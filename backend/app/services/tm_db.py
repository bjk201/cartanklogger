"""Kontrollierter Adapter für direkte TeslaMate-Postgres-Zugriffe.

Zweck: Ausschließlich der Kosten-Writeback nach charging_processes.cost.
- Keine Credentials ans Frontend.
- Nur parametrisierte SQL-Anweisungen:
    SELECT id, cost FROM charging_processes WHERE id = ANY(...)
    UPDATE charging_processes SET cost = %s WHERE id = %s
- Alle Writes passieren IMMER in einer expliziten Transaktion (atomar pro EVCC-Session).
- Vor jedem Update wird der aktuelle Wert gelesen (previous_tm_cost_eur).
- Nach dem Commit wird jeder Wert neu gelesen und verifiziert.

Konfiguration über Env/Settings:
  TESLAMATE_DB_HOST / TESLAMATE_DB_PORT / TESLAMATE_DB_NAME / TESLAMATE_DB_USER / TESLAMATE_DB_PASSWORD
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Optional

logger = logging.getLogger(__name__)


class TeslaMateDBConfigError(RuntimeError):
    """TeslaMate DB ist nicht konfiguriert."""


def _connection_kwargs() -> dict:
    from app.config import settings
    return dict(
        host=settings.TESLAMATE_DB_HOST,
        port=int(settings.TESLAMATE_DB_PORT or 5432),
        dbname=settings.TESLAMATE_DB_NAME,
        user=settings.TESLAMATE_DB_USER,
        password=settings.TESLAMATE_DB_PASSWORD,
        connect_timeout=10,
    )


def is_configured() -> bool:
    try:
        kw = _connection_kwargs()
    except Exception:
        return False
    return bool(kw.get("dbname") and kw.get("host"))


def _get_connection():
    """Öffnet eine psycopg2-Connection zur TeslaMate-Postgres."""
    try:
        import psycopg2  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "psycopg2 ist nicht installiert — TeslaMate-Writeback nicht möglich. "
            "Bitte im Backend-Image installieren."
        ) from exc

    kw = _connection_kwargs()
    if not kw.get("dbname"):
        raise TeslaMateDBConfigError("TESLAMATE_DB_* nicht konfiguriert")

    try:
        return psycopg2.connect(**{**kw, "connect_timeout": 8})
    except psycopg2.OperationalError as exc:
        # Klartext-Fehler statt 500-Traceback; typische Fehlkonfigurationen benennen
        host = kw.get("host"); port = kw.get("port")
        hint = ""
        if port in (80, 4000, 8080, 4001):
            hint = (
                f" Port {port} ist kein Postgres-Port — TESLAMATE_DB_PORT muss auf die "
                "TeslaMate-POSTGRES-DB zeigen (Standard 5432), NICHT auf die TeslaMateApi (4000/8080)."
            )
        raise TeslaMateDBConfigError(
            f"Verbindung zu TeslaMate-DB {host}:{port} fehlgeschlagen: {exc}.{hint}"
        ) from exc


@contextmanager
def _transaction():
    """Eine Postgres-Transaktion für den atomaren Session-Writeback.

    - commit() bei Erfolg
    - rollback() bei jeder Exception (alle Writes der EVCC-Session zurück)
    """
    conn = _get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def read_costs(tm_charging_process_ids: list) -> dict:
    """Liest aktuelle charging_processes.cost Werte (id -> cost|None)."""
    if not tm_charging_process_ids:
        return {}

    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, cost FROM charging_processes WHERE id = ANY(%(ids)s)",
            {"ids": [int(i) for i in tm_charging_process_ids]},
        )
        rows = cur.fetchall()
        cur.close()
    finally:
        conn.close()

    return {int(r[0]): (float(r[1]) if r[1] is not None else None) for r in rows}


def write_costs_atomically(updates: dict) -> None:
    """Schreibt alle Kosten einer EVCC-Session ATOMAR in einer Transaktion.

    - Bei Fehler an irgendeinem Update: Rollback ALLER Updates dieser Session.
    """
    if not updates:
        return

    with _transaction() as conn:
        cur = conn.cursor()
        for cp_id, cost in updates.items():
            cur.execute(
                "UPDATE charging_processes SET cost = %s WHERE id = %s",
                (float(cost), int(cp_id)),
            )
            if cur.rowcount != 1:
                raise RuntimeError(
                    f"UPDATE traf {cur.rowcount} Zeilen für charging_process_id={cp_id} "
                    "(erwartet 1) — Transaktion wird zurückgerollt."
                )
        cur.close()


def verify_written_costs(expected: dict) -> dict:
    """Nach dem Commit: liest alle Werte erneut und vergleicht mit Erwartung.

    Rückgabe: {charging_process_id: bool} — True wenn |ist - soll| < 0,005 €.
    """
    ids = list(expected.keys())
    actual = read_costs(ids)
    out = {}
    for cp_id, want in expected.items():
        got = actual.get(cp_id)
        out[cp_id] = got is not None and abs(float(got) - float(want)) < 0.005
    return out
