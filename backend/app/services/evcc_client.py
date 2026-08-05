"""
EVCC API Client
===============

Fetches live charging sessions from EVCC API.
"""

import httpx
from typing import Optional, List, Dict, Any
from datetime import datetime
from dataclasses import dataclass
from app.config import settings


@dataclass
class EVCCLiveSession:
    """Live EVCC session from API."""
    id: int
    source_id: str
    created: datetime
    finished: Optional[datetime]
    location: str
    charged_energy: float
    cost: float
    price_per_kwh: Optional[float]
    vehicle: Optional[str]
    soc_start: Optional[float]
    soc_end: Optional[float]
    loadpoint: str
    odometer: Optional[float]
    # PV/Solar data (if available from EVCC API)
    solar_percentage: Optional[float] = None
    pv_kwh: Optional[float] = None


class EVCCClient:
    """Client for EVCC API."""

    def __init__(self, base_url: str, api_token: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.api_token = api_token
        self._headers = {}
        if api_token:
            self._headers["Authorization"] = f"Bearer {api_token}"

    async def is_reachable(self) -> bool:
        """Check if EVCC API is reachable."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/api/state", headers=self._headers)
                return response.status_code == 200
        except Exception:
            return False

    async def get_sessions(self, limit: Optional[int] = None) -> List[EVCCLiveSession]:
        """Fetch charging sessions from EVCC API.

        EVCC API endpoint: GET /api/sessions
        """
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # EVCC uses /api/sessions for charging sessions
                response = await client.get(f"{self.base_url}/api/sessions", headers=self._headers)
                response.raise_for_status()
                data = response.json()

                sessions = []
                for item in data:
                    # Parse EVCC session format
                    created = self._parse_datetime(item.get("created"))
                    finished = self._parse_datetime(item.get("finished"))

                    session = EVCCLiveSession(
                        id=item.get("id", 0),
                        source_id=str(item.get("id", "")),
                        created=created or datetime.now(),
                        finished=finished,
                        location=item.get("loadpoint", ""),
                        charged_energy=item.get("chargedEnergy", 0),  # Already in kWh
                        cost=item.get("price", 0),
                        price_per_kwh=item.get("pricePerKwh"),
                        vehicle=item.get("vehicle"),
                        soc_start=item.get("socStart"),
                        soc_end=item.get("socEnd"),
                        loadpoint=item.get("loadpoint", ""),
                        odometer=item.get("odometer"),
                        # PV/Solar data - EVCC API may provide these
                        solar_percentage=item.get("solarPercentage") or item.get("solar_percentage"),
                        pv_kwh=item.get("pvEnergy") or item.get("pv_energy") or item.get("pvKwh")
                    )
                    sessions.append(session)

                # Sort by created desc (newest first)
                sessions.sort(key=lambda s: s.created, reverse=True)

                if limit:
                    sessions = sessions[:limit]

                return sessions

        except Exception as e:
            raise Exception(f"EVCC API error: {e}")

    def _parse_datetime(self, dt_str: Optional[str]) -> Optional[datetime]:
        """Parse ISO datetime string."""
        if not dt_str:
            return None
        try:
            # Handle Z suffix
            dt_str = dt_str.replace('Z', '+00:00')
            return datetime.fromisoformat(dt_str)
        except ValueError:
            try:
                return datetime.strptime(dt_str[:19], "%Y-%m-%dT%H:%M:%S")
            except ValueError:
                return None


async def create_evcc_client_from_config(config) -> Optional[EVCCClient]:
    """Create EVCC client from database config."""
    if not config or not config.evcc_base_url:
        return None

    return EVCCClient(
        base_url=config.evcc_base_url,
        api_token=config.evcc_api_token or None
    )