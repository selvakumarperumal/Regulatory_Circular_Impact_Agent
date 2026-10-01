"""What the worker does for each task. Each step commits as soon as it's done and
every task checks the database first, so a retry resumes where it stopped and a task
delivered twice does nothing twice. A task returns the tasks to queue next."""

import logging
import math
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

import llm
import ocr
import storage
from common.models import (
    Assessment,
    Circular,
    Company,
    Control,
    Gap,
    GapEvent,
    OcrPage,
    Policy,
    PolicyCheck,
    now,
)
from config import settings

log = logging.getLogger("pipeline")

DUE_DAYS = {"high": 7, "medium": 30, "low": 60}
EMBED_CHARS = 5000
MODEL = settings.GEMINI_EMBEDDING_MODEL_NAME

type Tasks = list[tuple[str, dict[str, int]]]


def cutoff() -> datetime:
    return datetime.now(UTC) - timedelta(days=settings.LOOKBACK_DAYS)


def read_circular(session: Session, circular_id: int) -> Tasks:
    """circular.read: OCR the PDF, summarise and embed it, the same for every company.
    A twin (another circular with the same PDF) reuses its text and summary. Then
    each company gets a pending assessment and a circular.assess task."""
    c = session.get(Circular, circular_id)
    if c is None or c.status in ("skipped", "failed"):
        return []
    if c.status == "new" and c.published_at and c.published_at < cutoff():
        c.status = "skipped"
        session.commit()
        return []
    if c.status == "new":
        t = twin(session, c, Circular.text)
        c.text = t.text if t else ocr_text(session, c)
        if not c.text:
            raise ValueError("OCR found no text in the PDF")
        c.status = "parsed"
        session.execute(delete(OcrPage).where(OcrPage.sha256 == c.sha256))
        session.commit()
        log.info("#%d parsed: %d chars", c.id, len(c.text))
    if c.summary is None:
        s = twin(session, c, Circular.summary) or llm.summarize(c)
        c.addressed_to, c.summary, c.requirements = (
            s.addressed_to,
            s.summary,
            s.requirements,
        )
        c.embedding = None
        session.commit()
        log.info("#%d read: addressed to %r", c.id, c.addressed_to[:80])
    embed_circular(session, c)
    c.status, c.error = "read", None
    session.commit()
    companies = session.exec(select(Company.id)).all()
    add_assessments(session, [(company, c.id) for company in companies])
    return pending(session, Assessment.circular_id == c.id)


def ocr_text(session: Session, c: Circular) -> str:
    """OCR the PDF a page at a time, saving each page in ocr_pages the moment it's
    read, so a retry or a restarted worker carries on from the next page."""
    sha = c.sha256
    saved = select(OcrPage.page, OcrPage.text).where(OcrPage.sha256 == sha)
    done = dict(session.exec(saved).all())
    if done:
        log.info("#%d: %d pages OCR'd before, carrying on", c.id, len(done))
    for n, text in ocr.pages(storage.get_pdf(c.s3_key), skip=done):
        session.add(OcrPage(sha256=sha, page=n, text=text))
        session.commit()
        done[n] = text
    return "\n\n".join(done[n] for n in sorted(done) if done[n]).strip()


def twin(session: Session, c: Circular, has) -> Circular | None:
    """Another circular with the same PDF that already has `has` (text or summary)."""
    return session.exec(
        select(Circular).where(
            Circular.sha256 == c.sha256, Circular.id != c.id, col(has).is_not(None)
        )
    ).first()


def assess(session: Session, company_id: int, circular_id: int) -> Tasks:
    """circular.assess: does the circular apply to the company (once it's
    described)? If it does, Gemini checks the company's closest policies."""
    company = session.get(Company, company_id)
    c = session.get(Circular, circular_id)
    if company is None or c is None or c.status != "read":
        return []
    add_assessments(session, [(company_id, circular_id)])
    a = session.exec(
        select(Assessment).where(
            Assessment.company_id == company_id, Assessment.circular_id == circular_id
        )
    ).one()
    if a.status == "done":
        return []
    if company.profile and a.applicable is None:
        r = llm.check_applicability(company.profile, c)
        a.applicable, a.applies_reason = r.applies_to_company, r.reason
        session.commit()
    gaps = match(session, c, company) if a.applicable and c.requirements else []
    a.status, a.error, a.updated_at = "done", None, now()
    session.commit()
    log.info(
        "#%d for company %d: applies: %s, gaps opened: %s",
        c.id,
        company_id,
        a.applicable,
        gaps or "none",
    )
    return []


def check_policy(session: Session, company_id: int, policy_id: int) -> Tasks:
    """policy.check: embed a new or edited policy, then check each of the company's
    recent circulars that apply against their closest policies, the new one included.
    Only pairs never judged cost a Gemini call. Stamps the policy's checked_at, and
    checks it again if it was edited meanwhile."""
    started = now()
    p = session.get(Policy, policy_id)
    company = session.get(Company, company_id)
    if p is None or company is None or p.company_id != company_id:
        return []
    embed_policy(session, p)
    recent = session.exec(
        select(Circular)
        .options(defer(Circular.text))
        .join(Assessment, col(Assessment.circular_id) == Circular.id)
        .where(
            Assessment.company_id == company_id,
            Assessment.status == "done",
            col(Assessment.applicable).is_(True),
            Circular.published_at >= cutoff(),
        )
    ).all()
    gaps = []
    for c in recent:
        if c.requirements and c.source in p.regulators:
            gaps += match(session, c, company)
    p.checked_at = started
    session.commit()
    log.info("%s checked, gaps opened: %s", p.code, gaps or "none")
    if p.updated_at > started:
        return [("policy.check", {"company_id": company_id, "policy_id": policy_id})]
    return []


def refresh_company(session: Session, company_id: int) -> Tasks:
    """company.refresh, queued when a company's description is added or changed. Its
    answers given before that go back to pending, each circular read in the last
    LOOKBACK_DAYS gets an assessment, and each pending one is a circular.assess task.
    Only "does it apply?" is asked again: the OCR text, the summaries and the policy
    verdicts are kept. Queues itself again if the description changed meanwhile."""
    company = session.get(Company, company_id)
    if company is None:
        return []
    described_at = company.updated_at
    session.execute(
        update(Assessment)
        .where(
            Assessment.company_id == company_id,
            Assessment.status != "pending",
            Assessment.updated_at < described_at,
        )
        .values(
            status="pending",
            applicable=None,
            applies_reason=None,
            error=None,
            updated_at=now(),
        )
    )
    recent = session.exec(
        select(Circular.id).where(
            Circular.status == "read", Circular.published_at >= cutoff()
        )
    ).all()
    add_assessments(session, [(company_id, circular_id) for circular_id in recent])
    tasks = pending(session, Assessment.company_id == company_id)
    if company.updated_at > described_at:
        tasks.append(("company.refresh", {"company_id": company_id}))
    return tasks


def match(session: Session, c: Circular, company: Company) -> list[str]:
    """Gemini checks the circular against the company's MATCH_TOP_K closest policies
    for its regulator (by embedding similarity; a policy scores its best chunk),
    skipping pairs judged at this version or that have a gap. A policy not embedded
    with the current model (new, edited, or the model changed) is embedded first.
    Returns the codes of the policies that got a gap."""
    embed_circular(session, c)
    policies = [
        p
        for p in session.exec(select(Policy).where(Policy.company_id == company.id))
        if c.source in p.regulators
    ]
    for p in policies:
        embed_policy(session, p)
    scored = sorted(
        ((max(cosine(c.embedding, v) for v in p.embeddings), p) for p in policies),
        key=lambda pair: pair[0],
        reverse=True,
    )[: settings.MATCH_TOP_K]
    checks = select(PolicyCheck.policy_id, PolicyCheck.policy_version)
    judged = {
        tuple(r) for r in session.exec(checks.where(PolicyCheck.circular_id == c.id))
    }
    with_gap = set(session.exec(select(Gap.policy_id).where(Gap.circular_id == c.id)))
    opened = []
    for score, p in scored:
        if (p.id, p.version) in judged or p.id in with_gap:
            continue
        if judge_policy(session, c, p, company, score):
            opened.append(p.code)
    return opened


def judge_policy(
    session: Session, c: Circular, p: Policy, company: Company, score: float
) -> bool:
    """Gemini's verdict on one policy, saved in policy_checks. An out-of-date policy
    gets a gap for its owner in the same commit. Returns whether it did."""
    controls = session.exec(select(Control).where(Control.policy_id == p.id)).all()
    v = llm.assess(company.profile, c, p, controls)
    impacted = bool(v.impacted and v.missing_from_policy)
    session.add(
        PolicyCheck(
            circular_id=c.id,
            policy_id=p.id,
            policy_version=p.version,
            similarity=round(score, 4),
            impacted=impacted,
        )
    )
    if impacted:
        known = {k.code for k in controls}
        gap = Gap(
            company_id=company.id,
            circular_id=c.id,
            policy_id=p.id,
            policy_version=p.version,
            title=f"Update {p.code} for {c.source} circular: {c.title[:120]}",
            impact=v.missing_from_policy,
            draft_change=v.draft_change,
            affected_controls=[code for code in v.affected_controls if code in known],
            severity=v.severity,
            owner=p.owner,
            due_date=date.today() + timedelta(days=DUE_DAYS[v.severity]),
        )
        session.add(gap)
        session.flush()
        session.add(
            GapEvent(
                gap_id=gap.id,
                actor="agent",
                action="opened",
                note=v.missing_from_policy,
            )
        )
    session.commit()
    verdict = "GAP" if impacted else "up to date"
    log.info("#%d vs %s v%d (%.2f): %s", c.id, p.code, p.version, score, verdict)
    return impacted


def add_assessments(session: Session, pairs: list[tuple[int, int]]) -> None:
    """A pending assessment for each (company, circular) that has none yet."""
    if pairs:
        rows = [
            {
                "company_id": a,
                "circular_id": b,
                "status": "pending",
                "updated_at": now(),
            }
            for a, b in pairs
        ]
        session.execute(insert(Assessment).values(rows).on_conflict_do_nothing())
    session.commit()


def pending(session: Session, *where) -> Tasks:
    """The pending assessments of read circulars, as circular.assess tasks."""
    rows = session.exec(
        select(Assessment.company_id, Assessment.circular_id)
        .join(Circular, col(Circular.id) == Assessment.circular_id)
        .where(Assessment.status == "pending", Circular.status == "read", *where)
    )
    return [("circular.assess", {"company_id": a, "circular_id": b}) for a, b in rows]


def embed_circular(session: Session, c: Circular) -> None:
    if c.embedding and c.embedding_model == MODEL:
        return
    text = f"{c.title}\n{c.summary}\n" + "\n".join(c.requirements or [])
    c.embedding = llm.embed([text[:EMBED_CHARS]], "RETRIEVAL_QUERY")[0]
    c.embedding_model = MODEL
    session.commit()


def embed_policy(session: Session, p: Policy) -> None:
    """One vector per EMBED_CHARS chunk, so nothing in a long policy is cut off."""
    if p.embeddings and p.embedding_model == MODEL:
        return
    chunks = [
        f"{p.title}\n{p.text[i : i + EMBED_CHARS]}"
        for i in range(0, max(len(p.text), 1), EMBED_CHARS)
    ]
    p.embeddings = llm.embed(chunks, "RETRIEVAL_DOCUMENT")
    p.embedding_model = MODEL
    session.commit()
    log.info("embedded %s (%d chunks) with %s", p.code, len(chunks), MODEL)


def cosine(a: list[float], b: list[float]) -> float:
    return math.sumprod(a, b) / math.sqrt(math.sumprod(a, a) * math.sumprod(b, b))
