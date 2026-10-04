# How the worker works, in depth

![Python 3.14](https://img.shields.io/badge/Python_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white) ![SQLModel](https://img.shields.io/badge/SQLModel-7E56C2?style=flat-square) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Gemini via LangChain](https://img.shields.io/badge/Gemini_via_LangChain-8E75B2?style=flat-square&logo=googlegemini&logoColor=white) ![Unlimited-OCR on vLLM](https://img.shields.io/badge/Unlimited--OCR_on_vLLM-EA580C?style=flat-square) ![Docker Compose](https://img.shields.io/badge/Docker_Compose-2496ED?style=flat-square&logo=docker&logoColor=white) ![Redis 7](https://img.shields.io/badge/Redis_7-DC382D?style=flat-square&logo=redis&logoColor=white)

This is the full story of the **worker**: every task it takes, every Redis command, every row
it reads and writes, and every commit. For the plain-words version with worked
examples, read [How the worker works](../../how_the_worker_works.md) first; this guide goes
all the way down. The code is in this folder, and the queue's names are in
[`common/queue.py`](../common/common/queue.py).

Start with [section 2](#2-step-by-step-everything-the-worker-does): it walks through
everything the worker does, step 1 to step 18, with the database after each step. To watch
the same 18 steps animated, with these tables filling in, open **How it works → Worker** in
the console (`#/how/worker`). The
sections after it are the reference for each piece.

**Reading the diagrams.** Each colour means the same thing in every diagram:

![our services](https://img.shields.io/badge/our_services-2dd4bf?style=flat-square) ![data](https://img.shields.io/badge/data-818cf8?style=flat-square) ![Gemini and outside services](https://img.shields.io/badge/Gemini_and_outside_services-c084fc?style=flat-square) ![OCR on the GPU](https://img.shields.io/badge/OCR_on_the_GPU-fb923c?style=flat-square) ![a decision](https://img.shields.io/badge/a_decision-fbbf24?style=flat-square) ![done, or OK](https://img.shields.io/badge/done,_or_OK-34d399?style=flat-square) ![a failure, or a gap](https://img.shields.io/badge/a_failure,_or_a_gap-fb7185?style=flat-square) ![where it starts](https://img.shields.io/badge/where_it_starts-a7ef6f?style=flat-square) ![the task queue](https://img.shields.io/badge/the_task_queue_in_Redis-38bdf8?style=flat-square)

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
15. [Where tasks come from](#15-where-tasks-come-from)
16. [Transactions, acknowledgements and crashes](#16-transactions-acknowledgements-and-crashes)
17. [When something fails](#17-when-something-fails)
18. [What the api and the watcher queue](#18-what-the-api-and-the-watcher-queue)
19. [Every Redis command](#19-every-redis-command)
20. [Every database operation](#20-every-database-operation)
21. [Cost of each event](#21-cost-of-each-event)
22. [Settings and constants](#22-settings-and-constants)

---

## 1. The worker at a glance

The worker is one Python program (`python main.py`). It never talks to the watcher or the
api directly. They save a change in **Postgres** and add a **task** to its **lane**, a Redis
stream: `circular.read` goes to `rci:tasks:pdf` (the PDF lane: minutes of OCR per task),
every other task to `rci:tasks` (the main lane: a few Gemini calls, seconds each). Each lane
is read as the consumer group `workers`, so each task goes to one worker.

Compose runs the program as two services, told which lane to take by `LANES`: **`reader`**
(`LANES=pdf`, always one copy: the GPU reads one page at a time, and a PDF is never read
twice) and
**`worker`** (`LANES=main`, `WORKERS` copies). A quick task never waits behind a PDF. Run on
the host, one process takes both lanes (`LANES=pdf,main`), with a loop for each.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        watcher("watcher") -->|"INSERT circular,<br/>XADD circular.read"| P[["Redis: the PDF lane<br/><b>rci:tasks:pdf</b>"]]
        api("api<br/>(the console)") -->|"saves the change,<br/>XADD the task"| Q[["Redis: the main lane<br/><b>rci:tasks</b>"]]
        P <-->|"XREADGROUP, XACK<br/>(group: workers)"| R("<b>reader</b> (one)<br/>LANES=pdf")
        Q <-->|"XREADGROUP, XACK<br/>(group: workers)"| K("<b>worker</b> × WORKERS<br/>LANES=main")
        R -->|"XADD circular.assess,<br/>one per company"| Q
        S3[("S3 (Floci)<br/>the PDFs")] -->|"GET the PDF"| R
        R <-->|"page image → text"| O[/"ocr<br/>on the GPU"\]
        R <-->|"summary,<br/>embedding"| G[/"Gemini<br/>via LangChain"/]
        K <-->|"questions → JSON,<br/>texts → embeddings"| G
        R <-->|"saves each step"| PG[("Postgres<br/>every result")]
        K <-->|"reads the work,<br/>saves each step"| PG
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
    class watcher,api,R,K svc
    class P,Q queue
    class PG,S3 data
    class O gpu
    class G ext
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| What | How | Used for |
|---|---|---|
| **Redis** | redis-py, one client (a connection per lane's loop) | the two lanes (its only source of work), the dedupe keys, the dead-letter stream |
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
- **A PDF is read once.** OCR runs only for a circular still `new` with no twin, and only
  for its pages not saved yet; the one reader takes PDFs one at a time, so two circulars
  with the same PDF never run OCR together. Each case is tested in
  [A PDF is read only once](../../how_the_worker_works.md#a-pdf-is-read-only-once).

---

## 2. Step by step: everything the worker does

The worker is a program that waits for **tasks** (small notes on a list in Redis, such
as "read circular 98") and does them, one at a time. There are two lists, called **lanes**:
reading a PDF takes minutes, so it has a list of its own, taken by the **reader**; every
other note takes seconds and goes on the main list, taken by the **workers**:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        wt(["The watcher finds<br/>a new circular"]) -->|"adds a note"| P
        ap(["You add a policy<br/>in the console"]) -->|"adds a note"| M
        P[["<b>The PDF list</b><br/>read circular 98"]] -->|"the oldest note<br/>(none yet? it waits)"| r1
        M[["<b>The main list</b><br/>check policy 7"]] -->|"the oldest note<br/>(none yet? it waits)"| w1
        r1("<b>The reader</b> reads the PDF<br/>and sums it up (minutes),<br/>saving it in Postgres") --> r2(["It adds a note per company,<br/>like 'check circular 98<br/>for company 1', then<br/>crosses this one off"])
        r2 -->|"new notes"| M
        r2 -->|"back for the<br/>next PDF"| P
        w1("<b>A worker</b> asks Gemini<br/>(seconds), saving the<br/>answer in Postgres") --> w2(["It crosses the note off"])
        w2 -->|"back for the<br/>next note"| M
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
    class wt,ap start
    class P,M queue
    class r1,w1 svc
    class r2,w2 ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Who writes the notes:** the watcher and the api, whenever something changes, and the
  reader and workers themselves when one job leads to the next. The worker never goes
  looking for work; it only reads these lists.
- **One at a time, per list:** the reader finishes a PDF before it takes the next, and each
  worker finishes its note before it takes the next. The two lists never wait for each
  other, so a 2-second check never waits behind a 2-minute PDF. More workers (`WORKERS`)
  share the main list, and each note goes to only one of them.
- **A note is only a pointer:** it says *what* to do, never the data. The worker reads the
  data from Postgres when it starts the job.

This section follows the worker through everything it does, in 18 steps.

**The example** used in every step:

- **Circular 98** from RBI, a 3-page PDF (the last page is blank).
- **Company 1**, an NBFC with four RBI policies, and **company 2**, a stock broker.

Each step has a picture, a few lines in plain words, and what changes in the database
(**bold** is new or changed). **In the code** says where to look; the sections after this
one go deeper.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        subgraph loop["The worker itself"]
            direction TB
            s1(["1. Start up"]) --> s2("2. Wait for a task")
            s2 --> s3("3. Take it, mark it<br/>as its own")
        end
        s3 --> kind{"Which task?"}
        subgraph read["the reader, on the PDF lane: once for every company"]
            direction TB
            s4{"4. Skip it<br/>or read it?"} --> s5[/"5. Turn the PDF<br/>into text"\]
            s5 --> s6[/"6. Summarise it"/]
            s6 --> s7[/"7. Turn it into<br/>numbers"/]
            s7 --> s8[("8. A to-do for<br/>each company")]
        end
        subgraph judge["a worker, on the main lane: once per company"]
            direction TB
            s10[/"10. Does it apply<br/>to this company?"/] --> s11("11. Find the<br/>closest policies")
            s11 --> s12[/"12. Is each policy<br/>out of date?"/]
            s12 --> s13(["13. Mark it done"])
        end
        subgraph other["the other tasks"]
            direction TB
            s14("14. A policy was<br/>added or edited")
            s15("15. A description<br/>added or changed")
        end
        kind -->|"read a circular"| s4
        kind -->|"check it for<br/>a company"| s10
        kind -->|"check a policy"| s14
        kind -->|"refresh a company"| s15
        s8 --> s9
        s13 --> s9
        s14 --> s9
        s15 --> s9
        s9[["9. Finish: put the next<br/>tasks on their lane, then<br/>back to step 2"]]
        s16[["16. Every change<br/>queues its task"]]
        s17>"17. Something fails:<br/>wait, retry or give up"]
        s18["18. A worker dies:<br/>another carries on"]
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

| Step | In plain words |
|---|---|
| [1](#step-1-start-up) | the worker starts, checks it can reach everything, and starts a loop per lane |
| [2](#step-2-wait-for-a-task) | each loop waits for a task on its lane; Redis writes the worker's name on it |
| [3](#step-3-take-the-task-and-mark-it-as-its-own) | it takes the task, and keeps touching it so nobody takes it over |
| [4](#step-4-skip-it-or-read-it) | skip a circular that's too old; leave a failed one alone |
| [5](#step-5-turn-the-pdf-into-text) | turn the PDF into text, page by page |
| [6](#step-6-summarise-it) | Gemini summarises it |
| [7](#step-7-turn-the-summary-into-numbers) | turn the summary into numbers (an embedding) |
| [8](#step-8-a-to-do-for-each-company) | add a to-do for each company, on the main lane |
| [9](#step-9-finish-the-task) | finish the task and put the next tasks on the list |
| [10](#step-10-does-it-apply-to-this-company) | does the circular apply to this company? |
| [11](#step-11-find-the-closest-policies) | find the company's most related policies |
| [12](#step-12-is-each-policy-out-of-date) | is each of those policies out of date? open a gap if so |
| [13](#step-13-mark-it-done) | mark this company's check as done |
| [14](#step-14-a-policy-is-added-or-edited) | a policy was added or edited: check it |
| [15](#step-15-a-company-adds-or-changes-its-description) | a company added or changed its description: which circulars apply now? |
| [16](#step-16-every-change-queues-its-task) | every change queues its task on its lane: the worker's only source of work |
| [17](#step-17-something-fails) | something failed: wait, retry or give up, and how to run it again |
| [18](#step-18-a-worker-dies) | a worker died: another one on its lane carries on |

**The worker itself** (steps 1 to 3)

### Step 1: Start up

When the worker program starts, it gets ready before it takes any work.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The worker starts"]) --> b("Read the settings:<br/>which lanes to take?")
        b -->|"a name that<br/>isn't a lane"| x
        b --> c("Make sure the database<br/>tables exist")
        c --> d{"Can it talk<br/>to Gemini?"}
        d -->|"wrong key or<br/>model name"| x(["Stop, with a<br/>clear error"])
        d -->|"yes, or Gemini<br/>is only busy"| e("Connect to Redis<br/>and pick a name")
        e --> f(["A loop per lane:<br/>each goes to step 2"])
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
    class a start
    class b,c,e svc
    class d ask
    class x bad
    class f ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- It reads its settings. With no Gemini key it stops straight away. `LANES` says which
  lanes it takes: `pdf`, `main`, or both (the default when run on the host). The `reader`
  service has `LANES=pdf`, the `worker` service `LANES=main`. A name that isn't a lane
  stops it with a clear message.
- It creates any table that's missing in Postgres.
- It asks Gemini one test question. A wrong key or model name stops it with a clear
  message. If Gemini is only busy, it starts anyway.
- It connects to Redis and gives itself a name, like `e02ff2af94f5-1`, so Redis knows which
  tasks belong to it.
- It starts **one loop per lane**, each in its own thread. From here on, each loop goes
  through steps 2 to 9 on its own lane, one task at a time. If a loop ever stops on an
  error nobody expected, the whole worker exits, so Docker restarts it.

**Database:** nothing changes.

**Log:** `worker e02ff2af94f5-1: lanes pdf, using gemini-3.5-flash, waiting for tasks` (in the
example, `e02ff2af94f5-1` is the reader).

**In the code:** `main()` in `main.py`. More: [section 4](#4-startup).

### Step 2: Wait for a task

A **task** is a small note, such as "read circular 98". The notes sit on two lists in Redis,
the **lanes**, each a **stream**: `rci:tasks:pdf` (the PDF lane) for `circular.read`, and
`rci:tasks` (the main lane) for every other task. `enqueue()` picks the lane from the task's
type. The workers on a lane read it together as one **consumer group** called `workers`
(each stream has its own group), and each worker has its own name in the group, such as
`e02ff2af94f5-1` (the container's hostname, then the process number).

The group also keeps a second list, the **pending list**: every task it has handed out that
isn't finished yet, with the name of the worker that has it. **That's how a task becomes a
worker's own:** the moment Redis hands it over, it writes the worker's name next to it on the
pending list. It stays there until the worker says "finished" ([step 9](#step-9-finish-the-task)).

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as reader e02f…-1
        participant R as Redis: the PDF lane's group
    end

    rect rgb(13, 20, 36)
        K->>R: XREADGROUP: a task nobody has had, please
        R-->>K: task 1790…-0: read circular 98
        Note left of R: pending list: task 1790…-0 belongs to e02f…-1
    end
```

Each time a loop is free, it looks in three places on its lane, in this order (`<lane>` is
the lane's stream, `rci:tasks:pdf` or `rci:tasks`):

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        w(["The worker is free"]) --> q1{"1. Anything still on<br/><b>my</b> pending list?"}
        q1 -->|"yes"| t(["Take it: step 3"])
        q1 -->|"no"| q2{"2. Anything on <b>another</b><br/>worker's pending list,<br/>untouched for 5 minutes?"}
        q2 -->|"yes"| mv[["Redis moves it to<br/>my pending list"]]
        mv --> t
        q2 -->|"no"| q3{"3. A task nobody<br/>has had yet?<br/>wait up to 5 seconds"}
        q3 -->|"yes: Redis writes<br/>my name on it"| t
        q3 -->|"no"| w
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
    class w start
    class q1,q2,q3 ask
    class mv queue
    class t ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

1. **My own pending list** (`XREADGROUP GROUP workers <me> COUNT 1 STREAMS <lane> 0`; the
   `0` means "from my pending list"). A task is still there when the last try hit a hiccup
   and was left unfinished on purpose, to be tried again ([step 17](#step-17-something-fails)),
   or when this worker's container restarted in the middle of it: it comes back with the
   same name, so it finds its own task.
2. **Another worker's pending list** (`XAUTOCLAIM <lane> workers <me> 300000 0-0 COUNT 1`).
   A task nobody has touched for 5 minutes (300,000 ms, `CLAIM_IDLE_SECONDS`) belongs to a
   worker that died: a live worker touches its task every minute
   ([step 3](#step-3-take-the-task-and-mark-it-as-its-own)). Redis moves it to this worker's
   pending list ([step 18](#step-18-a-worker-dies)).
3. **A new task** (`XREADGROUP GROUP workers <me> COUNT 1 BLOCK 5000 STREAMS <lane> >`;
   the `>` means "one nobody in the group has had"). Redis hands it over and writes this
   worker's name on the pending list in the same moment. If none arrives within 5 seconds,
   the worker looks again from 1.

Before looking, on every turn:

- `XGROUP CREATE <lane> workers 0 MKSTREAM` makes the group if it doesn't exist (the very
  first start, or Redis lost its data). If it exists, Redis says so and nothing changes. If
  Redis loses the group while the loop is waiting (`NOGROUP`), the loop logs it and makes it
  again on the next turn.
- A task whose contents were trimmed away (the stream keeps about the last 100,000) is marked
  finished and skipped.

There's no timer, and no other source of work: a new task is picked up the moment it
arrives, and the worker never looks in Postgres for something to do
([step 16](#step-16-every-change-queues-its-task)).

**The example starts here.** The watcher has just found circular 98 on RBI's website, saved
it, and put a task on the PDF lane:

| circulars.id | source | title | status | text |
|---|---|---|---|---|
| **98** | **RBI** | **Designation of terrorist organisation…** | **new** | *(empty)* |

The reader's `XREADGROUP … >` returns it at once. **The PDF lane's pending list after:**

| task id | the task | owner | idle | times handed out |
|---|---|---|---|---|
| **1790831159691-0** | **circular.read, circular 98** | **e02ff2af94f5-1** | **0 s** | **1** |

To look at it yourself: `docker compose exec redis redis-cli XPENDING rci:tasks:pdf workers - + 10`
(or `rci:tasks` for the main lane).

**In the code:** `next_task()` in `main.py`. More: [section 6](#6-taking-the-next-task).

### Step 3: Take the task and mark it as its own

Redis wrote the worker's name on the task in [step 2](#step-2-wait-for-a-task). But a name
alone isn't enough: Redis can't tell a worker that's busy from one that has died. So for each
pending task it also keeps an **idle time**: how long since its owner last touched it. Any
task idle for 5 minutes is taken over by another worker (step 2, the second place).

Reading a long PDF can take longer than 5 minutes. So while the job runs, a small helper
inside the worker **touches the task every minute** (`XCLAIM <lane> workers <me> 0 <task id>
JUSTID`), which sets its idle time back to 0. The task never looks abandoned while its
worker is alive, and no second worker ever starts the same PDF.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant R as Redis: the pending list
        participant J as the job
    end

    rect rgb(13, 20, 36)
        K->>J: start the job (steps 4 to 8)
        loop every 60 seconds while the job runs
            K->>R: XCLAIM: still mine
            Note left of R: idle time back to 0 s
        end
        J-->>K: finished
        K->>R: finish the task (step 9)
    end
```

The task's line on the pending list, minute by minute:

| Time | What happens | Idle time |
|---|---|---|
| 10:00:00 | Redis hands the task to `e02f…-1` | 0 s |
| 10:00:59 | still reading page 2 | 59 s |
| 10:01:00 | the helper touches it | **0 s** |
| 10:02:00 | the helper touches it again | **0 s** |
| 10:02:40 | the job ends: step 9 takes it off the list | *(gone)* |

- **Which job?** The task's type picks the function: `circular.read` runs steps 4 to 8,
  `circular.assess` steps 10 to 13, `policy.check` step 14, `company.refresh` step 15.
- **No locks.** Redis gives each task to one worker only, so two workers never get the same
  task.
- When the job ends, the worker finishes the task ([step 9](#step-9-finish-the-task)). If it
  fails: [step 17](#step-17-something-fails).

**In the code:** `run_task()` and `keep_claimed()` (the helper) in `main.py`. More:
[section 7](#7-doing-a-task).

**Reading a circular** (steps 4 to 9): one `circular.read` task, once for every company, on
the PDF lane: the **reader** does these

### Step 4: Skip it or read it

Before doing any work, the worker reads circular 98's row and looks at its **status**. Two
statuses mean "don't touch it": **skipped** and **failed**. They come from different places,
explained below.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        c(["Circular 98's row"]) --> s{"Its status?"}
        s -->|"skipped (too old)<br/>or failed (gave up)"| n(["Nothing to do:<br/>finish the task"])
        s -->|"new, published more<br/>than 30 days ago"| k["Set it to skipped<br/>(no OCR, no Gemini)"]
        s -->|"new, recent<br/>(or no date)"| r(["Read it: step 5"])
        s -->|"parsed: the text<br/>was saved before"| six(["Go to step 6"])
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
    class c start
    class s ask
    class n,k muted
    class r,six ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- If some of the work was done before (the text was saved, then the worker crashed), it
  carries on from there: each step checks what's saved first.
- Reading happens **once per circular**, not once per company: the text and the summary are
  the same for everybody.

#### Where "skipped" comes from

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        w(["The watcher saves every<br/>circular it hasn't seen,<br/>old ones too"]) --> s{"The first time a worker<br/>picks it up: published more<br/>than 30 days ago?"}
        s -->|"yes"| k["status skipped"]
        s -->|"no, or no date"| r(["Read as normal"])
        k --> f(["Never read, never<br/>retried: costs nothing"])
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
    class w start
    class s ask
    class k,f muted
    class r ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- It's set **right here**, the first time a worker picks the circular up. 30 days is
  `LOOKBACK_DAYS`.
- **Why:** the watcher saves everything on the regulators' lists, including circulars from
  months ago (on its very first round especially). Reading those would cost OCR and Gemini
  for circulars nobody needs.
- A circular with no publication date is never skipped.
- Nothing retries a skipped circular: no task is ever queued for it again, unless someone
  presses **Reprocess**.
- **To read one anyway:** raise `LOOKBACK_DAYS` in `.env`, restart the workers, then press
  **Reprocess** on it. Reprocess alone sets it back to `new`, but while it's still older than
  the window, the worker skips it again.
- A company that joined later also sees older circulars as **Skipped** in the console, even
  read ones: it only gets to-dos for the last 30 days
  ([step 15](#step-15-a-company-adds-or-changes-its-description)).

#### Where "failed" comes from

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["Reading circular 98:<br/>steps 5, 6 or 7"]) --> e>"An error the worker can't<br/>wait out, or the same<br/>hiccup 3 times"]
        e --> g>"Give up (step 17):<br/>status failed,<br/>the error saved on the circular,<br/>the task copied to rci:dead"]
        g --> st(["It stays failed: nothing<br/>retries it by itself"])
        st -->|"you fix the cause,<br/>then press Reprocess"| rp("Status back to parsed (text<br/>kept) or new; error cleared")
        rp --> again(["Read again, from<br/>what was saved"])
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
    class a start
    class e,g,st bad
    class rp svc
    class again ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- It's **not** set in this step. It's set by `give_up()` ([step 17](#step-17-something-fails))
  when reading the circular fails for good, for example:
  - the PDF has no text at all: `ValueError: OCR found no text in the PDF`;
  - the PDF is missing from S3 (`NoSuchKey`: Floci was restarted without `--persist`), or S3
    can't be reached (Floci isn't running);
  - Gemini refused the request (a 400);
  - the same hiccup three times in a row: an OCR timeout, a Gemini server error, an answer
    not in the asked-for form.
- The error is saved in `circulars.error`. Every company sees it on the circular's page,
  under **Why it failed**.
- **Why "nothing to do" here:** a failed circular's task was already finished when it was
  given up. It only reaches this step from a stale copy of a task. Nothing queues a failed
  circular again by itself, on purpose: retrying "no text in the PDF" would just fail
  again.
- **To run it again:** fix the cause (start Floci, say), then press **Reprocess**. The api sets
  the status back to `parsed` if the text was saved (or `new` if not), clears the error, and
  queues `circular.read`. The worker carries on from what was saved: the pages already OCR'd,
  the text, the summary.

**In the code:** `read_circular()` in `pipeline.py`; `give_up()` in `main.py`;
`reprocess_circular()` in `backend/api/routes/circulars.py`. More:
[section 11](#11-circularread).

### Step 5: Turn the PDF into text

The circular is a PDF, often a scan. The worker sends each page as a picture to **OCR**, a
model on the GPU that reads text from images. It **saves each page the moment it's read**.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a{"Another circular has<br/>the same PDF?"} -->|"yes"| cp["Copy its text<br/>(no OCR)"]
        a -->|"no"| dl("Download the PDF")
        dl --> pg{"For each page<br/>(up to 20):<br/>what is it?"}
        pg -->|"saved before"| sk["Skip it"]
        pg -->|"blank"| em["Save it as empty"]
        pg -->|"not read yet"| ocr[/"OCR on the GPU"\]
        ocr --> sp[("Save the page")]
        sk --> jn(["All pages in: join them<br/>into the circular's text"])
        em --> jn
        sp --> jn
        cp --> jn
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
    class a,pg ask
    class cp,sk,em muted
    class dl svc
    class ocr gpu
    class sp data
    class jn ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Same PDF seen before?** The worker copies that circular's text. No OCR at all.
- **Page by page.** Each page goes into the `ocr_pages` table as soon as it's read. If the
  worker stops on page 3, next time it starts at page 3, not page 1.
- **Blank pages** are never sent to the GPU.
- When every page is in, the pages are joined into the circular's text, and the saved pages
  are deleted.

**Database while it runs** (`ocr_pages`):

| sha256 (the PDF) | page | text |
|---|---|---|
| **3f9a…** | **0** | **"RESERVE BANK OF INDIA …"** |
| **3f9a…** | **1** | **"2. Regulated entities shall …"** |
| **3f9a…** | **2** | **""** (blank) |

**Database after** (`circulars`; the 3 `ocr_pages` rows are deleted):

| id | status | text |
|---|---|---|
| 98 | **parsed** | **"RESERVE BANK OF INDIA … (12,408 characters)"** |

**Log:** `#98 parsed: 12408 chars`, or after a restart halfway:
`#98: 2 pages OCR'd before, carrying on`

**If it fails here:**

- **S3 can't be reached, or the PDF isn't there:** given up at once: the circular is
  **failed** ([step 17](#step-17-something-fails)). Start Floci, then **Reprocess**.
- **The OCR model is still loading** (it can't be reached): the worker waits a minute and
  tries again, for as long as it takes.
- **A page takes over 10 minutes, or OCR answers with a server error:** tried again, up to 3
  tries. The pages already saved are kept, so each try starts at the page that failed.
- **No text on any page:** **failed**, with `OCR found no text in the PDF`. Its blank pages
  stay saved, so a **Reprocess** doesn't use the GPU again.

**In the code:** `ocr_text()` in `pipeline.py`, `pages()` in `ocr.py`. More:
[section 11](#11-circularread).

### Step 6: Summarise it

**Gemini** reads the text and answers three questions about it.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        t(["The circular's text"]) --> tw{"Another circular with<br/>the same PDF has<br/>a summary?"}
        tw -->|"yes"| cp["Copy it<br/>(no Gemini call)"]
        tw -->|"no"| g[/"Ask Gemini:<br/>1. who is it for?<br/>2. what does it change?<br/>3. what must be done?"/]
        g --> s[("Save the answers")]
        cp --> s
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
    class tw ask
    class cp muted
    class g ext
    class s data
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

1. **Who is it for?** For example "All Regulated Entities, NBFCs…".
2. **What does it change?** A short summary.
3. **What must be done?** Every obligation, with its numbers and deadlines as written.

Gemini has to answer in a fixed format. If it doesn't, the worker asks again
([step 17](#step-17-something-fails)).

**Database after:**

| id | addressed_to | summary | requirements |
|---|---|---|---|
| 98 | **All Regulated Entities… NBFCs…** | **RBI designates a new terrorist organisation…** | **["Report accounts … to FIU-IND", …]** |

**Log:** `#98 read: addressed to 'All Regulated Entities…'`

**If it fails here:**

- **Gemini's quota is used up (429):** wait a minute, try again, for as long as it takes.
- **Gemini has a server error, or its answer isn't in the form:** LangChain tries 3 times
  itself, then the worker tries the task again, up to 3 tries. The text is saved, so each try
  starts here, at the summary.
- **Gemini refuses the request (400):** the circular is **failed**. **Reprocess** starts again
  here, with no OCR.

**In the code:** `llm.summarize()`, called from `read_circular()`. More:
[section 11](#11-circularread).

### Step 7: Turn the summary into numbers

An **embedding** is a list of 768 numbers that captures what a text is about. Texts about
similar things get similar numbers. In [step 11](#step-11-find-the-closest-policies) the
worker compares these numbers to find related policies quickly, without asking Gemini.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        s[("Title + summary +<br/>obligations")] --> g[/"Gemini's embedding<br/>model"/]
        g --> e[("768 numbers:<br/>[0.021, -0.013, …]")]
        e --> r(["The circular is read"])
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
    class s,e data
    class g ext
    class r ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- It's made once, and used for every company.
- After this, the circular's status is **read**: everything that's the same for all
  companies is done.

**Database after:**

| id | status | embedding |
|---|---|---|
| 98 | **read** | **[0.021, -0.013, …]** |

**If it fails here:** the same rules as step 6. The summary is saved, so a retry only makes
the embedding.

**In the code:** `embed_circular()` in `pipeline.py`. More: [section 11](#11-circularread).

### Step 8: A to-do for each company

Each company has to decide for itself whether the circular matters to it. So the worker adds
one row per company, called an **assessment**, which says "not checked yet", and one new
task per company.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        c(["Circular 98 is read"]) --> a1[("Company 1:<br/>pending")]
        c --> a2[("Company 2:<br/>pending")]
        a1 --> t1[["New task: check 98<br/>for company 1"]]
        a2 --> t2[["New task: check 98<br/>for company 2"]]
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
    class c start
    class a1,a2 data
    class t1,t2 queue
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- One assessment per company: **pending** means not checked yet.
- One new task per company: `circular.assess`. They go on the list in
  [step 9](#step-9-finish-the-task).

**Database after:**

| company_id | circular_id | status |
|---|---|---|
| **1** | **98** | **pending** |
| **2** | **98** | **pending** |

**In the code:** `add_assessments()` and `pending()` in `pipeline.py`. More:
[section 11](#11-circularread).

### Step 9: Finish the task

Every task ends the same way, whatever job it was. Four small things, in this order:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        d(["The job is done"]) --> u("1. Stop touching<br/>the task")
        u --> k("2. Remove its<br/>'already queued' mark")
        k --> n[["3. Put the next tasks<br/>on their lane"]]
        n --> a(["4. XACK: Redis takes it<br/>off the pending list"])
        a --> b(["Back to step 2"])
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
    class d start
    class u,k svc
    class n queue
    class a,b ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

1. **Stop touching the task.** The helper from
   [step 3](#step-3-take-the-task-and-mark-it-as-its-own) stops.
2. **Remove the "already queued" mark.** When a task is added to the list, a small Redis key
   (its **mark**) is set at the same time, and a copy of the same task is dropped while that
   key exists. That's why pressing **Reprocess** twice can never queue circular 98 twice.
   Now the mark is removed (`DEL rci:queued:circular_id=98:type=circular.read`), so the same
   task can be queued again later, by **Reprocess** for example.
3. **Put the next tasks on their lane:** here, the two from
   [step 8](#step-8-a-to-do-for-each-company), one per company. Each gets its own mark first,
   then goes on the main lane, where the workers take them:

   ```text
   SET rci:queued:circular_id=98:company_id=1:type=circular.assess 1 NX EX 86400
   XADD rci:tasks * type circular.assess company_id 1 circular_id 98
   ```

   (and the same for company 2). A mark lasts a day at most, in case a worker dies before
   removing it.
4. **Tell Redis it's finished** (`XACK rci:tasks:pdf workers 1790831159691-0`, on the lane the
   task came from). Redis takes the task off the pending list: no worker will ever get it
   again.

**Why this order?** If the worker dies after 3 but before 4, the task is still on the pending
list, so it's done once more ([step 18](#step-18-a-worker-dies)): it finds all its work
already saved, and its next tasks are dropped because their marks are still there. Nothing
is lost or done twice. The reader goes back to step 2 for the next PDF. On the main lane,
with two workers, companies 1 and 2 are now checked at the same time, never behind a PDF.

**The PDF lane's pending list after:** empty. The two new tasks wait on the main lane until
a worker takes them, which is at once when one is free.

**In the code:** the end of `run_task()` in `main.py`, `enqueue()` in
`backend/common/common/queue.py`. More: [section 7](#7-doing-a-task) and
[section 10](#10-no-duplicates-the-dedupe-key).

**Checking it for one company** (steps 10 to 13): one `circular.assess` task per company, on
the main lane: a **worker** does these

### Step 10: Does it apply to this company?

From here on the work is **per company**. Gemini reads the company's description and the
start of the circular, and says whether the circular is meant for this company.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["Check circular 98<br/>for company 1"]) --> d{"Done already?"}
        d -->|"yes"| n(["Nothing to do"])
        d -->|"no"| p{"Has the company<br/>described itself?"}
        p -->|"no"| nc["Not checked yet:<br/>asked later, step 15"]
        p -->|"yes"| g[/"Ask Gemini:<br/>does it apply to us?"/]
        g -->|"yes"| s11(["Step 11"])
        g -->|"no"| s13(["Step 13"])
        nc --> s13
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
    class a start
    class d,p ask
    class n,nc muted
    class g ext
    class s11,s13 ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **Company 1** is an NBFC, and the circular is for NBFCs: it applies, so the worker
  checks company 1's policies next.
- **Company 2** is a stock broker: it doesn't apply, so company 2's check ends here.
- A company that hasn't described itself yet isn't checked. It's asked when it writes a
  description ([step 15](#step-15-a-company-adds-or-changes-its-description)).

**Database after:**

| company_id | circular_id | applicable | applies_reason |
|---|---|---|---|
| 1 | 98 | **true** | **"Addressed to NBFCs, and the company is an NBFC."** |
| 2 | 98 | **false** | **"Addressed to banks and NBFCs; the company is a stock broker."** |

**If it fails here:** only this company's assessment is marked **failed**, with the error
([step 17](#step-17-something-fails)); the circular and the other companies are not
affected. Someone in this company presses **Reprocess** on the circular to check it again.

**In the code:** `assess()` in `pipeline.py`, `llm.check_applicability()`. More:
[section 12](#12-circularassess).

### Step 11: Find the closest policies

Asking Gemini about every policy would be slow and costly. So the worker first compares
numbers: the circular's embedding ([step 7](#step-7-turn-the-summary-into-numbers)) with
each policy's. Only the **3 closest** policies go on to step 12.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        p(["Company 1's<br/>RBI policies"]) --> sc("Score each one:<br/>how close is it<br/>to the circular?")
        sc --> top("Keep the<br/>top 3")
        top --> q{"Asked about<br/>this one before?"}
        q -->|"yes"| sk(["Skip it: the<br/>answer is saved"])
        q -->|"no"| s12(["Step 12"])
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
    class p start
    class sc,top svc
    class q ask
    class sk muted
    class s12 ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Policy | Score | Goes to step 12? |
|---|---|---|
| POL-KYC | 0.82 | yes |
| POL-DRP | 0.58 | yes |
| POL-DLP | 0.55 | yes |
| POL-IT | 0.31 | no: not in the top 3 |

- No Gemini call here: it's quick arithmetic on saved numbers.
- A policy already asked about (at its current version) is skipped.

**Database:** nothing changes.

**In the code:** `match()` in `pipeline.py`. More: [section 12](#12-circularassess).

### Step 12: Is each policy out of date?

For each of the 3 policies, Gemini reads the circular and the policy, and answers: **does
the policy still meet what the circular asks?** If not, the worker opens a **gap**: a ticket
for the policy's owner, with what's missing and a draft of the new wording.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        p(["POL-KYC"]) --> g[/"Ask Gemini: is this<br/>policy out of date?"/]
        g -->|"no"| up(["Save the answer:<br/>up to date"])
        g -->|"yes"| od>"Save the answer:<br/>out of date"]
        od --> gap>"Open a gap:<br/>what's missing,<br/>a draft fix, a due date"]
        up --> nx(["Next policy"])
        gap --> nx
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
    class p start
    class g ext
    class up,nx ok
    class od,gap bad
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- Every answer is saved in `policy_checks`, so the same question is never asked twice.
- The due date depends on how serious the gap is: high 7 days, medium 30, low 60.
- The answer and its gap are saved together: both or neither.

**Database after** (`policy_checks`):

| circular | policy | version | score | out of date |
|---|---|---|---|---|
| **98** | **POL-KYC** | **1** | **0.82** | **yes** |
| **98** | **POL-DRP** | **1** | **0.58** | **no** |
| **98** | **POL-DLP** | **1** | **0.55** | **no** |

and a new gap:

| Table | New row |
|---|---|
| `gaps` | **company 1 · POL-KYC · severity high · owner Head of Compliance · due in 7 days · draft "Add clause 2A: …"** |
| `gap_events` | **agent · opened · "The policy does not require reporting to FIU-IND…"** |

**Log:** `#98 vs POL-KYC v1 (0.82): GAP`, `#98 vs POL-DRP v1 (0.58): up to date`, …

**If it fails here:** each answer was saved before the next question, so a retry asks only
about the policies left. If it fails for good, this company's assessment is **failed**, as in
step 10; its answers and gaps so far are kept.

**In the code:** `judge_policy()` in `pipeline.py`, `llm.assess()`. More:
[section 12](#12-circularassess).

### Step 13: Mark it done

When a company's check is over, its assessment becomes **done**, and the task is finished
([step 9](#step-9-finish-the-task)).

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a("Company 1: 3 answers<br/>saved, 1 gap opened") --> d1(["Assessment:<br/>done"])
        b("Company 2: it<br/>doesn't apply") --> d2(["Assessment:<br/>done"])
        d1 --> f(["Step 9: finish"])
        d2 --> f
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
    class a,b svc
    class d1,d2 ok
    class f queue
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

**Database after:**

| company_id | circular_id | status | applicable |
|---|---|---|---|
| 1 | 98 | **done** | true |
| 2 | 98 | **done** | false |

**Log:** `#98 for company 1: applies: True, gaps opened: ['POL-KYC']`

The console now shows circular 98 as **analyzed** to both companies, and company 1 sees the
new gap on its Gaps page.

**That's the whole journey of a circular.** In total it cost: OCR once per page, 1 summary,
1 embedding; then per company 1 "does it apply?" and, where it applies, up to 3 policy
questions.

**In the code:** the end of `assess()` in `pipeline.py`. More:
[section 12](#12-circularassess).

**The other tasks** (steps 14 and 15), on the main lane

### Step 14: A policy is added or edited

When someone saves a policy in the console, the api puts a `policy.check` task on the list.
The worker then checks the policy against the company's recent circulars.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        s(["A policy is saved<br/>in the console"]) --> e[/"Turn it into numbers<br/>(if new or changed)"/]
        e --> c("Find the company's recent<br/>circulars that apply to it")
        c --> m("For each one:<br/>steps 11 and 12")
        m --> d[("Mark the policy<br/>checked")]
        d --> q{"Edited again<br/>meanwhile?"}
        q -->|"yes"| ag(["Check it<br/>once more"])
        q -->|"no"| f(["Step 9: finish"])
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
    class s start
    class e ext
    class c,m svc
    class d data
    class q ask
    class ag muted
    class f ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- The new policy now competes for each circular's top 3. Only questions never asked before
  cost a Gemini call.
- The console shows **Waiting for the worker** until the check is done, then **Checked**.
- If the policy was saved again while the worker was checking it, it's checked once more.

**Database after** (company 1 added POL-AML):

| code | version | embedding | checked_at |
|---|---|---|---|
| POL-AML | 1 | **[[0.012, …], [0.031, …]]** | **2026-10-01 10:15** |

**Log:** `embedded POL-AML (2 chunks) with gemini-embedding-001`, then
`POL-AML checked, gaps opened: none`

**If it fails here:** a policy has no "failed" status. The task is copied to `rci:dead`
([step 17](#step-17-something-fails)), and the policy keeps saying **Waiting for the
worker** until someone saves it again: every save queues a new check
([step 16](#step-16-every-change-queues-its-task)).

**In the code:** `check_policy()` in `pipeline.py`. More: [section 13](#13-policycheck).

### Step 15: A company adds or changes its description

The description is how the worker knows which circulars apply to a company. So when it's
**added for the first time, or changed**, the api queues a `company.refresh` task, and the
worker asks "does it apply?" again for that company's circulars. Saving the page with the
same description, or only a new name, queues nothing. **Signing up queues nothing either**:
a new company has no description and no policies, so there's nothing to judge yet.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The description is added<br/>or changed, and saved"]) --> q[["company.refresh"]]
        q --> r[("Answers given before the<br/>change go back to pending")]
        r --> t[("A to-do for each circular read<br/>in the last 30 days it lacks")]
        t --> s(["Steps 10 to 13, for each<br/>pending one, this company only"])
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
    class a start
    class q queue
    class r,t data
    class s ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

`refresh_company()` in `pipeline.py`:

1. Read the company: the time its description last changed is its `updated_at`.
2. **Reset the old answers:** every assessment of this company that isn't pending and was
   last updated before that time goes back to `pending`, with `applicable` and the reason
   cleared. An answer given after the change (by a circular read since) is kept.
3. **Fill the gaps:** `add_assessments()` gives the company a pending assessment for each
   circular read in the last 30 days that it doesn't have yet. A company that signed up
   after those circulars were read has none.
4. Return a `circular.assess` task for each pending assessment: steps 10 to 13 run for this
   company only.
5. If the description changed again while this ran, return `company.refresh` too, so the
   newest description is used for everything.

Only "does it apply?" is asked again. The OCR text, the summaries and the earlier policy
answers are kept.

**Before the description exists**, a company's recent circulars show **Analysed** and **Not
checked** in the console: the api shows that for a read circular the company has no answer
for, while it has no description.

**Database after** (company 2 changed its description):

| company_id | circular_id | status | applicable | updated_at |
|---|---|---|---|---|
| 2 | 98 | **pending** | **(cleared)** | **now** |
| 2 | 97 | **pending** | **(cleared)** | **now** |
| 2 | 99 | done | true | after the change: kept |

**If it fails here:** a company refresh has no "failed" status: the task is copied to
`rci:dead`. Change the description again, or run `manage.py requeue`, which queues a refresh
for every described company ([step 16](#step-16-every-change-queues-its-task)).

**In the code:** `refresh_company()` in `pipeline.py`, `set_company()` in
`backend/api/routes/company.py`. More: [section 14](#14-companyrefresh).

**Keeping it all right** (steps 16 to 18)

### Step 16: Every change queues its task

The worker never goes looking for work: it never asks Postgres "is there anything to do?".
**Everything it does arrives as a task on one of the two Redis lanes.** So every change that
needs a worker puts its task on its lane, the moment the change is saved. `enqueue()` picks
the lane: the PDF lane for `circular.read`, the main lane for the rest.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        w("watcher: a new circular") --> p[["the PDF lane:<br/>rci:tasks:pdf"]]
        a("api: a description added<br/>or changed, a policy saved,<br/>Reprocess") --> q[["the main lane:<br/>rci:tasks"]]
        a -.->|"Reprocess an<br/>unread circular"| p
        k("reader or worker: the next<br/>steps of a task it finished") --> q
        m["manage.py requeue:<br/>only after Redis lost its data"] -.-> q
        m -.-> p
        p --> y(["the reader"])
        q --> x(["the workers"])
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
    class w,a,k svc
    class m muted
    class p,q queue
    class x,y ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Something happens | Who queues | The task (its lane) | What the worker does |
|---|---|---|---|
| the watcher finds a new circular | watcher | `circular.read` (PDF) | steps 4 to 8 |
| a company adds its description, or changes it | api | `company.refresh` (main) | step 15 |
| a policy is added | api | `policy.check` (main) | step 14 |
| a policy is saved again (**every save**) | api | `policy.check` (main) | step 14 |
| **Reprocess** on a circular that isn't read | api | `circular.read` (PDF) | steps 4 to 8 |
| **Reprocess** on a read circular | api | `circular.assess` (main), this company only | steps 10 to 13 |
| a circular is read | reader | `circular.assess` (main), one per company | steps 10 to 13 |
| a company refresh finds pending checks | worker | `circular.assess` (main), one per circular | steps 10 to 13 |
| a policy was saved again while its check ran | worker | `policy.check` (main) again | step 14 |
| a company signs up | nobody | none | nothing to judge yet: no description, no policies |
| the description saved unchanged, or only the name | nobody | none | nothing changed for the worker |
| a control is added, a gap updated, a teammate added | nobody | none | nothing to do: the worker reads a policy's controls each time it judges it |
| the embedding model setting changes | nobody | none | the worker re-embeds each policy the next time it meets it (step 11) |

Each one is queued **after** its change is committed, so the worker always finds the change
when it gets the task. A copy of a task that's still on the list is dropped by its mark
([step 9](#step-9-finish-the-task)).

#### If Redis can't take a task

The rule is: **a change is only finished when its task is on the list.** Nobody just logs a
lost task and moves on.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        e(["Redis can't take the task"]) --> who{"Who was queueing it?"}
        who -->|"the watcher"| wa("Delete the circular's row:<br/>the next round tries again")
        who -->|"the api: a new policy,<br/>or a description change"| ac("Undo it: delete the policy,<br/>or put the old description<br/>back. 503: try again")
        who -->|"the api: a policy<br/>saved, Reprocess"| ae("503: saved, try again.<br/>Saving again queues it")
        who -->|"the worker, queueing<br/>its next tasks"| wo("No XACK: the task<br/>runs again, and queues<br/>them again")
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
    class e bad
    class who ask
    class wa,ac,ae,wo svc
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

Saving again always works: an undone change is a change again, and a policy save or a
Reprocess queues its task every time.

#### If Redis loses its data

Redis keeps the list on disk (`--appendonly yes`), so a restart loses nothing. Only if its
data is deleted (the `redis-data` volume removed, say) are the queued tasks gone. Then a
person runs, once:

```bash
cd backend/api && uv run python manage.py requeue
# 3 unfinished: 3 queued, 0 already queued
```

It puts back every piece of work Postgres shows unfinished: circulars still `new` or
`parsed`, checks still `pending`, policies not checked since they were saved, and a
`company.refresh` for each company with a description (it resets nothing when nothing
changed). It's a producer, like the api: the worker still only reads the list.

**In the code:** `enqueue()` in `backend/common/common/queue.py`; `enqueue()` and
`enqueue_or_undo()` in `backend/api/database.py`; `fetch_new()` in `backend/watcher/main.py`;
`requeue()` in `backend/api/manage.py`. More: [section 15](#15-where-tasks-come-from).

### Step 17: Something fails

When a step raises an error, the worker first undoes the unsaved part of that step (a
database **rollback**). Everything saved before it stays saved. Then it sorts the error into
one of three kinds.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        e(["A step failed"]) --> k{"What kind<br/>of problem?"}
        k -->|"a service is down<br/>or busy"| w["<b>Wait</b> 60 seconds,<br/>then try again, as long<br/>as it takes. The task stays<br/>on my pending list"]
        k -->|"a hiccup"| r("<b>Retry</b> at once, up to<br/>3 tries. The task stays<br/>on my pending list")
        k -->|"anything else"| g>"<b>Give up</b>:<br/>give_up()"]
        r -->|"the 3rd try fails"| g
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
    class e,g bad
    class k ask
    class w muted
    class r svc
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Kind | For example | What happens to the task |
|---|---|---|
| **Wait** | the ocr service can't be reached (the model is still loading); Gemini answers 429 (the quota is used up) | not finished on purpose: it stays on this worker's pending list. After 60 s (`RETRY_SECONDS`), step 2's first place finds it again. No limit: it waits as long as the service is down. Only this lane's loop waits: while OCR loads, the main lane carries on |
| **Retry** | an OCR page takes over 10 minutes; OCR or Gemini answers with a server error (5xx); Gemini's answer isn't in the asked-for form; another task saved the same answer first | not finished: tried again straight away. The worker counts the tries in its memory (by lane and task id), so a restarted worker starts counting again. The 3rd failed try gives up |
| **Give up** | Gemini refuses the request (400); `OCR found no text in the PDF`; the PDF is missing from S3, or S3 can't be reached | `give_up()`, below |

LangChain tries Gemini's busy (429) and server (5xx) errors 3 times itself before the worker
sees them. The rules are in `failures.py`.

#### What giving up writes

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        g(["give_up()"]) --> t{"Which task?"}
        t -->|"circular.read"| c>"circulars: status failed,<br/>error saved (every company<br/>sees it)"]
        t -->|"circular.assess"| a>"assessments: status failed,<br/>error saved (this<br/>company only)"]
        t -->|"policy.check or<br/>company.refresh"| n["nothing in Postgres"]
        c --> d[["A copy in rci:dead: the task,<br/>its id, the error"]]
        a --> d
        n --> d
        d --> f(["Remove its mark, XACK:<br/>off the pending list"])
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
    class g start
    class t ask
    class c,a bad
    class n muted
    class d queue
    class f ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

The copy in the **dead-letter stream** `rci:dead` looks like this:

| Field | Value |
|---|---|
| `type` | circular.read |
| `circular_id` | 98 |
| `stream` | rci:tasks:pdf (the lane it came from) |
| `task_id` | 1790831159691-0 |
| `error` | ValueError: OCR found no text in the PDF |

Nothing reads `rci:dead` back: it's a record for whoever investigates.

#### Where you see a failure

- **The console:** the circular shows **Failed**, and its page has a **Why it failed** panel
  with the error, such as `ValueError: OCR found no text in the PDF`.
- **The worker's log:** `{'type': 'circular.read', 'circular_id': '98'} failed for good`,
  then the full error.
- **Redis:** `docker compose exec redis redis-cli XRANGE rci:dead - +` lists every task given
  up.

#### How failed work is run again

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        f1>"A failed circular"] -->|"fix the cause,<br/>press Reprocess"| a1("status parsed (text kept)<br/>or new; error cleared")
        a1 --> t1[["circular.read"]]
        f2>"A failed company check"] -->|"press Reprocess<br/>on the circular"| a2("assessment pending;<br/>its 'up to date'<br/>answers cleared")
        a2 --> t2[["circular.assess"]]
        f3>"A failed policy check"] -->|"save the policy<br/>again"| a3("every save queues<br/>a new check")
        a3 --> t3[["policy.check"]]
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
    class f1,f2,f3 bad
    class a1,a2,a3 svc
    class t1,t2,t3 queue
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| What failed | Retried by itself? | How to run it again | It carries on from |
|---|---|---|---|
| reading a circular (`failed`) | no | fix the cause, then **Reprocess** | the pages already OCR'd, the text, the summary |
| one company's check (its assessment `failed`) | no | **Reprocess** on the circular, signed in as that company | its gaps and "out of date" answers; "does it apply?" and the "up to date" answers are asked again |
| a policy check | no: it keeps saying **Waiting for the worker** | save the policy again | its embeddings and every saved answer |
| a company refresh | no | save the company description again | the to-dos already saved |

**Log:** `OCR or Gemini unavailable (…); retrying` (wait), `… failed (…); trying again`
(retry) or `… failed for good` (give up)

**In the code:** `run_task()` and `give_up()` in `main.py`, the rules in `failures.py`,
`reprocess_circular()` in `backend/api/routes/circulars.py`. More:
[section 17](#17-when-something-fails).

### Step 18: A worker dies

If a worker crashes in the middle of a task, the task isn't lost: it never got its "finished"
(XACK), so it's still on the pending list under the dead worker's name, and the work done so
far is saved in Postgres.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        d(["A worker dies<br/>in the middle of a task"]) --> q{"Does its container<br/>come back with the<br/>same name?"}
        q -->|"yes: Docker restarted it"| s("Step 2, first place:<br/>it finds the task on<br/>its own pending list")
        q -->|"no: gone, or replaced<br/>by up --build"| i["The task's idle time<br/>grows: nobody touches it"]
        i --> o("At 5 minutes, another worker<br/>on the same lane: its XAUTOCLAIM<br/>moves it to its own pending list")
        s --> c(["Carry on from the<br/>last saved step"])
        o --> c
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
    class d bad
    class q ask
    class s,o svc
    class i muted
    class c ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- **The same name:** a worker's name is its container's hostname plus its process number.
  Docker restarting the container (a crash, `docker compose restart`) keeps both, so the
  worker finds its own task straight away.
- **A new name:** `docker compose up --build` (or a scale-down) replaces the container, which
  gets a new hostname. The old name's task is then taken over after 5 minutes, by the new
  container itself or by another worker on the same lane.
- **Takeover stays in its lane.** Each lane has its own group and pending list: a dead
  reader's PDF is taken over by a reader, a dead worker's check by a worker.
- Nothing else queues it again meanwhile: its mark is still there, so a copy would be
  dropped.
- The tries count starts again at zero (it lived in the dead worker's memory).

| It died… | When the task comes back, the worker… |
|---|---|
| while reading the PDF | reads only the pages not saved yet (the page in progress is read again) |
| after the text was saved | starts at the summary |
| after the circular was read | only adds the companies' to-dos again |
| between two policy questions | asks only the questions not answered yet |
| after the check was done | has nothing to do |

**In the code:** `next_task()` in `main.py`. More:
[section 16](#16-transactions-acknowledgements-and-crashes).

---


## 3. The files

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TB
    subgraph canvas[" "]
        direction TB
        main("<b>main.py</b><br/>a loop per lane: serve, next_task,<br/>run_task, keep_claimed, give_up")
        pipeline("<b>pipeline.py</b><br/>one function per task type,<br/>OCR, matching, embeddings")
        queue[["<b>common/queue.py</b><br/>the lanes, connect,<br/>enqueue with its dedupe key"]]
        failures["<b>failures.py</b><br/>wait, retry or give up"]
        llm[/"<b>llm.py</b><br/>the three Gemini questions,<br/>embeddings"/]
        ocr[/"<b>ocr.py</b><br/>PDF pages → text"\]
        storage[("<b>storage.py</b><br/>PDFs from S3")]
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
| `main.py` | `main()` (checks `LANES` with `lanes()`, starts a `serve()` loop per lane in its own thread, and exits if one stops), `serve` (one lane's loop), `TASKS` (task type → pipeline function), `next_task`, `run_task` (do it, then delete its dedupe key, queue its follow-ups and acknowledge it, or retry, or give up), `keep_claimed` (renews the claim while a task runs), `give_up`, `check_gemini` |
| `pipeline.py` | one function per task type: `read_circular`, `assess`, `check_policy`, `refresh_company`; `ocr_text` (OCR page by page, each saved) and `twin`; `match` (re-embeds a policy another model made) and `judge_policy`; the embeddings. Each returns the tasks to queue next |
| `../common/common/queue.py` | `LANES` (lane → stream), `lane()` (a task type's lane), the other Redis names, `connect()`, `key()` (a task's dedupe key) and `enqueue()` (shared with the watcher and the api) |
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
        Note right of M: load Settings (GEMINI_API_KEY missing, or a LANES name that isn't a lane? stop)
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
        Note right of M: a thread per lane runs serve(lane)
    end
```

- **Tables.** Every service runs `init_db` at startup: `create_all` makes missing tables, and
  a column a model gained later is added (nullable; nothing is ever dropped). A transaction
  lock (`pg_advisory_xact_lock`) makes services that start together take turns, so two never
  create the same table at once; the COMMIT releases it.
- **`check_gemini`** turns a wrong key or model name (a 4xx) into one clear error. A 429, a
  5xx or no network only logs a warning: tasks wait for Gemini themselves.
- **The consumer name** is `<hostname>-<pid>`. In a container the pid is 1, so a restarted
  container comes back under the same name and finds its own unfinished tasks. A process on
  both lanes uses the one name in both groups: each group keeps its own pending list.
- **A loop per lane.** Each lane in `LANES` gets a `serve()` loop in its own thread. The
  loops share the Redis client and the database engine (both are thread-safe); each task
  gets its own session. The main thread checks every second that all loops are alive, and
  exits if one stopped on an error nobody expected, so Docker restarts the container.

---

## 5. The task loop

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        start(["serve(lane): forever"]) --> join("XGROUP CREATE<br/>&lt;lane&gt; workers 0 MKSTREAM<br/>(BUSYGROUP: it exists, fine)")
        join --> next("next_task()")
        next --> got{"A task?"}
        got -->|"yes"| run[/"run_task(): do it,<br/>XACK unless it's to be retried"/]
        got -->|"no, and --once"| stop(["exit"])
        got -->|"no"| join
        run --> join
        join -.->|"Redis down or timing out"| wait["log, sleep RETRY_SECONDS,<br/>start again"]
        join -.->|"NOGROUP: Redis<br/>lost the group"| join
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
    class join,next svc
    class got ask
    class run ext
    class stop,wait muted
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- Each lane has this loop, `serve(lane)`, in its own thread: the PDF lane's loop can spend
  minutes on a PDF while the main lane's loop takes task after task.
- Each turn starts with `XGROUP CREATE <lane> workers 0 MKSTREAM` (a group that exists
  already is fine). Starting at id `0` delivers tasks queued before any worker ever ran,
  and running it every turn recreates the group if Redis lost its data. If the group goes
  while the loop waits, Redis answers `NOGROUP`: the loop logs it and starts the turn again.
- There is **no polling interval**: `next_task` blocks on Redis for up to 5 seconds, and
  returns the moment a task arrives.
- `--once` (used by tests) runs the lanes one after another, each until a 5-second wait
  finds nothing, and again until a whole round finds nothing (a read queues work on the
  main lane), then exits.
- Redis down or timing out: the loop logs it, waits `RETRY_SECONDS` and starts again.
  Meanwhile the api answers "try again" and the watcher retries next round
  ([section 15](#15-where-tasks-come-from)), so nothing is saved without its task.
- The loop is the worker's only source of work: there's no timer and no Postgres query
  looking for something to do.

---

## 6. Taking the next task

`next_task()` looks in three places on its lane, in order, and takes one task:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a[["XREADGROUP GROUP workers &lt;me&gt;<br/>COUNT 1 STREAMS &lt;lane&gt; <b>0</b>"]] -->|"one of mine,<br/>never acknowledged"| r1(["retry it"])
        a -->|"none"| b[["XAUTOCLAIM &lt;lane&gt; workers &lt;me&gt;<br/><b>300000</b> 0-0 COUNT 1"]]
        b -->|"one idle 5 min<br/>(its worker died)"| r2(["take it over"])
        b -->|"none"| c[["XREADGROUP GROUP workers &lt;me&gt;<br/>COUNT 1 BLOCK 5000 STREAMS &lt;lane&gt; <b>&gt;</b>"]]
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
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        t(["run_task(task)"]) --> fn("TASKS[type](session, **ids)<br/>read_circular · assess ·<br/>check_policy · refresh_company")
        fn -->|"returns follow-up tasks"| del[["DEL its dedupe key"]]
        del --> xadd[["enqueue each follow-up<br/>(circular.assess, or policy.check<br/>for a policy edited meanwhile)"]]
        xadd --> ack(["XACK"])
        fn -.->|"raised"| fail>"should_wait / should_retry /<br/>give_up (section 17)"]
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
  `XCLAIM <lane> workers <me> 0 <id> JUSTID` every `HEARTBEAT_SECONDS` (60) from a
  background thread. Claiming resets the task's idle time, so however long a task takes (a
  20-page PDF waiting its turn on the GPU), it never looks abandoned, and no second worker
  starts the same OCR. The thread stops when the function returns or raises.

---

## 8. The tables it uses

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        CO(["<b>companies</b><br/>read: profile"])
        CI[("<b>circulars</b> (shared)<br/>written: status, text, addressed_to,<br/>summary, requirements, embedding,<br/>embedding_model, error")]
        AS("<b>assessments</b><br/>inserted: one per company and circular<br/>written: status, applicable,<br/>applies_reason, error")
        PO[("<b>policies</b> (per company)<br/>written: embeddings,<br/>embedding_model, checked_at")]
        CT[("<b>controls</b><br/>read, for the prompt")]
        PC(["<b>policy_checks</b><br/>inserted: one per verdict"])
        GA>"<b>gaps</b> (per company)<br/>inserted: one per out-of-date policy"]
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
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
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
| `read` | none, recent, the company not described | `analyzed`, applicable empty: **Not checked** |
| `read` | none, recent, the company described | `parsed` (a `company.refresh` is on its way) |

---

## 10. No duplicates: the dedupe key

The consumer group gives each task to one worker, so workers need no locks to share the
work. What's left is the same **work** queued twice (a double Reprocess, two quick saves of
a policy, a task re-run after a crash queueing its follow-ups again, `manage.py requeue`). `enqueue` prevents it with a key per task:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        add(["enqueue(kind, **ids)"]) --> nx{"SET rci:queued:&lt;task&gt;<br/>1 NX EX 86400"}
        nx -->|"OK"| xadd[["XADD to its lane"]]
        nx -->|"nil: queued or running"| skip(["dropped"])
        xadd --> w("a worker: XREADGROUP,<br/>does the work")
        w --> del("DEL rci:queued:&lt;task&gt;")
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
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        pdf[("PDF bytes")] --> pages["First 20 pages<br/>(OCR_MAX_PAGES)"]
        pages --> saved{"In ocr_pages already?<br/>(same sha256, same page)"}
        saved -->|"yes: read before a retry,<br/>a restart or a takeover"| reuse["use the saved text,<br/>no OCR"]
        saved -->|"no"| blank{"Blank page?<br/>no text layer, images<br/>or drawings"}
        blank -->|"yes"| drop["text is empty,<br/>nothing sent"]
        blank -->|"no"| png[/"Render a PNG<br/>at 200 DPI"\]
        png --> post[/"One chat request to the<br/>ocr service (600 s timeout)"\]
        post --> clean("remove_det: strip markers,<br/>drop images, footers, '[No text]'")
        clean --> save[("INSERT INTO ocr_pages,<br/>COMMIT")]
        drop --> save
        save --> join(["Join the pages:<br/>circulars.text"])
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
            K->>PG: SELECT the company's policies for this regulator<br/>(embed any another model made, COMMIT)
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

1. The company's policies that list the circular's regulator. One not embedded with the
   current model (new, edited, or the model setting changed) is embedded first
   (`embed_policy()`, a no-op otherwise).
2. Each one's score is the best **cosine similarity** between the circular's embedding and
   any of the policy's 5,000-character chunks.
3. Keep the top `MATCH_TOP_K` (3), and skip pairs already judged at this version, or that
   have a gap (the owner is on it).

**What a verdict writes** (`judge_policy`):

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    subgraph canvas[" "]
        direction LR
        ask[/"Gemini's answer"/] --> imp{"impacted and<br/>missing_from_policy<br/>not empty?"}
        imp -->|"no"| up(["policy_checks row<br/>impacted = false"])
        imp -->|"yes"| down>"policy_checks row<br/>impacted = true"]
        down --> gap>"gaps row: title, impact, draft_change,<br/>affected_controls (real codes only),<br/>severity, owner, status 'open',<br/>due_date = today + 7 / 30 / 60 days"]
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
added or saved (every save), and by itself when the policy was saved again during the check.

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

`refresh_company(session, company_id)`, queued by `set_company()` when a company's
description is added or changed (not at sign-up, and not for an unchanged description or a
new name). The api only saves the description; the worker resets the old answers.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant K as worker
        participant PG as Postgres
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        K->>PG: SELECT the company (described_at = its updated_at)
        K->>PG: UPDATE its assessments not pending and updated before described_at<br/>SET status 'pending', applicable and reason cleared, updated_at now
        K->>PG: SELECT id FROM circulars WHERE status = 'read' AND published_at >= cutoff
        K->>PG: INSERT INTO assessments … ON CONFLICT DO NOTHING (each), COMMIT
        K->>PG: SELECT the company's pending assessments of read circulars
        Note right of K: updated_at newer than described_at?<br/>then company.refresh again too
        K->>R: DEL its key, XADD circular.assess per pending circular, XACK
    end
```

- **Which answers are reset:** the company's assessments last updated before its
  description changed (`updated_at` older than the company's), whatever their circular's
  age. One judged after the change (a circular read since) is kept.
- **Which are added:** an assessment for each circular read in the last `LOOKBACK_DAYS` that
  the company lacks, which is all of them for a company that signed up after they were read.
  Older circulars stay unjudged for it (the console shows them as skipped).
- **Changed meanwhile:** the description's time is noted at the start; if it's newer at the
  end, the task returns itself, like `policy.check`.
- **Before any description**, there's no assessment to show for the circulars read before
  the company signed up: the api shows them `analyzed` with `applicable` empty (**Not
  checked**). Circulars read after the sign-up get an assessment from `read_circular` and
  are marked done, not checked, by `assess`.

---

## 15. Where tasks come from

The two lanes are the worker's **only** source of work. It never queries Postgres for things
to do: every change that needs a worker queues its task, right after the change is
committed. `enqueue()` puts `circular.read` on `rci:tasks:pdf` and the rest on `rci:tasks`.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        W("watcher<br/>fetch_new()") -->|"circular.read"| P[["rci:tasks:pdf"]]
        A("api<br/>database.enqueue()") -->|"company.refresh, policy.check,<br/>circular.assess"| Q[["rci:tasks"]]
        A -->|"circular.read<br/>(Reprocess)"| P
        K("reader or worker<br/>run_task(): follow-ups") -->|"circular.assess,<br/>policy.check"| Q
        M["manage.py requeue<br/>(a person, after Redis<br/>lost its data)"] -.-> P
        M -.-> Q
        P --> Y(["XREADGROUP:<br/>the reader"])
        Q --> X(["XREADGROUP:<br/>the workers"])
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
    class W,A,K svc
    class M muted
    class P,Q queue
    class X,Y ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Event | Code | Task | Queued when |
|---|---|---|---|
| a new circular | `fetch_new()`, `watcher/main.py` | `circular.read` | after its row is committed |
| a company description added or changed | `set_company()`, `api/routes/company.py` | `company.refresh` | after it's committed |
| a policy added | `create_policy()`, `api/routes/policies.py` | `policy.check` | after it's committed |
| a policy saved again | `update_policy()`, `api/routes/policies.py` | `policy.check` | on **every** save |
| Reprocess, circular not read | `reprocess_circular()`, `api/routes/circulars.py` | `circular.read` | after its status is set back |
| Reprocess, circular read | `reprocess_circular()` | `circular.assess` (this company) | after the assessment is set back to pending |
| a circular read | `read_circular()` returns them, `run_task()` queues | `circular.assess` per company | when the task is finished |
| a company refresh | `refresh_company()` returns them | `circular.assess` per pending circular | when the task is finished |
| a policy saved during its check | `check_policy()` returns it | `policy.check` | when the task is finished |

Nothing is queued for a sign-up (no description, no policies: nothing to judge), an
unchanged description or a new name, a new control, a gap update, a teammate or a password:
no worker work depends on them (`judge_policy()` reads the controls each time). A change of
`GEMINI_EMBEDDING_MODEL_NAME` queues nothing either: `embed_circular()` and `match()` re-embed
whatever they meet that another model made.

**When Redis can't take a task.** `enqueue()` raises (after deleting the dedupe key it set),
and each producer handles it so no task is ever lost quietly:

| Producer | What it does | Why that's enough |
|---|---|---|
| watcher | deletes the circular's row and counts the circular as failed | the next round finds it unknown, and saves it with its task |
| api, new policy (`enqueue_or_undo()`) | deletes the policy; 503 "nothing was saved: try again" | trying again starts clean |
| api, description (`set_company()`) | puts the old description back; 503 "the description wasn't saved" | saving it again is a change again |
| api, policy save or Reprocess (`enqueue()`) | keeps the change; 503 "Saved, but the task queue is unavailable: try again" | each of these queues its task on every save |
| worker (`run_task()`, queueing follow-ups) | the error reaches the main loop: no `XACK`, wait `RETRY_SECONDS` | the task stays pending, runs again, finds its work saved, and queues its follow-ups |

**When Redis loses its data** (its volume deleted; a restart loses nothing, the lanes are on
disk), `manage.py requeue` in `backend/api` queues every unfinished piece of work Postgres
shows: circulars `new` or `parsed`, assessments `pending` of read circulars, policies never
checked or saved after their check, and a `company.refresh` for each described company (a
lost refresh can't be seen in Postgres; a refresh with nothing to reset only queues what's
pending). A task still queued is skipped by its key; it prints
`N unfinished: X queued, Y already queued`.

---

## 16. Transactions, acknowledgements and crashes

The work session **commits after every step**, and the task is **acknowledged only when it
is finished**. For one circular and one company:

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant RD as reader
        participant K as worker
        participant PG as Postgres
        participant R as Redis
    end

    rect rgb(13, 20, 36)
        Note right of RD: circular.read 98, PDF lane
        RD->>PG: UPDATE text, status 'parsed': COMMIT ①
        RD->>PG: UPDATE summary fields: COMMIT ②
        RD->>PG: UPDATE embedding: COMMIT ③
        RD->>PG: UPDATE status 'read': COMMIT ④
        RD->>PG: INSERT assessments: COMMIT ⑤
        RD->>R: DEL its key, XADD circular.assess × companies to the main lane, XACK ⑥
        Note right of K: circular.assess A/98, main lane
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
first. Otherwise another worker on the same lane takes the task over once it has gone `CLAIM_IDLE_SECONDS`
(5 minutes) without its claim being renewed. A container recreated by `docker compose up
--build` comes back with a new name, so its old task waits those 5 minutes. Nothing queues
the task again meanwhile: its dedupe key is still set.

**Reloading after a commit.** SQLAlchemy expires a session's objects when it commits, so the
next use reads the row again: the worker always sees the latest values, including changes
the api made meanwhile.

---

## 17. When something fails

Every error goes through `run_task()`, with the rules in `failures.py`:

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        err>"the task raised"] --> rb["ROLLBACK the work session"]
        rb --> down{"should_wait?<br/>can't connect (OCR loading),<br/>Gemini 429 (quota)"}
        down -->|"yes"| wait["sleep RETRY_SECONDS (60),<br/><b>no XACK</b>: the task is<br/>this worker's next one"]
        down -->|"no"| retry{"should_retry?<br/>5xx, timeout, dropped connection,<br/>BadReply, IntegrityError"}
        retry -->|"yes"| count{"tries for this task id<br/>reached MAX_TRIES (3)?"}
        count -->|"no"| again["<b>no XACK</b>: retried<br/>straight away"]
        count -->|"yes"| give
        retry -->|"no: a 400,<br/>'OCR found no text', …"| give>"give_up(): circular or assessment<br/>status 'failed', error saved, COMMIT;<br/>XADD rci:dead the task + error"]
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
  `circular.assess` failure on that company's assessment only. Other failures
  (`policy.check`, `company.refresh`) only go to `rci:dead`: saving the policy, or the
  company description, again queues a new task. Nothing re-runs failed work by itself.

---

## 18. What the api and the watcher queue

Every producer saves its change first, then adds the task, so a worker never receives a
task whose change it can't see yet. If Redis can't take the task, nothing is left half done
([section 15](#15-where-tasks-come-from)): the watcher deletes the row, and the api answers
503, deleting a new policy it just created or putting a description back:

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
        Note right of A: no task: nothing to judge yet
        A->>PG: POST or PUT /policies: INSERT or UPDATE policies
        A->>R: enqueue policy.check
        A->>PG: PUT /company, description added or changed:<br/>UPDATE companies SET profile, updated_at
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
| sign up a company | `INSERT` the company and its first user | none: nothing to judge yet |
| add a policy | `INSERT INTO policies`, version 1, no embeddings | `policy.check` |
| edit a policy | text: `version + 1`, embeddings cleared, `policy_updated` on its open gaps; title: embeddings cleared; always `updated_at` | `policy.check` |
| add a control | `INSERT INTO controls` | none: `judge_policy` reads the controls each time |
| add or change the company description | `profile` and `updated_at`; the worker's refresh resets the older answers | `company.refresh` |
| save the company page unchanged, or only a new name | the name, if any | none |
| **Reprocess** a read circular | the company's assessment → `pending` (upsert); its "up to date" verdicts on it deleted | `circular.assess` |
| **Reprocess** any other circular | status `parsed` if it has text, else `new`; `error` cleared | `circular.read` |
| add a teammate, change a password | `users` | none |

---

## 19. Every Redis command

| Command | Who | When |
|---|---|---|
`<lane>` is the task's lane: `rci:tasks:pdf` for `circular.read`, `rci:tasks` for the rest.
Every command below runs on one lane; a reader or worker on both lanes runs them for each.

| Command | Who | When |
|---|---|---|
| `SET rci:queued:<task> 1 NX EX 86400`, then `XADD <lane> MAXLEN ~ 100000 * type … ids …` | watcher, api, worker, `manage.py requeue` | a task is queued (`enqueue`); skipped if the key exists. If either fails: `DEL` the key, and the error is raised |
| `XGROUP CREATE <lane> workers 0 MKSTREAM` | worker | every turn of the lane's loop; `BUSYGROUP` means it exists |
| `XREADGROUP GROUP workers <me> COUNT 1 STREAMS <lane> 0` | worker | its own unfinished task |
| `XAUTOCLAIM <lane> workers <me> 300000 0-0 COUNT 1` | worker | a dead worker's task |
| `XCLAIM <lane> workers <me> 0 <id> JUSTID` | worker | every minute while it runs a task: renews its claim |
| `XREADGROUP GROUP workers <me> COUNT 1 BLOCK 5000 STREAMS <lane> >` | worker | a new task |
| `DEL rci:queued:<task>`, then `XACK <lane> workers <id>` | worker | a task finished or given up |
| `XADD rci:dead * type … ids … stream … task_id … error …` | worker | a task given up |

To look inside: `docker compose exec redis redis-cli XINFO GROUPS rci:tasks` (the main lane;
`rci:tasks:pdf` for the PDF lane. `lag`: waiting, `pending`: being worked on),
`XRANGE rci:dead - +`, `KEYS rci:queued:*`.

---

## 20. Every database operation

What each task sends, in order. `…` stands for the values.

| Task | Statements |
|---|---|
| startup | `SELECT pg_advisory_xact_lock(hashtext('rci-schema'))`; `CREATE TABLE …`; `ALTER TABLE … ADD COLUMN …` for new columns; `COMMIT` |
| `circular.read` | `SELECT … FROM circulars WHERE id = …`; if new: the twin's text (`SELECT … WHERE sha256 = … AND id <> … AND text IS NOT NULL`), or `SELECT page, text FROM ocr_pages WHERE sha256 = …` and per page OCR'd `INSERT INTO ocr_pages`, `COMMIT`; `UPDATE circulars SET text, status = 'parsed'`, `DELETE FROM ocr_pages WHERE sha256 = …`, `COMMIT`; if no summary: the twin's (`… AND summary IS NOT NULL`) or Gemini's, `UPDATE … SET addressed_to, summary, requirements, embedding = NULL`, `COMMIT`; `UPDATE … SET embedding, embedding_model`, `COMMIT`; `UPDATE … SET status = 'read', error = NULL`, `COMMIT`; `SELECT id FROM companies`; `INSERT INTO assessments … ON CONFLICT DO NOTHING` (one statement for all), `COMMIT`; `SELECT company_id, circular_id FROM assessments JOIN circulars … WHERE pending` |
| `circular.assess` | `SELECT` the company and the circular; `INSERT INTO assessments … ON CONFLICT DO NOTHING`, `COMMIT`; `SELECT` the assessment; maybe `UPDATE assessments SET applicable, applies_reason`, `COMMIT`; `SELECT … FROM policies WHERE company_id = …`; `SELECT policy_id, policy_version FROM policy_checks WHERE circular_id = …`; `SELECT policy_id FROM gaps WHERE circular_id = …`; per policy asked: `SELECT … FROM controls`, `INSERT INTO policy_checks`, maybe `INSERT INTO gaps … RETURNING id` and `INSERT INTO gap_events`, `COMMIT`; `UPDATE assessments SET status = 'done', error = NULL, updated_at`, `COMMIT` |
| `policy.check` | `SELECT` the policy and the company; maybe `UPDATE policies SET embeddings, embedding_model`, `COMMIT`; `SELECT circulars … JOIN assessments …` (no `text`); per circular, the matching statements of `circular.assess`; `UPDATE policies SET checked_at`, `COMMIT` |
| `company.refresh` | `SELECT` the company; `UPDATE assessments SET status = 'pending', applicable = NULL, applies_reason = NULL, error = NULL, updated_at = … WHERE company_id = … AND status <> 'pending' AND updated_at < …`; `SELECT id FROM circulars WHERE status = 'read' AND published_at >= …`; `INSERT INTO assessments … ON CONFLICT DO NOTHING`, `COMMIT`; `SELECT … WHERE pending` |
| `manage.py requeue` (a person, after Redis lost its data) | `SELECT id FROM circulars WHERE status IN ('new', 'parsed')`; `SELECT id FROM companies WHERE profile <> ''`; the pending assessments of read circulars; `SELECT company_id, id FROM policies WHERE checked_at IS NULL OR checked_at < updated_at` |
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
| `REDIS_URL` | `redis://localhost:6379/0` (compose: `redis://redis:6379/0`) | the task lanes |
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
| `LANES` | `pdf,main` (compose: `reader` has `pdf`, `worker` has `main`) | the lanes this process takes, a loop for each |
| `WORKERS` (compose) | 1 | how many workers take the main lane side by side |

Constants in the code:

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `LANES` | `pdf`: `rci:tasks:pdf`, `main`: `rci:tasks` | `common/queue.py` | the lanes' streams; `lane()` sends `circular.read` to `pdf` |
| `GROUP`, `DEAD` | `workers`, `rci:dead` | `common/queue.py` | the group on each lane, the dead-letter stream |
| dedupe keys | `rci:queued:…`, expire after 1 day | `common/queue.py` | a task is queued at most once at a time |
| stream length | 100000 (approximate) | `common/queue.py` | each lane is trimmed beyond this |
| blocking read | 5000 ms | `main.py` | how long a worker waits for a new task per read |
| `MAX_TRIES` | 3 | `failures.py` | tries before a crashing task is given up |
| `HEARTBEAT_SECONDS` | 60 | `main.py` | how often a worker renews its claim on the task it's running |
| `DUE_DAYS` | high 7, medium 30, low 60 | `pipeline.py` | days a gap's owner gets, by severity |
| `EMBED_CHARS` | 5000 | `pipeline.py` | the chunk size for embeddings |
| embedding size | 768 | `llm.py` | numbers per embedding |
| applicability text | 4000 characters | `llm.py` | text sent for "does it apply?" |
| `DPI` | 200 | `ocr.py` | page rendering for OCR |

For what the log lines mean, see [Reading its log](../../how_it_works.md#reading-its-log).
