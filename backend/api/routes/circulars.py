"""Circulars: found by the watcher, OCR'd and analysed by the worker."""
from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlmodel import col, select

from common.models import Circular, Gap
from database import SessionDep, get_or_404

router = APIRouter(prefix="/circulars", tags=["circulars"])


class CircularDetail(BaseModel):
    circular: Circular
    gaps: list[Gap]


@router.get("")
def list_circulars(session: SessionDep, source: str | None = None, status: str | None = None,
                   limit: int = Query(50, le=500)) -> list[Circular]:
    """Newest first. status: new / parsed / analyzed / failed / skipped."""
    q = select(Circular).order_by(col(Circular.published_at).desc().nulls_last()).limit(limit)
    if source:
        q = q.where(Circular.source == source.upper())
    if status:
        q = q.where(Circular.status == status)
    return session.exec(q).all()


@router.get("/{circular_id}")
def get_circular(circular_id: int, session: SessionDep) -> CircularDetail:
    c = get_or_404(session, Circular, circular_id)
    gaps = session.exec(select(Gap).where(Gap.circular_id == c.id)).all()
    return CircularDetail(circular=c, gaps=gaps)


@router.get("/{circular_id}/text", response_class=PlainTextResponse)
def get_circular_text(circular_id: int, session: SessionDep) -> str:
    """The OCR output of the PDF."""
    return get_or_404(session, Circular, circular_id).text or ""


@router.post("/{circular_id}/reprocess")
def reprocess_circular(circular_id: int, session: SessionDep) -> Circular:
    """Queue the circular again (e.g. after 'failed', or after adding policies).
    OCR is reused if it already ran; existing gaps are kept and not duplicated."""
    c = get_or_404(session, Circular, circular_id)
    c.status, c.error = ("parsed" if c.text else "new"), None
    session.commit()
    session.refresh(c)
    return c
