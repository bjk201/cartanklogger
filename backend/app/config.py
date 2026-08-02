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
    
    # EVCC Configuration
    EVCC_HOST: str = ""
    EVCC_PORT: int = 7070
    EVCC_PASSWORD: str = ""
    EVCC_API_TOKEN: str = ""
    EVCC_USE_TLS: bool = False
    
    @property
    def EVCC_BASE_URL(self) -> str:
        if not self.EVCC_HOST:
            return ""
        protocol = "https" if self.EVCC_USE_TLS else "http"
        return f"{protocol}://{self.EVCC_HOST}:{self.EVCC_PORT}"
    
    @property
    def EVCC_CONFIGURED(self) -> bool:
        return bool(self.EVCC_HOST)
    
    # TeslaMate Configuration
    TESLAMATE_URL: str = ""
    TESLAMATE_API_TOKEN: str = ""
    
    @property
    def TESLAMATE_CONFIGURED(self) -> bool:
        return bool(self.TESLAMATE_URL)
    
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
    
    class Config:
        env_file = "/app/config.yaml" if os.path.exists("/app/config.yaml") else None
        env_file_encoding = "utf-8"
        case_sensitive = True
        extra = "ignore"


settings = Settings()