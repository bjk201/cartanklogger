"""
Live Matching Service
=====================

Matches live EVCC sessions with live TeslaMateAPI charges.
Only works when both APIs are configured and reachable.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict
from sqlalchemy.orm import Session

from app.models.matching_override import MatchingOverride, OverrideType
from app.services.evcc_client import EVCCClient, EVCCLiveSession, create_evcc_client_from_config
from app.services.teslamateapi_client import TeslaMateAPIClient, TeslaMateAPICharge, create_teslamateapi_client_from_config
from app.database import SessionLocal
from app.models.session import SessionModel


@dataclass
class LiveMatchedCharge:
    """A TeslaMateAPI charge that matched an EVCC session (live data)."""
    charge_id: int
    source_id: str
    date: str
    energy_kwh: Optional[float]
    charge_energy_added: Optional[float]
    charge_energy_used: Optional[float]
    cost_eur: Optional[float]
    location: Optional[str]
    location_original: Optional[str]
    location_normalized: Optional[str]
    accepted_as_candidate: bool
    reject_reason: Optional[str]
    overlap_seconds: int
    containment: str  # 'inside', 'overlaps_start', 'overlaps_end', 'envelops', 'manual_override'
    match_source: str = 'auto'  # 'auto' | 'manual_override'
    override_id: Optional[int] = None
    override_reason: Optional[str] = None
    replaced_auto_match: Optional[str] = None
    skipped_due_to_other_override: bool = False
    # TM charge details
    charge_type: Optional[str] = None  # 'DC', 'AC', 'unknown'
    fast_charger_brand: Optional[str] = None
    max_charge_power_kw: Optional[float] = None


@dataclass
class LiveEVCCSessionMatch:
    """Matching result for one EVCC session (live data)."""
    evcc_session_id: int
    evcc_source_id: str
    evcc_start: str
    evcc_end: str
    evcc_energy_kwh: Optional[float]
    evcc_cost_eur: Optional[float]
    evcc_cost_per_kwh: Optional[float]
    evcc_location: Optional[str]
    matched_charge_count: int
    matched_charge_ids: List[int]
    matched_charges: List[LiveMatchedCharge]
    matched_charge_energy_kwh_sum: Optional[float]
    delta_kwh: Optional[float]
    match_quality: str  # 'exact', 'plausible', 'weak', 'unmatched'
    match_notes: str


@dataclass
class LiveMatchingSummary:
    """Overall live matching summary."""
    total_evcc_sessions_checked: int
    total_matched: int
    total_unmatched: int
    total_evcc_energy: float
    total_tm_energy: float
    total_delta_kwh: float
    quality_distribution: Dict[str, int]
    total_tm_charges: int
    accepted_tm_charges_unique: int
    rejected_tm_charges_wrong_location_unique: int
    candidate_checks_total: int
    evcc_reachable: bool
    teslamateapi_reachable: bool


class LiveMatchingService:
    """Service for matching LIVE EVCC sessions with LIVE TeslaMateAPI charges."""

    # Home location identifier - exact match after normalization
    HOME_LOCATION_KEY = "zuhause"

    def __init__(self, evcc_client: EVCCClient, teslamateapi_client: TeslaMateAPIClient, db: Session):
        self.evcc_client = evcc_client
        self.teslamateapi_client = teslamateapi_client
        self.db = db

    def _parse_datetime(self, dt_str: str) -> Optional[datetime]:
        """Parse ISO datetime string."""
        if not dt_str:
            return None
        try:
            dt_str = dt_str.replace('Z', '+00:00')
            return datetime.fromisoformat(dt_str)
        except ValueError:
            return None

    def _normalize_location(self, location: Optional[str]) -> str:
        """Normalize location for comparison: lowercase, trim."""
        if not location:
            return ""
        return location.strip().lower()

    def _is_home_location(self, location: Optional[str]) -> bool:
        """Check if location is the home location 'Zuhause'."""
        normalized = self._normalize_location(location)
        return normalized == self.HOME_LOCATION_KEY

    def _filter_by_date_range(self, sessions, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None):
        """Filter EVCC sessions by date range (in-memory filter)."""
        from datetime import datetime, timedelta, timezone
        
        if not sessions:
            return sessions
        
        if from_date and to_date:
            from_dt = datetime.fromisoformat(from_date)
            to_dt = datetime.fromisoformat(to_date + ' 23:59:59')
            return [s for s in sessions if from_dt <= s.created <= to_dt]
        elif from_date and not to_date:
            from_dt = datetime.fromisoformat(from_date)
            return [s for s in sessions if s.created >= from_dt]
        elif days is not None:
            cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
            return [s for s in sessions if s.created >= cutoff_date]
        
        return sessions

    def _filter_tm_by_date_range(self, charges, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None):
        """Filter TeslaMate charges by date range (in-memory filter)."""
        from datetime import datetime, timedelta, timezone
        
        if not charges:
            return charges
        
        if from_date and to_date:
            from_dt = datetime.fromisoformat(from_date)
            to_dt = datetime.fromisoformat(to_date + ' 23:59:59')
            return [c for c in charges if c.start_date and from_dt <= c.start_date <= to_dt]
        elif from_date and not to_date:
            from_dt = datetime.fromisoformat(from_date)
            return [c for c in charges if c.start_date and c.start_date >= from_dt]
        elif days is not None:
            cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
            return [c for c in charges if c.start_date and c.start_date >= cutoff_date]
        
        return charges

    def _calculate_overlap(
        self,
        evcc_start: datetime,
        evcc_end: datetime,
        tm_start: datetime,
        tm_end: Optional[datetime]
    ) -> tuple[int, str]:
        """Calculate overlap between EVCC session and TeslaMate charge."""
        if tm_end is None:
            if evcc_start <= tm_start <= evcc_end:
                return 0, 'overlaps_start'
            return 0, 'unmatched'

        overlap_start = max(evcc_start, tm_start)
        overlap_end = min(evcc_end, tm_end)

        if overlap_start >= overlap_end:
            return 0, 'unmatched'

        overlap_seconds = int((overlap_end - overlap_start).total_seconds())

        if tm_start >= evcc_start and tm_end <= evcc_end:
            return overlap_seconds, 'inside'
        elif tm_start < evcc_start and tm_end > evcc_end:
            return overlap_seconds, 'envelops'
        elif tm_start < evcc_start <= tm_end <= evcc_end:
            return overlap_seconds, 'overlaps_start'
        elif evcc_start <= tm_start <= evcc_end < tm_end:
            return overlap_seconds, 'overlaps_end'
        else:
            return overlap_seconds, 'inside'

    def _determine_match_quality(
        self,
        evcc_energy: Optional[float],
        tm_energy_sum: Optional[float],
        overlap_seconds: int,
        evcc_duration_seconds: int,
        containment: str
    ) -> str:
        """Determine match quality."""
        if evcc_energy is None or tm_energy_sum is None:
            return 'weak'

        if evcc_energy <= 0:
            return 'weak'

        energy_ratio = tm_energy_sum / evcc_energy
        time_coverage = overlap_seconds / max(evcc_duration_seconds, 1) if evcc_duration_seconds > 0 else 0

        if 0.95 <= energy_ratio <= 1.05 and time_coverage >= 0.8 and containment == 'inside':
            return 'exact'

        if 0.8 <= energy_ratio <= 1.2 and time_coverage >= 0.5:
            return 'plausible'

        if overlap_seconds > 0:
            return 'weak'

        return 'unmatched'

    async def match_all_live(self, limit: Optional[int] = None, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None) -> tuple[List[LiveEVCCSessionMatch], LiveMatchingSummary]:
        """
        Match all LIVE EVCC sessions with LIVE TeslaMateAPI charges.
        Returns (list of matches, summary).
        """
        # Fetch live data
        evcc_sessions = await self.evcc_client.get_sessions(limit)
        tm_charges = await self.teslamateapi_client.get_charges()
        
        # Apply date filtering in memory (APIs don't support date filters)
        evcc_sessions = self._filter_by_date_range(evcc_sessions, days, from_date, to_date)
        tm_charges = self._filter_tm_by_date_range(tm_charges, days, from_date, to_date)

        # Load manual overrides from DB
        overrides = self._get_active_overrides()

        matches: List[LiveEVCCSessionMatch] = []
        total_evcc_energy = 0.0
        total_tm_energy = 0.0
        quality_dist = {'exact': 0, 'plausible': 0, 'weak': 0, 'unmatched': 0}

        total_tm_charges = len(tm_charges)
        # Unique tracking sets
        accepted_tm_charge_ids = set()
        rejected_tm_charge_ids_wrong_location = set()
        candidate_checks_total = 0

        # Build override lookup: tm_charge_id -> override info
        override_map = {}
        for ov in overrides:
            if ov.override_type == OverrideType.manual_assign and ov.evcc_session_id:
                override_map[ov.teslamate_charge_id] = {
                    'evcc_session_id': ov.evcc_session_id,
                    'override_id': ov.id,
                    'reason': ov.reason,
                    'replaced_auto_match': ov.replaced_auto_match
                }

        for evcc in evcc_sessions:
            evcc_start = evcc.created
            evcc_end = evcc.finished

            # If no finished time, estimate from energy
            if not evcc_end and evcc.charged_energy > 0:
                evcc_duration_hours = evcc.charged_energy / 11.0  # assume 11kW
                evcc_end = evcc_start + timedelta(hours=evcc_duration_hours)

            if not evcc_start or not evcc_end:
                match = LiveEVCCSessionMatch(
                    evcc_session_id=evcc.id,
                    evcc_source_id=evcc.source_id,
                    evcc_start=evcc_start.isoformat() if evcc_start else '',
                    evcc_end=evcc_end.isoformat() if evcc_end else '',
                    evcc_energy_kwh=evcc.charged_energy,
                    evcc_cost_eur=evcc.cost,
                    evcc_cost_per_kwh=evcc.price_per_kwh,
                    evcc_location=evcc.location,
                    matched_charge_count=0,
                    matched_charge_ids=[],
                    matched_charges=[],
                    matched_charge_energy_kwh_sum=None,
                    delta_kwh=None,
                    match_quality='unmatched',
                    match_notes='Missing timestamps'
                )
                matches.append(match)
                continue

            evcc_duration_seconds = int((evcc_end - evcc_start).total_seconds())

            # TIME WINDOW FILTER: Only consider TM charges within ±1 day of EVCC session
            evcc_date = evcc_start.date()
            window_start = evcc_start - timedelta(days=1)
            window_end = evcc_end + timedelta(days=1)
            
            tm_charges_in_window = [
                tm for tm in tm_charges
                if tm.start_date and window_start <= tm.start_date <= window_end
            ]

            matched_charges: List[LiveMatchedCharge] = []
            matched_charge_ids: List[int] = []
            matched_energy_sum = 0.0
            manual_matches = 0
            auto_matches = 0

            for tm in tm_charges_in_window:
                candidate_checks_total += 1
                override_info = override_map.get(tm.id)

                if override_info:
                    # Manual override exists
                    if override_info['evcc_session_id'] == evcc.id:
                        manual_matches += 1
                        matched_charges.append(LiveMatchedCharge(
                            charge_id=tm.id,
                            source_id=tm.source_id,
                            date=tm.start_date.isoformat(),
                            energy_kwh=tm.charge_energy_added,
                            charge_energy_added=tm.charge_energy_added,
                            charge_energy_used=tm.charge_energy_used,
                            cost_eur=tm.cost,
                            location=tm.location,
                            location_original=tm.location,
                            location_normalized=self._normalize_location(tm.location),
                            accepted_as_candidate=True,
                            reject_reason=None,
                            overlap_seconds=0,
                            containment='manual_override',
                            match_source='manual_override',
                            override_id=override_info['override_id'],
                            override_reason=override_info['reason'],
                            replaced_auto_match=override_info.get('replaced_auto_match'),
                            charge_type=tm.charge_type,
                            fast_charger_brand=tm.fast_charger_brand,
                            max_charge_power_kw=tm.max_charge_power_kw
                        ))
                        matched_charge_ids.append(tm.id)
                        if tm.charge_energy_added:
                            matched_energy_sum += tm.charge_energy_added
                        accepted_tm_charge_ids.add(tm.id)
                    else:
                        # Override points to different EVCC session - skip here
                        matched_charges.append(LiveMatchedCharge(
                            charge_id=tm.id,
                            source_id=tm.source_id,
                            date=tm.start_date.isoformat(),
                            energy_kwh=tm.charge_energy_added,
                            charge_energy_added=tm.charge_energy_added,
                            charge_energy_used=tm.charge_energy_used,
                            cost_eur=tm.cost,
                            location=tm.location,
                            location_original=tm.location,
                            location_normalized=self._normalize_location(tm.location),
                            accepted_as_candidate=False,
                            reject_reason='skipped_due_to_other_override',
                            overlap_seconds=0,
                            containment='unmatched',
                            match_source='auto',
                            skipped_due_to_other_override=True,
                            charge_type=tm.charge_type,
                            fast_charger_brand=tm.fast_charger_brand,
                            max_charge_power_kw=tm.max_charge_power_kw
                        ))
                    continue

                # No manual override - auto-matching with location pre-filter
                tm_location_original = tm.location
                tm_location_normalized = self._normalize_location(tm.location)
                is_home = self._is_home_location(tm.location)

                if not is_home:
                    rejected_tm_charge_ids_wrong_location.add(tm.id)
                    matched_charges.append(LiveMatchedCharge(
                        charge_id=tm.id,
                        source_id=tm.source_id,
                        date=tm.start_date.isoformat(),
                        energy_kwh=tm.charge_energy_added,
                        charge_energy_added=tm.charge_energy_added,
                        charge_energy_used=tm.charge_energy_used,
                        cost_eur=tm.cost,
                        location=tm.location,
                        location_original=tm_location_original,
                        location_normalized=tm_location_normalized,
                        accepted_as_candidate=False,
                        reject_reason='wrong_location',
                        overlap_seconds=0,
                        containment='unmatched',
                        match_source='auto',
                        charge_type=tm.charge_type,
                        fast_charger_brand=tm.fast_charger_brand,
                        max_charge_power_kw=tm.max_charge_power_kw
                    ))
                    continue

                # Location accepted (home)
                accepted_tm_charge_ids.add(tm.id)

                tm_start = tm.start_date
                tm_end = tm.end_date
                if not tm_end and tm.charge_energy_added > 0:
                    tm_duration_hours = tm.charge_energy_added / 11.0
                    tm_end = tm_start + timedelta(hours=tm_duration_hours)

                if not tm_start:
                    continue

                overlap_seconds, containment = self._calculate_overlap(
                    evcc_start, evcc_end, tm_start, tm_end
                )

                if overlap_seconds > 0 or containment != 'unmatched':
                    auto_matches += 1
                    matched_charges.append(LiveMatchedCharge(
                        charge_id=tm.id,
                        source_id=tm.source_id,
                        date=tm.start_date.isoformat(),
                        energy_kwh=tm.charge_energy_added,
                        charge_energy_added=tm.charge_energy_added,
                        charge_energy_used=tm.charge_energy_used,
                        cost_eur=tm.cost,
                        location=tm.location,
                        location_original=tm_location_original,
                        location_normalized=tm_location_normalized,
                        accepted_as_candidate=True,
                        reject_reason=None,
                        overlap_seconds=overlap_seconds,
                        containment=containment,
                        match_source='auto',
                        charge_type=tm.charge_type,
                        fast_charger_brand=tm.fast_charger_brand,
                        max_charge_power_kw=tm.max_charge_power_kw
                    ))
                    matched_charge_ids.append(tm.id)
                    if tm.charge_energy_added:
                        matched_energy_sum += tm.charge_energy_added

            # Filter to only accepted candidates for match calculation
            actual_matches = [c for c in matched_charges if c.accepted_as_candidate]

            delta_kwh = None
            if evcc.charged_energy is not None and actual_matches:
                matched_energy_sum = sum(c.energy_kwh for c in actual_matches if c.energy_kwh)
                delta_kwh = round(matched_energy_sum - evcc.charged_energy, 2)

            best_containment = 'unmatched'
            if actual_matches:
                containment_order = {'inside': 4, 'envelops': 3, 'overlaps_start': 2, 'overlaps_end': 1, 'manual_override': 5, 'unmatched': 0}
                best_containment = max(
                    [c.containment for c in actual_matches],
                    key=lambda x: containment_order.get(x, 0)
                )

            match_quality = self._determine_match_quality(
                evcc.charged_energy,
                sum(c.energy_kwh for c in actual_matches if c.energy_kwh) if actual_matches else None,
                sum(c.overlap_seconds for c in actual_matches),
                evcc_duration_seconds,
                best_containment
            )

            quality_dist[match_quality] += 1

            notes_parts = []
            if actual_matches:
                manual_count = sum(1 for c in actual_matches if c.match_source == 'manual_override')
                auto_count = len(actual_matches) - manual_count
                if manual_count > 0:
                    notes_parts.append(f"{manual_count} manual override(s)")
                if auto_count > 0:
                    notes_parts.append(f"{auto_count} auto-matched")
                for c in actual_matches:
                    oid = f" (override #{c.override_id})" if c.override_id else ""
                    notes_parts.append(f"  TM#{c.charge_id}: {c.containment}{oid} [{c.match_source}]")
            else:
                notes_parts.append("No TM charges matched (home location)")

            rejected_count = len([c for c in matched_charges if not c.accepted_as_candidate])
            if rejected_count > 0:
                notes_parts.append(f"{rejected_count} TM charge(s) rejected: wrong_location")

            if delta_kwh is not None:
                notes_parts.append(f"Delta: {delta_kwh:+.2f} kWh")

            match = LiveEVCCSessionMatch(
                evcc_session_id=evcc.id,
                evcc_source_id=evcc.source_id,
                evcc_start=evcc_start.isoformat(),
                evcc_end=evcc_end.isoformat(),
                evcc_energy_kwh=evcc.charged_energy,
                evcc_cost_eur=evcc.cost,
                evcc_cost_per_kwh=evcc.price_per_kwh,
                evcc_location=evcc.location,
                matched_charge_count=len(actual_matches),
                matched_charge_ids=[c.charge_id for c in actual_matches],
                matched_charges=matched_charges,
                matched_charge_energy_kwh_sum=round(sum(c.energy_kwh for c in actual_matches if c.energy_kwh), 2) if actual_matches else None,
                delta_kwh=delta_kwh,
                match_quality=match_quality,
                match_notes='; '.join(notes_parts)
            )

            matches.append(match)

            if evcc.charged_energy:
                total_evcc_energy += evcc.charged_energy
            if actual_matches:
                total_tm_energy += sum(c.energy_kwh for c in actual_matches if c.energy_kwh)

        # Summary
        total_delta = round(total_tm_energy - total_evcc_energy, 2)
        matched_count = sum(1 for m in matches if m.matched_charge_count > 0)
        unmatched_count = len(matches) - matched_count

        # Check reachability
        evcc_reachable = await self.evcc_client.is_reachable()
        teslamateapi_reachable = await self.teslamateapi_client.is_reachable()

        summary = LiveMatchingSummary(
            total_evcc_sessions_checked=len(matches),
            total_matched=matched_count,
            total_unmatched=unmatched_count,
            total_evcc_energy=round(total_evcc_energy, 2),
            total_tm_energy=round(total_tm_energy, 2),
            total_delta_kwh=total_delta,
            quality_distribution=quality_dist,
            total_tm_charges=total_tm_charges,
            accepted_tm_charges_unique=len(accepted_tm_charge_ids),
            rejected_tm_charges_wrong_location_unique=len(rejected_tm_charge_ids_wrong_location),
            candidate_checks_total=candidate_checks_total,
            evcc_reachable=evcc_reachable,
            teslamateapi_reachable=teslamateapi_reachable
        )

        return matches, summary

    def _get_active_overrides(self) -> List[MatchingOverride]:
        """Get all active manual overrides (excluding reset_to_auto)."""
        all_overrides = self.db.query(MatchingOverride).order_by(
            MatchingOverride.teslamate_charge_id,
            MatchingOverride.created_at.desc()
        ).all()

        latest_per_charge = {}
        for ov in all_overrides:
            if ov.override_type == OverrideType.reset_to_auto:
                continue
            if ov.teslamate_charge_id not in latest_per_charge:
                latest_per_charge[ov.teslamate_charge_id] = ov

        return list(latest_per_charge.values())


async def run_live_matching_dry_run(limit: Optional[int] = None, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None, db: Session = None) -> Dict[str, Any]:
    """
    Run the live matching dry-run.
    Requires both EVCC and TeslaMateAPI to be configured and reachable.
    """
    from app.database import SessionLocal
    from app.models.datasource import DataSourceConfig

    if db is None:
        db = SessionLocal()
        close_db = True
    else:
        close_db = False

    try:
        # Get config from DB
        config = db.query(DataSourceConfig).first()

        if not config or not config.evcc_base_url or not config.teslamateapi_base_url:
            return {
                'ok': False,
                'error': 'Live-Modus nicht konfiguriert: EVCC und/oder TeslaMateAPI fehlen in den Einstellungen',
                'matches': [],
                'summary': {},
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'live_mode': False,
                'config_missing': True
            }

        # Create clients
        evcc_client = await create_evcc_client_from_config(config)
        teslamateapi_client = await create_teslamateapi_client_from_config(config)

        if not evcc_client or not teslamateapi_client:
            return {
                'ok': False,
                'error': 'Client-Erstellung fehlgeschlagen',
                'matches': [],
                'summary': {},
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'live_mode': False
            }

        service = LiveMatchingService(evcc_client, teslamateapi_client, db)
        matches, summary = await service.match_all_live(limit, days, from_date, to_date)

        # Get reachability from summary
        evcc_reachable = summary.evcc_reachable
        teslamateapi_reachable = summary.teslamateapi_reachable

        # Convert to dict for JSON response
        result = {
            'ok': True,
            'matches': [asdict(m) for m in matches],
            'summary': asdict(summary),
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'live_mode': True,
            'evcc_reachable': evcc_reachable,
            'teslamateapi_reachable': teslamateapi_reachable
        }

        return result

    finally:
        if close_db:
            db.close()