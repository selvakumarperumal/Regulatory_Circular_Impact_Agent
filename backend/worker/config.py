"""Worker settings, read from the environment or a .env file beside main.py.
Nothing else in the worker reads os.environ."""
from pydantic import Field, field_validator
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

    # Unlimited-OCR (the ocr service). Long master circulars carry their changes up front.
    OCR_URL: str = "http://localhost:8001/v1"
    OCR_MAX_PAGES: int = 20

    # Gemini: summaries, the impact check (GEMINI_MODEL_NAME) and policy matching (embeddings)
    GEMINI_API_KEY: str = Field(default="", validate_default=True)   # required, see below
    GEMINI_MODEL_NAME: str = "gemini-3.5-flash"
    GEMINI_EMBEDDING_MODEL_NAME: str = "gemini-embedding-001"
    LLM_MAX_CHARS: int = 100_000             # circular text sent for the summary

    MATCH_TOP_K: int = 3                     # closest policies Gemini checks per circular
    LOOKBACK_DAYS: int = 30                  # older circulars are marked 'skipped'
    POLL_SECONDS: int = 60                   # wait between rounds

    @field_validator("GEMINI_API_KEY")
    @classmethod
    def _key_is_set(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("GEMINI_API_KEY is empty. Create a key at https://ai.google.dev/gemini-api "
                             "and put it in the .env file")
        return value.strip()


settings = Settings()
