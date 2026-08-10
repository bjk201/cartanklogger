"""
Unmatched TM Charges API Endpoint
===================================
LIVE data from TeslaMateAPI — shows only "Zuhause" charges
that aren't matched to any EVCC session.
"""

from fastapi import APIRouter, Query, Depends
from typing import Optional
from sqlalchemy.orm import Session
from app.database import get_db

router = APIRouter(prefix="/matching", tags=["Matching"])


@router.get("/unmatched")
async def get_unmatched_charges(
    days: Optional[int] = Query(36500, description="Number of days to look back"),
    db: Session = Depends(get_db)
):
    """Get unmatched 'Zuhause' TM charges (LIVE from TM API, not DB import)."""
    from app.models.datasource import DataSourceConfig
    from app.services.teslamateapi_client import create_teslamateapi_client_from_config
    from app.services.live_matching import LiveMatchingService
    from datetime import datetime, timezone, timedelta

    config = db.query(DataSourceConfig).first()
    if not config or not config.teslamateapi_base_url:
        return {"ok": False, "error": "TeslaMateAPI not configured", "charges": []}

    tm_client = await create_teslamateapi_client_from_config(config)
    if not tm_client:
        return {"ok": False, "error": "Could not connect to TeslaMateAPI", "charges": []}

    # 1. Get ALL TM charges from live API
    tm_charges = await tm_client.get_charges()

    # Filter by date range
    if days and days < 36500:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        tm_charges = [c for c in tm_charges if c.start_date and c.start_date >= cutoff]

    # 2. Get all EVCC sessions from the DB (home sessions)
    from app.models.session import SessionModel
    from sqlalchemy import func
    evcc_query = db.query(SessionModel).filter(SessionModel.source_type == 'home')
    if days and days < 36500:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        evcc_query = evcc_query.filter(SessionModel.date >= cutoff)
    evcc_sessions = evcc_query.all()

    # 3. Filter to "Zuhause" TM charges only
    home_charges = [c for c in tm_charges if c.location and "zuhause" in c.location.lower()]

    # 4. Build unmatched list by checking date overlap with EVCC sessions
    unmatched = []
    for tm in home_charges:
        is_matched = False
        if tm.start_date:
            for evcc in evcc_sessions:
                if evcc.date:
                    tm_date = tm.start_date.date() if hasattr(tm.start_date, 'date') else tm.start_date
                    evcc_date = evcc.date.date() if hasattr(evcc.date, 'date') else evcc.date
                    if tm_date == evcc_date:
                        is_matched = True
                        break
        if not is_matched:
            unmatched.append({
                "charge_id": tm.id,
                "date": tm.start_date.isoformat() if tm.start_date else None,
                "location": tm.location,
                "energy_added": tm.charge_energy_added,
                "energy_used": tm.charge_energy_used,
                "cost": tm.cost,
                "odometer": tm.odometer,
            })

    return {
        "ok": True,
        "total_tm_charges": len(tm_charges),
        "home_charges": len(home_charges),
        "unmatched_count": len(unmatched),
        "charges": unmatched,
    }