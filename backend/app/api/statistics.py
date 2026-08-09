from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional, List

from app.database import get_db
from app.repositories.session import SessionRepository
from app.services.matching import run_matching_dry_run
from app.services.live_matching import run_live_matching_dry_run
from app.schemas.overview import StatisticsResponse, ErrorDetail
from app.models.datasource import DataSourceConfig


router = APIRouter(prefix="/statistics", tags=["Statistics"])


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
    response_model=StatisticsResponse,
    summary="Get charging statistics",
    description="Returns aggregated statistics for the given time range. Supports days, from_date, to_date parameters (like other endpoints)."
)
async def get_statistics(
    limit: Optional[int] = Query(None, ge=1, le=500, description="Limit number of EVCC sessions to check"),
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    legacy_range: Optional[str] = Query(None, alias="range", description="Legacy range parameter: 7d, 30d, 90d, 365d, all (deprecated, use days/from_date/to_date)"),
    db: Session = Depends(get_db)
) -> StatisticsResponse:
    # Get allowed source types based on configuration
    allowed_sources = _get_allowed_source_types(db)
    
    # If no EVCC and no TM configured, return empty
    if "home" not in allowed_sources and "external" not in allowed_sources:
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
    
    # Filter stats based on configured sources
    configured = _get_configured_sources(db)
    
    # Zero out home stats if EVCC not configured
    if not configured["evcc"]:
        stats["kpis"]["home_sessions"] = 0
        stats["energy_by_source"]["home"] = 0.0
        stats["cost_by_source"]["home"] = 0.0
        stats["sessions_by_source"]["home"] = 0
    
    # Zero out external stats if TM not configured
    if not configured["teslamateapi"]:
        stats["kpis"]["external_sessions"] = 0
        stats["energy_by_source"]["external"] = 0.0
        stats["cost_by_source"]["external"] = 0.0
        stats["sessions_by_source"]["external"] = 0
        # Also zero DC/AC breakdown
        stats["kpis"]["external_dc_sessions"] = 0
        stats["kpis"]["external_ac_sessions"] = 0
        stats["kpis"]["external_dc_energy_kwh"] = 0.0
        stats["kpis"]["external_ac_energy_kwh"] = 0.0
        stats["kpis"]["external_dc_cost_eur"] = 0.0
        stats["kpis"]["external_ac_cost_eur"] = 0.0
    
    # Recalculate totals based on filtered values
    stats["energy_by_source"]["total"] = stats["energy_by_source"]["home"] + stats["energy_by_source"]["external"] + stats["energy_by_source"]["import"]
    stats["cost_by_source"]["total"] = stats["cost_by_source"]["home"] + stats["cost_by_source"]["external"] + stats["cost_by_source"]["import"]
    stats["sessions_by_source"]["total"] = stats["sessions_by_source"]["home"] + stats["sessions_by_source"]["external"] + stats["sessions_by_source"]["import"]
    stats["kpis"]["total_energy_kwh"] = stats["energy_by_source"]["total"]
    stats["kpis"]["total_cost_eur"] = stats["cost_by_source"]["total"]
    stats["kpis"]["total_sessions"] = stats["sessions_by_source"]["total"]
    
    # Calculate charging losses from live matching (only if both EVCC and TM configured)
    if configured["evcc"] and configured["teslamateapi"]:
        try:
            # Use live matching which fetches TM home charges from API (not DB)
            matching_result = await run_live_matching_dry_run(limit, range_days, from_date, to_date, db)
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
    else:
        # Not both configured - no matching possible
        stats['kpis']['charging_losses_kwh'] = None
        stats['kpis']['charging_losses_pct'] = None
        stats['kpis']['evcc_energy_matched_kwh'] = None
        stats['kpis']['tm_energy_matched_kwh'] = None
    
    # Calculate external charging losses from TM API (charge_energy_used - charge_energy_added)
    # This is the energy lost between TM's battery and the EV battery during external charging.
    # Only counts external (non-home) TM charges.
    # charge_energy_used = energy drawn from TM battery (wallbox side)
    # charge_energy_added = energy actually added to EV battery
    # Difference = charging loss (heat, cable, wallbox overhead)
    if configured["teslamateapi"]:
        try:
            from app.services.teslamateapi_client import create_teslamateapi_client_from_config
            config = db.query(DataSourceConfig).first()
            tm_client = await create_teslamateapi_client_from_config(config)
            if tm_client:
                tm_charges = await tm_client.get_charges()
                # Filter by date range if provided
                if range_days or from_date or to_date:
                    tm_charges = tm_client._filter_tm_by_date_range(tm_charges, range_days, from_date, to_date)
                
                # Only count external (non-home) charges for loss calculation
                home_keywords = {"zuhause", "garage", "home", "haus"}
                external_charges = [
                    c for c in tm_charges
                    if c.charge_energy_added and c.charge_energy_used
                    and c.location
                    and c.location.strip().lower() not in home_keywords
                ]
                
                total_external_added = sum(c.charge_energy_added for c in external_charges)
                total_external_used = sum(c.charge_energy_used for c in external_charges)
                
                if total_external_added > 0:
                    external_losses_kwh = round(total_external_used - total_external_added, 2)
                    external_losses_pct = round((external_losses_kwh / total_external_added) * 100, 1)
                    stats['kpis']['external_charging_losses_kwh'] = external_losses_kwh
                    stats['kpis']['external_charging_losses_pct'] = external_losses_pct
                else:
                    stats['kpis']['external_charging_losses_kwh'] = None
                    stats['kpis']['external_charging_losses_pct'] = None
        except Exception:
            stats['kpis']['external_charging_losses_kwh'] = None
            stats['kpis']['external_charging_losses_pct'] = None
    else:
        stats['kpis']['external_charging_losses_kwh'] = None
        stats['kpis']['external_charging_losses_pct'] = None
    
    # Add daily drives data for chart (km/day and kWh/day from TM drives)
    if configured["teslamateapi"]:
        try:
            from app.services.teslamateapi_client import create_teslamateapi_client_from_config
            config = db.query(DataSourceConfig).first()
            tm_client = await create_teslamateapi_client_from_config(config)
            if tm_client:
                tm_drives = await tm_client.get_drives()
                # Filter by date range if provided
                if range_days or from_date or to_date:
                    tm_drives = tm_client._filter_tm_by_date_range(tm_drives, range_days, from_date, to_date)
                
                # Group by date
                from collections import defaultdict
                daily_data = defaultdict(lambda: {"km": 0.0, "kwh": 0.0})
                for drive in tm_drives:
                    if drive.start_date:
                        date_key = drive.start_date.strftime("%Y-%m-%d")
                        if drive.odometer_distance:
                            daily_data[date_key]["km"] += drive.odometer_distance
                        if drive.energy_consumed_net:
                            daily_data[date_key]["kwh"] += drive.energy_consumed_net
                
                # Convert to sorted list for frontend chart
                sorted_dates = sorted(daily_data.keys())
                daily_km = [round(daily_data[d]["km"], 1) for d in sorted_dates]
                daily_kwh = [round(daily_data[d]["kwh"], 2) for d in sorted_dates]
                
                stats['kpis']['daily_dates'] = sorted_dates
                stats['kpis']['daily_km'] = daily_km
                stats['kpis']['daily_kwh'] = daily_kwh
        except Exception:
            stats['kpis']['daily_dates'] = []
            stats['kpis']['daily_km'] = []
            stats['kpis']['daily_kwh'] = []
    else:
        stats['kpis']['daily_dates'] = []
        stats['kpis']['daily_km'] = []
        stats['kpis']['daily_kwh'] = []

    # Add daily cost data from sessions DB
    try:
        from sqlalchemy import func
        from app.models.session import SessionModel
        # Query daily cost by date (using date() on the session date field)
        cost_query = db.query(
            func.date(SessionModel.date).label('day'),
            func.sum(SessionModel.cost_eur).label('total_cost')
        ).filter(
            SessionModel.source_type.in_(['home', 'external'])
        )
        # Apply date range
        if range_days:
            from datetime import datetime, timezone, timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(days=range_days)
            cost_query = cost_query.filter(SessionModel.date >= cutoff)
        if from_date:
            cost_query = cost_query.filter(func.date(SessionModel.date) >= from_date)
        if to_date:
            cost_query = cost_query.filter(func.date(SessionModel.date) <= to_date)
        
        cost_query = cost_query.group_by(func.date(SessionModel.date)).order_by(func.date(SessionModel.date))
        cost_rows = cost_query.all()
        
        daily_cost_dates = [str(row.day) for row in cost_rows]
        daily_cost_eur = [float(row.total_cost) for row in cost_rows]
        
        stats['kpis']['daily_cost_dates'] = daily_cost_dates
        stats['kpis']['daily_cost_eur'] = daily_cost_eur
    except Exception:
        stats['kpis']['daily_cost_dates'] = []
        stats['kpis']['daily_cost_eur'] = []
    
    # Add daily charged energy data for chart (home, external, total kWh/day from TM charges)
    if configured["teslamateapi"]:
        try:
            from app.services.teslamateapi_client import create_teslamateapi_client_from_config
            config = db.query(DataSourceConfig).first()
            tm_client = await create_teslamateapi_client_from_config(config)
            if tm_client:
                tm_charges = await tm_client.get_charges()
                # Filter by date range if provided
                if range_days or from_date or to_date:
                    tm_charges = tm_client._filter_tm_by_date_range(tm_charges, range_days, from_date, to_date)
                
                # Group by date
                from collections import defaultdict
                daily_charged = defaultdict(lambda: {"home": 0.0, "external": 0.0, "total": 0.0})
                for charge in tm_charges:
                    if charge.start_date and charge.charge_energy_added:
                        date_key = charge.start_date.strftime("%Y-%m-%d")
                        # Determine if home or external based on location
                        location = (charge.location or "").lower()
                        is_home = "zuhause" in location or "home" in location or "garage" in location
                        if is_home:
                            daily_charged[date_key]["home"] += charge.charge_energy_added
                        else:
                            daily_charged[date_key]["external"] += charge.charge_energy_added
                        daily_charged[date_key]["total"] += charge.charge_energy_added
                
                # Convert to sorted list for frontend chart
                sorted_charged_dates = sorted(daily_charged.keys())
                daily_home_kwh = [round(daily_charged[d]["home"], 2) for d in sorted_charged_dates]
                daily_external_kwh = [round(daily_charged[d]["external"], 2) for d in sorted_charged_dates]
                daily_total_kwh = [round(daily_charged[d]["total"], 2) for d in sorted_charged_dates]
                
                stats['kpis']['daily_charged_dates'] = sorted_charged_dates
                stats['kpis']['daily_home_kwh'] = daily_home_kwh
                stats['kpis']['daily_external_kwh'] = daily_external_kwh
                stats['kpis']['daily_total_kwh'] = daily_total_kwh
        except Exception:
            stats['kpis']['daily_charged_dates'] = []
            stats['kpis']['daily_home_kwh'] = []
            stats['kpis']['daily_external_kwh'] = []
            stats['kpis']['daily_total_kwh'] = []
    else:
        stats['kpis']['daily_charged_dates'] = []
        stats['kpis']['daily_home_kwh'] = []
        stats['kpis']['daily_external_kwh'] = []
        stats['kpis']['daily_total_kwh'] = []
    
    if configured["teslamateapi"]:
        trip_stats = repo.get_trip_analysis(range_days=range_days, from_date=from_date, to_date=to_date)
        stats['kpis'].update(trip_stats)
    else:
        stats['kpis']['trip_count'] = 0
        stats['kpis']['trip_total_energy_kwh'] = 0.0
        stats['kpis']['trip_total_cost_eur'] = 0.0
        stats['kpis']['trip_avg_distance_km'] = None

    # Calculate PV share of all charging sessions
    # Formula: PV_kWh from EVCC Home-Sessions / (EVCC Home-kWh + externe TM-kWh) * 100
    # Uses charge_energy_added from TM (not energy_kwh which may differ)
    total_pv_kwh = stats["energy_by_source"].get("home", 0.0)  # EVCC home sessions include PV data
    total_external_kwh = stats["energy_by_source"].get("external", 0.0)
    total_charged = total_pv_kwh + total_external_kwh
    if total_charged > 0 and total_pv_kwh > 0:
        stats['kpis']['pv_share_pct'] = round((total_pv_kwh / total_charged) * 100, 1)
        stats['kpis']['pv_kwh'] = round(total_pv_kwh, 2)
        stats['kpis']['total_charged_kwh'] = round(total_charged, 2)
    else:
        stats['kpis']['pv_share_pct'] = None
        stats['kpis']['pv_kwh'] = None
        stats['kpis']['total_charged_kwh'] = None

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