from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime


class SessionRead(BaseModel):
    """Response schema for a single session."""
    id: int = Field(..., description="Database primary key (unique)")
    source_type: Literal["home", "external", "import"]
    source_id: str = Field(..., description="Original source ID")
    date: datetime
    location: Optional[str] = None
    energy_kwh: Optional[float] = None
    cost_eur: Optional[float] = None
    odometer_km: Optional[float] = None
    distance_km: Optional[float] = None
    note: Optional[str] = None
    # PV / Solar data (from EVCC home_sessions)
    solar_percentage: Optional[float] = None
    pv_kwh: Optional[float] = None
    
    # Cost per kWh (price per unit energy)
    # For EVCC: directly from pricePerKWh API field (source='api')
    # For TeslaMate: derived from cost / charge_energy_added (source='derived')
    cost_per_kwh: Optional[float] = None
    cost_per_kwh_source: Optional[Literal["api", "derived"]] = None

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


class PaginationInfo(BaseModel):
    page: int
    page_size: int
    total: int
    total_pages: int
    has_next: bool
    has_prev: bool


class PaginatedSessionsResponse(BaseModel):
    """Response contract for GET /api/sessions"""
    ok: bool = True
    data: List[SessionRead]
    meta: MetaInfo
    pagination: PaginationInfo
    errors: List[ErrorDetail] = []