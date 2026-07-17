"""Domänenmodell + Matching-Logik für CarTankLogger.

Architektur-Idee (TeslaMate als Primärquelle):
  - TeslaMateCharge : vollständige Charge-Historie (auch Home)
  - EVCCSession     : ergänzende Home-Charging-Daten (Wallbox, PV, Odometer, Loadpoint)
  - UnifiedCharge    : vereinheitlichtes Objekt nach Matching

Home-Charges werden zwischen TeslaMate und EVCC gematcht. Externe Charges
kommen primär aus TeslaMate. Die App ist der Matching-/Kosten-/Statistik-Layer.
"""
from dataclasses import dataclass
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
class UnifiedCharge:
    source_type: str                  # teslamate_only | evcc_only | matched_home
    teslamate_charge_id: Optional[int]
    evcc_session_id: Optional[int]
    started_at: datetime
    finished_at: Optional[datetime]
    location_type: str               # home | external | unknown
    provider: Optional[str]
    odometer_km: Optional[float]

    battery_kwh: Optional[float]     # TeslaMate: Akkuenergie
    wall_kwh: Optional[float]        # EVCC: Wallbox-/Netzseite
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


def energy_close(a: Optional[float], b: Optional[float], tolerance_kwh: float = 4.0) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) <= tolerance_kwh


def match_evcc_to_teslamate(
    evcc_sessions: List[EVCCSession],
    teslamate_charges: List[TeslaMateCharge],
    home_geofences: List[str],
    start_tolerance_min: int = 90,
    energy_tolerance_kwh: float = 5.0,
):
    """Matcht EVCC-Home-Sessions gegen TeslaMate-Home-Charges.

    Rückgabe: (matched, unmatched_evcc, unmatched_tm)
      matched          : Liste von (EVCCSession, TeslaMateCharge)
      unmatched_evcc   : EVCC-Sessions ohne TM-Gegenstück (-> evcc_only)
      unmatched_tm     : TM-Charges ohne EVCC-Gegenstück
                         (Home -> entweder extern-ähnlich oder nur-TM-Home)
    """
    matched = []
    unmatched_evcc = []
    used_tm_ids = set()

    home_tm = [c for c in teslamate_charges if is_home_charge(c, home_geofences)]

    for ev in evcc_sessions:
        best = None
        best_score = None
        for tm in home_tm:
            if tm.id in used_tm_ids:
                continue

            start_diff = minutes_between(ev.created, tm.start_date)
            if start_diff > start_tolerance_min:
                continue

            tm_energy = tm.charge_energy_used or tm.charge_energy_added
            if tm_energy is None:
                continue

            if not energy_close(ev.charged_energy_kwh, tm_energy, energy_tolerance_kwh):
                continue

            score = start_diff + abs(ev.charged_energy_kwh - tm_energy) * 10
            if best is None or best_score is None or score < best_score:
                best = tm
                best_score = score

        if best:
            used_tm_ids.add(best.id)
            matched.append((ev, best))
        else:
            unmatched_evcc.append(ev)

    unmatched_tm = [tm for tm in teslamate_charges if tm.id not in used_tm_ids]
    return matched, unmatched_evcc, unmatched_tm


def compute_home_energy_split(wall_kwh: float, solar_percentage: Optional[float]):
    """PV-/Grid-Split aus Wallbox-kWh und Solar-Anteil (0..100)."""
    solar_percentage = solar_percentage or 0.0
    solar_percentage = max(0.0, min(100.0, float(solar_percentage)))
    pv_kwh = wall_kwh * solar_percentage / 100.0
    grid_kwh = max(0.0, wall_kwh - pv_kwh)
    return round(pv_kwh, 3), round(grid_kwh, 3)


def build_unified_charge_from_match(
    ev: EVCCSession,
    tm: TeslaMateCharge,
    grid_price_per_kwh: float,
    feedin_price_per_kwh: float,
) -> UnifiedCharge:
    wall_kwh = ev.charged_energy_kwh
    battery_kwh = tm.charge_energy_added or tm.charge_energy_used
    pv_share_pct = ev.solar_percentage or 0.0

    pv_kwh, grid_kwh = compute_home_energy_split(wall_kwh, pv_share_pct)

    charging_loss = None
    if battery_kwh is not None and wall_kwh is not None and wall_kwh >= battery_kwh:
        charging_loss = round(wall_kwh - battery_kwh, 3)

    total_cost = round(grid_kwh * grid_price_per_kwh + pv_kwh * feedin_price_per_kwh, 2)

    return UnifiedCharge(
        source_type="matched_home",
        teslamate_charge_id=tm.id,
        evcc_session_id=ev.id,
        started_at=ev.created,
        finished_at=ev.finished or tm.end_date,
        location_type="home",
        provider=ev.loadpoint or tm.geofence_name,
        odometer_km=ev.odometer or tm.odometer,
        battery_kwh=battery_kwh,
        wall_kwh=wall_kwh,
        pv_share_pct=round(pv_share_pct, 1),
        pv_kwh=pv_kwh,
        grid_kwh=grid_kwh,
        charging_loss_kwh=charging_loss,
        total_cost=total_cost,
        cost_source="evcc_calc",
        match_quality="fuzzy",
    )


def build_unified_external_charge(tm: TeslaMateCharge) -> UnifiedCharge:
    battery_kwh = tm.charge_energy_added or tm.charge_energy_used

    return UnifiedCharge(
        source_type="teslamate_only",
        teslamate_charge_id=tm.id,
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
