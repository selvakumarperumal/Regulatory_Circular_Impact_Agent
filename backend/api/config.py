"""API settings, read from the environment or a .env file beside main.py. Nothing else
in the api reads os.environ.

A variable set to "" keeps its default, since docker compose passes unset ones that
way. CORS_ORIGINS lists the browser origins allowed to call the API, comma-separated
("*" = any). REDIS_URL is the Redis holding the workers' task stream.

JWT_SECRET signs login tokens; left empty, a random one is made on first start and
kept in the database, so sign-ins survive restarts. A token is valid for TOKEN_HOURS.
LOOKBACK_DAYS must match the worker's: a new company is judged against this many
days of circulars."""

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
