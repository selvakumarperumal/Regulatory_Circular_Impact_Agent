# worker

> 📘 **New to the worker?** Start with [The worker: doing the work](../../how_it_works.md#14-the-worker-doing-the-work):
> the task queue, several workers, and what its log lines mean. Then
> [How the worker works](../../how_the_worker_works.md) follows a new circular and a new
> policy step by step, queue and database included. Changing the code?
> [INTERNALS.md](INTERNALS.md) walks through all of it in 18 steps, then has every Redis
> command, SQL statement and commit.

The agent. It reads each circular the watcher saved, and works out, for each company, which of
its internal policies the circular makes out of date. For each one, it opens a gap ticket for
the policy owner with a draft of the change.

**Tasks, not polling.** Tasks wait in two **lanes**, each a Redis stream. Reading a PDF
takes minutes on the GPU, so `circular.read` has the `pdf` lane (`rci:tasks:pdf`); every
other task, a few Gemini calls each, has the `main` lane (`rci:tasks`). A quick task never
waits behind a PDF. The worker reads each lane in `LANES` as one consumer of that lane's
group `workers` (`XREADGROUP`), so each task goes to exactly one worker however many run,
and it starts the moment a task is queued. Each lane gets its own loop (a thread), taking
one task at a time. It acknowledges a task (`XACK`) only when it's done. A task is queued
at most once at a time (a dedupe key in Redis, deleted when the task is done), so workers
need no locks to share the work.

In Docker the same program runs as two services: **`reader`** (`LANES=pdf`, always one
copy: the GPU reads one page at a time, and one reader never reads the same PDF twice) and
**`worker`** (`LANES=main`, `WORKERS` copies, as many as your Gemini rate limit allows). On
the host, `LANES` defaults to `pdf,main`: one process does both, in two loops.

| Task | Lane | Queued by | What the worker does |
|---|---|---|---|
| `circular.read` | pdf | the watcher, Reprocess | steps 1 and 2 below, once for every company; then one `circular.assess` per company |
| `circular.assess` | main | the worker, Reprocess | steps 3 to 6 for one company |
| `policy.check` | main | the api (a policy saved) | embeds the policy, then steps 4 to 6 against the company's recent circulars; stamps its `checked_at` (the console then shows it as **Checked**) |
| `company.refresh` | main | the api (a description added or changed) | sets the company's older answers back to pending, and queues a `circular.assess` for each of its recent circulars |

```
new ──OCR──► parsed ──Gemini──► read ──► per company: pending ──► done   (failed: see `error`)
 └── published before LOOKBACK_DAYS ──► skipped
```

1. **OCR** (once per PDF): each page is rendered at 200 DPI and sent to Unlimited-OCR
   (the `ocr` service), up to `OCR_MAX_PAGES` pages. Each page's text is saved in
   `ocr_pages` the moment it's read, so a retry, a timeout or a restarted worker carries on
   from the next page; once the whole text is on the circular, those rows are deleted.
   Blank pages are never sent. A circular whose PDF is identical to one already read (same
   SHA-256) copies its text: no OCR at all.
2. **Summary** (once per PDF): Gemini finds who it's addressed to, sums up what it
   changes, and lists every obligation, keeping the numbers and deadlines as written. A
   circular with the same PDF copies it. The summary is embedded with
   `GEMINI_EMBEDDING_MODEL_NAME` for step 4.
3. **Is it for this company?** Only once the company has described itself on the console's
   Company page (there's no default). Gemini compares the addressees with that description
   and gives a one-line reason, saved in the company's `assessments` row. With no
   description, or if it doesn't apply, the company's assessment stops here.
4. **Closest policies**: the company's policies tagged with the circular's regulator are
   scored against the circular's embedding (long policies in 5,000-character chunks, scoring
   their best chunk), and the `MATCH_TOP_K` most similar go on. No Gemini call here.
5. **Out of date?** For each of those policies not judged before at its current version,
   Gemini gets the company description, the obligations, the policy text and its controls.
   It says what is missing, how severe it is, and which controls are affected, and drafts
   replacement wording. The verdict is saved in `policy_checks` straight away.
6. **Gap**: if the policy is out of date, a gap is opened for its owner. The due date
   depends on severity: high 7 days, medium 30, low 60.

**Nothing slow or paid for is done twice.** Each OCR'd page, the summary, the embeddings,
each company's "does it apply?" and every verdict are saved as they come. A task delivered
twice, a restart or an outage halfway through resumes where it stopped. While a task runs,
its worker claims it again every minute, so however long a PDF takes, no other worker
starts on it too.

| File | Job |
|---|---|
| `main.py` | The task loops, one per lane: take the next task, run it, then acknowledge, retry or give up |
| `pipeline.py` | What each task does: `read_circular`, `assess`, `check_policy`, `refresh_company` |
| `failures.py` | What counts as "wait", "try again" or "give up" |
| `ocr.py` | PDF to text through Unlimited-OCR |
| `llm.py` | Every Gemini call, through LangChain (`ChatGoogleGenerativeAI.with_structured_output`, `GoogleGenerativeAIEmbeddings`). Each prompt comes with the Pydantic model its reply must match |
| `storage.py` | Reads the PDFs from S3 |
| `config.py` | Settings, from the environment or `.env` |

**When something fails.**
- **OCR unreachable** (the model is still loading) **or Gemini rate-limited (429):** the
  task stays unacknowledged; its lane waits `RETRY_SECONDS` and tries again, as long as it
  takes. Only that lane waits: while OCR loads, the main lane carries on.
- **A 5xx, a timeout, a dropped connection or a reply not in the asked-for JSON:** the task
  is retried up to 3 times, then given up. So is a clash with another task that saved the
  same verdict first (`IntegrityError`): the retry skips it.
- **Given up:** the circular (or the company's assessment) is marked `failed` with the error,
  and the task is copied to the stream `rci:dead`, with the lane's stream it came from.
- **S3 unreachable (Floci not running) or the PDF missing:** this isn't waited out. The
  circular is marked `failed` at once; start Floci, then press **Reprocess**.
- **A worker dies mid-task:** the task is still pending. The same container finds it on
  restart; otherwise another worker takes it over once it has gone `CLAIM_IDLE_SECONDS` (5
  minutes) without its claim being renewed (`XAUTOCLAIM`). Either way, OCR carries on from
  the next unsaved page.
- **Redis is down:** the worker waits for it. Its own unfinished task stays on its pending
  list; if Redis failed while it was queueing the next tasks, the task runs again and queues
  them. The lanes are its only source of work: it never looks in Postgres for something to
  do. If Redis lost its data, `uv run python manage.py requeue` in `backend/api` queues every
  unfinished piece of work again.
- **A wrong API key or model name:** the worker stops at startup.

LangChain first retries Gemini rate limits and server errors itself (`max_retries=3`), and
raises its own error classes. The worker reads the HTTP code from the original Gemini
error underneath (`gemini_status` in `failures.py`).

```bash
cp .env.example .env                # set GEMINI_API_KEY
uv sync
uv run python main.py --once        # work until both lanes are empty, then exit
LANES=main uv run python main.py    # only the main lane (another process reads the PDFs)
```
