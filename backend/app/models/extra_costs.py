from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Enum as SQLEnum
from sqlalchemy import ForeignKey
from sqlalchemy.sql import func
from app.database import Base
import enum


class ExtraCostCategory(str, enum.Enum):
    """Category of extra cost."""
    VERSICHERUNG = "VERSICHERUNG"
    ZUBEHOER = "ZUBEHOER"
    STEUER = "STEUER"
    SONSTIGES = "SONSTIGES"
    REIFENKAUF = "REIFENKAUF"


class ExtraCostModel(Base):
    """Extra costs like insurance, accessories, taxes, tyre purchases, etc."""
    __tablename__ = "extra_costs"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(DateTime(timezone=True), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    category = Column(SQLEnum(ExtraCostCategory), nullable=False, index=True)
    cost_eur = Column(Float, nullable=False)
    note = Column(Text, nullable=True)

    # Optional FK to vehicle_records (for REIFENKAUF category)
    linked_tire_id = Column(
        Integer,
        ForeignKey("vehicle_records.id", ondelete="SET NULL"),
        nullable=True,
        default=None,
    )

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<ExtraCost id={self.id} category={self.category} title={self.title!r} cost={self.cost_eur}>"