from pydantic import BaseModel, Field
from typing import List, Optional, Literal, Dict
from datetime import datetime


# Bekannte Kosten-Kategorien (Freitext-String, kein Enum — abwärtskompatibel)
VEHICLE_CATEGORIES = (
    "anschaffung",
    "anmeldung",
    "inspektion_wartung",
    "reparatur",
    "zubehoer",
    "reinigung_pflege",
    "versicherung",
    "steuer",
    "sonstiges",
)


class VehicleRecordCreate(BaseModel):
    """Create a service or tire record."""
    record_type: Literal["service", "tire"]
    date: datetime
    title: str = Field(..., min_length=1, max_length=255)
    odometer_km: Optional[float] = None
    cost_eur: Optional[float] = None
    note: Optional[str] = None
    shop: Optional[str] = None
    category: Optional[str] = Field(default=None, max_length=40)  # s. VEHICLE_CATEGORIES
    # Tire-specific
    tire_position: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None


class VehicleRecordUpdate(BaseModel):
    """Update a service/tire record (all fields optional)."""
    date: Optional[datetime] = None
    title: Optional[str] = None
    odometer_km: Optional[float] = None
    cost_eur: Optional[float] = None
    note: Optional[str] = None
    shop: Optional[str] = None
    category: Optional[str] = Field(default=None, max_length=40)  # s. VEHICLE_CATEGORIES
    tire_position: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None


class VehicleRecordRead(BaseModel):
    """Response schema for a single service/tire record."""
    id: int
    record_type: Literal["service", "tire"]
    date: datetime
    title: str
    odometer_km: Optional[float] = None
    cost_eur: Optional[float] = None
    note: Optional[str] = None
    shop: Optional[str] = None
    category: Optional[str] = None
    tire_position: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None
    start_odometer_km: Optional[float] = None
    replaced_by: Optional[int] = None
    is_active: bool = True          # Satz aktuell montiert?
    is_archived: bool = False       # Satz archiviert (separater Endzustand)
    mounts: List["TireMountRead"] = []  # Montage-Historie (nur Reifen)

    class Config:
        from_attributes = True


class TireMountRead(BaseModel):
    """Eine Montage-Periode eines Reifensatzes am Fahrzeug."""
    id: int
    tire_record_id: int
    mounted_at: datetime
    demounted_at: Optional[datetime] = None  # NULL = aktuell montiert
    km_on: Optional[float] = None
    km_off: Optional[float] = None
    note: Optional[str] = None

    class Config:
        from_attributes = True


class TireDemountRequest(BaseModel):
    """Satz abmontieren (kommt ins Lager, NICHT archiviert)."""
    date: datetime
    odometer_km: Optional[float] = None  # km-Stand bei Demontage (leer = Auto-Ableitung)
    note: Optional[str] = None


class TireMountRequest(BaseModel):
    """Satz aus dem Lager wieder montieren."""
    date: datetime
    odometer_km: Optional[float] = None  # km-Stand bei Montage (leer = Auto-Ableitung)
    note: Optional[str] = None


class TireReplaceRequest(BaseModel):
    """Replace an active tire set with a new one."""
    date: datetime
    odometer_km: Optional[float] = None  # km-Stand beim Wechsel (leer = Auto-Ableitung)
    title: str = Field(..., min_length=1, max_length=255)
    note: Optional[str] = None
    shop: Optional[str] = None
    tire_brand: Optional[str] = None
    tire_season: Optional[str] = None
    tire_position: Optional[str] = None
    cost_eur: Optional[float] = None  # Kosten des NEUEN Satzes


class VehicleInfo(BaseModel):
    """Vehicle identity info fetched live from TeslaMate."""
    car_id: Optional[int] = None
    name: Optional[str] = None
    vin: Optional[str] = None
    model: Optional[str] = None
    current_odometer_km: Optional[float] = None  # latest odometer seen
    source: str  # 'teslamate' | 'none'


class VehicleRecordsResponse(BaseModel):
    """Response for GET /vehicle/records."""
    ok: bool = True
    services: List[VehicleRecordRead] = []
    tires: List[VehicleRecordRead] = []
    errors: List = []


class VehicleSingleResponse(BaseModel):
    """Response for GET/POST/PUT/DELETE single record."""
    ok: bool = True
    data: Optional[VehicleRecordRead] = None
    errors: List = []


class VehicleInfoResponse(BaseModel):
    """Response for GET /vehicle/info."""
    ok: bool = True
    data: Optional[VehicleInfo] = None
    errors: List = []


class CategoryCost(BaseModel):
    """Eine Kosten-Kategorie in der Auswertung."""
    key: str                        # 'anschaffung' | ... | '_tires' | '_unsorted'
    label: str                      # 'Anschaffung' | ... | 'Reifen' | 'Ohne Kategorie'
    total_eur: float = 0.0
    count: int = 0                  # Anzahl Einträge in dieser Kategorie


class VehicleCostSummaryResponse(BaseModel):
    """Antwort auf GET /api/vehicle/cost-summary — aggregierte Auswertung."""
    ok: bool = True
    total_eur: float = 0.0          # Summe ALLER Einträge (Service + Reifen)
    tire_total_eur: float = 0.0     # nur Reifen
    service_total_eur: float = 0.0  # nur Service-Einträge
    categories: List[CategoryCost] = []

    # km-Achse für €/km-Berechnung
    odometer_start_km: Optional[float] = None     # frühester Record mit odometer_km
    odometer_start_date: Optional[datetime] = None # dessen Datum
    odometer_current_km: Optional[float] = None   # Live (TeslaMate, sonst max-Session)
    km_driven: Optional[float] = None             # current - start

    # Pro-km-Kosten
    eur_per_km_with_purchase: float = 0.0         # alle Kosten / gefahrene km
    eur_per_km_without_purchase: float = 0.0      # ohne Anschaffung

    # Jahres-Hochrechnung
    estimated_yearly_eur: float = 0.0
    estimated_yearly_breakdown: Dict[str, float] = {}

    errors: List = []
