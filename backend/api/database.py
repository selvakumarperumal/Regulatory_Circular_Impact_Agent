"""Each request's database session, the task queue, and helpers the routes share."""

from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.exc import IntegrityError
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


def get_or_404[T](session: Session, model: type[T], id: int, company_id=None) -> T:
    """The row, or 404. Given a company, another company's row is a 404 too."""
    obj = session.get(model, id)
    if obj is None or (company_id is not None and obj.company_id != company_id):
        raise HTTPException(404, f"{model.__name__} {id} not found")
    return obj


def save[T](session: Session, obj: T, taken: str = "it already exists") -> T:
    """Add, commit and reload. A clash with a unique constraint is a 409 `taken`."""
    session.add(obj)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, taken) from None
    session.refresh(obj)
    return obj


def enqueue(kind: str, **ids: int) -> None:
    """Queue a task for the workers, after the change it's about is committed."""
    queue.enqueue(tasks, kind, **ids)
