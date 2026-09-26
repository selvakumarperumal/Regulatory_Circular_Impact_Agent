"""The Postgres tables (SQLModel: each class is both a table and a Pydantic model).

circulars  --<  gaps  >--  policies  --<  controls
                 |
                 +--<  gap_events   (history of every gap: opened, status changes, comments)

company    one row: who "the company" is, in the user's words
"""
from datetime import date, datetime, timezone
from typing import Literal

from sqlalchemy import JSON, DateTime, Text, UniqueConstraint
from sqlmodel import Field, SQLModel


def now() -> datetime:
    return datetime.now(timezone.utc)


class Circular(SQLModel, table=True):
    """Inserted by the watcher (status 'new'). The worker then moves it along:
    new -> parsed (OCR done) -> analyzed, or failed / skipped (older than LOOKBACK_DAYS)."""
    __tablename__ = "circulars"
    __table_args__ = (UniqueConstraint("source", "source_key"),)

    id: int | None = Field(default=None, primary_key=True)
    source: str = Field(index=True)          # RBI / SEBI / IRDAI
    source_key: str                          # stable ID at the source
    title: str
    detail_url: str
    pdf_url: str
    published_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    sha256: str
    s3_key: str
    status: str = Field(default="new", index=True)
    created_at: datetime = Field(default_factory=now, sa_type=DateTime(timezone=True))
    # filled in by the worker
    text: str | None = Field(default=None, sa_type=Text, exclude=True)   # OCR output; served by /circulars/{id}/text
    addressed_to: str | None = Field(default=None, sa_type=Text)   # as written in the circular
    summary: str | None = Field(default=None, sa_type=Text)
    requirements: list[str] | None = Field(default=None, sa_type=JSON)
    # does it apply to the company? None = not checked, because nobody has described the company yet
    applicable: bool | None = None
    applies_reason: str | None = Field(default=None, sa_type=Text)
    error: str | None = Field(default=None, sa_type=Text)


class Company(SQLModel, table=True):
    """Who "the company" is, in a few sentences, written by a person in the console.
    There is only ever one row. Until it exists the worker still reads and summarises every
    circular, but doesn't judge which ones apply to the company."""
    __tablename__ = "company"

    id: int = Field(default=1, primary_key=True)
    profile: str = Field(sa_type=Text)
    updated_at: datetime = Field(default_factory=now, sa_type=DateTime(timezone=True))


class PolicyIn(SQLModel):
    """The fields a person sets (also the body of POST/PUT /policies)."""
    code: str = Field(unique=True)           # e.g. POL-KYC
    title: str
    owner: str                               # who gets the gap tickets
    regulators: list[str] = Field(default_factory=list, sa_type=JSON)   # e.g. ["RBI", "SEBI"]
    text: str = Field(sa_type=Text)          # current wording of the policy


class Policy(PolicyIn, table=True):
    __tablename__ = "policies"

    id: int | None = Field(default=None, primary_key=True)
    version: int = 1                         # +1 every time the text changes
    updated_at: datetime = Field(default_factory=now, sa_type=DateTime(timezone=True))
    # set by the worker; re-done when the text is edited or the embedding model changes
    embedding: list[float] | None = Field(default=None, sa_type=JSON, exclude=True)
    embedding_model: str | None = Field(default=None, exclude=True)


class ControlIn(SQLModel):
    """The fields a person sets (also the body of POST /policies/{id}/controls)."""
    code: str = Field(unique=True)           # e.g. CTL-KYC-01
    description: str
    owner: str
    frequency: str = "monthly"               # how often the control is performed


class Control(ControlIn, table=True):
    __tablename__ = "controls"

    id: int | None = Field(default=None, primary_key=True)
    policy_id: int = Field(foreign_key="policies.id", index=True)


GapStatus = Literal["open", "in_progress", "closed", "dismissed"]
OPEN_STATUSES = ("open", "in_progress")


class Gap(SQLModel, table=True):
    """A ticket: `policy` is out of date because of `circular`. One per (circular, policy)."""
    __tablename__ = "gaps"
    __table_args__ = (UniqueConstraint("circular_id", "policy_id"),)

    id: int | None = Field(default=None, primary_key=True)
    circular_id: int = Field(foreign_key="circulars.id", index=True)
    policy_id: int = Field(foreign_key="policies.id", index=True)
    policy_version: int                      # the version that was found out of date
    title: str
    impact: str = Field(sa_type=Text)        # why the policy no longer complies
    draft_change: str = Field(sa_type=Text)  # suggested wording, for the owner to review
    affected_controls: list[str] = Field(default_factory=list, sa_type=JSON)
    severity: str                            # low / medium / high
    owner: str
    status: str = Field(default="open", index=True)   # open -> in_progress -> closed | dismissed
    due_date: date
    created_at: datetime = Field(default_factory=now, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=now, sa_type=DateTime(timezone=True))
    closed_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class GapEvent(SQLModel, table=True):
    """One line of a gap's history. Never updated or deleted."""
    __tablename__ = "gap_events"

    id: int | None = Field(default=None, primary_key=True)
    gap_id: int = Field(foreign_key="gaps.id", index=True)
    at: datetime = Field(default_factory=now, sa_type=DateTime(timezone=True))
    actor: str                               # "agent", "system" or a person
    action: str                              # opened / status / owner / due_date / comment / policy_updated
    note: str = Field(default="", sa_type=Text)
