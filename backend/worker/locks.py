"""Postgres advisory locks: how several workers share the work without doing anything
twice. Run as many workers as you like; these locks keep them out of each other's way.

- (LIBRARY, 0)    embedding policies and the catch-up: one worker at a time, the others
                  skip it
- (CIRCULAR, id)  processing one circular: the worker holding it owns that circular
- (OCR, 0)        reading a PDF on the GPU, which serves one page at a time

Each lock is held on its own connection for the length of a with-block, so if a worker
dies, its connection closes and Postgres releases the lock by itself."""

from collections.abc import Iterator
from contextlib import contextmanager, suppress

from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

LIBRARY, CIRCULAR, OCR = 7310, 7311, 7312


@contextmanager
def held(
    engine: Engine, space: int, key: int = 0, wait: bool = False
) -> Iterator[bool]:
    """Yield whether the lock is held for the block: at once if it's free, or, with
    wait, as soon as it's free."""
    take = "pg_advisory_lock" if wait else "pg_try_advisory_lock"
    lock = {"space": space, "key": key}
    with engine.connect() as conn:
        mine = conn.execute(text(f"SELECT {take}(:space, :key)"), lock).scalar()
        mine = wait or bool(mine)
        conn.commit()
        try:
            yield mine
        finally:
            if mine:
                with suppress(DBAPIError):
                    conn.execute(text("SELECT pg_advisory_unlock(:space, :key)"), lock)
