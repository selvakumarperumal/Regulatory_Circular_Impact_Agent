"""The database session each request gets, the task queue, and small helpers the
routes share."""

from typing import Annotated

from fastapi import Depends, HTTPException
from sqlmodel import Session

from common import queue
from common.db import make_engine
from config import settings

engine = make_engine(settings.DATABASE_URL)
tasks = queue.connect(settings.REDIS_URL)


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def get_or_404[T](session: Session, model: type[T], id: int) -> T:
    obj = session.get(model, id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} {id} not found")
    return obj


def owned_or_404[T](session: Session, model: type[T], id: int, company_id: int) -> T:
    """Like get_or_404, for rows that belong to a company: another company's row is
    reported as not found, never as forbidden, so ids reveal nothing."""
    obj = session.get(model, id)
    if obj is None or obj.company_id != company_id:
        raise HTTPException(404, f"{model.__name__} {id} not found")
    return obj


def save[T](session: Session, obj: T) -> T:
    """Add, commit and reload, so the returned object has its id and defaults."""
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return obj


def enqueue(kind: str, **ids: int) -> None:
    """Queue a task for the workers, after the change it's about is committed."""
    queue.enqueue(tasks, kind, **ids)
