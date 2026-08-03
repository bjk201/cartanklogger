from sqlalchemy.orm import Session
from sqlalchemy import desc, text, func
from typing import List, Optional, Tuple
from datetime import datetime, timedelta
from app.models.session import SessionModel


class SessionRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_recent_sessions(self, limit: int = 10) -> List[SessionModel]:
        """Get recent sessions globally sorted by date descending."""
        return (
            self.db.query(SessionModel)
            .order_by(desc(SessionModel.date))
            .limit(limit)
            .all()
        )

    def get_sessions_paginated(
        self,
        page: int = 1,
        page_size: int = 25,
        source_type: Optional[str] = None,
        search: Optional[str] = None,
        sort_desc: bool = True,
    ) -> tuple[List[SessionModel], int]:
        """Get sessions with pagination, filtering, and sorting."""
        query = self.db.query(SessionModel)
        
        # Filter by source_type
        if source_type and source_type != "all":
            query = query.filter(SessionModel.source_type == source_type)
        
        # Search in location and note
        if search:
            search_term = f"%{search}%"
            query = query.filter(
                (SessionModel.location.ilike(search_term)) |
                (SessionModel.note.ilike(search_term))
            )
        
        # Get total count before pagination
        total = query.count()
        
        # Sort
        if sort_desc:
            query = query.order_by(desc(SessionModel.date))
        else:
            query = query.order_by(SessionModel.date)
        
        # Pagination
        offset = (page - 1) * page_size
        sessions = query.offset(offset).limit(page_size).all()
        
        return sessions, total

    def get_statistics(self, range_days: Optional[int] = None) -> dict:
        """Get aggregated statistics for the given time range."""
        query = self.db.query(SessionModel)
        
        # Apply time range filter
        if range_days is not None:
            cutoff_date = datetime.now() - timedelta(days=range_days)
            query = query.filter(SessionModel.date >= cutoff_date)
        
        # Base aggregations
        total_sessions = query.count()
        
        # Aggregations by source type
        home_query = query.filter(SessionModel.source_type == "home")
        external_query = query.filter(SessionModel.source_type == "external")
        import_query = query.filter(SessionModel.source_type == "import")
        
        home_sessions = home_query.count()
        external_sessions = external_query.count()
        import_sessions = import_query.count()
        
        # Energy sums
        total_energy = query.with_entities(func.coalesce(func.sum(SessionModel.energy_kwh), 0)).scalar() or 0
        home_energy = home_query.with_entities(func.coalesce(func.sum(SessionModel.energy_kwh), 0)).scalar() or 0
        external_energy = external_query.with_entities(func.coalesce(func.sum(SessionModel.energy_kwh), 0)).scalar() or 0
        import_energy = import_query.with_entities(func.coalesce(func.sum(SessionModel.energy_kwh), 0)).scalar() or 0
        
        # Cost sums
        total_cost = query.with_entities(func.coalesce(func.sum(SessionModel.cost_eur), 0)).scalar() or 0
        home_cost = home_query.with_entities(func.coalesce(func.sum(SessionModel.cost_eur), 0)).scalar() or 0
        external_cost = external_query.with_entities(func.coalesce(func.sum(SessionModel.cost_eur), 0)).scalar() or 0
        import_cost = import_query.with_entities(func.coalesce(func.sum(SessionModel.cost_eur), 0)).scalar() or 0
        
        # DC/AC breakdown for external sessions
        external_dc_query = external_query.filter(SessionModel.charge_type == "DC")
        external_ac_query = external_query.filter(SessionModel.charge_type == "AC")
        
        external_dc_sessions = external_dc_query.count()
        external_ac_sessions = external_ac_query.count()
        
        external_dc_energy = external_dc_query.with_entities(func.coalesce(func.sum(SessionModel.energy_kwh), 0)).scalar() or 0
        external_ac_energy = external_ac_query.with_entities(func.coalesce(func.sum(SessionModel.energy_kwh), 0)).scalar() or 0
        
        external_dc_cost = external_dc_query.with_entities(func.coalesce(func.sum(SessionModel.cost_eur), 0)).scalar() or 0
        external_ac_cost = external_ac_query.with_entities(func.coalesce(func.sum(SessionModel.cost_eur), 0)).scalar() or 0
        
        # Average cost per kWh (only where both cost and energy exist and energy > 0)
        avg_cost_per_kwh = None
        if total_energy > 0:
            avg_cost_per_kwh = round(total_cost / total_energy, 4)
        
        # Session-based averages
        avg_energy_per_session = None
        avg_cost_per_session = None
        if total_sessions > 0:
            avg_energy_per_session = round(total_energy / total_sessions, 2)
            avg_cost_per_session = round(total_cost / total_sessions, 2)
        
        # Max energy session
        max_energy_session = (
            query.filter(SessionModel.energy_kwh.isnot(None))
            .order_by(desc(SessionModel.energy_kwh))
            .first()
        )
        max_energy_val = max_energy_session.energy_kwh if max_energy_session else None
        max_energy_id = max_energy_session.id if max_energy_session else None
        
        # Max cost session
        max_cost_session = (
            query.filter(SessionModel.cost_eur.isnot(None))
            .order_by(desc(SessionModel.cost_eur))
            .first()
        )
        max_cost_val = max_cost_session.cost_eur if max_cost_session else None
        max_cost_id = max_cost_session.id if max_cost_session else None
        
        return {
            "kpis": {
                "total_energy_kwh": round(total_energy, 2),
                "total_cost_eur": round(total_cost, 2),
                "avg_cost_per_kwh": avg_cost_per_kwh,
                "total_sessions": total_sessions,
                "home_sessions": home_sessions,
                "external_sessions": external_sessions,
                "import_sessions": import_sessions,
                "avg_energy_per_session": avg_energy_per_session,
                "avg_cost_per_session": avg_cost_per_session,
                "max_energy_session": round(max_energy_val, 2) if max_energy_val else None,
                "max_cost_session": round(max_cost_val, 2) if max_cost_val else None,
                "max_energy_session_id": max_energy_id,
                "max_cost_session_id": max_cost_id,
                # DC/AC breakdown for external sessions
                "external_dc_sessions": external_dc_sessions,
                "external_ac_sessions": external_ac_sessions,
                "external_dc_energy_kwh": round(external_dc_energy, 2),
                "external_ac_energy_kwh": round(external_ac_energy, 2),
                "external_dc_cost_eur": round(external_dc_cost, 2),
                "external_ac_cost_eur": round(external_ac_cost, 2),
            },
            "energy_by_source": {
                "home": round(home_energy, 2),
                "external": round(external_energy, 2),
                "import": round(import_energy, 2),
                "total": round(total_energy, 2),
            },
            "cost_by_source": {
                "home": round(home_cost, 2),
                "external": round(external_cost, 2),
                "import": round(import_cost, 2),
                "total": round(total_cost, 2),
            },
            "sessions_by_source": {
                "home": home_sessions,
                "external": external_sessions,
                "import": import_sessions,
                "total": total_sessions,
            },
        }

    def count_all_sessions(self) -> int:
        """Count total sessions."""
        return self.db.query(SessionModel).count()

    def insert_seed_data(self) -> int:
        """Insert seed data for MVP testing. Returns count of inserted rows."""
        # Check if already seeded
        from app.models.session import SeedDataModel
        existing = self.db.query(SeedDataModel).first()
        if existing:
            return 0

        # Sample seed data matching the response contract
        from datetime import datetime, timedelta
        import random

        sessions = []
        base_date = datetime.now()
        
        # Home sessions
        for i in range(5):
            energy = round(random.uniform(10.0, 25.0), 1)
            cost = round(random.uniform(3.0, 8.0), 2)
            s = SessionModel(
                source_id=str(i + 1),
                source_type="home",
                date=base_date - timedelta(days=i * 2),
                location="Garage",
                energy_kwh=energy,
                cost_eur=cost,
                odometer_km=round(50000 + i * 150.5, 1),
                distance_km=round(random.uniform(80.0, 180.0), 1) if i > 0 else None,
                note="Home charging" if i % 2 == 0 else None,
                cost_per_kwh=round(cost / energy, 4) if energy > 0 else None,
                cost_per_kwh_source="api",
            )
            sessions.append(s)

        # External sessions (TeslaMate)
        for i in range(3):
            energy = round(random.uniform(30.0, 60.0), 1)
            cost = round(random.uniform(15.0, 35.0), 2)
            s = SessionModel(
                source_id=str(i + 1),
                source_type="external",
                date=base_date - timedelta(days=i * 3 + 1),
                location=f"Supercharger {['Munich', 'Berlin', 'Hamburg'][i]}",
                energy_kwh=energy,
                cost_eur=cost,
                odometer_km=round(50500 + i * 200.0, 1),
                distance_km=round(random.uniform(200.0, 350.0), 1),
                note="Long distance trip",
                cost_per_kwh=round(cost / energy, 4) if energy > 0 else None,
                cost_per_kwh_source="derived",
            )
            sessions.append(s)

        # Import sessions
        for i in range(2):
            energy = round(random.uniform(5.0, 15.0), 1)
            cost = round(random.uniform(2.0, 5.0), 2)
            s = SessionModel(
                source_id=str(i + 1),
                source_type="import",
                date=base_date - timedelta(days=10 + i * 5),
                location="Unknown",
                energy_kwh=energy,
                cost_eur=cost,
                odometer_km=round(49000 + i * 100.0, 1),
                distance_km=None,
                note="CSV Import",
                cost_per_kwh=round(cost / energy, 4) if energy > 0 else None,
                cost_per_kwh_source="derived",
            )
            sessions.append(s)

        self.db.add_all(sessions)
        self.db.commit()

        # Mark as seeded
        seed_marker = SeedDataModel(version="1.0")
        self.db.add(seed_marker)
        self.db.commit()

        return len(sessions)