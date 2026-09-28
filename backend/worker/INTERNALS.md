# How the worker works, in depth

![Python 3.14](https://img.shields.io/badge/Python_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white) ![SQLModel](https://img.shields.io/badge/SQLModel-7E56C2?style=flat-square) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Gemini via LangChain](https://img.shields.io/badge/Gemini_via_LangChain-8E75B2?style=flat-square&logo=googlegemini&logoColor=white) ![Unlimited-OCR on vLLM](https://img.shields.io/badge/Unlimited--OCR_on_vLLM-EA580C?style=flat-square) ![Docker Compose](https://img.shields.io/badge/Docker_Compose-2496ED?style=flat-square&logo=docker&logoColor=white) ![Redis 7](https://img.shields.io/badge/Redis_7-DC382D?style=flat-square&logo=redis&logoColor=white)

This is the full story of the **worker**: every task it takes, every Redis command, every row
it reads and writes, and every commit. For the plain-words version with worked
examples, read [How the worker works](../../how_the_worker_works.md) first; this guide goes
all the way down. The code is in this folder, and the queue's names are in
[`common/queue.py`](../common/common/queue.py).

**Reading the diagrams.** Each colour means the same thing in every diagram:

![our services](https://img.shields.io/badge/our_services-2dd4bf?style=flat-square) ![data](https://img.shields.io/badge/data-818cf8?style=flat-square) ![Gemini and outside services](https://img.shields.io/badge/Gemini_and_outside_services-c084fc?style=flat-square) ![OCR on the GPU](https://img.shields.io/badge/OCR_on_the_GPU-fb923c?style=flat-square) ![a decision](https://img.shields.io/badge/a_decision-fbbf24?style=flat-square) ![done, or OK](https://img.shields.io/badge/done,_or_OK-34d399?style=flat-square) ![a failure, or a gap](https://img.shields.io/badge/a_failure,_or_a_gap-fb7185?style=flat-square) ![where it starts](https://img.shields.io/badge/where_it_starts-a7ef6f?style=flat-square) ![the task queue](https://img.shields.io/badge/the_task_queue_in_Redis-38bdf8?style=flat-square) ![the task queue](https://img.shields.io/badge/the_task_queue_in_Redis-38bdf8?style=flat-square)

**Contents**

1. [The worker at a glance](#1-the-worker-at-a-glance)
2. [The files](#2-the-files)
3. [Startup](#3-startup)
4. [The task loop](#4-the-task-loop)
5. [Taking the next task](#5-taking-the-next-task)
6. [Doing a task](#6-doing-a-task)
7. [The tables it uses](#7-the-tables-it-uses)
8. [Two statuses](#8-two-statuses)
9. [No duplicates: the dedupe key](#9-no-duplicates-the-dedupe-key)
10. [circular.read](#10-circularread)
11. [circular.assess](#11-circularassess)
12. [policy.check](#12-policycheck)
13. [company.refresh](#13-companyrefresh)
14. [The reconciler](#14-the-reconciler)
15. [Transactions, acknowledgements and crashes](#15-transactions-acknowledgements-and-crashes)
16. [When something fails](#16-when-something-fails)
17. [What the api and the watcher queue](#17-what-the-api-and-the-watcher-queue)
18. [Every Redis command](#18-every-redis-command)
19. [Every database operation](#19-every-database-operation)
20. [Cost of each event](#20-cost-of-each-event)
21. [Settings and constants](#21-settings-and-constants)

---

## 1. The worker at a glance

The worker is one Python process (`python main.py`) per `worker` container; compose runs
`WORKERS` of them. It never talks to the watcher or the api directly. They save a change
in **Postgres** and add a **task** to the Redis stream `rci:tasks`; the workers read the
stream as the consumer group `workers`, so each task goes to one of them.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        watcher["watcher"] -->|"INSERT circular,<br/>XADD circular.read"| Q[["Redis<br/><b>rci:tasks</b>"]]
        api["api<br/>(the console)"] -->|"saves the change,<br/>XADD the task"| Q
        Q <-->|"XREADGROUP, XACK<br/>(group: workers)"| K["<b>worker</b><br/>× WORKERS"]
        K <-->|"reads the work,<br/>saves each step"| PG[("Postgres<br/>every result")]
        watcher --> PG
        api --> PG
        S3[("S3 (Floci)<br/>the PDFs")] -->|"GET the PDF"| K
        K <-->|"page image → text"| O["ocr<br/>on the GPU"]
        K <-->|"questions → JSON,<br/>texts → embeddings"| G["Gemini<br/>via LangChain"]
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class watcher,api,K svc
    class Q queue
    class PG,S3 data
    class O gpu
    class G ext
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| What | How | Used for |
|---|---|---|
| **Redis** | redis-py, one connection | the task stream, the dedupe keys, the dead-letter stream, the reconciler's key |
| **Postgres** | SQLAlchemy / SQLModel, a connection pool | every result |
| **S3** (Floci locally) | boto3 | each circular's PDF, read once |
| **ocr** | HTTP, vLLM's OpenAI-compatible API | page images to text, once per PDF |
| **Gemini** | LangChain (`langchain-google-genai`) | three questions, and embeddings |

Two rules hold everything together:

- **A task is only a pointer.** It carries a type and ids, never data. The worker reads the
  current state from Postgres and does what is left, so a task delivered twice, late or
  after a crash is harmless.
- **Nothing slow or paid for is done twice.** The OCR text, the summary, the embeddings,
  every "does it apply?" and every policy verdict are committed the moment they exist.

---

## 2. The files

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TB
    subgraph canvas[" "]
        direction TB
        main["<b>main.py</b><br/>the task loop: next_task, run_task,<br/>give_up, reconcile"]
        pipeline["<b>pipeline.py</b><br/>one function per task type,<br/>embeddings, missing_work"]
        queue[["<b>common/queue.py</b><br/>the stream's names, connect,<br/>enqueue with its dedupe key"]]
        failures["<b>failures.py</b><br/>wait, retry or give up"]
        llm["<b>llm.py</b><br/>the three Gemini questions,<br/>embeddings"]
        ocr["<b>ocr.py</b><br/>PDF pages → text"]
        storage["<b>storage.py</b><br/>PDFs from S3"]
        common[("<b>common/models.py, db.py</b><br/>the tables, engine, init_db")]
        main --> pipeline
        main --> queue
        main --> failures
        pipeline --> llm
        pipeline --> ocr
        pipeline --> storage
        llm --> failures
        main -.-> common
        pipeline -.-> common
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class main,pipeline svc
    class queue queue
    class failures muted
    class llm ext
    class ocr gpu
    class storage,common data
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| File | What's in it |
|---|---|
| `main.py` | `main()` (the loop), `TASKS` (task type → pipeline function), `next_task`, `run_task` (do it, then delete its dedupe key, queue its follow-ups and acknowledge it, or retry, or give up), `give_up`, `reconcile`, `check_gemini` |
| `pipeline.py` | one function per task type: `read_circular`, `assess`, `check_policy`, `refresh_company`; `match` and `judge_policy`; the embeddings; `missing_work` for the reconciler. Each returns the tasks to queue next |
| `../common/common/queue.py` | the Redis names, `connect()`, `key()` (a task's dedupe key) and `enqueue()` (shared with the watcher and the api) |
| `llm.py` | the Gemini client, the three prompts with their Pydantic reply models, `embed()` |
| `ocr.py` | PDF to text: rendering pages, the OCR request, cleaning the output |
| `failures.py` | `should_wait`, `should_retry`, `gemini_status` |
| `storage.py` | `get_pdf()` from S3 |
| `config.py` | every setting, from the environment or `.env` |

---

## 3. Startup

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant M as main.py
        participant PG as Postgres
        participant G as Gemini
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        Note right of M: load Settings (GEMINI_API_KEY missing? stop)
        M->>PG: BEGIN, pg_advisory_xact_lock(hashtext('rci-schema'))
        Note over PG: services starting together take turns
        M->>PG: create_all, then ADD COLUMN for any column a model gained
        M->>PG: COMMIT (the transaction lock is released)
        M->>G: llm.check: one chat call and one embedding
        alt 400 / 403 / 404
            Note right of M: stop: "Gemini rejected the key or model name"
        else OK, or 429 / 5xx / no network
            Note right of M: carry on (a warning if unavailable)
        end
        M->>R: connect (socket_timeout 30 s)
        Note right of M: consumer name = hostname-pid
    end
```

- **Tables.** Every service runs `init_db` at startup: `create_all` makes missing tables, and
  a column a model gained later is added (nullable; nothing is ever dropped). A transaction
  lock (`pg_advisory_xact_lock`) makes services that start together take turns, so two never
  create the same table at once; the COMMIT releases it.
- **`check_gemini`** turns a wrong key or model name (a 4xx) into one clear error. A 429, a
  5xx or no network only logs a warning: tasks wait for Gemini themselves.
- **The consumer name** is `<hostname>-<pid>`. In a container the pid is 1, so a restarted
  container comes back under the same name and finds its own unfinished tasks.

---

## 4. The task loop

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        start(["main(): forever"]) --> join["join_group: XGROUP CREATE<br/>rci:tasks workers 0 MKSTREAM<br/>(BUSYGROUP: it exists, fine)"]
        join --> due{"A minute since<br/>the last try?"}
        due -->|"yes"| rec["reconcile(): does work only if<br/>SET rci:reconciled NX EX succeeds"]
        due -->|"no"| next
        rec --> next["next_task()"]
        next --> got{"A task?"}
        got -->|"yes"| run["run_task(): do it,<br/>XACK unless it's to be retried"]
        got -->|"no, and --once"| stop(["exit"])
        got -->|"no"| join
        run --> join
        join -.->|"Redis down or timing out"| wait["log, sleep RETRY_SECONDS,<br/>start again"]
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class start start
    class join,rec,next svc
    class due,got ask
    class run ext
    class stop,wait muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- `join_group` creates the group at id `0`, so tasks queued before any worker ever ran are
  delivered. It runs every turn, which also recreates the group if Redis lost its data.
- There is **no polling interval**: `next_task` blocks on Redis for up to 5 seconds, and
  returns the moment a task arrives.
- `--once` (used by tests) works until a 5-second wait finds nothing, then exits.
- Redis down or timing out: the loop logs it, waits `RETRY_SECONDS` and starts again. The
  api and the watcher keep saving their changes meanwhile; the reconciler queues what was
  missed.

---

## 5. Taking the next task

`next_task()` looks in three places, in order, and takes one task:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a["XREADGROUP GROUP workers &lt;me&gt;<br/>COUNT 1 STREAMS rci:tasks <b>0</b>"] -->|"one of mine,<br/>never acknowledged"| r1(["retry it"])
        a -->|"none"| b["XAUTOCLAIM rci:tasks workers &lt;me&gt;<br/><b>1800000</b> 0-0 COUNT 1"]
        b -->|"one idle 30 min<br/>(its worker died)"| r2(["take it over"])
        b -->|"none"| c["XREADGROUP GROUP workers &lt;me&gt;<br/>COUNT 1 BLOCK 5000 STREAMS rci:tasks <b>&gt;</b>"]
        c -->|"a new one"| r3(["do it"])
        c -->|"5 s, nothing"| r4(["None"])
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class a,b,c queue
    class r1,r2,r3 ok
    class r4 muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **`0` reads this consumer's own pending list**: tasks it was given but never acknowledged,
  because the last attempt was to be retried. An entry whose fields are empty (trimmed from
  the stream by `MAXLEN`) is acknowledged and skipped.
- **`XAUTOCLAIM`** moves a task that has been pending with *another* consumer for
  `CLAIM_IDLE_SECONDS` (1,800) to this one. That worker is presumed dead. If it was only
  slow, both may run the task once; every step checks the database first, so the second run
  mostly finds the work done.
- **`>`** asks for a task never delivered to anyone in the group.

---

## 6. Doing a task

`run_task()` turns the task's fields into ids and calls its function from `TASKS`. There
are no locks: the consumer group gave this task to this worker only.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        t(["run_task(task)"]) --> fn["TASKS[type](session, **ids)<br/>read_circular · assess ·<br/>check_policy · refresh_company"]
        fn -->|"returns follow-up tasks"| del["DEL its dedupe key"]
        del --> xadd[["enqueue each follow-up<br/>(circular.assess, or policy.check<br/>for a policy edited meanwhile)"]]
        xadd --> ack(["XACK"])
        fn -.->|"raised"| fail["should_wait / should_retry /<br/>give_up (section 16)"]
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class t start
    class fn svc
    class del,xadd queue
    class ack ok
    class fail bad
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Follow-ups.** Each function returns the tasks to queue next: `read_circular` and
  `refresh_company` return a `circular.assess` per pending company or circular;
  `check_policy` returns itself when the policy was edited while it ran.
- **The order at the end** is: delete the task's dedupe key, queue the follow-ups,
  acknowledge. Deleting the key first lets a task queue itself again; a crash between the
  steps only means the task runs once more.

---

## 7. The tables it uses

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        CO["<b>companies</b><br/>read: profile"]
        CI["<b>circulars</b> (shared)<br/>written: status, text, addressed_to,<br/>summary, requirements, embedding,<br/>embedding_model, error"]
        AS["<b>assessments</b><br/>inserted: one per company and circular<br/>written: status, applicable,<br/>applies_reason, error"]
        PO["<b>policies</b> (per company)<br/>written: embeddings, embedding_model"]
        CT["<b>controls</b><br/>read, for the prompt"]
        PC["<b>policy_checks</b><br/>inserted: one per verdict"]
        GA["<b>gaps</b> (per company)<br/>inserted: one per out-of-date policy"]
        GE["<b>gap_events</b><br/>inserted: 'agent opened'"]
        CO --> AS
        CI --> AS
        CO --> PO
        PO --> CT
        CI --> PC
        PO --> PC
        PC --> GA
        GA --> GE
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class CO start
    class CI,PO,CT data
    class AS svc
    class PC ok
    class GA bad
    class GE muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Table | The worker reads | The worker writes |
|---|---|---|
| `companies` | `profile` | nothing |
| `users` | nothing | nothing |
| `circulars` | the task's circular; recent ones for `policy.check` and `company.refresh` | `status`, `text`, `addressed_to`, `summary`, `requirements`, `embedding`, `embedding_model`, `error` |
| `assessments` | the task's (company, circular) | inserts one per company and circular; `status`, `applicable`, `applies_reason`, `error`, `updated_at` |
| `policies` | the company's embedded policies | `embeddings`, `embedding_model` |
| `controls` | a policy's controls, for the prompt | nothing |
| `policy_checks` | the circular's judged pairs | one row per verdict |
| `gaps` | the circular's pairs that have a gap | one row per out-of-date policy, with `company_id` |
| `gap_events` | nothing | the first event of each gap: `agent`, `opened` |

Unique constraints back the worker up: `assessments` (company, circular), `policy_checks`
(circular, policy, version) and `gaps` (circular, policy). Policy ids belong to one company,
so a (circular, policy) pair is always one company's.

---

## 8. Two statuses

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TB
    subgraph canvas[" "]
        direction TB
        subgraph circ["circulars.status (shared)"]
            direction TB
            c_new(["new"]) -->|"parse: text saved"| c_parsed(["parsed"])
            c_parsed -->|"summary + embedding saved"| c_read(["read"])
            c_new -->|"published before LOOKBACK_DAYS"| c_skipped(["skipped"])
            c_new -->|"give_up"| c_failed(["failed"])
            c_parsed -->|"give_up"| c_failed
            c_failed -->|"api: Reprocess"| c_new
        end
        subgraph asm["assessments.status (per company)"]
            direction TB
            a_pending(["pending"]) -->|"assess() finished"| a_done(["done"])
            a_pending -->|"give_up"| a_failed(["failed"])
            a_done -->|"api: Reprocess, or<br/>a new description"| a_pending
            a_failed -->|"api: Reprocess"| a_pending
        end
        c_read -.->|"pending_companies()"| a_pending
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class c_new queued
    class c_parsed,c_read data
    class c_failed,a_failed bad
    class c_skipped muted
    class a_pending svc
    class a_done ok
    classDef queued fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    style circ fill:#0f172a,stroke:#334155,color:#94a3b8
    style asm fill:#0f172a,stroke:#334155,color:#94a3b8
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

`circulars.status` is how far the **shared** reading has got; `assessments.status` is how far
**one company** has got with the circular. The api combines them into the status a company
sees:

| circular | this company's assessment | the console shows |
|---|---|---|
| `new`, `parsed`, `failed`, `skipped` | (any) | the circular's status |
| `read` | `pending` | `parsed` ("In progress") |
| `read` | `done` | `analyzed` |
| `read` | `failed` | `failed` |
| `read` | none, published before `LOOKBACK_DAYS` | `skipped` |
| `read` | none, recent | `parsed` (a `company.refresh` is on its way) |

---

## 9. No duplicates: the dedupe key

The consumer group gives each task to one worker, so workers need no locks to share the
work. What's left is the same **work** queued twice (the reconciler, a double Reprocess, a
watcher restart). `enqueue` prevents it with a key per task:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        add(["enqueue(kind, **ids)"]) --> nx{"SET rci:queued:&lt;task&gt;<br/>1 NX EX 86400"}
        nx -->|"OK"| xadd[["XADD rci:tasks"]]
        nx -->|"nil: queued or running"| skip(["dropped"])
        xadd --> w["a worker: XREADGROUP,<br/>does the work"]
        w --> del["DEL rci:queued:&lt;task&gt;"]
        del --> ack(["XACK"])
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class add start
    class nx ask
    class xadd queue
    class skip muted
    class w,del svc
    class ack ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- The key is `rci:queued:` plus the task's fields, sorted, e.g.
  `rci:queued:circular_id=98:type=circular.read`. It expires after a day, in case a worker
  dies between finishing a task and deleting it.
- A retry keeps the key: the task is still queued, so no copy can be added meanwhile.
- **The rare clash.** Two *different* tasks can still judge the same (circular, policy) pair at
  once: a `policy.check` and a `circular.assess` for the same company. The unique constraint
  on `policy_checks` rejects the second save with an `IntegrityError`, which `should_retry`
  treats as a hiccup: the retry reloads the judged pairs and skips it.
- **The GPU.** The OCR server runs one sequence at a time (`--max-num-seqs 1`) and queues
  concurrent requests, so workers send pages freely.

Why no `SELECT … FOR UPDATE SKIP LOCKED`: the queue is Redis, and the consumer group already
hands each task to one worker; a row lock would also be released by the first of the
worker's step-by-step commits. See
[the plain-words guide](../../how_the_worker_works.md#why-no-skip-locked).

---

## 10. circular.read

`read_circular(session, circular_id)`, queued by the watcher for each new circular and by
**Reprocess** for one that isn't read. It runs **once per circular**, whatever the number of
companies.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant X as S3 + ocr + Gemini
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT the circular
        alt status new, published before the cutoff
            K->>PG: UPDATE status = 'skipped', COMMIT
        else status new
            K->>PG: a twin with the same sha256 and text?
            K->>X: else GET the PDF, OCR each page
            K->>PG: UPDATE text, status = 'parsed', COMMIT ①
        end
        opt summary IS NULL
            K->>X: SUMMARY_PROMPT + up to 100,000 characters
            K->>PG: UPDATE addressed_to, summary, requirements, COMMIT ②
        end
        K->>X: embed title + summary + requirements (RETRIEVAL_QUERY)
        K->>PG: UPDATE embedding, embedding_model, COMMIT ③
        K->>PG: UPDATE status = 'read', error = NULL, COMMIT ④
        K->>PG: INSERT INTO assessments … ON CONFLICT DO NOTHING (every company), COMMIT
        K->>PG: SELECT the pending assessments of this circular
        K->>R: DEL its key, XADD circular.assess per pending company, XACK
    end
```

Inside `ocr.pdf_to_text()`:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        pdf["PDF bytes"] --> pages["First 20 pages<br/>(OCR_MAX_PAGES)"]
        pages --> blank{"Blank page?<br/>no text layer, images<br/>or drawings"}
        blank -->|"yes"| drop["skip it"]
        blank -->|"no"| png["Render a PNG<br/>at 200 DPI"]
        png --> cache{"Read already?<br/>(sha256 of the PNG,<br/>in memory)"}
        cache -->|"yes: a retry"| reuse["use the saved text"]
        cache -->|"no"| post["One chat request to the<br/>ocr service (600 s timeout)"]
        post --> clean["remove_det: strip markers,<br/>drop images, footers, '[No text]'"]
        clean --> join["Join the pages:<br/>circulars.text"]
        reuse --> join
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class pdf data
    class blank,cache ask
    class drop,reuse muted
    class png,post gpu
    class clean svc
    class join ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Skipped, failed:** a circular already `skipped` or `failed` is left alone (Reprocess sets
  it back to `new` or `parsed` first). A `new` one published before `LOOKBACK_DAYS` becomes
  `skipped`.
- **One PDF, one OCR.** A circular whose PDF has the same `sha256` as one already read copies
  that text: no S3, no OCR.
- **The page cache** keeps pages already read in memory until the document is done, so a
  retry after a timeout on page 15 starts at page 15.
- **Empty result:** no text on any page raises `OCR found no text in the PDF`, and the
  circular is marked failed.
- **The summary** is forced into JSON matching `CircularSummary`. It doesn't depend on any
  company, so no company's change ever repeats it.
- **The embedding** is made from the title, summary and obligations
  (`RETRIEVAL_QUERY`), once, for every company's matching.
- **Fan-out:** `pending_companies()` inserts a pending assessment for every company (`ON
  CONFLICT DO NOTHING`) and returns a `circular.assess` task for each company still
  pending.

Logs: `#98 parsed: 12408 chars`, `#98 read: addressed to '…'`.

---

## 11. circular.assess

`assess(session, company_id, circular_id)`, queued by `circular.read`, by
`company.refresh` and by **Reprocess**.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant G as Gemini
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT the company, the circular (must be 'read')
        K->>PG: INSERT the assessment ON CONFLICT DO NOTHING, COMMIT
        K->>PG: SELECT the assessment
        Note right of K: done already? stop here
        opt described, and applicable IS NULL
            K->>G: APPLICABILITY_PROMPT + description + addressed_to + 4,000 chars
            K->>PG: UPDATE applicable, applies_reason, COMMIT
        end
        opt applies, and has requirements
            K->>PG: SELECT the company's policies (embedded, this regulator)
            K->>PG: SELECT the circular's judged pairs and gaps
            Note right of K: score each (cosine, best chunk),<br/>keep MATCH_TOP_K
            loop each top policy not judged at this version, with no gap
                K->>PG: SELECT its controls
                K->>G: ASSESS_PROMPT + description + circular + policy
                K->>PG: INSERT policy_checks (+ gaps + gap_events), COMMIT
            end
        end
        K->>PG: UPDATE assessment status = 'done', COMMIT
        K->>R: DEL its key, XACK
    end
```

**Does it apply?** (`judge`) runs only when the company has a description and `applicable IS
NULL`. The first 4,000 characters of the text are sent with the addressees: that's where a
circular says who it's for. Without a description the assessment is marked `done` with
`applicable` NULL ("Not checked"); a description saved later resets it to `pending`.

**The closest policies** (`closest_policies`), with no Gemini call:

1. The company's policies embedded with the current model that list the circular's
   regulator.
2. Each one's score is the best **cosine similarity** between the circular's embedding and
   any of the policy's 5,000-character chunks.
3. Keep the top `MATCH_TOP_K` (3), and skip pairs already judged at this version, or that
   have a gap (the owner is on it).

**What a verdict writes:**

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        ask["Gemini's answer"] --> imp{"impacted and<br/>missing_from_policy<br/>not empty?"}
        imp -->|"no"| up["policy_checks row<br/>impacted = false"]
        imp -->|"yes"| down["policy_checks row<br/>impacted = true"]
        down --> gap["gaps row: title, impact, draft_change,<br/>affected_controls (real codes only),<br/>severity, owner, status 'open',<br/>due_date = today + 7 / 30 / 60 days"]
        gap --> ev["gap_events row:<br/>agent, opened, note = what's missing"]
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class ask ext
    class imp ask
    class up ok
    class down,gap bad
    class ev muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

The verdict, the gap and its first event are one transaction. Each verdict is committed
before the next policy is asked about, so a retry after a failure only asks about the rest.

Logs: `#98 vs POL-KYC v1 (0.74): GAP` (0.74 is the similarity), then
`#98 for company 1: applies: True, gaps opened: ['POL-KYC']`.

---

## 12. policy.check

`check_new_policy(session, company_id, policy_id)`, queued by the api whenever a policy is
added or saved, and by the reconciler for a policy that isn't embedded.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant G as Gemini
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        Note right of K: started = now()
        K->>PG: SELECT the policy (must be the task's company's) and the company
        opt no embeddings, or another model
            K->>G: embed each 5,000-char chunk of "title + text" (RETRIEVAL_DOCUMENT)
            K->>PG: UPDATE embeddings, embedding_model, COMMIT
        end
        K->>PG: the company's done + applicable assessments of circulars since the cutoff
        loop each one from a regulator the policy lists, with requirements
            Note right of K: match(): the company's top policies for it,<br/>only unjudged pairs go to Gemini
        end
        K->>PG: UPDATE policies SET checked_at = started, COMMIT
        alt updated_at > started (edited meanwhile)
            K->>R: DEL its key, XADD policy.check again, XACK
        else
            K->>R: DEL its key, XACK
        end
    end
```

- **Embedding:** a policy needs it when it's new, when the api cleared its embeddings (title
  or text changed), or when `GEMINI_EMBEDDING_MODEL_NAME` changed. Its "title + text" is
  split into 5,000-character chunks, all embedded in as few requests as possible
  (`RETRIEVAL_DOCUMENT`).
- **Which circulars:** `recent_applicable()`: the company's assessments that are `done` and
  apply, of `read` circulars published in the last `LOOKBACK_DAYS` with obligations, from a
  regulator the policy lists. Their OCR text isn't loaded.
- **`checked_at`.** At the end the policy's `checked_at` is set to when the check started.
  A policy saved after that (`updated_at > checked_at`) shows as "Waiting for the worker" in
  the console, and `check_policy` queues itself once more.
- **Only unjudged pairs cost anything.** A policy whose owner or regulators changed is
  embedded already; only pairs never judged go to Gemini. An edited text is a new version,
  so its pairs are judged again, except those with a gap.

Log: `POL-AML checked, gaps opened: ['POL-AML']`.

---

## 13. company.refresh

`refresh_company(session, company_id)`, queued at sign-up and when a company's description
changes (the api has already set that company's assessments of read circulars back to
`pending`, with `applicable` cleared).

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT id FROM circulars WHERE status = 'read' AND published_at >= cutoff
        K->>PG: INSERT INTO assessments … ON CONFLICT DO NOTHING (each), COMMIT
        K->>PG: SELECT the company's pending assessments of read circulars
        K->>R: DEL its key, XADD circular.assess per pending circular, XACK
    end
```

A new company gets an assessment for each circular read in the last `LOOKBACK_DAYS`, and a
`circular.assess` task for each pending one. Older circulars stay unjudged for it (the
console shows them as skipped).

---

## 14. The reconciler

Postgres is the truth; the stream is only the to-do list. A task can go missing: Redis was
down when the api or watcher tried `XADD` (`enqueue` logs and carries on, never failing the
request), or Redis lost its data. Every `RECONCILE_MINUTES` (15), one worker queues again
whatever Postgres shows as unfinished:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        tick(["every minute, each worker"]) --> nx{"SET rci:reconciled &lt;me&gt;<br/>NX EX RECONCILE_MINUTES×60"}
        nx -->|"nil: another worker<br/>did it this interval"| skip(["nothing"])
        nx -->|"OK: my turn"| mw["missing_work(): three queries"]
        mw --> q1["circulars still<br/>new or parsed<br/>→ circular.read"]
        mw --> q2["assessments pending,<br/>circular read<br/>→ circular.assess"]
        mw --> q3["policies saved after their<br/>checked_at, or never checked<br/>→ policy.check"]
        q1 --> add[["enqueue each: work still<br/>queued is skipped by its key"]]
        q2 --> add
        q3 --> add
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class tick start
    class nx ask
    class skip muted
    class mw svc
    class q1,q2,q3 data
    class add queue
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **One worker per interval.** Each worker tries once a minute; `SET NX EX` succeeds for
  exactly one of them, and the key expires when the next run is due.
- **No duplicates.** Work that's still queued or running is skipped by its dedupe key.
- **Policies** are unfinished when they were saved after their last check (`checked_at` is
  missing or older than `updated_at`) or embedded with another model.

---

## 15. Transactions, acknowledgements and crashes

The work session **commits after every step**, and the task is **acknowledged only when it
is finished**. For one circular and one company:

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        Note right of K: circular.read 98
        K->>PG: UPDATE text, status 'parsed': COMMIT ①
        K->>PG: UPDATE summary fields: COMMIT ②
        K->>PG: UPDATE embedding: COMMIT ③
        K->>PG: UPDATE status 'read': COMMIT ④
        K->>PG: INSERT assessments: COMMIT ⑤
        K->>R: DEL its key, XADD circular.assess × companies, XACK ⑥
        Note right of K: circular.assess A/98
        K->>PG: UPDATE applicable: COMMIT ⑦
        K->>PG: INSERT policy_checks (+ gap): COMMIT ⑧
        K->>PG: UPDATE assessment 'done': COMMIT ⑨
        K->>R: DEL its key, XACK ⑩
    end
```

A crash (the process killed, the machine rebooted) loses at most the step in progress. The
task is still pending in Redis, under the dead worker's name:

| The crash happens… | What's saved | When the task comes back |
|---|---|---|
| during OCR, before ① | nothing | reads the PDF again (the page cache died with the process) |
| after ① | the text | summarises: no OCR |
| after ② | the summary | embeds it |
| after ④ or ⑤ | the circular is `read` | re-inserts nothing, queues the pending companies' tasks again |
| before ⑥'s `XACK` | the tasks were queued | queues them again: the duplicates do nothing |
| after ⑦ | "does it apply?" | goes straight to the policies |
| after ⑧ | the first verdict (and its gap) | asks only about the other policies |
| after ⑨ | the assessment is `done` | nothing to do |

**Who picks it up.** The same container, restarted by Docker, reads its own pending list
first. Otherwise another worker takes the task over after `CLAIM_IDLE_SECONDS`, and the
reconciler may queue the unfinished work sooner.

**Reloading after a commit.** SQLAlchemy expires a session's objects when it commits, so the
next use reads the row again: the worker always sees the latest values, including changes
the api made meanwhile.

---

## 16. When something fails

Every error goes through `run_task()`, with the rules in `failures.py`:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        err["the task raised"] --> rb["ROLLBACK the work session"]
        rb --> down{"should_wait?<br/>can't connect (OCR loading),<br/>Gemini 429 (quota)"}
        down -->|"yes"| wait["sleep RETRY_SECONDS (60),<br/><b>no XACK</b>: the task is<br/>this worker's next one"]
        down -->|"no"| retry{"should_retry?<br/>5xx, timeout, dropped connection,<br/>BadReply, IntegrityError"}
        retry -->|"yes"| count{"tries for this task id<br/>reached MAX_TRIES (3)?"}
        count -->|"no"| again["<b>no XACK</b>: retried<br/>straight away"]
        count -->|"yes"| give
        retry -->|"no: a 400,<br/>'OCR found no text', …"| give["give_up(): circular or assessment<br/>status 'failed', error saved, COMMIT;<br/>XADD rci:dead the task + error"]
        give --> ack(["DEL its key, XACK"])
    end
    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    classDef queue fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    class err bad
    class rb muted
    class down,retry,count ask
    class wait,again muted
    class give bad
    class ack ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Error | Examples | What happens | What you do |
|---|---|---|---|
| **should wait** | can't connect to ocr (the model is loading); Gemini 429 (quota) | wait `RETRY_SECONDS`, retry, for as long as it takes | nothing, or raise your Gemini quota |
| **should retry** | a 5xx; a timeout; a dropped connection; `BadReply` (not the asked-for JSON); `IntegrityError` (another task saved the same verdict first) | retried up to `MAX_TRIES` (3), then given up | usually nothing |
| **anything else** | a 400 from Gemini; `OCR found no text in the PDF` | `give_up()`: `failed` with the error, the task copied to `rci:dead`, its key deleted, acknowledged | open the circular, read the error, press **Reprocess** |

- LangChain retries Gemini rate limits and server errors itself first (`max_retries=3`).
  `gemini_status()` reads the HTTP code from the error underneath LangChain's.
- The tries counter lives in the worker process, keyed by task id.
- `give_up` marks a `circular.read` failure on the circular (every company sees it) and a
  `circular.assess` failure on that company's assessment only. Other failures only go to
  `rci:dead`; the reconciler tries an unchecked policy again later.

---

## 17. What the api and the watcher queue

Every producer saves its change first, then adds the task, so a worker never receives a
task whose change it can't see yet:

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant W as watcher
        participant A as api
        participant PG as Postgres
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        W->>PG: INSERT circulars (status new), COMMIT
        W->>R: enqueue circular.read
        A->>PG: POST /auth/signup: INSERT companies, users (one transaction)
        A->>R: enqueue company.refresh
        A->>PG: POST or PUT /policies: INSERT or UPDATE policies
        A->>R: enqueue policy.check
        A->>PG: PUT /company (new description): UPDATE companies,<br/>its assessments of read circulars back to pending
        A->>R: enqueue company.refresh
        A->>PG: POST /circulars/{id}/reprocess (read): upsert its assessment pending,<br/>DELETE its "up to date" policy_checks
        A->>R: enqueue circular.assess
        A->>PG: POST /circulars/{id}/reprocess (not read): status new or parsed
        A->>R: enqueue circular.read
        Note over W,R: every enqueue comes after the COMMIT, and is dropped<br/>if the same task is already queued or running
    end
```

| You do (or the watcher does) | The database change | The task |
|---|---|---|
| a regulator publishes a circular | watcher: `INSERT INTO circulars`, status `new` | `circular.read` |
| sign up a company | `INSERT` the company and its first user | `company.refresh` |
| add a policy | `INSERT INTO policies`, version 1, no embeddings | `policy.check` |
| edit a policy | text: `version + 1`, embeddings cleared, `policy_updated` on its open gaps; title: embeddings cleared; always `updated_at` | `policy.check` |
| add a control | `INSERT INTO controls` | none: part of the next checks |
| change the company description | the company's assessments of read circulars → `pending`, `applicable` cleared | `company.refresh` |
| **Reprocess** a read circular | the company's assessment → `pending` (upsert); its "up to date" verdicts on it deleted | `circular.assess` |
| **Reprocess** any other circular | status `parsed` if it has text, else `new`; `error` cleared | `circular.read` |
| add a teammate, change a password | `users` | none |

---

## 18. Every Redis command

| Command | Who | When |
|---|---|---|
| `SET rci:queued:<task> 1 NX EX 86400`, then `XADD rci:tasks MAXLEN ~ 100000 * type … ids …` | watcher, api, worker | a task is queued (`enqueue`); skipped if the key exists |
| `XGROUP CREATE rci:tasks workers 0 MKSTREAM` | worker | every turn of the loop; `BUSYGROUP` means it exists |
| `XREADGROUP GROUP workers <me> COUNT 1 STREAMS rci:tasks 0` | worker | its own unfinished task |
| `XAUTOCLAIM rci:tasks workers <me> 1800000 0-0 COUNT 1` | worker | a dead worker's task |
| `XREADGROUP GROUP workers <me> COUNT 1 BLOCK 5000 STREAMS rci:tasks >` | worker | a new task |
| `DEL rci:queued:<task>`, then `XACK rci:tasks workers <id>` | worker | a task finished or given up |
| `XADD rci:dead * type … ids … task_id … error …` | worker | a task given up |
| `SET rci:reconciled <me> NX EX 900` | worker | once a minute: is it my turn to reconcile? |

To look inside: `docker compose exec redis redis-cli XINFO GROUPS rci:tasks` (`lag`: waiting,
`pending`: being worked on), `XRANGE rci:dead - +`, `KEYS rci:queued:*`.

---

## 19. Every database operation

What each task sends, in order. `…` stands for the values.

| Task | Statements |
|---|---|
| startup | `SELECT pg_advisory_xact_lock(hashtext('rci-schema'))`; `CREATE TABLE …`; `ALTER TABLE … ADD COLUMN …` for new columns; `COMMIT` |
| `circular.read` | `SELECT … FROM circulars WHERE id = …`; if new: `SELECT text … WHERE sha256 = … AND id <> … AND text IS NOT NULL`, `UPDATE circulars SET text, status = 'parsed'`, `COMMIT`; `UPDATE … SET addressed_to, summary, requirements, embedding = NULL`, `COMMIT`; `UPDATE … SET embedding, embedding_model`, `COMMIT`; `UPDATE … SET status = 'read', error = NULL`, `COMMIT`; `SELECT id FROM companies`; `INSERT INTO assessments … ON CONFLICT DO NOTHING` (one statement for all), `COMMIT`; `SELECT company_id, circular_id FROM assessments JOIN circulars … WHERE pending` |
| `circular.assess` | `SELECT` the company and the circular; `INSERT INTO assessments … ON CONFLICT DO NOTHING`, `COMMIT`; `SELECT` the assessment; maybe `UPDATE assessments SET applicable, applies_reason`, `COMMIT`; `SELECT … FROM policies WHERE company_id = …`; `SELECT policy_id, policy_version FROM policy_checks WHERE circular_id = …`; `SELECT policy_id FROM gaps WHERE circular_id = …`; per policy asked: `SELECT … FROM controls`, `INSERT INTO policy_checks`, maybe `INSERT INTO gaps … RETURNING id` and `INSERT INTO gap_events`, `COMMIT`; `UPDATE assessments SET status = 'done', error = NULL, updated_at`, `COMMIT` |
| `policy.check` | `SELECT` the policy and the company; maybe `UPDATE policies SET embeddings, embedding_model`, `COMMIT`; `SELECT circulars … JOIN assessments …` (no `text`); per circular, the matching statements of `circular.assess`; `UPDATE policies SET checked_at`, `COMMIT` |
| `company.refresh` | `SELECT id FROM circulars WHERE status = 'read' AND published_at >= …`; `INSERT INTO assessments … ON CONFLICT DO NOTHING`, `COMMIT`; `SELECT … WHERE pending` |
| reconciler | `SELECT id FROM circulars WHERE status IN ('new', 'parsed')`; the pending assessments; `SELECT company_id, id FROM policies WHERE checked_at IS NULL OR checked_at < updated_at OR embedding_model IS DISTINCT FROM …` |
| giving up | `ROLLBACK`; `UPDATE circulars` or `UPDATE assessments SET status = 'failed', error = …`; `COMMIT` |

To watch them yourself, run a worker on the host with `echo=True` in `make_engine` for a
moment.

---

## 20. Cost of each event

What each event costs in OCR and Gemini calls; everything else is database and Redis work.

| Event | OCR | Gemini chat | Gemini embedding |
|---|---|---|---|
| worker starts | none | 1 (the configuration check) | 1 |
| nothing to do | none | none | none |
| a new circular | 1 per page, **once** | 1 summary, **once**; then per described company: 1 "applies?", plus 1 per top-3 policy where it applies | 1, once |
| the same PDF under a second circular | none | as above | as above |
| a new company signs up | none | none until it's described | none |
| a company describes itself (or changes it) | none | 1 per recent read circular, plus checks for pairs never judged | none |
| a new policy | none | 1 per recent circular where it ranks in the company's top 3 | 1 request for all its chunks |
| a policy's text edited | none | as for a new policy, except pairs with a gap | 1 |
| a policy's owner or regulators edited | none | only pairs never judged | none |
| **Reprocess** (read circular) | none | 1 "applies?" plus its "up to date" pairs again, for this company | none |

---

## 21. Settings and constants

Settings come from the environment or `.env` (`config.py`); an empty value keeps the
default.

| Setting | Default | What it controls |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://rci:rci@localhost:5432/rci` | the database |
| `REDIS_URL` | `redis://localhost:6379/0` (compose: `redis://redis:6379/0`) | the task stream |
| `S3_ENDPOINT_URL`, `S3_BUCKET`, AWS keys, region | empty (real AWS), `rci`, empty, `us-east-1` | where the PDFs are |
| `OCR_URL` | `http://localhost:8001/v1` | the ocr service |
| `OCR_MAX_PAGES` | 20 | pages read per PDF |
| `GEMINI_API_KEY` | none: required | Gemini access |
| `GEMINI_MODEL_NAME` | `gemini-3.5-flash` | the model that answers the three questions |
| `GEMINI_EMBEDDING_MODEL_NAME` | `gemini-embedding-001` | the embedding model (changing it re-embeds everything) |
| `LLM_MAX_CHARS` | 100000 | characters of text sent for the summary |
| `MATCH_TOP_K` | 3 | policies Gemini checks per circular and company |
| `LOOKBACK_DAYS` | 30 | older new circulars are skipped; how far back new policies and companies look |
| `CLAIM_IDLE_SECONDS` | 1800 | how long a task can sit with a silent worker before another takes it |
| `RETRY_SECONDS` | 60 | the wait while OCR, Gemini or Redis is down |
| `RECONCILE_MINUTES` | 15 | how often one worker looks for missing tasks |
| `WORKERS` (compose) | 1 | how many workers run side by side |

Constants in the code:

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `STREAM`, `GROUP`, `DEAD`, `RECONCILED` | `rci:tasks`, `workers`, `rci:dead`, `rci:reconciled` | `common/queue.py` | the Redis names |
| dedupe keys | `rci:queued:…`, expire after 1 day | `common/queue.py` | a task is queued at most once at a time |
| stream length | 100000 (approximate) | `common/queue.py` | the stream is trimmed beyond this |
| blocking read | 5000 ms | `main.py` | how long a worker waits for a new task per read |
| `MAX_TRIES` | 3 | `failures.py` | tries before a crashing task is given up |
| `DUE_DAYS` | high 7, medium 30, low 60 | `pipeline.py` | days a gap's owner gets, by severity |
| `EMBED_CHARS` | 5000 | `pipeline.py` | the chunk size for embeddings |
| embedding size | 768 | `llm.py` | numbers per embedding |
| applicability text | 4000 characters | `llm.py` | text sent for "does it apply?" |
| `DPI` | 200 | `ocr.py` | page rendering for OCR |

For what the log lines mean, see [Reading its log](../../how_it_works.md#reading-its-log).
