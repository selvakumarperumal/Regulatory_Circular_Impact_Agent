"""Accounts: signing up a company, signing in, and the company's team.

Signing up creates the company and its first user. Anyone in the company can add
teammates; everyone in a company sees the same data."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from auth import CurrentUser, hash_password, issue_token, password_ok
from common.models import Company, User
from database import SessionDep, enqueue, save

router = APIRouter(prefix="/auth", tags=["accounts"])
team = APIRouter(prefix="/users", tags=["accounts"])

EMAIL = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class SignUp(SQLModel):
    company: str = Field(min_length=2, description="The company's name")
    name: str = Field(min_length=1, description="Your name")
    email: str = Field(regex=EMAIL)
    password: str = Field(min_length=8)


class Login(SQLModel):
    email: str
    password: str


class NewUser(SQLModel):
    name: str = Field(min_length=1)
    email: str = Field(regex=EMAIL)
    password: str = Field(min_length=8)


class NewPassword(SQLModel):
    current: str
    new: str = Field(min_length=8)


class Account(BaseModel):
    user: User
    company: Company


class SignedIn(Account):
    token: str


def normal(email: str) -> str:
    return email.strip().lower()


def refuse_taken(session: Session, email: str) -> None:
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, f"an account with {email} already exists")


@router.post("/signup", status_code=201)
def sign_up(body: SignUp, session: SessionDep) -> SignedIn:
    """A new company and its first user. Its recent circulars are queued for
    assessment, and judged once the company is described."""
    email = normal(body.email)
    refuse_taken(session, email)
    company = save(session, Company(name=body.company.strip()))
    user = save(
        session,
        User(
            company_id=company.id,
            email=email,
            name=body.name.strip(),
            password_hash=hash_password(body.password),
        ),
    )
    enqueue("company.refresh", company_id=company.id)
    return SignedIn(user=user, company=company, token=issue_token(user))


@router.post("/login")
def log_in(body: Login, session: SessionDep) -> SignedIn:
    user = session.exec(select(User).where(User.email == normal(body.email))).first()
    if user is None or not password_ok(body.password, user.password_hash):
        raise HTTPException(401, "wrong email or password")
    company = session.get(Company, user.company_id)
    return SignedIn(user=user, company=company, token=issue_token(user))


@router.get("/me")
def me(user: CurrentUser, session: SessionDep) -> Account:
    return Account(user=user, company=session.get(Company, user.company_id))


@router.put("/password", status_code=204)
def change_password(body: NewPassword, user: CurrentUser, session: SessionDep) -> None:
    if not password_ok(body.current, user.password_hash):
        raise HTTPException(403, "the current password is wrong")
    user.password_hash = hash_password(body.new)
    save(session, user)


@team.get("")
def list_users(user: CurrentUser, session: SessionDep) -> list[User]:
    return session.exec(
        select(User).where(User.company_id == user.company_id).order_by(User.name)
    ).all()


@team.post("", status_code=201)
def add_user(body: NewUser, user: CurrentUser, session: SessionDep) -> User:
    """A teammate in the same company, with a first password to hand them."""
    email = normal(body.email)
    refuse_taken(session, email)
    return save(
        session,
        User(
            company_id=user.company_id,
            email=email,
            name=body.name.strip(),
            password_hash=hash_password(body.password),
        ),
    )
