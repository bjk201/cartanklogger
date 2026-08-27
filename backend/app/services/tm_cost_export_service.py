"""TM-Kostenexport Service: Allokation + Freigabe + Writeback + Rollback.

Kernregeln:
- EVCC ist führend für Home-Kosten und Wallbox-kWh; TM führt used-kWh + IDs.
- allocation_basis = 'tm_used_kwh': EVCC-Gesamtkosten werden proportional zu
  charge_energy_used der akzeptierten TM-Fragmente verteilt.
- Decimal-Arithmetik; Kosten auf 2 Nachkommastellen; Rundungsrest dem größten
  Fragment. Invariante: SUMME(allocated_cost_eur) == evcc_total_cost_eur.
- Ein TM-Charge darf nur in einer exportierbaren EVCC-Allokation vorkommen.
- Approve erzeugt nur Audit-Zeilen (approved), kein TeslaMate-Write.
- Execute schreibt atomar NUR approved-Einträge und braucht confirm=True.
- Rollback stellt previous_tm_cost_eur exakt wieder her; confirm=True nötig.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from app.models.tm_cost_export import SessionCostAllocation, TMCostExport

logger = logging.getLogger(__name__)

CALC_VERSION = "v1"

# Exportfähige Match-Qualitäten (Pflichtenheft §3)
EXPORTABLE_QUALITIES = {"exact", "plausible", "manual_override"}

TWOPLACES = Decimal("0.01")
SIXPLACES = Decimal("0.000001")

# Markierung fuer Auto-Matches, die durch einen bestaetigten manuellen
# Override auf derselben Session ersetzt wurden (Manual > Auto-Prioritaet).
# Zaehlt NICHT als Blockierung, ist aber auch NICHT Teil des Exports.
SUPERSEDED_MARKER = "superseded_by_manual_override"


def _row_blocks(row_exclusion: Optional[str]) -> bool:
    """True wenn die Zeile echte Blockgruende hat (Superseded zaehlt nicht)."""
    if not row_exclusion:
        return False
    parts = set(p for p in row_exclusion.split(";") if p)
    return not parts <= {SUPERSEDED_MARKER}


def _is_exportable_row(row_exclusion: Optional[str]) -> bool:
    """True nur bei ganz ohne exclusion_reason — nur diese Zeilen gehoeren
    in Summen, Freigabe und Export. Superseded-Auto-Fragmente sind kein Teil
    des Exports (auch wenn sie nicht blockieren)."""
    return not row_exclusion


def _dec(v) -> Optional[Decimal]:
    """Robust nach Decimal; None bei nicht-nummerisch."""
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def _q2(d: Decimal) -> Decimal:
    return d.quantize(TWOPLACES, rounding=ROUND_HALF_UP)


class TMCostExportError(ValueError):
    """Business-Fehler (blocked / fehlende Freigabe / falscher Status)."""


def allocate_costs(evcc_total_cost_eur, tm_used_list, tm_charge_ids=None) -> dict:
    """Reine Allokationsfunktion (Decimal, deterministisch, ohne DB).

    Effektivpreis = cost / used_total (volle Präzision).
    Jeder Anteil = q2(used_i * price). Rundungsrest geht an das größte Fragment.
    Invariante: SUMME(Anteile) == q2(cost).
    """
    if tm_charge_ids is not None and len(tm_charge_ids) != len(tm_used_list):
        raise TMCostExportError("tm_charge_ids Laenge passt nicht zu tm_used_list")

    cost = _dec(evcc_total_cost_eur)
    used_decimals = []
    for x in tm_used_list:
        d = _dec(x)
        if d is None or d < 0:
            raise TMCostExportError("Ungueltige TM-used-KWh: %r" % (x,))
        used_decimals.append(d)

    used_total = sum(used_decimals, Decimal("0"))
    if used_total <= 0:
        raise TMCostExportError("TM-used-Summe ist 0")
    if cost is None or cost < 0:
        raise TMCostExportError("EVCC-Gesamtkosten fehlen oder sind negativ")

    effective_price = cost / used_total  # volle Decimal-Praezision

    rounded = [_q2(u * effective_price) for u in used_decimals]
    allocated_sum = sum(rounded, Decimal("0"))
    remainder = _q2(cost) - allocated_sum
    max_idx = 0
    if remainder != Decimal("0"):
        max_idx = max(range(len(used_decimals)), key=lambda i: used_decimals[i])
        rounded[max_idx] += remainder

    fragments = []
    for i, (u, c) in enumerate(zip(used_decimals, rounded)):
        fragments.append({
            "index": i,
            "tm_charge_id": tm_charge_ids[i] if tm_charge_ids else None,
            "tm_used_kwh": u,
            "allocated_cost_eur": c,
            "is_remainder_holder": remainder != Decimal("0") and i == max_idx,
        })

    return {
        "effective_price": effective_price,
        "fragments": fragments,
        "allocated_sum": _q2(sum(rounded, Decimal("0"))),
        "total_tm_used": used_total,
        "remainder": remainder,
    }


class TMCostExportService:
    """Orchestriert Allokation -> Approve -> Execute -> Rollback."""

    def __init__(self, db: DBSession):
        self.db = db

    # ------------------------------------------------------------------
    # Live-Matching-Anbindung
    # ------------------------------------------------------------------
    def _load_live_matches_sync(self, limit: int = 500):
        """Baut die Clients aus der DB-Konfiguration und ruft das Matching auf.

        Hinweis: match_all_live ist async; der API-Layer ruft daher
        refresh_allocations_async() auf. Fuer Tests kann stattdessen
        set_live_matches_fixture() genutzt werden.
        """
        raise NotImplementedError("Bitte refresh_allocations_async verwenden")

    def set_live_matches_fixture(self, matches):
        """Nur fuer Tests: Live-Matches direkt injizieren (keine API-Calls)."""
        self._fixture_matches = matches

    async def refresh_allocations_async(self, limit: int = 500) -> dict:
        from app.config import settings
        from app.services.evcc_client import EVCCClient
        from app.services.teslamateapi_client import TeslaMateAPIClient
        from app.services.live_matching import LiveMatchingService
        from app.models.datasource import DataSourceConfig

        cfg = self.db.query(DataSourceConfig).first()
        evcc_url = (cfg.evcc_base_url if cfg else None) or settings.EVCC_BASE_URL
        tm_url = (cfg.teslamateapi_base_url if cfg else None) or settings.TESLAMATEAPI_BASE_URL
        token_tm = getattr(cfg, "teslamateapi_token", None) if cfg else None

        fixture = getattr(self, "_fixture_matches", None)
        if fixture is not None:
            matches = fixture
            overrides = getattr(self, "_fixture_overrides", {}) or {}
            tm_charges = {}
        else:
            evcc_client = EVCCClient(evcc_url, None)
            tm_client = TeslaMateAPIClient(tm_url, token_tm)
            svc = LiveMatchingService(evcc_client, tm_client, self.db)
            matches, _summary = await svc.match_all_live(limit=limit)
            # Bestaetigte manuelle Overrides direkt aus der autoritativen Tabelle
            # laden (Pflichtenheft §3). Deren Chargen-Daten kommen vom TM-API-Client.
            overrides = self._load_active_overrides()
            tm_charges = {}
            if overrides:
                try:
                    all_charges = await tm_client.get_charges()
                    tm_charges = {int(c.id): c for c in all_charges}
                except Exception as exc:
                    logger.warning("TM-Charges fuer Overrides nicht ladbar: %s", exc)

        return self._process_matches(matches, overrides=overrides, tm_charges=tm_charges)

    # ------------------------------------------------------------------
    # Allokation (Upsert, idempotent)
    # ------------------------------------------------------------------
    def _get_evcc_session(self, source_id):
        from app.models.session import SessionModel
        return (
            self.db.query(SessionModel)
            .filter(SessionModel.source_type == "home")
            .filter(SessionModel.source_id == str(source_id))
            .first()
        )

    def _find_other_allocation(self, tm_charge_ids, evcc_session_id):
        return (
            self.db.query(SessionCostAllocation)
            .filter(SessionCostAllocation.tm_charge_id.in_(tm_charge_ids))
            .filter(SessionCostAllocation.evcc_session_id != evcc_session_id)
            .filter(SessionCostAllocation.exclusion_reason.is_(None))
            .first()
        )

    def _load_active_overrides(self) -> dict:
        """Aktive manual_assign-Overrides: tm_charge_id -> evcc CTL-PK.

        Liest NUR die autoritative Tabelle matching_overrides (keine
        Regeländerung). Der Live-Matcher verwirft Overrides, die ausserhalb
        seines ±1-Tage-Zeitfensters liegen — fuer den Kostenexport zaehlt
        aber der bestätigte manuelle Override (Pflichtenheft §3:
        'bestaetigter manueller Override' ist exportfaehig).
        """
        from app.models.matching_override import MatchingOverride

        overrides = (
            self.db.query(MatchingOverride)
            .filter(MatchingOverride.override_type == "manual_assign")
            .order_by(MatchingOverride.id.desc())
            .all()
        )
        # Neuester Override je TM-Charge gewinnt
        out: dict = {}
        for ov in overrides:
            cid = int(ov.teslamate_charge_id)
            if cid not in out:
                ctl_id = self._resolve_ctl_session_id(ov.evcc_session_id)
                if ctl_id is not None:
                    out[cid] = {
                        "ctl_evcc_session_id": ctl_id,
                        "override_id": int(ov.id),
                    }
        return out

    def _resolve_ctl_session_id(self, source_or_pk):
        """Übersetzt EVCC-API-ID (source_id) ODER CTL-PK in den CTL-PK."""
        from app.models.session import SessionModel
        if source_or_pk is None:
            return None
        s = (
            self.db.query(SessionModel)
            .filter(SessionModel.source_type == "home")
            .filter(SessionModel.source_id == str(source_or_pk))
            .first()
        )
        if s is not None:
            return int(s.id)
        s = (
            self.db.query(SessionModel)
            .filter(SessionModel.source_type == "home")
            .filter(SessionModel.id == int(source_or_pk))
            .first()
        )
        return int(s.id) if s is not None else None

    def _other_exported(self, tm_charge_ids, evcc_session_id):
        return (
            self.db.query(TMCostExport)
            .filter(TMCostExport.tm_charge_id.in_(tm_charge_ids))
            .filter(TMCostExport.evcc_session_id != evcc_session_id)
            .filter(TMCostExport.status.in_(["exported", "approved"]))
            .first()
        )

    def _process_matches(self, matches, overrides: Optional[dict] = None, tm_charges: Optional[dict] = None) -> dict:
        """Verarbeitet Match-Ergebnisse (+ direkt injizierte manuelle Overrides).

        overrides:  {tm_charge_id: {'ctl_evcc_session_id': int, 'override_id': int}}
        tm_charges: {tm_charge_id: TeslaMateAPICharge} fuer Override-Injektion.
        """
        created = 0
        updated = 0
        overrides = overrides or {}
        tm_charges = tm_charges or {}

        # Ziel-Session je Override-Charge (CTL-PK)
        ov_target = {int(k): int(v["ctl_evcc_session_id"]) for k, v in overrides.items()}

        for m in matches:
            # WICHTIG: m.evcc_session_id ist die EVCC-API-ID (= source_id).
            # Allokationen referenzieren immer den CTL-PK aus der sessions-Tabelle.
            session = self._get_evcc_session(m.evcc_source_id)
            if session is None:
                # Noch nicht ins CTL synchronisiert -> kann nicht allokiert werden
                logger.info("Skip EVCC %s: keine CTL-Session (source_id=%s)", m.evcc_session_id, m.evcc_source_id)
                continue
            evcc_id = int(session.id)

            fragments = []
            # Ein Override auf DIESEM TM-Charge verdraengt jegliche Auto-Zuordnung
            # dieser Charge (Manual > Auto). Ist das Ziel genau diese Session,
            # werden ihre uebrigen Auto-Fragmente 'superseded' markiert
            # (keine echte Blockierung, aber auch nicht Teil des Exports).
            superseded_here = False

            for c in m.matched_charges:
                charge_key = int(c.charge_id)
                if charge_key in overrides:
                    if evcc_id == ov_target[charge_key]:
                        superseded_here = True
                    continue
                quality = getattr(c, "match_source", None) or m.match_quality
                if quality == "manual_override":
                    frag_quality = "manual_override"
                else:
                    frag_quality = m.match_quality
                # LiveMatchedCharge-Feld heisst charge_energy_used (NICHT *_kwh)
                used = _dec(getattr(c, "charge_energy_used", None))
                cp_id = getattr(c, "charging_process_id", None) or getattr(c, "charge_id", None)
                if not getattr(c, "accepted_as_candidate", True):
                    continue
                if used is None or used <= 0:
                    continue
                fragments.append({
                    "tm_charge_id": int(c.charge_id),
                    "charging_process_id": int(cp_id) if cp_id else None,
                    "match_quality": frag_quality,
                    "used": used,
                })

            energy = _dec(session.energy_kwh)
            cost = _dec(session.cost_eur)

            # Manual > Auto: Zielt ein bestätigter Override auf diese Session,
            # werden ALLE Auto-Fragmente hier 'superseded' markiert — sie
            # blockieren nicht, sind aber auch nicht Teil des Exports.
            if evcc_id in ov_target.values():
                for f in fragments:
                    row = (
                        self.db.query(SessionCostAllocation)
                        .filter_by(evcc_session_id=evcc_id, tm_charge_id=f["tm_charge_id"])
                        .first()
                    )
                    vals_superseded = dict(
                        exclusion_reason=SUPERSEDED_MARKER,
                        calculation_version=CALC_VERSION,
                    )
                    if row is None:
                        self.db.add(SessionCostAllocation(
                            evcc_session_id=evcc_id,
                            tm_charge_id=f["tm_charge_id"],
                            tm_charging_process_id=int(f["charging_process_id"] or 0),
                            match_quality=f["match_quality"],
                            allocation_basis="tm_used_kwh",
                            evcc_energy_kwh=float(energy or 0),
                            evcc_total_cost_eur=float(cost or 0),
                            tm_used_kwh=float(f["used"]),
                            tm_used_kwh_total=float(sum(x["used"] for x in fragments)),
                            effective_price_eur_per_kwh=None,
                            allocated_cost_eur=0.0,
                            **vals_superseded,
                        ))
                        created += 1
                    else:
                        row.exclusion_reason = SUPERSEDED_MARKER
                        row.calculation_version = CALC_VERSION
                        updated += 1
                continue  # reguläre Allokation dieser Session durch Overrides ersetzt

            reasons = []
            if cost is None or cost < 0:
                reasons.append("no_evcc_cost")
            if not fragments:
                reasons.append("no_accepted_match")
            else:
                bad_q = [f for f in fragments if f["match_quality"] not in EXPORTABLE_QUALITIES]
                if bad_q:
                    reasons.append("weak_or_rejected_match")
                if sum(f["used"] for f in fragments) <= 0:
                    reasons.append("tm_used_zero")
                if any(f["charging_process_id"] is None for f in fragments):
                    reasons.append("missing_charging_process_id")
                ids = [f["tm_charge_id"] for f in fragments]
                if self._find_other_allocation(ids, evcc_id) or self._other_exported(ids, evcc_id):
                    reasons.append("tm_charge_already_allocated_elsewhere")

            exportable = len(reasons) == 0

            alloc_result = None
            if exportable:
                try:
                    alloc_result = allocate_costs(
                        cost,
                        [f["used"] for f in fragments],
                        [f["tm_charge_id"] for f in fragments],
                    )
                except TMCostExportError as exc:
                    reasons.append("allocation_failed:%s" % exc)
                    exportable = False
                    alloc_result = None

            used_total = float(sum(f["used"] for f in fragments)) if fragments else 0.0

            for idx, f in enumerate(fragments):
                row = (
                    self.db.query(SessionCostAllocation)
                    .filter_by(evcc_session_id=evcc_id, tm_charge_id=f["tm_charge_id"])
                    .first()
                )

                allocated = float(_q2(f["used"]) * Decimal("0")) if alloc_result is None else float(
                    alloc_result["fragments"][idx]["allocated_cost_eur"]
                )
                eff_price = (
                    float(alloc_result["effective_price"].quantize(SIXPLACES, rounding=ROUND_HALF_UP))
                    if alloc_result is not None else None
                )

                vals = dict(
                    tm_charging_process_id=int(f["charging_process_id"]) if f["charging_process_id"] else 0,
                    match_quality=f["match_quality"],
                    allocation_basis="tm_used_kwh",
                    evcc_energy_kwh=float(energy) if energy is not None else 0.0,
                    evcc_total_cost_eur=float(cost) if cost is not None else 0.0,
                    tm_used_kwh=float(f["used"]),
                    tm_used_kwh_total=used_total,
                    effective_price_eur_per_kwh=eff_price,
                    allocated_cost_eur=allocated,
                    exclusion_reason=None if exportable else ";".join(reasons),
                    calculation_version=CALC_VERSION,
                )

                if row is None:
                    row = SessionCostAllocation(
                        evcc_session_id=evcc_id, tm_charge_id=f["tm_charge_id"], **vals
                    )
                    self.db.add(row)
                    created += 1
                else:
                    changed = False
                    for k, v in vals.items():
                        cur = getattr(row, k)
                        if k in ("evcc_total_cost_eur", "allocated_cost_eur"):
                            if cur is None or abs(float(cur) - float(v)) > 1e-9:
                                setattr(row, k, v); changed = True
                        elif cur != v:
                            setattr(row, k, v); changed = True
                    if changed:
                        updated += 1

        # ------------------------------------------------------------------
        # Override-Injektion: bestätigte manuelle Overrides werden als eigene
        # exportfähige Fragmente erzeugt (Daten direkt vom TM-API-Client).
        # Je Ziel-Session wird eine GRUPPEN-Allokation über alle Override-
        # Fragmente gerechnet (Manual > Auto: die Session hat sonst nur
        # superseded Auto-Fragmente).
        # ------------------------------------------------------------------
        from app.models.session import SessionModel as _SessionModel
        by_target: dict = {}
        for charge_id_str, info in overrides.items():
            by_target.setdefault(int(info["ctl_evcc_session_id"]), {})[int(charge_id_str)] = info

        for target, ov_map in by_target.items():
            # Chargen sammeln
            frags = []
            for charge_id_str in ov_map:
                charge_id = int(charge_id_str)
                ch = tm_charges.get(charge_id)
                if ch is None:
                    logger.warning("Override-Charge %s nicht im TM-Datenbestand", charge_id)
                    continue
                used = _dec(ch.charge_energy_used)
                if used is None or used <= 0:
                    continue
                frags.append({
                    "tm_charge_id": charge_id,
                    "charging_process_id": int(getattr(ch, "charging_process_id", 0) or 0) or charge_id,
                    "match_quality": "manual_override",
                    "used": used,
                })
            if not frags:
                continue

            session = self.db.get(_SessionModel, target)
            energy = _dec(session.energy_kwh) if session else None
            cost = _dec(session.cost_eur) if session else None

            # Auto-Zeilen dieser Charge auf ANDEREN Sessions deaktivieren
            ids = [f["tm_charge_id"] for f in frags]
            others = (
                self.db.query(SessionCostAllocation)
                .filter(SessionCostAllocation.tm_charge_id.in_(ids))
                .filter(SessionCostAllocation.evcc_session_id != target)
                .all()
            )
            for o in others:
                o.exclusion_reason = SUPERSEDED_MARKER

            reasons = []
            if cost is None or cost < 0:
                reasons.append("no_evcc_cost")

            used_total = float(sum(f["used"] for f in frags))
            alloc_result = None
            if not reasons:
                try:
                    alloc_result = allocate_costs(
                        cost,
                        [f["used"] for f in frags],
                        ids,
                    )
                except TMCostExportError as exc:
                    reasons.append("allocation_failed:%s" % exc)

            eff_price = (
                float(alloc_result["effective_price"].quantize(SIXPLACES, rounding=ROUND_HALF_UP))
                if alloc_result is not None else None
            )

            for idx, f in enumerate(frags):
                allocated = (
                    float(alloc_result["fragments"][idx]["allocated_cost_eur"])
                    if alloc_result is not None else 0.0
                )
                row = (
                    self.db.query(SessionCostAllocation)
                    .filter_by(evcc_session_id=target, tm_charge_id=f["tm_charge_id"])
                    .first()
                )
                vals = dict(
                    tm_charging_process_id=int(f["charging_process_id"]),
                    match_quality="manual_override",
                    allocation_basis="tm_used_kwh",
                    evcc_energy_kwh=float(energy) if energy is not None else 0.0,
                    evcc_total_cost_eur=float(cost) if cost is not None else 0.0,
                    tm_used_kwh=float(f["used"]),
                    tm_used_kwh_total=used_total,
                    effective_price_eur_per_kwh=eff_price,
                    allocated_cost_eur=allocated,
                    exclusion_reason=None if not reasons else ";".join(reasons),
                    calculation_version=CALC_VERSION,
                )
                if row is None:
                    self.db.add(SessionCostAllocation(
                        evcc_session_id=target, tm_charge_id=f["tm_charge_id"], **vals
                    ))
                    created += 1
                else:
                    changed = False
                    for k, v in vals.items():
                        cur = getattr(row, k)
                        if k in ("evcc_total_cost_eur", "allocated_cost_eur"):
                            if cur is None or abs(float(cur) - float(v)) > 1e-9:
                                setattr(row, k, v); changed = True
                        elif cur != v:
                            setattr(row, k, v); changed = True
                    if changed:
                        updated += 1

        self.db.commit()
        return {"created": created, "updated": updated, "sessions_seen": len(matches)}

    # ------------------------------------------------------------------
    # Lesen: Liste / Detail
    # ------------------------------------------------------------------
    def list_sessions(self, days: Optional[int] = None, status: Optional[str] = None):
        from app.models.session import SessionModel

        query = self.db.query(SessionModel).filter(SessionModel.source_type == "home")
        if days:
            cutoff = datetime.now(timezone.utc) - timedelta(days=days)
            query = query.filter(SessionModel.date >= cutoff)
        sessions = query.order_by(SessionModel.date.desc()).all()

        items = []
        for s in sessions:
            allocs = (
                self.db.query(SessionCostAllocation)
                .filter_by(evcc_session_id=s.id)
                .all()
            )
            exports = (
                self.db.query(TMCostExport)
                .filter_by(evcc_session_id=s.id)
                .all()
            )
            state = self._state_for(allocs, exports)
            # Nur exportfähige Zeilen zählen (Superseded/Blockierte bleiben außen vor)
            exportable_allocs = [a for a in allocs if _is_exportable_row(a.exclusion_reason)]
            tm_used_total = sum(a.tm_used_kwh for a in exportable_allocs) if exportable_allocs else 0.0
            planned_sum = sum(a.allocated_cost_eur for a in exportable_allocs) if exportable_allocs else 0.0
            loss = (s.energy_kwh or 0.0) - tm_used_total if exportable_allocs else None
            loss_pct = None
            if loss is not None and s.energy_kwh:
                loss_pct = round(loss / s.energy_kwh * 100, 1)

            item = {
                "evcc_session_id": s.id,
                "date": s.date.isoformat() if s.date else None,
                "location": s.location,
                "evcc_kwh": s.energy_kwh,
                "evcc_total_cost_eur": s.cost_eur,
                "fragment_count": len(allocs),
                "tm_used_kwh_total": round(tm_used_total, 3),
                "loss_kwh": round(loss, 3) if loss is not None else None,
                "loss_pct": loss_pct,
                "planned_export_eur": round(planned_sum, 2),
                "state": state,
                "block_reasons": [
                    r
                    for rr in {
                        a.exclusion_reason
                        for a in allocs
                        if _row_blocks(a.exclusion_reason)
                    }
                    for r in rr.split(";")
                ],
            }
            items.append(item)

        if status:
            items = [i for i in items if i["state"] == status]

        counts = {}
        for i in items:
            counts[i["state"]] = counts.get(i["state"], 0) + 1

        return {"data": items, "counts": counts}

    def _state_for(self, allocs, exports) -> str:
        if exports:
            statuses = {e.status for e in exports}
            if "failed" in statuses:
                return "failed"
            if "rolled_back" in statuses:
                return "rolled_back"
            if statuses <= {"exported"}:
                return "exported"
            if "approved" in statuses:
                return "approved"
            return "draft"
        if not allocs:
            return "draft"
        if any(_row_blocks(a.exclusion_reason) for a in allocs):
            return "blocked"
        return "draft"

    def detail(self, evcc_session_id: int) -> dict:
        from app.models.session import SessionModel

        s = (
            self.db.query(SessionModel)
            .filter(SessionModel.source_type == "home", SessionModel.id == evcc_session_id)
            .first()
        )
        if not s:
            raise TMCostExportError("EVCC-Session nicht gefunden")

        allocs = (
            self.db.query(SessionCostAllocation)
            .filter_by(evcc_session_id=s.id)
            .all()
        )
        exports = {
            e.tm_charge_id: e
            for e in self.db.query(TMCostExport).filter_by(evcc_session_id=s.id).all()
        }

        block_reasons = sorted({
            r
            for a in allocs if _row_blocks(a.exclusion_reason)
            for r in a.exclusion_reason.split(";")
        })
        state = self._state_for(allocs, list(exports.values()))

        charge_ids = [a.tm_charge_id for a in allocs]
        current_costs = {}
        if charge_ids:
            from app.services import tm_db
            cp_ids = [a.tm_charging_process_id for a in allocs]
            try:
                current_costs = tm_db.read_costs(cp_ids)
            except Exception as exc:
                logger.warning("TM read_costs fehlgeschlagen: %s", exc)

        fragments = []
        total_planned = Decimal("0")
        exportable_allocs = [a for a in allocs if _is_exportable_row(a.exclusion_reason)]
        for a in allocs:
            exp = exports.get(a.tm_charge_id)
            new_cost = float(a.allocated_cost_eur or 0)
            old_cost = None
            if exp is not None and exp.previous_tm_cost_eur is not None:
                old_cost = exp.previous_tm_cost_eur
            elif _is_exportable_row(a.exclusion_reason) and a.tm_charging_process_id in current_costs:
                old_cost = current_costs.get(a.tm_charging_process_id)

            fragments.append({
                "allocation_id": a.id,
                "tm_charge_id": a.tm_charge_id,
                "tm_charging_process_id": a.tm_charging_process_id,
                "match_quality": a.match_quality,
                "tm_used_kwh": a.tm_used_kwh,
                "old_tm_cost_eur": old_cost if _is_exportable_row(a.exclusion_reason) else None,
                "new_planned_tm_cost_eur": new_cost if _is_exportable_row(a.exclusion_reason) else None,
                "cost_source": "EVCC allokiert" if _is_exportable_row(a.exclusion_reason) else "nicht exportierbar",
                "exclusion_reason": a.exclusion_reason,
                "export_status": exp.status if exp else ("blocked" if _row_blocks(a.exclusion_reason) else ("superseded" if a.exclusion_reason else "draft")),
            })
            if _is_exportable_row(a.exclusion_reason):
                total_planned += Decimal(str(new_cost))

        tm_used_total = sum(a.tm_used_kwh for a in exportable_allocs) or 0.0
        loss = None
        loss_pct = None
        if exportable_allocs and s.energy_kwh:
            loss = s.energy_kwh - tm_used_total
            loss_pct = round(loss / s.energy_kwh * 100, 1)

        eff_price = None
        for a in exportable_allocs:
            if a.effective_price_eur_per_kwh:
                eff_price = a.effective_price_eur_per_kwh
                break

        exact = state != "blocked" and abs(float(total_planned) - float(s.cost_eur or 0)) < 0.005

        return {
            "evcc_session": {
                "id": s.id,
                "date": s.date.isoformat() if s.date else None,
                "location": s.location,
                "kwh": s.energy_kwh,
                "total_cost_eur": s.cost_eur,
            },
            "state": state,
            "block_reasons": block_reasons,
            "calculation_version": CALC_VERSION,
            "tm_fragment_count": len(allocs),
            "tm_used_kwh_total": round(tm_used_total, 3),
            "loss_kwh": round(loss, 3) if loss is not None else None,
            "loss_pct": loss_pct,
            "effective_price_eur_per_kwh": eff_price,
            "match_qualities": sorted({a.match_quality for a in allocs}),
            "sum_equals_evcc": exact,
            "sum_planned_eur": float(_q2(total_planned)),
            "tm_db_configured": False,  # wird im API-Layer befüllt
            "fragments": fragments,
        }

    # ------------------------------------------------------------------
    # Freigabe (NUR Audit-Status, kein TeslaMate-Write)
    # ------------------------------------------------------------------
    def approve(self, evcc_session_id: int) -> dict:
        allocs = (
            self.db.query(SessionCostAllocation)
            .filter_by(evcc_session_id=evcc_session_id)
            .all()
        )
        if not allocs:
            raise TMCostExportError("Keine Allokation vorhanden — erst berechnen")
        blocked = [a for a in allocs if _row_blocks(a.exclusion_reason)]
        if blocked:
            raise TMCostExportError("Session ist blockiert: %s" % blocked[0].exclusion_reason)

        now = datetime.now(timezone.utc)
        approved_n = 0
        for a in allocs:
            exp = (
                self.db.query(TMCostExport)
                .filter_by(evcc_session_id=evcc_session_id, tm_charge_id=a.tm_charge_id)
                .first()
            )
            if exp is None:
                exp = TMCostExport(
                    evcc_session_id=evcc_session_id,
                    tm_charge_id=a.tm_charge_id,
                    tm_charging_process_id=a.tm_charging_process_id,
                    allocation_id=a.id,
                    status="approved",
                    new_tm_cost_eur=float(a.allocated_cost_eur),
                    approved_at=now,
                    calculation_version=a.calculation_version,
                )
                self.db.add(exp)
                approved_n += 1
            elif exp.status == "exported":
                continue  # bereits exportiert — kein Re-Approve
            elif exp.status in ("draft", "failed", "rolled_back", "approved"):
                exp.status = "approved"
                exp.new_tm_cost_eur = float(a.allocated_cost_eur)
                exp.approved_at = now
                exp.error_message = None
                exp.allocation_id = a.id
                approved_n += 1

        self.db.commit()
        return {"approved": approved_n}

    # ------------------------------------------------------------------
    # Execute (atomarer TeslaMate-Writeback, braucht confirm=True)
    # ------------------------------------------------------------------
    def execute(self, evcc_session_id: int, confirm: bool) -> dict:
        if confirm is not True:
            raise TMCostExportError("Execute benoetigt explizit confirm=true")

        exports = (
            self.db.query(TMCostExport)
            .filter_by(evcc_session_id=evcc_session_id)
            .all()
        )
        pending = [e for e in exports if e.status == "approved"]
        if not pending:
            raise TMCostExportError(
                "Keine freigegebenen Eintraege — erst approve, dann execute"
            )

        from app.services import tm_db

        batch_id = uuid.uuid4().hex[:12]

        # previous Werte lesen (vor dem Schreiben sichern!)
        cp_ids = [e.tm_charging_process_id for e in pending]
        previous = tm_db.read_costs(cp_ids)

        updates = {}
        for e in pending:
            e.previous_tm_cost_eur = previous.get(e.tm_charging_process_id)
            e.export_batch_id = batch_id
            updates[e.tm_charging_process_id] = float(e.new_tm_cost_eur)

        try:
            tm_db.write_costs_atomically(updates)
        except Exception as exc:
            err = "%s: %s" % (type(exc).__name__, exc)
            for e in pending:
                e.status = "failed"
                e.error_message = err
            self.db.commit()
            return {"status": "failed", "error": err, "batch_id": batch_id}

        # Post-Commit-Verifikation
        verify = tm_db.verify_written_costs(updates)
        all_ok = all(verify.values())

        exported_at = datetime.now(timezone.utc)
        n_exported = 0
        for e in pending:
            ok = verify.get(e.tm_charging_process_id)
            if ok:
                e.status = "exported"
                e.exported_at = exported_at
                e.error_message = None
                n_exported += 1
            else:
                e.status = "failed"
                e.error_message = "Verifikation nach Commit fehlgeschlagen"

        self.db.commit()
        return {
            "status": "exported" if all_ok else "partial_failed",
            "exported": n_exported,
            "batch_id": batch_id,
            "verify": {str(k): v for k, v in verify.items()},
        }

    # ------------------------------------------------------------------
    # Rollback (previous Werte exakt zurueckschreiben, confirm=True)
    # ------------------------------------------------------------------
    def rollback(self, evcc_session_id: int, confirm: bool) -> dict:
        if confirm is not True:
            raise TMCostExportError("Rollback benoetigt explizit confirm=true")

        exports = [
            e
            for e in self.db.query(TMCostExport)
            .filter_by(evcc_session_id=evcc_session_id)
            .all()
            if e.status == "exported"
        ]
        if not exports:
            raise TMCostExportError("Keine exportierten Eintraege zum Rollback")

        from app.services import tm_db

        updates = {}
        missing_prev = []
        for e in exports:
            if e.previous_tm_cost_eur is None:
                missing_prev.append(e.tm_charge_id)
            else:
                updates[e.tm_charging_process_id] = float(e.previous_tm_cost_eur)

        if missing_prev:
            raise TMCostExportError(
                "previous_tm_cost_eur fehlt fuer TM-Charges: %s" % missing_prev
            )

        try:
            tm_db.write_costs_atomically(updates)
        except Exception as exc:
            err = "%s: %s" % (type(exc).__name__, exc)
            for e in exports:
                e.status = "failed"
                e.error_message = "Rollback failed: " + err
            self.db.commit()
            return {"status": "failed", "error": err}

        verify = tm_db.verify_written_costs(updates)
        rolled_at = datetime.now(timezone.utc)
        n_rolled = 0
        for e in exports:
            if verify.get(e.tm_charging_process_id):
                e.status = "rolled_back"
                e.rolled_back_at = rolled_at
                e.new_tm_cost_eur = float(e.previous_tm_cost_eur)
                e.error_message = None
                n_rolled += 1
            else:
                e.status = "failed"
                e.error_message = "Rollback-Verifikation fehlgeschlagen"

        self.db.commit()
        return {
            "status": "rolled_back" if n_rolled == len(exports) else "partial_failed",
            "rolled_back": n_rolled,
            "verify": {str(k): v for k, v in verify.items()},
        }
