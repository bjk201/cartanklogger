from sqlalchemy import Column, Integer, String, Float, DateTime, Text
from sqlalchemy.sql import func
from app.database import Base


class SessionModel(Base):
    """Unified session model for both home and external charging sessions."""
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    source_id = Column(String(100), nullable=False, index=True)  # Original ID from source
    source_type = Column(String(20), nullable=False, index=True)  # home, external, import
    
    date = Column(DateTime(timezone=True), nullable=False, index=True)
    location = Column(String(255), nullable=True)
    energy_kwh = Column(Float, nullable=True)
    cost_eur = Column(Float, nullable=True)
    odometer_km = Column(Float, nullable=True)
    distance_km = Column(Float, nullable=True)
    note = Column(Text, nullable=True)
    
    # PV / Solar data (from EVCC home_sessions)
    solar_percentage = Column(Float, nullable=True)
    pv_kwh = Column(Float, nullable=True)
    
    # Cost per kWh (price per unit energy)
    # For EVCC: directly from pricePerKWh API field (source='api')
    # For TeslaMate: derived from cost / charge_energy_added (source='derived')
    cost_per_kwh = Column(Float, nullable=True)
    cost_per_kwh_source = Column(String(20), nullable=True)  # 'api' | 'derived'
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    
    # Migration metadata
    legacy_source = Column(String(50), nullable=True)      # evcc, teslamate, manual
    legacy_table = Column(String(50), nullable=True)       # home_sessions, external_sessions
    legacy_id = Column(Integer, nullable=True)             # Original PK from legacy table
    imported_at = Column(DateTime(timezone=True), nullable=True)
    import_status = Column(String(50), nullable=True)      # imported, quarantine:..., duplicate_suppressed


class SeedDataModel(Base):
    """Marker table to track if seed data has been inserted."""
    __tablename__ = "seed_data_status"

    id = Column(Integer, primary_key=True)
    version = Column(String(50), nullable=False)
    inserted_at = Column(DateTime(timezone=True), server_default=func.now())