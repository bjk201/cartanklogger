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
# TeslaMate Client (GraphQL API)
# ---------------------------------------------------------------------------
class TeslaMateClient:
    QUERY_A = """
    query($limit: Int) {
      chargingSessions(limit: $limit) {
        id startDate endDate odometer chargeEnergyAdded
        address latitude longitude geofence cost durationMin
        startBatteryLevel endBatteryLevel
      }
    }"""
    QUERY_B = """
    query($limit: Int) {
      chargingSessions(limit: $limit) {
        id startDate endDate odometer energyAdded
        address latitude longitude geofence cost durationMin
      }
    }"""

    def __init__(self, url, token=""):
        self.url = url
        self.token = token

    def get_charging_sessions(self, limit=300):
        if mock_mode():
            return _mock_teslamate_sessions()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        for q in (self.QUERY_A, self.QUERY_B):
            try:
                r = requests.post(
                    self.url,
                    json={"query": q, "variables": {"limit": limit}},
                    headers=headers,
                    timeout=20,
                )
                if r.status_code == 200:
                    data = r.json()
                    if "errors" not in data:
                        return data.get("data", {}).get("chargingSessions", [])
                    app.logger.warning(f"TeslaMate GraphQL Fehler: {data.get('errors')}")
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
        cost = compute_home_cost(charged, solar, created)
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


def _detect_provider(geofence, address):
    text = f"{geofence or ''} {address or ''}".lower()
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
        sid = s.get("id")
        if sid is None:
            continue
        started = _parse_dt(s.get("startDate")) or datetime.now()
        finished = _parse_dt(s.get("endDate"))
        energy = float(s.get("chargeEnergyAdded") or s.get("energyAdded") or 0)
        if energy <= 0:
            continue
        provider = _detect_provider(s.get("geofence"), s.get("address"))
        tm_cost = s.get("cost")
        cost_total = float(tm_cost) if tm_cost not in (None, "") else 0.0
        ppk = (cost_total / energy) if (cost_total and energy) else 0.0
        try:
            cur = db.execute(
                """INSERT OR IGNORE INTO external_sessions
                   (teslamate_session_id, started_at, finished_at, location_name, address,
                    latitude, longitude, provider, energy_kwh, odometer_start,
                    cost_total, price_per_kwh, manual_price, imported_at, raw)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid, started.isoformat(),
                    finished.isoformat() if finished else None,
                    s.get("geofence") or "", s.get("address") or "",
                    s.get("latitude"), s.get("longitude"), provider,
                    energy, s.get("odometer"),
                    cost_total, round(ppk, 4), 0, now, json.dumps(s, default=str),
                ),
            )
            inserted += cur.rowcount
        except sqlite3.IntegrityError:
            pass
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
    ext = db.execute(
        "SELECT * FROM external_sessions WHERE started_at >= ? ORDER BY started_at ASC",
        (cutoff,),
    ).fetchall()
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
                    if k in config.get(section, {}):
                        # leere Passwörter/Tokens nicht überschreiben (sonst würden sie gelöscht)
                        if k in ("password", "api_token") and (v == "" or v is None):
                            continue
                        config[section][k] = v
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


@app.route("/api/external/<int:sid>/price", methods=["PUT"])
def api_external_price(sid):
    db = get_db()
    d = request.get_json(force=True)
    cost = float(d.get("cost_total", 0))
    energy = db.execute(
        "SELECT energy_kwh FROM external_sessions WHERE id = ?", (sid,)
    ).fetchone()
    if not energy:
        return jsonify({"ok": False, "error": "not found"}), 404
    ppk = (cost / energy["energy_kwh"]) if energy["energy_kwh"] else 0
    db.execute(
        "UPDATE external_sessions SET cost_total = ?, price_per_kwh = ?, manual_price = 1 WHERE id = ?",
        (cost, round(ppk, 4), sid),
    )
    db.commit()
    return jsonify({"ok": True, "cost_total": cost, "price_per_kwh": round(ppk, 4)})


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
