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
    
    class Config:
        env_file = "/app/config.yaml" if os.path.exists("/app/config.yaml") else None
        env_file_encoding = "utf-8"
        case_sensitive = True
        extra = "ignore"


settings = Settings()