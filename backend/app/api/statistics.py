import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional, List

from app.database import get_db
from app.repositories.session import SessionRepository
from app.services.matching import run_matching_dry_run
from app.schemas.overview import StatisticsResponse, ErrorDetail
from app.models.datasource import DataSourceConfig


logger = logging.getLogger(__name__)

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
            energy_by_source={"home": 0.0, "external": 0.0, "import_": 0.0, "total": 0.0},
            cost_by_source={"home": 0.0, "external": 0.0, "import_": 0.0, "total": 0.0},
            sessions_by_source={"home": 0, "external": 0, "import_": 0, "total": 0},
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
    stats["energy_by_source"]["total"] = stats["energy_by_source"]["home"] + stats["energy_by_source"]["external"] + stats["energy_by_source"]["import_"]
    stats["cost_by_source"]["total"] = stats["cost_by_source"]["home"] + stats["cost_by_source"]["external"] + stats["cost_by_source"]["import_"]
    stats["sessions_by_source"]["total"] = stats["sessions_by_source"]["home"] + stats["sessions_by_source"]["external"] + stats["sessions_by_source"]["import_"]
    stats["kpis"]["total_energy_kwh"] = stats["energy_by_source"]["total"]
    stats["kpis"]["total_cost_eur"] = stats["cost_by_source"]["total"]
    stats["kpis"]["total_sessions"] = stats["sessions_by_source"]["total"]
    
    # Calculate charging losses from ALL TeslaMate charges (home + external):
    # losses = Σ(charge_energy_used) − Σ(charge_energy_added) — same definition as the TM app summary.
    if configured["teslamateapi"]:
        tm_charges_all = None
        try:
            from app.services.teslamateapi_client import create_teslamateapi_client_from_config
            config = db.query(DataSourceConfig).first()
            tm_client = await create_teslamateapi_client_from_config(config)
            if tm_client:
                tm_charges_all = await tm_client.get_charges()
                if range_days or from_date or to_date:
                    tm_charges_all = tm_client._filter_tm_by_date_range(tm_charges_all, range_days, from_date, to_date)

                total_added = sum(c.charge_energy_added or 0 for c in tm_charges_all)
                total_used = sum(c.charge_energy_used or 0 for c in tm_charges_all)
                stats['kpis']['tm_total_energy_added_kwh'] = round(total_added, 2)
                stats['kpis']['tm_total_energy_used_kwh'] = round(total_used, 2)
                if total_added > 0:
                    losses = round(total_used - total_added, 2)
                    stats['kpis']['charging_losses_kwh'] = losses
                    stats['kpis']['charging_losses_pct'] = round((losses / total_added) * 100, 1)
                else:
                    stats['kpis']['charging_losses_kwh'] = None
                    stats['kpis']['charging_losses_pct'] = None
        except Exception:
            stats['kpis']['charging_losses_kwh'] = None
            stats['kpis']['charging_losses_pct'] = None
            stats['kpis']['tm_total_energy_added_kwh'] = None
            stats['kpis']['tm_total_energy_used_kwh'] = None
    else:
        stats['kpis']['charging_losses_kwh'] = None
        stats['kpis']['charging_losses_pct'] = None
        stats['kpis']['tm_total_energy_added_kwh'] = None
        stats['kpis']['tm_total_energy_used_kwh'] = None
    
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
                daily_data = defaultdict(lambda: {"km": 0.0, "kwh": 0.0, "odo": None})
                for drive in tm_drives:
                    if drive.start_date:
                        date_key = drive.start_date.strftime("%Y-%m-%d")
                        if drive.odometer_distance:
                            daily_data[date_key]["km"] += drive.odometer_distance
                        if drive.energy_consumed_net:
                            daily_data[date_key]["kwh"] += drive.energy_consumed_net
                        if drive.odometer_end:
                            # Keep the max (latest) odometer for each day
                            current = daily_data[date_key]["odo"]
                            if current is None or drive.odometer_end > current:
                                daily_data[date_key]["odo"] = drive.odometer_end
                
                # Convert to sorted list for frontend chart
                sorted_dates = sorted(daily_data.keys())
                daily_km = [round(daily_data[d]["km"], 1) for d in sorted_dates]
                daily_kwh = [round(daily_data[d]["kwh"], 2) for d in sorted_dates]
                daily_odo = [daily_data[d]["odo"] for d in sorted_dates]

                stats['kpis']['daily_dates'] = sorted_dates
                stats['kpis']['daily_km'] = daily_km
                stats['kpis']['daily_kwh'] = daily_kwh
                stats['kpis']['daily_odometer'] = daily_odo
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
            func.sum(SessionModel.cost_eur).label('total_cost'),
            func.sum(SessionModel.energy_kwh).label('total_energy')
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
        daily_cost_kwh = [float(row.total_energy) for row in cost_rows]

        stats['kpis']['daily_cost_dates'] = daily_cost_dates
        stats['kpis']['daily_cost_eur'] = daily_cost_eur
        stats['kpis']['daily_cost_kwh'] = daily_cost_kwh
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

    # Cost of charging losses:
    # Home:   loss_home = Σ(used − added) über HOME-Charges, bewertet mit Ø-Arbeitspreis Zuhause
    #         (= EVCC-Kosten / EVCC-geladene kWh im Zeitraum; da nur der Netzanteil kostet,
    #          ist das bereits der PV-Gewichtete Mischpreis → exakte Zusatzkosten der Verluste)
    # Extern: loss_ext = Σ(used − added) über EXTERNE Charges, bewertet mit Ø-Preis extern
    #         (= externe Kosten / externe kWh, inkl. Gebühren)
    try:
        from sqlalchemy import func
        from app.models.session import SessionModel
        from datetime import datetime, timezone, timedelta
        loss_costs = {
            'home_loss_kwh': None, 'home_price_eur_per_kwh': None, 'home_cost_eur': None,
            'external_loss_kwh': None, 'external_price_eur_per_kwh': None, 'external_cost_eur': None,
            'total_cost_eur': None, 'grid_share_home': 1.0,
        }
        if configured["teslamateapi"]:
            from app.services.teslamateapi_client import create_teslamateapi_client_from_config
            config = db.query(DataSourceConfig).first()
            tm_client_c = await create_teslamateapi_client_from_config(config)
            if tm_client_c:
                tm_charges_cost = await tm_client_c.get_charges()
                if range_days or from_date or to_date:
                    tm_charges_cost = tm_client_c._filter_tm_by_date_range(tm_charges_cost, range_days, from_date, to_date)

                home_kw = {"zuhause", "garage", "home", "haus"}
                used_h = added_h = used_e = added_e = 0.0
                for c in tm_charges_cost:
                    loc = (getattr(c, 'location', '') or '').lower()
                    if any(k in loc for k in home_kw):
                        used_h += c.charge_energy_used or 0
                        added_h += c.charge_energy_added or 0
                    else:
                        used_e += c.charge_energy_used or 0
                        added_e += c.charge_energy_added or 0

                home_loss = round(used_h - added_h, 2)
                ext_loss = round(used_e - added_e, 2)

                home_energy = stats["energy_by_source"].get("home", 0.0)
                home_cost = stats["cost_by_source"].get("home", 0.0)
                ext_energy = stats["energy_by_source"].get("external", 0.0)
                ext_cost = stats["cost_by_source"].get("external", 0.0)

                home_price = round(home_cost / home_energy, 4) if home_energy > 0 else None
                ext_price = round(ext_cost / ext_energy, 4) if ext_energy > 0 else None

                # Gewichteteter PV-/Netzanteil Zuhause (für Anzeige; Preis ist schon PV-gewichtet)
                pv_q = db.query(
                    func.sum(SessionModel.pv_kwh),
                    func.sum(SessionModel.energy_kwh),
                    func.sum(SessionModel.energy_kwh * SessionModel.solar_percentage) / func.sum(SessionModel.energy_kwh),
                ).filter(SessionModel.source_type == 'home')
                if range_days:
                    pv_q = pv_q.filter(SessionModel.date >= datetime.now(timezone.utc) - timedelta(days=range_days))
                if from_date:
                    pv_q = pv_q.filter(func.date(SessionModel.date) >= from_date)
                if to_date:
                    pv_q = pv_q.filter(func.date(SessionModel.date) <= to_date)
                pv_row = pv_q.first()
                en_sum = float(pv_row[1] or 0) if pv_row else 0.0
                pv_frac = None
                if en_sum > 0:
                    pv_direct = float(pv_row[0] or 0)
                    if pv_direct > 0:
                        pv_frac = pv_direct / en_sum
                    elif pv_row[2] is not None:
                        pv_frac = max(0.0, min(1.0, float(pv_row[2]) / 100.0))
                grid_share = round(1 - pv_frac, 4) if pv_frac is not None else 1.0

                home_cost_losses = round(abs(home_loss) * home_price, 2) if (home_price is not None and home_loss != 0) else None
                ext_cost_losses = round(abs(ext_loss) * ext_price, 2) if (ext_price is not None and ext_loss != 0) else None
                total_cost = round((home_cost_losses or 0) + (ext_cost_losses or 0), 2)

                loss_costs = {
                    'home_loss_kwh': home_loss,
                    'home_price_eur_per_kwh': home_price,
                    'home_cost_eur': home_cost_losses,
                    'external_loss_kwh': ext_loss,
                    'external_price_eur_per_kwh': ext_price,
                    'external_cost_eur': ext_cost_losses,
                    'total_cost_eur': total_cost,
                    'grid_share_home': grid_share,
                }
        stats['kpis']['charging_loss_costs'] = loss_costs
    except Exception:
        stats['kpis']['charging_loss_costs'] = None

    # Weighted monthly PV share (radar chart data) — label formatting happens in the frontend
    try:
        from sqlalchemy import func
        from app.models.session import SessionModel
        from datetime import datetime, timezone, timedelta
        month_expr = func.strftime('%Y-%m', SessionModel.date)
        mpv_q = db.query(
            month_expr.label('m'),
            func.sum(SessionModel.energy_kwh).label('en'),
            func.sum(SessionModel.pv_kwh).label('pv'),
            (func.sum(SessionModel.energy_kwh * SessionModel.solar_percentage) / func.sum(SessionModel.energy_kwh)).label('sp'),
        ).filter(SessionModel.source_type == 'home')
        if range_days:
            mpv_q = mpv_q.filter(SessionModel.date >= datetime.now(timezone.utc) - timedelta(days=range_days))
        if from_date:
            mpv_q = mpv_q.filter(func.date(SessionModel.date) >= from_date)
        if to_date:
            mpv_q = mpv_q.filter(func.date(SessionModel.date) <= to_date)
        monthly_pv = []
        for r in mpv_q.group_by(month_expr).order_by(month_expr).all():
            en_m = float(r.en or 0)
            if en_m <= 0:
                continue
            pv_m = float(r.pv or 0)
            frac = (pv_m / en_m) if pv_m > 0 else ((float(r.sp) / 100.0) if r.sp is not None else None)
            if frac is not None:
                frac = max(0.0, min(1.0, frac))
            monthly_pv.append({
                'month': r.m,
                'pv_pct': round(frac * 100, 1) if frac is not None else None,
                'energy_kwh': round(en_m, 1),
                'pv_kwh': round(pv_m, 1),
            })
        stats['kpis']['monthly_pv'] = monthly_pv
    except Exception:
        stats['kpis']['monthly_pv'] = []

    # ------------------------------------------------------------------
    # Prognose (wird bei JEDEM Aufruf frisch berechnet — dauerhaft aktuell)
    # Basis: komplette Fahrhistorie (ohne Zeitraum-Filter):
    #   - Fahrzeugalter seit Kaufdatum (ENV CTL_CAR_FIRST_REG, Default 23.06.2026)
    #   - Gefahrene km = max(odometer aus TM-Drives/Sessions/Records) − Start-km (ENV CTL_CAR_START_KM, Default 2)
    #   - Jährliche Fahrleistung = km / Alter in Jahren (linear)
    # Kosten je Jahr (hochgerechnet):
    #   - Ladekosten: home+external im Zeitraum "alles", linear auf 365 Tage
    #   - Extra-Kosten: extra_costs auf 365 Tage (einmalige Käufe zählen voll)
    # ------------------------------------------------------------------
    try:
        from sqlalchemy import func as _func
        from app.models.session import SessionModel as _S
        from app.models.vehicle import VehicleRecordModel as _V
        from app.models.extra_costs import ExtraCostModel as _E
        from datetime import datetime as _dt, timezone as _tz
        import os as _os

        now = datetime.now(_tz.utc)
        first_reg_str = _os.environ.get('CTL_CAR_FIRST_REG', '2026-06-23')
        start_km = float(_os.environ.get('CTL_CAR_START_KM', '2'))
        try:
            first_reg = _dt.strptime(first_reg_str, '%Y-%m-%d').replace(tzinfo=_tz.utc)
        except ValueError:
            first_reg = _dt(2026, 6, 23, tzinfo=_tz.utc)

        age_days = max((now - first_reg).total_seconds() / 86400.0, 1.0)
        age_years = age_days / 365.25

        # Gefahrene km: Maximum über alle Quellen
        max_sess_km = db.query(_func.max(_S.odometer_km)).scalar()
        max_rec_km = db.query(_func.max(_V.odometer_km)).scalar()
        candidates = [v for v in (max_sess_km, max_rec_km) if v is not None]
        current_km = max(candidates) if candidates else None
        km_total = (current_km - start_km) if current_km is not None else None

        # Jährliche Fahrleistung (linear)
        km_per_year = round(km_total / age_years) if km_total and km_total > 0 else None

        # Ladekosten gesamt (alle Zeiten, beide Quellen) + Tagesrate
        charge_cost_total = db.query(_func.coalesce(_func.sum(_S.cost_eur), 0.0)).filter(
            _S.source_type.in_(['home', 'external'])
        ).scalar() or 0.0
        first_day = db.query(_func.min(_func.date(_S.date))).filter(
            _S.source_type.in_(['home', 'external'])
        ).scalar()
        if first_day:
            fd = _dt.strptime(str(first_day), '%Y-%m-%d').replace(tzinfo=_tz.utc)
            charge_days = max((now - fd).total_seconds() / 86400.0, 1.0)
        else:
            charge_days = age_days
        charge_cost_per_year = round(charge_cost_total / charge_days * 365.25) if charge_cost_total > 0 else 0.0

        # Extra-Kosten (alle Zeiten)
        extra_total = db.query(_func.coalesce(_func.sum(_E.cost_eur), 0.0)).scalar() or 0.0
        extra_per_year = round(extra_total / charge_days * 365.25) if extra_total > 0 else 0.0

        stats['kpis']['forecast'] = {
            'current_km': round(current_km) if current_km is not None else None,
            'km_total': round(km_total) if km_total is not None else None,
            'age_days': round(age_days),
            'km_per_year': km_per_year,
            'charge_cost_total_eur': round(charge_cost_total, 2),
            'charge_cost_per_year_eur': charge_cost_per_year,
            'extra_cost_total_eur': round(extra_total, 2),
            'extra_cost_per_year_eur': extra_per_year,
            'total_cost_per_year_eur': charge_cost_per_year + extra_per_year,
            'cost_per_km_eur': (
                round((charge_cost_total + extra_total) / km_total, 4)
                if km_total and km_total > 0 and (charge_cost_total + extra_total) > 0
                else None
            ),
        }
    except Exception as _exc:  # pragma: no cover
        logger.warning("forecast failed: %s", _exc)
        stats['kpis']['forecast'] = None

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