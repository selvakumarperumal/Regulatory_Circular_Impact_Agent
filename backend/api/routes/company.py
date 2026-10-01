"""The signed-in user's company: its name, and the description the worker judges
circulars against."""

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
        description="What kind of entity it is, its licences and businesses, "
        "and who regulates it",
    )


class CompanySaved(BaseModel):
    company: Company
    requeued: int


@router.get("")
def get_company(user: CurrentUser, session: SessionDep) -> Company:
    return session.get(Company, user.company_id)


@router.put("")
def set_company(
    body: CompanyIn, user: CurrentUser, session: SessionDep
) -> CompanySaved:
    """A new description sets the company's "does it apply?" answers back to pending.
    Every save queues a company.refresh, which queues the pending ones (so saving
    again after a 503 queues them again). Only that question is asked again: the OCR
    text, the summaries and the policy verdicts are kept."""
    company = session.get(Company, user.company_id)
    company.name = (body.name or company.name).strip()
    profile = body.profile.strip()
    changed = profile != company.profile
    requeued = 0
    if changed:
        company.profile, company.updated_at = profile, now()
        read = select(Circular.id).where(Circular.status == "read")
        requeued = session.execute(
            update(Assessment)
            .where(
                Assessment.company_id == company.id,
                col(Assessment.circular_id).in_(read),
            )
            .values(status="pending", applicable=None, applies_reason=None, error=None)
        ).rowcount
    save(session, company)
    enqueue("company.refresh", company_id=company.id)
    return CompanySaved(company=company, requeued=requeued)
