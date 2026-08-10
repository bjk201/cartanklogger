"""
TeslaMateAPI Client
===================

Fetches live charging sessions and drives from TeslaMateAPI.
Uses the correct endpoint structure:
- GET /api/v1/cars to get car_id
- GET /api/v1/cars/{car_id}/charges to get charges
- GET /api/v1/cars/{car_id}/drives to get drives
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
    charge_type: Optional[str] = None  # 'DC', 'AC', 'unknown'
    fast_charger_brand: Optional[str] = None
    max_charge_power_kw: Optional[float] = None


@dataclass
class TeslaMateAPIDrive:
    """Live TeslaMate drive from API."""
    id: int
    source_id: str
    start_date: datetime
    end_date: Optional[datetime]
    start_address: str
    end_address: str
    odometer_start: Optional[float]
    odometer_end: Optional[float]
    odometer_distance: Optional[float]  # km driven
    duration_min: Optional[int]
    energy_consumed_net: Optional[float]  # kWh consumed
    consumption_net: Optional[float]  # Wh/km
    outside_temp_avg: Optional[float]
    inside_temp_avg: Optional[float]


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

        TeslaMateAPI endpoint: GET /cars/{car_id}/charges?page={n}&limit=100
        Fetches all pages to get complete charge history.
        """
        try:
            # Step 1: Get cars to determine car_id
            cars = await self.get_cars()
            if not cars:
                return []

            # Use first car (or could filter by VIN if multi-car setup)
            car_id = cars[0].car_id

            # Step 2: Fetch charges for this car - iterate all pages
            all_charges = []
            page = 1
            limit = 100

            while True:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.get(
                        f"{self.base_url}cars/{car_id}/charges",
                        params={"page": page, "per_page": limit},
                        headers=self._headers
                    )
                    response.raise_for_status()
                    data = response.json()

                    charges = data.get("data", {}).get("charges", [])
                    if not charges:
                        break

                    for item in charges:
                        # Parse TeslaMateAPI charge format
                        start_date = self._parse_datetime(item.get("start_date"))
                        end_date = self._parse_datetime(item.get("end_date"))

                        # Determine charge type from available TM data.
                        # TM API /cars/{car_id}/charges does NOT provide
                        # charge_details (no fast_charger_info, no charger_power).
                        # Without these details, no reliable DC/AC classification
                        # is possible — classify as unknown per requirement.
                        charge_type = "unknown"
                        fast_charger_brand = None
                        max_charge_power_kw = None

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
                            vehicle=None,  # Could add car name from cars list
                            charge_type=charge_type,
                            fast_charger_brand=fast_charger_brand,
                            max_charge_power_kw=max_charge_power_kw
                        )
                        all_charges.append(charge)

                    # Check if there are more pages
                    if len(charges) < limit:
                        break
                    page += 1

            return all_charges

        except Exception as e:
            raise Exception(f"TeslaMateAPI charges error: {e}")

    async def get_drives(self) -> List[TeslaMateAPIDrive]:
        """Fetch driving sessions from TeslaMateAPI.

        TeslaMateAPI endpoint: GET /cars/{car_id}/drives?page={n}&limit=100
        Fetches all pages to get complete drive history.
        """
        try:
            # Step 1: Get cars to determine car_id
            cars = await self.get_cars()
            if not cars:
                return []

            # Use first car (or could filter by VIN if multi-car setup)
            car_id = cars[0].car_id

            # Step 2: Fetch drives for this car - iterate all pages
            all_drives = []
            page = 1
            limit = 100

            while True:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.get(
                        f"{self.base_url}cars/{car_id}/drives",
                        params={"page": page, "per_page": limit},
                        headers=self._headers
                    )
                    response.raise_for_status()
                    data = response.json()

                    drives = data.get("data", {}).get("drives", [])
                    if not drives:
                        break

                    for item in drives:
                        # Parse TeslaMateAPI drive format
                        start_date = self._parse_datetime(item.get("start_date"))
                        end_date = self._parse_datetime(item.get("end_date"))

                        odometer_details = item.get("odometer_details", {})
                        odometer_start = odometer_details.get("odometer_start")
                        odometer_end = odometer_details.get("odometer_end")
                        odometer_distance = odometer_details.get("odometer_distance")

                        drive = TeslaMateAPIDrive(
                            id=item.get("drive_id", 0),
                            source_id=str(item.get("drive_id", "")),
                            start_date=start_date or datetime.now(),
                            end_date=end_date,
                            start_address=item.get("start_address", ""),
                            end_address=item.get("end_address", ""),
                            odometer_start=odometer_start,
                            odometer_end=odometer_end,
                            odometer_distance=odometer_distance,
                            duration_min=item.get("duration_min"),
                            energy_consumed_net=item.get("energy_consumed_net"),
                            consumption_net=item.get("consumption_net"),
                            outside_temp_avg=item.get("outside_temp_avg"),
                            inside_temp_avg=item.get("inside_temp_avg")
                        )
                        all_drives.append(drive)

                    # Check if there are more pages
                    if len(drives) < limit:
                        break
                    page += 1

            return all_drives

        except Exception as e:
            raise Exception(f"TeslaMateAPI drives error: {e}")

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

    def _filter_tm_by_date_range(self, items, days: Optional[int] = None, from_date: Optional[str] = None, to_date: Optional[str] = None):
        """Filter TeslaMate items by date range (in-memory filter)."""
        from datetime import datetime, timedelta, timezone
        
        if not items:
            return items
        
        if from_date and to_date:
            from_dt = datetime.fromisoformat(from_date)
            to_dt = datetime.fromisoformat(to_date + ' 23:59:59')
            return [item for item in items if item.start_date and from_dt <= item.start_date <= to_dt]
        elif from_date and not to_date:
            from_dt = datetime.fromisoformat(from_date)
            return [item for item in items if item.start_date and item.start_date >= from_dt]
        elif days is not None:
            cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
            return [item for item in items if item.start_date and item.start_date >= cutoff_date]
        
        return items


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