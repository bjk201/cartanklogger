"""
TeslaMateAPI Client
===================

Fetches live charging sessions from TeslaMateAPI.
"""

import httpx
from typing import Optional, List, Dict, Any
from datetime import datetime
from dataclasses import dataclass
from app.config import settings


@dataclass
class TeslaMateAPICharge:
    """Live TeslaMate charge from API."""
    id: int
    source_id: str
    start_date: datetime
    end_date: Optional[datetime]
    location: str
    charge_energy_added: float
    charge_energy_used: Optional[float]
    cost: Optional[float]
    odometer: Optional[float]
    soc_start: Optional[float]
    soc_end: Optional[float]
    vehicle: Optional[str]


class TeslaMateAPIClient:
    """Client for TeslaMateAPI."""

    def __init__(self, base_url: str, token: Optional[str] = None):
        # Normalize base URL - ensure it ends with /
        self.base_url = base_url.rstrip('/') + '/'
        self.token = token
        self._headers = {}
        if token:
            self._headers["Authorization"] = f"Bearer {token}"

    async def is_reachable(self) -> bool:
        """Check if TeslaMateAPI is reachable - also verify charges endpoint works."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                # Check base URL
                response = await client.get(self.base_url, headers=self._headers)
                if response.status_code != 200:
                    return False
                # Also verify the charges endpoint exists
                response = await client.get(f"{self.base_url}charges", headers=self._headers)
                return response.status_code == 200
        except Exception:
            return False

    async def get_charges(self) -> List[TeslaMateAPICharge]:
        """Fetch charging sessions from TeslaMateAPI.

        TeslaMateAPI endpoint: GET /charges (relative to base URL)
        """
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Use relative path - base_url already includes /api/v1/
                response = await client.get(f"{self.base_url}charges", headers=self._headers)
                response.raise_for_status()
                data = response.json()

                charges = []
                for item in data:
                    # Parse TeslaMateAPI charge format
                    start_date = self._parse_datetime(item.get("start_date"))
                    end_date = self._parse_datetime(item.get("end_date"))

                    charge = TeslaMateAPICharge(
                        id=item.get("id", 0),
                        source_id=str(item.get("id", "")),
                        start_date=start_date or datetime.now(),
                        end_date=end_date,
                        location=item.get("location", ""),
                        charge_energy_added=item.get("charge_energy_added", 0) / 1000.0,  # Wh to kWh
                        charge_energy_used=item.get("charge_energy_used"),
                        cost=item.get("cost"),
                        odometer=item.get("odometer"),
                        soc_start=item.get("soc_start"),
                        soc_end=item.get("soc_end"),
                        vehicle=item.get("vehicle")
                    )
                    charges.append(charge)

                return charges

        except Exception as e:
            raise Exception(f"TeslaMateAPI error: {e}")

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


async def create_teslamateapi_client_from_config(config) -> Optional[TeslaMateAPIClient]:
    """Create TeslaMateAPI client from database config."""
    if not config or not config.teslamateapi_base_url:
        return None
    
    base_url = config.teslamateapi_base_url
    if not base_url.endswith('/'):
        base_url = base_url + '/'
    
    return TeslaMateAPIClient(
        base_url=base_url,
        token=config.teslamateapi_token or None
    )