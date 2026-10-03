/** The watcher in detail: one round over RBI, SEBI and IRDAI with circular 98 (its real
 * links and fingerprint), then each way a round can go wrong. */
import { geometry, node } from "./player.js";

const IDLE_FETCH = "1.5 s pause · 3 tries";

const nodes = {
  rss: node(136, 105, 210, 62, "ext", "RBI · RSS feed", "notifications_rss.xml", { mono: true }),
  sebi: node(136, 195, 210, 62, "ext", "SEBI · listing pages", "circulars · master · regulations"),
  irdai: node(136, 285, 210, 62, "ext", "IRDAI · circulars table", "irdai.gov.in/circulars", { mono: true }),
  page: node(136, 410, 210, 62, "ext", "the circular's page", "NotificationUser.aspx?Id=…", { mono: true }),
  pdfsite: node(136, 510, 210, 62, "ext", "the PDF", "rbidocs.rbi.org.in", { mono: true }),

  loop: node(410, 95, 180, 62, "start", "main loop", "a round every 60 min"),
  fetch: node(410, 330, 180, 74, "svc", "fetch.py", IDLE_FETCH, { idle: IDLE_FETCH }),
  fail: node(410, 520, 180, 62, "bad", "on a failure", "delete it · next round"),
  parse: node(660, 95, 200, 62, "svc", "sources.py", "the list → items"),
  known: node(660, 195, 200, 62, "ask", "seen it before?", "skip ids already saved"),
  resolve: node(660, 300, 200, 62, "svc", "find the PDF link", "resolve_pdf_url()", { mono: true }),
  check: node(660, 405, 200, 62, "ask", "really a PDF?", "first bytes: %PDF"),
  sha: node(660, 510, 200, 62, "svc", "fingerprint, then save", "sha256 of the bytes"),

  pg: node(1000, 95, 280, 62, "data", "Postgres · circulars", "UNIQUE (source, source_key)"),
  keys: node(1000, 195, 280, 62, "queue", "dedupe key", "rci:queued:…", { mono: true }),
  lane: node(1000, 305, 280, 92, "queue", "PDF lane", "rci:tasks:pdf", { slots: 3, mono: true }),
  reader: node(1000, 420, 280, 62, "svc", "reader", "waiting", { idle: "waiting", link: "worker" }),
  s3: node(1000, 525, 280, 62, "data", "S3 · bucket rci", "rbi/<sha256>.pdf", { mono: true }),
};

const { at, line, curve } = geometry(nodes);

const edges = {
  "loop>parse": line(at("loop", "r"), at("parse", "l")),
  "parse>fetch": curve(at("parse", "l", 15), [520, 110], [455, 200], at("fetch", "t", 45)),
  "fetch>rss": curve(at("fetch", "l", -30), [285, 300], [285, 105], at("rss", "r")),
  "fetch>sebi": curve(at("fetch", "l", -15), [290, 315], [290, 195], at("sebi", "r")),
  "fetch>irdai": curve(at("fetch", "l"), [295, 330], [295, 285], at("irdai", "r")),
  "fetch>page": curve(at("fetch", "l", 15), [295, 345], [295, 410], at("page", "r")),
  "fetch>pdfsite": curve(at("fetch", "l", 30), [290, 360], [290, 510], at("pdfsite", "r")),
  "parse>known": line(at("parse", "b"), at("known", "t")),
  "known>pg": curve(at("known", "r"), [815, 195], [815, 95], at("pg", "l")),
  "known>resolve": line(at("known", "b"), at("resolve", "t")),
  "resolve>fetch": line(at("resolve", "l"), at("fetch", "r", -15)),
  "fetch>check": curve(at("fetch", "r", 20), [530, 350], [530, 405], at("check", "l")),
  "check>sha": line(at("check", "b"), at("sha", "t")),
  "sha>s3": curve(at("sha", "r", 12), [810, 522], [810, 525], at("s3", "l")),
  "sha>pg": curve(at("sha", "r", -14), [818, 496], [818, 108], at("pg", "l", 13)),
  "sha>keys": curve(at("sha", "r"), [826, 510], [826, 205], at("keys", "l", 10)),
  "keys>lane": line(at("keys", "b"), at("lane", "t")),
  "lane>reader": line(at("lane", "b"), at("reader", "t")),
  "check>fail": curve(at("check", "l", 14), [530, 419], [470, 440], at("fail", "t", 20)),
  "sha>fail": line(at("sha", "l"), at("fail", "r", -10)),
  "fetch>fail": line(at("fetch", "b"), at("fail", "t", -20)),
};

const PDF_URL = "https://rbidocs.rbi.org.in/rdocs/notification/PDFs/NOTI27024092026B5163644F687458B97DB7E5AF0FF4FDD.PDF";
const SHA = "93c944624b4c6ec1589c782c37c4dce064f4a5a16bffaf52f08cb00661b380d5";

const steps = [
  {
    story: 0, dur: 4600, focus: ["loop"],
    title: "Time for a round",
    text: "Every 60 minutes (WATCH_INTERVAL_MINUTES) the main loop runs one round: RBI first, then SEBI, then IRDAI, one regulator at a time.",
    code: "main() · watcher/main.py",
    moves: [["RBI", "loop>parse", 0.2, 0.75, "start"]],
    marks: [[0.12, { sub: { loop: "round: RBI" } }]],
  },
  {
    story: 0, dur: 6200, focus: ["parse", "fetch", "rss"],
    title: "Read RBI's list",
    text: "rbi() asks fetch.py for RBI's RSS feed. Every request waits 1.5 s first and sends a browser User-Agent, or rbidocs answers with a bot page.",
    code: "rbi(), rss_items() · watcher/sources.py · get() · watcher/fetch.py",
    moves: [
      ["feed URL", "parse>fetch", 0.03, 0.22, "svc"], ["GET", "fetch>rss", 0.36, 0.52, "ext"],
      ["XML", "rss>fetch", 0.56, 0.72, "ext"], ["XML", "fetch>parse", 0.76, 0.95, "svc"],
    ],
    marks: [
      [0.22, { sub: { fetch: "waiting 1.5 s…" } }],
      [0.36, { sub: { fetch: "GET the feed" } }],
      [0.52, { log: ["http", "GET https://www.rbi.org.in/notifications_rss.xml → 200 OK"] }],
      [0.95, { sub: { fetch: IDLE_FETCH } }],
    ],
  },
  {
    story: 0, dur: 5600, focus: ["parse"],
    title: "Turn entries into items",
    text: "feedparser reads the XML. Each entry becomes an item: its title, its date (RBI sends IST without a zone), its link, and a stable id from the link.",
    code: "rss_items(), stable_key(), entry_date() · watcher/sources.py",
    moves: [["10 items", "parse>known", 0.5, 0.9, "svc"]],
    marks: [[0.3, { sub: { parse: "10 items · e.g. id=13713" } }]],
  },
  {
    story: 0, dur: 5600, focus: ["known", "pg"],
    title: "Skip what it already has",
    text: "One query loads the ids already saved for RBI. 9 of the 10 are known and skipped; one is new: id=13713, circular 98 to be.",
    code: "run_source() · watcher/main.py",
    moves: [["SELECT ids", "known>pg", 0.05, 0.36, "data"], ["9 known ids", "pg>known", 0.46, 0.78, "data"]],
    marks: [
      [0.36, { log: ["sql", "SELECT source_key FROM circulars WHERE source = 'RBI'"] }],
      [0.82, { sub: { known: "new: id=13713 · 1 of 10" } }],
    ],
  },
  {
    story: 0, dur: 6600, focus: ["resolve", "fetch", "page"],
    title: "Find the PDF link",
    text: "RBI's link is a web page, not the PDF. resolve_pdf_url() opens the page and takes the first PDF link on it that isn't the Hindi one.",
    code: "resolve_pdf_url() · watcher/sources.py",
    moves: [
      ["id=13713", "known>resolve", 0.02, 0.18, "ask"], ["GET page", "resolve>fetch", 0.2, 0.36, "svc"],
      ["GET", "fetch>page", 0.4, 0.55, "ext"], ["HTML", "page>fetch", 0.58, 0.72, "ext"],
      ["HTML", "fetch>resolve", 0.74, 0.88, "svc"],
    ],
    marks: [
      [0.36, { sub: { fetch: "waiting 1.5 s…" } }],
      [0.55, { log: ["http", "GET https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=13713&Mode=0 → 200 OK"] }],
      [0.72, { sub: { fetch: IDLE_FETCH } }],
      [0.9, { sub: { resolve: "…/NOTI27024092026….PDF" } }],
    ],
  },
  {
    story: 0, dur: 6200, focus: ["fetch", "pdfsite"],
    title: "Download it",
    text: "fetch.py downloads the PDF. On a 429, a 5xx or a dropped connection it waits 2 s, then 4 s, and tries again: 3 tries in all.",
    code: "get(), retryable() · watcher/fetch.py",
    moves: [
      ["GET PDF", "resolve>fetch", 0.03, 0.2, "svc"], ["GET", "fetch>pdfsite", 0.26, 0.42, "ext"],
      ["PDF bytes", "pdfsite>fetch", 0.48, 0.68, "ext"], ["bytes", "fetch>check", 0.72, 0.92, "svc"],
    ],
    marks: [
      [0.2, { sub: { fetch: "waiting 1.5 s…" } }],
      [0.42, { log: ["http", `GET ${PDF_URL} → 200 OK`] }],
      [0.7, { sub: { fetch: IDLE_FETCH } }],
    ],
  },
  {
    story: 0, dur: 5200, focus: ["check"],
    title: "Is it really a PDF?",
    text: "Sites sometimes answer 200 with an HTML error page. The bytes must start with %PDF; anything else fails this circular, and the round goes on.",
    code: "fetch_new() · watcher/main.py",
    moves: [["%PDF ✓", "check>sha", 0.45, 0.85, "ok"]],
    marks: [[0.3, { sub: { check: "✓ starts with %PDF" } }]],
  },
  {
    story: 0, dur: 5000, focus: ["sha"],
    title: "Fingerprint it",
    text: "The sha256 of the bytes becomes the file's name. The same PDF always gets the same fingerprint: that's how the reader spots a twin later.",
    code: "fetch_new() · watcher/main.py",
    moves: [],
    marks: [[0.35, { sub: { sha: "93c94462…00661b380d5" } }]],
  },
  {
    story: 0, dur: 5200, focus: ["sha", "s3"],
    title: "Store the PDF in S3",
    text: "put_pdf() writes it to the bucket rci as rbi/<sha256>.pdf, typed application/pdf. Floci on your machine; real S3 in the cloud.",
    code: "put_pdf() · watcher/storage.py",
    moves: [["PDF", "sha>s3", 0.1, 0.6, "data"]],
    marks: [[0.6, { sub: { s3: "rbi/93c94462…b380d5.pdf" }, log: ["s3", `PUT s3://rci/rbi/${SHA}.pdf (application/pdf)`] }]],
  },
  {
    story: 0, dur: 6200, focus: ["sha", "pg"],
    title: "Save the row",
    text: "INSERT INTO circulars: source, id, title, both links, date, sha256, S3 key, status new; then COMMIT. UNIQUE (source, source_key): never saved twice.",
    code: "fetch_new() · watcher/main.py · Circular · common/models.py",
    moves: [["INSERT", "sha>pg", 0.08, 0.6, "data"]],
    marks: [[0.6, {
      sub: { pg: "98 · RBI · id=13713 · new" },
      log: [["sql", "INSERT INTO circulars (source, source_key, title, detail_url, pdf_url, published_at, sha256, s3_key, status) VALUES ('RBI', 'id=13713', 'Designation of terrorist organisation …', …, 'new') → id 98"],
            ["sql", "COMMIT"]],
    }]],
  },
  {
    story: 0, dur: 6600, focus: ["sha", "keys", "lane"],
    title: "Queue the task",
    text: "Only after the COMMIT: enqueue() sets the task's dedupe key (SET … NX, kept a day at most), then XADDs it to the PDF lane.",
    code: "enqueue(), key() · common/queue.py",
    moves: [["SET NX", "sha>keys", 0.05, 0.42, "queue"], ["XADD", "keys>lane", 0.5, 0.85, "queue"]],
    marks: [
      [0.42, { sub: { keys: "circular_id=98:type=circular.read" },
               log: ["redis", "SET rci:queued:circular_id=98:type=circular.read 1 NX EX 86400 → OK"] }],
      [0.85, { slots: { lane: ["read 98"] },
               log: [["redis", "XADD rci:tasks:pdf MAXLEN ~ 100000 * type circular.read circular_id 98 → 1790831159691-0"],
                     ["log", "INFO RBI new: Designation of terrorist organisation under clause (a) of sub-section (1) …"]] }],
    ],
  },
  {
    story: 0, dur: 4800, focus: ["lane", "reader"],
    title: "The reader takes it",
    text: "The reader is waiting on the PDF lane and picks the note up at once. What it does next is in the Worker tab.",
    code: "next_task() · worker/main.py",
    moves: [["read 98", "lane>reader", 0.15, 0.65, "queue"]],
    marks: [[0.15, { slots: { lane: [] } }], [0.65, { sub: { reader: "reading 98" } }]],
  },
  {
    story: 0, dur: 7000, focus: ["loop", "fetch"],
    title: "SEBI and IRDAI, the same way",
    text: "SEBI's three listing pages (circulars, master circulars, regulations) and IRDAI's table are read the same way. Nothing new there this round.",
    code: "sebi(), irdai() · watcher/sources.py",
    moves: [
      ["SEBI", "loop>parse", 0, 0.12, "start"], ["GET ×3", "fetch>sebi", 0.14, 0.32, "ext"],
      ["HTML", "sebi>fetch", 0.34, 0.48, "ext"], ["IRDAI", "loop>parse", 0.5, 0.6, "start"],
      ["GET", "fetch>irdai", 0.62, 0.78, "ext"], ["HTML", "irdai>fetch", 0.8, 0.95, "ext"],
    ],
    marks: [
      [0.02, { sub: { loop: "round: SEBI", known: "skip ids already saved" }, log: ["log", "INFO RBI: seen=10 new=1 failed=0"] }],
      [0.48, { log: ["log", "INFO SEBI: seen=92 new=0 failed=0"] }],
      [0.52, { sub: { loop: "round: IRDAI" } }],
      [0.95, { log: ["log", "INFO IRDAI: seen=20 new=0 failed=0"] }],
    ],
  },
  {
    story: 0, dur: 4600, focus: ["loop"],
    title: "Sleep",
    text: "The round is done, so it sleeps 60 minutes. Only one watcher ever runs: two would both find circular 98 and race to save it.",
    code: "main() · watcher/main.py",
    moves: [],
    marks: [[0.2, { sub: { loop: "sleeping 60 minutes" }, log: ["log", "INFO sleeping 60 minutes"] }]],
  },
  {
    story: 1, dur: 5600, focus: ["check", "fail"],
    title: "Not a PDF",
    text: "IRDAI answers 200 with an HTML error page instead of a PDF. It fails the %PDF check: nothing is saved for it, and the round goes on.",
    code: "fetch_new(), run_source() · watcher/main.py",
    moves: [["HTML", "fetch>check", 0.05, 0.4, "bad"], ["not a PDF", "check>fail", 0.5, 0.85, "bad"]],
    marks: [
      [0.02, { sub: { loop: "round: IRDAI" } }],
      [0.4, { sub: { check: "✗ <!DOCTYPE html> …" } }],
      [0.85, { sub: { fail: "IRDAI: not a PDF" },
               log: ["warn", "WARNING IRDAI failed (https://irdai.gov.in/…/x.pdf/…?download=true): not a PDF: https://irdai.gov.in/…"] }],
    ],
  },
  {
    story: 1, dur: 7000, focus: ["sha", "pg", "keys", "fail"],
    title: "Redis can't take the task",
    text: "The row is saved, but XADD fails: Redis is down. fetch_new() deletes the row again, so next round the circular is unknown and tried again.",
    code: "fetch_new() · watcher/main.py",
    moves: [
      ["INSERT", "sha>pg", 0.03, 0.24, "data"], ["XADD ✗", "sha>keys", 0.3, 0.5, "bad"],
      ["DELETE row", "sha>pg", 0.58, 0.8, "bad"], ["failed", "sha>fail", 0.83, 0.97, "bad"],
    ],
    marks: [
      [0.02, { sub: { check: "✓ starts with %PDF", loop: "round: RBI" } }],
      [0.24, { sub: { pg: "99 · RBI · new" }, log: [["sql", "INSERT INTO circulars (…) VALUES ('RBI', …) → id 99"], ["sql", "COMMIT"]] }],
      [0.5, { log: ["redis", "SET rci:queued:circular_id=99:type=circular.read … → Error 111: Connection refused"] }],
      [0.8, { sub: { pg: "99 · deleted again" }, log: [["sql", "DELETE FROM circulars WHERE id = 99"], ["sql", "COMMIT"]] }],
      [0.97, { sub: { fail: "99: tried again next round" },
               log: ["warn", "WARNING RBI failed (https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=…): Error 111 connecting to redis:6379"] }],
    ],
  },
  {
    story: 1, dur: 7000, focus: ["fetch", "sebi", "fail"],
    title: "A site is down",
    text: "If a regulator's list can't be read after 3 tries (2 s, then 4 s apart), that regulator is skipped this round, and the others go on.",
    code: "get() · watcher/fetch.py · run_source() · watcher/main.py",
    moves: [
      ["GET", "fetch>sebi", 0.03, 0.2, "ext"], ["503", "sebi>fetch", 0.23, 0.38, "bad"],
      ["GET, try 3", "fetch>sebi", 0.46, 0.62, "ext"], ["503", "sebi>fetch", 0.65, 0.78, "bad"],
      ["listing failed", "fetch>fail", 0.81, 0.97, "bad"],
    ],
    marks: [
      [0.02, { sub: { loop: "round: SEBI" } }],
      [0.38, { sub: { fetch: "503: waiting 2 s, then 4 s" } }],
      [0.97, { sub: { fetch: IDLE_FETCH, fail: "SEBI: skipped this round" },
               log: ["error", "ERROR SEBI: listing failed: Server error '503 Service Unavailable' for url 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?…'"] }],
    ],
  },
  {
    story: 1, dur: 5200, focus: ["loop", "known"],
    title: "Next round, it's retried",
    text: "An hour later, everything that failed is still unknown, so it's simply tried again. A circular is saved together with its task, or not at all.",
    code: "run_source() · watcher/main.py",
    moves: [["RBI", "loop>parse", 0.2, 0.6, "start"], ["items", "parse>known", 0.65, 0.95, "svc"]],
    marks: [[0.1, { sub: { loop: "round: RBI", fail: "delete it · next round", known: "99 is unknown: try it" } }]],
  },
];

export default {
  id: "watcher",
  tab: "Watcher",
  hint: "finding new circulars",
  heading: "The watcher, in detail",
  lead: "One round over RBI, SEBI and IRDAI, request by request, with circular 98's real links and fingerprint; then each way a round can go wrong. The log underneath shows what the watcher, Postgres, S3 and Redis see at each step.",
  label: "The watcher: the main loop reads each regulator's list through fetch.py, skips known ids, finds and downloads each new PDF, checks it, fingerprints it, stores it in S3, saves a row in Postgres and queues a task on the PDF lane for the reader.",
  size: [1180, 610],
  groups: [[16, 30, 240, 560, "the regulators' websites"], [286, 30, 520, 560, "the watcher · one container"],
           [836, 30, 328, 560, "where it saves and queues"]],
  nodes,
  edges,
  quietEdges: true,
  stories: ["Story 1 · One round finds circular 98", "Story 2 · When something goes wrong"],
  steps,
};
