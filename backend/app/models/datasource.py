from sqlalchemy import Column, Integer, String, Boolean, Text, DateTime
from sqlalchemy.sql import func
from app.database import Base


class DataSourceConfig(Base):
    """Persisted data source configuration (EVCC + TeslaMateAPI)."""
    __tablename__ = "data_source_config"

    id = Column(Integer, primary_key=True, index=True)
    
    # EVCC
    evcc_host = Column(String(255), nullable=True, default="")
    evcc_port = Column(Integer, nullable=True, default=7070)
    evcc_password = Column(String(255), nullable=True, default="")
    evcc_api_token = Column(String(255), nullable=True, default="")
    evcc_use_tls = Column(Boolean, nullable=True, default=False)
    
    # TeslaMateAPI
    teslamateapi_base_url = Column(String(500), nullable=True, default="")
    teslamateapi_token = Column(String(500), nullable=True, default="")
    
    # Meta
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    updated_by = Column(String(100), nullable=True, default="admin")