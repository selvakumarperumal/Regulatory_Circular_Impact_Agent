# watcher

> 📘 **New to the watcher?** [How the watcher works](../../how_the_watcher_works.md) follows
> one hourly round step by step, with a diagram for each step: reading each regulator, the
> PDF in S3, the row in Postgres, the task for the workers, and what happens when something
> fails.

Every `INTERVAL_MINUTES` it checks the RBI, SEBI and IRDAI sites for circulars it hasn't seen.
For each new one it downloads the PDF, stores it in S3 as `<source>/<sha256>.pdf`, adds a
`circulars` row with status `new`, and queues a `circular.read` task on the Redis stream,
which a worker picks up at once.

| File | Job |
|---|---|
| `main.py` | The loop: list each source, skip known circulars, save new ones and queue their tasks |
| `sources.py` | Where circulars come from: RBI's RSS feed, and the SEBI and IRDAI listing pages |
| `fetch.py` | One polite HTTP client: a delay between requests, retries on 5xx |
| `storage.py` | Writes the PDFs to S3 |
| `config.py` | Settings, from the environment or `.env` |

A circular is saved with its task, or not at all. If it fails (its PDF link is broken, S3
can't be reached because Floci isn't running, or Redis can't take the task), nothing about it
is kept: the row is deleted again if it was already saved, and the next round tries it
again. The task is queued only after the row is committed, so a worker always finds it; the
task stream is the workers' only source of work.

Run **one** watcher (compose pins `replicas: 1`): two would both find the same new circular.

```bash
cp .env.example .env
uv sync
uv run python main.py               # one pass over all three sources
uv run python main.py --only RBI    # just one source
```

In Docker it runs from the repo root (`docker compose up -d watcher`) with `INTERVAL_MINUTES=60`.
