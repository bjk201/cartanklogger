"""
Matching Raw Data API Endpoint
==============================

Provides raw EVCC and TeslaMateAPI data for matching inspection.
"""

from fastapi import APIRouter, Query, Depends
from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_

from app.database import get_db
from app.models.session import SessionModel
from app.models.matching_override import MatchingOverride, OverrideType

router = APIRouter(prefix="/matching", tags=["Matching"])


@router.get("/raw-data")
async def matching_raw_data(
    limit: Optional[int] = Query(None, ge=1, le=500, description="Limit number of EVCC sessions"),
    days: Optional[int] = Query(None, description="Number of days to look back (e.g., 7, 30, 90, 365)"),
    from_date: Optional[str] = Query(None, description="Start date in ISO format (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="End date in ISO format (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
):
    """
    Get raw EVCC and TeslaMateAPI data for matching inspection.
    Returns original fields from both sources without matching logic applied.
    """

    # Build EVCC sessions query
    from sqlalchemy import func
    evcc_query = db.query(SessionModel).filter(
        SessionModel.source_type == 'home'
    )
    
    # Apply time range filter
    if from_date and to_date:
        from_str = from_date
        to_str = to_date + ' 23:59:59'
        evcc_query = evcc_query.filter(
            func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str,
            func.date(func.replace(SessionModel.date, 'T', ' ')) <= to_str
        )
    elif from_date and not to_date:
        from_str = from_date
        evcc_query = evcc_query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str)
    elif days is not None:
        from datetime import datetime, timedelta, timezone
        cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_str = cutoff_date.strftime('%Y-%m-%d')
        evcc_query = evcc_query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= cutoff_str)
    
    evcc_query = evcc_query.order_by(SessionModel.date.desc())
    
    if limit:
        evcc_query = evcc_query.limit(limit)

    evcc_sessions = evcc_query.all()

    # Build TM charges query
    tm_query = db.query(SessionModel).filter(
        SessionModel.source_type == 'external'
    )
    
    # Apply time range filter
    if from_date and to_date:
        from_str = from_date
        to_str = to_date + ' 23:59:59'
        tm_query = tm_query.filter(
            func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str,
            func.date(func.replace(SessionModel.date, 'T', ' ')) <= to_str
        )
    elif from_date and not to_date:
        from_str = from_date
        tm_query = tm_query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str)
    elif days is not None:
        from datetime import datetime, timedelta, timezone
        cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_str = cutoff_date.strftime('%Y-%m-%d')
        tm_query = tm_query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= cutoff_str)

    tm_charges = tm_query.all()

    # Get active overrides
    all_overrides = db.query(MatchingOverride).order_by(
        MatchingOverride.teslamate_charge_id,
        MatchingOverride.created_at.desc()
    ).all()

    # Keep only latest NON-reset override per TM charge
    latest_per_charge = {}
    for ov in all_overrides:
        if ov.override_type == OverrideType.reset_to_auto:
            continue
        if ov.teslamate_charge_id not in latest_per_charge:
            latest_per_charge[ov.teslamate_charge_id] = ov

    active_overrides = list(latest_per_charge.values())
    override_map = {ov.teslamate_charge_id: ov for ov in active_overrides}

    # Build EVCC raw data
    evcc_raw = []
    for evcc in evcc_sessions:
        # Try to get additional fields from note or legacy metadata
        # The sessions table has: id, source_id, source_type, date, location, energy_kwh, cost_eur,
        # odometer_km, distance_km, note, solar_percentage, pv_kwh, cost_per_kwh, cost_per_kwh_source,
        # legacy_source, legacy_table, legacy_id

        evcc_raw.append({
            "evcc_session_id": evcc.id,
            "source_id": evcc.source_id,
            "created": evcc.date.isoformat() if evcc.date else None,
            "finished": None,  # Not directly stored, estimated from energy
            "location": evcc.location,
            "energy_kwh": evcc.energy_kwh,
            "cost_eur": evcc.cost_eur,
            "cost_per_kwh": evcc.cost_per_kwh,
            "cost_per_kwh_source": evcc.cost_per_kwh_source,
            "odometer_km": evcc.odometer_km,
            "distance_km": evcc.distance_km,
            "note": evcc.note,
            "solar_percentage": evcc.solar_percentage,
            "pv_kwh": evcc.pv_kwh,
            "legacy_source": evcc.legacy_source,
            "legacy_table": evcc.legacy_table,
            "legacy_id": evcc.legacy_id,
            # Parsed from note if available
            "vehicle": _parse_vehicle_from_note(evcc.note),
            "soc_start": _parse_soc_start_from_note(evcc.note),
            "soc_end": _parse_soc_end_from_note(evcc.note),
        })

    # Build TM raw data
    tm_raw = []
    for tm in tm_charges:
        override = override_map.get(tm.id)
        is_home_location = _is_home_location(tm.location)

        tm_raw.append({
            "charge_id": tm.id,
            "source_id": tm.source_id,
            "start_date": tm.date.isoformat() if tm.date else None,
            "end_date": None,  # Not directly stored
            "location_original": tm.location,
            "location_normalized": (tm.location or "").strip().lower(),
            "energy_kwh": tm.energy_kwh,
            "cost_eur": tm.cost_eur,
            "cost_per_kwh": tm.cost_per_kwh,
            "cost_per_kwh_source": tm.cost_per_kwh_source,
            "odometer_km": tm.odometer_km,
            "distance_km": tm.distance_km,
            "note": tm.note,
            "legacy_source": tm.legacy_source,
            "legacy_table": tm.legacy_table,
            "legacy_id": tm.legacy_id,
            "is_home_location": is_home_location,
            "override": {
                "override_id": override.id if override else None,
                "evcc_session_id": override.evcc_session_id if override else None,
                "override_type": override.override_type.value if override else None,
                "reason": override.reason if override else None,
                "replaced_auto_match": override.replaced_auto_match if override else None,
            } if override else None,
            # Parsed from note if available
            "provider": _parse_provider_from_note(tm.note),
            "soc_start": _parse_soc_start_from_note(tm.note),
            "soc_end": _parse_soc_end_from_note(tm.note),
            # Charge type details
            "charge_type": tm.charge_type,
            "fast_charger_brand": tm.fast_charger_brand,
            "max_charge_power_kw": tm.max_charge_power_kw,
        })

    return {
        "ok": True,
        "evcc_sessions": evcc_raw,
        "teslamate_charges": tm_raw,
        "active_overrides_count": len(active_overrides),
        "total_evcc": len(evcc_raw),
        "total_tm": len(tm_raw),
        "home_tm_charges": len([c for c in tm_raw if c["is_home_location"]]),
        "external_tm_charges": len([c for c in tm_raw if not c["is_home_location"]]),
        "timestamp": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
    }


def _is_home_location(location: Optional[str]) -> bool:
    """Check if location is the home location 'Zuhause'."""
    if not location:
        return False
    normalized = location.strip().lower()
    return normalized == "zuhause"


def _parse_vehicle_from_note(note: Optional[str]) -> Optional[str]:
    if not note:
        return None
    for part in note.split(";"):
        part = part.strip()
        if part.startswith("Vehicle:") or part.startswith("vehicle:"):
            return part.split(":", 1)[1].strip()
    return None


def _parse_soc_start_from_note(note: Optional[str]) -> Optional[float]:
    if not note:
        return None
    for part in note.split(";"):
        part = part.strip()
        if "SoC:" in part or "soc:" in part.lower():
            # Format: "SoC: 80→20%" or "soc: 80->20"
            try:
                soc_part = part.split(":", 1)[1].strip()
                return float(soc_part.split("→")[0].split("->")[0].strip().rstrip("%"))
            except:
                pass
    return None


def _parse_soc_end_from_note(note: Optional[str]) -> Optional[float]:
    if not note:
        return None
    for part in note.split(";"):
        part = part.strip()
        if "SoC:" in part or "soc:" in part.lower():
            try:
                soc_part = part.split(":", 1)[1].strip()
                if "→" in soc_part:
                    return float(soc_part.split("→")[1].strip().rstrip("%"))
                elif "->" in soc_part:
                    return float(soc_part.split("->")[1].strip().rstrip("%"))
            except:
                pass
    return None


def _parse_provider_from_note(note: Optional[str]) -> Optional[str]:
    if not note:
        return None
    for part in note.split(";"):
        part = part.strip()
        if part.startswith("Provider:"):
            return part.split(":", 1)[1].strip()
    return None