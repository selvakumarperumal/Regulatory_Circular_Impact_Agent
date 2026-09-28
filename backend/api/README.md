# api

FastAPI over accounts, each company's circulars, its policy and control library, and its gap
tickets. The interactive docs are at http://localhost:8000/docs.

**Logins.** Every route except sign-up, login and `/health` needs a login token:
`Authorization: Bearer <token>`. A token names the user and their company, and every route
reads and writes only that company's rows; another company's policy or gap is "not found".
Passwords are stored as scrypt hashes. Tokens are JWTs (HS256) signed with `JWT_SECRET`, or
with a key made on first start and kept in Postgres, and last `TOKEN_HOURS`.

**Tasks.** The api never calls OCR or Gemini. When a change needs the agent, it saves the
change, then adds a task to the Redis stream `rci:tasks` for the workers. If Redis is down
the change is still saved, and the workers' reconciler queues the task later.

| Method & path | What it does | Task queued |
|---|---|---|
| `GET /health` | 200 when the database answers (no login) | |
| `POST /auth/signup` | A new company and its first user; returns a token | `company.refresh` |
| `POST /auth/login` | Email and password; returns a token | |
| `GET /auth/me` | The signed-in user and their company | |
| `PUT /auth/password` | Change your password (needs the current one) | |
| `GET /users` · `POST /users` | The company's team; add a teammate with a first password | |
| `GET /stats` | The company's counts of circulars and gaps by status, and overdue gaps | |
| `GET /company` · `PUT /company` | The company's name and description. A new description clears the company's "does it apply?" answers | `company.refresh` |
| `GET /circulars?source=RBI&status=analyzed&limit=50` | Every circular, newest first, with this company's status and verdict | |
| `GET /circulars/{id}` | One circular: summary, obligations, this company's gaps, and the policies of this company it was checked against | |
| `GET /circulars/{id}/text` | The OCR text | |
| `POST /circulars/{id}/reprocess` | Read: judge it again for this company (no OCR); gaps are kept. Not read: read it again | `circular.assess` or `circular.read` |
| `GET /policies` · `POST /policies` | The company's policy library | `policy.check` |
| `GET /policies/{id}` | A policy, with its controls and gaps | |
| `PUT /policies/{id}` | Edit a policy. A text change raises the version and is noted on its open gaps | `policy.check` |
| `POST /policies/{id}/controls` | Add a control to a policy | |
| `GET /gaps?status=open&owner=…&policy_id=…&overdue=true` | The company's gaps, earliest due first | |
| `GET /gaps/{id}` | A gap, with its circular, its policy and its full history | |
| `PATCH /gaps/{id}` | Change status, owner or due date. A note is required to close or dismiss | |
| `POST /gaps/{id}/comments` | Add a comment | |

A circular's status as a company sees it: the circular's own (`new`, `parsed`, `failed`,
`skipped`) until it's read; then `parsed` while the company's assessment is pending,
`analyzed` once it's done, `failed` if judging it failed for good.

A gap moves `open → in_progress → closed | dismissed`, and can be reopened. Every change is
added to `gap_events` under the signed-in user's email. Nothing there is ever edited.

```bash
TOKEN=$(curl -s localhost:8000/auth/login -H 'content-type: application/json' \
  -d '{"email": "head.kyc@bank.example", "password": "…"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -H "Authorization: Bearer $TOKEN" "localhost:8000/gaps?overdue=true"
curl -X PATCH localhost:8000/gaps/1 -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"status": "closed", "note": "POL-KYC v2 approved by the board"}'
```

| File | Job |
|---|---|
| `main.py` | The app, `/health` and `/stats` |
| `auth.py` | Password hashing, login tokens, and `CurrentUser` (who is calling) |
| `routes/` | `auth.py` (sign-up, login, the team), `company.py`, `circulars.py`, `policies.py`, `gaps.py` |
| `database.py` | The session each request gets, `owned_or_404`, and `enqueue` for tasks |
| `manage.py` | Admin commands: `add-user` (a login, or a new password for one), `companies` |
| `config.py` | Settings, from the environment or `.env` |

**A login from the command line**, for any company (or a new password for an existing login):

```bash
uv run python manage.py add-user you@company.com "Your Name" --company 1   # asks for a password
uv run python manage.py companies                                          # every company and its users
```

```bash
cp .env.example .env
uv sync
uv run uvicorn main:app --reload
```
