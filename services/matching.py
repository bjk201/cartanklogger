"""Domänenmodell + Matching-Logik für CarTankLogger.

Architektur (fachlich gewollt, keine Notlösung):
  - TeslaMate = Primärquelle für Fahrzeug-/Fahr-/Charge-Historie.
  - EVCC       = Primärquelle für Home-Ladekosten (Wallbox-Energie, PV-Anteil),
                 weil EVCC die reale Home-Session zwischen Einstecken und
                 Ausstecken als EINE Session zusammenfasst.
  - App        = Matching-/Kosten-/Statistik-Layer.

Home-Matching:
  - 1 EVCC-Session  = führende CableSession (Einstecken -> Ausstecken)
  - n TeslaMate-Charges innerhalb desselben Kabel-Zeitfensters
    = Teilereignisse derselben Home-Ladung.
  - wall_kwh / pv_share / Kosten = EVCC (führend).
  - battery_kwh = Summe der TeslaMate charge_energy_added (ergänzend).
  - charging_loss_kwh = wall_kwh - battery_kwh (aus echten Daten).

Externe Charges:
  - primär aus TeslaMate (nicht an Home-Geofence).
  - Kosten aus TeslaMate oder manueller Korrektur.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List


@dataclass
class TeslaMateCharge:
    id: int
    start_date: datetime
    end_date: Optional[datetime]
    charge_energy_added: float
    charge_energy_used: Optional[float]
    odometer: Optional[float]
    geofence_name: Optional[str]
    address_name: Optional[str]
    cost: Optional[float]
    car_id: Optional[int]


@dataclass
class EVCCSession:
    id: int
    created: datetime
    finished: Optional[datetime]
    loadpoint: Optional[str]
    vehicle: Optional[str]
    odometer: Optional[float]
    meter_start: Optional[float]
    meter_stop: Optional[float]
    charged_energy_kwh: float
    solar_percentage: Optional[float]


@dataclass
class CableSession:
    """Logische Home-Ladesession = EVCC-Session + zugehörige TeslaMate-Teilcharges.

    EVCC ist führend für wall_kwh / Kosten.
    TeslaMate liefert die Akku-Teilcharges (battery_kwh = Summe).
    """
    evcc_session: EVCCSession
    teslamate_charges: List[TeslaMateCharge] = field(default_factory=list)

    @property
    def evcc_session_id(self) -> int:
        return self.evcc_session.id

    @property
    def teslamate_charge_ids(self) -> List[int]:
        return [c.id for c in self.teslamate_charges]

    @property
    def started_at(self) -> datetime:
        return self.evcc_session.created

    @property
    def finished_at(self) -> Optional[datetime]:
        return self.evcc_session.finished

    @property
    def wall_kwh(self) -> float:
        return self.evcc_session.charged_energy_kwh

    @property
    def battery_kwh(self) -> Optional[float]:
        """Summe der TeslaMate Akkuenergie über alle Teilladungen."""
        if not self.teslamate_charges:
            return None
        total = 0.0
        for c in self.teslamate_charges:
            e = c.charge_energy_added or c.charge_energy_used or 0
            total += float(e)
        return round(total, 3)

    @property
    def pv_share_pct(self) -> float:
        return self.evcc_session.solar_percentage or 0.0

    @property
    def odometer_km(self) -> Optional[float]:
        return self.evcc_session.odometer or (
            self.teslamate_charges[0].odometer if self.teslamate_charges else None)

    @property
    def provider(self) -> Optional[str]:
        return self.evcc_session.loadpoint or (
            self.teslamate_charges[0].geofence_name if self.teslamate_charges else None)

    @property
    def charging_loss_kwh(self) -> Optional[float]:
        b = self.battery_kwh
        w = self.wall_kwh
        if b is None:
            return None
        if w >= b:
            return round(w - b, 3)
        # wall < battery: Messunschaerfe (z.B. TM zaehlt mehr) -> 0, nicht negativ
        return 0.0


@dataclass
class UnifiedCharge:
    source_type: str                  # matched_home | teslamate_only | evcc_only
    teslamate_charge_ids: List[int]   # bei matched_home: alle Teilcharges
    evcc_session_id: Optional[int]
    started_at: datetime
    finished_at: Optional[datetime]
    location_type: str               # home | external | unknown
    provider: Optional[str]
    odometer_km: Optional[float]

    battery_kwh: Optional[float]     # TeslaMate: Akkuenergie (Summe bei Home)
    wall_kwh: Optional[float]        # EVCC: Wallbox-/Netzseite (führend zuhause)
    pv_share_pct: Optional[float]

    pv_kwh: Optional[float]
    grid_kwh: Optional[float]
    charging_loss_kwh: Optional[float]

    total_cost: Optional[float]
    cost_source: str                 # teslamate | evcc_calc | manual | none
    match_quality: str               # exact | fuzzy | none


def is_home_charge(tm_charge: TeslaMateCharge, home_geofences: List[str]) -> bool:
    """True, wenn eine TeslaMate-Ladung als Zuhause gilt (Geofence/Adresse)."""
    text = f"{tm_charge.geofence_name or ''} {tm_charge.address_name or ''}".lower()
    return any(g.lower() in text for g in home_geofences)


def minutes_between(a: datetime, b: datetime) -> float:
    return abs((a - b).total_seconds()) / 60.0


def energy_close(a: Optional[float], b: Optional[float], tolerance_kwh: float = 8.0) -> bool:
    """Plausibilitätsprüfung: EVCC wall_kwh vs Summe TM battery_kwh.

    Toleranz großzügiger (8 kWh), da TM-Teilcharges oft nicht exakt die
    EVCC-Wallbox-Energie abbilden (andere Messpunkte). Dient nur als
    Plausibilitäts-Check, nicht als harte Match-Bedingung.
    """
    if a is None or b is None:
        return False
    return abs(a - b) <= tolerance_kwh


def match_evcc_to_teslamate(
    evcc_sessions: List[EVCCSession],
    teslamate_charges: List[TeslaMateCharge],
    home_geofences: List[str],
    start_tolerance_min: int = 120,
    end_tolerance_min: int = 120,
):
    """Matcht EVCC-Home-Sessions gegen TeslaMate-Home-Charges.

    Match-Einheit:
      - 1 EVCC-Session  (führende CableSession: Einstecken -> Ausstecken)
      - n TeslaMate-Charges innerhalb desselben Kabel-Zeitfensters
        (alle TM-Charges mit start_date im [EVCC.created - tol, EVCC.finished + tol]
         UND Home-Geofence).

    Rückgabe: (cable_sessions, unmatched_evcc, unmatched_tm)
      cable_sessions : Liste von CableSession (EVCC + gruppierte TM-Teilcharges)
      unmatched_evcc : EVCC-Sessions ohne TM-Teilcharge (-> evcc_only)
      unmatched_tm   : TM-Charges ohne EVCC-Gegenstück (extern oder rein-TM-Home)
    """
    cable_sessions = []
    unmatched_evcc = []
    used_tm_ids = set()

    home_tm = [c for c in teslamate_charges if is_home_charge(c, home_geofences)]

    for ev in evcc_sessions:
        # Kabel-Zeitfenster aus EVCC-Session
        ev_start = ev.created
        ev_end = ev.finished or ev.created
        window_start = ev_start - timedelta(minutes=start_tolerance_min)
        window_end = ev_end + timedelta(minutes=end_tolerance_min)

        # Alle Home-TM-Charges, die zeitlich in das Kabel-Fenster fallen
        group = []
        for tm in home_tm:
            if tm.id in used_tm_ids:
                continue
            if tm.start_date is None:
                continue
            if window_start <= tm.start_date <= window_end:
                group.append(tm)

        if group:
            # beste TM-Charge als Anker (früheste), alle anderen als Teilladungen
            group.sort(key=lambda c: c.start_date or datetime.min)
            for tm in group:
                used_tm_ids.add(tm.id)
            cable_sessions.append(CableSession(evcc_session=ev, teslamate_charges=group))
        else:
            unmatched_evcc.append(ev)

    unmatched_tm = [tm for tm in teslamate_charges if tm.id not in used_tm_ids]
    return cable_sessions, unmatched_evcc, unmatched_tm


def compute_home_energy_split(wall_kwh: float, solar_percentage: Optional[float]):
    """PV-/Grid-Split aus Wallbox-kWh und Solar-Anteil (0..100)."""
    solar_percentage = solar_percentage or 0.0
    solar_percentage = max(0.0, min(100.0, float(solar_percentage)))
    pv_kwh = wall_kwh * solar_percentage / 100.0
    grid_kwh = max(0.0, wall_kwh - pv_kwh)
    return round(pv_kwh, 3), round(grid_kwh, 3)


def build_unified_home_charge(
    cable: CableSession,
    grid_price_per_kwh: float,
    feedin_price_per_kwh: float,
) -> UnifiedCharge:
    """Baut eine UnifiedCharge aus einer CableSession (EVCC + gruppierte TM).

    EVCC ist führend für wall_kwh / pv_share / Kosten.
    TeslaMate liefert battery_kwh (Summe der Teilladungen).
    """
    wall_kwh = cable.wall_kwh
    battery_kwh = cable.battery_kwh
    pv_share_pct = cable.pv_share_pct

    pv_kwh, grid_kwh = compute_home_energy_split(wall_kwh, pv_share_pct)
    charging_loss = cable.charging_loss_kwh

    total_cost = round(grid_kwh * grid_price_per_kwh + pv_kwh * feedin_price_per_kwh, 2)

    # Match-Qualität: exact wenn Energien plausibel nahe beieinander, sonst fuzzy
    energy_ok = energy_close(wall_kwh, battery_kwh, tolerance_kwh=8.0) if battery_kwh else False
    match_quality = "exact" if (battery_kwh is not None and energy_ok) else "fuzzy"

    return UnifiedCharge(
        source_type="matched_home",
        teslamate_charge_ids=cable.teslamate_charge_ids,
        evcc_session_id=cable.evcc_session_id,
        started_at=cable.started_at,
        finished_at=cable.finished_at,
        location_type="home",
        provider=cable.provider,
        odometer_km=cable.odometer_km,
        battery_kwh=battery_kwh,
        wall_kwh=wall_kwh,
        pv_share_pct=round(pv_share_pct, 1),
        pv_kwh=pv_kwh,
        grid_kwh=grid_kwh,
        charging_loss_kwh=charging_loss,
        total_cost=total_cost,
        cost_source="evcc_calc",
        match_quality=match_quality,
    )


def build_unified_external_charge(tm: TeslaMateCharge) -> UnifiedCharge:
    battery_kwh = tm.charge_energy_added or tm.charge_energy_used

    return UnifiedCharge(
        source_type="teslamate_only",
        teslamate_charge_ids=[tm.id],
        evcc_session_id=None,
        started_at=tm.start_date,
        finished_at=tm.end_date,
        location_type="external",
        provider=tm.geofence_name or tm.address_name,
        odometer_km=tm.odometer,
        battery_kwh=battery_kwh,
        wall_kwh=None,
        pv_share_pct=None,
        pv_kwh=None,
        grid_kwh=None,
        charging_loss_kwh=None,
        total_cost=tm.cost,
        cost_source="teslamate" if tm.cost is not None else "none",
        match_quality="none",
    )


# timedelta import ans Ende, damit die Dataclass-Typen oben sauber stehen
from datetime import timedelta  # noqa: E402
