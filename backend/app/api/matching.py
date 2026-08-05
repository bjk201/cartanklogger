"""
Matching API Endpoints
=====================

Dry-run endpoints for EVCC ↔ TeslaMateAPI matching.
- /dry-run: Legacy DB-based matching (kept for reference)
- /dry-run/live: Live API matching (REQUIRED for production)
"""

from fastapi import APIRouter, Query, Depends
from typing import Optional
from sqlalchemy.orm import Session
from datetime import datetime, timezone

from app.services.matching import run_matching_dry_run
from app.services.live_matching import run_live_matching_dry_run
from app.database import get_db


router = APIRouter(prefix="/matching", tags=["Matching"])


@router.get("/dry-run")
async def matching_dry_run(
    limit: Optional[int] = Query(None, ge=1, le=500, description="Limit number of EVCC sessions to check"),
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
):
    """
    Legacy DB-based matching dry-run.
    Uses imported database data (may be stale).
    
    For production use /dry-run/live instead.
    Returns empty result if EVCC/TM not configured.
    """
    from app.models.datasource import DataSourceConfig
    
    # If not in live mode (no EVCC/TM config), return empty results
    config = db.query(DataSourceConfig).first()
    if not config or not config.evcc_host or not config.teslamateapi_base_url:
        from app.services.matching import MatchingSummary
        return {
            'ok': True,
            'matches': [],
            'summary': {
                'total_evcc_sessions_checked': 0,
                'total_matched': 0,
                'total_unmatched': 0,
                'total_evcc_energy': 0.0,
                'total_tm_energy': 0.0,
                'total_delta_kwh': 0.0,
                'quality_distribution': {'exact': 0, 'plausible': 0, 'weak': 0, 'unmatched': 0},
                'total_tm_charges': 0,
                'accepted_candidates': 0,
                'rejected_wrong_location': 0
            },
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'data_source': 'database',
            'message': 'EVCC und/oder TeslaMateAPI nicht konfiguriert - Keine Demo-Daten'
        }
    
    from app.database import SessionLocal
    from app.services.matching import run_matching_dry_run
    db_local = SessionLocal()
    try:
        result = run_matching_dry_run(limit, days, from_date, to_date)
        result['data_source'] = 'database'
        return result
    finally:
        db_local.close()


@router.get("/dry-run/live")
async def matching_dry_run_live(
    limit: Optional[int] = Query(None, ge=1, le=500, description="Limit number of EVCC sessions to check"),
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
):
    """
    LIVE matching dry-run using EVCC API and TeslaMateAPI directly.
    
    REQUIRES both EVCC and TeslaMateAPI to be configured AND reachable.
    Returns error if live mode is not available.
    
    This is the production endpoint - no demo/seed data fallback.
    """
    result = await run_live_matching_dry_run(limit, days, from_date, to_date, db)
    return result


@router.get("/dry-run/status")
async def matching_live_status(db: Session = Depends(get_db)):
    """
    Check if live matching is available (both APIs configured and reachable).
    """
    from app.models.datasource import DataSourceConfig
    from app.services.evcc_client import create_evcc_client_from_config
    from app.services.teslamateapi_client import create_teslamateapi_client_from_config
    
    config = db.query(DataSourceConfig).first()
    
    if not config or not config.evcc_host or not config.teslamateapi_base_url:
        return {
            'ok': True,
            'live_available': False,
            'reason': 'EVCC und/oder TeslaMateAPI nicht in Einstellungen konfiguriert',
            'evcc_configured': bool(config and config.evcc_host),
            'teslamateapi_configured': bool(config and config.teslamateapi_base_url)
        }
    
    evcc_client = await create_evcc_client_from_config(config)
    teslamateapi_client = await create_teslamateapi_client_from_config(config)
    
    if not evcc_client or not teslamateapi_client:
        return {
            'ok': True,
            'live_available': False,
            'reason': 'Clients konnten nicht erstellt werden',
            'evcc_configured': bool(config.evcc_host),
            'teslamateapi_configured': bool(config.teslamateapi_base_url)
        }
    
    evcc_reachable = await evcc_client.is_reachable()
    teslamateapi_reachable = await teslamateapi_client.is_reachable()
    
    return {
        'ok': True,
        'live_available': evcc_reachable and teslamateapi_reachable,
        'reason': 'Beide APIs erreichbar' if (evcc_reachable and teslamateapi_reachable) else 
                  f'EVCC: {"erreichbar" if evcc_reachable else "NICHT erreichbar"}, TeslaMateAPI: {"erreichbar" if teslamateapi_reachable else "NICHT erreichbar"}',
        'evcc_configured': True,
        'teslamateapi_configured': True,
        'evcc_reachable': evcc_reachable,
        'teslamateapi_reachable': teslamateapi_reachable
    }