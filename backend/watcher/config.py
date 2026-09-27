"""Watcher settings, read from the environment or a .env file beside main.py. Nothing
else in the watcher reads os.environ.

A variable set to "" keeps its default, since docker compose passes unset ones that
way. Empty S3 endpoint and keys mean real AWS with the usual credential chain; for
Floci (local S3) set S3_ENDPOINT_URL=http://localhost:4566 and both keys to "test".
INTERVAL_MINUTES is how often the regulator sites are checked; 0 checks once and
exits."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", env_ignore_empty=True
    )

    DATABASE_URL: str = "postgresql+psycopg://rci:rci@localhost:5432/rci"

    S3_ENDPOINT_URL: str = ""
    S3_BUCKET: str = "rci"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_DEFAULT_REGION: str = "us-east-1"

    INTERVAL_MINUTES: int = 0


settings = Settings()
