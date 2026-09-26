# api

FastAPI over the circulars, the policy and control library, and the gap tickets. The
interactive docs are at http://localhost:8000/docs.

| Method & path | What it does |
|---|---|
| `GET /health` | 200 when the database answers |
| `GET /stats` | Counts of circulars and gaps by status, and how many gaps are overdue |
| `GET /company` · `PUT /company` | Your company description (null until written). Saving a change sends every analysed circular back to be judged against it (only "does it apply?" is asked again) |
| `GET /circulars?source=RBI&status=analyzed&limit=50` | List circulars, newest first |
| `GET /circulars/{id}` | One circular: summary, obligations, the gaps it opened, and the policies it was checked against (with the verdicts) |
| `GET /circulars/{id}/text` | The OCR text |
| `POST /circulars/{id}/reprocess` | Gemini reads it again from the saved OCR text (no new OCR); gaps are kept |
| `GET /policies` · `POST /policies` | The policy library |
| `GET /policies/{id}` | A policy, with its controls and gaps |
| `PUT /policies/{id}` | Edit a policy. A text change raises the version, is noted on its open gaps, and the worker re-checks recent circulars against it |
| `POST /policies/{id}/controls` | Add a control to a policy |
| `GET /gaps?status=open&owner=…&policy_id=…&overdue=true` | List gaps, earliest due first |
| `GET /gaps/{id}` | A gap, with its circular, its policy and its full history |
| `PATCH /gaps/{id}` | Change status, owner or due date. A note is required to close or dismiss |
| `POST /gaps/{id}/comments` | Add a comment |

A gap moves `open → in_progress → closed | dismissed`, and can be reopened. Every change is
added to `gap_events` with who made it and when. Nothing there is ever edited.

```bash
curl localhost:8000/gaps?overdue=true
curl -X PATCH localhost:8000/gaps/1 -H 'content-type: application/json' \
     -d '{"actor": "head.kyc@bank.example", "status": "closed", "note": "POL-KYC v2 approved by the board"}'
```

| File | Job |
|---|---|
| `main.py` | The app, `/health` and `/stats` |
| `routes/` | `circulars.py`, `policies.py` and `gaps.py`, one router each |
| `database.py` | The session each request gets |
| `config.py` | Settings, from the environment or `.env` |

```bash
cp .env.example .env
uv sync
uv run uvicorn main:app --reload
```
