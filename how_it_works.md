# How the backend works

![Python 3.14](https://img.shields.io/badge/Python_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white) ![SQLModel](https://img.shields.io/badge/SQLModel-7E56C2?style=flat-square) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Gemini via LangChain](https://img.shields.io/badge/Gemini_via_LangChain-8E75B2?style=flat-square&logo=googlegemini&logoColor=white) ![Unlimited-OCR on vLLM](https://img.shields.io/badge/Unlimited--OCR_on_vLLM-EA580C?style=flat-square) ![Docker Compose](https://img.shields.io/badge/Docker_Compose-2496ED?style=flat-square&logo=docker&logoColor=white)

This guide explains the Regulatory Circular Impact Agent from the outside in. It starts with
one picture of the whole system, follows a single circular through it, and then covers each
service, the data, and what happens when something breaks. Every diagram is Mermaid, so it
renders on GitHub and in VS Code's Markdown preview.

**Reading the diagrams.** Each colour means the same thing in every diagram:

![our services](https://img.shields.io/badge/our_services-2dd4bf?style=flat-square) ![data](https://img.shields.io/badge/data-818cf8?style=flat-square) ![Gemini and outside services](https://img.shields.io/badge/Gemini_and_outside_services-c084fc?style=flat-square) ![OCR on the GPU](https://img.shields.io/badge/OCR_on_the_GPU-fb923c?style=flat-square) ![a decision](https://img.shields.io/badge/a_decision-fbbf24?style=flat-square) ![done, or OK](https://img.shields.io/badge/done,_or_OK-34d399?style=flat-square) ![a failure, or a gap](https://img.shields.io/badge/a_failure,_or_a_gap-fb7185?style=flat-square) ![where it starts](https://img.shields.io/badge/where_it_starts-a7ef6f?style=flat-square)

**Contents**

1. [The idea in one minute](#1-the-idea-in-one-minute)
2. [The big picture](#2-the-big-picture)
3. [What runs where](#3-what-runs-where)
4. [The life of one circular](#4-the-life-of-one-circular)
5. [Step 1: the watcher finds new circulars](#5-step-1-the-watcher-finds-new-circulars)
6. [Step 2: OCR turns the PDF into text](#6-step-2-ocr-turns-the-pdf-into-text)
7. [Step 3: the worker decides what the circular means for us](#7-step-3-the-worker-decides-what-the-circular-means-for-us)
8. [When you add or edit a policy](#8-when-you-add-or-edit-a-policy)
9. [The data](#9-the-data)
10. [Tracking a gap until it's closed](#10-tracking-a-gap-until-its-closed)
11. [The API and the console](#11-the-api-and-the-console)
12. [When things go wrong](#12-when-things-go-wrong)
13. [Where settings come from](#13-where-settings-come-from)
14. [The code, file by file](#14-the-code-file-by-file)
15. [How do I…?](#15-how-do-i)
16. [Glossary](#16-glossary)

---

## 1. The idea in one minute

Indian regulators (**RBI**, **SEBI** and **IRDAI**) publish new circulars every week. Each
one can make a company's internal policy out of date.

The agent does four things by itself:

1. **Watches** the three regulators' websites and downloads every new circular (a PDF).
2. **Reads** it: OCR turns the PDF into text.
3. **Decides** whether the circular applies to the company and, if it does, which internal
   policies it makes out of date.
4. **Opens a gap ticket** for each such policy, addressed to the policy's owner, with a
   drafted change to the policy's wording.

It needs two things that only you can give it, both entered in the console:

- **a description of your company** (what kind of entity it is, its licences and businesses),
  so it can tell which circulars apply to you;
- **your policies and their controls**, so it has something to compare each circular with.

It ships with neither. Until you add them it still reads and summarises every circular,
but it doesn't say which ones apply to you, and it opens no gaps.

People then work the gaps (in progress, closed or dismissed) in the console. Every change is
kept in the gap's history.

> 💡 **Why it matters.** The company's own policy library, and the history of its gaps, are
> what make this more than a chatbot. The agent compares each circular against *your* policies and keeps
> *your* audit trail.

---

## 2. The big picture

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    sites["RBI · SEBI · IRDAI<br/>websites"] -->|new circulars| W["watcher"]
    W -->|PDF| S3[("S3 (Floci)<br/>the PDFs")]
    W -->|"row, status 'new'"| DB[("Postgres")]
    S3 -->|PDF| K["worker<br/>(the agent)"]
    DB <-->|"picks up work,<br/>saves results and gaps"| K
    K <-->|"page image → text"| O["ocr<br/>Unlimited-OCR on the GPU"]
    K <-->|"question → JSON answer"| G["Gemini<br/>(via LangChain)"]
    DB <-->|reads and writes| A["api<br/>FastAPI"]
    A <-->|"/api/*"| F["frontend<br/>console"]
    F <--> U(("You"))

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class W,K,A,F svc
    class S3,DB data
    class sites,G ext
    class O gpu
    class U start
```

There are two kinds of service:

- **Background services** work on their own, around the clock:
  - the **watcher** finds circulars;
  - the **worker** reads them and opens gaps;
  - **ocr** is the model the worker uses to read the PDFs.
- **Services for people:** the **api** and the **frontend** (the console) show you
  everything and let you manage policies and gaps.

The services never call each other directly, except the worker calling `ocr` and Gemini.
They hand work over through **Postgres**: the watcher writes a row with status `new`, and
the worker picks up any row with that status. That keeps each service simple, and means any
of them can be restarted at any time.

---

## 3. What runs where

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    B["Browser"] -->|":8080"| FE

    subgraph compose["docker compose (project: rci)"]
        FE["frontend<br/>nginx :8080"] -->|"/api/*"| API["api<br/>uvicorn :8000"]
        API --> PG[("postgres<br/>:5432")]
        WA["watcher"] --> PG
        WK["worker"] --> PG
        WK -->|"http://ocr:8000/v1"| OC["ocr<br/>vLLM (host :8001)"]
    end

    WA -->|PDFs| FL[("Floci S3 :4566<br/>(outside Docker)")]
    WK -->|PDFs| FL
    WK -->|HTTPS| GEM["Gemini API<br/>(internet)"]
    OC --- GPU[["NVIDIA GPU"]]


    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class FE,API,WA,WK svc
    class PG,FL data
    class GEM ext
    class OC,GPU gpu
    class B start
    classDef external stroke-dasharray: 5 4
    class FL,GEM,GPU external
    style compose fill:#0c1a24,stroke:#2dd4bf
```

| Service | Folder | Runs | Port on your machine |
|---|---|---|---|
| `watcher` | `backend/watcher` | `python main.py`, one round every 60 minutes | none |
| `ocr` | `backend/ocr` | vLLM serving `baidu/Unlimited-OCR` on the GPU | 8001 |
| `worker` | `backend/worker` | `python main.py`, one round every 60 seconds ([how a round works](#how-the-worker-works-one-round-every-60-seconds)) | none |
| `api` | `backend/api` | `uvicorn main:app` | 8000 (docs at `/docs`) |
| `frontend` | `frontend` | nginx serving static files | 8080 |
| `postgres` | none (official image) | the database | 5432 |

Two things live outside Docker:

- **Floci**, a local AWS emulator used for S3, where the PDFs are kept.
- **Gemini**, Google's API, which the worker reaches over the internet.

The database tables are defined once, in `backend/common`, and installed into the watcher,
worker and api. Each of those has its own `pyproject.toml` and virtualenv.

---

## 4. The life of one circular

This is the whole journey of one circular, from the regulator's website to a ticket on
someone's desk.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    autonumber
    participant Site as Regulator site
    participant W as watcher
    participant S3 as S3 (Floci)
    participant DB as Postgres
    participant K as worker
    participant O as ocr (GPU)
    participant G as Gemini
    participant P as Policy owner

    rect rgb(13, 20, 36)
        W->>DB: already known? (source + source_key)
        W->>Site: download the PDF
        W->>S3: store rbi/sha256.pdf
        W->>DB: insert row, status new

        Note over K: every 60 seconds
        K->>DB: newest circular with status new
        alt the same PDF was already read for another circular
            K->>DB: copy its saved text
        else
            K->>S3: get the PDF
            loop each page, up to 20
                K->>O: page image (PNG)
                O-->>K: page text
            end
        end
        K->>DB: save text, status parsed

        K->>G: who is it addressed to, what does it change and require?
        G-->>K: addressed_to, summary, requirements
        K->>DB: save them
        K->>DB: read the company description
        opt a description exists
            K->>G: does it apply to this company?
            G-->>K: applies_to_company, reason
        end
        alt applies to the company
            K->>G: embed the circular (saved with it)
            G-->>K: vector
            Note over K: pick the 3 most similar policies from the same regulator
            loop each of those policies not judged before
                K->>G: is this policy out of date?
                G-->>K: missing_from_policy, severity, draft_change
                K->>DB: save the verdict, and open a gap if out of date
            end
        end
        K->>DB: status analyzed
        P->>DB: sees the gap in the console, works it, closes it
    end
```

A circular's **status** tells you where it is in that journey:

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "transitionColor": "#8b9bb4", "transitionLabelColor": "#e2e8f0", "stateLabelColor": "#e6edf7", "labelBackgroundColor": "#0f172a", "specialStateColor": "#a7ef6f", "innerEndBackground": "#a7ef6f", "stateBkg": "#16213a", "stateBorder": "#475a7a"}}}%%
stateDiagram-v2
    [*] --> new: watcher saves it
    new --> skipped: published more than 30 days ago
    new --> parsed: OCR done
    parsed --> analyzed: Gemini done
    new --> failed: error, see the error field
    parsed --> failed: error, see the error field
    failed --> new: reprocess (no OCR text yet)
    failed --> parsed: reprocess (OCR text kept)
    analyzed --> parsed: reprocess, or the company description changed
    analyzed --> [*]
    skipped --> [*]

    classDef queued fill:#0c2231,stroke:#38bdf8,color:#e0f2fe
    classDef working fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef done fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef broken fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef quiet fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class new queued
    class parsed working
    class analyzed done
    class failed broken
    class skipped quiet
```

- **`new`**: saved by the watcher, waiting for the worker.
- **`parsed`**: OCR is done and the text is saved. Everything after this reads the saved
  text, so OCR never runs twice for a circular, whatever happens next.
- **`analyzed`**: finished. The circular now has its addressee, a summary, its
  requirements, `applicable` (true, false, or empty if no company description exists yet)
  with the reason, and any gaps it opened.
- **`failed`**: something went wrong that retrying didn't fix. The `error` field says
  what, and **Reprocess** in the console queues it again.
- **`skipped`**: older than `LOOKBACK_DAYS` (30) when the worker first saw it. That stops a
  first start from working through years of old circulars.

---

## 5. Step 1: the watcher finds new circulars

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    start(["Every 60 minutes"]) --> each["For RBI, SEBI and IRDAI"]
    each --> list["Fetch the list of circulars"]
    list --> known{"Already in the database?<br/>(source + source_key)"}
    known -->|yes| next["Next one"]
    known -->|no| pdf["Find and download the PDF<br/>(English version, not Hindi)"]
    pdf --> isPdf{"Really a PDF?<br/>(starts with %PDF)"}
    isPdf -->|no| skip["Log it and skip it.<br/>Tried again next round"]
    isPdf -->|yes| store["Store it in S3 as<br/>source/sha256.pdf"]
    store --> row["Insert a circulars row<br/>with status new"]
    row --> next
    skip --> next

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
    class known,isPdf ask
    class skip bad
    class store,row data
    class next muted
```

Where each regulator's circulars come from:

| Source | How the watcher reads it | Stable ID (`source_key`) |
|---|---|---|
| RBI | the RSS feed `notifications_rss.xml` | `?Id=` in the link |
| SEBI | three listing pages: circulars, master circulars and regulations (the RSS feed misses many circulars) | the page's path |
| IRDAI | the circulars table, where each row links its own PDF | `?documentId=` in the link |

Things worth knowing:

- **Politeness.** Every request waits 1.5 seconds first, and retries up to 3 times on a
  network error, a 429 or a 5xx.
- **Nothing half-saved.** The row is inserted only after the PDF is safely in S3, so a
  failure simply means "try again next round".
- **The PDF's hash is its name** (`rbi/<sha256>.pdf`), so the same file is never stored
  twice.

---

## 6. Step 2: OCR turns the PDF into text

The worker reads each PDF with **Baidu Unlimited-OCR**, a vision model that sees the page as
an image. It handles scanned pages, tables and Hindi, not just a PDF's text layer.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    pdf["PDF from S3"] --> pages["First 20 pages<br/>(OCR_MAX_PAGES)"]
    pages --> png["Each page rendered<br/>to a PNG at 200 DPI"]
    png --> request["One request per page to<br/>the ocr service"]
    request --> raw["Page text, each block tagged<br/>with its type and position"]
    raw --> clean["Strip the markers.<br/>Drop footers, images, '[No text]'"]
    clean --> saved["circulars.text<br/>status parsed"]

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
    class request,raw gpu
    class saved ok
```

- The model tags each block of text with its type and position on the page, like
  `<|det|>text [117, 118, 297, 134]<|/det|>RBI/2026-2027/270`. `ocr.py` strips those tags
  and drops page footers (the boilerplate "RBI never sends mails…"), images and empty blocks.
- The request uses the model's own recipe: the prompt `<image>document parsing.`, plus a
  no-repeat n-gram setting that stops it looping on tables.
- **Why only 20 pages?** Long master circulars state their changes up front. The cap keeps
  a 300-page regulation from tying up the GPU for an hour.
- **Why 200 DPI?** At 200 DPI an A4 page is cut into about 6 tiles. At 300 DPI it's 24,
  which is too much for an 8 GB GPU. `backend/ocr/README.md` explains the vLLM flags that
  make the model fit.
- **Once per PDF.** OCR is the slow step (tens of seconds a page on a laptop GPU), so its
  output is kept in `circulars.text` and everything else reads that. When a regulator lists
  the same PDF under a second circular, the worker spots the identical file (same SHA-256)
  and copies the saved text instead of reading it again.
- **No page read twice.** If page 15 of 20 times out, the retry starts at page 15: pages
  already read are kept in memory until the document is done. Blank pages are skipped, and
  all pages go over one reused connection.

---

## 7. Step 3: the worker decides what the circular means for us

This is where the thinking happens. The worker asks Gemini three kinds of question. Each
answer comes back as **JSON matching a Pydantic model** (LangChain's
`with_structured_output`), never as free text the code would have to parse.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    text["Circular text"] --> q1["Gemini: who is it addressed to,<br/>what does it change,<br/>what does it require?"]
    q1 --> described{"Has the company<br/>been described?"}
    described -->|no| doneUnknown["analyzed<br/>applicable = not checked, no gaps"]
    described -->|yes| q2["Gemini: does it apply to<br/>this company? And why?"]
    q2 --> applies{"Applies?"}
    applies -->|no| doneNo["analyzed<br/>applicable = false, no gaps"]
    applies -->|yes| anyReq{"Any obligations?"}
    anyReq -->|"no (informational)"| doneInfo["analyzed<br/>no gaps"]
    anyReq -->|yes| match["Pick the 3 closest policies<br/>(same regulator, by embedding similarity)"]
    match --> q3["For each of the 3 — Gemini:<br/>is this policy out of date?<br/>What's missing? Draft the new wording"]
    q3 --> impacted{"Out of date?"}
    impacted -->|yes| gap["Open a gap for the policy owner,<br/>due date by severity"]
    impacted -->|no| ok["No gap for this policy"]
    gap --> done["analyzed"]
    ok --> done

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class text data
    class q1,q2,q3 ext
    class described,applies,anyReq,impacted ask
    class doneUnknown,doneNo,doneInfo muted
    class match svc
    class gap bad
    class ok,done ok
```

Every verdict from the last step is saved in `policy_checks`, one row per circular and
policy version. A pair that has a row, or already has a gap, is never sent to Gemini again,
so a circular and policy pair never get two tickets and never cost two calls.

### The three questions

| # | Question | What Gemini gets | What comes back |
|---|---|---|---|
| 1 | What does it say? (every circular) | Up to 100,000 characters of the text | `addressed_to`, `summary`, `requirements[]` (with numbers and deadlines kept as written) |
| 2 | Does it apply to us? (only once the company is described) | Your company description, the addressee, and the first 4,000 characters | `applies_to_company`, `reason` |
| 3 | Is this policy out of date? | Your company description, the circular's addressee, summary and requirements, the policy's text and its controls | `missing_from_policy`, `impacted`, `severity`, `affected_controls[]`, `draft_change` |

The company description is **yours**. It's written on the console's **Company** page and
stored in the `company` table, with no built-in default. Saving a changed description clears
every circular's "does it apply?" answer and sends the analysed ones back to `parsed`. The
worker then asks question 2 again, and only question 2: the OCR text, the summaries and the
policy verdicts don't depend on the description, so they're kept.

### Work that's done once, and kept

Everything slow or paid for is saved the first time and reused after that:

| Work | Saved in | Done again only when |
|---|---|---|
| OCR of the PDF (the slowest step) | `circulars.text` | never. A second circular with the same PDF copies it |
| Question 1: what does it say? | `circulars.addressed_to`, `summary`, `requirements` | you press **Reprocess** |
| Question 2: does it apply to us? | `circulars.applicable`, `applies_reason` | you change the company description, or press **Reprocess** |
| The circular's embedding | `circulars.embedding` | its summary changes, or you change the embedding model |
| A policy's embeddings | `policies.embeddings` | its title or text is edited, or you change the embedding model |
| Question 3: is this policy out of date? | `policy_checks` (and a gap if it is) | the policy's text changes (a new version), or **Reprocess** re-asks the "up to date" ones |

> ✅ **Nothing is done twice.** A restart, an outage halfway through, a new policy or a
> changed company description never repeats a call that already succeeded. A quiet round,
> with nothing new anywhere, makes no OCR or Gemini call at all.

### How the closest policies are found

Reading every policy for every circular would be slow and expensive, so the worker narrows
the list first with **embeddings**. An embedding turns a text into a list of 768 numbers,
where similar meanings give similar numbers.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    c["Circular:<br/>title + summary + requirements"] -->|"embed (RETRIEVAL_QUERY)<br/>done once, stored on the circular"| qv(("query<br/>vector"))
    p["Each policy:<br/>title + text, in 5,000-character chunks"] -->|"embed (RETRIEVAL_DOCUMENT)<br/>done once, stored on the policy"| pv(("one vector<br/>per chunk"))
    qv --> cos["Cosine similarity.<br/>A policy scores its best chunk"]
    pv --> cos
    filter["Only policies tagged with<br/>the circular's regulator"] --> cos
    cos --> top["Top 3 (MATCH_TOP_K)<br/>go to question 3"]

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class c,p data
    class qv,pv,cos svc
    class filter ask
    class top ok
```

The embedding model reads about 2,000 tokens at most, so a long policy is split into
5,000-character chunks and each chunk is embedded. A policy's score is its best chunk's, so
a clause on page 12 of a long KYC policy still makes it a match.

### What a gap contains

| Field | Where it comes from |
|---|---|
| `title` | `Update POL-KYC for RBI circular: <circular title>` |
| `impact` | what the policy is missing (Gemini, question 3) |
| `draft_change` | the proposed wording (Gemini, question 3) |
| `affected_controls` | the policy's controls Gemini named. Codes that don't exist are dropped |
| `severity` | `high` (a breach or penalty), `medium` (a process or document must change) or `low` (wording only) |
| `owner` | the policy's owner |
| `due_date` | today plus 7 days (high), 30 (medium) or 60 (low) |
| `policy_version` | the version of the policy that was found out of date |

Each gap starts its history with one event: `agent` `opened` it.

---

## 8. When you add or edit a policy

Circulars aren't the only trigger. When you add a policy, the worker checks it against the
circulars of the **last 30 days** that apply to the company, so a library loaded today still
finds the gaps left by last week's circulars. From then on, every new circular is checked
against it too.

> 💡 **No restart needed.** The worker notices a new or edited policy on its next round,
> within a minute.

In short, for a new policy:

1. The api saves it as version 1, with no embeddings yet.
2. Within 60 seconds the worker embeds it (turns its text into vectors, see
   [section 7](#how-the-closest-policies-are-found)).
3. The worker lists the recent circulars that apply to the company and have obligations.
4. For each one it ranks every policy by similarity. Where the new policy is among the 3
   closest, Gemini is asked whether the policy is now out of date.
5. Each answer is saved. An out-of-date policy gets a gap ticket for its owner, with a draft
   of the new wording.

### How the worker works: one round every 60 seconds

The worker is a loop. Each round does the same four things, then waits 60 seconds
(`POLL_SECONDS`) and starts again. The wait starts when a round finishes, so a round that
reads a long circular simply takes longer.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    boot(["Worker starts"]) --> init["Create any missing tables and columns.<br/>Check the Gemini key and model names"]
    init --> r1
    subgraph round["One round"]
        r1["Step 1: embed policies that are<br/>new or edited"] --> r2{"Step 2: anything changed<br/>since the last catch-up?"}
        r2 -->|yes| r3["Catch up: check recent circulars<br/>against their closest policies"]
        r2 -->|no| r4
        r3 --> r4["Step 3: mark new circulars older<br/>than 30 days as skipped"]
        r4 --> r5{"Step 4: is a circular waiting?<br/>(status new or parsed)"}
        r5 -->|yes| r6["Process it, newest first: OCR if needed,<br/>read, judge, check its closest policies"]
        r6 --> r5
    end
    r5 -->|no| wait["Wait 60 seconds"]
    wait --> r1

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class boot start
    class r1,r3,r4,r6 svc
    class r2,r5 ask
    class wait muted
    style round fill:#0c1a24,stroke:#2dd4bf
```

Steps 1 and 2 are where a new policy is handled. "Anything changed" means the company
description, any policy, or the set of recent circulars that apply to the company. In the
catch-up, only pairs of circular and policy that were never judged are sent to Gemini. A
round with nothing new costs a few database reads and no OCR or Gemini call, so running
every minute is free.

### Step by step: what happens to a new policy

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    autonumber
    participant U as You
    participant F as console
    participant A as api
    participant DB as Postgres
    participant K as worker
    participant G as Gemini

    rect rgb(13, 20, 36)
        U->>F: New policy or Import JSON
        F->>A: POST /policies
        A->>DB: save as version 1, no embeddings
        A-->>F: 201 Created
        Note over K: next round, within 60 s
        K->>DB: policies with no embeddings?
        DB-->>K: the new policy
        K->>G: embed it, in 5,000-character chunks
        G-->>K: one vector per chunk
        K->>DB: save the vectors
        Note over K: library changed: catch up
        K->>DB: recent circulars that apply
        DB-->>K: circulars and their vectors
        Note over K: rank the policies for each<br/>circular (no Gemini call)
        loop each circular: new policy in its top 3, pair never judged
            K->>G: is the policy out of date?
            G-->>K: what's missing, severity, draft
            K->>DB: save the verdict (policy_checks)
            opt out of date
                K->>DB: open a gap for the owner
            end
        end
        U->>F: gap under Gaps, verdict on the circular
    end
```

### Which circulars a new policy is checked against

Not every circular. Each filter below exists either because the question can't be asked yet
or because the answer is already known:

A circular is checked against the new policy only if it passes every one of these, left to
right. The first row decides whether the circular is worth checking at all; the second,
whether this policy is one of the right ones to ask about.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    all(["Every circular in the database"]) --> row1
    subgraph row1["Is the circular worth checking?"]
        direction LR
        a["Analysed"] --> b["Applies to<br/>the company"] --> c["Published in<br/>the last 30 days"] --> d["Creates<br/>obligations"]
    end
    row1 --> row2
    subgraph row2["Is this policy one to ask about?"]
        direction LR
        e["Lists the circular's<br/>regulator"] --> f["Among the circular's<br/>3 closest policies"] --> g["Never judged at this<br/>version, and no gap yet"]
    end
    row2 --> ask(["Sent to Gemini"])

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class all start
    class ask ext
    style row1 fill:#0c1a24,stroke:#2dd4bf
    style row2 fill:#170f26,stroke:#c084fc
```

| If it fails… | It means | Setting |
|---|---|---|
| Analysed | the circular is still waiting, failed, or was skipped as too old | |
| Applies to the company | Gemini judged it's for other kinds of entity, or the company isn't described yet | |
| Published in the last 30 days | it's older than the catch-up window | `LOOKBACK_DAYS` |
| Creates obligations | it's informational (a repeal, a notice), so there's nothing a policy could miss | |
| Lists the circular's regulator | the policy isn't tagged with RBI, SEBI or IRDAI as needed | |
| Among the 3 closest | other policies fit this circular better | `MATCH_TOP_K` |
| Never judged | Gemini already answered for this version of the policy, or a gap is already open | |

The "3 closest" test is relative. Every policy that lists the circular's regulator competes
for the 3 places, by how close its best chunk is to the circular (see
[How the closest policies are found](#how-the-closest-policies-are-found)). With 3 or fewer
policies for that regulator, all of them are checked. With 50, only the 3 most relevant are,
which keeps Gemini's work (and your bill) small without missing the policies that matter.

### How Gemini decides whether there's a gap

For each pair that gets through, Gemini is asked question 3 from
[section 7](#the-three-questions):

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph input["What Gemini is given"]
        direction LR
        co["Your company<br/>description"]
        ci["The circular: addressee,<br/>summary, obligations"]
        po["The policy: its text at this<br/>version, and its controls"]
        co ~~~ ci ~~~ po
    end
    input --> q{"Does the circular require<br/>something this policy<br/>doesn't already say?"}
    q -->|no| ok["Up to date<br/>saved in policy_checks<br/>no gap"]
    q -->|yes| bad["Out of date<br/>saved in policy_checks"]
    bad --> gap["A gap for the policy owner:<br/>what's missing, severity, draft wording,<br/>affected controls, due date"]

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class q ask
    class ok ok
    class bad,gap bad
    style input fill:#170f26,stroke:#c084fc
```

Strictly, "out of date" means the circular creates or changes an obligation within this
policy's scope that the policy text doesn't already meet.

- **Up to date** is a real answer, not a failure. It means the policy already says what the
  circular requires, or the circular is about something the policy doesn't cover. It's still
  saved, so the same pair is never asked about again.
- **Out of date** opens one gap with `severity` high, medium or low, due in 7, 30 or 60 days.
  See [What a gap contains](#what-a-gap-contains).
- Controls Gemini names that don't exist on the policy are dropped from the gap.

### An example: a new policy with no gap

Say you add **POL-DRP** (listing RBI, SEBI and IRDAI) to a library that already has one
policy, for a company described as a non-deposit-taking NBFC, and the worker has analysed 25
circulars from the last 30 days:

| Circulars | How many | What happens to them |
|---|---|---|
| Don't apply to an NBFC | 23 | not checked |
| Applies, but only repeals old guidelines (no obligations) | 1 | nothing to check |
| Applies, with 4 obligations (an RBI circular) | 1 | checked |

The worker then:

1. **Embeds** POL-DRP (3,057 characters, so 1 chunk) about 30 seconds after you save it.
2. **Ranks** the 2 policies for the one eligible circular: POL-DRP scores 0.58, POL-DLP 0.55.
   With only 2 policies, both are in the top 3.
3. **Asks Gemini** about POL-DRP. POL-DLP was already judged for this circular, so it isn't
   asked again. Gemini finds that POL-DRP already covers what the circular requires.
4. **Saves** the verdict: up to date, no gap.

It's all visible in the worker's log:

```text
INFO pipeline embedded 1 policies (1 chunks) with gemini-embedding-001
INFO pipeline #98 vs POL-DRP v1 (similarity 0.58): up to date
INFO pipeline caught up: 1 new checks against 1 recent circulars, gaps opened: none
```

And in the console: the circular's page lists both policies under **Checked against your
policies**, each marked **Up to date**. Nothing shows on the Gaps page because no gap was
needed. The next RBI, SEBI or IRDAI circular that applies will be checked against POL-DRP
as soon as it's analysed.

### After that: every new circular includes the policy

The catch-up above only looks back. Going forward, the new policy is simply part of the
library: each new circular that applies ranks all the policies (the new one included) and
the 3 closest are judged, as in [section 7](#7-step-3-the-worker-decides-what-the-circular-means-for-us).

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    nc["A new circular<br/>that applies to us"] --> rank["Rank every policy<br/>for its regulator"]
    lib[("The policy library,<br/>new policy included")] --> rank
    rank --> top["Its 3 closest"] --> judge["Gemini judges each one"] --> out["Verdicts saved,<br/>gaps opened"]

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class nc,lib data
    class rank,top svc
    class judge ext
    class out ok
```

### When you edit a policy: what gets redone

Only what the change can affect:

| You change | Re-embedded? | Checked again? | Why |
|---|---|---|---|
| the owner | no | no | nothing Gemini sees has changed. New gaps go to the new owner |
| a control (added) | no | no | used from the next check on |
| the regulators | no | yes, against circulars from the newly listed regulators | those circulars couldn't pick it before |
| the title | yes | only pairs never judged | the ranking may change; the text Gemini judges is the same version |
| the text | yes | yes: it's a new version, so every recent pair is judged again, except pairs that already have a gap | a new version may fix, or cause, a gap |

A text edit also bumps the version and adds a `policy_updated` event to each of the policy's
open gaps ("POL-KYC updated to v2"), so the owner can close them against the new wording.

### Why doesn't my new policy have a gap?

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    s(["Added a policy, but no gap?"]) --> q1{"Is the company described?<br/>(the Company page)"}
    q1 -->|no| a1["Describe it. Until then no circular<br/>is judged as applying to you"]
    q1 -->|yes| q2{"Does any circular from the last<br/>30 days apply to you and<br/>have obligations?"}
    q2 -->|no| a2["Nothing to check yet.<br/>New circulars will be checked"]
    q2 -->|yes| q3{"Open that circular. Is the policy<br/>under Checked against your policies?"}
    q3 -->|"yes, Up to date"| a3["Gemini found the policy already<br/>meets the circular: no gap is needed"]
    q3 -->|no| q4{"Does the policy list that<br/>circular's regulator?"}
    q4 -->|no| a4["Edit the policy and<br/>add the regulator"]
    q4 -->|yes| a5["Other policies were closer, so it<br/>wasn't in the top 3. Raise MATCH_TOP_K<br/>to check more policies per circular"]

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class s start
    class q1,q2,q3,q4 ask
    class a3 ok
    class a1,a2,a4,a5 muted
```

To see what the worker did, and when:

```bash
docker compose logs worker | grep -E "embedded|caught up| vs "
```

### Reliability

- **Each verdict is saved as soon as Gemini gives it.** If Gemini fails halfway, the next
  round carries on from the next unjudged pair; nothing is asked twice.
- **Nothing changed, nothing done.** The worker notes what the company, the library and the
  recent circulars looked like when it last finished, and skips the catch-up while they're
  the same.
- **One ticket per pair.** An edit never opens a second gap for the same circular and policy.
- **Changing `GEMINI_EMBEDDING_MODEL_NAME`** re-embeds every policy and circular
  automatically. Vectors from two different models can't be compared, so the worker tracks
  which model made each one.

---

## 9. The data

Seven tables, all defined in `backend/common/common/models.py`:

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#5eead4", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "attributeBackgroundColorOdd": "#111a2c", "attributeBackgroundColorEven": "#162136"}}}%%
erDiagram
    CIRCULARS ||--o{ GAPS : "can open"
    POLICIES ||--o{ GAPS : "can be out of date in"
    POLICIES ||--o{ CONTROLS : has
    GAPS ||--|{ GAP_EVENTS : "history of"
    CIRCULARS ||--o{ POLICY_CHECKS : "checked in"
    POLICIES ||--o{ POLICY_CHECKS : "checked in"
    COMPANY ||..o{ CIRCULARS : "decides which apply"

    CIRCULARS {
        int id PK
        string source "RBI, SEBI or IRDAI"
        string source_key "stable ID at the source"
        string title
        string pdf_url
        string s3_key "where the PDF is"
        datetime published_at
        string status "new, parsed, analyzed, failed, skipped"
        text text "OCR output"
        text addressed_to "as written in it"
        text summary
        bool applicable "empty = not checked"
        text applies_reason "why it does or doesn't"
        json requirements "list of obligations"
        json embedding "768 numbers"
        text error "why it failed"
    }
    COMPANY {
        int id PK "always 1: one row"
        text profile "your description"
        datetime updated_at
    }
    POLICIES {
        int id PK
        string code UK "e.g. POL-KYC"
        string title
        string owner "gets the gap tickets"
        json regulators "e.g. RBI, SEBI"
        text text "current wording"
        int version "+1 on every text change"
        json embeddings "768 numbers per chunk"
        string embedding_model
    }
    POLICY_CHECKS {
        int id PK
        int circular_id FK
        int policy_id FK
        int policy_version
        float similarity
        bool impacted "true = a gap was opened"
    }
    CONTROLS {
        int id PK
        string code UK "e.g. CTL-KYC-01"
        int policy_id FK
        string description
        string owner
        string frequency
    }
    GAPS {
        int id PK
        int circular_id FK
        int policy_id FK
        int policy_version
        string title
        text impact "what is missing"
        text draft_change "proposed wording"
        json affected_controls
        string severity "low, medium, high"
        string owner
        string status "open, in_progress, closed, dismissed"
        date due_date
        datetime closed_at
    }
    GAP_EVENTS {
        int id PK
        int gap_id FK
        datetime at
        string actor "agent, system or a person"
        string action "opened, status, owner, due_date, comment, policy_updated"
        text note
    }
```

Rules the database enforces:

- A circular is unique by `(source, source_key)`, so the watcher can't save it twice.
- A gap is unique by `(circular_id, policy_id)`: one ticket per circular and policy.
- A check is unique by `(circular_id, policy_id, policy_version)`: Gemini judges each pair
  once per version of the policy.
- `gap_events` rows are only ever added, never edited or deleted. That's the audit trail.

Tables are created at startup by every service (`init_db`), and a column added to a model
later is added to the existing table (nothing is ever dropped). A Postgres advisory lock
stops two services that start together from both changing the schema.

---

## 10. Tracking a gap until it's closed

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "transitionColor": "#8b9bb4", "transitionLabelColor": "#e2e8f0", "stateLabelColor": "#e6edf7", "labelBackgroundColor": "#0f172a", "specialStateColor": "#a7ef6f", "innerEndBackground": "#a7ef6f", "stateBkg": "#16213a", "stateBorder": "#475a7a"}}}%%
stateDiagram-v2
    [*] --> open: agent opens it
    open --> in_progress: someone starts on it
    in_progress --> open
    open --> closed: fixed (note required)
    in_progress --> closed: fixed (note required)
    open --> dismissed: not needed (note required)
    in_progress --> dismissed: not needed (note required)
    closed --> open: reopened
    dismissed --> open: reopened

    classDef open fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef progress fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef done fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef quiet fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class open open
    class in_progress progress
    class closed done
    class dismissed quiet
```

- **Every change is an event.** Changing the status, owner or due date, or adding a comment,
  adds a `gap_events` row recording who did it (the name you enter under "Signed in as"),
  when, and why.
- **Closing or dismissing needs a note.** The API refuses without one, so the history always
  says why a gap ended.
- **Editing the policy is noted on its gaps.** When a policy's text changes, each of its open
  gaps gets a `policy_updated` event ("POL-KYC updated to v2"). The owner can then close the
  gap against the new version, and the console shows "found in v1, now v2".
- **Overdue** means open or in progress with a due date before today. The overview counts
  these, and the Gaps page can filter to them.

An example history, as the console shows it, for gap #1 (update POL-KYC for an RBI circular):

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "cScale0": "#16213a", "cScale1": "#0e2a2c", "cScale2": "#2a1640", "cScale3": "#2a2410", "cScale4": "#0b2a1c", "cScale5": "#2e0f17", "cScaleLabel0": "#e6edf7", "cScaleLabel1": "#e6edf7", "cScaleLabel2": "#e6edf7", "cScaleLabel3": "#e6edf7", "cScaleLabel4": "#e6edf7", "cScaleLabel5": "#e6edf7", "cScaleInv0": "#8b9bb4", "cScaleInv1": "#8b9bb4", "cScaleInv2": "#8b9bb4", "cScaleInv3": "#8b9bb4", "cScaleInv4": "#8b9bb4", "cScaleInv5": "#8b9bb4"}}}%%
timeline
    Day 0 : agent opened the gap : "Reporting to FIU-IND is missing"
    Day 1 : priya changed the status : open → in progress, "drafting clause 2A"
    Day 3 : cco commented : "board meets on the 10th"
    Day 10 : system updated the policy : POL-KYC updated to v2
    Day 10 : priya changed the status : in progress → closed, "v2 approved by the board"
```

---

## 11. The API and the console

The console is plain HTML and JavaScript. It talks to the API through nginx, so the browser
only ever sees one address.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    participant B as Browser
    participant N as nginx (frontend :8080)
    participant A as api (FastAPI)
    participant DB as Postgres

    rect rgb(13, 20, 36)
        B->>N: GET /api/gaps?status=open
        N->>A: GET /gaps?status=open (the /api prefix removed)
        A->>DB: SELECT gaps
        DB-->>A: rows
        A-->>N: JSON
        N-->>B: JSON, drawn as the gaps list
    end
```

| Area | Endpoints |
|---|---|
| Health and counts | `GET /health` · `GET /stats` |
| Company | `GET /company` · `PUT /company` (a change sends analysed circulars back to be judged again) |
| Circulars | `GET /circulars` · `GET /circulars/{id}` (with its gaps and the policies it was checked against) · `GET /circulars/{id}/text` · `POST /circulars/{id}/reprocess` |
| Policies | `GET /policies` · `POST /policies` · `GET /policies/{id}` · `PUT /policies/{id}` · `POST /policies/{id}/controls` |
| Gaps | `GET /gaps` (filter by status, owner, policy, overdue) · `GET /gaps/{id}` (with its circular, policy and history) · `PATCH /gaps/{id}` · `POST /gaps/{id}/comments` |

The API never calls Gemini or OCR. It only reads and writes Postgres. Anything that needs
the agent, like reprocessing a circular or checking a new policy, works by changing the
data (a status, or a cleared embedding), which the worker notices on its next round.

Lists never read the heavy columns (the OCR text, the embeddings) from the database, since
the console never shows them; the OCR text has its own endpoint.

The interactive API docs are at http://localhost:8000/docs.

---

## 12. When things go wrong

> 🛡️ **The worker never loses work.** The question it asks about every error is: is the
> circular to blame, or the service?

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    err["An error while processing a circular"] --> down{"Service down or rate-limited?<br/>(can't connect, Gemini 429)"}
    down -->|yes| wait["Stop this round.<br/>Try again in 60 s, for as long as it takes.<br/>The circular keeps its status"]
    down -->|no| crash{"Service hiccup?<br/>(5xx, timeout, dropped connection,<br/>a reply not in the asked-for JSON)"}
    crash -->|yes| count{"Third time for<br/>this circular?"}
    count -->|no| retry["Stop this round.<br/>Retry the circular in 60 s"]
    count -->|yes| failed
    crash -->|"no (e.g. a 400)"| failed["Mark it failed,<br/>with the error saved.<br/>Move on to the next circular"]

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class err,failed bad
    class down,crash,count ask
    class wait,retry muted
```

| What happened | What you see | What to do |
|---|---|---|
| The OCR model is still loading (first start downloads 6.7 GB) | the worker logs "OCR or Gemini unavailable; retrying in 60s" | nothing: it carries on by itself |
| Gemini's quota ran out (429) | the same message | wait, or raise your quota |
| Gemini or OCR returned a 5xx a few times | the circular shows `failed`, with the error | **Reprocess** it in the console |
| A wrong API key or model name | the worker stops at startup: "Gemini rejected the configuration" | fix `.env`, then restart the worker |
| A PDF link is broken | the watcher logs "failed" for that one | nothing: it's tried again next round |

LangChain first retries Gemini's rate limits and server errors itself (3 times). Only after
that does the worker's own retry take over. LangChain wraps Gemini's errors in its own
classes, so the worker reads the HTTP code from the original error underneath
(`gemini_status` in `backend/worker/failures.py`, which holds all these rules).

Checking new policies against recent circulars follows the same rules. An error there that
isn't a service problem is logged, and that circular is left alone until the worker restarts,
so the worker keeps processing everything else instead of stopping.

---

## 13. Where settings come from

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart LR
    env[".env beside<br/>docker-compose.yml"] --> compose["docker compose"]
    shell["your shell<br/>(e.g. a direnv .envrc)"] --> compose
    compose -->|"container<br/>environment"| cfg["each service's config.py<br/>(pydantic-settings)"]
    local[".env beside a service's main.py<br/>(when run with uv run)"] --> cfg
    defaults["defaults written<br/>in config.py"] --> cfg
    cfg --> code["the rest of the code<br/>(never reads os.environ)"]

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    class compose,cfg svc
    class code ok
```

- 🔑 Only **`GEMINI_API_KEY`** is required.
- Nothing about **your company** is a setting. The company description and the policies are
  data, entered in the console, so the agent never assumes a company you didn't describe. Every other setting has a default in the service's
  `config.py`.
- Compose passes settings you haven't set as empty strings, and `config.py` ignores empty
  values (`env_ignore_empty`), so the default in `config.py` always applies.
- **`S3_ENDPOINT_URL` is fixed in `docker-compose.yml`** on purpose. Your shell may say
  `localhost:4566`, which is right on the host but would point a container at itself.

Settings you're most likely to change:

| Setting | Default | What it changes |
|---|---|---|
| `GEMINI_MODEL_NAME` | `gemini-3.5-flash` | the model that answers the three questions |
| `GEMINI_EMBEDDING_MODEL_NAME` | `gemini-embedding-001` | the model used for policy matching (changing it re-embeds every policy and circular) |
| `LOOKBACK_DAYS` | 30 | older circulars are skipped; new policies are checked against this window |
| `MATCH_TOP_K` | 3 | how many policies Gemini checks per circular |
| `OCR_MAX_PAGES` | 20 | how many pages of each PDF are read |
| `WATCH_INTERVAL_MINUTES` | 60 | how often the regulator sites are checked |

`.env.example` in the repo root lists every setting.

---

## 14. The code, file by file

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TB
    subgraph common["backend/common (shared)"]
        models["models.py<br/>the 7 tables"]
        dbpy["db.py<br/>make_engine, init_db"]
    end
    subgraph watcher["backend/watcher"]
        wmain["main.py<br/>the hourly loop"] --> sources["sources.py<br/>RBI, SEBI, IRDAI"]
        wmain --> fetch["fetch.py<br/>polite HTTP"]
        wmain --> wstore["storage.py<br/>PDF to S3"]
    end
    subgraph worker["backend/worker"]
        kmain["main.py<br/>the loop"] --> pipeline["pipeline.py<br/>parse, analyze, match,<br/>embed_policies, check_recent"]
        kmain --> failures["failures.py<br/>wait, retry or give up"]
        pipeline --> ocrpy["ocr.py<br/>PDF to text"]
        pipeline --> llm["llm.py<br/>the Gemini prompts"]
        pipeline --> kstore["storage.py<br/>PDF from S3"]
    end
    subgraph api["backend/api"]
        amain["main.py<br/>app, /health, /stats"] --> routes["routes/<br/>circulars, policies, gaps"]
        amain --> database["database.py<br/>session per request"]
    end
    wmain -.-> models
    kmain -.-> models
    routes -.-> models
    class models,dbpy data
    class wmain,kmain,amain svc

    classDef svc fill:#0e2a2c,stroke:#2dd4bf,color:#ccfbf1
    classDef data fill:#1c1a47,stroke:#818cf8,color:#e0e7ff
    classDef ext fill:#2a1640,stroke:#c084fc,color:#f3e8ff
    classDef gpu fill:#2d1b0c,stroke:#fb923c,color:#ffedd5
    classDef ask fill:#2a2410,stroke:#fbbf24,color:#fef3c7
    classDef ok fill:#0b2a1c,stroke:#34d399,color:#d1fae5
    classDef bad fill:#2e0f17,stroke:#fb7185,color:#ffe4e6
    classDef start fill:#1c2a0e,stroke:#a7ef6f,color:#ecfccb
    classDef muted fill:#1a2130,stroke:#64748b,color:#cbd5e1
    style common fill:#14123a,stroke:#818cf8
    style watcher fill:#0c1a24,stroke:#2dd4bf
    style worker fill:#0c1a24,stroke:#2dd4bf
    style api fill:#0c1a24,stroke:#2dd4bf
```

| Want to change… | Look in |
|---|---|
| which sites are watched, or how they're scraped | `backend/watcher/sources.py` |
| what Gemini is asked, or the shape of its answers | `backend/worker/llm.py` (the prompts and Pydantic models sit side by side) |
| the order of the steps, how policies are picked, the due dates | `backend/worker/pipeline.py` |
| what's retried and what's marked failed | `backend/worker/failures.py` (the rules) and `main.py` (the loop) |
| how PDFs are turned into images, or how OCR output is cleaned | `backend/worker/ocr.py` |
| the vLLM flags for the OCR model | `backend/ocr/Dockerfile` |
| an endpoint | `backend/api/routes/` (`company.py`, `circulars.py`, `policies.py`, `gaps.py`) |
| a table or a column | `backend/common/common/models.py` (then rebuild all three services) |
| the console | `frontend/js/views/` (one module per page) and `frontend/css/` (see `frontend/README.md`) |

---

## 15. How do I…?

**…start everything?**

```bash
cp .env.example .env                 # set GEMINI_API_KEY
docker compose up -d --build
docker compose logs -f worker        # watch the agent think
```

Then open http://localhost:8080.

**…tell the agent who my company is?** In the console, open **Company** and write a few
sentences. Say what kind of entity it is, list every licence and business with its regulator,
and say what it's *not* when that's easy to confuse ("not a small finance bank"). Within a
few minutes every analysed circular has been judged against it, each with a one-sentence
reason.

**…load my company's policies?** In the console, go to **Policies**, then **Import JSON**
(the file format is shown on that page and in `frontend/README.md`), or add them one at a
time with **New policy**. Within a minute the worker embeds them and checks them against the
last 30 days of circulars.

**…see why a circular has no gaps?** Open it in the console:

- **"Not checked for us"**: nobody has described the company yet. Do that on the
  **Company** page.
- **"Not for us"**: Gemini decided it's addressed to other kinds of entity. The reason is
  shown beside it. If it's wrong, make your company description more precise.
- **No obligations**: it's informational, so there's nothing to check.
- **"No policy in the library was found out of date"**: the closest policies already comply,
  or you don't have a policy on that subject yet.

**…run a circular through the agent again?** Press **Reprocess** on the circular, or
`curl -X POST localhost:8000/circulars/<id>/reprocess`. Gemini reads the saved OCR text
again (no new OCR), judges it and re-checks the policies it had found up to date. Gaps
already opened are kept and never duplicated.

**…find out why a new policy has no gap?** Follow the chart in
[Why doesn't my new policy have a gap?](#why-doesnt-my-new-policy-have-a-gap). Most often
Gemini checked it and found it already up to date, which the circular's page shows.

**…see which policies a circular was checked against?** Its page in the console has a
**Checked against your policies** list: each policy, its similarity, and Gemini's verdict.

**…see what Gemini decided, step by step?**

```bash
docker compose logs worker | grep pipeline
# #98 vs POL-KYC v1 (similarity 0.74): GAP
# #98 analyzed: addressed to 'All Commercial Banks', applies to us: True, gaps opened: ['POL-KYC']
```

**…look at the raw data?**

```bash
curl localhost:8000/stats
curl localhost:8000/circulars/98 | python3 -m json.tool
curl localhost:8000/circulars/98/text            # the OCR output
docker compose exec postgres psql -U rci -d rci -c "select id, status, applicable from circulars order by id desc limit 10"
```

**…run one service on my machine instead of in Docker?**

```bash
docker compose up -d postgres ocr    # what it depends on
cd backend/worker && cp .env.example .env && uv sync
uv run python main.py --once         # one pass through the queue, then exit
```

---

## 16. Glossary

| Term | Meaning |
|---|---|
| **Circular** | A notice from a regulator (RBI, SEBI or IRDAI) that creates or changes rules |
| **Policy** | One of the company's own documents, e.g. its KYC policy. It has an owner, the regulators it answers to, and a version |
| **Control** | A regular check that puts a policy into practice, e.g. "screen customers against sanctions lists daily" |
| **Gap** | A ticket saying "this policy is out of date because of this circular", with a draft of the fix |
| **Gap event** | One line of a gap's history: opened, status changed, reassigned, commented, policy updated |
| **Company description** | A few sentences you write on the console's Company page saying what kind of entity the company is. There's no default |
| **Applicable** | Whether a circular applies to the company you described. Empty means "not checked", because no description exists yet |
| **Requirements** | The concrete obligations Gemini found in a circular |
| **OCR** | Optical character recognition: reading text from an image of a page |
| **Embedding** | A list of numbers that represents a text's meaning, so similar texts can be found by arithmetic |
| **Structured output** | Asking the model for JSON that matches a schema (a Pydantic model), instead of free text |
| **Lookback** | The window (`LOOKBACK_DAYS`, 30) of recent circulars the agent cares about |
