from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime
import enum


class ChargeType(str, enum.Enum):
    DC = "DC"
    AC = "AC"
    UNKNOWN = "unknown"


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
    
    # Charge type details (for external/TeslaMate sessions)
    charge_type: Optional[ChargeType] = None
    fast_charger_brand: Optional[str] = None
    max_charge_power_kw: Optional[float] = None

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


# Statistics Schemas
class SourceBreakdown(BaseModel):
    """Breakdown by source type"""
    home: float
    external: float
    import_: float = Field(alias="import")
    total: float

    class Config:
        populate_by_name = True


class StatisticsKPIs(BaseModel):
    """Main KPI values for statistics page"""
    total_energy_kwh: float
    total_cost_eur: float
    avg_cost_per_kwh: Optional[float] = None
    total_sessions: int
    home_sessions: int
    external_sessions: int
    import_sessions: int
    
    # Session-based stats
    avg_energy_per_session: Optional[float] = None
    avg_cost_per_session: Optional[float] = None
    max_energy_session: Optional[float] = None
    max_cost_session: Optional[float] = None
    max_energy_session_id: Optional[int] = None
    max_cost_session_id: Optional[int] = None
    
    # DC/AC breakdown for external sessions
    external_dc_sessions: Optional[int] = None
    external_ac_sessions: Optional[int] = None
    external_dc_energy_kwh: Optional[float] = None
    external_ac_energy_kwh: Optional[float] = None
    external_dc_cost_eur: Optional[float] = None
    external_ac_cost_eur: Optional[float] = None


class StatisticsResponse(BaseModel):
    """Response contract for GET /api/statistics"""
    ok: bool = True
    kpis: StatisticsKPIs
    energy_by_source: SourceBreakdown
    cost_by_source: SourceBreakdown
    sessions_by_source: SourceBreakdown
    range_days: int
    range_label: str
    errors: List[ErrorDetail] = []


class OverviewSummaryResponse(BaseModel):
    """Response contract for GET /api/overview/summary"""
    ok: bool = True
    total_sessions: int
    total_energy_kwh: float
    total_cost_eur: float
    avg_cost_per_kwh: Optional[float] = None
    home_sessions: int
    external_sessions: int
    import_sessions: int
    home_energy_kwh: float
    external_energy_kwh: float
    home_cost_eur: float
    external_cost_eur: float
    home_share_pct: float
    errors: List[ErrorDetail] = []