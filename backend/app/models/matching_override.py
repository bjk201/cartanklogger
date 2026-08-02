"""
Matching Override Model
=======================

Persistent model for manual overrides of EVCC ↔ TeslaMateAPI matching.
"""

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Enum as SQLEnum
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
import enum

from app.database import Base


class OverrideType(str, enum.Enum):
    """Type of manual override."""
    manual_assign = "manual_assign"      # TM charge assigned to EVCC session
    manual_unassign = "manual_unassign"  # TM charge unassigned from EVCC session
    reset_to_auto = "reset_to_auto"      # Reset to auto-matching


class MatchingOverride(Base):
    """Manual override for EVCC ↔ TeslaMateAPI matching."""
    __tablename__ = "matching_overrides"

    id = Column(Integer, primary_key=True, index=True)
    
    # The TeslaMate charge being overridden
    teslamate_charge_id = Column(Integer, nullable=False, index=True)
    
    # The EVCC session it's assigned to (nullable for unassign)
    evcc_session_id = Column(Integer, nullable=True, index=True)
    
    # Type of override
    override_type = Column(SQLEnum(OverrideType), nullable=False)
    
    # Reason/note for audit trail
    reason = Column(Text, nullable=True)
    
    # If this override replaced an auto-match, store the original
    replaced_auto_match = Column(Text, nullable=True)  # JSON of original match info
    
    # Audit
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by = Column(String(100), nullable=True)  # e.g., "admin", "user"
    
    def to_dict(self):
        return {
            "id": self.id,
            "teslamate_charge_id": self.teslamate_charge_id,
            "evcc_session_id": self.evcc_session_id,
            "override_type": self.override_type.value if self.override_type else None,
            "reason": self.reason,
            "replaced_auto_match": self.replaced_auto_match,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "created_by": self.created_by,
        }