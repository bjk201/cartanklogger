"""
Matching API Endpoint
=====================

Dry-run endpoint for EVCC ↔ TeslaMateAPI matching.
"""

from fastapi import APIRouter, Query
from typing import Optional

from app.services.matching import run_matching_dry_run


router = APIRouter(prefix="/matching", tags=["Matching"])


@router.get("/dry-run")
async def matching_dry_run(
    limit: Optional[int] = Query(None, ge=1, le=500, description="Limit number of EVCC sessions to check")
):
    """
    Run EVCC ↔ TeslaMateAPI matching as dry-run.
    
    Returns detailed matches per EVCC session and overall summary.
    """
    result = run_matching_dry_run(limit)
    return result