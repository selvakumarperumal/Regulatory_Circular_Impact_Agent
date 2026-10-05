/** Redis, from zero to advanced: what Redis is, keys and strings (the marks), the other
 * types and why the tasks use a stream, streams (the lanes), consumer groups, crashes and
 * claims, keeping data on disk, and what lies beyond one server. Every command is a real
 * one with Redis's real answer, checked on Redis 7.4 (the redis service); the settings,
 * files and counts are this machine's. The example is the other scenes': circular 98,
 * company 1 and company 2, the reader e02ff2af94f5-1 and workers 4b2f…-1 and a71c…-1. */
import { geometry, node } from "./player.js";

const W = "waiting";
const READER = "e02ff2af94f5-1";
const W1 = "4b2f9c0d1e7a-1";
const W2 = "a71c3e5f0b92-1";
const MARK = "rci:queued:company_id=1:policy_id=11:type=policy.check";
const READ98 = "1790831159691-0";
const A98 = "1790831161204-0";
const B98 = "1790831161207-0";
const READ99 = "1790831165420-0";

const nodes = {
  // who talks to Redis, and where the facts are
  cli: node(116, 92, 168, 56, "start", "you", "redis-cli"),
  watcher: node(116, 190, 168, 52, "svc", "watcher", "queues reads", { link: "watcher" }),
  api: node(116, 286, 168, 52, "svc", "api", "queues checks", { link: "api" }),
  reader: node(116, 382, 168, 52, "svc", "reader", W, { idle: W, link: "worker", mono: true }),
  w1: node(116, 478, 168, 52, "svc", "worker 1", W, { idle: W, link: "worker", mono: true }),
  w2: node(116, 574, 168, 52, "svc", "worker 2", W, { idle: W, link: "worker", mono: true }),
  pg: node(116, 703, 168, 52, "data", "Postgres", "the facts"),
  // the server: one loop runs every command
  loop: node(312, 395, 128, 640, "queue", "command loop", W, { shape: "box", idle: W, mono: true }),
  // keys in database 0
  str: node(522, 108, 236, 50, "queue", "strings", "none yet", { shape: "box", mono: true }),
  marks: node(522, 186, 236, 50, "queue", "marks", "none", { shape: "box", mono: true }),
  pdf: node(522, 278, 236, 76, "queue", "rci:tasks:pdf", "the PDF lane", { slots: 3, mono: true }),
  main: node(522, 380, 236, 76, "queue", "rci:tasks", "the main lane", { slots: 3, mono: true }),
  dead: node(522, 470, 236, 48, "bad", "rci:dead", "nothing given up", { shape: "pipe" }),
  mem: node(765, 120, 182, 56, "queue", "memory", "empty", { shape: "box", mono: true }),
  group: node(765, 278, 182, 60, "queue", "group workers", "not made yet", { shape: "box", mono: true }),
  pel: node(765, 380, 182, 60, "queue", "pending list", "empty", { shape: "box", mono: true }),
  // the other types
  list: node(522, 572, 236, 34, "queue", "jobs", "a list", { inline: true, shape: "pipe" }),
  hash: node(522, 616, 236, 34, "queue", "company:1", "a hash", { inline: true, shape: "box" }),
  set: node(522, 660, 236, 34, "queue", "seen", "a set", { inline: true, shape: "box" }),
  zset: node(522, 704, 236, 34, "queue", "later", "a sorted set", { inline: true, shape: "box" }),
  chan: node(765, 638, 182, 56, "queue", "news", "a pub/sub channel", { shape: "box" }),
  // disk, more servers, and watching it
  aof: node(1062, 106, 292, 56, "data", "appendonlydir/", "every write"),
  rdb: node(1062, 200, 292, 56, "data", "dump.rdb", "a snapshot"),
  replica: node(1062, 352, 292, 40, "queue", "replica", "a live copy", { inline: true, shape: "box" }),
  sentinel: node(1062, 408, 292, 40, "ask", "Sentinel", "watches, promotes", { inline: true }),
  cluster: node(1062, 464, 292, 40, "queue", "Cluster", "keys over servers", { inline: true, shape: "box" }),
  info: node(1062, 606, 292, 40, "ask", "INFO · XINFO", "how it's doing", { inline: true }),
  slow: node(1062, 656, 292, 40, "ask", "SLOWLOG · MONITOR", "what it runs", { inline: true }),
  clients: node(1062, 706, 292, 40, "ask", "CLIENT LIST", "who's connected", { inline: true }),
};

const { at, line, curve, via } = geometry(nodes);
const into = (id) => line(at(id, "r"), at("loop", "l", nodes[id].y - nodes.loop.y));
const from = (id) => line(at("loop", "r", nodes[id].y - nodes.loop.y), at(id, "l"));
/** From the top of the loop, along the corridor at height y, down into a file on the right. */
const disk = (dx, y, to) => {
  const [x0, y0] = at("loop", "t", dx), [x1, y1] = at(to, "l");
  return `M${x0},${y0} C${x0},${y + 10} ${x0 + 6},${y} ${x0 + 22},${y} L${884},${y} C${902},${y} ${900},${y1} ${x1},${y1}`;
};

const edges = {
  "cli>loop": into("cli"),
  "watcher>loop": into("watcher"),
  "api>loop": into("api"),
  "reader>loop": into("reader"),
  "w1>loop": into("w1"),
  "w2>loop": into("w2"),
  "api>pg": curve(at("api", "l"), [12, 286], [12, 703], at("pg", "l", -8)),
  "cli>pg": curve(at("cli", "l"), [4, 92], [4, 703], at("pg", "l", 8)),
  "loop>str": from("str"),
  "loop>marks": from("marks"),
  "loop>pdf": from("pdf"),
  "loop>main": from("main"),
  "loop>dead": from("dead"),
  "loop>list": from("list"),
  "loop>hash": from("hash"),
  "loop>set": from("set"),
  "loop>zset": from("zset"),
  "loop>mem": line(at("loop", "r", -248), at("mem", "l", 27)),
  "loop>chan": line(at("loop", "r", 243), at("chan", "l")),
  "pdf>group": line(at("pdf", "r"), at("group", "l")),
  "main>pel": line(at("main", "r"), at("pel", "l")),
  "group>pel": line(at("group", "b"), at("pel", "t")),
  "loop>aof": disk(18, 52, "aof"),
  "loop>rdb": disk(36, 60, "rdb"),
  "loop>replica": via(at("loop", "r", -66), 329, at("replica", "l")),
  "sentinel>replica": line(at("sentinel", "t"), at("replica", "b")),
  "loop>cluster": via(at("loop", "r", 121), 516, at("cluster", "l")),
};

const tables = {
  config: { title: "this Redis", store: "CONFIG GET", cols: ["setting", "value", "means"] },
  keyspace: { title: "the keys in database 0", store: "SCAN", cols: ["key", "type", "value", "expires in"] },
  turns: { title: "the loop, in order", store: "one thread", cols: ["#", "from", "command", "answer"] },
  types: { title: "Redis's types", store: "TYPE", cols: ["type", "like", "commands", "in this app"] },
  compare: { title: "three ways to queue work", store: "why a stream", cols: ["the tasks need…", "a list", "pub/sub", "a stream + a group"] },
  pdfEntries: { title: "rci:tasks:pdf · its entries", store: "XRANGE", cols: ["entry id", "fields", "pending?"] },
  mainEntries: { title: "rci:tasks · its entries", store: "XRANGE", cols: ["entry id", "fields", "pending?"] },
  idParts: { title: "an entry id, taken apart", store: READ98, cols: ["part", "value", "means"] },
  trim: { title: "how big a lane gets", store: "XINFO STREAM", cols: ["what", "value"] },
  group: { title: "the groups", store: "XINFO GROUPS", cols: ["lane", "last delivered", "pending", "lag", "members"] },
  pel: { title: "the pending lists", store: "XPENDING", cols: ["lane", "entry id", "owner", "idle", "delivered"] },
  consumers: { title: "members of workers on rci:tasks", store: "XINFO CONSUMERS", cols: ["name", "pending", "idle", "who"] },
  beat: { title: "a long task, minute by minute", store: "keep_claimed()", cols: ["time", "what happens", "idle"] },
  idem: { title: "safe to run twice", store: "Postgres", cols: ["step", "already done if…", "so a rerun…"] },
  finish: { title: "finishing a task, in this order", store: "run_task()", cols: ["step", "if Redis fails right after it"] },
  dual: { title: "a save and its task", store: "enqueue_or_undo()", cols: ["step", "if it fails here"] },
  info: { title: "INFO memory", store: "this machine", cols: ["field", "value", "means"] },
  files: { title: "/data, on the redis-data volume", store: "this machine", cols: ["file", "size", "what it is"] },
  persist: { title: "two ways to keep data", store: "redis.conf", cols: ["", "RDB snapshot", "AOF log"] },
  beyond: { title: "beyond one server", store: "not used here", cols: ["feature", "what it does", "for this app"] },
  watch: { title: "asking Redis how it's doing", store: "redis-cli", cols: ["command", "tells you"] },
};

// Rows that come back again and again
const GREETING = ["greeting", "string", "hello", "never"];
const VISITS = ["visits", "string", "2", "never"];
const MARK_ROW = (ttl) => [MARK, "string", "1", ttl];
const COMPANY = ["company:1", "hash", "name A · kind NBFC", "never"];
const SEEN = ["seen", "set", "98", "never"];
const LATER = ["later", "zset", "remind-98 · 1791190800", "never"];
const PDF_KEY = ["rci:tasks:pdf", "stream", "1 entry", "never"];
const MAIN_KEY = ["rci:tasks", "stream", "2 entries", "never"];
const KEYS_3 = [GREETING, VISITS, COMPANY, SEEN, LATER];
const E_READ = (p = "") => [READ98, "type circular.read · circular_id 98", p];
const E_A = (p = "") => [A98, "type circular.assess · company_id 1 · circular_id 98", p];
const E_B = (p = "") => [B98, "type circular.assess · company_id 2 · circular_id 98", p];
const G_PDF = (last, pending, lag, members = "1") => ["rci:tasks:pdf", last, pending, lag, members];
const G_MAIN = (last, pending, lag, members = "2") => ["rci:tasks", last, pending, lag, members];
const P_READ = (idle, owner = READER, n = "1") => ["pdf", READ98, owner, idle, n];
const P_A = (idle, owner = W1, n = "1") => ["main", A98, owner, idle, n];
const P_B = (idle, owner = W2, n = "1") => ["main", B98, owner, idle, n];
const P_99 = (idle) => ["pdf", READ99, READER, idle, "1"];
const BEYOND = [
  ["pipeline", "send many commands, then read all the answers", "not needed: a task is 2 or 3 calls"],
  ["MULTI … EXEC", "run a batch with nothing else in between", "could make SET NX + XADD one step"],
  ["Lua (EVAL)", "a small script that runs inside Redis, atomically", "the same, with an if in the middle"],
  ["replica", "a second Redis copying every write", "one Redis: the tasks can be rebuilt"],
  ["Sentinel", "watches the primary; promotes a replica if it dies", "not needed with one Redis"],
  ["Cluster", "16,384 slots spread over several servers", "far more than this app needs"],
];

const steps = [
  // ── 0. Zero ──
  {
    story: 0, dur: 8200, focus: ["loop", "mem"], tables: ["config"],
    title: "A server that keeps everything in memory",
    text: "Redis is one program, redis-server, here in the container redis (image redis:7-alpine, Redis 7.4). It keeps all its data in RAM, so a command takes microseconds, and it waits for clients on port 6379.",
    code: "redis: · docker-compose.yml",
    moves: [],
    marks: [
      [0.1, { sub: { mem: "1.05 MB of RAM" } }],
      [0.6, { log: ["log", "1:M 05 Oct 2026 06:24:23.964 * Ready to accept connections tcp", "Redis's own log: it has loaded its data from disk and now waits for clients on port 6379. Nothing in it works until this line."] }],
    ],
  },
  {
    story: 0, dur: 7000, focus: ["cli", "loop"], tables: ["config"],
    title: "Ask it something: PING",
    text: "Any program that speaks Redis's protocol can connect: redis-cli in a terminal, or the redis package in Python, as the app does. You send a command, Redis answers. The simplest is PING; the answer is PONG.",
    code: "docker compose exec redis redis-cli",
    moves: [["PING", "cli>loop", 0.05, 0.4, "start"], ["PONG", "loop>cli", 0.5, 0.85, "ok"]],
    marks: [
      [0.4, { sub: { loop: "PING" } }],
      [0.85, { sub: { loop: W }, log: ["redis", "PING → PONG", "You ask “are you there?” and Redis answers PONG. Docker asks the same every 5 seconds: it's the redis service's healthcheck."] }],
    ],
  },
  {
    story: 0, dur: 8600, focus: ["cli", "loop", "str"], tables: ["keyspace"],
    title: "Keys and values: one big dictionary",
    text: "Everything in Redis lives under a key, a name like greeting. SET stores a value under a key; GET reads it back. There are no tables and no queries: you always ask for a key by its exact name.",
    code: "redis-cli",
    moves: [["SET greeting hello", "cli>loop", 0.03, 0.25, "start"], ["store it", "loop>str", 0.28, 0.42, "queue"], ["OK", "loop>cli", 0.44, 0.56, "ok"],
            ["GET greeting", "cli>loop", 0.6, 0.74, "start"], ["\"hello\"", "loop>cli", 0.8, 0.95, "ok"]],
    marks: [
      [0.25, { sub: { loop: "SET" } }],
      [0.42, { sub: { str: "greeting = hello" }, rows: { keyspace: [GREETING] },
               log: ["redis", "SET greeting hello → OK", "Store the text hello under the name greeting. OK means it's done; if greeting already had a value, it's replaced."] }],
      [0.74, { sub: { loop: "GET" } }],
      [0.95, { sub: { loop: W }, log: ["redis", "GET greeting → \"hello\"", "Read the value under greeting back. Had there been no such key, the answer would be (nil): nothing."] }],
    ],
  },
  {
    story: 0, dur: 9000, focus: ["watcher", "api", "reader", "loop"], tables: ["turns"],
    title: "One command at a time",
    text: "Three clients send a command at the same moment. Redis runs them one after another, each to the end, in the order they arrive. So no client ever sees half of a command: each one is atomic. One thread is quick enough for thousands of clients.",
    code: "io-threads 1 · CONFIG GET",
    moves: [["SET … NX", "api>loop", 0.04, 0.26, "queue"], ["XADD", "watcher>loop", 0.06, 0.28, "queue"], ["XREADGROUP", "reader>loop", 0.08, 0.3, "queue"],
            ["OK", "loop>api", 0.38, 0.52, "ok"], ["an id", "loop>watcher", 0.58, 0.72, "ok"], ["a task", "loop>reader", 0.78, 0.92, "ok"]],
    marks: [
      [0.32, { sub: { loop: "1: SET" }, rows: { turns: [["1", "api", "SET rci:queued:… 1 NX EX 86400", "…"], ["2", "watcher", "XADD rci:tasks:pdf * …", "waits"], ["3", "reader", "XREADGROUP … >", "waits"]] } }],
      [0.52, { sub: { loop: "2: XADD" }, rows: { turns: [["1", "api", "SET rci:queued:… 1 NX EX 86400", "OK"], ["2", "watcher", "XADD rci:tasks:pdf * …", "…"], ["3", "reader", "XREADGROUP … >", "waits"]] } }],
      [0.72, { sub: { loop: "3: XREADGROUP" }, rows: { turns: [["1", "api", "SET rci:queued:… 1 NX EX 86400", "OK"], ["2", "watcher", "XADD rci:tasks:pdf * …", "an id"], ["3", "reader", "XREADGROUP … >", "…"]] } }],
      [0.92, { sub: { loop: W }, rows: { turns: [["1", "api", "SET rci:queued:… 1 NX EX 86400", "OK"], ["2", "watcher", "XADD rci:tasks:pdf * …", "an id"], ["3", "reader", "XREADGROUP … >", "a task"]] } }],
    ],
  },
  {
    story: 0, dur: 8200, focus: ["cli", "loop", "str"], tables: ["keyspace"],
    title: "16 databases; the app uses 0",
    text: "A Redis server has 16 numbered databases, 0 to 15, each with its own keys. The app's REDIS_URL, redis://redis:6379/0, ends in 0: database 0. The tests use database 1, so they never touch the real lanes.",
    code: "REDIS_URL · api, worker and watcher config.py",
    moves: [["DBSIZE", "cli>loop", 0.04, 0.2, "start"], ["1", "loop>cli", 0.24, 0.36, "ok"], ["SELECT 1", "cli>loop", 0.42, 0.56, "start"], ["OK", "loop>cli", 0.6, 0.7, "ok"],
            ["DBSIZE", "cli>loop", 0.74, 0.86, "start"], ["0", "loop>cli", 0.88, 0.97, "ok"]],
    marks: [
      [0.36, { log: ["redis", "DBSIZE → (integer) 1", "How many keys database 0 holds: one, greeting."] }],
      [0.7, { log: ["redis", "SELECT 1 → OK", "Switch this connection to database 1. Each connection picks its own; a new one starts in database 0."] }],
      [0.97, { log: ["redis", "DBSIZE → (integer) 0", "Database 1 is empty: its keys are separate from database 0's. That's where the tests write."] }],
    ],
  },

  // ── 1. Keys and strings: the marks ──
  {
    story: 1, dur: 8600, focus: ["api", "loop", "marks"], tables: ["keyspace"],
    title: "Only if it isn't there: SET NX",
    text: "You saved policy 11, so the api wants to queue “check policy 11 for company 1”. First it sets a mark, a key named after the task, with NX: only if no such key exists yet. The answer is OK, so nobody has queued this task: go ahead.",
    code: "enqueue() · common/queue.py",
    moves: [["SET mark NX EX", "api>loop", 0.04, 0.32, "queue"], ["a new key", "loop>marks", 0.36, 0.54, "queue"], ["OK", "loop>api", 0.6, 0.84, "ok"]],
    marks: [
      [0.32, { sub: { loop: "SET … NX" } }],
      [0.54, { sub: { marks: "1 · policy 11 · 86400 s", loop: W }, rows: { keyspace: [GREETING, MARK_ROW("86400 s")] },
               log: ["redis", `SET ${MARK} 1 NX EX 86400 → OK`, "The mark is new, so Redis sets it and answers OK. The api goes on to queue the task itself."] }],
    ],
  },
  {
    story: 1, dur: 8600, focus: ["api", "loop", "marks"], tables: ["keyspace"],
    title: "A second time? Nothing",
    text: "A moment later the same task is asked for again, say a double click on Save. SET NX finds the mark already there, sets nothing and answers nil. enqueue() sees that and queues nothing. Two clients racing can't both get OK: commands run one at a time.",
    code: "enqueue() · common/queue.py",
    moves: [["SET mark NX EX", "api>loop", 0.04, 0.32, "queue"], ["already there", "loop>marks", 0.36, 0.54, "bad"], ["(nil)", "loop>api", 0.6, 0.84, "bad"]],
    marks: [
      [0.32, { sub: { loop: "SET … NX" } }],
      [0.84, { sub: { loop: W }, log: ["redis", `SET ${MARK} 1 NX EX 86400 → (nil)`, "The mark is already there, so nothing is set and Redis answers nil. The task is already queued: enqueue() returns False and adds nothing."] }],
    ],
  },
  {
    story: 1, dur: 8200, focus: ["cli", "loop", "marks", "str"], tables: ["keyspace"],
    title: "A key that forgets itself: TTL",
    text: "EX 86400 gave the mark a timer. TTL shows the seconds left: when it reaches 0, Redis deletes the key by itself. So if a worker dies before deleting a mark, its task is blocked for a day at most. greeting has no timer: -1.",
    code: "key() · common/queue.py",
    moves: [["TTL mark", "cli>loop", 0.04, 0.24, "start"], ["86391", "loop>cli", 0.3, 0.46, "ok"], ["TTL greeting", "cli>loop", 0.54, 0.72, "start"], ["-1", "loop>cli", 0.78, 0.94, "ok"]],
    marks: [
      [0.46, { sub: { marks: "1 · policy 11 · 86391 s" }, rows: { keyspace: [GREETING, MARK_ROW("86391 s")] },
               log: ["redis", `TTL ${MARK} → (integer) 86391`, "9 seconds have passed: the mark has 86,391 seconds, almost a day, left before Redis deletes it on its own."] }],
      [0.94, { log: ["redis", "TTL greeting → (integer) -1", "greeting has no timer: -1 means it's kept until someone deletes it. -2 would mean there's no such key at all."] }],
    ],
  },
  {
    story: 1, dur: 8200, focus: ["cli", "loop", "marks"], tables: ["keyspace"],
    title: "Finding keys: SCAN, never KEYS *",
    text: "Key names are plain text; the colons are only a habit, grouping names like folders: rci:tasks, rci:queued:…. To find keys, SCAN walks them a few at a time and hands back a cursor to carry on from. KEYS * lists them all at once and stalls every client on a big database.",
    code: "redis-cli",
    moves: [["SCAN 0 MATCH rci:queued:*", "cli>loop", 0.04, 0.34, "start"], ["looks", "loop>marks", 0.38, 0.56, "queue"], ["cursor 0 + 1 key", "loop>cli", 0.62, 0.9, "ok"]],
    marks: [
      [0.9, { log: ["redis", `SCAN 0 MATCH rci:queued:* COUNT 100 → cursor 0, keys: ${MARK}`, "Walk the keys from the start (cursor 0), keeping those whose names start rci:queued:. The next cursor is 0 again, so the walk is over: one mark."] }],
    ],
  },
  {
    story: 1, dur: 8200, focus: ["w1", "loop", "marks"], tables: ["keyspace"],
    title: "Done: DEL",
    text: "When a worker has finished checking policy 11, it deletes the mark, so the same check can be queued again after your next edit. EXISTS then answers 0: the key is gone.",
    code: "run_task() · worker/main.py",
    moves: [["DEL mark", "w1>loop", 0.04, 0.26, "queue"], ["delete", "loop>marks", 0.3, 0.46, "queue"], ["(integer) 1", "loop>w1", 0.5, 0.64, "ok"],
            ["EXISTS mark", "cli>loop", 0.7, 0.82, "start"], ["0", "loop>cli", 0.86, 0.96, "ok"]],
    marks: [
      [0.46, { sub: { marks: "none" }, rows: { keyspace: [GREETING] },
               log: ["redis", `DEL ${MARK} → (integer) 1`, "Delete the mark. The answer counts the keys deleted: 1. The task can now be queued again."] }],
      [0.96, { log: ["redis", `EXISTS ${MARK} → (integer) 0`, "Is there a key with this name? 0: no."] }],
    ],
  },
  {
    story: 1, dur: 8200, focus: ["cli", "loop", "str"], tables: ["keyspace"],
    title: "Numbers: INCR",
    text: "A string can hold a number. INCR adds 1 in a single step and answers the new value, so two clients counting at the same time never lose a count. The app doesn't count anything, but counters, rate limits and ids are often made this way.",
    code: "redis-cli",
    moves: [["INCR visits", "cli>loop", 0.04, 0.24, "start"], ["0 → 1", "loop>str", 0.28, 0.42, "queue"], ["1", "loop>cli", 0.44, 0.54, "ok"],
            ["INCR visits", "cli>loop", 0.58, 0.72, "start"], ["1 → 2", "loop>str", 0.74, 0.84, "queue"], ["2", "loop>cli", 0.86, 0.96, "ok"]],
    marks: [
      [0.42, { sub: { str: "greeting · visits = 1" }, rows: { keyspace: [GREETING, ["visits", "string", "1", "never"]] },
               log: ["redis", "INCR visits → (integer) 1", "There was no key visits, so Redis starts from 0, adds 1 and answers 1."] }],
      [0.84, { sub: { str: "greeting · visits = 2" }, rows: { keyspace: [GREETING, VISITS] },
               log: ["redis", "INCR visits → (integer) 2", "Again: 2. Reading, adding and saving happen as one command, so no other client can slip in between."] }],
    ],
  },

  // ── 2. The other types ──
  {
    story: 2, dur: 8600, focus: ["str", "list", "hash", "set", "zset", "chan", "pdf"], tables: ["types"],
    title: "Six kinds of value",
    text: "A key's value has a type, and each type has its own commands. Strings you've seen; there are also lists, hashes, sets, sorted sets and streams, and pub/sub channels, which aren't keys at all. The app uses two: strings (the marks) and streams (the lanes).",
    code: "redis-cli",
    moves: [["TYPE greeting", "cli>loop", 0.05, 0.3, "start"], ["string", "loop>cli", 0.36, 0.6, "ok"]],
    marks: [
      [0.02, { rows: { types: [["string", "a text or a number", "SET GET INCR DEL", "the marks"], ["list", "a queue of items", "LPUSH RPOP BRPOP", "no"],
                                ["hash", "a small record", "HSET HGET HGETALL", "no; an entry is like one"], ["set", "a bag of unique items", "SADD SISMEMBER", "no"],
                                ["sorted set", "items ranked by a score", "ZADD ZRANGE", "no"], ["stream", "a log of entries with ids", "XADD XREADGROUP XACK", "the lanes"],
                                ["pub/sub", "a radio channel, not a key", "PUBLISH SUBSCRIBE", "no"]] } }],
      [0.6, { log: ["redis", "TYPE greeting → string", "TYPE says what kind of value a key holds: greeting is a string."] }],
    ],
  },
  {
    story: 2, dur: 9000, focus: ["cli", "w1", "loop", "list"], tables: ["keyspace"],
    title: "A list: the simplest queue",
    text: "LPUSH puts an item at one end of a list, RPOP takes one from the other: first in, first out. BRPOP waits for an item when the list is empty. Many job queues are just this. And a list that becomes empty is deleted.",
    code: "redis-cli",
    moves: [["LPUSH jobs read-98", "cli>loop", 0.04, 0.26, "start"], ["push", "loop>list", 0.3, 0.44, "queue"], ["BRPOP jobs 5", "w1>loop", 0.52, 0.68, "queue"],
            ["pop", "loop>list", 0.7, 0.8, "queue"], ["read-98", "loop>w1", 0.82, 0.96, "ok"]],
    marks: [
      [0.44, { sub: { list: "read-98" }, rows: { keyspace: [...KEYS_3.slice(0, 2), ["jobs", "list", "read-98", "never"]] },
               log: ["redis", "LPUSH jobs read-98 → (integer) 1", "Push read-98 onto the list jobs, made on the spot. The answer is the list's new length: 1."] }],
      [0.96, { sub: { list: "empty: deleted", w1: "read-98" }, rows: { keyspace: KEYS_3.slice(0, 2) },
               log: ["redis", "BRPOP jobs 5 → jobs, read-98", "Worker 1 takes the oldest item, waiting up to 5 seconds if there's none. The item is removed, and the empty list with it."] }],
    ],
  },
  {
    story: 2, dur: 8200, focus: ["w1", "list", "loop"], tables: ["keyspace"],
    title: "…but a popped item is gone",
    text: "RPOP removes the item. If worker 1 now crashes, read-98 is lost: it's not in the list, and nobody knows worker 1 had it. You can patch this (LMOVE it to a second list while working), but then you write the recovery yourself.",
    code: "redis-cli",
    moves: [["LRANGE jobs 0 -1", "cli>loop", 0.4, 0.62, "start"], ["(empty)", "loop>cli", 0.68, 0.9, "bad"]],
    marks: [
      [0.08, { sub: { w1: "✗ crashed" } }],
      [0.9, { log: ["redis", "LRANGE jobs 0 -1 → (empty array)", "List everything in jobs, from the first item (0) to the last (-1): nothing. read-98 left with worker 1, and worker 1 is gone. The task is lost."] }],
    ],
  },
  {
    story: 2, dur: 9400, focus: ["cli", "loop", "hash", "set", "zset"], tables: ["keyspace"],
    title: "Hashes, sets, sorted sets",
    text: "A hash is a small record under one key: fields and values. A set holds each item once; adding it again changes nothing. A sorted set keeps items in order of a score, handy for “run this later”, with the time as the score.",
    code: "redis-cli",
    moves: [["HSET", "cli>loop", 0.03, 0.18, "start"], ["2 fields", "loop>hash", 0.2, 0.3, "queue"], ["SADD ×2", "cli>loop", 0.36, 0.5, "start"], ["98 once", "loop>set", 0.52, 0.62, "queue"],
            ["ZADD", "cli>loop", 0.68, 0.82, "start"], ["by score", "loop>zset", 0.84, 0.94, "queue"]],
    marks: [
      [0.3, { sub: { hash: "name A, NBFC" }, rows: { keyspace: [...KEYS_3.slice(0, 2), COMPANY] },
              log: ["redis", "HSET company:1 name A kind NBFC → (integer) 2", "Make the hash company:1 with two fields, name and kind. The answer counts the new fields: 2. HGET company:1 kind would answer NBFC."] }],
      [0.62, { sub: { set: "{98}" }, rows: { keyspace: [...KEYS_3.slice(0, 2), COMPANY, SEEN] },
               log: [["redis", "SADD seen 98 → (integer) 1", "Add 98 to the set seen: 1 new member."], ["redis", "SADD seen 98 → (integer) 0", "Add 98 again: 0, it was already there. A set never holds a member twice."]] }],
      [0.94, { sub: { zset: "remind-98 @ 1791190800" }, rows: { keyspace: KEYS_3 },
               log: ["redis", "ZADD later 1791190800 remind-98 → (integer) 1", "Add remind-98 to the sorted set later, with a score: a time in seconds since 1970. ZRANGE later 0 -1 lists members lowest score first."] }],
    ],
  },
  {
    story: 2, dur: 9400, focus: ["w1", "w2", "cli", "loop", "chan"], tables: [],
    title: "Pub/sub: a radio channel",
    text: "SUBSCRIBE listens on a channel; PUBLISH sends a message to everyone listening at that moment. Nothing is stored: a subscriber that's offline misses it for good. Good for live updates, not for work that must get done.",
    code: "redis-cli",
    moves: [["SUBSCRIBE news", "w1>loop", 0.03, 0.18, "queue"], ["SUBSCRIBE news", "w2>loop", 0.05, 0.2, "queue"], ["PUBLISH news …", "cli>loop", 0.3, 0.46, "start"],
            ["on air", "loop>chan", 0.48, 0.6, "queue"], ["message", "loop>w1", 0.64, 0.8, "ok"], ["message", "loop>w2", 0.66, 0.82, "ok"], ["2", "loop>cli", 0.84, 0.96, "ok"]],
    marks: [
      [0.2, { sub: { chan: "2 listening", w1: "listening", w2: "listening" },
              log: ["redis", "SUBSCRIBE news → subscribed to news (1 channel)", "Worker 1 (and worker 2 the same) starts listening on the channel news. From now on, its connection only receives."] }],
      [0.96, { sub: { chan: "0 stored", w1: "got it", w2: "got it" },
               log: ["redis", "PUBLISH news \"circular 98 is read\" → (integer) 2", "Send a message on news. 2 = it reached 2 listeners. With nobody listening the answer would be 0, and the message would be gone."] }],
    ],
  },
  {
    story: 2, dur: 8600, focus: ["list", "chan", "pdf", "main", "group", "pel"], tables: ["compare"],
    title: "Why the tasks use a stream",
    text: "A task must wait until it's done even if no worker is up (pub/sub can't), go to one worker only (a plain read can't), and come back if its worker crashes (a popped list item can't). A stream with a consumer group does all three.",
    code: "common/queue.py",
    moves: [],
    marks: [
      [0.04, { sub: { w1: W, w2: W, chan: "a pub/sub channel", list: "a list" },
               rows: { compare: [["to wait until done", "yes", "no: gone at once", "yes"], ["to go to one worker", "yes", "no: to all", "yes: the group"],
                                  ["to survive a crash", "no: popped is gone", "no", "yes: the pending list"], ["to be read again", "no", "no", "yes: by its id"]] } }],
    ],
  },

  // ── 3. Streams: the lanes ──
  {
    story: 3, dur: 8600, focus: ["watcher", "loop", "pdf"], tables: ["pdfEntries", "keyspace"],
    title: "XADD: an entry at the end",
    text: "The watcher saved circular 98 and queues “read it”. XADD adds an entry to the stream rci:tasks:pdf, making the stream if it doesn't exist. An entry is a few fields and values, like a small hash: the task's type and the circular's id.",
    code: "enqueue() · common/queue.py",
    moves: [["XADD", "watcher>loop", 0.04, 0.3, "queue"], ["an entry", "loop>pdf", 0.34, 0.52, "queue"], [READ98, "loop>watcher", 0.58, 0.86, "ok"]],
    marks: [
      [0.3, { sub: { loop: "XADD" } }],
      [0.52, { sub: { loop: W }, slots: { pdf: ["98"] }, rows: { pdfEntries: [E_READ()], keyspace: [...KEYS_3, PDF_KEY] },
               log: ["redis", `XADD rci:tasks:pdf MAXLEN ~ 100000 * type circular.read circular_id 98 → ${READ98}`, "The watcher adds a to-do note to the PDF lane: read circular 98. Redis answers with the id it gave the entry."] }],
    ],
  },
  {
    story: 3, dur: 8200, focus: ["pdf"], tables: ["idParts", "pdfEntries"],
    title: "The id: when it was added",
    text: "With * Redis picks the id: the time in milliseconds since 1970, a dash, and a counter for entries added in the same millisecond. Ids only grow, so a stream is always in order, and “everything after this id” is a question Redis can answer.",
    code: "XADD … * …",
    moves: [],
    marks: [
      [0.04, { rows: { idParts: [["1790831159691", "milliseconds since 1970", "1 Oct 2026, 10:35:59.691 (IST)"], ["-", "", "a dash"],
                                  ["0", "a counter", "the first entry in that millisecond; the next would be -1"]] } }],
      [0.5, { log: ["redis", "XADD demo:tasks * type circular.assess company_id 2 circular_id 98 → 1791198733778-1", "From a test on this machine, in database 1: two XADDs in the same millisecond. The first got …778-0, this one …778-1: same time, counter 1."] }],
    ],
  },
  {
    story: 3, dur: 8600, focus: ["cli", "loop", "pdf"], tables: ["pdfEntries"],
    title: "Reading doesn't remove: XLEN, XRANGE",
    text: "XLEN counts a stream's entries; XRANGE lists them between two ids, where - and + mean the first and the last. Unlike RPOP, reading leaves every entry in place: a stream is a log you can read again and again.",
    code: "redis-cli",
    moves: [["XLEN", "cli>loop", 0.04, 0.2, "start"], ["1", "loop>cli", 0.24, 0.36, "ok"], ["XRANGE - +", "cli>loop", 0.44, 0.6, "start"], ["reads", "loop>pdf", 0.62, 0.72, "queue"],
            ["the entry", "loop>cli", 0.76, 0.94, "ok"]],
    marks: [
      [0.36, { log: ["redis", "XLEN rci:tasks:pdf → (integer) 1", "How many entries the PDF lane holds: 1."] }],
      [0.94, { log: ["redis", `XRANGE rci:tasks:pdf - + → ${READ98} {type: circular.read, circular_id: 98}`, "Every entry from the first (-) to the last (+), with its fields. It's still there afterwards: reading changes nothing."] }],
    ],
  },
  {
    story: 3, dur: 9000, focus: ["pdf", "main", "mem", "info"], tables: ["trim"],
    title: "MAXLEN ~ 100000: a lane can't fill the memory",
    text: "Entries stay after their task is done, so a stream would grow for ever. MAXLEN ~ 100000 on each XADD drops the oldest. The ~ lets Redis drop only whole blocks (100 entries each), which is much cheaper than keeping exactly 100,000.",
    code: "enqueue() · common/queue.py",
    moves: [["XINFO STREAM", "cli>loop", 0.04, 0.28, "start"], ["looks", "loop>main", 0.3, 0.44, "queue"], ["length 141", "loop>cli", 0.5, 0.8, "ok"]],
    marks: [
      [0.04, { rows: { trim: [["MAXLEN ~ 100000", "keep about the newest 100,000"], ["stream-node-max-entries", "100: entries per block"]] } }],
      [0.8, { rows: { trim: [["MAXLEN ~ 100000", "keep about the newest 100,000"], ["stream-node-max-entries", "100: entries per block"],
                             ["rci:tasks on this machine", "141 entries, in 6 blocks"], ["trimmed so far", "none: far from 100,000"]] },
              log: ["redis", "XINFO STREAM rci:tasks → length 141, radix-tree-nodes 6, entries-added 141, last-generated-id 1791019954089-0", "The real main lane on this machine: 141 entries ever added and all still there, in 6 blocks. Trimming starts only near 100,000."] }],
    ],
  },
  {
    story: 3, dur: 8600, focus: ["w1", "w2", "loop", "pdf"], tables: [],
    title: "XREAD: everyone gets everything",
    text: "Plain XREAD reads a stream from an id onwards and can wait for new entries (BLOCK). But every reader gets every entry: two workers reading this way would both read circular 98. To share work out, you need a consumer group.",
    code: "redis-cli",
    moves: [["XREAD", "w1>loop", 0.04, 0.22, "queue"], ["XREAD", "w2>loop", 0.06, 0.24, "queue"], ["reads", "loop>pdf", 0.28, 0.4, "queue"],
            ["read 98", "loop>w1", 0.46, 0.68, "ok"], ["read 98 too", "loop>w2", 0.5, 0.72, "bad"]],
    marks: [
      [0.68, { sub: { w1: "read 98", w2: "read 98 too" },
               log: ["redis", `XREAD COUNT 1 BLOCK 5000 STREAMS rci:tasks:pdf 0 → ${READ98} {type: circular.read, circular_id: 98}`, "Worker 1 reads the lane from the start (id 0) and gets read 98. Worker 2 sends the same and gets the same entry: the PDF would be read twice."] }],
      [0.98, { sub: { w1: W, w2: W } }],
    ],
  },

  // ── 4. Consumer groups ──
  {
    story: 4, dur: 8600, focus: ["reader", "loop", "group", "pdf"], tables: ["group"],
    title: "XGROUP CREATE: a group on the lane",
    text: "A consumer group is a named reader of a stream that shares its entries out among its members. Every worker makes the group workers as it starts, from id 0, the very beginning. If it's there already, Redis says BUSYGROUP, and that's fine.",
    code: "serve() · worker/main.py",
    moves: [["XGROUP CREATE", "reader>loop", 0.04, 0.3, "queue"], ["a group", "loop>pdf", 0.34, 0.46, "queue"], ["", "pdf>group", 0.46, 0.6, "queue"], ["OK", "loop>reader", 0.66, 0.9, "ok"]],
    marks: [
      [0.6, { sub: { group: "pdf: from 0-0" }, rows: { group: [G_PDF("0-0", "0", "1", "0")] },
              log: ["redis", "XGROUP CREATE rci:tasks:pdf workers 0 MKSTREAM → OK", "Make the group workers on the PDF lane, starting from the first entry (0). MKSTREAM would make the lane too, if it didn't exist."] }],
      [0.92, { log: ["redis", "XGROUP CREATE rci:tasks:pdf workers 0 MKSTREAM → BUSYGROUP Consumer Group name already exists", "What every later start sees: the group exists, so nothing changes. The worker ignores this answer."] }],
    ],
  },
  {
    story: 4, dur: 9000, focus: ["reader", "loop", "pdf", "group", "pel"], tables: ["group", "pdfEntries"],
    title: "XREADGROUP >: the next new entry",
    text: "The reader asks the group for one new entry (>), as the member e02ff2af94f5-1, waiting up to 5 seconds. Redis hands over read 98 and moves the group's last-delivered id to it. A member is made the first time it asks.",
    code: "next_task() · worker/main.py",
    moves: [["XREADGROUP >", "reader>loop", 0.04, 0.26, "queue"], ["next new", "loop>pdf", 0.3, 0.42, "queue"], ["", "pdf>group", 0.42, 0.54, "queue"], ["read 98", "loop>reader", 0.6, 0.86, "ok"]],
    marks: [
      [0.54, { sub: { group: "pdf: …691-0" }, rows: { group: [G_PDF(READ98, "1", "0", "1")], pdfEntries: [E_READ("yes: reader")] } }],
      [0.86, { sub: { reader: "read 98" },
               log: ["redis", `XREADGROUP GROUP workers ${READER} COUNT 1 BLOCK 5000 STREAMS rci:tasks:pdf > → ${READ98} {type: circular.read, circular_id: 98}`, "The reader asks for the next entry nobody in the group has had. It gets read 98."] }],
    ],
  },
  {
    story: 4, dur: 8600, focus: ["group", "pel", "reader"], tables: ["pel"],
    title: "Handed over = written down",
    text: "In the same moment, Redis writes the entry on the group's pending list, the PEL, under the reader's name, with an idle clock and a delivery count. Until it's acknowledged it's the reader's: no other member gets it with >.",
    code: "next_task() · worker/main.py",
    moves: [["written down", "group>pel", 0.06, 0.34, "queue"], ["XPENDING", "cli>loop", 0.44, 0.62, "start"], ["1 entry", "loop>cli", 0.68, 0.92, "ok"]],
    marks: [
      [0.34, { sub: { pel: "read 98 → e02f…-1" }, rows: { pel: [P_READ("0 s")] } }],
      [0.92, { rows: { pel: [P_READ("2.1 s")] },
               log: ["redis", `XPENDING rci:tasks:pdf workers - + 10 → ${READ98} ${READER} idle 2104 ms, delivered 1`, "The pending list, entry by entry: read 98 belongs to the reader, untouched for 2.1 seconds, handed out once."] }],
    ],
  },
  {
    story: 4, dur: 9800, focus: ["reader", "w1", "w2", "loop", "main", "pel"], tables: ["mainEntries", "pel"],
    title: "Two workers, one entry each",
    text: "The reader has read 98: it queues one check per company on the main lane and acknowledges read 98. Worker 1 and worker 2 both ask with >, and the group gives each a different entry: each entry to exactly one member, so both companies are checked at once.",
    code: "next_task() · worker/main.py",
    moves: [["XADD ×2 · XACK", "reader>loop", 0.03, 0.18, "queue"], ["2 entries", "loop>main", 0.2, 0.32, "queue"],
            ["XREADGROUP >", "w1>loop", 0.38, 0.52, "queue"], ["XREADGROUP >", "w2>loop", 0.4, 0.54, "queue"],
            ["", "main>pel", 0.56, 0.66, "queue"], ["98 · 1", "loop>w1", 0.68, 0.86, "ok"], ["98 · 2", "loop>w2", 0.7, 0.88, "ok"]],
    marks: [
      [0.32, { slots: { main: ["98·1", "98·2"], pdf: ["98 ✓"] }, sub: { reader: W, pel: "empty" }, rows: { mainEntries: [E_A(), E_B()], pel: [] },
               log: [["redis", `XADD rci:tasks MAXLEN ~ 100000 * type circular.assess company_id 1 circular_id 98 → ${A98}`, "The reader puts a to-do note on the main lane for company 1: check circular 98."],
                     ["redis", `XADD rci:tasks MAXLEN ~ 100000 * type circular.assess company_id 2 circular_id 98 → ${B98}`, "And a second note, the same but for company 2."],
                     ["redis", `XACK rci:tasks:pdf workers ${READ98} → (integer) 1`, "Then the reader says read 98 is finished: it leaves the PDF lane's pending list. (The next story shows why this comes last.)"]] }],
      [0.66, { sub: { pel: "2 entries out" }, rows: { mainEntries: [E_A("yes: worker 1"), E_B("yes: worker 2")], pel: [P_A("0 s"), P_B("0 s")] } }],
      [0.88, { sub: { w1: "98 · company 1", w2: "98 · company 2" },
               log: [["redis", `XREADGROUP GROUP workers ${W1} COUNT 1 BLOCK 5000 STREAMS rci:tasks > → ${A98} {type: circular.assess, company_id: 1, circular_id: 98}`, "Worker 1 gets the first new entry: check 98 for company 1."],
                     ["redis", `XREADGROUP GROUP workers ${W2} COUNT 1 BLOCK 5000 STREAMS rci:tasks > → ${B98} {type: circular.assess, company_id: 2, circular_id: 98}`, "Worker 2 asks the same way and gets the next one, for company 2. Neither gets the other's."]] }],
    ],
  },
  {
    story: 4, dur: 9000, focus: ["w1", "loop", "pel", "main"], tables: ["pel", "mainEntries"],
    title: "XACK: finished, not deleted",
    text: "Worker 1 has finished company 1's check. XACK takes the entry off the pending list. The entry itself stays in the stream (MAXLEN trims it some day): acknowledging means “done”, not “delete”.",
    code: "run_task() · worker/main.py",
    moves: [["XACK", "w1>loop", 0.04, 0.3, "ok"], ["off the list", "main>pel", 0.34, 0.52, "ok"], ["(integer) 1", "loop>w1", 0.58, 0.84, "ok"]],
    marks: [
      [0.52, { sub: { pel: "1 entry out", w1: W }, slots: { main: ["98·1 ✓", "98·2"] },
               rows: { pel: [P_B("26 s")], mainEntries: [E_A("no: done"), E_B("yes: worker 2")] },
               log: ["redis", `XACK rci:tasks workers ${A98} → (integer) 1`, "Worker 1 says company 1's check is done. 1 entry left the pending list; sent again, the answer would be 0. XLEN still says 2: the entry stays."] }],
    ],
  },
  {
    story: 4, dur: 8600, focus: ["w1", "loop", "main"], tables: [],
    title: "Nothing new? BLOCK waits",
    text: "Worker 1 asks for the next new entry, but there is none. BLOCK 5000 makes Redis hold the question for up to 5 seconds and answer the moment an entry arrives. If none does, the answer is nil, and the worker simply asks again: no busy polling.",
    code: "next_task() · worker/main.py",
    moves: [["XREADGROUP >", "w1>loop", 0.04, 0.2, "queue"], ["(nil) after 5 s", "loop>w1", 0.72, 0.94, "queue"]],
    marks: [
      [0.2, { sub: { loop: "holds w1's ask", w1: "asking…" } }],
      [0.94, { sub: { loop: W, w1: W },
               log: ["redis", `XREADGROUP GROUP workers ${W1} COUNT 1 BLOCK 5000 STREAMS rci:tasks > → (nil)`, "No new entry came within 5 seconds, so Redis answers nil. Other clients were served all along: a waiting ask doesn't hold up the loop."] }],
    ],
  },
  {
    story: 4, dur: 9000, focus: ["cli", "loop", "group", "info"], tables: ["group"],
    title: "XINFO GROUPS: a group at a glance",
    text: "XINFO GROUPS shows each group: its members, how many entries are pending, the last id handed out, and lag: entries no member has been given yet. These are this machine's real lanes, right now: nothing pending, nothing waiting.",
    code: "redis-cli",
    moves: [["XINFO GROUPS", "cli>loop", 0.04, 0.28, "start"], ["looks", "loop>main", 0.3, 0.42, "queue"], ["", "main>pel", 0.42, 0.52, "queue"], ["4 numbers", "loop>cli", 0.58, 0.86, "ok"]],
    marks: [
      [0.86, { sub: { info: "lag 0 · pending 0" }, rows: { group: [G_MAIN("1791019954089-0", "0", "0", "8"), G_PDF("1791019836828-0", "0", "0", "1")] },
               log: ["redis", "XINFO GROUPS rci:tasks → name workers, consumers 8, pending 0, last-delivered-id 1791019954089-0, entries-read 141, lag 0", "The real main lane's group, on this machine: 8 members, nothing pending, the last entry handed out, all 141 entries read, nothing waiting."] }],
    ],
  },
  {
    story: 4, dur: 9000, focus: ["cli", "loop", "group", "info"], tables: ["consumers"],
    title: "Members stay: XINFO CONSUMERS",
    text: "A rebuilt container has a new name, and Redis keeps every member it has seen: 8 on this main lane, most of them old containers with nothing pending. They're harmless. XGROUP DELCONSUMER removes one, safely only when its pending count is 0.",
    code: "redis-cli",
    moves: [["XINFO CONSUMERS", "cli>loop", 0.04, 0.3, "start"], ["8 members", "loop>cli", 0.36, 0.62, "ok"], ["DELCONSUMER", "cli>loop", 0.7, 0.84, "start"], ["0", "loop>cli", 0.86, 0.96, "ok"]],
    marks: [
      [0.62, { rows: { consumers: [[W1, "0", "2 s", "worker 1, now"], [W2, "1", "0.4 s", "worker 2, now"], ["9d04e1b7c2aa-1", "0", "2 days", "an old container"],
                                   ["…5 more", "0", "days", "old containers"]] },
               log: ["redis", `XINFO CONSUMERS rci:tasks workers → ${W1} pending 0 idle 2104, ${W2} pending 1 idle 380, 9d04e1b7c2aa-1 pending 0 idle 172800000, … (8 in all)`, "Each member with its pending count and how long since it last asked. The old ones have nothing pending: nothing is stuck with them."] }],
      [0.96, { rows: { consumers: [[W1, "0", "2 s", "worker 1, now"], [W2, "1", "0.4 s", "worker 2, now"], ["…5 more", "0", "days", "old containers"]] },
               log: ["redis", "XGROUP DELCONSUMER rci:tasks workers 9d04e1b7c2aa-1 → (integer) 0", "Remove an old member. The answer is how many pending entries it had: 0, so nothing was lost by removing it."] }],
    ],
  },

  // ── 5. Advanced ──
  {
    story: 5, dur: 9000, focus: ["w2", "pel", "main"], tables: ["pel"],
    title: "At least once",
    text: "A worker acknowledges only after its work is saved. So if it dies half-way, the entry stays pending and will be handed out again: every task runs at least once, now and then twice. Redis can't promise exactly once; the app makes twice harmless.",
    code: "run_task() · worker/main.py",
    moves: [],
    marks: [
      [0.06, { sub: { w2: "✗ killed" }, rows: { pel: [P_B("30 s")] } }],
      [0.5, { rows: { pel: [P_B("2 min")] } }],
      [0.9, { sub: { pel: "98·2: idle 4 min" }, rows: { pel: [P_B("4 min")] },
              log: ["redis", `XPENDING rci:tasks workers - + 10 → ${B98} ${W2} idle 240000 ms, delivered 1`, "Worker 2 died without XACK, so company 2's check is still pending under its name, untouched for 4 minutes."] }],
    ],
  },
  {
    story: 5, dur: 8600, focus: ["w2", "loop", "pel", "main"], tables: ["pel"],
    title: "Back under its own name: read 0",
    text: "Restarted by Docker, a container keeps its name. Before anything new, the worker reads with 0 instead of >: “my own pending entries”. So it finds the check it was doing and does it again.",
    code: "next_task() · worker/main.py",
    moves: [["XREADGROUP 0", "w2>loop", 0.04, 0.3, "queue"], ["mine?", "main>pel", 0.34, 0.5, "queue"], ["98 · 2 again", "loop>w2", 0.56, 0.84, "ok"]],
    marks: [
      [0.04, { sub: { w2: "restarted" } }],
      [0.84, { sub: { w2: "98 · company 2", pel: "98·2: idle 0" }, rows: { pel: [P_B("0 s", W2, "2")] },
               log: ["redis", `XREADGROUP GROUP workers ${W2} COUNT 1 STREAMS rci:tasks 0 → ${B98} {type: circular.assess, company_id: 2, circular_id: 98}`, "0 instead of >: the worker's own pending entries, from the start. It gets back the check it never finished, delivered now twice."] }],
    ],
  },
  {
    story: 5, dur: 9400, focus: ["w1", "w2", "loop", "pel", "main"], tables: ["pel"],
    title: "Or a new name: XAUTOCLAIM",
    text: "Say instead worker 2's container was rebuilt (up --build): it comes back with a new name, so nobody reads its entry with 0. That's why every worker first asks XAUTOCLAIM: an entry idle for 5 minutes (CLAIM_IDLE_SECONDS) becomes its own, delivered once more.",
    code: "next_task() · worker/main.py",
    moves: [["XAUTOCLAIM 300000", "w1>loop", 0.04, 0.28, "queue"], ["idle ≥ 5 min?", "main>pel", 0.32, 0.5, "queue"], ["98 · 2", "loop>w1", 0.56, 0.84, "ok"]],
    marks: [
      [0.04, { sub: { w2: "new name: 77c1…-1", pel: "98·2: idle 5 min" }, rows: { pel: [P_B("5 min")] } }],
      [0.84, { sub: { w1: "98 · company 2", pel: "98·2 → worker 1" }, rows: { pel: [P_B("0 s", W1, "2")] },
               log: ["redis", `XAUTOCLAIM rci:tasks workers ${W1} 300000 0-0 COUNT 1 → ${B98}`, "Worker 1 looks for an entry nobody has touched for 300,000 ms (5 minutes) and takes it: company 2's check is now worker 1's, delivered twice."] }],
    ],
  },
  {
    story: 5, dur: 9400, focus: ["reader", "loop", "pel", "pdf"], tables: ["beat"],
    title: "A heartbeat: XCLAIM every minute",
    text: "Meanwhile the reader takes read 99, a long PDF: minutes of OCR, and it mustn't look dead. Every 60 seconds it claims its own entry again with XCLAIM, which sets the entry's idle clock back to 0. Only a really dead worker's entry ever gets 5 minutes old.",
    code: "keep_claimed() · worker/main.py",
    moves: [["XCLAIM", "reader>loop", 0.24, 0.38, "queue"], ["idle → 0", "loop>pdf", 0.4, 0.48, "ok"], ["XCLAIM", "reader>loop", 0.64, 0.78, "queue"], ["idle → 0", "loop>pdf", 0.8, 0.88, "ok"]],
    marks: [
      [0.04, { sub: { reader: "read 99: page 1", pel: "read 99 → reader" }, slots: { pdf: ["98 ✓", "99"] },
               rows: { beat: [["10:36:40", "takes read 99", "0 s"]] } }],
      [0.48, { sub: { reader: "read 99: page 9" }, rows: { beat: [["10:36:40", "takes read 99", "0 s"], ["10:37:40", "XCLAIM: still mine", "60 s → 0 s"]] },
               log: ["redis", `XCLAIM rci:tasks:pdf workers ${READER} 0 ${READ99} JUSTID → ${READ99}`, "The reader claims its own entry again. That restarts its idle clock; JUSTID means don't send the entry back, and don't count it as handed out again."] }],
      [0.88, { sub: { reader: "read 99: page 18" }, rows: { beat: [["10:36:40", "takes read 99", "0 s"], ["10:37:40", "XCLAIM: still mine", "60 s → 0 s"],
                                                                   ["10:38:40", "XCLAIM: still mine", "60 s → 0 s"], ["…", "every minute until it's done", "never above 60 s"]] } }],
    ],
  },
  {
    story: 5, dur: 9000, focus: ["w1", "pg", "loop", "pel"], tables: ["idem", "pel"],
    title: "Running twice is harmless",
    text: "Worker 1 now runs company 2's check for the second time. Every step looks in Postgres first: here the first run had saved “doesn't apply”, so Gemini isn't asked again. At least once, with steps that are safe to repeat, works like exactly once.",
    code: "assess() · worker/pipeline.py",
    moves: [["already done?", "w1>loop", 0.04, 0.12, "data"], ["XACK", "w1>loop", 0.66, 0.8, "ok"], ["", "main>pel", 0.82, 0.92, "ok"]],
    marks: [
      [0.04, { rows: { idem: [["OCR a page", "ocr_pages has it", "skips the page"], ["read a circular", "its status is read", "goes straight to its checks"],
                              ["does it apply?", "the assessment has the answer", "doesn't ask Gemini again"], ["judge a policy", "policy_checks has this version", "doesn't ask again"],
                              ["open a gap", "one exists for this circular and policy", "opens none"]],
                       pel: [P_B("3 s", W1, "2"), P_99("20 s")] } }],
      [0.4, { log: ["sql", "SELECT applicable FROM assessments WHERE company_id = 2 AND circular_id = 98 → false", "The first run already saved company 2's answer: the circular doesn't apply. So the check ends here, with nothing paid for twice."] }],
      [0.92, { sub: { w1: W, pel: "read 99 → reader" }, slots: { main: ["98·1 ✓", "98·2 ✓"] }, rows: { pel: [P_99("24 s")] },
               log: ["redis", `XACK rci:tasks workers ${B98} → (integer) 1`, "Done at last: company 2's check leaves the pending list."] }],
    ],
  },
  {
    story: 5, dur: 9800, focus: ["reader", "loop", "marks", "main", "pel"], tables: ["finish"],
    title: "Finishing in an order that loses nothing",
    text: "Read 99 is done. The reader deletes its mark, queues the next tasks (a check per company), and only then sends XACK. If Redis fails anywhere in between, the entry isn't acknowledged yet, so the whole task runs again and no next task is lost.",
    code: "run_task() · worker/main.py",
    moves: [["DEL mark", "reader>loop", 0.03, 0.16, "queue"], ["", "loop>marks", 0.18, 0.26, "queue"], ["SET NX · XADD", "reader>loop", 0.32, 0.48, "queue"], ["", "loop>main", 0.5, 0.6, "queue"],
            ["XACK", "reader>loop", 0.7, 0.84, "ok"], ["", "pdf>group", 0.86, 0.96, "ok"]],
    marks: [
      [0.04, { rows: { finish: [["1. DEL the mark", "the task runs again; its mark comes back"],
                                ["2. queue the next tasks", "runs again; tasks already queued are skipped by their marks (SET NX)"],
                                ["3. XACK", "nothing: it's done"]] } }],
      [0.26, { log: ["redis", "DEL rci:queued:circular_id=99:type=circular.read → (integer) 1", "1. The mark for read 99 is deleted: it may be queued again some day, by Reprocess."] }],
      [0.6, { slots: { main: ["98·2 ✓", "99·1", "99·2"] },
              log: [["redis", "SET rci:queued:circular_id=99:company_id=1:type=circular.assess 1 NX EX 86400 → OK", "2. The next tasks, each queued the usual way: its mark first…"],
                    ["redis", "XADD rci:tasks MAXLEN ~ 100000 * type circular.assess company_id 1 circular_id 99 → 1790831402117-0", "…then its note on the main lane: check circular 99 for company 1. The same follows for company 2."]] }],
      [0.96, { sub: { reader: W, pel: "empty" }, slots: { pdf: ["98 ✓", "99 ✓"] }, rows: { pel: [] },
               log: ["redis", `XACK rci:tasks:pdf workers ${READ99} → (integer) 1`, "3. Last, the acknowledgement. Before this line, a crash means read 99 simply runs again, and nothing it queued is lost or doubled."] }],
    ],
  },
  {
    story: 5, dur: 9400, focus: ["reader", "loop", "dead", "pdf"], tables: [],
    title: "A task that always fails: rci:dead",
    text: "Some tasks fail every time, like a PDF with no text in it. After MAX_TRIES the worker gives up: it adds a copy of the task, with its error, to the stream rci:dead, and acknowledges it, so it isn't handed out over and over.",
    code: "give_up() · worker/main.py",
    moves: [["XADD rci:dead", "reader>loop", 0.04, 0.3, "bad"], ["a copy + error", "loop>dead", 0.34, 0.52, "bad"], ["XACK", "reader>loop", 0.6, 0.76, "ok"], ["(integer) 1", "loop>reader", 0.8, 0.94, "ok"]],
    marks: [
      [0.04, { sub: { reader: "read 100: no text" }, slots: { pdf: ["98 ✓", "99 ✓", "100"] } }],
      [0.52, { sub: { dead: "circular 100 · its error" },
               log: ["redis", "XADD rci:dead * type circular.read circular_id 100 stream rci:tasks:pdf task_id 1790831470001-0 error 'ValueError: OCR found no text in the PDF' → 1790831470512-0", "The failed task goes to rci:dead with its lane, its id and the error, so nothing fails silently. XRANGE rci:dead - + lists them."] }],
      [0.94, { sub: { reader: W }, slots: { pdf: ["98 ✓", "99 ✓", "100 ✗"] },
               log: ["redis", "XACK rci:tasks:pdf workers 1790831470001-0 → (integer) 1", "Then it's acknowledged: finished, even though it failed, so no reader takes it again."] }],
    ],
  },
  {
    story: 5, dur: 9800, focus: ["api", "pg", "loop", "marks"], tables: ["dual"],
    title: "Postgres and Redis can't share a commit",
    text: "Saving a policy writes Postgres; queueing its check writes Redis, and no transaction spans both. So the api commits first and queues second. If Redis refuses, it deletes what it just saved and answers 503: never a saved policy without its task.",
    code: "enqueue_or_undo() · api/database.py",
    moves: [["INSERT + COMMIT", "api>pg", 0.03, 0.22, "data"], ["SET NX", "api>loop", 0.28, 0.46, "bad"], ["DELETE", "api>pg", 0.56, 0.76, "bad"]],
    marks: [
      [0.04, { sub: { loop: "✗ down" }, rows: { dual: [["1. INSERT + COMMIT the policy", "nothing saved, nothing queued: fine"], ["2. SET NX the mark", "Redis down: delete the policy, answer 503"],
                                                        ["3. XADD the task", "remove the mark, delete the policy, 503"], ["later: Redis loses its data", "manage.py requeue queues it all again"]] } }],
      [0.22, { log: ["sql", "INSERT INTO policies (…) VALUES (1, 'POL-SAN', …) → id 12", "1. The new policy is saved in Postgres for good."] }],
      [0.46, { log: ["redis", "SET rci:queued:company_id=1:policy_id=12:type=policy.check 1 NX EX 86400 → Error 111: Connection refused", "2. Redis doesn't answer, so the check can't be queued."] }],
      [0.76, { sub: { loop: W }, log: ["sql", "DELETE FROM policies WHERE id = 12", "So the api takes the save back, and the page says try again. Nothing is left half done."] }],
    ],
  },

  // ── 6. Keeping it ──
  {
    story: 6, dur: 9000, focus: ["cli", "loop", "mem", "info"], tables: ["info"],
    title: "All in memory: INFO memory",
    text: "Every key lives in RAM: here the whole database is about 1 MB. maxmemory is 0 (no limit), and the policy noeviction: if RAM ran out, Redis would refuse writes rather than drop keys, which is right for a queue. MAXLEN and the marks' timers keep it small.",
    code: "redis-cli",
    moves: [["INFO memory", "cli>loop", 0.04, 0.28, "start"], ["", "loop>mem", 0.3, 0.42, "queue"], ["1.05M", "loop>cli", 0.48, 0.78, "ok"]],
    marks: [
      [0.78, { sub: { mem: "1.05 MB · no limit" }, rows: { info: [["used_memory_human", "1.05M", "the data, and Redis's own bookkeeping"], ["maxmemory", "0", "no limit"],
                                                                   ["maxmemory_policy", "noeviction", "full? refuse writes, never drop keys"],
                                                                   ["the other policies", "allkeys-lru, volatile-ttl…", "drop old keys: for a cache, not a queue"]] },
               log: ["redis", "INFO memory → used_memory_human:1.05M maxmemory:0 maxmemory_policy:noeviction", "This machine's Redis: about 1 MB in use, no limit set, and it would refuse writes rather than drop a key."] }],
    ],
  },
  {
    story: 6, dur: 9400, focus: ["watcher", "loop", "aof"], tables: ["files"],
    title: "The AOF: every write, on disk",
    text: "RAM is lost when the container stops, so Redis also appends every change to a log on disk, the AOF (append-only file), in /data/appendonlydir on the redis-data volume. appendfsync everysec flushes it to disk once a second: at most a second of writes can be lost.",
    code: "command: redis-server --appendonly yes · docker-compose.yml",
    moves: [["XADD", "watcher>loop", 0.04, 0.24, "queue"], ["in memory", "loop>pdf", 0.28, 0.4, "queue"], ["appended", "loop>aof", 0.44, 0.7, "data"]],
    marks: [
      [0.7, { sub: { aof: "+1 write · fsync 1/s" }, rows: { files: [["appendonlydir/appendonly.aof.1.base.rdb", "89 B", "the start: the data at the last rewrite"],
                                                                    ["appendonlydir/appendonly.aof.1.incr.aof", "258 KB", "every write since, in order"],
                                                                    ["appendonlydir/appendonly.aof.manifest", "88 B", "which files make up the AOF"], ["dump.rdb", "2.6 KB", "the last snapshot"]] },
              log: ["redis", "CONFIG GET appendfsync → appendfsync everysec", "The AOF is pushed to the disk once a second. always would do it on every write (safer, slower); no would leave it to the system."] }],
    ],
  },
  {
    story: 6, dur: 9800, focus: ["loop", "rdb", "aof"], tables: ["persist"],
    title: "RDB: a snapshot now and then",
    text: "The other way is a snapshot, dump.rdb: the whole dataset at one moment, written by a copy of Redis made with fork(). By default: after an hour with 1 change, 5 minutes with 100, or 1 minute with 10,000. Quick to load, but it loses what came after.",
    code: "save 3600 1 300 100 60 10000 · CONFIG GET",
    moves: [["fork: a copy", "loop>rdb", 0.06, 0.5, "data"]],
    marks: [
      [0.04, { rows: { persist: [["what", "the whole dataset at one moment", "every write, in order"], ["when", "save 3600 1 300 100 60 10000", "all the time; synced each second"],
                                 ["can lose", "everything since the last snapshot", "about 1 second"], ["restart", "load one file: quick", "load the base, replay the rest"],
                                 ["here", "on (the defaults)", "on: --appendonly yes"]] } }],
      [0.2, { log: ["log", "1:M 05 Oct 2026 06:29:24.029 * 100 changes in 300 seconds. Saving...", "Redis's own log, on this machine: 100 changes in 5 minutes, so it's time for a snapshot."] }],
      [0.5, { sub: { rdb: "saved by pid 372" }, log: ["log", "372:C 05 Oct 2026 06:29:24.053 * DB saved on disk", "The copy (process 372, C for child) has written dump.rdb. The real Redis kept serving clients all the while."] }],
      [0.85, { log: ["log", "1:C 05 Oct 2026 06:24:23.953 # WARNING Memory overcommit must be enabled! Without it, a background save or replication may fail under low memory condition.", "A real warning from this machine's start-up: fork() needs Linux to allow memory overcommit. With a 1 MB database it doesn't matter; on a big one, set vm.overcommit_memory = 1."] }],
    ],
  },
  {
    story: 6, dur: 9800, focus: ["loop", "aof", "reader", "w1", "w2", "api"], tables: [],
    title: "A restart: the lanes come back",
    text: "docker compose restart redis: for a moment every client loses its connection. Workers log “Redis unavailable; retrying” and wait a minute; the api answers 503 for anything that needs a task. Redis reads its files back, and every stream, group and pending entry is as it was.",
    code: "serve() · worker/main.py",
    moves: [["replay", "aof>loop", 0.32, 0.62, "data"]],
    marks: [
      [0.04, { sub: { loop: "✗ restarting", reader: "retrying", w1: "retrying", w2: "retrying", mem: "empty" },
               log: ["warn", "WARNING Redis unavailable (Error 111 connecting to redis:6379. Connection refused.); retrying", "Each worker's log: Redis isn't answering, so it waits a minute (RETRY_SECONDS) and tries again. Its task stays pending."] }],
      [0.62, { sub: { mem: "1.05 MB of RAM" },
               log: ["log", "1:M 05 Oct 2026 06:24:23.964 * DB loaded from append only file: 0.009 seconds", "Redis's own log: it read the base file and replayed the rest of the AOF, in 9 ms. Everything is back in memory."] }],
      [0.82, { sub: { loop: W, reader: W, w1: W, w2: W },
               log: ["log", "1:M 05 Oct 2026 06:24:23.964 * Ready to accept connections tcp", "Ready again. The workers' next try connects, and they carry on where they were."] }],
    ],
  },
  {
    story: 6, dur: 8600, focus: ["loop", "aof"], tables: ["files"],
    title: "Rewriting the AOF",
    text: "The log keeps every write, even for keys long gone. So Redis rewrites it in the background: a new base file with the data as it is now, and a new, empty file for what follows. It happens on its own once the AOF reaches 64 MB and doubles; here it's 258 KB, so never yet.",
    code: "auto-aof-rewrite-percentage 100 · auto-aof-rewrite-min-size 64mb",
    moves: [["BGREWRITEAOF", "cli>loop", 0.04, 0.24, "start"], ["fork: rewrite", "loop>aof", 0.3, 0.7, "data"]],
    marks: [
      [0.24, { log: ["redis", "BGREWRITEAOF → Background append only file rewriting started", "Ask for a rewrite now instead of waiting. A copy of Redis writes the new base; Redis carries on serving."] }],
      [0.7, { sub: { aof: "base 2 · a fresh log" }, rows: { files: [["appendonlydir/appendonly.aof.2.base.rdb", "2.6 KB", "the data as it is now"],
                                                                    ["appendonlydir/appendonly.aof.2.incr.aof", "0 B", "writes from now on"],
                                                                    ["appendonlydir/appendonly.aof.manifest", "88 B", "now names the new pair"], ["dump.rdb", "2.6 KB", "the last snapshot"]] } }],
    ],
  },
  {
    story: 6, dur: 9800, focus: ["cli", "pg", "loop", "pdf", "main", "w1"], tables: [],
    title: "Lost it all? Postgres still knows",
    text: "If the redis-data volume is deleted, the lanes and marks are gone. A worker sees NOGROUP and makes its group again. Postgres still knows what's unfinished, so manage.py requeue queues it all again: Redis holds only to-do notes; the facts live in Postgres.",
    code: "serve() · worker/main.py · requeue · api/manage.py",
    moves: [["NOGROUP", "loop>w1", 0.04, 0.2, "bad"], ["XGROUP CREATE", "w1>loop", 0.22, 0.34, "queue"], ["requeue", "cli>pg", 0.42, 0.6, "data"], ["XADD ×3", "cli>loop", 0.64, 0.82, "queue"],
            ["", "loop>main", 0.84, 0.96, "queue"], ["", "loop>pdf", 0.84, 0.96, "queue"]],
    marks: [
      [0.02, { sub: { pel: "empty", group: "not made yet", dead: "gone too", marks: "none" }, slots: { pdf: [], main: [] } }],
      [0.2, { log: ["warn", "WARNING Redis lost rci:tasks (NOGROUP No such key 'rci:tasks' or consumer group 'workers' in XREADGROUP with GROUP option); making it again", "The worker's log: the lane and its group are gone. It makes them again (XGROUP CREATE … MKSTREAM), empty."] }],
      [0.6, { log: ["app", "cd backend/api && uv run python manage.py requeue", "You run this once: it looks in Postgres for unfinished work and queues it again."] }],
      [0.96, { sub: { group: "main: from 0-0" }, slots: { main: ["99·1", "99·2"], pdf: ["101"] },
               log: ["app", "3 unfinished: 3 queued, 0 already queued", "3 unfinished jobs found in Postgres, all 3 queued again. Nothing is lost."] }],
    ],
  },

  // ── 7. Beyond one server ──
  {
    story: 7, dur: 9800, focus: ["api", "loop", "marks", "main"], tables: ["beyond"],
    title: "Pipelines, MULTI … EXEC, Lua",
    text: "Each command is a round trip. A pipeline sends many and reads the answers after. MULTI … EXEC runs a batch with nothing in between; a Lua script can even decide half-way. The app sends SET NX and XADD as two calls, and removes the mark if XADD fails.",
    code: "enqueue() · common/queue.py",
    moves: [["MULTI", "api>loop", 0.03, 0.16, "queue"], ["SET NX: QUEUED", "api>loop", 0.2, 0.34, "queue"], ["XADD: QUEUED", "api>loop", 0.38, 0.52, "queue"],
            ["EXEC", "api>loop", 0.56, 0.68, "queue"], ["", "loop>marks", 0.7, 0.78, "queue"], ["", "loop>main", 0.72, 0.8, "queue"], ["[OK, id]", "loop>api", 0.82, 0.96, "ok"]],
    marks: [
      [0.04, { rows: { beyond: BEYOND.slice(0, 3) } }],
      [0.34, { log: [["redis", "MULTI → OK", "Start a batch: the commands that follow are only queued, not run."],
                     ["redis", `SET ${MARK} 1 NX EX 86400 → QUEUED`, "Queued in the batch, not run yet."]] }],
      [0.96, { log: ["redis", "EXEC → [OK, 1791198749208-0]", "Run the whole batch at once, nothing in between: the mark is set and the task added. Tried on this machine."] }],
    ],
  },
  {
    story: 7, dur: 9000, focus: ["loop", "replica", "sentinel"], tables: ["beyond"],
    title: "A replica, and Sentinel",
    text: "REPLICAOF makes a second Redis copy every write of the first, a moment later. If the first dies, a replica can take over; Sentinel watches them and promotes one on its own. This app runs one Redis: its tasks can always be rebuilt from Postgres.",
    code: "not used here",
    moves: [["every write", "loop>replica", 0.1, 0.5, "queue"], ["is it alive?", "sentinel>replica", 0.6, 0.8, "ask"]],
    marks: [
      [0.04, { rows: { beyond: BEYOND.slice(0, 5) } }],
      [0.5, { sub: { replica: "in step" }, log: ["redis", "REPLICAOF redis 6379 → OK", "Run on a second server: become a copy of the Redis at redis:6379. It loads a snapshot, then follows every write."] }],
    ],
  },
  {
    story: 7, dur: 9000, focus: ["loop", "cluster", "pdf", "main"], tables: ["beyond"],
    title: "Cluster: keys over many servers",
    text: "Redis Cluster splits keys into 16,384 slots, spread over several servers, for data bigger than one machine. A key's slot comes from its name, and a key lives on one server, so a stream is never split: one lane can't be spread out. Far more than this app needs.",
    code: "not used here",
    moves: [["which slot?", "loop>cluster", 0.1, 0.5, "queue"]],
    marks: [
      [0.04, { rows: { beyond: BEYOND } }],
      [0.5, { sub: { cluster: "rci:tasks → slot 15027" },
              log: ["redis", "CLUSTER KEYSLOT rci:tasks → (integer) 15027", "On a cluster, rci:tasks would live in slot 15,027 (a checksum of its name). This machine's Redis isn't a cluster, so it refuses CLUSTER commands."] }],
    ],
  },
  {
    story: 7, dur: 9800, focus: ["cli", "loop", "info", "slow", "clients"], tables: ["watch"],
    title: "Watching it",
    text: "INFO tells you about the server; SLOWLOG lists commands that took long; CLIENT LIST shows who's connected: each worker, the api, the watcher. MONITOR prints every command as it runs: good for learning, too heavy to leave on.",
    code: "docker compose exec redis redis-cli",
    moves: [["SLOWLOG GET", "cli>loop", 0.03, 0.18, "start"], ["(empty)", "loop>cli", 0.2, 0.3, "ok"], ["CLIENT LIST", "cli>loop", 0.36, 0.5, "start"], ["a line each", "loop>cli", 0.52, 0.62, "ok"],
            ["MONITOR", "cli>loop", 0.68, 0.8, "start"], ["every command", "loop>cli", 0.82, 0.96, "ok"]],
    marks: [
      [0.04, { rows: { watch: [["INFO", "everything: memory, persistence, clients, stats"], ["XINFO GROUPS · CONSUMERS", "how each lane and its members are doing"],
                               ["SLOWLOG GET", "commands slower than 10 ms"], ["CLIENT LIST", "every connection and its last command"], ["MONITOR", "every command, live"]] } }],
      [0.3, { sub: { slow: "nothing slow" }, log: ["redis", "SLOWLOG GET 2 → (empty array)", "No command on this machine has taken over 10 ms (the default limit): nothing to show."] }],
      [0.62, { sub: { clients: "reader, workers, api" },
               log: ["redis", "CLIENT LIST → id=7 addr=172.18.0.6:51234 name= db=0 idle=0 cmd=xreadgroup …", "One line per connection: here the reader, waiting in XREADGROUP on database 0. The others show the workers, the api and the watcher."] }],
      [0.96, { sub: { slow: "MONITOR: on" },
               log: ["redis", `MONITOR → 1791190812.104528 [0 172.18.0.6:51234] "XREADGROUP" "GROUP" "workers" "${READER}" …`, "Every command any client sends, as it runs: when, from where, and what. Press Ctrl+C to stop; it slows Redis down."] }],
    ],
  },
];

export default {
  id: "redis",
  tab: "Redis",
  hint: "from zero to advanced",
  heading: "Redis, from zero to advanced",
  lead: "What Redis is and every part of it this app uses, step by step: keys and the marks, the other types, streams and the two lanes, consumer groups, crashes and claims, keeping it on disk, and what lies beyond one server. The commands are real ones with the answers Redis gives (checked on this machine's Redis 7.4), and the settings, files, log lines and counts are this machine's.",
  label: "Redis: on the left, the clients (you with redis-cli, the watcher, the api, the reader and two workers) send commands to the command loop, which runs them one at a time against the keys in memory: strings, the marks, the two lanes with their group and pending list, rci:dead, and the other types. On the right, the files on disk, more servers, and the tools for watching it.",
  size: [1240, 772],
  groups: [[16, 34, 200, 590, "who talks to Redis"], [16, 650, 200, 106, "the facts"], [236, 34, 644, 722, "redis-server 7.4 · port 6379 · in memory"],
           [394, 70, 256, 448, "keys in database 0"], [662, 236, 206, 188, "the group's books"], [394, 540, 474, 200, "other types · not used here"],
           [900, 34, 324, 236, "disk · the redis-data volume"], [900, 292, 324, 232, "beyond one server"], [900, 546, 324, 210, "watching it"]],
  nodes,
  edges,
  tables,
  quietEdges: true,
  backbone: ["cli>loop", "watcher>loop", "api>loop", "reader>loop", "w1>loop", "w2>loop", "loop>str", "loop>marks", "loop>pdf", "loop>main",
             "loop>dead", "pdf>group", "main>pel", "group>pel", "loop>aof"],
  start: { rows: { keyspace: [],
                   config: [["port", "6379", "where clients connect"], ["databases", "16", "numbered 0 to 15; the app uses 0"],
                            ["io-threads", "1", "one thread runs every command"], ["maxmemory", "0", "no limit on the RAM it uses"],
                            ["appendonly", "yes", "every write also goes to a file"]] } },
  stories: ["Zero · what Redis is", "Keys and strings · the marks", "The other types · and why tasks use a stream", "Streams · the lanes",
            "Consumer groups · each task to one worker", "Advanced · crashes, claims, doing it once", "Keeping it · memory, disk, restarts",
            "Beyond one server · and watching it"],
  steps,
};
