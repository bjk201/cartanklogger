from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime, timedelta
from sqlalchemy import func

from app.database import get_db
from app.repositories.session import SessionRepository
from app.schemas.overview import OverviewResponse, SessionRead, MetaInfo, ErrorDetail, OverviewSummaryResponse


router = APIRouter(prefix="/overview", tags=["Overview"])


@router.get(
    "/recent-sessions",
    response_model=OverviewResponse,
    summary="Get recent charging sessions",
    description="Returns globally sorted recent sessions from all sources (home, external, import). "
                "Limit: min 1, max 100. Results sorted by date descending."
)
def get_recent_sessions(
    limit: int = Query(10, ge=1, le=100, description="Number of sessions to return"),
    db: Session = Depends(get_db)
) -> OverviewResponse:
    repo = SessionRepository(db)
    
    # Insert seed data if empty (MVP)
    repo.insert_seed_data()
    
    # Get sessions
    sessions = repo.get_recent_sessions(limit=limit)
    
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
    description="Returns aggregated KPIs for the overview page (all time)."
)
def get_overview_summary(
    db: Session = Depends(get_db)
) -> OverviewSummaryResponse:
    repo = SessionRepository(db)
    
    # Insert seed data if empty (MVP)
    repo.insert_seed_data()
    
    # Get all sessions for aggregation
    sessions = repo.get_recent_sessions(limit=10000)  # Large limit to get all
    
    total_sessions = len(sessions)
    total_energy = sum(s.energy_kwh or 0 for s in sessions)
    total_cost = sum(s.cost_eur or 0 for s in sessions)
    home_sessions = [s for s in sessions if s.source_type == "home"]
    external_sessions = [s for s in sessions if s.source_type == "external"]
    home_energy = sum(s.energy_kwh or 0 for s in home_sessions)
    external_energy = sum(s.energy_kwh or 0 for s in external_sessions)
    home_cost = sum(s.cost_eur or 0 for s in home_sessions)
    external_cost = sum(s.cost_eur or 0 for s in external_sessions)
    
    avg_cost_per_kwh = round(total_cost / total_energy, 4) if total_energy > 0 else None
    home_share = round((home_energy / total_energy) * 100, 1) if total_energy > 0 else 0
    
    return OverviewSummaryResponse(
        ok=True,
        total_sessions=total_sessions,
        total_energy_kwh=round(total_energy, 1),
        total_cost_eur=round(total_cost, 2),
        avg_cost_per_kwh=avg_cost_per_kwh,
        home_sessions=len(home_sessions),
        external_sessions=len(external_sessions),
        import_sessions=len([s for s in sessions if s.source_type == "import"]),
        home_energy_kwh=round(home_energy, 1),
        external_energy_kwh=round(external_energy, 1),
        home_cost_eur=round(home_cost, 2),
        external_cost_eur=round(external_cost, 2),
        home_share_pct=home_share,
        errors=[]
    )