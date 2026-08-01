from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime


class SessionRead(BaseModel):
    """Response schema for a single session."""
    id: str = Field(..., description="Unique identifier: {source_type}:{source_id}")
    date: datetime
    source_type: Literal["home", "external", "import"]
    location: Optional[str] = None
    energy_kwh: Optional[float] = None
    cost_eur: Optional[float] = None
    odometer_km: Optional[float] = None
    distance_km: Optional[float] = None
    note: Optional[str] = None

    class Config:
        from_attributes = True


class MetaInfo(BaseModel):
    count: int
    limit: int


class ErrorDetail(BaseModel):
    code: str
    message: str
    field: Optional[str] = None


class OverviewResponse(BaseModel):
    """MVP Response Contract: GET /api/overview/recent-sessions"""
    ok: bool = True
    data: List[SessionRead]
    meta: MetaInfo
    errors: List[ErrorDetail] = []


class HealthResponse(BaseModel):
    ok: bool = True
    service: str
    version: str
    database: str