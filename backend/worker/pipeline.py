"""What the agent does with one circular, and with a policy that's new or edited.

1. parse    OCR the PDF from S3 with Unlimited-OCR and save the text   status new -> parsed
            (once per PDF: the same file under another circular reuses the saved text)
2. read     Gemini summarises it: who it's addressed to, what changes, every obligation.
            Saved, with an embedding of it; doesn't depend on the company, so done once.
3. judge    If the company has been described (the console's Company page): does the
            circular apply to it? Once per description.
4. match    If it applies: the closest policies (embeddings, no Gemini call), then Gemini
            decides whether each one is now out of date. Each verdict is saved in
            policy_checks, so a (circular, policy version) pair is never asked about twice;
            an out-of-date policy gets a gap ticket with a draft change   status -> analyzed

New and edited policies are embedded by embed_policies(); check_recent() then makes sure
every recent circular that applies has been checked against its closest policies, asking
Gemini only about pairs it hasn't judged. Each step commits as soon as it's done, so a
failure halfway loses nothing and the next round picks up where it stopped.
"""
import logging
import math
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import defer
from sqlmodel import Session, col, func, select

import failures
import llm
import ocr
import storage
from common.models import Circular, Company, Control, Gap, GapEvent, Policy, PolicyCheck
from config import settings

log = logging.getLogger("pipeline")

DUE_DAYS = {"high": 7, "medium": 30, "low": 60}     # time the owner gets to close a gap
EMBED_CHARS = 5000                                  # per embedded text: well inside the model's 2,048 tokens
MODEL = settings.GEMINI_EMBEDDING_MODEL_NAME

# check_recent: what the library looked like the last time it finished (it skips the work
# while nothing has changed), and circulars it couldn't check for a reason retrying won't fix
# (left alone until the worker restarts, so one bad circular can't cost a Gemini call a minute)
last_checked: tuple | None = None
given_up: set[int] = set()
tries: Counter[int] = Counter()


def process(session: Session, c: Circular) -> None:
    if c.status == "new":
        parse(session, c)
    analyze(session, c)


# ── 1. OCR ──────────────────────────────────────────────────────────────────

def parse(session: Session, c: Circular) -> None:
    twin = session.exec(select(Circular).where(
        Circular.sha256 == c.sha256, Circular.id != c.id, col(Circular.text).is_not(None))).first()
    if twin and twin.text:
        c.text = twin.text
        log.info("#%d same PDF as #%d: reusing its OCR text", c.id, twin.id)
    else:
        c.text = ocr.pdf_to_text(storage.get_pdf(c.s3_key))
    if not c.text.strip():
        raise ValueError("OCR found no text in the PDF")
    c.status = "parsed"
    session.commit()                      # the text is kept whatever happens next
    log.info("#%d parsed: %d chars", c.id, len(c.text))


# ── 2-4. read, judge, match ─────────────────────────────────────────────────

def company_profile(session: Session) -> str | None:
    """The company's description from the console, or None if nobody has written one yet."""
    company = session.get(Company, 1)
    return company.profile if company and company.profile.strip() else None


def analyze(session: Session, c: Circular) -> None:
    text = c.text or ""
    if c.summary is None:
        s = llm.summarize(c.source, c.title, text)
        c.addressed_to, c.summary, c.requirements = s.addressed_to, s.summary, s.requirements
        c.embedding = None
        session.commit()

    # Whether it applies depends on who the company is: without a description, don't guess.
    # The api resets `applicable` when the description changes.
    company = company_profile(session)
    if company and c.applicable is None:
        a = llm.check_applicability(company, c.source, c.title, c.addressed_to, text)
        c.applicable, c.applies_reason = a.applies_to_company, a.reason
        session.commit()

    opened = []
    policies = [p for p in embedded_policies(session) if c.source in p.regulators]
    if c.applicable and c.requirements and policies:
        embed_circulars(session, [c])
        opened = match(session, c, policies, company, checked_pairs(session, c.id))
    c.status, c.error = "analyzed", None
    session.commit()
    applies = "not judged (no company description)" if c.applicable is None else c.applicable
    log.info("#%d analyzed: addressed to %r, applies to us: %s, gaps opened: %s",
             c.id, (c.addressed_to or "")[:80], applies, opened or "none")


def match(session: Session, c: Circular, policies: list[Policy], company: str,
          done: set[tuple[int, int, int | None]]) -> list[str]:
    """Ask Gemini about each of the circular's closest policies it hasn't judged yet.
    Returns the codes of the policies that got a gap."""
    opened = []
    for policy, score in closest_policies(c, policies):
        pair = (c.id, policy.id, policy.version)
        if pair in done or (c.id, policy.id, None) in done:
            continue
        gap = check_policy(session, c, policy, company, score)
        session.commit()                  # this verdict is kept even if the next one fails
        done.add(pair)
        log.info("#%d vs %s v%d (similarity %.2f): %s", c.id, policy.code, policy.version, score,
                 "GAP" if gap else "up to date")
        if gap:
            opened.append(policy.code)
    return opened


def closest_policies(c: Circular, policies: list[Policy]) -> list[tuple[Policy, float]]:
    """The MATCH_TOP_K policies for this regulator most similar to the circular. A policy's
    score is its best chunk's, so a match deep inside a long policy still counts."""
    scored = [(p, max(cosine(c.embedding, v) for v in p.embeddings))
              for p in policies if c.source in p.regulators]
    return sorted(scored, key=lambda x: x[1], reverse=True)[:settings.MATCH_TOP_K]


def check_policy(session: Session, c: Circular, policy: Policy, company: str, score: float) -> Gap | None:
    controls = session.exec(select(Control).where(Control.policy_id == policy.id)).all()
    published = c.published_at.date() if c.published_at else "unknown date"
    circular_text = (f"CIRCULAR ({c.source}, {published}): {c.title}\n"
                     f"Addressed to: {c.addressed_to}\nSummary: {c.summary}\nRequirements:\n"
                     + "\n".join(f"- {r}" for r in c.requirements or []))
    policy_text = (f"POLICY {policy.code} v{policy.version}: {policy.title}\n{policy.text}\n\nCONTROLS:\n"
                   + "\n".join(f"- {k.code}: {k.description} ({k.frequency})" for k in controls))

    a = llm.assess(company, circular_text, policy_text)
    impacted = bool(a.impacted and a.missing_from_policy)
    session.add(PolicyCheck(circular_id=c.id, policy_id=policy.id, policy_version=policy.version,
                            similarity=round(score, 4), impacted=impacted))
    if not impacted:
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


def checked_pairs(session: Session, circular_id: int | None = None) -> set[tuple[int, int, int | None]]:
    """Every (circular, policy, version) Gemini has judged, plus (circular, policy, None) for
    each gap: a pair with a gap isn't checked again whatever the version (its owner is on it)."""
    checks = select(PolicyCheck.circular_id, PolicyCheck.policy_id, PolicyCheck.policy_version)
    gaps = select(Gap.circular_id, Gap.policy_id)
    if circular_id is not None:
        checks, gaps = checks.where(PolicyCheck.circular_id == circular_id), gaps.where(Gap.circular_id == circular_id)
    return {tuple(r) for r in session.exec(checks)} | {(c, p, None) for c, p in session.exec(gaps)}


# ── Embeddings ──────────────────────────────────────────────────────────────

def chunks(text: str) -> list[str]:
    return [text[i:i + EMBED_CHARS] for i in range(0, len(text), EMBED_CHARS)] or [""]


def embedded_policies(session: Session) -> list[Policy]:
    return [p for p in session.exec(select(Policy)).all() if p.embeddings and p.embedding_model == MODEL]


def embed_policies(session: Session) -> None:
    """Embed the policies that are new, edited (the api clears their embeddings) or embedded
    with another model (vectors from two models can't be compared). All chunks of all of them
    go out in as few requests as possible."""
    todo = [p for p in session.exec(select(Policy)).all() if not p.embeddings or p.embedding_model != MODEL]
    if not todo:
        return
    parts = {p.id: [f"{p.title}\n{part}" for part in chunks(p.text)] for p in todo}
    vectors = iter(llm.embed([t for texts in parts.values() for t in texts], "RETRIEVAL_DOCUMENT"))
    for p in todo:
        p.embeddings, p.embedding_model = [next(vectors) for _ in parts[p.id]], MODEL
    session.commit()
    log.info("embedded %d policies (%d chunks) with %s", len(todo), sum(map(len, parts.values())), MODEL)


def embed_circulars(session: Session, circulars: list[Circular]) -> None:
    todo = [c for c in circulars if not c.embedding or c.embedding_model != MODEL]
    if not todo:
        return
    texts = [f"{c.title}\n{c.summary}\n" + "\n".join(c.requirements or []) for c in todo]
    for c, v in zip(todo, llm.embed([t[:EMBED_CHARS] for t in texts], "RETRIEVAL_QUERY"), strict=True):
        c.embedding, c.embedding_model = v, MODEL
    session.commit()


def check_recent(session: Session) -> None:
    """Make sure every recent circular that applies to us has been checked against its closest
    policies, at their current version. That normally happens when the circular is analysed;
    this catches up after a policy is added or edited (text or regulators), and after an
    interruption. Only pairs Gemini hasn't judged are sent, and the whole thing is skipped
    while the company, the library and the recent circulars are unchanged."""
    global last_checked
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.LOOKBACK_DAYS)
    applies = (Circular.status == "analyzed", Circular.applicable == True,   # noqa: E712  (SQL, not Python)
               Circular.published_at >= cutoff)
    company = session.get(Company, 1)
    state = (company and company.updated_at, settings.MATCH_TOP_K,
             *session.exec(select(func.count(), func.max(Policy.updated_at))).one(),
             *session.exec(select(func.count(), func.max(Circular.id)).where(*applies)).one())
    if state == last_checked:
        return
    profile = company_profile(session)
    policies = embedded_policies(session)
    regulators = {r for p in policies for r in p.regulators}
    recent = [c for c in session.exec(select(Circular).options(defer(Circular.text)).where(*applies)).all()
              if c.requirements and c.source in regulators and c.id not in given_up]   # (no OCR text needed)
    if profile and recent:
        embed_circulars(session, recent)
        done, opened, retry = checked_pairs(session), [], False
        before = len(done)
        for c in recent:
            try:
                opened += match(session, c, policies, profile, done)
            except Exception as e:
                session.rollback()
                if failures.service_down(e):
                    raise                 # wait; the next round picks up from here
                tries[c.id] += 1
                if failures.service_crashed(e) and tries[c.id] < failures.MAX_TRIES:
                    retry = True
                    log.warning("#%d: %s; trying again next round", c.id, e)
                else:
                    given_up.add(c.id)
                    log.exception("#%d: couldn't check it against the policy library; skipping it", c.id)
        if len(done) > before:
            log.info("caught up: %d new checks against %d recent circulars, gaps opened: %s",
                     len(done) - before, len(recent), opened or "none")
        if retry:
            return                        # not finished: run again next round
    last_checked = state


def cosine(a: list[float], b: list[float]) -> float:
    return math.sumprod(a, b) / math.sqrt(math.sumprod(a, a) * math.sumprod(b, b))
