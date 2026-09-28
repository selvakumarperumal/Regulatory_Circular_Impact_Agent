"""The signed-in user's company: its name and its description. The worker uses the
description to decide which circulars apply to the company; until someone writes it,
circulars are read but not judged for this company."""

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import update
from sqlmodel import Field, SQLModel, col, select

from auth import CurrentUser
from common.models import Assessment, Circular, Company, now
from database import SessionDep, enqueue, save

router = APIRouter(prefix="/company", tags=["company"])


class CompanyIn(SQLModel):
    name: str | None = Field(default=None, min_length=2)
    profile: str = Field(
        min_length=20,
        description="A few sentences: what kind of entity the company is, "
        "its licences and businesses, and who regulates it",
    )


class CompanySaved(BaseModel):
    """The saved company, and how many circulars were queued to be judged again."""

    company: Company
    requeued: int


@router.get("")
def get_company(user: CurrentUser, session: SessionDep) -> Company:
    return session.get(Company, user.company_id)


@router.put("")
def set_company(
    body: CompanyIn, user: CurrentUser, session: SessionDep
) -> CompanySaved:
    """Save the name and description. A new description clears the company's "does it
    apply to us?" answers and queues its circulars to be judged again. Only that
    question goes back to Gemini: the OCR text, the summaries and every policy check
    already made are kept, and gaps are never duplicated."""
    company = session.get(Company, user.company_id)
    if body.name:
        company.name = body.name.strip()
    profile = body.profile.strip()
    if company.profile == profile:
        return CompanySaved(company=save(session, company), requeued=0)
    company.profile, company.updated_at = profile, now()
    read = select(Circular.id).where(Circular.status == "read")
    requeued = session.execute(
        update(Assessment)
        .where(
            Assessment.company_id == company.id,
            col(Assessment.circular_id).in_(read),
        )
        .values(
            status="pending",
            applicable=None,
            applies_reason=None,
            error=None,
            updated_at=now(),
        )
    ).rowcount
    saved = save(session, company)
    enqueue("company.refresh", company_id=company.id)
    return CompanySaved(company=saved, requeued=requeued)
