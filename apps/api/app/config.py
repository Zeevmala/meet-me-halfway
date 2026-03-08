from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/meetmehalfway"
    FIREBASE_CREDENTIALS_JSON: str = ""
    GOOGLE_PLACES_KEY: str = ""
    MAPBOX_TOKEN: str = ""
    WHATSAPP_TOKEN: str = ""
    WHATSAPP_PHONE_NUMBER_ID: str = ""
    WHATSAPP_APP_SECRET: str = ""
    APP_DOMAIN: str = "https://meetmehalfway.app"
    SESSION_TTL_HOURS: int = 4
    LOG_FORMAT: str = "json"
    CORS_ORIGINS: str = "*"
    SESSION_LINK_SECRET: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
