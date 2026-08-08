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
    ReachabilityLevel,
)


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
        evcc_base_url=config.evcc_base_url or "",
        evcc_api_token=config.evcc_api_token or "",
        teslamateapi_base_url=config.teslamateapi_base_url or "",
        teslamateapi_token="",  # Never return token
        evcc_configured=bool(config.evcc_base_url),
        teslamateapi_configured=bool(config.teslamateapi_base_url),
        data_source="live" if (config.evcc_base_url and config.teslamateapi_base_url) else "demo",
    )


@router.post("", response_model=DataSourceConfigRead, status_code=status.HTTP_200_OK)
def save_data_source_config(payload: DataSourceConfigWrite, db: Session = Depends(get_db)):
    """Save data source configuration."""
    config = get_or_create_config(db)

    # Update EVCC fields
    if payload.evcc_base_url is not None:
        config.evcc_base_url = payload.evcc_base_url.strip()
    if payload.evcc_api_token is not None:
        config.evcc_api_token = payload.evcc_api_token.strip() or ""

    # Update TeslaMateAPI fields
    if payload.teslamateapi_base_url is not None:
        config.teslamateapi_base_url = payload.teslamateapi_base_url.strip()
    if payload.teslamateapi_token is not None:
        config.teslamateapi_token = payload.teslamateapi_token.strip() or ""

    config.updated_by = "admin"

    db.commit()
    db.refresh(config)

    return DataSourceConfigRead(
        evcc_base_url=config.evcc_base_url or "",
        evcc_api_token=config.evcc_api_token or "",
        teslamateapi_base_url=config.teslamateapi_base_url or "",
        teslamateapi_token="",
        evcc_configured=bool(config.evcc_base_url),
        teslamateapi_configured=bool(config.teslamateapi_base_url),
        data_source="live" if (config.evcc_base_url and config.teslamateapi_base_url) else "demo",
    )


async def _check_evcc_reachable(base_url: str, api_token: str) -> ReachabilityStatus:
    """Check EVCC reachability."""
    if not base_url:
        return ReachabilityStatus(configured=False, reachable=False, error="Nicht konfiguriert")

    headers = {}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url.rstrip('/')}/api/state", headers=headers)
            if response.status_code == 200:
                return ReachabilityStatus(configured=True, reachable=True, level=ReachabilityLevel.REACHABLE, status_code=response.status_code)
            else:
                return ReachabilityStatus(configured=True, reachable=False, level=ReachabilityLevel.UNREACHABLE, status_code=response.status_code, error=f"HTTP {response.status_code}")
    except httpx.TimeoutException:
        return ReachabilityStatus(configured=True, reachable=False, error="Timeout")
    except httpx.ConnectError:
        return ReachabilityStatus(configured=True, reachable=False, error="Verbindungsfehler")
    except Exception as e:
        return ReachabilityStatus(configured=True, reachable=False, error=str(e))


async def _check_teslamateapi_reachable(base_url: str, token: str) -> ReachabilityStatus:
    """Check TeslaMateAPI reachability - verifies both base URL and cars endpoint."""
    if not base_url:
        return ReachabilityStatus(configured=False, reachable=False, level=ReachabilityLevel.UNREACHABLE, error="Nicht konfiguriert")

    # Ensure trailing slash for TeslaMateAPI
    base_url_clean = base_url.rstrip("/") + "/"

    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Check base URL
            response = await client.get(base_url_clean, headers=headers)
            if response.status_code != 200:
                return ReachabilityStatus(configured=True, reachable=False, level=ReachabilityLevel.UNREACHABLE, status_code=response.status_code, error=f"Base URL HTTP {response.status_code}")

            # Also verify the cars endpoint exists (correct endpoint for this API)
            response = await client.get(f"{base_url_clean}cars", headers=headers)
            if response.status_code == 200:
                return ReachabilityStatus(configured=True, reachable=True, level=ReachabilityLevel.REACHABLE, status_code=response.status_code)
            else:
                return ReachabilityStatus(configured=True, reachable=True, level=ReachabilityLevel.DATA_FETCH_ERROR, status_code=response.status_code, data_error=f"Cars endpoint HTTP {response.status_code}")
    except httpx.TimeoutException:
        return ReachabilityStatus(configured=True, reachable=False, level=ReachabilityLevel.UNREACHABLE, error="Timeout")
    except httpx.ConnectError:
        return ReachabilityStatus(configured=True, reachable=False, level=ReachabilityLevel.UNREACHABLE, error="Verbindungsfehler")
    except Exception as e:
        return ReachabilityStatus(configured=True, reachable=False, level=ReachabilityLevel.UNREACHABLE, error=str(e))


@router.post("/test", response_model=DataSourceConfigTestResponse)
async def test_data_source_connection(payload: DataSourceConfigTestRequest):
    """Test connection to a data source (EVCC or TeslaMateAPI)."""
    if payload.source == "evcc":
        if not payload.evcc_base_url:
            return DataSourceConfigTestResponse(
                ok=False,
                source="evcc",
                status=ReachabilityStatus(
                    configured=False,
                    reachable=False,
                    level=ReachabilityLevel.UNREACHABLE,
                    error="EVCC Base URL ist erforderlich"
                )
            )

        status_result = await _check_evcc_reachable(
            base_url=payload.evcc_base_url,
            api_token=payload.evcc_api_token or "",
        )
        return DataSourceConfigTestResponse(ok=True, source="evcc", status=status_result)

    elif payload.source == "teslamateapi":
        if not payload.teslamateapi_base_url:
            return DataSourceConfigTestResponse(
                ok=False,
                source="teslamateapi",
                status=ReachabilityStatus(
                    configured=False,
                    reachable=False,
                    level=ReachabilityLevel.UNREACHABLE,
                    error="TeslaMateAPI Base URL ist erforderlich"
                )
            )

        status_result = await _check_teslamateapi_reachable(
            base_url=payload.teslamateapi_base_url,
            token=payload.teslamateapi_token or "",
        )
        return DataSourceConfigTestResponse(ok=True, source="teslamateapi", status=status_result)

    else:
        raise HTTPException(status_code=400, detail="Unbekannte Quelle: 'evcc' oder 'teslamateapi' erforderlich")


@router.post("/sync", response_model=dict)
async def sync_data_sources(db: Session = Depends(get_db)):
    """Trigger full sync of all configured data sources (EVCC + TM)."""
    from app.services.sync_service import run_full_sync
    result = await run_full_sync(db)
    return {
        "ok": True,
        "result": result
    }