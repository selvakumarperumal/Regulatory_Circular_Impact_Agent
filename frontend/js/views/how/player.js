/** The player behind every How it works animation. A scene is plain data: nodes, edges,
 * and steps, each with a caption, the tokens that move along the edges, and marks that
 * change what the nodes say. What's drawn is a pure function of (step, progress through
 * it): the state at a moment is the scene's start plus every mark up to that moment, and
 * a token is on its edge while its move runs. So pausing, stepping back and changing the
 * speed only draw another moment.
 *
 * A scene: { id, tab, label, size: [w, h], nodes, edges: { "a>b": path }, groups, start,
 *           stories, steps, quietEdges (draw only the edges the current step uses) }
 * A step: { story, dur, title, text, code, focus: [node ids],
 *           moves: [[label, "from>to", start, end, kind], …],   (start, end: 0 to 1)
 *           marks: [[moment, { sub, slots, badge, log }], …] }
 * A move along "b>a" when only "a>b" is drawn runs the same edge backwards. */
import { $, $$, html, put } from "../../lib/html.js";
import { icon } from "../../ui/icons.js";

// The same colours as the diagrams in the docs.
export const KIND = {
  svc: "#2dd4bf", data: "#818cf8", ext: "#c084fc", gpu: "#fb923c", queue: "#38bdf8",
  start: "#a7ef6f", ask: "#fbbf24", gap: "#fb7185", bad: "#fb7185", ok: "#34d399",
};

// The log panel's line types.
const LOG = {
  http: ["HTTP", "#a7ef6f"], sql: ["SQL", "#818cf8"], redis: ["Redis", "#38bdf8"], s3: ["S3", "#a5b4fc"],
  llm: ["Gemini", "#c084fc"], ocr: ["OCR", "#fb923c"], log: ["log", "#5eead4"], warn: ["warn", "#fbbf24"],
  error: ["error", "#fb7185"], app: ["app", "#cbd5e1"],
};
const LOG_LINES = 7;

/** A node: node(x, y, w, h, kind, title, sub, { slots, idle, link, badge, mono, inline }).
 * idle: the sub-line that means "not busy"; any other sub-line makes the node glow as busy.
 * link: the scene that shows this part in detail (clicking the node opens it). */
export const node = (x, y, w, h, kind, title, sub = "", opts = {}) => ({ x, y, w, h, kind, title, sub, ...opts });

/** Path helpers for a scene: at(id, side, offset) is a point on a node's side. */
export function geometry(nodes) {
  const at = (id, side, d = 0) => {
    const { x, y, w, h } = nodes[id];
    return { l: [x - w / 2, y + d], r: [x + w / 2, y + d], t: [x + d, y - h / 2], b: [x + d, y + h / 2] }[side];
  };
  return { at, line: (a, b) => `M${a} L${b}`, curve: (a, c1, c2, b) => `M${a} C${c1} ${c2} ${b}` };
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
  const s = { sub: {}, slots: {}, badge: {}, log: [] };
  for (const [id, n] of Object.entries(scene.nodes)) {
    s.sub[id] = n.sub;
    if (n.slots) s.slots[id] = [];
  }
  apply(s, scene.start || {});
  scene.steps.slice(0, step + 1).forEach((st, k) => {
    const marks = [...(st.marks || [])].sort((a, b) => a[0] - b[0]);
    for (const [t, change] of marks) if (k < step || t <= p) apply(s, change);
  });
  return s;
}

// ── Drawing ────────────────────────────────────────────────────────────────

function nodeSvg(id, n) {
  const { x, y, w, h, kind, title, slots } = n;
  const top = y - h / 2;
  const gap = 6;
  const sw = slots ? Math.min(78, (w - 24 - (slots - 1) * gap) / slots) : 0;
  const sx = x - (slots * sw + (slots - 1) * gap) / 2;
  // inline: a one-line row (a table, a service): the title on the left, the line on the right
  const [tx, sx2, ty, sy] = n.inline ? [x - w / 2 + 14, x + w / 2 - 14, y + 5, y + 5]
    : [x, x, slots ? top + 22 : y - 3, slots ? top + 38 : y + 15];
  return html`<g class="node${n.link ? " link" : ""}${n.inline ? " inline" : ""}" data-node="${id}" style="--k: ${KIND[kind]}"
      ${n.link ? html`data-link="${n.link}" tabindex="0" role="link" aria-label="${title}: see it in detail"` : ""}>
    ${n.link ? html`<title>${title}: click to see it in detail</title>` : ""}
    <rect x="${x - w / 2}" y="${top}" width="${w}" height="${h}" rx="${n.inline ? 10 : 14}" />
    <text class="node-title" x="${tx}" y="${ty}">${title}</text>
    <text class="node-sub${n.mono ? " mono" : ""}" data-sub="${id}" x="${sx2}" y="${sy}"></text>
    ${slots ? range(slots).map((i) => html`
      <g class="slot" data-slot="${id}-${i}" transform="translate(${sx + i * (sw + gap)} ${top + 50})">
        <rect width="${sw}" height="24" rx="7" /><text x="${sw / 2}" y="16.5">·</text></g>`) : ""}
    ${n.badge ? html`<g class="count-badge" data-badge="${id}" transform="translate(${x + w / 2 - 6} ${top + 6})">
      <circle r="12" /><text y="4.5"></text></g>` : ""}
    ${n.link ? html`<text class="node-open" x="${x + w / 2 - 12}" y="${top + 17}">↗</text>` : ""}
  </g>`;
}

function sceneSvg(scene) {
  const [w, h] = scene.size;
  // Never narrower than 80% of its drawn size: on a phone it scrolls sideways instead of shrinking
  return html`<svg class="how-svg${scene.quietEdges ? " quiet" : ""}" viewBox="0 0 ${w} ${h}" role="img"
      aria-label="${scene.label}" style="min-width: ${Math.round(w * 0.8)}px">
    <g class="groups">${(scene.groups || []).map(([x, y, gw, gh, label]) => html`<g class="group">
      <rect x="${x}" y="${y}" width="${gw}" height="${gh}" rx="18" /><text x="${x + 16}" y="${y + 22}">${label}</text></g>`)}</g>
    <g class="edges">${Object.entries(scene.edges).map(([id, d]) => html`<path class="edge" data-edge="${id}" d="${d}" />`)}</g>
    <g class="nodes">${Object.entries(scene.nodes).map(([id, n]) => nodeSvg(id, n))}</g>
    <g class="tokens">${range(9).map(() => html`<g class="token"><rect height="26" rx="13" y="-13" /><text y="4.5"></text></g>`)}</g>
  </svg>`;
}

function stepList(scene) {
  return scene.stories.map((story, s) => html`
    <li class="how-story-head">${story}</li>
    ${scene.steps.map((st, i) => st.story === s ? html`<li><button type="button" class="how-step" data-step="${i}">
      <span class="how-num">${i + 1}</span><span>${st.title}</span></button></li>` : "")}`);
}

const LEGEND = [["svc", "our code"], ["data", "data"], ["ext", "Gemini, outside sites"], ["gpu", "OCR on the GPU"],
                ["queue", "a task, Redis"], ["ask", "a check"], ["gap", "a gap, a failure"]];

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
        <div class="how-log" role="log" aria-label="What the logs, Redis and Postgres see">
          <div class="how-log-head"><b>Underneath</b><span>what the logs, Redis, Postgres and the network see</span></div>
          <ol id="how-log"></ol>
        </div>
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
      <aside class="panel how-steps"><ol>${stepList(scene)}</ol></aside>
    </div>`);

  const steps = scene.steps;
  const total = steps.reduce((n, s) => n + s.dur, 0);
  const svg = $(".how-svg", root);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pathOf = Object.fromEntries($$(".edge", svg).map((p) => [p.dataset.edge, p]));
  const lengthOf = Object.fromEntries(Object.entries(pathOf).map(([id, p]) => [id, p.getTotalLength()]));
  const tokens = $$(".token", svg);
  const widths = new Map();
  let step = 0, p = reduced ? 1 : 0, playing = !reduced, speed = 1, last = null, shownStep = -1, shownLog = "";
  const shown = new Map();                        // text element → the text last put in it

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
  /** The room a node's sub-line has: the box, less the title when they share the line. */
  const room = Object.fromEntries(Object.entries(scene.nodes).map(([id, n]) => {
    const title = $(`[data-node="${id}"] .node-title`, svg);
    return [id, n.inline ? n.w - 42 - title.getComputedTextLength() : n.w - 16];
  }));

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

  function showLog(lines) {
    const key = lines.length + (lines.at(-1)?.[1] ?? "");
    if (key === shownLog) return;
    shownLog = key;
    const recent = lines.slice(-LOG_LINES);
    put($("#how-log", root), html`${recent.map(([type, text], i) => html`
      <li class="${i === recent.length - 1 ? "new" : ""}" style="--c: ${LOG[type][1]}"><b>${LOG[type][0]}</b><code>${text}</code></li>`)}
      ${recent.length ? "" : html`<li class="none">Nothing yet: press play.</li>`}`);
  }

  function draw() {
    const st = steps[step];
    const s = stateAt(scene, step, p);
    if (shownStep !== step) {
      shownStep = step;
      $("#how-story", root).textContent = scene.stories[st.story];
      $("#how-title", root).textContent = `${step + 1}. ${st.title}`;
      $("#how-text", root).textContent = st.text;
      put($("#how-code", root), st.code ? html`<span>In the code</span>${st.code}` : html``);
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
    showLog(s.log);

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

  $("#how-play", root).addEventListener("click", () => {
    if (step === steps.length - 1 && p >= 1) return go(0, { play: true });
    playing = !playing;
    last = null;
    draw();
  });
  $("#how-prev", root).addEventListener("click", () => go(p > 0.15 && !reduced ? step : step - 1));
  $("#how-next", root).addEventListener("click", () => go(step + 1));
  $("#how-restart", root).addEventListener("click", () => go(0, { play: true }));
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
    if (target) location.hash = `#/how/${target.dataset.link}`;
  };
  svg.addEventListener("click", open);
  svg.addEventListener("keydown", (e) => { if (e.key === "Enter") open(e); });
  const keys = (e) => {
    if (!svg.isConnected) return removeEventListener("keydown", keys);
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === " " && !e.target.closest("button, [data-link]")) { e.preventDefault(); $("#how-play", root).click(); }
    if (e.key === "ArrowRight") go(step + 1);
    if (e.key === "ArrowLeft") go(step - 1);
  };
  addEventListener("keydown", keys);

  draw();
  requestAnimationFrame(frame);
}
