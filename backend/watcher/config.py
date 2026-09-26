"""Watcher settings, read from the environment or a .env file beside main.py.
Nothing else in the watcher reads os.environ."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # env_ignore_empty: a variable set to "" (as docker-compose passes unset ones) keeps the default
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)

    DATABASE_URL: str = "postgresql+psycopg://rci:rci@localhost:5432/rci"

    # S3 holding the PDFs. Empty endpoint and keys = real AWS with the usual credential chain;
    # for Floci (local S3) set S3_ENDPOINT_URL=http://localhost:4566 and the keys to "test".
    S3_ENDPOINT_URL: str = ""
    S3_BUCKET: str = "rci"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_DEFAULT_REGION: str = "us-east-1"

    # How often to check the regulator sites. 0 = check once and exit.
    INTERVAL_MINUTES: int = 0


settings = Settings()
