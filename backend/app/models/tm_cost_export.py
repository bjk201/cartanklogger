"""Models for the TM cost export (EVCC -> TeslaMate charging_processes.cost writeback).

Kernprinzipien:
- Writeback ist NIE automatisch; jede Ausführung braucht explizite Nutzerfreigabe.
- Allokation ist idempotent (unique key evcc_session_id + tm_charge_id).
- Ein TM-Charge darf nur in einer exportierbaren EVCC-Allokation vorkommen.
"""
from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Text, UniqueConstraint, Index,
)
from sqlalchemy.sql import func
from app.database import Base


class SessionCostAllocation(Base):
    """Anteilige Kostenallokation einer EVCC-Session auf gematchte TM-Charges.

    allocation_basis ist immer 'tm_used_kwh': die EVCC-Gesamtkosten werden
    proportional zu charge_energy_used der TM-Fragmente verteilt.
    """
    __tablename__ = "session_cost_allocations"
    __table_args__ = (
        # Idempotenz: wiederholte Berechnung überschreibt dieselbe Zeile.
        UniqueConstraint("evcc_session_id", "tm_charge_id", name="uq_alloc_evcc_tm"),
        Index("ix_alloc_evcc_session", "evcc_session_id"),
        Index("ix_alloc_tm_charge", "tm_charge_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    evcc_session_id = Column(Integer, nullable=False)
    tm_charge_id = Column(Integer, nullable=False)
    # TeslaMate charging_processes.id — Pflichtfeld für den späteren Writeback.
    tm_charging_process_id = Column(Integer, nullable=False)
    match_quality = Column(String(20), nullable=False)  # exact|plausible|manual_override
    allocation_basis = Column(String(30), nullable=False, default="tm_used_kwh")

    # EVCC-Seite (führend für Kosten + Wallbox-kWh)
    evcc_energy_kwh = Column(Float, nullable=False)
    evcc_total_cost_eur = Column(Float, nullable=False)

    # TM-Seite (führend für used-kWh und IDs)
    tm_used_kwh = Column(Float, nullable=False)
    tm_used_kwh_total = Column(Float, nullable=False)

    effective_price_eur_per_kwh = Column(Float, nullable=True)
    allocated_cost_eur = Column(Float, nullable=False)  # 2 Nachkommastellen (Cent-genau)

    exclusion_reason = Column(String(200), nullable=True)  # null = exportierbar
    calculation_version = Column(String(20), nullable=False)
    calculated_at = Column(DateTime(timezone=True), server_default=func.now())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "evcc_session_id": self.evcc_session_id,
            "tm_charge_id": self.tm_charge_id,
            "tm_charging_process_id": self.tm_charging_process_id,
            "match_quality": self.match_quality,
            "allocation_basis": self.allocation_basis,
            "evcc_energy_kwh": self.evcc_energy_kwh,
            "evcc_total_cost_eur": self.evcc_total_cost_eur,
            "tm_used_kwh": self.tm_used_kwh,
            "tm_used_kwh_total": self.tm_used_kwh_total,
            "effective_price_eur_per_kwh": self.effective_price_eur_per_kwh,
            "allocated_cost_eur": self.allocated_cost_eur,
            "exclusion_reason": self.exclusion_reason,
            "calculation_version": self.calculation_version,
            "calculated_at": self.calculated_at.isoformat() if self.calculated_at else None,
        }


class TMCostExport(Base):
    """Audit-Log für echte TeslaMate-Writebacks. draft -> approved -> exported
    (+ failed / rolled_back). Ohne approved-Zeile kein Execute."""
    __tablename__ = "tm_cost_exports"
    __table_args__ = (
        UniqueConstraint("evcc_session_id", "tm_charge_id", name="uq_export_evcc_tm"),
        Index("ix_export_evcc_session", "evcc_session_id"),
        Index("ix_export_status", "status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    evcc_session_id = Column(Integer, nullable=False)
    tm_charge_id = Column(Integer, nullable=False)
    tm_charging_process_id = Column(Integer, nullable=False)
    allocation_id = Column(Integer, nullable=False)

    previous_tm_cost_eur = Column(Float, nullable=True)
    new_tm_cost_eur = Column(Float, nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    exported_at = Column(DateTime(timezone=True), nullable=True)
    rolled_back_at = Column(DateTime(timezone=True), nullable=True)

    status = Column(String(20), nullable=False, default="draft")  # draft|approved|exported|failed|rolled_back
    error_message = Column(Text, nullable=True)
    export_batch_id = Column(String(40), nullable=True)
    calculation_version = Column(String(20), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "evcc_session_id": self.evcc_session_id,
            "tm_charge_id": self.tm_charge_id,
            "tm_charging_process_id": self.tm_charging_process_id,
            "allocation_id": self.allocation_id,
            "previous_tm_cost_eur": self.previous_tm_cost_eur,
            "new_tm_cost_eur": self.new_tm_cost_eur,
            "approved_at": self.approved_at.isoformat() if self.approved_at else None,
            "exported_at": self.exported_at.isoformat() if self.exported_at else None,
            "rolled_back_at": self.rolled_back_at.isoformat() if self.rolled_back_at else None,
            "status": self.status,
            "error_message": self.error_message,
            "export_batch_id": self.export_batch_id,
            "calculation_version": self.calculation_version,
        }
