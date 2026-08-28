from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timezone
from typing import List, Optional

from app.database import get_db
from app.models.vehicle import VehicleRecordModel, VehicleRecordType
from app.models.datasource import DataSourceConfig
from app.schemas.vehicle import (
    VehicleRecordCreate,
    VehicleRecordUpdate,
    VehicleRecordRead,
    VehicleRecordsResponse,
    VehicleSingleResponse,
    VehicleInfo,
    VehicleInfoResponse,
    TireReplaceRequest,
)

router = APIRouter(prefix="/vehicle", tags=["Vehicle"])


def _to_read(rec: VehicleRecordModel) -> VehicleRecordRead:
    return VehicleRecordRead(
        id=rec.id,
        record_type=rec.record_type.value,
        date=rec.date,
        title=rec.title,
        odometer_km=rec.odometer_km,
        cost_eur=rec.cost_eur,
        note=rec.note,
        shop=rec.shop,
        tire_position=rec.tire_position,
        tire_brand=rec.tire_brand,
        tire_season=rec.tire_season,
        start_odometer_km=rec.start_odometer_km,
        replaced_by=rec.replaced_by,
        is_active=rec.is_active,
    )


@router.get("/records", response_model=VehicleRecordsResponse, summary="Get service and tire records")
def get_vehicle_records(db: Session = Depends(get_db)) -> VehicleRecordsResponse:
    """Return all vehicle records, split into services and tires, newest first."""
    records = db.query(VehicleRecordModel).order_by(
        VehicleRecordModel.date.desc()
    ).all()

    services = []
    tires = []
    for rec in records:
        read = _to_read(rec)
        if rec.record_type == VehicleRecordType.SERVICE:
            services.append(read)
        else:
            tires.append(read)

    return VehicleRecordsResponse(ok=True, services=services, tires=tires, errors=[])


@router.get("/records/{record_id}", response_model=VehicleSingleResponse, summary="Get single vehicle record")
def get_vehicle_record(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")
    return VehicleSingleResponse(ok=True, data=_to_read(rec), errors=[])


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
        tire_position=payload.tire_position,
        tire_brand=payload.tire_brand,
        tire_season=payload.tire_season,
    )
    # Reifensatz: Start-km = km-Stand beim Anlegen → gefahrene km bilanzierbar
    if rec.record_type == VehicleRecordType.TIRE and payload.odometer_km is not None:
        rec.start_odometer_km = payload.odometer_km
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
    return VehicleSingleResponse(ok=True, data=_to_read(rec), errors=[])


@router.put("/records/{record_id}/replace-tire", response_model=VehicleSingleResponse, summary="Replace the active tire set with a new one")
def replace_tire(record_id: int, payload: TireReplaceRequest, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Wechselt den AKTIVEN Reifensatz gegen einen neuen (EIN Eintrag pro Satz).

    - Der alte Satz wird archiviert (is_active=False, replaced_by=neue ID)
      und behält seinen letzten bekannten km-Stand → gefahrene km je Satz
      bleiben in der Historie sichtbar.
    - Der neue Satz bekommt start_odometer_km = km-Stand beim Wechsel.
    - Wenn odometer_km leer gelassen wird, wird der km-Stand automatisch
      abgeleitet (aktuellster TM-Drives-Wert, sonst max. Vehicle-Record).
    """
    old_rec = db.query(VehicleRecordModel).filter(
        VehicleRecordModel.id == record_id,
        VehicleRecordModel.record_type == VehicleRecordType.TIRE
    ).first()
    if not old_rec:
        raise HTTPException(status_code=404, detail="Reifen-Eintrag nicht gefunden")
    if not old_rec.is_active:
        raise HTTPException(status_code=409, detail="Nur der aktive Reifensatz kann getauscht werden")

    # KM-Stand bestimmen: übergeben > letzter Wert des alten Satzes > TM-Drives > max. Record
    odometer = payload.odometer_km
    if odometer is None:
        odometer = old_rec.odometer_km
    if odometer is None:
        # Auto-Ableitung: 1) max. odometer aus Vehicle-Records (Fallback),
        # 2) TM-Drives werden client-seitig in get_vehicle_info genutzt —
        #    hier synchron per max() aus Sessions/Records ableitbar.
        from app.models.session import SessionModel
        max_rec = db.query(func.max(VehicleRecordModel.odometer_km)).scalar()
        max_sess = db.query(func.max(SessionModel.odometer_km)).scalar()
        candidates = [v for v in (max_rec, max_sess) if v is not None]
        odometer = max(candidates) if candidates else None

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
        start_odometer_km=odometer,  # km-Stand beim Anlegen des neuen Satzes
        is_active=True,
    )
    db.add(new_rec)
    db.flush()  # neue ID holen

    # Alten Satz archivieren — End-km = Wechsel-km → gefahrene km bleiben erhalten
    old_rec.is_active = False
    old_rec.replaced_by = new_rec.id
    if odometer is not None:
        old_rec.odometer_km = odometer
    if old_rec.start_odometer_km is None and odometer is not None:
        old_rec.start_odometer_km = odometer  # Legacy-Satz ohne Start: Bilanz startet hier
    old_rec.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(new_rec)
    return VehicleSingleResponse(ok=True, data=_to_read(new_rec), errors=[])


@router.post("/records/{record_id}/sync-odometer", response_model=VehicleSingleResponse, summary="Derive missing odometer from latest known km")
def sync_record_odometer(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """Leitet den km-Stand eines Eintrags ohne km aus dem aktuellen Fahrzeug-km ab.

    Quelle (in dieser Reihenfolge): aktuellster TM-Drives-Wert (via /vehicle/info-Logik,
    hier synchron: max. Session-odometer + max. Record-odometer), sonst 409.
    Setzt odometer_km auf den ermittelten Stand. Idempotent.
    """
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")

    if rec.odometer_km is not None:
        return VehicleSingleResponse(ok=True, data=_to_read(rec), errors=[])

    from app.models.session import SessionModel
    max_rec = db.query(func.max(VehicleRecordModel.odometer_km)).scalar()
    max_sess = db.query(func.max(SessionModel.odometer_km)).scalar()
    candidates = [v for v in (max_rec, max_sess) if v is not None]
    # WICHTIG: der eigene Eintrag hat odometer_km=None und fällt nicht ins Maximum.
    if not candidates:
        raise HTTPException(
            status_code=409,
            detail="Kein km-Stand ableitbar — weder TeslaMate- noch Record-Kilometerstände vorhanden",
        )
    rec.odometer_km = max(candidates)
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    return VehicleSingleResponse(ok=True, data=_to_read(rec), errors=[])


@router.delete("/records/{record_id}", response_model=VehicleSingleResponse, summary="Delete service/tire record")
def delete_vehicle_record(record_id: int, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    rec = db.query(VehicleRecordModel).filter(VehicleRecordModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Eintrag nicht gefunden")
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
            from app.models.vehicle import VehicleRecordModel
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
