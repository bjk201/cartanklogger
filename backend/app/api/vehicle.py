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


@router.put("/records/{record_id}/replace-tire", response_model=VehicleSingleResponse, summary="Replace a tire with a new one")
def replace_tire(record_id: int, payload: TireReplaceRequest, db: Session = Depends(get_db)) -> VehicleSingleResponse:
    """
    Replace an existing tire record with a new one.
    Creates a NEW tire record linked via replaces_tire_id and marks the old
    tire as 'replaced' (is_active=False, replaced_by=new_id).
    The old tire keeps its odometer_km, the new one gets a start_odometer_km.
    """
    # Find the old tire
    old_rec = db.query(VehicleRecordModel).filter(
        VehicleRecordModel.id == record_id,
        VehicleRecordModel.record_type == VehicleRecordType.TIRE
    ).first()
    if not old_rec:
        raise HTTPException(status_code=404, detail="Reifen-Eintrag nicht gefunden")

    # Create the new tire record (replaces the old one)
    new_rec = VehicleRecordModel(
        record_type=VehicleRecordType.TIRE,
        date=payload.date,
        title=payload.title,
        odometer_km=payload.odometer_km,          # new tire's current odometer
        cost_eur=old_rec.cost_eur,                 # keep cost from old (or None)
        note=payload.note,
        shop=payload.shop,
        tire_position=payload.tire_position or old_rec.tire_position,
        tire_brand=payload.tire_brand or old_rec.tire_brand,
        tire_season=payload.tire_season or old_rec.tire_season,
        start_odometer_km=payload.odometer_km,    # mark start km for the new tire
    )
    db.add(new_rec)
    db.flush()  # get the new ID

    # Mark the old tire as replaced
    old_rec.is_active = False
    old_rec.replaced_by = new_rec.id
    old_rec.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(new_rec)
    return VehicleSingleResponse(ok=True, data=_to_read(new_rec), errors=[])


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
        # 1. Priorität: Max odometer_km aus manuellen Vehicle-Records
        from app.models.vehicle import VehicleRecordModel
        max_record_km = db.query(func.max(VehicleRecordModel.odometer_km)).scalar()

        # 2. TeslaMate Drives als Fallback / Vergleich
        current_odometer = max_record_km  # Start mit manuellem Wert
        try:
            drives = await tm_client.get_drives()
            for d in reversed(drives):
                if d.odometer_end:
                    tm_odo = d.odometer_end
                    if current_odometer is None or tm_odo > current_odometer:
                        current_odometer = tm_odo
                    break
        except Exception:
            pass  # Fallback auf max_record_km (oder None)

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
