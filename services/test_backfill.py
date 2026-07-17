"""Test für TeslaMate-Kosten-Backfill (Regel 9).

Validiert, dass backfill_teslamate_costs:
  - NUR existierende Charges anreichert (kein Anlegen neuer)
  - die Kosten korrekt aus PV/Grid-Split + Preisperioden berechnet
  - Fehler sauber sammelt
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.stats import backfill_teslamate_costs, compute_home_energy_split


class FakeTMClient:
    """Simuliert TeslaMateClient.update_charging_process_cost."""
    def __init__(self):
        self.calls = []

    def update_charging_process_cost(self, charge_id, cost):
        # Simuliert Erfolg für ID 101, Fehler für 102
        if charge_id == 102:
            raise RuntimeError("GraphQL: charging process not found")
        self.calls.append((charge_id, cost))


def fake_price(kind, date):
    return 0.32 if kind == "grid" else 0.08


def main():
    client = FakeTMClient()
    rows = [
        {"teslamate_session_id": 101, "created": "2026-01-01T10:00:00",
         "charged_kwh": 40.0, "solar_percentage": 60.0},
        {"teslamate_session_id": 102, "created": "2026-01-03T10:00:00",
         "charged_kwh": 30.0, "solar_percentage": 20.0},
        {"teslamate_session_id": None, "created": "2026-01-05T10:00:00",
         "charged_kwh": 15.0, "solar_percentage": 0.0},  # keine TM-Ref -> skip
    ]
    updated, errors = backfill_teslamate_costs(
        client, rows, fake_price, 0.32, 0.08)

    print(f"Updated: {updated} (erwartet 1: nur ID 101)")
    print(f"Errors: {errors} (erwartet 1: ID 102 GraphQL-Fehler)")
    print(f"TM calls: {client.calls}")
    assert updated == 1, f"Should update 1 charge, got {updated}"
    assert len(errors) == 1, f"Should have 1 error, got {len(errors)}"

    # Kostenprüfung für ID 101: 40kWh, 60% PV -> 24 PV, 16 Grid
    # cost = 16*0.32 + 24*0.08 = 5.12 + 1.92 = 7.04
    cid, cost = client.calls[0]
    assert cid == 101
    assert abs(cost - 7.04) < 0.01, f"Cost {cost} != 7.04"

    # Keine neuen Charges angelegt (nur Updates)
    assert len(client.calls) == 1

    print("\n✅ BACKFILL-TEST BESTANDEN – nur existierende Charges, korrekte Kosten.")


if __name__ == "__main__":
    main()
