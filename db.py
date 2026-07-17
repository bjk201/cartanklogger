"""Datenbankinitialisierung + Migrationen."""
import os
import sqlite3
import hashlib
from flask import g
from datetime import datetime

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.yaml")
DB_PATH = os.environ.get("DB_PATH", "/app/data/cartanklogger.db")

# Hilfsfunktion für einen stabilen Secret-Schlüssel (aus app.py importiert)
def _resolve_secret_key(config=None):
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    if config:
        cfg_secret = (config.get("app") or {}).get("secret_key")
        if cfg_secret:
            return str(cfg_secret)
    # Stabiler Fallback: Hash ueber DB-Pfad (aendert sich nicht pro Restart).
    return hashlib.sha256(DB_PATH.encode("utf-8")).hexdigest()


def load_config_stub():
    """Minimaler Config-Fallback fuer db.py (ohne yaml-Abhaengigkeit).
    Die vollstaendige Config kommt aus app.py; hier nur, falls db.py
    eigenstaendig genutzt wird."""
    return {"app": {}}

# ----------------------------------------
# Migrationen: DB_COLUMNS hinzufügen
# ----------------------------------------
def _ensure_migrations(db):
    """Fügt Spalten hinzu, falls sie fehlen (Home/External/Extra/Costs-Periods)."""
    # home_sessions
    cols = [r[1] for r in db.execute('PRAGMA table_info(home_sessions)')]
    for col, typ, deflt in (
        ('odometer', 'REAL', '0'),
        ('vehicle', 'TEXT', "''"),
        ('loadpoint', 'TEXT', "''"),
        ('solar_percentage', 'REAL', '0'),
        ('created', 'TEXT', "''"),
        ('finished', 'TEXT', "''"),
        ('note', 'TEXT', "''"),
        ('source', 'TEXT', "'imported'"),
        ('manually_edited', 'INTEGER', '0'),
        ('updated_at', 'TEXT', 'created'),
    ):
        if col not in cols:
            db.execute(f'ALTER TABLE home_sessions ADD COLUMN {col} {typ}')
    # Setzen Sie Werte für fehlerhafte Zeilen wie in der ursprünglichen Migration
    db.execute('UPDATE home_sessions SET odometer = 0 WHERE odometer IS NULL')
    db.execute('UPDATE home_sessions SET vehicle = "" WHERE vehicle IS NULL')
    db.execute('UPDATE home_sessions SET loadpoint = "" WHERE loadpoint IS NULL')
    db.execute('UPDATE home_sessions SET solar_percentage = 0 WHERE solar_percentage IS NULL')
    db.execute('UPDATE home_sessions SET created = "" WHERE created IS NULL')
    db.execute('UPDATE home_sessions SET finished = "" WHERE finished IS NULL')
    db.execute('UPDATE home_sessions SET note = "" WHERE note IS NULL')
    db.execute("UPDATE home_sessions SET source = 'imported' WHERE source IS NULL OR source = ''")
    db.execute('UPDATE home_sessions SET manually_edited = 0 WHERE manually_edited IS NULL')
    db.execute('UPDATE home_sessions SET updated_at = created WHERE updated_at IS NULL OR updated_at = ""')

    # external_sessions
    cols = [r[1] for r in db.execute('PRAGMA table_info(external_sessions)')]
    for col, typ, deflt in (
        ('address', 'TEXT', "''"),
        ('provider', 'TEXT', "''"),
        ('started_at', 'TEXT', "''"),
        ('finished_at', 'TEXT', "''"),
        ('location_name', 'TEXT', "''"),
        ('manual_price', 'INTEGER', '0'),
        ('note', 'TEXT', "''"),
        ('source', 'TEXT', "'imported'"),
        ('manually_edited', 'INTEGER', '0'),
        ('updated_at', 'TEXT', 'started_at'),
    ):
        if col not in cols:
            db.execute(f'ALTER TABLE external_sessions ADD COLUMN {col} {typ}')
    db.execute('UPDATE external_sessions SET address = "" WHERE address IS NULL')
    db.execute('UPDATE external_sessions SET provider = "" WHERE provider IS NULL')
    db.execute('UPDATE external_sessions SET started_at = "" WHERE started_at IS NULL')
    db.execute('UPDATE external_sessions SET finished_at = "" WHERE finished_at IS NULL')
    db.execute('UPDATE external_sessions SET location_name = "" WHERE location_name IS NULL')
    db.execute('UPDATE external_sessions SET manual_price = 0 WHERE manual_price IS NULL')
    db.execute('UPDATE external_sessions SET note = "" WHERE note IS NULL')
    db.execute("UPDATE external_sessions SET source = 'imported' WHERE source IS NULL OR source = ''")
    db.execute('UPDATE external_sessions SET manually_edited = 0 WHERE manually_edited IS NULL')
    db.execute('UPDATE external_sessions SET updated_at = started_at WHERE updated_at IS NULL OR updated_at = ""')

    # extra_costs
    cols = [r[1] for r in db.execute('PRAGMA table_info(extra_costs)')]
    for col, typ, deflt in (
        ('category', 'TEXT', "'other'"),
        ('date', 'TEXT', "''"),
        ('description', 'TEXT', "''"),
        ('odometer', 'REAL', '0'),
        ('note', 'TEXT', "''"),
        ('source', 'TEXT', "'imported'"),
        ('manually_edited', 'INTEGER', '0'),
        ('updated_at', 'TEXT', 'date || "T00:00:00"'),
    ):
        if col not in cols:
            db.execute(f'ALTER TABLE extra_costs ADD COLUMN {col} {typ}')
    db.execute('UPDATE extra_costs SET category = "other" WHERE category IS NULL OR category = ""')
    db.execute('UPDATE extra_costs SET date = "" WHERE date IS NULL')
    db.execute('UPDATE extra_costs SET description = "" WHERE description IS NULL')
    db.execute('UPDATE extra_costs SET odometer = 0 WHERE odometer IS NULL')
    db.execute('UPDATE extra_costs SET note = "" WHERE note IS NULL')
    db.execute("UPDATE extra_costs SET source = 'imported' WHERE source IS NULL OR source = ''")
    db.execute('UPDATE extra_costs SET manually_edited = 0 WHERE manually_edited IS NULL')
    # updated_at auf date + T00:00:00 gesetzt, falls null oder leer

    # price_periods
    cols = [r[1] for r in db.execute('PRAGMA table_info(price_periods)')]
    for col, typ, deflt in (
        ('kind', 'TEXT', "'grid'"),
        ('valid_from', 'TEXT', "''"),
        ('valid_to', 'TEXT', "''"),
        ('note', 'TEXT', "''"),
        ('source', 'TEXT', "'imported'"),
        ('manually_edited', 'INTEGER', '0'),
        ('updated_at', 'TEXT', 'valid_from || "T00:00:00"'),
    ):
        if col not in cols:
            db.execute(f'ALTER TABLE price_periods ADD COLUMN {col} {typ}')
    db.execute('UPDATE price_periods SET kind = "grid" WHERE kind IS NULL OR kind = ""')
    db.execute('UPDATE price_periods SET valid_from = "" WHERE valid_from IS NULL')
    db.execute('UPDATE price_periods SET valid_to = "" WHERE valid_to IS NULL')
    db.execute('UPDATE price_periods SET note = "" WHERE note IS NULL')
    db.execute("UPDATE price_periods SET source = 'imported' WHERE source IS NULL OR source = ''")
    db.execute('UPDATE price_periods SET manually_edited = 0 WHERE manually_edited IS NULL')

    # Löschen Sie doppelte Spalten (falls vorhanden)
    dup_cols = ['manually_edited', 'source', 'updated_at']
    for tbl in ('home_sessions', 'external_sessions', 'extra_costs', 'price_periods'):
        existing = [r[1] for r in db.execute(f'PRAGMA table_info({tbl})')]
        for col in dup_cols:
            if existing.count(col) > 1:
                db.execute(f'ALTER TABLE {tbl} RENAME COLUMN {col} {col}_2')
                db.execute(f'ALTER TABLE {tbl} RENAME COLUMN {col}_2 TO {col}')


def get_db():
    """Gibt ein SQLite-DB-Objekt zurück, stellt Migrations-Sicherheiten bereit und initialisiert die DB."""
    db = getattr(g, '_db', None)
    if db is None:
        db = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys = ON')
        g._db = db
        _ensure_migrations(db)
        _init_tables(db)
    return db
def _init_tables(db):
    """Tabellenerstellung (nur beim ersten Start, falls nicht vorhanden)."""
    # home_sessions
    db.executescript('''
    CREATE TABLE IF NOT EXISTS home_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        charged_kwh REAL,
        created TEXT,
        finished TEXT,
        grid_cost REAL,
        grid_kwh REAL,
        loadpoint TEXT,
        note TEXT,
        odometer REAL,
        pv_cost REAL,
        pv_kwh REAL,
        price_per_kwh REAL,
        solar_percentage REAL,
        vehicle TEXT,
        total_cost REAL
    );''')
    # external_sessions
    db.executescript('''
    CREATE TABLE IF NOT EXISTS external_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT,
        cost_total REAL,
        energy_kwh REAL,
        finished_at TEXT,
        location_name TEXT,
        manual_price INTEGER,
        note TEXT,
        odometer_start REAL,
        price_per_kwh REAL,
        provider TEXT,
        started_at TEXT
    );''')
    # extra_costs
    db.executescript('''
    CREATE TABLE IF NOT EXISTS extra_costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL,
        category TEXT,
        date TEXT,
        description TEXT,
        odometer REAL,
        note TEXT
    );''')
    # price_periods
    db.executescript('''
    CREATE TABLE IF NOT EXISTS price_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT,
        price_per_kwh REAL,
        valid_from TEXT,
        valid_to TEXT
    );''')
    db.commit()

# zukünftige Hilfsfunktionen werden in services.py hinzugefügt
# -> exportieren Sie diese später:
__all__ = ['get_db', 'init_db']