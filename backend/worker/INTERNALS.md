# How the worker works, in depth

![Python 3.14](https://img.shields.io/badge/Python_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white) ![SQLModel](https://img.shields.io/badge/SQLModel-7E56C2?style=flat-square) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Gemini via LangChain](https://img.shields.io/badge/Gemini_via_LangChain-8E75B2?style=flat-square&logo=googlegemini&logoColor=white) ![Unlimited-OCR on vLLM](https://img.shields.io/badge/Unlimited--OCR_on_vLLM-EA580C?style=flat-square) ![Docker Compose](https://img.shields.io/badge/Docker_Compose-2496ED?style=flat-square&logo=docker&logoColor=white) ![Redis 7](https://img.shields.io/badge/Redis_7-DC382D?style=flat-square&logo=redis&logoColor=white)

This is the full story of the **worker**: every task it takes, every Redis command, every row
it reads and writes, and every commit. For the plain-words version with worked
examples, read [How the worker works](../../how_the_worker_works.md) first; this guide goes
all the way down. The code is in this folder, and the queue's names are in
[`common/queue.py`](../common/common/queue.py).

Start with [section 2](#2-step-by-step-everything-the-worker-does): it walks through
everything the worker does, step 1 to step 18, with the database after each step. The
sections after it are the reference for each piece.

**Reading the diagrams.** Each colour means the same thing in every diagram:

![our services](https://img.shields.io/badge/our_services-2dd4bf?style=flat-square) ![data](https://img.shields.io/badge/data-818cf8?style=flat-square) ![Gemini and outside services](https://img.shields.io/badge/Gemini_and_outside_services-c084fc?style=flat-square) ![OCR on the GPU](https://img.shields.io/badge/OCR_on_the_GPU-fb923c?style=flat-square) ![a decision](https://img.shields.io/badge/a_decision-fbbf24?style=flat-square) ![done, or OK](https://img.shields.io/badge/done,_or_OK-34d399?style=flat-square) ![a failure, or a gap](https://img.shields.io/badge/a_failure,_or_a_gap-fb7185?style=flat-square) ![where it starts](https://img.shields.io/badge/where_it_starts-a7ef6f?style=flat-square) ![the task queue](https://img.shields.io/badge/the_task_queue_in_Redis-38bdf8?style=flat-square) ![the task queue](https://img.shields.io/badge/the_task_queue_in_Redis-38bdf8?style=flat-square)

**Contents**

1. [The worker at a glance](#1-the-worker-at-a-glance)
2. [Step by step: everything the worker does](#2-step-by-step-everything-the-worker-does)
3. [The files](#3-the-files)
4. [Startup](#4-startup)
5. [The task loop](#5-the-task-loop)
6. [Taking the next task](#6-taking-the-next-task)
7. [Doing a task](#7-doing-a-task)
8. [The tables it uses](#8-the-tables-it-uses)
9. [Two statuses](#9-two-statuses)
10. [No duplicates: the dedupe key](#10-no-duplicates-the-dedupe-key)
11. [circular.read](#11-circularread)
12. [circular.assess](#12-circularassess)
13. [policy.check](#13-policycheck)
14. [company.refresh](#14-companyrefresh)
15. [The reconciler](#15-the-reconciler)
16. [Transactions, acknowledgements and crashes](#16-transactions-acknowledgements-and-crashes)
17. [When something fails](#17-when-something-fails)
18. [What the api and the watcher queue](#18-what-the-api-and-the-watcher-queue)
19. [Every Redis command](#19-every-redis-command)
20. [Every database operation](#20-every-database-operation)
21. [Cost of each event](#21-cost-of-each-event)
22. [Settings and constants](#22-settings-and-constants)

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
- **Nothing slow or paid for is done twice.** Each OCR'd page, the summary, the embeddings,
  every "does it apply?" and every policy verdict are committed the moment they exist, and
  a running task is never handed to a second worker.

---

## 2. Step by step: everything the worker does

This section follows the worker from the moment it starts, through one circular's whole
journey to the gap tickets it opens, then the other tasks and what keeps it all right when
something breaks. Each step names the code that runs, the Redis commands, what changes in
Postgres (**bold** is new or changed) and the log line. The sections after this one explain
each piece in depth.

**The example.** RBI circular **98**, "Designation of terrorist organisation…": a 3-page PDF
whose last page is blank. Two companies: **1** (A, an NBFC, with four RBI policies) and
**2** (B, a stock broker).

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        subgraph loop["The worker itself"]
            direction TB
            s1(["1. Start up"]) --> s2["2. Wait for a task"]
            s2 --> s3["3. Take it, keep it claimed"]
        end
        s3 --> kind{"Which task?"}
        subgraph read["once for every company"]
            direction TB
            s4{"4. Skip it<br/>or read it?"} --> s5["5. Get the text:<br/>a twin's, or OCR<br/>page by page"]
            s5 --> s6["6. Summarise it"]
            s6 --> s7["7. Embed it:<br/>status read"]
            s7 --> s8["8. An assessment<br/>for every company"]
        end
        subgraph judge["once per company"]
            direction TB
            s10["10. Does it apply<br/>to this company?"] --> s11["11. Find the<br/>closest policies"]
            s11 --> s12["12. Is each policy<br/>out of date?<br/>verdict, maybe a gap"]
            s12 --> s13["13. Mark the<br/>assessment done"]
        end
        subgraph other["the other tasks"]
            direction TB
            s14["14. policy.check:<br/>a policy saved"]
            s15["15. company.refresh:<br/>a company described"]
        end
        kind -->|"circular.read"| s4
        kind -->|"circular.assess"| s10
        kind -->|"policy.check"| s14
        kind -->|"company.refresh"| s15
        s8 --> s9
        s13 --> s9
        s14 --> s9
        s15 --> s9
        s9[["9. Finish: DEL its key,<br/>queue the follow-ups, XACK,<br/>then back to step 2"]]
        s16[["16. The reconciler,<br/>every minute"]]
        s17["17. A step fails:<br/>wait, retry or give up"]
        s18["18. A worker dies:<br/>taken over, resumed"]
        s9 ~~~ s16
        s9 ~~~ s17
        s9 ~~~ s18
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
    class s1 start
    class s2,s3,s11,s14,s15 svc
    class kind,s4 ask
    class s5 gpu
    class s6,s7,s10,s12 ext
    class s8 data
    class s13 ok
    class s9,s16 queue
    class s17 bad
    class s18 muted
    style loop fill:#0f172a,stroke:#334155,color:#94a3b8
    style read fill:#0f172a,stroke:#334155,color:#94a3b8
    style judge fill:#0f172a,stroke:#334155,color:#94a3b8
    style other fill:#0f172a,stroke:#334155,color:#94a3b8
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Step | What happens | Code | Costs |
|---|---|---|---|
| [1](#step-1-start-up) | start up, check Gemini, connect | `main()` | 1 chat + 1 embedding |
| [2](#step-2-wait-for-a-task) | wait for a task: own, abandoned, new | `next_task()` | nothing |
| [3](#step-3-take-the-task-and-keep-it-claimed) | take it, renew the claim every minute | `run_task()`, `keep_claimed()` | nothing |
| [4](#step-4-skip-it-or-read-it) | skip an old circular, or read it | `read_circular()` | nothing |
| [5](#step-5-get-the-text) | the text: a twin's, or OCR page by page | `twin()`, `ocr_text()`, `ocr.pages()` | 1 OCR per page, once per PDF |
| [6](#step-6-summarise-it) | the summary: a twin's, or Gemini's | `llm.summarize()` | 1 chat, once per PDF |
| [7](#step-7-embed-it) | embed the summary | `embed_circular()` | 1 embedding |
| [8](#step-8-an-assessment-for-every-company) | a pending assessment per company | `add_assessments()`, `pending()` | nothing |
| [9](#step-9-finish-the-task) | delete the key, queue the follow-ups, acknowledge | `run_task()` | nothing |
| [10](#step-10-does-it-apply-to-this-company) | does it apply to this company? | `assess()`, `llm.check_applicability()` | 1 chat per company |
| [11](#step-11-find-the-closest-policies) | the company's closest policies | `match()` | nothing |
| [12](#step-12-is-each-policy-out-of-date) | a verdict per policy, maybe a gap | `judge_policy()`, `llm.assess()` | up to 3 chats |
| [13](#step-13-mark-the-assessment-done) | the assessment is done | `assess()` | nothing |
| [14](#step-14-a-policy-is-added-or-edited) | embed a saved policy, check it | `check_policy()` | 1 embedding + unjudged pairs |
| [15](#step-15-a-company-signs-up-or-is-described) | judge recent circulars for a company | `refresh_company()` | via steps 10 to 13 |
| [16](#step-16-the-reconciler-every-minute) | queue work whose task went missing | `reconcile()`, `missing_work()` | nothing |
| [17](#step-17-a-step-fails) | wait, retry or give up | `run_task()`, `give_up()` | nothing |
| [18](#step-18-a-worker-dies) | a dead worker's task is taken over | `next_task()` | only what wasn't saved |

### Step 1: Start up

`main()` in `main.py`, once per container.

1. Load the settings (`config.py`). No `GEMINI_API_KEY`: stop.
2. `init_db()`: take the transaction lock `pg_advisory_xact_lock(hashtext('rci-schema'))`,
   create the missing tables (`ocr_pages` included), add any column a model gained,
   `COMMIT`.
3. `check_gemini()`: one chat call and one embedding. A 4xx (a wrong key or model name)
   stops the worker with "Gemini rejected the key or model name"; a 429, a 5xx or no
   network only warns, and tasks wait for Gemini themselves.
4. Connect to Redis, and take the consumer name `<hostname>-<pid>`, e.g. `e02ff2af94f5-1`.

Postgres: nothing changes, apart from tables created on the very first start.

Log: `worker e02ff2af94f5-1: using gemini-3.5-flash, waiting for tasks`. Details:
[section 4](#4-startup).

### Step 2: Wait for a task

The loop in `main()`, forever. Each turn:

1. `XGROUP CREATE rci:tasks workers 0 MKSTREAM` joins the group (`BUSYGROUP` means it
   exists: fine).
2. Once a minute: `reconcile()` ([step 16](#step-16-the-reconciler-every-minute)).
3. `next_task()` looks in three places, in order, and takes the first task it finds:
   - `XREADGROUP GROUP workers <me> COUNT 1 STREAMS rci:tasks 0`: its **own** unacknowledged
     task, one it left to retry;
   - `XAUTOCLAIM rci:tasks workers <me> 300000 0-0 COUNT 1`: an **abandoned** task, one
     whose claim nobody has renewed for 5 minutes ([step 18](#step-18-a-worker-dies));
   - `XREADGROUP GROUP workers <me> COUNT 1 BLOCK 5000 STREAMS rci:tasks >`: a **new** task,
     waiting up to 5 seconds for one.
4. Nothing: back to 1. There is no polling interval: a new task is taken the moment it
   arrives.

In the example, the watcher has just saved circular 98 and queued its task:

| circulars.id | source | title | status | text |
|---|---|---|---|---|
| **98** | **RBI** | **Designation of terrorist organisation…** | **new** | *(empty)* |

```text
SET rci:queued:circular_id=98:type=circular.read 1 NX EX 86400
XADD rci:tasks * type circular.read circular_id 98
```

The worker's `XREADGROUP … >` returns it at once. Details: [section 5](#5-the-task-loop)
and [section 6](#6-taking-the-next-task).

### Step 3: Take the task and keep it claimed

`run_task()` in `main.py`.

1. Turn the task's fields into ids: `{"circular_id": 98}`.
2. Open a database session, and start `keep_claimed()`: a background thread that sends
   `XCLAIM rci:tasks workers <me> 0 <task id> JUSTID` every 60 seconds
   (`HEARTBEAT_SECONDS`). A claim resets the task's idle time, so however long the OCR
   takes, no other worker takes the task over and does it a second time.
3. Call the task's function from `TASKS`: `circular.read` → `read_circular(session,
   circular_id=98)`.
4. It returns: [step 9](#step-9-finish-the-task). It raises:
   [step 17](#step-17-a-step-fails).

No locks: the consumer group gave this task to this worker only. Details:
[section 7](#7-doing-a-task).

### Step 4: Skip it or read it

`read_circular()` in `pipeline.py`. This task runs **once per circular**, for every company.

1. `SELECT … FROM circulars WHERE id = 98`.
2. Missing, `skipped` or `failed`: nothing to do (**Reprocess** sets a failed one back to
   `new` or `parsed` first).
3. Still `new` but published before `LOOKBACK_DAYS` (30 days ago): `UPDATE circulars SET
   status = 'skipped'`, `COMMIT`, stop. An old circular costs no OCR and no Gemini call.
4. Otherwise carry on. Each step after this checks what's saved first: a circular already
   `parsed` skips step 5, and one with a summary skips step 6.

### Step 5: Get the text

`twin()` and `ocr_text()` in `pipeline.py`, `ocr.pages()` in `ocr.py`.

1. **A twin?** `SELECT … FROM circulars WHERE sha256 = '3f9a…' AND id <> 98 AND text IS NOT
   NULL`. Another circular with the identical PDF already has its text: copy it (no S3, no
   OCR) and go to 6.
2. **Pages read before?** `SELECT page, text FROM ocr_pages WHERE sha256 = '3f9a…'`. None
   the first time; after a crash or a restart, the pages read before it.
3. **The PDF:** `GET rbi/3f9a….pdf` from S3.
4. **Each of the first 20 pages** (`OCR_MAX_PAGES`) not read before, in order:
   - a blank page (no text, images or drawings) gets an empty text, and nothing is sent to
     the GPU;
   - any other page is rendered at 200 DPI and sent to the ocr service (one chat request,
     600 s timeout); `remove_det` strips the layout markers and drops image and footer
     blocks;
   - `INSERT INTO ocr_pages`, `COMMIT`, before the next page.

   While it runs:

   | sha256 | page | text |
   |---|---|---|
   | **3f9a…** | **0** | **"RESERVE BANK OF INDIA …"** |
   | **3f9a…** | **1** | **"2. Regulated entities shall …"** |
   | **3f9a…** | **2** | **""** (blank) |

5. Join the pages that have text. No text at all: raise `OCR found no text in the PDF`
   ([step 17](#step-17-a-step-fails)). The pages stay, so a **Reprocess** sends nothing
   to the GPU again.
6. `UPDATE circulars SET text = …, status = 'parsed'`, `DELETE FROM ocr_pages WHERE sha256
   = '3f9a…'`, `COMMIT`: the text and the clean-up in one transaction.

| circulars.id | status | text |
|---|---|---|
| 98 | **parsed** | **"RESERVE BANK OF INDIA … (12,408 characters)"** |

`ocr_pages`: **its 3 rows deleted**.

Log: `#98 parsed: 12408 chars`. After a restart halfway: `#98: 2 pages OCR'd before,
carrying on`. Cost: one OCR request per non-blank page, once per PDF. Details:
[section 11](#11-circularread).

### Step 6: Summarise it

Still `read_circular()`.

1. Already summarised (a retry): skip.
2. **A twin with a summary?** Copy its `addressed_to`, `summary` and `requirements`: no
   Gemini call.
3. Otherwise `llm.summarize()` sends `SUMMARY_PROMPT` with the regulator, the title and
   the first 100,000 characters (`LLM_MAX_CHARS`). The reply must match
   `CircularSummary`; anything else is a `BadReply`, retried
   ([step 17](#step-17-a-step-fails)).
4. `UPDATE circulars SET addressed_to, summary, requirements, embedding = NULL`, `COMMIT`.
   The embedding is cleared because it's made from the summary.

| id | addressed_to | summary | requirements |
|---|---|---|---|
| 98 | **All Regulated Entities… NBFCs…** | **RBI designates a new terrorist organisation…** | **["Report accounts … to FIU-IND", …]** |

Log: `#98 read: addressed to 'All Regulated Entities…'`.

### Step 7: Embed it

`embed_circular()`.

1. Already embedded with the current model: skip.
2. Embed "title + summary + requirements" (up to 5,000 characters) with
   `GEMINI_EMBEDDING_MODEL_NAME`, as a `RETRIEVAL_QUERY`: 768 numbers that capture its
   meaning, used in step 11.
3. `UPDATE circulars SET embedding, embedding_model`, `COMMIT`; then `UPDATE circulars SET
   status = 'read', error = NULL`, `COMMIT`.

| id | status | embedding | embedding_model |
|---|---|---|---|
| 98 | **read** | **[0.021, -0.013, …]** | **gemini-embedding-001** |

`read` is as far as the circular itself goes. Everything after this depends on the company.

### Step 8: An assessment for every company

1. `SELECT id FROM companies`: 1 and 2.
2. `add_assessments()`: one `INSERT INTO assessments … ON CONFLICT DO NOTHING` for all of
   them, `COMMIT`.
3. `pending()`: the pending assessments of this circular, as follow-up tasks.

| company_id | circular_id | status | applicable |
|---|---|---|---|
| **1** | **98** | **pending** | *(empty)* |
| **2** | **98** | **pending** | *(empty)* |

`read_circular` returns two follow-ups: `circular.assess` for (company 1, circular 98) and
for (company 2, circular 98).

### Step 9: Finish the task

Back in `run_task()`, the same for every task type, in this order:

1. `keep_claimed()` stops renewing the claim.
2. `DEL rci:queued:circular_id=98:type=circular.read`: from now on the same task may be
   queued again.
3. `enqueue` each follow-up, which sets its own key first and is dropped if that task is
   already queued:

   ```text
   SET rci:queued:circular_id=98:company_id=1:type=circular.assess 1 NX EX 86400
   XADD rci:tasks * type circular.assess company_id 1 circular_id 98
   SET rci:queued:circular_id=98:company_id=2:type=circular.assess 1 NX EX 86400
   XADD rci:tasks * type circular.assess company_id 2 circular_id 98
   ```

4. `XACK rci:tasks workers <task id>`: done.

Deleting the key before queueing lets a task queue itself again
([step 14](#step-14-a-policy-is-added-or-edited) does). A crash between these lines only
means the task runs once more, and finds its work done. With two workers, companies 1 and
2 are now judged **at the same time**, each by one worker.

### Step 10: Does it apply to this company?

`assess(session, company_id=1, circular_id=98)` in `pipeline.py`, once per company.

1. `SELECT` the company and the circular. The circular isn't `read`: nothing to do.
2. `INSERT` the assessment if it's missing (`ON CONFLICT DO NOTHING`), `COMMIT`, then
   `SELECT` it. Already `done`: stop.
3. The company has a description and `applicable IS NULL`: `llm.check_applicability()`
   sends `APPLICABILITY_PROMPT` with the description, the title, the addressees and the
   first 4,000 characters of the text (where a circular says who it's for).
   `UPDATE assessments SET applicable, applies_reason`, `COMMIT`.

| company_id | circular_id | applicable | applies_reason |
|---|---|---|---|
| 1 | 98 | **true** | **"Addressed to NBFCs, and the company is an NBFC."** |
| 2 | 98 | **false** | **"Addressed to banks and NBFCs; the company is a stock broker."** |

For company 2 it goes straight to [step 13](#step-13-mark-the-assessment-done): the circular
doesn't apply, so none of its policies is checked. The same happens when the circular has
no obligations. A company with no description yet keeps `applicable` NULL (the console says
"Not checked") and is asked when the description is saved
([step 15](#step-15-a-company-signs-up-or-is-described)).

### Step 11: Find the closest policies

`match()`, with no Gemini call.

1. `embed_circular()`: done in step 7 already, so nothing.
2. `SELECT … FROM policies WHERE company_id = 1`; keep those embedded with the current model
   that list `RBI` in `regulators`.
3. Score each one: the best cosine similarity between the circular's embedding and any of
   the policy's 5,000-character chunks. Keep the top `MATCH_TOP_K` (3).
4. `SELECT` the circular's judged pairs (`policy_checks`) and its gaps; skip a policy judged
   at its current version, or that has a gap: the answer is known.

| Policy | Score | Goes on to step 12? |
|---|---|---|
| POL-KYC | 0.82 | yes |
| POL-DRP | 0.58 | yes |
| POL-DLP | 0.55 | yes |
| POL-IT | 0.31 | no: not in the top 3 |

### Step 12: Is each policy out of date?

`judge_policy()`, one policy at a time.

1. `SELECT` the policy's controls.
2. `llm.assess()` sends `ASSESS_PROMPT` with the company's description, the circular (date,
   title, addressees, summary, obligations), the policy's text and its controls. The reply
   (`Verdict`): what's missing from the policy, impacted or not, the severity, the affected
   controls and a draft of the new wording.
3. The policy is out of date only if `impacted` is true **and** `missing_from_policy` isn't
   empty.
4. In one transaction: `INSERT INTO policy_checks`; if out of date, also `INSERT INTO gaps`
   (due in 7, 30 or 60 days by severity; only control codes that really exist) and
   `INSERT INTO gap_events` ("agent opened"); `COMMIT`. Then the next policy.

| circular_id | policy | policy_version | similarity | impacted |
|---|---|---|---|---|
| **98** | **POL-KYC** | **1** | **0.82** | **true** |
| **98** | **POL-DRP** | **1** | **0.58** | **false** |
| **98** | **POL-DLP** | **1** | **0.55** | **false** |

| Table | New row |
|---|---|
| `gaps` | **company 1 · circular 98 · POL-KYC v1 · "Update POL-KYC for RBI circular: Designation of…" · severity high · owner Head of Compliance · open · due in 7 days · draft "Add clause 2A: …"** |
| `gap_events` | **agent · opened · "The policy does not require reporting to FIU-IND…"** |

Log: `#98 vs POL-KYC v1 (0.82): GAP`, then `#98 vs POL-DRP v1 (0.58): up to date`, and so on.
Each verdict is committed before the next question, so a retry asks only about the
policies left. Details: [section 12](#12-circularassess).

### Step 13: Mark the assessment done

`UPDATE assessments SET status = 'done', error = NULL, updated_at = now()`, `COMMIT`.
`assess` returns no follow-ups, and [step 9](#step-9-finish-the-task) deletes its key and
acknowledges it.

| company_id | circular_id | status | applicable |
|---|---|---|---|
| 1 | 98 | **done** | true |
| 2 | 98 | **done** | false |

Log: `#98 for company 1: applies: True, gaps opened: ['POL-KYC']` and
`#98 for company 2: applies: False, gaps opened: none`. The console now shows circular 98 as
**analyzed** to both companies, and company 1's Gaps page has the new ticket.

That's the whole journey of a circular: OCR once per page and 1 summary **in total**, then
per company 1 "does it apply?" and, where it applies, up to 3 policy checks.

### Step 14: A policy is added or edited

Task `policy.check`, queued by the api after it saves the policy (here company 1 adds
POL-AML, id 15). `check_policy()` in `pipeline.py`:

1. Note `started = now()`. `SELECT` the policy and the company; a policy of another company
   is ignored.
2. `embed_policy()`: no embeddings (new, or the api cleared them because the title or text
   changed) or another model's: split the text into 5,000-character chunks, each with the
   title, embed them as `RETRIEVAL_DOCUMENT`, `UPDATE policies SET embeddings,
   embedding_model`, `COMMIT`.
3. `SELECT` the company's circulars whose assessment is `done` and applies, published in
   the last 30 days (their OCR text isn't loaded).
4. For each one with obligations, from a regulator the policy lists: `match()` and
   `judge_policy()` (steps 11 and 12). The new policy now competes for the top 3, and only
   pairs never judged cost a Gemini call.
5. `UPDATE policies SET checked_at = started`, `COMMIT`. The console switches from "Waiting
   for the worker" to "Checked".
6. Saved again while this ran (`updated_at > started`): it returns itself as a follow-up,
   and is checked once more.

| code | version | embeddings | checked_at |
|---|---|---|---|
| POL-AML | 1 | **[[0.012, …], [0.031, …]]** | **2026-10-01 10:15** |

Log: `embedded POL-AML (2 chunks) with gemini-embedding-001`, then
`POL-AML checked, gaps opened: none`. Details: [section 13](#13-policycheck).

### Step 15: A company signs up or is described

Task `company.refresh`, queued at sign-up and when a company saves a new description. For a
new description the api first sets that company's assessments of read circulars back to
`pending`, with `applicable` cleared; the OCR text, the summaries and the policy verdicts
are kept. `refresh_company()`:

1. `SELECT id FROM circulars WHERE status = 'read' AND published_at >= cutoff` (30 days).
2. `add_assessments()`: a pending assessment for each one the company lacks, `COMMIT`.
3. Return a `circular.assess` task for each pending one: steps 10 to 13, for this company
   only.

Company 2 rewrites its description:

| company_id | circular_id | status | applicable |
|---|---|---|---|
| 2 | 98 | **pending** | *(**cleared**)* |
| 2 | 97 | **pending** | *(**cleared**)* |

Only "does it apply?" is asked again; nothing is OCR'd or summarised again. Details:
[section 14](#14-companyrefresh).

### Step 16: The reconciler, every minute

Postgres is the truth; the stream is only the to-do list. If Redis was down when a task was
queued (`enqueue` only logs), or it lost its data, the work is still in Postgres.

1. Once a minute each worker tries `SET rci:reconciled <me> NX EX 900`. It succeeds for one
   worker per 15 minutes (`RECONCILE_MINUTES`).
2. That worker runs `missing_work()`:

   | Postgres shows | Task queued |
   |---|---|
   | a circular still `new` or `parsed` | `circular.read` |
   | a pending assessment of a read circular | `circular.assess` |
   | a policy never checked, saved after its check, or embedded with another model | `policy.check` |

3. It `enqueue`s each one; work already queued or running is skipped by its key.

Log: `reconciler: 3 unfinished tasks checked`. Details: [section 15](#15-the-reconciler).

### Step 17: A step fails

What a step committed stays committed. `run_task()` rolls back only the unfinished step,
then decides with the rules in `failures.py`:

| The error | What happens | Log |
|---|---|---|
| the ocr service can't be reached (the model is loading); Gemini 429 (quota) | wait 60 s (`RETRY_SECONDS`), no `XACK`: the same task is this worker's next one, for as long as it takes | `OCR or Gemini unavailable (…); retrying` |
| a 5xx, a timeout, a dropped connection, a reply not in the asked-for JSON, an `IntegrityError` (another task saved the same verdict first) | no `XACK`: tried again at once, up to 3 tries (`MAX_TRIES`) | `… failed (…); trying again` |
| anything else (a 400, "OCR found no text", S3 down or the PDF missing), or the third try | `give_up()`: a `circular.read` marks the circular `failed`, a `circular.assess` marks that company's assessment `failed`, both with the error; the task is copied to `rci:dead`; its key deleted; `XACK` | `… failed for good` |

The console shows a failed circular's error. **Reprocess** queues it again, and it resumes
from what was saved: the text, or the pages already OCR'd. Details:
[section 17](#17-when-something-fails).

### Step 18: A worker dies

A worker that dies mid-task never acknowledges it, and stops renewing its claim.

1. **Its container restarts** under the same name: [step 2](#step-2-wait-for-a-task) finds
   the task on its own pending list at once.
2. **It doesn't come back**, or `docker compose up --build` replaced it (a new container has
   a new name): once the claim is 5 minutes old (`CLAIM_IDLE_SECONDS`), another worker's
   `XAUTOCLAIM` takes the task over.
3. Either way the task starts again at its first step and skips everything committed:

| It died… | The rerun… |
|---|---|
| during OCR | OCRs only the pages not in `ocr_pages` (the one in flight is sent again) |
| after `parsed` | starts at the summary |
| after `read` | only adds the missing assessments and queues them |
| between two policy verdicts | asks only about the policies not judged yet |
| after `done` | has nothing to do |

Details: [section 16](#16-transactions-acknowledgements-and-crashes).

---

## 3. The files

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
| `main.py` | `main()` (the loop), `TASKS` (task type → pipeline function), `next_task`, `run_task` (do it, then delete its dedupe key, queue its follow-ups and acknowledge it, or retry, or give up), `keep_claimed` (renews the claim while a task runs), `give_up`, `reconcile`, `check_gemini` |
| `pipeline.py` | one function per task type: `read_circular`, `assess`, `check_policy`, `refresh_company`; `ocr_text` (OCR page by page, each saved) and `twin`; `match` and `judge_policy`; the embeddings; `missing_work` for the reconciler. Each returns the tasks to queue next |
| `../common/common/queue.py` | the Redis names, `connect()`, `key()` (a task's dedupe key) and `enqueue()` (shared with the watcher and the api) |
| `llm.py` | the Gemini client, the three prompts with their Pydantic reply models, `embed()` |
| `ocr.py` | PDF pages to text, one at a time (`pages()`): rendering, the OCR request, cleaning the output |
| `failures.py` | `should_wait`, `should_retry`, `gemini_status` |
| `storage.py` | `get_pdf()` from S3 |
| `config.py` | every setting, from the environment or `.env` |

---

## 4. Startup

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

## 5. The task loop

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        start(["main(): forever"]) --> join["XGROUP CREATE<br/>rci:tasks workers 0 MKSTREAM<br/>(BUSYGROUP: it exists, fine)"]
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

- Each turn starts with `XGROUP CREATE rci:tasks workers 0 MKSTREAM` (a group that exists
  already is fine). Starting at id `0` delivers tasks queued before any worker ever ran,
  and running it every turn recreates the group if Redis lost its data.
- There is **no polling interval**: `next_task` blocks on Redis for up to 5 seconds, and
  returns the moment a task arrives.
- `--once` (used by tests) works until a 5-second wait finds nothing, then exits.
- Redis down or timing out: the loop logs it, waits `RETRY_SECONDS` and starts again. The
  api and the watcher keep saving their changes meanwhile; the reconciler queues what was
  missed.

---

## 6. Taking the next task

`next_task()` looks in three places, in order, and takes one task:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a["XREADGROUP GROUP workers &lt;me&gt;<br/>COUNT 1 STREAMS rci:tasks <b>0</b>"] -->|"one of mine,<br/>never acknowledged"| r1(["retry it"])
        a -->|"none"| b["XAUTOCLAIM rci:tasks workers &lt;me&gt;<br/><b>300000</b> 0-0 COUNT 1"]
        b -->|"one idle 5 min<br/>(its worker died)"| r2(["take it over"])
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
  the stream, which keeps about 100,000 entries) is acknowledged and skipped.
- **`XAUTOCLAIM`** moves a task that has been pending with *another* consumer for
  `CLAIM_IDLE_SECONDS` (300) to this one. A live worker renews its claim every minute
  however slow the task (section 7), so a task idle that long belongs to a dead worker.
- **`>`** asks for a task never delivered to anyone in the group.

---

## 7. Doing a task

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
        fn -.->|"raised"| fail["should_wait / should_retry /<br/>give_up (section 17)"]
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
- **Keeping the claim.** While the function runs, `keep_claimed()` sends
  `XCLAIM rci:tasks workers <me> 0 <id> JUSTID` every `HEARTBEAT_SECONDS` (60) from a
  background thread. Claiming resets the task's idle time, so however long a task takes (a
  20-page PDF waiting its turn on the GPU), it never looks abandoned, and no second worker
  starts the same OCR. The thread stops when the function returns or raises.

---

## 8. The tables it uses

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        CO["<b>companies</b><br/>read: profile"]
        CI["<b>circulars</b> (shared)<br/>written: status, text, addressed_to,<br/>summary, requirements, embedding,<br/>embedding_model, error"]
        AS["<b>assessments</b><br/>inserted: one per company and circular<br/>written: status, applicable,<br/>applies_reason, error"]
        PO["<b>policies</b> (per company)<br/>written: embeddings,<br/>embedding_model, checked_at"]
        CT["<b>controls</b><br/>read, for the prompt"]
        PC["<b>policy_checks</b><br/>inserted: one per verdict"]
        GA["<b>gaps</b> (per company)<br/>inserted: one per out-of-date policy"]
        GE["<b>gap_events</b><br/>inserted: 'agent opened'"]
        OP["<b>ocr_pages</b><br/>inserted: one per page OCR'd<br/>deleted: once the text is saved"]
        CI -.->|"same sha256"| OP
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
    class GE,OP muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Table | The worker reads | The worker writes |
|---|---|---|
| `companies` | `profile` | nothing |
| `users` | nothing | nothing |
| `circulars` | the task's circular; recent ones for `policy.check` and `company.refresh` | `status`, `text`, `addressed_to`, `summary`, `requirements`, `embedding`, `embedding_model`, `error` |
| `assessments` | the task's (company, circular) | inserts one per company and circular; `status`, `applicable`, `applies_reason`, `error`, `updated_at` |
| `policies` | the company's embedded policies | `embeddings`, `embedding_model`, `checked_at` |
| `controls` | a policy's controls, for the prompt | nothing |
| `policy_checks` | the circular's judged pairs | one row per verdict |
| `gaps` | the circular's pairs that have a gap | one row per out-of-date policy, with `company_id` |
| `gap_events` | nothing | the first event of each gap: `agent`, `opened` |
| `ocr_pages` | the pages of the circular's PDF already OCR'd | one row per page as it's read; deletes them once the circular is `parsed` |

Unique constraints back the worker up: `assessments` (company, circular), `policy_checks`
(circular, policy, version) and `gaps` (circular, policy). Policy ids belong to one company,
so a (circular, policy) pair is always one company's.

---

## 9. Two statuses

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
        c_read -.->|"add_assessments()"| a_pending
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

## 10. No duplicates: the dedupe key

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

## 11. circular.read

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
            K->>PG: else SELECT the pages already in ocr_pages
            K->>X: GET the PDF
            loop each page not saved yet
                K->>X: OCR the page
                K->>PG: INSERT INTO ocr_pages, COMMIT
            end
            K->>PG: UPDATE text, status = 'parsed', DELETE its ocr_pages, COMMIT ①
        end
        opt summary IS NULL
            K->>PG: a twin with the same sha256 and a summary?
            K->>X: else SUMMARY_PROMPT + up to 100,000 characters
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

Inside `ocr_text()` and `ocr.pages()`:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        pdf["PDF bytes"] --> pages["First 20 pages<br/>(OCR_MAX_PAGES)"]
        pages --> saved{"In ocr_pages already?<br/>(same sha256, same page)"}
        saved -->|"yes: read before a retry,<br/>a restart or a takeover"| reuse["use the saved text,<br/>no OCR"]
        saved -->|"no"| blank{"Blank page?<br/>no text layer, images<br/>or drawings"}
        blank -->|"yes"| drop["text is empty,<br/>nothing sent"]
        blank -->|"no"| png["Render a PNG<br/>at 200 DPI"]
        png --> post["One chat request to the<br/>ocr service (600 s timeout)"]
        post --> clean["remove_det: strip markers,<br/>drop images, footers, '[No text]'"]
        clean --> save["INSERT INTO ocr_pages,<br/>COMMIT"]
        drop --> save
        save --> join["Join the pages:<br/>circulars.text"]
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
    class pdf,save data
    class blank,saved ask
    class drop,reuse muted
    class png,post gpu
    class clean svc
    class join ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Skipped, failed:** a circular already `skipped` or `failed` is left alone (Reprocess sets
  it back to `new` or `parsed` first). A `new` one published before `LOOKBACK_DAYS` becomes
  `skipped`.
- **One PDF, one OCR, one summary.** A circular whose PDF has the same `sha256` as one
  already read (a twin) copies its text: no S3, no OCR. It copies the twin's summary too:
  no Gemini call.
- **Every page is saved as it's read.** `ocr_text()` inserts each page's text into
  `ocr_pages` (keyed by the PDF's `sha256` and the page number) and commits before asking
  for the next. A retry after a timeout on page 15, a worker restarted by Docker, or one
  that takes the task over starts at page 15, and logs
  `#98: 14 pages OCR'd before, carrying on`. Only a page in flight when the worker died is
  sent again. The pages are deleted in the commit that saves the circular's text.
- **Empty result:** no text on any page raises `OCR found no text in the PDF`, and the
  circular is marked failed. Its pages stay in `ocr_pages`, so **Reprocess** doesn't send
  them to the GPU again.
- **The summary** is forced into JSON matching `CircularSummary`. It doesn't depend on any
  company, so no company's change ever repeats it.
- **The embedding** is made from the title, summary and obligations
  (`RETRIEVAL_QUERY`), once, for every company's matching.
- **Fan-out:** `add_assessments()` inserts a pending assessment for every company, in one
  statement (`ON CONFLICT DO NOTHING`), and `pending()` returns a `circular.assess` task
  for each company still pending.

Logs: `#98 parsed: 12408 chars`, `#98 read: addressed to '…'`.

---

## 12. circular.assess

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

**Does it apply?** is asked only when the company has a description and `applicable IS
NULL` (`llm.check_applicability`). The first 4,000 characters of the text are sent with the addressees: that's where a
circular says who it's for. Without a description the assessment is marked `done` with
`applicable` NULL ("Not checked"); a description saved later resets it to `pending`.

**The closest policies** (`match`), with no Gemini call:

1. The company's policies embedded with the current model that list the circular's
   regulator.
2. Each one's score is the best **cosine similarity** between the circular's embedding and
   any of the policy's 5,000-character chunks.
3. Keep the top `MATCH_TOP_K` (3), and skip pairs already judged at this version, or that
   have a gap (the owner is on it).

**What a verdict writes** (`judge_policy`):

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

## 13. policy.check

`check_policy(session, company_id, policy_id)`, queued by the api whenever a policy is
added or saved, and by the reconciler for a policy saved after its last check.

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
- **Which circulars:** the company's assessments that are `done` and apply, of circulars
  published in the last `LOOKBACK_DAYS` with obligations, from a regulator the policy
  lists. Their OCR text isn't loaded.
- **`checked_at`.** At the end the policy's `checked_at` is set to when the check started.
  A policy saved after that (`updated_at > checked_at`) shows as "Waiting for the worker" in
  the console, and `check_policy` queues itself once more.
- **Only unjudged pairs cost anything.** A policy whose owner or regulators changed is
  embedded already; only pairs never judged go to Gemini. An edited text is a new version,
  so its pairs are judged again, except those with a gap.

Log: `POL-AML checked, gaps opened: ['POL-AML']`.

---

## 14. company.refresh

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

## 15. The reconciler

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

## 16. Transactions, acknowledgements and crashes

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
| during OCR, before ① | each page read so far, in `ocr_pages` | OCRs only the pages not saved (the one in flight is sent again) |
| after ① | the text | summarises: no OCR |
| after ② | the summary | embeds it |
| after ④ or ⑤ | the circular is `read` | re-inserts nothing, queues the pending companies' tasks again |
| before ⑥'s `XACK` | the follow-up tasks were queued | runs again; its follow-ups are still queued, so their dedupe keys drop the copies |
| after ⑦ | "does it apply?" | goes straight to the policies |
| after ⑧ | the first verdict (and its gap) | asks only about the other policies |
| after ⑨ | the assessment is `done` | nothing to do |

**Who picks it up.** The same container, restarted by Docker, reads its own pending list
first. Otherwise another worker takes the task over once it has gone `CLAIM_IDLE_SECONDS`
(5 minutes) without its claim being renewed, and the reconciler may queue the unfinished
work sooner. A container recreated by `docker compose up --build` comes back with a new
name, so its old task waits those 5 minutes.

**Reloading after a commit.** SQLAlchemy expires a session's objects when it commits, so the
next use reads the row again: the worker always sees the latest values, including changes
the api made meanwhile.

---

## 17. When something fails

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
| **anything else** | a 400 from Gemini; `OCR found no text in the PDF`; S3 unreachable (Floci not running) or the PDF missing (`NoSuchKey`) | `give_up()`: `failed` with the error, the task copied to `rci:dead`, its key deleted, acknowledged | open the circular, read the error, press **Reprocess** |

- LangChain retries Gemini rate limits and server errors itself first (`max_retries=3`).
  `gemini_status()` reads the HTTP code from the error underneath LangChain's.
- The tries counter lives in the worker process, keyed by task id.
- `give_up` marks a `circular.read` failure on the circular (every company sees it) and a
  `circular.assess` failure on that company's assessment only. Other failures only go to
  `rci:dead`; the reconciler tries an unchecked policy again later.

---

## 18. What the api and the watcher queue

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

## 19. Every Redis command

| Command | Who | When |
|---|---|---|
| `SET rci:queued:<task> 1 NX EX 86400`, then `XADD rci:tasks MAXLEN ~ 100000 * type … ids …` | watcher, api, worker | a task is queued (`enqueue`); skipped if the key exists |
| `XGROUP CREATE rci:tasks workers 0 MKSTREAM` | worker | every turn of the loop; `BUSYGROUP` means it exists |
| `XREADGROUP GROUP workers <me> COUNT 1 STREAMS rci:tasks 0` | worker | its own unfinished task |
| `XAUTOCLAIM rci:tasks workers <me> 300000 0-0 COUNT 1` | worker | a dead worker's task |
| `XCLAIM rci:tasks workers <me> 0 <id> JUSTID` | worker | every minute while it runs a task: renews its claim |
| `XREADGROUP GROUP workers <me> COUNT 1 BLOCK 5000 STREAMS rci:tasks >` | worker | a new task |
| `DEL rci:queued:<task>`, then `XACK rci:tasks workers <id>` | worker | a task finished or given up |
| `XADD rci:dead * type … ids … task_id … error …` | worker | a task given up |
| `SET rci:reconciled <me> NX EX 900` | worker | once a minute: is it my turn to reconcile? |

To look inside: `docker compose exec redis redis-cli XINFO GROUPS rci:tasks` (`lag`: waiting,
`pending`: being worked on), `XRANGE rci:dead - +`, `KEYS rci:queued:*`.

---

## 20. Every database operation

What each task sends, in order. `…` stands for the values.

| Task | Statements |
|---|---|
| startup | `SELECT pg_advisory_xact_lock(hashtext('rci-schema'))`; `CREATE TABLE …`; `ALTER TABLE … ADD COLUMN …` for new columns; `COMMIT` |
| `circular.read` | `SELECT … FROM circulars WHERE id = …`; if new: the twin's text (`SELECT … WHERE sha256 = … AND id <> … AND text IS NOT NULL`), or `SELECT page, text FROM ocr_pages WHERE sha256 = …` and per page OCR'd `INSERT INTO ocr_pages`, `COMMIT`; `UPDATE circulars SET text, status = 'parsed'`, `DELETE FROM ocr_pages WHERE sha256 = …`, `COMMIT`; if no summary: the twin's (`… AND summary IS NOT NULL`) or Gemini's, `UPDATE … SET addressed_to, summary, requirements, embedding = NULL`, `COMMIT`; `UPDATE … SET embedding, embedding_model`, `COMMIT`; `UPDATE … SET status = 'read', error = NULL`, `COMMIT`; `SELECT id FROM companies`; `INSERT INTO assessments … ON CONFLICT DO NOTHING` (one statement for all), `COMMIT`; `SELECT company_id, circular_id FROM assessments JOIN circulars … WHERE pending` |
| `circular.assess` | `SELECT` the company and the circular; `INSERT INTO assessments … ON CONFLICT DO NOTHING`, `COMMIT`; `SELECT` the assessment; maybe `UPDATE assessments SET applicable, applies_reason`, `COMMIT`; `SELECT … FROM policies WHERE company_id = …`; `SELECT policy_id, policy_version FROM policy_checks WHERE circular_id = …`; `SELECT policy_id FROM gaps WHERE circular_id = …`; per policy asked: `SELECT … FROM controls`, `INSERT INTO policy_checks`, maybe `INSERT INTO gaps … RETURNING id` and `INSERT INTO gap_events`, `COMMIT`; `UPDATE assessments SET status = 'done', error = NULL, updated_at`, `COMMIT` |
| `policy.check` | `SELECT` the policy and the company; maybe `UPDATE policies SET embeddings, embedding_model`, `COMMIT`; `SELECT circulars … JOIN assessments …` (no `text`); per circular, the matching statements of `circular.assess`; `UPDATE policies SET checked_at`, `COMMIT` |
| `company.refresh` | `SELECT id FROM circulars WHERE status = 'read' AND published_at >= …`; `INSERT INTO assessments … ON CONFLICT DO NOTHING`, `COMMIT`; `SELECT … WHERE pending` |
| reconciler | `SELECT id FROM circulars WHERE status IN ('new', 'parsed')`; the pending assessments; `SELECT company_id, id FROM policies WHERE checked_at IS NULL OR checked_at < updated_at OR embedding_model IS DISTINCT FROM …` |
| giving up | `ROLLBACK`; `UPDATE circulars` or `UPDATE assessments SET status = 'failed', error = …`; `COMMIT` |

To watch them yourself, run a worker on the host with `echo=True` in `make_engine` for a
moment.

---

## 21. Cost of each event

What each event costs in OCR and Gemini calls; everything else is database and Redis work.

| Event | OCR | Gemini chat | Gemini embedding |
|---|---|---|---|
| worker starts | none | 1 (the configuration check) | 1 |
| nothing to do | none | none | none |
| a new circular | 1 per page, **once** | 1 summary, **once**; then per described company: 1 "applies?", plus 1 per top-3 policy where it applies | 1, once |
| the same PDF under a second circular | none | no summary; per company as above | 1 |
| a worker restarted or replaced mid-PDF | only the pages not saved yet | none extra | none extra |
| a new company signs up | none | none until it's described | none |
| a company describes itself (or changes it) | none | 1 per recent read circular, plus checks for pairs never judged | none |
| a new policy | none | 1 per recent circular where it ranks in the company's top 3 | 1 request for all its chunks |
| a policy's text edited | none | as for a new policy, except pairs with a gap | 1 |
| a policy's owner or regulators edited | none | only pairs never judged | none |
| **Reprocess** (read circular) | none | 1 "applies?" plus its "up to date" pairs again, for this company | none |

---

## 22. Settings and constants

Settings come from the environment or `.env` (`config.py`); an empty value keeps the
default. In Docker, only the settings `docker-compose.yml` passes reach the worker; the rest
keep their defaults unless you add them there.

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
| `CLAIM_IDLE_SECONDS` | 300 | how long a task can go without its claim renewed before another worker takes it |
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
| `HEARTBEAT_SECONDS` | 60 | `main.py` | how often a worker renews its claim on the task it's running |
| `DUE_DAYS` | high 7, medium 30, low 60 | `pipeline.py` | days a gap's owner gets, by severity |
| `EMBED_CHARS` | 5000 | `pipeline.py` | the chunk size for embeddings |
| embedding size | 768 | `llm.py` | numbers per embedding |
| applicability text | 4000 characters | `llm.py` | text sent for "does it apply?" |
| `DPI` | 200 | `ocr.py` | page rendering for OCR |

For what the log lines mean, see [Reading its log](../../how_it_works.md#reading-its-log).
