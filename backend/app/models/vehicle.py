from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, Enum as SQLEnum
from sqlalchemy import ForeignKey
from sqlalchemy.sql import func
from app.database import Base
import enum


class VehicleRecordType(str, enum.Enum):
    """Type of vehicle record: service (Wartung) or tire (Reifen)."""
    SERVICE = "service"
    TIRE = "tire"


class VehicleRecordModel(Base):
    """Manually maintained vehicle records (service history and tire changes).

    EVCC and TeslaMate do not provide service/tire history, so these records
    are created/edited by the user in the app. Only vehicle identity info
    (model, VIN, name) is read live from TeslaMate.
    """
    __tablename__ = "vehicle_records"

    id = Column(Integer, primary_key=True, index=True)
    record_type = Column(SQLEnum(VehicleRecordType), nullable=False, index=True)  # service | tire

    # Common fields
    date = Column(DateTime(timezone=True), nullable=False, index=True)
    title = Column(String(255), nullable=False)          # e.g. "Inspektion", "Reifenwechsel Sommer"
    odometer_km = Column(Float, nullable=True)           # km-Stand bei Eintrag
    cost_eur = Column(Float, nullable=True)              # optional costs
    note = Column(Text, nullable=True)                   # optional notes
    shop = Column(String(255), nullable=True)            # optionally: Werkstatt

    # Tire-specific
    tire_position = Column(String(20), nullable=True)    # VA/HA or 1-4
    tire_brand = Column(String(50), nullable=True)
    tire_season = Column(String(20), nullable=True)      # Sommer | Winter | Ganzjahres

    # Tire chain / replacement tracking
    start_odometer_km = Column(Float, nullable=True, default=None)  # km-Stand bei neuer Reifengarnitur
    replaced_by = Column(Integer, ForeignKey('vehicle_records.id'), nullable=True, default=None)  # FK to replacement tire record
    is_active = Column(Boolean, nullable=False, default=True)       # whether this tire is still in use

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<VehicleRecord id={self.id} type={self.record_type} title={self.title!r}>"
