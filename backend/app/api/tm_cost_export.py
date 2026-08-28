"""API-Router: TM-Kostenexport (kontrollierter TeslaMate-Writeback).

Sicherheitsbedingungen:
- Kein Endpoint schreibt ohne explizite Nutzerfreigabe.
- execute/rollback verlangen zusaetzlich {"confirm": true} im Body.
- Credentials (TESLAMATE_DB_*) verlassen den Backend-Container nie.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from app.database import get_db
from app.services.tm_cost_export_service import (
    TMCostExportService,
    TMCostExportError,
)
from app.services.tm_db import TeslaMateDBConfigError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tm-cost-export", tags=["tm-cost-export"])


class ConfirmBody(BaseModel):
    confirm: bool


def _svc(db: DBSession) -> TMCostExportService:
    return TMCostExportService(db)


@router.get("")
def list_export_sessions(
    days: int = None,
    status: str = None,
    db: DBSession = Depends(get_db),
):
    """Liste aller EVCC-Sessions mit Exportstatus + Status-Zaehlung."""
    return _svc(db).list_sessions(days=days, status=status)


@router.post("/refresh")
def refresh_allocations(db: DBSession = Depends(get_db)):
    """Berechnet Allokationen anhand Live-Matching (idempotent).

    Erzeugt NUR Allokations-/Audit-Datensaetze in CTL — niemals TM-Writes.
    """
    import asyncio

    svc = _svc(db)
    try:
        result = asyncio.run(svc.refresh_allocations_async())
        return {"ok": True, "result": result}
    except TMCostExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("refresh failed")
        raise HTTPException(status_code=502, detail="Matching fehlgeschlagen: %s" % exc)


@router.get("/{evcc_session_id}")
def export_detail(evcc_session_id: int, db: DBSession = Depends(get_db)):
    """Detailansicht inkl. geplanter neuer TM-Kostenwerte."""
    from app.services import tm_db

    try:
        d = _svc(db).detail(evcc_session_id)
    except TMCostExportError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    d["tm_db_configured"] = tm_db.is_configured()
    return d


@router.post("/{evcc_session_id}/approve")
def approve_session(evcc_session_id: int, db: DBSession = Depends(get_db)):
    """Freigabe: erzeugt nur Audit-Eintraege mit Status approved.

    KEIN TeslaMate-Write. Execute ist danach moeglich, braucht aber confirm=true.
    """
    try:
        return _svc(db).approve(evcc_session_id)
    except (TMCostExportError, TeslaMateDBConfigError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{evcc_session_id}/execute")
def execute_session(
    evcc_session_id: int,
    body: ConfirmBody,
    db: DBSession = Depends(get_db),
):
    """Atomarer Writeback in TeslaMate — NUR nach approve + confirm:true."""
    if body.confirm is not True:
        raise HTTPException(
            status_code=428,
            detail="Execute benoetigt {\"confirm\": true} — Freigabe + Bestaetigung erforderlich",
        )
    try:
        return _svc(db).execute(evcc_session_id, confirm=True)
    except (TMCostExportError, TeslaMateDBConfigError) as exc:
        raise HTTPException(status_code=503, detail=f"TeslaMate-Writeback fehlgeschlagen: {exc}")
    except Exception as exc:
        logger.exception("execute: unbehandelter Fehler bei Session %d", evcc_session_id)
        raise HTTPException(
            status_code=503,
            detail=f"TeslaMate-Export-Interner Fehler ({type(exc).__name__}): {exc}",
        )


@router.post("/{evcc_session_id}/rollback")
def rollback_session(
    evcc_session_id: int,
    body: ConfirmBody,
    db: DBSession = Depends(get_db),
):
    """Stellt previous_tm_cost_eur wieder her — nur fuer exported Eintraege."""
    if body.confirm is not True:
        raise HTTPException(
            status_code=428,
            detail="Rollback benoetigt {\"confirm\": true}",
        )
    try:
        return _svc(db).rollback(evcc_session_id, confirm=True)
    except (TMCostExportError, TeslaMateDBConfigError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("rollback: unbehandelter Fehler bei Session %d", evcc_session_id)
        raise HTTPException(
            status_code=503,
            detail=f"Rollback-Interner Fehler ({type(exc).__name__}): {exc}",
        )
