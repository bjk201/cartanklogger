"""Override-Ziel-Auflösung — EINE Auflösung für alle Consumer.

Hintergrund (Bug-Historie): Matching-Overrides speichern ihr Ziel in
``matching_overrides.evcc_session_id``. Zwei Consumer interpretierten
diesen Wert HISTORISCH unterschiedlich:

- Legacy-Matcher (matching.py, Session-Ansicht): CTL-Primary-Key (sessions.id)
- Live-Matcher (live_matching.py, TM-Kostenexport): EVCC-API-ID (= sessions.source_id)

Ein bestätigter Override konnte dadurch in der Session-Ansicht "passen",
im TM-Kostenexport aber unsichtbar sein (Live-Matcher verwirft das Ziel,
weil es nicht im EVCC-ID-Raum liegt) — und umgekehrt.

Ab jetzt gilt EINE Regel (Pflichtenheft §3, Manual > Auto):

    Ein bestätigter manual_assign-Override trifft zu, wenn die
    übersetzte Ziel-Session (CTL-PK) der betrachteten Session entspricht —
    unabhängig davon, ob die Override-Zeile den CTL-PK oder die
    EVCC-API-ID speichert (Bestand wird tolerant aufgelöst).

Die Auflösung erfolgt einmalig zentral hier, damit Matcher (beide),
Kostenexport und API identische Ergebnisse liefern. Neu angelegte
Overrides werden NORMIERT gespeichert (immer CTL-PK), sodass der
Bestand langfristig konsistent ist.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy.orm import Session as DBSession

from app.models.matching_override import MatchingOverride, OverrideType
from app.models.session import SessionModel

logger = logging.getLogger(__name__)


def resolve_session_target(db: DBSession, value, ref_dt=None) -> Optional[int]:
    """Übersetzt eine Override-Ziel-ID in den CTL-Primary-Key.

    Die gespeicherte Ziel-ID ist historisch uneinheitlich: CTL-PK
    (TmCostExportPage/„Bestätigen", neuer API-Layer) ODER EVCC-API-ID
    (MatchingPage Live-Modus). Reihenfolge:

    1. Exakter CTL-PK (sessions.id, source_type='home')
    2. EVCC-API-ID via sessions.source_id (source_type='home')
    3. Beides existiert (Zahlenraum-Kollision): Zeitfenster-Check —
       die Kandidatin gewinnt, deren Session-Datum nahe an ref_dt
       (Override-Erstellung) liegt (±2 Tage); ohne Entscheidung
       gilt der CTL-PK.
    4. None (Ziel existiert nicht / nicht mehr synchronisiert)
    """
    if value is None:
        return None
    try:
        v = int(value)
    except (TypeError, ValueError):
        return None

    pk_row = (
        db.query(SessionModel)
        .filter(SessionModel.source_type == "home", SessionModel.id == v)
        .first()
    )
    if pk_row is None:
        row = (
            db.query(SessionModel)
            .filter(SessionModel.source_type == "home", SessionModel.source_id == str(v))
            .first()
        )
        return int(row.id) if row is not None else None

    src_row = (
        db.query(SessionModel)
        .filter(SessionModel.source_type == "home", SessionModel.source_id == str(v))
        .first()
    )
    if src_row is None or int(src_row.id) == int(pk_row.id):
        return int(pk_row.id)

    # Zahlenraum-Kollision: per Zeitfenster um die Override-Erstellung
    # entscheiden (Fallback: CTL-PK — das schreibt der heutige API-Layer).
    default = int(pk_row.id)
    if ref_dt is None:
        return default
    try:
        created = ov_created_at(ref_dt)
        if created is None:
            return default
        lo, hi = created - timedelta(days=2), created + timedelta(days=2)
    except Exception:
        return default

    pk_hits = _session_date_in_window(db, pk_row, lo, hi)
    src_hits = _session_date_in_window(db, src_row, lo, hi)
    if pk_hits and not src_hits:
        return int(pk_row.id)
    if src_hits and not pk_hits:
        return int(src_row.id)
    return default


def _session_date_in_window(db: DBSession, row, lo, hi) -> bool:
    """True wenn Session-Datum (naiv/UTC-tolerant) im Fenster liegt."""
    d = getattr(row, "date", None)
    if d is None:
        return False
    try:
        dd = d.replace(tzinfo=None) if d.tzinfo else d
        return lo <= dd <= hi
    except Exception:
        return False


def ov_created_at(value):
    """Override.created_at robust nach naivem datetime (Vergleichsfenster)."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    return None


def get_effective_manual_overrides(db: DBSession) -> List[dict]:
    """Aktive manual_assign-Overrides, ZIELE BEREITS AUF CTL-PK AUFGELOEST.

    Neuester Override je TM-Charge gewinnt (reset_to_auto wird ignoriert —
    konsistent zu LiveMatchingService._get_active_overrides).
    Liefert Einträge: {tm_charge_id, override_id, ctl_session_id, reason}.
    Overrides mit unaufloesbarem Ziel werden übersprungen (mit Warnlog).
    """
    all_overrides = (
        db.query(MatchingOverride)
        .order_by(
            MatchingOverride.teslamate_charge_id,
            MatchingOverride.created_at.desc(),
            MatchingOverride.id.desc(),
        )
        .all()
    )

    latest_per_charge: Dict[int, MatchingOverride] = {}
    for ov in all_overrides:
        if ov.override_type == OverrideType.reset_to_auto:
            continue
        if ov.override_type != OverrideType.manual_assign or ov.evcc_session_id is None:
            continue
        if ov.teslamate_charge_id not in latest_per_charge:
            latest_per_charge[int(ov.teslamate_charge_id)] = ov

    out: List[dict] = []
    for cid, ov in latest_per_charge.items():
        ctl_id = resolve_session_target(db, ov.evcc_session_id, ref_dt=ov.created_at)
        if ctl_id is None:
            logger.warning(
                "Override #%d (TM-Charge %d): Ziel-Session %r nicht auflösbar — übersprungen",
                ov.id, cid, ov.evcc_session_id,
            )
            continue
        out.append({
            "tm_charge_id": cid,
            "override_id": int(ov.id),
            "ctl_session_id": ctl_id,
            "reason": ov.reason,
            "replaced_auto_match": ov.replaced_auto_match,
        })
    return out


def normalize_override_target(db: DBSession, session_value) -> Optional[int]:
    """Normiert eine frisch anzulegende Override-Ziel-ID auf den CTL-PK.

    Nimmt CTL-PK ODER EVCC-API-ID entgegen (beide zulässig, API-Schicht
    bleibt rückwärtskompatibel) und liefert IMMER den CTL-PK zurück —
    neue Overrides werden damit in einem einheitlichen ID-Raum gespeichert.
    """
    return resolve_session_target(db, session_value)
