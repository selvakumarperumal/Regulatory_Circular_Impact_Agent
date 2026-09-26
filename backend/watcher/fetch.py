"""One polite HTTP client: fixed delay between requests, small retry on network/5xx errors."""
import time

import httpx

client = httpx.Client(
    # rbidocs.rbi.org.in serves an HTML bot page (not the PDF) to non-browser user agents
    headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/130 Safari/537.36"},
    timeout=30,
    follow_redirects=True,
)
DELAY = 1.5


def get(url: str, retries: int = 3) -> httpx.Response:
    for attempt in range(1, retries + 1):
        time.sleep(DELAY)
        try:
            resp = client.get(url)
            resp.raise_for_status()
            return resp
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 429 and e.response.status_code < 500:
                raise
            if attempt == retries:
                raise
        except httpx.TransportError:
            if attempt == retries:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")
