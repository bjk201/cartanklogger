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
import requests
from datetime import datetime, date, timedelta
from flask import Flask, render_template, jsonify, request, g

try:
    import yaml
except ImportError:
    yaml = None

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.yaml")
DB_PATH = os.environ.get("DB_PATH", "/app/data/cartanklogger.db")
_env_mock = os.environ.get("MOCK_MODE")
MOCK_MODE = _env_mock.lower() in ("1", "true", "yes") if _env_mock is not None else None


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
        },
        "pricing_defaults": {
            "grid_price_per_kwh": 0.32,   # Netzbezugspreis (€/kWh)
            "feedin_price_per_kwh": 0.08,  # Einspeisevergütung (€/kWh)
        },
    }
    cfg = defaults
    if os.path.exists(CONFIG_PATH) and yaml:
        try:
            with open(CONFIG_PATH, "r") as f:
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


config = load_config()


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
    db.commit()
    seed_price_periods(db)


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
        # Basis-URL der teslamateapi, z.B. http://192.168.1.x:8080/api/v1
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
    """Liste der als 'Zuhause' geltenden Adress-Substrings (aus config)."""
    return [a.strip().lower() for a in config.get("app", {}).get("home_addresses", []) if a and a.strip()]


def _is_home_address(geofence, address):
    """True, wenn eine TeslaMate-Ladung an einer Zuhause-Adresse stattfand.
    Diese Ladungen sind IDENTISCH mit den EVCC-Ladungen (doppeltes Tracking)
    und duerfen NICHT als extern gezaehlt/addiert werden."""
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
        if existing is None:
            cur = db.execute(
                """INSERT OR IGNORE INTO external_sessions
                   (teslamate_session_id, started_at, finished_at, location_name, address,
                    latitude, longitude, provider, energy_kwh, energy_used_kwh, odometer_start,
                    cost_total, price_per_kwh, manual_price, imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid, started.isoformat(),
                    finished.isoformat() if finished else None,
                    s.get("geofence") or "", s.get("address") or "",
                    s.get("latitude"), s.get("longitude"), provider,
                    energy, energy_used, s.get("odometer"),
                    cost_total, round(ppk, 4), 0, now, json.dumps(s, default=str),
                ),
            )
            inserted += cur.rowcount
        elif existing["manual_price"] == 0 and cost_total > 0:
            # Auto-Eintrag: Kosten aus TeslaMate uebernehmen, falls gepflegt
            db.execute(
                """UPDATE external_sessions SET cost_total=?, price_per_kwh=?, energy_kwh=?, energy_used_kwh=?
                   WHERE id=?""",
                (round(cost_total, 2), round(ppk, 4), energy, energy_used, existing["id"]))
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
            "loadpoint": "Wallbox Garage",
            "vehicle": "Tesla Model 3",
            "odometer": 42000 + i * 320,
            "chargedEnergy": round(8 + (i % 5), 2),
            "solarPercentage": solar,
            "price": 3.5,
            "pricePerKWh": 0.33,
        })
    return out


def _mock_teslamate_sessions():
    base = datetime.now() - timedelta(days=100)
    out = []
    for i in range(6):
        started = base + timedelta(days=i * 18, hours=5)
        is_sc = i % 2 == 0
        out.append({
            "id": 500 + i,
            "startDate": started.isoformat() + "Z",
            "endDate": (started + timedelta(hours=1)).isoformat() + "Z",
            "odometer": 42500 + i * 2900,
            "chargeEnergyAdded": round(45 + (i % 3) * 10, 1),
            "address": "A8 Tank & Rast" if not is_sc else "Tesla Supercharger München",
            "latitude": 48.1 + i * 0.01,
            "longitude": 11.5 + i * 0.01,
            "geofence": "Supercharger München" if is_sc else "A8 Rastplatz",
            "cost": round(18 + i * 2, 2) if is_sc else 0.0,
            "durationMin": 55,
            "startBatteryLevel": 20,
            "endBatteryLevel": 80,
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


def build_stats(days=365):
    db = get_db()
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()

    home = db.execute(
        "SELECT * FROM home_sessions WHERE created >= ? ORDER BY created ASC", (cutoff,)
    ).fetchall()
    ext_all = db.execute(
        "SELECT * FROM external_sessions WHERE started_at >= ? ORDER BY started_at ASC",
        (cutoff,),
    ).fetchall()
    # WICHTIG: TeslaMate-Ladungen an Zuhause-Adressen (Dammstraße/Garage) sind
    # dieselben wie die EVCC-Ladungen (doppeltes Tracking). Sie duerfen NICHT
    # als extern gezaehlt oder zur Energie/Distanz addiert werden.
    ext = [r for r in ext_all if not _is_home_address(r["location_name"], r["address"])]
    extras = db.execute(
        "SELECT * FROM extra_costs WHERE date >= ? ORDER BY date DESC", (cutoff,)
    ).fetchall()

    home_kwh = sum(r["charged_kwh"] for r in home)
    home_grid_cost = 0.0
    home_pv_cost = 0.0
    home_pv_kwh = 0.0
    home_grid_kwh = 0.0
    for r in home:
        c = compute_home_cost_row(r)
        home_grid_cost += c["grid_cost"]
        home_pv_cost += c["pv_cost"]
        home_pv_kwh += c["pv_kwh"]
        home_grid_kwh += c["grid_kwh"]
    home_cost = home_grid_cost + home_pv_cost

    ext_kwh = sum(r["energy_kwh"] for r in ext)
    ext_cost = sum(r["cost_total"] for r in ext)

    extra_total = sum(e["amount"] for e in extras)
    extra_by_cat = {}
    for e in extras:
        extra_by_cat[e["category"]] = extra_by_cat.get(e["category"], 0) + e["amount"]

    # Distanz (Odometer-Diff über alle Sessions)
    rows = []
    for r in home:
        rows.append((r["created"], r["odometer"]))
    for r in ext:
        rows.append((r["started_at"], r["odometer_start"]))
    rows.sort(key=lambda x: x[0])
    total_dist = 0.0
    prev = None
    for _, odo in rows:
        if odo is not None:
            if prev is not None and odo > prev:
                total_dist += odo - prev
            prev = odo

    total_kwh = home_kwh + ext_kwh
    total_cost = home_cost + ext_cost + extra_total
    tco = total_cost

    cost_per_km = (total_cost / total_dist) if total_dist > 0 else 0
    consumption = (total_kwh / total_dist * 100) if total_dist > 0 else 0

    # Monatliche Aggregate
    monthly = {}
    for r in home:
        m = r["created"][:7]
        agg = monthly.setdefault(m, {"home_kwh": 0, "home_cost": 0, "ext_kwh": 0, "ext_cost": 0, "extra": 0})
        c = compute_home_cost_row(r)
        agg["home_kwh"] += r["charged_kwh"]
        agg["home_cost"] += c["total_cost"]
    for r in ext:
        m = r["started_at"][:7]
        agg = monthly.setdefault(m, {"home_kwh": 0, "home_cost": 0, "ext_kwh": 0, "ext_cost": 0, "extra": 0})
        agg["ext_kwh"] += r["energy_kwh"]
        agg["ext_cost"] += r["cost_total"]
    for e in extras:
        m = e["date"][:7]
        agg = monthly.setdefault(m, {"home_kwh": 0, "home_cost": 0, "ext_kwh": 0, "ext_cost": 0, "extra": 0})
        agg["extra"] += e["amount"]

    monthly_list = [
        {"month": m, **{k: round(v, 2) for k, v in agg.items()}}
        for m, agg in sorted(monthly.items())
    ]

    return {
        "home": {
            "count": len(home), "kwh": round(home_kwh, 2),
            "grid_kwh": round(home_grid_kwh, 2), "pv_kwh": round(home_pv_kwh, 2),
            "grid_cost": round(home_grid_cost, 2), "pv_cost": round(home_pv_cost, 2),
            "cost": round(home_cost, 2),
            "pv_share_pct": round(home_pv_kwh / home_kwh * 100, 1) if home_kwh else 0,
        },
        "external": {
            "count": len(ext), "kwh": round(ext_kwh, 2), "cost": round(ext_cost, 2),
            "share_pct": round(ext_kwh / total_kwh * 100, 1) if total_kwh else 0,
            "cost_per_kwh": round(ext_cost / ext_kwh, 3) if ext_kwh else 0,
        },
        "extra": {
            "count": len(extras), "total": round(extra_total, 2),
            "by_category": {k: round(v, 2) for k, v in extra_by_cat.items()},
        },
        "totals": {
            "kwh": round(total_kwh, 2),
            "cost_home_and_external": round(home_cost + ext_cost, 2),
            "cost_extra": round(extra_total, 2),
            "tco": round(tco, 2),
            "distance_km": round(total_dist, 1),
            "cost_per_km": round(cost_per_km, 3),
            "consumption_kwh_per_100km": round(consumption, 2),
        },
        "monthly": monthly_list,
    }


# ---------------------------------------------------------------------------
# Routen - Seiten
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", mock=mock_mode())


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
        # YAML persistieren
        try:
            os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
            with open(CONFIG_PATH, "w") as f:
                yaml.safe_dump(config, f, default_flow_style=False, allow_unicode=True)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
    c = json.loads(json.dumps(config))
    # Passwörter/Tokens nie ausliefern
    c["evcc"]["password"] = "" if c["evcc"].get("password") else ""
    c["evcc"]["api_token"] = "" if c["evcc"].get("api_token") else ""
    c["teslamate"]["api_token"] = "" if c["teslamate"].get("api_token") else ""
    c["app"]["mock_mode"] = mock_mode()
    return jsonify(c)


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


@app.route("/api/stats")
def api_stats():
    days = request.args.get("days", 365, type=int)
    return jsonify(build_stats(days))


@app.route("/api/sessions")
def api_sessions():
    db = get_db()
    home = [dict(r) for r in db.execute("SELECT * FROM home_sessions ORDER BY created DESC")]
    # Kosten immer frisch aus den (ggf. geänderten) Preisperioden berechnen
    for r in home:
        c = compute_home_cost_row(r)
        r.update(c)
    ext = [dict(r) for r in db.execute("SELECT * FROM external_sessions ORDER BY started_at DESC")]
    return jsonify({"home": home, "external": ext})


# ---------------------------------------------------------------------------
# Zusammenfassung: pro Tag + Ladestation, EVCC führend + TeslaMate-Werte
# (TeslaMate-PV-Fragmente werden bei Lücke < 60min + gleicher Adresse gemerged)
# ---------------------------------------------------------------------------
TM_MERGE_GAP_MIN = 60

def _tm_grouped_sessions(rows):
    """external_sessions (TeslaMate) nach Adresse + Zeitlücke zu Sessions gruppieren."""
    rows = sorted(rows, key=lambda r: (r.get("started_at") or ""))
    if not rows:
        return []
    groups, cur = [], [rows[0]]
    for r in rows[1:]:
        prev = cur[-1]
        prev_end = prev.get("finished_at") or prev.get("started_at")
        this_start = r.get("started_at")
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
    - Zuhause = EVCC (Wallbox Garage) IST fuehrend fuer kWh/Kosten/km.
    - TeslaMate-Zuhause (Dammstraße/Garage) = DIESELBEN Ladungen wie EVCC,
      werden NUR fuer added/used -> Ladeverluste genutzt, NIE zur Energie addiert.
    - Extern = nur TeslaMate-Ladungen an Fremd-Adressen (z.B. Supercharger Engen).
    Mehrere Ladestationen pro Tag bleiben in der Aufklapp-Liste sichtbar.
    """
    from collections import defaultdict
    days = defaultdict(lambda: {"evcc": [], "tm_home": [], "tm_ext": []})

    # EVCC (immer Zuhause, fuehrend) -> nach STARTTAG buchen
    # Zusaetzlich Zeitfenster [created, finished] merken, um TM-Teilladungen
    # (die ueber Mitternacht in andere Kalendertage rutschen) derselben
    # EVCC-Sitzung / demselben Starttag zuzuordnen.
    evcc_windows = []  # (start_dt, end_dt, day)
    for r in rows.get("home", []):
        day = (r.get("created") or "")[:10]
        days[day]["evcc"].append(r)
        try:
            sdt = datetime.fromisoformat(r.get("created"))
            edt = datetime.fromisoformat(r.get("finished")) if r.get("finished") else sdt
            evcc_windows.append((sdt, edt, day))
        except Exception:
            pass
    evcc_windows.sort(key=lambda w: w[0])

    def _assign_day(charge_start_iso):
        """Ordnet eine TM-Ladung dem EVCC-Sitzungstag zu (Fenster enthaelt Start).
        Faellt zurueck auf den eigenen Kalendertag, wenn kein EVCC-Fenster passt."""
        try:
            cdt = datetime.fromisoformat(charge_start_iso)
        except Exception:
            return (charge_start_iso or "")[:10]
        for sdt, edt, day in evcc_windows:
            if sdt <= cdt <= edt:
                return day
        return (charge_start_iso or "")[:10]

    # TeslaMate: nach Zuhause vs. Extern trennen
    ext_rows, home_rows = [], []
    for r in rows.get("external", []):
        if _is_home_address(r.get("location_name"), r.get("address")):
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
        day = (g["start"] or "")[:10]
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
        if ev_kwh > 0 and tmh_added > 0:
            coverage = tmh_added / ev_kwh
            loss = ev_kwh - tmh_added
            loss_pct = loss / ev_kwh
            if coverage >= 0.70 and 0 <= loss_pct <= 0.30:
                home_loss = round(loss, 2)

        # --- Extern: nur echte Fremdladungen ---
        ext_kwh = sum(t["added"] for t in v["tm_ext"])
        ext_used = sum(t["used"] for t in v["tm_ext"])
        ext_cost = sum(t["cost"] for t in v["tm_ext"])
        ext_loss = round(ext_used - ext_kwh, 2) if (ext_kwh and ext_used) else 0.0

        # Ladestationen des Tages (fuer "mehrere Stationen sichtbar")
        stations = []
        if v["evcc"]:
            stations.append("Garage (EVCC)")
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
    sess = api_sessions().get_json()
    return jsonify(_build_merged(sess))


@app.route("/api/charts")
def api_charts():
    """Statistik-Ansicht (Road-Trip-App-Stil): 4 Zeitreihen + KPIs.
    1) Verbrauch kWh/100km  2) €/kWh  3) €/100km  4) kumulierte km
    Plus Sekundaer-KPIs: geladene kWh, Reichweite, Ladeverluste, AC/DC, CO2.
    """
    db = get_db()
    evcc = [dict(r) for r in db.execute(
        "SELECT created, finished, charged_kwh, total_cost, odometer, price_per_kwh, "
        "solar_percentage, loadpoint, raw FROM home_sessions ORDER BY created ASC")]

    def _evcc_co2(raw):
        try:
            j = json.loads(raw) if isinstance(raw, str) else raw
            return float(j.get("co2PerKWh") or 0)
        except Exception:
            return 0.0
    tm = [dict(r) for r in db.execute(
        "SELECT started_at, energy_kwh, energy_used_kwh, cost_total, odometer_start, "
        "latitude, longitude, address, raw FROM external_sessions ORDER BY started_at ASC")]

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
        # (Supercharger=DC, andere Fremd=AC). TM-Zuhause (Dammstraße/Garage)
        # ist dieselbe Ladung wie EVCC -> NICHT nochmal zaehlen (Doppelzaehlung).
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
    total_km = round(cum_km, 1)
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
        km = b["odometer"] - a["odometer"]
        cons = round(used_energy / (km / 100.0), 2) if (km > 0 and used_energy >= 0) else None
        soc_intervals.append({
            "day": b["day"], "date": b["created"], "dsoc": round(dsoc, 1),
            "used_kwh": round(used_energy, 2), "km": round(km, 1),
            "consumption": cons,  # kWh/100km ueber Intervall
        })

    return jsonify({
        "series": series,
        "soc_intervals": soc_intervals,
        "est_capacity": round(est_cap, 1),
        "kpis": {
            "total_kwh": total_kwh, "total_cost": total_cost, "total_km": total_km,
            "avg_consumption": avg_consumption, "avg_cost_100": avg_cost_100,
            "avg_price_kwh": avg_price_kwh, "avg_co2": avg_co2,
            "ac_kwh": total_ac, "dc_kwh": total_dc,
            "dc_share_pct": round(total_dc / total_kwh * 100, 1) if total_kwh > 0 else 0,
            "last_range": last_range,
        },
    })


@app.route("/api/roadtrip")
def api_roadtrip():
    """Roadtrip-/Reise-Ansicht (iOS Roadtrip-App-Stil): Tageswerte km/kWh/€/Station + Kennzahlen + Ladestopps (lat/lng)."""
    db = get_db()
    evcc = [dict(r) for r in db.execute(
        "SELECT created, finished, charged_kwh, total_cost, odometer, solar_percentage, loadpoint "
        "FROM home_sessions ORDER BY created ASC")]
    tm = [dict(r) for r in db.execute(
        "SELECT started_at, finished_at, energy_kwh, energy_used_kwh, cost_total, odometer_start, "
        "latitude, longitude, address FROM external_sessions ORDER BY started_at ASC")]

    from collections import defaultdict
    day_kwh = defaultdict(float)
    day_cost = defaultdict(float)
    day_stations = defaultdict(set)
    day_pins = defaultdict(list)

    for e in evcc:
        day = (e.get("created") or "")[:10]
        day_kwh[day] += float(e.get("charged_kwh") or 0)
        day_cost[day] += float(e.get("total_cost") or 0)
        day_stations[day].add("Garage (EVCC)")

    for t in tm:
        day = (t.get("started_at") or "")[:10]
        addr = t.get("address") or "?"
        day_stations[day].add(addr)
        lat = t.get("latitude")
        lng = t.get("longitude")
        if lat is not None and lng is not None:
            day_pins[day].append({
                "lat": lat, "lng": lng, "address": addr,
                "kwh": round(float(t.get("energy_kwh") or 0), 2),
                "cost": round(float(t.get("cost_total") or 0), 2),
            })

    # km ueber odometer: Tages-Diff (max odometer pro Tag - VorTag)
    odo_points = []
    for e in evcc:
        try:
            odo_points.append(((e.get("created") or "")[:10], float(e.get("odometer") or 0)))
        except Exception:
            pass
    for t in tm:
        try:
            odo_points.append(((t.get("started_at") or "")[:10], float(t.get("odometer_start") or 0)))
        except Exception:
            pass
    day_odo = defaultdict(float)
    for day, o in odo_points:
        day_odo[day] = max(day_odo[day], o)
    days_sorted = sorted(day_odo.keys())
    day_km = {}
    prev = 0.0
    for d in days_sorted:
        o = day_odo[d]
        day_km[d] = round(o - prev, 1) if prev > 0 else 0.0
        prev = o

    per_day = []
    for day in days_sorted:
        per_day.append({
            "day": day,
            "km": day_km.get(day, 0),
            "kwh": round(day_kwh.get(day, 0), 2),
            "cost": round(day_cost.get(day, 0), 2),
            "stations": sorted(day_stations.get(day, [])),
            "pins": day_pins.get(day, []),
        })
    per_day.sort(key=lambda x: x["day"], reverse=True)

    total_km = round(sum(day_km.values()), 1)
    total_kwh = round(sum(day_kwh.values()), 2)
    total_cost = round(sum(day_cost.values()), 2)
    avg_consumption = round(total_kwh / (total_km / 100.0), 2) if total_km > 0 else 0
    avg_cost_100 = round(total_cost / (total_km / 100.0), 2) if total_km > 0 else 0

    stops = []
    for day, pins in day_pins.items():
        for p in pins:
            stops.append({**p, "day": day})

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


@app.route("/api/external/<int:sid>", methods=["PUT", "DELETE"])
def api_external_detail(sid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM external_sessions WHERE id = ?", (sid,))
        db.commit()
        return jsonify({"ok": True})

    d = request.get_json(force=True)
    allowed = ("location_name", "address", "provider", "started_at", "finished_at",
               "energy_kwh", "odometer_start", "cost_total")
    fields = {k: d[k] for k in allowed if k in d}
    if not fields:
        return jsonify({"ok": False, "error": "keine Felder"}), 400

    # Bei Kosten-/Energie-Aenderung €/kWh neu ableiten
    if "cost_total" in fields or "energy_kwh" in fields:
        cur = db.execute(
            "SELECT energy_kwh, cost_total FROM external_sessions WHERE id = ?", (sid,)
        ).fetchone()
        if not cur:
            return jsonify({"ok": False, "error": "not found"}), 404
        energy = float(fields.get("energy_kwh", cur["energy_kwh"]) or 0)
        cost = float(fields.get("cost_total", cur["cost_total"]) or 0)
        fields["price_per_kwh"] = round(cost / energy, 4) if energy > 0 else 0.0

    set_parts = [f"{k} = ?" for k in fields]
    # Nur bei expliziter Kostenaenderung als manuell markieren
    if "cost_total" in fields:
        set_parts.append("manual_price = 1")
    db.execute(
        f"UPDATE external_sessions SET {', '.join(set_parts)} WHERE id = ?",
        list(fields.values()) + [sid],
    )
    db.commit()
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
