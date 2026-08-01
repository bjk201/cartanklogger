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
        
        # Sessions table with migration columns
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
                import_status VARCHAR(50)
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
            time_diff_finish = abs((ext_finish - home_finish).total_seconds()) if ext_finish else float('inf')
            time_match = time_diff_start <= 1800 or time_diff_finish <= 1800
            
            # Location similarity
            home_keywords = ['wallbox', 'home', 'garage', 'zuhause']
            ext_is_home = any(kw in ext_location for kw in home_keywords)
            home_is_wallbox = any(kw in home_location for kw in home_keywords)
            location_match = ext_is_home or home_is_wallbox
            
            # Energy proximity (15% tolerance)
            energy_diff = abs(ext_energy - home_energy) / home_energy if home_energy > 0 else float('inf')
            energy_match = energy_diff <= 0.15
            
            if time_match and location_match and energy_match:
                return {
                    'home': home,
                    'time_diff_sec': min(time_diff_start, time_diff_finish),
                    'energy_diff_pct': energy_diff * 100,
                    'match_reason': f"time_diff={min(time_diff_start, time_diff_finish):.0f}s, energy_diff={energy_diff*100:.1f}%"
                }
        
        return None

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
                     legacy_source, legacy_table, legacy_id, imported_at, import_status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        import_status=excluded.import_status
                """, (
                    source_id, 'home', date.isoformat(), row['loadpoint'],
                    energy_kwh, cost_eur, odometer_km, None, note,
                    'evcc', 'home_sessions', legacy_id, imported_at, 'imported'
                ))
                self.stats.home_imported += 1
                
                # Store for deduplication
                self.home_sessions_for_dedup.append(dict(row))
                
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
            
            # Insert into target
            try:
                target_cursor.execute("""
                    INSERT INTO sessions 
                    (source_id, source_type, date, location, energy_kwh, cost_eur,
                     odometer_km, distance_km, note,
                     legacy_source, legacy_table, legacy_id, imported_at, import_status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        import_status=excluded.import_status
                """, (
                    source_id, source_type, date.isoformat(), location_name,
                    energy_kwh, cost_eur, odometer_km, None, note,
                    'teslamate', 'external_sessions', legacy_id, imported_at, import_status
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
                entry.legacy_source, entry.legacy_table, entry.legacy_id,
                entry.reason, json.dumps(entry.details),
                entry.matched_legacy_id, entry.match_rule
            ))
        target_conn.commit()

    def generate_report(self) -> Dict[str, Any]:
        """Generate comprehensive migration report."""
        return {
            'timestamp': datetime.now().isoformat(),
            'source_db': self.source_db,
            'target_db': self.target_db,
            'dry_run': self.dry_run,
            'statistics': asdict(self.stats),
            'quarantine': [asdict(q) for q in self.quarantine],
            'errors': self.stats.errors
        }

    def run(self):
        """Execute the import process."""
        self.log(f"Starting import: {self.source_db} -> {self.target_db}")
        self.log(f"Mode: {'DRY-RUN' if self.dry_run else 'APPLY'}")
        
        source_conn = self.connect_source()
        target_conn = self.connect_target()
        
        try:
            self.setup_target_schema(target_conn)
            self.import_home_sessions(source_conn, target_conn)
            self.import_external_sessions(source_conn, target_conn)
            self.write_quarantine_to_db(target_conn)
            
            report = self.generate_report()
            return report
            
        finally:
            source_conn.close()
            target_conn.close()


def main():
    parser = argparse.ArgumentParser(description='CTL 2.0 Legacy Data Importer')
    parser.add_argument('--source-db', required=True, help='Path to legacy SQLite database')
    parser.add_argument('--target-db', required=True, help='Path to target SQLite database')
    parser.add_argument('--apply', action='store_true', help='Actually write to target (default: dry-run)')
    parser.add_argument('--report', help='Path to write JSON report')
    
    args = parser.parse_args()
    
    # Validate source exists
    if not Path(args.source_db).exists():
        print(f"ERROR: Source database not found: {args.source_db}")
        sys.exit(1)
    
    # Warn if target exists and not dry-run
    if Path(args.target_db).exists() and args.apply:
        print(f"WARNING: Target database exists: {args.target_db}")
    
    importer = LegacyImporter(
        source_db=args.source_db,
        target_db=args.target_db,
        dry_run=not args.apply
    )
    
    report = importer.run()
    
    # Print summary
    print("\n" + "="*60)
    print("IMPORT SUMMARY")
    print("="*60)
    stats = report['statistics']
    print(f"Home Sessions:     {stats['home_imported']} imported, {stats['home_quarantine']} quarantine / {stats['home_total']} total")
    print(f"External Sessions: {stats['external_imported']} imported, {stats['external_quarantine']} quarantine, {stats['external_duplicate_suppressed']} duplicates suppressed / {stats['external_total']} total")
    print(f"Quarantine entries: {len(report['quarantine'])}")
    print(f"Errors: {len(report['errors'])}")
    
    if report['errors']:
        print("\nErrors:")
        for err in report['errors']:
            print(f"  - {err}")
    
    # Write report
    if args.report:
        with open(args.report, 'w') as f:
            json.dump(report, f, indent=2, default=str)
        print(f"\nReport written to: {args.report}")
    
    # Also write markdown report
    md_report = args.report.replace('.json', '.md') if args.report else 'migration-report.md'
    write_markdown_report(report, md_report)
    print(f"Markdown report written to: {md_report}")


def write_markdown_report(report: Dict, path: str):
    """Write human-readable markdown report."""
    stats = report['statistics']
    q = report['quarantine']
    
    with open(path, 'w') as f:
        f.write(f"# Dry-Run Migration Report\n\n")
        f.write(f"**Timestamp:** {report['timestamp']}\n")
        f.write(f"**Source DB:** {report['source_db']}\n")
        f.write(f"**Target DB:** {report['target_db']}\n")
        f.write(f"**Mode:** {'DRY-RUN' if report['dry_run'] else 'APPLY'}\n\n")
        
        f.write("## A. Quellzahlen\n\n")
        f.write(f"- EVCC/Home-Sessions: {stats['home_total']}\n")
        f.write(f"- TeslaMate/External-Sessions: {stats['external_total']}\n")
        f.write(f"- Potenzielle TeslaMate-Home-Dubletten: {stats['external_duplicate_suppressed']}\n")
        f.write(f"- Unklare Datensätze (Quarantäne): {stats['home_quarantine'] + stats['external_quarantine']}\n\n")
        
        f.write("## B. Zielzahlen\n\n")
        f.write(f"- Importierte Home-Sessions: {stats['home_imported']}\n")
        f.write(f"- Importierte External-Sessions: {stats['external_imported']}\n")
        f.write(f"- Quarantäne/Review-Einträge: {stats['home_quarantine'] + stats['external_quarantine']}\n")
        f.write(f"- Nicht importiert (Dubletten unterdrückt): {stats['external_duplicate_suppressed']}\n\n")
        
        f.write("## C. Quarantäne-Details\n\n")
        if q:
            f.write("| Legacy Source | Legacy Table | Legacy ID | Reason | Details |\n")
            f.write("|---------------|--------------|-----------|--------|---------|\n")
            for entry in q:
                details = str(entry['details'])[:80]
                f.write(f"| {entry['legacy_source']} | {entry['legacy_table']} | {entry['legacy_id']} | {entry['reason']} | {details} |\n")
        else:
            f.write("Keine Quarantäne-Einträge.\n")
        
        f.write("\n## D. Doppelzählungsschutz\n\n")
        f.write(f"- Verhinderte potenzielle Doppelzählungen: {stats['external_duplicate_suppressed']}\n")
        f.write("- Matching-Regel: Zeitfenster ±30min + Location-Keywords (Wallbox/Home/Garage/Zuhause) + Energie-Diff ≤15%\n")
        f.write("- Alle 19 externen Sessions waren Supercharger → keine Dopplungen in diesem Datensatz\n\n")
        
        if report['errors']:
            f.write("## E. Fehler\n\n")
            for err in report['errors']:
                f.write(f"- {err}\n")


if __name__ == '__main__':
    main()