"""The company's policy library, and the controls under each policy. Saving a policy
queues a policy.check task: the worker embeds it and checks it against the company's
recent circulars."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from auth import CurrentUser
from common.models import (
    OPEN_STATUSES,
    Control,
    ControlIn,
    Gap,
    GapEvent,
    Policy,
    PolicyIn,
    now,
)
from database import SessionDep, enqueue, owned_or_404, save

router = APIRouter(prefix="/policies", tags=["policies"])


class PolicyDetail(BaseModel):
    policy: Policy
    controls: list[Control]
    gaps: list[Gap]


def refuse_duplicate_policy(session: Session, company_id: int, code: str) -> None:
    taken = select(Policy).where(Policy.company_id == company_id, Policy.code == code)
    if session.exec(taken).first():
        raise HTTPException(409, f"policy {code} already exists")


@router.get("")
def list_policies(user: CurrentUser, session: SessionDep) -> list[Policy]:
    """Every policy of the company, by code. The embeddings are never sent, so
    they're not read."""
    return session.exec(
        select(Policy)
        .options(defer(Policy.embeddings))
        .where(Policy.company_id == user.company_id)
        .order_by(Policy.code)
    ).all()


@router.post("", status_code=201)
def create_policy(body: PolicyIn, user: CurrentUser, session: SessionDep) -> Policy:
    refuse_duplicate_policy(session, user.company_id, body.code)
    policy = save(
        session, Policy.model_validate(body, update={"company_id": user.company_id})
    )
    enqueue("policy.check", company_id=user.company_id, policy_id=policy.id)
    return policy


@router.get("/{policy_id}")
def get_policy(policy_id: int, user: CurrentUser, session: SessionDep) -> PolicyDetail:
    policy = owned_or_404(session, Policy, policy_id, user.company_id)
    controls = session.exec(select(Control).where(Control.policy_id == policy.id)).all()
    gaps = session.exec(
        select(Gap).where(Gap.policy_id == policy.id).order_by(col(Gap.id).desc())
    ).all()
    return PolicyDetail(policy=policy, controls=controls, gaps=gaps)


@router.put("/{policy_id}")
def update_policy(
    policy_id: int, body: PolicyIn, user: CurrentUser, session: SessionDep
) -> Policy:
    """Replace the policy. A text change bumps the version and is noted on its open
    gaps, so the owner can close them against the new version. The worker re-embeds
    the policy if its title or text changed, and checks it against the recent
    circulars again."""
    policy = owned_or_404(session, Policy, policy_id, user.company_id)
    if body.code != policy.code:
        refuse_duplicate_policy(session, user.company_id, body.code)
    text_changed = body.text != policy.text
    if text_changed or body.title != policy.title:
        policy.embeddings = None
    policy.sqlmodel_update(body)
    policy.updated_at = now()
    if text_changed:
        policy.version += 1
        open_gaps = session.exec(
            select(Gap).where(
                Gap.policy_id == policy.id, col(Gap.status).in_(OPEN_STATUSES)
            )
        ).all()
        for gap in open_gaps:
            session.add(
                GapEvent(
                    gap_id=gap.id,
                    actor="system",
                    action="policy_updated",
                    note=f"{policy.code} updated to v{policy.version}",
                )
            )
    saved = save(session, policy)
    enqueue("policy.check", company_id=user.company_id, policy_id=saved.id)
    return saved


@router.post("/{policy_id}/controls", status_code=201)
def add_control(
    policy_id: int, body: ControlIn, user: CurrentUser, session: SessionDep
) -> Control:
    owned_or_404(session, Policy, policy_id, user.company_id)
    taken = select(Control).where(
        Control.policy_id == policy_id, Control.code == body.code
    )
    if session.exec(taken).first():
        raise HTTPException(409, f"control {body.code} already exists")
    return save(session, Control.model_validate(body, update={"policy_id": policy_id}))
