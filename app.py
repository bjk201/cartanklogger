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
        cost = compute_home_cost(charged, solar_f, created)
        try:
            cur = db.execute(
                """INSERT OR IGNORE INTO home_sessions
                   (evcc_session_id, created, finished, loadpoint, vehicle, odometer,
                    charged_kwh, solar_percentage, pv_kwh, grid_kwh, grid_cost, pv_cost,
                    total_cost, price_per_kwh, imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid, created.isoformat(),
                    finished.isoformat() if finished else None,
                    s.get("loadpoint", ""), s.get("vehicle", ""),
                    s.get("odometer"),
                    charged, solar,
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
        # Adress-Label: immer anonymisiert (nie rohe Strasse/Hausnummer in der API)
        label = _location_label(s.get("geofence"), s.get("address"))
        if existing is None:
            cur = db.execute(
                """INSERT OR IGNORE INTO external_sessions
                   (teslamate_session_id, started_at, finished_at, location_name, address,
                    latitude, longitude, provider, energy_kwh, energy_used_kwh, odometer_start,
                    odometer_end, cost_total, price_per_kwh, manual_price, imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid, started.isoformat(),
                    finished.isoformat() if finished else None,
                    s.get("geofence") or "", label,
                    lat, lng, provider,
                    energy, energy_used, s.get("odometer"),
                    s.get("odometer"),
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
        })
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


@app.route("/api/sync/all", methods=["POST"])
def api_sync_all():
    e = sync_evcc()
    t = sync_teslamate()
    return jsonify({"ok": True, "evcc": e, "teslamate": t})


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
    home = [dict(r) for r in db.execute(home_q, params).fetchall()]
    # Kosten immer frisch aus den (ggf. geänderten) Preisperioden berechnen
    for r in home:
        c = compute_home_cost_row(r)
        r.update(c)
        # Datenschutz: keine Rohdaten/Payload im JSON
        r["raw"] = None
        r["has_raw"] = bool(r.get("raw"))
    ext = [dict(r) for r in db.execute(ext_q, params).fetchall()]
    for r in ext:
        # Datenschutz: rohe Adresse durch anonymisiertes Label ersetzen,
        # GPS-Koordinaten entfernen, raw nur als Flag belassen.
        r["address"] = _location_label(r.get("location_name"), r.get("address"))
        r["latitude"] = None
        r["longitude"] = None
        r["has_raw"] = bool(r.get("raw"))
        r.pop("raw", None)
    return jsonify({"home": home, "external": ext})


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
    evcc_q = "SELECT created, finished, charged_kwh, total_cost, odometer, price_per_kwh, solar_percentage, loadpoint, raw FROM home_sessions WHERE created >= ?"
    tm_q = "SELECT started_at, energy_kwh, energy_used_kwh, cost_total, odometer_start, latitude, longitude, address, raw FROM external_sessions WHERE started_at >= ?"
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
        if not _is_home_address(t.get("address"), t.get("address")):
            if is_dc:
                day_dc_kwh[day] += kwh
            else:
                day_ac_kwh[day] += kwh
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
            "range": round(day_range_end.get(d, 0), 0),
        })
    series.sort(key=lambda x: x["day"])

    # --- Gesamt-KPIs ---
    total_kwh = round(sum(s["kwh"] for s in series), 2)
    total_cost = round(sum(s["cost"] for s in series), 2)
    total_km = round(_total_km_odo, 1)  # Tachostand (max odometer), nicht kumulative Diff
    total_ac = round(sum(s["ac_kwh"] for s in series), 2)
    total_dc = round(sum(s["dc_kwh"] for s in series), 2)
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
            "dc_cost_per_100km": round((total_dc / (total_ac + total_dc) * avg_cost_100) if (total_ac + total_dc) > 0 else 0, 2),
            "ac_cost_per_100km": round((total_ac / (total_ac + total_dc) * avg_cost_100) if (total_ac + total_dc) > 0 else 0, 2),
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

    # --- Monatsvergleich (Kosten + Energie) aus build_stats.monthly ---
    stats = build_stats(days, from_date, to_date)
    monthly = stats.get("monthly", [])

    # --- Standorttyp-Verteilung (nur echte Externe, TM) ---
    # Zuhause = EVCC (Wallbox). Externe nach Adress-Typ gruppieren.
    loc_map = defaultdict(lambda: {"kwh": 0.0, "cost": 0.0, "sessions": 0, "added": 0.0})
    for r in ext:
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
    ext_durs = [_dur_h(r.get("started_at"), r.get("finished_at")) for r in ext]
    ext_durs = [d for d in ext_durs if d is not None]
    all_durs = home_durs + ext_durs
    n_home = len(home)
    n_ext = len(ext)
    n_all = n_home + n_ext
    avg_per_charge = {
        "n_charges": n_all,
        "avg_kwh": round(sum(float(r.get("charged_kwh") or 0) for r in home) / n_home, 2) if n_home else 0,
        "avg_cost": round(sum(float(r.get("total_cost") or 0) for r in home) / n_home, 2) if n_home else 0,
        "avg_duration_h": round(sum(all_durs) / len(all_durs), 2) if all_durs else 0,
        "ext_avg_kwh": round(sum(float(r.get("energy_kwh") or 0) for r in ext) / n_ext, 2) if n_ext else 0,
        "ext_avg_cost": round(sum(float(r.get("cost_total") or 0) for r in ext) / n_ext, 2) if n_ext else 0,
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
    for r in home:
        try:
            dt = datetime.fromisoformat(str(r.get("created")).replace("Z", "")[:19])
            heat[dt.weekday()][dt.hour] += 1
        except Exception:
            pass
    for r in ext:
        try:
            dt = datetime.fromisoformat(str(r.get("started_at")).replace("Z", "")[:19])
            heat[dt.weekday()][dt.hour] += 1
        except Exception:
            pass

    return jsonify({
        "monthly": monthly,
        "by_location": by_location,
        "avg_per_charge": avg_per_charge,
        "ac_dc": ac_dc,
        "home_vs_extern": home_vs_extern,
        "heatmap": heat,
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
              "loadpoint, note FROM home_sessions WHERE created >= ?")
    tm_q = ("SELECT started_at, odometer_end, odometer_start, energy_kwh, "
            "cost_total, price_per_kwh, provider, address, location_name, note "
            "FROM external_sessions WHERE started_at >= ?")
    params = [cutoff]
    if end:
        evcc_q += " AND created <= ?"
        tm_q += " AND started_at <= ?"
        params = [cutoff, end]

    home = [dict(r) for r in db.execute(evcc_q + " ORDER BY created ASC", params).fetchall()]
    ext = [dict(r) for r in db.execute(tm_q + " ORDER BY started_at ASC", params).fetchall()]

    # (date, odometer, fill_kwh, unit_price, total, location, notes)
    # Jede Ladung = ein kompletter "Fill-up" (Full Tank), Einheit kWh.
    rows = []

    for e in home:
        d = (e.get("created") or "")[:10]
        odo = float(e.get("odometer") or 0)
        kwh = float(e.get("charged_kwh") or 0)
        total = float(e.get("total_cost") or 0)
        unit = float(e.get("price_per_kwh") or 0)
        loc = e.get("loadpoint") or ""
        note = e.get("note") or "Wallbox (Zuhause)"
        rows.append((d, odo, kwh, unit, total, str(loc), str(note)))

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
        rows.append((d, odo, kwh, unit, total, str(loc), str(note)))

    # Nach Datum sortieren (aufsteigend = chronologisch)
    rows.sort(key=lambda r: r[0])

    # Road Trip MPG CSV-Spalten (siehe darrensoft.ca/roadtrip/manual/csv-import/columns/).
    # 'Fill Unit' = kWh erzwingt Strom-Einheit unabhaengig vom Fahrzeugprofil-Default.
    # 'Full Tank' = 1 markiert jede Ladung als vollstaendig getankt (korrekte Verbrauchsrechnung).
    header = ["Date", "Odometer", "Fill Amount", "Fill Unit",
              "Price per Unit", "Total Price", "Full Tank", "Location", "Notes"]
    buf = _StringIO()
    w = _csv.writer(buf)
    w.writerow(header)
    for d, odo, kwh, unit, total, loc, note in rows:
        # Leere/ungueltige Zeilen nicht exportieren
        if not d or (kwh <= 0 and total <= 0):
            continue
        w.writerow([
            d,
            f"{odo:.1f}" if odo else "",
            f"{kwh:.3f}" if kwh else "",
            "kWh",
            f"{unit:.4f}" if unit else "",
            f"{total:.2f}" if total else "",
            "1",
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
