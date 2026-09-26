"""Engine and schema creation. Each service passes in its own DATABASE_URL."""
from sqlalchemy import Engine, text
from sqlmodel import SQLModel, create_engine

from common import models  # noqa: F401  (registers the tables on SQLModel.metadata)


def make_engine(url: str) -> Engine:
    # pre_ping replaces connections Postgres closed while the service was idle
    return create_engine(url, pool_pre_ping=True)


def init_db(engine: Engine) -> None:
    """Create any missing tables. Every service calls this at startup; the advisory lock
    stops two services that start together from both trying to create the same table."""
    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(1)"))
        SQLModel.metadata.create_all(conn)
