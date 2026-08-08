from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime


class VehicleRecordCreate(BaseModel):
    """Create a service or tire record."""
    record_type: Literal["service", "tire"]
    date: datetime
    title: str = Field(..., min_length=1, max_length=255)
    odometer_km: Optional[float] = None
    cost_eur: Optional[float] = None
    note: Optional[str] = None
    shop: Optional[str] = None
    # Tire-specific
    tire_position: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None


class VehicleRecordUpdate(BaseModel):
    """Update a service or tire record (all fields optional)."""
    date: Optional[datetime] = None
    title: Optional[str] = None
    odometer_km: Optional[float] = None
    cost_eur: Optional[float] = None
    note: Optional[str] = None
    shop: Optional[str] = None
    tire_position: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None


class VehicleRecordRead(BaseModel):
    """Response schema for a single service/tire record."""
    id: int
    record_type: Literal["service", "tire"]
    date: datetime
    title: str
    odometer_km: Optional[float] = None
    cost_eur: Optional[float] = None
    note: Optional[str] = None
    shop: Optional[str] = None
    tire_position: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None
    start_odometer_km: Optional[float] = None
    replaced_by: Optional[int] = None
    is_active: bool = True

    class Config:
        from_attributes = True


class TireReplaceRequest(BaseModel):
    """Replace an existing tire with a new one."""
    date: datetime
    odometer_km: Optional[float] = None
    title: str = Field(..., min_length=1, max_length=255)
    note: Optional[str] = None
    shop: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None
    tire_position: Optional[str] = None
    replaces_tire_id: int


class VehicleInfo(BaseModel):
    """Vehicle identity info fetched live from TeslaMate."""
    car_id: Optional[int] = None
    name: Optional[str] = None
    vin: Optional[str] = None
    model: Optional[str] = None
    current_odometer_km: Optional[float] = None  # latest odometer seen
    source: str  # 'teslamate' | 'none'


class VehicleRecordsResponse(BaseModel):
    """Response for GET /vehicle/records."""
    ok: bool = True
    services: List[VehicleRecordRead] = []
    tires: List[VehicleRecordRead] = []
    errors: List = []


class VehicleSingleResponse(BaseModel):
    """Response for GET/POST/PUT/DELETE single record."""
    ok: bool = True
    data: Optional[VehicleRecordRead] = None
    errors: List = []


class VehicleInfoResponse(BaseModel):
    """Response for GET /vehicle/info."""
    ok: bool = True
    data: Optional[VehicleInfo] = None
    errors: List = []
