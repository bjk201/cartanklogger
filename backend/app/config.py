from pydantic_settings import BaseSettings
from typing import Optional
import os


class Settings(BaseSettings):
    # App
    APP_NAME: str = "CarTankLogger 2.0"
    DEBUG: bool = False

    # Database
    DB_PATH: str = "/app/data/cartanklogger.db"

    @property
    def DATABASE_URL(self) -> str:
        return f"sqlite:///{self.DB_PATH}"

    # CORS
    ALLOWED_ORIGINS: str = "http://localhost:13131,http://127.0.0.1:13131"

    # API
    API_PREFIX: str = "/api"

    # EVCC Configuration - Full base URL
    EVCC_BASE_URL: str = ""

    @property
    def EVCC_CONFIGURED(self) -> bool:
        return bool(self.EVCC_BASE_URL)

    # TeslaMateAPI Configuration (via TeslaMateAPI service)
    TESLAMATEAPI_BASE_URL: str = ""

    @property
    def TESLAMATEAPI_CONFIGURED(self) -> bool:
        return bool(self.TESLAMATEAPI_BASE_URL)

    # App settings
    MOCK_MODE: bool = False
    AUTO_SYNC_MINUTES: int = 0
    CURRENCY: str = "EUR"
    VEHICLE_NAME: str = "Mein EV"
    HOME_ADDRESSES: list[str] = ["zuhause", "garage"]
    STORE_RAW_PAYLOADS: bool = False
    STORE_EXACT_LOCATIONS: bool = False
    STORE_ADDRESS_LABELS: bool = True

    # Pricing defaults
    GRID_PRICE_PER_KWH: float = 0.32
    FEEDIN_PRICE_PER_KWH: float = 0.08

    # Data source mode
    DATA_SOURCE: str = "demo"  # demo | live

    # TeslaMate Postgres (kontrollierter Kosten-Writeback, NIEMALS ans Frontend)
    TESLAMATE_DB_HOST: str = ""
    TESLAMATE_DB_PORT: int = 5432
    TESLAMATE_DB_NAME: str = "teslamate"
    TESLAMATE_DB_USER: str = "teslamate"
    TESLAMATE_DB_PASSWORD: str = ""

    class Config:
        env_file = "/app/config.yaml" if os.path.exists("/app/config.yaml") else None
        env_file_encoding = "utf-8"
        case_sensitive = True
        extra = "ignore"


settings = Settings()