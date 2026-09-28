"""What the worker does for each task (the task types are in common/queue.py).

circular.read     A circular is read once, for every company:
                  1. parse  OCR the PDF and save the text (status 'parsed'). Once per
                            PDF: the same file under another circular reuses the text.
                  2. read   Gemini summarises it, and it's embedded (status 'read').
                  Every company then gets a pending assessment, and a circular.assess
                  task each.
circular.assess   For one company and one circular:
                  3. judge  does it apply to the company? (needs its description)
                  4. match  its closest policies (embeddings, no Gemini call), then
                            Gemini decides whether each is now out of date. Each verdict
                            is saved in policy_checks; an out-of-date policy gets a gap.
policy.check      A new or edited policy is embedded, then checked against the
                  company's recent circulars that apply (only pairs never judged).
company.refresh   A company's recent circulars get assessments, and circular.assess
                  tasks for the pending ones (after sign-up or a new description).

Each step commits as soon as it's done, so a task that fails halfway loses nothing
and its retry picks up where it stopped. Everything checks the database first, so a
task delivered twice is harmless."""

import logging
import math
from datetime import UTC, date, datetime, timedelta

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

import llm
import locks
import ocr
import storage
from common.models import (
    Assessment,
    Circular,
    Company,
    Control,
    Gap,
    GapEvent,
    Policy,
    PolicyCheck,
    now,
)
from config import settings

log = logging.getLogger("pipeline")

DUE_DAYS = {"high": 7, "medium": 30, "low": 60}
EMBED_CHARS = 5000
MODEL = settings.GEMINI_EMBEDDING_MODEL_NAME

type Pairs = set[tuple[int, int, int | None]]


def cutoff() -> datetime:
    return datetime.now(UTC) - timedelta(days=settings.LOOKBACK_DAYS)


# circular.read


def read_circular(session: Session, circular_id: int) -> list[int]:
    """Steps 1 and 2, once for every company. Returns the companies whose assessment
    of the circular is still pending, to queue a circular.assess task each."""
    c = session.get(Circular, circular_id)
    if c is None or c.status in ("skipped", "failed"):
        return []
    if c.status == "new" and c.published_at and c.published_at < cutoff():
        c.status = "skipped"
        session.commit()
        log.info("#%d skipped: published before %s", c.id, cutoff().date())
        return []
    if c.status == "new":
        with locks.held(session.get_bind(), locks.OCR, wait=True):
            parse(session, c)
    if c.summary is None:
        summarise(session, c)
    embed_circulars(session, [c])
    c.status, c.error = "read", None
    session.commit()
    return pending_companies(session, c.id)


def parse(session: Session, c: Circular) -> None:
    twin = session.exec(
        select(Circular).where(
            Circular.sha256 == c.sha256,
            Circular.id != c.id,
            col(Circular.text).is_not(None),
        )
    ).first()
    if twin and twin.text:
        c.text = twin.text
        log.info("#%d same PDF as #%d: reusing its OCR text", c.id, twin.id)
    else:
        c.text = ocr.pdf_to_text(storage.get_pdf(c.s3_key))
    if not c.text.strip():
        raise ValueError("OCR found no text in the PDF")
    c.status = "parsed"
    session.commit()
    log.info("#%d parsed: %d chars", c.id, len(c.text))


def summarise(session: Session, c: Circular) -> None:
    s = llm.summarize(c.source, c.title, c.text or "")
    c.addressed_to = s.addressed_to
    c.summary = s.summary
    c.requirements = s.requirements
    c.embedding = None
    session.commit()
    log.info("#%d read: addressed to %r", c.id, (c.addressed_to or "")[:80])


def pending_companies(session: Session, circular_id: int) -> list[int]:
    """Give every company an assessment of the circular (pending if it's new), and
    return the companies still to judge it."""
    for company_id in session.exec(select(Company.id)).all():
        add_assessment(session, company_id, circular_id)
    session.commit()
    return list(
        session.exec(
            select(Assessment.company_id).where(
                Assessment.circular_id == circular_id, Assessment.status == "pending"
            )
        ).all()
    )


def add_assessment(session: Session, company_id: int, circular_id: int) -> None:
    """A pending assessment, unless there's one already (two workers may try at
    once)."""
    session.execute(
        insert(Assessment)
        .values(company_id=company_id, circular_id=circular_id, status="pending")
        .on_conflict_do_nothing()
    )


# circular.assess


def assess(session: Session, company_id: int, circular_id: int) -> list[str]:
    """Steps 3 and 4 for one company. Returns the codes of the policies that got a
    gap."""
    company = session.get(Company, company_id)
    c = session.get(Circular, circular_id)
    if company is None or c is None or c.status != "read":
        return []
    add_assessment(session, company_id, circular_id)
    session.commit()
    a = session.exec(
        select(Assessment).where(
            Assessment.company_id == company_id, Assessment.circular_id == circular_id
        )
    ).one()
    if a.status == "done":
        return []
    profile = company.profile.strip()
    if profile and a.applicable is None:
        judge(session, a, c, profile)
    opened = []
    if a.applicable and c.requirements:
        policies = [
            p for p in embedded_policies(session, company_id) if c.source in p.regulators
        ]
        if policies:
            opened = match(
                session, c, policies, profile, checked_pairs(session, c.id), company_id
            )
    a.status, a.error, a.updated_at = "done", None, now()
    session.commit()
    applies = "not judged (no description)" if a.applicable is None else a.applicable
    log.info(
        "#%d for company %d: applies: %s, gaps opened: %s",
        c.id,
        company_id,
        applies,
        opened or "none",
    )
    return opened


def judge(session: Session, a: Assessment, c: Circular, profile: str) -> None:
    r = llm.check_applicability(
        profile, c.source, c.title, c.addressed_to or "", c.text or ""
    )
    a.applicable, a.applies_reason = r.applies_to_company, r.reason
    session.commit()


def match(
    session: Session,
    c: Circular,
    policies: list[Policy],
    profile: str,
    done: Pairs,
    company_id: int,
) -> list[str]:
    """Ask Gemini about each of the circular's closest policies it hasn't judged yet,
    saving each verdict as it comes. Returns the codes of the policies that got a
    gap. A circular read before embeddings were kept for every circular is embedded
    here, once."""
    embed_circulars(session, [c])
    opened = []
    for policy, score in closest_policies(c, policies):
        pair = (c.id, policy.id, policy.version)
        if pair in done or (c.id, policy.id, None) in done:
            continue
        gap = check_policy(session, c, policy, profile, score, company_id)
        session.commit()
        done.add(pair)
        log.info(
            "#%d vs %s v%d (similarity %.2f): %s",
            c.id,
            policy.code,
            policy.version,
            score,
            "GAP" if gap else "up to date",
        )
        if gap:
            opened.append(policy.code)
    return opened


def closest_policies(c: Circular, policies: list[Policy]) -> list[tuple[Policy, float]]:
    """The MATCH_TOP_K policies for this regulator most similar to the circular. A
    policy's score is its best chunk's, so a match deep inside a long policy still
    counts."""
    scored = [
        (p, max(cosine(c.embedding, v) for v in p.embeddings))
        for p in policies
        if c.source in p.regulators
    ]
    return sorted(scored, key=lambda x: x[1], reverse=True)[: settings.MATCH_TOP_K]


def check_policy(
    session: Session,
    c: Circular,
    policy: Policy,
    profile: str,
    score: float,
    company_id: int,
) -> Gap | None:
    """Gemini's verdict on one policy, saved in policy_checks. If the policy is out
    of date, a gap is opened for its owner, with controls Gemini made up left out."""
    controls = session.exec(select(Control).where(Control.policy_id == policy.id)).all()
    a = llm.assess(profile, describe_circular(c), describe_policy(policy, controls))
    impacted = bool(a.impacted and a.missing_from_policy)
    session.add(
        PolicyCheck(
            circular_id=c.id,
            policy_id=policy.id,
            policy_version=policy.version,
            similarity=round(score, 4),
            impacted=impacted,
        )
    )
    if not impacted:
        return None
    known_controls = {k.code for k in controls}
    gap = Gap(
        company_id=company_id,
        circular_id=c.id,
        policy_id=policy.id,
        policy_version=policy.version,
        title=f"Update {policy.code} for {c.source} circular: {c.title[:120]}",
        impact=a.missing_from_policy,
        draft_change=a.draft_change,
        affected_controls=[
            code for code in a.affected_controls if code in known_controls
        ],
        severity=a.severity,
        owner=policy.owner,
        due_date=date.today() + timedelta(days=DUE_DAYS[a.severity]),
    )
    session.add(gap)
    session.flush()
    session.add(
        GapEvent(
            gap_id=gap.id, actor="agent", action="opened", note=a.missing_from_policy
        )
    )
    return gap


def describe_circular(c: Circular) -> str:
    published = c.published_at.date() if c.published_at else "unknown date"
    requirements = "\n".join(f"- {r}" for r in c.requirements or [])
    return (
        f"CIRCULAR ({c.source}, {published}): {c.title}\n"
        f"Addressed to: {c.addressed_to}\n"
        f"Summary: {c.summary}\n"
        f"Requirements:\n{requirements}"
    )


def describe_policy(policy: Policy, controls: list[Control]) -> str:
    listed = "\n".join(f"- {k.code}: {k.description} ({k.frequency})" for k in controls)
    return (
        f"POLICY {policy.code} v{policy.version}: {policy.title}\n"
        f"{policy.text}\n\n"
        f"CONTROLS:\n{listed}"
    )


def checked_pairs(session: Session, circular_id: int) -> Pairs:
    """Every (circular, policy, version) Gemini has judged for this circular, plus
    (circular, policy, None) for each gap: a pair with a gap isn't checked again
    whatever the version (its owner is on it)."""
    checks = select(
        PolicyCheck.circular_id, PolicyCheck.policy_id, PolicyCheck.policy_version
    ).where(PolicyCheck.circular_id == circular_id)
    gaps = select(Gap.circular_id, Gap.policy_id).where(Gap.circular_id == circular_id)
    return {tuple(r) for r in session.exec(checks)} | {
        (c, p, None) for c, p in session.exec(gaps)
    }


# policy.check


def check_new_policy(session: Session, company_id: int, policy_id: int) -> list[str]:
    """Embed a new or edited policy, then check the company's recent circulars that
    apply against their closest policies, the new one included. Only pairs never
    judged cost a Gemini call. Returns the codes of the policies that got a gap."""
    policy = session.get(Policy, policy_id)
    company = session.get(Company, company_id)
    if policy is None or company is None or policy.company_id != company_id:
        return []
    embed_policies(session, [policy])
    profile = company.profile.strip()
    recent = [
        c for c in recent_applicable(session, company_id) if c.source in policy.regulators
    ]
    if not profile or not recent:
        return []
    embed_circulars(session, recent)
    opened = []
    for c in recent:
        policies = [
            p for p in embedded_policies(session, company_id) if c.source in p.regulators
        ]
        with locks.held(session.get_bind(), locks.ASSESS, f"{company_id}/{c.id}", True):
            opened += match(
                session, c, policies, profile, checked_pairs(session, c.id), company_id
            )
    log.info(
        "%s checked against %d recent circulars of company %d, gaps opened: %s",
        policy.code,
        len(recent),
        company_id,
        opened or "none",
    )
    return opened


def recent_applicable(session: Session, company_id: int) -> list[Circular]:
    """The company's circulars of the last LOOKBACK_DAYS that apply and have
    obligations. Their OCR text isn't needed, so it isn't loaded."""
    query = (
        select(Circular)
        .options(defer(Circular.text))
        .join(Assessment, col(Assessment.circular_id) == Circular.id)
        .where(
            Assessment.company_id == company_id,
            Assessment.status == "done",
            col(Assessment.applicable).is_(True),
            Circular.status == "read",
            Circular.published_at >= cutoff(),
        )
    )
    return [c for c in session.exec(query).all() if c.requirements]


# company.refresh


def refresh_company(session: Session, company_id: int) -> list[int]:
    """Give the company an assessment of every circular read in the last
    LOOKBACK_DAYS, and return the circulars it still has to judge. The api has
    already cleared the old answers if the description changed."""
    if session.get(Company, company_id) is None:
        return []
    recent = session.exec(
        select(Circular.id).where(
            Circular.status == "read", Circular.published_at >= cutoff()
        )
    ).all()
    for circular_id in recent:
        add_assessment(session, company_id, circular_id)
    session.commit()
    return list(
        session.exec(
            select(Assessment.circular_id)
            .join(Circular, col(Circular.id) == Assessment.circular_id)
            .where(
                Assessment.company_id == company_id,
                Assessment.status == "pending",
                Circular.status == "read",
            )
        ).all()
    )


# embeddings


def chunks(text: str) -> list[str]:
    """Pieces of at most EMBED_CHARS characters, well inside the embedding model's
    2,048 tokens."""
    return [text[i : i + EMBED_CHARS] for i in range(0, len(text), EMBED_CHARS)] or [""]


def embedded_policies(session: Session, company_id: int) -> list[Policy]:
    return [
        p
        for p in session.exec(select(Policy).where(Policy.company_id == company_id))
        if p.embeddings and p.embedding_model == MODEL
    ]


def embed_policies(session: Session, policies: list[Policy]) -> None:
    """Embed the policies that are new, edited (the api clears their embeddings) or
    embedded with another model (vectors from two models can't be compared). All
    chunks go out in as few requests as possible."""
    todo = [p for p in policies if not p.embeddings or p.embedding_model != MODEL]
    if not todo:
        return
    parts = {p.id: [f"{p.title}\n{part}" for part in chunks(p.text)] for p in todo}
    vectors = iter(
        llm.embed([t for texts in parts.values() for t in texts], "RETRIEVAL_DOCUMENT")
    )
    for p in todo:
        p.embeddings, p.embedding_model = [next(vectors) for _ in parts[p.id]], MODEL
    session.commit()
    log.info(
        "embedded %d policies (%d chunks) with %s",
        len(todo),
        sum(map(len, parts.values())),
        MODEL,
    )


def embed_circulars(session: Session, circulars: list[Circular]) -> None:
    todo = [c for c in circulars if not c.embedding or c.embedding_model != MODEL]
    if not todo:
        return
    texts = [
        f"{c.title}\n{c.summary}\n" + "\n".join(c.requirements or []) for c in todo
    ]
    for c, v in zip(
        todo,
        llm.embed([t[:EMBED_CHARS] for t in texts], "RETRIEVAL_QUERY"),
        strict=True,
    ):
        c.embedding, c.embedding_model = v, MODEL
    session.commit()


# the reconciler


def missing_work(session: Session) -> list[tuple[str, dict[str, int]]]:
    """Every piece of work Postgres shows as unfinished, as the task that does it.
    Queued by the reconciler in case a task went missing; a task queued twice is
    harmless."""
    tasks: list[tuple[str, dict[str, int]]] = [
        ("circular.read", {"circular_id": cid})
        for cid in session.exec(
            select(Circular.id).where(col(Circular.status).in_(["new", "parsed"]))
        )
    ]
    pending = session.exec(
        select(Assessment.company_id, Assessment.circular_id)
        .join(Circular, col(Circular.id) == Assessment.circular_id)
        .where(Assessment.status == "pending", Circular.status == "read")
    )
    tasks += [
        ("circular.assess", {"company_id": company, "circular_id": circular})
        for company, circular in pending
    ]
    tasks += [
        ("policy.check", {"company_id": p.company_id, "policy_id": p.id})
        for p in session.exec(select(Policy).options(defer(Policy.text)))
        if not p.embeddings or p.embedding_model != MODEL
    ]
    return tasks


def cosine(a: list[float], b: list[float]) -> float:
    return math.sumprod(a, b) / math.sqrt(math.sumprod(a, a) * math.sumprod(b, b))
