from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logging
import os
import httpx

from app.config import settings
from app.database import init_db, engine
from app.api import overview, sessions, statistics

# Logging setup
logging.basicConfig(
    level=logging.INFO if not settings.DEBUG else logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# Data source mode derived from settings
def get_data_source_info() -> dict:
    """Determine data source mode and reachability."""
    evcc_configured = settings.EVCC_CONFIGURED
    teslamateapi_configured = settings.TESLAMATEAPI_CONFIGURED
    
    # If both are configured, we're in live mode
    is_live = evcc_configured and teslamateapi_configured
    
    if is_live:
        data_source = "live"
        description = "Live-Modus: EVCC und TeslaMateAPI konfiguriert"
    else:
        data_source = "demo"
        description = "Demo/Fallback-Modus: Seed-Daten (EVCC/TeslaMateAPI nicht oder unvollständig konfiguriert)"
    
    return {
        "data_source": data_source,
        "data_source_description": description,
        "evcc_configured": evcc_configured,
        "teslamateapi_configured": teslamateapi_configured,
        "is_live": is_live,
    }


async def check_evcc_reachable() -> dict:
    """Check if EVCC API is reachable."""
    if not settings.EVCC_CONFIGURED:
        return {"configured": False, "reachable": False, "error": "Nicht konfiguriert"}
    
    base_url = settings.EVCC_BASE_URL
    if not base_url:
        return {"configured": True, "reachable": False, "error": "Keine Base URL"}
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # EVCC health endpoint
            response = await client.get(f"{base_url}/api/state", headers={})
            if response.status_code == 200:
                return {"configured": True, "reachable": True, "status_code": response.status_code}
            else:
                return {"configured": True, "reachable": False, "status_code": response.status_code, "error": f"HTTP {response.status_code}"}
    except httpx.TimeoutException:
        return {"configured": True, "reachable": False, "error": "Timeout"}
    except httpx.ConnectError:
        return {"configured": True, "reachable": False, "error": "Verbindungsfehler"}
    except Exception as e:
        return {"configured": True, "reachable": False, "error": str(e)}


async def check_teslamateapi_reachable() -> dict:
    """Check if TeslaMateAPI is reachable."""
    if not settings.TESLAMATEAPI_CONFIGURED:
        return {"configured": False, "reachable": False, "error": "Nicht konfiguriert"}
    
    base_url = settings.TESLAMATEAPI_BASE_URL
    if not base_url:
        return {"configured": True, "reachable": False, "error": "Keine Base URL"}
    
    headers = {}
    if settings.TESLAMATEAPI_TOKEN:
        headers["Authorization"] = f"Bearer {settings.TESLAMATEAPI_TOKEN}"
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # TeslaMateAPI health check - use /health or /api/v1/vehicles
            response = await client.get(f"{base_url}/health", headers=headers)
            if response.status_code == 200:
                return {"configured": True, "reachable": True, "status_code": response.status_code}
            else:
                return {"configured": True, "reachable": False, "status_code": response.status_code, "error": f"HTTP {response.status_code}"}
    except httpx.TimeoutException:
        return {"configured": True, "reachable": False, "error": "Timeout"}
    except httpx.ConnectError:
        return {"configured": True, "reachable": False, "error": "Verbindungsfehler"}
    except Exception as e:
        return {"configured": True, "reachable": False, "error": str(e)}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting CarTankLogger 2.0 Backend...")
    logger.info(f"Database URL: {settings.DATABASE_URL}")
    
    data_source_info = get_data_source_info()
    logger.info(f"Data source: {data_source_info['data_source']} - {data_source_info['data_source_description']}")
    logger.info(f"EVCC configured: {data_source_info['evcc_configured']}")
    logger.info(f"TeslaMateAPI configured: {data_source_info['teslamateapi_configured']}")
    
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
app.include_router(statistics.router, prefix=settings.API_PREFIX)


@app.get("/health", tags=["Health"])
def health_check():
    """Health check endpoint with data source info."""
    info = get_data_source_info()
    return {
        "ok": True,
        "service": "cartanklogger-backend",
        "version": "2.0.0",
        "database": "connected",
        "data_source": info["data_source"],
        "data_source_description": info["data_source_description"],
        "evcc_configured": info["evcc_configured"],
        "teslamateapi_configured": info["teslamateapi_configured"],
    }


@app.get("/api/status", tags=["Status"])
async def data_source_status():
    """Data source status endpoint for frontend with reachability checks."""
    info = get_data_source_info()
    evcc_status = await check_evcc_reachable()
    teslamateapi_status = await check_teslamateapi_reachable()
    
    # Determine overall message
    if info["is_live"]:
        if evcc_status["reachable"] and teslamateapi_status["reachable"]:
            message = "Live-Modus aktiv: EVCC und TeslaMateAPI erreichbar"
        elif evcc_status["reachable"] and not teslamateapi_status["reachable"]:
            message = "Live-Modus: EVCC erreichbar, TeslaMateAPI nicht erreichbar"
        elif not evcc_status["reachable"] and teslamateapi_status["reachable"]:
            message = "Live-Modus: TeslaMateAPI erreichbar, EVCC nicht erreichbar"
        else:
            message = "Live-Modus konfiguriert, aber keine Quelle erreichbar"
    else:
        missing = []
        if not info["evcc_configured"]:
            missing.append("EVCC")
        if not info["teslamateapi_configured"]:
            missing.append("TeslaMateAPI")
        message = f"Demo-Modus: {', '.join(missing)} nicht konfiguriert"
    
    return {
        "ok": True,
        "data_source": info["data_source"],
        "data_source_description": info["data_source_description"],
        "message": message,
        "evcc": evcc_status,
        "teslamateapi": teslamateapi_status,
    }


@app.get("/", tags=["Root"])
def root():
    info = get_data_source_info()
    return {
        "service": "CarTankLogger 2.0",
        "version": "2.0.0",
        "docs": "/docs",
        "health": "/health",
        "api": settings.API_PREFIX,
        "data_source": info["data_source"],
    }