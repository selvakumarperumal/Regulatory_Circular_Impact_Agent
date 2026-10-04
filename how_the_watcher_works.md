# How the watcher works

![Python 3.14](https://img.shields.io/badge/Python_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![SQLModel](https://img.shields.io/badge/SQLModel-7E56C2?style=flat-square) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Redis 7](https://img.shields.io/badge/Redis_7-DC382D?style=flat-square&logo=redis&logoColor=white) ![httpx](https://img.shields.io/badge/httpx-1e293b?style=flat-square) ![BeautifulSoup](https://img.shields.io/badge/BeautifulSoup-1e293b?style=flat-square) ![feedparser](https://img.shields.io/badge/feedparser-1e293b?style=flat-square)

The **watcher** is the part of the app that keeps an eye on the regulators' websites. Every
hour it visits RBI, SEBI and IRDAI, notices any circular it hasn't seen before, downloads its
PDF, and hands it over to the workers. It doesn't read the circulars or call Gemini: that's
the worker's job.

This guide follows the watcher through one round, step by step, with a picture for each step
and what changes in the database. The code is in [backend/watcher](backend/watcher). To watch
the same round animated, open **How it works → Watcher** in the console (`#/how/watcher`).

**Reading the diagrams.** Each colour means the same thing in every diagram:

![our services](https://img.shields.io/badge/our_services-2dd4bf?style=flat-square) ![data](https://img.shields.io/badge/data-818cf8?style=flat-square) ![the regulators' websites](https://img.shields.io/badge/the_regulators'_websites-c084fc?style=flat-square) ![a decision](https://img.shields.io/badge/a_decision-fbbf24?style=flat-square) ![done, or OK](https://img.shields.io/badge/done,_or_OK-34d399?style=flat-square) ![a failure](https://img.shields.io/badge/a_failure-fb7185?style=flat-square) ![where it starts](https://img.shields.io/badge/where_it_starts-a7ef6f?style=flat-square) ![the task queue](https://img.shields.io/badge/the_task_queue_in_Redis-38bdf8?style=flat-square)

> 📖 **The other guides.** [how_it_works.md](how_it_works.md) explains the whole app.
> [how_the_worker_works.md](how_the_worker_works.md) picks up where this guide ends: what the
> workers do with each circular the watcher hands over.

**Contents**

1. [The watcher in one minute](#1-the-watcher-in-one-minute)
2. [Words you'll meet](#2-words-youll-meet)
3. [One round, step by step](#3-one-round-step-by-step)
4. [The three regulators, one by one](#4-the-three-regulators-one-by-one)
5. [Being polite to the websites](#5-being-polite-to-the-websites)
6. [When something goes wrong](#6-when-something-goes-wrong)
7. [What happens next](#7-what-happens-next)
8. [Reading its log](#8-reading-its-log)
9. [Running it, and its settings](#9-running-it-and-its-settings)
10. [The code, file by file](#10-the-code-file-by-file)
11. [Common questions](#11-common-questions)

---

## 1. The watcher in one minute

Think of the watcher as the **post room** of an office. Once an hour it goes to the three
regulators' mailboxes, takes out anything new, files a copy, writes it in the register, and
drops a note in the analysts' in-tray saying "there's a new one to read".

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        rbi[/"RBI<br/>website"/] --> W("<b>watcher</b><br/>once an hour")
        sebi[/"SEBI<br/>website"/] --> W
        irdai[/"IRDAI<br/>website"/] --> W
        W -->|"the PDF"| S3[("S3<br/>a copy of every PDF")]
        W -->|"a new row,<br/>status new"| DB[("Postgres<br/>the register")]
        W -->|"a note: read<br/>circular 98"| Q[["Redis<br/>the to-do list"]]
        Q --> K("the workers<br/>read it next")
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
    class rbi,sebi,irdai ext
    class W svc
    class S3,DB data
    class Q queue
    class K svc
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

For every circular it hasn't seen before, the watcher does exactly four things:

| # | It… | Kept in | So that… |
|---|---|---|---|
| 1 | downloads the PDF | **S3** (Floci on your machine) | the workers can read it later, even if the website changes |
| 2 | names the file after its fingerprint (`sha256`) | the file name, `rbi/3f9a….pdf` | the same file is never stored twice |
| 3 | adds a row to the `circulars` table, status **new** | **Postgres** | everyone knows the circular exists, and it's never downloaded again |
| 4 | puts a `circular.read` task on the to-do list | **Redis** | a worker starts reading it straight away |

It runs as **one** copy only, and it never talks to the workers directly: everything goes
through Postgres and Redis.

---

## 2. Words you'll meet

| Word | What it means here |
|---|---|
| **Circular** | A notice from a regulator that creates or changes rules. Each one has a web page and a PDF |
| **Listing** | The page (or RSS feed) where a regulator lists its latest circulars |
| **Round** | One visit to all three regulators. In Docker, one round every 60 minutes |
| **`source`** | Which regulator: `RBI`, `SEBI` or `IRDAI` |
| **`source_key`** | The circular's ID on the regulator's site, e.g. `id=13650` for RBI. With `source`, it identifies a circular: the watcher never saves the same pair twice |
| **Fingerprint (`sha256`)** | A 64-character code computed from the PDF's bytes. The same file always gives the same code; a different file, a different one |
| **S3** | File storage. On your machine it's **Floci**, which pretends to be Amazon S3 |
| **Task** | A short note on the Redis to-do list, like "read circular 98". The workers take them one by one |

---

## 3. One round, step by step

Here's the whole round at a glance. The steps below follow one circular through it: **RBI
circular 98**, "Designation of terrorist organisation…", published this morning.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        s1(["1. Wake up"]) --> s2("2. Get each regulator's<br/>list of circulars")
        s2 --> s3("3. Skip the ones<br/>it already knows")
        s3 --> s4("4. Find the PDF link<br/>of each new one")
        s4 --> s5("5. Download it, and check<br/>it's really a PDF")
        s5 --> s6[("6. Store it in S3,<br/>named by its fingerprint")]
        s6 --> s7[("7. Add a row in Postgres:<br/>status new")]
        s7 --> s8[["8. Put a task on the<br/>to-do list for the workers"]]
        s8 --> s9(["9. Write a summary,<br/>sleep until the next round"])
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
    class s2,s3,s4,s5 svc
    class s6,s7 data
    class s8 queue
    class s9 ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

### Step 1: Wake up

The watcher is a loop. In Docker it does one round, sleeps 60 minutes, and starts again,
forever. Run by hand, it does one round and stops.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The watcher starts"]) --> b("Make sure the database<br/>tables exist")
        b --> c("Do one round:<br/>RBI, then SEBI, then IRDAI")
        c --> d{"INTERVAL_MINUTES<br/>more than 0?"}
        d -->|"yes (Docker: 60)"| e["Sleep that long"]
        e --> c
        d -->|"no (by hand: 0)"| f(["Stop"])
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
    class b,c svc
    class d ask
    class e muted
    class f ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- In Docker the interval comes from `WATCH_INTERVAL_MINUTES` in `.env` (default 60).
- `--only RBI` does just one regulator, which is handy for testing.
- There's no clock time: the first round starts when the container starts, and each next
  round an hour after the previous one ended.

**In the code:** `main()` in `main.py`.

### Step 2: Get each regulator's list of circulars

Each regulator publishes its latest circulars differently, so each has its own small reader
in `sources.py`. All three return the same thing: a list of **items**, each with a title, a
link, a date and an ID.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["For each regulator"]) --> rbi[/"RBI: its RSS feed<br/>(about 10 items)"/]
        a --> sebi[/"SEBI: three listing pages<br/>(about 90 items)"/]
        a --> irdai[/"IRDAI: its circulars table<br/>(about 20 items)"/]
        rbi --> item("The same list for all three:<br/>title, link, date, ID")
        sebi --> item
        irdai --> item
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
    class rbi,sebi,irdai ext
    class item svc
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

For circular 98 the RBI reader produces this item:

| source | source_key | title | detail_url | published_at |
|---|---|---|---|---|
| RBI | `id=13650` | Designation of terrorist organisation… | `https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=13650&Mode=0` | 2026-10-01 09:30 IST |

- If a site is down, or its page has changed so nothing can be found, that regulator is
  skipped for this round (`RBI: listing failed: …` in the log), and the other two still run.
- Section 4 shows how each regulator is read.

**In the code:** `rbi()`, `sebi()` and `irdai()` in `sources.py`.

### Step 3: Skip the ones it already knows

Most of the list is old news. The watcher asks Postgres for every `source_key` it already
has for this regulator, and keeps only the items that aren't there.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["RBI's list:<br/>10 items"]) --> b[("Postgres: the IDs<br/>already saved for RBI")]
        b --> c{"Is this item's<br/>ID there?"}
        c -->|"yes: 9 of them"| d["Skip it"]
        c -->|"no: circular 98"| e(["New: step 4"])
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
    class b data
    class c ask
    class d muted
    class e ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- It's one quick question to the database per regulator, not one per item.
- A circular is known by its **regulator and ID together**, so the same ID at two
  regulators never clashes.
- Nothing about dates is checked here. An old circular the watcher has never seen (on its
  very first round, say) is saved too; the worker later marks it **skipped** without reading
  it ([section 7](#7-what-happens-next)).

**In the code:** `run_source()` in `main.py`.

### Step 4: Find the PDF link

The item's link usually points to a web page about the circular, not to the PDF itself. The
watcher opens that page and looks for the PDF.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The item's link"]) --> b{"Does it already<br/>end in .pdf?"}
        b -->|"yes (IRDAI)"| c(["That's the PDF"])
        b -->|"no (RBI, SEBI)"| d("Open the page and list<br/>every .pdf link on it")
        d --> e{"Any found?"}
        e -->|"no"| h>"Error: no PDF link.<br/>Tried again next round"]
        e -->|"yes"| f("Unwrap viewer links,<br/>skip Hindi versions")
        f --> g(["The first English PDF"])
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
    class b,e ask
    class c,g ok
    class d,f svc
    class h bad
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- Some links wrap the PDF in a viewer, like `…/web/?file=https://site/doc.pdf`; the real
  address after `=` is taken.
- Regulators often publish a Hindi and an English PDF. The watcher prefers the English one;
  if there's only a Hindi one, it takes that.

For circular 98: `https://rbidocs.rbi.org.in/rdocs/notification/PDFs/NT98DESIGNATION.PDF`.

**In the code:** `resolve_pdf_url()` in `sources.py`.

### Step 5: Download it, and check it's really a PDF

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The PDF link"]) --> b("Download it<br/>(politely: section 5)")
        b --> c{"Do the first bytes<br/>say %PDF?"}
        c -->|"no: an error page<br/>dressed up as a file"| d>"Error: not a PDF.<br/>Tried again next round"]
        c -->|"yes"| e(["A real PDF: step 6"])
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
    class b svc
    class c ask
    class d bad
    class e ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

Some sites answer "200 OK" with an HTML error page instead of the file. Every real PDF starts
with the characters `%PDF`, so the watcher checks that before keeping anything.

**In the code:** `fetch_new()` in `main.py`, `get()` in `fetch.py`.

### Step 6: Store it in S3, named by its fingerprint

The watcher computes the PDF's **fingerprint** (its `sha256`) and stores the file in S3
under that name, in a folder per regulator.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The PDF's bytes"]) --> b("Compute its fingerprint:<br/>3f9a…c1 (64 characters)")
        b --> c[("File name:<br/>rbi/3f9a…c1.pdf")]
        c --> d[("S3 bucket rci")]
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
    class b svc
    class c,d data
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- The same file always gets the same name, so it's never stored twice.
- The fingerprint is also saved on the circular. The worker uses it to spot two circulars
  with the identical PDF, and reads that PDF only once.
- If S3 can't be reached (Floci isn't running), the watcher stops here for this circular:
  nothing is saved, and the next round tries again.

**S3 after:**

| Bucket | Key | Type |
|---|---|---|
| rci | **rbi/3f9a…c1.pdf** | application/pdf |

**In the code:** `fetch_new()` in `main.py`, `put_pdf()` in `storage.py`.

### Step 7: Add a row in Postgres

Only once the PDF is safely in S3 does the watcher add the circular to the database.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["The PDF is in S3"]) --> b[("INSERT a circulars row,<br/>status new")]
        b --> c(["Saved: from now on<br/>it's a known circular"])
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
    class b data
    class c ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

**Database after** (`circulars`):

| id | source | source_key | title | sha256 | s3_key | status |
|---|---|---|---|---|---|---|
| **98** | **RBI** | **id=13650** | **Designation of terrorist organisation…** | **3f9a…c1** | **rbi/3f9a…c1.pdf** | **new** |

The row also keeps the page link, the PDF link and the publication date. The text, the
summary and everything else stay empty: the workers fill them in.

> ✅ **Nothing half-saved.** The order is the PDF, then the row, then the task (step 8). If
> the task can't be queued, the row is deleted again. So a circular in the database always
> has its PDF and its task; if anything fails, nothing is kept, and the next round simply
> tries again.

**In the code:** `fetch_new()` in `main.py`.

### Step 8: Put a task on the to-do list

Last, the watcher puts a note on the Redis to-do list: **read circular 98**. A free worker
picks it up within moments.

```mermaid
%%{init: {"theme": "base", "sequence": {"diagramMarginX": 0, "diagramMarginY": 0}, "themeVariables": {"darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "actorBkg": "#16213a", "actorBorder": "#5eead4", "actorTextColor": "#e6edf7", "actorLineColor": "#3b4a66", "signalColor": "#8b9bb4", "signalTextColor": "#e2e8f0", "noteBkgColor": "#2a2410", "noteBorderColor": "#fbbf24", "noteTextColor": "#fde68a", "labelBoxBkgColor": "#1e293b", "labelBoxBorderColor": "#64748b", "labelTextColor": "#e2e8f0", "loopTextColor": "#c4b5fd", "sequenceNumberColor": "#0b1020", "activationBkgColor": "#1e293b"}}}%%
sequenceDiagram
    box rgb(11, 16, 32)
        participant W as watcher
        participant R as Redis (the to-do list)
        participant K as a worker
    end

    rect rgb(13, 20, 36)
        W->>R: is "read circular 98" already on the list?
        R-->>W: no: add it (and remember it's there)
        W->>R: the task: circular.read, circular 98
        R-->>K: the task, at once
        Note right of K: OCR, Gemini, gaps
    end
```

- Redis remembers each task while it's on the list, so the same task is never added twice
  (for example, if someone presses **Reprocess** on it twice).
- **The task list is the workers' only source of work**: they never look in Postgres for new
  circulars. So if Redis can't take the task, the watcher deletes the row it just saved and
  counts the circular as failed. Nothing about it is kept, and the next round tries it again,
  from the download.

**In the code:** `enqueue()` in `backend/common/common/queue.py`.

### Step 9: Write a summary, sleep until the next round

After each regulator, the watcher writes one summary line. After all three, it sleeps.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["RBI, SEBI and<br/>IRDAI are done"]) --> b("One line per regulator:<br/>seen, new, failed")
        b --> c["Sleep 60 minutes"]
        c --> d(["Next round: step 1"])
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
    class b svc
    class c muted
    class d ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

```text
INFO RBI new: Designation of terrorist organisation…
INFO RBI: seen=10 new=1 failed=0
INFO SEBI: seen=92 new=0 failed=0
INFO IRDAI: seen=20 new=0 failed=0
INFO sleeping 60 minutes
```

---

## 4. The three regulators, one by one

### RBI: the notifications RSS feed

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a[/"rbi.org.in/notifications_rss.xml"/] --> b("Read each entry<br/>(feedparser)")
        b --> c("Fix the title: RBI escapes<br/>special characters twice")
        c --> d("Fix the date: RBI sends<br/>Thu, 24 Sep 2026 17:15:00<br/>with no time zone (it's IST)")
        d --> e(["Item: ID from ?Id=13650<br/>in the link"])
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
    class a ext
    class b,c,d svc
    class e ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- The feed holds the latest notifications, about 10 at a time.
- The entry's link is the circular's web page; the PDF link is found on it (step 4).
- RBI's PDF server shows a "bot check" page to programs, so the watcher identifies itself as
  a normal web browser (section 5).

### SEBI: three listing pages

SEBI's RSS feed holds only its latest 30 items, mostly orders, so it misses circulars. The
watcher reads SEBI's listing pages instead.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        p1[/"Circulars<br/>(latest 25)"/] --> rows("Each table row with a<br/>/legal/… link")
        p2[/"Master circulars<br/>(latest 25)"/] --> rows
        p3[/"Regulations<br/>(latest 25)"/] --> rows
        rows --> date("The date: Sep 09, 2026 in the<br/>first cell, or Last amended on …<br/>in a regulation's title")
        date --> e(["Item: ID is the<br/>link's path"])
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
    class p1,p2,p3 ext
    class rows,date svc
    class e ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- A regulation's first cell only has a year, so the date comes from "[Last amended on July
  7, 2026]" in its title.
- The PDF link is found on the circular's page (step 4).

### IRDAI: the circulars table

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a[/"irdai.gov.in/circulars"/] --> b("Each table row with a<br/>document-detail link<br/>and a PDF link")
        b --> c("Title: the Short Description<br/>column. Date: the first<br/>dd-mm-yyyy in the row")
        c --> d(["Item: ID from ?documentId=…,<br/>link = the English PDF itself"])
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
    class a ext
    class b,c svc
    class d ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

- Each row already links its PDF, so step 4 has nothing to look up.
- Links elsewhere on the page (site-wide forms and so on) are ignored: only rows with both
  a detail link and a PDF count.

If a reader finds nothing at all, it stops with "page layout may have changed": that's the
sign a regulator has redesigned its site, and `sources.py` needs updating.

---

## 5. Being polite to the websites

Every request goes through one small HTTP client, so the watcher never hammers a regulator's
site.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a(["A request"]) --> b["Wait 1.5 seconds first,<br/>always"]
        b --> c("Send it, as a normal<br/>web browser")
        c --> d{"How did it go?"}
        d -->|"OK"| e(["Done"])
        d -->|"busy (429), server error<br/>(5xx) or network trouble"| t{"Tried 3 times<br/>already?"}
        t -->|"no"| g["Wait 2 s<br/>(then 4 s)"]
        g --> b
        t -->|"yes"| f>"Give up on this one:<br/>tried again next round"]
        d -->|"anything else,<br/>like 404"| f
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
    class b,g muted
    class c svc
    class d,t ask
    class e ok
    class f bad
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| Rule | Why |
|---|---|
| a 1.5-second pause before every request | regulators' sites are public services: no bursts |
| a normal browser's User-Agent | RBI's PDF server shows a bot-check page to anything else |
| up to 3 tries on 429, 5xx and network errors, waiting 2 s then 4 s | a busy moment shouldn't lose a circular |
| a 30-second timeout, and redirects followed | a stuck site can't stall the whole round |

A first round on an empty database downloads well over a hundred PDFs, so it takes a few
minutes. Later rounds usually download nothing, and take well under a minute.

**In the code:** `fetch.py`.

---

## 6. When something goes wrong

The watcher's rule is simple: **a circular is either saved completely, or not at all**. A
failure just means "try again next round".

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        e(["Something failed"]) --> k{"What failed?"}
        k -->|"a whole listing<br/>(site down, page changed)"| r["Skip that regulator<br/>this round"]
        k -->|"one circular<br/>(PDF link, download, S3)"| s["Skip that circular:<br/>nothing was saved"]
        k -->|"the task<br/>(Redis down)"| n["Delete the row again:<br/>nothing is kept"]
        n --> again
        r --> again(["Next round tries again"])
        s --> again
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
    class k ask
    class r,s,n muted
    class again ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| What happened | What you see in the log | What happens next | What to do |
|---|---|---|---|
| A regulator's site is down | `SEBI: listing failed: …` | the next round tries again | nothing |
| The site changed its layout | `… no circular links found; page layout may have changed` | every round fails the same way | update that reader in `sources.py` |
| A circular's page has no PDF link | `RBI failed (…): no PDF link on …` | tried again every round | nothing, unless it lasts; then check the page by hand |
| The download is an HTML page, not a PDF | `… failed (…): not a PDF: …` | tried again next round | nothing |
| Floci (S3) isn't running | `… failed (…): Could not connect to the endpoint URL: "http://host.docker.internal:4566/…"` | nothing is saved; tried again every round | start Floci: `floci start --persist="$HOME/.floci/aws-state"` |
| Redis is down | `RBI failed (…): Error 111 connecting to redis:6379. Connection refused.` | the row is deleted again; tried again every round | start Redis: `docker compose up -d redis` |
| Postgres is down | the watcher restarts until it's back | the next round catches up | `docker compose up -d` |

> 💡 Because a failed circular isn't saved, it stays "new" in the watcher's eyes, so every
> round retries it until it works. Nothing is ever skipped for good.

---

## 7. What happens next

The watcher's job ends with the task. From there the workers take over: OCR reads the PDF,
Gemini summarises it, and each company finds out whether it applies to them.

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        a[("circular 98:<br/>status new")] --> b{"A worker checks: published<br/>in the last 30 days?"}
        b -->|"no"| c["Marked skipped:<br/>no OCR, no Gemini"]
        b -->|"yes"| d[/"OCR reads the PDF,<br/>page by page"\]
        d --> e[/"Gemini summarises it, and<br/>each company checks it"/]
        e --> f(["Gaps for the policy owners"])
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
    class a data
    class b ask
    class c muted
    class d gpu
    class e ext
    class f ok
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

That's why the watcher doesn't filter by date: it records everything it sees, and the worker
decides what's worth reading. On a first round that means many old circulars end up
**skipped**, which costs nothing.

The full story is in [how_the_worker_works.md](how_the_worker_works.md).

---

## 8. Reading its log

```bash
docker compose logs -f watcher
```

| Log line | What it means |
|---|---|
| `RBI new: Designation of terrorist organisation…` | a new circular was saved and its task queued |
| `RBI: seen=10 new=1 failed=0` | RBI's list had 10 items: 1 was new, none failed |
| `RBI failed (https://…): …` | one circular couldn't be saved; the reason follows. It's retried next round |
| `SEBI: listing failed: …` | the whole SEBI list couldn't be read this round |
| `sleeping 60 minutes` | the round is over |

A quiet round looks like this, and is normal:

```text
INFO RBI: seen=10 new=0 failed=0
INFO SEBI: seen=92 new=0 failed=0
INFO IRDAI: seen=20 new=0 failed=0
INFO sleeping 60 minutes
```

---

## 9. Running it, and its settings

In Docker it starts with everything else:

```bash
docker compose up -d watcher
docker compose logs -f watcher
```

To run one round by hand on your machine:

```bash
cd backend/watcher
cp .env.example .env        # points at localhost: Postgres, Redis and Floci
uv sync
uv run python main.py               # one round over all three regulators
uv run python main.py --only RBI    # just RBI
```

| Setting | Default | What it does |
|---|---|---|
| `WATCH_INTERVAL_MINUTES` (in the root `.env`, for Docker) | 60 | minutes between rounds |
| `INTERVAL_MINUTES` (in `backend/watcher/.env`, by hand) | 0 | the same; 0 means one round, then stop |
| `DATABASE_URL` | `postgresql+psycopg://rci:rci@localhost:5432/rci` | the database |
| `REDIS_URL` | `redis://localhost:6379/0` | the to-do list |
| `S3_ENDPOINT_URL` | empty (real AWS); Floci is `http://localhost:4566` | where the PDFs go |
| `S3_BUCKET` | `rci` | the bucket |

> ⚠️ **Run only one watcher.** Docker Compose pins it to one copy. Two would find the same new
> circular at the same moment; the database would refuse the second copy, but both would
> download it.

---

## 10. The code, file by file

```mermaid
%%{init: {"theme": "base", "flowchart": {"diagramPadding": 0, "nodeSpacing": 58, "rankSpacing": 58, "curve": "basis"}, "themeVariables": {"fontSize": "14px", "darkMode": true, "primaryColor": "#16213a", "primaryTextColor": "#e6edf7", "primaryBorderColor": "#475a7a", "lineColor": "#8b9bb4", "secondaryColor": "#1b2436", "tertiaryColor": "#101a2e", "edgeLabelBackground": "#0f172a", "textColor": "#e2e8f0", "clusterBkg": "#0f1728", "clusterBorder": "#2b3a55", "titleColor": "#c4b5fd", "nodeTextColor": "#e6edf7"}}}%%
flowchart TD
    subgraph canvas[" "]
        direction TB
        main("<b>main.py</b><br/>the loop: one round,<br/>then sleep") --> sources[/"<b>sources.py</b><br/>RBI, SEBI, IRDAI readers,<br/>find the PDF link"/]
        main --> storage[("<b>storage.py</b><br/>put the PDF in S3")]
        main --> models[("<b>common/models.py</b><br/>the circulars table")]
        main --> queue[["<b>common/queue.py</b><br/>add a task"]]
        sources --> fetch["<b>fetch.py</b><br/>polite HTTP"]
        main --> fetch
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
    class main svc
    class sources ext
    class fetch muted
    class storage,models data
    class queue queue
    style canvas fill:#0b1020,stroke:#1e293b,color:#0b1020
```

| File | What's in it |
|---|---|
| `main.py` | `main()`: the loop and `--only`; `run_source()`: one regulator's list, skip the known ones; `fetch_new()`: download, check, store, save, queue one circular |
| `sources.py` | `rbi()`, `sebi()`, `irdai()`: each regulator's reader; `resolve_pdf_url()`: find the PDF on a circular's page; the date and ID helpers |
| `fetch.py` | `get()`: the pause, the browser User-Agent, the retries |
| `storage.py` | `put_pdf()`: one file into S3 |
| `config.py` | the settings above |

| Want to change… | Look in |
|---|---|
| add a regulator, or fix one after a site redesign | `sources.py` (add it to `SOURCES`) |
| the pause between requests, or the retries | `fetch.py` (`DELAY`, `retries`) |
| how often it runs | `WATCH_INTERVAL_MINUTES` in `.env` |
| what's saved about a circular | `fetch_new()` in `main.py`, and `common/models.py` |

---

## 11. Common questions

**How soon after a regulator publishes does the app know?** Within an hour (the next round),
then a worker starts on it within seconds.

**Can I make it check now?** Restart it: `docker compose restart watcher`. A round starts at
once.

**Why are so many circulars "Skipped" after the first start?** The first round saves every
circular on the regulators' lists, including old ones. The worker skips those older than 30
days (`LOOKBACK_DAYS`) without reading them, so they cost nothing.

**Does it download the same PDF again every hour?** No. A saved circular is skipped in step
3, before any download. Only a circular that failed is downloaded again, on each round, until
it's saved.

**What if a regulator publishes a correction under a new ID?** It's a new circular to the
watcher, and is saved and read like any other. If the PDF is byte-for-byte the same file, the
worker notices the matching fingerprint and copies the earlier text and summary instead of
reading it again.

**Does it need the GPU, or Gemini?** No. The watcher only needs the internet, Postgres, Redis
and S3.
