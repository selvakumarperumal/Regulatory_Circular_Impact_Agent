# Regulatory Circular Impact Agent

Every day it watches RBI, SEBI and IRDAI circulars and reads each new one with
[Unlimited-OCR](https://github.com/baidu/Unlimited-OCR). It then asks **Gemini** (through
LangChain) whether the circular applies to the company and which internal policy it makes out
of date. For each such policy it opens a gap ticket for the owner, with a draft of the change,
and keeps a history of the gap until it is closed. The company's control library and the gap
history are data a chatbot will never have.

```
 RBI / SEBI / IRDAI sites
          │
      [watcher] ── PDF ──► S3 (Floci, on the host)         every hour: new circulars, status "new"
          │
      Postgres ◄──────────────┐
          │                   │
      [worker]  1. OCR each page ──────────► [ocr]  Unlimited-OCR on vLLM (GPU)
                2. is it for us?  ┐
                3. summarise      ├────────► Gemini (LangChain: chat + embeddings)
                4. closest policy ┤
                5. out of date?   ┘
                6. open a gap for the owner, with a draft change
          │
       [api]   FastAPI on :8000  — circulars, policies & controls, gaps & their history
          │
    [frontend] test console on :8080 (nginx, forwards /api to the api)
```

## Layout

One folder per service. Each Python service has its own `pyproject.toml`, `uv.lock`,
`.venv`, `Dockerfile`, `.env.example` and README.

| Folder | Service | What it does |
|---|---|---|
| [backend/watcher](backend/watcher) | `watcher` | Finds new circulars, stores the PDF in S3, adds a `circulars` row |
| [backend/ocr](backend/ocr) | `ocr` | Unlimited-OCR served by vLLM on the GPU (image and flags only) |
| [backend/worker](backend/worker) | `worker` | The agent: OCR → Gemini → gap tickets |
| [backend/api](backend/api) | `api` | FastAPI over circulars, policies, controls and gaps |
| [backend/common](backend/common) | none | The Postgres tables, installed into each service from `../common` |
| [frontend](frontend) | `frontend` | A test console over every API endpoint: static files served by nginx |

`docker-compose.yml` and `.env.example` are here at the root.

## Run it

You need these first:

- Docker with the NVIDIA runtime.
- Floci (a local AWS emulator, used here for S3) on port 4566, with a bucket named `rci`.
- A Gemini API key.

```bash
cp .env.example .env                        # set GEMINI_API_KEY (the rest have defaults)
docker compose up -d --build
docker compose logs -f worker               # watch the agent work
                                            # console: http://localhost:8080   API docs: http://localhost:8000/docs
```

The agent knows nothing about your company until you tell it, in the console:

1. **Company**: a few sentences on what kind of entity it is. Until this exists, circulars are
   summarised but nobody says which ones apply to you.
2. **Policies**: add them one at a time, or **Import JSON** for a whole library. A new or edited policy is checked against the
circulars of the last `LOOKBACK_DAYS` that apply to the company, so nothing waits for the
next circular.

Compose also takes settings from your shell, so a direnv `.envrc` that exports
`GEMINI_API_KEY` and `GEMINI_MODEL_NAME` works too.

The first start of `ocr` downloads the 6.7 GB model. Until it's ready, the worker logs
"OCR or Gemini unavailable" and keeps retrying. When the worker starts, it marks circulars
published more than `LOOKBACK_DAYS` ago as `skipped`, then works through the rest, newest
first.

## Where things are explained

- **[how_it_works.md](how_it_works.md): start here.** The whole backend explained with diagrams:
  the life of a circular, each service, the data, gap tracking, failures and settings.
- [backend/worker/README.md](backend/worker/README.md): how a circular moves through the
  pipeline, and what happens when OCR or Gemini fails.
- [backend/api/README.md](backend/api/README.md): every endpoint, and how gaps are tracked.
- [frontend/README.md](frontend/README.md): the test console, and how to run it without Docker.
- [backend/ocr/README.md](backend/ocr/README.md): why the vLLM flags are needed on an 8 GB GPU.
- [backend/common/README.md](backend/common/README.md): the tables.
- [.env.example](.env.example): every setting.

## Develop one service on the host

```bash
docker compose up -d postgres ocr           # what the services need
cd backend/worker
cp .env.example .env                        # host values: localhost:5432, localhost:4566, localhost:8001
uv sync
uv run python main.py --once
```

Each service's `config.py` is the only place that reads settings: from `.env` beside
`main.py`, with environment variables taking precedence.
