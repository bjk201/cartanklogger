from pydantic import BaseModel, Field, HttpUrl
from typing import Optional


class EVCCConfig(BaseModel):
    """EVCC configuration fields."""
    host: str = Field(default="", description="EVCC Hostname oder IP")
    port: int = Field(default=7070, ge=1, le=65535, description="EVCC Port")
    password: str = Field(default="", description="EVCC Admin-Passwort (optional)")
    api_token: str = Field(default="", description="EVCC API-Token (optional, alternativ zu Passwort)")
    use_tls: bool = Field(default=False, description="HTTPS verwenden")


class TeslaMateAPIConfig(BaseModel):
    """TeslaMateAPI configuration fields."""
    base_url: str = Field(default="", description="TeslaMateAPI Base URL, z.B. http://192.168.1.21:8080/api/v1")
    token: str = Field(default="", description="Bearer Token (optional)")


class DataSourceConfigRead(BaseModel):
    """Full data source configuration for reading."""
    # EVCC
    evcc_host: str
    evcc_port: int
    evcc_password: str  # wird nicht im Frontend angezeigt, nur gesetzt
    evcc_api_token: str
    evcc_use_tls: bool
    
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
    host: str = Field(default="")
    port: int = Field(default=7070, ge=1, le=65535)
    password: Optional[str] = None
    api_token: Optional[str] = None
    use_tls: bool = False
    
    # TeslaMateAPI
    base_url: str = Field(default="")
    token: Optional[str] = None


class DataSourceConfigTestRequest(BaseModel):
    """Request for testing a single data source connection."""
    source: str  # "evcc" | "teslamateapi"
    # EVCC fields
    host: Optional[str] = None
    port: Optional[int] = None
    password: Optional[str] = None
    api_token: Optional[str] = None
    use_tls: Optional[bool] = None
    # TeslaMateAPI fields
    base_url: Optional[str] = None
    token: Optional[str] = None


class ReachabilityStatus(BaseModel):
    """Connection test result."""
    configured: bool
    reachable: bool
    status_code: Optional[int] = None
    error: Optional[str] = None


class DataSourceConfigTestResponse(BaseModel):
    """Response for connection test."""
    ok: bool
    source: str
    status: ReachabilityStatus