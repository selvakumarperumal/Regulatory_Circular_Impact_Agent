"""Who the company is. The worker uses this description to decide which circulars apply to
the company; until someone writes it, circulars are summarised but not judged."""
from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import update
from sqlmodel import Field, SQLModel, col

from common.models import Circular, Company, now
from database import SessionDep

router = APIRouter(prefix="/company", tags=["company"])


class CompanyIn(SQLModel):
    profile: str = Field(min_length=20, description="A few sentences: what kind of entity the company is, "
                                                    "its licences and businesses, and who regulates it")


class CompanySaved(BaseModel):
    company: Company
    requeued: int                          # analysed circulars queued to be judged again


@router.get("")
def get_company(session: SessionDep) -> Company | None:
    """The description, or null if nobody has written one yet."""
    return session.get(Company, 1)


@router.put("")
def set_company(body: CompanyIn, session: SessionDep) -> CompanySaved:
    """Save the description. If it changed, every circular's "does it apply to us?" is
    cleared and the analysed ones are queued again, so the worker judges them against the
    new description. Only that question goes back to Gemini: the OCR text, the summaries
    and every policy check already made are kept, and gaps are never duplicated."""
    profile = body.profile.strip()
    company = session.get(Company, 1)
    changed = company is None or company.profile != profile
    if company is None:
        company = Company(id=1, profile=profile)
        session.add(company)
    elif changed:
        company.profile, company.updated_at = profile, now()
    requeued = 0
    if changed:
        session.execute(update(Circular).where(col(Circular.applicable).is_not(None))
                        .values(applicable=None, applies_reason=None))
        requeued = session.execute(update(Circular).where(Circular.status == "analyzed")
                                   .values(status="parsed")).rowcount
    session.commit()
    session.refresh(company)
    return CompanySaved(company=company, requeued=requeued)
