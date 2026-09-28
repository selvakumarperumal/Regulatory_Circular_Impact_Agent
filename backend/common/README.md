# common

The Postgres tables and the task queue, shared by `watcher`, `worker` and `api`. They are
defined once, here, so the three services can't drift apart.

```
companies  --<  users
    |
    +--<  assessments  >--  circulars        does this circular apply to this company?
    |                          |
    +--<  policies  --<  controls
             |
             +--<  gaps  >-- circulars       (each gap also carries its company_id)
             |      +--<  gap_events
             |
             +--<  policy_checks  >--  circulars
```

| Table | Written by | What it holds |
|---|---|---|
| `companies` | api | each company: its name, and the description its people write |
| `users` | api | who can sign in, each in one company (scrypt password hashes) |
| `circulars` | watcher (new rows), worker (OCR text, summary, embedding, status) | one per regulator circular, **shared by every company** |
| `assessments` | worker, api (Reprocess, a new description) | one per company and circular: pending, done or failed, and whether it applies |
| `policies`, `controls` | api (the worker writes the embeddings) | each company's policy and control library |
| `gaps` | worker (opens them), api (status, owner, due date) | a policy that a circular made out of date |
| `gap_events` | worker, api | the history of each gap, never edited |
| `policy_checks` | worker (api deletes "up to date" ones on Reprocess) | Gemini's verdict on each circular and policy version, so no pair is asked about twice |
| `app_secrets` | api | secrets made on first start, such as the login-token key |

`db.py`:

- `make_engine(url)`: the connection pool (`pool_pre_ping`).
- `init_db(engine)`: creates missing tables and columns at startup, one service at a time,
  and runs the one-off migrations: `move_single_company` (a database from before companies
  becomes company 1) and `per_company_codes` (policy codes unique per company).
- `lock_key(conn, name)`: the key for a Postgres advisory lock named `name`. It's a hash of
  the app, the connection's schema and the name, so copies of the app in separate schemas or
  other software in the same database never share a lock.

`queue.py`: the task stream. `STREAM` (`rci:tasks`), `GROUP` (`workers`), `DEAD`
(`rci:dead`), `connect(url)`, and `enqueue(client, kind, **ids)`, which adds a task after the
caller has committed its change, and only logs if Redis is down. The task types are listed in
its docstring.

This isn't a service. Each service installs it from `../common` as a path dependency (see
`[tool.uv.sources]` in its `pyproject.toml`), so every service keeps its own `.venv`.
