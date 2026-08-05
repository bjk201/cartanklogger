from pydantic import BaseModel, Field, HttpUrl
from typing import Optional
from enum import Enum


class ReachabilityLevel(str, Enum):
    """Reachability levels for data sources."""
    REACHABLE = "reachable"           # Base URL responds
    DATA_FETCH_ERROR = "data_fetch_error"  # Base reachable, but data endpoint fails
    UNREACHABLE = "unreachable"       # No connection possible


class EVCCConfig(BaseModel):
    """EVCC configuration fields."""
    base_url: str = Field(default="", description="EVCC Base URL, z.B. http://192.168.1.15:7070")
    api_token: str = Field(default="", description="EVCC API-Token (optional)")


class TeslaMateAPIConfig(BaseModel):
    """TeslaMateAPI configuration fields."""
    base_url: str = Field(default="", description="TeslaMateAPI Base URL, z.B. http://192.168.1.21:8080/api/v1")
    token: str = Field(default="", description="Bearer Token (optional)")


class DataSourceConfigRead(BaseModel):
    """Full data source configuration for reading."""
    # EVCC
    evcc_base_url: str
    evcc_api_token: str
    
    # TeslaMateAPI
    teslamateapi_base_url: str
    teslamateapi_token: str
    
    # Computed
    evcc_configured: bool
    teslamateapi_configured: bool
    data_source: str  # "demo" | "live"
    
    class Config:
        from_attributes = True


class DataSourceConfigWrite(BaseModel):
    """Data source configuration for writing (password/token optional)."""
    # EVCC
    evcc_base_url: str = Field(default="")
    evcc_api_token: Optional[str] = None
    
    # TeslaMateAPI
    teslamateapi_base_url: str = Field(default="")
    teslamateapi_token: Optional[str] = None


class DataSourceConfigTestRequest(BaseModel):
    """Request for testing a single data source connection."""
    source: str  # "evcc" | "teslamateapi"
    # EVCC fields
    evcc_base_url: Optional[str] = None
    evcc_api_token: Optional[str] = None
    # TeslaMateAPI fields
    teslamateapi_base_url: Optional[str] = None
    teslamateapi_token: Optional[str] = None


class ReachabilityStatus(BaseModel):
    """Connection test result."""
    configured: bool
    reachable: bool
    level: ReachabilityLevel = ReachabilityLevel.UNREACHABLE
    status_code: Optional[int] = None
    error: Optional[str] = None
    data_error: Optional[str] = None  # For data fetch errors when reachable


class DataSourceConfigTestResponse(BaseModel):
    """Response for connection test."""
    ok: bool
    source: str
    status: ReachabilityStatus