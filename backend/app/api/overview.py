from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime

from app.database import get_db
from app.repositories.session import SessionRepository
from app.schemas.overview import OverviewResponse, SessionRead, MetaInfo, ErrorDetail


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
            id=f"{s.source_type}:{s.source_id}",
            date=s.date,
            source_type=s.source_type,
            location=s.location,
            energy_kwh=s.energy_kwh,
            cost_eur=s.cost_eur,
            odometer_km=s.odometer_km,
            distance_km=s.distance_km,
            note=s.note,
        ))
    
    return OverviewResponse(
        ok=True,
        data=data,
        meta=MetaInfo(count=len(data), limit=limit),
        errors=[]
    )