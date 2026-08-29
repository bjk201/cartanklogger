from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import StaticPool
from app.config import settings
import logging

logger = logging.getLogger(__name__)

# SQLite-spezifische Konfiguration für Thread-Sicherheit
_is_sqlite = settings.DATABASE_URL.startswith("sqlite")
_is_memory = _is_sqlite and (":memory:" in settings.DATABASE_URL or "mode=memory" in settings.DATABASE_URL)

connect_args = {"check_same_thread": False} if _is_sqlite else {}

# StaticPool NUR für In-Memory-SQLite. Bei Datei-DBs würde StaticPool eine EINZIGE
# Connection an alle parallelen Requests verteilen → sqlite3.InterfaceError
# ("bad parameter or other API misuse") bei gleichzeitiger Nutzung.
poolclass = StaticPool if _is_memory else None

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=connect_args,
    poolclass=poolclass,
    echo=settings.DEBUG,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def _migrate_sessions_columns(conn) -> None:
    """Idempotente Migration: stellt sicher, dass die TM-spezifischen Spalten
    in der sessions-Tabelle existieren (create_all ändert bestehende Tabellen nicht)."""
    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    from sqlalchemy import text
    try:
        rows = conn.execute(text("PRAGMA table_info(sessions)")).fetchall()
        existing = {row[1] for row in rows}
        additions = {
            "charge_energy_added": "FLOAT",
            "charge_energy_used": "FLOAT",
            "duration_min": "INTEGER",
        }
        for col, coltype in additions.items():
            if col not in existing:
                conn.execute(text(f"ALTER TABLE sessions ADD COLUMN {col} {coltype}"))
                logger.info("Sessions-Tabelle: Spalte %s hinzugefügt", col)
    except Exception as e:  # pragma: no cover
        logger.warning("Sessions-Migration übersprungen: %s", e)


def _migrate_vehicle_columns(conn) -> None:
    """Idempotente Migration: tire_mounts-Tabelle + is_archived-Spalte.

    create_all() legt die tire_mounts-Tabelle neu an, ändert aber bestehende
    vehicle_records-Tabellen nicht → is_archived per ALTER TABLE sichern.
    Zusätzlich: Legacy-Reifenstatus (nur is_active) auf Mounts abbilden.
    """
    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    from sqlalchemy import text
    try:
        rows = conn.execute(text("PRAGMA table_info(vehicle_records)")).fetchall()
        existing = {row[1] for row in rows}
        if "is_archived" not in existing:
            conn.execute(text(
                "ALTER TABLE vehicle_records ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT 0"
            ))
            logger.info("vehicle_records: Spalte is_archived hinzugefügt")

        # Legacy-DatenÜbernahme: Für bestehende aktive Reifensätze ohne Mount-Historie
        # eine offene Montage anlegen (Start: start_odometer_km, sonst NULL).
        # HINWEIS: SQLAlchemy speichert SQLEnum als MEMBER-NAMEN ('TIRE'), nicht als
        # Wert ('tire') → name-agnostisch filtern.
        count = conn.execute(text("SELECT COUNT(*) FROM tire_mounts")).scalar() or 0
        if count == 0:
            conn.execute(text(
                """
                INSERT INTO tire_mounts (tire_record_id, mounted_at, demounted_at, km_on, km_off)
                SELECT id, date, NULL, start_odometer_km, NULL
                FROM vehicle_records
                WHERE UPPER(record_type) = 'TIRE' AND is_active = 1
                """
            ))
            logger.info("tire_mounts: Legacy-Montagen aus aktiven Reifensätzen erzeugt")
    except Exception as e:  # pragma: no cover
        logger.warning("Vehicle-Migration übersprungen: %s", e)


def init_db() -> None:
    """Initialisiert die Datenbank-Tabellen."""
    from app.models import session as session_model  # noqa: F401
    from app.models import matching_override  # noqa: F401
    from app.models import datasource  # noqa: F401
    from app.models import vehicle  # noqa: F401
    from app.models import extra_costs  # noqa: F401
    from app.models import tm_cost_export  # noqa: F401
    from app.models import tire_mount  # noqa: F401
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        _migrate_sessions_columns(conn)
        _migrate_vehicle_columns(conn)
    logger.info("Database tables created/verified")


def get_db():
    """Dependency für FastAPI - Datenbank-Session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()