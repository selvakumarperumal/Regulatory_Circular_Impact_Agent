/** Reading a real log line piece by piece. The Underneath panel shows a line's plain words,
 * the real line in full, and then each part of it with what that part means:
 *
 *     XADD            add a note to the end of a lane …
 *     rci:tasks       the main lane: the to-do list the workers take from …
 *     MAXLEN ~ 100000 keep only about the newest 100,000 notes …
 *
 * explain(type, text) splits a line by the rules of its kind (a Redis command, SQL, a web
 * request, a log line, a call to Gemini…) and looks its names up in the glossaries below.
 * It returns [[part, meaning], …], or [] for a line it can't read; a log line may also
 * bring its own parts as a fourth element. Keep the glossaries in step with the code:
 * the lane, task, table and column names are the real ones. */

// ── Glossaries ─────────────────────────────────────────────────────────────

const LANE = {
  "rci:tasks": "the main lane: the to-do list in Redis that the workers take quick tasks from (checks and refreshes, seconds each)",
  "rci:tasks:pdf": "the PDF lane: the to-do list in Redis that only the reader takes from, because reading a PDF takes minutes",
  "rci:dead": "the dead list: tasks that failed for good, each kept with its error so you can see what failed and why",
};

const TASK = {
  "circular.read": "read a new circular: OCR its PDF page by page, then Gemini sums it up",
  "circular.assess": "check one circular for one company: does it apply, and which of the company's policies does it leave out of date?",
  "policy.check": "check one new or edited policy against the recent circulars",
  "company.refresh": "the company's description changed, so decide again which recent circulars apply to it",
};

const TABLE = {
  circulars: "One row per circular the watcher found: its links, PDF fingerprint, text, summary and status",
  assessments: "One row per company and circular: does it apply, and is that company's check pending or done?",
  policies: "Each company's policies: code, owner, text, version and their numbers",
  policy_checks: "The verdicts: one per circular, policy and policy version, up to date or out of date",
  gaps: "What a policy misses because of a circular: severity, owner, due date and status",
  gap_events: "Each gap's history: who did what, and when",
  companies: "The companies: name and description",
  users: "The people who can sign in, each in one company",
  controls: "A policy's controls: the regular checks that put it into practice",
  ocr_pages: "The pages OCR has read so far, saved one at a time, so a restart carries on where it stopped",
};

// A column's meaning; "table.column" first when a column means something else in one table.
const COL = {
  id: "the row's id, its number in the table",
  company_id: "which company the row belongs to",
  circular_id: "which circular",
  policy_id: "which policy",
  gap_id: "which gap",
  source: "which regulator: RBI, SEBI or IRDAI",
  source_key: "the regulator's own id for the circular, used to spot ones already saved",
  title: "the title",
  detail_url: "the circular's web page",
  pdf_url: "where the PDF was downloaded from",
  published_at: "the day the regulator published it",
  sha256: "the PDF's fingerprint: a code worked out from its bytes, the same for the same file",
  s3_key: "where the PDF is kept in S3",
  "circulars.status": "how far it has got: new, then parsed (text ready), then read (summarised); or skipped, or failed",
  "assessments.status": "where this company's check stands: pending (still to do) or done",
  "gaps.status": "where the gap stands: open, in_progress or closed",
  status: "where the row has got to",
  "circulars.text": "the circular's full text, from OCR",
  "policies.text": "the policy's own words",
  "ocr_pages.text": "the page's text, as OCR read it",
  text: "the text",
  version: "the policy's version: every edit of its text adds 1",
  embedding: "the numbers (from Gemini) that describe what it means, used to find close policies",
  embeddings: "the numbers (from Gemini) that describe what it means, one list per piece of the policy",
  embedding_model: "which Gemini model made the numbers, so old numbers are never mixed with new ones",
  updated_at: "when the row last changed",
  checked_at: "when the worker last checked it; later than updated_at means the console shows Checked",
  profile: "the company's description, which Gemini reads to decide what applies to it",
  applicable: "does the circular apply to the company? true or false",
  applies_reason: "Gemini's reason for that answer",
  addressed_to: "who the circular is for, in Gemini's words",
  summary: "a short summary, from Gemini",
  requirements: "every obligation in the circular, as a list, from Gemini",
  error: "why it failed",
  code: "the policy's short code",
  "gaps.owner": "who must fix it: the policy's owner",
  owner: "who looks after the policy: its gaps go to this person",
  regulators: "which regulators the policy answers to; only their circulars are compared with it",
  severity: "how serious: high (due in 7 days), medium (30 days) or low (60 days)",
  due_date: "the day it should be fixed by",
  draft_change: "Gemini's suggested new wording for the policy",
  page: "the page number, counting from 0",
  policy_version: "the version of the policy that was judged",
  similarity: "how close the two meanings are, from 0 to 1 (1 would be the same meaning)",
  impacted: "the verdict: true means the policy misses something (out of date)",
  actor: "who did it: a person's email, 'agent' (the worker) or 'system'",
  action: "what happened: opened, status, policy_updated…",
  note: "the details, in words",
  email: "the email you sign in with",
};

// What a few values mean, wherever they appear.
const VALUE = [
  [/^now\(\)$/, "now() is the moment of saving"],
  [/^NULL$/, "NULL means empty: not known yet"],
  [/^today \+ (\d+)$/, (m) => `${m[1]} days from today`],
  [/^\[…\]$/, "the numbers, left out here"],
  [/^'?…'?$/, "left out here"],
];

const FIELD = {
  type: (v) => `the kind of task: ${TASK[v] ?? v}`,
  company_id: (v) => `for company ${v}`,
  circular_id: (v) => `about circular ${v} (its id in Postgres)`,
  policy_id: (v) => `about policy ${v} (its id in Postgres)`,
  stream: (v) => `the lane the task was on: ${LANE[v]?.split(":")[0] ?? v}`,
  task_id: () => "its id on that lane, so you can find it there",
  error: () => "why it failed, in the program's words",
};

const STATUS = {
  200: "200 OK means it worked",
  201: "201 Created means it worked, and something new was saved",
  503: "503 Service Unavailable means the server can't do this right now; try again later",
};

const HOST = {
  "www.rbi.org.in": "RBI's website",
  "rbidocs.rbi.org.in": "RBI's server for PDFs",
  "www.sebi.gov.in": "SEBI's website",
  "irdai.gov.in": "IRDAI's website",
};

const LEVEL = {
  INFO: "a normal line in the program's log: it's going well",
  WARNING: "something went wrong, but it's handled: it will be tried again",
  ERROR: "something failed; the program logs it and carries on with the rest",
};

const ERROR = [
  [/Errno 111|Error 111|Connection refused/, "connection refused: nothing is listening at that address, so the service is down or still starting"],
  [/429|RESOURCE_EXHAUSTED/, "429: Gemini's limit on requests per minute was reached, so it says wait"],
  [/BadReply/, "Gemini answered, but not in the shape that was asked for"],
  [/503/, "503: the site is down for now"],
  [/Could not connect to the endpoint/, "S3 can't be reached: Floci, the local S3, isn't running"],
  [/no PDF link/, "the page has no link to a PDF yet"],
  [/not a PDF/, "the download was a web page, not a PDF: it doesn't start with %PDF"],
  [/no circular links found/, "the page loaded, but no circular links were where they should be: the site's layout probably changed"],
];
const why = (s) => ERROR.find(([re]) => re.test(s))?.[1] ?? "why, in the program's words";

// The functions the lines call, what each does and what each argument is.
const CALL = {
  summarize: ["ask Gemini to read the circular and answer in a fixed shape (JSON): who it's for, a short summary, every obligation",
    ["which circular: its id"]],
  embed: ["ask Gemini's embedding model to turn text into numbers that describe what it means",
    ["the text that's turned into numbers", "a hint for Gemini: these numbers will be used to search for close matches"]],
  check_applicability: ["ask Gemini: does this circular apply to this company?",
    ["the company: Gemini reads its description", "the circular: Gemini reads who it's addressed to and how it starts"]],
  assess: ["ask Gemini: does this policy still cover everything the circular asks?",
    ["the circular: Gemini reads its obligations", "the policy and its version: Gemini reads its text and its controls"]],
  cosine: ["plain arithmetic, no Gemini: how close two lists of numbers are, from 0 to 1 (1 would be the same meaning)",
    ["the circular's numbers", "for each policy, the numbers of its closest piece"]],
  scrypt: ["scramble the password the same slow way as at sign-up, then compare",
    ["the password you typed", "a random value saved with your account, so equal passwords scramble differently",
      "the cost: 2^14 = 16,384 rounds of mixing, slow on purpose so guessing is expensive",
      "the block size, which sets how much memory each try needs", "how many runs side by side"]],
  "jwt.decode": ["check the token's signature, then read what's inside it",
    ["the token your page sent", "the api's secret key, the only key that makes a valid signature", "the signing method"]],
};

const ANSWER = {
  addressed_to: "who the circular is for",
  summary: "a short summary",
  requirements: "every obligation in it, as a list",
  applies_to_company: (v) => (v === "true" ? "the answer: yes, it applies" : "the answer: no, it doesn't apply"),
  reason: "why, in one sentence",
  impacted: (v) => (v === "true" ? "the verdict: out of date, the policy misses something" : "the verdict: up to date"),
  severity: "how serious: high, medium or low",
  missing_from_policy: "what the policy misses",
  draft_change: "a draft of new wording for the policy",
  sub: (v) => `whose token it is: user ${v.replace(/'/g, "")}`,
  exp: "when it stops working",
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Split at `sep`, but not inside quotes or brackets. */
function split(s, sep = ",") {
  const out = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && (quoted || /[\s(=[{,:]/.test(s[i - 1] ?? " "))) quoted = !quoted;
    else if (!quoted && "([{".includes(ch)) depth++;
    else if (!quoted && ")]}".includes(ch)) depth--;
    if (!quoted && depth === 0 && s.startsWith(sep, i)) {
      out.push(cur.trim());
      cur = "";
      i += sep.length - 1;
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const words = (s) => split(s, " ").filter(Boolean);

/** A line may end with a note for the reader, set off by two spaces: "…  (and company 2)". */
function aside(text) {
  const m = text.match(/^(.*?)\s{2,}(\([^()]*\))$/);
  return m ? [m[1], [[m[2], "a note for you, not part of the real line"]]] : [text, []];
}

const left = (part) => [part, part === "…" ? "more of the same, left out here" : ""];
const valueNote = (v) => {
  for (const [re, note] of VALUE) {
    const m = v.match(re);
    if (m) return typeof note === "function" ? note(m) : note;
  }
  return "";
};
const col = (table, c) => COL[`${table}.${c}`] ?? COL[c] ?? "";
const join = (a, b) => (a && b ? `${a}; ${b}` : a || b);

/** "id = 98 AND company_id = 1" → only the rows where id is 98 and company_id is 1. */
function where(cond) {
  const said = cond.split(" AND ").map((c) => {
    let m;
    if ((m = c.match(/^(\w+) = (.+)$/))) return `${m[1]} is ${m[2]}`;
    if ((m = c.match(/^(\w+) <> (.+)$/))) return `${m[1]} isn't ${m[2]}`;
    if ((m = c.match(/^(\w+) IS NOT NULL$/))) return `${m[1]} is filled in`;
    if ((m = c.match(/^(\w+) IN \((.+)\)$/))) return `${m[1]} is ${m[2].replace(/, (?=[^,]*$)/, " or ")}`;
    if ((m = c.match(/^(\w+) < (.+)$/))) return `${m[1]} is earlier than ${m[2].replace(/^\((.*)\)$/, "$1")}`;
    return c;
  });
  const own = /\bcompany_id\b/.test(cond) ? ". The company_id part keeps every company to its own rows" : "";
  return [`WHERE ${cond}`, `which rows: only those where ${said.join(" and ")}${own}`];
}

// ── Redis ──────────────────────────────────────────────────────────────────

function redisId(id) {
  if (id === "…") return left(id);
  return [id, "a note's id: the moment it was added (milliseconds since 1970), a dash, then a counter"];
}

function mark(key) {
  if (!key.startsWith("rci:queued:")) return [key, "the key's name"];
  const f = Object.fromEntries(key.slice(11).split(":").map((kv) => kv.split("=")));
  const what = [f.type, f.company_id && `company ${f.company_id}`, f.circular_id && `circular ${f.circular_id}`,
    f.policy_id && `policy ${f.policy_id}`].filter(Boolean).join(", ");
  return [key, `the mark's name: rci:queued: followed by the task it stands for (${what}). While the mark exists, that task counts as queued`];
}

function redisAnswer(r, op) {
  if (op === "XREADGROUP" && r !== "(nothing)") return [`→ ${r}`, "Redis hands over the note, and writes this member's name next to it on the pending list"];
  if (op === "XAUTOCLAIM" && r !== "(nothing)") return [`→ ${r}`, "Redis hands over the left-behind note, now in this member's name"];
  if (r === "OK") return [`→ ${r}`, "Redis's answer: done. The mark is new, so the task goes on its lane next"];
  if (/^Error 111/.test(r)) return [`→ ${r}`, "no answer: nothing is listening on Redis's port (6379), so Redis is down. Nothing gets queued"];
  if (/^BUSYGROUP/.test(r)) return [`→ ${r}`, "Redis's answer: the group already exists, which is fine: nothing to do"];
  if (r === "(nothing)") return [`→ ${r}`, "Redis's answer: no note"];
  if (/^\d{13}-\d+$/.test(r)) return [`→ ${r}`, "Redis's answer: the note's id, the moment it was added (milliseconds since 1970), then a counter"];
  if (/^\d{13}-\d+ \{/.test(r)) return [`→ ${r}`, "Redis's answer: the note's id, then what the note says"];
  if (/^\{/.test(r)) return [`→ ${r}`, "Redis's answer: what the note says"];
  return [`→ ${r}`, "Redis's answer: the note"];
}

function redisCommand(cmd) {
  const [body, result] = cmd.split(" → ");
  const w = words(body);
  const out = [];
  const lane = (s) => [s, LANE[s] ?? (s === "…" ? "more of the same, left out here" : "")];
  const op = w[0];
  let i = 1;
  if (op === "XADD") {
    out.push(["XADD", w[1] === "rci:dead"
      ? "add a note to the end of a Redis stream, a list that keeps its notes in order: here a copy of the failed task"
      : "add a note to the end of a lane. A lane is a Redis stream: a list that keeps its notes in order. A note holds only a few names and numbers; the data itself stays in Postgres"]);
    out.push(lane(w[i++]));
    if (w[i] === "MAXLEN") {
      out.push([`MAXLEN ${w[i + 1]} ${w[i + 2]}`, `keep only about the newest ${Number(w[i + 2]).toLocaleString("en")} notes and drop older ones, so the lane never fills the memory (~ means about, which is quicker for Redis)`]);
      i += 3;
    }
    if (w[i] === "*") out.push(["*", "let Redis give the note its id: the moment it's added, in milliseconds, then a counter"]), i++;
    for (; i < w.length; i += 2) {
      const [f, v = ""] = [w[i], w[i + 1]];
      out.push([`${f} ${v}`.trim(), FIELD[f]?.(v) ?? (f === "…" ? "more of the same, left out here" : "")]);
    }
  } else if (op === "XACK") {
    out.push(["XACK", "acknowledge: tell Redis these notes are finished, so they leave the pending list for good and are never handed out again"]);
    out.push(lane(w[i++]));
    out.push([w[i++], "the group of readers and workers that took the note"]);
    for (; i < w.length; i++) out.push(redisId(w[i]));
  } else if (op === "XREADGROUP") {
    out.push(["XREADGROUP", "ask for notes as a member of a group: each note goes to one member only, and Redis writes down who has it (the pending list)"]);
    out.push([`GROUP ${w[2]}`, "the group: all readers and workers belong to it"]);
    out.push(w[3] === "…" ? left("…") : [w[3], "who is asking: its container's name, a dash, then a number"]);
    for (i = 4; i < w.length; i++) {
      if (w[i] === "COUNT") out.push([`COUNT ${w[i + 1]}`, w[i + 1] === "1" ? "one note at a time" : `up to ${w[i + 1]} notes`]), i++;
      else if (w[i] === "BLOCK") out.push([`BLOCK ${w[i + 1]}`, `if there is none, wait up to ${Number(w[i + 1]).toLocaleString("en")} ms (${w[i + 1] / 1000} seconds) for one to arrive`]), i++;
      else if (w[i] === "STREAMS") out.push([`STREAMS ${w[i + 1]}`, `from ${LANE[w[i + 1]] ?? w[i + 1]}`]), i++;
      else if (w[i] === ">") out.push([">", "only new notes: ones never handed to anyone yet"]);
      else if (w[i] === "0") out.push(["0", "no new notes: only this member's own pending ones, taken earlier but never finished (say, before a crash)"]);
      else out.push(left(w[i]));
    }
  } else if (op === "XAUTOCLAIM") {
    out.push(["XAUTOCLAIM", "take over notes that another member took but left unfinished for too long (it probably crashed)"]);
    out.push(lane(w[1]), [w[2], "the group"], [w[3], "who takes them over: this member"]);
    out.push([w[4], `only notes nobody has touched for ${Number(w[4]).toLocaleString("en")} ms (${w[4] / 60000} minutes)`]);
    out.push([w[5], "look from the very start of the lane"]);
    if (w[6] === "COUNT") out.push([`COUNT ${w[7]}`, "one note at a time"]);
  } else if (op === "XCLAIM") {
    out.push(["XCLAIM", "claim a note for a member. Claiming its own note again restarts the note's idle clock: “still mine, I'm still working”"]);
    out.push(lane(w[1]), [w[2], "the group"], [w[3], "this member, the one doing the work"]);
    out.push([w[4], "claim it however recently it was touched"], redisId(w[5]));
    if (w[6] === "JUSTID") out.push(["JUSTID", "answer with just the id: no need to send the note back"]);
  } else if (op === "XGROUP") {
    out.push(["XGROUP CREATE", "make a group of members on a lane, so the lane's notes are shared out among them"]);
    out.push(lane(w[2]), [w[3], "the group's name"], [w[4], "the group starts at the lane's first note, so none is missed"]);
    if (w[5] === "MKSTREAM") out.push(["MKSTREAM", "make the lane too, if it doesn't exist yet"]);
  } else if (op === "SET") {
    out.push(["SET", "store a value under a name (a key)"], mark(w[1]));
    for (i = 2; i < w.length; i++) {
      if (w[i] === "1") out.push(["1", "the value. Only the name matters: if it's there, the task is queued"]);
      else if (w[i] === "NX") out.push(["NX", "only if the name isn't there yet (Not eXists). If the mark already exists, nothing is set and the task is not queued twice"]);
      else if (w[i] === "EX") out.push([`EX ${w[i + 1]}`, `forget the mark after ${Number(w[i + 1]).toLocaleString("en")} seconds (a day), so a task that got lost can be queued again`]), i++;
      else out.push(left(w[i]));
    }
  } else if (op === "DEL") {
    out.push(["DEL", "delete a key: here the task's mark. The task is over, so it may be queued again some day (Reprocess, for one)"]);
    out.push(w[1] === "…" ? left("…") : mark(w[1]));
  } else return [];
  if (result) out.push(redisAnswer(result, op));
  return out;
}

function redis(text) {
  const [line, notes] = aside(text);
  return [...line.split(" · ").flatMap(redisCommand), ...notes];
}

// ── Postgres ───────────────────────────────────────────────────────────────

function sqlAnswer(r) {
  const m = r.match(/^id (\d+)$/);
  if (m) return [`→ ${r}`, `Postgres's answer: the new row's id, ${m[1]}`];
  if (r === "(none)") return [`→ ${r}`, "Postgres's answer: no rows match"];
  return [`→ ${r}`, "Postgres's answer, in short"];
}

function assignment(table, a) {
  if (a === "…") return left(a);
  const [c, v] = a.split(/ = (.*)/);
  return [a, join(col(table, c), valueNote(v))];
}

function sql(text) {
  const [line, notes] = aside(text);
  const [stmt, result] = line.split(" → ");
  const out = [];
  let m;
  if (stmt === "COMMIT") {
    out.push(["COMMIT", "save for good, all at once, everything this transaction changed. Until now nobody else could see the changes, and an error would have undone them all"]);
  } else if ((m = stmt.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+))?$/))) {
    out.push([`SELECT ${m[1]}`, m[1] === "*" ? "read whole rows, every column" : `read only these columns: ${m[1]}`]);
    out.push([`FROM ${m[2]}`, `from the table ${m[2]}. ${TABLE[m[2]] ?? ""}`]);
    if (m[3]) out.push(where(m[3]));
  } else if ((m = stmt.match(/^INSERT INTO (\w+) (\([^)]*\)|…) VALUES (.+?)( ON CONFLICT DO NOTHING)?$/))) {
    const [, table, colList, values, conflict] = m;
    out.push([`INSERT INTO ${table}`, `add ${/\), \(/.test(values) ? "new rows" : "a new row"} to the table ${table}. ${TABLE[table] ?? ""}`]);
    const cols = colList === "…" ? ["…"] : split(colList.slice(1, -1));
    const rows = split(values).map((r) => split(r.replace(/^\(|\)$/g, "")));
    if (rows.length === 1 && cols.length === rows[0].length && cols.length > 1) {
      cols.forEach((c, k) => {
        const v = rows[0][k];
        out.push(c === "…" && v === "…" ? ["…", "more columns and values, left out here"] : [`${c}: ${v}`, join(col(table, c), valueNote(v))]);
      });
    } else {
      out.push([colList, colList.includes("…") && cols.length <= 1 ? "the columns being filled in, left out here" : "the columns being filled in"]);
      cols.filter((c) => c !== "…" && col(table, c)).forEach((c) => out.push([c, col(table, c)]));
      if (rows.length > 1) rows.forEach((r) => out.push([`(${r.join(", ")})`, "one new row: its values, in the order of the columns"]));
      else out.push([`VALUES ${values}`, "the values, in the same order as the columns (… is left out here)"]);
    }
    if (conflict) out.push(["ON CONFLICT DO NOTHING", "if that row is already there, leave it alone instead of failing"]);
  } else if ((m = stmt.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/))) {
    out.push([`UPDATE ${m[1]}`, `change rows that are already in the table ${m[1]}. ${TABLE[m[1]] ?? ""}`]);
    out.push(["SET", "the new values, column by column:"]);
    split(m[2]).forEach((a) => out.push(assignment(m[1], a)));
    out.push(where(m[3]));
  } else if ((m = stmt.match(/^DELETE FROM (\w+) WHERE (.+)$/))) {
    out.push([`DELETE FROM ${m[1]}`, `remove rows from the table ${m[1]}. ${TABLE[m[1]] ?? ""}`], where(m[2]));
  } else return [];
  if (result) out.push(sqlAnswer(result));
  return [...out, ...notes];
}

// ── Web requests ───────────────────────────────────────────────────────────

// What the api's addresses do (routes/*.py), without the /api in front.
const ROUTE = [
  [/^\/auth\/login$/, "sign in"],
  [/^\/auth\/signup$/, "sign up, for a new company and its first user"],
  [/^\/gaps$/, "your company's gaps"],
  [/^\/policies$/, "your company's policies, where a POST adds one"],
  [/^\/policies\/(\d+)\/controls$/, (m) => `policy ${m[1]}'s controls, where a POST adds one`],
];
function route(path) {
  for (const [re, said] of ROUTE) {
    const m = path.match(re);
    if (m) return ` (${typeof said === "function" ? said(m) : said})`;
  }
  return "";
}

function address(url) {
  if (url.startsWith("…")) return [url, "the same address as above, with only its end changed"];
  if (url.startsWith("/api/")) return [url, `an address on the api${route(url.slice(4))}. The page sends it to nginx, which passes everything under /api/ on to the api`];
  if (url.startsWith("/")) return [url, `the same address as the api sees it, without /api in front${route(url)}`];
  const host = url.match(/^https?:\/\/([^/]+)/)?.[1];
  return [url, HOST[host] ? `an address on ${HOST[host]}` : "the address asked for"];
}

function http(text) {
  const out = [];
  let m = text.match(/^(INFO) "(\w+) (\S+) (HTTP\/[\d.]+)" (\d{3}) (.+)$/);
  if (m) {
    return [[m[1], LEVEL.INFO], [`"${m[2]} ${m[3]}`, "the request the api just handled"],
      [`${m[4]}"`, "the web protocol's version"], [`${m[5]} ${m[6]}`, STATUS[m[5]] ?? "the answer's status"]];
  }
  const parts = split(text.replace(/ → /g, "  →  "), "  ").filter(Boolean);
  let answered = false;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === "→") {
      if (parts[k + 1] === "nginx") {
        out.push(["→ nginx", "nginx, the web server in front of everything, receives it"]);
        k++;
      } else if (/^api:/.test(parts[k + 1] ?? "")) {
        const [where_, path] = parts[k + 1].split(" ");
        out.push([`→ ${where_}`, "and passes it on to the api, on port 8000 inside Docker"], address(path));
        k++;
      }
      continue;
    }
    if ((m = part.match(/^(GET|POST|PUT|PATCH|DELETE) (\S+)$/))) {
      out.push([m[1], m[1] === "GET" ? "ask for a page or some data, changing nothing" : "send data to be saved or acted on"], address(m[2]));
    } else if ((m = part.match(/^(\d{3})(?: [A-Z][\w ]*?)?(?: \((.+)\))?$/))) {
      answered = true;
      out.push([part.replace(/ \(.+\)$/, ""), `the answer's status: ${STATUS[m[1]] ?? m[1]}`]);
      if (m[2]) out.push([`(${m[2]})`, "a note for you: which listing this was"]);
    } else if (/^Authorization: Bearer/.test(part)) {
      out.push([part, "your login token, sent with every request: it proves who you are. Bearer means whoever holds it is let in, so it's kept secret"]);
    } else if (/^[{[]/.test(part)) {
      out.push([part, answered ? "what came back, as JSON: data written as names and values" : "the data sent along, as JSON: names and values"]);
    } else out.push([part, ""]);
  }
  return out.filter(([, meaning]) => meaning);
}

// ── S3, OCR ────────────────────────────────────────────────────────────────

function s3(text) {
  const m = text.match(/^(PUT|GET) s3:\/\/(\w+)\/(\S+)(?: \((.+)\))?$/);
  if (!m) return [];
  const out = [[m[1], m[1] === "PUT" ? "upload a file" : "download a file"],
    [`s3://${m[2]}`, `the bucket, S3's top-level folder, named ${m[2]}`],
    [m[3], "the file's name: the regulator's folder, then the PDF's fingerprint (sha256), so the same file is only ever stored once"]];
  if (m[4]) out.push([`(${m[4]})`, "the file's type: a PDF"]);
  return out;
}

function ocr(text) {
  const m = text.match(/^POST (http:\/\/ocr:\d+)(\S+)\s{2,}(page \d+)(?: (as a (\d+) DPI PNG))?(?:, (".+"))?$/);
  if (!m) return [];
  const out = [["POST", "send a request"], [m[1], "the OCR service: a reading model on the GPU, in its own container"],
    [m[2], "an address in the shape of OpenAI's chat API: a message in, an answer out"],
    [m[3], "which page of the PDF"]];
  if (m[4]) out.push([m[4], `the page is drawn as a picture, ${m[5]} dots per inch: sharp enough to read small print`]);
  if (m[6]) out.push([m[6], "the instruction sent with the picture: read the document"]);
  return out;
}

// ── Calls: Gemini and friends ──────────────────────────────────────────────

function call(text) {
  const m = text.match(/^([\w.]+)\(/);
  if (!m || !CALL[m[1]]) return null;
  let depth = 0, end = m[0].length - 1;
  for (; end < text.length; end++) {
    if ("([{".includes(text[end])) depth++;
    if (")]}".includes(text[end]) && --depth === 0) break;
  }
  const [what, argMeanings] = CALL[m[1]];
  const out = [[m[1], what]];
  split(text.slice(m[0].length, end)).forEach((a, k) => out.push([a, argMeanings[k] ?? argMeanings.at(-1)]));
  const rest = text.slice(end + 1);
  if (rest.startsWith(" → {")) {
    out.push(["→", "what comes back, as JSON, a field at a time:"]);
    for (const f of split(rest.slice(4, -1))) {
      if (f === "…") { out.push(left(f)); continue; }
      const [k, v] = f.split(/: (.*)/);
      const meaning = ANSWER[k];
      out.push([f, typeof meaning === "function" ? meaning(v) : meaning ?? ""]);
    }
  } else if (rest.startsWith(" → [")) {
    out.push([rest.slice(3), "the answer: a list of 768 numbers. Texts about similar things get similar numbers"]);
  } else if (rest.startsWith(": ")) {
    rest.slice(2).split(" · ").forEach((p) => {
      const [code, score] = p.split(" ");
      out.push([p, `${code}'s closeness: ${score}${p === rest.slice(2).split(" · ")[0] ? ", the closest" : ""}`]);
    });
  } else if (rest.trim()) {
    out.push([rest.trim(), "the result matches the one saved at sign-up, so the password is right"]);
  }
  return out;
}

// ── Log lines ──────────────────────────────────────────────────────────────

const MESSAGE = [
  [/^#(\d+) vs (\S+) v(\d+) \(([\d.]+)\): (GAP|up to date)$/, (m) => [
    [`#${m[1]}`, `circular ${m[1]}`], [`vs ${m[2]} v${m[3]}`, `compared with policy ${m[2]}, version ${m[3]}`],
    [`(${m[4]})`, "how close their meanings are, from 0 to 1. Only the 3 closest policies are sent to Gemini"],
    [m[5], m[5] === "GAP" ? "Gemini's verdict: out of date. The policy misses something, so a gap is opened" : "Gemini's verdict: the policy already covers it, no gap"]]],
  [/^#(\d+) for company (\d+): applies: (True|False), gaps opened: (.+)$/, (m) => [
    [`#${m[1]} for company ${m[2]}`, `circular ${m[1]}, checked for company ${m[2]}`],
    [`applies: ${m[3]}`, m[3] === "True" ? "Gemini said it applies to this company" : "Gemini said it doesn't apply, so no policy is compared"],
    [`gaps opened: ${m[4]}`, m[4] === "none" ? "no new gaps" : "the policies that got a new gap"]]],
  [/^#(\d+) parsed: (\d+) chars$/, (m) => [[`#${m[1]} parsed`, `circular ${m[1]}'s text is ready: its status is now parsed`],
    [`${m[2]} chars`, `the text's length: ${Number(m[2]).toLocaleString("en")} characters, from every page joined together`]]],
  [/^#(\d+) read: (.+)$/, (m) => [[`#${m[1]} read`, `circular ${m[1]} is fully read: summarised and turned into numbers`],
    [m[2], "who it's for, from Gemini's summary"]]],
  [/^#(\d+): (\d+) pages OCR'd before, carrying on$/, (m) => [[`#${m[1]}`, `circular ${m[1]}`],
    [`${m[2]} pages OCR'd before`, "pages already saved in ocr_pages by an earlier try that stopped half-way"],
    ["carrying on", "so it starts at the next page; nothing is read twice"]]],
  [/^embedded (\S+) \((\d+) chunks\) with (\S+)$/, (m) => [[`embedded ${m[1]}`, `policy ${m[1]} now has its numbers`],
    [`(${m[2]} chunks)`, m[2] === "1" ? "it's short, so it stays one piece (up to 5,000 characters), turned into numbers"
      : `it was cut into ${m[2]} pieces of up to 5,000 characters, each turned into numbers`],
    [`with ${m[3]}`, "the Gemini model that made the numbers"]]],
  [/^(\S+) checked, gaps opened: (.+)$/, (m) => [[`${m[1]} checked`, `policy ${m[1]} was compared with the recent circulars`],
    [`gaps opened: ${m[2]}`, m[2] === "none" ? "no new gaps" : "the policies that got a new gap"]]],
  [/^worker (\S+): lanes (\w+), using (\S+), waiting for tasks$/, (m) => [[`worker ${m[1]}`, "its name: its container's name, a dash, then a number"],
    [`lanes ${m[2]}`, m[2] === "pdf" ? "it takes notes only from the PDF lane: this one is the reader" : "it takes notes from the main lane: a worker"],
    [`using ${m[3]}`, "the Gemini model it asks"], ["waiting for tasks", "ready, and idle until a note arrives"]]],
  [/^(RBI|SEBI|IRDAI) new: (.+)$/, (m) => [[`${m[1]} new`, `${m[1]} has a circular the watcher hasn't seen before`], [m[2], "its title"]]],
  [/^(RBI|SEBI|IRDAI): seen=(\d+) new=(\d+) failed=(\d+)$/, (m) => [[`${m[1]}:`, `${m[1]}'s summary for this round`],
    [`seen=${m[2]}`, "circulars on its list"], [`new=${m[3]}`, "new ones saved and queued"], [`failed=${m[4]}`, "ones that failed, tried again next round"]]],
  [/^sleeping (\d+) minutes$/, (m) => [[m[0], `the round is over; the next one starts in ${m[1]} minutes`]]],
  [/^OCR or Gemini unavailable \((.+)\); retrying$/, (m) => [["OCR or Gemini unavailable", "a service the worker needs can't be reached right now"],
    [`(${m[1]})`, why(m[1])], ["retrying", "it keeps the task, waits a minute and tries the same step again"]]],
  [/^(\{.+\}) failed (for good)$/, (m) => [[m[1], "the task, as the worker took it from its lane"],
    [`failed ${m[2]}`, "an error that waiting won't fix, so the worker gives up on this task"]]],
  [/^(\{.+\}) failed \((.+)\); trying again$/, (m) => [[m[1], "the task, as the worker took it from its lane"],
    [`failed (${m[2]})`, why(m[2])], ["trying again", "a hiccup: it tries again at once, up to 3 times"]]],
  [/^(RBI|SEBI|IRDAI) failed \((.+?)\): (.+)$/, (m) => [[`${m[1]} failed`, `one ${m[1]} circular couldn't be saved this round`],
    [`(${m[2]})`, "the circular's page"], [m[3], why(m[3])]]],
  [/^(RBI|SEBI|IRDAI): listing failed: (.+)$/, (m) => [[`${m[1]}: listing failed`, `the watcher couldn't read ${m[1]}'s list of circulars this round`],
    [m[2], why(m[2])]]],
];

function logLine(text) {
  const [line, notes] = aside(text);
  const m = line.match(/^(INFO|WARNING|ERROR) (.+)$/);
  if (!m) {
    const e = line.match(/^(psycopg\.\w+): (.+?) … \((.+)\)$/);
    return e ? [[e[1], "an error from psycopg, the program's link to Postgres: it couldn't talk to the database"],
      [e[2], "Postgres, the container named postgres, didn't answer"], [`(${e[3]})`, "a note for you: what happens next"]] : [];
  }
  const rule = MESSAGE.find(([re]) => re.test(m[2]));
  return [[m[1], LEVEL[m[1]]], ...(rule ? rule[1](m[2].match(rule[0])) : [[m[2], "the message"]]), ...notes];
}

function app(text) {
  const done = call(text);
  if (done) return done;
  let m;
  if ((m = text.match(/^toast: (.+)$/))) return [["toast", "a short message that pops up at the corner of the page"], [m[1], "what it says"]];
  if ((m = text.match(/^docker compose restart (\w+)$/))) return [["docker compose restart", "stop and start a service's container"], [m[1], `the service: the ${m[1]}`]];
  if ((m = text.match(/^cd (\S+) && (uv run python manage\.py) (\w+)$/))) {
    return [[`cd ${m[1]}`, "go to the api's folder"], [m[2], "run the api's manage.py with the api's own Python and packages"],
      [m[3], "the command: find unfinished work in Postgres and queue it again"]];
  }
  if ((m = text.match(/^(\d+) unfinished: (\d+) queued, (\d+) already queued$/))) {
    return [[`${m[1]} unfinished`, "jobs Postgres says aren't finished"], [`${m[2]} queued`, "put back on their lanes"],
      [`${m[3]} already queued`, "skipped, because their mark said they were already waiting"]];
  }
  if ((m = text.match(/^(page \d+): (.+) → (.+)$/))) return [[m[1], "a page of the PDF"], [m[2], "what the page holds"], [`→ ${m[3]}`, "so it's skipped: no GPU time spent on it"]];
  return [];
}

const RULES = { redis, sql, http, s3, ocr, log: logLine, warn: logLine, error: logLine, llm: (t) => call(t) ?? [], app };

/** A real line's parts, each with what it means: [[part, meaning], …], or [] if unknown. */
export function explain(type, text) {
  try {
    return (RULES[type]?.(text) ?? []).filter(([part, meaning]) => part && meaning);
  } catch {
    return [];
  }
}
