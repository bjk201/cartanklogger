"""
EVCC ↔ TeslaMateAPI Matching Service
====================================

Read-only dry-run matching of EVCC sessions with TeslaMateAPI charges.
Uses time window overlap logic with location pre-filter and manual overrides.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_

from app.models.session import SessionModel
from app.models.matching_override import MatchingOverride, OverrideType
from app.database import get_db


@dataclass
class MatchedCharge:
    """A TeslaMate charge that matched an EVCC session."""
    charge_id: int
    source_id: str
    date: str
    energy_kwh: Optional[float]
    cost_eur: Optional[float]
    location: Optional[str]
    # Pre-filter info
    location_original: Optional[str]
    location_normalized: Optional[str]
    accepted_as_candidate: bool
    reject_reason: Optional[str]
    # Match info
    overlap_seconds: int
    containment: str  # 'inside', 'overlaps_start', 'overlaps_end', 'envelops', 'manual_override'
    # Source info
    match_source: str = 'auto'  # 'auto' | 'manual_override'
    override_id: Optional[int] = None
    override_reason: Optional[str] = None
    replaced_auto_match: Optional[str] = None
    skipped_due_to_other_override: bool = False


@dataclass
class EVCCSessionMatch:
    """Matching result for one EVCC session."""
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
    matched_charges: List[MatchedCharge]
    matched_charge_energy_kwh_sum: Optional[float]
    delta_kwh: Optional[float]
    match_quality: str  # 'exact', 'plausible', 'weak', 'unmatched'
    match_notes: str


@dataclass
class MatchingSummary:
    """Overall matching summary."""
    total_evcc_sessions_checked: int
    total_matched: int
    total_unmatched: int
    total_evcc_energy: float
    total_tm_energy: float
    total_delta_kwh: float
    quality_distribution: Dict[str, int]
    # Pre-filter stats
    total_tm_charges: int
    accepted_candidates: int
    rejected_wrong_location: int


class MatchingService:
    """Service for matching EVCC sessions with TeslaMateAPI charges."""
    
    # Home location identifier - exact match after normalization
    HOME_LOCATION_KEY = "zuhause"
    
    def __init__(self, db: Session):
        self.db = db
    
    def _parse_datetime(self, dt_str: str) -> Optional[datetime]:
        """Parse ISO datetime string."""
        if not dt_str:
            return None
        try:
            # Handle Z suffix
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
    
    def _get_evcc_sessions(self, limit: Optional[int] = None, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None) -> List[SessionModel]:
        """Get EVCC (home) sessions with optional date filtering."""
        from sqlalchemy import func
        query = self.db.query(SessionModel).filter(
            SessionModel.source_type == 'home'
        )
        
        # Apply time range filter
        if from_date and to_date:
            from_str = from_date
            to_str = to_date + ' 23:59:59'
            query = query.filter(
                func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str,
                func.date(func.replace(SessionModel.date, 'T', ' ')) <= to_str
            )
        elif from_date and not to_date:
            from_str = from_date
            query = query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str)
        elif days is not None:
            from datetime import datetime, timedelta, timezone
            cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
            cutoff_str = cutoff_date.strftime('%Y-%m-%d')
            query = query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= cutoff_str)
        
        query = query.order_by(SessionModel.date.desc())
        
        if limit:
            query = query.limit(limit)
        
        return query.all()
    
    def _get_teslamate_charges(self, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None) -> List[SessionModel]:
        """Get TeslaMateAPI (external) charges with optional date filtering."""
        from sqlalchemy import func
        query = self.db.query(SessionModel).filter(
            SessionModel.source_type == 'external'
        )
        
        # Apply time range filter
        if from_date and to_date:
            from_str = from_date
            to_str = to_date + ' 23:59:59'
            query = query.filter(
                func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str,
                func.date(func.replace(SessionModel.date, 'T', ' ')) <= to_str
            )
        elif from_date and not to_date:
            from_str = from_date
            query = query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= from_str)
        elif days is not None:
            from datetime import datetime, timedelta, timezone
            cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
            cutoff_str = cutoff_date.strftime('%Y-%m-%d')
            query = query.filter(func.date(func.replace(SessionModel.date, 'T', ' ')) >= cutoff_str)
        
        return query.all()
    
    def _calculate_overlap(
        self, 
        evcc_start: datetime, 
        evcc_end: datetime,
        tm_start: datetime, 
        tm_end: Optional[datetime]
    ) -> tuple[int, str]:
        """
        Calculate overlap between EVCC session and TeslaMate charge.
        Returns (overlap_seconds, containment_type).
        """
        if tm_end is None:
            # If no end time, treat as point event
            if evcc_start <= tm_start <= evcc_end:
                return 0, 'overlaps_start'
            return 0, 'unmatched'
        
        # Calculate overlap
        overlap_start = max(evcc_start, tm_start)
        overlap_end = min(evcc_end, tm_end)
        
        if overlap_start >= overlap_end:
            return 0, 'unmatched'
        
        overlap_seconds = int((overlap_end - overlap_start).total_seconds())
        
        # Determine containment type
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
        
        # Energy ratio
        energy_ratio = tm_energy_sum / evcc_energy
        
        # Time coverage ratio
        time_coverage = overlap_seconds / max(evcc_duration_seconds, 1) if evcc_duration_seconds > 0 else 0
        
        # Exact: energy very close (within 5%) and good time coverage
        if 0.95 <= energy_ratio <= 1.05 and time_coverage >= 0.8 and containment == 'inside':
            return 'exact'
        
        # Plausible: energy within 20% and reasonable time coverage
        if 0.8 <= energy_ratio <= 1.2 and time_coverage >= 0.5:
            return 'plausible'
        
        # Weak: some overlap but significant difference
        if overlap_seconds > 0:
            return 'weak'
        
        return 'unmatched'
    
    def match_all(self, limit: Optional[int] = None, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None) -> tuple[List[EVCCSessionMatch], MatchingSummary]:
        """
        Match all EVCC sessions with TeslaMateAPI charges.
        Returns (list of matches, summary).
        """
        evcc_sessions = self._get_evcc_sessions(limit, days, from_date, to_date)
        tm_charges = self._get_teslamate_charges(days, from_date, to_date)
        
        # Load manual overrides
        overrides = self._get_active_overrides()
        
        matches: List[EVCCSessionMatch] = []
        total_evcc_energy = 0.0
        total_tm_energy = 0.0
        quality_dist = {'exact': 0, 'plausible': 0, 'weak': 0, 'unmatched': 0}
        
        # Pre-filter stats
        total_tm_charges = len(tm_charges)
        accepted_candidates = 0
        rejected_wrong_location = 0
        
        # Track which TM charges are already assigned via override
        overridden_tm_charge_ids = set()
        for ov in overrides:
            if ov.override_type == OverrideType.manual_assign and ov.evcc_session_id:
                overridden_tm_charge_ids.add(ov.teslamate_charge_id)
        
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
            evcc_start = self._parse_datetime(evcc.date.isoformat() if evcc.date else '')
            
            # EVCC end time: estimate duration from energy
            evcc_duration_hours = 0
            if evcc.energy_kwh and evcc.energy_kwh > 0:
                # Assume average 11kW charging power
                evcc_duration_hours = float(evcc.energy_kwh) / 11.0
            
            evcc_end = evcc_start + timedelta(hours=evcc_duration_hours) if evcc_start else None
            
            if not evcc_start or not evcc_end:
                # Cannot match without times
                match = EVCCSessionMatch(
                    evcc_session_id=evcc.id,
                    evcc_source_id=evcc.source_id,
                    evcc_start=evcc_start.isoformat() if evcc_start else '',
                    evcc_end=evcc_end.isoformat() if evcc_end else '',
                    evcc_energy_kwh=evcc.energy_kwh,
                    evcc_cost_eur=evcc.cost_eur,
                    evcc_cost_per_kwh=evcc.cost_per_kwh,
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
            
            # Find matching TM charges
            matched_charges: List[MatchedCharge] = []
            matched_charge_ids: List[int] = []
            matched_energy_sum = 0.0
            manual_matches = 0
            auto_matches = 0
            
            for tm in tm_charges:
                # Check if this TM charge has a manual override
                override_info = override_map.get(tm.id)
                
                if override_info:
                    # Manual override exists - use it if it points to this EVCC session
                    if override_info['evcc_session_id'] == evcc.id:
                        # This TM charge is manually assigned to this EVCC session
                        manual_matches += 1
                        matched_charges.append(MatchedCharge(
                            charge_id=tm.id,
                            source_id=tm.source_id,
                            date=tm.date.isoformat() if tm.date else '',
                            energy_kwh=tm.energy_kwh,
                            cost_eur=tm.cost_eur,
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
                            replaced_auto_match=override_info.get('replaced_auto_match')
                        ))
                        matched_charge_ids.append(tm.id)
                        if tm.energy_kwh:
                            matched_energy_sum += float(tm.energy_kwh)
                    else:
                        # Override exists but points to a DIFFERENT EVCC session
                        # This charge is skipped for auto-matching in this session
                        matched_charges.append(MatchedCharge(
                            charge_id=tm.id,
                            source_id=tm.source_id,
                            date=tm.date.isoformat() if tm.date else '',
                            energy_kwh=tm.energy_kwh,
                            cost_eur=tm.cost_eur,
                            location=tm.location,
                            location_original=tm.location,
                            location_normalized=self._normalize_location(tm.location),
                            accepted_as_candidate=False,
                            reject_reason='skipped_due_to_other_override',
                            overlap_seconds=0,
                            containment='unmatched',
                            match_source='auto',
                            skipped_due_to_other_override=True
                        ))
                    continue
                
                # No manual override - apply auto-matching logic
                # PRE-FILTER: Location check
                tm_location_original = tm.location
                tm_location_normalized = self._normalize_location(tm.location)
                is_home = self._is_home_location(tm.location)
                
                if not is_home:
                    rejected_wrong_location += 1
                    # Still record as rejected candidate for debugging
                    matched_charges.append(MatchedCharge(
                        charge_id=tm.id,
                        source_id=tm.source_id,
                        date=tm.date.isoformat() if tm.date else '',
                        energy_kwh=tm.energy_kwh,
                        cost_eur=tm.cost_eur,
                        location=tm.location,
                        location_original=tm_location_original,
                        location_normalized=tm_location_normalized,
                        accepted_as_candidate=False,
                        reject_reason='wrong_location',
                        overlap_seconds=0,
                        containment='unmatched',
                        match_source='auto'
                    ))
                    continue
                
                # Location accepted
                accepted_candidates += 1
                
                tm_start = self._parse_datetime(tm.date.isoformat() if tm.date else '')
                # TM end: estimate from energy
                tm_end = None
                if tm.energy_kwh and tm.energy_kwh > 0:
                    tm_duration_hours = float(tm.energy_kwh) / 11.0  # rough estimate
                    tm_end = tm_start + timedelta(hours=tm_duration_hours) if tm_start else None
                
                if not tm_start:
                    continue
                
                overlap_seconds, containment = self._calculate_overlap(
                    evcc_start, evcc_end, tm_start, tm_end
                )
                
                if overlap_seconds > 0 or containment != 'unmatched':
                    auto_matches += 1
                    matched_charges.append(MatchedCharge(
                        charge_id=tm.id,
                        source_id=tm.source_id,
                        date=tm.date.isoformat() if tm.date else '',
                        energy_kwh=tm.energy_kwh,
                        cost_eur=tm.cost_eur,
                        location=tm.location,
                        location_original=tm_location_original,
                        location_normalized=tm_location_normalized,
                        accepted_as_candidate=True,
                        reject_reason=None,
                        overlap_seconds=overlap_seconds,
                        containment=containment,
                        match_source='auto'
                    ))
                    matched_charge_ids.append(tm.id)
                    if tm.energy_kwh:
                        matched_energy_sum += float(tm.energy_kwh)
            
            # Filter to only accepted candidates for match calculation
            actual_matches = [c for c in matched_charges if c.accepted_as_candidate]
            
            # Calculate delta
            delta_kwh = None
            if evcc.energy_kwh is not None and actual_matches:
                matched_energy_sum = sum(c.energy_kwh for c in actual_matches if c.energy_kwh)
                delta_kwh = round(matched_energy_sum - float(evcc.energy_kwh), 2)
            
            # Determine quality
            best_containment = 'unmatched'
            if actual_matches:
                containment_order = {'inside': 4, 'envelops': 3, 'overlaps_start': 2, 'overlaps_end': 1, 'manual_override': 5, 'unmatched': 0}
                best_containment = max(
                    [c.containment for c in actual_matches],
                    key=lambda x: containment_order.get(x, 0)
                )
            
            match_quality = self._determine_match_quality(
                evcc.energy_kwh,
                sum(c.energy_kwh for c in actual_matches if c.energy_kwh) if actual_matches else None,
                sum(c.overlap_seconds for c in actual_matches),
                evcc_duration_seconds,
                best_containment
            )
            
            quality_dist[match_quality] += 1
            
            # Build notes
            notes_parts = []
            if actual_matches:
                manual_count = sum(1 for c in actual_matches if getattr(c, 'match_source', 'auto') == 'manual_override')
                auto_count = len(actual_matches) - manual_count
                if manual_count > 0:
                    notes_parts.append(f"{manual_count} manual override(s)")
                if auto_count > 0:
                    notes_parts.append(f"{auto_count} auto-matched")
                for c in actual_matches:
                    source = getattr(c, 'match_source', 'auto')
                    oid = f" (override #{c.override_id})" if getattr(c, 'override_id', None) else ""
                    notes_parts.append(f"  TM#{c.charge_id}: {c.containment}{oid} [{source}]")
            else:
                notes_parts.append("No TM charges matched (home location)")
            
            # Show rejected count
            rejected_count = len([c for c in matched_charges if not c.accepted_as_candidate])
            if rejected_count > 0:
                notes_parts.append(f"{rejected_count} TM charge(s) rejected: wrong_location")
            
            if delta_kwh is not None:
                notes_parts.append(f"Delta: {delta_kwh:+.2f} kWh")
            
            match = EVCCSessionMatch(
                evcc_session_id=evcc.id,
                evcc_source_id=evcc.source_id,
                evcc_start=evcc_start.isoformat(),
                evcc_end=evcc_end.isoformat(),
                evcc_energy_kwh=evcc.energy_kwh,
                evcc_cost_eur=evcc.cost_eur,
                evcc_cost_per_kwh=evcc.cost_per_kwh,
                evcc_location=evcc.location,
                matched_charge_count=len(actual_matches),
                matched_charge_ids=[c.charge_id for c in actual_matches],
                matched_charges=matched_charges,  # Include all for debugging (accepted + rejected)
                matched_charge_energy_kwh_sum=round(sum(c.energy_kwh for c in actual_matches if c.energy_kwh), 2) if actual_matches else None,
                delta_kwh=delta_kwh,
                match_quality=match_quality,
                match_notes='; '.join(notes_parts)
            )
            
            matches.append(match)
            
            if evcc.energy_kwh:
                total_evcc_energy += float(evcc.energy_kwh)
            if actual_matches:
                total_tm_energy += sum(c.energy_kwh for c in actual_matches if c.energy_kwh)
        
        # Summary
        total_delta = round(total_tm_energy - total_evcc_energy, 2)
        matched_count = sum(1 for m in matches if m.matched_charge_count > 0)
        unmatched_count = len(matches) - matched_count
        
        summary = MatchingSummary(
            total_evcc_sessions_checked=len(matches),
            total_matched=matched_count,
            total_unmatched=unmatched_count,
            total_evcc_energy=round(total_evcc_energy, 2),
            total_tm_energy=round(total_tm_energy, 2),
            total_delta_kwh=total_delta,
            quality_distribution=quality_dist,
            total_tm_charges=total_tm_charges,
            accepted_candidates=accepted_candidates,
            rejected_wrong_location=rejected_wrong_location
        )
        
        return matches, summary
    
    def _get_active_overrides(self) -> List[MatchingOverride]:
        """Get all active manual overrides (excluding reset_to_auto and cancelled ones).
        
        Returns only the latest NON-reset override per TM charge.
        """
        # Get all overrides ordered by TM charge and created_at desc
        all_overrides = self.db.query(MatchingOverride).order_by(
            MatchingOverride.teslamate_charge_id,
            MatchingOverride.created_at.desc()
        ).all()
        
        # Keep only the latest NON-reset override per TM charge
        latest_per_charge = {}
        for ov in all_overrides:
            if ov.override_type == OverrideType.reset_to_auto:
                continue
            if ov.teslamate_charge_id not in latest_per_charge:
                latest_per_charge[ov.teslamate_charge_id] = ov
        
        return list(latest_per_charge.values())


def run_matching_dry_run(limit: Optional[int] = None, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None) -> Dict[str, Any]:
    """
    Run the matching dry-run.
    Can be called directly or via API endpoint.
    """
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        service = MatchingService(db)
        matches, summary = service.match_all(limit, days, from_date, to_date)
        return {
            'ok': True,
            'matches': [asdict(m) for m in matches],
            'summary': asdict(summary),
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        return {
            'ok': False,
            'error': str(e),
            'matches': [],
            'summary': {},
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
    finally:
        db.close()