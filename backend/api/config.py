"""API settings, read from the environment or a .env file beside main.py. Nothing else
in the api reads os.environ.

A variable set to "" keeps its default, since docker compose passes unset ones that
way. CORS_ORIGINS lists the browser origins allowed to call the API, comma-separated
("*" = any)."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", env_ignore_empty=True
    )

    DATABASE_URL: str = "postgresql+psycopg://rci:rci@localhost:5432/rci"
    CORS_ORIGINS: str = "*"


settings = Settings()
