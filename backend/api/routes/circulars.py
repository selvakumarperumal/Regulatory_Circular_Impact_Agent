"""Circulars: found by the watcher, read by the worker, judged per company.

Every company sees every circular, with its own status: a circular the worker has
read shows as "analyzed" once it has been judged for this company, "parsed" while it
waits, "failed" if judging failed, and "skipped" if it was published before the
look-back window and never judged for this company. `applicable` and
`applies_reason` are the company's own.

The OCR text (up to 100 kB) and the embedding are never sent to the console, so
they're never read from the database here either; the OCR text has its own endpoint."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import and_, case, delete, literal, or_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import defer
from sqlmodel import col, select

from auth import CurrentUser
from common.models import Assessment, Circular, Gap, Policy, PolicyCheck, now
from config import settings
from database import SessionDep, enqueue, get_or_404, save

router = APIRouter(prefix="/circulars", tags=["circulars"])

HEAVY = (defer(Circular.text), defer(Circular.embedding))


class CircularView(BaseModel):
    """A circular as the signed-in company sees it."""

    id: int
    source: str
    source_key: str
    title: str
    detail_url: str
    pdf_url: str
    published_at: datetime | None
    status: str
    created_at: datetime
    addressed_to: str | None
    summary: str | None
    requirements: list[str] | None
    applicable: bool | None
    applies_reason: str | None
    error: str | None


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
    circular: CircularView
    gaps: list[Gap]
    checks: list[Checked]


def shown_status():
    """The circular's status as this company sees it (see the module docstring)."""
    cutoff = datetime.now(UTC) - timedelta(days=settings.LOOKBACK_DAYS)
    too_old = or_(col(Circular.published_at).is_(None), Circular.published_at < cutoff)
    return case(
        (Circular.status != "read", Circular.status),
        (Assessment.status == "done", literal("analyzed")),
        (Assessment.status == "failed", literal("failed")),
        (and_(col(Assessment.id).is_(None), too_old), literal("skipped")),
        else_=literal("parsed"),
    )


def assessed_by(company_id: int):
    return and_(
        Assessment.circular_id == Circular.id, Assessment.company_id == company_id
    )


def company_view(company_id: int, shown):
    return (
        select(
            Circular,
            Assessment.applicable,
            Assessment.applies_reason,
            Assessment.error,
            shown,
        )
        .options(*HEAVY)
        .outerjoin(Assessment, assessed_by(company_id))
    )


def as_view(row) -> CircularView:
    c, applicable, reason, error, shown = row
    return CircularView.model_validate(
        c.model_dump()
        | {
            "status": shown,
            "applicable": applicable,
            "applies_reason": reason,
            "error": error or c.error,
        }
    )


@router.get("")
def list_circulars(
    user: CurrentUser,
    session: SessionDep,
    source: str | None = None,
    status: str | None = None,
    limit: int = Query(50, le=500),
) -> list[CircularView]:
    """Newest first. status: new / parsed / analyzed / failed / skipped."""
    shown = shown_status()
    q = (
        company_view(user.company_id, shown)
        .order_by(col(Circular.published_at).desc().nulls_last())
        .limit(limit)
    )
    if source:
        q = q.where(Circular.source == source.upper())
    if status:
        q = q.where(shown == status)
    return [as_view(row) for row in session.exec(q).all()]


@router.get("/{circular_id}")
def get_circular(
    circular_id: int, user: CurrentUser, session: SessionDep
) -> CircularDetail:
    row = session.exec(
        company_view(user.company_id, shown_status()).where(Circular.id == circular_id)
    ).first()
    if row is None:
        raise HTTPException(404, f"Circular {circular_id} not found")
    gaps = session.exec(
        select(Gap).where(
            Gap.circular_id == circular_id, Gap.company_id == user.company_id
        )
    ).all()
    rows = session.exec(
        select(PolicyCheck, Policy.code, Policy.title)
        .join(Policy)
        .where(
            PolicyCheck.circular_id == circular_id,
            Policy.company_id == user.company_id,
        )
        .order_by(col(PolicyCheck.similarity).desc())
    ).all()
    checks = [
        Checked(
            policy_id=k.policy_id,
            code=code,
            title=title,
            version=k.policy_version,
            similarity=k.similarity,
            impacted=k.impacted,
            checked_at=k.checked_at,
        )
        for k, code, title in rows
    ]
    return CircularDetail(circular=as_view(row), gaps=gaps, checks=checks)


@router.get("/{circular_id}/text", response_class=PlainTextResponse)
def get_circular_text(circular_id: int, user: CurrentUser, session: SessionDep) -> str:
    """The OCR output of the PDF."""
    return get_or_404(session, Circular, circular_id).text or ""


@router.post("/{circular_id}/reprocess", status_code=202)
def reprocess_circular(
    circular_id: int, user: CurrentUser, session: SessionDep
) -> None:
    """Run the circular through again for this company.

    A circular the worker hasn't read (it failed, or is still waiting) is queued to be
    read; its saved OCR text is reused. A circular already read is judged again for
    this company only, and checked against its policies afresh: only its "up to date"
    verdicts are forgotten. An out-of-date one has a gap, and a pair with a gap is
    never re-checked (its owner is already on it), so no gap is duplicated. Other
    companies' answers are never touched."""
    c = get_or_404(session, Circular, circular_id)
    if c.status != "read":
        c.status, c.error = ("parsed" if c.text else "new"), None
        save(session, c)
        enqueue("circular.read", circular_id=c.id)
        return
    fresh = {
        "status": "pending",
        "applicable": None,
        "applies_reason": None,
        "error": None,
        "updated_at": now(),
    }
    session.execute(
        insert(Assessment)
        .values(company_id=user.company_id, circular_id=c.id, **fresh)
        .on_conflict_do_update(index_elements=["company_id", "circular_id"], set_=fresh)
    )
    ours = select(Policy.id).where(Policy.company_id == user.company_id)
    session.execute(
        delete(PolicyCheck).where(
            PolicyCheck.circular_id == c.id,
            col(PolicyCheck.impacted).is_(False),
            col(PolicyCheck.policy_id).in_(ours),
        )
    )
    session.commit()
    enqueue("circular.assess", company_id=user.company_id, circular_id=c.id)
