from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional

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


def _is_live_mode(db: Session) -> bool:
    """Check if both EVCC and TeslaMateAPI are configured (live mode)."""
    config = db.query(DataSourceConfig).first()
    return bool(config and config.evcc_host and config.teslamateapi_base_url)


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
    # If not in live mode (no EVCC/TM config), return empty results
    if not _is_live_mode(db):
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
        source_type=source_type,
        search=search,
        sort_desc=sort_desc,
        days=days,
        from_date=from_date,
        to_date=to_date,
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
            cost_per_kwh=s.cost_per_kwh,
            cost_per_kwh_source=s.cost_per_kwh_source,
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