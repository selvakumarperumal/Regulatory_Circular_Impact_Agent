/** The whole system, every part and every flow: a new circular from the regulator's site to
 * a gap on the Gaps page; a company signing up and describing itself; a new policy, the
 * full process; editing a policy; working a gap until it's closed; what happens when
 * something goes wrong; and Reprocess. The example is the docs': circular 98, company A (an
 * NBFC with four RBI policies), company B (a stock broker), and a new company C. The
 * watcher, the reader, the workers and the api link to their own detailed scenes. */
import { geometry, node } from "./player.js";

const W = "waiting";
const READER = "e02ff2af94f5-1";
const SHA = "3f9a…c1";

const nodes = {
  // the regulators and the watcher
  reg: node(88, 104, 150, 58, "ext", "regulators", "RBI · SEBI · IRDAI"),
  watcher: node(272, 104, 132, 58, "svc", "watcher", "every 60 min", { link: "watcher" }),
  // Redis's bookkeeping
  marks: node(104, 268, 150, 52, "queue", "marks", "no duplicates"),
  pending: node(292, 268, 168, 52, "queue", "pending lists", "who has what"),
  dead: node(198, 356, 180, 52, "bad", "rci:dead", "tasks given up", { shape: "pipe" }),
  // your team and the console's pages, in the sidebar's order
  team: node(62, 600, 92, 64, "start", "your team", "browser"),
  overview: node(235, 486, 198, 34, "svc", "Overview", "at a glance", { inline: true }),
  gappage: node(235, 532, 198, 34, "svc", "Gaps", "to fix", { inline: true }),
  circpage: node(235, 578, 198, 34, "svc", "Circulars", "the list", { inline: true }),
  polpage: node(235, 624, 198, 34, "svc", "Policies", "your library", { inline: true }),
  compage: node(235, 670, 198, 34, "svc", "Company", "who you are", { inline: true }),
  nginx: node(402, 548, 84, 56, "svc", "nginx", ":8080"),
  api: node(402, 662, 84, 64, "svc", "api", "FastAPI", { link: "api" }),
  // reading circulars, and checking them
  s3: node(575, 50, 196, 38, "data", "S3", "the PDFs", { inline: true }),
  pdf: node(575, 142, 196, 84, "queue", "PDF lane", "rci:tasks:pdf", { slots: 2, mono: true }),
  reader: node(790, 142, 140, 64, "svc", "reader", W, { idle: W, link: "worker" }),
  main: node(600, 522, 240, 84, "queue", "main lane", "rci:tasks", { slots: 3, mono: true }),
  w1: node(800, 470, 136, 60, "svc", "worker 1", W, { idle: W, link: "worker" }),
  w2: node(800, 578, 136, 60, "svc", "worker 2", W, { idle: W, link: "worker" }),
  // what they call, and where everything is kept
  ocr: node(1062, 80, 304, 34, "gpu", "OCR · GPU", "a page at a time", { inline: true }),
  chat: node(1062, 124, 304, 34, "ext", "Gemini chat", "JSON answers", { inline: true }),
  emb: node(1062, 168, 304, 34, "ext", "Gemini embeddings", "768 numbers", { inline: true }),
  companies: node(1062, 276, 304, 34, "data", "companies · users", "A, B", { inline: true }),
  circulars: node(1062, 320, 304, 34, "data", "circulars", "95 read", { inline: true }),
  ocrpages: node(1062, 364, 304, 34, "data", "ocr_pages", "empty", { inline: true }),
  policies: node(1062, 408, 304, 34, "data", "policies · controls", "A: 4 policies", { inline: true }),
  assessments: node(1062, 452, 304, 34, "data", "assessments", "who it applies to", { inline: true }),
  checks: node(1062, 496, 304, 34, "data", "policy_checks", "one verdict each", { inline: true }),
  gaps: node(1062, 540, 304, 34, "gap", "gaps", "none open", { inline: true }),
  events: node(1062, 584, 304, 34, "gap", "gap_events", "each gap's history", { inline: true }),
};

const { at, line, curve } = geometry(nodes);
const X = 886;                                   // the corridor between the middle and the right
/** Right, up or down the corridor, into a table or service on the right. */
const side = (from, to, d = 0) => curve(at(from, "r", d), [X, nodes[from].y + d], [X, nodes[to].y], at(to, "l"));
/** From the api, along the bottom and up the same corridor, into a table. */
const low = (to) => {
  const y = nodes[to].y, [ax, ay] = at("api", "b"), [tx] = at(to, "l");
  return `M${ax},${ay} C${ax},${ay + 22} ${ax + 18},734 ${ax + 40},734 L${X - 16},734 C${X},734 ${X},720 ${X},704 `
    + `L${X},${y + 16} C${X},${y} ${X + 8},${y} ${tx},${y}`;
};
const PAGES = ["overview", "gappage", "circpage", "polpage", "compage"];
const page = (p) => [`team>${p}`, curve(at("team", "r"), [122, 600], [122, nodes[p].y], at(p, "l"))];
const toNginx = (p) => [`${p}>nginx`, curve(at(p, "r"), [348, nodes[p].y], [348, 548], at("nginx", "l"))];
const cy = nodes.circulars.y;

const edges = {
  "reg>watcher": line(at("reg", "r"), at("watcher", "l")),
  "watcher>s3": curve(at("watcher", "r", -12), [390, 92], [430, 50], at("s3", "l")),
  "watcher>pdf": curve(at("watcher", "r", 12), [390, 116], [430, 142], at("pdf", "l")),
  "watcher>marks": curve(at("watcher", "b", -30), [242, 196], [104, 206], at("marks", "t")),
  "watcher>circulars": `M${at("watcher", "t")} C272,44 290,14 320,14 L${X - 16},14 C${X},14 ${X},28 ${X},44 `
    + `L${X},${cy - 16} C${X},${cy} ${X + 8},${cy} ${at("circulars", "l")}`,
  "s3>reader": curve(at("s3", "r"), [720, 50], [752, 80], at("reader", "t", -20)),
  "pdf>reader": line(at("pdf", "r"), at("reader", "l")),
  "reader>ocr": side("reader", "ocr", -20),
  "reader>chat": side("reader", "chat", -10),
  "reader>emb": side("reader", "emb", 0),
  "reader>circulars": side("reader", "circulars", 10),
  "reader>ocrpages": side("reader", "ocrpages", 18),
  "reader>assessments": side("reader", "assessments", 26),
  "reader>main": curve(at("reader", "b", -10), [770, 310], [660, 410], at("main", "t", 50)),
  "reader>pending": curve(at("reader", "b", -40), [740, 250], [470, 268], at("pending", "r")),
  "reader>dead": curve(at("reader", "b", -55), [730, 330], [480, 356], at("dead", "r")),
  "main>w1": curve(at("main", "r", -12), [726, 510], [722, 470], at("w1", "l")),
  "main>w2": curve(at("main", "r", 12), [726, 534], [722, 578], at("w2", "l")),
  "w1>chat": side("w1", "chat", -10), "w2>chat": side("w2", "chat", -10),
  "w1>emb": side("w1", "emb", -4), "w2>emb": side("w2", "emb", -4),
  "w1>companies": side("w1", "companies", 2), "w2>companies": side("w2", "companies", 2),
  "w1>policies": side("w1", "policies", 6), "w2>policies": side("w2", "policies", 6),
  "w1>assessments": side("w1", "assessments", 10), "w2>assessments": side("w2", "assessments", 10),
  "w1>checks": side("w1", "checks", 14), "w2>checks": side("w2", "checks", 14),
  "w1>gaps": side("w1", "gaps", 18), "w1>events": side("w1", "events", 22),
  "w1>pending": curve(at("w1", "t", -30), [770, 370], [490, 320], at("pending", "r", 14)),
  ...Object.fromEntries(PAGES.flatMap((p) => [page(p), toNginx(p)])),
  "nginx>api": line(at("nginx", "b"), at("api", "t")),
  "api>main": curve(at("api", "r"), [462, 662], [462, 538], at("main", "l", 16)),
  "api>pdf": curve(at("api", "r", -20), [458, 642], [458, 154], at("pdf", "l", 12)),
  ...Object.fromEntries(["companies", "circulars", "policies", "assessments", "checks", "gaps", "events"].map((t) => [`api>${t}`, low(t)])),
};

const tables = {
  circulars: { title: "circulars", store: "Postgres", cols: ["id", "status", "what's saved"] },
  ocrPages: { title: "ocr_pages", store: "Postgres", cols: ["PDF", "page", "text"] },
  companies: { title: "companies · users", store: "Postgres", cols: ["company", "description", "users"] },
  policies: { title: "policies (company A)", store: "Postgres", cols: ["code", "version", "embedded", "controls", "checked_at", "its page says"] },
  assessments: { title: "assessments", store: "Postgres", cols: ["company", "circular", "status", "applies?"] },
  ranks: { title: "the 3 closest, per circular", store: "worked out each time, never saved", cols: ["circular", "A's closest RBI policies"] },
  checks: { title: "policy_checks", store: "Postgres", cols: ["circular", "policy", "version", "out of date?"] },
  gaps: { title: "gaps", store: "Postgres", cols: ["gap", "company", "policy", "severity", "owner", "due", "status"] },
  events: { title: "gap_events", store: "Postgres", cols: ["gap", "who", "what", "note"] },
};

// The rows, as the stories change them
const C95 = ["95", "read", "text, summary, numbers"];
const C98new = ["98", "new", "the PDF in S3; nothing read yet"];
const C98parsed = ["98", "parsed", "its text: 12,408 characters"];
const C98read = ["98", "read", "text, summary, obligations, numbers"];
const C100 = (status, saved) => ["100", status, saved];
const PG1 = [SHA, "0", "RESERVE BANK OF INDIA …"];
const PG2 = [SHA, "1", "2. Regulated entities shall …"];
const PG3 = [SHA, "2", "(blank: never sent to OCR)"];
const COMPANY_A = ["A (id 1)", "an NBFC, not deposit-taking", "2 users"];
const COMPANY_B = ["B (id 2)", "a stock broker", "1 user"];
const KYC1 = ["POL-KYC", "1", "3 pieces", "3", "Sep 30", "Checked"];
const DRP = ["POL-DRP", "1", "1 piece", "2", "Sep 30", "Checked"];
const DLP = ["POL-DLP", "1", "2 pieces", "2", "Sep 30", "Checked"];
const IT = ["POL-IT", "1", "2 pieces", "1", "Sep 30", "Checked"];
const AML = (embedded, controls, checked, says) => ["POL-AML", "1", embedded, controls, checked, says];
const AML_DONE = AML("2 pieces", "0", "Oct 3, 10:15", "Checked");
const AML_CTL = AML("2 pieces", "1", "Oct 3, 10:15", "Checked");
const A95 = ["A", "95", "done", "yes"];
const B95 = ["B", "95", "done", "no"];
const AB98 = (a, b, applies = ["", ""]) => [["A", "98", a, applies[0]], ["B", "98", b, applies[1]]];
const C2 = (s95, s98, applies = ["", ""]) => [["C", "95", s95, applies[0]], ["C", "98", s98, applies[1]]];
const GAP1 = (status) => ["#1", "A", "POL-KYC", "high", "kyc@a.example", "in 7 days", status];
const GAP2 = ["#2", "A", "POL-AML", "medium", "aml@a.example", "in 30 days", "open"];
const EV1 = ["#1", "agent", "opened", "The policy does not require reporting to FIU-IND…"];
const EV2 = ["#2", "agent", "opened", "No screening against the updated sanctions list…"];
const EV_V2 = ["#1", "system", "policy_updated", "POL-KYC updated to v2"];
const EV_START = ["#1", "kyc@a.example", "status", "open -> in_progress"];
const EV_NOTE = ["#1", "kyc@a.example", "comment", "Drafting clause 2A with Legal"];
const EV_CLOSE = ["#1", "kyc@a.example", "status", "in_progress -> closed: POL-KYC v2 approved by the board"];
const CHECK_START = [["95", "POL-KYC", "1", "no"], ["95", "POL-DLP", "1", "no"], ["95", "POL-DRP", "1", "no"]];
const CHECK_98 = [["98", "POL-KYC", "1", "yes"], ["98", "POL-DRP", "1", "no"], ["98", "POL-DLP", "1", "no"]];
const CHECK_AML = [["98", "POL-AML", "1", "no"], ["95", "POL-AML", "1", "yes"]];
const CHECK_KYC2 = ["95", "POL-KYC", "2", "no"];
const CHECKS_KEPT = [...CHECK_START, ["98", "POL-KYC", "1", "yes"], ["95", "POL-AML", "1", "yes"], CHECK_KYC2];

const steps = [
  // ── 1. A new circular arrives ──
  {
    story: 0, dur: 5600, focus: ["reg", "watcher"], tables: [],
    title: "The watcher finds it",
    text: "Every 60 minutes the watcher reads RBI's, SEBI's and IRDAI's lists of circulars. Circular 98 is one it has never seen, so it downloads its PDF.",
    code: "run_source(), fetch_new() · watcher/main.py",
    moves: [["circular 98", "reg>watcher", 0.1, 0.7, "ext"]],
    marks: [[0.7, { sub: { watcher: "found 98" }, log: ["log", "INFO RBI new: Designation of terrorist organisation…", "The watcher notes in its log that RBI has a circular it has never seen, with its title."] }]],
  },
  {
    story: 0, dur: 6600, focus: ["watcher", "s3", "circulars"], tables: ["circulars"],
    title: "The PDF to S3, a row to Postgres",
    text: "The PDF goes to S3, named by its fingerprint (sha256), so the same file is never stored twice. Then a circulars row, status new. A circular is never saved twice either.",
    code: "fetch_new() · watcher/main.py · put_pdf() · watcher/storage.py",
    moves: [["PDF", "watcher>s3", 0.05, 0.42, "data"], ["row 98", "watcher>circulars", 0.36, 0.86, "data"]],
    marks: [[0.42, { log: ["s3", `PUT s3://rci/rbi/${SHA}.pdf (application/pdf)`, "The PDF is uploaded to S3, the file store. Its name is its fingerprint, so the same file is never stored twice."] }],
            [0.86, { rows: { circulars: [C95, C98new] }, sub: { circulars: "98 · new" },
                     log: ["sql", "INSERT INTO circulars (…) VALUES ('RBI', 'id=13650', …, 'new') → id 98", "A new row in the circulars table: circular 98, from RBI, status new. Nobody has read it yet."] }]],
  },
  {
    story: 0, dur: 6600, focus: ["watcher", "marks", "pdf"], tables: [],
    title: "A mark, then a note on the PDF lane",
    text: "The mark stops the same note being added twice. The note only says read 98: the data stays in Postgres. Reading takes minutes, so PDFs have a lane of their own.",
    code: "enqueue() · common/queue.py",
    moves: [["mark", "watcher>marks", 0.05, 0.4, "queue"], ["read 98", "watcher>pdf", 0.46, 0.86, "queue"]],
    marks: [[0.4, { sub: { marks: "read 98" }, log: ["redis", "SET rci:queued:circular_id=98:type=circular.read 1 NX EX 86400 → OK", "A mark in Redis: “read 98 is already queued”. NX means only if there's no mark yet, so the same task can't be queued twice. It expires after a day."] }],
            [0.86, { slots: { pdf: ["read 98"] }, sub: { watcher: "every 60 min" },
                     log: ["redis", "XADD rci:tasks:pdf MAXLEN ~ 100000 * type circular.read circular_id 98", "The watcher puts a to-do note on the PDF lane, the queue only the reader takes from. It says: read circular 98. The note holds only that number; the circular itself stays in Postgres."] }]],
  },
  {
    story: 0, dur: 6400, focus: ["pdf", "reader", "pending"], tables: [],
    title: "The reader takes it at once",
    text: "Redis hands the note to the one reader and writes its name on the pending list, so nobody else gets it. While it works, it touches the note every minute: still mine.",
    code: "next_task(), keep_claimed() · worker/main.py",
    moves: [["read 98", "pdf>reader", 0.08, 0.5, "queue"], ["still mine", "reader>pending", 0.62, 0.94, "queue"]],
    marks: [[0.08, { slots: { pdf: [] } }],
            [0.5, { sub: { reader: "reading 98", pending: "98: the reader" },
                    log: ["redis", `XREADGROUP GROUP workers ${READER} COUNT 1 BLOCK 5000 STREAMS rci:tasks:pdf > → read 98`, "The reader asks Redis for a new note and waits up to 5 seconds. Redis hands it read 98 and writes the reader's name next to it, so nobody else gets it."] }]],
  },
  {
    story: 0, dur: 9400, focus: ["reader", "s3", "ocr", "ocrpages"], tables: ["ocrPages"],
    title: "OCR reads each page once",
    text: "The reader fetches the PDF from S3 and sends it to OCR on the GPU one page at a time. Each page's text is saved the moment it's read; a blank page is saved as blank, never sent.",
    code: "ocr_text() · worker/pipeline.py · pages() · worker/ocr.py",
    moves: [["PDF", "s3>reader", 0.02, 0.13, "data"], ["page 1", "reader>ocr", 0.16, 0.27, "gpu"], ["text", "ocr>reader", 0.29, 0.39, "gpu"],
            ["save page 1", "reader>ocrpages", 0.41, 0.51, "data"], ["page 2", "reader>ocr", 0.54, 0.64, "gpu"], ["text", "ocr>reader", 0.66, 0.75, "gpu"],
            ["save page 2", "reader>ocrpages", 0.77, 0.86, "data"], ["page 3: blank", "reader>ocrpages", 0.88, 0.98, "data"]],
    marks: [[0.27, { log: ["ocr", "POST http://ocr:8000/v1/chat/completions  page 1 as a 200 DPI PNG", "Page 1 of the PDF becomes a picture and goes to the OCR model on the GPU, which sends back the page's text."] }],
            [0.51, { rows: { ocrPages: [PG1] }, sub: { ocrpages: "98: 1 page" } }],
            [0.64, { log: ["ocr", "POST http://ocr:8000/v1/chat/completions  page 2", "Page 2 goes to OCR the same way. One page at a time, so even a huge PDF never overloads the GPU."] }],
            [0.86, { rows: { ocrPages: [PG1, PG2] }, sub: { ocrpages: "98: 2 pages" } }],
            [0.98, { rows: { ocrPages: [PG1, PG2, PG3] }, sub: { ocrpages: "98: 3 pages" } }]],
  },
  {
    story: 0, dur: 7000, focus: ["reader", "circulars", "ocrpages"], tables: ["circulars", "ocrPages"],
    title: "Joined into its text",
    text: "The pages are joined and saved on the circular, now parsed, and its saved pages are deleted. Had the reader stopped half-way, the next one would have carried on from the last saved page.",
    code: "ocr_text() · worker/pipeline.py",
    moves: [["the text", "reader>circulars", 0.05, 0.45, "data"], ["delete 3 pages", "reader>ocrpages", 0.4, 0.8, "data"]],
    marks: [[0.45, { rows: { circulars: [C95, C98parsed] }, sub: { circulars: "98 · parsed" }, log: ["log", "INFO #98 parsed: 12408 chars", "The reader's log: circular 98's text is ready, 12,408 characters from all its pages joined together."] }],
            [0.8, { rows: { ocrPages: [] }, sub: { ocrpages: "empty" } }]],
  },
  {
    story: 0, dur: 8400, focus: ["reader", "chat", "emb", "circulars"], tables: ["circulars"],
    title: "Gemini sums it up, then numbers",
    text: "Gemini answers in a fixed shape: who it's for, a short summary, every obligation. The summary becomes 768 numbers, used to find close policies. Done once, for every company.",
    code: "summarize(), embed() · worker/llm.py",
    moves: [["summarise", "reader>chat", 0.02, 0.2, "ext"], ["summary", "chat>reader", 0.24, 0.42, "ext"],
            ["into numbers", "reader>emb", 0.48, 0.64, "ext"], ["768 numbers", "emb>reader", 0.68, 0.82, "ext"],
            ["saved", "reader>circulars", 0.85, 0.97, "data"]],
    marks: [[0.42, { log: ["llm", "summarize(98) → {addressed_to: 'All Regulated Entities…', summary: 'RBI designates a new terrorist organisation…', requirements: […]}", "Gemini reads the text and answers in a fixed shape: who the circular is for, a short summary, and the list of obligations."] }],
            [0.82, { log: ["llm", "embed(title + summary + obligations) → [0.021, -0.013, …] (768 numbers)", "Gemini turns the title, summary and obligations into 768 numbers. Texts about similar things get similar numbers: that's how close policies are found."] }],
            [0.97, { rows: { circulars: [C95, C98read] }, sub: { circulars: "98 · read" },
                     log: ["log", "INFO #98 read: addressed to 'All Regulated Entities…'", "The reader's log: circular 98 is now fully read, and it's addressed to all regulated entities."] }]],
  },
  {
    story: 0, dur: 7800, focus: ["reader", "assessments", "main", "pending"], tables: ["assessments"],
    title: "One check per company",
    text: "Each company gets an assessment, pending, and its own note on the main lane. Then the reader says finished (XACK): read 98 leaves the pending list for good.",
    code: "add_assessments(), pending() · worker/pipeline.py · run_task() · worker/main.py",
    moves: [["2 to-dos", "reader>assessments", 0.03, 0.28, "data"], ["98 · A", "reader>main", 0.32, 0.6, "queue"],
            ["98 · B", "reader>main", 0.42, 0.7, "queue"], ["XACK", "reader>pending", 0.76, 0.95, "ok"]],
    marks: [
      [0.28, { rows: { assessments: [A95, B95, ...AB98("pending", "pending")] }, sub: { assessments: "98: A, B pending" } }],
      [0.6, { slots: { main: ["98 · A"] }, sub: { marks: "check 98 · A, B" },
              log: ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type circular.assess company_id 1 circular_id 98", "The reader puts a to-do note on the main lane, the queue the workers take their tasks from. It says: check circular 98 for company 1 (A in the picture). The note holds only these numbers; the worker reads the rest from Postgres."] }],
      [0.7, { slots: { main: ["98 · A", "98 · B"] }, log: ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type circular.assess company_id 2 circular_id 98", "A second note, the same but for company 2 (B). One note per company, so two workers can check A and B at the same time."] }],
      [0.95, { sub: { reader: W, pending: "who has what" }, log: ["redis", "XACK rci:tasks:pdf workers 1790831160001-0", "The reader tells Redis the task is finished (XACK means acknowledge). The note leaves the pending list for good and is never handed out again."] }],
    ],
  },
  {
    story: 0, dur: 6600, focus: ["main", "w1", "w2", "reader"], tables: [],
    title: "Two workers, one note each",
    text: "Each note goes to exactly one worker, so A and B are checked at the same time. The reader is already free for the next PDF: the two lanes never wait for each other.",
    code: "serve(), next_task() · worker/main.py",
    moves: [["98 · A", "main>w1", 0.05, 0.45, "queue"], ["98 · B", "main>w2", 0.12, 0.52, "queue"]],
    marks: [[0.05, { slots: { main: ["98 · B"] } }], [0.12, { slots: { main: [] } }],
            [0.45, { sub: { w1: "98 · A" } }], [0.52, { sub: { w2: "98 · B", pending: "98·A, 98·B" } }]],
  },
  {
    story: 0, dur: 8400, focus: ["w1", "w2", "companies", "chat", "assessments"], tables: ["assessments"],
    title: "Does it apply?",
    text: "Each worker gives Gemini its company's description and the start of the circular. Yes for A, an NBFC. No for B, a stock broker, so B's check ends here.",
    code: "assess() · worker/pipeline.py · check_applicability() · worker/llm.py",
    moves: [["A's description", "w1>companies", 0.02, 0.18, "data"], ["B's", "w2>companies", 0.04, 0.2, "data"],
            ["applies?", "w1>chat", 0.24, 0.42, "ext"], ["applies?", "w2>chat", 0.26, 0.44, "ext"],
            ["yes", "chat>w1", 0.48, 0.66, "ok"], ["no", "chat>w2", 0.5, 0.68, "ext"],
            ["yes", "w1>assessments", 0.74, 0.92, "data"], ["no", "w2>assessments", 0.76, 0.94, "data"]],
    marks: [[0.66, { log: [["llm", "check_applicability(company 1, 98) → {applies_to_company: true, …}", "Gemini gets company 1's description and the circular, and is asked: does this apply? Answer: yes."],
                           ["llm", "check_applicability(company 2, 98) → {applies_to_company: false, …}", "The same question for company 2, a stock broker. Answer: no, so company 2's check stops here, at no further cost."]] }],
            [0.94, { rows: { assessments: [A95, B95, ...AB98("pending", "pending", ["yes", "no"])] }, sub: { assessments: "98: A yes, B no" } }]],
  },
  {
    story: 0, dur: 8800, focus: ["w1", "policies", "chat", "checks"], tables: ["checks"],
    title: "The closest policies, then Gemini",
    text: "Worker 1 ranks A's RBI policies by their numbers, plain arithmetic, and asks Gemini about the 3 closest. POL-KYC is out of date; POL-DRP and POL-DLP are fine.",
    code: "match(), judge_policy() · worker/pipeline.py",
    moves: [["A's RBI policies", "w1>policies", 0.02, 0.2, "data"], ["their numbers", "policies>w1", 0.24, 0.4, "data"],
            ["3 questions", "w1>chat", 0.46, 0.64, "ext"], ["KYC: out of date", "chat>w1", 0.68, 0.86, "gap"],
            ["3 verdicts", "w1>checks", 0.88, 0.98, "data"]],
    marks: [[0.86, { log: ["llm", "assess(98, POL-KYC v1) → {impacted: true, severity: 'high', missing_from_policy: 'The policy does not require reporting to FIU-IND…'}", "Gemini compares circular 98 with policy POL-KYC, version 1. Verdict: out of date, severity high, and it says what's missing."] }],
            [0.98, { rows: { checks: [...CHECK_START, ...CHECK_98] }, sub: { checks: "98: 3 verdicts" },
                     log: [["log", "INFO #98 vs POL-KYC v1 (0.82): GAP", "The log line for that verdict: POL-KYC v1 scored 0.82 for closeness (1 would mean the same meaning), and it has a gap."], ["log", "INFO #98 vs POL-DRP v1 (0.58): up to date", "POL-DRP was close enough to ask about (0.58), and Gemini says it's already up to date. No gap."],
                           ["log", "INFO #98 vs POL-DLP v1 (0.51): up to date", "POL-DLP, the third closest (0.51), is up to date too."]] }]],
  },
  {
    story: 0, dur: 7600, focus: ["w1", "gaps", "events"], tables: ["gaps", "events"],
    title: "A gap for the policy's owner",
    text: "With the verdict, in the same commit: gap #1 for POL-KYC's owner, high, so due in 7 days, with what's missing, a draft of the new wording and the controls to change.",
    code: "judge_policy(), DUE_DAYS · worker/pipeline.py",
    moves: [["gap #1", "w1>gaps", 0.05, 0.45, "gap"], ["opened", "w1>events", 0.3, 0.7, "gap"]],
    marks: [[0.7, { rows: { gaps: [GAP1("open")], events: [EV1] }, sub: { gaps: "#1 open", events: "#1: opened" },
                    log: ["sql", "INSERT INTO gaps (…, severity, owner, due_date) VALUES (…, 'high', 'kyc@a.example', today + 7) → id 1", "A new gap row: what POL-KYC misses, severity high, for its owner kyc@a.example, due in 7 days (high gets 7 days, medium 30, low 60)."] }]],
  },
  {
    story: 0, dur: 7000, focus: ["w1", "w2", "assessments", "main"], tables: ["assessments"],
    title: "Done, and never twice",
    text: "Each company's assessment is marked done, and each worker says finished. Every result was saved as it came, so nothing slow or paid for is ever done again.",
    code: "assess() · worker/pipeline.py · run_task() · worker/main.py",
    moves: [["done", "w1>assessments", 0.04, 0.32, "ok"], ["done", "w2>assessments", 0.06, 0.34, "ok"],
            ["XACK", "w1>main", 0.44, 0.74, "ok"], ["XACK", "w2>main", 0.48, 0.78, "ok"]],
    marks: [[0.34, { rows: { assessments: [A95, B95, ...AB98("done", "done", ["yes", "no"])] }, sub: { assessments: "98: done" } }],
            [0.78, { sub: { w1: W, w2: W, marks: "no duplicates", pending: "who has what" },
                     log: [["log", "INFO #98 for company 1: applies: True, gaps opened: ['POL-KYC']", "The worker's summary for company 1: the circular applies, and one gap was opened, for POL-KYC."],
                           ["log", "INFO #98 for company 2: applies: False, gaps opened: none", "The summary for company 2: it doesn't apply, so no gaps."]] }]],
  },
  {
    story: 0, dur: 7600, focus: ["gappage", "overview", "team"], tables: ["gaps"],
    title: "You see it in the console",
    text: "Company A's Gaps page shows gap #1 and its Overview counts it; company B sees none. Every page asks the api for its own company's rows only.",
    code: "list_gaps() · api/routes/gaps.py · gapsPage() · frontend/js/views/gaps.js",
    moves: [["gap #1", "gaps>api", 0.04, 0.32, "gap"], ["gap #1", "api>nginx", 0.36, 0.5, "gap"],
            ["gap #1", "nginx>gappage", 0.54, 0.7, "gap"], ["1 to fix", "gappage>team", 0.76, 0.94, "gap"]],
    marks: [[0.3, { log: ["http", "GET /api/gaps → 200  [{id: 1, policy: 'POL-KYC', severity: 'high', status: 'open', …}]", "The Gaps page asks the api for this company's gaps, and gets a list back: gap 1, POL-KYC, high, open."] }],
            [0.7, { sub: { gappage: "#1 open", overview: "1 open gap" } }]],
  },

  // ── 2. A company signs up and describes itself ──
  {
    story: 1, dur: 8400, focus: ["team", "compage", "api", "companies"], tables: ["companies"],
    title: "Sign up: a company and its first user",
    text: "Someone at company C opens Set up your company: its name, then their own name, email and password. The api saves both together and signs them in. Nothing is queued: there's nothing to judge yet.",
    code: "sign_up() · api/routes/auth.py",
    moves: [["Create account", "team>compage", 0.02, 0.18, "start"], ["POST /auth/signup", "compage>nginx", 0.22, 0.38, "start"],
            ["sign-up", "nginx>api", 0.4, 0.5, "start"], ["company + user", "api>companies", 0.54, 0.78, "data"],
            ["a login token", "api>nginx", 0.82, 0.96, "ok"]],
    marks: [[0.78, { rows: { companies: [COMPANY_A, COMPANY_B, ["C (id 3)", "(none yet)", "1 user"]] }, sub: { companies: "A, B, C" },
                     log: ["http", "POST /api/auth/signup  {\"company\": \"C\", \"name\": …, \"email\": …}  → 201", "The sign-up form sends the company's name and the first user's details. 201 means created: the company and the user now exist."] }]],
  },
  {
    story: 1, dur: 7000, focus: ["overview", "circpage"], tables: ["companies"],
    title: "Not checked until it's described",
    text: "Company C's circulars show Not checked: describe your company first. Its Overview shows two set-up steps, describe the company and add policies. New circulars are still read meanwhile.",
    code: "overviewPage() · frontend/js/views/overview.js",
    moves: [["Not checked", "nginx>circpage", 0.15, 0.5, "ask"], ["2 set-up steps", "nginx>overview", 0.3, 0.65, "ask"]],
    marks: [[0.5, { sub: { circpage: "Not checked" } }], [0.65, { sub: { overview: "set up first" } }]],
  },
  {
    story: 1, dur: 8400, focus: ["compage", "api", "companies", "main"], tables: ["companies"],
    title: "Describe the company",
    text: "On the Company page: what kind of entity it is, its licences and businesses. A new or changed description is saved with a company.refresh task; if Redis can't take it, the old one is put back.",
    code: "set_company() · api/routes/company.py",
    moves: [["a description", "team>compage", 0.02, 0.16, "start"], ["PUT /company", "compage>nginx", 0.2, 0.34, "start"],
            ["PUT", "nginx>api", 0.36, 0.46, "start"], ["save it", "api>companies", 0.5, 0.7, "data"],
            ["company.refresh", "api>main", 0.74, 0.94, "queue"]],
    marks: [[0.7, { rows: { companies: [COMPANY_A, COMPANY_B, ["C (id 3)", "a small finance bank, also a corporate insurance agent", "1 user"]] },
                    sub: { compage: "described" } }],
            [0.94, { slots: { main: ["refresh"] }, sub: { marks: "refresh C" },
                     log: ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type company.refresh company_id 3", "Company C's description changed, so a company.refresh note goes on the main lane: its circulars will be judged again."] }]],
  },
  {
    story: 1, dur: 7800, focus: ["main", "w2", "assessments"], tables: ["assessments"],
    title: "Which circulars apply now?",
    text: "A worker sends C's earlier answers back to pending (none yet), gives C a to-do for each circular read in the last 30 days, here 95 and 98, and queues a check for each.",
    code: "refresh_company() · worker/pipeline.py",
    moves: [["refresh C", "main>w2", 0.03, 0.26, "queue"], ["2 to-dos", "w2>assessments", 0.32, 0.6, "data"], ["2 checks", "w2>main", 0.66, 0.94, "queue"]],
    marks: [[0.03, { slots: { main: [] } }], [0.26, { sub: { w2: "refresh C" } }],
            [0.6, { rows: { assessments: [A95, B95, ...AB98("done", "done", ["yes", "no"]), ...C2("pending", "pending")] }, sub: { assessments: "C: 2 to-dos" } }],
            [0.94, { slots: { main: ["C · 95", "C · 98"] }, sub: { w2: W, marks: "no duplicates" } }]],
  },
  {
    story: 1, dur: 8400, focus: ["w1", "w2", "chat", "assessments"], tables: ["assessments"],
    title: "Each one judged, for C only",
    text: "Does it apply, for company C? 95 is for NBFCs only; 98 is for every regulated entity. C has no policies yet, so no gaps. The text, the summaries and everyone else's answers are kept.",
    code: "assess() · worker/pipeline.py",
    moves: [["C · 95", "main>w1", 0.02, 0.2, "queue"], ["C · 98", "main>w2", 0.04, 0.22, "queue"],
            ["applies?", "w1>chat", 0.28, 0.44, "ext"], ["applies?", "w2>chat", 0.3, 0.46, "ext"],
            ["no", "chat>w1", 0.5, 0.64, "ext"], ["yes", "chat>w2", 0.52, 0.66, "ok"],
            ["done", "w1>assessments", 0.72, 0.9, "data"], ["done", "w2>assessments", 0.74, 0.92, "data"]],
    marks: [[0.02, { slots: { main: ["C · 98"] } }], [0.04, { slots: { main: [] } }],
            [0.2, { sub: { w1: "C · 95" } }], [0.22, { sub: { w2: "C · 98" } }],
            [0.92, { rows: { assessments: [A95, B95, ...AB98("done", "done", ["yes", "no"]), ...C2("done", "done", ["no", "yes"])] },
                     sub: { assessments: "C: 98 applies", circpage: "the list", overview: "at a glance", w1: W, w2: W },
                     log: [["log", "INFO #95 for company 3: applies: False, gaps opened: none", "Circular 95 is for NBFCs only, so it doesn't apply to company C. No gaps."],
                           ["log", "INFO #98 for company 3: applies: True, gaps opened: none", "Circular 98 applies to company C, but C has no policies yet: nothing to compare, so no gaps."]] }]],
  },

  // ── 3. You add a new policy: the full process ──
  {
    story: 2, dur: 7600, focus: ["team", "polpage"], tables: ["policies"],
    title: "Fill in New policy",
    text: "Back at company A: Policies → New policy. A code (POL-AML), a title, the owner's email, the regulators it answers to (RBI), and its text, typed or loaded from a file. Import JSON adds a whole library at once.",
    code: "newPolicyPage(), importPolicies() · frontend/js/views/policies.js",
    moves: [["New policy", "team>polpage", 0.2, 0.6, "start"]],
    marks: [[0.6, { sub: { polpage: "New policy" } }]],
  },
  {
    story: 2, dur: 6600, focus: ["polpage", "nginx", "api"], tables: [],
    title: "Save: POST /api/policies",
    text: "The page sends the policy as JSON, with your login token. nginx passes everything under /api on to the api container.",
    code: "api() · frontend/js/lib/api.js · location /api/ · frontend/nginx.conf",
    moves: [["POST /policies", "polpage>nginx", 0.05, 0.45, "start"], ["POST", "nginx>api", 0.5, 0.85, "start"]],
    marks: [[0.45, { log: ["http", "POST /api/policies  Authorization: Bearer eyJ…  {\"code\": \"POL-AML\", \"regulators\": [\"RBI\"], …}", "The page sends the new policy as JSON. The Authorization header carries your login token, which proves who you are."] }]],
  },
  {
    story: 2, dur: 7800, focus: ["api", "companies"], tables: [],
    title: "Who are you, and is it complete?",
    text: "The api checks the token and loads your user: no login is a 401. Then the fields: a missing title is a 422, a code you already have a 409. It only ever touches company A's rows.",
    code: "current_user() · api/auth.py · PolicyIn · common/models.py",
    moves: [["the token", "api>companies", 0.05, 0.4, "data"], ["you · company A", "companies>api", 0.48, 0.85, "data"]],
  },
  {
    story: 2, dur: 7000, focus: ["api", "policies", "polpage"], tables: ["policies"],
    title: "Saved first: version 1",
    text: "POL-AML is saved for company A as version 1, with no numbers yet, and committed. Its page will say Waiting for the worker.",
    code: "create_policy(), save() · api/routes/policies.py",
    moves: [["INSERT POL-AML", "api>policies", 0.05, 0.55, "data"]],
    marks: [[0.55, { rows: { policies: [KYC1, DRP, DLP, IT, AML("none yet", "0", "—", "Waiting for the worker")] }, sub: { policies: "A: 5 policies" },
                     log: [["sql", "INSERT INTO policies (company_id, code, title, owner, regulators, text, version) VALUES (1, 'POL-AML', …, 1) → id 11", "The policy is saved as a new row: id 11, version 1, for company 1. It has no numbers (embeddings) yet."],
                           ["sql", "COMMIT", "Postgres saves everything so far for good, all together. Until this line nothing was saved, so a failure would have undone it all."]] }]],
  },
  {
    story: 2, dur: 8000, focus: ["api", "main", "marks", "polpage"], tables: ["policies"],
    title: "Then its task: policy.check",
    text: "Only after the commit, the api sets a mark and puts policy.check on the main lane, then answers 201: a toast, and the policy's page. If Redis can't take it, the policy is deleted again: nothing was saved.",
    code: "enqueue_or_undo() · api/database.py",
    moves: [["mark + XADD", "api>main", 0.06, 0.5, "queue"], ["201 Created", "api>nginx", 0.56, 0.74, "ok"], ["saved", "nginx>polpage", 0.78, 0.96, "ok"]],
    marks: [[0.3, { sub: { marks: "check POL-AML" }, log: ["redis", "SET rci:queued:company_id=1:policy_id=11:type=policy.check 1 NX EX 86400 → OK", "A mark in Redis: “check policy 11 is queued”, so the same check can't be queued twice. It expires after a day."] }],
            [0.5, { slots: { main: ["POL-AML"] }, log: ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type policy.check company_id 1 policy_id 11", "The api puts a to-do note on the main lane, the queue the workers take their tasks from. It says: check policy 11 for company 1. A free worker picks it up within moments."] }],
            [0.96, { sub: { polpage: "AML: waiting" }, log: ["app", "toast: POL-AML saved and queued: a worker is checking it now", "The page shows a short message (a toast) and opens the policy's page, which says Waiting for the worker."] }]],
  },
  {
    story: 2, dur: 6000, focus: ["main", "w1"], tables: [],
    title: "A worker takes it at once",
    text: "A free worker takes the note within moments. The api never waits for it, and never calls OCR or Gemini itself.",
    code: "next_task(), run_task() · worker/main.py",
    moves: [["POL-AML", "main>w1", 0.1, 0.55, "queue"]],
    marks: [[0.1, { slots: { main: [] } }], [0.55, { sub: { w1: "checking AML", pending: "AML: worker 1" } }]],
  },
  {
    story: 2, dur: 8400, focus: ["w1", "policies", "emb"], tables: ["policies"],
    title: "Turned into numbers",
    text: "The worker cuts POL-AML into 5,000-character pieces and turns each into 768 numbers. Against a circular, a policy scores its best piece.",
    code: "check_policy(), embed_policy() · worker/pipeline.py",
    moves: [["its text", "policies>w1", 0.02, 0.2, "data"], ["2 pieces", "w1>emb", 0.26, 0.46, "ext"],
            ["2 × 768 numbers", "emb>w1", 0.5, 0.7, "ext"], ["saved", "w1>policies", 0.76, 0.94, "data"]],
    marks: [[0.94, { rows: { policies: [KYC1, DRP, DLP, IT, AML("2 pieces", "0", "—", "Waiting for the worker")] },
                     log: ["log", "INFO embedded POL-AML (2 chunks) with gemini-embedding-001", "The worker cut the policy into 2 pieces and turned each into numbers with Gemini's embedding model."] }]],
  },
  {
    story: 2, dur: 7800, focus: ["w1", "assessments"], tables: ["assessments"],
    title: "Which circulars are worth checking?",
    text: "Company A's circulars of the last 30 days that apply to it, have obligations, and come from a regulator POL-AML lists. Here: 98 and 95.",
    code: "check_policy() · worker/pipeline.py",
    moves: [["A's, last 30 days", "w1>assessments", 0.05, 0.4, "data"], ["98, 95", "assessments>w1", 0.48, 0.85, "data"]],
  },
  {
    story: 2, dur: 8000, focus: ["w1", "policies"], tables: ["ranks"],
    title: "Does POL-AML make the top 3?",
    text: "For each circular, POL-AML competes with all of A's RBI policies for the 3 closest places, by their numbers. For 98 it comes second; for 95, an AML circular, first.",
    code: "match(), cosine() · worker/pipeline.py",
    moves: [["rank them", "w1>policies", 0.05, 0.4, "data"], ["top 3 each", "policies>w1", 0.48, 0.85, "data"]],
    marks: [[0.85, { rows: { ranks: [["98", "POL-KYC .82 · POL-AML .71 · POL-DRP .58"], ["95", "POL-AML .79 · POL-KYC .60 · POL-DLP .44"]] } }]],
  },
  {
    story: 2, dur: 7400, focus: ["w1", "checks", "gaps"], tables: ["checks"],
    title: "Only new questions cost a call",
    text: "A pair already judged at this version, or that has a gap, is skipped: POL-KYC and POL-DRP were judged for 98, and so were POL-KYC and POL-DLP for 95. POL-AML is new: 2 questions.",
    code: "match() · worker/pipeline.py",
    moves: [["judged before?", "w1>checks", 0.05, 0.4, "data"], ["only POL-AML new", "checks>w1", 0.48, 0.85, "data"]],
  },
  {
    story: 2, dur: 8800, focus: ["w1", "chat", "checks"], tables: ["checks"],
    title: "98: up to date. 95: out of date",
    text: "Gemini reads each circular's obligations, POL-AML's text and its controls. For 98 it's up to date. For 95 something is missing: severity medium.",
    code: "judge_policy() · worker/pipeline.py · assess() · worker/llm.py",
    moves: [["AML vs 98?", "w1>chat", 0.02, 0.2, "ext"], ["up to date", "chat>w1", 0.23, 0.4, "ok"],
            ["AML vs 95?", "w1>chat", 0.46, 0.64, "ext"], ["out of date", "chat>w1", 0.67, 0.84, "gap"],
            ["2 verdicts", "w1>checks", 0.87, 0.98, "data"]],
    marks: [[0.98, { rows: { checks: [...CHECK_START, ...CHECK_98, ...CHECK_AML] }, sub: { checks: "+2 verdicts" },
                     log: [["log", "INFO #98 vs POL-AML v1 (0.71): up to date", "POL-AML is compared with circular 98 (closeness 0.71): it already covers what 98 asks. No gap."], ["log", "INFO #95 vs POL-AML v1 (0.79): GAP", "Against circular 95 (closeness 0.79), POL-AML is missing something: a gap."]] }]],
  },
  {
    story: 2, dur: 7800, focus: ["w1", "gaps", "events"], tables: ["gaps", "events"],
    title: "A gap for POL-AML's owner",
    text: "Gap #2, due in 30 days because it's medium, saved together with the verdict. That's how a policy added today still finds what last week's circulars ask of it.",
    code: "judge_policy(), DUE_DAYS · worker/pipeline.py",
    moves: [["gap #2", "w1>gaps", 0.05, 0.45, "gap"], ["opened", "w1>events", 0.3, 0.7, "gap"]],
    marks: [[0.7, { rows: { gaps: [GAP1("open"), GAP2], events: [EV1, EV2] }, sub: { gaps: "#1, #2 open", events: "#2: opened" } }]],
  },
  {
    story: 2, dur: 7200, focus: ["w1", "policies", "main", "pending"], tables: ["policies"],
    title: "Checked",
    text: "checked_at is stamped and the worker says finished (XACK). Had POL-AML been saved again while it ran, it would queue itself once more, for the new text.",
    code: "check_policy() · worker/pipeline.py",
    moves: [["checked_at", "w1>policies", 0.05, 0.45, "ok"], ["XACK", "w1>main", 0.55, 0.9, "ok"]],
    marks: [[0.45, { rows: { policies: [KYC1, DRP, DLP, IT, AML_DONE] }, log: ["log", "INFO POL-AML checked, gaps opened: ['POL-AML']", "The worker's summary: POL-AML is checked, and one gap was opened for it."] }],
            [0.9, { sub: { w1: W, marks: "no duplicates", pending: "who has what" } }]],
  },
  {
    story: 2, dur: 8800, focus: ["polpage", "api", "policies", "gappage", "overview"], tables: ["policies", "gaps"],
    title: "The page notices",
    text: "While it says Waiting, the page asks GET /api/policies/11 every 3 seconds. Now checked_at is newer than the last save: it shows Checked and a toast, and gap #2 is on Gaps and the Overview.",
    code: "watchWorker() · frontend/js/views/policies.js · get_policy() · api/routes/policies.py",
    moves: [["GET, every 3 s", "polpage>nginx", 0.02, 0.18, "start"], ["GET", "nginx>api", 0.2, 0.3, "start"],
            ["checked_at?", "api>policies", 0.33, 0.5, "data"], ["Checked", "policies>api", 0.52, 0.66, "ok"],
            ["Checked", "api>nginx", 0.68, 0.78, "ok"], ["Checked", "nginx>polpage", 0.8, 0.92, "ok"]],
    marks: [[0.92, { sub: { polpage: "AML: Checked", gappage: "#1, #2 open", overview: "2 open gaps" },
                     log: ["app", "toast: POL-AML checked by the worker", "The page has been asking every 3 seconds. Now it sees the check is done and shows this message."] }]],
  },
  {
    story: 2, dur: 8000, focus: ["polpage", "api", "policies"], tables: ["policies"],
    title: "Its controls",
    text: "On the policy's page, Add control: a code, an owner, how often, what it checks. Saved at once, with no task: Gemini reads the controls the next time the policy is judged, and a gap names the ones to change.",
    code: "add_control() · api/routes/policies.py",
    moves: [["Add control", "team>polpage", 0.02, 0.18, "start"], ["POST …/controls", "polpage>nginx", 0.22, 0.38, "start"],
            ["POST", "nginx>api", 0.4, 0.5, "start"], ["CTL-AML-01", "api>policies", 0.54, 0.8, "data"], ["201", "api>nginx", 0.84, 0.96, "ok"]],
    marks: [[0.8, { rows: { policies: [KYC1, DRP, DLP, IT, AML_CTL] }, sub: { policies: "A: 5 policies" },
                    log: ["http", "POST /api/policies/11/controls  {\"code\": \"CTL-AML-01\", \"frequency\": \"monthly\", …}  → 201", "A control (a regular check that puts the policy into practice, here monthly) is added to policy 11. 201: saved. No task is queued."] }]],
  },

  // ── 4. You edit a policy ──
  {
    story: 3, dur: 9400, focus: ["polpage", "api", "policies", "events", "main"], tables: ["policies", "events"],
    title: "Edit POL-KYC's text",
    text: "A text change makes version 2: its numbers are cleared, and its open gap #1 gets a line, POL-KYC updated to v2. Every save queues policy.check, even one that changes nothing.",
    code: "update_policy(), save_policy() · api/routes/policies.py",
    moves: [["edit POL-KYC", "team>polpage", 0.02, 0.14, "start"], ["PUT /policies/7", "polpage>nginx", 0.17, 0.3, "start"],
            ["PUT", "nginx>api", 0.32, 0.4, "start"], ["v2, numbers cleared", "api>policies", 0.44, 0.62, "data"],
            ["updated to v2", "api>events", 0.56, 0.76, "gap"], ["policy.check", "api>main", 0.8, 0.96, "queue"]],
    marks: [[0.62, { rows: { policies: [["POL-KYC", "2", "cleared", "3", "Sep 30", "Waiting for the worker"], DRP, DLP, IT, AML_CTL] },
                     sub: { polpage: "KYC: waiting" } }],
            [0.76, { rows: { events: [EV1, EV2, EV_V2] } }],
            [0.96, { slots: { main: ["POL-KYC"] }, log: ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type policy.check company_id 1 policy_id 7", "Saving the edited POL-KYC (id 7) queues a new check, so its new version gets compared again."] }]],
  },
  {
    story: 3, dur: 9400, focus: ["w2", "emb", "chat", "checks", "policies"], tables: ["checks", "policies"],
    title: "Checked again, only where it matters",
    text: "Version 2 gets new numbers, and only pairs not judged at v2 are asked: 95 is. 98 is skipped, as it has gap #1, which its owner now works against v2.",
    code: "check_policy(), match() · worker/pipeline.py",
    moves: [["POL-KYC", "main>w2", 0.02, 0.16, "queue"], ["new numbers", "w2>emb", 0.2, 0.34, "ext"], ["numbers", "emb>w2", 0.36, 0.48, "ext"],
            ["v2 vs 95?", "w2>chat", 0.52, 0.66, "ext"], ["up to date", "chat>w2", 0.68, 0.8, "ok"],
            ["verdict", "w2>checks", 0.82, 0.9, "data"], ["checked_at", "w2>policies", 0.9, 0.98, "ok"]],
    marks: [[0.02, { slots: { main: [] } }], [0.16, { sub: { w2: "checking KYC" } }],
            [0.8, { log: ["log", "INFO #95 vs POL-KYC v2 (0.61): up to date", "POL-KYC's new version 2 is compared with circular 95: up to date."] }],
            [0.9, { rows: { checks: [...CHECK_START, ...CHECK_98, ...CHECK_AML, CHECK_KYC2] } }],
            [0.98, { rows: { policies: [["POL-KYC", "2", "3 pieces", "3", "Oct 3, 11:02", "Checked"], DRP, DLP, IT, AML_CTL] },
                     sub: { w2: W, polpage: "KYC: Checked" }, log: ["log", "INFO POL-KYC checked, gaps opened: none", "The summary: POL-KYC version 2 is checked, and no new gaps were needed."] }]],
  },

  // ── 5. Your team works a gap ──
  {
    story: 4, dur: 8400, focus: ["gappage", "api", "gaps", "events"], tables: ["gaps", "events"],
    title: "Open the gap",
    text: "Gap #1's page shows what POL-KYC is missing, the proposed wording to copy, the circular, the controls to change, the owner and the due date, and its whole history.",
    code: "get_gap() · api/routes/gaps.py · gapPage() · frontend/js/views/gaps.js",
    moves: [["gap #1", "team>gappage", 0.02, 0.14, "start"], ["GET /gaps/1", "gappage>nginx", 0.17, 0.3, "start"], ["GET", "nginx>api", 0.32, 0.4, "start"],
            ["the gap", "api>gaps", 0.44, 0.58, "data"], ["+ its history", "api>events", 0.5, 0.64, "data"],
            ["the page", "api>nginx", 0.7, 0.8, "ok"], ["gap #1", "nginx>gappage", 0.82, 0.94, "ok"]],
  },
  {
    story: 4, dur: 8000, focus: ["gappage", "api", "gaps", "events"], tables: ["gaps", "events"],
    title: "Start work on it",
    text: "A new status, owner or due date adds a gap_events line under your email. Nothing is queued: a gap is your team's work, not the worker's.",
    code: "update_gap() · api/routes/gaps.py",
    moves: [["PATCH: in progress", "gappage>nginx", 0.04, 0.22, "start"], ["PATCH", "nginx>api", 0.25, 0.35, "start"],
            ["in_progress", "api>gaps", 0.4, 0.6, "data"], ["who, what, when", "api>events", 0.5, 0.72, "data"]],
    marks: [[0.72, { rows: { gaps: [GAP1("in_progress"), GAP2], events: [EV1, EV2, EV_V2, EV_START] }, sub: { gappage: "#1 in progress" } }]],
  },
  {
    story: 4, dur: 9400, focus: ["gappage", "api", "gaps", "events", "overview"], tables: ["gaps", "events"],
    title: "Comment, then close with a note",
    text: "Comments go into the history too. Closing or dismissing needs a note, or the api answers 422. An open gap past its due date counts as overdue on the Overview.",
    code: "add_comment(), update_gap() · api/routes/gaps.py",
    moves: [["a comment", "gappage>nginx", 0.02, 0.16, "start"], ["comment", "api>events", 0.2, 0.38, "data"],
            ["close + a note", "gappage>nginx", 0.46, 0.6, "start"], ["closed", "api>gaps", 0.64, 0.82, "ok"], ["the note", "api>events", 0.72, 0.9, "data"]],
    marks: [[0.38, { rows: { events: [EV1, EV2, EV_V2, EV_START, EV_NOTE] } }],
            [0.9, { rows: { gaps: [GAP1("closed"), GAP2], events: [EV1, EV2, EV_V2, EV_START, EV_NOTE, EV_CLOSE] },
                    sub: { gappage: "#2 open", overview: "1 open gap", gaps: "#2 open" } }]],
  },

  // ── 6. When something goes wrong ──
  {
    story: 5, dur: 8000, focus: ["pdf", "reader", "ocr", "pending"], tables: ["circulars"],
    title: "OCR is still loading",
    text: "The reader takes read 100 but can't reach OCR, so it leaves the note on its pending list, waits a minute and tries again, as long as it takes. The workers carry on meanwhile.",
    code: "should_wait(), RETRY_SECONDS · worker/failures.py · run_task() · worker/main.py",
    moves: [["read 100", "pdf>reader", 0.02, 0.2, "queue"], ["page 1", "reader>ocr", 0.26, 0.42, "gpu"], ["refused", "ocr>reader", 0.46, 0.62, "bad"],
            ["stays mine", "reader>pending", 0.68, 0.92, "queue"]],
    marks: [[0, { rows: { circulars: [C95, C98read, C100("new", "the PDF in S3; nothing read yet")] } }],
            [0.2, { sub: { reader: "reading 100", pending: "100: the reader", circulars: "100 · new" } }],
            [0.62, { sub: { reader: "100: wait 60 s" }, log: ["warn", "WARNING OCR or Gemini unavailable ([Errno 111] Connection refused); retrying", "The worker can't reach OCR (connection refused: it's still starting). It keeps the task, waits a minute and tries again."] }]],
  },
  {
    story: 5, dur: 7600, focus: ["w1", "chat", "reader"], tables: [],
    title: "Gemini is busy (429), or a hiccup",
    text: "The step is rolled back; what was saved before stays. A 429 waits a minute and runs again; a timeout or an answer in the wrong shape is retried at once, up to 3 times.",
    code: "should_wait(), should_retry(), MAX_TRIES · worker/failures.py",
    moves: [["applies?", "w1>chat", 0.05, 0.3, "ext"], ["429 busy", "chat>w1", 0.36, 0.6, "bad"]],
    marks: [[0.6, { sub: { w1: "wait 60 s" }, log: ["warn", "WARNING OCR or Gemini unavailable (429 RESOURCE_EXHAUSTED); retrying", "Gemini says 429: too many requests right now. The worker waits a minute and runs the same step again."] }],
            [0.98, { sub: { w1: W, reader: "reading 100" } }]],
  },
  {
    story: 5, dur: 8400, focus: ["reader", "dead", "circulars", "circpage"], tables: ["circulars"],
    title: "Given up",
    text: "Anything else is given up at once. Circular 100 has no text at all: it shows Failed with Why it failed, a copy of its note goes to rci:dead, and the note is finished. Fix the cause, then Reprocess.",
    code: "give_up() · worker/main.py",
    moves: [["failed + why", "reader>circulars", 0.05, 0.36, "bad"], ["a copy", "reader>dead", 0.42, 0.72, "bad"], ["Failed", "nginx>circpage", 0.78, 0.96, "bad"]],
    marks: [[0.36, { rows: { circulars: [C95, C98read, C100("failed", "ValueError: OCR found no text in the PDF")] }, sub: { circulars: "100 · failed" },
                     log: ["error", "ERROR {'type': 'circular.read', 'circular_id': '100'} failed for good", "Reading circular 100 failed in a way that waiting won't fix, so the worker gives up on this task."] }],
            [0.72, { sub: { dead: "circular.read 100", reader: W, pending: "who has what" },
                     log: ["redis", "XADD rci:dead * type circular.read circular_id 100 stream rci:tasks:pdf error 'ValueError: OCR found no text…'", "A copy of the failed task goes to rci:dead, the list of given-up tasks, with its error, so you can see what failed and why."] }],
            [0.96, { sub: { circpage: "100: Failed" } }]],
  },
  {
    story: 5, dur: 8000, focus: ["w2", "pending", "w1"], tables: [],
    title: "A worker dies mid-task",
    text: "Its note was never finished, so it stays on the pending list under its name. Restarted, it finds it first; otherwise another worker takes it over after 5 minutes, from the last saved step.",
    code: "next_task() · worker/main.py",
    moves: [["take it over", "w1>pending", 0.5, 0.82, "queue"]],
    marks: [[0.04, { sub: { w2: "✗ stopped", pending: "98·A: idle 0 s" } }], [0.4, { sub: { pending: "98·A: idle 5 min" } }],
            [0.82, { sub: { w1: "carries on", pending: "98·A: worker 1" } }], [0.98, { sub: { w1: W, w2: W, pending: "who has what" } }]],
  },
  {
    story: 5, dur: 8400, focus: ["polpage", "api", "main"], tables: [],
    title: "Redis is down",
    text: "Nothing is saved without its task: a new policy or description is undone, and the page says try again. The watcher retries its new circulars next round. Redis's lists survive a restart.",
    code: "enqueue_or_undo() · api/database.py · set_company() · api/routes/company.py",
    moves: [["save", "polpage>nginx", 0.02, 0.18, "start"], ["POST", "nginx>api", 0.2, 0.3, "start"], ["XADD ✗", "api>main", 0.34, 0.56, "bad"],
            ["503", "api>nginx", 0.62, 0.76, "bad"], ["try again", "nginx>polpage", 0.8, 0.96, "bad"]],
    marks: [[0.02, { sub: { main: "✗ Redis is down", marks: "✗ down", pending: "✗ down" } }],
            [0.56, { log: ["redis", "SET rci:queued:company_id=1:policy_id=12:type=policy.check … → Error 111: Connection refused", "The api tries to set the mark in Redis, but Redis doesn't answer (error 111: connection refused)."] }],
            [0.96, { sub: { polpage: "try again" },
                     log: ["http", "503  {\"detail\": \"The task queue is unavailable, so nothing was saved: try again\"}", "The api answers 503: the task queue is down, so it undid the save. The page shows the message: try again."] }]],
  },

  // ── 7. Reprocess ──
  {
    story: 6, dur: 8800, focus: ["circpage", "api", "assessments", "checks", "main"], tables: ["assessments", "checks"],
    title: "Reprocess a read circular",
    text: "For your company only: its assessment goes back to pending and its up-to-date verdicts are forgotten. Gaps and out-of-date verdicts stay. No OCR and no summary again.",
    code: "reprocess_circular() · api/routes/circulars.py",
    moves: [["Reprocess 98", "circpage>nginx", 0.02, 0.16, "start"], ["POST", "nginx>api", 0.18, 0.28, "start"],
            ["A · 98: pending", "api>assessments", 0.32, 0.5, "data"], ["forget up to date", "api>checks", 0.42, 0.6, "data"],
            ["circular.assess", "api>main", 0.66, 0.9, "queue"]],
    marks: [[0, { sub: { polpage: "your library", circpage: "the list", main: "rci:tasks", marks: "no duplicates", pending: "who has what" } }],
            [0.5, { rows: { assessments: [A95, B95, ...AB98("pending", "done", ["", "no"]), ...C2("done", "done", ["no", "yes"])] } }],
            [0.6, { rows: { checks: CHECKS_KEPT } }],
            [0.9, { slots: { main: ["98 · A"] }, log: ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type circular.assess company_id 1 circular_id 98", "The api puts one to-do note on the main lane, for your company only: check circular 98 again for company 1 (A). Company 2 (B) gets no note, so its result stays as it was."] }]],
  },
  {
    story: 6, dur: 8800, focus: ["main", "w1", "chat", "checks", "assessments"], tables: ["assessments", "checks"],
    title: "Judged again",
    text: "A worker asks does it apply again, then re-asks only the forgotten pairs still in the top 3: POL-AML and POL-DRP. POL-KYC is skipped: there's one gap per circular and policy, ever.",
    code: "assess(), match() · worker/pipeline.py",
    moves: [["98 · A", "main>w1", 0.02, 0.16, "queue"], ["applies?", "w1>chat", 0.2, 0.34, "ext"], ["yes", "chat>w1", 0.36, 0.48, "ok"],
            ["AML, DRP?", "w1>chat", 0.52, 0.64, "ext"], ["up to date ×2", "chat>w1", 0.66, 0.78, "ok"],
            ["2 verdicts", "w1>checks", 0.8, 0.9, "data"], ["done", "w1>assessments", 0.86, 0.97, "ok"]],
    marks: [[0.02, { slots: { main: [] } }], [0.16, { sub: { w1: "98 · A" } }],
            [0.9, { rows: { checks: [...CHECKS_KEPT, ["98", "POL-AML", "1", "no"], ["98", "POL-DRP", "1", "no"]] } }],
            [0.97, { rows: { assessments: [A95, B95, ...AB98("done", "done", ["yes", "no"]), ...C2("done", "done", ["no", "yes"])] },
                     sub: { w1: W }, log: ["log", "INFO #98 for company 1: applies: True, gaps opened: none", "After Reprocess, company 1 is judged again: it applies, and no new gap (the old one is kept, never duplicated)."] }]],
  },
  {
    story: 6, dur: 9000, focus: ["circpage", "api", "circulars", "pdf", "reader"], tables: ["circulars"],
    title: "Reprocess a failed circular",
    text: "Say circular 99 failed while Floci, the local S3, wasn't running. Start it, then press Reprocess: 99 goes back to new (parsed, had its text been saved) and read 99 goes on the PDF lane.",
    code: "reprocess_circular() · api/routes/circulars.py",
    moves: [["Reprocess 99", "circpage>nginx", 0.02, 0.16, "start"], ["POST", "nginx>api", 0.18, 0.28, "start"],
            ["failed → new", "api>circulars", 0.32, 0.5, "data"], ["read 99", "api>pdf", 0.54, 0.76, "queue"], ["read 99", "pdf>reader", 0.8, 0.96, "queue"]],
    marks: [[0, { rows: { circulars: [C95, C98read, ["99", "failed", "S3 unreachable: Floci wasn't running"], C100("failed", "ValueError: OCR found no text in the PDF")] } }],
            [0.5, { rows: { circulars: [C95, C98read, ["99", "new", "error cleared"], C100("failed", "ValueError: OCR found no text in the PDF")] },
                    sub: { circulars: "99 · new" } }],
            [0.76, { slots: { pdf: ["read 99"] }, log: ["redis", "XADD rci:tasks:pdf MAXLEN ~ 100000 * type circular.read circular_id 99", "Reprocess puts read 99 back on the PDF lane. Any pages already read are reused, not read again."] }],
            [0.8, { slots: { pdf: [] } }], [0.96, { sub: { reader: "reading 99", circpage: "99: reading" } }]],
  },
];

export default {
  id: "system",
  tab: "Whole system",
  hint: "every part, every flow",
  heading: "The whole system, step by step",
  lead: "Every part, and everything it does: a new circular from the regulator's site to a gap on your Gaps page; a company signing up and describing itself; a new policy, the full process; editing a policy; working a gap until it's closed; what happens when something goes wrong; and Reprocess. Click the watcher, the reader, a worker or the api to see that part in detail.",
  label: "The system: the regulators and the watcher top left; Redis's marks, pending lists and rci:dead below them; your team, the console's pages, nginx and the api bottom left; S3, the PDF lane and the reader top middle; the main lane and two workers below; OCR and Gemini top right; and the Postgres tables on the right.",
  size: [1240, 750],
  groups: [[16, 196, 424, 196, "Redis"], [124, 450, 222, 254, "the console"], [900, 40, 324, 166, "Gemini and the GPU"],
           [900, 234, 324, 386, "Postgres"]],
  nodes,
  edges,
  tables,
  quietEdges: true,
  backbone: ["reg>watcher", "watcher>s3", "watcher>pdf", "s3>reader", "pdf>reader", "reader>main", "main>w1", "main>w2", "nginx>api", "api>main",
             ...PAGES.flatMap((p) => [`team>${p}`, `${p}>nginx`])],
  start: { rows: { circulars: [C95], companies: [COMPANY_A, COMPANY_B], policies: [KYC1, DRP, DLP, IT],
                   assessments: [A95, B95], checks: CHECK_START } },
  stories: ["1 · A new circular arrives", "2 · A company signs up and describes itself", "3 · You add a new policy: the full process",
            "4 · You edit a policy", "5 · Your team works a gap", "6 · When something goes wrong", "7 · Reprocess"],
  steps,
};
