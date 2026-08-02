"""
EVCC ↔ TeslaMateAPI Matching Service
====================================

Read-only dry-run matching of EVCC sessions with TeslaMateAPI charges.
Uses time window overlap logic.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_

from app.models.session import SessionModel
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
    overlap_seconds: int
    containment: str  # 'inside', 'overlaps_start', 'overlaps_end', 'envelops'


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


class MatchingService:
    """Service for matching EVCC sessions with TeslaMateAPI charges."""
    
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
    
    def _get_evcc_sessions(self, limit: Optional[int] = None) -> List[SessionModel]:
        """Get EVCC (home) sessions."""
        query = self.db.query(SessionModel).filter(
            SessionModel.source_type == 'home'
        ).order_by(SessionModel.date.desc())
        
        if limit:
            query = query.limit(limit)
        
        return query.all()
    
    def _get_teslamate_charges(self) -> List[SessionModel]:
        """Get TeslaMateAPI (external) charges."""
        return self.db.query(SessionModel).filter(
            SessionModel.source_type == 'external'
        ).all()
    
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
    
    def match_all(self, limit: Optional[int] = None) -> tuple[List[EVCCSessionMatch], MatchingSummary]:
        """
        Match all EVCC sessions with TeslaMateAPI charges.
        Returns (list of matches, summary).
        """
        evcc_sessions = self._get_evcc_sessions(limit)
        tm_charges = self._get_teslamate_charges()
        
        matches: List[EVCCSessionMatch] = []
        total_evcc_energy = 0.0
        total_tm_energy = 0.0
        quality_dist = {'exact': 0, 'plausible': 0, 'weak': 0, 'unmatched': 0}
        
        for evcc in evcc_sessions:
            evcc_start = self._parse_datetime(evcc.date.isoformat() if evcc.date else '')
            
            # EVCC end time: we need finished time - not in model directly
            # Use date + estimate based on energy (rough: 11kW charging = ~1h per 11kWh)
            # Or we can check if there's a finished field in legacy data
            # For now, estimate duration from energy
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
            
            for tm in tm_charges:
                tm_start = self._parse_datetime(tm.date.isoformat() if tm.date else '')
                # TM end: estimate from energy or use finished if available
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
                    matched_charges.append(MatchedCharge(
                        charge_id=tm.id,
                        source_id=tm.source_id,
                        date=tm.date.isoformat() if tm.date else '',
                        energy_kwh=tm.energy_kwh,
                        cost_eur=tm.cost_eur,
                        location=tm.location,
                        overlap_seconds=overlap_seconds,
                        containment=containment
                    ))
                    matched_charge_ids.append(tm.id)
                    if tm.energy_kwh:
                        matched_energy_sum += float(tm.energy_kwh)
            
            # Calculate delta
            delta_kwh = None
            if evcc.energy_kwh is not None and matched_energy_sum > 0:
                delta_kwh = round(matched_energy_sum - float(evcc.energy_kwh), 2)
            
            # Determine quality
            best_containment = 'unmatched'
            if matched_charges:
                # Use best containment
                containment_order = {'inside': 4, 'envelops': 3, 'overlaps_start': 2, 'overlaps_end': 1, 'unmatched': 0}
                best_containment = max(
                    [c.containment for c in matched_charges],
                    key=lambda x: containment_order.get(x, 0)
                )
            
            match_quality = self._determine_match_quality(
                evcc.energy_kwh,
                matched_energy_sum if matched_charges else None,
                sum(c.overlap_seconds for c in matched_charges),
                evcc_duration_seconds,
                best_containment
            )
            
            quality_dist[match_quality] += 1
            
            # Build notes
            notes_parts = []
            if matched_charges:
                notes_parts.append(f"{len(matched_charges)} TM charge(s) matched")
                for c in matched_charges:
                    notes_parts.append(f"  TM#{c.charge_id}: {c.containment}, overlap={c.overlap_seconds}s")
            else:
                notes_parts.append("No TM charges matched")
            
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
                matched_charge_count=len(matched_charges),
                matched_charge_ids=matched_charge_ids,
                matched_charges=matched_charges,
                matched_charge_energy_kwh_sum=round(matched_energy_sum, 2) if matched_charges else None,
                delta_kwh=delta_kwh,
                match_quality=match_quality,
                match_notes='; '.join(notes_parts)
            )
            
            matches.append(match)
            
            if evcc.energy_kwh:
                total_evcc_energy += float(evcc.energy_kwh)
            if matched_charges:
                total_tm_energy += matched_energy_sum
        
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
            quality_distribution=quality_dist
        )
        
        return matches, summary


def run_matching_dry_run(limit: Optional[int] = None) -> Dict[str, Any]:
    """
    Run the matching dry-run.
    Can be called directly or via API endpoint.
    """
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        service = MatchingService(db)
        matches, summary = service.match_all(limit)
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