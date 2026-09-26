"""The company's policy library, and the controls under each policy."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import defer
from sqlmodel import col, select

from common.models import OPEN_STATUSES, Control, ControlIn, Gap, GapEvent, Policy, PolicyIn, now
from database import SessionDep, get_or_404

router = APIRouter(prefix="/policies", tags=["policies"])


class PolicyDetail(BaseModel):
    policy: Policy
    controls: list[Control]
    gaps: list[Gap]


@router.get("")
def list_policies(session: SessionDep) -> list[Policy]:
    # the embeddings are never sent out, so don't read them
    return session.exec(select(Policy).options(defer(Policy.embeddings)).order_by(Policy.code)).all()


@router.post("", status_code=201)
def create_policy(body: PolicyIn, session: SessionDep) -> Policy:
    if session.exec(select(Policy).where(Policy.code == body.code)).first():
        raise HTTPException(409, f"policy {body.code} already exists")
    policy = Policy.model_validate(body)
    session.add(policy)
    session.commit()
    session.refresh(policy)
    return policy


@router.get("/{policy_id}")
def get_policy(policy_id: int, session: SessionDep) -> PolicyDetail:
    policy = get_or_404(session, Policy, policy_id)
    controls = session.exec(select(Control).where(Control.policy_id == policy.id)).all()
    gaps = session.exec(select(Gap).where(Gap.policy_id == policy.id).order_by(col(Gap.id).desc())).all()
    return PolicyDetail(policy=policy, controls=controls, gaps=gaps)


@router.put("/{policy_id}")
def update_policy(policy_id: int, body: PolicyIn, session: SessionDep) -> Policy:
    """Replace the policy. A text change bumps the version and is noted on its open gaps,
    so the owner can close them against the new version. The worker re-embeds the policy
    if its title or text changed, and checks it against the recent circulars again."""
    policy = get_or_404(session, Policy, policy_id)
    if body.code != policy.code and session.exec(select(Policy).where(Policy.code == body.code)).first():
        raise HTTPException(409, f"policy {body.code} already exists")
    text_changed = body.text != policy.text
    if text_changed or body.title != policy.title:
        policy.embeddings = None          # what gets embedded changed
    policy.sqlmodel_update(body)
    policy.updated_at = now()
    if text_changed:
        policy.version += 1
        open_gaps = session.exec(select(Gap).where(Gap.policy_id == policy.id,
                                                   col(Gap.status).in_(OPEN_STATUSES))).all()
        for gap in open_gaps:
            session.add(GapEvent(gap_id=gap.id, actor="system", action="policy_updated",
                                 note=f"{policy.code} updated to v{policy.version}"))
    session.commit()
    session.refresh(policy)
    return policy


@router.post("/{policy_id}/controls", status_code=201)
def add_control(policy_id: int, body: ControlIn, session: SessionDep) -> Control:
    get_or_404(session, Policy, policy_id)
    if session.exec(select(Control).where(Control.code == body.code)).first():
        raise HTTPException(409, f"control {body.code} already exists")
    control = Control.model_validate(body, update={"policy_id": policy_id})
    session.add(control)
    session.commit()
    session.refresh(control)
    return control
