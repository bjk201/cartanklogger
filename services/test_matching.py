"""Integrationstest für das neue Domänenmodell + CableSession-Matching.

Validiert:
  1. 1 EVCC-Session matched n TeslaMate-Teilcharges (nicht 1:1)
  2. battery_kwh = Summe der TM charge_energy_added
  3. charging_loss = wall - battery_sum (aus echten Daten)
  4. Externe Charges bleiben teslamate_only
  5. Keine Doppelzählung (matched_home zählt nur einmal)
"""
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.matching import (
    TeslaMateCharge, EVCCSession, CableSession, UnifiedCharge,
    match_evcc_to_teslamate,
    build_unified_home_charge,
    build_unified_external_charge,
    compute_home_energy_split,
)


def make_mock_data():
    """EVCC-Session mit 2 TM-Teilcharges (Kabelfenster). 1 extern."""
    base = datetime(2026, 1, 1, 12, 0, 0)

    # EVCC: 1 Home-Session, 40 kWh Wallbox, 60% PV
    ev_1 = EVCCSession(
        id=201, created=base, finished=base + timedelta(hours=2),
        loadpoint="Wallbox", vehicle="Mein EV", odometer=1000.0,
        meter_start=100.0, meter_stop=140.0, charged_energy_kwh=40.0, solar_percentage=60.0)
    # EVCC ohne TM (evcc_only)
    ev_orphan = EVCCSession(
        id=203, created=base + timedelta(days=10), finished=base + timedelta(days=10, hours=1),
        loadpoint="Wallbox", vehicle="Mein EV", odometer=1300.0,
        meter_start=170.0, meter_stop=185.0, charged_energy_kwh=15.0, solar_percentage=0.0)

    # TeslaMate: 2 Teilladungen innerhalb des EVCC-Fensters (Kabel verbunden)
    tm_part_1 = TeslaMateCharge(
        id=101, start_date=base + timedelta(minutes=5), end_date=base + timedelta(minutes=50),
        charge_energy_added=25.0, charge_energy_used=24.0, odometer=1000.0,
        geofence_name="Zuhause", address_name="Zuhause Garage", cost=None, car_id=1)
    tm_part_2 = TeslaMateCharge(
        id=102, start_date=base + timedelta(minutes=55), end_date=base + timedelta(minutes=110),
        charge_energy_added=15.0, charge_energy_used=14.5, odometer=1000.0,
        geofence_name="Zuhause", address_name="Zuhause Garage", cost=None, car_id=1)
    # TeslaMate extern
    tm_ext = TeslaMateCharge(
        id=501, start_date=base + timedelta(days=6), end_date=base + timedelta(days=6, hours=1),
        charge_energy_added=50.0, charge_energy_used=48.0, odometer=1250.0,
        geofence_name="Supercharger Beispielstadt", address_name="Supercharger Beispielstadt",
        cost=18.50, car_id=1)

    return [tm_part_1, tm_part_2, tm_ext], [ev_1, ev_orphan]


def main():
    home_geofences = ["zuhause", "garage"]
    tm_charges, ev_sessions = make_mock_data()

    cable_sessions, unmatched_evcc, unmatched_tm = match_evcc_to_teslamate(
        ev_sessions, tm_charges, home_geofences)

    print(f"CableSessions: {len(cable_sessions)} (erwartet 1)")
    print(f"Unmatched EVCC (evcc_only): {len(unmatched_evcc)} (erwartet 1: ev_orphan)")
    print(f"Unmatched TM: {len(unmatched_tm)} (erwartet 1: tm_ext)")
    assert len(cable_sessions) == 1
    assert len(unmatched_evcc) == 1
    assert len(unmatched_tm) == 1

    cable = cable_sessions[0]
    # 1 EVCC -> 2 TM-Teilcharges (NICHT 1:1)
    assert len(cable.teslamate_charges) == 2, "Sollte 2 TM-Teilcharges gruppieren"
    assert cable.teslamate_charge_ids == [101, 102]

    # battery_kwh = Summe TM (25 + 15 = 40)
    assert cable.battery_kwh == 40.0, f"battery_kwh {cable.battery_kwh} != 40.0"
    # wall_kwh = EVCC 40
    assert cable.wall_kwh == 40.0
    # charging_loss = 40 - 40 = 0
    assert cable.charging_loss_kwh == 0.0

    # UnifiedCharge bauen (Kosten via Grid 0.32, Feedin 0.08)
    uc = build_unified_home_charge(cable, 0.32, 0.08)
    print(f"\nUnified (matched_home): wall={uc.wall_kwh}, battery={uc.battery_kwh}, "
          f"tm_ids={uc.teslamate_charge_ids}")
    print(f"  pv%={uc.pv_share_pct}, pv_kwh={uc.pv_kwh}, grid_kwh={uc.grid_kwh}")
    print(f"  loss={uc.charging_loss_kwh}, cost={uc.total_cost} ({uc.cost_source})")
    assert uc.source_type == "matched_home"
    assert uc.wall_kwh == 40.0
    assert uc.battery_kwh == 40.0
    assert uc.pv_share_pct == 60.0
    assert uc.pv_kwh == 24.0
    assert uc.grid_kwh == 16.0
    assert uc.charging_loss_kwh == 0.0
    assert abs(uc.total_cost - 7.04) < 0.01

    # Extern
    uc_ext = build_unified_external_charge(unmatched_tm[0])
    assert uc_ext.source_type == "teslamate_only"
    assert uc_ext.location_type == "external"
    assert uc_ext.total_cost == 18.50

    # PV-Split
    pv, grid = compute_home_energy_split(50.0, 30.0)
    assert pv == 15.0 and grid == 35.0

    # Doppelzählung vermeiden
    all_unified = [uc]
    all_unified.append(build_unified_external_charge(unmatched_tm[0]))
    all_unified.append(UnifiedCharge(
        source_type="evcc_only", teslamate_charge_ids=[], evcc_session_id=unmatched_evcc[0].id,
        started_at=unmatched_evcc[0].created, finished_at=unmatched_evcc[0].finished,
        location_type="home", provider=unmatched_evcc[0].loadpoint,
        odometer_km=unmatched_evcc[0].odometer, battery_kwh=None,
        wall_kwh=unmatched_evcc[0].charged_energy_kwh, pv_share_pct=unmatched_evcc[0].solar_percentage,
        pv_kwh=None, grid_kwh=None, charging_loss_kwh=None, total_cost=None,
        cost_source="none", match_quality="none"))

    home_kwh = sum(u.wall_kwh or 0 for u in all_unified if u.location_type == "home")
    ext_kwh = sum(u.battery_kwh or 0 for u in all_unified if u.location_type == "external")
    print(f"\nGesamt Home-kWh (Wall): {home_kwh} | Extern-kWh (Akku): {ext_kwh}")
    # Home: 40 (matched) + 15 (evcc_only) = 55
    assert abs(home_kwh - 55.0) < 0.01
    assert abs(ext_kwh - 50.0) < 0.01

    print("\n✅ ALLE TESTS BESTANDEN – CableSession-Matching + UnifiedCharge korrekt.")


if __name__ == "__main__":
    main()
