from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import StaticPool
from app.config import settings
import logging

logger = logging.getLogger(__name__)

# SQLite-spezifische Konfiguration für Thread-Sicherheit
connect_args = {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}

# StaticPool für SQLite in Entwicklung/Testing
poolclass = StaticPool if settings.DATABASE_URL.startswith("sqlite") else None

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


def init_db() -> None:
    """Initialisiert die Datenbank-Tabellen."""
    from app.models import session as session_model  # noqa: F401
    from app.models import matching_override  # noqa: F401
    from app.models import datasource  # noqa: F401
    from app.models import vehicle  # noqa: F401
    from app.models import extra_costs  # noqa: F401
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        _migrate_sessions_columns(conn)
    logger.info("Database tables created/verified")


def get_db():
    """Dependency für FastAPI - Datenbank-Session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()