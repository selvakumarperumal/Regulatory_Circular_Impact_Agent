"""The company's policy library and each policy's controls. Saving a policy queues a
policy.check task: a worker embeds it and checks it against the company's recent
circulars, then sets its checked_at."""

from fastapi import APIRouter
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
from database import SessionDep, enqueue, get_or_404, save

router = APIRouter(prefix="/policies", tags=["policies"])


class PolicyDetail(BaseModel):
    policy: Policy
    controls: list[Control]
    gaps: list[Gap]


def save_policy(session: Session, policy: Policy) -> Policy:
    saved = save(session, policy, f"policy {policy.code} already exists")
    enqueue("policy.check", company_id=saved.company_id, policy_id=saved.id)
    return saved


@router.get("")
def list_policies(user: CurrentUser, session: SessionDep) -> list[Policy]:
    return session.exec(
        select(Policy)
        .options(defer(Policy.embeddings))
        .where(Policy.company_id == user.company_id)
        .order_by(Policy.code)
    ).all()


@router.post("", status_code=201)
def create_policy(body: PolicyIn, user: CurrentUser, session: SessionDep) -> Policy:
    policy = Policy.model_validate(body, update={"company_id": user.company_id})
    return save_policy(session, policy)


@router.get("/{policy_id}")
def get_policy(policy_id: int, user: CurrentUser, session: SessionDep) -> PolicyDetail:
    policy = get_or_404(session, Policy, policy_id, user.company_id)
    return PolicyDetail(
        policy=policy,
        controls=session.exec(
            select(Control).where(Control.policy_id == policy_id)
        ).all(),
        gaps=session.exec(
            select(Gap).where(Gap.policy_id == policy_id).order_by(col(Gap.id).desc())
        ).all(),
    )


@router.put("/{policy_id}")
def update_policy(
    policy_id: int, body: PolicyIn, user: CurrentUser, session: SessionDep
) -> Policy:
    """A text change is a new version, noted on the policy's open gaps. A new title
    or text is embedded again."""
    policy = get_or_404(session, Policy, policy_id, user.company_id)
    if (body.title, body.text) != (policy.title, policy.text):
        policy.embeddings = None
    if body.text != policy.text:
        policy.version += 1
        open_gaps = select(Gap).where(
            Gap.policy_id == policy_id, col(Gap.status).in_(OPEN_STATUSES)
        )
        for gap in session.exec(open_gaps):
            note = f"{body.code} updated to v{policy.version}"
            session.add(
                GapEvent(
                    gap_id=gap.id, actor="system", action="policy_updated", note=note
                )
            )
    policy.sqlmodel_update(body)
    policy.updated_at = now()
    return save_policy(session, policy)


@router.post("/{policy_id}/controls", status_code=201)
def add_control(
    policy_id: int, body: ControlIn, user: CurrentUser, session: SessionDep
) -> Control:
    get_or_404(session, Policy, policy_id, user.company_id)
    control = Control.model_validate(body, update={"policy_id": policy_id})
    return save(session, control, f"control {body.code} already exists")
