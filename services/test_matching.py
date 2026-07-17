"""Integrationstest für das Domänenmodell + Matching.

Validiert, dass:
  1. Home-Charges zwischen EVCC und TeslaMate gematcht werden
  2. Externe Charges als teslamate_only erkannt werden
  3. Kosten/PV-Split/Ladeverlust aus echten Daten abgeleitet werden
  4. Keine Doppelzählung (matched_home zählt nur einmal)

Start: python -m services.test_matching  (aus Projekt-Root)
"""
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.matching import (
    TeslaMateCharge, EVCCSession, UnifiedCharge,
    match_evcc_to_teslamate,
    build_unified_charge_from_match,
    build_unified_external_charge,
    compute_home_energy_split,
)


def make_mock_data():
    """Erzeugt realistische Mock-Daten: 2 Home-Ladungen (EVCC+TM) + 1 extern (nur TM)."""
    base = datetime(2026, 1, 1, 12, 0, 0)

    # TeslaMate: 2 Home + 1 extern
    tm_home_1 = TeslaMateCharge(
        id=101, start_date=base, end_date=base + timedelta(hours=2),
        charge_energy_added=40.0, charge_energy_used=38.0, odometer=1000.0,
        geofence_name="Zuhause", address_name="Zuhause Garage", cost=None, car_id=1)
    tm_home_2 = TeslaMateCharge(
        id=102, start_date=base + timedelta(days=3), end_date=base + timedelta(days=3, hours=1),
        charge_energy_added=30.0, charge_energy_used=28.5, odometer=1100.0,
        geofence_name="Zuhause", address_name="Zuhause Garage", cost=None, car_id=1)
    tm_ext = TeslaMateCharge(
        id=501, start_date=base + timedelta(days=6), end_date=base + timedelta(days=6, hours=1),
        charge_energy_added=50.0, charge_energy_used=48.0, odometer=1250.0,
        geofence_name="Supercharger Beispielstadt", address_name="Supercharger Beispielstadt",
        cost=18.50, car_id=1)

    # EVCC: 2 Home (gleiche Zeit/Energie wie tm_home_1/2)
    ev_1 = EVCCSession(
        id=201, created=base, finished=base + timedelta(hours=2),
        loadpoint="Wallbox", vehicle="Mein EV", odometer=1000.0,
        meter_start=100.0, meter_stop=140.0, charged_energy_kwh=40.0, solar_percentage=60.0)
    ev_2 = EVCCSession(
        id=202, created=base + timedelta(days=3), finished=base + timedelta(days=3, hours=1),
        loadpoint="Wallbox", vehicle="Mein EV", odometer=1100.0,
        meter_start=140.0, meter_stop=170.0, charged_energy_kwh=30.0, solar_percentage=20.0)
    # EVCC ohne TM-Gegenstück (z.B. kurzer Top-Up, TM hat keine Charge)
    ev_orphan = EVCCSession(
        id=203, created=base + timedelta(days=10), finished=base + timedelta(days=10, hours=1),
        loadpoint="Wallbox", vehicle="Mein EV", odometer=1300.0,
        meter_start=170.0, meter_stop=185.0, charged_energy_kwh=15.0, solar_percentage=0.0)

    return [tm_home_1, tm_home_2, tm_ext], [ev_1, ev_2, ev_orphan]


def main():
    home_geofences = ["zuhause", "garage"]
    tm_charges, ev_sessions = make_mock_data()

    matched, unmatched_evcc, unmatched_tm = match_evcc_to_teslamate(
        ev_sessions, tm_charges, home_geofences)

    print(f"Matched Home: {len(matched)} (erwartet 2)")
    print(f"Unmatched EVCC (evcc_only): {len(unmatched_evcc)} (erwartet 1: ev_orphan)")
    print(f"Unmatched TM: {len(unmatched_tm)} (erwartet 1: tm_ext)")

    assert len(matched) == 2, "Sollte 2 gematchte Home-Ladungen geben"
    assert len(unmatched_evcc) == 1, "Sollte 1 verwaiste EVCC-Session geben"
    assert len(unmatched_tm) == 1, "Sollte 1 ungematchte TM-Charge (extern) geben"

    # Unified Charge aus Match bauen (Kosten via Grid 0.32, Feedin 0.08)
    grid = 0.32
    feedin = 0.08
    uc1 = build_unified_charge_from_match(matched[0][0], matched[0][1], grid, feedin)
    print(f"\nUnified (match 1): source={uc1.source_type}, wall={uc1.wall_kwh}, "
          f"battery={uc1.battery_kwh}, pv%={uc1.pv_share_pct}")
    print(f"  pv_kwh={uc1.pv_kwh}, grid_kwh={uc1.grid_kwh}, "
          f"loss={uc1.charging_loss_kwh}, cost={uc1.total_cost} ({uc1.cost_source})")
    assert uc1.source_type == "matched_home"
    assert uc1.wall_kwh == 40.0
    assert uc1.battery_kwh == 40.0  # charge_energy_added
    assert uc1.pv_share_pct == 60.0
    assert uc1.pv_kwh == 24.0       # 40 * 0.6
    assert uc1.grid_kwh == 16.0     # 40 - 24
    assert uc1.charging_loss_kwh == 0.0  # 40 (wall) >= 40 (battery) -> 0
    # Kosten: 16*0.32 + 24*0.08 = 5.12 + 1.92 = 7.04
    assert abs(uc1.total_cost - 7.04) < 0.01, f"Kosten {uc1.total_cost} != 7.04"

    # Externe Charge
    uc_ext = build_unified_external_charge(unmatched_tm[0])
    print(f"\nUnified (extern): source={uc_ext.source_type}, battery={uc_ext.battery_kwh}, "
          f"cost={uc_ext.total_cost} ({uc_ext.cost_source})")
    assert uc_ext.source_type == "teslamate_only"
    assert uc_ext.location_type == "external"
    assert uc_ext.total_cost == 18.50
    assert uc_ext.cost_source == "teslamate"

    # PV-Split Check
    pv, grid_k = compute_home_energy_split(50.0, 30.0)
    assert pv == 15.0 and grid_k == 35.0

    # Doppelzählung vermeiden: matched_home + teslamate_only müssen getrennt sein
    all_unified = []
    for ev, tm in matched:
        all_unified.append(build_unified_charge_from_match(ev, tm, grid, feedin))
    for tm in unmatched_tm:
        all_unified.append(build_unified_external_charge(tm))
    for ev in unmatched_evcc:
        # evcc_only: eigenständige Home-Ladung
        all_unified.append(UnifiedCharge(
            source_type="evcc_only", teslamate_charge_id=None, evcc_session_id=ev.id,
            started_at=ev.created, finished_at=ev.finished, location_type="home",
            provider=ev.loadpoint, odometer_km=ev.odometer, battery_kwh=None,
            wall_kwh=ev.charged_energy_kwh, pv_share_pct=ev.solar_percentage,
            pv_kwh=None, grid_kwh=None, charging_loss_kwh=None, total_cost=None,
            cost_source="none", match_quality="none"))

    home_kwh = sum(u.wall_kwh or 0 for u in all_unified if u.location_type == "home")
    ext_kwh = sum(u.battery_kwh or 0 for u in all_unified if u.location_type == "external")
    print(f"\nGesamt Home-kWh (Wall): {home_kwh} | Extern-kWh (Akku): {ext_kwh}")
    # Home: 40 + 30 (matched) + 15 (evcc_only) = 85
    assert abs(home_kwh - 85.0) < 0.01
    # Extern: 50 (nur TM)
    assert abs(ext_kwh - 50.0) < 0.01

    print("\n✅ ALLE TESTS BESTANDEN – Domänenmodell + Matching korrekt.")


if __name__ == "__main__":
    main()
