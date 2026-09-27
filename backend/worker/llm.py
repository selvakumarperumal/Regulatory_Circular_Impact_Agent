"""Everything that talks to Gemini, through LangChain (langchain-google-genai).

Replies are forced into JSON that matches a Pydantic model (`with_structured_output`),
so the rest of the code works with typed objects, not free text. LangChain retries rate
limits and server errors itself (max_retries) before the worker's own retries take over.

The three questions, in the order the pipeline asks them:
1. summarize            what does the circular say? (every circular, once)
2. check_applicability  does it apply to the company? (once the company is described)
3. assess               is this policy now out of date?"""

from functools import cache
from typing import Literal

from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from pydantic import BaseModel

from config import settings
from failures import BadReply

EMBED_DIMENSIONS = 768
APPLICABILITY_CHARS = 4000

chat = ChatGoogleGenerativeAI(
    model=settings.GEMINI_MODEL_NAME,
    google_api_key=settings.GEMINI_API_KEY,
    max_retries=3,
)
embedder = GoogleGenerativeAIEmbeddings(
    model=settings.GEMINI_EMBEDDING_MODEL_NAME, google_api_key=settings.GEMINI_API_KEY
)


def check() -> None:
    """Called at startup: a wrong key or model name fails here, not on every
    circular."""
    chat.invoke("Reply with OK.")
    embedder.embed_query("ok")


@cache
def structured(schema: type[BaseModel]):
    """The chat model bound to one reply schema, built once per schema."""
    return chat.with_structured_output(schema)


def ask[T: BaseModel](system: str, user: str, schema: type[T]) -> T:
    reply = structured(schema).invoke([("system", system), ("human", user)])
    if reply is None:
        raise BadReply(f"Gemini returned no valid {schema.__name__}")
    return reply


def embed(
    texts: list[str], task: Literal["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT"]
) -> list[list[float]]:
    """Packs the texts into as few requests as it can. Callers keep each text under
    the model's input limit (pipeline.EMBED_CHARS)."""
    return embedder.embed_documents(
        texts, task_type=task, output_dimensionality=EMBED_DIMENSIONS
    )


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


def summarize(source: str, title: str, text: str) -> CircularSummary:
    return ask(
        SUMMARY_PROMPT,
        f"Regulator: {source}\nTitle: {title}\n\n{text[:settings.LLM_MAX_CHARS]}",
        CircularSummary,
    )


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


def check_applicability(
    company: str, source: str, title: str, addressed_to: str, text: str
) -> Applicability:
    return ask(
        APPLICABILITY_PROMPT,
        f"THE COMPANY: {company}\n\nTHE CIRCULAR\nRegulator: {source}\nTitle: {title}\n"
        f"Addressed to: {addressed_to or 'not named'}\n\n{text[:APPLICABILITY_CHARS]}",
        Applicability,
    )


class Assessment(BaseModel):
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


def assess(company: str, circular: str, policy: str) -> Assessment:
    return ask(
        ASSESS_PROMPT, f"THE COMPANY: {company}\n\n{circular}\n\n{policy}", Assessment
    )
