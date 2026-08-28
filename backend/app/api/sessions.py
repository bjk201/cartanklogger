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
            # TM-specific charging details
            charge_energy_added=s.charge_energy_added,
            charge_energy_used=s.charge_energy_used,
            duration_min=s.duration_min,
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


@router.get("/tm-sums")
async def get_session_tm_sums(
    days: Optional[int] = Query(None, description="Zeitraum in Tagen (z.B. 30)"),
    from_date: Optional[str] = Query(None, description="Startdatum YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="Enddatum YYYY-MM-DD"),
    db: Session = Depends(get_db)
):
    """Liefert für jede EVCC-Home-Session die Summe der zugeordneten TM-Energie
    (nur akzeptierte Matches). Läuft das Live-Matching ein MAL für den Zeitraum
    und gruppiert nach EVCC-Source-ID – so kann das Frontend die Summe direkt
    in der zugeklappten Session-Zeile anzeigen, ohne für jede Session einen
    Match-Call machen zu müssen."""
    from datetime import datetime, timedelta, timezone
    from app.models.session import SessionModel
    from app.services.live_matching import run_live_matching_dry_run

    # Zeitraum bestimmen
    if from_date and to_date:
        try:
            fd = datetime.strptime(from_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            td = datetime.strptime(to_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return {"ok": False, "by_source": {}}
    elif days:
        td = datetime.now(timezone.utc)
        fd = td - timedelta(days=days)
    else:
        td = datetime.now(timezone.utc)
        fd = td - timedelta(days=36500)

    # Alle Home-Sessions im Zeitraum (Datum statt Objekt)
    home_sessions = db.query(SessionModel).filter(
        SessionModel.source_type == "home",
        SessionModel.date >= fd,
        SessionModel.date <= td + timedelta(days=1)
    ).all()

    result = await run_live_matching_dry_run(
        limit=None,
        from_date=fd.strftime("%Y-%m-%d"),
        to_date=td.strftime("%Y-%m-%d"),
        db=db
    )

    # TM-Summe pro EVCC source_id (nur akzeptierte Kandidaten)
    by_source = {}
    for m in result.get("matches", []) if result.get("ok") else []:
        src_id = str(m.get("evcc_source_id"))
        actual = [c for c in m.get("matched_charges", []) if c.get("accepted_as_candidate")]
        tm_sum = round(sum(c.get("energy_kwh") or 0 for c in actual), 2)
        tm_used_sum = round(sum(c.get("charge_energy_used") or 0 for c in actual), 2)
        by_source[src_id] = {
            "tm_sum_kwh": tm_sum,
            "tm_used_kwh": tm_used_sum,
            "tm_count": len(actual),
            "evcc_energy_kwh": m.get("evcc_energy_kwh"),
        }

    # Nur Home-Sessions zurueckgeben (auch solche ohne Match)
    out = []
    for s in home_sessions:
        info = by_source.get(str(s.source_id), {})
        out.append({
            "session_id": s.id,
            "source_id": s.source_id,
            "tm_sum_kwh": info.get("tm_sum_kwh"),
            "tm_used_kwh": info.get("tm_used_kwh"),
            "tm_count": info.get("tm_count", 0),
            "evcc_energy_kwh": info.get("evcc_energy_kwh") if info else s.energy_kwh,
        })

    return {"ok": True, "data": out}


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

# ---------------------------------------------------------------------------
# Edit + Delete (Session-Detailpflege; Quelle bleibt EVCC/TM, hier nur CTL)
# ---------------------------------------------------------------------------
from fastapi import HTTPException as _HTTPException
from pydantic import BaseModel as _BaseModel
from typing import Optional as _Optional


class _SessionUpdate(_BaseModel):
    date: _Optional[str] = None
    energy_kwh: _Optional[float] = None
    cost_eur: _Optional[float] = None
    cost_per_kwh: _Optional[float] = None
    location: _Optional[str] = None
    odometer_km: _Optional[float] = None
    distance_km: _Optional[float] = None
    note: _Optional[str] = None


from app.models.session import SessionModel as _SessionModel


def _get_session_or_404(db: Session, session_id: int) -> _SessionModel:
    s = db.query(_SessionModel).filter(_SessionModel.id == session_id).first()
    if not s:
        raise _HTTPException(status_code=404, detail=f"Session {session_id} nicht gefunden")
    return s


@router.put("/{session_id}")
async def update_session(
    session_id: int,
    body: _SessionUpdate,
    db: Session = Depends(get_db),
):
    """Session-Felder direkt in CTL korrigieren (z. B. falsche kWh/Kosten).

    Nur gesetzte Felder werden ueberschrieben; cost_per_kwh_source wird auf
    'manual' gesetzt, wenn der Preis uebersteuert wurde.
    """
    from datetime import datetime as _dt

    s = _get_session_or_404(db, session_id)
    data = body.dict(exclude_unset=True)

    if "date" in data and data["date"]:
        raw = data["date"].replace("T", " ")
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                s.date = _dt.strptime(raw, fmt)
                break
            except ValueError:
                continue
        else:
            raise _HTTPException(status_code=422, detail=f"Ungueltiges Datum: {data['date']}")

    if "energy_kwh" in data:
        s.energy_kwh = data["energy_kwh"]
    if "cost_eur" in data:
        s.cost_eur = data["cost_eur"]
    if "cost_per_kwh" in data:
        s.cost_per_kwh = data["cost_per_kwh"]
        s.cost_per_kwh_source = "api" if data["cost_per_kwh"] is not None else "derived"
    if "location" in data:
        s.location = data["location"]
    if "odometer_km" in data:
        s.odometer_km = data["odometer_km"]
    if "distance_km" in data:
        s.distance_km = data["distance_km"]
    if "note" in data:
        s.note = data["note"]

    # Konsistenz: wenn Energie+Kosten vorhanden, Kosten/kWh neu ableiten
    # (nur wenn Preis-Feld selbst nicht explizit im Request war)
    if "cost_per_kwh" not in data and s.energy_kwh and s.cost_eur and s.energy_kwh > 0:
        s.cost_per_kwh = round(s.cost_eur / s.energy_kwh, 4)
        s.cost_per_kwh_source = "derived"

    db.commit()
    db.refresh(s)
    return {
        "ok": True,
        "message": "Session aktualisiert",
        "session_id": s.id,
        "updated": {
            "date": s.date.isoformat() if s.date else None,
            "energy_kwh": s.energy_kwh,
            "cost_eur": s.cost_eur,
            "cost_per_kwh": s.cost_per_kwh,
            "location": s.location,
            "odometer_km": s.odometer_km,
            "distance_km": s.distance_km,
            "note": s.note,
        },
    }


@router.delete("/{session_id}")
async def delete_session(session_id: int, db: Session = Depends(get_db)):
    """Session aus CTL loeschen (mit Referenz-Schutz).

    Blockiert, wenn Allokationen, Exporte oder Overrides an der Session
    haengen — diese Referenzen halten die TM-Kostenexport-Historie fest.
    """
    from app.models.tm_cost_export import SessionCostAllocation, TMCostExport
    from app.models.matching_override import MatchingOverride

    s = _get_session_or_404(db, session_id)

    refs = []
    alloc_n = db.query(SessionCostAllocation).filter_by(evcc_session_id=s.id).count()
    exp_n = db.query(TMCostExport).filter_by(evcc_session_id=s.id).count()
    ov_n = db.query(MatchingOverride).filter_by(evcc_session_id=s.id).count()
    if alloc_n:
        refs.append(f"{alloc_n} Allokation(en)")
    if exp_n:
        refs.append(f"{exp_n} Export-Eintraege")
    if ov_n:
        refs.append(f"{ov_n} Override(s)")

    if refs:
        raise _HTTPException(
            status_code=409,
            detail="Session kann nicht geloescht werden — Referenzen vorhanden: "
            + ", ".join(refs)
            + ". Erst Matching/Export-Verweise entfernen.",
        )

    info = {"id": s.id, "source_id": s.source_id, "date": s.date.isoformat() if s.date else None}
    db.delete(s)
    db.commit()
    return {"ok": True, "message": "Session geloescht", "deleted": info}
