"""Circulars: found by the watcher, OCR'd and analysed by the worker."""
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.orm import defer
from sqlmodel import col, select

from common.models import Circular, Gap, Policy, PolicyCheck
from database import SessionDep, get_or_404

router = APIRouter(prefix="/circulars", tags=["circulars"])

# never sent to the console, so never read from the database here (the OCR text can be 100 kB)
HEAVY = (defer(Circular.text), defer(Circular.embedding))


class Checked(BaseModel):
    """One policy the circular was checked against, and Gemini's verdict."""
    policy_id: int
    code: str
    title: str
    version: int
    similarity: float
    impacted: bool
    checked_at: datetime


class CircularDetail(BaseModel):
    circular: Circular
    gaps: list[Gap]
    checks: list[Checked]


@router.get("")
def list_circulars(session: SessionDep, source: str | None = None, status: str | None = None,
                   limit: int = Query(50, le=500)) -> list[Circular]:
    """Newest first. status: new / parsed / analyzed / failed / skipped."""
    q = select(Circular).options(*HEAVY).order_by(col(Circular.published_at).desc().nulls_last()).limit(limit)
    if source:
        q = q.where(Circular.source == source.upper())
    if status:
        q = q.where(Circular.status == status)
    return session.exec(q).all()


@router.get("/{circular_id}")
def get_circular(circular_id: int, session: SessionDep) -> CircularDetail:
    c = session.exec(select(Circular).options(*HEAVY).where(Circular.id == circular_id)).first()
    if c is None:
        raise HTTPException(404, f"Circular {circular_id} not found")
    gaps = session.exec(select(Gap).where(Gap.circular_id == c.id)).all()
    rows = session.exec(select(PolicyCheck, Policy.code, Policy.title).join(Policy)
                        .where(PolicyCheck.circular_id == c.id).order_by(col(PolicyCheck.similarity).desc())).all()
    checks = [Checked(policy_id=k.policy_id, code=code, title=title, version=k.policy_version,
                      similarity=k.similarity, impacted=k.impacted, checked_at=k.checked_at)
              for k, code, title in rows]
    return CircularDetail(circular=c, gaps=gaps, checks=checks)


@router.get("/{circular_id}/text", response_class=PlainTextResponse)
def get_circular_text(circular_id: int, session: SessionDep) -> str:
    """The OCR output of the PDF."""
    return get_or_404(session, Circular, circular_id).text or ""


@router.post("/{circular_id}/reprocess")
def reprocess_circular(circular_id: int, session: SessionDep) -> Circular:
    """Run the circular through Gemini again: it's read, judged and checked against the
    policies afresh. The saved OCR text is reused (OCR only runs if there isn't any), and
    gaps already opened are kept and never duplicated."""
    c = get_or_404(session, Circular, circular_id)
    c.status, c.error = ("parsed" if c.text else "new"), None
    c.addressed_to = c.summary = c.requirements = c.embedding = c.applicable = c.applies_reason = None
    # forget the "up to date" verdicts so they're asked again; out-of-date ones have a gap,
    # and a pair with a gap is never re-checked (its owner is already on it)
    session.execute(delete(PolicyCheck).where(PolicyCheck.circular_id == c.id, col(PolicyCheck.impacted).is_(False)))
    session.commit()
    session.refresh(c)
    return c
