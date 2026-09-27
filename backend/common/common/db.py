"""Engine and schema creation. Each service passes in its own DATABASE_URL."""

from sqlalchemy import Connection, Engine, inspect, text
from sqlmodel import SQLModel, create_engine

from common import models

__all__ = ["init_db", "make_engine", "models"]


def make_engine(url: str) -> Engine:
    """pool_pre_ping replaces connections Postgres closed while the service was idle."""
    return create_engine(url, pool_pre_ping=True)


def init_db(engine: Engine) -> None:
    """Create any missing tables and columns. Every service calls this at startup;
    the advisory lock stops two services that start together from both changing the
    schema."""
    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(1)"))
        SQLModel.metadata.create_all(conn)
        add_missing_columns(conn)


def add_missing_columns(conn: Connection) -> None:
    """create_all makes new tables but never changes existing ones, so a column added
    to a model later (always nullable) is added here. Nothing is ever dropped or
    altered."""
    existing = inspect(conn)
    for table in SQLModel.metadata.sorted_tables:
        have = {c["name"] for c in existing.get_columns(table.name)}
        for column in table.columns:
            if column.name not in have:
                kind = column.type.compile(dialect=conn.dialect)
                add = f'ALTER TABLE "{table.name}" ADD COLUMN IF NOT EXISTS'
                conn.execute(text(f'{add} "{column.name}" {kind}'))
