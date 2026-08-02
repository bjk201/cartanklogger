from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import List, Optional

from app.database import get_db
from app.repositories.session import SessionRepository
from app.schemas.overview import (
    PaginatedSessionsResponse, 
    SessionRead, 
    MetaInfo, 
    ErrorDetail,
    PaginationInfo
)


router = APIRouter(prefix="/sessions", tags=["Sessions"])


@router.get(
    "",
    response_model=PaginatedSessionsResponse,
    summary="Get paginated charging sessions",
    description="Returns paginated sessions with filtering and sorting options."
)
def get_sessions(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(25, ge=1, le=100, description="Items per page"),
    source_type: Optional[str] = Query(None, description="Filter by source type: home, external, import, all"),
    search: Optional[str] = Query(None, description="Search in location and note"),
    sort_desc: bool = Query(True, description="Sort by date descending"),
    db: Session = Depends(get_db)
) -> PaginatedSessionsResponse:
    repo = SessionRepository(db)
    
    # Insert seed data if empty (MVP)
    repo.insert_seed_data()
    
    # Get paginated sessions
    sessions, total = repo.get_sessions_paginated(
        page=page,
        page_size=page_size,
        source_type=source_type,
        search=search,
        sort_desc=sort_desc,
    )
    
    # Calculate pagination info
    total_pages = (total + page_size - 1) // page_size
    has_next = page < total_pages
    has_prev = page > 1
    
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
        ))
    
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