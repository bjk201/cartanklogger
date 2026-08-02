from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logging
import os

from app.config import settings
from app.database import init_db, engine
from app.api import overview, sessions

# Logging setup
logging.basicConfig(
    level=logging.INFO if not settings.DEBUG else logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting CarTankLogger 2.0 Backend...")
    logger.info(f"Database URL: {settings.DATABASE_URL}")
    
    # Initialize database tables
    try:
        init_db()
        logger.info("Database initialized successfully")
    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
        raise
    
    yield
    
    # Shutdown
    logger.info("Shutting down CarTankLogger 2.0 Backend...")
    engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    description="EV Charging Cost Tracker - FastAPI Backend",
    version="2.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# CORS Configuration
allowed_origins = [origin.strip() for origin in settings.ALLOWED_ORIGINS.split(",") if origin.strip()]
logger.info(f"CORS allowed origins: {allowed_origins}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,  # No cookie auth in MVP
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Include routers
app.include_router(overview.router, prefix=settings.API_PREFIX)
app.include_router(sessions.router, prefix=settings.API_PREFIX)


@app.get("/health", tags=["Health"])
def health_check():
    """Health check endpoint."""
    return {
        "ok": True,
        "service": "cartanklogger-backend",
        "version": "2.0.0",
        "database": "connected"
    }


@app.get("/", tags=["Root"])
def root():
    return {
        "service": "CarTankLogger 2.0",
        "version": "2.0.0",
        "docs": "/docs",
        "health": "/health",
        "api": settings.API_PREFIX
    }