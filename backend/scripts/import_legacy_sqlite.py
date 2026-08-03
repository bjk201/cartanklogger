#!/usr/bin/env python3
"""
Legacy SQLite to CTL 2.0 Importer
==================================

Dry-run by default. Use --apply to write to target database.

Usage:
    python import_legacy_sqlite.py --source-db /path/to/legacy.db --target-db /path/to/target.db [--apply]
"""

import argparse
import sqlite3
import json
import sys
from datetime import datetime
from dataclasses import dataclass, asdict
from typing import Optional, List, Dict, Any
from pathlib import Path


@dataclass
class ImportStats:
    home_total: int = 0
    home_imported: int = 0
    home_quarantine: int = 0
    external_total: int = 0
    external_imported: int = 0
    external_quarantine: int = 0
    external_duplicate_suppressed: int = 0
    drives_total: int = 0
    errors: List[str] = None

    def __post_init__(self):
        if self.errors is None:
            self.errors = []


@dataclass
class QuarantineEntry:
    legacy_source: str
    legacy_table: str
    legacy_id: int
    reason: str
    details: Dict[str, Any]
    matched_legacy_id: Optional[int] = None
    match_rule: Optional[str] = None


class LegacyImporter:
    def __init__(self, source_db: str, target_db: str, dry_run: bool = True):
        self.source_db = source_db
        self.target_db = target_db
        self.dry_run = dry_run
        self.stats = ImportStats()
        self.quarantine: List[QuarantineEntry] = []
        self.home_sessions_for_dedup: List[Dict] = []

    def log(self, msg: str):
        prefix = "[DRY-RUN] " if self.dry_run else "[APPLY] "
        print(f"{prefix}{msg}")

    def connect_source(self):
        conn = sqlite3.connect(self.source_db)
        conn.row_factory = sqlite3.Row
        return conn

    def connect_target(self):
        conn = sqlite3.connect(self.target_db)
        conn.row_factory = sqlite3.Row
        return conn

    def setup_target_schema(self, conn: sqlite3.Connection):
        """Create target tables with migration extensions."""
        cursor = conn.cursor()

        # Sessions table with migration extensions
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id VARCHAR(100) NOT NULL,
                source_type VARCHAR(20) NOT NULL,
                date DATETIME NOT NULL,
                location VARCHAR(255),
                energy_kwh FLOAT,
                cost_eur FLOAT,
                odometer_km FLOAT,
                distance_km FLOAT,
                note TEXT,
                created_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
                updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP),
                -- Migration metadata
                legacy_source VARCHAR(50),
                legacy_table VARCHAR(50),
                legacy_id INTEGER,
                imported_at DATETIME,
                import_status VARCHAR(50),
                -- PV / Solar data
                solar_percentage FLOAT,
                pv_kwh FLOAT,
                -- Cost per kWh
                cost_per_kwh FLOAT,
                cost_per_kwh_source VARCHAR(20),
                -- Charge type details (for external/TeslaMate sessions)
                charge_type VARCHAR(10),  -- DC, AC, unknown
                fast_charger_brand VARCHAR(50),
                max_charge_power_kw FLOAT
            )
        """)

        # Unique index for idempotency
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_legacy
            ON sessions (legacy_source, legacy_table, legacy_id)
        """)

        # Regular indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_sessions_source_type ON sessions (source_type)")
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_sessions_source_id ON sessions (source_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_sessions_date ON sessions (date)")

        # Quarantine table for review
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS import_quarantine (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                legacy_source VARCHAR(50),
                legacy_table VARCHAR(50),
                legacy_id INTEGER,
                reason VARCHAR(100),
                details TEXT,
                matched_legacy_id INTEGER,
                match_rule VARCHAR(50),
                created_at DATETIME DEFAULT (CURRENT_TIMESTAMP)
            )
        """)

        conn.commit()

    def parse_datetime(self, dt_str: str) -> Optional[datetime]:
        """Parse ISO datetime string, handle various formats."""
        if not dt_str:
            return None
        try:
            # Handle Z suffix and timezone
            dt_str = dt_str.replace('Z', '+00:00')
            return datetime.fromisoformat(dt_str)
        except ValueError:
            try:
                # Try without microseconds
                return datetime.strptime(dt_str[:19], "%Y-%m-%dT%H:%M:%S")
            except ValueError:
                return None

    def check_plausibility(self, energy_kwh: float, cost_eur: float,
                          odometer_km: float, date: datetime) -> List[str]:
        """Check value plausibility, return list of violations."""
        violations = []
        if energy_kwh is not None and (energy_kwh < 0.1 or energy_kwh > 200):
            violations.append(f"energy_kwh={energy_kwh} outside [0.1, 200]")
        if cost_eur is not None and (cost_eur < 0 or cost_eur > 1000):
            violations.append(f"cost_eur={cost_eur} outside [0, 1000]")
        if odometer_km is not None and (odometer_km < 0 or odometer_km > 1_000_000):
            violations.append(f"odometer_km={odometer_km} outside [0, 1M]")
        if date is not None:
            if date < datetime(2020, 1, 1) or date > datetime.now():
                violations.append(f"date={date} outside valid range")
        return violations

    def find_matching_home_session(self, ext_session: Dict,
                                    home_sessions: List[Dict]) -> Optional[Dict]:
        """
        Find matching home session for deduplication.
        Returns the matching home session or None.
        """
        ext_start = self.parse_datetime(ext_session['started_at'])
        ext_finish = self.parse_datetime(ext_session['finished_at'])
        ext_energy = ext_session['energy_kwh']
        ext_location = (ext_session['location_name'] or '').lower()

        if not ext_start or ext_energy is None:
            return None

        for home in home_sessions:
            home_start = self.parse_datetime(home['created'])
            home_finish = self.parse_datetime(home['finished'])
            home_energy = home['charged_kwh']
            home_location = (home['loadpoint'] or '').lower()

            if not home_start or not home_finish or home_energy is None:
                continue

            # Time window: ±30 minutes
            time_diff_start = abs((ext_start - home_start).total_seconds())
            time_diff_finish = abs((ext_finish - home_finish).total_seconds()) if ext_finish and home_finish else float('inf')

            # Energy tolerance: ±10%
            energy_diff = abs(ext_energy - home_energy) / max(home_energy, 0.1)

            # Location match
            location_match = ext_location == home_location

            # Match criteria: time within 30 min AND energy within 10% AND same location
            if time_diff_start <= 1800 and energy_diff <= 0.1 and location_match:
                return {
                    'home': home,
                    'match_reason': f'time={time_diff_start:.0f}s energy={energy_diff:.1%} loc={location_match}'
                }

            # Alternative: time within 1h AND energy within 20%
            if time_diff_start <= 3600 and energy_diff <= 0.2:
                return {
                    'home': home,
                    'match_reason': f'time={time_diff_start:.0f}s energy={energy_diff:.1%}'
                }

        return None

    def add_quarantine(self, legacy_source: str, legacy_table: str, legacy_id: int,
                       reason: str, details: Dict, matched_legacy_id: int = None,
                       match_rule: str = None):
        """Add entry to quarantine list and table."""
        entry = QuarantineEntry(
            legacy_source=legacy_source,
            legacy_table=legacy_table,
            legacy_id=legacy_id,
            reason=reason,
            details=details,
            matched_legacy_id=matched_legacy_id,
            match_rule=match_rule
        )
        self.quarantine.append(entry)

    def write_quarantine_to_db(self, target_conn: sqlite3.Connection):
        """Write quarantine entries to database."""
        cursor = target_conn.cursor()
        for entry in self.quarantine:
            cursor.execute("""
                INSERT INTO import_quarantine
                (legacy_source, legacy_table, legacy_id, reason, details, matched_legacy_id, match_rule)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                entry.legacy_source,
                entry.legacy_table,
                entry.legacy_id,
                entry.reason,
                json.dumps(entry.details),
                entry.matched_legacy_id,
                entry.match_rule
            ))
        target_conn.commit()

    def import_home_sessions(self, source_conn: sqlite3.Connection,
                              target_conn: sqlite3.Connection):
        """Import all home_sessions as source_type='home'."""
        cursor = source_conn.cursor()
        rows = cursor.execute("SELECT * FROM home_sessions ORDER BY id").fetchall()

        self.stats.home_total = len(rows)
        self.log(f"Found {len(rows)} home_sessions to import")

        target_cursor = target_conn.cursor()
        imported_at = datetime.now().isoformat()

        for row in rows:
            legacy_id = row['id']
            source_id = str(row['evcc_session_id'])

            # Parse date
            date = self.parse_datetime(row['created'])
            if not date:
                self.add_quarantine('evcc', 'home_sessions', legacy_id,
                                   'missing_timestamp', {'created': row['created']})
                self.stats.home_quarantine += 1
                continue

            energy_kwh = row['charged_kwh']
            cost_eur = row['total_cost']
            odometer_km = row['odometer']

            # Plausibility check
            violations = self.check_plausibility(energy_kwh, cost_eur, odometer_km, date)
            if violations:
                self.add_quarantine('evcc', 'home_sessions', legacy_id,
                                   'invalid_value', {'violations': violations})
                self.stats.home_quarantine += 1
                continue

            # Build note
            note_parts = []
            if row['vehicle']:
                note_parts.append(f"Vehicle: {row['vehicle']}")
            if row['soc_start'] is not None and row['soc_end'] is not None:
                note_parts.append(f"SoC: {row['soc_start']}→{row['soc_end']}%")
            note = "; ".join(note_parts) if note_parts else None

            # Insert into target
            try:
                target_cursor.execute("""
                    INSERT INTO sessions
                    (source_id, source_type, date, location, energy_kwh, cost_eur,
                     odometer_km, distance_km, note,
                     legacy_source, legacy_table, legacy_id, imported_at, import_status,
                     solar_percentage, pv_kwh,
                     cost_per_kwh, cost_per_kwh_source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(legacy_source, legacy_table, legacy_id)
                    DO UPDATE SET
                        source_id=excluded.source_id,
                        source_type=excluded.source_type,
                        date=excluded.date,
                        location=excluded.location,
                        energy_kwh=excluded.energy_kwh,
                        cost_eur=excluded.cost_eur,
                        odometer_km=excluded.odometer_km,
                        distance_km=excluded.distance_km,
                        note=excluded.note,
                        imported_at=excluded.imported_at,
                        import_status=excluded.import_status,
                        solar_percentage=excluded.solar_percentage,
                        pv_kwh=excluded.pv_kwh,
                        cost_per_kwh=excluded.cost_per_kwh,
                        cost_per_kwh_source=excluded.cost_per_kwh_source
                """, (
                    source_id, 'home', date.isoformat(), row['loadpoint'],
                    energy_kwh, cost_eur, odometer_km, None, note,
                    'evcc', 'home_sessions', legacy_id, imported_at, 'imported',
                    row['solar_percentage'], row['pv_kwh'],
                    row['price_per_kwh'], 'api'
                ))

                self.stats.home_imported += 1
            except Exception as e:
                self.stats.errors.append(f"Home session {legacy_id}: {e}")
                self.stats.home_quarantine += 1

        target_conn.commit()
        self.log(f"Home sessions: imported={self.stats.home_imported}, quarantine={self.stats.home_quarantine}")

    def import_external_sessions(self, source_conn: sqlite3.Connection,
                                  target_conn: sqlite3.Connection):
        """Import external_sessions with deduplication logic."""
        cursor = source_conn.cursor()
        rows = cursor.execute("SELECT * FROM external_sessions ORDER BY id").fetchall()

        self.stats.external_total = len(rows)
        self.log(f"Found {len(rows)} external_sessions to analyze")

        target_cursor = target_conn.cursor()
        imported_at = datetime.now().isoformat()

        for row in rows:
            legacy_id = row['id']
            source_id = str(row['teslamate_session_id'])

            # Parse date
            date = self.parse_datetime(row['started_at'])
            if not date:
                self.add_quarantine('teslamate', 'external_sessions', legacy_id,
                                   'missing_timestamp', {'started_at': row['started_at']})
                self.stats.external_quarantine += 1
                continue

            energy_kwh = row['energy_kwh']
            cost_eur = row['cost_total']
            odometer_km = row['odometer_start']

            # Plausibility check
            violations = self.check_plausibility(energy_kwh, cost_eur, odometer_km, date)
            if violations:
                self.add_quarantine('teslamate', 'external_sessions', legacy_id,
                                   'invalid_value', {'violations': violations})
                self.stats.external_quarantine += 1
                continue

            # Deduplication check
            match = self.find_matching_home_session(dict(row), self.home_sessions_for_dedup)

            location_name = row['location_name'] or ''
            is_supercharger = 'supercharger' in location_name.lower()
            is_home_location = any(kw in location_name.lower() for kw in ['wallbox', 'home', 'garage', 'zuhause'])

            if match:
                # Duplicate detected - suppress TeslaMate, keep EVCC
                self.add_quarantine('teslamate', 'external_sessions', legacy_id,
                                   'duplicate_suppressed',
                                   {'matched_home_id': match['home']['id'],
                                    'match_rule': 'time_location_energy',
                                    'match_details': match['match_reason']})
                self.stats.external_duplicate_suppressed += 1
                self.log(f"  Duplicate suppressed: TM:{legacy_id} matches EVCC:{match['home']['id']} ({match['match_reason']})")
                continue

            # Determine source_type
            if is_supercharger:
                source_type = 'external'
                import_status = 'imported'
            elif is_home_location:
                source_type = 'home'
                import_status = 'quarantine:possible_home_duplicate'
            else:
                source_type = 'import'
                import_status = 'quarantine:ambiguous_source'

            # Build note
            note_parts = []
            if row['provider']:
                note_parts.append(f"Provider: {row['provider']}")
            if row['soc_start'] is not None and row['soc_end'] is not None:
                note_parts.append(f"SoC: {row['soc_start']}→{row['soc_end']}%")
            if row['manual_price']:
                note_parts.append("manual_price=true")
            note = "; ".join(note_parts) if note_parts else None

            # Determine charge_type and fast_charger details from legacy data
            charge_type = 'unknown'
            fast_charger_brand = None
            max_charge_power_kw = None

            if is_supercharger:
                charge_type = 'DC'
                fast_charger_brand = 'Tesla'
            elif is_home_location:
                charge_type = 'AC'
            else:
                charge_type = 'unknown'

            # Insert into target
            try:
                # Derive cost_per_kwh for TeslaMate: cost / charge_energy_added (energy_kwh)
                # Only if energy_kwh > 0, otherwise null
                derived_cost_per_kwh = None
                if energy_kwh is not None and energy_kwh > 0 and cost_eur is not None:
                    derived_cost_per_kwh = round(cost_eur / energy_kwh, 4)

                target_cursor.execute("""
                    INSERT INTO sessions
                    (source_id, source_type, date, location, energy_kwh, cost_eur,
                     odometer_km, distance_km, note,
                     legacy_source, legacy_table, legacy_id, imported_at, import_status,
                     solar_percentage, pv_kwh,
                     cost_per_kwh, cost_per_kwh_source,
                     charge_type, fast_charger_brand, max_charge_power_kw)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(legacy_source, legacy_table, legacy_id)
                    DO UPDATE SET
                        source_id=excluded.source_id,
                        source_type=excluded.source_type,
                        date=excluded.date,
                        location=excluded.location,
                        energy_kwh=excluded.energy_kwh,
                        cost_eur=excluded.cost_eur,
                        odometer_km=excluded.odometer_km,
                        distance_km=excluded.distance_km,
                        note=excluded.note,
                        imported_at=excluded.imported_at,
                        import_status=excluded.import_status,
                        solar_percentage=excluded.solar_percentage,
                        pv_kwh=excluded.pv_kwh,
                        cost_per_kwh=excluded.cost_per_kwh,
                        cost_per_kwh_source=excluded.cost_per_kwh_source,
                        charge_type=excluded.charge_type,
                        fast_charger_brand=excluded.fast_charger_brand,
                        max_charge_power_kw=excluded.max_charge_power_kw
                """, (
                    source_id, source_type, date.isoformat(), location_name,
                    energy_kwh, cost_eur, odometer_km, None, note,
                    'teslamate', 'external_sessions', legacy_id, imported_at, import_status,
                    None, None,  # solar_percentage, pv_kwh
                    derived_cost_per_kwh, 'derived',
                    charge_type, fast_charger_brand, max_charge_power_kw
                ))

                if import_status == 'imported':
                    self.stats.external_imported += 1
                else:
                    self.stats.external_quarantine += 1

            except Exception as e:
                self.stats.errors.append(f"External session {legacy_id}: {e}")
                self.stats.external_quarantine += 1

        target_conn.commit()
        self.log(f"External sessions: imported={self.stats.external_imported}, quarantine={self.stats.external_quarantine}, duplicates_suppressed={self.stats.external_duplicate_suppressed}")

    def import_drives(self, source_conn: sqlite3.Connection,
                       target_conn: sqlite3.Connection):
        """Import drives table (informational only, not stored in sessions)."""
        cursor = source_conn.cursor()
        rows = cursor.execute("SELECT * FROM drives ORDER BY id").fetchall()

        self.stats.drives_total = len(rows)
        self.log(f"Found {len(rows)} drives to analyze")
        # Drives are informational only - not stored in sessions table
        self.log(f"Drives: total={self.stats.drives_total}")

    def run(self):
        """Main import orchestration."""
        source_conn = self.connect_source()
        target_conn = self.connect_target()

        try:
            self.setup_target_schema(target_conn)

            # Build home sessions cache for deduplication
            source_cursor = source_conn.cursor()
            self.home_sessions_for_dedup = [dict(row) for row in
                source_cursor.execute("SELECT * FROM home_sessions ORDER BY id").fetchall()]

            self.log(f"Cached {len(self.home_sessions_for_dedup)} home sessions for deduplication")

            # Import in order: home first (for dedup), then external, then drives
            self.import_home_sessions(source_conn, target_conn)
            self.import_external_sessions(source_conn, target_conn)
            self.import_drives(source_conn, target_conn)

            # Write quarantine entries
            self.write_quarantine_to_db(target_conn)

            # Print summary
            self.log("=== IMPORT SUMMARY ===")
            self.log(f"Home:     total={self.stats.home_total} imported={self.stats.home_imported} quarantine={self.stats.home_quarantine}")
            self.log(f"External: total={self.stats.external_total} imported={self.stats.external_imported} quarantine={self.stats.external_quarantine} duplicates_suppressed={self.stats.external_duplicate_suppressed}")
            self.log(f"Drives:   total={self.stats.drives_total}")

            if self.stats.errors:
                self.log(f"Errors: {len(self.stats.errors)}")
                for err in self.stats.errors:
                    self.log(f"  - {err}")

            if self.dry_run:
                self.log("DRY-RUN complete. Use --apply to write changes.")
                target_conn.rollback()
            else:
                self.log("APPLY complete. Changes committed.")
                target_conn.commit()

        finally:
            source_conn.close()
            target_conn.close()


def main():
    parser = argparse.ArgumentParser(description="Legacy SQLite to CTL 2.0 Importer")
    parser.add_argument("--source-db", required=True, help="Path to source SQLite database")
    parser.add_argument("--target-db", required=True, help="Path to target SQLite database")
    parser.add_argument("--apply", action="store_true", help="Actually write changes (default is dry-run)")
    args = parser.parse_args()

    if not Path(args.source_db).exists():
        print(f"ERROR: Source database not found: {args.source_db}")
        sys.exit(1)

    if not Path(args.target_db).exists():
        print(f"ERROR: Target database not found: {args.target_db}")
        sys.exit(1)

    importer = LegacyImporter(args.source_db, args.target_db, dry_run=not args.apply)
    importer.run()


if __name__ == "__main__":
    main()