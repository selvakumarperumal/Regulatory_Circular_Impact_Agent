"""One polite HTTP client: a fixed delay before every request, and a small retry on
network errors, 429s and 5xx. It sends a browser User-Agent because
rbidocs.rbi.org.in serves an HTML bot page, not the PDF, to anything else."""

import time

import httpx

DELAY = 1.5
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130 Safari/537.36"
)

client = httpx.Client(
    headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True
)


def retryable(e: httpx.HTTPError) -> bool:
    if isinstance(e, httpx.HTTPStatusError):
        return e.response.status_code == 429 or e.response.status_code >= 500
    return isinstance(e, httpx.TransportError)


def get(url: str, retries: int = 3) -> httpx.Response:
    for attempt in range(1, retries + 1):
        time.sleep(DELAY)
        try:
            resp = client.get(url)
            resp.raise_for_status()
            return resp
        except httpx.HTTPError as e:
            if attempt == retries or not retryable(e):
                raise
        time.sleep(2**attempt)
    raise RuntimeError("unreachable")
