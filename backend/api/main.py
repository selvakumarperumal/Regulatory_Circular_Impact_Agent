"""API: uvicorn main:app --reload        docs at http://localhost:8000/docs

Every route except sign-up, login and /health needs a login token, and only ever
shows the signed-in user's company."""

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
for module in (auth, company, circulars, policies, gaps):
    app.include_router(module.router)


@app.get("/health")
def health(session: SessionDep) -> dict:
    session.exec(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/stats")
def stats(user: CurrentUser, session: SessionDep) -> dict:
    """The company's circulars and gaps by status, and its overdue gaps."""
    shown = shown_status()
    ours = Gap.company_id == user.company_id
    overdue = (col(Gap.status).in_(OPEN_STATUSES), Gap.due_date < date.today())
    return {
        "circulars": dict(
            session.exec(
                select(shown, func.count())
                .select_from(Circular)
                .outerjoin(Assessment, assessed_by(user.company_id))
                .group_by(shown)
            ).all()
        ),
        "gaps": dict(
            session.exec(
                select(Gap.status, func.count()).where(ours).group_by(Gap.status)
            ).all()
        ),
        "overdue_gaps": session.exec(
            select(func.count()).select_from(Gap).where(ours, *overdue)
        ).one(),
    }
