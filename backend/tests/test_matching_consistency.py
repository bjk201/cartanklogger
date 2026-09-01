"""Konsistenz-Test: Matching-Logik muess uebereinstimmen.

Pflichtenheft-Kernregel: Wenn das Matching in der Session-Ansicht passt,
muss der TM-Kostenexport DASSELBE Ergebnis liefern — der bestätigte
manuelle Override ist in beiden Sichten exportfähig.

Getestet wird der kritische Bug: Override-Ziel in falschem ID-Raum
(EVCC-API-ID statt CTL-PK) — Match-Zuordnung vs. TM-Kostenexport.

Start: python3 backend/tests/test_matching_consistency.py
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="ctl20_matchcons_test_")
os.environ["DB_PATH"] = os.path.join(_TMP, "test.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import SessionLocal, init_db  # noqa: E402
from app.models.session import SessionModel  # noqa: E402
from app.models.matching_override import MatchingOverride, OverrideType  # noqa: E402
from app.services import tm_db  # noqa: E402
from app.services.override_target import (  # noqa: E402
    get_effective_manual_overrides,
    resolve_session_target,
)
from app.services.tm_cost_export_service import TMCostExportService  # noqa: E402
from app.main import app  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  PASS %s" % name)
    else:
        FAIL.append((name, detail))
        print("  FAIL %s  %s" % (name, detail))


# Fake-TeslaMate-Postgres (wie in test_tm_cost_export.py)
FAKE_TM_COSTS = {}


def fake_read_costs(ids):
    return {i: FAKE_TM_COSTS.get(i) for i in ids}


def fake_write_costs_atomically(updates):
    for cp_id, cost in updates.items():
        FAKE_TM_COSTS[cp_id] = cost


def fake_verify_written_costs(expected):
    return {
        cp_id: FAKE_TM_COSTS.get(cp_id) is not None and abs(FAKE_TM_COSTS[cp_id] - want) < 0.005
        for cp_id, want in expected.items()
    }


tm_db.read_costs = fake_read_costs
tm_db.write_costs_atomically = fake_write_costs_atomically
tm_db.verify_written_costs = fake_verify_written_costs

init_db()
client = TestClient(app)
db = SessionLocal()


def seed_session(pk, source_id, energy, cost, when):
    s = SessionModel(
        id=pk,
        source_id=str(source_id),
        source_type="home",
        date=when,
        location="Zuhause",
        energy_kwh=energy,
        cost_eur=cost,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return int(s.id)


# Konstruiere exakt die Bug-Situation: PK- und EVCC-ID-Raum kollidieren.
# Session A: CTL-PK=93, EVCC source_id='30' (wie im echten Datenbestand).
# Session B: CTL-PK=30,  EVCC source_id='93'  -> Zahl 30/93 existiert in BEIDEN Räumen.
PK_A = seed_session(93, "30", 15.454, 1.52262230769867, datetime(2026, 7, 22, 16, 30, 0))
PK_B = seed_session(30, "93", 8.0, 0.80, datetime(2026, 8, 20, 12, 0, 0))

print("\n== 1) Zahlenraum-Kollision konstruiert ==")
check("PK_A ist 93 (Bug-Reproduktion)", PK_A == 93, str(PK_A))
check("PK_B ist 30 (Bug-Reproduktion)", PK_B == 30, str(PK_B))

print("\n== 2) resolve_session_target: beide ID-Räume ==")
# Override-Ziel als CTL-PK gespeichert (heutiger API-Layer): eindeutig.
t_pk = resolve_session_target(db, 30, ref_dt=None)
check("Ziel 30 als CTL-PK -> Session B (Fallback ohne Zeitkontext)", t_pk == PK_B, str(t_pk))
# Override-Ziel im EVCC-ID-Raum gespeichert (Bestandszeile), Override
# kurz nach der Ladung erstellt: Zeitfenster entscheidet pro Session A.
t_evcc = resolve_session_target(db, 30, ref_dt=datetime(2026, 7, 23, 10, 0, 0))
check("Ziel 30 mit Zeitfenster -> EVCC-ID-Raum gewinnt (Session A)", t_evcc == PK_A, str(t_evcc))
# Unbekannte Zahl -> None
check("Unbekanntes Ziel -> None", resolve_session_target(db, 424242) is None)

print("\n== 3) get_effective_manual_overrides: bestätigte Overrides ==")
ov_evcc = MatchingOverride(
    teslamate_charge_id=2412,
    evcc_session_id=30,  # EVCC-API-ID von Session A (Bestandszeile)
    override_type=OverrideType.manual_assign,
    reason="Manual match via UI (Bestand)",
    created_by="user",
    created_at=datetime(2026, 7, 23, 10, 4, 17),
)
db.add(ov_evcc)
db.commit()
eff = get_effective_manual_overrides(db)
ov_map = {o["tm_charge_id"]: o for o in eff}
check("Override 2412 aktiv", 2412 in ov_map, str(eff))
check(
    "Override-Ziel korrekt auf Session A aufgelöst (nicht Session B)",
    ov_map.get(2412, {}).get("ctl_session_id") == PK_A,
    str(ov_map.get(2412)),
)

print("\n== 4) Session-Ansicht == TM-Kostenexport (dieselbe Charge) ==")


class FakeCharge:
    def __init__(self, cid, used, cp=None, src="auto"):
        self.charge_id = cid
        self.charge_energy_used = used
        self.charging_process_id = cp or cid + 1000
        self.match_source = src
        self.accepted_as_candidate = True


class FakeMatch:
    def __init__(self, evcc_id, source_id, charges, quality="plausible"):
        self.evcc_session_id = evcc_id
        self.evcc_source_id = source_id
        self.matched_charges = charges
        self.match_quality = quality


svc = TMCostExportService(SessionLocal())
svc.set_live_matches_fixture([FakeMatch(PK_A, "30", [FakeCharge(2412, 3.0, src="manual_override")])])
svc._fixture_overrides = {2412: {"ctl_evcc_session_id": PK_A, "override_id": ov_evcc.id}}
res = svc._process_matches([], overrides=svc._fixture_overrides, tm_charges={
    2412: FakeCharge(2412, 3.0),
})
check("Allokation erzeugt (created=1)", res["created"] == 1, str(res))

from app.models.tm_cost_export import SessionCostAllocation  # noqa: E402

rows = SessionLocal().query(SessionCostAllocation).filter_by(evcc_session_id=PK_A).all()
exportable = [r for r in rows if r.exclusion_reason is None]
check("Session A hat exportierbare manual_override-Zeile", len(exportable) == 1, str([(r.tm_charge_id, r.match_quality, r.exclusion_reason) for r in rows]))
check("Match-Qualität manual_override", exportable and exportable[0].match_quality == "manual_override")
check("Geplanter Exportbetrag == EVCC-Kosten", exportable and abs(exportable[0].allocated_cost_eur - 1.52262230769867) < 0.01,
      str(exportable[0].allocated_cost_eur if exportable else None))

# Export-Detail: state draft, keine Blockgruende, sum_equals_evcc
d = client.get("/api/tm-cost-export/%d" % PK_A).json()
check("Detail: state draft (exportfähig nach Freigabe)", d.get("state") == "draft", str(d.get("state")))
check("Detail: keine Blockierungsgruende", d.get("block_reasons") == [], str(d.get("block_reasons")))
check("Detail: match_qualities enthaelt manual_override", "manual_override" in d.get("match_qualities", []), str(d.get("match_qualities")))
check("Detail: sum_equals_evcc", d.get("sum_equals_evcc") is True, str(d.get("sum_equals_evcc")))

# Freigabe + Export (Fake-TM-Adapter) — der eigentliche "es passiert nichts"-Fall
r = client.post("/api/tm-cost-export/%d/approve" % PK_A)
check("approve HTTP 200 (vorher: 'Session ist blockiert')", r.status_code == 200, r.text)
r = client.post("/api/tm-cost-export/%d/execute" % PK_A, json={"confirm": True})
body = r.json()
check("execute HTTP 200", r.status_code == 200, r.text)
check("execute status=exported", body.get("status") == "exported", str(body))

print("\n== 5) Idempotenz: erneute Bestätigung erzeugt keinen Duplikat-Override ==")
r = client.post("/api/sessions/%d/match" % PK_A, json={"tm_charge_id": 2412})
bj = r.json()
check("erneute Bestätigung -> 'Match already exists'", bj.get("message") == "Match already exists", str(bj))
n_ov = SessionLocal().query(MatchingOverride).filter_by(teslamate_charge_id=2412).count()
check("kein Duplikat-Override angelegt", n_ov == 1, str(n_ov))

print("\n== 6) Safety-Net: Override-Ziel mit nur superseded Zeilen wird blockiert ==")
# Session B ist Override-Ziel (9999), aber die Injektion liefert KEINE
# Fragmente (Charge nicht im TM-Datenbestand). Die Auto-Zeile von B wird
# superseded -> nur-superseded-Zustand. approve() muess blockieren.
svc2 = TMCostExportService(SessionLocal())
svc2._fixture_matches = []
svc2._fixture_overrides = {9999: {"ctl_evcc_session_id": PK_B, "override_id": 0}}
svc2._process_matches(
    [FakeMatch(PK_B, "93", [FakeCharge(5050, 2.0)])],
    overrides=svc2._fixture_overrides,
    tm_charges={},
)
rows_b = SessionLocal().query(SessionCostAllocation).filter_by(evcc_session_id=PK_B).all()
check(
    "Safety-Net blockiert Session ohne exportierbare Zeile",
    rows_b and all(r.exclusion_reason == "override_injection_failed" for r in rows_b),
    str([(r.tm_charge_id, r.exclusion_reason) for r in rows_b]),
)
r = client.post("/api/tm-cost-export/%d/approve" % PK_B)
check("approve auf nur-superseded Session -> HTTP 400", r.status_code == 400, r.text)

print("\n========================================")
print("BESTANDEN: %d  FEHLGESCHLAGEN: %d" % (len(PASS), len(FAIL)))
for name, detail in FAIL:
    print("  !! %s -- %s" % (name, detail))
sys.exit(1 if FAIL else 0)
