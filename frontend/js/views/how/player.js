/** The player behind every How it works animation. A scene is plain data: nodes, edges,
 * tables, and steps, each with a caption, the tokens that move along the edges, and marks
 * that change what the nodes say and what the tables hold. What's drawn is a pure function
 * of (step, progress through it): the state at a moment is the scene's start plus every
 * mark up to that moment, and a token is on its edge while its move runs. So pausing,
 * stepping back and changing the speed only draw another moment.
 *
 * A scene: { id, tab, hint, heading, lead, label, refDoc, size: [w, h], nodes, edges,
 *            groups: [[x, y, w, h, label]], tables: { id: { title, store, cols } },
 *            start: { sub, slots, badge, rows }, stories, steps, quietEdges, backbone }
 * A step:  { story, dur, ref, title, text, code, focus: [node ids], tables: [table ids],
 *            moves: [[label, "from>to", start, end, kind], …],   (start, end: 0 to 1)
 *            marks: [[moment, { sub, slots, badge, rows, log }], …] }
 * A log line: [type, the real log line, SQL or command, what it means in plain words]. The
 * panel under the picture shows the plain words first, the real line under them.
 * A move along "b>a" when only "a>b" is drawn runs the same edge backwards. quietEdges
 * draws only the edges the current step uses, plus the backbone ones, faintly and with an
 * arrow. Each kind of part has its own shape, as in a flowchart (SHAPE below). */
import { $, $$, html, put } from "../../lib/html.js";
import { icon } from "../../ui/icons.js";

// The same colours as the diagrams in the docs.
export const KIND = {
  svc: "#2dd4bf", data: "#818cf8", ext: "#c084fc", gpu: "#fb923c", queue: "#38bdf8",
  start: "#a7ef6f", ask: "#fbbf24", gap: "#fb7185", bad: "#fb7185", ok: "#34d399", step: "#94a3b8",
};

// The log panel's line types. Each line is [type, the real text, what it means in plain words].
const LOG = {
  http: ["request", "#a7ef6f"], sql: ["Postgres", "#818cf8"], redis: ["Redis", "#38bdf8"], s3: ["S3", "#a5b4fc"],
  llm: ["Gemini", "#c084fc"], ocr: ["OCR", "#fb923c"], log: ["log", "#5eead4"], warn: ["warning", "#fbbf24"],
  error: ["error", "#fb7185"], app: ["app", "#cbd5e1"],
};
const LOG_LINES = 6;

/** A node: node(x, y, w, h, kind, title, sub, { slots, idle, link, badge, mono, inline, num, shape }).
 * idle: the sub-line that means "not busy"; any other sub-line makes the node glow as busy.
 * link: the scene that shows this part in detail (clicking the node opens it).
 * num: a step number, drawn in a circle on the left (the boxes of a numbered walkthrough).
 * shape: one of SHAPE's values, when the kind's own shape doesn't suit the part. */
export const node = (x, y, w, h, kind, title, sub = "", opts = {}) => ({ x, y, w, h, kind, title, sub, ...opts });

// Each kind of part has its own shape, as in a flowchart: our code a rounded box, a person,
// a start or a finish a pill, a table a cylinder, a Redis list a pipe, an outside service a
// parallelogram, the GPU a chip, a check a hexagon, a failure a flag.
const SHAPE = { svc: "box", step: "box", start: "pill", ok: "pill", data: "db", gap: "db", queue: "pipe",
                ext: "para", gpu: "chip", ask: "hex", bad: "flag" };
const shapeOf = (n) => n.shape || SHAPE[n.kind] || "box";

/** A shape's sizes: corner radius, a cylinder's rim, a pipe's end, how far a side slants. */
function form(n) {
  const { w, h } = n;
  switch (shapeOf(n)) {
    case "pill": return { r: h / 2 };
    case "db": return { ry: Math.min(7, h * 0.12) };
    case "pipe": return { rc: Math.min(11, w * 0.05) };
    case "hex": return { i: Math.min(14, h * 0.3) };
    case "para": return { s: Math.min(12, h * 0.26) };
    case "chip": return { c: Math.min(10, h * 0.24) };
    case "flag": return { k: Math.min(12, h * 0.26), r: 10 };
    default: return { r: n.inline ? 9 : 12 };
  }
}

/** How far inside its box a node's left or right side is, at height d from its middle: where
 * an edge meets a slanted or rounded side. */
function lean(n, side, d) {
  if (side !== "l" && side !== "r") return 0;
  const f = form(n), half = n.h / 2, a = Math.min(Math.abs(d), half);
  const corner = (r) => (a > half - r ? r - Math.sqrt(Math.max(0, r * r - (a - (half - r)) ** 2)) : 0);
  switch (shapeOf(n)) {
    case "box": case "pill": return corner(f.r);
    case "hex": return (f.i * a) / half;
    case "para": return (f.s * (side === "l" ? half - d : half + d)) / n.h;
    case "pipe": return f.rc * (1 - Math.sqrt(Math.max(0, 1 - (a / half) ** 2)));
    case "chip": return Math.max(0, a - (half - f.c));
    case "flag": return side === "l" ? f.k * (1 - a / half) : corner(f.r);
    default: return 0;                            // a cylinder's sides are straight
  }
}

const box = (x0, y0, w, h, r) => `M${x0 + r},${y0} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} `
  + `a${r},${r} 0 0 1 ${-r},${r} h${2 * r - w} a${r},${r} 0 0 1 ${-r},${-r} v${2 * r - h} a${r},${r} 0 0 1 ${r},${-r} Z`;

/** A node's outline, and the extra lines some shapes have: a cylinder's rim, a pipe's open
 * end, a chip's pins. */
function outline(n) {
  const { x, y, w, h } = n, f = form(n);
  const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2;
  switch (shapeOf(n)) {
    case "db": {
      const rx = w / 2, { ry } = f;
      return { d: `M${x0},${y0 + ry} A${rx},${ry} 0 0 1 ${x1},${y0 + ry} V${y1 - ry} A${rx},${ry} 0 0 1 ${x0},${y1 - ry} Z`,
               lid: `M${x0},${y0 + ry} A${rx},${ry} 0 0 0 ${x1},${y0 + ry} A${rx},${ry} 0 0 0 ${x0},${y0 + ry} Z` };
    }
    case "pipe": {
      const { rc } = f, ry = h / 2;
      return { d: `M${x0 + rc},${y0} H${x1 - rc} A${rc},${ry} 0 0 1 ${x1 - rc},${y1} H${x0 + rc} A${rc},${ry} 0 0 1 ${x0 + rc},${y0} Z`,
               lid: `M${x1 - rc},${y0} A${rc},${ry} 0 0 0 ${x1 - rc},${y1} A${rc},${ry} 0 0 0 ${x1 - rc},${y0} Z` };
    }
    case "hex": return { d: `M${x0 + f.i},${y0} H${x1 - f.i} L${x1},${y} L${x1 - f.i},${y1} H${x0 + f.i} L${x0},${y} Z` };
    case "para": return { d: `M${x0 + f.s},${y0} H${x1} L${x1 - f.s},${y1} H${x0} Z` };
    case "chip": {
      const { c } = f, step = (w - 2 * c - 24) / 3;
      const pins = n.inline ? "" : range(4).map((i) => {
        const px = x0 + c + 12 + i * step;
        return `M${px},${y0 - 4} V${y0} M${px},${y1} V${y1 + 4}`;
      }).join(" ");
      return { d: `M${x0 + c},${y0} H${x1 - c} L${x1},${y0 + c} V${y1 - c} L${x1 - c},${y1} H${x0 + c} L${x0},${y1 - c} V${y0 + c} Z`, pins };
    }
    case "flag": {
      const { k, r } = f;
      return { d: `M${x0},${y0} H${x1 - r} A${r},${r} 0 0 1 ${x1},${y0 + r} V${y1 - r} A${r},${r} 0 0 1 ${x1 - r},${y1} H${x0} L${x0 + k},${y} Z` };
    }
    default: return { d: box(x0, y0, w, h, f.r) };
  }
}

/** Where a node's text goes, clear of its shape's slanted or rounded sides: the centre line,
 * the room for its sub-line, the number's place, and how far a cylinder's rim pushes it down. */
function textBox(n) {
  const { x, w } = n, band = n.inline ? 7 : 12;
  const side = (s) => Math.max(lean(n, s, -band), lean(n, s, band));
  const il = side("l"), ir = side("r") + (shapeOf(n) === "pipe" ? form(n).rc : 0);
  const x0 = x - w / 2, x1 = x + w / 2;
  const numX = n.num ? x0 + 20 + lean(n, "l", 0) * 0.9 : 0;
  const left = n.num ? numX + 21 : x0 + 8 + il, right = x1 - 8 - ir;
  return { il, ir, numX, cx: (left + right) / 2, room: right - left, dy: shapeOf(n) === "db" ? form(n).ry * 0.75 : 0 };
}

/** Path helpers for a scene. at(id, side, offset) is a point on a node's outline; via(a, y, b)
 * runs from a to b along the horizontal corridor at height y (between rows of boxes). */
export function geometry(nodes) {
  const at = (id, side, d = 0) => {
    const n = nodes[id], { x, y, w, h } = n, e = lean(n, side, d);
    return { l: [x - w / 2 + e, y + d], r: [x + w / 2 - e, y + d], t: [x + d, y - h / 2], b: [x + d, y + h / 2] }[side];
  };
  const line = (a, b) => `M${a} L${b}`;
  const curve = (a, c1, c2, b) => `M${a} C${c1} ${c2} ${b}`;
  const via = (a, y, b) => {
    const s = Math.sign(b[0] - a[0]) || 1;
    if (Math.abs(b[0] - a[0]) < 70) return curve(a, [a[0] + 12 * s, a[1]], [b[0] - 12 * s, b[1]], b);
    return `M${a} C${[a[0] + 14 * s, a[1]]} ${[a[0] + 14 * s, y]} ${[a[0] + 28 * s, y]} L${[b[0] - 28 * s, y]} `
      + `C${[b[0] - 14 * s, y]} ${[b[0] - 14 * s, b[1]]} ${b}`;
  };
  return { at, line, curve, via };
}

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const range = (n) => [...Array(n).keys()];

function apply(s, change) {
  for (const [key, value] of Object.entries(change)) {
    if (key === "log") s.log.push(...(typeof value[0] === "string" ? [value] : value));
    else Object.assign(s[key], value);
  }
}

/** The state at a moment: the start, every mark of the earlier steps, and this step's up to p. */
function stateAt(scene, step, p) {
  const s = { sub: {}, slots: {}, badge: {}, rows: {}, log: [] };
  for (const [id, n] of Object.entries(scene.nodes)) {
    s.sub[id] = n.sub;
    if (n.slots) s.slots[id] = [];
  }
  for (const id of Object.keys(scene.tables || {})) s.rows[id] = [];
  apply(s, scene.start || {});
  scene.steps.slice(0, step + 1).forEach((st, k) => {
    const marks = [...(st.marks || [])].sort((a, b) => a[0] - b[0]);
    for (const [t, change] of marks) if (k < step || t <= p) apply(s, change);
  });
  return s;
}

// ── Drawing ────────────────────────────────────────────────────────────────

function nodeSvg(id, n) {
  const { x, y, w, h, kind, title, slots, num } = n;
  const top = y - h / 2;
  const o = outline(n), t = textBox(n);
  const gap = 6;
  const sw = slots ? Math.min(78, (w - 24 - t.il - t.ir - (slots - 1) * gap) / slots) : 0;
  const sx = x + (t.il - t.ir) / 2 - (slots * sw + (slots - 1) * gap) / 2;
  // inline: a one-line row (a table, a service): the title on the left, the line on the right
  const [tx, sx2, ty, sy] = n.inline ? [x - w / 2 + 14 + t.il, x + w / 2 - 14 - t.ir, y + 5 + t.dy, y + 5 + t.dy]
    : [t.cx, t.cx, (slots ? top + 22 : y - 3) + t.dy, (slots ? top + 38 : y + 15) + t.dy];
  return html`<g class="node${n.link ? " link" : ""}${n.inline ? " inline" : ""}${num ? " numbered" : ""}" data-node="${id}"
      style="--k: ${KIND[kind]}" ${n.link ? html`data-link="${n.link}" tabindex="0" role="link" aria-label="${title}: see it in detail"` : ""}>
    ${n.link ? html`<title>${title}: click to see it in detail</title>` : ""}
    <path class="shape" d="${o.d}" /><path class="sheen" d="${o.d}" />
    ${o.lid ? html`<path class="lid" d="${o.lid}" />` : ""}${o.pins ? html`<path class="pins" d="${o.pins}" />` : ""}
    ${num ? html`<g class="node-num" transform="translate(${t.numX} ${y})"><circle r="13" /><text y="4.5">${num}</text></g>` : ""}
    <text class="node-title" x="${tx}" y="${ty}">${title}</text>
    <text class="node-sub${n.mono ? " mono" : ""}" data-sub="${id}" x="${sx2}" y="${sy}"></text>
    ${slots ? range(slots).map((i) => html`
      <g class="slot" data-slot="${id}-${i}" transform="translate(${sx + i * (sw + gap)} ${top + 50})">
        <rect width="${sw}" height="24" rx="7" /><text x="${sw / 2}" y="16.5">·</text></g>`) : ""}
    ${n.badge ? html`<g class="count-badge" data-badge="${id}" transform="translate(${x + w / 2 - 6 - t.ir / 2} ${top + 6})">
      <circle r="12" /><text y="4.5"></text></g>` : ""}
    ${n.link ? html`<text class="node-open" x="${x + w / 2 - 12 - t.ir}" y="${top + 17 + t.dy * 1.6}">↗</text>` : ""}
  </g>`;
}

function sceneSvg(scene) {
  const [w, h] = scene.size;
  const backbone = new Set(scene.backbone || []);
  // Never narrower than 80% of its drawn size: on a phone it scrolls sideways instead of shrinking
  return html`<svg class="how-svg${scene.quietEdges ? " quiet" : ""}" viewBox="0 0 ${w} ${h}" role="img"
      aria-label="${scene.label}" style="min-width: ${Math.round(w * 0.8)}px">
    <defs>
      <linearGradient id="how-sheen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity="0.08" /><stop offset="0.6" stop-color="#fff" stop-opacity="0" />
      </linearGradient>
      ${[...Object.entries(KIND), ["faint", "rgba(148, 163, 184, 0.4)"]].map(([k, c]) => html`<marker id="how-tip-${k}"
        viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse"
        orient="auto-start-reverse"><path d="M1,1.2 L9.4,5 L1,8.8 L2.8,5 Z" fill="${c}" /></marker>`)}
    </defs>
    <g class="groups">${(scene.groups || []).map(([x, y, gw, gh, label]) => html`<g class="group">
      <rect class="frame" x="${x}" y="${y}" width="${gw}" height="${gh}" rx="16" />
      <g class="tag" transform="translate(${x + 14} ${y})"><rect y="-10" height="20" rx="10" /><text x="10" y="3.6">${label}</text></g></g>`)}</g>
    <g class="edges">${Object.entries(scene.edges).map(([id, d]) => html`<path class="edge${backbone.has(id) ? " backbone" : ""}"
      data-edge="${id}" d="${d}" ${backbone.has(id) ? html`marker-end="url(#how-tip-faint)"` : ""} />`)}</g>
    <g class="nodes">${Object.entries(scene.nodes).map(([id, n]) => nodeSvg(id, n))}</g>
    <g class="tokens">${range(10).map(() => html`<g class="token"><rect height="26" rx="13" y="-13" /><text y="4.5"></text></g>`)}</g>
  </svg>`;
}

function stepList(scene) {
  return scene.stories.map((story, s) => html`
    <li class="how-story-head">${story}</li>
    ${scene.steps.map((st, i) => st.story === s ? html`<li><button type="button" class="how-step" data-step="${i}">
      <span class="how-num">${i + 1}</span><span class="how-step-title">${st.title}</span>
      ${st.ref ? html`<em>${st.ref}</em>` : ""}</button></li>` : "")}`);
}

const LEGEND = [["svc", "our code"], ["start", "you, a start, an end"], ["data", "a table, a store"], ["queue", "a task, Redis"],
                ["ext", "Gemini, outside sites"], ["gpu", "OCR on the GPU"], ["ask", "a check"], ["bad", "a gap, a failure"]];

/** A legend key: the kind's own shape and colour, small. */
function keyIcon(kind) {
  const o = outline(node(50, 30, 92, 48, kind));
  return html`<svg viewBox="0 0 100 60" aria-hidden="true"><path d="${o.d}" />${o.lid ? html`<path class="lid" d="${o.lid}" />` : ""}</svg>`;
}

/** One table of the "rows now" panel. Rows or cells that differ from the step's start are lit. */
function tableHtml(def, rows, before) {
  const was = new Set(before.map((r) => JSON.stringify(r)));
  return html`<section class="how-table">
    <header><b>${def.title}</b><span>${def.store}</span></header>
    ${rows.length ? html`<table>
      <thead><tr>${def.cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${rows.map((r, i) => html`<tr class="${was.has(JSON.stringify(r)) ? "" : "changed"}">${r.map((cell, j) => html`
        <td class="${before[i] && before[i][j] === cell ? "" : "lit"}" title="${cell}">${cell}</td>`)}</tr>`)}</tbody>
    </table>` : html`<p class="how-empty">no rows</p>`}
  </section>`;
}

// ── Playing ────────────────────────────────────────────────────────────────

/** Draw the scene into `root` and play it. Stops by itself once root leaves the page. */
export function play(scene, root) {
  put(root, html`
    <div class="how">
      <section class="panel how-stage">
        <div class="how-caption" aria-live="polite">
          <div class="how-story" id="how-story"></div>
          <h2 id="how-title"></h2>
          <p id="how-text"></p>
          <p class="how-code" id="how-code"></p>
        </div>
        <div class="how-canvas">${sceneSvg(scene)}</div>
        <div class="how-bar"><i id="how-progress"></i></div>
        <div class="how-controls">
          <button class="icon-btn" id="how-restart" title="Start again" aria-label="Start again">${icon("refresh")}</button>
          <button class="icon-btn" id="how-prev" title="Previous step (←)" aria-label="Previous step">${icon("back")}</button>
          <button class="btn primary sm" id="how-play"></button>
          <button class="icon-btn" id="how-next" title="Next step (→)" aria-label="Next step">${icon("forward")}</button>
          <button class="btn ghost sm" id="how-speed" title="Speed">1×</button>
          <span class="how-count" id="how-count"></span>
          <button class="btn ghost sm" id="how-full" title="Full screen (F)">${icon("expand")}Full screen</button>
          <ul class="how-legend">${LEGEND.map(([k, label]) => html`<li style="--k: ${KIND[k]}">${keyIcon(k)}${label}</li>`)}</ul>
        </div>
        <div class="how-panels${scene.tables ? "" : " log-only"}">
          ${scene.tables ? html`<div class="how-rows" aria-live="polite">
            <div class="how-panel-head"><b>The rows now</b><span>what this step changed is lit</span></div>
            <div id="how-tables"></div>
          </div>` : ""}
          <div class="how-log" role="log" aria-label="What the logs, Redis and Postgres see">
            <div class="how-panel-head"><b>Underneath</b><span>what happens behind the scenes, in plain words, with the real log line or command</span></div>
            <ol id="how-log"></ol>
          </div>
        </div>
      </section>
      <aside class="panel how-steps"><ol>${stepList(scene)}</ol></aside>
    </div>`);

  const steps = scene.steps;
  const total = steps.reduce((n, s) => n + s.dur, 0);
  const stage = $(".how-stage", root);
  const svg = $(".how-svg", root);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pathOf = Object.fromEntries($$(".edge", svg).map((p) => [p.dataset.edge, p]));
  const lengthOf = Object.fromEntries(Object.entries(pathOf).map(([id, p]) => [id, p.getTotalLength()]));
  const tokens = $$(".token", svg);
  const widths = new Map();
  const shown = new Map();                        // text element → the text last put in it
  let step = 0, p = reduced ? 1 : 0, playing = !reduced, speed = 1, last = null;
  let shownStep = -1, shownLog = "", shownRows = "", before = null;

  /** Put text in an SVG text element, cut with "…" to fit `max` pixels. */
  function fit(el, text, max) {
    if (shown.get(el) === text) return;
    shown.set(el, text);
    el.textContent = text;
    let cut = text;
    while (cut.length > 3 && el.getComputedTextLength() > max) {
      cut = cut.slice(0, -1);
      el.textContent = `${cut.trimEnd()}…`;
    }
  }
  /** The room a node's sub-line has: inside its shape, less the title when they share the line. */
  const room = Object.fromEntries(Object.entries(scene.nodes).map(([id, n]) => {
    const title = $(`[data-node="${id}"] .node-title`, svg);
    return [id, textBox(n).room - (n.inline ? 26 + title.getComputedTextLength() : 0)];
  }));
  // Each group's label sits on its border, on a tag as wide as the label
  const tags = () => $$(".group .tag", svg).forEach((g) => $("rect", g).setAttribute("width", $("text", g).getComputedTextLength() + 20));
  tags();
  document.fonts?.ready.then(tags);
  const faint = (id) => (pathOf[id].classList.contains("backbone") ? "marker-end faint" : "");
  const tips = new Map(Object.keys(pathOf).map((id) => [id, faint(id)]));   // edge → the arrowhead it shows

  function edgeFor(name) {
    if (pathOf[name]) return { id: name, back: false };
    const [a, b] = name.split(">");
    if (!pathOf[`${b}>${a}`]) throw new Error(`no edge ${name} in ${scene.id}`);
    return { id: `${b}>${a}`, back: true };
  }

  function label(token, text) {
    const t = $("text", token);
    if (t.textContent === text) return;
    t.textContent = text;
    if (!widths.has(text)) widths.set(text, t.getComputedTextLength() + 24);
    const w = widths.get(text);
    $("rect", token).setAttribute("width", w);
    $("rect", token).setAttribute("x", -w / 2);
  }

  /** The latest lines: what each means, then the real line. This step's lines are bright. */
  function showLog(lines, fresh) {
    const key = `${lines.length} ${fresh} ${lines.at(-1)?.[1] ?? ""}`;
    if (key === shownLog) return;
    shownLog = key;
    const first = Math.max(0, lines.length - LOG_LINES);
    const recent = lines.slice(first);
    put($("#how-log", root), html`${recent.map(([type, text, why], i) => html`
      <li class="${first + i >= fresh ? `now${i === recent.length - 1 ? " new" : ""}` : ""}" style="--c: ${LOG[type][1]}">
        <b>${LOG[type][0]}</b><div>${why ? html`<p>${why}</p>` : ""}<code title="${text}">${text}</code></div></li>`)}
      ${recent.length ? "" : html`<li class="none">Nothing yet: press play.</li>`}`);
  }

  function showTables(st, s) {
    if (!scene.tables) return;
    const ids = st.tables || [];
    const key = JSON.stringify(ids.map((id) => s.rows[id]));
    if (key === shownRows) return;
    shownRows = key;
    put($("#how-tables", root), ids.length
      ? html`${ids.map((id) => tableHtml(scene.tables[id], s.rows[id], before.rows[id]))}`
      : html`<p class="how-empty">No table changes in this step.</p>`);
  }

  function draw() {
    const st = steps[step];
    const s = stateAt(scene, step, p);
    if (shownStep !== step) {
      shownStep = step;
      before = stateAt(scene, step, 0);
      shownRows = "";
      $("#how-story", root).textContent = scene.stories[st.story];
      put($("#how-title", root), html`${st.ref ? html`<span class="how-ref">${scene.refDoc} · ${st.ref}</span>` : ""}${st.title}`);
      $("#how-text", root).textContent = st.text;
      put($("#how-code", root), st.code ? html`<span>In the code</span>${st.code}` : html``);
      $("#how-count", root).textContent = `step ${step + 1} of ${steps.length}`;
      $$(".how-step", root).forEach((b) => b.classList.toggle("on", +b.dataset.step === step));
      const routes = new Set(st.moves.map(([, name]) => edgeFor(name).id));
      for (const [id, path] of Object.entries(pathOf)) path.classList.toggle("route", routes.has(id));
    }
    for (const [id, slots] of Object.entries(s.slots)) {
      range(scene.nodes[id].slots).forEach((i) => {
        const slot = $(`[data-slot="${id}-${i}"]`, svg);
        slot.classList.toggle("full", Boolean(slots[i]));
        fit($("text", slot), slots[i] || "·", +$("rect", slot).getAttribute("width") - 8);
      });
    }
    for (const [id, text] of Object.entries(s.sub)) {
      fit($(`[data-sub="${id}"]`, svg), text, room[id]);
      const idle = scene.nodes[id].idle;
      $(`[data-node="${id}"]`, svg).classList.toggle("busy", idle !== undefined && text !== idle);
    }
    for (const [id, n] of Object.entries(s.badge)) {
      const badge = $(`[data-badge="${id}"]`, svg);
      badge.classList.toggle("show", Boolean(n));
      $("text", badge).textContent = n || "";
    }
    showLog(s.log, before.log.length);
    showTables(st, s);

    const lit = new Set(st.focus || []);
    const busyEdges = new Map();
    let used = 0;
    for (const [text, name, from, to, kind] of st.moves) {
      if (p < from || p > to || used >= tokens.length) continue;
      const { id, back } = edgeFor(name);
      const x = ease((p - from) / (to - from));
      const pt = pathOf[id].getPointAtLength(lengthOf[id] * (back ? 1 - x : x));
      const token = tokens[used++];
      label(token, text);
      token.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
      token.style.setProperty("--k", KIND[kind]);
      token.classList.add("show");
      busyEdges.set(id, { kind, back });
      name.split(">").forEach((n) => lit.add(n));
    }
    tokens.slice(used).forEach((t) => t.classList.remove("show"));
    $$(".node", svg).forEach((g) => g.classList.toggle("on", lit.has(g.dataset.node)));
    for (const [id, path] of Object.entries(pathOf)) {
      const busy = busyEdges.get(id);
      path.classList.toggle("on", Boolean(busy));
      path.classList.toggle("back", Boolean(busy?.back));
      if (busy) path.style.setProperty("--k", KIND[busy.kind]);
      // An arrowhead in the note's colour where it's going; a backbone edge keeps a faint one
      const tip = busy ? `${busy.back ? "marker-start" : "marker-end"} ${busy.kind}` : faint(id);
      if (tips.get(id) !== tip) {
        tips.set(id, tip);
        path.removeAttribute("marker-start");
        path.removeAttribute("marker-end");
        if (tip) {
          const [where, kind] = tip.split(" ");
          path.setAttribute(where, `url(#how-tip-${kind})`);
        }
      }
    }

    const done = steps.slice(0, step).reduce((sum, x) => sum + x.dur, 0) + p * st.dur;
    $("#how-progress", root).style.width = `${(100 * done) / total}%`;
    const atEnd = step === steps.length - 1 && p >= 1;
    put($("#how-play", root), html`${icon(playing ? "pause" : "play")}${playing ? "Pause" : atEnd ? "Replay" : "Play"}`);
  }

  function go(to, { play: start } = {}) {
    step = Math.max(0, Math.min(steps.length - 1, to));
    if (start !== undefined) playing = start;
    p = reduced && !playing ? 1 : 0;
    last = null;
    draw();
  }

  function frame(now) {
    if (!svg.isConnected) return;                 // the page was left: stop
    if (playing && last !== null) {
      p += ((now - last) * speed) / steps[step].dur;
      if (p >= 1) {
        if (step < steps.length - 1) { step += 1; p = 0; } else { p = 1; playing = false; }
      }
      draw();
    }
    last = now;
    requestAnimationFrame(frame);
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.();
  }

  $("#how-play", root).addEventListener("click", () => {
    if (step === steps.length - 1 && p >= 1) return go(0, { play: true });
    playing = !playing;
    last = null;
    draw();
  });
  $("#how-prev", root).addEventListener("click", () => go(p > 0.15 && !reduced ? step : step - 1));
  $("#how-next", root).addEventListener("click", () => go(step + 1));
  $("#how-restart", root).addEventListener("click", () => go(0, { play: true }));
  $("#how-full", root).addEventListener("click", toggleFull);
  $("#how-speed", root).addEventListener("click", (e) => {
    speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
    e.currentTarget.textContent = `${speed}×`;
  });
  $(".how-steps", root).addEventListener("click", (e) => {
    const b = e.target.closest(".how-step");
    if (b) go(+b.dataset.step);
  });
  const open = (e) => {
    const target = e.target.closest("[data-link]");
    if (!target) return;
    if (document.fullscreenElement) document.exitFullscreen();
    location.hash = `#/how/${target.dataset.link}`;
  };
  svg.addEventListener("click", open);
  svg.addEventListener("keydown", (e) => { if (e.key === "Enter") open(e); });
  const keys = (e) => {
    if (!svg.isConnected) return removeEventListener("keydown", keys);
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === " " && !e.target.closest("button, [data-link]")) { e.preventDefault(); $("#how-play", root).click(); }
    if (e.key === "ArrowRight") go(step + 1);
    if (e.key === "ArrowLeft") go(step - 1);
    if (e.key === "f" || e.key === "F") toggleFull();
  };
  addEventListener("keydown", keys);

  draw();
  requestAnimationFrame(frame);
}
