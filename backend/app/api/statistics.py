from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional

from app.database import get_db
from app.repositories.session import SessionRepository
from app.services.matching import run_matching_dry_run
from app.schemas.overview import StatisticsResponse, ErrorDetail
from app.models.datasource import DataSourceConfig


router = APIRouter(prefix="/statistics", tags=["Statistics"])


def _is_live_mode(db: Session) -> bool:
    """Check if both EVCC and TeslaMateAPI are configured (live mode)."""
    config = db.query(DataSourceConfig).first()
    return bool(config and config.evcc_host and config.teslamateapi_base_url)


@router.get(
    "",
    response_model=StatisticsResponse,
    summary="Get charging statistics",
    description="Returns aggregated statistics for the given time range. Supports days, from_date, to_date parameters (like other endpoints)."
)
def get_statistics(
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    legacy_range: Optional[str] = Query(None, alias="range", description="Legacy range parameter: 7d, 30d, 90d, 365d, all (deprecated, use days/from_date/to_date)"),
    db: Session = Depends(get_db)
) -> StatisticsResponse:
    # If not in live mode (no EVCC/TM config), return empty results
    if not _is_live_mode(db):
        return StatisticsResponse(
            ok=True,
            kpis={
                "total_energy_kwh": 0.0,
                "total_cost_eur": 0.0,
                "avg_cost_per_kwh": None,
                "total_sessions": 0,
                "home_sessions": 0,
                "external_sessions": 0,
                "import_sessions": 0,
                "avg_energy_per_session": None,
                "avg_cost_per_session": None,
                "max_energy_session": None,
                "max_cost_session": None,
                "max_energy_session_id": None,
                "max_cost_session_id": None,
                "external_dc_sessions": 0,
                "external_ac_sessions": 0,
                "external_dc_energy_kwh": 0.0,
                "external_ac_energy_kwh": 0.0,
                "external_dc_cost_eur": 0.0,
                "external_ac_cost_eur": 0.0,
                "charging_losses_kwh": None,
                "charging_losses_pct": None,
                "evcc_energy_matched_kwh": None,
                "tm_energy_matched_kwh": None,
                "trip_count": 0,
                "trip_total_energy_kwh": 0.0,
                "trip_total_cost_eur": 0.0,
                "trip_avg_distance_km": None,
            },
            energy_by_source={"home": 0.0, "external": 0.0, "import": 0.0, "total": 0.0},
            cost_by_source={"home": 0.0, "external": 0.0, "import": 0.0, "total": 0.0},
            sessions_by_source={"home": 0, "external": 0, "import": 0, "total": 0},
            range_days=days or 0,
            range_label="Keine Konfiguration",
            errors=[]
        )
    repo = SessionRepository(db)

    # Parse range parameter - support both new (days/from_date/to_date) and legacy (range=) formats
    range_days = None
    range_label = "30d"
    
    if legacy_range:
        # Legacy range= parameter
        if legacy_range == "7d":
            range_days = 7
        elif legacy_range == "30d":
            range_days = 30
        elif legacy_range == "90d":
            range_days = 90
        elif legacy_range == "365d":
            range_days = 365
        elif legacy_range == "all":
            range_days = None
            range_label = "all"
        else:
            range_days = 30
            range_label = "30d"
    elif days is not None or from_date or to_date:
        # New days/from_date/to_date parameters
        # Priority: from_date/to_date > days
        if from_date and to_date:
            range_days = None
            range_label = f"{from_date} – {to_date}"
        elif from_date:
            range_days = None
            range_label = f"ab {from_date}"
        elif to_date:
            range_days = None
            range_label = f"bis {to_date}"
        elif days is not None:
            if days >= 36500:
                range_label = "Alles"
                range_days = None
            else:
                range_label = f"{days} Tage"
                range_days = days
        else:
            range_days = 30
            range_label = "30d"
    else:
        # Default
        range_days = 30
        range_label = "30d"
    
    # Get base statistics
    stats = repo.get_statistics(range_days=range_days, from_date=from_date, to_date=to_date)
    
    # Calculate charging losses from live matching
    try:
        matching_result = run_matching_dry_run(days=range_days, from_date=from_date, to_date=to_date)
        if matching_result.get('ok') and matching_result.get('summary'):
            summary = matching_result['summary']
            total_evcc_energy = summary.get('total_evcc_energy', 0)
            total_tm_energy = summary.get('total_tm_energy', 0)
            if total_evcc_energy > 0:
                charging_losses_kwh = round(total_tm_energy - total_evcc_energy, 2)
                charging_losses_pct = round((charging_losses_kwh / total_evcc_energy) * 100, 1)
            else:
                charging_losses_kwh = None
                charging_losses_pct = None
            
            stats['kpis']['charging_losses_kwh'] = charging_losses_kwh
            stats['kpis']['charging_losses_pct'] = charging_losses_pct
            stats['kpis']['evcc_energy_matched_kwh'] = round(total_evcc_energy, 2)
            stats['kpis']['tm_energy_matched_kwh'] = round(total_tm_energy, 2)
        else:
            stats['kpis']['charging_losses_kwh'] = None
            stats['kpis']['charging_losses_pct'] = None
            stats['kpis']['evcc_energy_matched_kwh'] = None
            stats['kpis']['tm_energy_matched_kwh'] = None
    except Exception:
        stats['kpis']['charging_losses_kwh'] = None
        stats['kpis']['charging_losses_pct'] = None
        stats['kpis']['evcc_energy_matched_kwh'] = None
        stats['kpis']['tm_energy_matched_kwh'] = None
    
    # Trip analysis - find trips (external sessions grouped by proximity)
    trip_stats = repo.get_trip_analysis(range_days=range_days, from_date=from_date, to_date=to_date)
    stats['kpis'].update(trip_stats)
    
    return StatisticsResponse(
        ok=True,
        kpis=stats["kpis"],
        energy_by_source=stats["energy_by_source"],
        cost_by_source=stats["cost_by_source"],
        sessions_by_source=stats["sessions_by_source"],
        range_days=range_days or 0,
        range_label=range_label,
        errors=[]
    )