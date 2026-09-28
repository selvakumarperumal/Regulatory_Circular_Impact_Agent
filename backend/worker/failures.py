"""Whether a failed task should wait for a service, be retried, or be given up."""

import httpx
from google.genai import errors
from sqlalchemy.exc import IntegrityError

MAX_TRIES = 3


class BadReply(Exception):
    """Gemini answered, but not in the requested JSON shape."""


def gemini_status(e: BaseException | None) -> int | None:
    """The HTTP status of a Gemini error, found under LangChain's wrapper."""
    while e is not None:
        if isinstance(e, errors.APIError):
            return e.code
        e = e.__cause__
    return None


def should_wait(e: Exception) -> bool:
    """OCR still loading, or Gemini's quota used up: wait as long as it takes."""
    return isinstance(e, httpx.ConnectError) or gemini_status(e) == 429


def should_retry(e: Exception) -> bool:
    """A timeout, a dropped connection, a 5xx or a bad reply; or another task saved
    the same verdict first (IntegrityError), which the retry then skips."""
    if isinstance(
        e, (httpx.RemoteProtocolError, httpx.TimeoutException, BadReply, IntegrityError)
    ):
        return True
    if isinstance(e, httpx.HTTPStatusError):
        return e.response.status_code >= 500
    return (gemini_status(e) or 0) >= 500
