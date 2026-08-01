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


def init_db() -> None:
    """Initialisiert die Datenbank-Tabellen."""
    from app.models import session as session_model  # noqa: F401
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created/verified")


def get_db():
    """Dependency für FastAPI - Datenbank-Session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()