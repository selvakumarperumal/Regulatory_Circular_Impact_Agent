"""The signed-in user's company: its name, and the description the worker judges
circulars against."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Field, SQLModel

from auth import CurrentUser
from common.models import Company, now
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
    checking: bool = Field(
        description="The description changed: a worker is checking the company's "
        "circulars against it"
    )


@router.get("")
def get_company(user: CurrentUser, session: SessionDep) -> Company:
    return session.get(Company, user.company_id)


@router.put("")
def set_company(
    body: CompanyIn, user: CurrentUser, session: SessionDep
) -> CompanySaved:
    """Saves the name and the description. A description added or changed is saved
    together with a company.refresh task (the worker then asks "does it apply?" again
    for the company's circulars), or not at all: if the task can't be queued, the old
    description is put back and the request fails with 503. A name alone queues
    nothing."""
    company = session.get(Company, user.company_id)
    company.name = (body.name or company.name).strip()
    old = company.profile, company.updated_at
    checking = body.profile.strip() != company.profile
    if checking:
        company.profile, company.updated_at = body.profile.strip(), now()
    save(session, company)
    if checking:
        try:
            enqueue("company.refresh", company_id=company.id)
        except HTTPException as e:
            company.profile, company.updated_at = old
            save(session, company)
            e.detail = "The task queue is unavailable, so the description wasn't saved"
            raise
    return CompanySaved(company=company, checking=checking)
