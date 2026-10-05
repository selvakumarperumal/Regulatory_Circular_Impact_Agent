# frontend

The compliance desk: a console over the backend's API. It's plain HTML, CSS and JavaScript,
with no build step and no dependencies.

You sign in first. **Sign in** and **Create an account** (a new company and its first user)
are the only pages shown before that; everything after shows only your company's data. The
sidebar shows who you are, your company, and a sign-out button.

Every list is a table, and every gap, circular and policy has its own page. The content is on
the left, and a sidebar holds its properties and actions. Breadcrumbs at the top lead back to the
list, with its filters as you left them.

| Page | What you can do |
|---|---|
| **Overview** | A dashboard: your regulatory exposure (gaps to close, by severity) with the setup steps or headline numbers, KPI cards with 30-day trends, exposure per policy, what's due next and the latest circulars. Every card opens its filtered list |
| **Gaps** | A table you can filter by status, owner or overdue. A gap's page shows what the policy is missing, the proposed wording (with Copy) and the activity, with a comment box. Its sidebar changes the status, owner or due date |
| **Circulars** | A table you can filter by regulator and status, and search by title or addressee. A circular's page shows the summary, what it requires, the gaps it opened and the OCR text. Its sidebar holds the addressee, whether it applies to you and why, the source links, and **Reprocess** |
| **Company** | Its name and description: until you describe it, circulars are summarised but not judged for you. Your **Team** (add a teammate with a first password), and **Your password** |
| **Policies** | Build the library: **New policy** (the text can be loaded from a `.txt` or `.md` file), or **Import JSON** for many at once. Search it, read a policy, edit it (a text change makes a new version), add controls, see its gaps. Each policy shows the worker's progress: **Waiting for the worker** after a save, then **Checked**, updating by itself |
| **How it works** | The system, animated, in five tabs: **Whole system** (every part on one picture, in 7 stories: a new circular end to end, a company signing up and describing itself, a new policy's full process, an edit, working a gap, failures, and Reprocess), the **Watcher** (the 9 steps of `how_the_watcher_works.md`, the three regulators, every failure), the **Worker** (the 18 steps of `backend/worker/INTERNALS.md`, with its example and its tables) the **API** (each hop of a request) and **Redis**, from zero to advanced: what it is, keys and the marks, the other types, streams and the lanes, consumer groups, crashes and claims, the AOF and snapshots, and what lies beyond one server, with this app's keys and Redis's real answers. Each kind of part has its own flowchart shape (a box for our code, a cylinder for a table, a pipe for a Redis lane, a parallelogram for Gemini and outside sites, a chip for the GPU, a hexagon for a check, a flag for a failure), shown in the legend, and each picture is medium-sized (at most 1160 px wide). Notes move along the arrows and each part says what it's doing; under the picture, **The rows now** lights up the rows each step changed, and **Underneath** explains in plain words each thing that happens behind the scenes, with the real log line, SQL or Redis command under it. The newest line is opened up piece by piece: each part of the real line with what it means (`views/how/explain.js` reads Redis commands, SQL, web requests, log lines and calls to Gemini); click any older line to open it, which pauses the animation. Each step names its code and, on the detailed tabs, the guide step it shows. **Full screen** (or F) puts the rows and the log beside the picture. Click the watcher, the reader, a worker or the api to open its tab (`#/how/watcher`, `#/how/worker`, `#/how/api`), and a lane, the marks or the pending lists to open Redis's (`#/how/redis`). Play, pause, step with ← and →, change the speed, or click a step. With reduced motion on, it starts paused and each step shows its end state |

The agent ships knowing nothing about your company. The overview shows a two-step setup (describe
the company, add policies) until both are done. The library starts empty. Saving a policy queues
a task, and a worker checks it straight away against your circulars of the last
`LOOKBACK_DAYS` that apply to you.

Import file format: a list of policies. `text` is either one string or a list of clauses.
`controls` is optional.

```json
[
  {
    "code": "POL-KYC",
    "title": "Know Your Customer and Anti-Money Laundering Policy",
    "owner": "head.kyc@yourbank.com",
    "regulators": ["RBI", "SEBI"],
    "text": ["1. Scope: ...", "2. Customer due diligence: ..."],
    "controls": [
      { "code": "CTL-KYC-01", "description": "Upload new KYC records to CKYCR",
        "owner": "ops.kyc@yourbank.com", "frequency": "daily" }
    ]
  }
]
```

A policy whose code already exists in your library is skipped, so importing the same file
twice is safe.

Every gap change and comment is recorded under your email. The login token is kept in
`localStorage` (`rci.session`) and sent with every API call; when the API says it has ended,
the console signs you out and shows the login page. The dot at the bottom of the sidebar
shows whether the API answers.

## Run it

With the stack: `docker compose up -d frontend`, then open http://localhost:8080. nginx
serves the page and forwards `/api/*` to the api service (see `nginx.conf`), so the browser
only ever talks to one origin. When the api isn't running, nginx answers **502 Bad Gateway**
(on sign-up, for example): see
[When things go wrong](../how_it_works.md#19-when-things-go-wrong).

By hand, against an API on http://localhost:8000:

```bash
cd frontend
python3 -m http.server 5500          # then open http://localhost:5500
```

To use a different API, set `window.__API_URL__` in `config.js`. The Docker image swaps in
`config.docker.js` instead, which sets it to `/api`.

```
index.html            the sidebar, the top bar (breadcrumbs), the page frame
css/
  tokens.css          every colour, radius and font (one dark theme)
  layout.css          sidebar, top bar, list and detail page frames
  components.css      panels, tables, tags, buttons, forms, timeline, toasts
  pages.css           overview charts and setup checklist, sign-in, the company page
js/                   ES modules, loaded by the browser directly
  main.js             registers the routes and starts the app
  lib/                api.js (the API client), html.js (escaping), format.js (dates, due, ...)
  ui/                 icons.js, components.js (tags, panels, tables, ...), feedback.js (toast, tooltip)
  app/                router.js (#/gaps/12 → a page; login and sign-up are the only open pages),
                      session.js (the token, the user and their company),
                      state.js (list filters), status.js (API status, badges)
  views/              auth.js (sign in, sign up), overview.js, gaps.js, circulars.js,
                      policies.js, company.js (with the team and your password)
nginx.conf, Dockerfile   the image: nginx serving the files and forwarding /api
```

To add a page, write a function that renders into `#view` in `js/views/`, and register it
with `route("name/:id", page)` in `main.js` (`{ open: true }` for a page shown signed out).

The fonts are Sora (headings and figures), Plus Jakarta Sans (text) and JetBrains Mono (codes),
from Google Fonts. Without internet the page falls back to system fonts.

The console has one dark theme: near-black navy with a lime-to-mint accent. Each regulator keeps
one colour everywhere (RBI blue, SEBI green, IRDAI orange), severity is one rose hue (lighter is
more severe), and states always show a word beside their colour dot.

Everything from the API is HTML-escaped before it's shown (the
`html` template tag in `js/lib/html.js`), because circular titles come from outside websites.
