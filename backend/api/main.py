"""API: uvicorn main:app --reload        docs at http://localhost:8000/docs

Accounts (sign-up, login, the team), the company's description, circulars (written by
the watcher and worker, read here), the policy and control library, and the gap
tickets with their history. Every route except sign-up, login and /health needs a
login token, and only ever shows the signed-in user's company."""

from contextlib import asynccontextmanager
from datetime import date

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlmodel import col, func, select

from auth import CurrentUser
from common.db import init_db
from common.models import OPEN_STATUSES, Assessment, Circular, Gap
from config import settings
from database import SessionDep, engine
from routes import auth, circulars, company, gaps, policies
from routes.circulars import assessed_by, shown_status


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db(engine)
    yield


app = FastAPI(title="Regulatory Circular Impact Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS.split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(auth.team)
app.include_router(company.router)
app.include_router(circulars.router)
app.include_router(policies.router)
app.include_router(gaps.router)


@app.get("/health")
def health(session: SessionDep) -> dict:
    session.exec(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/stats")
def stats(user: CurrentUser, session: SessionDep) -> dict:
    """The company's counts of circulars and gaps by status, and how many of its open
    gaps are past due."""
    shown = shown_status()
    circulars = (
        select(shown, func.count())
        .select_from(Circular)
        .outerjoin(Assessment, assessed_by(user.company_id))
        .group_by(shown)
    )
    gaps = (
        select(Gap.status, func.count())
        .where(Gap.company_id == user.company_id)
        .group_by(Gap.status)
    )
    overdue = (
        select(func.count())
        .select_from(Gap)
        .where(
            Gap.company_id == user.company_id,
            col(Gap.status).in_(OPEN_STATUSES),
            Gap.due_date < date.today(),
        )
    )
    return {
        "circulars": dict(session.exec(circulars).all()),
        "gaps": dict(session.exec(gaps).all()),
        "overdue_gaps": session.exec(overdue).one(),
    }
