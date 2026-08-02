from sqlalchemy.orm import Session
from sqlalchemy import desc, text
from typing import List, Optional
from datetime import datetime
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
            s = SessionModel(
                source_id=str(i + 1),
                source_type="home",
                date=base_date - timedelta(days=i * 2),
                location="Garage",
                energy_kwh=round(random.uniform(10.0, 25.0), 1),
                cost_eur=round(random.uniform(3.0, 8.0), 2),
                odometer_km=round(50000 + i * 150.5, 1),
                distance_km=round(random.uniform(80.0, 180.0), 1) if i > 0 else None,
                note="Home charging" if i % 2 == 0 else None,
            )
            sessions.append(s)

        # External sessions (TeslaMate)
        for i in range(3):
            s = SessionModel(
                source_id=str(i + 1),
                source_type="external",
                date=base_date - timedelta(days=i * 3 + 1),
                location=f"Supercharger {['Munich', 'Berlin', 'Hamburg'][i]}",
                energy_kwh=round(random.uniform(30.0, 60.0), 1),
                cost_eur=round(random.uniform(15.0, 35.0), 2),
                odometer_km=round(50500 + i * 200.0, 1),
                distance_km=round(random.uniform(200.0, 350.0), 1),
                note="Long distance trip",
            )
            sessions.append(s)

        # Import sessions
        for i in range(2):
            s = SessionModel(
                source_id=str(i + 1),
                source_type="import",
                date=base_date - timedelta(days=10 + i * 5),
                location="Unknown",
                energy_kwh=round(random.uniform(5.0, 15.0), 1),
                cost_eur=round(random.uniform(2.0, 5.0), 2),
                odometer_km=round(49000 + i * 100.0, 1),
                distance_km=None,
                note="CSV Import",
            )
            sessions.append(s)

        self.db.add_all(sessions)
        self.db.commit()

        # Mark as seeded
        seed_marker = SeedDataModel(version="1.0")
        self.db.add(seed_marker)
        self.db.commit()

        return len(sessions)