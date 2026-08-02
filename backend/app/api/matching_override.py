"""
Matching Override API Endpoints
===============================

API for managing manual overrides of EVCC ↔ TeslaMateAPI matching.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime

from app.database import get_db
from app.models.matching_override import MatchingOverride, OverrideType
from app.models.session import SessionModel
from app.schemas.matching_override import (
    MatchingOverrideCreate,
    MatchingOverrideUpdate,
    MatchingOverrideRead,
    MatchingOverrideListResponse,
    MatchingOverrideSingleResponse,
)


router = APIRouter(prefix="/matching/overrides", tags=["Matching Overrides"])


def _override_to_read(override: MatchingOverride) -> MatchingOverrideRead:
    """Convert model to read schema."""
    return MatchingOverrideRead(
        id=override.id,
        teslamate_charge_id=override.teslamate_charge_id,
        evcc_session_id=override.evcc_session_id,
        override_type=override.override_type.value if override.override_type else "",
        reason=override.reason,
        replaced_auto_match=override.replaced_auto_match,
        created_at=override.created_at.isoformat() if override.created_at else "",
        created_by=override.created_by,
    )


@router.get("", response_model=MatchingOverrideListResponse)
def list_overrides(
    db: Session = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List all matching overrides."""
    overrides = db.query(MatchingOverride).order_by(
        MatchingOverride.created_at.desc()
    ).offset(offset).limit(limit).all()
    
    return MatchingOverrideListResponse(
        ok=True,
        overrides=[_override_to_read(o) for o in overrides]
    )


@router.post("", response_model=MatchingOverrideSingleResponse, status_code=status.HTTP_201_CREATED)
def create_override(
    payload: MatchingOverrideCreate,
    db: Session = Depends(get_db),
):
    """Create a new manual override."""
    # Validate override_type
    try:
        override_type = OverrideType(payload.override_type)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid override_type. Must be one of: {[t.value for t in OverrideType]}"
        )
    
    # Validate TM charge exists
    tm_charge = db.query(SessionModel).filter(
        SessionModel.id == payload.teslamate_charge_id,
        SessionModel.source_type == 'external'
    ).first()
    if not tm_charge:
        raise HTTPException(
            status_code=404,
            detail=f"TeslaMate charge {payload.teslamate_charge_id} not found"
        )
    
    # If manual_assign, validate EVCC session exists
    if override_type == OverrideType.manual_assign:
        if payload.evcc_session_id is None:
            raise HTTPException(
                status_code=400,
                detail="evcc_session_id is required for manual_assign"
            )
        evcc_session = db.query(SessionModel).filter(
            SessionModel.id == payload.evcc_session_id,
            SessionModel.source_type == 'home'
        ).first()
        if not evcc_session:
            raise HTTPException(
                status_code=404,
                detail=f"EVCC session {payload.evcc_session_id} not found"
            )
    
    # Check if there's already an active override for this TM charge
    existing = db.query(MatchingOverride).filter(
        MatchingOverride.teslamate_charge_id == payload.teslamate_charge_id
    ).order_by(MatchingOverride.created_at.desc()).first()
    
    # Store replaced auto-match info if exists
    replaced_auto_match = None
    if existing and existing.override_type == OverrideType.manual_assign:
        replaced_auto_match = f"Previous override: EVCC session {existing.evcc_session_id}"
    elif existing:
        replaced_auto_match = f"Previous override: {existing.override_type.value}"
    
    # Create new override
    override = MatchingOverride(
        teslamate_charge_id=payload.teslamate_charge_id,
        evcc_session_id=payload.evcc_session_id if override_type == OverrideType.manual_assign else None,
        override_type=override_type,
        reason=payload.reason,
        replaced_auto_match=replaced_auto_match,
        created_by="admin",  # TODO: get from auth context
    )
    
    db.add(override)
    db.commit()
    db.refresh(override)
    
    return MatchingOverrideSingleResponse(ok=True, override=_override_to_read(override))


@router.delete("/{override_id}", response_model=MatchingOverrideSingleResponse)
def delete_override(
    override_id: int,
    db: Session = Depends(get_db),
):
    """Delete (reset) an override - this effectively removes the manual override."""
    override = db.query(MatchingOverride).filter(MatchingOverride.id == override_id).first()
    if not override:
        raise HTTPException(status_code=404, detail="Override not found")
    
    # Create a reset_to_auto override to mark this as cancelled
    reset_override = MatchingOverride(
        teslamate_charge_id=override.teslamate_charge_id,
        evcc_session_id=None,
        override_type=OverrideType.reset_to_auto,
        reason=f"Reset override #{override.id}: {override.reason}",
        replaced_auto_match=f"Cancelled manual override (type: {override.override_type.value})",
        created_by="admin",
    )
    
    db.add(reset_override)
    db.commit()
    db.refresh(reset_override)
    
    return MatchingOverrideSingleResponse(ok=True, override=_override_to_read(reset_override))


@router.get("/charge/{tm_charge_id}", response_model=MatchingOverrideSingleResponse)
def get_override_for_charge(
    tm_charge_id: int,
    db: Session = Depends(get_db),
):
    """Get the latest active override for a specific TM charge."""
    # Find the latest non-reset override
    override = db.query(MatchingOverride).filter(
        MatchingOverride.teslamate_charge_id == tm_charge_id,
        MatchingOverride.override_type != OverrideType.reset_to_auto
    ).order_by(MatchingOverride.created_at.desc()).first()
    
    if not override:
        raise HTTPException(status_code=404, detail="No active override for this charge")
    
    return MatchingOverrideSingleResponse(ok=True, override=_override_to_read(override))