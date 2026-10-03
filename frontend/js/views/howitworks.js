/** How it works: the whole system, animated. One circular travels from the regulator's
 * site to a gap on the Gaps page, then a saved policy is checked. Each step has a caption;
 * play, pause, step through, or click a step to jump to it.
 *
 * What's drawn is a pure function of (step, progress through it): the state at a moment is
 * the initial state plus every mark up to that moment, and a token is on its edge while its
 * move is running. So pausing, stepping back and changing speed only draw another moment. */
import { $, $$, html, put } from "../lib/html.js";
import { pageHead } from "../ui/components.js";
import { icon } from "../ui/icons.js";
import { setCrumbs } from "../app/router.js";

// The same colours as the diagrams in the docs.
const KIND = {
  svc: "#2dd4bf", data: "#818cf8", ext: "#c084fc", gpu: "#fb923c",
  queue: "#38bdf8", start: "#a7ef6f", gap: "#fb7185", ok: "#34d399",
};

// id: [centre x, centre y, width, height, kind, title, line under the title]
const NODES = {
  reg: [95, 150, 150, 74, "ext", "RBI · SEBI · IRDAI", "regulators' sites"],
  watcher: [300, 150, 150, 74, "svc", "watcher", "every 60 minutes"],
  s3: [545, 44, 180, 56, "data", "S3", "the PDFs"],
  pdf: [545, 150, 250, 92, "queue", "PDF lane", "Redis · rci:tasks:pdf"],
  reader: [820, 150, 160, 74, "svc", "reader", ""],
  ocr: [1075, 150, 150, 74, "gpu", "OCR", "GPU · a page at a time"],
  db: [545, 335, 210, 74, "data", "Postgres", ""],
  gemini: [1075, 410, 150, 74, "ext", "Gemini", "questions → answers"],
  team: [95, 545, 150, 74, "start", "your team", "in the browser"],
  console: [300, 545, 150, 74, "svc", "console + api", ""],
  main: [545, 545, 250, 92, "queue", "main lane", "Redis · rci:tasks"],
  w1: [840, 480, 160, 66, "svc", "worker 1", ""],
  w2: [840, 610, 160, 66, "svc", "worker 2", ""],
};
const QUEUES = ["pdf", "main"];

/** A point on a node's side: at("db", "r", 12) is 12 px below the middle of its right side. */
function at(id, side, d = 0) {
  const [x, y, w, h] = NODES[id];
  return { l: [x - w / 2, y + d], r: [x + w / 2, y + d], t: [x + d, y - h / 2], b: [x + d, y + h / 2] }[side];
}
const line = (a, b) => `M${a} L${b}`;
const curve = (a, c1, c2, b) => `M${a} C${c1} ${c2} ${b}`;

// Every path a token can take. A token going the other way ("ocr>reader") runs it backwards.
const EDGES = {
  "reg>watcher": line(at("reg", "r"), at("watcher", "l")),
  "watcher>s3": curve(at("watcher", "t"), [300, 44], [380, 44], at("s3", "l")),
  "watcher>pdf": line(at("watcher", "r"), at("pdf", "l")),
  "watcher>db": curve(at("watcher", "b"), [300, 320], [380, 323], at("db", "l", -12)),
  "s3>reader": curve(at("s3", "r"), [790, 44], [820, 70], at("reader", "t")),
  "pdf>reader": line(at("pdf", "r"), at("reader", "l")),
  "reader>ocr": line(at("reader", "r"), at("ocr", "l")),
  "reader>gemini": curve(at("reader", "b", 50), [870, 320], [950, 395], at("gemini", "l", -15)),
  "reader>db": curve(at("reader", "b", -50), [770, 290], [700, 323], at("db", "r", -12)),
  "reader>main": curve(at("reader", "b", -10), [810, 400], [700, 470], at("main", "t", 95)),
  "team>console": line(at("team", "r"), at("console", "l")),
  "console>main": line(at("console", "r"), at("main", "l")),
  "console>db": curve(at("console", "t", 30), [330, 420], [380, 347], at("db", "l", 12)),
  "main>w1": curve(at("main", "r", -12), [720, 533], [720, 480], at("w1", "l")),
  "main>w2": curve(at("main", "r", 12), [720, 557], [720, 610], at("w2", "l")),
  "w1>gemini": curve(at("w1", "r"), [960, 480], [960, 420], at("gemini", "l", 10)),
  "w2>gemini": curve(at("w2", "r"), [1075, 610], [1075, 520], at("gemini", "b")),
  "w1>db": curve(at("w1", "t", -50), [790, 380], [710, 347], at("db", "r", 12)),
  "w2>db": curve(at("w2", "t", -60), [740, 500], [640, 430], at("db", "b", 60)),
};

const INITIAL = {
  slots: { pdf: [], main: [] },
  hold: { reader: "waiting", w1: "waiting", w2: "waiting" },
  db: "every result",
  gaps: 0,
  policy: "",
};

const STORIES = ["Story 1 · A new circular arrives", "Story 2 · You save a policy"];

// moves: [label, edge, from, to, kind]: the token runs along the edge between those two
// moments of the step (0 to 1). marks: [moment, change]: the state changes from then on.
const STEPS = [
  {
    story: 0, dur: 4200, focus: ["reg", "watcher"],
    title: "The watcher finds it",
    text: "Every 60 minutes the watcher reads the regulators' lists. Circular 98 is one it has never seen, so it downloads the PDF.",
    moves: [["circular 98", "reg>watcher", 0.08, 0.7, "ext"]],
  },
  {
    story: 0, dur: 4800, focus: ["watcher"],
    title: "It saves the PDF and a row",
    text: "The PDF goes to S3, named by its fingerprint, and a row goes to Postgres with status new. A circular is never saved twice.",
    moves: [["PDF", "watcher>s3", 0.05, 0.55, "data"], ["row 98", "watcher>db", 0.25, 0.75, "data"]],
    marks: [[0.75, { db: "circular 98 · new" }]],
  },
  {
    story: 0, dur: 4500, focus: ["watcher", "pdf"],
    title: "A note on the PDF lane",
    text: "It queues a small task, read 98: just a type and an id. Reading a PDF takes minutes, so PDFs have a lane of their own.",
    moves: [["read 98", "watcher>pdf", 0.1, 0.6, "queue"]],
    marks: [[0.6, { slots: { pdf: ["read 98"] } }]],
  },
  {
    story: 0, dur: 4500, focus: ["pdf", "reader"],
    title: "The reader takes it at once",
    text: "Redis hands the note to the one reader and writes the reader's name on it, so nobody else can take it.",
    moves: [["read 98", "pdf>reader", 0.12, 0.6, "queue"]],
    marks: [[0.12, { slots: { pdf: [] } }], [0.6, { hold: { reader: "reading 98" } }]],
  },
  {
    story: 0, dur: 7000, focus: ["reader", "ocr"],
    title: "OCR reads each page once",
    text: "The reader fetches the PDF from S3 and sends it to OCR a page at a time. Each page's text is saved the moment it's read.",
    moves: [
      ["PDF", "s3>reader", 0.02, 0.18, "data"],
      ["page 1", "reader>ocr", 0.2, 0.34, "gpu"], ["text", "ocr>reader", 0.36, 0.5, "gpu"],
      ["page 2", "reader>ocr", 0.52, 0.66, "gpu"], ["text", "ocr>reader", 0.68, 0.8, "gpu"],
      ["text", "reader>db", 0.8, 0.94, "data"],
    ],
    marks: [[0.94, { db: "circular 98 · text saved" }]],
  },
  {
    story: 0, dur: 5600, focus: ["reader", "gemini"],
    title: "Gemini sums it up",
    text: "Who it's addressed to, a short summary and every obligation. The summary also becomes numbers, used to find close policies.",
    moves: [
      ["summarise", "reader>gemini", 0.05, 0.38, "ext"], ["summary", "gemini>reader", 0.44, 0.74, "ext"],
      ["summary", "reader>db", 0.76, 0.92, "data"],
    ],
    marks: [[0.92, { db: "circular 98 · read" }]],
  },
  {
    story: 0, dur: 5200, focus: ["reader", "main"],
    title: "One check per company",
    text: "Each company gets its own note on the main lane: check 98 for company A, and for company B. The reader is done with 98.",
    moves: [["check 98·A", "reader>main", 0.05, 0.5, "queue"], ["check 98·B", "reader>main", 0.25, 0.7, "queue"]],
    marks: [[0.5, { slots: { main: ["98·A"] } }], [0.7, { slots: { main: ["98·A", "98·B"] } }],
            [0.8, { hold: { reader: "waiting" } }]],
  },
  {
    story: 0, dur: 5800, focus: ["main", "w1", "w2"],
    title: "Two workers, one note each",
    text: "Each note goes to exactly one worker, so A and B are checked at the same time. Meanwhile the reader starts on circular 99.",
    moves: [
      ["98·A", "main>w1", 0.1, 0.5, "queue"], ["98·B", "main>w2", 0.15, 0.55, "queue"],
      ["read 99", "watcher>pdf", 0.05, 0.42, "queue"], ["read 99", "pdf>reader", 0.5, 0.8, "queue"],
    ],
    marks: [
      [0.1, { slots: { main: ["98·B"] } }], [0.15, { slots: { main: [] } }],
      [0.42, { slots: { pdf: ["read 99"] } }], [0.5, { slots: { pdf: [] }, hold: { w1: "checking 98·A" } }],
      [0.55, { hold: { w2: "checking 98·B" } }], [0.8, { hold: { reader: "reading 99" } }],
    ],
  },
  {
    story: 0, dur: 5800, focus: ["w1", "w2", "gemini"],
    title: "Does it apply?",
    text: "Gemini compares each company's description with who the circular is for: yes for A, an NBFC; no for B, a stock broker.",
    moves: [
      ["applies?", "w1>gemini", 0.05, 0.4, "ext"], ["applies?", "w2>gemini", 0.1, 0.45, "ext"],
      ["yes", "gemini>w1", 0.5, 0.85, "ok"], ["no", "gemini>w2", 0.55, 0.9, "ext"],
      ["page 1", "reader>ocr", 0.2, 0.45, "gpu"], ["text", "ocr>reader", 0.55, 0.8, "gpu"],
    ],
    marks: [[0.85, { hold: { w1: "98 applies to A" } }], [0.9, { hold: { w2: "98: not for B" } }]],
  },
  {
    story: 0, dur: 5800, focus: ["w1", "gemini"],
    title: "Is a close policy out of date?",
    text: "Worker 1 scores A's policies against the circular, plain arithmetic, and asks Gemini about the closest. POL-KYC is out of date.",
    moves: [
      ["POL-KYC?", "w1>gemini", 0.05, 0.4, "ext"], ["out of date", "gemini>w1", 0.5, 0.85, "gap"],
      ["B: done", "w2>db", 0.2, 0.55, "data"],
    ],
    marks: [[0.55, { hold: { w2: "waiting" } }], [0.85, { hold: { w1: "POL-KYC out of date" } }]],
  },
  {
    story: 0, dur: 5400, focus: ["w1", "db", "console", "team"],
    title: "A gap for the policy's owner",
    text: "The verdict and a gap with a draft fix are saved together, due in 7 days. It shows on company A's Gaps page only.",
    moves: [["gap", "w1>db", 0.05, 0.4, "gap"], ["gap", "db>console", 0.45, 0.8, "gap"]],
    marks: [[0.4, { db: "gap opened · POL-KYC" }], [0.8, { gaps: 1, hold: { w1: "waiting" } }]],
  },
  {
    story: 0, dur: 4200, focus: ["main", "w1", "w2"],
    title: "Finished, never twice",
    text: "Each worker tells Redis it's finished (XACK), and its note leaves the list for good. Work that's saved is never done again.",
    moves: [["XACK", "w1>main", 0.1, 0.5, "ok"], ["XACK", "w2>main", 0.15, 0.55, "ok"]],
  },
  {
    story: 1, dur: 5800, focus: ["team", "console", "main"],
    title: "You save a policy",
    text: "The api saves POL-AML in Postgres first, then queues policy.check on the main lane. Its page says Waiting for the worker.",
    moves: [
      ["POL-AML", "team>console", 0.05, 0.3, "start"], ["policy", "console>db", 0.32, 0.58, "data"],
      ["check POL-AML", "console>main", 0.6, 0.88, "queue"],
    ],
    marks: [[0.3, { policy: "waiting for the worker" }], [0.58, { db: "POL-AML · saved" }],
            [0.88, { slots: { main: ["POL-AML"] } }]],
  },
  {
    story: 1, dur: 6400, focus: ["w1", "gemini", "console"],
    title: "A worker checks it at once",
    text: "It turns the policy into numbers, then checks it against your circulars of the last 30 days. The page now says Checked.",
    moves: [
      ["POL-AML", "main>w1", 0.04, 0.28, "queue"], ["embed", "w1>gemini", 0.3, 0.48, "ext"],
      ["numbers", "gemini>w1", 0.5, 0.66, "ext"], ["checked", "w1>db", 0.7, 0.84, "ok"],
      ["Checked", "db>console", 0.86, 0.97, "ok"],
    ],
    marks: [[0.04, { slots: { main: [] } }], [0.28, { hold: { w1: "checking POL-AML" } }],
            [0.84, { db: "POL-AML · checked" }], [0.97, { policy: "Checked", hold: { w1: "waiting" } }]],
  },
];
const TOTAL = STEPS.reduce((n, s) => n + s.dur, 0);

/** The state at a moment: every mark of the earlier steps, and this step's up to `p`. */
function stateAt(step, p) {
  const s = structuredClone(INITIAL);
  STEPS.slice(0, step + 1).forEach((st, k) => {
    for (const [t, change] of st.marks || []) {
      if (k < step || t <= p) {
        for (const [key, value] of Object.entries(change)) {
          s[key] = typeof value === "object" && !Array.isArray(value) ? { ...s[key], ...value } : value;
        }
      }
    }
  });
  return s;
}

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

// ── The picture ─────────────────────────────────────────────────────────────

function nodeSvg(id) {
  const [x, y, w, h, kind, title, sub] = NODES[id];
  const queue = QUEUES.includes(id);
  const slots = queue ? [0, 1, 2].map((i) => html`
    <g class="slot" data-slot="${id}-${i}" transform="translate(${x - 117 + i * 80} ${y + 6})">
      <rect width="74" height="24" rx="7" /><text x="37" y="16.5">·</text></g>`) : "";
  return html`<g class="node ${kind}" data-node="${id}" style="--k: ${KIND[kind]}">
    <rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="14" />
    <text class="node-title" x="${x}" y="${queue ? y - 24 : y - 4}">${title}</text>
    <text class="node-sub ${queue ? "mono" : ""}" data-sub="${id}" x="${x}" y="${queue ? y - 8 : y + 17}">${sub}</text>
    ${slots}
    ${id === "console" ? html`<g class="count-badge" transform="translate(${x + w / 2 - 6} ${y - h / 2 + 6})">
      <circle r="12" /><text y="4.5">1</text></g>` : ""}
  </g>`;
}

function stageSvg() {
  return html`<svg class="how-svg" viewBox="0 0 1180 680" role="img"
      aria-label="The system: the watcher saves new circulars and puts a note on the PDF lane; the reader reads each PDF with OCR and Gemini and puts one note per company on the main lane; the workers check each company's policies with Gemini and open gaps, which your team sees in the console.">
    <g class="edges">${Object.entries(EDGES).map(([id, d]) => html`<path class="edge" data-edge="${id}" d="${d}" />`)}</g>
    <g class="nodes">${Object.keys(NODES).map(nodeSvg)}</g>
    <g class="tokens">${[0, 1, 2, 3, 4, 5].map(() => html`<g class="token"><rect height="26" rx="13" y="-13" /><text y="4.5"></text></g>`)}</g>
  </svg>`;
}

function stepList() {
  return STORIES.map((story, s) => html`
    <li class="how-story-head">${story}</li>
    ${STEPS.map((st, i) => st.story === s ? html`<li><button type="button" class="how-step" data-step="${i}">
      <span class="how-num">${i + 1}</span><span>${st.title}</span></button></li>` : "")}`);
}

const LEGEND = [["svc", "our services"], ["data", "data"], ["ext", "Gemini, regulators"], ["gpu", "OCR on the GPU"],
                ["queue", "a task (a note)"], ["gap", "a gap"]];

// ── The page ────────────────────────────────────────────────────────────────

export async function howPage() {
  setCrumbs([["How it works"]]);
  put($("#view"), html`
    ${pageHead("How it works", "The whole system, step by step",
               "Follow one circular from a regulator's website to a gap on your Gaps page, then a policy you save. Each part is its own service: they only pass small notes, called tasks, through Redis.")}
    <div class="how">
      <section class="panel how-stage">
        <div class="how-caption" aria-live="polite">
          <div class="how-story" id="how-story"></div>
          <h2 id="how-title"></h2>
          <p id="how-text"></p>
        </div>
        <div class="how-canvas">${stageSvg()}</div>
        <div class="how-bar"><i id="how-progress"></i></div>
        <div class="how-controls">
          <button class="icon-btn" id="how-restart" title="Start again" aria-label="Start again">${icon("refresh")}</button>
          <button class="icon-btn" id="how-prev" title="Previous step (←)" aria-label="Previous step">${icon("back")}</button>
          <button class="btn primary sm" id="how-play"></button>
          <button class="icon-btn" id="how-next" title="Next step (→)" aria-label="Next step">${icon("forward")}</button>
          <button class="btn ghost sm" id="how-speed" title="Speed">1×</button>
          <ul class="how-legend">${LEGEND.map(([k, label]) => html`<li style="--k: ${KIND[k]}"><i></i>${label}</li>`)}</ul>
        </div>
      </section>
      <aside class="panel how-steps"><ol>${stepList()}</ol></aside>
    </div>`);

  const svg = $(".how-svg");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pathOf = Object.fromEntries($$(".edge", svg).map((p) => [p.dataset.edge, p]));
  const lengthOf = Object.fromEntries(Object.entries(pathOf).map(([id, p]) => [id, p.getTotalLength()]));
  const tokens = $$(".token", svg);
  const widths = new Map();
  let step = 0, p = reduced ? 1 : 0, playing = !reduced, speed = 1, last = null, shownStep = -1;

  function edgeFor(name) {
    if (pathOf[name]) return { id: name, back: false };
    const [a, b] = name.split(">");
    return { id: `${b}>${a}`, back: true };
  }

  function label(token, text) {
    const t = $("text", token);
    if (t.textContent !== text) {
      t.textContent = text;
      if (!widths.has(text)) widths.set(text, t.getComputedTextLength() + 22);
      const w = widths.get(text);
      $("rect", token).setAttribute("width", w);
      $("rect", token).setAttribute("x", -w / 2);
      t.setAttribute("x", 0);
    }
  }

  function draw() {
    const st = STEPS[step];
    const s = stateAt(step, p);
    if (shownStep !== step) {
      shownStep = step;
      $("#how-story").textContent = STORIES[st.story];
      $("#how-title").textContent = `${step + 1}. ${st.title}`;
      $("#how-text").textContent = st.text;
      $$(".how-step").forEach((b) => b.classList.toggle("on", +b.dataset.step === step));
    }
    for (const q of QUEUES) {
      [0, 1, 2].forEach((i) => {
        const slot = $(`[data-slot="${q}-${i}"]`, svg);
        const text = s.slots[q][i];
        slot.classList.toggle("full", Boolean(text));
        $("text", slot).textContent = text || "·";
      });
    }
    for (const [id, text] of Object.entries(s.hold)) {
      $(`[data-sub="${id}"]`, svg).textContent = text;
      $(`[data-node="${id}"]`, svg).classList.toggle("busy", text !== "waiting");
    }
    $('[data-sub="db"]', svg).textContent = s.db;
    $('[data-sub="console"]', svg).textContent = s.policy ? `POL-AML: ${s.policy}` : s.gaps ? "1 new gap" : "Gaps · Policies";
    $(".count-badge", svg).classList.toggle("show", s.gaps > 0);

    const lit = new Set(st.focus);
    const busyEdges = new Map();
    let n = 0;
    for (const [text, name, from, to, kind] of st.moves) {
      if (p < from || p > to || n >= tokens.length) continue;
      const { id, back } = edgeFor(name);
      const x = ease((p - from) / (to - from));
      const pt = pathOf[id].getPointAtLength(lengthOf[id] * (back ? 1 - x : x));
      const token = tokens[n++];
      label(token, text);
      token.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
      token.style.setProperty("--k", KIND[kind]);
      token.classList.add("show");
      busyEdges.set(id, { kind, back });
      name.split(">").forEach((node) => lit.add(node));
    }
    tokens.slice(n).forEach((t) => t.classList.remove("show"));
    $$(".node", svg).forEach((g) => g.classList.toggle("on", lit.has(g.dataset.node)));
    for (const [id, path] of Object.entries(pathOf)) {
      const busy = busyEdges.get(id);
      path.classList.toggle("on", Boolean(busy));
      path.classList.toggle("back", Boolean(busy?.back));
      if (busy) path.style.setProperty("--k", KIND[busy.kind]);
    }

    const done = STEPS.slice(0, step).reduce((sum, x) => sum + x.dur, 0) + p * st.dur;
    $("#how-progress").style.width = `${(100 * done) / TOTAL}%`;
    const atEnd = step === STEPS.length - 1 && p >= 1;
    put($("#how-play"), html`${icon(playing ? "pause" : "play")}${playing ? "Pause" : atEnd ? "Replay" : "Play"}`);
  }

  function go(to, { play } = {}) {
    step = Math.max(0, Math.min(STEPS.length - 1, to));
    p = reduced && !playing ? 1 : 0;
    if (play !== undefined) playing = play;
    last = null;
    draw();
  }

  function frame(now) {
    if (!svg.isConnected) return;                 // the page was left: stop
    if (playing && last !== null) {
      p += ((now - last) * speed) / STEPS[step].dur;
      if (p >= 1) {
        if (step < STEPS.length - 1) { step += 1; p = 0; } else { p = 1; playing = false; }
      }
    }
    last = now;
    draw();
    requestAnimationFrame(frame);
  }

  $("#how-play").addEventListener("click", () => {
    if (step === STEPS.length - 1 && p >= 1) return go(0, { play: true });
    playing = !playing;
    last = null;
    draw();
  });
  $("#how-prev").addEventListener("click", () => go(p > 0.15 && !reduced ? step : step - 1));
  $("#how-next").addEventListener("click", () => go(step + 1));
  $("#how-restart").addEventListener("click", () => go(0, { play: true }));
  $("#how-speed").addEventListener("click", (e) => {
    speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
    e.currentTarget.textContent = `${speed}×`;
  });
  $(".how-steps").addEventListener("click", (e) => {
    const b = e.target.closest(".how-step");
    if (b) go(+b.dataset.step);
  });
  const keys = (e) => {
    if (!svg.isConnected) return removeEventListener("keydown", keys);
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); $("#how-play").click(); }
    if (e.key === "ArrowRight") go(step + 1);
    if (e.key === "ArrowLeft") go(step - 1);
  };
  addEventListener("keydown", keys);

  draw();
  requestAnimationFrame(frame);
}
