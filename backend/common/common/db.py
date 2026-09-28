"""The engine, and table creation."""

from sqlalchemy import Engine, inspect, text
from sqlmodel import SQLModel, create_engine

from common import models

__all__ = ["init_db", "make_engine", "models"]


def make_engine(url: str) -> Engine:
    return create_engine(url, pool_pre_ping=True)


def init_db(engine: Engine) -> None:
    """Create missing tables, and add columns that models gained since (nullable;
    nothing is dropped). Services starting together take turns (a transaction lock),
    so two never create the same table at once."""
    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('rci-schema'))"))
        SQLModel.metadata.create_all(conn)
        db = inspect(conn)
        for table in SQLModel.metadata.sorted_tables:
            have = {c["name"] for c in db.get_columns(table.name)}
            for column in table.columns:
                if column.name not in have:
                    kind = column.type.compile(dialect=conn.dialect)
                    add = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}"'
                    conn.execute(text(f"{add} {kind}"))
