"""Worker settings, read from the environment or a .env file beside main.py. Nothing
else in the worker reads os.environ.

A variable set to "" keeps its default, since docker compose passes unset ones that way.
Empty S3 endpoint and keys mean real AWS with the usual credential chain; for Floci
(local S3) set S3_ENDPOINT_URL=http://localhost:4566 and both keys to "test".

GEMINI_API_KEY is the only required setting. OCR_MAX_PAGES caps the pages read per
PDF (long master circulars state their changes up front), LLM_MAX_CHARS the circular
text sent for the summary, MATCH_TOP_K the closest policies Gemini checks per
circular, and LOOKBACK_DAYS how old a new circular can be before it's skipped."""

from pydantic import Field, field_validator
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

    OCR_URL: str = "http://localhost:8001/v1"
    OCR_MAX_PAGES: int = 20

    GEMINI_API_KEY: str = Field(default="", validate_default=True)
    GEMINI_MODEL_NAME: str = "gemini-3.5-flash"
    GEMINI_EMBEDDING_MODEL_NAME: str = "gemini-embedding-001"
    LLM_MAX_CHARS: int = 100_000

    MATCH_TOP_K: int = 3
    LOOKBACK_DAYS: int = 30
    POLL_SECONDS: int = 60

    @field_validator("GEMINI_API_KEY")
    @classmethod
    def key_is_set(cls, value: str) -> str:
        if not value.strip():
            raise ValueError(
                "GEMINI_API_KEY is empty. Create a key at "
                "https://ai.google.dev/gemini-api and put it in the .env file"
            )
        return value.strip()


settings = Settings()
