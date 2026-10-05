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

// Keys the Redis tab makes to show the other types; the app's own are in LANE and mark().
const KEY = {
  greeting: "the key: any name you choose",
  visits: "the key: a string holding a number",
  jobs: "the key: a list",
  "company:1": "the key: a hash. The colon is only a naming habit, like a folder",
  seen: "the key: a set",
  later: "the key: a sorted set",
  "demo:tasks": "a test stream in database 1, made only to try this out",
};

// What the fields in XINFO's, INFO's and CLIENT LIST's answers mean.
const INFO_FIELD = {
  name: "the group's name",
  consumers: "how many members the group has, old ones included",
  pending: "entries handed out but not acknowledged yet",
  "last-delivered-id": "the newest entry handed out so far",
  "entries-read": "how many entries the group has handed out in all",
  lag: "entries no member has been given yet: 0 means nothing is waiting",
  length: "entries in the stream now",
  "radix-tree-nodes": "the blocks the entries are kept in",
  "entries-added": "entries ever added, trimmed ones included",
  "last-generated-id": "the newest entry's id",
  used_memory_human: "the memory Redis uses: the data and its own bookkeeping",
  maxmemory: "the most it may use; 0 means no limit",
  maxmemory_policy: "what to do when full: noeviction refuses writes and never drops a key",
};
const CLIENT_FIELD = {
  laddr: "the server's own address and port", fd: "the connection's file descriptor on the server", age: "seconds since it connected",
  "lib-name": "the client library, from CLIENT SETINFO", "lib-ver": "its version",
  id: "the connection's number",
  addr: "where it connects from: a container's address and port",
  name: "a name the client may give itself; empty here",
  db: "the database it uses",
  idle: "seconds since its last command",
  cmd: "its last command: here it waits for a task",
};

const SETTING = {
  appendfsync: "how often the AOF is pushed to the disk",
  save: "when to take a snapshot",
};

const ms = (n) => (n >= 86_400_000 ? `${n / 86_400_000} days` : n >= 60_000 ? `${n / 60_000} minutes` : `${n / 1000} seconds`);
const count = (n) => Number(n).toLocaleString("en");

function redisId(id) {
  if (id === "…") return left(id);
  return [id, "a note's id: the moment it was added (milliseconds since 1970), a dash, then a counter"];
}

function mark(key) {
  if (!key.startsWith("rci:queued:")) return [key, LANE[key] ?? KEY[key] ?? "the key's name"];
  const f = Object.fromEntries(key.slice(11).split(":").map((kv) => kv.split("=")));
  const what = [f.type, f.company_id && `company ${f.company_id}`, f.circular_id && `circular ${f.circular_id}`,
    f.policy_id && `policy ${f.policy_id}`].filter(Boolean).join(", ");
  return [key, `the mark's name: rci:queued: followed by the task it stands for (${what}). While the mark exists, that task counts as queued`];
}
const isMark = (key) => key?.startsWith("rci:queued:");
const lane = (s) => [s, LANE[s] ?? KEY[s] ?? (s === "…" ? "more of the same, left out here" : "the stream")];
const integer = (r) => r.match(/^\(integer\) (-?\d+)$/)?.[1];

/** "k v, k v" or "k:v k:v" or "k=v k=v": a piece for each field. */
function fields(text, sep, kv, glossary = INFO_FIELD) {
  return text.split(sep).filter(Boolean).map((f) => {
    if (f === "…") return left(f);
    const k = f.split(kv)[0];
    return [f, glossary[k] ?? ""];
  });
}

/** Redis's answer, read for the command that asked. */
function redisAnswer(r, op, w) {
  const n = integer(r);
  const say = (meaning) => [[`→ ${r}`, meaning]];
  if (/^Error 111/.test(r)) return say("no answer: nothing is listening on Redis's port (6379), so Redis is down. Nothing gets queued");
  if (r === "QUEUED") return say("not run yet: it waits in the batch until EXEC");
  switch (op) {
    case "PING": return say("Redis's answer: it's alive");
    case "SET":
      if (r === "OK") return say(isMark(w[1]) ? "Redis's answer: done. The mark is new, so the task goes on its lane next" : "Redis's answer: done, the value is stored");
      if (r === "(nil)") return say("nothing set: the key is already there, and NX said only if it isn't");
      break;
    case "GET": return say(r === "(nil)" ? "no such key" : "the value stored under the key");
    case "TTL":
      if (n === "-1") return say("-1: the key has no timer and is kept until deleted");
      if (n === "-2") return say("-2: there's no such key");
      return say(`${count(n)} seconds left, about ${Math.round(n / 3600)} hours`);
    case "EXISTS": return say(n === "0" ? "0: no such key" : "1: the key exists");
    case "DEL": return say(`how many keys were deleted: ${n}`);
    case "INCR": return say("the new value");
    case "DBSIZE": return say("how many keys this database holds");
    case "SELECT": return say("done: this connection now uses that database");
    case "TYPE": return say("the type of the value under the key");
    case "SCAN": {
      const m = r.match(/^cursor (\d+), keys: (.+)$/);
      if (m) return [[`→ cursor ${m[1]}`, m[1] === "0" ? "the cursor to carry on from: 0 means the walk is finished" : "the cursor to carry on from, in the next SCAN"],
        [m[2], "the keys found by this call"]];
      break;
    }
    case "LPUSH": return say("the list's length now");
    case "BRPOP": return say("the list it came from, then the item, now taken off the list");
    case "LRANGE": return say("nothing: the list is empty, and an empty list doesn't exist at all");
    case "HSET": return say("how many fields were new");
    case "SADD": return say(n === "0" ? "0: it was already a member, nothing changed" : "1: a new member");
    case "ZADD": return say("how many members were new");
    case "SUBSCRIBE": return say("now listening; this connection is on 1 channel");
    case "PUBLISH": return say(`how many listeners got it: ${n}. Nobody listening would give 0, and the message would be gone`);
    case "XLEN": return say("the number of entries in the stream");
    case "XRANGE": case "XREAD": return say("the entry: its id, then its fields");
    case "XACK": return say(`how many entries left the pending list: ${n}. Sent again, it would be 0`);
    case "XCLAIM": return say("the id of the entry claimed; with JUSTID, only the id comes back");
    case "XGROUP":
      if (/^BUSYGROUP/.test(r)) return say("Redis's answer: the group already exists, which is fine: nothing to do");
      if (w[1] === "DELCONSUMER") return say(`how many entries the member still had pending: ${n}, so nothing was lost`);
      return say("done: the group is made");
    case "XPENDING": {
      const m = r.match(/^(\S+) (\S+) idle (\d+) ms, delivered (\d+)$/);
      if (m) return [["→", "each pending entry, with:"], [m[1], "the entry"], [m[2], "the member that has it"],
        [`idle ${m[3]} ms`, `untouched for ${ms(+m[3])}`], [`delivered ${m[4]}`, `handed out ${m[4] === "1" ? "once" : `${m[4]} times`}`]];
      break;
    }
    case "XINFO":
      if (w[1] === "CONSUMERS") {
        return [["→", "each member, with:"], ...r.split(", ").map((c) => {
          const m = c.match(/^(\S+) pending (\d+) idle (\d+)$/);
          return m ? [c, `a member: ${m[2]} pending, last asked ${ms(+m[3])} ago`] : [c, "more members, left out here"];
        })];
      }
      return [["→", "the answer, a field at a time:"], ...fields(r, ", ", " ")];
    case "INFO": return [["→", "the answer, a field at a time:"], ...fields(r, " ", ":")];
    case "CONFIG": return say("the setting's name, then its value");
    case "BGREWRITEAOF": return say("started: a copy of Redis writes the new files while Redis carries on");
    case "MULTI": return say("the batch has started");
    case "EXEC": return say("every queued command's answer, in order: OK from SET, then the new entry's id from XADD");
    case "REPLICAOF": return say("done: it now copies the other Redis, then follows every write");
    case "CLUSTER": return say("the slot, one of 0 to 16,383, worked out from the key's name");
    case "SLOWLOG": return say("nothing: no command has been slow");
    case "CLIENT": return [["→", "one line per client; this one's fields:"], ...fields(r, " ", "=", CLIENT_FIELD)];
    case "MONITOR": {
      const m = r.match(/^([\d.]+) (\[\S+ \S+\]) (.+)$/);
      if (m) return [[`→ ${m[1]}`, "when: seconds since 1970, to the microsecond"], [m[2], "the database (0), and the client's address"], [m[3], "the command, word by word"]];
      break;
    }
    case "XREADGROUP":
      if (r === "(nil)") return say("nothing new came in time: Redis answers nil, and the worker asks again");
      if (r !== "(nothing)" && w.at(-1) === "0") return say("Redis hands back this member's own pending note; its delivery count goes up by one");
      if (r !== "(nothing)") return say("Redis hands over the note, and writes this member's name next to it on the pending list");
      break;
    case "XAUTOCLAIM":
      if (r !== "(nothing)") return say("Redis hands over the left-behind note, now in this member's name");
      break;
  }
  if (r === "OK") return say("Redis's answer: done");
  if (r === "(nothing)") return say("Redis's answer: no note");
  if (/^\d{13}-\d+$/.test(r)) return say("Redis's answer: the note's id, the moment it was added (milliseconds since 1970), then a counter");
  if (/^\d{13}-\d+ \{/.test(r)) return say("Redis's answer: the note's id, then what the note says");
  return say("Redis's answer");
}

// Each command's parts, from its words w (w[0] is the command).
const COMMAND = {
  PING: () => [["PING", "are you there?"]],
  SET: (w) => {
    if (!isMark(w[1])) return [["SET", "store a value under a name (a key); an old value is replaced"], mark(w[1]), [w[2], "the value"]];
    const out = [["SET", "store a value under a name (a key)"], mark(w[1])];
    for (let i = 2; i < w.length; i++) {
      if (w[i] === "1") out.push(["1", "the value. Only the name matters: if it's there, the task is queued"]);
      else if (w[i] === "NX") out.push(["NX", "only if the name isn't there yet (Not eXists). If the mark already exists, nothing is set and the task is not queued twice"]);
      else if (w[i] === "EX") out.push([`EX ${w[i + 1]}`, `forget the mark after ${count(w[i + 1])} seconds (a day), so a task that got lost can be queued again`]), i++;
      else out.push(left(w[i]));
    }
    return out;
  },
  GET: (w) => [["GET", "read the value stored under a key"], mark(w[1])],
  TTL: (w) => [["TTL", "time to live: how many seconds until the key deletes itself"], mark(w[1])],
  EXISTS: (w) => [["EXISTS", "is there a key with this name?"], mark(w[1])],
  DEL: (w) => [["DEL", isMark(w[1]) || w[1] === "…" ? "delete a key: here the task's mark. The task is over, so it may be queued again some day (Reprocess, for one)" : "delete a key"],
    w[1] === "…" ? left("…") : mark(w[1])],
  INCR: (w) => [["INCR", "add 1 to the number under a key, in one step; a missing key counts as 0"], mark(w[1])],
  DBSIZE: () => [["DBSIZE", "count the keys in the database this connection uses"]],
  SELECT: (w) => [["SELECT", "switch this connection to another database"], [w[1], `database ${w[1]}, one of 0 to 15`]],
  TYPE: (w) => [["TYPE", "what kind of value is under this key?"], mark(w[1])],
  SCAN: (w) => [["SCAN", "walk the keys a few at a time, so other clients never wait"], [w[1], "the cursor: 0 starts at the beginning"],
    [`MATCH ${w[3]}`, "keep only names that fit the pattern; * stands for anything"], [`COUNT ${w[5]}`, "about how many keys to look at in this call: a hint, not a limit"]],
  LPUSH: (w) => [["LPUSH", "push an item onto the left end of a list, making the list if needed"], mark(w[1]), [w[2], "the item"]],
  BRPOP: (w) => [["BRPOP", "take the item at the right end, the oldest, waiting if the list is empty (B for blocking)"], mark(w[1]),
    [w[2], `wait up to ${w[2]} seconds for an item`]],
  LRANGE: (w) => [["LRANGE", "read the items between two positions, without taking them off"], mark(w[1]), [`${w[2]} ${w[3]}`, "from the first item (0) to the last (-1)"]],
  HSET: (w) => [["HSET", "set fields in a hash: a small record under one key"], mark(w[1]),
    ...w.slice(2).reduce((out, f, i) => (i % 2 ? out : [...out, [`${f} ${w[i + 3]}`, "a field and its value"]]), [])],
  SADD: (w) => [["SADD", "add a member to a set, which holds each member only once"], mark(w[1]), [w[2], "the member"]],
  ZADD: (w) => [["ZADD", "add a member to a sorted set, with a score that sets its place"], mark(w[1]),
    [w[2], "the score: here a time, in seconds since 1970"], [w[3], "the member"]],
  SUBSCRIBE: (w) => [["SUBSCRIBE", "start listening on a channel; this connection then only receives"], [w[1], "the channel's name. A channel isn't a key: nothing is stored"]],
  PUBLISH: (w) => [["PUBLISH", "send a message to everyone listening on the channel right now"], [w[1], "the channel"], [w.slice(2).join(" "), "the message"]],
  XADD: (w) => {
    const out = [["XADD", w[1] === "rci:dead"
      ? "add a note to the end of a Redis stream, a list that keeps its notes in order: here a copy of the failed task"
      : w[1].startsWith("rci:tasks")
        ? "add a note to the end of a lane. A lane is a Redis stream: a list that keeps its notes in order. A note holds only a few names and numbers; the data itself stays in Postgres"
        : "add an entry to the end of a stream, a list that keeps its entries in order"], lane(w[1])];
    let i = 2;
    if (w[i] === "MAXLEN") {
      out.push([`MAXLEN ${w[i + 1]} ${w[i + 2]}`, `keep only about the newest ${count(w[i + 2])} notes and drop older ones, so the lane never fills the memory (~ means about, which is quicker for Redis)`]);
      i += 3;
    }
    if (w[i] === "*") out.push(["*", "let Redis give the note its id: the moment it's added, in milliseconds, then a counter"]), i++;
    for (; i < w.length; i += 2) {
      const [f, v = ""] = [w[i], w[i + 1]];
      out.push([`${f} ${v}`.trim(), FIELD[f]?.(v) ?? (f === "…" ? "more of the same, left out here" : "")]);
    }
    return out;
  },
  XLEN: (w) => [["XLEN", "count the entries in a stream"], lane(w[1])],
  XRANGE: (w) => [["XRANGE", "read entries between two ids, without removing them"], lane(w[1]), [w[2], "from the first entry"], [w[3], "to the last"]],
  XREAD: (w) => [["XREAD", "read entries after an id. Every reader gets every entry: there's no sharing out"], ...streamOptions(w, 1)],
  XREADGROUP: (w) => [["XREADGROUP", "ask for notes as a member of a group: each note goes to one member only, and Redis writes down who has it (the pending list)"],
    [`GROUP ${w[2]}`, "the group: all readers and workers belong to it"],
    w[3] === "…" ? left("…") : [w[3], "who is asking: its container's name, a dash, then a number"], ...streamOptions(w, 4)],
  XACK: (w) => [["XACK", "acknowledge: tell Redis these notes are finished, so they leave the pending list for good and are never handed out again"],
    lane(w[1]), [w[2], "the group of readers and workers that took the note"], ...w.slice(3).map(redisId)],
  XPENDING: (w) => [["XPENDING", "list a group's pending entries: handed out, not acknowledged yet"], lane(w[1]), [w[2], "the group"],
    [`${w[3]} ${w[4]}`, "from the first pending entry to the last"], [w[5], `at most ${w[5]} of them`]],
  XAUTOCLAIM: (w) => [["XAUTOCLAIM", "take over notes that another member took but left unfinished for too long (it probably crashed)"],
    lane(w[1]), [w[2], "the group"], [w[3], "who takes them over: this member"],
    [w[4], `only notes nobody has touched for ${count(w[4])} ms (${w[4] / 60000} minutes)`], [w[5], "look from the very start of the lane"],
    ...(w[6] === "COUNT" ? [[`COUNT ${w[7]}`, "one note at a time"]] : [])],
  XCLAIM: (w) => [["XCLAIM", "claim a note for a member. Claiming its own note again restarts the note's idle clock: “still mine, I'm still working”"],
    lane(w[1]), [w[2], "the group"], [w[3], "this member, the one doing the work"], [w[4], "claim it however recently it was touched"], redisId(w[5]),
    ...(w[6] === "JUSTID" ? [["JUSTID", "answer with just the id: no need to send the note back"]] : [])],
  XGROUP: (w) => (w[1] === "DELCONSUMER"
    ? [["XGROUP DELCONSUMER", "remove a member from a group"], lane(w[2]), [w[3], "the group"], [w[4], "the member: an old container's name"]]
    : [["XGROUP CREATE", "make a group of members on a lane, so the lane's notes are shared out among them"], lane(w[2]), [w[3], "the group's name"],
      [w[4], "the group starts at the lane's first note, so none is missed"], ...(w[5] === "MKSTREAM" ? [["MKSTREAM", "make the lane too, if it doesn't exist yet"]] : [])]),
  XINFO: (w) => [[`XINFO ${w[1]}`, { STREAM: "describe a stream", GROUPS: "describe each group on a stream", CONSUMERS: "describe each member of a group" }[w[1]]],
    lane(w[2]), ...(w[3] ? [[w[3], "the group"]] : [])],
  INFO: (w) => [["INFO", "ask the server about itself"], [w[1], `only the ${w[1]} section`]],
  CONFIG: (w) => [["CONFIG GET", "read one of the server's settings"], [w[2], SETTING[w[2]] ?? "the setting"]],
  BGREWRITEAOF: () => [["BGREWRITEAOF", "rewrite the AOF now, in the background (BG)"]],
  MULTI: () => [["MULTI", "start a batch, a transaction: the commands that follow are only queued"]],
  EXEC: () => [["EXEC", "run the whole batch now, with nothing from other clients in between"]],
  REPLICAOF: (w) => [["REPLICAOF", "become a copy of another Redis"], [`${w[1]} ${w[2]}`, `the Redis to copy: host ${w[1]}, port ${w[2]}`]],
  CLUSTER: (w) => [["CLUSTER KEYSLOT", "which of a cluster's 16,384 slots a key belongs in"], lane(w[2])],
  SLOWLOG: (w) => [["SLOWLOG GET", "show the latest commands that took over 10 ms"], [w[2], `at most ${w[2]}`]],
  CLIENT: () => [["CLIENT LIST", "one line for every connected client"]],
  MONITOR: () => [["MONITOR", "print every command any client sends, as it runs"]],
};

/** XREAD's and XREADGROUP's options, from word i on. */
function streamOptions(w, i) {
  const out = [];
  for (; i < w.length; i++) {
    if (w[i] === "COUNT") out.push([`COUNT ${w[i + 1]}`, w[i + 1] === "1" ? "one note at a time" : `up to ${w[i + 1]} notes`]), i++;
    else if (w[i] === "BLOCK") out.push([`BLOCK ${w[i + 1]}`, `if there is none, wait up to ${count(w[i + 1])} ms (${w[i + 1] / 1000} seconds) for one to arrive`]), i++;
    else if (w[i] === "STREAMS") out.push([`STREAMS ${w[i + 1]}`, `from ${LANE[w[i + 1]] ?? w[i + 1]}`]), i++;
    else if (w[i] === ">") out.push([">", "only new notes: ones never handed to anyone yet"]);
    else if (w[i] === "0") out.push(["0", w[0] === "XREAD" ? "from the very start of the stream" : "no new notes: only this member's own pending ones, taken earlier but never finished (say, before a crash)"]);
    else out.push(left(w[i]));
  }
  return out;
}

function redisCommand(cmd) {
  const [body, result] = cmd.split(" → ");
  const w = words(body);
  const parts = COMMAND[w[0]];
  if (!parts) return [];
  return [...parts(w), ...(result ? redisAnswer(result, w[0], w) : [])];
}

function redis(text) {
  const [line, notes] = aside(text);
  return [...line.split(" · ").flatMap(redisCommand), ...notes];
}

// ── Redis in general: the tutorial's commands ──────────────────────────────
// Lines of type "cmd" are read here with general meanings, not this app's lanes and marks.

// What each command does.
const DOES = {
  PING: "are you there?",
  HELLO: "open the conversation: choose the protocol version, and log in if needed",
  "CLIENT SETINFO": "tell the server which client library this connection is",
  "CLIENT LIST": "list every connection, one line each",
  "CLIENT TRACKING": "ask Redis to remember which keys this client reads, and to say when they change",
  SET: "store a value under a key, replacing any old value",
  GET: "read the value under a key",
  SETEX: "store a value with a timer, in one command",
  MSET: "store several keys at once",
  MGET: "read several keys at once",
  DEL: "delete keys",
  UNLINK: "delete keys, freeing their memory in a background thread",
  EXISTS: "count how many of these keys exist",
  TYPE: "say what type of value a key holds",
  RENAME: "give a key a new name",
  TTL: "time to live: seconds left before the key deletes itself",
  EXPIRE: "give a key a timer, in seconds",
  PERSIST: "remove a key's timer",
  INCR: "add 1 to a number, atomically",
  INCRBY: "add to a number, atomically, and answer the new value",
  DECRBY: "take away from a number, atomically",
  APPEND: "add text to the end of a string",
  SCAN: "walk the keys a little at a time, so no client waits",
  RPUSH: "add items at the right end of a list",
  LPUSH: "add items at the left end of a list",
  LRANGE: "read the items between two positions, leaving them there",
  BRPOP: "take the item at the right end, waiting if the list is empty (B for blocking)",
  BLMOVE: "move an item from one list to another in one step, waiting if the first is empty",
  LREM: "remove items equal to a value",
  LTRIM: "keep only the items between two positions",
  HSET: "set fields in a hash",
  HGET: "read one field of a hash",
  HGETALL: "read every field and value of a hash",
  HINCRBY: "add to a number in one field, atomically",
  HDEL: "remove fields from a hash",
  HEXPIRE: "give fields of a hash their own timer",
  HTTL: "seconds left on fields' timers",
  HSCAN: "walk a hash's fields a little at a time",
  SADD: "add members to a set; ones already there are ignored",
  SISMEMBER: "is this a member of the set?",
  SINTER: "the members found in every one of these sets",
  SUNION: "the members found in any of these sets",
  SDIFF: "the members of the first set that aren't in the others",
  ZADD: "add members to a sorted set, each with a score",
  ZINCRBY: "add to a member's score",
  ZRANGE: "read members by place, or by score with BYSCORE",
  ZREVRANGE: "read members by place, counting from the highest score",
  ZREM: "remove members from a sorted set",
  SETBIT: "set one bit of a string to 1 or 0",
  BITCOUNT: "count the bits that are 1",
  PFADD: "add items to a HyperLogLog, which only counts distinct ones",
  PFCOUNT: "about how many distinct items were added",
  GEOADD: "add places to a geo set",
  GEODIST: "the distance between two places",
  GEOSEARCH: "find the places within an area",
  SUBSCRIBE: "listen on channels; the connection then only receives",
  PSUBSCRIBE: "listen on every channel matching a pattern",
  PUBLISH: "send a message to everyone listening on a channel now",
  XADD: "append an entry to a stream",
  XRANGE: "read a stream's entries between two ids",
  XREAD: "read entries after an id; every reader gets every entry",
  "XGROUP CREATE": "make a consumer group on a stream",
  "XGROUP DELCONSUMER": "remove a consumer from a group",
  XREADGROUP: "read entries as one consumer of a group: each entry goes to one consumer",
  XPENDING: "the group's pending list: entries handed out but not acknowledged",
  XACK: "acknowledge entries: done, so they leave the pending list",
  XAUTOCLAIM: "take over entries idle for too long, as another consumer",
  XTRIM: "drop a stream's oldest entries",
  XDEL: "delete entries by id",
  "XINFO GROUPS": "describe each consumer group of a stream",
  MULTI: "start a transaction: what follows is queued, not run",
  EXEC: "run everything queued since MULTI, with nothing else in between",
  WATCH: "watch keys: if any changes before EXEC, the transaction is cancelled",
  EVALSHA: "run a Lua script already loaded in Redis, by its SHA1",
  "SCRIPT LOAD": "load a Lua script and get back its SHA1",
  "FUNCTION LOAD": "load a library of functions into Redis",
  FCALL: "call a loaded function by name",
  "CONFIG SET": "change a setting while Redis runs",
  "CONFIG GET": "read a setting",
  INFO: "ask the server about itself",
  "MEMORY USAGE": "how many bytes a key takes",
  "OBJECT ENCODING": "how Redis stores a value inside",
  BGSAVE: "write a snapshot (RDB) in the background",
  BGREWRITEAOF: "rewrite the append-only file in the background, to make it small again",
  ROLE: "is this server a primary or a replica, and how far along?",
  WAIT: "wait until replicas have every write so far",
  "SENTINEL GET-MASTER-ADDR-BY-NAME": "ask Sentinel where a group's primary is now",
  "CLUSTER KEYSLOT": "which of the cluster's 16,384 slots a key belongs to",
  "ACL SETUSER": "create or change a user and what it may do",
  "SLOWLOG GET": "the latest commands that took over 10 ms",
  MONITOR: "print every command any client sends, as it runs",
  "JSON.SET": "store a JSON document, or a part of one by path",
  "JSON.NUMINCRBY": "add to a number inside a JSON document",
  "FT.CREATE": "make a search index",
  "FT.SEARCH": "search an index",
};

// Positional arguments: a name each; "+" repeats until the end or an option; a name of
// several words takes that many words together.
const ARGS = {
  SET: ["key", "value"], GET: ["key"], SETEX: ["key", "seconds", "value"], MSET: ["key value+"], MGET: ["key+"],
  DEL: ["key+"], UNLINK: ["key+"], EXISTS: ["key+"], TYPE: ["key"], RENAME: ["key", "newkey"], TTL: ["key"],
  EXPIRE: ["key", "seconds"], PERSIST: ["key"], INCR: ["key"], INCRBY: ["key", "by"], DECRBY: ["key", "by"],
  APPEND: ["key", "value"], SCAN: ["cursor"], RPUSH: ["key", "item+"], LPUSH: ["key", "item+"], LRANGE: ["key", "start stop"],
  BRPOP: ["key", "timeout"], BLMOVE: ["key", "destination", "from to", "timeout"], LREM: ["key", "count", "item"], LTRIM: ["key", "start stop"],
  HSET: ["key", "field value+"], HGET: ["key", "field"], HGETALL: ["key"], HINCRBY: ["key", "field", "by"], HDEL: ["key", "field+"],
  HEXPIRE: ["key", "seconds"], HTTL: ["key"], HSCAN: ["key", "cursor"], SADD: ["key", "member+"], SISMEMBER: ["key", "member"],
  SINTER: ["key+"], SUNION: ["key+"], SDIFF: ["key+"], ZADD: ["key", "score member+"], ZINCRBY: ["key", "by", "member"],
  ZRANGE: ["key", "start stop"], ZREVRANGE: ["key", "start stop"], ZREM: ["key", "member+"], SETBIT: ["key", "offset", "bit"],
  BITCOUNT: ["key"], PFADD: ["key", "item+"], PFCOUNT: ["key+"], GEOADD: ["key", "lon lat place+"], GEODIST: ["key", "place", "place", "unit"],
  GEOSEARCH: ["key"], SUBSCRIBE: ["channel+"], PSUBSCRIBE: ["pattern+"], PUBLISH: ["channel", "message"],
  XRANGE: ["key", "start", "end"], "XGROUP CREATE": ["key", "group", "from"], "XGROUP DELCONSUMER": ["key", "group", "consumer"],
  XPENDING: ["key", "group", "start end", "count"], XACK: ["key", "group", "id+"], XAUTOCLAIM: ["key", "group", "consumer", "idle", "scanfrom"],
  XTRIM: ["key"], XDEL: ["key", "id+"], "XINFO GROUPS": ["key"], WATCH: ["key+"], "SCRIPT LOAD": ["script"],
  "FUNCTION LOAD": [], "CONFIG SET": ["setting", "value"], "CONFIG GET": ["setting"], INFO: ["section"], "MEMORY USAGE": ["key"],
  "OBJECT ENCODING": ["key"], WAIT: ["replicas", "ms"], "SENTINEL GET-MASTER-ADDR-BY-NAME": ["name"], "CLUSTER KEYSLOT": ["key"],
  "SLOWLOG GET": ["count"], "CLIENT SETINFO": ["what", "value"], "CLIENT TRACKING": ["onoff"],
  "JSON.SET": ["key", "path", "json"], "JSON.NUMINCRBY": ["key", "path", "by"],
};

// What some of the tutorial's keys are.
const KEY_SAID = [
  [/^views$/, "the key: a counter"], [/^session:/, "the key: one login session"], [/^mode$/, "the key: a setting"],
  [/^greeting$/, "the key: any name you like"], [/^otp:/, "the key: a one-time code"], [/^price:|^bulk:/, "a key"],
  [/^stock:/, "the key: a number in stock"], [/^product:/, "the key: a product, as JSON text"], [/^log:/, "the key: a string that grows"],
  [/^emails:processing$/, "the list of jobs being worked on"], [/^emails$/, "the key: a list used as a job queue"], [/^recent:/, "the key: a list of recent events"],
  [/^user:\d+$/, "the key: one user's record, a hash"], [/^tags:/, "the key: a set of tags"], [/^leaderboard$/, "the key: a sorted set"],
  [/^jobs:later$/, "the key: a sorted set used as a schedule"], [/^active:/, "the key: a bitmap, one bit per user"], [/^visitors:/, "the key: a HyperLogLog"],
  [/^shops$/, "the key: a geo set"], [/^orders:dead$/, "a stream for entries that kept failing"], [/^orders:log$/, "the key: a list"],
  [/^orders$/, "the key: a stream of orders"], [/^cache:/, "the key: a cached copy"], [/^lock:/, "the key: the lock"],
  [/^rate:/, "the key: this user's count for this minute"], [/^item:/, "the key: a JSON document"], [/^temp$/, "the key"],
];
const keySaid = (k) => (k === "…" ? "more, left out here" : KEY_SAID.find(([re]) => re.test(k))?.[1] ?? "the key");

const secs = (n) => (n >= 3600 && n % 3600 === 0 ? `${n / 3600} hour${n === 3600 ? "" : "s"}` : n >= 60 && n % 60 === 0 ? `${n / 60} minute${n === 60 ? "" : "s"}` : `${count(n)} seconds`);
const ARG = {
  key: ([k]) => keySaid(k),
  value: ([v]) => (v === "…" ? "the value, left out here" : "the value"),
  newkey: () => "the new name",
  seconds: ([n]) => secs(+n),
  by: ([n]) => `by ${n}`,
  cursor: ([c]) => (c === "0" ? "the cursor: 0 starts at the beginning" : "the cursor to carry on from"),
  item: () => "an item", member: () => "a member", field: () => "a field", place: () => "a place",
  "key value": () => "a key and its value", "field value": () => "a field and its value", "score member": () => "a score and its member",
  "lon lat place": () => "a place: its longitude, latitude and name",
  "start stop": ([a, b], op, w) => (w?.includes("BYSCORE") ? `scores from ${a} to ${b} (now, in seconds since 1970)`
    : a === "0" && b === "-1" ? "from the first (0) to the last (-1)" : `from position ${a} to ${b}`),
  "from to": ([a, b]) => `take from the ${a.toLowerCase()} end, put at the ${b.toLowerCase()} end`,
  timeout: ([n]) => `wait up to ${n} seconds`,
  count: ([n], op) => (op === "LREM" ? `remove up to ${n}` : op === "XPENDING" ? `at most ${n}` : `at most ${n}`),
  destination: ([k]) => keySaid(k),
  offset: ([n]) => `bit number ${n}`, bit: ([b]) => (b === "1" ? "turn it on" : "turn it off"),
  unit: ([u]) => ({ km: "in kilometres", m: "in metres", mi: "in miles" })[u] ?? "the unit",
  channel: ([c]) => (c.startsWith("__keyevent@") ? "a channel Redis itself publishes on: key events in database 0" : "the channel's name; a channel isn't a key"),
  pattern: () => "a pattern: * matches anything", message: () => "the message",
  start: ([s]) => (s === "-" ? "from the first entry" : "from this id"), end: ([e]) => (e === "+" ? "to the last" : "to this id"),
  group: () => "the consumer group", consumer: () => "the consumer's name", from: ([i]) => (i === "0" ? "start at the stream's first entry" : i === "$" ? "start at the end: only new entries" : "start after this id"),
  "start end": () => "from the first pending entry to the last", id: () => "an entry's id",
  idle: ([n]) => `only entries untouched for ${count(n)} ms (${secs(n / 1000)})`, scanfrom: ([i]) => (i === "0-0" ? "look from the very start" : "look from this id"),
  script: () => "the Lua script's text", setting: ([s]) => SETTING_SAID[s] ?? "the setting", section: ([s]) => `only the ${s} section`,
  replicas: ([n]) => `at least ${n} replica${n === "1" ? "" : "s"}`, ms: ([n]) => `but no longer than ${n} ms`, name: () => "the name of the primary's group",
  what: ([w]) => ({ "LIB-NAME": "the library's name", "LIB-VER": "the library's version" })[w] ?? "what", onoff: ([o]) => (o === "ON" ? "turn it on" : "turn it off"),
  path: ([p]) => (p === "$" ? "the path: $ is the whole document" : "the path to a part of the document"), json: () => "the document, as JSON",
};
const SETTING_SAID = {
  "notify-keyspace-events": "which key events Redis publishes", maxmemory: "the most memory Redis may use",
  "maxmemory-policy": "what to drop when memory is full", appendonly: "the append-only file, on or off", appendfsync: "how often the AOF is pushed to disk",
  save: "when to take snapshots",
};

// Options, wherever they come: how many words follow, and what they mean.
const OPTION = {
  EX: [1, ([n]) => `expire after ${secs(+n)}`], PX: [1, ([n]) => `expire after ${count(n)} ms`],
  NX: [0, (_, op) => (op === "EXPIRE" ? "only if it has no timer yet" : "only if the key doesn't exist yet")],
  MAXLEN: [2, ([t, n]) => (t === "~" ? `keep about the newest ${count(n)} entries (~: roughly, which is cheaper)` : `keep the newest ${count(t)}`)],
  XX: [0, "only if the key already exists"], GET: [0, "and answer with the old value"],
  MATCH: [1, () => "only names matching the pattern; * matches anything"],
  COUNT: [1, ([n], op) => (op === "SCAN" || op === "HSCAN" ? `look at about ${n} per call: a hint, not a limit` : `at most ${n}`)],
  BLOCK: [1, ([n]) => `if there's nothing yet, wait up to ${count(n)} ms`],
  WITHSCORES: [0, "with each member's score"], BYSCORE: [0, "start and stop are scores, not places"],
  WITHDIST: [0, "with each place's distance"], MKSTREAM: [0, "make the stream if it doesn't exist yet"],
  FROMLONLAT: [2, ([a, b]) => `from the point at longitude ${a}, latitude ${b}`], BYRADIUS: [2, ([r, u]) => `within ${r} ${u}`],
  FIELDS: [-1, ([n, ...f]) => `for ${n} field${n === "1" ? "" : "s"}: ${f.join(", ")}`],
  REPLACE: [0, "replace a library of the same name"], DIALECT: [1, ([n]) => `query syntax version ${n}`],
  LIMIT: [2, ([o, c]) => `results ${+o + 1} to ${+o + +c}`], AUTH: [2, ([u]) => `log in as ${u}, with a password`],
};

function argv(s) {
  const out = [];
  let cur = "", depth = 0, quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += s[++i] ?? "";
      else if (ch === quote) quote = "";
    } else if (ch === "\"" && depth === 0) { cur += ch; quote = ch; }
    else if ("{[".includes(ch)) { depth++; cur += ch; }
    else if ("}]".includes(ch)) { depth--; cur += ch; }
    else if (ch === " " && depth === 0) { if (cur) out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const say = (m, ...a) => (typeof m === "function" ? m(...a) : m);

/** XADD, XREAD, XREADGROUP, GEOSEARCH and the rest that don't fit the simple pattern. */
const SPECIAL = {
  XADD: (w) => {
    const out = [["XADD", DOES.XADD], [w[1], keySaid(w[1])]];
    let i = 2;
    if (w[i] === "MAXLEN") { out.push([w.slice(i, i + 3).join(" "), `keep only about the newest ${count(w[i + 2])} entries (~: roughly, which is cheaper)`]); i += 3; }
    if (w[i] === "*") out.push(["*", "let Redis choose the id: the time in ms, then a counter"]), i++;
    for (; i < w.length; i += 2) out.push([`${w[i]} ${w[i + 1] ?? ""}`.trim(), w[i] === "error" ? "a field: why it failed" : "a field and its value"]);
    return out;
  },
  XREAD: (w) => streams(w, 1),
  XREADGROUP: (w) => [["XREADGROUP", DOES.XREADGROUP], [`GROUP ${w[2]} ${w[3]}`, `as consumer ${w[3]} of the group ${w[2]}`], ...streams(w, 4).slice(1)],
  GEOSEARCH: (w) => [["GEOSEARCH", DOES.GEOSEARCH], [w[1], keySaid(w[1])], ...options(w, 2, "GEOSEARCH")],
  EVALSHA: (w) => script(w, "EVALSHA"),
  FCALL: (w) => script(w, "FCALL"),
  HELLO: (w) => [["HELLO", DOES.HELLO], [w[1], w[1] === "3" ? "protocol version 3: RESP3" : "protocol version 2"], ...options(w, 2, "HELLO")],
  "ACL SETUSER": (w) => [["ACL SETUSER", DOES["ACL SETUSER"]], [w[2], "the user's name"], ...w.slice(3).map((rule) => [rule,
    rule === "on" ? "enabled: it may log in" : rule.startsWith(">") ? "add this password" : rule.startsWith("~") ? "a pattern of keys it may touch"
      : rule.startsWith("+@") ? `may run the ${rule.slice(2)} group of commands` : rule.startsWith("+") ? `may run ${rule.slice(1).replace("|", " ").toUpperCase()}` : "a rule"])],
  "FUNCTION LOAD": (w) => [["FUNCTION LOAD", DOES["FUNCTION LOAD"]], ...options(w, 2, "FUNCTION LOAD").filter(([p]) => p === "REPLACE"),
    [w.at(-1), "the library's code: its first line names it (#!lua name=shop)"]],
  "FT.CREATE": (w) => {
    const out = [["FT.CREATE", DOES["FT.CREATE"]], [w[1], "the index's name"]];
    for (let i = 2; i < w.length; i++) {
      if (w[i] === "ON") out.push([`ON ${w[i + 1]}`, `index ${w[i + 1]} documents`]), i++;
      else if (w[i] === "PREFIX") out.push([`PREFIX ${w[i + 1]} ${w[i + 2]}`, `every key whose name starts ${w[i + 2]}`]), i += 2;
      else if (w[i] === "SCHEMA") out.push(["SCHEMA", "the fields to index:"]);
      else if (w[i + 1] === "AS") out.push([w.slice(i, i + 4).join(" "), `${w[i]}, called ${w[i + 2]}, ${w[i + 3] === "TEXT" ? "as text, for word search" : "as a number, for ranges"}`]), i += 3;
    }
    return out;
  },
  "FT.SEARCH": (w) => [["FT.SEARCH", DOES["FT.SEARCH"]], [w[1], "the index"], [w[2], "the query: price from 0 to 40"], ...options(w, 3, "FT.SEARCH")],
};

function streams(w, from) {
  const out = [[w[0], DOES[w[0]]]];
  let i = from;
  while (i < w.length && w[i] !== "STREAMS") {
    const o = OPTION[w[i]];
    out.push([w.slice(i, i + 1 + o[0]).join(" "), say(o[1], w.slice(i + 1, i + 1 + o[0]), w[0])]);
    i += 1 + o[0];
  }
  if (w[i] === "STREAMS") {
    out.push([`STREAMS ${w[i + 1]}`, `from the stream ${w[i + 1]}`]);
    const id = w[i + 2];
    out.push([id, id === ">" ? "only entries never handed to anyone in the group" : id === "$" ? "only entries added from now on"
      : id === "0" && w[0] === "XREADGROUP" ? "not new entries: this consumer's own pending ones" : id === "0" ? "from the very start" : "after this id"]);
  }
  return out;
}

function script(w, op) {
  const keys = +w[2];
  return [[op, DOES[op]], [w[1], op === "EVALSHA" ? "the script's SHA1, its name in Redis's script cache" : "the function's name"],
    [w[2], `${keys} of the arguments that follow ${keys === 1 ? "is a key" : "are keys"}`],
    ...w.slice(3).map((a, k) => [a, k < keys ? `a key the ${op === "FCALL" ? "function" : "script"} uses: KEYS[${k + 1}]` : `an argument: ARGV[${k - keys + 1}]`])];
}

function options(w, i, op) {
  const out = [];
  while (i < w.length) {
    const o = OPTION[w[i]];
    if (!o) { out.push([w[i], ""]); i++; continue; }
    const n = o[0] < 0 ? 1 + +w[i + 1] : o[0];
    out.push([w.slice(i, i + 1 + n).join(" "), typeof o[1] === "function" ? o[1](w.slice(i + 1, i + 1 + n), op) : o[1]]);
    i += 1 + n;
  }
  return out;
}

function generic(op, w, skip) {
  const out = [[op, DOES[op]]];
  let i = skip;
  for (const name of ARGS[op] ?? []) {
    if (i >= w.length) break;
    const base = name.replace(/\+$/, ""), size = base.split(" ").length;
    do {
      if (OPTION[w[i]] && name.endsWith("+")) break;
      out.push([w.slice(i, i + size).join(" "), ARG[base]?.(w.slice(i, i + size), op, w) ?? ""]);
      i += size;
    } while (name.endsWith("+") && i < w.length && !(op === "BRPOP" && i === w.length - 1));
  }
  return [...out, ...options(w, i, op)];
}

/** Redis's answer to a command, in plain words. */
function answer(op, r, w = []) {
  const n = integer(r), nil = r === "(nil)";
  if (op === "INFO") return [["→", "the section's fields, name:value:"], ...fields(r, " ", ":", { ...INFO_FIELD, used_memory: "the memory Redis uses, in bytes: the data and its own bookkeeping",
    used_memory_human: "the same, rounded for people" })];
  if (op === "CLIENT LIST") return [["→", "one line per connection; this one's fields:"], ...fields(r, " ", "=", CLIENT_FIELD)];
  if (op === "MONITOR") {
    const m = r.match(/^([\d.]+) (\[\S+ \S+\]) (.+)$/);
    if (m) return [[`→ ${m[1]}`, "when: seconds since 1970, to the microsecond"], [m[2], "the database (0), then the client's address"], [m[3], "the command, word by word"]];
  }
  if (op === "SET" && r.startsWith("\"") && w.includes("GET")) return [[`→ ${r}`, "the old value, because of GET"]];
  const g = {
    PING: "it's alive: redis-py returns True",
    HELLO: "facts about the server: its version, the protocol, its role…",
    "CLIENT SETINFO": "done", "CLIENT TRACKING": "done: from now on Redis tells this client about changed keys",
    SET: nil ? "nothing set (NX or XX said no): nil, None in Python" : r === "OK" ? "done" : r === "QUEUED" ? "queued in the transaction, not run yet" : "Redis's answer",
    GET: nil ? "no such key: nil, None in Python" : "the value", SETEX: "done", MSET: "done: all set together",
    MGET: "one answer per key, in order; (nil) for a missing one", DEL: `how many keys were deleted: ${n}`, UNLINK: `how many keys were deleted: ${n}`,
    EXISTS: `how many of them exist: ${n}`, TYPE: "the type", RENAME: "done",
    TTL: n === "-1" ? "-1: no timer, it's kept until deleted" : n === "-2" ? "-2: there's no such key" : `${count(n)} seconds left`,
    EXPIRE: r === "QUEUED" ? "queued in the transaction" : n === "1" ? "1: the timer is set" : "0: not set (no key, or NX and it had a timer)",
    PERSIST: "1: the timer is gone", INCR: "the new value", INCRBY: r === "QUEUED" ? "queued in the transaction" : "the new value", DECRBY: r === "QUEUED" ? "queued in the transaction, not run yet" : "the new value",
    APPEND: "the string's new length", SCAN: "the next cursor (0: the walk is done), then the keys found",
    RPUSH: "the list's new length", LPUSH: r === "QUEUED" ? "queued in the transaction" : "the list's new length", LRANGE: "the items, in order",
    BRPOP: "the list it came from, then the item, now off the list", BLMOVE: "the item that moved", LREM: `how many were removed: ${n}`, LTRIM: "done",
    HSET: n === "0" ? "0: no new field; an existing one changed" : `how many fields were new: ${n}`, HGET: "the field's value",
    HGETALL: "each field, then its value; redis-py makes a dict", HINCRBY: "the field's new value", HDEL: `how many fields were removed: ${n}`,
    HEXPIRE: "one answer per field: 1 = timer set", HTTL: "one answer per field: the seconds left", HSCAN: "the next cursor (0: done), then fields and values",
    SADD: `how many members were new: ${n}`, SISMEMBER: n === "1" ? "1: yes" : "0: no", SINTER: "the members in every set",
    SUNION: "the members in any of the sets", SDIFF: "the members only in the first set",
    ZADD: `how many members were new: ${n}`, ZINCRBY: "the member's new score", ZRANGE: "the members asked for", ZREVRANGE: "each member with its score, highest first",
    ZREM: `how many were removed: ${n}`, SETBIT: `the bit's old value: ${n}`, BITCOUNT: `how many bits are 1: ${n}`,
    PFADD: n === "1" ? "1: the count changed" : "0: nothing new", PFCOUNT: `about how many distinct items: ${n}`, GEOADD: `how many places were new: ${n}`,
    GEODIST: "the distance", GEOSEARCH: "each place found, with its distance",
    SUBSCRIBE: "confirmed: subscribed to the channel, and how many this connection listens to", PSUBSCRIBE: "confirmed: the pattern, and how many this connection listens to",
    PUBLISH: `how many listeners got it: ${n}. With nobody listening it'd be 0, and the message gone`,
    XADD: "the new entry's id", XRANGE: "each entry: its id, then its fields", XREAD: nil ? "nothing came in time: nil, an empty list in Python" : "the entries",
    "XGROUP CREATE": "done: the group is made", "XGROUP DELCONSUMER": `how many entries it still had pending: ${n}`,
    XREADGROUP: "the stream, then each entry: its id and fields", XPENDING: "a summary: how many are pending, the lowest and highest id, and how many each consumer has",
    XACK: `how many entries left the pending list: ${n}`, XAUTOCLAIM: "where to carry on (0-0: done), the entries now this consumer's, and any deleted meanwhile",
    XTRIM: `how many entries were dropped: ${n}`, XDEL: `how many were deleted: ${n}`, "XINFO GROUPS": "each group: its name, consumers, pending, last id handed out, entries read and lag",
    MULTI: "the transaction has started", EXEC: nil ? "nil: a watched key changed, so nothing ran" : "one answer per queued command, in order",
    WATCH: "watching", EVALSHA: "the script's answer", "SCRIPT LOAD": "the script's SHA1", "FUNCTION LOAD": "the library's name", FCALL: "the function's answer",
    "CONFIG SET": "done, at once, without a restart", "CONFIG GET": "the setting and its value", INFO: "the section's fields, name:value",
    "MEMORY USAGE": `bytes: ${n}`, "OBJECT ENCODING": "the encoding", BGSAVE: "started: a child process writes the snapshot",
    BGREWRITEAOF: "started: a child process writes the new files", ROLE: "the role, its primary, the link's state, and the replication offset",
    WAIT: `how many replicas have it: ${n}`, "SENTINEL GET-MASTER-ADDR-BY-NAME": "the primary's address and port",
    "CLUSTER KEYSLOT": `the slot: ${n}`, "ACL SETUSER": "done", "SLOWLOG GET": "nothing: no command has been that slow", MONITOR: "one line per command: when, the database and client, then the command",
    "CLIENT LIST": "one line per connection; this one's fields", "JSON.SET": "done", "JSON.NUMINCRBY": "the new number, as JSON", "FT.CREATE": "done: the index is made",
    "FT.SEARCH": "how many matched, then each match's key and fields",
  }[op];
  return [[`→ ${r}`, g ?? "Redis's answer"]];
}

function general(text) {
  const [line, notes] = aside(text);
  if (/^invalidate → /.test(line)) {
    return [["invalidate", "a message Redis pushes on its own (RESP3), unasked: keys this client read have changed"], [line.slice(13), "the keys: drop your local copies"]];
  }
  const [cmd, reply] = line.split(" → ");
  const w = argv(cmd);
  const two = `${w[0]} ${w[1] ?? ""}`;
  const op = DOES[two] || SPECIAL[two] ? two : w[0];
  if (!DOES[op] && !SPECIAL[op]) return [];
  const parts = SPECIAL[op] ? SPECIAL[op](w) : generic(op, w, op.split(" ").length);
  return [...parts, ...(reply ? answer(op, reply, w) : []), ...notes];
}

// Redis's error answers, and redis-py's exceptions
const REDIS_ERROR = {
  NOSCRIPT: "Redis's error: there's no script with that SHA1 in its cache", NOPERM: "Redis's error: this user isn't allowed to do that",
  MOVED: "Redis's error in a cluster: this server doesn't own that slot", CROSSSLOT: "Redis's error in a cluster: the keys are in different slots",
  WRONGTYPE: "Redis's error: the key holds another type", OOM: "Redis's error: memory is full and the policy is noeviction",
};
function redisError(text) {
  let m = text.match(/^(redis\.exceptions\.\w+): (.+)$/);
  if (m) return [[m[1], "the exception redis-py raises"], [m[2], "its message"]];
  m = text.match(/^([A-Z]{3,}) (.+)$/);
  if (!m || !REDIS_ERROR[m[1]]) return null;
  if (m[1] === "MOVED") {
    const [slot, addr] = m[2].split(" ");
    return [["MOVED", REDIS_ERROR.MOVED], [slot, "the slot asked about"], [addr, "the server that owns it now: ask there"]];
  }
  return [[m[1], REDIS_ERROR[m[1]]], [m[2], "the message"]];
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
  [/^Redis unavailable \((.+)\); retrying$/, (m) => [["Redis unavailable", "the worker can't reach Redis"], [`(${m[1]})`, why(m[1])],
    ["retrying", "it waits a minute (RETRY_SECONDS) and tries again; its task stays on the pending list"]]],
  [/^Redis lost (\S+) \((.+)\); making it again$/, (m) => [[`Redis lost ${m[1]}`, "the lane and its group are gone: Redis's data was deleted"],
    [`(${m[2]})`, "NOGROUP: Redis's error when a lane or its group doesn't exist"], ["making it again", "it runs XGROUP CREATE … MKSTREAM: an empty lane and group"]]],
];

// Redis's own log: "1:M 05 Oct 2026 06:24:23.964 * Ready to accept connections tcp"
const ROLE = { M: "M: the server itself", C: "C: a child, a copy of Redis made with fork() to write a file", S: "S: a replica", X: "X: Sentinel" };
const MARK_LEVEL = { "*": "* means a notice: all is well", "#": "# means a warning", "-": "- means a detail", ".": ". means a debug line" };
const SERVER = [
  [/^Ready to accept connections tcp$/, "it's ready: clients can now connect over TCP, on port 6379"],
  [/^DB loaded from append only file: ([\d.]+) seconds$/, (m) => `everything was read back from the AOF into memory, in ${Math.round(m[1] * 1000)} ms`],
  [/^(\d+) changes in (\d+) seconds\. Saving\.\.\.$/, (m) => `the save rule “${m[1]} changes in ${m[2]} seconds” was met, so a snapshot starts`],
  [/^DB saved on disk$/, "the snapshot, dump.rdb, is written"],
  [/^WARNING Memory overcommit must be enabled!/, "Linux's vm.overcommit_memory is 0, so fork() could fail on a big database: a snapshot or a replica would then fail"],
];

function serverLine(text) {
  const m = text.match(/^(\d+):([MCSX]) (\d\d \w{3} \d{4} [\d:.]+) ([*#.-]) (.+)$/);
  if (!m) return null;
  const rule = SERVER.find(([re]) => re.test(m[5]));
  const said = rule ? (typeof rule[1] === "function" ? rule[1](m[5].match(rule[0])) : rule[1]) : "the message";
  const role = m[1] === "1" && m[2] === "C" ? "C: so early in start-up Redis hasn't noted its own process id yet, so it marks the line C" : ROLE[m[2]];
  return [[`${m[1]}:${m[2]}`, `process ${m[1]}${m[1] === "1" ? ", the first in its container" : ""}; ${role}`],
    [m[3], "when, on the container's clock (UTC)"], [m[4], MARK_LEVEL[m[4]]], [m[5], said]];
}

function logLine(text) {
  const server = serverLine(text) ?? redisError(text);
  if (server) return server;
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

const RULES = { redis, cmd: general, sql, http, s3, ocr, log: logLine, warn: logLine, error: logLine, llm: (t) => call(t) ?? [], app };

/** A real line's parts, each with what it means: [[part, meaning], …], or [] if unknown. */
export function explain(type, text) {
  try {
    return (RULES[type]?.(text) ?? []).filter(([part, meaning]) => part && meaning);
  } catch {
    return [];
  }
}
