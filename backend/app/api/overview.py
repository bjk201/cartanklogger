from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime, timedelta, timezone
from sqlalchemy import func

from app.database import get_db
from app.repositories.session import SessionRepository
from app.schemas.overview import OverviewResponse, SessionRead, MetaInfo, ErrorDetail, OverviewSummaryResponse
from app.models.datasource import DataSourceConfig


router = APIRouter(prefix="/overview", tags=["Overview"])


def _get_configured_sources(db: Session) -> dict:
    """Check which data sources are configured."""
    config = db.query(DataSourceConfig).first()
    return {
        "evcc": bool(config and config.evcc_host),
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
    "/recent-sessions",
    response_model=OverviewResponse,
    summary="Get recent charging sessions",
    description="Returns globally sorted recent sessions from all sources (home, external, import). "
                "Can be filtered by date range using 'days', 'from', and 'to' parameters. "
                "If no range specified, defaults to last 30 days. Results sorted by date descending."
)
def get_recent_sessions(
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    limit: int = Query(100, ge=1, le=10000, description="Maximum number of sessions to return"),
    db: Session = Depends(get_db)
) -> OverviewResponse:
    # Get allowed source types based on configuration
    allowed_sources = _get_allowed_source_types(db)
    
    # If no sources configured at all, return empty
    if not allowed_sources or allowed_sources == ["import"]:
        # Only import is allowed - check if we should show import data
        # For now, return empty if no EVCC and no TM configured
        if "home" not in allowed_sources and "external" not in allowed_sources:
            return OverviewResponse(
                ok=True,
                data=[],
                meta=MetaInfo(count=0, limit=limit),
                errors=[]
            )

    repo = SessionRepository(db)

    # Parse from/to dates - keep as strings for TEXT comparison in SQLite
    from_dt = None
    to_dt = None
    if from_date:
        try:
            # Validate format
            datetime.fromisoformat(from_date)
            from_dt = from_date  # Pass as string
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid from_date format. Use YYYY-MM-DD")
    if to_date:
        try:
            # Validate format
            datetime.fromisoformat(to_date + "T23:59:59")
            to_dt = to_date  # Pass as string (repository will add T23:59:59)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid to_date format. Use YYYY-MM-DD")

    # Default to 30 days if no range specified
    if not days and not from_dt:
        days = 30

    # Get sessions (no seed data - only real production data)
    sessions = repo.get_sessions_by_date_range(
        range_days=days,
        from_date=from_dt,
        to_date=to_dt,
        limit=limit,
    )

    # Filter by allowed source types
    sessions = [s for s in sessions if s.source_type in allowed_sources]

    # Map to response schema
    data = []
    for s in sessions:
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
            pv_kwh=s.pv_kwh,
            cost_per_kwh=s.cost_per_kwh,
            cost_per_kwh_source=s.cost_per_kwh_source,
        ))

    return OverviewResponse(
        ok=True,
        data=data,
        meta=MetaInfo(count=len(data), limit=limit),
        errors=[]
    )


@router.get(
    "/summary",
    response_model=OverviewSummaryResponse,
    summary="Get overview summary KPIs",
    description="Returns aggregated KPIs for the overview page for the given time range."
)
def get_overview_summary(
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
) -> OverviewSummaryResponse:
    # Get allowed source types based on configuration
    allowed_sources = _get_allowed_source_types(db)
    
    # If no EVCC and no TM configured, return empty
    if "home" not in allowed_sources and "external" not in allowed_sources:
        return OverviewSummaryResponse(
            ok=True,
            total_sessions=0,
            total_energy_kwh=0.0,
            total_cost_eur=0.0,
            avg_cost_per_kwh=None,
            home_sessions=0,
            external_sessions=0,
            import_sessions=0,
            home_energy_kwh=0.0,
            external_energy_kwh=0.0,
            home_cost_eur=0.0,
            external_cost_eur=0.0,
            home_share_pct=0.0,
            errors=[]
        )

    repo = SessionRepository(db)

    # Parse from/to dates - keep as strings for TEXT comparison in SQLite
    from_dt = None
    to_dt = None
    if from_date:
        try:
            # Validate format
            datetime.fromisoformat(from_date)
            from_dt = from_date
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid from_date format. Use YYYY-MM-DD")
    if to_date:
        try:
            # Validate format
            datetime.fromisoformat(to_date + "T23:59:59")
            to_dt = to_date
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid to_date format. Use YYYY-MM-DD")

    # Default to 30 days if no range specified
    if not days and not from_dt:
        days = 30

    # Get all sessions for aggregation for the given range
    sessions = repo.get_sessions_by_date_range(
        range_days=days,
        from_date=from_dt,
        to_date=to_dt,
        limit=10000,  # Large limit to get all
    )

    # Filter by allowed source types
    sessions = [s for s in sessions if s.source_type in allowed_sources]

    total_sessions = len(sessions)
    total_energy = sum(s.energy_kwh or 0 for s in sessions)
    total_cost = sum(s.cost_eur or 0 for s in sessions)
    home_sessions_list = [s for s in sessions if s.source_type == "home"]
    external_sessions_list = [s for s in sessions if s.source_type == "external"]
    home_energy = sum(s.energy_kwh or 0 for s in home_sessions_list)
    external_energy = sum(s.energy_kwh or 0 for s in external_sessions_list)
    home_cost = sum(s.cost_eur or 0 for s in home_sessions_list)
    external_cost = sum(s.cost_eur or 0 for s in external_sessions_list)

    avg_cost_per_kwh = round(total_cost / total_energy, 4) if total_energy > 0 else None
    home_share = round((home_energy / total_energy) * 100, 1) if total_energy > 0 else 0

    return OverviewSummaryResponse(
        ok=True,
        total_sessions=total_sessions,
        total_energy_kwh=round(total_energy, 1),
        total_cost_eur=round(total_cost, 2),
        avg_cost_per_kwh=avg_cost_per_kwh,
        home_sessions=len(home_sessions_list),
        external_sessions=len(external_sessions_list),
        import_sessions=len([s for s in sessions if s.source_type == "import"]),
        home_energy_kwh=round(home_energy, 1),
        external_energy_kwh=round(external_energy, 1),
        home_cost_eur=round(home_cost, 2),
        external_cost_eur=round(external_cost, 2),
        home_share_pct=home_share,
        errors=[]
    )