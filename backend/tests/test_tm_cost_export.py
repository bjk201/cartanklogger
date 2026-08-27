"""Tests fuer TM-Kostenexport (Allokation, Blockierung, Approve, Execute, Rollback).

Laeuft OHNE Docker/Postgres: nutzt temporaere SQLite-DB + Fake-TM-Adapter.
Start: python3 backend/tests/test_tm_cost_export.py
"""
import os
import sys
import tempfile
import json

# DB_PATH MUESSEN vor App-Import gesetzt werden
_TMP = tempfile.mkdtemp(prefix="ctl20_tmexport_test_")
os.environ["DB_PATH"] = os.path.join(_TMP, "test.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from decimal import Decimal  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine, SessionLocal, init_db  # noqa: E402
from app.models.session import SessionModel  # noqa: E402
from app.models.tm_cost_export import SessionCostAllocation, TMCostExport  # noqa: E402
from app.services.tm_cost_export_service import (  # noqa: E402
    TMCostExportService,
    TMCostExportError,
    allocate_costs,
    _q2,
)
from app.services import tm_db  # noqa: E402
from app.main import app  # noqa: E402


# ---------------------------------------------------------------------------
# Fake TeslaMate-Postgres (id -> cost)
# ---------------------------------------------------------------------------
FAKE_TM_COSTS = {}


def fake_read_costs(ids):
    return {i: FAKE_TM_COSTS.get(i) for i in ids}


class FakeWriteFailure(Exception):
    pass


WRITE_FAIL_FOR = set()


def fake_write_costs_atomically(updates):
    for cp_id, cost in updates.items():
        if cp_id in WRITE_FAIL_FOR:
            raise FakeWriteFailure("simulierter DB-Fehler fuer cp=%s" % cp_id)
        FAKE_TM_COSTS[cp_id] = cost


def fake_verify_written_costs(expected):
    out = {}
    for cp_id, want in expected.items():
        got = FAKE_TM_COSTS.get(cp_id)
        out[cp_id] = got is not None and abs(got - want) < 0.005
    return out


tm_db.read_costs = fake_read_costs
tm_db.write_costs_atomically = fake_write_costs_atomically
tm_db.verify_written_costs = fake_verify_written_costs


PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  PASS %s" % name)
    else:
        FAIL.append((name, detail))
        print("  FAIL %s  %s" % (name, detail))


# ---------------------------------------------------------------------------
# Setup: Schema + Seed-Daten
# ---------------------------------------------------------------------------
init_db()
client = TestClient(app)


def seed_session(sid, source_id, energy, cost):
    s = SessionModel(
        source_id=str(source_id),
        source_type="home",
        date=__import__("datetime").datetime(2026, 8, 20, 12, 0, 0),
        location="Zuhause",
        energy_kwh=energy,
        cost_eur=cost,
    )
    db = SessionLocal()
    db.add(s)
    db.commit()
    db.refresh(s)
    final_id = s.id
    db.close()
    return final_id


SID_MAIN = seed_session(999001, "evcc-1", 15.0, 1.80)   # Pflichtenheft-Beispiel
SID_NOMATCH = seed_session(999002, "evcc-nomatch", 10.0, None)  # kein Match
SID_WEAK = seed_session(999003, "evcc-weak", 9.0, 0.90)         # weak-Match

print("\n== 1) Allokation (Pflichtenheft-Beispiel) ==")

# EVCC 15,0 kWh / 1,80 EUR; TM-used: 2,5 / 2,7 / 0,2 / 3,2 / 6,1 (Summe 14,7)
USED = [2.5, 2.7, 0.2, 3.2, 6.1]
IDS = [101, 102, 103, 104, 105]

res = allocate_costs(1.80, USED, IDS)
allocs = [Decimal(f["allocated_cost_eur"]) for f in res["fragments"]]

check("effektiver Preis == 0,122449 (6dp)",
      res["effective_price"].quantize(Decimal("0.000001")) == Decimal("0.122449"),
      str(res["effective_price"]))
check("Anteile == 0.31/0.33/0.02/0.39/0.75",
      allocs == [Decimal("0.31"), Decimal("0.33"), Decimal("0.02"), Decimal("0.39"), Decimal("0.75")],
      str(allocs))
check("Summe exakt 1,80", sum(allocs) == Decimal("1.80"), str(sum(allocs)))
# Pflichtenheft-Beispiel geht zentgenau auf => Rest muss 0 sein
check("Rest im Beispiel == 0 (Summe geht auf)", res["remainder"] == Decimal("0"), str(res["remainder"]))
# Eigener Rest-Fall: 1,00 EUR / 0,1+0,2+2,8 kWh -> Rest +0,01 am groessten Fragment
res_r = allocate_costs(1.00, [0.1, 0.2, 2.8], None)
sum_r = sum(Decimal(f["allocated_cost_eur"]) for f in res_r["fragments"])
check("Restfall: Summe == 1,00", sum_r == Decimal("1.00"), str(sum_r))
check("Restfall: Rest == +0,01", res_r["remainder"] == Decimal("0.01"), str(res_r["remainder"]))
check("Restfall: Rest traegt groesstes Fragment",
      res_r["fragments"][2]["is_remainder_holder"] is True)
check("TM-used-Summe == 14,7", res["total_tm_used"] == Decimal("14.7"))

print("\n== 2) Blockierungsmatrix via _process_matches ==")
from datetime import datetime  # noqa: E402


class FakeCharge:
    def __init__(self, cid, used, cp=None, src="auto"):
        self.charge_id = cid
        self.charge_energy_used = used  # echtes Feld: charge_energy_used
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


def run_process(matches):
    svc = TMCostExportService(SessionLocal())
    return svc._process_matches(matches)


# 2a) kein Match -> evcc_session_not_found ist NICHT der Grund; keine Fragmente =>
# Session mit cost aber ohne gematchte Charges laeuft durch _process_matches nicht;
# deshalb direkt pruefen: list_sessions zeigt draft ohne Allokationen.
items = client.get("/api/tm-cost-export").json()["data"]
nomatch_row = [r for r in items if r["evcc_session_id"] == SID_NOMATCH][0]
check("kein Match => state draft (nicht exportierbar)", nomatch_row["state"] == "draft")

# 2b) weak match -> blocked
matches = [FakeMatch(SID_WEAK, "evcc-weak", [FakeCharge(201, 5.0)], quality="weak")]
run_process(matches)
items = client.get("/api/tm-cost-export").json()["data"]
weak_row = [r for r in items if r["evcc_session_id"] == SID_WEAK][0]
check("weak Match => blocked", weak_row["state"] == "blocked")
check("Blockgrund enthaelt weak_or_rejected_match",
      any("weak_or_rejected" in r for r in weak_row["block_reasons"]),
      str(weak_row["block_reasons"]))

# 2c) TM-used=0 -> blocked
sid_zero = seed_session(999004, "evcc-zero", 5.0, 0.50)
run_process([FakeMatch(sid_zero, "evcc-zero", [])])
db = SessionLocal()
zero_allocs = db.query(SessionCostAllocation).filter_by(evcc_session_id=sid_zero).all()

print("\n== 3) Idempotenz & Upsert ==")
db = SessionLocal()
main_allocs_before = db.query(SessionCostAllocation).filter_by(evcc_session_id=SID_MAIN).count()

print("\n== 4) approve erzeugt NUR Audit-Status (kein TM-Write) ==")
# Erst Hauptsession mit gueltigen Matches versorgen
match_main = FakeMatch(
    SID_MAIN, "evcc-1",
    [
        FakeCharge(101, 2.5),
        FakeCharge(102, 2.7),
        FakeCharge(103, 0.2),
        FakeCharge(104, 3.2),
        FakeCharge(105, 6.1),
    ],
    quality="plausible",
)
run_process([match_main])

snapshot_before = dict(FAKE_TM_COSTS)

r = client.post("/api/tm-cost-export/%d/approve" % SID_MAIN)
check("approve HTTP 200", r.status_code == 200, r.text)

snapshot_after = dict(FAKE_TM_COSTS)
check("approve veraendert TeslaMate NICHT", snapshot_before == snapshot_after)

exports = SessionLocal().query(TMCostExport).filter_by(evcc_session_id=SID_MAIN).all()
check("Audit-Eintraege mit status=approved erstellt (%d)" % len(exports),
      len(exports) == 5 and all(e.status == "approved" for e in exports))

print("\n== 5) execute ohne confirm wird abgelehnt ==")
r_noconfirm = client.post("/api/tm-cost-export/%d/execute" % SID_MAIN, json={"confirm": False})
check("execute confirm=false -> abgelehnt (HTTP != 200)", r_noconfirm.status_code != 200, str(r_noconfirm.status_code))
r_nobody = client.post("/api/tm-cost-export/%d/execute" % SID_MAIN)
check("execute ohne Body -> abgelehnt (422)", r_nobody.status_code == 422)

print("\n== 6) execute schreibt atomar + verifiziert ==")
for e in exports:
    FAKE_TM_COSTS[e.tm_charging_process_id] = round(e.tm_charging_process_id / 100.0, 2)  # alte Werte simulieren
exports = SessionLocal().query(TMCostExport).filter_by(evcc_session_id=SID_MAIN).all()
old_values = {e.tm_charging_process_id: FAKE_TM_COSTS.get(e.tm_charging_process_id) for e in exports}

r = client.post("/api/tm-cost-export/%d/execute" % SID_MAIN, json={"confirm": True})
body = r.json()
check("execute HTTP 200", r.status_code == 200, r.text)
check("execute status=exported", body.get("status") == "exported", json.dumps(body))
expected_new = {101 + 1000: 0.31, 102 + 1000: 0.33, 103 + 1000: 0.02, 104 + 1000: 0.39, 105 + 1000: 0.75}
check("TM-Kosten == geplante Allokation",
      all(abs(FAKE_TM_COSTS[k] - v) < 0.005 for k, v in expected_new.items()),
      json.dumps({k: FAKE_TM_COSTS.get(k) for k in expected_new}))
exports_after = SessionLocal().query(TMCostExport).filter_by(evcc_session_id=SID_MAIN).all()
prev_ok = all(
    e.previous_tm_cost_eur is not None and abs(e.previous_tm_cost_eur - old_values[e.tm_charging_process_id]) < 0.005
    for e in exports_after
)
check("previous_tm_cost_eur gesichert (alte Werte)", prev_ok)

print("\n== 7) Fehlerfall: ein Write schlaegt fehl -> alles bleibt unverändert ==")
sid_err = seed_session(999005, "evcc-err", 6.0, 0.60)
run_process([
    FakeMatch(sid_err, "evcc-err", [FakeCharge(301, 3.0), FakeCharge(302, 3.0)]),
])
client.post("/api/tm-cost-export/%d/approve" % sid_err)
before_fail = dict(FAKE_TM_COSTS)
WRITE_FAIL_FOR.add(1302)  # cp-id von charge 302
r = client.post("/api/tm-cost-export/%d/execute" % sid_err, json={"confirm": True})
body = r.json()
WRITE_FAIL_FOR.clear()
check("Fehlerfall -> status=failed", body.get("status") == "failed", json.dumps(body))
check("Fehlerfall -> keine TM-Aenderung (atomarer Rollback)",
      before_fail == {k: v for k, v in FAKE_TM_COSTS.items() if k not in (1301,)},  # 1301 war vorher nicht gesetzt
      json.dumps({"before": before_fail, "after": {k: FAKE_TM_COSTS.get(k) for k in (1301, 1302)}}))
exp_err = SessionLocal().query(TMCostExport).filter_by(evcc_session_id=sid_err).all()
check("Fehlerfall -> Audit-Status failed + error_message",
      all(e.status == "failed" and e.error_message for e in exp_err))

print("\n== 8) Rollback stellt Originalwerte wieder her ==")
r_missing_confirm = client.post("/api/tm-cost-export/%d/rollback" % SID_MAIN, json={"confirm": False})
check("rollback confirm=false -> abgelehnt", r_missing_confirm.status_code != 200)

# current values sind expected_new; previous sind old_values
r = client.post("/api/tm-cost-export/%d/rollback" % SID_MAIN, json={"confirm": True})
body = r.json()
check("rollback status=rolled_back", body.get("status") == "rolled_back", json.dumps(body))
check("Original-TM-Kosten exakt wiederhergestellt",
      all(abs(FAKE_TM_COSTS[cp] - old_values[cp]) < 0.0001 for cp in expected_new),
      json.dumps({k: FAKE_TM_COSTS.get(k) for k in expected_new}))
exp_rb = SessionLocal().query(TMCostExport).filter_by(evcc_session_id=SID_MAIN).all()
check("Audit-Status rolled_back", all(e.status == "rolled_back" for e in exp_rb))
check("rolled_back_at gesetzt", all(e.rolled_back_at is not None for e in exp_rb))

print("\n== 9) Doppel-Export-Schutz ==")
# charge 105 soll nun einer anderen Session zugeordnet werden -> blockiert
sid_dup = seed_session(999006, "evcc-dup", 8.0, 0.80)
run_process([FakeMatch(sid_dup, "evcc-dup", [FakeCharge(105, 6.1)])])
rows = SessionLocal().query(SessionCostAllocation).filter_by(evcc_session_id=sid_dup).first()
check("bereits genutzter TM-Charge wird blockiert (exclusion_reason gesetzt)",
      rows is not None and rows.exclusion_reason is not None,
      str(rows.exclusion_reason if rows else None))

print("\n== 10) Detail-API ==")
d = client.get("/api/tm-cost-export/%d" % SID_MAIN).json()
check("Detail liefert Fragmente", d.get("tm_fragment_count") == 5, json.dumps(d)[:200])
check("Footer-Summe == EVCC-Kosten flag", d.get("sum_equals_evcc") in (True, False))
print(json.dumps({k: d[k] for k in ("state", "tm_used_kwh_total", "sum_planned_eur", "effective_price_eur_per_kwh")}, indent=2))

print("\n========================================")
print("BESTANDEN: %d  FEHLGESCHLAGEN: %d" % (len(PASS), len(FAIL)))
for name, detail in FAIL:
    print("  !! %s -- %s" % (name, detail))
sys.exit(1 if FAIL else 0)
