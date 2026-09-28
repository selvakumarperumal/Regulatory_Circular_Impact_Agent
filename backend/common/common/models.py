"""The Postgres tables. Circulars are shared by every company and read once; everything
that depends on a company (does it apply, its policies, its gaps) is kept per company.

companies --< users
companies --< assessments >-- circulars
companies --< policies --< controls
policies  --< policy_checks >-- circulars
policies  --< gaps >-- circulars,  gaps --< gap_events"""

from datetime import UTC, date, datetime
from typing import Literal

from sqlalchemy import JSON, DateTime, Text, UniqueConstraint
from sqlmodel import Field, SQLModel

Timestamp = DateTime(timezone=True)


def now() -> datetime:
    return datetime.now(UTC)


class Company(SQLModel, table=True):
    """`profile` describes the company; circulars are judged for it once it's written."""

    __tablename__ = "companies"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    profile: str = Field(default="", sa_type=Text)
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    updated_at: datetime = Field(default_factory=now, sa_type=Timestamp)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: int | None = Field(default=None, primary_key=True)
    company_id: int = Field(foreign_key="companies.id", index=True)
    email: str = Field(unique=True, index=True)
    name: str
    password_hash: str = Field(exclude=True)
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)


class CircularBase(SQLModel):
    """What the api shows of a circular. Status: new -> parsed (OCR text saved) -> read
    (summarised and embedded), or failed / skipped."""

    source: str = Field(index=True, description="RBI, SEBI or IRDAI")
    source_key: str
    title: str
    detail_url: str
    pdf_url: str
    published_at: datetime | None = Field(default=None, sa_type=Timestamp)
    sha256: str
    s3_key: str
    status: str = Field(default="new", index=True)
    created_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    addressed_to: str | None = Field(default=None, sa_type=Text)
    summary: str | None = Field(default=None, sa_type=Text)
    requirements: list[str] | None = Field(default=None, sa_type=JSON)
    error: str | None = Field(default=None, sa_type=Text)


class Circular(CircularBase, table=True):
    __tablename__ = "circulars"
    __table_args__ = (UniqueConstraint("source", "source_key"),)

    id: int | None = Field(default=None, primary_key=True)
    text: str | None = Field(default=None, sa_type=Text, exclude=True)
    embedding: list[float] | None = Field(default=None, sa_type=JSON, exclude=True)
    embedding_model: str | None = Field(default=None, exclude=True)


class Assessment(SQLModel, table=True):
    """One company's view of one circular: pending, then done (or failed).
    `applicable` stays None while the company isn't described."""

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
    code: str = Field(description="e.g. POL-KYC, unique within the company")
    title: str
    owner: str = Field(description="Who gets the gap tickets")
    regulators: list[str] = Field(default_factory=list, sa_type=JSON)
    text: str = Field(sa_type=Text)


class Policy(PolicyIn, table=True):
    """`version` goes up when the text changes. The worker embeds "title + text" in
    chunks and sets `checked_at` when it has checked the policy against recent
    circulars; a policy saved after that is waiting for the worker."""

    __tablename__ = "policies"
    __table_args__ = (
        UniqueConstraint("company_id", "code", name="uq_policies_company_code"),
    )

    id: int | None = Field(default=None, primary_key=True)
    company_id: int = Field(foreign_key="companies.id", index=True)
    version: int = 1
    updated_at: datetime = Field(default_factory=now, sa_type=Timestamp)
    checked_at: datetime | None = Field(default=None, sa_type=Timestamp)
    embeddings: list[list[float]] | None = Field(
        default=None, sa_type=JSON, exclude=True
    )
    embedding_model: str | None = Field(default=None, exclude=True)


class ControlIn(SQLModel):
    code: str = Field(description="e.g. CTL-KYC-01, unique within the policy")
    description: str
    owner: str
    frequency: str = "monthly"


class Control(ControlIn, table=True):
    __tablename__ = "controls"
    __table_args__ = (
        UniqueConstraint("policy_id", "code", name="uq_controls_policy_code"),
    )

    id: int | None = Field(default=None, primary_key=True)
    policy_id: int = Field(foreign_key="policies.id", index=True)


class PolicyCheck(SQLModel, table=True):
    """Gemini's verdict on a circular against one policy version, never asked twice.
    `impacted` means a gap was opened."""

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
    """A policy made out of date by a circular: what's missing, a draft fix, a due
    date by severity. One per circular and policy."""

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
    """A gap's history, never edited. `actor` is agent, system or a user's email."""

    __tablename__ = "gap_events"

    id: int | None = Field(default=None, primary_key=True)
    gap_id: int = Field(foreign_key="gaps.id", index=True)
    at: datetime = Field(default_factory=now, sa_type=Timestamp)
    actor: str
    action: str
    note: str = Field(default="", sa_type=Text)


class AppSecret(SQLModel, table=True):
    """Secrets made on first start, such as the key that signs login tokens."""

    __tablename__ = "app_secrets"

    name: str = Field(primary_key=True)
    value: str = Field(sa_type=Text, exclude=True)
