"""Worker settings, from the environment or .env beside main.py; empty values keep the
default. GEMINI_API_KEY is required (https://ai.google.dev/gemini-api). Empty S3
endpoint and keys mean real AWS.

LOOKBACK_DAYS: newer circulars are read, and new policies and companies are checked
against them. A task held CLAIM_IDLE_SECONDS by a silent worker is taken over; while a
service is down tasks wait RETRY_SECONDS; every RECONCILE_MINUTES one worker re-queues
work whose task went missing."""

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

    OCR_URL: str = "http://localhost:8001/v1"
    OCR_MAX_PAGES: int = 20

    GEMINI_API_KEY: str
    GEMINI_MODEL_NAME: str = "gemini-3.5-flash"
    GEMINI_EMBEDDING_MODEL_NAME: str = "gemini-embedding-001"
    LLM_MAX_CHARS: int = 100_000

    MATCH_TOP_K: int = 3
    LOOKBACK_DAYS: int = 30
    CLAIM_IDLE_SECONDS: int = 1800
    RETRY_SECONDS: int = 60
    RECONCILE_MINUTES: int = 15


settings = Settings()
