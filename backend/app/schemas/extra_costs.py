from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime


class ExtraCostCreate(BaseModel):
    """Create an extra cost entry."""
    date: datetime
    title: str = Field(..., min_length=1, max_length=255)
    category: Literal["VERSICHERUNG", "ZUBEHOER", "STEUER", "SONSTIGES", "REIFENKAUF"]
    cost_eur: float = Field(..., gt=0)
    note: Optional[str] = None
    linked_tire_id: Optional[int] = None


class ExtraCostUpdate(BaseModel):
    """Update an extra cost entry (all fields optional)."""
    date: Optional[datetime] = None
    title: Optional[str] = None
    category: Optional[Literal["VERSICHERUNG", "ZUBEHOER", "STEUER", "SONSTIGES", "REIFENKAUF"]] = None
    cost_eur: Optional[float] = Field(None, gt=0)
    note: Optional[str] = None
    linked_tire_id: Optional[int] = None


class ExtraCostRead(BaseModel):
    """Response schema for a single extra cost entry."""
    id: int
    date: datetime
    title: str
    category: Literal["VERSICHERUNG", "ZUBEHOER", "STEUER", "SONSTIGES", "REIFENKAUF"]
    cost_eur: float
    note: Optional[str] = None
    linked_tire_id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ExtraCostListResponse(BaseModel):
    """Response for GET /extra-costs."""
    ok: bool = True
    data: List[ExtraCostRead] = []
    errors: List = []


class ExtraCostSingleResponse(BaseModel):
    """Response for GET/POST/PUT/DELETE single extra cost."""
    ok: bool = True
    data: Optional[ExtraCostRead] = None
    errors: List = []