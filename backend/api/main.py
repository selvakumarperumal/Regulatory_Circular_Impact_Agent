"""API: uvicorn main:app --reload        docs at http://localhost:8000/docs

The company's description, circulars (written by the watcher and worker, read here),
the policy and control library, and the gap tickets with their history."""

from contextlib import asynccontextmanager
from datetime import date

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlmodel import col, func, select

from common.db import init_db
from common.models import OPEN_STATUSES, Circular, Gap
from config import settings
from database import SessionDep, engine
from routes import circulars, company, gaps, policies


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
app.include_router(company.router)
app.include_router(circulars.router)
app.include_router(policies.router)
app.include_router(gaps.router)


@app.get("/health")
def health(session: SessionDep) -> dict:
    session.exec(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/stats")
def stats(session: SessionDep) -> dict:
    """Counts of circulars and gaps by status, and how many open gaps are past due."""
    overdue = (
        select(func.count())
        .select_from(Gap)
        .where(col(Gap.status).in_(OPEN_STATUSES), Gap.due_date < date.today())
    )
    return {
        "circulars": dict(
            session.exec(
                select(Circular.status, func.count()).group_by(Circular.status)
            ).all()
        ),
        "gaps": dict(
            session.exec(select(Gap.status, func.count()).group_by(Gap.status)).all()
        ),
        "overdue_gaps": session.exec(overdue).one(),
    }
