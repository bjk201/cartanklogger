"""
CarTankLogger - Vollständiges Ladekosten-Tracking für EVCC + TeslaMate

Zuhause (EVCC):  Netzbezugspreis (zeitlich anpassbar) + PV-Anteil
                 berechnet mit entgangener Einspeisevergütung.
Extern (TeslaMate API): manuell belasteter Preis je Ladevorgang.
Plus: Odometer/KM-Stand, Statistik (Tank-Logging-Stil) und
separate Sicht für Anschaffung/Service/Zubehör/Versicherung/Steuer.
"""

import os
import json
import sqlite3
import subprocess
import requests
from datetime import datetime, date, timedelta
from flask import Flask, render_template, jsonify, request, g, session

# Domänenmodell + Matching + Statistik (vereinheitlichte Charge-Sicht)
from services.stats import build_stats_from_rows, compute_home_cost_row as _stats_compute_home_cost_row
import db as dbmod

try:
    import yaml
except ImportError:
    yaml = None

app = Flask(__name__)
# Browser zwingen, statische Dateien (app.js, css) bei jedem Request neu zu
# holen -> kein veralteter JS/CSS-Cache nach einem Deploy.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.yaml")
DB_PATH = os.environ.get("DB_PATH", "/app/data/cartanklogger.db")
# Sicherstellen, dass die DB IMMER unter dem gemounteten /app/data liegt.
# Wenn DB_PATH ausserhalb von /app/data zeigt (nicht gemountet), landen die
# Daten im ephemeralen Container-Layer und gehen beim Recreate verloren.
# Daher: falls DB_PATH nicht unter /app/data liegt, verschieben wir sie dorthin.
import os as _os
if not DB_PATH.startswith("/app/data/"):
    _fallback = "/app/data/cartanklogger.db"
    if DB_PATH != _fallback:
        app.logger.warning(
            f"DB_PATH={DB_PATH} liegt NICHT unter /app/data (nicht gemountet). "
            f"Daten wahren beim Recreate verloren! Nutze {_fallback}.")
        DB_PATH = _fallback
_env_mock = os.environ.get("MOCK_MODE")
MOCK_MODE = _env_mock.lower() in ("1", "true", "yes") if _env_mock is not None else None

# --- Ladeverlust-Effizienz (ev-monitor: AC 0.90 / DC 0.95) ---
# AC-Wallbox: ~10% Verlust, DC-Schnellladen: ~5% Verlust.
AC_EFFICIENCY = 0.90
DC_EFFICIENCY = 0.95
# Plausibilitaetsgrenzen (ev-monitor: absolute bounds)
ABS_MIN_KWH_100 = 5.0
ABS_MAX_KWH_100 = 40.0
SIGMA_MULTIPLIER = 2.0  # statistische Plausibilität: Mittelwert ± 2σ


def load_config():
    defaults = {
        "evcc": {
            "host": "evcc.local",
            "port": 7070,
            "password": "",
            "api_token": "",
            "use_tls": False,
        },
        "teslamate": {
            "url": "http://teslamate:4000/api",
            "api_token": "",
        },
        "app": {
            "mock_mode": MOCK_MODE,
            "auto_sync_minutes": 0,  # 0 = aus
            "currency": "EUR",
            "vehicle_name": "Mein EV",
            # Datenschutz-Defaults: maximal datensparsam (public-repo-tauglich)
            "store_raw_payloads": False,    # keine kompletten API-Payloads speichern
            "store_exact_locations": False,  # keine GPS-Koordinaten / exakten Adressen
            "store_address_labels": True,    # anonymisierte Labels erlaubt
        },
        "pricing_defaults": {
            "grid_price_per_kwh": 0.32,   # Netzbezugspreis (€/kWh)
            "feedin_price_per_kwh": 0.08,  # Einspeisevergütung (€/kWh)
        },
    }
    cfg = defaults
    # CONFIG_PATH kann sein:
    #   - eine Datei            (/app/config.yaml)
    #   - ein Verzeichnis        (/app/config)  -> Datei liegt in .../config.yaml
    # Docker erzeugt bei fehlender Quelldatei aus einem Datei-Mount aber ein
    # gleichnamiges VERZEICHNIS -> "/app/config.yaml" ist dann ein Ordner.
    # Wir probieren alle plausiblen Orte, damit die gespeicherten IPs nach
    # einem F5 (Neuladen der Config) WIRKLICH wieder gelesen werden.
    candidates = []
    if os.path.isdir(CONFIG_PATH):
        candidates.append(os.path.join(CONFIG_PATH, "config.yaml"))
    else:
        candidates.append(CONFIG_PATH)            # /app/config.yaml (Datei)
        candidates.append(os.path.join(os.path.dirname(CONFIG_PATH), "config", "config.yaml"))  # /app/config/config.yaml
        candidates.append(os.path.join(os.path.dirname(CONFIG_PATH), "config.yaml"))            # /app/config.yaml (im parent)
    cfg_path = next((c for c in candidates if os.path.isfile(c)), None)
    if cfg_path and yaml:
        try:
            with open(cfg_path, "r") as f:
                loaded = yaml.safe_load(f) or {}
            # tiefen-merge (nur eine Ebene)
            for k, v in loaded.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as e:
            app.logger.warning(f"Konfig konnte nicht gelesen werden: {e}")
    cfg["app"]["mock_mode"] = MOCK_MODE if MOCK_MODE is not None else cfg["app"].get("mock_mode", False)
    return cfg


# --- Datenschutz-Helfer (zentral, von Sync + API genutzt) -------------------
def _privacy():
    """Liefert die Datenschutz-Optionen aus der App-Config (Default: sparsam)."""
    a = config.get("app", {})
    return {
        "store_raw_payloads": bool(a.get("store_raw_payloads", False)),
        "store_exact_locations": bool(a.get("store_exact_locations", False)),
        "store_address_labels": bool(a.get("store_address_labels", True)),
    }


def _location_label(geofence, address):
    """Anonymisiertes Standort-Label fuer die API/Ausgabe.

    - store_address_labels=False: immer nur Provider/Standorttyp
      ("Zuhause" / "Tesla Supercharger" / "Oeffentliche Ladestation")
    - store_address_labels=True: zusaetzlich Geofence/Label, aber NIE
      die rohe Adresse mit Strasse/Hausnummer (sofern nicht als Zuhause erkannt).
    Liefert KEINEN exakten Strassennamen zurueck.
    """
    priv = _privacy()
    text = f"{geofence or ''} {address or ''}".strip()
    if _is_home_address(geofence, address):
        return "Zuhause"
    if "supercharger" in text.lower():
        return "Tesla Supercharger"
    if not priv["store_address_labels"]:
        return "Oeffentliche Ladestation"
    # Geofence ist meist eine grobe Kategorie (z.B. "A8 Rastplatz") -> OK als Label
    if geofence:
        return str(geofence)
    return "Oeffentliche Ladestation"


def _store_raw():
    return _privacy()["store_raw_payloads"]


def _store_exact_location():
    return _privacy()["store_exact_locations"]


config = load_config()

# --- Secret + CSRF -------------------------------------------------------
# CSRF-Schutz fuer schreibende Requests (PUT/POST/DELETE). Der Secret_key ist
# die HMAC-Basis fuer die Token. Persistent (env > config.yaml > DB-Pfad-Hash),
# damit ein Container-Neustart offene Sessions nicht invalidiert.
import hmac
import hashlib
import secrets

def _resolve_secret_key():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    cfg_secret = (config.get("app") or {}).get("secret_key")
    if cfg_secret:
        return str(cfg_secret)
    # Stabiler Fallback: Hash ueber DB-Pfad (aendert sich nicht pro Restart).
    return hashlib.sha256(DB_PATH.encode("utf-8")).hexdigest()

app.secret_key = _resolve_secret_key()


def csrf_token():
    """Liefert das CSRF-Token aus der Flask-Session (persistent pro Browser-Cookie)."""
    token = session.get("csrf_token_value")
    if not token:
        token = secrets.token_hex(32)
        session["csrf_token_value"] = token
    return token


def csrf_protect():
    """Prueft das CSRF-Token bei schreibenden Requests. Bricht mit 403 ab."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    # Token aus Header (X-CSRFToken) oder Form-Feld.
    token = request.headers.get("X-CSRFToken")
    if token is None and request.form:
        token = request.form.get("csrf_token")
    if not token:
        return jsonify({"ok": False, "error": "CSRF-Token fehlt"}), 403
    expected = csrf_token()
    if not hmac.compare_digest(token, expected):
        return jsonify({"ok": False, "error": "CSRF-Token ungueltig"}), 403


# Vor jedem Request sicherstellen, dass ein Token in der Session liegt,
# und bei schreibenden Requests (POST/PUT/DELETE) das CSRF-Token pruefen.
@app.before_request
def _ensure_csrf():
    # Token in der Session bereitstellen (fuer GET /api/csrf und spaetere POSTs).
    csrf_token()
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        err = csrf_protect()
        if err is not None:
            # csrf_protect liefert bereits eine Response (403) zurueck
            return err
    # Konfiguration pro Request frisch laden, falls die Datei sich geaendert
    # hat (mtime-Check). So ist ein Browser-F5 nach dem Speichern (auch im
    # gleichen Container) immer aktuell – unabhaengig vom Modul-Start-Cache.
    _maybe_reload_config()


@app.after_request
def _no_cache_all(resp):
    """Keine Cache-Header fuer HTML + API, damit der Browser nach einem
    Deploy/Update immer frische Seiten und Datenbank-Daten zeigt
    (kein 'alte Daten' durch gecachte admin.html / API-Antworten).
    Ausserdem CORS-Header setzen: die einkommende Origin wird reflektiert
    (statt fest auf '*'), zusammen mit Allow-Credentials. So funktioniert
    die App egal, von wo sie geladen wird – Same-Origin, ueber eine andere
    IP/localhost, einen Reverse-Proxy oder eingebettet in Home Assistant.
    Ein festes '*' wuerde bei mitgesandtem Session-Cookie (credentials)
    vom Browser blockt werden."""
    if request.path.startswith("/api/") or request.path in ("/admin", "/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        origin = request.headers.get("Origin")
        if origin:
            # Einkommende Origin erlauben (CORS erlaubt nur genaue Werte,
            # kein '*' zusammen mit credentials).
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
        else:
            # Same-Origin (kein Origin-Header): nichts tun, CORS greift nicht.
            resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-CSRFToken"
        resp.headers["Vary"] = "Origin"
    return resp


# ---------------------------------------------------------------------------
# Validierungs-Helfer (serverseitig, streng)
# ---------------------------------------------------------------------------
def _v_number(val, name, lo=None, hi=None, required=False):
    """Validiert eine Zahl. Gibt (wert, fehler) zurueck."""
    if val is None or val == "":
        if required:
            return None, f"{name} ist erforderlich"
        return None, None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None, f"{name} muss eine Zahl sein"
    if lo is not None and f < lo:
        return None, f"{name} darf nicht kleiner als {lo} sein"
    if hi is not None and f > hi:
        return None, f"{name} darf nicht groesser als {hi} sein"
    return f, None


def _v_date(val, name, required=False):
    """Validiert ISO-Datum/-zeit. Gibt (iso_string, fehler) zurueck."""
    if val is None or val == "":
        if required:
            return None, f"{name} ist erforderlich"
        return None, None
    s = str(val).strip()
    # Normalize: 'T' erlauben, 'Z' ignorieren
    s2 = s.replace("Z", "+00:00")
    parsed = None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(s[:19] if "T" in s or " " in s else s, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(s2)
        except ValueError:
            return None, f"{name} muss ein gueltiges Datum (YYYY-MM-DD[THH:MM:SS]) sein"
    return parsed.isoformat(), None


def _v_text(val, name, maxlen=200, required=False, choices=None):
    if val is None:
        if required:
            return None, f"{name} ist erforderlich"
        return None, None
    s = str(val).strip()
    if required and not s:
        return None, f"{name} ist erforderlich"
    if choices is not None and s not in choices:
        return None, f"{name} muss einer von: {', '.join(choices)} sein"
    if len(s) > maxlen:
        return None, f"{name} darf max. {maxlen} Zeichen haben"
    return s, None


EXTRA_CATEGORIES = {"purchase", "service", "accessory", "insurance", "tax", "other"}
PRICE_KINDS = {"grid", "feedin"}


def _now_iso():
    return datetime.now().isoformat()




def mock_mode():
    return bool(config.get("app", {}).get("mock_mode", MOCK_MODE))


# ---------------------------------------------------------------------------
# Datenbank
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        init_db(g.db)
        # Migrationen: fehlende Spalten (z.B. soc_start/soc_end) bei bereits
        # existierenden Tabellen ergaenzen. Wichtig fuer Container-Updates auf
        # eine neue Version ohne DB-Neuaufbau.
        try:
            dbmod._ensure_migrations(g.db)
        except Exception as e:
            app.logger.warning(f"Migration uebersprungen: {e}")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(db):
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS home_sessions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            evcc_session_id INTEGER UNIQUE,
            created         TEXT,
            finished        TEXT,
            loadpoint       TEXT,
            vehicle         TEXT,
            odometer        REAL,
            charged_kwh     REAL,
            solar_percentage REAL,
            soc_start        REAL,
            soc_end          REAL,
            pv_kwh          REAL,
            grid_kwh        REAL,
            grid_cost       REAL,
            pv_cost         REAL,
            total_cost      REAL,
            price_per_kwh   REAL,
            imported_at     TEXT,
            raw             TEXT
        );

        CREATE TABLE IF NOT EXISTS external_sessions (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            teslamate_session_id INTEGER UNIQUE,
            started_at        TEXT,
            finished_at       TEXT,
            location_name     TEXT,
            address           TEXT,
            soc_start         REAL,
            soc_end           REAL,
            latitude          REAL,
            longitude         REAL,
            provider          TEXT,
            energy_kwh        REAL,
            energy_used_kwh   REAL,
            odometer_start    REAL,
            odometer_end      REAL,
            cost_total        REAL,
            price_per_kwh     REAL,
            manual_price      INTEGER DEFAULT 0,
            imported_at       TEXT,
            raw               TEXT
        );

        CREATE TABLE IF NOT EXISTS price_periods (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT,            -- 'grid' | 'feedin'
            valid_from   TEXT,            -- YYYY-MM-DD
            valid_to     TEXT,            -- YYYY-MM-DD oder NULL (offen)
            price_per_kwh REAL,
            note         TEXT
        );

        CREATE TABLE IF NOT EXISTS extra_costs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            category    TEXT,             -- purchase|service|accessory|insurance|tax|other
            date        TEXT,
            description TEXT,
            amount      REAL,
            odometer    REAL,
            note        TEXT,
            created_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS drives (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            teslamate_drive_id  INTEGER UNIQUE,
            start_date          TEXT,
            end_date            TEXT,
            start_address       TEXT,
            end_address         TEXT,
            distance_km         REAL,
            odometer_start      REAL,
            odometer_end        REAL,
            duration_min        INTEGER,
            speed_max           INTEGER,
            speed_avg           REAL,
            soc_start           REAL,
            soc_end             REAL,
            energy_consumed_kwh REAL,
            outside_temp_avg    REAL,
            imported_at         TEXT,
            raw                 TEXT
        );
        """
    )
    # Spalte energy_used_kwh nur ergaenzen, falls aeltere DB (Migration).
    # SQLite unterstuetzt kein "ADD COLUMN IF NOT EXISTS" im executescript.
    cols = [r[1] for r in db.execute("PRAGMA table_info(external_sessions)")]
    if "energy_used_kwh" not in cols:
        db.execute("ALTER TABLE external_sessions ADD COLUMN energy_used_kwh REAL")
    if "odometer_end" not in cols:
        db.execute("ALTER TABLE external_sessions ADD COLUMN odometer_end REAL")
    # --- Migration: Bearbeitbarkeit / Datenherkunft (Feature "Bearbeiten") ---
    # Neue Spalten duerfen keine bestehenden Daten brechen (DEFAULT-Werte).
    _migrate_columns(db, "home_sessions", {
        "updated_at": "TEXT",
        "source": "TEXT DEFAULT 'evcc'",
        "manually_edited": "INTEGER DEFAULT 0",
        "note": "TEXT",
    })
    _migrate_columns(db, "external_sessions", {
        "updated_at": "TEXT",
        "source": "TEXT DEFAULT 'teslamate'",
        "manually_edited": "INTEGER DEFAULT 0",
        "note": "TEXT",
    })
    _migrate_columns(db, "extra_costs", {
        "updated_at": "TEXT",
        "source": "TEXT DEFAULT 'manual'",
        "manually_edited": "INTEGER DEFAULT 0",
    })
    _migrate_columns(db, "price_periods", {
        "updated_at": "TEXT",
        "source": "TEXT DEFAULT 'manual'",
        "manually_edited": "INTEGER DEFAULT 0",
    })
    db.commit()
    seed_price_periods(db)


def _migrate_columns(db, table, columns):
    """Ergaenzt fehlende Spalten (SQLite kennt kein ADD COLUMN IF NOT EXISTS)."""
    existing = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
    for name, typ in columns.items():
        if name not in existing:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {typ}")


def seed_price_periods(db):
    cur = db.execute("SELECT COUNT(*) AS c FROM price_periods")
    if cur.fetchone()["c"] == 0:
        gd = config.get("pricing_defaults", {})
        today = date.today().isoformat()
        db.execute(
            "INSERT INTO price_periods (kind, valid_from, valid_to, price_per_kwh, note) VALUES (?,?,?,?,?)",
            ("grid", "2020-01-01", None, gd.get("grid_price_per_kwh", 0.32), "Standard Netzbezugspreis"),
        )
        db.execute(
            "INSERT INTO price_periods (kind, valid_from, valid_to, price_per_kwh, note) VALUES (?,?,?,?,?)",
            ("feedin", "2020-01-01", None, gd.get("feedin_price_per_kwh", 0.08), "Einspeisevergütung"),
        )
        db.commit()


# ---------------------------------------------------------------------------
# Preislogik (zeitabhängig)
# ---------------------------------------------------------------------------
def get_price_at(kind, on_date):
    db = get_db()
    d = on_date.isoformat() if isinstance(on_date, (datetime, date)) else str(on_date)
    row = db.execute(
        """SELECT price_per_kwh FROM price_periods
           WHERE kind = ?
             AND valid_from <= ?
             AND (valid_to IS NULL OR valid_to = '' OR valid_to >= ?)
           ORDER BY valid_from DESC LIMIT 1""",
        (kind, d, d),
    ).fetchone()
    if row:
        return float(row["price_per_kwh"])
    # Fallback auf Default
    if kind == "grid":
        return float(config.get("pricing_defaults", {}).get("grid_price_per_kwh", 0.32))
    return float(config.get("pricing_defaults", {}).get("feedin_price_per_kwh", 0.08))


def compute_home_cost(charged_kwh, solar_percentage, on_date):
    """Teilt Energie in PV/Grid und berechnet Kosten."""
    solar = 0.0
    if solar_percentage is not None:
        try:
            solar = float(solar_percentage)
        except (TypeError, ValueError):
            solar = 0.0
    solar = max(0.0, min(100.0, solar))
    pv_kwh = charged_kwh * solar / 100.0
    grid_kwh = max(0.0, charged_kwh - pv_kwh)

    grid_price = get_price_at("grid", on_date)
    feedin_price = get_price_at("feedin", on_date)

    grid_cost = grid_kwh * grid_price
    pv_cost = pv_kwh * feedin_price
    grid_cost_r = round(grid_cost, 2)
    pv_cost_r = round(pv_cost, 2)
    total = round(grid_cost_r + pv_cost_r, 2)  # Spalten addieren sich exakt auf
    ppk = (total / charged_kwh) if charged_kwh > 0 else 0.0
    return {
        "pv_kwh": round(pv_kwh, 3),
        "grid_kwh": round(grid_kwh, 3),
        "grid_cost": grid_cost_r,
        "pv_cost": pv_cost_r,
        "total_cost": total,
        "price_per_kwh": round(ppk, 4),
        "grid_price": grid_price,
        "feedin_price": feedin_price,
    }


def compute_home_cost_row(row):
    """Kosten für eine gespeicherte Home-Session neu berechnen (immer aktuell)."""
    created = _parse_dt(row["created"]) or datetime.now()
    return compute_home_cost(row["charged_kwh"], row["solar_percentage"], created)


def recompute_all_home_costs():
    """Alle Home-Sessions neu bewerten (nach Preisänderung)."""
    db = get_db()
    for r in db.execute("SELECT * FROM home_sessions"):
        c = compute_home_cost_row(r)
        db.execute(
            """UPDATE home_sessions SET pv_kwh=?, grid_kwh=?, grid_cost=?, pv_cost=?,
               total_cost=?, price_per_kwh=? WHERE id=?""",
            (c["pv_kwh"], c["grid_kwh"], c["grid_cost"], c["pv_cost"],
             c["total_cost"], c["price_per_kwh"], r["id"]),
        )
    db.commit()


# ---------------------------------------------------------------------------
# EVCC Client (REST API v0.2.x)
# ---------------------------------------------------------------------------
class EVCCClient:
    def __init__(self, host, port, password="", api_token="", use_tls=False):
        scheme = "https" if use_tls else "http"
        self.base_url = f"{scheme}://{host}:{port}/api"
        self.password = password
        self.api_token = api_token
        self.session = requests.Session()
        self._authed = False

    def _authenticate(self):
        if self._authed:
            return True
        if self.api_token:
            self.session.headers["Authorization"] = f"Bearer {self.api_token}"
            self._authed = True
            return True
        if self.password:
            try:
                r = self.session.post(
                    f"{self.base_url}/auth/login",
                    json={"password": self.password},
                    timeout=10,
                )
                if r.status_code == 200:
                    self._authed = True
                    return True
                app.logger.warning(f"EVCC Login fehlgeschlagen: {r.status_code}")
            except Exception as e:
                app.logger.warning(f"EVCC Login Fehler: {e}")
        # Kein Passwort/Token konfiguriert -> EVCC ohne Auth (REST offen)
        if not self.api_token and not self.password:
            self._authed = True
            return True
        return False

    def get_sessions(self, since_days=365):
        if mock_mode():
            return _mock_evcc_sessions()
        if not self._authenticate():
            return []
        try:
            r = self.session.get(f"{self.base_url}/sessions", timeout=20)
            if r.status_code == 200:
                data = r.json()
                return data if isinstance(data, list) else []
            app.logger.warning(f"EVCC /sessions: {r.status_code}")
        except Exception as e:
            app.logger.warning(f"EVCC Abruf Fehler: {e}")
        return []


# ---------------------------------------------------------------------------
# TeslaMate Client (REST via teslamateapi, z.B. http://host:8080/api/v1)
# ---------------------------------------------------------------------------
class TeslaMateClient:
    def __init__(self, url, token=""):
        # Basis-URL der teslamateapi, z.B. http://teslamate:4000/api/v1
        self.base = url.rstrip("/")
        if not self.base.endswith("/v1"):
            # falls nur ".../api" oder ".../api/" angegeben wurde
            if self.base.endswith("/api"):
                self.base = self.base + "/v1"
            elif self.base.endswith("/api/"):
                self.base = self.base.rstrip("/") + "/v1"
        self.token = token

    def _cars(self):
        try:
            r = requests.get(f"{self.base}/cars", timeout=20)
            if r.status_code == 200:
                return [c["car_id"] for c in r.json().get("data", {}).get("cars", [])]
        except Exception as e:
            app.logger.warning(f"TeslaMate /cars Fehler: {e}")
        return []

    def get_charging_sessions(self, limit=300):
        if mock_mode():
            return _mock_teslamate_sessions()
        try:
            car_ids = self._cars()
            if not car_ids:
                # Fallback: einfach Car 1 versuchen
                car_ids = [1]
            out = []
            for cid in car_ids:
                try:
                    r = requests.get(
                        f"{self.base}/cars/{cid}/charges",
                        params={"limit": limit},
                        timeout=30,
                    )
                    if r.status_code != 200:
                        app.logger.warning(f"TeslaMate /charges: {r.status_code}")
                        continue
                    charges = r.json().get("data", {}).get("charges", [])
                    out.extend(charges)
                except Exception as e:
                    app.logger.warning(f"TeslaMate /charges Fehler: {e}")
            return out
        except Exception as e:
            app.logger.warning(f"TeslaMate Abruf Fehler: {e}")
        return []

    def get_drives(self, limit=1000):
        """Holt Fahrten (drives) aus teslamateapi: GET /cars/:id/drives.

        Response-Huelle: {"data": {"drives": [ {drive_id, start_date, end_date,
        odometer_details{odometer_start/end/distance}, battery_details{...},
        duration_min, speed_max, speed_avg, energy_consumed_net, ...} ]}}.
        Wir flachen die verschachtelten Details in ein einfaches Dict ab.
        """
        if mock_mode():
            return _mock_teslamate_drives()
        try:
            car_ids = self._cars() or [1]
            out = []
            for cid in car_ids:
                try:
                    r = requests.get(
                        f"{self.base}/cars/{cid}/drives",
                        params={"limit": limit},
                        timeout=60,
                    )
                    if r.status_code != 200:
                        app.logger.warning(f"TeslaMate /drives: {r.status_code}")
                        continue
                    drives = r.json().get("data", {}).get("drives", [])
                    out.extend(drives)
                except Exception as e:
                    app.logger.warning(f"TeslaMate /drives Fehler: {e}")
            return out
        except Exception as e:
            app.logger.warning(f"TeslaMate Drives Abruf Fehler: {e}")
        return []

    def get_status(self, car_id=None):
        """Live-Status aus teslamateapi (GET /cars/:CarID/status).

        Liefert u.a. MQTTDataPluggedIn (bool) und MQTTDataChargingState (string).
        WICHTIG: Dieser Endpunkt ist LIVE (MQTT-Cache), NICHT historisch.
        Er dient nur zur Anzeige ("gerade am Kabel") und NICHT zum Matching.
        Das Home-Matching nutzt das EVCC-Zeitfenster (siehe services/matching).

        Gibt Dict zurueck: {plugged_in, charging_state, car_id, ...} oder {} bei Fehler.
        """
        if car_id is None:
            car_ids = self._cars() or [1]
            car_id = car_ids[0] if car_ids else 1
        try:
            r = requests.get(f"{self.base}/cars/{car_id}/status", timeout=15)
            if r.status_code != 200:
                return {}
            d = r.json().get("data", r.json())
            return {
                "car_id": car_id,
                "plugged_in": bool(d.get("MQTTDataPluggedIn", False)),
                "charging_state": (d.get("MQTTDataChargingState") or "").lower(),
                "geofence": d.get("MQTTDataGeofence"),
                "battery_level": d.get("MQTTDataBatteryLevel"),
            }
        except Exception as e:
            app.logger.warning(f"TeslaMate /status Fehler: {e}")
            return {}

    def update_charging_process_cost(self, charge_id, cost):
        """Schreibt die berechnete Home-Kosten zurueck in TeslaMate.

        Nutzt die TeslaMate GraphQL-API (Mutation updateChargingProcess),
        da teslamateapi v1 keine PUT/PATCH fuer charging_processes bietet.
        Es werden NUR existierende Charges angereichert (cost-Feld),
        es werden KEINE neuen Charges angelegt.

        Wirft Exception bei Fehler (damit der Aufrufer sie sauber loggen kann).
        """
        import requests as _req
        # GraphQL-Endpoint: URL ohne '/v1' + '/graphql'
        graphql_url = self.base
        if graphql_url.endswith("/v1"):
            graphql_url = graphql_url[:-3]
        if not graphql_url.endswith("/"):
            graphql_url += "/"
        graphql_url += "graphql"
        mutation = """
        mutation UpdateCost($id: Int!, $cost: Float!) {
          updateChargingProcess(id: $id, cost: $cost) {
            id cost
          }
        }
        """
        try:
            r = _req.post(
                graphql_url,
                json={"query": mutation, "variables": {"id": int(charge_id), "cost": float(cost)}},
                timeout=20,
                headers={"Content-Type": "application/json"},
            )
            if r.status_code != 200:
                raise RuntimeError(f"GraphQL {r.status_code}: {r.text[:200]}")
            body = r.json()
            if body.get("errors"):
                raise RuntimeError(f"GraphQL errors: {body['errors']}")
        except Exception as e:
            # Im Mock-Mode: nur loggen, nicht werfen (damit Tests nicht brechen)
            if mock_mode():
                app.logger.info(f"[MOCK] TeslaMate cost backfill charge {charge_id} = {cost}")
                return
            raise


# ---------------------------------------------------------------------------
# Sync / Import
# ---------------------------------------------------------------------------
def _parse_dt(val):
    if not val:
        return None
    if isinstance(val, (datetime, date)):
        return val
    s = str(val).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(str(val), fmt)
            except ValueError:
                continue
    return None


def _to_float(v):
    """Sicheres float() – gibt None zurueck, wenn v nicht numerisch ist."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _extract_soc(s, prefixes=("soc", "soc_", "battery", "battery_", "startSoc", "endSoc")):
    """Liest Start/End-SoC feldnamen-robust aus einer EVCC-Session.

    EVCC-Versionen liefern das SoC-Feld mal als 'socStart'/'socEnd',
    'soc_start'/'soc_end', 'startSoc'/'endSoc' oder 'batteryStart'/'batteryEnd'.
    Wir probieren mehrere Varianten, damit der Sync unabhaengig von der
    genauen EVCC-Version funktioniert. Gibt (soc_start, soc_end) zurueck.
    """
    def _find(*names):
        for n in names:
            if n in s and s[n] not in (None, ""):
                try:
                    return float(s[n])
                except (TypeError, ValueError):
                    return None
        return None
    soc_start = _find("socStart", "soc_start", "startSoc", "start_soc",
                      "batteryStart", "battery_start", "socBegin", "soc_begin")
    soc_end = _find("socEnd", "soc_end", "endSoc", "end_soc",
                    "batteryEnd", "battery_end", "socFinish", "soc_finish")
    return soc_start, soc_end


def sync_evcc():
    evcc = config["evcc"]
    client = EVCCClient(
        evcc["host"], evcc["port"], evcc.get("password", ""),
        evcc.get("api_token", ""), evcc.get("use_tls", False),
    )
    sessions = client.get_sessions()
    db = get_db()
    now = datetime.now().isoformat()
    inserted = 0
    for s in sessions:
        sid = s.get("id")
        if sid is None:
            continue
        created = _parse_dt(s.get("created")) or datetime.now()
        finished = _parse_dt(s.get("finished"))
        charged = float(s.get("chargedEnergy", 0) or 0)
        if charged <= 0:
            continue
        solar = s.get("solarPercentage")
        # EVCC liefert solarPercentage als 0..1 -> auf 0..100 normieren
        try:
            solar_f = float(solar) if solar is not None else 0.0
        except (TypeError, ValueError):
            solar_f = 0.0
        if solar_f <= 1.0 and solar_f > 0:
            solar_f = solar_f * 100.0
        # SoC feldnamen-robust auslesen (EVCC-Version-abhaengig)
        soc_start, soc_end = _extract_soc(s)
        cost = compute_home_cost(charged, solar_f, created)
        try:
            cur = db.execute(
                """INSERT OR IGNORE INTO home_sessions
                   (evcc_session_id, created, finished, loadpoint, vehicle, odometer,
                    charged_kwh, solar_percentage, soc_start, soc_end,
                    pv_kwh, grid_kwh, grid_cost, pv_cost,
                    total_cost, price_per_kwh, imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid, created.isoformat(),
                    finished.isoformat() if finished else None,
                    s.get("loadpoint", ""), s.get("vehicle", ""),
                    s.get("odometer"),
                    charged, solar, soc_start, soc_end,
                    cost["pv_kwh"], cost["grid_kwh"], cost["grid_cost"],
                    cost["pv_cost"], cost["total_cost"], cost["price_per_kwh"],
                    now, json.dumps(s, default=str),
                ),
            )
            inserted += cur.rowcount
        except sqlite3.IntegrityError:
            pass
    db.commit()
    return {"inserted": inserted, "fetched": len(sessions)}


def _home_addresses():
    """Liste der als 'Zuhause' geltenden Adress-Substrings (aus config).

    Ergaenzt um feste Geofence-Namen, die TeslaMate typischerweise fuer die
    Heim-Ladestation verwendet (case-insensitiv). So wird eine TM-Ladung an
    einem Geofence 'Zuhause'/'Home'/'Garage'/'Wallbox' IMMER als Zuhause
    erkannt – auch wenn in der Config keine home_addresses gepflegt sind.
    """
    base = [a.strip().lower() for a in config.get("app", {}).get("home_addresses", []) if a and a.strip()]
    fixed = ["zuhause", "home", "garage", "wallbox", "zu hause"]
    seen = set()
    out = []
    for h in base + fixed:
        if h and h not in seen:
            seen.add(h)
            out.append(h)
    return out


def _is_home_address(geofence, address):
    """True, wenn eine TeslaMate-Ladung an einer Zuhause-Adresse stattfand.
    Diese Ladungen sind IDENTISCH mit den EVCC-Ladungen (doppeltes Tracking)
    und duerfen NICHT als extern gezaehlt/addiert werden.

    Erkennung ueber:
      - Geofence-Namen 'Zuhause'/'Home'/'Garage'/'Wallbox' (automatisch)
      - home_addresses aus der Config (Substring-Match auf Geofence+Adresse)
    """
    geo = (geofence or "").strip().lower()
    # Geofence-Namen direkt als Zuhause erkennen (unabhaengig von Config)
    if geo in ("zuhause", "home", "garage", "wallbox", "zu hause"):
        return True
    text = f"{geofence or ''} {address or ''}".lower()
    return any(h in text for h in _home_addresses())


def _detect_provider(geofence, address):
    text = f"{geofence or ''} {address or ''}".lower()
    if _is_home_address(geofence, address):
        return "Zuhause"
    if "supercharger" in text:
        return "Tesla Supercharger"
    if geofence:
        return str(geofence)
    return "Öffentliche Ladestation"


def derive_odometer_for_date(db, date):
    """Leitet den KM-Stand fuer ein Datum ab, wenn er bei einer Extra-Kosten-
    Buchung nicht erfasst wurde.

    Strategie: nimm den KM-Stand des Ladevorgangs (EVCC odometer / TM
    odometer_start), dessen Zeitstempel dem Buchungsdatum am naechsten liegt
    (vorzugsweise am selben Tag oder danach; sonst der letzte davor). FALLBACK:
    wenn keine Ladevorgänge da sind, der groesste bekannte Tacho-Stand aus den
    Fahrten (drives.odometer_end). Liefert None, wenn gar nichts bekannt.
    """
    if not date:
        return None
    d19 = str(date)[:10]
    try:
        target = datetime.fromisoformat(d19).date()
    except Exception:
        return None
    from datetime import date as _date
    candidates = []  # (abs_days_diff, odometer, is_after)
    for tbl, ts_col, odo_col in (
        ("home_sessions", "created", "odometer"),
        ("external_sessions", "started_at", "odometer_start"),
    ):
        try:
            rows = db.execute(
                f"SELECT {ts_col}, {odo_col} FROM {tbl} WHERE {odo_col} IS NOT NULL AND {odo_col} > 0"
            ).fetchall()
        except Exception:
            rows = []
        for r in rows:
            ts = str(dict(r).get(ts_col) or "")[:10]
            odo = dict(r).get(odo_col)
            if not ts or odo is None:
                continue
            try:
                d = datetime.fromisoformat(ts).date()
            except Exception:
                continue
            diff = (d - target).days
            candidates.append((abs(diff), odo, diff >= 0))
    if candidates:
        # Bevorzuge Eintraege am/nahe dem Datum; bei Gleichstand den mit KM-Stand.
        candidates.sort(key=lambda c: (0 if c[2] else 1, c[0], -c[1] if c[1] else 0))
        return candidates[0][1]
    # Fallback: groesster Tacho-Stand aus Fahrten
    try:
        row = db.execute(
            "SELECT MAX(odometer_end) AS m FROM drives WHERE odometer_end IS NOT NULL AND odometer_end > 0"
        ).fetchone()
        if row:
            return dict(row).get("m")
    except Exception:
        pass
    return None


def sync_teslamate():
    tm = config["teslamate"]
    client = TeslaMateClient(tm["url"], tm.get("api_token", ""))
    sessions = client.get_charging_sessions()
    db = get_db()
    now = datetime.now().isoformat()
    inserted = 0
    for s in sessions:
        sid = s.get("charge_id")
        if sid is None:
            continue
        started = _parse_dt(s.get("start_date")) or datetime.now()
        finished = _parse_dt(s.get("end_date"))
        energy = float(s.get("charge_energy_added") or s.get("charge_energy_used") or 0)
        energy_used = float(s.get("charge_energy_used") or energy)
        if energy <= 0:
            continue
        provider = _detect_provider(s.get("geofence"), s.get("address"))
        tm_cost = s.get("cost")
        cost_total = float(tm_cost) if tm_cost not in (None, "") else 0.0
        ppk = (cost_total / energy) if (cost_total and energy) else 0.0
        existing = db.execute(
            "SELECT id, manual_price, cost_total FROM external_sessions WHERE teslamate_session_id=?",
            (sid,)).fetchone()
        # sqlite3.Row hat kein .get(); in dict wandeln für einheitlichen Zugriff
        existing = dict(existing) if existing is not None else None
        # Datenschutz: rohe Payload + exakte GPS-Koordinaten nur speichern, wenn erlaubt
        raw_val = json.dumps(s, default=str) if _store_raw() else None
        lat = s.get("latitude") if _store_exact_location() else None
        lng = s.get("longitude") if _store_exact_location() else None
        # SoC aus TeslaMate (charge_energy_added etc. liefert keine SoC,
        # aber start_battery_level/end_battery_level sind im charges-Payload).
        soc_start = s.get("start_battery_level")
        soc_end = s.get("end_battery_level")
        try:
            soc_start = float(soc_start) if soc_start not in (None, "") else None
        except (TypeError, ValueError):
            soc_start = None
        try:
            soc_end = float(soc_end) if soc_end not in (None, "") else None
        except (TypeError, ValueError):
            soc_end = None
        # Adress-Label: immer anonymisiert (nie rohe Strasse/Hausnummer in der API)
        label = _location_label(s.get("geofence"), s.get("address"))
        if existing is None:
            cur = db.execute(
                """INSERT OR IGNORE INTO external_sessions
                   (teslamate_session_id, started_at, finished_at, location_name, address,
                    latitude, longitude, provider, energy_kwh, energy_used_kwh, odometer_start,
                    odometer_end, soc_start, soc_end, cost_total, price_per_kwh, manual_price, imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid, started.isoformat(),
                    finished.isoformat() if finished else None,
                    s.get("geofence") or "", label,
                    lat, lng, provider,
                    energy, energy_used, s.get("odometer"),
                    s.get("odometer"),
                    soc_start, soc_end,
                    cost_total, round(ppk, 4), 0, now, raw_val,
                ),
            )
            inserted += cur.rowcount
        elif existing["manual_price"] == 0:
            # Auto-Eintrag: Provider + Label IMMER neu ableiten (bei jedem Sync),
            # damit Aenderungen an home_addresses / TM-Geofence ("Zuhause") sofort
            # ALLE historischen Ladungen korrekt als Zuhause markieren - auch wenn
            # cost_total == 0 (Heimladungen haben in TM meist keine Kosten erfasst,
            # die alte Bedingung 'cost_total > 0' hat die Umetikettierung blockiert).
            new_provider = _detect_provider(s.get("geofence"), s.get("address"))
            new_label = _location_label(s.get("geofence"), s.get("address"))
            if cost_total > 0:
                db.execute(
                    """UPDATE external_sessions SET cost_total=?, price_per_kwh=?, energy_kwh=?, energy_used_kwh=?
                    WHERE id=?""",
                    (round(cost_total, 2), round(ppk, 4), energy, energy_used, existing["id"]))
            if new_provider != existing.get("provider") or new_label != existing.get("address"):
                db.execute(
                    """UPDATE external_sessions SET provider=?, address=? WHERE id=?""",
                    (new_provider, new_label, existing["id"]))
    db.commit()
    return {"inserted": inserted, "fetched": len(sessions)}


def _drive_flat(d):
    """Flacht eine TM-Drive (verschachtelt) in ein einfaches Dict ab."""
    od = d.get("odometer_details") or {}
    bd = d.get("battery_details") or {}
    def _f(v):
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None
    dist = _f(od.get("odometer_distance"))
    o_s = _f(od.get("odometer_start"))
    o_e = _f(od.get("odometer_end"))
    if dist is None and o_s is not None and o_e is not None:
        dist = round(o_e - o_s, 1)
    return {
        "drive_id": d.get("drive_id") or d.get("id"),
        "start_date": d.get("start_date"),
        "end_date": d.get("end_date"),
        "start_address": d.get("start_address") or "",
        "end_address": d.get("end_address") or "",
        "distance_km": dist,
        "odometer_start": o_s,
        "odometer_end": o_e,
        "duration_min": d.get("duration_min"),
        "speed_max": d.get("speed_max"),
        "speed_avg": _f(d.get("speed_avg")),
        "soc_start": _f(bd.get("start_battery_level")),
        "soc_end": _f(bd.get("end_battery_level")),
        "energy_consumed_kwh": _f(d.get("energy_consumed_net")),
        "outside_temp_avg": _f(d.get("outside_temp_avg")),
    }


def sync_teslamate_drives():
    """Holt Fahrten (drives) aus TeslaMate und speichert sie in der drives-Tabelle.

    Jede Fahrt hat km, Dauer, SoC-Start/Ende und (falls vorhanden) den von
    TeslaMate berechneten Netto-Energieverbrauch. Daraus lassen sich km/Tag
    (auch an ladefreien Tagen) und der Verbrauch pro Fahrt/Tag ableiten.
    """
    tm = config["teslamate"]
    client = TeslaMateClient(tm["url"], tm.get("api_token", ""))
    drives = client.get_drives()
    db = get_db()
    now = datetime.now().isoformat()
    inserted = 0
    store_raw = _store_raw()
    for raw in drives:
        d = _drive_flat(raw)
        did = d["drive_id"]
        if did is None:
            continue
        started = _parse_dt(d["start_date"])
        finished = _parse_dt(d["end_date"])
        try:
            cur = db.execute(
                """INSERT OR IGNORE INTO drives
                   (teslamate_drive_id, start_date, end_date, start_address, end_address,
                    distance_km, odometer_start, odometer_end, duration_min, speed_max,
                    speed_avg, soc_start, soc_end, energy_consumed_kwh, outside_temp_avg,
                    imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    did,
                    started.isoformat() if started else d["start_date"],
                    finished.isoformat() if finished else d["end_date"],
                    d["start_address"], d["end_address"],
                    d["distance_km"], d["odometer_start"], d["odometer_end"],
                    d["duration_min"], d["speed_max"], d["speed_avg"],
                    d["soc_start"], d["soc_end"], d["energy_consumed_kwh"],
                    d["outside_temp_avg"], now,
                    json.dumps(raw, default=str) if store_raw else None,
                ),
            )
            inserted += cur.rowcount
        except sqlite3.IntegrityError:
            pass
    db.commit()
    return {"inserted": inserted, "fetched": len(drives)}


# ---------------------------------------------------------------------------
# Mock-Daten (für Tests ohne live Instanzen)
# ---------------------------------------------------------------------------
def _mock_evcc_sessions():
    base = datetime.now() - timedelta(days=120)
    out = []
    for i in range(14):
        created = base + timedelta(days=i * 8, hours=2)
        # wechselnde Solar-Anteile und leicht steigender Preis
        solar = [80, 65, 90, 40, 70, 55, 95, 30, 75, 60, 85, 50, 78, 45][i % 14]
        out.append({
            "id": 1000 + i,
            "created": created.isoformat() + "Z",
            "finished": (created + timedelta(hours=3)).isoformat() + "Z",
            "loadpoint": "Wallbox",
            "vehicle": "Tesla Model 3",
            "odometer": 42000 + i * 320,
            "chargedEnergy": round(8 + (i % 5), 2),
            "solarPercentage": solar,
            "price": 3.5,
            "pricePerKWh": 0.33,
            # SoC (Version 1: camelCase socStart/socEnd)
            "socStart": 40 + (i % 4) * 10,
            "socEnd": 80 + (i % 3) * 5,
        })
    return out


def _mock_teslamate_drives():
    """Beispiel-Fahrten im Format der teslamateapi (/cars/<id>/drives).

    Enthaelt bewusst eine wiederkehrende PENDELSTRECKE (Home->Arbeit und zurueck)
    ueber mehrere Tage mit leicht schwankendem Verbrauch, damit die
    Vergleichsfunktion (mehrere Fahrten uebereinanderlegen) testbar ist.
    Verschachtelte Struktur wie die echte API: odometer_details/battery_details.
    """
    base = datetime.now() - timedelta(days=30)
    out = []
    did = 2000
    odo = 42000.0
    # 14 Werktage Pendeln: morgens hin (~32 km), abends zurueck (~32 km)
    for day in range(14):
        d0 = base + timedelta(days=day)
        # kleine Verbrauchs-Variation ueber die Zeit (Wetter/Fahrstil)
        cons_factor = 1.0 + (day % 5) * 0.06   # 1.00 .. 1.24
        for leg, (h, sa, ea, dist) in enumerate([
            (7,  "Zuhause", "Arbeit GmbH", 32.4),
            (17, "Arbeit GmbH", "Zuhause", 33.1),
        ]):
            start = d0.replace(hour=h, minute=0, second=0, microsecond=0)
            dur = 38 + (day % 4) * 3
            end = start + timedelta(minutes=dur)
            # Verbrauch ~ 16 kWh/100km * dist * factor
            energy = round(dist * 0.16 * cons_factor, 2)
            soc_s = 85 - leg * 12 - (day % 3) * 2
            soc_e = soc_s - int(energy / 0.75)   # grobe SoC-Abnahme
            odo_start = odo
            odo_end = odo + dist
            odo = odo_end
            out.append({
                "drive_id": did,
                "start_date": start.isoformat() + "Z",
                "end_date": end.isoformat() + "Z",
                "start_address": sa,
                "end_address": ea,
                "duration_min": dur,
                "duration_str": f"{dur} min",
                "speed_max": 118,
                "speed_avg": round(dist / (dur / 60.0), 1),
                "power_max": 95,
                "power_min": -30,
                "odometer_details": {
                    "odometer_start": round(odo_start, 1),
                    "odometer_end": round(odo_end, 1),
                    "odometer_distance": round(dist, 1),
                },
                "battery_details": {
                    "start_usable_battery_level": soc_s,
                    "start_battery_level": soc_s,
                    "end_usable_battery_level": soc_e,
                    "end_battery_level": soc_e,
                    "reduced_range": False,
                    "is_sufficiently_precise": True,
                },
                "outside_temp_avg": round(8 + day * 0.5, 1),
                "inside_temp_avg": 21.0,
                "energy_consumed_net": energy,
            })
            did += 1
    # ein paar laengere Wochenendfahrten
    for k in range(3):
        d0 = base + timedelta(days=5 + k * 7, hours=10)
        dist = 145.0 + k * 40
        dur = 105 + k * 25
        end = d0 + timedelta(minutes=dur)
        energy = round(dist * 0.17, 2)
        soc_s = 92
        soc_e = soc_s - int(energy / 0.75)
        odo_start = odo
        odo_end = odo + dist
        odo = odo_end
        out.append({
            "drive_id": did,
            "start_date": d0.isoformat() + "Z",
            "end_date": end.isoformat() + "Z",
            "start_address": "Zuhause",
            "end_address": ["Alpen Ausflug", "Bodensee", "Schwarzwald"][k],
            "duration_min": dur,
            "duration_str": f"{dur} min",
            "speed_max": 165,
            "speed_avg": round(dist / (dur / 60.0), 1),
            "power_max": 120, "power_min": -45,
            "odometer_details": {
                "odometer_start": round(odo_start, 1),
                "odometer_end": round(odo_end, 1),
                "odometer_distance": round(dist, 1),
            },
            "battery_details": {
                "start_battery_level": soc_s, "start_usable_battery_level": soc_s,
                "end_battery_level": soc_e, "end_usable_battery_level": soc_e,
                "reduced_range": False, "is_sufficiently_precise": True,
            },
            "outside_temp_avg": 15.0, "inside_temp_avg": 21.0,
            "energy_consumed_net": energy,
        })
        did += 1
    return out


def _mock_teslamate_sessions():
    """Liefert Beispiel-Sessions im Format der TeslaMate-REST-API
    (teslamateapi /cars/<id>/charges), passend zu sync_teslamate()."""
    base = datetime.now() - timedelta(days=100)
    out = []
    for i in range(6):
        started = base + timedelta(days=i * 18, hours=5)
        is_sc = i % 2 == 0
        addr = "Tesla Supercharger Beispielstadt" if is_sc else "A8 Tank & Rast"
        energy = round(45 + (i % 3) * 10, 1)
        out.append({
            "charge_id": 500 + i,
            "start_date": started.isoformat() + "Z",
            "end_date": (started + timedelta(hours=1)).isoformat() + "Z",
            "odometer": 42500 + i * 2900,
            "charge_energy_added": energy,
            "charge_energy_used": round(energy * 1.08, 1),
            "address": addr,
            "latitude": 48.1 + i * 0.01,
            "longitude": 11.5 + i * 0.01,
            "geofence": "Supercharger Beispielstadt" if is_sc else "A8 Rastplatz",
            "cost": round(18 + i * 2, 2) if is_sc else 0.0,
            "duration_min": 55,
            "start_battery_level": 20,
            "end_battery_level": 80,
        })

    # Zusaetzliche Home-Teilcharges (Geofence "Zuhause"), die zeitlich in die
    # EVCC-Mock-Sessions fallen (gleiche base-Berechnung wie _mock_evcc_sessions).
    # Simulation: 1 EVCC-Session -> 2 TeslaMate-Teilcharges (Kabel verbunden).
    evcc_base = datetime.now() - timedelta(days=120)
    for j in range(3):
        evcc_created = evcc_base + timedelta(days=j * 8, hours=2)
        # Teilcharge 1 (frueh)
        out.append({
            "charge_id": 600 + j * 2,
            "start_date": (evcc_created + timedelta(minutes=5)).isoformat() + "Z",
            "end_date": (evcc_created + timedelta(minutes=50)).isoformat() + "Z",
            "odometer": 42000 + j * 320,
            "charge_energy_added": round(4 + (j % 3), 1),
            "charge_energy_used": round((4 + (j % 3)) * 0.97, 1),
            "address": "Zuhause Garage",
            "latitude": 48.12,
            "longitude": 11.55,
            "geofence": "Zuhause",
            "cost": None,
            "duration_min": 45,
            "start_battery_level": 50,
            "end_battery_level": 65,
        })
        # Teilcharge 2 (spaeter, gleiche Kabelphase)
        out.append({
            "charge_id": 601 + j * 2,
            "start_date": (evcc_created + timedelta(minutes=55)).isoformat() + "Z",
            "end_date": (evcc_created + timedelta(minutes=110)).isoformat() + "Z",
            "odometer": 42000 + j * 320,
            "charge_energy_added": round(4 + (j % 3), 1),
            "charge_energy_used": round((4 + (j % 3)) * 0.97, 1),
            "address": "Zuhause Garage",
            "latitude": 48.12,
            "longitude": 11.55,
            "geofence": "Zuhause",
            "cost": None,
            "duration_min": 55,
            "start_battery_level": 65,
            "end_battery_level": 80,
        })
    return out


# ---------------------------------------------------------------------------
# Statistik
# ---------------------------------------------------------------------------
def all_sessions_with_distance():
    """Liefert home+external Sessions mit attribuierter Distanz (KM-Stand-Diff)."""
    db = get_db()
    rows = []
    for r in db.execute("SELECT * FROM home_sessions ORDER BY created ASC"):
        rows.append(("home", r))
    for r in db.execute("SELECT * FROM external_sessions ORDER BY started_at ASC"):
        rows.append(("external", r))
    rows.sort(key=lambda x: (x[1]["created"] if x[0] == "home" else x[1]["started_at"]))

    prev_odo = None
    result = []
    for kind, r in rows:
        odo = r["odometer"] if kind == "home" else r["odometer_start"]
        dist = 0.0
        if prev_odo is not None and odo is not None:
            d = odo - prev_odo
            if d > 0:
                dist = d
        prev_odo = odo if odo is not None else prev_odo
        result.append({"kind": kind, "row": r, "km_driven": dist})
    return result


def build_stats(days=365, from_date=None, to_date=None):
    db = get_db()
    if from_date and to_date:
        # Eigener Zeitraum: from..to (inklusive)
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None

    home_q = "SELECT * FROM home_sessions WHERE created >= ?"
    ext_q = "SELECT * FROM external_sessions WHERE started_at >= ?"
    extra_q = "SELECT * FROM extra_costs WHERE date >= ?"
    params = [cutoff]
    if end:
        home_q += " AND created <= ?"
        ext_q += " AND started_at <= ?"
        extra_q += " AND date <= ?"
        params = [cutoff, end]

    home_rows = [dict(r) for r in db.execute(home_q + " ORDER BY created ASC", params).fetchall()]
    external_rows = [dict(r) for r in db.execute(ext_q + " ORDER BY started_at ASC", params).fetchall()]
    extra_rows = [dict(r) for r in db.execute(extra_q + " ORDER BY date DESC", params).fetchall()]

    # --- Statistik auf Basis vereinheitlichter Charge-Sicht (services/stats.py) ---
    stats = build_stats_from_rows(
        home_rows, external_rows, extra_rows,
        price_lookup=get_price_at,
        get_price_at=get_price_at,
        days=days, from_date=from_date, to_date=to_date,
    )

    # Rückgewinnung der Felder für die Tages-Series (von der UI genutzt)
    home = [dict(r) for r in home_rows]
    # Externe = TM-Ladungen OHNE passendes EVCC-Wallbox-Fenster (Zeitfenster-Matching).
    # TM-Heim-Ladungen (falsch als "Oeffentliche Ladestation" gelabelt) liegen im
    # EVCC-Fenster -> gehoeren zu Zuhause, duerfen NICHT als extern gezaehlt werden.
    evcc_windows = []
    def _pd(v):
        s = str(v or "").replace("Z", "").replace("+00:00", "")
        try:
            return datetime.fromisoformat(s[:19])
        except Exception:
            return None
    for r in home_rows:
        sdt = _pd(r.get("created"))
        edt = _pd(r.get("finished")) or sdt
        if sdt is not None:
            evcc_windows.append((sdt, edt))
    def _tm_is_home(r):
        cdt = _pd(r.get("started_at"))
        if cdt is not None:
            for sdt, edt in evcc_windows:
                if sdt <= cdt <= edt:
                    return True
        return _is_home_external_row(dict(r))
    ext = [dict(r) for r in external_rows if not _tm_is_home(dict(r))]
    # Tages-Aggregation für Chart-Series
    from collections import defaultdict
    day_map = defaultdict(lambda: {"home_kwh": 0.0, "ext_kwh": 0.0, "cost": 0.0, "km": 0.0})
    for r in home:
        d = (r.get("created") or "")[:10]
        c = compute_home_cost_row(r)
        day_map[d]["home_kwh"] += float(r.get("charged_kwh") or 0)
        day_map[d]["cost"] += c["total_cost"]
    for r in ext:
        d = (r.get("started_at") or "")[:10]
        day_map[d]["ext_kwh"] += float(r.get("energy_kwh") or 0)
        day_map[d]["cost"] += float(r.get("cost_total") or 0)

    series = []
    cum_km = 0.0
    prev_odo = None
    odo_rows = []
    for r in home:
        odo_rows.append((r.get("created"), r.get("odometer")))
    for r in ext:
        odo_rows.append((r.get("started_at"), r.get("odometer_start")))
    odo_rows = [(d, o) for d, o in odo_rows if o is not None]
    odo_rows.sort(key=lambda x: x[0] or "")

    for d in sorted(day_map.keys()):
        agg = day_map[d]
        # Tages-Verbrauch (brutto) aus Home-kWh / Tages-km (vereinfacht)
        day_kwh = agg["home_kwh"]
        consumption = (day_kwh / agg["km"] * 100) if agg["km"] > 0 else None
        series.append({
            "day": d,
            "home_kwh": round(agg["home_kwh"], 2),
            "ext_kwh": round(agg["ext_kwh"], 2),
            "cost": round(agg["cost"], 2),
            "consumption": round(consumption, 2) if consumption else None,
            "price_per_kwh": round(agg["cost"] / day_kwh, 3) if day_kwh else 0,
            "cost_per_100": None,  # wird UI-seitig falls benötigt berechnet
            "cum_km": 0,
        })

    # KPIs für UI (aus totals + home/external)
    t = stats["totals"]
    # Echte PV/Grid-Werte aus den Home-Sessions aggregieren (nicht 0 setzen!)
    _hb_grid_kwh = 0.0
    _hb_pv_kwh = 0.0
    _hb_grid_cost = 0.0
    _hb_pv_cost = 0.0
    _hb_solar_sum = 0.0
    for r in home:
        c = compute_home_cost_row(r)
        _hb_grid_kwh += c["grid_kwh"]
        _hb_pv_kwh += c["pv_kwh"]
        _hb_grid_cost += c["grid_cost"]
        _hb_pv_cost += c["pv_cost"]
        _hb_solar_sum += float(r.get("solar_percentage") or 0)
    _hb_pv_share = (_hb_pv_kwh / _hb_grid_kwh * 100) if _hb_grid_kwh > 0 else 0
    _hb_solar_pct_avg = (_hb_solar_sum / len(home)) if home else 0
    _hb_kwh_total = _hb_grid_kwh + _hb_pv_kwh
    home_block = {
        "count": len(home), "kwh": t["home_kwh"],
        "grid_kwh": round(_hb_grid_kwh, 2),
        "pv_kwh": round(_hb_pv_kwh, 2),
        "grid_cost": round(_hb_grid_cost, 2),
        "pv_cost": round(_hb_pv_cost, 2),
        "cost": round(_hb_grid_cost + _hb_pv_cost, 2),
        # PV-Anteil als Prozent der GELADENEN kWh (nicht grid-bezogen!)
        "pv_share_pct": round((_hb_pv_kwh / _hb_kwh_total * 100) if _hb_kwh_total > 0 else _hb_solar_pct_avg, 1),
    }
    external_block = {
        "count": len(ext), "kwh": t["ext_kwh"], "cost": t["cost_external"],
        "share_pct": round(t["ext_kwh"] / (t["home_kwh"] + t["ext_kwh"]) * 100, 1) if (t["home_kwh"] + t["ext_kwh"]) else 0,
        "cost_per_kwh": round(t["cost_external"] / t["ext_kwh"], 3) if t["ext_kwh"] else 0,
    }
    extra_block = {
        "count": len(extra_rows), "total": t["cost_extra"],
        "by_category": {},
    }
    stats["home"] = home_block
    stats["external"] = external_block
    stats["extra"] = extra_block
    stats["series"] = series
    return stats


def _is_home_external_row(r):
    """True, wenn eine external_sessions-Zeile eine TM-Home-Ladung ist
    (doppeltes Tracking mit EVCC)."""
    text = f"{r.get('location_name') or ''} {r.get('address') or ''}".lower()
    markers = ["zuhause", "garage", "wallbox", "home"]
    return any(m in text for m in markers)


# ---------------------------------------------------------------------------
# Routen - Seiten
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    # Cache-Buster: aendert sich bei jedem Container-Start (APP_VERSION aus ENV,
    # im entrypoint auf die Startzeit gesetzt) -> Browser holt nach einem Deploy
    # zwingend die neue app.js (kein veralteter JS-Cache).
    js_ver = os.environ.get("APP_VERSION", "1")
    return render_template("index.html", mock=mock_mode(), js_version=js_ver)


@app.route("/statistik")
def statistik():
    js_ver = os.environ.get("APP_VERSION", "1")
    return render_template("statistik.html", mock=mock_mode(), js_version=js_ver)


@app.route("/evcc")
def evcc():
    js_ver = os.environ.get("APP_VERSION", "1")
    return render_template("evcc.html", mock=mock_mode(), js_version=js_ver)


@app.route("/teslamate")
def teslamate():
    js_ver = os.environ.get("APP_VERSION", "1")
    return render_template("teslamate.html", mock=mock_mode(), js_version=js_ver)


@app.route("/extra")
def extra():
    js_ver = os.environ.get("APP_VERSION", "1")
    return render_template("extra.html", mock=mock_mode(), js_version=js_ver)


@app.route("/analytics")
def analytics():
    js_ver = os.environ.get("APP_VERSION", "1")
    return render_template("analytics.html", mock=mock_mode(), js_version=js_ver)


@app.route("/api/version")
def api_version():
    """Sichtbare Versionsinfo, damit der User sofort sieht, welche
    App-Version im Browser laeuft (Cache-Buster-Kontrolle)."""
    av = os.environ.get("APP_VERSION", "unknown")
    commit = "n/a"
    # 1) zur Build-Zeit geschriebene Datei (zuverlaessig, auch ohne .git im Image)
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "BUILD_COMMIT")
        if os.path.exists(p):
            with open(p) as f:
                commit = f.read().strip() or "n/a"
    except Exception:
        pass
    # 2) Fallback: live aus git (falls .git im Container vorhanden)
    if commit == "n/a":
        try:
            commit = subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                stderr=subprocess.DEVNULL
            ).decode().strip() or "n/a"
        except Exception:
            commit = "n/a"
    return jsonify({
        "app_version": av,
        "commit": commit,
        "mock": mock_mode(),
    })


@app.route("/api/debug/db")
def api_debug_db():
    """Diagnose: zeigt, welche Datenbank die App tatsaechlich nutzt.

    Hilft, wenn 'alte Daten' angezeigt werden oder Loeschen nicht
    persistiert – meistens weil DB_PATH auf eine andere Datei zeigt als
    der gemountete ./data-Ordner.
    """
    import os as _os
    info = {
        "DB_PATH": DB_PATH,
        "db_exists": _os.path.exists(DB_PATH),
        "db_size_bytes": _os.path.getsize(DB_PATH) if _os.path.exists(DB_PATH) else 0,
        "db_writable": (lambda p: _os.access(_os.path.dirname(p) or ".", _os.W_OK) if _os.path.dirname(p) else False)(DB_PATH),
        "data_dir": _os.path.dirname(DB_PATH),
        "data_dir_exists": _os.path.isdir(_os.path.dirname(DB_PATH) or "."),
        "data_dir_writable": _os.access(_os.path.dirname(DB_PATH) or ".", _os.W_OK) if _os.path.dirname(DB_PATH) else False,
    }
    try:
        db = get_db()
        info["home_sessions"] = db.execute("SELECT COUNT(*) AS c FROM home_sessions").fetchone()["c"]
        info["external_sessions"] = db.execute("SELECT COUNT(*) AS c FROM external_sessions").fetchone()["c"]
        info["price_periods"] = db.execute("SELECT COUNT(*) AS c FROM price_periods").fetchone()["c"]
        info["extra_costs"] = db.execute("SELECT COUNT(*) AS c FROM extra_costs").fetchone()["c"]
    except Exception as e:
        info["error"] = str(e)
    return jsonify(info)


@app.route("/admin")
def admin():
    return render_template("admin.html", mock=mock_mode())


# ---------------------------------------------------------------------------
# Routen - API
# ---------------------------------------------------------------------------
@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "POST":
        d = request.get_json(force=True) or {}
        # Erlaubte Felder (Passwörter/Tokens nur wenn nicht leer)
        for section in ("evcc", "teslamate", "app"):
            if section in d and isinstance(d[section], dict):
                for k, v in d[section].items():
                    # home_addresses darf auch neu angelegt werden (kann in alter config fehlen)
                    if k in config.get(section, {}) or (section == "app" and k == "home_addresses"):
                        # leere Passwörter/Tokens nicht überschreiben (sonst würden sie gelöscht)
                        if k in ("password", "api_token") and (v == "" or v is None):
                            continue
                        config.setdefault(section, {})[k] = v
        # pricing_defaults
        if "pricing_defaults" in d and isinstance(d["pricing_defaults"], dict):
            config.setdefault("pricing_defaults", {})
            config["pricing_defaults"].update(d["pricing_defaults"])
        # YAML persistieren. CONFIG_PATH kann eine Datei (/app/config.yaml)
        # oder ein Verzeichnis (/app/config) sein. Im Verzeichnis-Fall (oder
        # wenn Docker aus einem Datei-Mount ein gleichnamiges Verzeichnis
        # erzeugt hat) wird die Datei konsistent in CONFIG_PATH/config.yaml
        # geschrieben – exakt wie load_config() sie liest.
        target = CONFIG_PATH
        try:
            if os.path.isdir(target):
                # CONFIG_PATH ist ein Verzeichnis -> Datei darin ablegen
                target = os.path.join(target, "config.yaml")
            elif os.path.isdir(os.path.dirname(target)) and os.path.basename(target) == "config.yaml" and os.path.exists(target) and os.path.isdir(target):
                # Edge-Case: sollte nicht eintreten, aber konsistent halten
                pass
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w") as f:
                yaml.safe_dump(config, f, default_flow_style=False, allow_unicode=True)
            # Globalen Cache nach dem Schreiben neu laden, damit F5 (gleicher
            # Container) sofort die frisch gespeicherten Werte zeigt.
            _reload_config()
            return jsonify({"ok": True, "saved_to": target})
        except Exception as e:
            app.logger.error(f"Config speichern fehlgeschlagen: {e}")
            return jsonify({"ok": False, "error": str(e)}), 500
    c = json.loads(json.dumps(config))
    # Passwörter/Tokens nie ausliefern
    c["evcc"]["password"] = "" if c["evcc"].get("password") else ""
    c["evcc"]["api_token"] = "" if c["evcc"].get("api_token") else ""
    c["teslamate"]["api_token"] = "" if c["teslamate"].get("api_token") else ""
    c["app"]["mock_mode"] = mock_mode()
    return jsonify(c)


_config_mtime = None


def _maybe_reload_config():
    """Laedt die Konfiguration neu, falls die Datei sich seit dem letzten
    Laden geaendert hat (mtime-Check). Sehr guenstig (nur stat, kein Parsen),
    verhindert aber Cache-Staleness nach dem Speichern oder nach einem
    erneuten Mount. Ein Browser-F5 sieht immer die persistierten Werte."""
    global config, _config_mtime
    try:
        if not os.path.exists(CONFIG_PATH):
            return
        mtime = os.path.getmtime(CONFIG_PATH)
        if _config_mtime is None or mtime > _config_mtime:
            config = load_config()
            _config_mtime = mtime
    except Exception:
        pass


def _reload_config():
    """Laedt die Konfiguration frisch aus der Datei in den globalen Cache.

    Wird nach dem Speichern (api_config POST) aufgerufen, damit ein
    Browser-F5 (gleicher Container) sofort die frisch gespeicherten Werte
    zeigt. Setzt auch den mtime-Cache zurueck.
    """
    global config, _config_mtime
    config = load_config()
    try:
        if os.path.exists(CONFIG_PATH):
            _config_mtime = os.path.getmtime(CONFIG_PATH)
    except Exception:
        pass


@app.route("/api/sync/evcc", methods=["POST"])
def api_sync_evcc():
    res = sync_evcc()
    return jsonify({"ok": True, **res})


@app.route("/api/sync/teslamate", methods=["POST"])
def api_sync_teslamate():
    res = sync_teslamate()
    return jsonify({"ok": True, **res})


@app.route("/api/sync/drives", methods=["POST"])
def api_sync_drives():
    res = sync_teslamate_drives()
    return jsonify({"ok": True, **res})


@app.route("/api/sync/all", methods=["POST"])
def api_sync_all():
    e = sync_evcc()
    t = sync_teslamate()
    d = sync_teslamate_drives()
    return jsonify({"ok": True, "evcc": e, "teslamate": t, "drives": d})


@app.route("/api/sync/backfill-teslamate", methods=["POST"])
def api_sync_backfill_teslamate():
    """Schreibt berechnete Home-Kosten zurueck in TeslaMate charging_processes.cost.

    Regel: NUR existierende Charges werden angereichert (kein kuenstliches Anlegen
    neuer Charges). Voraussetzung: EVCC-Sync lieferte matched_home-Sessions mit
    teslamate_session_id. Die Kosten werden aus PV-/Grid-Split + Preisperioden
    neu berechnet (Opportunitaetskosten via Einspeiseverguetung)."""
    db = get_db()
    home_rows = [dict(r) for r in db.execute(
        "SELECT * FROM home_sessions ORDER BY created ASC").fetchall()]
    external_rows = [dict(r) for r in db.execute(
        "SELECT * FROM external_sessions ORDER BY started_at ASC").fetchall()]
    home_geofences = [a.strip().lower() for a in config.get("app", {}).get("home_addresses", []) if a and a.strip()]
    from services.stats import build_cable_sessions_from_rows
    cable_sessions, _unmatched_evcc, _external_unified = build_cable_sessions_from_rows(
        home_rows, external_rows, home_geofences)

    grid_default = float((config.get("pricing_defaults") or {}).get("grid_price_per_kwh", 0.32))
    feedin_default = float((config.get("pricing_defaults") or {}).get("feedin_price_per_kwh", 0.08))

    rows = []
    for cable in cable_sessions:
        if not cable.teslamate_charge_ids:
            continue
        wall = cable.wall_kwh
        pv_share = cable.pv_share_pct
        pv_kwh, grid_kwh = (wall * pv_share / 100.0, max(0.0, wall - wall * pv_share / 100.0)) \
            if pv_share else (0.0, wall)
        cost = round(grid_kwh * grid_default + pv_kwh * feedin_default, 2)
        rows.append({
            "teslamate_charge_ids": cable.teslamate_charge_ids,
            "cost": cost,
        })
    if not rows:
        return jsonify({"ok": True, "updated": 0, "errors": [],
                        "note": "Keine gematchten Home-Ladungen mit TM-Referenz gefunden."})
    tm_cfg = config["teslamate"]
    client = TeslaMateClient(tm_cfg["url"], tm_cfg.get("api_token", ""))
    try:
        from services.stats import backfill_teslamate_costs
        updated, errors = backfill_teslamate_costs(
            client, rows, get_price_at, grid_default, feedin_default)
        return jsonify({"ok": True, "updated": updated, "errors": errors})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/stats")
def api_stats():
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    return jsonify(build_stats(days, from_date, to_date))


@app.route("/api/sessions")
def api_sessions():
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 100, type=int)
    # Zeitraum-Filter (wie /api/stats) -> Home/Ext-Tabs respektieren die
    # Zeitraum-Auswahl, nicht nur die Summary-Kacheln.
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
        home_q = "SELECT * FROM home_sessions WHERE created >= ? AND created <= ? ORDER BY created DESC"
        ext_q = "SELECT * FROM external_sessions WHERE started_at >= ? AND started_at <= ? ORDER BY started_at DESC"
        params = [cutoff, end]
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        home_q = "SELECT * FROM home_sessions WHERE created >= ? ORDER BY created DESC"
        ext_q = "SELECT * FROM external_sessions WHERE started_at >= ? ORDER BY started_at DESC"
        params = [cutoff]
    db = get_db()
    # Get total count for pagination
    if from_date and to_date:
        count_params = [cutoff, end]
    else:
        count_params = [cutoff]
    home_count = db.execute(f"SELECT COUNT(*) FROM ({home_q})", count_params).fetchone()[0]
    ext_count = db.execute(f"SELECT COUNT(*) FROM ({ext_q})", count_params).fetchone()[0]
    # Apply pagination
    offset = (page - 1) * per_page
    home_q += " LIMIT ? OFFSET ?"
    ext_q += " LIMIT ? OFFSET ?"
    params_with_limit = params + [per_page, offset]
    home = [dict(r) for r in db.execute(home_q, params_with_limit).fetchall()]
    # Kosten immer frisch aus den (ggf. geänderten) Preisperioden berechnen
    for r in home:
        c = compute_home_cost_row(r)
        r.update(c)
        # Datenschutz: keine Rohdaten/Payload im JSON
        r["raw"] = None
        r["has_raw"] = bool(r.get("raw"))
    ext = [dict(r) for r in db.execute(ext_q, params_with_limit).fetchall()]
    for r in ext:
        # Datenschutz: rohe Adresse durch anonymisiertes Label ersetzen,
        # GPS-Koordinaten entfernen, raw nur als Flag belassen.
        r["address"] = _location_label(r.get("location_name"), r.get("address"))
        r["latitude"] = None
        r["longitude"] = None
        r["has_raw"] = bool(r.get("raw"))
        r.pop("raw", None)
    return jsonify({
        "home": home, 
        "external": ext,
        "pagination": {
            "page": page,
            "per_page": per_page,
            "home_total": home_count,
            "external_total": ext_count,
            "home_pages": (home_count + per_page - 1) // per_page,
            "external_pages": (ext_count + per_page - 1) // per_page
        }
    })


@app.route("/api/charges")
def api_charges():
    """Vereinheitlichte Charge-Sicht (CableSession-Matching).

    Liefert:
      - matched_home : Liste von CableSessions (1 EVCC + n TeslaMate-Teilcharges)
      - evcc_only    : EVCC-Sessions ohne TM-Gegenstück
      - external     : externe Charges (teslamate_only)

    EVCC ist führend für wall_kwh / Kosten; TeslaMate liefert battery_kwh
    (Summe der Teilladungen) und charging_loss. Keine Doppelzählung.
    """
    db = get_db()
    home_rows = [dict(r) for r in db.execute(
        "SELECT * FROM home_sessions ORDER BY created ASC").fetchall()]
    external_rows = [dict(r) for r in db.execute(
        "SELECT * FROM external_sessions ORDER BY started_at ASC").fetchall()]
    home_geofences = [a.strip().lower() for a in config.get("app", {}).get("home_addresses", []) if a and a.strip()]

    from services.stats import build_cable_sessions_from_rows
    cable_sessions, unmatched_evcc, external_unified = build_cable_sessions_from_rows(
        home_rows, external_rows, home_geofences)

    grid_default = float((config.get("pricing_defaults") or {}).get("grid_price_per_kwh", 0.32))
    feedin_default = float((config.get("pricing_defaults") or {}).get("feedin_price_per_kwh", 0.08))

    matched = []
    for cable in cable_sessions:
        # battery_kwh bereits Summe der TM-Teilcharges im CableSession
        wall = cable.wall_kwh
        pv_share = cable.pv_share_pct
        pv_kwh, grid_kwh = (wall * pv_share / 100.0, max(0.0, wall - wall * pv_share / 100.0)) \
            if pv_share else (0.0, wall)
        cost = round(grid_kwh * grid_default + pv_kwh * feedin_default, 2)
        matched.append({
            "evcc_session_id": cable.evcc_session_id,
            "teslamate_charge_ids": cable.teslamate_charge_ids,
            "started_at": cable.started_at.isoformat() if cable.started_at else None,
            "finished_at": cable.finished_at.isoformat() if cable.finished_at else None,
            "provider": cable.provider,
            "odometer_km": cable.odometer_km,
            "wall_kwh": wall,
            "battery_kwh": cable.battery_kwh,
            "charging_loss_kwh": cable.charging_loss_kwh,
            "pv_share_pct": round(pv_share, 1),
            "pv_kwh": round(pv_kwh, 3),
            "grid_kwh": round(grid_kwh, 3),
            "total_cost": cost,
            "cost_source": "evcc_calc",
            "match_quality": "exact" if (cable.battery_kwh and abs(wall - cable.battery_kwh) <= 8.0) else "fuzzy",
        })

    evcc_only = [{
        "evcc_session_id": ev.id,
        "wall_kwh": ev.charged_energy_kwh,
        "started_at": ev.created.isoformat() if ev.created else None,
        "finished_at": ev.finished.isoformat() if ev.finished else None,
        "provider": ev.loadpoint,
        "odometer_km": ev.odometer,
        "battery_kwh": None,
        "charging_loss_kwh": None,
        "cost_source": "none",
    } for ev in unmatched_evcc]

    external = [{
        "teslamate_charge_ids": u.teslamate_charge_ids,
        "started_at": u.started_at.isoformat() if u.started_at else None,
        "finished_at": u.finished_at.isoformat() if u.finished_at else None,
        "provider": u.provider,
        "odometer_km": u.odometer_km,
        "battery_kwh": u.battery_kwh,
        "total_cost": u.total_cost,
        "cost_source": u.cost_source,
        "location_type": u.location_type,
    } for u in external_unified]

    return jsonify({
        "matched_home": matched,
        "evcc_only": evcc_only,
        "external": external,
        "summary": {
            "matched_count": len(matched),
            "evcc_only_count": len(evcc_only),
            "external_count": len(external),
            "note": "EVCC führend für wall_kwh/Kosten; TeslaMate ergänzt battery_kwh (Summe Teilladungen).",
        },
    })


@app.route("/api/status/live")
def api_status_live():
    """Live-Status aus teslamateapi (PluggedIn/ChargingState).

    WICHTIG: Dieser Endpunkt ist LIVE (MQTT-Cache), NICHT historisch.
    Er dient nur zur Anzeige ('gerade am Kabel') und wird NICHT zum Matching
    genutzt (das Home-Matching nutzt das EVCC-Zeitfenster)."""
    tm_cfg = config.get("teslamate", {})
    url = tm_cfg.get("url", "")
    if not url:
        return jsonify({"plugged_in": False, "charging_state": "", "available": False})
    if mock_mode():
        return jsonify({"plugged_in": True, "charging_state": "charging",
                        "geofence": "Zuhause", "battery_level": 72, "available": True, "mock": True})
    try:
        client = TeslaMateClient(url, tm_cfg.get("api_token", ""))
        status = client.get_status()
        status["available"] = True
        return jsonify(status)
    except Exception as e:
        return jsonify({"plugged_in": False, "charging_state": "", "available": False, "error": str(e)})




# ---------------------------------------------------------------------------
# Zusammenfassung: pro Tag + Ladestation, EVCC führend + TeslaMate-Werte
# (TeslaMate-PV-Fragmente werden bei Lücke < 60min + gleicher Adresse gemerged)
# ---------------------------------------------------------------------------
TM_MERGE_GAP_MIN = 60

def _str(v):
    """Sicher zu String konvertieren (datetime -> ISO, bytes -> utf-8, None -> '')."""
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except Exception:
            return str(v)
    return str(v)


def _day_of(v):
    """Kalendertag (YYYY-MM-DD) aus einem Datum/String sicher extrahieren."""
    s = _str(v)
    return s[:10] if s else ""


def _tm_grouped_sessions(rows):
    """external_sessions (TeslaMate) nach Adresse + Zeitlücke zu Sessions gruppieren."""
    rows = sorted(rows, key=lambda r: _day_of(r.get("started_at")))
    if not rows:
        return []
    groups, cur = [], [rows[0]]
    for r in rows[1:]:
        prev = cur[-1]
        prev_end = _str(prev.get("finished_at") or prev.get("started_at"))
        this_start = _str(r.get("started_at"))
        try:
            gap = (datetime.fromisoformat(this_start) -
                   datetime.fromisoformat(prev_end)).total_seconds() / 60
        except Exception:
            gap = 999
        same_addr = (prev.get("address") or "").strip() == (r.get("address") or "").strip()
        # Nie ueber Tagesgrenzen zusammenfassen: pro Tag eine getrennte Ladung.
        same_day = (this_start or "")[:10] == (prev.get("started_at") or "")[:10]
        if gap < TM_MERGE_GAP_MIN and same_addr and same_day:
            cur.append(r)
        else:
            groups.append(cur)
            cur = [r]
    groups.append(cur)
    out = []
    for g in groups:
        added = sum(float(x.get("energy_kwh") or 0) for x in g)
        used = sum(float(x.get("energy_used_kwh") or x.get("energy_kwh") or 0) for x in g)
        cost = sum(float(x.get("cost_total") or 0) for x in g)
        out.append({
            "tm_ids": [x.get("teslamate_session_id") for x in g],
            "start": g[0].get("started_at"),
            "end": g[-1].get("finished_at"),
            "address": g[0].get("address") or g[0].get("location_name") or "",
            "added": round(added, 2),
            "used": round(used, 2),
            "cost": round(cost, 2),
            "n_frags": len(g),
            "frags": g,
        })
    return out


def _build_merged(rows):
    """Eine Zeile PRO TAG. Grundsatz:
    - Zuhause = EVCC (Wallbox) IST fuehrend fuer kWh/Kosten/km.
    - TeslaMate-Zuhause (Stadt irgendwo) = dieselben wie EVCC,
      werden nur fuer added/used -> Ladeverluste genutzt, NIE zur Energie addiert.
    - Extern = nur TeslaMate-Ladungen an Fremd-Adressen (z.B. Supercharger Engen).
    Mehrere Ladestationen pro Tag bleiben in der Aufklapp-Liste sichtbar.
    """
    from collections import defaultdict
    days = defaultdict(lambda: {"evcc": [], "tm_home": [], "tm_ext": []})

    def _parse_dt(v):
        """ISO-String -> naive datetime (Zeitzone verwerfen; nur Kalendertag
        wird verglichen, also egal). Verhindert 'offset-naive vs offset-aware'
        Vergleichsfehler bei fromisoformat mit 'Z'."""
        s = _str(v)
        if not s:
            return None
        s = s.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
            return dt.replace(tzinfo=None)
        except Exception:
            return None

    # EVCC (immer Zuhause, fuehrend) -> nach STARTTAG buchen
    # Zusaetzlich Zeitfenster [created, finished] merken, um TM-Teilladungen
    # (die ueber Mitternacht in andere Kalendertage rutschen) derselben
    # EVCC-Sitzung / demselben Starttag zuzuordnen.
    evcc_windows = []  # (start_dt, end_dt, day)
    for r in rows.get("home", []):
        day = _day_of(r.get("created"))
        days[day]["evcc"].append(r)
        sdt = _parse_dt(r.get("created"))
        edt = _parse_dt(r.get("finished")) or sdt
        if sdt is not None:
            evcc_windows.append((sdt, edt, day))
    evcc_windows.sort(key=lambda w: w[0])

    def _assign_day(charge_start_iso):
        """Ordnet eine TM-Ladung dem EVCC-Sitzungstag zu (Fenster enthaelt Start).
        Faellt zurueck auf den eigenen Kalendertag, wenn kein EVCC-Fenster passt."""
        cdt = _parse_dt(charge_start_iso)
        if cdt is None:
            return _day_of(_str(charge_start_iso))
        for sdt, edt, day in evcc_windows:
            if sdt <= cdt <= edt:
                return day
        return _day_of(_str(charge_start_iso))

    # TeslaMate: Zuhause vs. Extern trennen.
    # WICHTIG: Nicht ueber den Geofence-String (TM liefert bei Heim-Ladungen
    # oft falsche Labels wie "Oeffentliche Ladestation"). Stattdessen wird jede
    # TM-Ladung via Zeitfenster-Matching EVCC zugeordnet: liegt sie im Fenster
    # einer EVCC-Wallbox-Sitzung -> Zuhause (doppeltes Tracking, NICHT extern).
    # Nur TM-Ladungen OHNE passendes EVCC-Fenster sind echte Externe.
    home_rows, ext_rows = [], []
    for r in rows.get("external", []):
        start_iso = r.get("started_at")
        assigned = False
        cdt = _parse_dt(start_iso)
        if cdt is not None:
            for sdt, edt, _day in evcc_windows:
                if sdt <= cdt <= edt:
                    assigned = True
                    break
        if assigned:
            home_rows.append(r)
        elif _is_home_address(r.get("location_name"), r.get("address")):
            # Fallback: kein EVCC-Fenster, aber eindeutig als Zuhause gelabelt
            home_rows.append(r)
        else:
            ext_rows.append(r)

    # TM-Zuhause: pro EVCC-Sitzungstag buckets bilden, dann gruppieren
    home_by_day = defaultdict(list)
    for r in home_rows:
        home_by_day[_assign_day(r.get("started_at"))].append(r)
    for day, rws in home_by_day.items():
        for g in _tm_grouped_sessions(rws):
            days[day]["tm_home"].append(g)

    # TM-Extern gruppieren (echte Fremdladungen, eigene Energie, nach Kalendertag)
    for g in _tm_grouped_sessions(ext_rows):
        day = _day_of(g["start"])
        days[day]["tm_ext"].append(g)

    result = []
    for day, v in days.items():
        # --- Zuhause: EVCC ist fuehrend ---
        ev_kwh = sum(float(e.get("charged_kwh") or 0) for e in v["evcc"])
        ev_cost = sum(float(e.get("total_cost") or 0) for e in v["evcc"])
        ev_solar = (sum(float(e.get("solar_percentage") or 0) for e in v["evcc"]) / len(v["evcc"])) if v["evcc"] else 0
        # TM-Zuhause: added = im Akku angekommen. ECHTER Ladeverlust zuhause
        # = EVCC-Wallbox (Wand) - TM added (Akku).
        # ABER: TeslaMate hat teils Datenluecken (Auto offline etc.). Dann ist
        # TM_added << EVCC und die Differenz ist KEIN Verlust, sondern eine
        # fehlende TM-Ladung. Verlust daher nur zeigen, wenn plausibel:
        # - TM added deckt >=70% der EVCC-kWh ab (sonst Datenluecke)
        # - Verlust liegt zwischen 0 und 30% (physikalisch realistisch)
        tmh_added = sum(t["added"] for t in v["tm_home"])
        tmh_used = sum(t["used"] for t in v["tm_home"])
        home_loss = None  # None = nicht ermittelbar -> Frontend zeigt "–"
        # TM 'used' = Wand (brutto) -> entspricht EVCC. 'added' = Akku (netto).
        # Deckung ueber TM_used pruefen (nicht added), weil used der EVCC-Wand
        # am naechsten kommt. added ist immer < EVCC (Ladeverlust), daher wuerde
        # eine added-basierte Schwellenwert-Tage mit echtem TM-Daten fälschlich
        # ausschliessen (z.B. 06.29).
        if ev_kwh > 0 and tmh_used > 0:
            used_cov = tmh_used / ev_kwh
            if 0.70 <= used_cov <= 1.30:
                loss = ev_kwh - tmh_added      # Wand(EVCC) - Akku(TM)
                loss_pct = loss / ev_kwh
                if 0 <= loss_pct <= 0.35:       # physikalisch realistisch
                    home_loss = round(loss, 2)

        # --- Extern: nur echte Fremdladungen ---
        ext_kwh = sum(t["added"] for t in v["tm_ext"])
        ext_used = sum(t["used"] for t in v["tm_ext"])
        ext_cost = sum(t["cost"] for t in v["tm_ext"])
        ext_loss = round(ext_used - ext_kwh, 2) if (ext_kwh and ext_used) else 0.0

        # Ladestationen des Tages (fuer "mehrere Stationen sichtbar")
        stations = []
        if v["evcc"]:
            stations.append("Wallbox")
        for g in v["tm_home"]:
            a = g.get("address") or "Zuhause"
            if a not in stations:
                stations.append(a)
        for g in v["tm_ext"]:
            a = g.get("address") or "Extern"
            if a not in stations:
                stations.append(a)

        result.append({
            "day": day,
            "stations": stations,           # Liste aller genutzten Stationen
            "n_stations": len(stations),
            # Zuhause (EVCC fuehrend)
            "home_kwh": round(ev_kwh, 2),
            "home_cost": round(ev_cost, 2),
            "home_solar_pct": round(ev_solar, 1),
            "home_loss": home_loss,
            "tm_home_added": round(tmh_added, 2),
            "tm_home_used": round(tmh_used, 2),
            # Extern (nur Fremd)
            "ext_kwh": round(ext_kwh, 2),
            "ext_cost": round(ext_cost, 2),
            "ext_loss": ext_loss,
            # Gesamt (Zuhause EVCC + echte Externe, KEINE Doppelzaehlung)
            "total_kwh": round(ev_kwh + ext_kwh, 2),
            "total_cost": round(ev_cost + ext_cost, 2),
            # Detail-Daten fuer Aufklappen
            "evcc": v["evcc"],
            "tm_home": v["tm_home"],
            "tm_ext": v["tm_ext"],
        })
    result.sort(key=lambda x: x["day"], reverse=True)
    return result


@app.route("/api/merged")
def api_merged():
    # api_sessions() liest den Zeitraum selbst aus request.args (gleicher
    # Request-Kontext), daher hier kein expliziter Durchreich-Parameter nötig.
    sess = api_sessions().get_json()
    return jsonify(_build_merged(sess))


@app.route("/api/charts")
def api_charts():
    """Statistik-Ansicht (Road-Trip-App-Stil): 4 Zeitreihen + KPIs.
    1) Verbrauch kWh/100km  2) €/kWh  3) €/100km  4) kumulierte km
    Plus Sekundaer-KPIs: geladene kWh, Reichweite, Ladeverluste, AC/DC, CO2.
    """
    days_param = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days_param)).isoformat()
        end = None
    db = get_db()
    evcc_q = "SELECT created, finished, charged_kwh, total_cost, odometer, price_per_kwh, solar_percentage, loadpoint, raw FROM home_sessions WHERE created >= ?"
    tm_q = "SELECT started_at, energy_kwh, energy_used_kwh, cost_total, odometer_start, latitude, longitude, address, raw, price_per_kwh FROM external_sessions WHERE started_at >= ?"
    params = [cutoff]
    if end:
        evcc_q += " AND created <= ?"
        tm_q += " AND started_at <= ?"
        params = [cutoff, end]
    evcc = [dict(r) for r in db.execute(evcc_q + " ORDER BY created ASC", params).fetchall()]
    # Gesamt-km = LETZTER (neuester) Tachostand ueber alle Sessions (= Tacho km, 1:1 zum Auto-Tacho).
    # EVCC 'odometer' ist der absolute Tachostand in km. Wir nehmen den zeitlich
    # letzten Wert (nicht blind max), damit ein Ausreisser das Ergebnis nicht verfaelscht.
    _odo_dated = []
    for e in evcc:
        try: _odo_dated.append(((e.get("created") or "")[:19], float(e.get("odometer") or 0)))
        except Exception: pass
    tm_odo = [dict(r) for r in db.execute(
        "SELECT started_at, odometer_start FROM external_sessions")]
    for t in tm_odo:
        try: _odo_dated.append(((t.get("started_at") or "")[:19], float(t.get("odometer_start") or 0)))
        except Exception: pass
    _odo_dated = [x for x in _odo_dated if x[1] > 0]
    _odo_dated.sort(key=lambda x: x[0])
    _total_km_odo = _odo_dated[-1][1] if _odo_dated else 0.0

    def _evcc_co2(raw):
        try:
            j = json.loads(raw) if isinstance(raw, str) else raw
            return float(j.get("co2PerKWh") or 0)
        except Exception:
            return 0.0
    tm = [dict(r) for r in db.execute(tm_q + " ORDER BY started_at ASC", params).fetchall()]

    def _tm_range_end(raw):
        """Reichweite (ideal) aus TeslaMate raw-JSON holen."""
        try:
            j = json.loads(raw) if isinstance(raw, str) else raw
            return float(j.get("range_ideal", {}).get("end_range", 0) or 0)
        except Exception:
            return 0.0

    from collections import defaultdict
    # Tagesgruppierung
    day_kwh = defaultdict(float)
    day_cost = defaultdict(float)
    day_odo_start = defaultdict(float)
    day_odo_end = defaultdict(float)
    day_price = defaultdict(list)   # €/kWh gewichtet
    day_co2 = defaultdict(list)
    day_dc_kwh = defaultdict(float)  # Supercharger = DC
    day_ac_kwh = defaultdict(float)
    day_dc_cost = defaultdict(float)  # echte DC-Kosten (Punkt 5)
    day_ac_cost = defaultdict(float)  # echte AC-Kosten (Punkt 5)
    day_added = defaultdict(float)   # TM added (Akku)
    day_used = defaultdict(float)    # TM used (Wand)
    day_range_end = defaultdict(float)

    for e in evcc:
        day = (e.get("created") or "")[:10]
        kwh = float(e.get("charged_kwh") or 0)
        day_kwh[day] += kwh
        day_cost[day] += float(e.get("total_cost") or 0)
        o = float(e.get("odometer") or 0)
        day_odo_start[day] = min(day_odo_start[day] or o, o) if day_odo_start[day] else o
        day_odo_end[day] = max(day_odo_end[day], o)
        ppk = e.get("price_per_kwh")
        if ppk: day_price[day].append((ppk, kwh))
        co2 = _evcc_co2(e.get("raw"))
        if co2: day_co2[day].append((co2, kwh))
        day_ac_kwh[day] += kwh  # EVCC = AC (Wallbox)

    for t in tm:
        day = (t.get("started_at") or "")[:10]
        kwh = float(t.get("energy_kwh") or 0)
        added = float(t.get("energy_kwh") or 0)
        used = float(t.get("energy_used_kwh") or 0)
        day_added[day] += added
        day_used[day] += used
        o = float(t.get("odometer_start") or 0)
        day_odo_start[day] = min(day_odo_start[day] or o, o) if day_odo_start[day] else o
        day_odo_end[day] = max(day_odo_end[day], o)
        is_dc = "supercharger" in (t.get("address") or "").lower()
        # TM-Ladungen zaehlen nur zum AC/DC-Anteil, wenn sie EXTERN sind
        # (Supercharger=DC, andere Fremd=AC). TM-Zuhause ist dieselbe Ladung
        # wie EVCC -> NICHT nochmal zaehlen (Doppelzaehlung).
        is_home = _is_home_address(t.get("address"), t.get("address"))
        if not is_home:
            if is_dc:
                day_dc_kwh[day] += kwh
                day_dc_cost[day] += float(t.get("cost_total") or 0)
            else:
                day_ac_kwh[day] += kwh
                day_ac_cost[day] += float(t.get("cost_total") or 0)
            # Auch zur Tages-Gesamtenergie/Kosten hinzufuegen (fuer Charts/Stats)
            # Extern: Wand-Energie = energy_used_kwh, Kosten = cost_total
            day_kwh[day] += used
            day_cost[day] += float(t.get("cost_total") or 0)
            # price_per_kwh fuer extern (falls vorhanden)
            ppk = t.get("price_per_kwh")
            if ppk:
                day_price[day].append((ppk, used))
        re = _tm_range_end(t.get("raw"))
        if re: day_range_end[day] = max(day_range_end[day], re)

    days = sorted(set(list(day_kwh) + list(day_added)))
    # km pro Tag ueber odometer-Diff (kumuliert)
    cum_km = 0.0
    prev_odo = None
    series = []
    for d in days:
        # km an Tag = max odo_end - max odo_start des Tages (oder Diff zu VorTag)
        o_start = day_odo_start.get(d, 0)
        o_end = day_odo_end.get(d, 0)
        km_day = 0.0
        if prev_odo is not None and o_end >= prev_odo:
            km_day = round(o_end - prev_odo, 1)
        elif o_end > o_start:
            km_day = round(o_end - o_start, 1)
        prev_odo = o_end if o_end > 0 else prev_odo
        cum_km += km_day

        kwh = day_kwh.get(d, 0)
        cost = day_cost.get(d, 0)
        # Verbrauch kWh/100km (nur wenn km>0 UND plausibel, sonst None)
        # km muss zum geladenen kWh passen: bei ~15 kWh/100km sind 29,8 kWh ~200 km.
        # Wenn km_day deutlich zu niedrig fuer die geladene kWh -> odometer-Luecke,
        # dann Verbrauch/€-Werte nicht berechnen (keine Fantasiezahlen).
        km_plausible = km_day >= (kwh * 100 / 60.0)  # max 60 kWh/100km erlaubt
        raw_cons = kwh / (km_day / 100.0) if (km_day > 0 and km_plausible) else None
        consumption = round(raw_cons, 2) if (raw_cons is not None and 0 < raw_cons <= 60) else None
        # €/kWh (gewichtet)
        ppk_vals = day_price.get(d, [])
        price_per_kwh = round(sum(p * w for p, w in ppk_vals) / sum(w for _, w in ppk_vals), 4) if ppk_vals else None
        # €/100km (nur bei plausibler km)
        raw_c100 = cost / (km_day / 100.0) if (km_day > 0 and km_plausible) else None
        cost_per_100 = round(raw_c100, 2) if (raw_c100 is not None and 0 <= raw_c100 <= 30) else None
        # CO2 g/kWh (gewichtet)
        co2_vals = day_co2.get(d, [])
        co2 = round(sum(c * w for c, w in co2_vals) / sum(w for _, w in co2_vals), 1) if co2_vals else None
        # Ladeverlust (EVCC-kWh - TM added), nur wenn beide da
        added = day_added.get(d, 0)
        loss = round(kwh - added, 2) if (kwh > 0 and added > 0) else None

        series.append({
            "day": d, "km": km_day, "cum_km": round(cum_km, 1),
            "kwh": round(kwh, 2), "cost": round(cost, 2),
            "consumption": consumption, "price_per_kwh": price_per_kwh,
            "cost_per_100": cost_per_100, "co2": co2, "loss": loss,
            "ac_kwh": round(day_ac_kwh.get(d, 0), 2),
            "dc_kwh": round(day_dc_kwh.get(d, 0), 2),
            "ac_cost": round(day_ac_cost.get(d, 0), 2),
            "dc_cost": round(day_dc_cost.get(d, 0), 2),
            "range": round(day_range_end.get(d, 0), 0),
        })
    series.sort(key=lambda x: x["day"])

    # --- Echte gefahrene km pro Tag aus TeslaMate-Drives (Wahrheit) ---
    # korrigiert die Odometer-Diff-Schätzung (Tacho-Sprünge). (Punkt 4)
    try:
        from collections import defaultdict as _dd
        drive_km_by_day = _dd(float)
        for dr in _drive_rows(days_param, from_date, to_date):
            dk = (dr.get("start_date") or "")[:10]
            if not dk:
                continue
            try:
                drive_km_by_day[dk] += float(dr.get("distance_km") or 0)
            except Exception:
                pass
        for s in series:
            if s["day"] in drive_km_by_day:
                s["km"] = round(drive_km_by_day[s["day"]], 1)
    except Exception:
        pass

    # --- Gesamt-KPIs ---
    total_kwh = round(sum(s["kwh"] for s in series), 2)
    total_cost = round(sum(s["cost"] for s in series), 2)
    total_km = round(sum(s["km"] for s in series), 1) or 0.0  # gefahrene km (Summe Tages-km), nicht Tacho-Stand
    total_ac = round(sum(s["ac_kwh"] for s in series), 2)
    total_dc = round(sum(s["dc_kwh"] for s in series), 2)
    total_dc_cost = round(sum(s["dc_cost"] for s in series), 2)
    total_ac_cost = round(sum(s["ac_cost"] for s in series), 2)
    avg_consumption = round(total_kwh / (total_km / 100.0), 2) if total_km > 0 else 0
    avg_cost_100 = round(total_cost / (total_km / 100.0), 2) if total_km > 0 else 0
    # gewichteter €/kWh ueber alle Tage
    all_ppk = [(s["price_per_kwh"], s["kwh"]) for s in series if s["price_per_kwh"]]
    avg_price_kwh = round(sum(p * w for p, w in all_ppk) / sum(w for _, w in all_ppk), 4) if all_ppk else 0
    all_co2 = [(s["co2"], s["kwh"]) for s in series if s["co2"]]
    avg_co2 = round(sum(c * w for c, w in all_co2) / sum(w for _, w in all_co2), 1) if all_co2 else 0
    last_range = series[-1]["range"] if series else 0

    # --- SOC-basierter Intervall-Verbrauch (besser als Fill-to-Full) ---
    # Jede EVCC-Ladung kennt SOC_start/end + kWh. Aus kWh/(SOC_end-SOC_start)
    # ergibt sich die (brutto-)Kapazitaet je Ladung (~67 kWh bei Model Y).
    # Verbrauch zwischen Ladung N und N+1 = (SOC_start(N+1) - SOC_end(N))/100 * Kapazitaet.
    # Das nutzt ALLE Ladungen (nicht nur Full-Charges) -> dichte Zeitreihe.
    soc_rows = []
    for e in evcc:
        raw = e.get("raw")
        try:
            j = json.loads(raw) if isinstance(raw, str) else raw
            ss = float(j.get("socStart") or 0); se = float(j.get("socEnd") or 0)
            kwh = float(e.get("charged_kwh") or 0)
            cap = kwh / (se - ss) * 100 if (se - ss) > 0 else None
        except Exception:
            ss = se = kwh = cap = None
        soc_rows.append({
            "day": (e.get("created") or "")[:10], "created": e.get("created"),
            "soc_start": ss, "soc_end": se, "kwh": kwh, "cap": cap,
            "odometer": float(e.get("odometer") or 0),
        })
    soc_rows.sort(key=lambda x: x["created"] or "")
    valid_caps = [r["cap"] for r in soc_rows if r["cap"] and 30 <= r["cap"] <= 120]
    est_cap = sum(valid_caps) / len(valid_caps) if valid_caps else 75.0  # Fallback Model Y
    soc_intervals = []
    for a, b in zip(soc_rows, soc_rows[1:]):
        if None in (a["soc_end"], b["soc_start"]):
            continue
        dsoc = b["soc_start"] - a["soc_end"]          # verbrauchte SOC seit letzter Ladung (negativ)
        used_energy = -dsoc / 100.0 * est_cap         # kWh verbraucht (positiv)
        # P1 (ev-monitor Z.143): SoC-Delta-Korrektur.
        #   energyConsumed = (SOC_A_end - SOC_B_end) * cap/100  [Korrektur Start/Ende-Intervall]
        #                  + used_energy (Strecke A->B via SOC-Diff)
        # b_charged (Energie in B geladen) ist NICHT addieren -- das ueberschaetzt,
        # da used_energy bereits die gefahrene Strecke abdeckt.
        soc_after_a = a["soc_end"]; soc_after_b = b["soc_end"]
        soc_corr = (soc_after_a - soc_after_b) / 100.0 * est_cap
        energy_consumed = used_energy + soc_corr
        km = b["odometer"] - a["odometer"]
        # Plausibilitaets-Check (ev-monitor Layer 1: absolut + Mindeststrecke).
        # km muss zum geladenen/verbrauchten kWh passen: max 40 kWh/100km erlaubt.
        # Mindeststrecke 20 km (ev-monitor minTripDistanceKm): kurze Intervalle
        # mit ungenauer odometer-Diff verfaelschen den Verbrauch.
        km_ok = km >= 20 and energy_consumed >= 0 and energy_consumed <= km / 100.0 * 40.0
        cons = round(energy_consumed / (km / 100.0), 2) if km_ok else None
        soc_intervals.append({
            "day": b["day"], "date": b["created"], "dsoc": round(dsoc, 1),
            "used_kwh": round(used_energy, 2), "km": round(km, 1),
            "consumption": cons,  # kWh/100km ueber Intervall (SoC-korrigiert)
        })

    # --- Gesamt-Ladeverlust (P2): immer anzeigen, keine TM-Abhaengigkeit ---
    # ev-monitor: Verlust = (1 - efficiency) * geladene_kWh.
    # AC 10% Verlust, DC 5% Verlust. Das ist eine saubere, immer verfuegbare
    # Schaetzung (im Gegensatz zu TM-added Diff, die bei Datenluecken '-' war).
    total_loss_ac = total_ac * (1 - AC_EFFICIENCY)
    total_loss_dc = total_dc * (1 - DC_EFFICIENCY)
    total_charging_loss = round(total_loss_ac + total_loss_dc, 2)

    # --- Statistische Plausibilitaet (P3, ev-monitor Layer 2a) ---
    # Mittelwert +/- 2σ ueber die berechneten Intervall-Verbrauchswerte.
    cons_vals = [s["consumption"] for s in soc_intervals if s["consumption"] is not None]
    mean_c = std_c = lo = hi = 0
    if cons_vals:
        mean_c = sum(cons_vals) / len(cons_vals)
        variance = sum((x - mean_c) ** 2 for x in cons_vals) / len(cons_vals)
        std_c = variance ** 0.5
        margin = std_c * SIGMA_MULTIPLIER
        lo, hi = mean_c - margin, mean_c + margin
        for s in soc_intervals:
            if s["consumption"] is not None and not (lo <= s["consumption"] <= hi):
                s["consumption"] = None  # Ausreisser ausblenden (statistisch)
                s["outlier"] = True
    else:
        lo = hi = mean_c = 0

    return jsonify({
        "series": series,
        "soc_intervals": soc_intervals,
        "est_capacity": round(est_cap, 1),
        "plausibility": {"mean": round(mean_c, 2), "std": round(std_c, 2) if cons_vals else 0,
                         "lower": round(lo, 2), "upper": round(hi, 2)},
        "kpis": {
            "total_kwh": total_kwh, "total_cost": total_cost, "total_km": total_km,
            "avg_consumption": avg_consumption, "avg_cost_100": avg_cost_100,
            "avg_price_kwh": avg_price_kwh, "avg_co2": avg_co2,
            "ac_kwh": total_ac, "dc_kwh": total_dc,
            "charged_total_kwh": round(total_ac + total_dc, 2),
            "dc_share_pct": round(total_dc / (total_ac + total_dc) * 100, 1) if (total_ac + total_dc) > 0 else 0,
            "last_range": last_range,
            "charging_loss_kwh": total_charging_loss,
            "charging_loss_pct": round(total_charging_loss / (total_ac + total_dc) * 100, 1) if (total_ac + total_dc) > 0 else 0,
            # P5: AC/DC-Split (Kosten + Verbrauch)
            "ac_share_pct": round(total_ac / (total_ac + total_dc) * 100, 1) if (total_ac + total_dc) > 0 else 0,
            # P5: echte DC/AC-Kosten pro 100km (nicht % von Gesamt-€/100km).
            # DC-Kosten = Summe der echten externen DC-Ladekosten / gefahrene km.
            "dc_cost_per_100km": round(total_dc_cost / (total_km / 100.0), 2) if total_km > 0 else 0,
            "ac_cost_per_100km": round(total_ac_cost / (total_km / 100.0), 2) if total_km > 0 else 0,
        },
    })


@app.route("/api/statistics")
def api_statistics():
    """Daten fuer das Statistik-Tab (Etappe B): Monatsvergleiche,
    Standorttyp-Verteilung, Oeffentlichkeits-Kennzahlen je Ladevorgang,
    AC/DC-Anteil, Home-vs-Extern-Kosten, Ladezeiten-Heatmap.
    Respektiert den Zeitraum (days/from/to)."""
    from collections import defaultdict
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None
    db = get_db()
    home_q = "SELECT created, finished, charged_kwh, total_cost FROM home_sessions WHERE created >= ?"
    ext_q = ("SELECT started_at, finished_at, energy_kwh, energy_used_kwh, cost_total, "
             "address, location_name FROM external_sessions WHERE started_at >= ?")
    params = [cutoff]
    if end:
        home_q += " AND created <= ?"
        ext_q += " AND started_at <= ?"
        params = [cutoff, end]
    home = [dict(r) for r in db.execute(home_q + " ORDER BY created ASC", params).fetchall()]
    ext = [dict(r) for r in db.execute(ext_q + " ORDER BY started_at ASC", params).fetchall()]

    # EVCC-Zeitfenster (fuer TM-Zuhause-Erkennung via Ueberlappung, s.u.)
    def _pd(v):
        s = str(v or "").replace("Z", "").replace("+00:00", "")
        try:
            return datetime.fromisoformat(s[:19])
        except Exception:
            return None
    evcc_windows = []
    for r in home:
        sdt = _pd(r.get("created"))
        edt = _pd(r.get("finished")) or sdt
        if sdt is not None:
            evcc_windows.append((sdt, edt))

    # Road-Trip-Import-Ladungen (provider='Road Trip') sind KEIN echtes
    # Fremdladen. Ausserdem duerfen TeslaMate-Zuhause-Ladungen (doppeltes
    # Tracking mit EVCC) NICHT als Extern gewertet werden. Beides wird fuer
    # die Extern-Statistik ausgeklammert, damit "Extern O kWh" nur echte
    # Fremdladungen (Supercharger/Arbeit/oeffentliche Saule) zaehlt.
    # Erkennung von TM-Zuhause wie in build_stats: Adress-/Geofence-Match
    # ODER zeitliche Ueberlappung mit einem EVCC-Wallbox-Ladevorgang.
    def _tm_is_home(r):
        cdt = _pd(r.get("started_at"))
        if cdt is not None:
            for sdt, edt in evcc_windows:
                if sdt <= cdt <= edt:
                    return True
        return _is_home_address(r.get("location_name"), r.get("address"))
    def _is_real_external(r):
        if (r.get("provider") or "") == "Road Trip":
            return False
        if _tm_is_home(r):
            return False
        return True
    ext_real = [r for r in ext if _is_real_external(r)]
    ext_import = [r for r in ext if (r.get("provider") or "") == "Road Trip"]

    # --- Monatsvergleich (Kosten + Energie) aus build_stats.monthly ---
    stats = build_stats(days, from_date, to_date)
    monthly = stats.get("monthly", [])

    # --- Standorttyp-Verteilung (nur echte Externe, TM; Road-Trip-Import separat) ---
    # Zuhause = EVCC (Wallbox). Externe nach Adress-Typ gruppieren.
    loc_map = defaultdict(lambda: {"kwh": 0.0, "cost": 0.0, "sessions": 0, "added": 0.0})
    for r in ext_real:
        addr = (r.get("location_name") or r.get("address") or "").lower()
        if _is_home_address(r.get("location_name"), r.get("address")):
            typ = "Zuhause"
        elif "supercharger" in addr:
            typ = "Supercharger"
        elif any(w in addr for w in ("arbeit", "office", "firma", "work")):
            typ = "Arbeit"
        else:
            typ = "Sonstige"
        loc_map[typ]["kwh"] += float(r.get("energy_kwh") or 0)
        loc_map[typ]["cost"] += float(r.get("cost_total") or 0)
        loc_map[typ]["added"] += float(r.get("energy_kwh") or 0)
        loc_map[typ]["sessions"] += 1
    if ext_import:
        imp_kwh = sum(float(r.get("energy_kwh") or 0) for r in ext_import)
        imp_cost = sum(float(r.get("cost_total") or 0) for r in ext_import)
        loc_map["Road Trip (Import)"] = {"kwh": imp_kwh, "cost": imp_cost,
                                          "sessions": len(ext_import), "added": imp_kwh}
    by_location = [{"type": k, **v} for k, v in sorted(loc_map.items(), key=lambda kv: -kv[1]["kwh"])]

    # --- Durchschnitt je Ladevorgang (kWh, Kosten, Dauer) ---
    def _dur_h(a, b):
        try:
            da = datetime.fromisoformat(str(a).replace("Z", "")[:19])
            db_ = datetime.fromisoformat(str(b).replace("Z", "")[:19])
            return max(0.0, (db_ - da).total_seconds() / 3600.0)
        except Exception:
            return None
    home_durs = [_dur_h(r.get("created"), r.get("finished")) for r in home]
    home_durs = [d for d in home_durs if d is not None]
    ext_durs = [_dur_h(r.get("started_at"), r.get("finished_at")) for r in ext_real]
    ext_durs = [d for d in ext_durs if d is not None]
    all_durs = home_durs + ext_durs
    n_home = len(home)
    n_ext = len(ext_real)
    n_all = n_home + n_ext
    avg_per_charge = {
        "n_charges": n_all,
        "avg_kwh": round(sum(float(r.get("charged_kwh") or 0) for r in home) / n_home, 2) if n_home else 0,
        "avg_cost": round(sum(float(r.get("total_cost") or 0) for r in home) / n_home, 2) if n_home else 0,
        "avg_duration_h": round(sum(all_durs) / len(all_durs), 2) if all_durs else 0,
        "ext_avg_kwh": round(sum(float(r.get("energy_kwh") or 0) for r in ext_real) / n_ext, 2) if n_ext else 0,
        "ext_avg_cost": round(sum(float(r.get("cost_total") or 0) for r in ext_real) / n_ext, 2) if n_ext else 0,
    }

    # --- AC/DC-Anteil (aus api_charts-KPIs) ---
    charts = api_charts().get_json().get("kpis", {})
    ac_dc = {
        "ac_kwh": charts.get("ac_kwh", 0),
        "dc_kwh": charts.get("dc_kwh", 0),
        "ac_share_pct": charts.get("ac_share_pct", 0),
        "dc_share_pct": charts.get("dc_share_pct", 0),
    }

    # --- Home vs. Extern Kostenverteilung ---
    t = stats.get("totals", {})
    home_vs_extern = {
        "home_cost": t.get("cost_home", 0),
        "ext_cost": t.get("cost_external", 0),
        "home_kwh": t.get("home_kwh", 0),
        "ext_kwh": t.get("ext_kwh", 0),
    }

    # --- Ladezeiten-Heatmap: Wochentag (0=Mo) x Stunde (0-23) ---
    heat = [[0] * 24 for _ in range(7)]
    heat_kwh = [[0.0] * 24 for _ in range(7)]
    for r in home:
        try:
            dt = datetime.fromisoformat(str(r.get("created")).replace("Z", "")[:19])
            heat[dt.weekday()][dt.hour] += 1
            heat_kwh[dt.weekday()][dt.hour] += float(r.get("charged_kwh") or 0)
        except Exception:
            pass
    for r in ext:
        try:
            dt = datetime.fromisoformat(str(r.get("started_at")).replace("Z", "")[:19])
            heat[dt.weekday()][dt.hour] += 1
            heat_kwh[dt.weekday()][dt.hour] += float(r.get("energy_kwh") or 0)
        except Exception:
            pass

    return jsonify({
        "monthly": monthly,
        "by_location": by_location,
        "avg_per_charge": avg_per_charge,
        "ac_dc": ac_dc,
        "home_vs_extern": home_vs_extern,
        "heatmap": heat,
        "heatmap_kwh": heat_kwh,
    })


@app.route("/api/roadtrip")
def api_roadtrip():
    """Roadtrip-/Reise-Ansicht (iOS Roadtrip-App-Stil): Tageswerte km/kWh/€/Station + Kennzahlen + Ladestopps (lat/lng)."""
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None
    db = get_db()
    evcc_q = "SELECT created, finished, charged_kwh, total_cost, odometer, solar_percentage, loadpoint FROM home_sessions WHERE created >= ?"
    tm_q = "SELECT started_at, finished_at, energy_kwh, energy_used_kwh, cost_total, odometer_start, latitude, longitude, address, location_name FROM external_sessions WHERE started_at >= ?"
    params = [cutoff]
    if end:
        evcc_q += " AND created <= ?"
        tm_q += " AND started_at <= ?"
        params = [cutoff, end]
    evcc = [dict(r) for r in db.execute(evcc_q + " ORDER BY created ASC", params).fetchall()]
    tm = [dict(r) for r in db.execute(tm_q + " ORDER BY started_at ASC", params).fetchall()]

    from collections import defaultdict
    day_kwh = defaultdict(float)
    day_cost = defaultdict(float)
    day_stations = defaultdict(set)
    day_pins = defaultdict(list)
    day_consumed = defaultdict(float)  # vom Akku gezogene Energie (TeslaMate energy_used_kwh)

    # EVCC (Zuhause) Tage einsammeln
    for e in evcc:
        day = (e.get("created") or "")[:10]
        day_kwh[day] += float(e.get("charged_kwh") or 0)
        day_cost[day] += float(e.get("total_cost") or 0)
        day_stations[day].add("Wallbox")

    # TeslaMate Ladestopps (extern + ggf. Zuhause) sammeln
    for t in tm:
        day = (t.get("started_at") or "")[:10]
        lat = t.get("latitude")
        lng = t.get("longitude")
        # Datenschutz: keine exakten GPS-Koordinaten in der API ausgeben.
        # lat/lng nur dann mitliefern, wenn exakte Locations erlaubt sind.
        if not _store_exact_location():
            lat = lng = None
        addr = _location_label(t.get("location_name"), t.get("address")) or "Ladestopp"
        day_stations[day].add(addr)
        # Verbrauch = vom Akku gezogene Energie (energy_used_kwh), falls vorhanden
        try:
            day_consumed[day] += float(t.get("energy_used_kwh") or 0)
        except Exception:
            pass
        if lat is not None and lng is not None:
            day_pins[day].append({
                "lat": lat, "lng": lng, "address": addr,
                "kwh": round(float(t.get("energy_kwh") or 0), 2),
                "cost": round(float(t.get("cost_total") or 0), 2),
            })

    # km ueber odometer: Gesamt-km = letzter (neuester) Tachostand.
    # EVCC liefert 'odometer' = Tachostand in km (1:1 zum Auto-Tacho).
    # TeslaMate liefert pro Ladung 'odometer' (= Tachostand beim Laden) -> wir
    # speichern es in 'odometer_start' UND 'odometer_end' (TM gibt nur einen
    # Wert pro Charge). Fuer die Tages-Diff nutzen wir den hoeheren der beiden
    # Werte (odometer_end, fallback odometer_start), damit ein Tag den besten
    # verfuegbaren Endstand bekommt.
    odo_dated = []
    for e in evcc:
        try:
            odo_dated.append(((e.get("created") or "")[:19], float(e.get("odometer") or 0)))
        except Exception:
            pass
    for t in tm:
        try:
            o = float(t.get("odometer_end") or t.get("odometer_start") or 0)
            odo_dated.append(((t.get("started_at") or "")[:19], o))
        except Exception:
            pass
    odo_dated = [x for x in odo_dated if x[1] > 0]
    total_km_calc = odo_dated[-1][1] if odo_dated else 0.0  # letzter (sortiert nach Zeit)
    odo_dated.sort(key=lambda x: x[0])
    # Tages-Diff nur fuer die Tagesbalken (km pro Tag), nicht fuer Gesamt-km
    odo_points_dated = odo_dated
    day_odo = defaultdict(float)
    for day, o in odo_points_dated:
        day_odo[day[:10]] = max(day_odo[day[:10]], o)
    days_sorted = sorted(day_odo.keys())
    day_km = {}
    prev = 0.0
    for d in days_sorted:
        o = day_odo[d]
        day_km[d] = round(o - prev, 1) if prev > 0 else 0.0
        prev = o

    # --- Echte gefahrene km pro Tag aus TeslaMate-Drives (Wahrheit) ---
    # Die Odometer-Differenz zwischen Ladevorgängen ist fehleranfällig
    # (Tacho-Sprünge, Resets, nicht erfasste Fahrten) und zeigt dann
    # viel zu hohe km (z.B. 340 km an einem Tag, an dem nur ~216 km
    # gefahren wurden). Wenn echte Drives vorhanden sind, überschreiben
    # wir die Odometer-Schätzung damit. (Punkt 4)
    try:
        drive_rows = _drive_rows(days, from_date, to_date)
        drive_km_by_day = defaultdict(float)
        for dr in drive_rows:
            dk = (dr.get("start_date") or "")[:10]
            if not dk:
                continue
            try:
                drive_km_by_day[dk] += float(dr.get("distance_km") or 0)
            except Exception:
                pass
        for d, km in drive_km_by_day.items():
            day_km[d] = round(km, 1)
    except Exception:
        pass  # Fallback: Odometer-Diff bleibt stehen

    # --- Pins deduplizieren: pro Adresse nur EIN Pin (Summe der kWh) ---
    # Zuerst alle Adressen sammeln, die als "Zuhause" (Wallbox/EVCC) geladen wurden
    home_addr_counter = defaultdict(int)
    for e in evcc:
        home_addr_counter["Wallbox"] += 1
    for day, pins in day_pins.items():
        for p in pins:
            if p.get("address") and p["address"] != "?":
                home_addr_counter[p["address"]] += 1

    # Adresse mit den meisten Treffern = Zuhause (anonymisiert)
    home_addr = ""
    if home_addr_counter:
        home_addr = max(home_addr_counter.items(), key=lambda kv: kv[1])[0]

    def anon(addr):
        if not addr or addr == "?":
            return "Unbekannt"
        if addr == home_addr or addr == "Wallbox":
            return "Zuhause"
        return "Ladestopp"

    # Deduplizierte Pins pro Tag (Adresse -> aggregiert)
    day_pins_dedup = defaultdict(lambda: defaultdict(float))
    day_pins_meta = {}
    for day, pins in day_pins.items():
        for p in pins:
            a = anon(p.get("address"))
            day_pins_dedup[day][a] += float(p.get("kwh") or 0)
            day_pins_meta[(day, a)] = {"lat": p.get("lat"), "lng": p.get("lng")}

    per_day = []
    for day in days_sorted:
        pins_agg = []
        for a, kwh in day_pins_dedup.get(day, {}).items():
            meta = day_pins_meta.get((day, a), {})
            pins_agg.append({
                "address": a,
                "kwh": round(kwh, 2),
                "lat": meta.get("lat"),
                "lng": meta.get("lng"),
            })
        per_day.append({
            "day": day,
            "km": day_km.get(day, 0),
            "kwh": round(day_kwh.get(day, 0), 2),
            "consumed_kwh": round(day_consumed.get(day, 0), 2),
            "cost": round(day_cost.get(day, 0), 2),
            "stations": sorted(day_stations.get(day, [])),
            "pins": pins_agg,
        })
    per_day.sort(key=lambda x: x["day"], reverse=True)

    total_km = round(total_km_calc, 1)
    total_kwh = round(sum(day_kwh.values()), 2)
    total_cost = round(sum(day_cost.values()), 2)
    avg_consumption = round(total_kwh / (total_km / 100.0), 2) if total_km > 0 else 0
    avg_cost_100 = round(total_cost / (total_km / 100.0), 2) if total_km > 0 else 0

    # Stops: dedupliziert (eine Position pro Adresse)
    stop_seen = {}
    stops = []
    for day, pins in day_pins.items():
        for p in pins:
            key = (round(float(p.get("lat") or 0), 4), round(float(p.get("lng") or 0), 4))
            if key not in stop_seen:
                stop_seen[key] = True
                stops.append({
                    "address": anon(p.get("address")),
                    "lat": p.get("lat"), "lng": p.get("lng"),
                    "kwh": round(float(p.get("kwh") or 0), 2),
                    "cost": round(float(p.get("cost") or 0), 2),
                    "day": day,
                })

    return jsonify({
        "per_day": per_day,
        "stops": stops,
        "totals": {
            "km": total_km, "kwh": total_kwh, "cost": total_cost,
            "avg_consumption_kwh_100km": avg_consumption,
            "avg_cost_per_100km": avg_cost_100,
            "n_days": len(days_sorted),
        },
    })


@app.route("/api/export/roadtrip-csv")
def api_export_roadtrip_csv():
    """Export aller Ladevorgänge als Road Trip MPG (Darren Stone) CSV.

    Die iOS-App 'Road Trip MPG' importiert CSV direkt (Spalten siehe
    https://apps.apple.com/app/road-trip-mpg/id299392794). Sie ist eine
    Verbrenner-App (Fill-up = Tankfuellung in Litern/Gallons), kennt aber
    KEIN kWh-Feld.

    Mapping fuer EV-Ladedaten (jede Ladung = ein 'Fill-up'):
      Date          -> Ladestart (YYYY-MM-DD)
      Odometer      -> Tachostand km beim Laden
      Fill Amount   -> geladene Energie in kWh (= 'Fuel amount')
      Price per Unit-> €/kWh (= 'Price per unit')
      Total Price   -> Gesamtkosten € (Bonus-Spalte, von der App erkannt)
      Note          -> Ort/Anbieter (Bonus-Spalte)

    Die Spaltenueberschriften sind bewusst die App-Standardnamen, damit der
    Import ohne manuelles Column-Mapping klappt.
    """
    import csv as _csv
    from io import StringIO as _StringIO

    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None

    db = get_db()
    evcc_q = ("SELECT created, odometer, charged_kwh, total_cost, price_per_kwh, "
              "loadpoint, note, soc_start, soc_end FROM home_sessions WHERE created >= ?")
    tm_q = ("SELECT started_at, odometer_end, odometer_start, energy_kwh, "
            "cost_total, price_per_kwh, provider, address, location_name, note, "
            "soc_start, soc_end FROM external_sessions WHERE started_at >= ?")
    params = [cutoff]
    if end:
        evcc_q += " AND created <= ?"
        tm_q += " AND started_at <= ?"
        params = [cutoff, end]

    home = [dict(r) for r in db.execute(evcc_q + " ORDER BY created ASC", params).fetchall()]
    ext = [dict(r) for r in db.execute(tm_q + " ORDER BY started_at ASC", params).fetchall()]

    # Parameter: Schwellwert (Anteil der Maximal-Ladung), ab dem eine Ladung
    # als 'voll' (Full Tank) gilt. Kleinere = Partial (Top-up).
    # 1.0 = alle als voll markieren (altes Verhalten).
    full_threshold = request.args.get("full_threshold", 0.5, type=float)
    full_threshold = max(0.0, min(1.0, full_threshold))

    rows = []  # (date, odometer, fill_kwh, unit_price, total, location, notes, _is_home)

    for e in home:
        d = (e.get("created") or "")[:10]
        odo = float(e.get("odometer") or 0)
        kwh = float(e.get("charged_kwh") or 0)
        total = float(e.get("total_cost") or 0)
        unit = float(e.get("price_per_kwh") or 0)
        loc = e.get("loadpoint") or ""
        note = e.get("note") or "Wallbox (Zuhause)"
        ss = _to_float(e.get("soc_start"))
        se = _to_float(e.get("soc_end"))
        rows.append((d, odo, kwh, unit, total, str(loc), str(note), True, ss, se))

    for t in ext:
        d = (t.get("started_at") or "")[:10]
        odo = float(t.get("odometer_end") or t.get("odometer_start") or 0)
        kwh = float(t.get("energy_kwh") or 0)
        total = float(t.get("cost_total") or 0)
        unit = float(t.get("price_per_kwh") or 0)
        loc = _location_label(t.get("location_name"), t.get("address")) or ""
        provider = t.get("provider") or ""
        # Provider nur ergaenzen, wenn er nicht schon im Ortsnamen steckt
        note = loc
        if provider and provider.lower() not in (loc or "").lower():
            note = " ".join(p for p in (loc, provider) if p).strip()
        note = note or "Ladestopp"
        ss = _to_float(t.get("soc_start"))
        se = _to_float(t.get("soc_end"))
        rows.append((d, odo, kwh, unit, total, str(loc), str(note), False, ss, se))

    # Nach Datum sortieren (aufsteigend = chronologisch)
    rows.sort(key=lambda r: r[0])

    # Voll-Tank-Erkennung (jetzt ueber gespeicherten SoC, nicht mehr nur kWh-Heuristik):
    # Eine Ladung gilt als 'voll' (Full Tank = 1), wenn:
    #   - der End-SoC hoch ist (>= soc_full_end, Default 95%)  ODER
    #   - die geladene Spanne gross ist (Ende - Start >= soc_full_span, Default 60%)
    # Ladungen ohne SoC-Daten (z.B. aeltere EVCC-Version) fallen auf die
    # kWh-Heuristik zurueck (full_threshold * groesste Ladung im Export).
    # full_threshold >= 1.0 erzwingt ausdruecklich ALLE als voll.
    soc_full_end = request.args.get("soc_full_end", 95.0, type=float)
    soc_full_span = request.args.get("soc_full_span", 60.0, type=float)
    max_kwh = max((r[2] for r in rows), default=0.0)
    threshold_kwh = max_kwh * full_threshold
    all_full = full_threshold >= 1.0

    def _is_full(kwh, ss, se):
        if all_full:
            return True
        # Echte SoC-Entscheidung
        if ss is not None and se is not None and (se - ss) >= 0:
            if se >= soc_full_end or (se - ss) >= soc_full_span:
                return True
        # Fallback: keine/ungueltige SoC -> kWh-Heuristik
        return kwh >= threshold_kwh

    # Road Trip MPG CSV-Spalten (siehe darrensoft.ca/roadtrip/manual/csv-import/columns/).
    # 'Fill Unit' = kWh erzwingt Strom-Einheit unabhaengig vom Fahrzeugprofil-Default.
    header = ["Date", "Odometer", "Fill Amount", "Fill Unit",
              "Price per Unit", "Total Price", "Full Tank", "Location", "Notes"]
    buf = _StringIO()
    w = _csv.writer(buf)
    w.writerow(header)
    for d, odo, kwh, unit, total, loc, note, _is_home, ss, se in rows:
        # Leere/ungueltige Zeilen nicht exportieren
        if not d or (kwh <= 0 and total <= 0):
            continue
        full = 1 if _is_full(kwh, ss, se) else 0
        w.writerow([
            d,
            f"{odo:.1f}" if odo else "",
            f"{kwh:.3f}" if kwh else "",
            "kW.h",
            f"{unit:.4f}" if unit else "",
            f"{total:.2f}" if total else "",
            str(full),
            loc,
            note,
        ])
    csv_text = buf.getvalue()
    return _csv_response(csv_text, "cartanklogger_roadtrip.csv")


def _csv_response(text, filename):
    """Baut eine saubere text/csv-Response mit Download-Header."""
    from flask import Response
    return Response(
        text,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ---------------------------------------------------------------------------
# Road Trip Rück-Import (iOS "Road Trip MPG" -> CarTankLogger)
# ---------------------------------------------------------------------------
def _parse_roadtrip_csv(text):
    """Parst den Road Trip CSV-Export (';'-Trenner, dt. Dezimalkomma, kW.h).

    Liefert Liste von Dicts mit den FuelRecord-Feldern, die wir brauchen:
    odometer, date, kwh, unit_price, total, full(0/1), location.
    Nur die 'Kraftstoff'-Sektion wird ausgewertet; Reifen/Touren/Wartung
    bleiben beim Rueck-Import unangetastet (CarTankLogger hat keine solchen
    Tabellen, also werden sie schlicht ignoriert).
    """
    def _de(s):
        if s is None:
            return None
        s = s.strip().strip('"')
        if s == "":
            return None
        s = s.replace(",", ".")  # dt. Dezimalkomma
        try:
            return float(s)
        except ValueError:
            return s

    lines = text.replace("\ufeff", "").splitlines()
    # Sektion 'Kraftstoff' finden
    start = None
    for i, l in enumerate(lines):
        if l.strip() == "Kraftstoff":
            start = i + 1
            break
    if start is None:
        return []
    # Header der Kraftstoff-Sektion (erste nicht-leere Zeile nach 'Kraftstoff')
    hdr = None
    j = start
    while j < len(lines) and not lines[j].strip():
        j += 1
    if j >= len(lines):
        return []
    hdr = [c.strip() for c in lines[j].split(";")]
    j += 1
    out = []
    idx = {name: hdr.index(name) for name in (
        "Tachostand (km)", "Datum", "Getankt Betrag", "Getankt Einheiten",
        "Preis pro Einheit", "Total Preis", "Vollgetankt", "Ort") if name in hdr}

    def _unquote(s):
        if s is None:
            return ""
        s = s.strip()
        if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
            s = s[1:-1]
        return s.strip()

    while j < len(lines):
        l = lines[j].strip()
        j += 1
        if not l:
            continue
        # Sektion endet, wenn eine andere Ueberschrift kommt
        if l in ("Wartung", "Touren", "Automobil", "Reifen", "VALUATIONS"):
            break
        parts = l.split(";")
        if len(parts) <= max(idx.values(), default=0):
            continue
        odo = _de(parts[idx["Tachostand (km)"]])
        date = _unquote(parts[idx["Datum"]]) if "Datum" in idx and idx["Datum"] < len(parts) else ""
        kwh = _de(parts[idx["Getankt Betrag"]]) if "Getankt Betrag" in idx else None
        unit = _de(parts[idx["Preis pro Einheit"]]) if "Preis pro Einheit" in idx else None
        total = _de(parts[idx["Total Preis"]]) if "Total Preis" in idx else None
        fullraw = parts[idx["Vollgetankt"]] if "Vollgetankt" in idx else ""
        full = 1 if (fullraw or "").strip().lower() in ("full", "voll", "vollgetankt", "1") else 0
        loc = _unquote(parts[idx["Ort"]]) if "Ort" in idx else ""        # Nur echte Zahlenwerte uebernehmen
        if not date or (kwh is None and total is None):
            continue
        out.append({
            "odometer": odo if isinstance(odo, (int, float)) else None,
            "date": date,
            "kwh": kwh if isinstance(kwh, (int, float)) else None,
            "unit_price": unit if isinstance(unit, (int, float)) else None,
            "total": total if isinstance(total, (int, float)) else None,
            "full": full,
            "location": loc or "",
        })
    return out


def _parse_roadtrip_rtvd(text):
    """Parst das native Road Trip Backup (.roadtrip, base64 in 'Data:'-Zeilen).

    Liefert dieselbe Dict-Liste wie _parse_roadtrip_csv.
    """
    import base64, urllib.parse
    blobs = []
    for l in text.splitlines():
        if l.startswith("Data:"):
            blobs.append(l.split(":", 1)[1].strip())
    if not blobs:
        return []
    b64 = "".join(blobs)
    b64 += "=" * (-len(b64) % 4)
    try:
        dec = base64.b64decode(b64).decode("utf-8", "replace")
    except Exception:
        return []
    # Wie CSV, nur dass dec bereits die gleiche Sektionsstruktur hat
    return _parse_roadtrip_csv(dec)


def _import_roadtrip_rows(rows):
    """Schreibt geparste Road-Trip-Ladungen in external_sessions (Dedup).

    Vermeidet Doppel: (round(odometer), date[0:10], round(kwh,3)) darf nicht
    schon existieren. Jede Ladung wird als externe Ladung (provider='Road Trip')
    gespeichert, damit sie nicht mit EVCC/TeslaMate-Sync kollidiert.
    """
    db = get_db()
    inserted = 0
    now = datetime.now().isoformat()
    for r in rows:
        odo = r.get("odometer")
        date = r.get("date") or ""
        kwh = r.get("kwh")
        if odo is None or not date or kwh is None:
            continue
        # Datums-Normalisierung: '2026-6-23 11:16' -> '2026-06-23T11:16:00'
        iso = _parse_dt(date)
        if iso is None:
            iso = datetime.now()
        day = str(iso)[:10]
        odo_r = round(float(odo), 1)
        kwh_r = round(float(kwh), 3)
        # Dedup-Check
        existing = db.execute(
            """SELECT id FROM external_sessions
               WHERE odometer_end=? AND substr(started_at,1,10)=? AND energy_kwh=?
               AND provider='Road Trip' LIMIT 1""",
            (odo_r, day, kwh_r)).fetchone()
        if existing:
            continue
        try:
            db.execute(
                """INSERT INTO external_sessions
                   (teslamate_session_id, started_at, finished_at, location_name, address,
                    provider, energy_kwh, energy_used_kwh, odometer_start, odometer_end,
                    soc_start, soc_end, cost_total, price_per_kwh, manual_price, imported_at, raw)
                   VALUES (NULL,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,0,?,?)""",
                (iso.isoformat(), iso.isoformat(),
                 r.get("location") or "Road Trip", r.get("location") or "Road Trip",
                 "Road Trip", kwh_r, kwh_r,
                 odo_r, odo_r,
                 r.get("total") or 0.0, r.get("unit_price") or 0.0,
                 now, json.dumps(r, default=str)))
            inserted += 1
        except sqlite3.IntegrityError:
            pass
    db.commit()
    return inserted


@app.route("/api/import/roadtrip", methods=["POST"])
def api_import_roadtrip():
    """Laedt eine Road Trip MPG Datei (.roadtrip Backup ODER CSV-Export) hoch
    und importiert die Ladungen (Kraftstoff/FuelRecords) in external_sessions.

    Reifen/Touren/Wartung aus der Datei werden NICHT uebernommen (CarTankLogger
    hat keine solchen Tabellen) — sie bleiben in der Road Trip App erhalten.
    Doppelte Ladungen (Tachostand+Datum+kWh) werden uebersprungen.
    """
    if "file" not in request.files:
        return jsonify({"error": "Keine Datei (field 'file')"}), 400
    f = request.files["file"]
    raw = f.read().decode("utf-8", "replace")
    fname = (f.filename or "").lower()
    if fname.endswith(".roadtrip") or raw.lstrip().startswith("RTVD"):
        rows = _parse_roadtrip_rtvd(raw)
    else:
        rows = _parse_roadtrip_csv(raw)
    if not rows:
        return jsonify({"error": "Keine Ladungen (Kraftstoff) in der Datei gefunden", "parsed": 0}), 422
    inserted = _import_roadtrip_rows(rows)
    return jsonify({"ok": True, "parsed": len(rows), "inserted": inserted})


@app.route("/api/soc")
def api_soc():
    """SoC-Auswertung (State of Charge) ueber alle Ladevorgaenge.

    Liefert Verteilungen, mit denen das Frontend Diagramme zeichnet:
      - soc_start_hist:  Histogramm der Start-SoC (in 10%-Faechern)
      - soc_end_hist:    Histogramm der End-SoC
      - charge_span:     Verteilung der geladenen Spanne (Ende-Start) in 10%-Faechern
      - by_hour:         WANN wurde geladen? Anzahl Ladungen pro Tagesstunde (0..23)
      - by_weekday:      Anzahl pro Wochentag (Mon..So)
      - by_provider:     WO wurde geladen? Anzahl + kWh je Anbieter (Top-Urls)
      - summary:         Ø Start/End-SoC, Ø Spanne, Anzahl mit/ohne SoC-Daten
    """
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None

    db = get_db()
    from collections import defaultdict
    q = ("SELECT started_at, created, soc_start, soc_end, energy_kwh, "
         "charged_kwh, provider, location_name, address, energy_used_kwh "
         "FROM ("
         "  SELECT started_at, NULL AS created, soc_start, soc_end, energy_kwh, "
         "         0 AS charged_kwh, provider, location_name, address, energy_used_kwh "
         "  FROM external_sessions WHERE started_at >= ? "
         "  UNION ALL "
         "  SELECT NULL AS started_at, created, soc_start, soc_end, 0 AS energy_kwh, "
         "         charged_kwh, 'Zuhause' AS provider, NULL AS location_name, "
         "         NULL AS address, NULL AS energy_used_kwh "
         "  FROM home_sessions WHERE created >= ?"
         ")")
    params = [cutoff, cutoff]
    if end:
        q = q.replace("started_at >= ?", "started_at >= ? AND started_at <= ?")
        q = q.replace("created >= ?", "created >= ? AND created <= ?")
        params = [cutoff, end, cutoff, end]
    rows = [dict(r) for r in db.execute(q, params).fetchall()]

    def _bucket(v, size=10):
        if v is None:
            return None
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return None
        return int(min(100, max(0, fv)) // size) * size

    def _hour(dt):
        if not dt:
            return None
        s = str(dt)
        # Format YYYY-MM-DD HH:MM oder ISO
        m = None
        import re as _re
        mm = _re.search(r"(\d{1,2}):(\d{2})", s)
        if mm:
            return int(mm.group(1))
        return None

    def _weekday(dt):
        if not dt:
            return None
        s = str(dt)[:19]
        try:
            d = datetime.fromisoformat(s.replace("Z", ""))
            return d.weekday()  # 0=Mon
        except Exception:
            return None

    soc_start_hist = defaultdict(int)
    soc_end_hist = defaultdict(int)
    charge_span = defaultdict(int)
    by_hour = defaultdict(int)
    by_weekday = defaultdict(int)
    by_provider = defaultdict(lambda: {"count": 0, "kwh": 0.0})
    n_with_soc = 0
    n_total = 0
    sum_start = 0.0
    sum_end = 0.0
    sum_span = 0.0
    n_span = 0

    for r in rows:
        n_total += 1
        ss = _to_float(r.get("soc_start"))
        se = _to_float(r.get("soc_end"))
        kwh = _to_float(r.get("energy_kwh")) or _to_float(r.get("charged_kwh")) or 0.0
        # Zeitstempel: extern uses started_at, home uses created
        ts = r.get("started_at") or r.get("created")
        hr = _hour(ts)
        wd = _weekday(ts)
        if hr is not None:
            by_hour[hr] += 1
        if wd is not None:
            by_weekday[wd] += 1
        # Anbieter
        prov = r.get("provider") or "Unbekannt"
        if not prov or prov.strip() == "":
            prov = "Unbekannt"
        by_provider[prov]["count"] += 1
        by_provider[prov]["kwh"] += float(kwh or 0)
        # SoC
        if ss is not None or se is not None:
            n_with_soc += 1
        b_s = _bucket(ss)
        b_e = _bucket(se)
        if b_s is not None:
            soc_start_hist[b_s] += 1
            sum_start += ss or 0
        if b_e is not None:
            soc_end_hist[b_e] += 1
            sum_end += se or 0
        if ss is not None and se is not None and (se - ss) >= 0:
            span = se - ss
            sum_span += span
            n_span += 1
            b_sp = _bucket(span)
            if b_sp is not None:
                charge_span[b_sp] += 1

    # Histogramme als sortierte Listen fuellen (0..100 in 10er-Schritten)
    def _hist_fill(d):
        return [{"bucket": b, "count": d.get(b, 0)} for b in range(0, 101, 10)]

    # by_hour als 24er-Liste
    hours = [by_hour.get(h, 0) for h in range(24)]
    # by_weekday als 7er-Liste (Mon..So)
    weekdays = [by_weekday.get(w, 0) for w in range(7)]
    # by_provider als Liste (nach Anzahl sortiert)
    providers = sorted(
        [{"provider": p, "count": v["count"], "kwh": round(v["kwh"], 2)}
         for p, v in by_provider.items()],
        key=lambda x: x["count"], reverse=True)

    summary = {
        "total": n_total,
        "with_soc": n_with_soc,
        "without_soc": n_total - n_with_soc,
        "avg_soc_start": round(sum_start / n_with_soc, 1) if n_with_soc else None,
        "avg_soc_end": round(sum_end / n_with_soc, 1) if n_with_soc else None,
        "avg_span": round(sum_span / n_span, 1) if n_span else None,
    }

    return jsonify({
        "summary": summary,
        "soc_start_hist": _hist_fill(soc_start_hist),
        "soc_end_hist": _hist_fill(soc_end_hist),
        "charge_span": _hist_fill(charge_span),
        "by_hour": hours,
        "by_weekday": weekdays,
        "by_provider": providers,
    })


def _drive_rows(days=365, from_date=None, to_date=None):
    """Fahrten aus der drives-Tabelle im Zeitraum, chronologisch."""
    db = get_db()
    if from_date and to_date:
        lo, hi = from_date + "T00:00:00", to_date + "T23:59:59"
    else:
        lo = (datetime.now() - timedelta(days=days)).isoformat()
        hi = None
    q = "SELECT * FROM drives WHERE start_date >= ?"
    params = [lo]
    if hi:
        q += " AND start_date <= ?"
        params.append(hi)
    q += " ORDER BY start_date ASC"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@app.route("/api/daily-km")
def api_daily_km():
    """Gefahrene km pro Tag (auch an Tagen ohne Ladung), plus Verbrauch & SoC.

    Aggregiert alle TeslaMate-Fahrten je Kalendertag:
      - km:            Summe distance_km
      - energy_kwh:    Summe energy_consumed_net (Netto-Verbrauch)
      - cons_per_100:  kWh/100km (Verbrauch) -> Vergleich ueber Zeit
      - soc_start/soc_end: erster Start-SoC / letzter End-SoC des Tages
      - drives:        Anzahl Fahrten
    Tage ganz ohne Fahrt tauchen mit km=0 auf (luecklose Reihe).
    """
    days = request.args.get("days", 90, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    rows = _drive_rows(days, from_date, to_date)

    from collections import defaultdict
    agg = defaultdict(lambda: {"km": 0.0, "energy": 0.0, "drives": 0,
                               "soc_start": None, "soc_end": None,
                               "first_ts": None, "last_ts": None})
    for r in rows:
        ts = r.get("start_date") or ""
        day = str(ts)[:10]
        if not day:
            continue
        a = agg[day]
        a["km"] += float(r.get("distance_km") or 0)
        a["energy"] += float(r.get("energy_consumed_kwh") or 0)
        a["drives"] += 1
        # SoC: erster Start / letzter Ende des Tages (nach Zeit)
        if a["first_ts"] is None or ts < a["first_ts"]:
            a["first_ts"] = ts
            a["soc_start"] = r.get("soc_start")
        if a["last_ts"] is None or ts >= a["last_ts"]:
            a["last_ts"] = ts
            a["soc_end"] = r.get("soc_end")

    # Lueckenlose Tagesreihe erzeugen
    if from_date and to_date:
        d0 = datetime.fromisoformat(from_date)
        d1 = datetime.fromisoformat(to_date)
    else:
        d1 = datetime.now()
        d0 = d1 - timedelta(days=days)
    out = []
    cur = d0
    while cur.date() <= d1.date():
        key = cur.strftime("%Y-%m-%d")
        a = agg.get(key)
        if a:
            km = round(a["km"], 1)
            energy = round(a["energy"], 2)
            cons = round(energy / km * 100, 1) if km > 0 and energy > 0 else None
            out.append({
                "date": key, "km": km, "energy_kwh": energy,
                "cons_per_100": cons, "drives": a["drives"],
                "soc_start": a["soc_start"], "soc_end": a["soc_end"],
            })
        else:
            out.append({
                "date": key, "km": 0.0, "energy_kwh": 0.0,
                "cons_per_100": None, "drives": 0,
                "soc_start": None, "soc_end": None,
            })
        cur += timedelta(days=1)

    total_km = round(sum(x["km"] for x in out), 1)
    total_energy = round(sum(x["energy_kwh"] for x in out), 2)
    driving_days = sum(1 for x in out if x["km"] > 0)
    avg_cons = round(total_energy / total_km * 100, 1) if total_km > 0 else None
    return jsonify({
        "days": out,
        "summary": {
            "total_km": total_km,
            "total_energy_kwh": total_energy,
            "driving_days": driving_days,
            "calendar_days": len(out),
            "avg_km_per_calendar_day": round(total_km / len(out), 1) if out else 0,
            "avg_km_per_driving_day": round(total_km / driving_days, 1) if driving_days else 0,
            "avg_cons_per_100": avg_cons,
        },
    })


@app.route("/api/drives")
def api_drives():
    """Liste der Fahrten (zum Auswaehlen fuer den Vergleich).

    Pro Fahrt: id, Datum, Start/Ziel, km, Dauer, Verbrauch, kWh/100km, SoC.
    Optionaler Filter q= (Substring in Start/Ziel) fuer die Pendelstrecke.
    """
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    q = (request.args.get("q") or "").strip().lower()
    rows = _drive_rows(days, from_date, to_date)
    out = []
    for r in rows:
        route = f"{r.get('start_address') or ''} → {r.get('end_address') or ''}"
        if q and q not in route.lower():
            continue
        km = float(r.get("distance_km") or 0)
        energy = float(r.get("energy_consumed_kwh") or 0)
        cons = round(energy / km * 100, 1) if km > 0 and energy > 0 else None
        out.append({
            "id": r.get("teslamate_drive_id"),
            "start_date": r.get("start_date"),
            "end_date": r.get("end_date"),
            "route": route,
            "start_address": r.get("start_address"),
            "end_address": r.get("end_address"),
            "km": round(km, 1),
            "duration_min": r.get("duration_min"),
            "speed_avg": r.get("speed_avg"),
            "speed_max": r.get("speed_max"),
            "energy_kwh": round(energy, 2) if energy else None,
            "cons_per_100": cons,
            "soc_start": r.get("soc_start"),
            "soc_end": r.get("soc_end"),
            "outside_temp_avg": r.get("outside_temp_avg"),
        })
    # Neueste zuerst fuer die Auswahl-Liste
    out.sort(key=lambda x: x["start_date"] or "", reverse=True)
    return jsonify({"drives": out, "count": len(out)})


@app.route("/api/drives/compare")
def api_drives_compare():
    """Detailvergleich mehrerer Fahrten (Pendelstrecke uebereinanderlegen).

    Parameter ids=1,2,3 (teslamate_drive_id). Liefert je Fahrt die
    Kennzahlen nebeneinander + Deltas gegen den Durchschnitt, damit man
    z.B. sieht, welche Pendelfahrt sparsamer war und warum (Temperatur, Tempo).
    """
    ids_raw = request.args.get("ids", "")
    ids = [int(x) for x in ids_raw.split(",") if x.strip().isdigit()]
    if not ids:
        return jsonify({"error": "Parameter ids= fehlt (z.B. ids=2000,2001)"}), 400
    db = get_db()
    placeholders = ",".join("?" * len(ids))
    rows = [dict(r) for r in db.execute(
        f"SELECT * FROM drives WHERE teslamate_drive_id IN ({placeholders})",
        ids).fetchall()]
    # Reihenfolge wie angefragt
    by_id = {r["teslamate_drive_id"]: r for r in rows}
    drives = []
    for i in ids:
        r = by_id.get(i)
        if not r:
            continue
        km = float(r.get("distance_km") or 0)
        energy = float(r.get("energy_consumed_kwh") or 0)
        cons = round(energy / km * 100, 1) if km > 0 and energy > 0 else None
        drives.append({
            "id": i,
            "start_date": r.get("start_date"),
            "route": f"{r.get('start_address') or ''} → {r.get('end_address') or ''}",
            "km": round(km, 1),
            "duration_min": r.get("duration_min"),
            "speed_avg": round(float(r.get("speed_avg")), 1) if r.get("speed_avg") is not None else None,
            "speed_max": r.get("speed_max"),
            "energy_kwh": round(energy, 2) if energy else None,
            "cons_per_100": cons,
            "soc_start": r.get("soc_start"),
            "soc_end": r.get("soc_end"),
            "soc_used": (round(r["soc_start"] - r["soc_end"], 1)
                         if r.get("soc_start") is not None and r.get("soc_end") is not None else None),
            "outside_temp_avg": r.get("outside_temp_avg"),
        })
    if not drives:
        return jsonify({"error": "Keine Fahrten zu diesen IDs gefunden"}), 404

    # Durchschnitte + beste/schlechteste Verbrauchsfahrt
    def _avg(key):
        vals = [d[key] for d in drives if d.get(key) is not None]
        return round(sum(vals) / len(vals), 2) if vals else None
    def _avg_1(key):
        vals = [d[key] for d in drives if d.get(key) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None
    averages = {
        "km": _avg("km"), "duration_min": _avg("duration_min"),
        "speed_avg": _avg_1("speed_avg"), "energy_kwh": _avg("energy_kwh"),
        "cons_per_100": _avg("cons_per_100"), "soc_used": _avg("soc_used"),
        "outside_temp_avg": _avg("outside_temp_avg"),
    }
    cons_vals = [(d["id"], d["cons_per_100"]) for d in drives if d.get("cons_per_100") is not None]
    best = min(cons_vals, key=lambda x: x[1])[0] if cons_vals else None
    worst = max(cons_vals, key=lambda x: x[1])[0] if cons_vals else None
    # Delta gegen Durchschnitt anreichern
    for d in drives:
        if d.get("cons_per_100") is not None and averages["cons_per_100"] is not None:
            d["cons_delta"] = round(d["cons_per_100"] - averages["cons_per_100"], 1)
        else:
            d["cons_delta"] = None
        d["is_best"] = (d["id"] == best)
        d["is_worst"] = (d["id"] == worst)
    return jsonify({
        "drives": drives,
        "averages": averages,
        "best_consumption_id": best,
        "worst_consumption_id": worst,
    })


@app.route("/api/price-periods", methods=["GET", "POST", "DELETE"])
def api_price_periods():
    db = get_db()
    if request.method == "GET":
        rows = [dict(r) for r in db.execute(
            "SELECT * FROM price_periods ORDER BY kind, valid_from")]
        return jsonify(rows)
    if request.method == "POST":
        d = request.get_json(force=True)
        cur = db.execute(
            "INSERT INTO price_periods (kind, valid_from, valid_to, price_per_kwh, note) VALUES (?,?,?,?,?)",
            (d["kind"], d["valid_from"], d.get("valid_to") or None,
             float(d["price_per_kwh"]), d.get("note", "")),
        )
        db.commit()
        recompute_all_home_costs()
        return jsonify({"ok": True, "id": cur.lastrowid})
    if request.method == "DELETE":
        pid = request.args.get("id", type=int)
        db.execute("DELETE FROM price_periods WHERE id = ?", (pid,))
        db.commit()
        recompute_all_home_costs()
        return jsonify({"ok": True})


@app.route("/api/recompute", methods=["POST"])
def api_recompute():
    recompute_all_home_costs()
    return jsonify({"ok": True})


@app.route("/api/csrf", methods=["GET"])
def api_csrf():
    """Liefert das aktuelle CSRF-Token fuer das UI (X-CSRFToken-Header)."""
    return jsonify({"csrf_token": csrf_token()})


@app.route("/api/external/<int:sid>", methods=["PUT", "DELETE"])
def api_external_detail(sid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM external_sessions WHERE id = ?", (sid,))
        db.commit()
        return jsonify({"ok": True})

    d = request.get_json(force=True, silent=True) or {}
    err = csrf_protect()
    if err:
        return err

    # Erlaubte Felder (kein Mass-Assignment)
    allowed = {
        "location_name": lambda v: _v_text(v, "location_name", 200),
        "address": lambda v: _v_text(v, "address", 200),
        "provider": lambda v: _v_text(v, "provider", 120),
        "started_at": lambda v: _v_date(v, "started_at"),
        "finished_at": lambda v: _v_date(v, "finished_at"),
        "energy_kwh": lambda v: _v_number(v, "energy_kwh", lo=0, hi=100000),
        "odometer_start": lambda v: _v_number(v, "odometer_start", lo=0, hi=10000000),
        "cost_total": lambda v: _v_number(v, "cost_total", lo=0, hi=100000),
        "price_per_kwh": lambda v: _v_number(v, "price_per_kwh", lo=0, hi=1000),
        "manual_price": lambda v: (1 if v else 0, None),
        "note": lambda v: _v_text(v, "note", 500),
    }
    fields = {}
    for k, fn in allowed.items():
        if k in d:
            val, e = fn(d[k])
            if e:
                return jsonify({"ok": False, "error": e}), 400
            fields[k] = val

    if not fields:
        return jsonify({"ok": False, "error": "keine gueltigen Felder"}), 400

    # Bei Kosten-/Energie-Aenderung €/kWh neu ableiten (sofern nicht explizit gesetzt)
    cur = db.execute(
        "SELECT energy_kwh, cost_total FROM external_sessions WHERE id = ?", (sid,)
    ).fetchone()
    if not cur:
        return jsonify({"ok": False, "error": "nicht gefunden"}), 404

    if "price_per_kwh" not in fields and ("cost_total" in fields or "energy_kwh" in fields):
        energy = float(fields.get("energy_kwh", cur["energy_kwh"]) or 0)
        cost = float(fields.get("cost_total", cur["cost_total"]) or 0)
        fields["price_per_kwh"] = round(cost / energy, 4) if energy > 0 else 0.0

    set_parts = [f"{k} = ?" for k in fields]
    set_parts.append("manually_edited = 1")
    set_parts.append("updated_at = ?")
    db.execute(
        f"UPDATE external_sessions SET {', '.join(set_parts)} WHERE id = ?",
        list(fields.values()) + [_now_iso(), sid],
    )
    db.commit()
    return jsonify({"ok": True, **fields})


@app.route("/api/home-sessions/<int:sid>", methods=["PUT", "DELETE"])
def api_home_detail(sid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM home_sessions WHERE id = ?", (sid,))
        db.commit()
        return jsonify({"ok": True})

    d = request.get_json(force=True, silent=True) or {}
    err = csrf_protect()
    if err:
        return err

    allowed = {
        "odometer": lambda v: _v_number(v, "odometer", lo=0, hi=10000000),
        "vehicle": lambda v: _v_text(v, "vehicle", 120),
        "loadpoint": lambda v: _v_text(v, "loadpoint", 120),
        "solar_percentage": lambda v: _v_number(v, "solar_percentage", lo=0, hi=100),
        "created": lambda v: _v_date(v, "created"),
        "finished": lambda v: _v_date(v, "finished"),
        "note": lambda v: _v_text(v, "note", 500),
    }
    fields = {}
    for k, fn in allowed.items():
        if k in d:
            val, e = fn(d[k])
            if e:
                return jsonify({"ok": False, "error": e}), 400
            fields[k] = val

    if not fields:
        return jsonify({"ok": False, "error": "keine gueltigen Felder"}), 400

    # Aktuellen Datensatz laden, um abhaengige Felder neu zu berechnen.
    row = db.execute("SELECT * FROM home_sessions WHERE id = ?", (sid,)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "nicht gefunden"}), 404

    # Row mit Aenderungen zusammenfuehren
    merged = dict(row)
    merged.update({k: v for k, v in fields.items() if v is not None})

    # Abhaengige Kostenfelder neu berechnen (pv/grid/cost/price)
    cost = compute_home_cost_row(merged)
    set_parts = [f"{k} = ?" for k in fields]
    set_parts += ["pv_kwh = ?", "grid_kwh = ?", "grid_cost = ?",
                  "pv_cost = ?", "total_cost = ?", "price_per_kwh = ?",
                  "manually_edited = 1", "updated_at = ?"]
    params = list(fields.values()) + [
        cost["pv_kwh"], cost["grid_kwh"], cost["grid_cost"],
        cost["pv_cost"], cost["total_cost"], cost["price_per_kwh"],
        _now_iso(), sid,
    ]
    db.execute(
        f"UPDATE home_sessions SET {', '.join(set_parts)} WHERE id = ?", params
    )
    db.commit()
    return jsonify({"ok": True, **fields, "recalc": cost})


@app.route("/api/extra-costs/<int:eid>", methods=["PUT", "DELETE"])
def api_extra_cost_detail(eid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM extra_costs WHERE id = ?", (eid,))
        db.commit()
        return jsonify({"ok": True})

    d = request.get_json(force=True, silent=True) or {}
    err = csrf_protect()
    if err:
        return err

    allowed = {
        "category": lambda v: _v_text(v, "category", 30, choices=EXTRA_CATEGORIES, required=True),
        "date": lambda v: _v_date(v, "date", required=True),
        "description": lambda v: _v_text(v, "description", 200, required=True),
        "amount": lambda v: _v_number(v, "amount", lo=0, hi=10000000, required=True),
        "odometer": lambda v: _v_number(v, "odometer", lo=0, hi=10000000),
        "note": lambda v: _v_text(v, "note", 500),
    }
    fields = {}
    for k, fn in allowed.items():
        if k in d:
            val, e = fn(d[k])
            if e:
                return jsonify({"ok": False, "error": e}), 400
            fields[k] = val
        elif k == "category" and "category" not in d:
            # Kategorie nur setzen, wenn uebergeben
            pass

    if not fields:
        return jsonify({"ok": False, "error": "keine gueltigen Felder"}), 400

    set_parts = [f"{k} = ?" for k in fields]
    set_parts.append("manually_edited = 1")
    set_parts.append("updated_at = ?")
    db.execute(
        f"UPDATE extra_costs SET {', '.join(set_parts)} WHERE id = ?",
        list(fields.values()) + [_now_iso(), eid],
    )
    db.commit()
    return jsonify({"ok": True, **fields})


@app.route("/api/price-periods/<int:pid>", methods=["PUT", "DELETE"])
def api_price_period_detail(pid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM price_periods WHERE id = ?", (pid,))
        db.commit()
        recompute_all_home_costs()
        return jsonify({"ok": True})

    d = request.get_json(force=True, silent=True) or {}
    err = csrf_protect()
    if err:
        return err

    allowed = {
        "kind": lambda v: _v_text(v, "kind", 20, choices=PRICE_KINDS, required=True),
        "valid_from": lambda v: _v_date(v, "valid_from"),
        "valid_to": lambda v: _v_date(v, "valid_to"),
        "price_per_kwh": lambda v: _v_number(v, "price_per_kwh", lo=0, hi=1000, required=True),
        "note": lambda v: _v_text(v, "note", 200),
    }
    fields = {}
    for k, fn in allowed.items():
        if k in d:
            val, e = fn(d[k])
            if e:
                return jsonify({"ok": False, "error": e}), 400
            fields[k] = val

    if not fields:
        return jsonify({"ok": False, "error": "keine gueltigen Felder"}), 400

    set_parts = [f"{k} = ?" for k in fields]
    set_parts.append("manually_edited = 1")
    set_parts.append("updated_at = ?")
    db.execute(
        f"UPDATE price_periods SET {', '.join(set_parts)} WHERE id = ?",
        list(fields.values()) + [_now_iso(), pid],
    )
    db.commit()
    # Preisaenderung -> alle Home-Sessions neu bewerten
    recompute_all_home_costs()
    return jsonify({"ok": True, **fields})


@app.route("/api/extra-costs", methods=["GET", "POST", "DELETE"])
def api_extra_costs():
    db = get_db()
    if request.method == "GET":
        rows = [dict(r) for r in db.execute(
            "SELECT * FROM extra_costs ORDER BY date DESC")]
        # KM-Stand ableiten, wenn nicht erfasst: aus dem naechstgelegenen
        # Ladevorgang (home_sessions/external_sessions) oder Fahrt (drives).
        for r in rows:
            if r.get("odometer") in (None, 0, ""):
                r["odometer_derived"] = derive_odometer_for_date(db, r.get("date"))
            else:
                r["odometer_derived"] = r.get("odometer")
        return jsonify(rows)
    if request.method == "POST":
        d = request.get_json(force=True)
        cur = db.execute(
            """INSERT INTO extra_costs (category, date, description, amount, odometer, note, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (d["category"], d["date"], d.get("description", ""),
             float(d["amount"]), d.get("odometer"), d.get("note", ""),
             datetime.now().isoformat()),
        )
        db.commit()
        return jsonify({"ok": True, "id": cur.lastrowid})
    if request.method == "DELETE":
        eid = request.args.get("id", type=int)
        db.execute("DELETE FROM extra_costs WHERE id = ?", (eid,))
        db.commit()
        return jsonify({"ok": True})


@app.route("/api/seed", methods=["POST"])
def api_seed():
    """Testdaten einspielen (nur sinnvoll mit MOCK_MODE)."""
    sync_evcc()
    sync_teslamate()
    # Fahrten (TeslaMate-Drives) fuer km/Tag + Fahrtenvergleich
    try:
        sync_teslamate_drives()
    except Exception as e:
        app.logger.warning("Seed: Fahrten-Sync uebersprungen: %s", e)
    # ein paar Beispiel-Extra-Kosten
    db = get_db()
    db.execute("""INSERT INTO extra_costs (category, date, description, amount, odometer, note, created_at)
                  VALUES ('purchase','2024-01-10','Anschaffung Fahrzeug', 42990, 0, 'Listenpreis', ?)""",
              (datetime.now().isoformat(),))
    db.execute("""INSERT INTO extra_costs (category, date, description, amount, odometer, note, created_at)
                  VALUES ('service','2025-03-15','Inspektion + Service', 320, 38000, 'Jahresinspektion', ?)""",
              (datetime.now().isoformat(),))
    db.execute("""INSERT INTO extra_costs (category, date, description, amount, odometer, note, created_at)
                  VALUES ('accessory','2025-05-01','Wandhalterung Typ2', 180, 41000, 'Zubehör', ?)""",
              (datetime.now().isoformat(),))
    db.commit()
    return jsonify({"ok": True, "message": "Testdaten eingespielt"})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    """Alle gespeicherten Daten leeren (Haupt-Reset ueber Admin-UI).

    Leert home_sessions, external_sessions, extra_costs, price_periods.
    Die Konfiguration (config.yaml) bleibt unberuehrt. CSRF-geschützt.
    """
    err = csrf_protect()
    if err:
        return err
    db = get_db()
    db.execute("DELETE FROM home_sessions")
    db.execute("DELETE FROM external_sessions")
    db.execute("DELETE FROM extra_costs")
    db.execute("DELETE FROM price_periods")
    db.execute("DELETE FROM sqlite_sequence WHERE name IN "
               "('home_sessions','external_sessions','extra_costs','price_periods')")
    db.commit()
    return jsonify({"ok": True, "message": "Alle Daten zurueckgesetzt"})


@app.route("/api/debug/evcc")
def api_debug_evcc():
    """Rohes EVCC-Sample (zum Felder-Check gegen echte Instanz)."""
    if mock_mode():
        return jsonify(_mock_evcc_sessions()[:2])
    evcc = config["evcc"]
    client = EVCCClient(evcc["host"], evcc["port"], evcc.get("password", ""),
                        evcc.get("api_token", ""), evcc.get("use_tls", False))
    data = client.get_sessions()
    return jsonify(data[:3] if isinstance(data, list) else data)


@app.route("/api/debug/teslamate")
def api_debug_teslamate():
    """Rohe TeslaMate-Sessions (zeigt geofence/address, die TM wirklich liefert).
    Damit der Nutzer sehen kann, warum eine Ladung als 'Oeffentliche Ladestation'
    (Default) gelabelt wird statt als Zuhause."""
    tm = config["teslamate"]
    client = TeslaMateClient(tm["url"], tm.get("api_token", ""))
    try:
        sessions = client.get_charging_sessions()
    except Exception as e:
        return jsonify({"error": str(e)}), 502
    # Nur die Felder zeigen, die fuer die Klassifizierung relevant sind
    out = []
    for s in sessions[:20]:
        geo = s.get("geofence")
        addr = s.get("address")
        out.append({
            "charge_id": s.get("charge_id"),
            "geofence": geo,
            "address": addr,
            "erkannt_als": _detect_provider(geo, addr),
            "label_wird": _location_label(geo, addr),
            "ist_zuhause": _is_home_address(geo, addr),
        })
    return jsonify(out)


# ============================================================
# NERD ANALYTICS - TeslaMate Special Data
# ============================================================

@app.route("/api/nerd/kpis")
def api_nerd_kpis():
    """4 KPI-Kacheln für Nerd Analytics."""
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None
    
    db = get_db()
    
    # 1. Vampire Drain (Standverluste)
    # Nutze drives Tabelle für Park-Intervalle (Tage ohne Fahrt)
    # TeslaMate hat keine direkte Park-Session Tabelle, daher approximieren wir
    # über die Lücken zwischen Fahrten
    vampire_query = """
        SELECT 
            start_date,
            end_date,
            soc_start,
            soc_end,
            distance_km
        FROM drives 
        WHERE start_date >= ?
    """
    params = [cutoff]
    if end:
        vampire_query += " AND start_date <= ?"
        params.append(end)
    vampire_query += " ORDER BY start_date ASC"
    
    drives = [dict(r) for r in db.execute(vampire_query, params).fetchall()]
    
    vampire_drain_pct_per_day = 0.0
    vampire_drain_watts_sentry_on = 0.0
    vampire_drain_watts_sentry_off = 0.0
    sentry_on_count = 0
    sentry_off_count = 0
    
    if len(drives) >= 2:
        # Park-Intervalle zwischen Fahrten berechnen
        park_intervals = []
        for i in range(len(drives) - 1):
            current = drives[i]
            next_drive = drives[i + 1]
            
            try:
                end_soc = float(current.get("soc_end") or 0)
                start_soc = float(next_drive.get("soc_start") or 0)
                end_time = datetime.fromisoformat(str(current.get("end_date") or "").replace("Z", "")[:19])
                start_time = datetime.fromisoformat(str(next_drive.get("start_date") or "").replace("Z", "")[:19])
                
                if end_soc > 0 and start_soc > 0 and start_time > end_time:
                    hours_parked = (start_time - end_time).total_seconds() / 3600.0
                    if hours_parked > 1 and hours_parked < 168:  # 1h bis 7 Tage
                        soc_loss = end_soc - start_soc
                        if soc_loss > 0:
                            pct_per_day = (soc_loss / hours_parked) * 24
                            park_intervals.append({
                                "hours": hours_parked,
                                "soc_loss": soc_loss,
                                "pct_per_day": pct_per_day,
                                "date": start_time.strftime("%Y-%m-%d")
                            })
            except Exception:
                continue
        
        if park_intervals:
            vampire_drain_pct_per_day = sum(p["pct_per_day"] for p in park_intervals) / len(park_intervals)
            # Ohne Sentry-Modus Daten schätzen wir: ca. 50% der Zeit Sentry an
            # Typische Werte: Sentry an ~1-2%/Tag, aus ~0.5-1%/Tag
            vampire_drain_watts_sentry_on = vampire_drain_pct_per_day * 0.75  # grobe Schätzung
            vampire_drain_watts_sentry_off = vampire_drain_pct_per_day * 0.25
    
    # 2. Battery Degradation
    # Range at 100% = battery_capacity / consumption_per_100km * 100
    # Use drives table with energy_consumed_kwh and distance_km
    BATTERY_CAPACITY_KWH = 75.0  # Model Y usable capacity estimate
    
    deg_query = """
        SELECT odometer_start, energy_consumed_kwh, distance_km, start_date
        FROM drives 
        WHERE odometer_start > 0 AND energy_consumed_kwh > 0 AND distance_km > 0
    """
    if from_date and to_date:
        deg_query += " AND start_date >= ? AND start_date <= ?"
        deg_params = [cutoff, end]
    else:
        deg_query += " AND start_date >= ?"
        deg_params = [cutoff]
    deg_query += " ORDER BY start_date ASC"
    
    deg_rows = [dict(r) for r in db.execute(deg_query, deg_params).fetchall()]
    
    projected_ranges = []
    for r in deg_rows:
        odo = float(r.get("odometer_start") or 0)
        energy = float(r.get("energy_consumed_kwh") or 0)
        dist = float(r.get("distance_km") or 0)
        if odo > 0 and energy > 0 and dist > 0:
            wh_per_km = (energy / dist) * 1000
            if 50 < wh_per_km < 500:  # Plausible consumption
                range_100 = BATTERY_CAPACITY_KWH * 1000 / wh_per_km
                if 200 < range_100 < 600:  # Plausible range
                    projected_ranges.append({
                        "odo": round(odo, 1),
                        "range_100": round(range_100, 1),
                        "date": str(r.get("start_date") or "")[:10]
                    })
    
    first_range = projected_ranges[0]["range_100"] if projected_ranges else 0
    last_range = projected_ranges[-1]["range_100"] if projected_ranges else 0
    degradation_pct = ((first_range - last_range) / first_range * 100) if first_range > 0 else 0
    
    # 3. Charging Efficiency (AC vs DC)
    # AC: home_sessions (EVCC) -> charge_energy_used vs charge_energy_added
    # DC: external_sessions Supercharger
    eff_query = """
        SELECT 
            CASE 
                WHEN provider = 'Supercharger' OR address LIKE '%supercharger%' THEN 'DC'
                ELSE 'AC'
            END as type,
            energy_kwh,
            energy_used_kwh
        FROM external_sessions 
        WHERE energy_kwh > 0 AND energy_used_kwh > 0
    """
    if from_date and to_date:
        eff_query += " AND started_at >= ? AND started_at <= ?"
        eff_params = [cutoff, end]
    else:
        eff_query += " AND started_at >= ?"
        eff_params = [cutoff]
    
    eff_rows = [dict(r) for r in db.execute(eff_query, eff_params).fetchall()]
    
    ac_eff = []
    dc_eff = []
    for r in eff_rows:
        added = float(r.get("energy_kwh") or 0)
        used = float(r.get("energy_used_kwh") or 0)
        if added > 0 and used > 0:
            eff = (added / used) * 100
            if r.get("type") == "DC":
                dc_eff.append(eff)
            else:
                ac_eff.append(eff)
    
    ac_avg = sum(ac_eff) / len(ac_eff) if ac_eff else 0
    dc_avg = sum(dc_eff) / len(dc_eff) if dc_eff else 0
    
    # 4. Temperature Efficiency Factor
    temp_query = """
        SELECT outside_temp_avg, energy_consumed_kwh, distance_km
        FROM drives
        WHERE outside_temp_avg IS NOT NULL 
          AND energy_consumed_kwh > 0 
          AND distance_km > 0
    """
    if from_date and to_date:
        temp_query += " AND start_date >= ? AND start_date <= ?"
        temp_params = [cutoff, end]
    else:
        temp_query += " AND start_date >= ?"
        temp_params = [cutoff]
    
    temp_rows = [dict(r) for r in db.execute(temp_query, temp_params).fetchall()]
    
    winter = []  # < 10°C
    summer = []  # > 15°C
    for r in temp_rows:
        temp = float(r.get("outside_temp_avg") or 0)
        energy = float(r.get("energy_consumed_kwh") or 0)
        dist = float(r.get("distance_km") or 0)
        if dist > 0:
            wh_per_km = (energy / dist) * 1000
            if temp < 10:
                winter.append(wh_per_km)
            elif temp > 15:
                summer.append(wh_per_km)
    
    winter_avg = sum(winter) / len(winter) if winter else 0
    summer_avg = sum(summer) / len(summer) if summer else 0
    temp_diff_pct = ((winter_avg - summer_avg) / summer_avg * 100) if summer_avg > 0 else 0
    
    return jsonify({
        "vampire_drain": {
            "pct_per_day": round(vampire_drain_pct_per_day, 2),
            "watts_sentry_on": round(vampire_drain_watts_sentry_on * 10, 0),  # rough
            "watts_sentry_off": round(vampire_drain_watts_sentry_off * 10, 0),
            "intervals_count": len(park_intervals) if 'park_intervals' in locals() else 0
        },
        "battery_degradation": {
            "first_range_km": round(first_range, 1),
            "last_range_km": round(last_range, 1),
            "degradation_pct": round(degradation_pct, 2),
            "data_points": len(projected_ranges)
        },
        "charging_efficiency": {
            "ac_avg_pct": round(ac_avg, 1),
            "dc_avg_pct": round(dc_avg, 1),
            "ac_sessions": len(ac_eff),
            "dc_sessions": len(dc_eff)
        },
        "temperature_efficiency": {
            "winter_wh_km": round(winter_avg, 1),
            "summer_wh_km": round(summer_avg, 1),
            "diff_pct": round(temp_diff_pct, 1),
            "winter_drives": len(winter),
            "summer_drives": len(summer)
        }
    })


@app.route("/api/nerd/charts")
def api_nerd_charts():
    """Chart-Daten für Degradation und Temp-Effizienz."""
    days = request.args.get("days", 365, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None
    
    db = get_db()
    
    # Chart 1: Degradation Scatter (Odometer vs Projected Range at 100%)
    deg_query = """
        SELECT odometer_start, energy_consumed_kwh, distance_km, start_date
        FROM drives 
        WHERE odometer_start > 0 AND energy_consumed_kwh > 0 AND distance_km > 0
          AND start_date >= ?
    """
    params = [cutoff]
    if end:
        deg_query += " AND start_date <= ?"
        params.append(end)
    deg_query += " ORDER BY start_date ASC"
    
    deg_rows = [dict(r) for r in db.execute(deg_query, params).fetchall()]
    
    degradation_data = []
    # Assume ~75 kWh usable battery capacity for Model Y
    BATTERY_CAPACITY_KWH = 75.0
    for r in deg_rows:
        odo = float(r.get("odometer_start") or 0)
        energy = float(r.get("energy_consumed_kwh") or 0)
        dist = float(r.get("distance_km") or 0)
        if odo > 0 and energy > 0 and dist > 0:
            wh_per_km = (energy / dist) * 1000
            if 50 < wh_per_km < 500:  # Plausible consumption
                range_100 = BATTERY_CAPACITY_KWH * 1000 / wh_per_km
                if 200 < range_100 < 600:  # Plausible range
                    degradation_data.append({
                        "odo": round(odo, 1),
                        "range_100": round(range_100, 1),
                        "date": str(r.get("start_date") or "")[:10]
                    })
    
    # Chart 2: Efficiency vs Temperature Scatter
    temp_query = """
        SELECT outside_temp_avg, energy_consumed_kwh, distance_km, start_date
        FROM drives
        WHERE outside_temp_avg IS NOT NULL 
          AND energy_consumed_kwh > 0 
          AND distance_km > 0
          AND start_date >= ?
    """
    params2 = [cutoff]
    if end:
        temp_query += " AND start_date <= ?"
        params2.append(end)
    temp_query += " ORDER BY start_date ASC"
    
    temp_rows = [dict(r) for r in db.execute(temp_query, params2).fetchall()]
    
    temp_efficiency_data = []
    for r in temp_rows:
        temp = float(r.get("outside_temp_avg") or 0)
        energy = float(r.get("energy_consumed_kwh") or 0)
        dist = float(r.get("distance_km") or 0)
        if dist > 0:
            wh_per_km = (energy / dist) * 1000
            if 50 < wh_per_km < 500:  # Plausibilität
                temp_efficiency_data.append({
                    "temp": round(temp, 1),
                    "wh_km": round(wh_per_km, 1),
                    "date": str(r.get("start_date") or "")[:10]
                })
    
    return jsonify({
        "degradation": degradation_data,
        "temp_efficiency": temp_efficiency_data
    })


@app.route("/api/nerd/vampire-drain")
def api_nerd_vampire_drain():
    """Detail-Tabelle für Vampire Drain (Park-Sessions)."""
    days = request.args.get("days", 30, type=int)
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None
    
    db = get_db()
    
    query = """
        SELECT start_date, end_date, soc_start, soc_end, distance_km
        FROM drives 
        WHERE start_date >= ?
    """
    params = [cutoff]
    if end:
        query += " AND start_date <= ?"
        params.append(end)
    query += " ORDER BY start_date ASC"
    
    drives = [dict(r) for r in db.execute(query, params).fetchall()]
    
    park_sessions = []
    for i in range(len(drives) - 1):
        current = drives[i]
        next_drive = drives[i + 1]
        
        try:
            end_soc = float(current.get("soc_end") or 0)
            start_soc = float(next_drive.get("soc_start") or 0)
            end_time = datetime.fromisoformat(str(current.get("end_date") or "").replace("Z", "")[:19])
            start_time = datetime.fromisoformat(str(next_drive.get("start_date") or "").replace("Z", "")[:19])
            
            if end_soc > 0 and start_soc > 0 and start_time > end_time:
                hours_parked = (start_time - end_time).total_seconds() / 3600.0
                if hours_parked > 1 and hours_parked < 168:
                    soc_loss = end_soc - start_soc
                    if soc_loss >= 0:
                        # Geschätzter Verlust in kWh (Model Y ~75kWh nutzbar)
                        est_kwh = (soc_loss / 100) * 75
                        park_sessions.append({
                            "date": start_time.strftime("%Y-%m-%d %H:%M"),
                            "duration_h": round(hours_parked, 1),
                            "soc_loss_pct": round(soc_loss, 2),
                            "est_loss_kwh": round(est_kwh, 2),
                            "sentry_mode": "Unbekannt"  # TM speichert das nicht direkt
                        })
        except Exception:
            continue
    
    # Neueste zuerst
    park_sessions.reverse()
    
    return jsonify({"park_sessions": park_sessions[:50]})  # Top 50


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
