"""Accounts: sign up (a company and its first user), log in, and the company's team.
Everyone in a company sees the same data."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from auth import CurrentUser, hash_password, issue_token, password_ok
from common.models import Company, User
from database import SessionDep, enqueue_or_undo, save

router = APIRouter(tags=["accounts"])


class NewUser(SQLModel):
    name: str = Field(min_length=1)
    email: str = Field(regex=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=8)


class SignUp(NewUser):
    company: str = Field(min_length=2)


class Login(SQLModel):
    email: str
    password: str


class NewPassword(SQLModel):
    current: str
    new: str = Field(min_length=8)


class Account(BaseModel):
    user: User
    company: Company
    token: str | None = None


def add_user(session: Session, company_id: int, body: NewUser) -> User:
    email = body.email.strip().lower()
    user = User(
        company_id=company_id,
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
    )
    return save(session, user, f"an account with {email} already exists")


@router.post("/auth/signup", status_code=201)
def sign_up(body: SignUp, session: SessionDep) -> Account:
    """The company and its user are saved together, then a company.refresh is queued
    (its recent circulars, judged once it's described). No queue, no sign-up."""
    company = Company(name=body.company.strip())
    session.add(company)
    session.flush()
    user = add_user(session, company.id, body)
    session.refresh(company)
    enqueue_or_undo(session, [user, company], "company.refresh", company_id=company.id)
    return Account(user=user, company=company, token=issue_token(user))


@router.post("/auth/login")
def log_in(body: Login, session: SessionDep) -> Account:
    email = body.email.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    if user is None or not password_ok(body.password, user.password_hash):
        raise HTTPException(401, "wrong email or password")
    company = session.get(Company, user.company_id)
    return Account(user=user, company=company, token=issue_token(user))


@router.get("/auth/me")
def me(user: CurrentUser, session: SessionDep) -> Account:
    return Account(user=user, company=session.get(Company, user.company_id))


@router.put("/auth/password", status_code=204)
def change_password(body: NewPassword, user: CurrentUser, session: SessionDep) -> None:
    if not password_ok(body.current, user.password_hash):
        raise HTTPException(403, "the current password is wrong")
    user.password_hash = hash_password(body.new)
    save(session, user)


@router.get("/users")
def list_users(user: CurrentUser, session: SessionDep) -> list[User]:
    team = select(User).where(User.company_id == user.company_id).order_by(User.name)
    return session.exec(team).all()


@router.post("/users", status_code=201)
def add_teammate(body: NewUser, user: CurrentUser, session: SessionDep) -> User:
    return add_user(session, user.company_id, body)
