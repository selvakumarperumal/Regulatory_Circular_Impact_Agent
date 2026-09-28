"""Postgres advisory locks: how several workers share the work without doing anything
twice. Run as many workers as you like; these locks keep them out of each other's way.

- "library"         embedding policies and the catch-up: one worker at a time, the
                    others skip it
- "circular/<id>"   processing one circular: the worker holding it owns that circular
- "ocr"             reading a PDF on the GPU, which serves one page at a time

Each name becomes a key with common.db.lock_key, which includes the Postgres schema, so
copies of the app in separate schemas or databases never block each other. Each lock is
held on its own connection for the length of a with-block, so if a worker dies, its
connection closes and Postgres releases the lock by itself."""

from collections.abc import Iterator
from contextlib import contextmanager, suppress

from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from common.db import lock_key

LIBRARY, CIRCULAR, OCR = "library", "circular", "ocr"


@contextmanager
def held(
    engine: Engine, name: str, item: int | None = None, wait: bool = False
) -> Iterator[bool]:
    """Yield whether the lock `name` (or `name/item`) is held for the block: at once
    if it's free, or, with wait, as soon as it's free."""
    take = "pg_advisory_lock" if wait else "pg_try_advisory_lock"
    with engine.connect() as conn:
        lock = {"key": lock_key(conn, name if item is None else f"{name}/{item}")}
        mine = conn.execute(text(f"SELECT {take}(:key)"), lock).scalar()
        mine = wait or bool(mine)
        conn.commit()
        try:
            yield mine
        finally:
            if mine:
                with suppress(DBAPIError):
                    conn.execute(text("SELECT pg_advisory_unlock(:key)"), lock)
