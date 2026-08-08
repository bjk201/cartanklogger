from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timezone
from typing import List

from app.database import get_db
from app.models.extra_costs import ExtraCostModel, ExtraCostCategory
from app.models.vehicle import VehicleRecordModel, VehicleRecordType
from app.schemas.extra_costs import (
    ExtraCostCreate,
    ExtraCostUpdate,
    ExtraCostRead,
    ExtraCostListResponse,
    ExtraCostSingleResponse,
)

router = APIRouter(prefix="/extra-costs", tags=["Extra Costs"])


def _to_read(rec: ExtraCostModel) -> ExtraCostRead:
    return ExtraCostRead(
        id=rec.id,
        date=rec.date,
        title=rec.title,
        category=rec.category.value,
        cost_eur=rec.cost_eur,
        note=rec.note,
        linked_tire_id=rec.linked_tire_id,
        created_at=rec.created_at,
        updated_at=rec.updated_at,
    )


@router.get("", response_model=ExtraCostListResponse, summary="Get all extra costs")
def get_extra_costs(db: Session = Depends(get_db)) -> ExtraCostListResponse:
    """Return all extra cost entries, newest first."""
    records = (
        db.query(ExtraCostModel)
        .order_by(ExtraCostModel.date.desc(), ExtraCostModel.id.desc())
        .all()
    )
    return ExtraCostListResponse(
        ok=True,
        data=[_to_read(r) for r in records],
        errors=[],
    )


@router.get("/{record_id}", response_model=ExtraCostSingleResponse, summary="Get single extra cost")
def get_extra_cost(record_id: int, db: Session = Depends(get_db)) -> ExtraCostSingleResponse:
    rec = db.query(ExtraCostModel).filter(ExtraCostModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Extra-Kosten-Eintrag nicht gefunden")
    return ExtraCostSingleResponse(ok=True, data=_to_read(rec), errors=[])


@router.post(
    "",
    response_model=ExtraCostSingleResponse,
    status_code=201,
    summary="Create extra cost entry",
)
def create_extra_cost(
    payload: ExtraCostCreate, db: Session = Depends(get_db)
) -> ExtraCostSingleResponse:
    """Create an extra cost entry.

    If category is REIFENKAUF and linked_tire_id is NOT provided, additionally
    create a new tire record in vehicle_records automatically.
    If linked_tire_id IS provided, no automatic tire record is created
    (the user is linking to an existing vehicle tire).
    """
    # Validate linked_tire_id if provided
    if payload.linked_tire_id is not None:
        tire = (
            db.query(VehicleRecordModel)
            .filter(
                VehicleRecordModel.id == payload.linked_tire_id,
                VehicleRecordModel.record_type == VehicleRecordType.TIRE,
            )
            .first()
        )
        if not tire:
            raise HTTPException(
                status_code=404,
                detail="Verknüpfter Reifen-Eintrag nicht gefunden",
            )

    # Create the extra cost record
    rec = ExtraCostModel(
        date=payload.date,
        title=payload.title,
        category=ExtraCostCategory(payload.category),
        cost_eur=payload.cost_eur,
        note=payload.note,
        linked_tire_id=payload.linked_tire_id,
    )
    db.add(rec)
    db.flush()  # get ID

    # If category is REIFENKAUF and no tire is linked, auto-create a tire record
    if payload.category == "REIFENKAUF" and payload.linked_tire_id is None:
        tire_rec = VehicleRecordModel(
            record_type=VehicleRecordType.TIRE,
            date=payload.date,
            title=payload.title,
            cost_eur=payload.cost_eur,
            note=payload.note,
            is_active=True,
        )
        db.add(tire_rec)
        db.flush()
        # Link the extra cost to the newly created tire
        rec.linked_tire_id = tire_rec.id

    db.commit()
    db.refresh(rec)
    return ExtraCostSingleResponse(ok=True, data=_to_read(rec), errors=[])


@router.put("/{record_id}", response_model=ExtraCostSingleResponse, summary="Update extra cost entry")
def update_extra_cost(
    record_id: int, payload: ExtraCostUpdate, db: Session = Depends(get_db)
) -> ExtraCostSingleResponse:
    rec = db.query(ExtraCostModel).filter(ExtraCostModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Extra-Kosten-Eintrag nicht gefunden")

    # If linked_tire_id is being set, validate it
    if payload.linked_tire_id is not None and payload.linked_tire_id != rec.linked_tire_id:
        tire = (
            db.query(VehicleRecordModel)
            .filter(
                VehicleRecordModel.id == payload.linked_tire_id,
                VehicleRecordModel.record_type == VehicleRecordType.TIRE,
            )
            .first()
        )
        if not tire:
            raise HTTPException(
                status_code=404,
                detail="Verknüpfter Reifen-Eintrag nicht gefunden",
            )

    patch = payload.model_dump(exclude_unset=True)
    for field, value in patch.items():
        setattr(rec, field, value)

    # If category is being updated to non-REIFENKAUF, clear the link
    if payload.category is not None and payload.category != "REIFENKAUF":
        if payload.linked_tire_id is None:
            rec.linked_tire_id = None

    rec.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rec)
    return ExtraCostSingleResponse(ok=True, data=_to_read(rec), errors=[])


@router.delete("/{record_id}", response_model=ExtraCostSingleResponse, summary="Delete extra cost entry")
def delete_extra_cost(record_id: int, db: Session = Depends(get_db)) -> ExtraCostSingleResponse:
    rec = db.query(ExtraCostModel).filter(ExtraCostModel.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Extra-Kosten-Eintrag nicht gefunden")
    db.delete(rec)
    db.commit()
    return ExtraCostSingleResponse(ok=True, data=None, errors=[])