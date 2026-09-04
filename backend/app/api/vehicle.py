from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timezone, date as date_cls, timedelta
from typing import List, Optional, Dict

from app.database import get_db
from app.models.vehicle import VehicleRecordModel, VehicleRecordType
from app.models.tire_mount import TireMountModel
from app.models.datasource import DataSourceConfig
from app.services.teslamateapi_client import TeslaMateAPIClient
from app.config import settings
from app.schemas.vehicle import (
    VehicleRecordCreate,
    VehicleRecordUpdate,
    VehicleRecordRead,
    VehicleRecordsResponse,
    VehicleSingleResponse,
    VehicleInfo,
    VehicleInfoResponse,
    TireReplaceRequest,
    TireMountRequest,
    TireDemountRequest,
    TireMountRead,
    VEHICLE_CATEGORIES,
    VehicleCostSummaryResponse,
    CategoryCost,
)


def _create_teslamateapi_client_from_config(config: Optional[DataSourceConfig]) -> Optional[TeslaMateAPIClient]:
    """Factory: erstellt TeslaMateAPIClient aus DB-Config oder ENV-Fallback."""
    tm_url = None
    tm_token = None
    if config is not None and getattr(config, "teslamateapi_base_url", None):
        tm_url = config.teslamateapi_base_url
        tm_token = getattr(config, "teslamateapi_token", None)
    if not tm_url:
        tm_url = getattr(settings, "TESLAMATEAPI_BASE_URL", None) or None
    if not tm_url:
        return None
    return TeslaMateAPIClient(tm_url, tm_token)

router = APIRouter(prefix="/vehicle", tags=["Vehicle"])


def _max_known_odometer(db: Session) -> Optional[float]:
    """Max. bekannter km-Stand aus Sessions + Vehicle-Records (Fallback-Ableitung)."""
    from app.models.session import SessionModel
    max_rec = db.query(func.max(VehicleRecordModel.odometer_km)).scalar()
    max_sess = db.query(func.max(SessionModel.odometer_km)).scalar()
    candidates = [v for v in (max_rec, max_sess) if v is not None]
    return max(candidates) if candidates else None


def _resolve_km_or_auto(
    db: Session,
    explicit: Optional[float],
    fallback_rec: Optional[VehicleRecordModel] = None,
) -> Optional[float]:
    """km-Stand ermitteln: übergeben > letzter Stand des Satzes > max. bekannter km."""
    if explicit is not None:
        return explicit
    if fallback_rec is not None and fallback_rec.odometer_km is not None:
        return fallback_rec.odometer_km
    return _max_known_odometer(db)


def _get_open_mount(db: Session, tire_record_id: int) -> Optional[TireMountModel]:
    """Offene Montage eines Satzes (demounted_at IS NULL) oder None."""
    return (
        db.query(TireMountModel)
        .filter(
            TireMountModel.tire_record_id == tire_record_id,
            TireMountModel.demounted_at.is_(None),
        )
        .first()
    )


def _mounts_for(db: Session, tire_record_id: int) -> List[TireMountModel]:
    return (
        db.query(TireMountModel)
        .filter(TireMountModel.tire_record_id == tire_record_id)
        .order_by(TireMountModel.mounted_at.asc(), TireMountModel.id.asc())
        .all()
    )


def _get_tire_or_404(record_id: int, db: Session) -> VehicleRecordModel:
    rec = (
        db.query(VehicleRecordModel)
        .filter(
            VehicleRecordModel.id == record_id,
            VehicleRecordModel.record_type == VehicleRecordType.TIRE,
        )
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Reifen-Eintrag nicht gefunden")
    return rec


def _to_read(
    rec: VehicleRecordModel,
    mounts: Optional[List[TireMountModel]] = None,
) -> VehicleRecordRead:
    return VehicleRecordRead(
        id=rec.id,
        record_type=rec.record_type.value,
        date=rec.date,
        title=rec.title,
        odometer_km=rec.odometer_km,
        cost_eur=rec.cost_eur,
        note=rec.note,
        shop=rec.shop,
        category=getattr(rec, "category", None),
        tire_position=rec.tire_position,
        tire_brand=rec.tire_brand,
        tire_season=rec.tire_season,
        start_odometer_km=rec.start_odometer_km,
        replaced_by=rec.replaced_by,
        is_active=rec.is_active,
        is_archived=bool(getattr(rec, "is_archived", False)),
        mounts=[TireMountRead.model_validate(m) for m in mounts] if mounts else [],
    )


@router.get("/records", response_model=VehicleRecordsResponse, summary="Get service and tire records")
def get_vehicle_records(db: Session = Depends(get_db)) -> VehicleRecordsResponse:
    """Return all vehicle records, split into services and tires, newest first.

    Reifensätze enthalten ihre komplette Montage-Historie (mounts).
    """
    records = db.query(VehicleRecordModel).order_by(
        VehicleRecordModel.date.desc()
    ).all()

    all_mounts = db.query(TireMountModel).order_by(TireMountModel.mounted_at.asc()).all()
    mounts_by_tire: dict[int, List[TireMountModel]] = {}
    for m in all_mounts:
        mounts_by_tire.setdefault(m.tire_record_id, []).append(m)

    services = []
    tires = []
    for rec in records:
        if rec.record_type == VehicleRecordType.SERVICE:
            services.append(_to_read(rec))
        else:
            tires.append(_to_read(rec, mounts_by_tire.get(rec.id, [])))

    return VehicleRecordsResponse(ok=True, services=services, tires=tires, errors=[])


@router.get("/records/{record_id}", response_model=VehicleSingleResponse, summary="Get single vehicle record")
def get_vehicle_record(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")
    mounts = _mounts_for(db, rec.id) if rec.record_type == VehicleRecordType.TIRE else None
    return VehicleSingleResponse(ok=True, data=_to_read(rec, mounts), errors=[])


@router.post("/records", response_model=VehicleSingleResponse, status_code=201, summary="Create service/tire record")
def create_vehicle_record(payload: VehicleRecordCreate, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    rec = VehicleRecordModel(
        record_type=VehicleRecordType(payload.record_type),
        date=payload.date,
        title=payload.title,
        odometer_km=payload.odometer_km,
        cost_eur=payload.cost_eur,
        note=payload.note,
        shop=payload.shop,
        category=payload.category,
        tire_position=payload.tire_position,
        tire_brand=payload.tire_brand,
        tire_season=payload.tire_season,
    )
    if rec.record_type == VehicleRecordType.TIRE:
        # Reifensatz: Start-km = km-Stand beim Anlegen → gefahrene km bilanzierbar
        if payload.odometer_km is not None:
            rec.start_odometer_km = payload.odometer_km
        # Erste Montage: ein neuer Satz gilt als sofort montiert
        db.add(rec)
        db.flush()  # rec.id für die Montage holen
        db.add(TireMountModel(
            tire_record_id=rec.id,
            mounted_at=payload.date,
            demounted_at=None,
            km_on=payload.odometer_km,
            km_off=None,
            note=None,
        ))
        db.commit()
        db.refresh(rec)
        return VehicleSingleResponse(
            ok=True,
            data=_to_read(rec, _mounts_for(db, rec.id)),
            errors=[],
        )

    db.add(rec)
    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec), errors=[])


@router.put("/records/{record_id}", response_model=VehicleSingleResponse, summary="Update service/tire record")
def update_vehicle_record(record_id: int, payload: VehicleRecordUpdate, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")

    patch = payload.model_dump(exclude_unset=True)
    for field, value in patch.items():
        setattr(rec, field, value)
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    mounts = _mounts_for(db, rec.id) if rec.record_type == VehicleRecordType.TIRE else None
    return VehicleSingleResponse(ok=True, data=_to_read(rec, mounts), errors=[])


@router.put("/records/{record_id}/replace-tire", response_model=VehicleSingleResponse, summary="Swap the mounted tire set for a new set")
def replace_tire(record_id: int, payload: TireReplaceRequest, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Wechselt den MONTIERTEN Reifensatz gegen einen neuen Satz.

    Semantik seit Aug 2026: Der alte Satz wird NICHT archiviert — er kommt
    ins LAGER (is_active=False, keine offene Montage) und kann beliebig oft
    wieder montiert werden. Archivieren ist ein SEPARATER Endzustand
    (POST /records/{id}/archive).

    - Offene Montage des alten Satzes wird geschlossen (km_off = Wechsel-km)
      → die gefahrene km-Bilanz dieser Montage bleibt erhalten.
    - Der neue Satz wird angelegt (start_odometer_km = Wechsel-km) und
      sofort montiert (offene Montage, km_on = Wechsel-km).
    - km leer = Auto-Ableitung: letzter Stand des alten Satzes > max. known km.
    """
    old_rec = _get_tire_or_404(record_id, db)
    if not old_rec.is_active:
        raise HTTPException(status_code=409, detail="Nur der montierte Reifensatz kann getauscht werden")
    if old_rec.is_archived:
        raise HTTPException(status_code=409, detail="Archivierte Sätze können nicht getauscht werden")

    odometer = _resolve_km_or_auto(db, payload.odometer_km, fallback_rec=old_rec)

    # 1) Offene Montage des alten Satzes schließen
    open_mount = (
        db.query(TireMountModel)
        .filter(
            TireMountModel.tire_record_id == old_rec.id,
            TireMountModel.demounted_at.is_(None),
        )
        .first()
    )
    if open_mount:
        open_mount.demounted_at = payload.date
        open_mount.km_off = odometer
        open_mount.updated_at = datetime.now(timezone.utc)

    # 2) Neuen Satz anlegen und montieren
    new_rec = VehicleRecordModel(
        record_type=VehicleRecordType.TIRE,
        date=payload.date,
        title=payload.title,
        odometer_km=odometer,
        cost_eur=payload.cost_eur,
        note=payload.note,
        shop=payload.shop,
        tire_position=payload.tire_position or old_rec.tire_position,
        tire_brand=payload.tire_brand or old_rec.tire_brand,
        tire_season=payload.tire_season or old_rec.tire_season,
        start_odometer_km=odometer,
        is_active=True,
        is_archived=False,
    )
    db.add(new_rec)
    db.flush()
    db.add(TireMountModel(
        tire_record_id=new_rec.id,
        mounted_at=payload.date,
        demounted_at=None,
        km_on=odometer,
        km_off=None,
        note=payload.note,
    ))

    # 3) Alten Satz demontiert — bewusst NICHT archiviert
    old_rec.is_active = False
    old_rec.replaced_by = new_rec.id  # Herkunft/Wechselkette (rein informativ)
    if odometer is not None:
        old_rec.odometer_km = odometer
    if old_rec.start_odometer_km is None and odometer is not None:
        old_rec.start_odometer_km = odometer
    old_rec.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(new_rec)
    return VehicleSingleResponse(
        ok=True,
        data=_to_read(new_rec, _mounts_for(db, new_rec.id)),
        errors=[],
    )


@router.post("/records/{record_id}/demount", response_model=VehicleSingleResponse, summary="Demount a mounted tire set (goes to storage)")
def demount_tire(record_id: int, payload: TireDemountRequest, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Nimmt den montierten Satz AB (ins Lager — NICHT archiviert).

    Schließt die offene Montage (km_off = km-Stand bei Demontage,
    leer = Auto-Ableitung). Der Satz bleibt im Umlauf und kann
    jederzeit wieder montiert werden.
    """
    rec = _get_tire_or_404(record_id, db)
    if rec.is_archived:
        raise HTTPException(status_code=409, detail="Archivierte Sätze können nicht demontiert werden")
    if not rec.is_active:
        raise HTTPException(status_code=409, detail="Satz ist bereits demontiert (im Lager)")

    km_off = _resolve_km_or_auto(db, payload.odometer_km, fallback_rec=rec)

    open_mount = (
        db.query(TireMountModel)
        .filter(
            TireMountModel.tire_record_id == rec.id,
            TireMountModel.demounted_at.is_(None),
        )
        .first()
    )
    if not open_mount:
        # Konsistenz-Reparatur: montiert ohne Mount-Eintrag → Legacy-Datenbestand.
        # Wir legen die geschlossene Montage direkt an statt hart zu scheitern.
        open_mount = TireMountModel(
            tire_record_id=rec.id,
            mounted_at=rec.date,
            demounted_at=payload.date,
            km_on=rec.start_odometer_km,
            km_off=km_off,
        )
        db.add(open_mount)
    else:
        open_mount.demounted_at = payload.date
        open_mount.km_off = km_off
        if payload.note:
            open_mount.note = payload.note
        open_mount.updated_at = datetime.now(timezone.utc)

    rec.is_active = False
    if km_off is not None:
        rec.odometer_km = km_off
    if rec.start_odometer_km is None and km_off is not None:
        rec.start_odometer_km = km_off
    rec.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec, _mounts_for(db, rec.id)), errors=[])


@router.post("/records/{record_id}/mount", response_model=VehicleSingleResponse, summary="Mount a stored tire set again")
def mount_tire(record_id: int, payload: TireMountRequest, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Montiert einen LAGER-Satz (wieder) am Fahrzeug.

    Mehrfach-Montage ausdrücklich erlaubt. Invariante: maximal EIN Satz
    montiert — ist bereits ein anderer Satz montiert → 409 (erst
    demounten oder replace-tire).
    """
    rec = _get_tire_or_404(record_id, db)
    if rec.is_archived:
        raise HTTPException(status_code=409, detail="Archivierte Sätze können nicht mehr montiert werden")
    if rec.is_active:
        raise HTTPException(status_code=409, detail="Satz ist bereits montiert")

    other_active = (
        db.query(VehicleRecordModel)
        .filter(
            VehicleRecordModel.record_type == VehicleRecordType.TIRE,
            VehicleRecordModel.is_active.is_(True),
            VehicleRecordModel.id != rec.id,
        )
        .first()
    )
    if other_active:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Ein anderer Satz ist bereits montiert: '{other_active.title}' "
                f"(#{other_active.id}) — bitte zuerst demontieren oder tauschen"
            ),
        )

    km_on = _resolve_km_or_auto(db, payload.odometer_km, fallback_rec=None)

    db.add(TireMountModel(
        tire_record_id=rec.id,
        mounted_at=payload.date,
        demounted_at=None,
        km_on=km_on,
        km_off=None,
        note=payload.note,
    ))
    rec.is_active = True
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec, _mounts_for(db, rec.id)), errors=[])


@router.post("/records/{record_id}/archive", response_model=VehicleSingleResponse, summary="Archive a tire set (separate final state)")
def archive_tire(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Archiviert einen Satz — SEPARATER Endzustand (nicht durch Wechsel!).

    Voraussetzung: Satz ist NICHT montiert (ggf. zuerst demounten).
    Archivierte Sätze bleiben mit ihrer kompletten km-Bilanz sichtbar,
    können aber nicht wieder montiert oder getauscht werden
    (unarchive macht es rückgängig).
    """
    rec = _get_tire_or_404(record_id, db)
    if rec.is_archived:
        raise HTTPException(status_code=409, detail="Satz ist bereits archiviert")
    if rec.is_active:
        raise HTTPException(
            status_code=409,
            detail="Satz ist noch montiert — bitte zuerst abmontieren",
        )
    rec.is_archived = True
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec, _mounts_for(db, rec.id)), errors=[])


@router.post("/records/{record_id}/unarchive", response_model=VehicleSingleResponse, summary="Restore an archived tire set to storage")
def unarchive_tire(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Hebt die Archivierung auf — Satz ist wieder im Lager montierbar."""
    rec = _get_tire_or_404(record_id, db)
    if not rec.is_archived:
        raise HTTPException(status_code=409, detail="Satz ist nicht archiviert")
    rec.is_archived = False
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec, _mounts_for(db, rec.id)), errors=[])


@router.post("/records/{record_id}/sync-odometer", response_model=VehicleSingleResponse, summary="Derive missing odometer from latest known km")
def sync_record_odometer(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Leitet den km-Stand eines Eintrags ohne km aus dem aktuellen Fahrzeug-km ab.

    Quelle: max. Session-odometer + max. Record-odometer, sonst 409.
    Idempotent (greift nur bei km=None). Bei montierten Reifensätzen wird
    zusätzlich ein fehlendes km_on der offenen Montage nachgezogen.
    """
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")

    if rec.odometer_km is not None:
        return VehicleSingleResponse(ok=True, data=_to_read(rec, _mounts_for(db, rec.id) if rec.record_type == VehicleRecordType.TIRE else None), errors=[])

    km = _max_known_odometer(db)
    if km is None:
        raise HTTPException(
            status_code=409,
            detail="Kein km-Stand ableitbar — weder TeslaMate- noch Record-Kilometerstände vorhanden",
        )
    rec.odometer_km = km
    if rec.record_type == VehicleRecordType.TIRE:
        if rec.start_odometer_km is None:
            rec.start_odometer_km = km
        open_mount = _get_open_mount(db, rec.id)
        if open_mount and open_mount.km_on is None:
            open_mount.km_on = km
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec, _mounts_for(db, rec.id)), errors=[])


# ============================================================
# COST-SUMMARY (Auswertung)
# ============================================================
def _compute_daily_km_endings(drives: list) -> Dict[date_cls, float]:
    """Berechnet pro Tag den Endstand (max odometer_end aller Drives dieses Tages).

    drives: List von Objekten mit .end_date (datetime) und .odometer_end (Optional[float]).
    Return: {date: km_end_of_day} — Tages-Endstand in lokaler Zeit (UTC-naive).
    """
    by_day: Dict[date_cls, float] = {}
    for d in drives:
        if d.end_date is None or d.odometer_end is None:
            continue
        day = d.end_date.date() if hasattr(d.end_date, "date") else d.end_date
        cur = by_day.get(day)
        if cur is None or d.odometer_end > cur:
            by_day[day] = d.odometer_end
    return by_day


def _km_for_date(
    target_date: datetime,
    daily_km: Dict[date_cls, float],
    fallback_km: Optional[float],
) -> Optional[float]:
    """Bestimmt den km-Stand zum target_date aus daily_km.

    Strategie:
      - Exakter Tag vorhanden → der Tages-Endstand
      - Target-Datum liegt VOR dem ersten Drive → None (vor Anschaffung)
      - Target-Datum liegt ZWISCHEN Tagen → exakter Wert vom letzten Drive-Tag davor
      - Target-Datum liegt NACH dem letzten Drive → fallback_km (aktuell)
    """
    target_day = (target_date.date()
                   if hasattr(target_date, "date") else target_date)
    if target_day in daily_km:
        return daily_km[target_day]
    sorted_days = sorted(daily_km.keys())
    if not sorted_days:
        return fallback_km
    last_day = sorted_days[-1]
    if target_day > last_day:
        return fallback_km
    # Suche letzten Tag <= target_day
    last_known = None
    for day in sorted_days:
        if day <= target_day:
            last_known = day
        else:
            break
    return daily_km.get(last_known) if last_known else None


@router.get("/cost-summary", response_model=VehicleCostSummaryResponse, summary="Aggregierte Kosten-Auswertung pro Kategorie + Gesamt + €/km + Jahres-Hochrechnung")
async def get_cost_summary(db: Session = Depends(get_db)) -> VehicleCostSummaryResponse:
    """Summiert alle service+tire-Einträge nach Kategorie und liefert die wichtigsten KPIs.

    km-Stand-Ableitung pro Datensatz:
      1. Hat der Eintrag selbst odometer_km → der wird genommen (manuell erfasst)
      2. Sonst: aus TM-Drives → Tages-Endstand (= max odometer_end aller Drives des Tages)
         - Ist das Datum älter als der erste Drive (z.B. Anschaffung), None
         - Liegt das Datum in der Zukunft oder nach dem letzten Drive → aktueller fallback_km
      3. Wenn TM nicht erreichbar: nur die manuellen km werden genutzt
    """
    records = db.query(VehicleRecordModel).order_by(VehicleRecordModel.date.asc()).all()

    # Aktuelle TM-Daten einmal holen (Tages-Endstände aller bisherigen Drives)
    config = db.query(DataSourceConfig).filter(DataSourceConfig.is_active == True).first() \
        if hasattr(DataSourceConfig, "is_active") else db.query(DataSourceConfig).first()
    daily_km: Dict[date_cls, float] = {}
    fallback_km = _max_known_odometer(db)
    tm_client = _create_teslamateapi_client_from_config(config)
    if tm_client is not None:
        try:
            drives = await tm_client.get_drives()
            if drives:
                daily_km = _compute_daily_km_endings(drives)
        except Exception:
            drives = None

    if not records:
        return VehicleCostSummaryResponse(
            ok=True, total_eur=0.0, tire_total_eur=0.0, service_total_eur=0.0,
            categories=[],
            odometer_start_km=None, odometer_start_date=None,
            odometer_current_km=fallback_km, km_driven=None,
            eur_per_km_with_purchase=0.0, eur_per_km_without_purchase=0.0,
            estimated_yearly_eur=0.0, estimated_yearly_breakdown={},
            errors=[],
        )

    # Manuelle km aus Records (Ankerpunkte die der User selbst eingetragen hat)
    known_km: Dict[datetime, float] = {}
    for r in records:
        if r.odometer_km is not None:
            d = r.date if r.date.tzinfo is None else r.date.replace(tzinfo=None)
            known_km[d] = r.odometer_km

    # Pro-Kategorie Aggregation
    by_cat: Dict[str, float] = {c: 0.0 for c in VEHICLE_CATEGORIES}
    by_cat["_tires"] = 0.0
    by_cat["_unsorted"] = 0.0
    by_cat_count: Dict[str, int] = {}

    tire_total = 0.0
    service_total = 0.0
    total_eur = 0.0
    earliest_date = None
    earliest_km = None

    for r in records:
        cost = float(r.cost_eur or 0.0)
        if r.record_type == VehicleRecordType.TIRE:
            tire_total += cost
            by_cat["_tires"] += cost
            by_cat_count["_tires"] = by_cat_count.get("_tires", 0) + 1
            total_eur += cost
            continue
        service_total += cost
        cat = r.category if r.category in VEHICLE_CATEGORIES else None
        if cat:
            by_cat[cat] += cost
            by_cat_count[cat] = by_cat_count.get(cat, 0) + 1
        else:
            by_cat["_unsorted"] += cost
            by_cat_count["_unsorted"] = by_cat_count.get("_unsorted", 0) + 1
        total_eur += cost

        # Frühester Service-Eintrag als Anker für die km-Berechnung
        # Hat er selbst odometer_km → nimm das; sonst TM-Tages-Endstand
        rec_km = None
        if r.odometer_km is not None:
            rec_km = r.odometer_km
        else:
            rec_km = _km_for_date(r.date, daily_km, fallback_km)
        if rec_km is not None:
            if earliest_date is None or r.date < earliest_date:
                earliest_date = r.date
                earliest_km = rec_km

    categories = []
    for c in VEHICLE_CATEGORIES:
        if by_cat[c] > 0 or by_cat_count.get(c, 0) > 0:
            categories.append(CategoryCost(
                key=c, label=_CATEGORY_LABELS.get(c, c),
                total_eur=round(by_cat[c], 2),
                count=by_cat_count.get(c, 0),
            ))
    if by_cat["_tires"] > 0:
        categories.append(CategoryCost(
            key="_tires", label="Reifen",
            total_eur=round(by_cat["_tires"], 2),
            count=by_cat_count.get("_tires", 0),
        ))
    if by_cat["_unsorted"] > 0:
        categories.append(CategoryCost(
            key="_unsorted", label="Ohne Kategorie",
            total_eur=round(by_cat["_unsorted"], 2),
            count=by_cat_count["_unsorted"],
        ))

    odo_start_km = earliest_km
    odo_start_date = earliest_date
    odo_current_km = fallback_km

    km_driven = None
    eur_per_km_with = 0.0
    eur_per_km_without = 0.0
    estimated_yearly = 0.0
    yearly_breakdown: Dict[str, float] = {}

    if odo_start_km is not None and odo_current_km is not None and odo_current_km > odo_start_km:
        km_driven = round(odo_current_km - odo_start_km, 1)
        if km_driven > 0:
            eur_per_km_with = round(total_eur / km_driven, 4)
            ohne_anschaffung = total_eur - by_cat.get("anschaffung", 0.0)
            eur_per_km_without = round(ohne_anschaffung / km_driven, 4)

    if odo_start_date and odo_current_km and odo_current_km > odo_start_km:
        days = max(1.0, (datetime.utcnow() - odo_start_date).total_seconds() / 86400)
        km_per_day = km_driven / days if km_driven else 0
        annual_target_km = 20000.0
        if km_per_day > 0:
            variable_per_km = eur_per_km_without
            variable_annual = variable_per_km * annual_target_km
            amort_anschaffung = by_cat.get("anschaffung", 0.0) / 5.0
            amort_anmeldung = by_cat.get("anmeldung", 0.0) / 5.0
            fixed_yearly = amort_anschaffung + amort_anmeldung
            yearly_breakdown = {
                "variable_km_annual": round(variable_annual, 2),
                "fix_anschaffung_amortisiert_5y": round(amort_anschaffung, 2),
                "fix_anmeldung_amortisiert_5y": round(amort_anmeldung, 2),
                "assumption_km_per_year": annual_target_km,
                "assumption_amort_years": 5,
                "actual_km_per_day": round(km_per_day, 2),
            }
            estimated_yearly = round(variable_annual + fixed_yearly, 2)

    return VehicleCostSummaryResponse(
        ok=True,
        total_eur=round(total_eur, 2),
        tire_total_eur=round(tire_total, 2),
        service_total_eur=round(service_total, 2),
        categories=categories,
        odometer_start_km=odo_start_km,
        odometer_start_date=odo_start_date,
        odometer_current_km=odo_current_km,
        km_driven=km_driven,
        eur_per_km_with_purchase=eur_per_km_with,
        eur_per_km_without_purchase=eur_per_km_without,
        estimated_yearly_eur=estimated_yearly,
        estimated_yearly_breakdown=yearly_breakdown,
        errors=[],
    )


# Anzeige-Labels für die JSON-API (Frontend braucht sie nicht, aber für Doku hilfreich)
_CATEGORY_LABELS = {
    "anschaffung": "Anschaffung",
    "anmeldung": "Anmeldung",
    "inspektion_wartung": "Inspektion / Wartung",
    "reparatur": "Reparatur",
    "zubehoer": "Zubehör",
    "reinigung_pflege": "Reinigung / Pflege",
    "versicherung": "Versicherung",
    "steuer": "Steuer",
    "sonstiges": "Sonstiges",
}


@router.delete("/records/{record_id}", response_model=VehicleSingleResponse, summary="Delete service/tire record")
def delete_vehicle_record(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")
    if rec.record_type == VehicleRecordType.TIRE:
        # Montage-Historie des Satzes mitlöschen (gehört zum Datensatz)
        db.query(TireMountModel).filter(TireMountModel.tire_record_id == record_id).delete()
        # Verweise anderer Sätze auf diesen als Nachfolger lösen
        db.query(VehicleRecordModel).filter(
            VehicleRecordModel.replaced_by == record_id
        ).update({VehicleRecordModel.replaced_by: None}, synchronize_session=False)
    db.delete(rec)
    db.commit()
    return VehicleSingleResponse(ok=True, data=None, errors=[])


@router.get("/info", response_model=VehicleInfoResponse, summary="Get vehicle info from TeslaMate")
async def get_vehicle_info(db: Session = Depends(get_db)) -> VehicleInfoResponse:
    """Fetch vehicle identity and latest odometer from TeslaMate (read-only)."""
    config = db.query(DataSourceConfig).first()
    if not config or not config.teslamateapi_base_url:
        # No TM configured - return empty, frontend shows '—'
        return VehicleInfoResponse(ok=True, data=VehicleInfo(source="none"), errors=[])

    try:
        from app.services.teslamateapi_client import create_teslamateapi_client_from_config
        tm_client = await create_teslamateapi_client_from_config(config)
        if not tm_client:
            return VehicleInfoResponse(ok=True, data=VehicleInfo(source="none"), errors=[])

        cars = await tm_client.get_cars()
        if not cars:
            return VehicleInfoResponse(ok=True, data=VehicleInfo(source="none"), errors=[])

        car = cars[0]
        # 1. TeslaMate Drives als primäre Quelle für aktuellen km-Stand
        current_odometer = None
        try:
            drives = await tm_client.get_drives()
            for d in drives:  # drives are already newest-first from TM API
                if d.odometer_end:
                    current_odometer = d.odometer_end
                    break
        except Exception:
            pass

        # 2. Fallback: Max odometer_km aus manuellen Vehicle-Records
        if current_odometer is None:
            current_odometer = db.query(func.max(VehicleRecordModel.odometer_km)).scalar()

        info = VehicleInfo(
            car_id=car.car_id,
            name=car.name,
            vin=car.vin,
            model=car.model,
            current_odometer_km=current_odometer,
            source="teslamate",
        )
        return VehicleInfoResponse(ok=True, data=info, errors=[])
    except Exception as e:
        return VehicleInfoResponse(
            ok=True,
            data=VehicleInfo(source="error"),
            errors=[{"code": "TM_FETCH", "message": str(e)}],
        )
