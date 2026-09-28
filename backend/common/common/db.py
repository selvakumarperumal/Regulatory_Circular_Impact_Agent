"""Engine, schema creation and upgrades, and advisory-lock keys. Each service passes in
its own DATABASE_URL."""

import hashlib

from sqlalchemy import Connection, Engine, inspect, text
from sqlmodel import SQLModel, create_engine

from common import models

__all__ = ["init_db", "lock_key", "make_engine", "models"]


def make_engine(url: str) -> Engine:
    """pool_pre_ping replaces connections Postgres closed while the service was idle."""
    return create_engine(url, pool_pre_ping=True)


def lock_key(conn: Connection, name: str) -> int:
    """The advisory-lock key for `name` in this connection's schema.

    Postgres keeps advisory locks per database but not per schema, and any program can
    take any number. So the key is a 64-bit hash of the app, the schema and the name:
    copies of the app in separate schemas of one database never share a lock, and
    neither does other software using advisory locks. The hash is blake2b, not hash(),
    whose seed changes per process: every worker must derive the same key from the
    same name."""
    schema = conn.execute(text("SELECT current_schema()")).scalar()
    digest = hashlib.blake2b(f"rci/{schema}/{name}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


def init_db(engine: Engine) -> None:
    """Create any missing tables and columns, and upgrade a database from before
    companies. Every service calls this at startup; the advisory lock stops two
    services that start together from both changing the schema."""
    with engine.begin() as conn:
        key = lock_key(conn, "schema")
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
        SQLModel.metadata.create_all(conn)
        add_missing_columns(conn)
        move_single_company(conn)
        per_company_codes(conn)


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


def move_single_company(conn: Connection) -> None:
    """Before companies, the app served one company, described in a one-row table
    `company`. That company becomes company 1 and keeps everything: its policies, its
    gaps, and its "does it apply?" answers, which move from the circulars to
    assessments. Runs once: only while `companies` is empty."""
    existing = inspect(conn)
    if not existing.has_table("company"):
        return
    if conn.execute(text("SELECT count(*) FROM companies")).scalar():
        return
    old = conn.execute(text("SELECT profile, updated_at FROM company")).first()
    conn.execute(
        text(
            "INSERT INTO companies (id, name, profile, created_at, updated_at) "
            "VALUES (1, 'My company', :profile, now(), coalesce(:updated, now()))"
        ),
        {
            "profile": old.profile if old else "",
            "updated": old.updated_at if old else None,
        },
    )
    conn.execute(text("SELECT setval(pg_get_serial_sequence('companies', 'id'), 1)"))
    conn.execute(text("UPDATE policies SET company_id = 1 WHERE company_id IS NULL"))
    conn.execute(text("UPDATE gaps SET company_id = 1 WHERE company_id IS NULL"))
    if "applicable" in {c["name"] for c in existing.get_columns("circulars")}:
        conn.execute(
            text(
                "INSERT INTO assessments (company_id, circular_id, status, "
                "applicable, applies_reason, updated_at) "
                "SELECT 1, id, 'done', applicable, applies_reason, now() "
                "FROM circulars WHERE status = 'analyzed' ON CONFLICT DO NOTHING"
            )
        )
    conn.execute(text("UPDATE circulars SET status = 'read' WHERE status = 'analyzed'"))


def per_company_codes(conn: Connection) -> None:
    """Policy codes used to be unique across the whole app, and control codes too.
    Now two companies may both have a POL-KYC: a policy code is unique within its
    company, and a control code within its policy."""
    for table, old, new, columns in (
        ("policies", "policies_code_key", "uq_policies_company_code", "company_id, code"),
        ("controls", "controls_code_key", "uq_controls_policy_code", "policy_id, code"),
    ):
        conn.execute(text(f'ALTER TABLE "{table}" DROP CONSTRAINT IF EXISTS {old}'))
        found = conn.execute(
            text(
                "SELECT 1 FROM pg_constraint "
                "WHERE conname = :name AND conrelid = CAST(:table AS regclass)"
            ),
            {"name": new, "table": table},
        ).first()
        if not found:
            conn.execute(
                text(f'ALTER TABLE "{table}" ADD CONSTRAINT {new} UNIQUE ({columns})')
            )
