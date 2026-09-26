# common

The Postgres tables, shared by `watcher`, `worker` and `api`. They are defined once, here,
so the three services can't drift apart.

```
circulars  --<  gaps  >--  policies  --<  controls
                 |
                 +--<  gap_events

company    (one row)
```

| Table | Written by | What it holds |
|---|---|---|
| `circulars` | watcher (new rows), worker (OCR text, summary, status) | one per regulator circular |
| `company` | api | one row: the company description a person writes, used to decide which circulars apply |
| `policies`, `controls` | api | the company's policy and control library |
| `gaps` | worker (opens them), api (status, owner, due date) | a policy that a circular made out of date |
| `gap_events` | worker, api | the history of each gap, never edited |

This isn't a service. Each service installs it from `../common` as a path dependency (see
`[tool.uv.sources]` in its `pyproject.toml`), so every service keeps its own `.venv`.
