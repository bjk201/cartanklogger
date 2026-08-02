"""
Matching Override Schemas
=========================

Pydantic schemas for matching override API.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Any
from datetime import datetime


class MatchingOverrideBase(BaseModel):
    """Base fields for matching override."""
    teslamate_charge_id: int = Field(..., description="TeslaMate charge ID")
    evcc_session_id: Optional[int] = Field(None, description="EVCC session ID (nullable for unassign)")
    override_type: str = Field(..., description="manual_assign | manual_unassign | reset_to_auto")
    reason: Optional[str] = Field(None, description="Reason for override")


class MatchingOverrideCreate(MatchingOverrideBase):
    """Create override request."""
    pass


class MatchingOverrideUpdate(BaseModel):
    """Update override request (reason only)."""
    reason: Optional[str] = None


class MatchingOverrideRead(BaseModel):
    """Override response."""
    id: int
    teslamate_charge_id: int
    evcc_session_id: Optional[int]
    override_type: str
    reason: Optional[str]
    replaced_auto_match: Optional[str]
    created_at: str
    created_by: Optional[str]

    class Config:
        from_attributes = True


class MatchingOverrideListResponse(BaseModel):
    """List response."""
    ok: bool = True
    overrides: List[MatchingOverrideRead]


class MatchingOverrideSingleResponse(BaseModel):
    """Single override response."""
    ok: bool = True
    override: MatchingOverrideRead