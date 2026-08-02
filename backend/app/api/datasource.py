from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional
import httpx

from app.database import get_db
from app.models.datasource import DataSourceConfig
from app.schemas.datasource import (
    DataSourceConfigRead,
    DataSourceConfigWrite,
    DataSourceConfigTestRequest,
    DataSourceConfigTestResponse,
    ReachabilityStatus,
    EVCCConfig,
    TeslaMateAPIConfig,
)
from app.config import settings as app_settings


router = APIRouter(prefix="/settings/data-sources", tags=["Data Sources"])


def get_or_create_config(db: Session) -> DataSourceConfig:
    """Get the singleton config row or create it."""
    config = db.query(DataSourceConfig).first()
    if not config:
        config = DataSourceConfig()
        db.add(config)
        db.commit()
        db.refresh(config)
    return config


@router.get("", response_model=DataSourceConfigRead)
def get_data_source_config(db: Session = Depends(get_db)):
    """Get current data source configuration."""
    config = get_or_create_config(db)
    
    return DataSourceConfigRead(
        evcc_host=config.evcc_host or "",
        evcc_port=config.evcc_port or 7070,
        evcc_password="",  # Never return password
        evcc_api_token=config.evcc_api_token or "",
        evcc_use_tls=config.evcc_use_tls or False,
        teslamateapi_base_url=config.teslamateapi_base_url or "",
        teslamateapi_token="",  # Never return token
        evcc_configured=bool(config.evcc_host),
        teslamateapi_configured=bool(config.teslamateapi_base_url),
        data_source="live" if (config.evcc_host and config.teslamateapi_base_url) else "demo",
    )


@router.post("", response_model=DataSourceConfigRead, status_code=status.HTTP_200_OK)
def save_data_source_config(payload: DataSourceConfigWrite, db: Session = Depends(get_db)):
    """Save data source configuration."""
    config = get_or_create_config(db)
    
    # Update EVCC fields
    config.evcc_host = payload.host.strip() if payload.host else ""
    config.evcc_port = payload.port if payload.port else 7070
    if payload.password is not None:
        config.evcc_password = payload.password.strip()
    if payload.api_token is not None:
        config.evcc_api_token = payload.api_token.strip()
    config.evcc_use_tls = payload.use_tls
    
    # Update TeslaMateAPI fields
    config.teslamateapi_base_url = payload.base_url.strip() if payload.base_url else ""
    if payload.token is not None:
        config.teslamateapi_token = payload.token.strip()
    
    config.updated_by = "admin"
    
    db.commit()
    db.refresh(config)
    
    return DataSourceConfigRead(
        evcc_host=config.evcc_host or "",
        evcc_port=config.evcc_port or 7070,
        evcc_password="",
        evcc_api_token=config.evcc_api_token or "",
        evcc_use_tls=config.evcc_use_tls or False,
        teslamateapi_base_url=config.teslamateapi_base_url or "",
        teslamateapi_token="",
        evcc_configured=bool(config.evcc_host),
        teslamateapi_configured=bool(config.teslamateapi_base_url),
        data_source="live" if (config.evcc_host and config.teslamateapi_base_url) else "demo",
    )


async def _check_evcc_reachable(host: str, port: int, password: str, api_token: str, use_tls: bool) -> ReachabilityStatus:
    """Check EVCC reachability."""
    if not host:
        return ReachabilityStatus(configured=False, reachable=False, error="Nicht konfiguriert")
    
    protocol = "https" if use_tls else "http"
    base_url = f"{protocol}://{host}:{port}"
    
    headers = {}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"
    elif password:
        # EVCC basic auth would be different, but we'll try Bearer for token
        pass
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/api/state", headers=headers)
            if response.status_code == 200:
                return ReachabilityStatus(configured=True, reachable=True, status_code=response.status_code)
            else:
                return ReachabilityStatus(configured=True, reachable=False, status_code=response.status_code, error=f"HTTP {response.status_code}")
    except httpx.TimeoutException:
        return ReachabilityStatus(configured=True, reachable=False, error="Timeout")
    except httpx.ConnectError:
        return ReachabilityStatus(configured=True, reachable=False, error="Verbindungsfehler")
    except Exception as e:
        return ReachabilityStatus(configured=True, reachable=False, error=str(e))


async def _check_teslamateapi_reachable(base_url: str, token: str) -> ReachabilityStatus:
    """Check TeslaMateAPI reachability."""
    if not base_url:
        return ReachabilityStatus(configured=False, reachable=False, error="Nicht konfiguriert")
    
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/health", headers=headers)
            if response.status_code == 200:
                return ReachabilityStatus(configured=True, reachable=True, status_code=response.status_code)
            else:
                return ReachabilityStatus(configured=True, reachable=False, status_code=response.status_code, error=f"HTTP {response.status_code}")
    except httpx.TimeoutException:
        return ReachabilityStatus(configured=True, reachable=False, error="Timeout")
    except httpx.ConnectError:
        return ReachabilityStatus(configured=True, reachable=False, error="Verbindungsfehler")
    except Exception as e:
        return ReachabilityStatus(configured=True, reachable=False, error=str(e))


@router.post("/test", response_model=DataSourceConfigTestResponse)
async def test_data_source_connection(payload: DataSourceConfigTestRequest):
    """Test connection to a data source (EVCC or TeslaMateAPI)."""
    if payload.source == "evcc":
        status_result = await _check_evcc_reachable(
            host=payload.host or "",
            port=payload.port or 7070,
            password=payload.password or "",
            api_token=payload.api_token or "",
            use_tls=payload.use_tls or False,
        )
        return DataSourceConfigTestResponse(ok=True, source="evcc", status=status_result)
    
    elif payload.source == "teslamateapi":
        status_result = await _check_teslamateapi_reachable(
            base_url=payload.base_url or "",
            token=payload.token or "",
        )
        return DataSourceConfigTestResponse(ok=True, source="teslamateapi", status=status_result)
    
    else:
        raise HTTPException(status_code=400, detail="Unbekannte Quelle: 'evcc' oder 'teslamateapi'")