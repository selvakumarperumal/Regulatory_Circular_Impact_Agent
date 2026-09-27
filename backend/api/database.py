"""The database session each request gets, and small helpers the routes share."""

from typing import Annotated

from fastapi import Depends, HTTPException
from sqlmodel import Session

from common.db import make_engine
from config import settings

engine = make_engine(settings.DATABASE_URL)


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def get_or_404[T](session: Session, model: type[T], id: int) -> T:
    obj = session.get(model, id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} {id} not found")
    return obj


def save[T](session: Session, obj: T) -> T:
    """Add, commit and reload, so the returned object has its id and defaults."""
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return obj
