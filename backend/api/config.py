"""API settings, from the environment or .env beside main.py; empty values keep the
default. JWT_SECRET signs login tokens (empty: a key made on first start, kept in
Postgres); a login lasts TOKEN_HOURS. LOOKBACK_DAYS must match the worker's."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", env_ignore_empty=True
    )

    DATABASE_URL: str = "postgresql+psycopg://rci:rci@localhost:5432/rci"
    REDIS_URL: str = "redis://localhost:6379/0"
    CORS_ORIGINS: str = "*"

    JWT_SECRET: str = ""
    TOKEN_HOURS: int = 12
    LOOKBACK_DAYS: int = 30


settings = Settings()
