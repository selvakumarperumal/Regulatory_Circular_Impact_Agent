"""What kind of failure an exception is, so the worker knows whether to wait, retry
or give up. A circular that crashes MAX_TRIES times is given up on."""

import httpx
from google.genai import errors

MAX_TRIES = 3


class BadReply(Exception):
    """Gemini answered, but not in the requested JSON shape. Usually fine on a second
    try."""


def gemini_status(e: BaseException | None) -> int | None:
    """The HTTP status of a Gemini error. LangChain wraps it (GoogleRateLimitError,
    ...); the original google.genai error, which has the code, is the cause."""
    while e is not None:
        if isinstance(e, errors.APIError):
            return e.code
        e = e.__cause__
    return None


def service_down(e: Exception) -> bool:
    """Wait as long as it takes: the OCR model is still loading, or Gemini's quota is
    used up."""
    return isinstance(e, httpx.ConnectError) or gemini_status(e) == 429


def service_crashed(e: Exception) -> bool:
    """A temporary failure of OCR or Gemini: retry a few times."""
    if isinstance(e, (httpx.RemoteProtocolError, httpx.TimeoutException, BadReply)):
        return True
    if isinstance(e, httpx.HTTPStatusError):
        return e.response.status_code >= 500
    return (gemini_status(e) or 0) >= 500


def temporary(e: Exception) -> bool:
    return service_down(e) or service_crashed(e)
