"""API settings, read from the environment or a .env file beside main.py.
Nothing else in the api reads os.environ."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # env_ignore_empty: a variable set to "" (as docker-compose passes unset ones) keeps the default
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)

    DATABASE_URL: str = "postgresql+psycopg://rci:rci@localhost:5432/rci"
    # Browser origins allowed to call the API, comma-separated ("*" = any)
    CORS_ORIGINS: str = "*"


settings = Settings()
