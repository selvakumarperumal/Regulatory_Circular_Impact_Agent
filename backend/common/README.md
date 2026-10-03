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

ocr_pages                                    a PDF's pages OCR'd so far (by its sha256)
```

| Table | Written by | What it holds |
|---|---|---|
| `companies` | api | each company: its name, and the description its people write |
| `users` | api | who can sign in, each in one company (scrypt password hashes) |
| `circulars` | watcher (new rows), worker (OCR text, summary, embedding, status) | one per regulator circular, **shared by every company** |
| `assessments` | worker, api (Reprocess, a new description) | one per company and circular: pending, done or failed, and whether it applies |
| `policies`, `controls` | api (the worker writes a policy's embeddings and `checked_at`) | each company's policy and control library |
| `gaps` | worker (opens them), api (status, owner, due date) | a policy that a circular made out of date |
| `gap_events` | worker, api | the history of each gap, never edited |
| `policy_checks` | worker (api deletes "up to date" ones on Reprocess) | Gemini's verdict on each circular and policy version, so no pair is asked about twice |
| `ocr_pages` | worker | each page of a PDF being OCR'd, saved as it's read so no page is OCR'd twice; deleted once the circular has its text |
| `app_secrets` | api | secrets made on first start, such as the login-token key |

`db.py`:

- `make_engine(url)`: the connection pool (`pool_pre_ping`).
- `init_db(engine)`: creates missing tables at startup, and adds any column a model gained
  since (nullable; nothing is dropped). Services starting together take turns.

`queue.py`: the task lanes. `LANES` maps each lane to its stream: `pdf` (`rci:tasks:pdf`,
reading a circular's PDF, minutes each) and `main` (`rci:tasks`, every other task, a few
Gemini calls each), so a quick task never waits behind a PDF. `lane(kind)` says which lane
a task type goes to. Also `GROUP` (`workers`, one per lane), `DEAD` (`rci:dead`),
`connect(url)`, and `enqueue(client, kind, **ids)`, which adds a task to its lane after the
caller has committed its change, unless the same task is already queued or running (its
dedupe key, `key(task)`, exists); it returns whether it added it. If Redis can't take the
task it raises, so the caller undoes its change or fails: the lanes are the workers' only
source of work, and a task is never dropped quietly. The task types and their lanes are
listed in its docstring.

This isn't a service. Each service installs it from `../common` as a path dependency (see
`[tool.uv.sources]` in its `pyproject.toml`), so every service keeps its own `.venv`.
