# How the worker works, in depth

![Python 3.14](https://img.shields.io/badge/Python_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white) ![SQLModel](https://img.shields.io/badge/SQLModel-7E56C2?style=flat-square) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Gemini via LangChain](https://img.shields.io/badge/Gemini_via_LangChain-8E75B2?style=flat-square&logo=googlegemini&logoColor=white) ![Unlimited-OCR on vLLM](https://img.shields.io/badge/Unlimited--OCR_on_vLLM-EA580C?style=flat-square) ![Docker Compose](https://img.shields.io/badge/Docker_Compose-2496ED?style=flat-square&logo=docker&logoColor=white)

This is the full story of the **worker**, the service that does the agent's thinking: every
step it takes, every row it reads and writes, every commit and every lock. For a short,
plain-words version, read [The worker in plain words](how_it_works.md#4-the-worker-in-plain-words)
first; this guide goes all the way down. The code is in [`backend/worker`](backend/worker).

**Reading the diagrams.** Each colour means the same thing in every diagram:

![our services](https://img.shields.io/badge/our_services-2dd4bf?style=flat-square) ![data](https://img.shields.io/badge/data-818cf8?style=flat-square) ![Gemini and outside services](https://img.shields.io/badge/Gemini_and_outside_services-c084fc?style=flat-square) ![OCR on the GPU](https://img.shields.io/badge/OCR_on_the_GPU-fb923c?style=flat-square) ![a decision](https://img.shields.io/badge/a_decision-fbbf24?style=flat-square) ![done, or OK](https://img.shields.io/badge/done,_or_OK-34d399?style=flat-square) ![a failure, or a gap](https://img.shields.io/badge/a_failure,_or_a_gap-fb7185?style=flat-square) ![where it starts](https://img.shields.io/badge/where_it_starts-a7ef6f?style=flat-square)

**Contents**

1. [The worker at a glance](#1-the-worker-at-a-glance)
2. [The files](#2-the-files)
3. [Startup](#3-startup)
4. [The loop](#4-the-loop)
5. [One round](#5-one-round)
6. [The tables it uses](#6-the-tables-it-uses)
7. [A circular's status](#7-a-circulars-status)
8. [Connections and locks](#8-connections-and-locks)
9. [Claiming a circular](#9-claiming-a-circular)
10. [Step 1: read the PDF](#10-step-1-read-the-pdf)
11. [Step 2: summarise it](#11-step-2-summarise-it)
12. [Step 3: does it apply to us?](#12-step-3-does-it-apply-to-us)
13. [Step 4: check the policies](#13-step-4-check-the-policies)
14. [The policy library](#14-the-policy-library)
15. [Transactions and crashes](#15-transactions-and-crashes)
16. [When something fails](#16-when-something-fails)
17. [What the api and the watcher change](#17-what-the-api-and-the-watcher-change)
18. [Every database operation](#18-every-database-operation)
19. [Cost of each event](#19-cost-of-each-event)
20. [Settings and constants](#20-settings-and-constants)

---

## 1. The worker at a glance

The worker is one Python process (`python main.py`) running in the `worker` container. It
never talks to the watcher or the api directly: **Postgres is the meeting point**. The
watcher and the api leave work in the database (new rows, cleared columns, changed
statuses); the worker picks it up, does it, and saves every result back.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        watcher["watcher"] -->|"new circulars:<br/>INSERT, status new"| PG[("Postgres<br/>the queue and<br/>every result")]
        api["api<br/>(your edits in the console)"] -->|"policies, company,<br/>Reprocess"| PG
        PG <-->|"claims work,<br/>saves each step"| K["<b>worker</b><br/>one loop, every 60 s"]
        S3[("S3 (Floci)<br/>the PDFs")] -->|"GET the PDF"| K
        K <-->|"one page image<br/>→ its text"| O["ocr<br/>Unlimited-OCR on the GPU"]
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
    class watcher,api,K svc
    class PG,S3 data
    class O gpu
    class G ext
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

It reaches four things:

| What | How | Used for |
|---|---|---|
| **Postgres** | SQLAlchemy / SQLModel, a connection pool | the work queue, every result, and the locks |
| **S3** (Floci locally) | boto3 | reading each circular's PDF, once |
| **ocr** | HTTP, the OpenAI-compatible API of vLLM | turning each page image into text, once |
| **Gemini** | LangChain (`langchain-google-genai`) | three questions per circular, and embeddings |

> 💡 **Nothing slow or paid for is ever done twice.** The OCR text, the summary, whether a
> circular applies, the embeddings and every policy verdict are saved the moment they exist.
> A restart, a crash or an outage carries on from the last saved step.

---

## 2. The files

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TB
    subgraph canvas[" "]
        direction TB
        main["<b>main.py</b><br/>the loop, claiming work,<br/>what happens on an error"]
        pipeline["<b>pipeline.py</b><br/>the four steps, embeddings,<br/>the catch-up"]
        locks["<b>locks.py</b><br/>Postgres advisory locks"]
        failures["<b>failures.py</b><br/>wait, retry or give up"]
        llm["<b>llm.py</b><br/>the three Gemini questions,<br/>embeddings"]
        ocr["<b>ocr.py</b><br/>PDF pages → text"]
        storage["<b>storage.py</b><br/>PDFs from S3"]
        config["<b>config.py</b><br/>settings from the environment"]
        common[("<b>common</b> (shared)<br/>models.py: the tables<br/>db.py: engine, init_db")]
        main --> pipeline
        main --> locks
        main --> failures
        pipeline --> llm
        pipeline --> ocr
        pipeline --> storage
        pipeline --> locks
        llm --> failures
        main -.-> common
        pipeline -.-> common
        main -.-> config
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
    class main,pipeline svc
    class locks,failures,config muted
    class llm ext
    class ocr gpu
    class storage,common data
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| File | What's in it |
|---|---|
| `main.py` | `main()` (the loop), `run_once()` (one round), `update_library()`, `process_next()` (claiming), `process()`, `retry_later()`, `skip_old()`, `check_gemini()` |
| `pipeline.py` | the four steps: `parse`, `read`, `judge`, `check_against_policies` / `match` / `check_policy`; embeddings: `embed_policies`, `embed_circulars`; the catch-up: `check_recent` |
| `llm.py` | the Gemini client, the three prompts with their Pydantic reply models, `embed()` |
| `ocr.py` | PDF to text: rendering pages, the OCR request, cleaning the output |
| `locks.py` | `held()`: take a Postgres advisory lock on its own connection for a with-block |
| `failures.py` | which errors mean wait, retry or give up |
| `storage.py` | `get_pdf()` from S3 |
| `config.py` | every setting, from the environment or `.env` |
| `backend/common` | shared with the watcher and api: the table models and `init_db` |

---

## 3. Startup

When the container starts, `main()` does this once, then enters the loop:

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant M as main.py
        participant C as config.py
        participant PG as Postgres
        participant G as Gemini
    end

    rect rgb(13, 20, 36)
        M->>C: load Settings from the environment and .env
        Note over C: GEMINI_API_KEY empty? stop with a clear error
        M->>PG: make_engine: a connection pool (pool_pre_ping)
        M->>PG: BEGIN, pg_advisory_xact_lock(key of "schema")
        Note over PG: only one service at a time changes the schema
        M->>PG: create_all: CREATE any missing table
        M->>PG: add_missing_columns: ALTER TABLE ADD COLUMN IF NOT EXISTS
        M->>PG: COMMIT (the schema lock is released)
        M->>G: llm.check: one chat call and one embedding
        alt Gemini answers 4xx (wrong key or model name)
            G-->>M: 400 / 403 / 404
            Note right of M: stop: "Gemini rejected the configuration"
        else it works (or 429, 5xx, no network: not a configuration problem)
            G-->>M: OK
            Note right of M: log "using gemini-… and gemini-embedding-001", start the loop
        end
    end
```

- **The schema lock** (`pg_advisory_xact_lock` on the key of `schema`) is a *transaction*
  lock: it's released by the COMMIT. Every service (watcher, worker, api) runs `init_db` at startup, and the lock
  makes them take turns, so two of them never try to create the same table at once.
- **`add_missing_columns`** adds any column a model gained after its table was created
  (always nullable). Nothing is ever dropped or altered.
- **`check_gemini`** turns a wrong key or model name into one clear error at startup,
  instead of a failure on every circular. A 429, a 5xx or no network doesn't stop the
  worker: those are handled in the loop.

---

## 4. The loop

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        start(["main(): the loop"]) --> run["run_once(): one round"]
        run --> ok{"Did the round<br/>raise an error?"}
        ok -->|"no"| once{"Started with --once?"}
        ok -->|"yes: temporary<br/>(service down or crashed)"| warn["log 'OCR or Gemini unavailable;<br/>retrying in 60s'"]
        ok -->|"yes: anything else"| crash["the worker exits;<br/>Docker restarts it<br/>(restart: unless-stopped)"]
        warn --> once
        once -->|"yes"| stop(["exit"])
        once -->|"no"| sleep["sleep POLL_SECONDS (60)"]
        sleep --> run
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
    class start start
    class run svc
    class ok,once ask
    class warn,sleep muted
    class crash bad
    class stop muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- The wait of `POLL_SECONDS` (60) starts **after** a round ends, so rounds never overlap
  within one worker.
- A **temporary** error (a service down, rate-limited or crashing) ends the round early, is
  logged, and the next round tries again. See [When something fails](#16-when-something-fails).
- Any **other** error that escapes a round, for example Postgres being unreachable, stops
  the process. Docker restarts it (`restart: unless-stopped`), and startup runs again.

---

## 5. One round

`run_once()` opens one database session for the round and does two things: look after the
policy library (in one worker at a time), then work through the queue of circulars.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        open["Open a database session"] --> lib{"Try the library lock<br/>(library)"}
        lib -->|"another worker has it"| queue
        lib -->|"got it"| skip["skip_old: mark new circulars<br/>older than 30 days as skipped"]
        skip --> embed["embed_policies: embed new<br/>and edited policies"]
        embed --> catch["check_recent: catch up recent<br/>circulars with the library<br/>(only if something changed)"]
        catch --> unlock["Release the library lock"]
        unlock --> queue{"process_next: claim a<br/>waiting circular"}
        queue -->|"claimed one"| work["Run steps 1 to 4 on it,<br/>then release it"]
        work --> queue
        queue -->|"nothing left to claim"| close["Close the session: end of round"]
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
    class open,close muted
    class lib,queue ask
    class skip,embed,catch,unlock svc
    class work ext
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

A round with nothing to do costs a handful of cheap queries and **no OCR or Gemini call**.
In a quiet round the library part stops right after comparing the library's state with the
last catch-up, and the queue part finds no waiting circular.

---

## 6. The tables it uses

The tables are defined once, in `backend/common/common/models.py`. This is what the worker
reads and writes in each:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        CO["<b>company</b><br/>read: profile, updated_at"]
        CI["<b>circulars</b><br/>read: everything<br/>written: status, text, addressed_to,<br/>summary, requirements, embedding,<br/>embedding_model, applicable,<br/>applies_reason, error"]
        PO["<b>policies</b><br/>read: everything<br/>written: embeddings, embedding_model"]
        CT["<b>controls</b><br/>read: code, description,<br/>frequency (for the prompt)"]
        PC["<b>policy_checks</b><br/>read: which pairs are judged<br/>inserted: one row per verdict"]
        GA["<b>gaps</b><br/>read: which pairs have a gap<br/>inserted: one per out-of-date policy"]
        GE["<b>gap_events</b><br/>inserted: 'agent opened'<br/>with each new gap"]
        CO -.->|"decides which apply"| CI
        CI --> PC
        PO --> PC
        PO --> CT
        CI --> GA
        PO --> GA
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
    class CO start
    class CI,PO,CT data
    class PC ok
    class GA bad
    class GE muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Table | The worker reads | The worker writes |
|---|---|---|
| `company` | the one row (`id = 1`): `profile`, `updated_at` | nothing |
| `circulars` | the waiting ones (`status` new or parsed), recent ones that apply | `status`, `text`, `addressed_to`, `summary`, `requirements`, `embedding`, `embedding_model`, `applicable`, `applies_reason`, `error` |
| `policies` | all of them | `embeddings`, `embedding_model` |
| `controls` | a policy's controls, for the prompt | nothing |
| `policy_checks` | which (circular, policy, version) pairs are judged | one row per Gemini verdict |
| `gaps` | which (circular, policy) pairs already have a gap | one row per out-of-date policy |
| `gap_events` | nothing | the first event of each new gap: `agent` `opened` |

Unique constraints back the worker up: `policy_checks` is unique by (circular, policy,
version) and `gaps` by (circular, policy), so even a bug could never store a verdict or a
gap twice.

---

## 7. A circular's status

`circulars.status` is the queue. Three services move it, and each only ever moves it along
the arrows below:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TB
    subgraph canvas[" "]
        direction TB
        s0((" ")) -->|"watcher: INSERT"| c_new(["new"])
        c_new -->|"worker, step 1: OCR saved"| c_parsed(["parsed"])
        c_parsed -->|"worker, steps 2 to 4 done"| c_analyzed(["analyzed"])
        c_new -->|"worker: published more<br/>than 30 days ago"| c_skipped(["skipped"])
        c_new -->|"worker: failed for good"| c_failed(["failed"])
        c_parsed -->|"worker: failed for good"| c_failed
        c_failed -->|"api: Reprocess<br/>(no OCR text yet)"| c_new
        c_failed -->|"api: Reprocess<br/>(OCR text kept)"| c_parsed
        c_analyzed -->|"api: Reprocess, or the<br/>company description changed"| c_parsed
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
    class s0 start
    class c_new queued
    class c_parsed data
    class c_analyzed ok
    class c_failed bad
    class c_skipped muted
    classDef queued fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Status | Meaning | Picked up by the worker? |
|---|---|---|
| `new` | saved by the watcher; nothing done yet | yes: starts at step 1 |
| `parsed` | the OCR text is saved | yes: starts at step 2 (skips anything already saved) |
| `analyzed` | finished | no (only the catch-up reads it) |
| `failed` | failed for good; `error` says why | no, until you press **Reprocess** |
| `skipped` | published before `LOOKBACK_DAYS` (30) | no |

---

## 8. Connections and locks

The worker's engine keeps a **pool** of Postgres connections (5, plus up to 10 more when
busy; `pool_pre_ping` replaces any the server closed). One worker uses several at once:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        subgraph proc["one worker process"]
            direction TB
            sess["<b>the work session</b><br/>(sqlmodel Session)<br/>reads and saves each step,<br/>commits after every step"]
            l1["<b>lock connection</b><br/>holds circular/id<br/>for the whole circular"]
            l2["<b>lock connection</b><br/>holds ocr while<br/>the PDF is on the GPU"]
            l3["<b>lock connection</b><br/>holds library while<br/>the library is updated"]
        end
        pool[("the engine's connection pool<br/>5 connections + 10 extra")]
        PG[("Postgres")]
        sess --> pool
        l1 --> pool
        l2 --> pool
        l3 --> pool
        pool --> PG
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
    class sess svc
    class l1,l2,l3 ask
    class pool,PG data
    style proc fill:#0c1a24,stroke:#2dd4bf
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- The **work session** runs the steps. It commits after every step (see
  [Transactions and crashes](#15-transactions-and-crashes)); after a commit it hands its
  connection back to the pool and takes one again for the next statement.
- Each **lock** lives on a connection of its own, taken by `locks.held()` for exactly the
  length of a with-block. That's what lets a lock outlast the work session's commits.

The locks are Postgres **advisory locks**: locks on a 64-bit number of the app's choosing,
not on any row. `pg_try_advisory_lock(key)` answers at once, true (yours now) or false
(someone else has it); `pg_advisory_lock(key)` waits until it's free; `pg_advisory_unlock`
gives it back. If a worker dies, its connections close and Postgres releases its locks by
itself.

Each lock has a **name**, and `lock_key()` (in `backend/common/common/db.py`) turns it into the
key: a blake2b hash of the app, the connection's **schema** (`SELECT current_schema()`) and the
name. Every worker derives the same key from the same name, and nothing else collides with it.

| Lock | Name | Held while | If another worker holds it |
|---|---|---|---|
| a circular | `circular/<id>` | one circular is processed | skip it, try the next |
| the GPU | `ocr` | a PDF is being read with OCR | take a circular that's already read; if none, wait |
| the policy library | `library` | skipping old circulars, embedding policies, the catch-up | skip that part of the round |
| the schema | `schema`, a transaction lock | `init_db` at startup | wait |

**Several companies.** The app serves one company per deployment. Deployments for different
companies can share a Postgres server (a database each) or even a database (a schema each):
Postgres keeps advisory locks per database, and the schema is part of every key, so one
company's workers never block another's.

With one worker, every lock is simply always free. With several (`WORKERS=3`), they're what
keeps the workers out of each other's way. Why advisory locks rather than
`SELECT … FOR UPDATE SKIP LOCKED` is explained in
[Why not FOR UPDATE SKIP LOCKED](how_it_works.md#why-not-for-update-skip-locked).

---

## 9. Claiming a circular

`process_next()` finds one waiting circular that no other worker holds, and processes it.
The round repeats it until nothing is left to claim:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        list["waiting(): SELECT id FROM circulars<br/>WHERE status IN ('new','parsed')<br/>ORDER BY published_at DESC NULLS LAST"] --> tryc{"Try its lock<br/>(circular/id)"}
        list -->|"none left to try"| idle["End of the queue:<br/>the round ends"]
        tryc -->|"false: another<br/>worker holds it"| skip1["Skip it:<br/>try the next one"]
        tryc -->|"true"| fresh{"SELECT the circular again<br/>(populate_existing):<br/>still new or parsed?"}
        fresh -->|"no: another worker<br/>just finished it"| skip2["Unlock it:<br/>try the next one"]
        fresh -->|"yes"| isnew{"status new?<br/>(needs step 1)"}
        isnew -->|"yes"| gpu{"The ocr lock:<br/>try, or wait on the<br/>second pass"}
        gpu -->|"busy, first pass"| skip3["Unlock it:<br/>try the next one"]
        gpu -->|"got it"| s1["Step 1: read the PDF,<br/>then unlock the GPU"]
        isnew -->|"no: parsed"| s2["Steps 2 to 4"]
        s1 --> s2
        s2 --> done["Unlock circular/id,<br/>start again from the list"]
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
    class list data
    class tryc,fresh,isnew,gpu ask
    class idle,skip1,skip2,skip3 muted
    class s1 gpu
    class s2 ext
    class done ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

Two details make it safe and efficient:

- **The status is read again after the lock is taken** (`session.get(…,
  populate_existing=True)`). Between listing the circulars and locking one, another worker
  may have finished it; re-reading means it's never started twice.
- **Two passes.** The first pass only takes what can start at once. If every free circular
  needs the GPU and another worker is using it, the second pass claims the first one and
  **waits** for the GPU (`pg_advisory_lock`) instead of skipping it, so no worker sits idle
  while there's work.

Each claimed circular is logged as `#98 RBI: <title>`.

---

## 10. Step 1: read the PDF

`pipeline.parse()` runs for a `new` circular, under the GPU lock.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant S3 as S3 (Floci)
        participant O as ocr (GPU)
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT * FROM circulars WHERE sha256 = … AND id <> … AND text IS NOT NULL
        alt another circular has the same PDF and its text
            PG-->>K: that circular
            Note right of K: copy its text: no S3, no OCR
        else first time this PDF is seen
            K->>S3: GET rbi/sha256.pdf
            S3-->>K: the PDF bytes
            loop each page, up to OCR_MAX_PAGES (20)
                Note right of K: blank page? skip it.<br/>render a 200 DPI PNG, hash it
                K->>O: POST /v1/chat/completions: the page image
                O-->>K: tagged text blocks
                Note right of K: strip the markers, drop footers and images
            end
        end
        Note right of K: no text at all? raise "OCR found no text" (marks it failed)
        K->>PG: UPDATE circulars SET text = …, status = 'parsed' WHERE id = …
        K->>PG: COMMIT
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
    class pdf data
    class blank,cache ask
    class drop,reuse muted
    class png,post gpu
    class clean svc
    class join ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **One PDF, one OCR.** A circular whose PDF is byte-for-byte the same as one already read
  (the same `sha256`) copies that text, with no S3 or OCR call.
- **Page cache.** Pages already read are kept in memory by the hash of their image until
  the document is done, so a retry after a timeout on page 15 starts at page 15. The cache
  lives in the worker process, so a restart starts the document again.
- **The request** follows the model's vLLM recipe: the prompt `<image>document parsing.`,
  `temperature: 0`, and a no-repeat n-gram setting (`ngram_size 35`, `window_size 128`)
  that stops it looping on tables. All pages go over one reused HTTP connection.
- **Empty result.** If no page has any text, the step raises `OCR found no text in the PDF`
  and the circular is marked failed, rather than being summarised from its title alone.
- The GPU lock is taken for any `new` circular, including one whose text turns out to be
  copied from a twin.

After the COMMIT the circular is `parsed`, and its text is never read from the PDF again.
Log: `#98 parsed: 12408 chars` (or `#98 same PDF as #97: reusing its OCR text`).

---

## 11. Step 2: summarise it

`pipeline.read()` runs when `summary IS NULL`: for a circular that's just been parsed, or
one sent back by **Reprocess**, which clears it.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant G as Gemini
        participant PG as Postgres
    end

    rect rgb(13, 20, 36)
        Note right of K: runs only if summary IS NULL (new, or sent back by Reprocess)
        K->>G: SUMMARY_PROMPT + regulator + title + up to 100,000 characters of the text
        G-->>K: JSON: addressed_to, summary, requirements[]
        Note right of K: not valid JSON? BadReply: retried like a hiccup
        K->>PG: UPDATE circulars SET addressed_to, summary, requirements (and embedding = NULL)
        K->>PG: COMMIT
    end
```

- The reply is forced into JSON matching `CircularSummary` (LangChain
  `with_structured_output`). The prompt asks for obligations with numbers, time limits and
  dates exactly as written, and none of the "comply with the circular" kind.
- Saving a new summary sets `embedding = NULL`, because the circular's embedding is made
  from the summary and must be made again.
- The summary doesn't depend on your company, so a change to the company description never
  repeats this step.

---

## 12. Step 3: does it apply to us?

`pipeline.judge()` runs only when the company has been described **and**
`applicable IS NULL`.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant G as Gemini
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT * FROM company WHERE id = 1
        PG-->>K: the profile (or nothing)
        alt no company description yet
            Note right of K: leave applicable NULL: nothing is judged or checked
        else described, and applicable IS NULL
            K->>G: APPLICABILITY_PROMPT + your description + addressed_to + first 4,000 characters
            G-->>K: JSON: reason, applies_to_company
            K->>PG: UPDATE circulars SET applicable, applies_reason
            K->>PG: COMMIT
        end
    end
```

- **No description, no judgement.** Without a company description, `applicable` stays
  `NULL` (shown as "Not checked") and step 4 is skipped: the worker never guesses who you
  are.
- **Once per description.** When you change the description, the api sets `applicable =
  NULL` on every circular and sends the analysed ones back to `parsed`, so this step runs
  again for each of them, and only this step.
- Only the first 4,000 characters of the text are sent: the addressee and the scope are at
  the top of a circular.

---

## 13. Step 4: check the policies

`pipeline.check_against_policies()` runs when the circular **applies** and **has
obligations**. It finds the policies worth asking about, then `match()` asks Gemini about
each and saves the verdicts.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant G as Gemini
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT * FROM policies
        Note right of K: keep the policies that are embedded<br/>and list this circular's regulator
        K->>G: embed title + summary + requirements (RETRIEVAL_QUERY), if not done yet
        K->>PG: UPDATE circulars SET embedding, embedding_model
        K->>PG: COMMIT
        K->>PG: SELECT circular_id, policy_id, policy_version FROM policy_checks WHERE circular_id = …
        K->>PG: SELECT circular_id, policy_id FROM gaps WHERE circular_id = …
        Note right of K: score each policy: cosine similarity,<br/>its best chunk wins. Keep the top 3
        loop each of the top 3 not judged at this version, with no gap
            K->>PG: SELECT * FROM controls WHERE policy_id = …
            K->>G: ASSESS_PROMPT + company + the circular + the policy text and controls
            G-->>K: JSON: missing_from_policy, impacted, severity, affected_controls, draft_change
            K->>PG: INSERT INTO policy_checks (the verdict)
            opt out of date
                K->>PG: INSERT INTO gaps (…) RETURNING id
                K->>PG: INSERT INTO gap_events ('agent', 'opened')
            end
            K->>PG: COMMIT (the verdict, the gap and its event together)
        end
        K->>PG: UPDATE circulars SET status = 'analyzed', error = NULL
        K->>PG: COMMIT
    end
```

**How the closest policies are chosen** (`closest_policies`), with no Gemini call:

1. Keep the policies that are embedded with the current model and list the circular's
   regulator.
2. Score each one: the **cosine similarity** between the circular's embedding and each of
   the policy's chunk embeddings, and take the **best chunk**. A long policy is split into
   5,000-character chunks, so a clause deep inside it still counts.
3. Sort by score and keep the top `MATCH_TOP_K` (3).
4. Skip any pair Gemini has already judged at this policy version (`policy_checks`), or
   that already has a gap (`gaps`): its owner is already on it.

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
    class ask ext
    class imp ask
    class up ok
    class down,gap bad
    class ev muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

The verdict, the gap and its first event are written in **one transaction**: they're saved
together or not at all. Each verdict is committed before the next policy is asked about, so
a failure halfway keeps every verdict already given.

Finally the circular's `status` becomes `analyzed` and `error` is cleared. Logs:
`#98 vs POL-KYC v1 (similarity 0.74): GAP` for each verdict, then
`#98 analyzed: addressed to '…', applies to us: True, gaps opened: ['POL-KYC']`.

---

## 14. The policy library

The first part of every round looks after the policy library, in one worker at a time
(the library lock). It has three jobs.

**Skip old circulars.** `skip_old()` marks `new` circulars published more than
`LOOKBACK_DAYS` (30) ago as `skipped`, so a first start doesn't work through years of
history.

**Embed new and edited policies.** `embed_policies()`:

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant G as Gemini
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT * FROM policies
        Note right of K: to do: embeddings IS NULL (new, or the api cleared them),<br/>or embedded with another model
        Note right of K: split each one's "title + text" into<br/>5,000-character chunks
        K->>G: embed every chunk of every policy (RETRIEVAL_DOCUMENT), in as few requests as possible
        G-->>K: one vector of 768 numbers per chunk
        K->>PG: UPDATE policies SET embeddings, embedding_model (one per policy)
        K->>PG: COMMIT
    end
```

A policy needs embedding when it's new, when the api cleared its embeddings (its title or
text changed), or when `GEMINI_EMBEDDING_MODEL_NAME` changed, since vectors from two models
can't be compared. A change of owner, controls or regulators doesn't touch the embeddings.

**Catch up.** `check_recent()` makes sure every recent circular that applies has been
checked against its closest policies at their current version. Normally that happened when
the circular was analysed; the catch-up handles what changed since: a policy added or
edited, a regulator added to a policy, or an interruption halfway.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        state["library_state(): the company's updated_at,<br/>count and max(updated_at) of policies,<br/>count and max(id) of recent circulars that apply"] --> same{"Same as when the last<br/>catch-up finished?"}
        same -->|"yes"| nothing["Do nothing more<br/>(no more queries, no Gemini)"]
        same -->|"no"| recent["recent_circulars(): analyzed, applies,<br/>last 30 days, has obligations, from a<br/>regulator some policy lists (OCR text not loaded)"]
        recent --> emb["embed any of them not embedded yet"]
        emb --> pairs["checked_pairs(): every judged pair<br/>and every gap, in two queries"]
        pairs --> each{"For each circular:<br/>try its lock (circular/id)"}
        each -->|"another worker is<br/>processing it"| later["leave it to that worker;<br/>catch up again next round"]
        each -->|"got it"| m["match(): only unjudged<br/>top-3 pairs go to Gemini"]
        m --> fin["When every circular is done:<br/>remember the state, so the next<br/>round does nothing"]
        later --> fin
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
    class state data
    class same,each ask
    class nothing,later muted
    class recent,emb,pairs svc
    class m ext
    class fin ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Skipped while nothing changed.** The state compared is small: the company's
  `updated_at`, `MATCH_TOP_K`, the number of policies and their latest `updated_at`, and the
  number and latest id of recent circulars that apply. The worker keeps the state of its last
  finished catch-up in memory (`CatchUp.finished`), so after a restart it runs once, finds
  every pair already judged, and asks Gemini nothing.
- **Only unjudged pairs cost anything.** `checked_pairs()` loads every judged pair and
  every gap once, and `match()` skips them.
- **Respects claims.** A circular another worker is processing is left to that worker,
  and the catch-up runs again next round.
- **Errors.** A service that's down ends the round. A crash is retried next round, up to 3
  times per circular (`CatchUp.tries`); after that, or on any other error, that circular is
  left alone until the worker restarts (`CatchUp.given_up`), so one bad circular can't cost
  a Gemini call every minute.

---

## 15. Transactions and crashes

The work session **commits after every step**. These are the commit points for one circular
that applies and has two policies to check:

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker (work session)
        participant PG as Postgres
    end

    rect rgb(13, 20, 36)
        K->>PG: UPDATE circulars SET text, status = 'parsed'
        K->>PG: COMMIT ①
        K->>PG: UPDATE circulars SET addressed_to, summary, requirements
        K->>PG: COMMIT ②
        K->>PG: UPDATE circulars SET applicable, applies_reason
        K->>PG: COMMIT ③
        K->>PG: UPDATE circulars SET embedding, embedding_model
        K->>PG: COMMIT ④
        K->>PG: INSERT policy_checks (+ gaps, gap_events): policy 1
        K->>PG: COMMIT ⑤
        K->>PG: INSERT policy_checks (+ gaps, gap_events): policy 2
        K->>PG: COMMIT ⑥
        K->>PG: UPDATE circulars SET status = 'analyzed'
        K->>PG: COMMIT ⑦
    end
```

Because every step is saved before the next starts, a crash (the process killed, the
machine rebooted) never loses more than the step in progress:

| The crash happens… | What's saved | What the next round does |
|---|---|---|
| during OCR, before ① | nothing | reads the PDF again (the page cache was in the dead process) |
| after ① | the text; status `parsed` | starts at step 2: no OCR |
| after ② | the summary | starts at step 3 |
| after ③ | whether it applies | starts at step 4 |
| after ④ | the circular's embedding | ranks the policies without embedding it again |
| after ⑤ | the first verdict (and its gap) | asks Gemini only about policy 2 |
| after ⑦ | everything; status `analyzed` | nothing: it's done |

Its locks are released by Postgres the moment the dead process's connections close, and the
circular is still `new` or `parsed`, so the next round (in this worker after a restart, or in
another worker) claims it again.

**Reloading after a commit.** SQLAlchemy expires the objects of a session when it commits,
so the next time the circular or a policy is used, its row is read again (`SELECT … WHERE id
= …`). That's why the worker always sees the latest values, including changes the api made
meanwhile.

---

## 16. When something fails

Every error while processing a circular goes through the same decision
(`process()` in `main.py`, the rules in `failures.py`):

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        err["An exception while processing<br/>a circular"] --> rb["ROLLBACK the work session:<br/>the unsaved step is undone"]
        rb --> down{"service_down?<br/>can't connect (OCR loading),<br/>or Gemini 429 (quota)"}
        down -->|"yes"| wait["End the round; the circular<br/>keeps its status. Try again<br/>next round, for as long as it takes"]
        down -->|"no"| crashed{"service_crashed?<br/>5xx, timeout, dropped connection,<br/>BadReply (not the asked-for JSON)"}
        crashed -->|"yes"| count{"Third time for this<br/>circular in this process?<br/>(crashes counter, MAX_TRIES)"}
        count -->|"no"| wait
        count -->|"yes"| failed
        crashed -->|"no: e.g. a 400,<br/>'OCR found no text'"| failed["UPDATE circulars SET<br/>status = 'failed', error = '…'<br/>COMMIT, then the next circular"]
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
    class err bad
    class rb muted
    class down,crashed,count ask
    class wait muted
    class failed bad
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Error | Examples | What happens | What you do |
|---|---|---|---|
| **service down** | can't connect to ocr (the model is loading); Gemini 429 (quota) | the round ends; the circular keeps its status and is retried every minute | nothing, or raise your Gemini quota |
| **service crashed** | a 5xx; a timeout; a dropped connection; `BadReply` (Gemini's answer isn't the asked-for JSON) | retried next round, up to `MAX_TRIES` (3) per circular, then treated as below | usually nothing |
| **anything else** | a 400 from Gemini; `OCR found no text in the PDF` | `status = 'failed'`, `error` saved, next circular | open the circular, read the error, press **Reprocess** |

- LangChain retries Gemini's rate limits and server errors itself first (`max_retries=3`).
  Only then does the worker's rule apply. LangChain wraps Gemini's errors in its own
  classes, so `gemini_status()` reads the HTTP code from the original error underneath.
- The retry counter (`crashes`) lives in the worker process: a restart resets it.
- Errors in the library part are handled the same way, except that a non-temporary error is
  only logged (`couldn't update the policy library's embeddings or checks`) and the queue is
  still processed.

---

## 17. What the api and the watcher change

The worker reacts to what the other services write. None of them calls the worker: they
change the database, and the worker notices on its next round.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant W as watcher
        participant A as api (your console)
        participant PG as Postgres
        participant K as worker
    end

    rect rgb(13, 20, 36)
        W->>PG: INSERT INTO circulars (…, status 'new')
        A->>PG: POST /policies: INSERT INTO policies (version 1, embeddings NULL)
        A->>PG: PUT /policies/{id}: UPDATE policies (embeddings NULL if title or text changed,<br/>version + 1 if text changed, updated_at), INSERT gap_events 'policy_updated'
        A->>PG: PUT /company: UPDATE company, then UPDATE circulars SET applicable = NULL,<br/>and SET status = 'parsed' WHERE status = 'analyzed'
        A->>PG: POST /circulars/{id}/reprocess: UPDATE circulars (clear the Gemini fields, status new or parsed),<br/>DELETE FROM policy_checks WHERE impacted IS false
        Note left of K: next round, within 60 seconds
        K->>PG: sees the new rows, the cleared columns and the changed statuses, and acts on them
    end
```

| You do (or the watcher does) | The database change | What the worker then does |
|---|---|---|
| a regulator publishes a circular | watcher: `INSERT INTO circulars` with status `new` | steps 1 to 4 |
| add a policy | `INSERT INTO policies`, version 1, no embeddings | embeds it; the catch-up checks it against recent circulars |
| edit a policy's text | `embeddings = NULL`, `version + 1`, `updated_at`; a `policy_updated` event on its open gaps | re-embeds it; the new version is checked again (pairs with a gap excepted) |
| edit a policy's title | `embeddings = NULL`, `updated_at` | re-embeds it; only pairs never judged are checked |
| edit a policy's regulators or owner | `updated_at` | the catch-up runs; with new regulators, their circulars are checked |
| add a control | `INSERT INTO controls` | nothing now; the control is part of the next checks |
| change the company description | `applicable = NULL` everywhere; `analyzed` → `parsed` | step 3 again for each circular, then step 4 for pairs never judged |
| press **Reprocess** | clears `addressed_to`, `summary`, `requirements`, `embedding`, `applicable`, `applies_reason`, `error`; status `parsed` (or `new` without text); deletes the circular's "up to date" verdicts | steps 2 to 4 again, no OCR; gaps are kept and never duplicated |

---

## 18. Every database operation

Every statement the worker sends, in the order of a round. This list was checked against a
trace of the real worker's SQL. `…` stands for the values.

| # | Where | Statement | Why |
|---|---|---|---|
| 1 | `init_db` (startup) | `SELECT current_schema()`, `SELECT pg_advisory_xact_lock(<key of schema>)`, `CREATE TABLE …`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`, `COMMIT` | create missing tables and columns, one service at a time |
| 2 | `update_library` | `SELECT current_schema()`, `SELECT pg_try_advisory_lock(<key of library>)` | only one worker looks after the library |
| 3 | `skip_old` | `SELECT … FROM circulars WHERE status = 'new' AND published_at < …`, then `UPDATE circulars SET status = 'skipped'` for each, `COMMIT` | set aside circulars older than 30 days |
| 4 | `embed_policies` | `SELECT … FROM policies`, then `UPDATE policies SET embeddings = …, embedding_model = … WHERE id = …`, `COMMIT` | embed new and edited policies |
| 5 | `library_state` | `SELECT … FROM company WHERE id = 1`; `SELECT count(*), max(updated_at) FROM policies`; `SELECT count(*), max(id) FROM circulars WHERE status = 'analyzed' AND applicable IS true AND published_at >= …` | has anything changed since the last catch-up? |
| 6 | `recent_circulars` | the same `WHERE` on `circulars`, every column except `text` | the circulars to catch up |
| 7 | `checked_pairs` | `SELECT circular_id, policy_id, policy_version FROM policy_checks`; `SELECT circular_id, policy_id FROM gaps` | pairs never to ask about again |
| 8 | `update_library` | `SELECT pg_advisory_unlock(<key of library>)` | release the library |
| 9 | `waiting` | `SELECT id FROM circulars WHERE status IN ('new', 'parsed') ORDER BY published_at DESC NULLS LAST` | the queue |
| 10 | `process_next` | `SELECT current_schema()`, `SELECT pg_try_advisory_lock(<key of circular/id>)` | claim one circular |
| 11 | `process_next` | `SELECT … FROM circulars WHERE id = …` | re-read it after the claim |
| 12 | `process` | `SELECT current_schema()`, `SELECT pg_try_advisory_lock(<key of ocr>)` or `pg_advisory_lock(…)` | the GPU, for step 1 |
| 13 | `parse` | `SELECT … FROM circulars WHERE sha256 = … AND id <> … AND text IS NOT NULL` | a twin with the same PDF? |
| 14 | `parse` | `UPDATE circulars SET text = …, status = 'parsed' WHERE id = …`, `COMMIT` | step 1 saved |
| 15 | `read` | `UPDATE circulars SET addressed_to = …, summary = …, requirements = … WHERE id = …`, `COMMIT` | step 2 saved |
| 16 | `company_profile` | `SELECT … FROM company WHERE id = 1` | the description for step 3 |
| 17 | `judge` | `UPDATE circulars SET applicable = …, applies_reason = … WHERE id = …`, `COMMIT` | step 3 saved |
| 18 | `embedded_policies` | `SELECT … FROM policies` | the candidates for step 4 |
| 19 | `embed_circulars` | `UPDATE circulars SET embedding = …, embedding_model = … WHERE id = …`, `COMMIT` | the circular's embedding |
| 20 | `checked_pairs` | the two queries of #7, `WHERE circular_id = …` | this circular's judged pairs |
| 21 | `check_policy` | `SELECT … FROM controls WHERE policy_id = …` | the policy's controls, for the prompt |
| 22 | `check_policy` | `INSERT INTO policy_checks (…)`; if out of date `INSERT INTO gaps (…)` and `INSERT INTO gap_events (…)`; `COMMIT` | one verdict saved |
| 23 | `analyze` | `UPDATE circulars SET status = 'analyzed', error = NULL WHERE id = …`, `COMMIT` | the circular is done |
| 24 | `process` (on failure) | `ROLLBACK`; `UPDATE circulars SET status = 'failed', error = … WHERE id = …`, `COMMIT` | failed for good |
| 25 | `process_next` | `SELECT pg_advisory_unlock(<key of ocr>)`, `SELECT pg_advisory_unlock(<key of circular/id>)` | release the GPU (after step 1) and the circular |

Between these, after each commit, SQLAlchemy reads rows back as they're used (see
[Transactions and crashes](#15-transactions-and-crashes)). Only the catch-up (#6) leaves out
the OCR text, since it never needs it.

To watch the statements yourself, run the worker on the host with SQL logging, for example
by setting `echo=True` in `make_engine` for a moment.

---

## 19. Cost of each event

What each event costs in OCR and Gemini calls. Everything else is database work.

| Event | OCR | Gemini chat | Gemini embedding |
|---|---|---|---|
| worker starts | none | 1 (the configuration check) | 1 |
| a quiet round | none | none | none |
| a new circular that doesn't apply | 1 per page | 2 (summary, applies?) | none |
| a new circular that applies, with obligations | 1 per page | 2, plus 1 per policy in its top 3 | 1 (the circular) |
| the same PDF under a second circular | none | as above | as above |
| a new policy | none | 1 per recent circular where it ranks in the top 3 | 1 request for all its chunks |
| a policy's text edited | none | as for a new policy, except pairs with a gap | 1 |
| a policy's owner, controls or regulators edited | none | only for pairs never judged | none |
| the company description changed | none | 1 per analysed circular (applies?), plus checks for pairs never judged | per circular not yet embedded |
| **Reprocess** | none | 2, plus checks for its "up to date" pairs | 1 |

---

## 20. Settings and constants

Settings come from the environment or `.env` (`config.py`). A variable set to an empty
string keeps its default.

| Setting | Default | What it controls |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://rci:rci@localhost:5432/rci` | the database |
| `S3_ENDPOINT_URL` | empty: real AWS (compose sets Floci, `http://host.docker.internal:4566`) | where the PDFs are |
| `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` | `rci`, empty, empty, `us-east-1` (compose passes `test` keys for Floci) | the bucket and credentials |
| `OCR_URL` | `http://localhost:8001/v1` | the ocr service |
| `OCR_MAX_PAGES` | 20 | pages read per PDF |
| `GEMINI_API_KEY` | none: required | Gemini access |
| `GEMINI_MODEL_NAME` | `gemini-3.5-flash` | the model that answers the three questions |
| `GEMINI_EMBEDDING_MODEL_NAME` | `gemini-embedding-001` | the embedding model (changing it re-embeds everything) |
| `LLM_MAX_CHARS` | 100000 | characters of text sent for the summary |
| `MATCH_TOP_K` | 3 | policies Gemini checks per circular |
| `LOOKBACK_DAYS` | 30 | older new circulars are skipped; the catch-up window |
| `POLL_SECONDS` | 60 | the wait between rounds |
| `WORKERS` (compose) | 1 | how many workers run side by side |

Constants in the code:

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `DUE_DAYS` | high 7, medium 30, low 60 | `pipeline.py` | days a gap's owner gets, by severity |
| `EMBED_CHARS` | 5000 | `pipeline.py` | the chunk size for embeddings |
| `EMBED_DIMENSIONS` | 768 | `llm.py` | numbers per embedding |
| `APPLICABILITY_CHARS` | 4000 | `llm.py` | text sent for "does it apply?" |
| `MAX_TRIES` | 3 | `failures.py` | tries before a crashing circular is given up |
| `DPI` | 200 | `ocr.py` | page rendering for OCR |
| OCR timeout | 600 s | `ocr.py` | per page request |
| lock names | `library`, `circular/<id>`, `ocr`, `schema` | `locks.py`, `common/db.py` | hashed with the schema into 64-bit keys |

For what the log lines mean, see [Reading its log](how_it_works.md#reading-its-log).
