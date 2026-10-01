"""Circulars, shared by every company, each shown with the company's own status: a
read circular is "parsed" while the company's assessment is pending, "analyzed" once
it's done (or, with no assessment, while the company has no description: "Not
checked"), "failed" if it failed, and "skipped" if it's older than LOOKBACK_DAYS and
never judged for the company. The OCR text has its own endpoint."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import and_, case, delete, literal, or_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from auth import CurrentUser
from common.models import (
    Assessment,
    Circular,
    CircularBase,
    Company,
    Gap,
    Policy,
    PolicyCheck,
    now,
)
from config import settings
from database import SessionDep, enqueue, get_or_404

router = APIRouter(prefix="/circulars", tags=["circulars"])


class CircularView(CircularBase):
    id: int
    applicable: bool | None = None
    applies_reason: str | None = None


class Checked(BaseModel):
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


def assessed_by(company_id: int):
    return and_(
        Assessment.circular_id == Circular.id, Assessment.company_id == company_id
    )


def shown_status(session: Session, company_id: int):
    """A read circular the company has no assessment of is "skipped" when it's older
    than LOOKBACK_DAYS. A recent one is "analyzed" (Not checked) while the company has
    no description, else "parsed": a company.refresh is on its way."""
    cutoff = datetime.now(UTC) - timedelta(days=settings.LOOKBACK_DAYS)
    old = or_(col(Circular.published_at).is_(None), Circular.published_at < cutoff)
    unjudged = col(Assessment.id).is_(None)
    whens = [
        (Circular.status != "read", Circular.status),
        (Assessment.status == "done", literal("analyzed")),
        (Assessment.status == "failed", literal("failed")),
        (and_(unjudged, old), literal("skipped")),
    ]
    if not session.get(Company, company_id).profile:
        whens.append((unjudged, literal("analyzed")))
    return case(*whens, else_=literal("parsed"))


def views(
    session: SessionDep, company_id: int, *where, status: str | None = None, limit=1
) -> list[CircularView]:
    """The circulars as this company sees them, newest first."""
    shown = shown_status(session, company_id)
    query = (
        select(Circular, Assessment, shown)
        .options(defer(Circular.text), defer(Circular.embedding))
        .outerjoin(Assessment, assessed_by(company_id))
        .where(*where)
        .order_by(col(Circular.published_at).desc().nulls_last())
        .limit(limit)
    )
    if status:
        query = query.where(shown == status)
    return [
        CircularView.model_validate(
            c.model_dump()
            | {
                "status": status,
                "applicable": a and a.applicable,
                "applies_reason": a and a.applies_reason,
                "error": (a and a.error) or c.error,
            }
        )
        for c, a, status in session.exec(query)
    ]


@router.get("")
def list_circulars(
    user: CurrentUser,
    session: SessionDep,
    source: str | None = None,
    status: str | None = None,
    limit: int = Query(50, le=500),
) -> list[CircularView]:
    """status: new / parsed / analyzed / failed / skipped."""
    where = [Circular.source == source.upper()] if source else []
    return views(session, user.company_id, *where, status=status, limit=limit)


@router.get("/{circular_id}")
def get_circular(
    circular_id: int, user: CurrentUser, session: SessionDep
) -> CircularDetail:
    found = views(session, user.company_id, Circular.id == circular_id)
    if not found:
        raise HTTPException(404, f"Circular {circular_id} not found")
    gaps = select(Gap).where(
        Gap.circular_id == circular_id, Gap.company_id == user.company_id
    )
    checks = session.exec(
        select(PolicyCheck, Policy.code, Policy.title)
        .join(Policy)
        .where(
            PolicyCheck.circular_id == circular_id,
            Policy.company_id == user.company_id,
        )
        .order_by(col(PolicyCheck.similarity).desc())
    )
    return CircularDetail(
        circular=found[0],
        gaps=session.exec(gaps).all(),
        checks=[
            Checked(**k.model_dump(), code=code, title=title, version=k.policy_version)
            for k, code, title in checks
        ],
    )


@router.get("/{circular_id}/text", response_class=PlainTextResponse)
def get_circular_text(circular_id: int, user: CurrentUser, session: SessionDep) -> str:
    return get_or_404(session, Circular, circular_id).text or ""


@router.post("/{circular_id}/reprocess", status_code=202)
def reprocess_circular(
    circular_id: int, user: CurrentUser, session: SessionDep
) -> None:
    """Not read yet (failed, or waiting): queue it to be read again, reusing any OCR
    text. Read: judge it again for this company only, forgetting only its "up to
    date" verdicts; gaps are kept and never duplicated."""
    c = get_or_404(session, Circular, circular_id)
    if c.status != "read":
        c.status, c.error = ("parsed" if c.text else "new"), None
        session.commit()
        enqueue("circular.read", circular_id=c.id)
        return
    fresh = {"status": "pending", "applicable": None, "applies_reason": None}
    session.execute(
        insert(Assessment)
        .values(company_id=user.company_id, circular_id=c.id, updated_at=now(), **fresh)
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
