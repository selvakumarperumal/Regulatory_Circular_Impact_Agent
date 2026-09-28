"""The Postgres tables (SQLModel: each class is both a table and a Pydantic model).

companies  --<  users
    |
    +--<  assessments  >--  circulars    does this circular apply to this company?
    |                          |
    +--<  policies  --<  controls
             |                 |
             +--<  gaps  >-----+         (a gap belongs to a policy and a circular)
             |      |
             |      +--<  gap_events     history of every gap
             |
             +--<  policy_checks  >--  circulars   Gemini's verdict per policy version

Circulars are shared by every company: they're public, and reading one (OCR, the
summary, the embedding) is the same for everyone, so it's done once. Everything that
depends on the company (does it apply, which policies are out of date) is kept per
company. Work that costs time or money is done once and kept."""

from datetime import UTC, date, datetime
from typing import Literal

from sqlalchemy import JSON, DateTime, Text, UniqueConstraint
from sqlmodel import Field, SQLModel

Timestamp = DateTime(timezone=True)


def now() -> datetime:
    return datetime.now(UTC)


class Company(SQLModel, table=True):
    """A company using the app. `profile` is its description in a few sentences,
    written by its people in the console; until it's written, circulars are read but
    not judged for this company."""

    __tablename__ = "companies"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    profile: str = Field(default="", sa_type=Text)
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    updated_at: datetime = Field(default_factory=now, sa_type=Timestamp)


class User(SQLModel, table=True):
    """Someone who signs in to the console. Every user belongs to one company and
    only ever sees that company's data."""

    __tablename__ = "users"

    id: int | None = Field(default=None, primary_key=True)
    company_id: int = Field(foreign_key="companies.id", index=True)
    email: str = Field(unique=True, index=True)
    name: str
    password_hash: str = Field(exclude=True)
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)


class Circular(SQLModel, table=True):
    """A regulator's circular, shared by every company. The watcher inserts it with
    status 'new'; the worker moves it to 'parsed' (OCR text saved) and then 'read'
    (summary and embedding saved), or to 'failed' or 'skipped' (published before
    LOOKBACK_DAYS). OCR runs once per PDF: everything after it reads the saved text.

    `text` and `embedding` are never sent by the api; the OCR text has its own
    endpoint."""

    __tablename__ = "circulars"
    __table_args__ = (UniqueConstraint("source", "source_key"),)

    id: int | None = Field(default=None, primary_key=True)
    source: str = Field(index=True, description="RBI, SEBI or IRDAI")
    source_key: str = Field(description="Stable ID of the circular at its source")
    title: str
    detail_url: str
    pdf_url: str
    published_at: datetime | None = Field(default=None, sa_type=Timestamp)
    sha256: str
    s3_key: str
    status: str = Field(default="new", index=True)
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)

    text: str | None = Field(default=None, sa_type=Text, exclude=True)
    addressed_to: str | None = Field(default=None, sa_type=Text)
    summary: str | None = Field(default=None, sa_type=Text)
    requirements: list[str] | None = Field(default=None, sa_type=JSON)
    embedding: list[float] | None = Field(default=None, sa_type=JSON, exclude=True)
    embedding_model: str | None = Field(default=None, exclude=True)
    error: str | None = Field(default=None, sa_type=Text)


class Assessment(SQLModel, table=True):
    """What one company makes of one circular: 'pending' until the worker has judged
    it, then 'done' (or 'failed', with the error). `applicable` stays None when the
    company hasn't been described yet."""

    __tablename__ = "assessments"
    __table_args__ = (UniqueConstraint("company_id", "circular_id"),)

    id: int | None = Field(default=None, primary_key=True)
    company_id: int = Field(foreign_key="companies.id", index=True)
    circular_id: int = Field(foreign_key="circulars.id", index=True)
    status: str = Field(default="pending", index=True)
    applicable: bool | None = None
    applies_reason: str | None = Field(default=None, sa_type=Text)
    error: str | None = Field(default=None, sa_type=Text)
    updated_at: datetime = Field(default_factory=now, sa_type=Timestamp)


class PolicyIn(SQLModel):
    """The fields a person sets (also the body of POST and PUT /policies)."""

    code: str = Field(description="e.g. POL-KYC, unique within the company")
    title: str
    owner: str = Field(description="Who gets the gap tickets")
    regulators: list[str] = Field(
        default_factory=list, sa_type=JSON, description='e.g. ["RBI", "SEBI"]'
    )
    text: str = Field(sa_type=Text, description="The current wording of the policy")


class Policy(PolicyIn, table=True):
    """A policy in a company's library. `version` goes up by one every time its text
    changes. The worker stores one embedding per chunk of "title + text", so nothing
    in a long policy is cut off; the api clears them when the title or text
    changes."""

    __tablename__ = "policies"
    __table_args__ = (
        UniqueConstraint("company_id", "code", name="uq_policies_company_code"),
    )

    id: int | None = Field(default=None, primary_key=True)
    company_id: int = Field(foreign_key="companies.id", index=True)
    version: int = 1
    updated_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    embeddings: list[list[float]] | None = Field(
        default=None, sa_type=JSON, exclude=True
    )
    embedding_model: str | None = Field(default=None, exclude=True)


class ControlIn(SQLModel):
    """The fields a person sets (also the body of POST /policies/{id}/controls)."""

    code: str = Field(description="e.g. CTL-KYC-01, unique within the policy")
    description: str
    owner: str
    frequency: str = Field(
        default="monthly", description="How often the control is performed"
    )


class Control(ControlIn, table=True):
    __tablename__ = "controls"
    __table_args__ = (
        UniqueConstraint("policy_id", "code", name="uq_controls_policy_code"),
    )

    id: int | None = Field(default=None, primary_key=True)
    policy_id: int = Field(foreign_key="policies.id", index=True)


class PolicyCheck(SQLModel, table=True):
    """Gemini's verdict on one circular against one version of a policy. A pair that
    has a row here is never sent to Gemini again: not after a restart, a failure
    halfway through, a change to the company description, or a new policy being
    added. `impacted` means the policy was out of date and a gap was opened."""

    __tablename__ = "policy_checks"
    __table_args__ = (UniqueConstraint("circular_id", "policy_id", "policy_version"),)

    id: int | None = Field(default=None, primary_key=True)
    circular_id: int = Field(foreign_key="circulars.id", index=True)
    policy_id: int = Field(foreign_key="policies.id", index=True)
    policy_version: int
    similarity: float
    impacted: bool
    checked_at: datetime = Field(default_factory=now, sa_type=Timestamp)


GapStatus = Literal["open", "in_progress", "closed", "dismissed"]
OPEN_STATUSES = ("open", "in_progress")


class Gap(SQLModel, table=True):
    """A ticket: `policy` (at `policy_version`) is out of date because of `circular`.
    One per circular and policy. `impact` says what the policy is missing,
    `draft_change` is the suggested wording for the owner to review, and `severity`
    is low, medium or high."""

    __tablename__ = "gaps"
    __table_args__ = (UniqueConstraint("circular_id", "policy_id"),)

    id: int | None = Field(default=None, primary_key=True)
    company_id: int = Field(foreign_key="companies.id", index=True)
    circular_id: int = Field(foreign_key="circulars.id", index=True)
    policy_id: int = Field(foreign_key="policies.id", index=True)
    policy_version: int
    title: str
    impact: str = Field(sa_type=Text)
    draft_change: str = Field(sa_type=Text)
    affected_controls: list[str] = Field(default_factory=list, sa_type=JSON)
    severity: str
    owner: str
    status: str = Field(default="open", index=True)
    due_date: date
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    updated_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    closed_at: datetime | None = Field(default=None, sa_type=Timestamp)


class GapEvent(SQLModel, table=True):
    """One line of a gap's history, never updated or deleted. `actor` is "agent",
    "system" or a person's email; `action` is opened, status, owner, due_date, comment
    or policy_updated."""

    __tablename__ = "gap_events"

    id: int | None = Field(default=None, primary_key=True)
    gap_id: int = Field(foreign_key="gaps.id", index=True)
    at: datetime = Field(default_factory=now, sa_type=Timestamp)
    actor: str
    action: str
    note: str = Field(default="", sa_type=Text)


class AppSecret(SQLModel, table=True):
    """Secrets the services make up themselves on first start, such as the key that
    signs login tokens, so they survive restarts without any setting."""

    __tablename__ = "app_secrets"

    name: str = Field(primary_key=True)
    value: str = Field(sa_type=Text, exclude=True)
