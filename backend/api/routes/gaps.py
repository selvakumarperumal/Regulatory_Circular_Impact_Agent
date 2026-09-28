"""Gap tickets: opened by the worker, worked on by people. Every change is added to
the gap's history (gap_events) under the signed-in user's email."""

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import SQLModel, col, select

from auth import CurrentUser
from common.models import OPEN_STATUSES, Circular, Gap, GapEvent, GapStatus, Policy, now
from database import SessionDep, get_or_404, save

router = APIRouter(prefix="/gaps", tags=["gaps"])


class GapDetail(BaseModel):
    gap: Gap
    circular: Circular
    policy: Policy
    events: list[GapEvent]


class GapUpdate(SQLModel):
    """Send only what changes. A note is required to close or dismiss."""

    note: str = ""
    status: GapStatus | None = None
    owner: str | None = None
    due_date: date | None = None


class Comment(SQLModel):
    note: str


@router.get("")
def list_gaps(
    user: CurrentUser,
    session: SessionDep,
    status: GapStatus | None = None,
    owner: str | None = None,
    policy_id: int | None = None,
    overdue: bool = False,
) -> list[Gap]:
    """Earliest due first."""
    filters = {"status": status, "owner": owner, "policy_id": policy_id}
    q = select(Gap).where(Gap.company_id == user.company_id).order_by(Gap.due_date)
    q = q.where(*[getattr(Gap, k) == v for k, v in filters.items() if v])
    if overdue:
        q = q.where(col(Gap.status).in_(OPEN_STATUSES), Gap.due_date < date.today())
    return session.exec(q).all()


@router.get("/{gap_id}")
def get_gap(gap_id: int, user: CurrentUser, session: SessionDep) -> GapDetail:
    gap = get_or_404(session, Gap, gap_id, user.company_id)
    history = select(GapEvent).where(GapEvent.gap_id == gap_id).order_by(GapEvent.at)
    return GapDetail(
        gap=gap,
        circular=session.get(Circular, gap.circular_id),
        policy=session.get(Policy, gap.policy_id),
        events=session.exec(history).all(),
    )


@router.patch("/{gap_id}")
def update_gap(
    gap_id: int, body: GapUpdate, user: CurrentUser, session: SessionDep
) -> GapDetail:
    gap = get_or_404(session, Gap, gap_id, user.company_id)
    if body.status in ("closed", "dismissed") and not body.note:
        raise HTTPException(422, "a note is required to close or dismiss a gap")
    for field, new in body.model_dump(exclude_unset=True, exclude={"note"}).items():
        old = getattr(gap, field)
        if new is not None and new != old:
            setattr(gap, field, new)
            note = f"{old} -> {new}" + (f": {body.note}" if body.note else "")
            session.add(
                GapEvent(gap_id=gap_id, actor=user.email, action=field, note=note)
            )
    gap.closed_at = None if gap.status in OPEN_STATUSES else (gap.closed_at or now())
    gap.updated_at = now()
    session.commit()
    return get_gap(gap_id, user, session)


@router.post("/{gap_id}/comments", status_code=201)
def add_comment(
    gap_id: int, body: Comment, user: CurrentUser, session: SessionDep
) -> GapEvent:
    gap = get_or_404(session, Gap, gap_id, user.company_id)
    gap.updated_at = now()
    comment = GapEvent(
        gap_id=gap_id, actor=user.email, action="comment", note=body.note
    )
    return save(session, comment)
