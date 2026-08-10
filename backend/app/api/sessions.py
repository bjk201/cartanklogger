from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional, List

from app.database import get_db
from app.repositories.session import SessionRepository
from app.schemas.overview import (
    PaginatedSessionsResponse,
    SessionRead,
    MetaInfo,
    ErrorDetail,
    PaginationInfo
)
from app.models.datasource import DataSourceConfig


router = APIRouter(prefix="/sessions", tags=["Sessions"])


def _get_configured_sources(db: Session) -> dict:
    """Check which data sources are configured."""
    config = db.query(DataSourceConfig).first()
    return {
        "evcc": bool(config and config.evcc_base_url),
        "teslamateapi": bool(config and config.teslamateapi_base_url),
    }


def _get_allowed_source_types(db: Session) -> List[str]:
    """Get list of source types that should be included based on configuration."""
    configured = _get_configured_sources(db)
    allowed = ["import"]  # Import is always allowed (manual data)
    if configured["evcc"]:
        allowed.append("home")
    if configured["teslamateapi"]:
        allowed.append("external")
    return allowed


@router.get(
    "",
    response_model=PaginatedSessionsResponse,
    summary="Get paginated charging sessions",
    description="Returns paginated sessions with filtering, sorting, and date range options."
)
def get_sessions(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(25, ge=1, le=100, description="Items per page"),
    source_type: Optional[str] = Query(None, description="Filter by source type: home, external, import, all"),
    search: Optional[str] = Query(None, description="Search in location and note"),
    sort_desc: bool = Query(True, description="Sort by date descending"),
    # Date range filters (same as overview)
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
) -> PaginatedSessionsResponse:
    # Get allowed source types based on configuration
    allowed_sources = _get_allowed_source_types(db)

    # If no EVCC and no TM configured, return empty
    if "home" not in allowed_sources and "external" not in allowed_sources:
        return PaginatedSessionsResponse(
            ok=True,
            data=[],
            meta=MetaInfo(count=0, limit=page_size),
            pagination=PaginationInfo(
                page=page,
                page_size=page_size,
                total=0,
                total_pages=0,
                has_next=False,
                has_prev=False,
            ),
            errors=[]
        )

    # Apply source_type filter in combination with allowed sources
    effective_source_type = source_type
    if source_type and source_type != "all":
        # User requested a specific source type - check if it's allowed
        if source_type not in allowed_sources:
            # Requested source type not configured - return empty
            return PaginatedSessionsResponse(
                ok=True,
                data=[],
                meta=MetaInfo(count=0, limit=page_size),
                pagination=PaginationInfo(
                    page=page,
                    page_size=page_size,
                    total=0,
                    total_pages=0,
                    has_next=False,
                    has_prev=False,
                ),
                errors=[]
            )

    repo = SessionRepository(db)

    # Default to 30 days if no range specified (same as overview)
    if not days and not from_date:
        days = 30

    # Get paginated sessions with date range filtering
    sessions, total = repo.get_sessions_paginated(
        page=page,
        page_size=page_size,
        source_type=effective_source_type,
        search=search,
        sort_desc=sort_desc,
        days=days,
        from_date=from_date,
        to_date=to_date,
        allowed_sources=allowed_sources,
    )

    # Map to response schema with PV/kWh and cost per kWh from TM charges
    # PV comes from TM charge_energy_added (external) or EVCC Home PV
    # cost_per_kwh = cost_eur / energy_kwh (from TM charges)
    data = []
    for s in sessions:
        # PV/kWh berechnen aus Session-Modell-Daten
        # pv_kwh ist bereits im Modell gespeichert (für EVCC Home-Sessions mit PV)
        # Für externe Sessions: pv_kwh = energy_kwh (da extern geladen)
        # cost_per_kwh = cost_eur / energy_kwh oder bereits gespeichert
        pv_kwh = None
        cost_per_kwh = None

        if s.pv_kwh is not None and s.pv_kwh > 0:
            # EVCC Home-Sessions haben bereits PV im Session-Modell
            pv_kwh = s.pv_kwh
        elif s.solar_percentage is not None and s.energy_kwh is not None and s.energy_kwh > 0:
            # PV aus Solar-Percentage berechnen
            pv_kwh = round(s.energy_kwh * s.solar_percentage / 100, 2)
        elif s.energy_kwh is not None and s.energy_kwh > 0:
            # Fallback: gesamter Energieverbrauch (für externe Sessions)
            pv_kwh = s.energy_kwh

        if s.cost_per_kwh is not None and s.cost_per_kwh > 0:
            # Bereits gespeicherte Kosten pro kWh
            cost_per_kwh = s.cost_per_kwh
        elif s.cost_eur is not None and s.energy_kwh is not None and s.energy_kwh > 0:
            # Kosten pro kWh aus Gesamtkosten / Gesamtenergie
            cost_per_kwh = round(s.cost_eur / s.energy_kwh, 2)

        data.append(SessionRead(
            id=s.id,
            source_type=s.source_type,
            source_id=s.source_id,
            date=s.date,
            location=s.location,
            energy_kwh=s.energy_kwh,
            cost_eur=s.cost_eur,
            odometer_km=s.odometer_km,
            distance_km=s.distance_km,
            note=s.note,
            solar_percentage=s.solar_percentage,
            pv_kwh=pv_kwh,
            cost_per_kwh=cost_per_kwh,
            cost_per_kwh_source=s.cost_per_kwh_source,
            # Charge type details from TeslaMate
            charge_type=s.charge_type,
            fast_charger_brand=s.fast_charger_brand,
            max_charge_power_kw=s.max_charge_power_kw,
        ))

    # Calculate pagination info
    total_pages = (total + page_size - 1) // page_size
    has_next = page < total_pages
    has_prev = page > 1

    return PaginatedSessionsResponse(
        ok=True,
        data=data,
        meta=MetaInfo(count=len(data), limit=page_size),
        pagination=PaginationInfo(
            page=page,
            page_size=page_size,
            total=total,
            total_pages=total_pages,
            has_next=has_next,
            has_prev=has_prev,
        ),
        errors=[]
    )


@router.get("/{session_id}/matches")
async def get_session_matches(
    session_id: int,
    db: Session = Depends(get_db)
):
    """
    Get TeslaMateAPI matches for a specific session using LIVE data.
    Returns matched TM charges with energy, cost, and location data.
    """
    from app.models.session import SessionModel
    from app.services.live_matching import run_live_matching_dry_run
    from datetime import timedelta

    # Find the session
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        return {"ok": False, "matches": [], "error": "Session not found"}

    if session.source_type != "home":
        return {"ok": True, "matches": [], "note": "Only home sessions can have TM matches"}

    # Get TM charges in the same time window (±1 day)
    if session.date:
        from_date = (session.date - timedelta(days=1)).strftime("%Y-%m-%d")
        to_date = (session.date + timedelta(days=1)).strftime("%Y-%m-%d")
    else:
        return {"ok": True, "matches": [], "note": "Session has no date"}

    # Run LIVE matching for this session (no limit, use narrow date window for speed)
    result = await run_live_matching_dry_run(
        limit=None, from_date=from_date, to_date=to_date, db=db
    )

    if not result.get("ok", False):
        return {"ok": False, "matches": [], "error": "Live matching failed"}

    # Find matches for this specific session using source_id (EVCC ID)
    evcc_source_id = session.source_id
    session_match = None
    for m in result.get("matches", []):
        if str(m.get("evcc_session_id")) == str(evcc_source_id):
            session_match = m
            break

    if not session_match:
        return {
            "ok": True,
            "matches": [],
            "session_id": session_id,
            "note": "No TM matches found for this session"
        }

    # Build response
    matches = []
    for mc in session_match.get("matched_charges", []):
        matches.append({
            "charge_id": mc.get("charge_id"),
            "source_id": mc.get("source_id"),
            "date": mc.get("date"),
            "energy_kwh": mc.get("energy_kwh"),
            "cost_eur": mc.get("cost_eur"),
            "location": mc.get("location"),
            "accepted_as_candidate": mc.get("accepted_as_candidate"),
            "reject_reason": mc.get("reject_reason"),
            "overlap_seconds": mc.get("overlap_seconds"),
            "containment": mc.get("containment"),
            "match_source": mc.get("match_source"),
        })

    return {
        "ok": True,
        "matches": matches,
        "session_id": session_id,
        "match_quality": session_match.get("match_quality"),
        "delta_kwh": session_match.get("delta_kwh"),
        "matched_charge_count": len(matches),
    }


@router.post("/{session_id}/match")
async def create_session_match(
    session_id: int,
    body: dict,
    db: Session = Depends(get_db)
):
    """
    Create a manual match between a session and a TM charge.
    Body: { "tm_charge_id": 2449 }
    Creates a MatchingOverride record.
    """
    from app.models.session import SessionModel
    from app.models.matching_override import MatchingOverride, OverrideType
    from datetime import datetime, timezone

    tm_charge_id = body.get("tm_charge_id")
    if not tm_charge_id:
        return {"ok": False, "error": "tm_charge_id is required"}

    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        return {"ok": False, "error": "Session not found"}

    # Check if override already exists
    existing = db.query(MatchingOverride).filter(
        MatchingOverride.evcc_session_id == session_id,
        MatchingOverride.teslamate_charge_id == tm_charge_id
    ).first()

    if existing:
        return {"ok": True, "message": "Match already exists", "override_id": existing.id}

    # Create new override
    override = MatchingOverride(
        evcc_session_id=session_id,
        teslamate_charge_id=tm_charge_id,
        override_type=OverrideType.manual_assign,
        reason="Manual match via UI",
        created_by="user",
    )
    db.add(override)
    db.commit()

    return {
        "ok": True,
        "message": "Manual match created",
        "override_id": override.id,
        "session_id": session_id,
        "tm_charge_id": tm_charge_id,
    }


@router.delete("/{session_id}/match/{tm_charge_id}")
async def remove_session_match(
    session_id: int,
    tm_charge_id: int,
    db: Session = Depends(get_db)
):
    """
    Remove a manual match between a session and a TM charge.
    Deletes the MatchingOverride record.
    """
    from app.models.matching_override import MatchingOverride

    override = db.query(MatchingOverride).filter(
        MatchingOverride.evcc_session_id == session_id,
        MatchingOverride.teslamate_charge_id == tm_charge_id
    ).first()

    if not override:
        return {"ok": False, "error": "Match not found"}

    db.delete(override)
    db.commit()

    return {
        "ok": True,
        "message": "Match removed",
        "session_id": session_id,
        "tm_charge_id": tm_charge_id,
    }