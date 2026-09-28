"""Gemini, through LangChain. Each question's reply is forced into JSON matching a
Pydantic model (with_structured_output). LangChain retries rate limits and server
errors itself before the worker's own retries.

1. summarize            what does the circular say? (once per circular)
2. check_applicability  does it apply to the company? (once per company)
3. assess               is this policy now out of date?"""

from functools import cache
from typing import Literal

from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from pydantic import BaseModel

from common.models import Circular, Control, Policy
from config import settings
from failures import BadReply

chat = ChatGoogleGenerativeAI(
    model=settings.GEMINI_MODEL_NAME,
    google_api_key=settings.GEMINI_API_KEY,
    max_retries=3,
)
embedder = GoogleGenerativeAIEmbeddings(
    model=settings.GEMINI_EMBEDDING_MODEL_NAME, google_api_key=settings.GEMINI_API_KEY
)


def check() -> None:
    """At startup, so a wrong key or model name fails once, clearly."""
    chat.invoke("Reply with OK.")
    embedder.embed_query("ok")


@cache
def structured(schema: type[BaseModel]):
    return chat.with_structured_output(schema)


def ask[T: BaseModel](system: str, user: str, schema: type[T]) -> T:
    reply = structured(schema).invoke([("system", system), ("human", user)])
    if reply is None:
        raise BadReply(f"Gemini returned no valid {schema.__name__}")
    return reply


def embed(
    texts: list[str], task: Literal["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT"]
) -> list[list[float]]:
    return embedder.embed_documents(texts, task_type=task, output_dimensionality=768)


class CircularSummary(BaseModel):
    addressed_to: str
    summary: str
    requirements: list[str]


SUMMARY_PROMPT = """\
You are a compliance analyst. Read the regulatory circular and reply in JSON:
- addressed_to: who the circular is addressed to or applies to, as written in it (its
  "To" block, salutation or applicability clause, e.g. "All Commercial Banks"). Empty if
  it names no one.
- summary: 2-4 plain sentences on what the circular changes.
- requirements: every concrete obligation it creates or changes (what must be done, by
  whom, by when), one per item. Keep numbers, time limits, thresholds and dates exactly
  as written. Do not write generic items like "comply with the circular". Empty list if
  informational only."""


def summarize(c: Circular) -> CircularSummary:
    text = (c.text or "")[: settings.LLM_MAX_CHARS]
    user = f"Regulator: {c.source}\nTitle: {c.title}\n\n{text}"
    return ask(SUMMARY_PROMPT, user, CircularSummary)


class Applicability(BaseModel):
    reason: str
    applies_to_company: bool


APPLICABILITY_PROMPT = """\
You work in the compliance team of the company described below. Decide whether a
regulatory circular applies to it. Reply in JSON:
- reason: one sentence naming the addressee that matches the company, or saying why none
  does.
- applies_to_company: true if the company is one of the addressees, or must act on the
  circular in one of its roles. False if it is only for other kinds of entities. With no
  named addressee (e.g. amended regulations), true if its subject touches any of the
  company's businesses."""


def check_applicability(company: str, c: Circular) -> Applicability:
    """Only the start of the text is sent: that's where a circular says who it's for."""
    user = (
        f"THE COMPANY: {company}\n\nTHE CIRCULAR\nRegulator: {c.source}\n"
        f"Title: {c.title}\nAddressed to: {c.addressed_to or 'not named'}\n\n"
        f"{(c.text or '')[:4000]}"
    )
    return ask(APPLICABILITY_PROMPT, user, Applicability)


class Verdict(BaseModel):
    missing_from_policy: str
    impacted: bool
    severity: Literal["low", "medium", "high"]
    affected_controls: list[str]
    draft_change: str


ASSESS_PROMPT = """\
You check whether one internal policy of the company is out of date because of a new
regulatory circular that applies to the company. The policy is out of date only if the
circular creates or changes an obligation within this policy's scope that the policy
text does not already meet. Reply in JSON:
- missing_from_policy: what the circular requires that the policy does not already say,
  quoting numbers and time limits. Empty if the circular is about something this policy
  does not cover, or the policy already complies.
- impacted: true only if missing_from_policy is not empty.
- severity: high = the company would breach the circular or face penalties; medium = a
  process or document must change; low = wording or reference update only.
- affected_controls: codes of the listed controls that must change (may be empty).
- draft_change: if impacted, the new or replacement clause, written as policy text the
  owner can paste in, saying which clause it replaces or where it goes. Only the changed
  wording. Empty if not impacted."""


def assess(company: str, c: Circular, p: Policy, controls: list[Control]) -> Verdict:
    published = c.published_at.date() if c.published_at else "unknown date"
    requirements = "\n".join(f"- {r}" for r in c.requirements or [])
    listed = "\n".join(f"- {k.code}: {k.description} ({k.frequency})" for k in controls)
    user = (
        f"THE COMPANY: {company}\n\n"
        f"CIRCULAR ({c.source}, {published}): {c.title}\n"
        f"Addressed to: {c.addressed_to}\nSummary: {c.summary}\n"
        f"Requirements:\n{requirements}\n\n"
        f"POLICY {p.code} v{p.version}: {p.title}\n{p.text}\n\nCONTROLS:\n{listed}"
    )
    return ask(ASSESS_PROMPT, user, Verdict)
