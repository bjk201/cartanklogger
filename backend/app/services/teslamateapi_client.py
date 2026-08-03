"""
TeslaMateAPI Client
===================

Fetches live charging sessions from TeslaMateAPI.
Uses the correct endpoint structure:
- GET /api/v1/cars to get car_id
- GET /api/v1/cars/{car_id}/charges to get charges
"""

import httpx
from typing import Optional, List, Dict, Any
from datetime import datetime
from dataclasses import dataclass
from app.config import settings


@dataclass
class TeslaMateAPICar:
    """TeslaMateAPI car info."""
    car_id: int
    name: str
    vin: Optional[str] = None
    model: Optional[str] = None


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
        """Check if TeslaMateAPI base URL is reachable (does not check data endpoints)."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(self.base_url, headers=self._headers)
                return response.status_code == 200
        except Exception:
            return False

    async def get_cars(self) -> List[TeslaMateAPICar]:
        """Fetch cars from TeslaMateAPI.

        TeslaMateAPI endpoint: GET /cars (relative to base URL, e.g. /api/v1/cars)
        Returns list of cars with car_id.
        """
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{self.base_url}cars", headers=self._headers)
                response.raise_for_status()
                data = response.json()

                cars = []
                for item in data.get("data", {}).get("cars", []):
                    car = TeslaMateAPICar(
                        car_id=item.get("car_id", 0),
                        name=item.get("name", ""),
                        vin=item.get("car_details", {}).get("vin"),
                        model=item.get("car_details", {}).get("model"),
                    )
                    cars.append(car)

                return cars

        except Exception as e:
            raise Exception(f"TeslaMateAPI cars error: {e}")

    async def get_charges(self) -> List[TeslaMateAPICharge]:
        """Fetch charging sessions from TeslaMateAPI.

        TeslaMateAPI endpoint: GET /cars/{car_id}/charges
        First fetches cars to determine car_id, then fetches charges for that car.
        """
        try:
            # Step 1: Get cars to determine car_id
            cars = await self.get_cars()
            if not cars:
                return []

            # Use first car (or could filter by VIN if multi-car setup)
            car_id = cars[0].car_id

            # Step 2: Fetch charges for this car
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(f"{self.base_url}cars/{car_id}/charges", headers=self._headers)
                response.raise_for_status()
                data = response.json()

                charges = []
                for item in data.get("data", {}).get("charges", []):
                    # Parse TeslaMateAPI charge format
                    start_date = self._parse_datetime(item.get("start_date"))
                    end_date = self._parse_datetime(item.get("end_date"))

                    charge = TeslaMateAPICharge(
                        id=item.get("charge_id", 0),
                        source_id=str(item.get("charge_id", "")),
                        start_date=start_date or datetime.now(),
                        end_date=end_date,
                        location=item.get("address", ""),
                        charge_energy_added=item.get("charge_energy_added", 0),  # Already in kWh
                        charge_energy_used=item.get("charge_energy_used"),
                        cost=item.get("cost"),
                        odometer=item.get("odometer"),
                        soc_start=item.get("battery_details", {}).get("start_battery_level"),
                        soc_end=item.get("battery_details", {}).get("end_battery_level"),
                        vehicle=None  # Could add car name from cars list
                    )
                    charges.append(charge)

                return charges

        except Exception as e:
            raise Exception(f"TeslaMateAPI charges error: {e}")

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