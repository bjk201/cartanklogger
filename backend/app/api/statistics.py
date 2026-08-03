from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional

from app.database import get_db
from app.repositories.session import SessionRepository
from app.schemas.overview import StatisticsResponse, ErrorDetail


router = APIRouter(prefix="/statistics", tags=["Statistics"])


@router.get(
    "",
    response_model=StatisticsResponse,
    summary="Get charging statistics",
    description="Returns aggregated statistics for the given time range."
)
def get_statistics(
    range: str = Query("30d", description="Time range: 7d, 30d, 90d, 365d, all"),
    db: Session = Depends(get_db)
) -> StatisticsResponse:
    repo = SessionRepository(db)

    # Parse range parameter (no seed data - only real production data)
    range_days = None
    range_label = range
    if range == "7d":
        range_days = 7
    elif range == "30d":
        range_days = 30
    elif range == "90d":
        range_days = 90
    elif range == "365d":
        range_days = 365
    elif range == "all":
        range_days = None
        range_label = "all"
    else:
        # Default to 30d
        range_days = 30
        range_label = "30d"
    
    # Get statistics
    stats = repo.get_statistics(range_days=range_days)
    
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