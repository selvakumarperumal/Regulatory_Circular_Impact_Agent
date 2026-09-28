"""Watcher settings, from the environment or .env beside main.py; empty values keep
the default. Empty S3 endpoint and keys mean real AWS. INTERVAL_MINUTES: how often the
regulator sites are checked; 0 checks once and exits."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", env_ignore_empty=True
    )

    DATABASE_URL: str = "postgresql+psycopg://rci:rci@localhost:5432/rci"
    REDIS_URL: str = "redis://localhost:6379/0"

    S3_ENDPOINT_URL: str = ""
    S3_BUCKET: str = "rci"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_DEFAULT_REGION: str = "us-east-1"

    INTERVAL_MINUTES: int = 0


settings = Settings()
