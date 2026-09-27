"""What the agent does with one circular, and with a policy that's new or edited.

1. parse   OCR the PDF from S3 with Unlimited-OCR and save the text (status 'parsed').
           Once per PDF: the same file under another circular reuses the saved text.
2. read    Gemini summarises it: who it's addressed to, what changes, every obligation.
           Saved with an embedding of it. It doesn't depend on the company: done once.
3. judge   Once the company is described (the console's Company page): does the
           circular apply to it? Once per description; the api clears the answer when
           the description changes.
4. match   If it applies: the closest policies (embeddings, no Gemini call), then
           Gemini decides whether each one is now out of date. Each verdict is saved in
           policy_checks, so a (circular, policy version) pair is never asked twice.
           An out-of-date policy gets a gap ticket with a draft change. The circular
           is then 'analyzed'.

New and edited policies are embedded by embed_policies(); check_recent() then makes
sure every recent circular that applies has been checked against its closest
policies, asking Gemini only about pairs it hasn't judged. Each step commits as soon
as it's done, so a failure halfway loses nothing and the next round picks up where it
stopped."""

import logging
import math
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy.orm import defer
from sqlmodel import Session, col, func, select

import failures
import llm
import ocr
import storage
from common.models import Circular, Company, Control, Gap, GapEvent, Policy, PolicyCheck
from config import settings

log = logging.getLogger("pipeline")

DUE_DAYS = {"high": 7, "medium": 30, "low": 60}
EMBED_CHARS = 5000
MODEL = settings.GEMINI_EMBEDDING_MODEL_NAME

type Pairs = set[tuple[int, int, int | None]]


@dataclass
class CatchUp:
    """What check_recent remembers between rounds: the state of the library when it
    last finished (it does nothing while that's unchanged), and the circulars it gave
    up on for a reason retrying won't fix. Those are left alone until the worker
    restarts, so one bad circular can't cost a Gemini call every minute."""

    finished: tuple | None = None
    given_up: set[int] = field(default_factory=set)
    tries: Counter[int] = field(default_factory=Counter)


catch_up = CatchUp()


def process(session: Session, c: Circular) -> None:
    if c.status == "new":
        parse(session, c)
    analyze(session, c)


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


def analyze(session: Session, c: Circular) -> None:
    if c.summary is None:
        read(session, c)
    company = company_profile(session)
    if company and c.applicable is None:
        judge(session, c, company)
    opened = (
        check_against_policies(session, c, company)
        if c.applicable and c.requirements
        else []
    )
    c.status, c.error = "analyzed", None
    session.commit()
    applies = (
        "not judged (no company description)" if c.applicable is None else c.applicable
    )
    log.info(
        "#%d analyzed: addressed to %r, applies to us: %s, gaps opened: %s",
        c.id,
        (c.addressed_to or "")[:80],
        applies,
        opened or "none",
    )


def read(session: Session, c: Circular) -> None:
    s = llm.summarize(c.source, c.title, c.text or "")
    c.addressed_to = s.addressed_to
    c.summary = s.summary
    c.requirements = s.requirements
    c.embedding = None
    session.commit()


def judge(session: Session, c: Circular, company: str) -> None:
    a = llm.check_applicability(
        company, c.source, c.title, c.addressed_to or "", c.text or ""
    )
    c.applicable, c.applies_reason = a.applies_to_company, a.reason
    session.commit()


def check_against_policies(session: Session, c: Circular, company: str) -> list[str]:
    policies = [p for p in embedded_policies(session) if c.source in p.regulators]
    if not policies:
        return []
    embed_circulars(session, [c])
    return match(session, c, policies, company, checked_pairs(session, c.id))


def company_profile(session: Session) -> str | None:
    """The company's description from the console, or None if nobody has written one
    yet."""
    company = session.get(Company, 1)
    return company.profile if company and company.profile.strip() else None


def match(
    session: Session, c: Circular, policies: list[Policy], company: str, done: Pairs
) -> list[str]:
    """Ask Gemini about each of the circular's closest policies it hasn't judged yet,
    saving each verdict as it comes. Returns the codes of the policies that got a
    gap."""
    opened = []
    for policy, score in closest_policies(c, policies):
        pair = (c.id, policy.id, policy.version)
        if pair in done or (c.id, policy.id, None) in done:
            continue
        gap = check_policy(session, c, policy, company, score)
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
    session: Session, c: Circular, policy: Policy, company: str, score: float
) -> Gap | None:
    """Gemini's verdict on one policy, saved in policy_checks. If the policy is out
    of date, a gap is opened for its owner, with controls Gemini made up left out."""
    controls = session.exec(select(Control).where(Control.policy_id == policy.id)).all()
    a = llm.assess(company, describe_circular(c), describe_policy(policy, controls))
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


def checked_pairs(session: Session, circular_id: int | None = None) -> Pairs:
    """Every (circular, policy, version) Gemini has judged, plus (circular, policy,
    None) for each gap: a pair with a gap isn't checked again whatever the version
    (its owner is on it)."""
    checks = select(
        PolicyCheck.circular_id, PolicyCheck.policy_id, PolicyCheck.policy_version
    )
    gaps = select(Gap.circular_id, Gap.policy_id)
    if circular_id is not None:
        checks = checks.where(PolicyCheck.circular_id == circular_id)
        gaps = gaps.where(Gap.circular_id == circular_id)
    return {tuple(r) for r in session.exec(checks)} | {
        (c, p, None) for c, p in session.exec(gaps)
    }


def chunks(text: str) -> list[str]:
    """Pieces of at most EMBED_CHARS characters, well inside the embedding model's
    2,048 tokens."""
    return [text[i : i + EMBED_CHARS] for i in range(0, len(text), EMBED_CHARS)] or [""]


def embedded_policies(session: Session) -> list[Policy]:
    return [
        p
        for p in session.exec(select(Policy)).all()
        if p.embeddings and p.embedding_model == MODEL
    ]


def embed_policies(session: Session) -> None:
    """Embed the policies that are new, edited (the api clears their embeddings) or
    embedded with another model (vectors from two models can't be compared). All
    chunks of all of them go out in as few requests as possible."""
    todo = [
        p
        for p in session.exec(select(Policy)).all()
        if not p.embeddings or p.embedding_model != MODEL
    ]
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


def recent_and_applicable() -> tuple:
    cutoff = datetime.now(UTC) - timedelta(days=settings.LOOKBACK_DAYS)
    return (
        Circular.status == "analyzed",
        col(Circular.applicable).is_(True),
        Circular.published_at >= cutoff,
    )


def library_state(session: Session) -> tuple:
    """Changes whenever the company, a policy or the set of recent circulars that
    apply does."""
    company = session.get(Company, 1)
    policies = session.exec(select(func.count(), func.max(Policy.updated_at))).one()
    circulars = session.exec(
        select(func.count(), func.max(Circular.id)).where(*recent_and_applicable())
    ).one()
    return company and company.updated_at, settings.MATCH_TOP_K, *policies, *circulars


def recent_circulars(session: Session, policies: list[Policy]) -> list[Circular]:
    """Recent circulars that apply, have obligations and have a policy for their
    regulator. Their OCR text isn't needed here, so it isn't loaded."""
    regulators = {r for p in policies for r in p.regulators}
    query = (
        select(Circular).options(defer(Circular.text)).where(*recent_and_applicable())
    )
    return [
        c
        for c in session.exec(query).all()
        if c.requirements and c.source in regulators and c.id not in catch_up.given_up
    ]


def check_recent(session: Session) -> None:
    """Make sure every recent circular that applies to us has been checked against
    its closest policies, at their current version. That normally happens when the
    circular is analysed; this catches up after a policy is added or edited (text or
    regulators), and after an interruption. Only pairs Gemini hasn't judged are sent,
    and nothing is done while the company, the library and the recent circulars are
    unchanged. A service that's down ends the round; a crash is retried next round,
    up to MAX_TRIES times per circular."""
    state = library_state(session)
    if state == catch_up.finished:
        return
    profile = company_profile(session)
    policies = embedded_policies(session)
    recent = recent_circulars(session, policies) if profile else []
    if not recent:
        catch_up.finished = state
        return
    embed_circulars(session, recent)
    done, opened, unfinished = checked_pairs(session), [], False
    before = len(done)
    for c in recent:
        try:
            opened += match(session, c, policies, profile, done)
        except Exception as e:
            session.rollback()
            if failures.service_down(e):
                raise
            catch_up.tries[c.id] += 1
            if (
                failures.service_crashed(e)
                and catch_up.tries[c.id] < failures.MAX_TRIES
            ):
                unfinished = True
                log.warning("#%d: %s; trying again next round", c.id, e)
            else:
                catch_up.given_up.add(c.id)
                log.exception(
                    "#%d: couldn't check it against the policy library; skipping it",
                    c.id,
                )
    if len(done) > before:
        log.info(
            "caught up: %d new checks against %d recent circulars, gaps opened: %s",
            len(done) - before,
            len(recent),
            opened or "none",
        )
    if not unfinished:
        catch_up.finished = state


def cosine(a: list[float], b: list[float]) -> float:
    return math.sumprod(a, b) / math.sqrt(math.sumprod(a, a) * math.sumprod(b, b))
