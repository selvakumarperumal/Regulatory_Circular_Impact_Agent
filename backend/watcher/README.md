# watcher

Every `INTERVAL_MINUTES` it checks the RBI, SEBI and IRDAI sites for circulars it hasn't seen.
For each new one it downloads the PDF, stores it in S3 as `<source>/<sha256>.pdf`, and adds a
`circulars` row with status `new` for the worker.

| File | Job |
|---|---|
| `main.py` | The loop: list each source, skip known circulars, save new ones |
| `sources.py` | Where circulars come from: RBI's RSS feed, and the SEBI and IRDAI listing pages |
| `fetch.py` | One polite HTTP client: a delay between requests, retries on 5xx |
| `storage.py` | Writes the PDFs to S3 |
| `config.py` | Settings, from the environment or `.env` |

A circular that fails (for example, its PDF link is broken) is not saved, so the next round
tries it again.

```bash
cp .env.example .env
uv sync
uv run python main.py               # one pass over all three sources
uv run python main.py --only RBI    # just one source
```

In Docker it runs from the repo root (`docker compose up -d watcher`) with `INTERVAL_MINUTES=60`.
