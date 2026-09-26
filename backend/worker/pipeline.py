"""What the agent does with one circular.

1. parse    OCR the PDF from S3 with Unlimited-OCR                    status new -> parsed
2. analyze  summarise it: who it's addressed to, what changes, every obligation (Gemini).
            If the company has been described (the console's Company page): ask Gemini
            whether the circular applies to it, and if it does, find the closest internal
            policies (embeddings), ask Gemini whether each one is now out of date, and open
            a gap ticket with a draft change for the policy owner       status -> analyzed

A policy added or edited later is checked the same way against the recent circulars that
apply to the company (refresh_policies), so it doesn't wait for the next circular.
"""
import logging
import math
from datetime import date, datetime, timedelta, timezone

from sqlmodel import Session, select

import llm
import ocr
import storage
from common.models import Circular, Company, Control, Gap, GapEvent, Policy
from config import settings

log = logging.getLogger("pipeline")

DUE_DAYS = {"high": 7, "medium": 30, "low": 60}           # time the owner gets to close a gap


def process(session: Session, c: Circular) -> None:
    if c.status == "new":
        parse(session, c)
    analyze(session, c)


def parse(session: Session, c: Circular) -> None:
    c.text = ocr.pdf_to_text(storage.get_pdf(c.s3_key))
    c.status = "parsed"
    session.commit()                      # keep the OCR text even if the analysis fails
    log.info("#%d parsed: %d chars", c.id, len(c.text))


def company_profile(session: Session) -> str | None:
    """The company's description from the console, or None if nobody has written one yet."""
    company = session.get(Company, 1)
    return company.profile if company and company.profile.strip() else None


def analyze(session: Session, c: Circular) -> None:
    text = c.text or ""
    s = llm.summarize(c.source, c.title, text)
    c.addressed_to, c.summary, c.requirements = s.addressed_to, s.summary, s.requirements

    # Whether it applies depends on who the company is: without a description, don't guess.
    company = company_profile(session)
    if company:
        a = llm.check_applicability(company, c.source, c.title, s.addressed_to, text)
        c.applicable, c.applies_reason = a.applies_to_company, a.reason
    else:
        c.applicable, c.applies_reason = None, None

    opened = []
    candidates = closest_policies(session, c) if c.applicable and c.requirements else []
    for policy, score in candidates:
        if session.exec(select(Gap).where(Gap.circular_id == c.id, Gap.policy_id == policy.id)).first():
            continue                      # reprocessed circular: this gap was already raised
        gap = check_policy(session, c, policy, company)
        log.info("#%d vs %s (similarity %.2f): %s", c.id, policy.code, score, "GAP" if gap else "ok")
        if gap:
            opened.append(policy.code)
    c.status, c.error = "analyzed", None
    session.commit()
    applies = "not checked (no company description)" if c.applicable is None else c.applicable
    log.info("#%d analyzed: addressed to %r, applies to us: %s, gaps opened: %s",
             c.id, c.addressed_to[:80], applies, opened or "none")


def closest_policies(session: Session, c: Circular) -> list[tuple[Policy, float]]:
    """The MATCH_TOP_K policies for this regulator most similar to the circular."""
    policies = [p for p in session.exec(select(Policy)).all() if c.source in p.regulators and p.embedding]
    if not policies:
        return []
    query = llm.embed([f"{c.title}\n{c.summary}\n" + "\n".join(c.requirements or [])], "RETRIEVAL_QUERY")[0]
    scored = sorted(((p, cosine(query, p.embedding)) for p in policies), key=lambda x: x[1], reverse=True)
    return scored[:settings.MATCH_TOP_K]


def check_policy(session: Session, c: Circular, policy: Policy, company: str) -> Gap | None:
    controls = session.exec(select(Control).where(Control.policy_id == policy.id)).all()
    published = c.published_at.date() if c.published_at else "unknown date"
    circular_text = (f"CIRCULAR ({c.source}, {published}): {c.title}\n"
                     f"Addressed to: {c.addressed_to}\nSummary: {c.summary}\nRequirements:\n"
                     + "\n".join(f"- {r}" for r in c.requirements or []))
    policy_text = (f"POLICY {policy.code} v{policy.version}: {policy.title}\n{policy.text}\n\nCONTROLS:\n"
                   + "\n".join(f"- {k.code}: {k.description} ({k.frequency})" for k in controls))

    a = llm.assess(company, circular_text, policy_text)
    if not (a.impacted and a.missing_from_policy):
        return None
    known = {k.code for k in controls}
    gap = Gap(
        circular_id=c.id, policy_id=policy.id, policy_version=policy.version,
        title=f"Update {policy.code} for {c.source} circular: {c.title[:120]}",
        impact=a.missing_from_policy, draft_change=a.draft_change,
        affected_controls=[code for code in a.affected_controls if code in known],   # drop made-up codes
        severity=a.severity, owner=policy.owner,
        due_date=date.today() + timedelta(days=DUE_DAYS[a.severity]),
    )
    session.add(gap)
    session.flush()                       # gives gap.id
    session.add(GapEvent(gap_id=gap.id, actor="agent", action="opened", note=a.missing_from_policy))
    return gap


def refresh_policies(session: Session) -> None:
    """Embed the policies that are new, edited (the api clears the embedding) or embedded with
    another model (vectors from two models can't be compared), then check just those policies
    against the recent circulars that apply to us. One transaction: if Gemini fails halfway,
    nothing is saved and the next round starts over."""
    todo = [p for p in session.exec(select(Policy)).all()
            if not p.embedding or p.embedding_model != settings.GEMINI_EMBEDDING_MODEL_NAME]
    if not todo:
        return
    vectors = llm.embed([f"{p.title}\n{p.text}" for p in todo], "RETRIEVAL_DOCUMENT")
    for p, v in zip(todo, vectors, strict=True):
        p.embedding, p.embedding_model = v, settings.GEMINI_EMBEDDING_MODEL_NAME
    log.info("embedded %d policies with %s", len(todo), settings.GEMINI_EMBEDDING_MODEL_NAME)

    new_ids = {p.id for p in todo}
    company = company_profile(session)
    if not company:                       # nothing is known to apply to us yet: just keep the embeddings
        session.commit()
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.LOOKBACK_DAYS)
    recent = session.exec(select(Circular).where(
        Circular.status == "analyzed", Circular.applicable == True,   # noqa: E712  (SQL, not Python)
        Circular.published_at >= cutoff)).all()
    opened = 0
    for c in recent:
        if not c.requirements:
            continue
        for policy, score in closest_policies(session, c):
            if policy.id not in new_ids:
                continue
            if session.exec(select(Gap).where(Gap.circular_id == c.id, Gap.policy_id == policy.id)).first():
                continue
            gap = check_policy(session, c, policy, company)
            opened += bool(gap)
            log.info("#%d vs new/edited %s (similarity %.2f): %s", c.id, policy.code, score, "GAP" if gap else "ok")
    session.commit()
    log.info("checked %d policies against %d recent circulars: %d gaps opened", len(todo), len(recent), opened)


def cosine(a: list[float], b: list[float]) -> float:
    return math.sumprod(a, b) / math.sqrt(math.sumprod(a, a) * math.sumprod(b, b))
