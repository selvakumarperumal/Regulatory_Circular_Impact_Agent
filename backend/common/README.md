# common

The Postgres tables, shared by `watcher`, `worker` and `api`. They are defined once, here,
so the three services can't drift apart.

```
circulars  --<  gaps  >--  policies  --<  controls
    |            |
    |            +--<  gap_events
    |
    +--<  policy_checks  >--  policies

company    (one row)
```

| Table | Written by | What it holds |
|---|---|---|
| `circulars` | watcher (new rows), worker (OCR text, summary, status) | one per regulator circular |
| `company` | api | one row: the company description a person writes, used to decide which circulars apply |
| `policies`, `controls` | api | the company's policy and control library |
| `gaps` | worker (opens them), api (status, owner, due date) | a policy that a circular made out of date |
| `gap_events` | worker, api | the history of each gap, never edited |
| `policy_checks` | worker (api deletes "up to date" ones on Reprocess) | Gemini's verdict on each circular and policy version, so no pair is asked about twice |

`db.py` has three helpers:

- `make_engine(url)`: the connection pool (`pool_pre_ping`).
- `init_db(engine)`: creates missing tables and columns at startup, one service at a time.
- `lock_key(conn, name)`: the key for a Postgres advisory lock named `name`. It's a hash of
  the app, the connection's schema and the name, so copies of the app in separate schemas
  (one per company, say) or other software in the same database never share a lock.

This isn't a service. Each service installs it from `../common` as a path dependency (see
`[tool.uv.sources]` in its `pyproject.toml`), so every service keeps its own `.venv`.
