"""
Sync Service
============

Imports live data from EVCC and TeslaMateAPI into the local database.
"""

from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import and_

from app.models.session import SessionModel, ChargeType
from app.models.datasource import DataSourceConfig
from app.services.evcc_client import create_evcc_client_from_config, EVCCLiveSession
from app.services.teslamateapi_client import create_teslamateapi_client_from_config, TeslaMateAPICharge


class SyncService:
    """Service for syncing live data from EVCC and TeslaMateAPI."""
    
    def __init__(self, db: Session):
        self.db = db
    
    async def sync_all(self) -> dict:
        """Sync both EVCC and TM data."""
        results = {
            "evcc": {"synced": 0, "errors": []},
            "teslamateapi": {"synced": 0, "errors": []},
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        
        config = self.db.query(DataSourceConfig).first()
        if not config:
            results["evcc"]["errors"].append("Keine Konfiguration gefunden")
            results["teslamateapi"]["errors"].append("Keine Konfiguration gefunden")
            return results
        
        # Sync EVCC if configured
        if config.evcc_base_url:
            evcc_result = await self._sync_evcc(config)
            results["evcc"] = evcc_result
        
        # Sync TeslaMateAPI if configured
        if config.teslamateapi_base_url:
            tm_result = await self._sync_teslamateapi(config)
            results["teslamateapi"] = tm_result
        
        return results
    
    async def _sync_evcc(self, config: DataSourceConfig) -> dict:
        """Sync EVCC sessions to database."""
        result = {"synced": 0, "errors": []}
        
        try:
            client = await create_evcc_client_from_config(config)
            if not client:
                result["errors"].append("EVCC Client konnte nicht erstellt werden")
                return result
            
            live_sessions = await client.get_sessions()

            live_source_ids = set()
            for live_session in live_sessions:
                live_source_ids.add(live_session.source_id)
                try:
                    # Check if already exists (by source_id)
                    existing = self.db.query(SessionModel).filter(
                        and_(
                            SessionModel.source_type == "home",
                            SessionModel.source_id == live_session.source_id
                        )
                    ).first()
                    
                    if existing:
                        # Update existing
                        existing.location = live_session.location
                        existing.energy_kwh = live_session.charged_energy
                        existing.cost_eur = live_session.cost
                        existing.date = live_session.created
                        existing.cost_per_kwh = live_session.price_per_kwh
                        existing.cost_per_kwh_source = "api" if live_session.price_per_kwh else "derived"
                        existing.odometer_km = live_session.odometer
                        existing.note = f"EVCC Loadpoint: {live_session.loadpoint}"
                        # PV/Solar data from EVCC API
                        existing.solar_percentage = live_session.solar_percentage
                        existing.pv_kwh = live_session.pv_kwh
                        existing.updated_at = datetime.now(timezone.utc)
                    else:
                        # Create new
                        session = SessionModel(
                            source_id=live_session.source_id,
                            source_type="home",
                            date=live_session.created,
                            location=live_session.location,
                            energy_kwh=live_session.charged_energy,
                            cost_eur=live_session.cost,
                            odometer_km=live_session.odometer,
                            note=f"EVCC Loadpoint: {live_session.loadpoint}",
                            cost_per_kwh=live_session.price_per_kwh,
                            cost_per_kwh_source="api" if live_session.price_per_kwh else "derived",
                            solar_percentage=live_session.solar_percentage,
                            pv_kwh=live_session.pv_kwh,
                            charge_type=None,
                            legacy_source="evcc",
                            legacy_table="live_api",
                            legacy_id=live_session.id,
                            imported_at=datetime.now(timezone.utc),
                            import_status="imported"
                        )
                        self.db.add(session)
                    
                    result["synced"] += 1
                    
                except Exception as e:
                    result["errors"].append(f"Session {live_session.source_id}: {e}")
            
            self.db.commit()

            # --- Lösch-Replikation: EVCC ist führend für Home-Sessions ---
            # Home-Sessions, die in EVCC gelöscht wurden, werden aus CTL
            # entfernt — ABER nur ohne Audit-Referenzen (Allokationen,
            # Exporte, Overrides), damit die TM-Kostenexport-Historie
            # nicht verwaist. Gelöschte Sessions mit Referenzen bleiben
            # erhalten und werden im Ergebnis gemeldet.
            from app.models.tm_cost_export import SessionCostAllocation, TMCostExport
            from app.models.matching_override import MatchingOverride

            kept_by_ref = []
            deleted_n = 0
            home_rows = (
                self.db.query(SessionModel)
                .filter(SessionModel.source_type == "home")
                .all()
            )
            for row in home_rows:
                if row.source_id in live_source_ids:
                    continue  # existiert weiter in EVCC
                # Nur wirklich exportierte Eintraege (status='exported')
                # blockieren die Loeschung — sie wurden nach TeslaMate
                # geschrieben und ihre Historie muss erhalten bleiben.
                # Alles andere (Allokationen, draft/approved, Overrides)
                # ist jederzeit neu berechenbar -> kaskadierend mitloeschen.
                exported_n = (
                    self.db.query(TMCostExport)
                    .filter_by(evcc_session_id=row.id, status="exported")
                    .count()
                )
                if exported_n:
                    kept_by_ref.append(f"#{row.id} ({exported_n} bereits in TeslaMate exportierte Eintraege)")
                    continue
                alloc_n = (
                    self.db.query(SessionCostAllocation)
                    .filter_by(evcc_session_id=row.id)
                    .delete()
                )
                exp_n = (
                    self.db.query(TMCostExport)
                    .filter_by(evcc_session_id=row.id)
                    .delete()
                )
                ov_n = (
                    self.db.query(MatchingOverride)
                    .filter_by(evcc_session_id=row.id)
                    .delete()
                )
                self.db.delete(row)
                deleted_n += 1
            self.db.commit()
            if deleted_n:
                result["deleted"] = deleted_n
            if kept_by_ref:
                result["kept"] = len(kept_by_ref)
                result["kept_details"] = kept_by_ref

        except Exception as e:
            self.db.rollback()
            result["errors"].append(f"EVCC Sync failed: {e}")
        
        return result
    
    async def _sync_teslamateapi(self, config: DataSourceConfig) -> dict:
        """Sync TeslaMateAPI charges to database.
        
        Rule: EVCC is leading for home charging. If EVCC is configured,
        skip TM charges at home location (Zuhause/Garage) to avoid duplicates.
        Only import TM charges at external locations (Supercharger, public AC, etc.).
        """
        result = {"synced": 0, "errors": []}
        
        # Check if EVCC is configured (leading for home charging)
        evcc_configured = bool(config.evcc_base_url)
        
        # Home location keywords (normalized)
        home_keywords = {"zuhause", "garage", "home", "haus"}
        
        def _is_home_location(location: Optional[str]) -> bool:
            if not location:
                return False
            normalized = location.strip().lower()
            return normalized in home_keywords
        
        try:
            client = await create_teslamateapi_client_from_config(config)
            if not client:
                result["errors"].append("TeslaMateAPI Client konnte nicht erstellt werden")
                return result
            
            live_charges = await client.get_charges()
            
            for live_charge in live_charges:
                try:
                    # Skip home location charges if EVCC is configured (EVCC leading)
                    if evcc_configured and _is_home_location(live_charge.location):
                        # Skip this charge - EVCC handles home charging
                        continue
                    
                    # Check if already exists (by source_id)
                    existing = self.db.query(SessionModel).filter(
                        and_(
                            SessionModel.source_type == "external",
                            SessionModel.source_id == live_charge.source_id
                        )
                    ).first()
                    
                    # Map charge_type string to enum
                    # TM API does not provide charge_details (no fast_charger_info).
                    # Without these details, no reliable DC/AC classification is possible.
                    charge_type_enum = ChargeType.UNKNOWN

                    if existing:
                        # Update existing
                        existing.location = live_charge.location
                        existing.energy_kwh = live_charge.charge_energy_added
                        existing.cost_eur = live_charge.cost
                        existing.date = live_charge.start_date
                        existing.odometer_km = live_charge.odometer
                        existing.cost_per_kwh = (live_charge.cost / live_charge.charge_energy_added) if live_charge.cost and live_charge.charge_energy_added else None
                        existing.cost_per_kwh_source = "derived"
                        existing.charge_type = charge_type_enum
                        existing.fast_charger_brand = live_charge.fast_charger_brand
                        existing.max_charge_power_kw = live_charge.max_charge_power_kw
                        # NEW: Store TM detail fields for loss calculation
                        existing.charge_energy_added = live_charge.charge_energy_added
                        existing.charge_energy_used = live_charge.charge_energy_used
                        existing.duration_min = live_charge.duration_min
                        existing.updated_at = datetime.now(timezone.utc)
                    else:
                        # Create new
                        session = SessionModel(
                            source_id=live_charge.source_id,
                            source_type="external",
                            date=live_charge.start_date,
                            location=live_charge.location,
                            energy_kwh=live_charge.charge_energy_added,
                            cost_eur=live_charge.cost,
                            odometer_km=live_charge.odometer,
                            cost_per_kwh=(live_charge.cost / live_charge.charge_energy_added) if live_charge.cost and live_charge.charge_energy_added else None,
                            cost_per_kwh_source="derived",
                            charge_type=charge_type_enum,
                            fast_charger_brand=live_charge.fast_charger_brand,
                            max_charge_power_kw=live_charge.max_charge_power_kw,
                            # NEW: Store TM detail fields for loss calculation
                            charge_energy_added=live_charge.charge_energy_added,
                            charge_energy_used=live_charge.charge_energy_used,
                            duration_min=live_charge.duration_min,
                            legacy_source="teslamate",
                            legacy_table="live_api",
                            legacy_id=live_charge.id,
                            imported_at=datetime.now(timezone.utc),
                            import_status="imported"
                        )
                        self.db.add(session)
                    
                    result["synced"] += 1
                    
                except Exception as e:
                    result["errors"].append(f"Charge {live_charge.source_id}: {e}")
            
            self.db.commit()
            
        except Exception as e:
            self.db.rollback()
            result["errors"].append(f"TM Sync failed: {e}")
        
        return result


async def run_full_sync(db: Session) -> dict:
    """Run full sync of all configured data sources."""
    service = SyncService(db)
    return await service.sync_all()