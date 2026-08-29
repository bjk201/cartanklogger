from sqlalchemy import Column, Integer, Float, DateTime, Text, ForeignKey
from sqlalchemy.sql import func
from app.database import Base


class TireMountModel(Base):
    """Montage-Historie eines Reifensatzes am Fahrzeug.

    Ein Satz kann MEHRFACH montiert werden (Sommer/Winter-Wechsel):
    - Eine offene Montage (demounted_at IS NULL) = Satz ist aktuell montiert.
    - Jede geschlossene Montage kennt km-Stand bei Montage (km_on) und
      bei Demontage (km_off) → gefahrene km je Montage = km_off - km_on.
    - Gefahrene km je Satz = Summe aller geschlossenen Montagen
      (+ für die offene Montage: aktueller Tacho - km_on, im Frontend
      aus dem live abgerufenen TM-Drives-Stand berechnet).

    Ein Satz im Lager (demontiert) hat keine offene Montage und ist NICHT
    archiviert → er kann jederzeit wieder montiert werden. Archivieren ist
    ein SEPARATER Zustand (is_archived am Tire-Record) und beendet die
    weitere Verwendung; er setzt eine geschlossene Montage voraus bzw.
    dass der Satz aktuell nicht montiert ist.
    """
    __tablename__ = "tire_mounts"

    id = Column(Integer, primary_key=True, index=True)
    tire_record_id = Column(
        Integer, ForeignKey("vehicle_records.id"), nullable=False, index=True
    )
    mounted_at = Column(DateTime(timezone=True), nullable=False)   # Datum der Montage
    demounted_at = Column(DateTime(timezone=True), nullable=True)  # NULL = aktuell montiert
    km_on = Column(Float, nullable=True)   # km-Stand bei Montage
    km_off = Column(Float, nullable=True)  # km-Stand bei Demontage (NULL solange montiert)
    note = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return (
            f"<TireMount id={self.id} tire={self.tire_record_id} "
            f"on={self.km_on} off={self.km_off} open={self.demounted_at is None}>"
        )
