/** Overview: the compliance dashboard. Every number is computed from the API's data
 * (circulars, gaps, policies, the company); nothing on this page is made up. */
import { api } from "../lib/api.js";
import { $, $$, html, put } from "../lib/html.js";
import { OPEN, dueInfo, fmtDate, gapParts, parseDate, plural } from "../lib/format.js";
import { icon } from "../ui/icons.js";
import { dimWhile } from "../ui/feedback.js";
import { CIRCULAR_STATUS, GAP_STATUS, REG_COLOR, SEVERITY, applies, panel, tag } from "../ui/components.js";
import { filters } from "../app/state.js";
import { setCrumbs } from "../app/router.js";
import { firstName } from "../app/session.js";

const DAY = 864e5;

export async function overviewPage() {
  setCrumbs([["Overview"]]);
  const view = $("#view");
  if (!$(".hero", view)) put(view, html`<div class="empty">Loading…</div>`);

  const [stats, gaps, circulars, policies, account] = await dimWhile(view, Promise.all([
    api("/stats"), api("/gaps"), api("/circulars?limit=500"), api("/policies"), api("/company"),
  ]));
  const company = account.profile ? account : null;       // null until it's described
  const d = derive(gaps, circulars, company);

  put(view, html`
    ${hero(d, stats, policies, company)}
    ${stats.circulars.failed ? html`<div class="banner warn">${icon("alert")}
      <p><b>${plural(stats.circulars.failed, "circular")} failed</b> to process. Open one to see the error, then reprocess it.</p>
      <a class="btn sm" href="#/circulars" data-status="failed">Review</a></div>` : ""}
    ${kpis(d, company)}
    <div class="dash">
      ${panel({
        title: "Due next", count: d.open.length || undefined, flush: true,
        actions: html`<a href="#/gaps" data-filter='{}'>All gaps →</a>`,
        body: d.open.length ? html`<ul class="list">${d.open.slice(0, 6).map(dueRow)}</ul>`
          : html`<div class="empty">${company && policies.length ? "Nothing open. Every gap is closed." : "No gaps yet: finish setting up the agent first."}</div>`,
      })}
      ${panel({ title: "Exposure by policy", body: exposure(d.open, policies) })}
    </div>
    ${panel({
      title: "Latest circulars", flush: true,
      actions: html`<a href="#/circulars">All circulars →</a>`,
      body: html`<ul class="list">${circulars.filter((c) => c.status !== "skipped").slice(0, 6).map(circularRow)}</ul>`,
    })}`);

  // tiles and links open their list with the matching filter
  $$("[data-filter]", view).forEach((a) => a.addEventListener("click", () => {
    Object.assign(filters.gaps, { status: "", owner: "", overdue: false }, JSON.parse(a.dataset.filter));
  }));
  $$("[data-status]", view).forEach((a) => a.addEventListener("click", () => {
    Object.assign(filters.circulars, { source: "", q: "", status: a.dataset.status });
  }));
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const dayStart = (v) => { const x = new Date(v); x.setHours(0, 0, 0, 0); return x; };
const today = () => dayStart(new Date());

/** How many dates fall on each of the last `days` days, oldest first. */
function perDay(dates, days = 30) {
  const start = today() - (days - 1) * DAY;
  const counts = Array(days).fill(0);
  for (const v of dates) {
    const i = Math.round((dayStart(parseDate(v)) - start) / DAY);
    if (v && i >= 0 && i < days) counts[i] += 1;
  }
  return counts;
}

function derive(gaps, circulars, company) {
  const since = (days) => today() - days * DAY;
  const published = circulars.filter((c) => c.published_at).map((c) => ({ ...c, t: parseDate(c.published_at) }));
  const analysed = circulars.filter((c) => c.status === "analyzed");
  const open = gaps.filter((g) => OPEN.includes(g.status));
  const inWeek = today() - 0 + 7 * DAY;
  return {
    open,
    analysed,
    applicable: analysed.filter((c) => c.applicable),
    inflow: published.filter((c) => c.t >= since(29)).length,
    inflowBefore: published.filter((c) => c.t >= since(59) && c.t < since(29)).length,
    inflowDaily: perDay(published.map((c) => c.published_at)),
    applicableDaily: company ? perDay(analysed.filter((c) => c.applicable).map((c) => c.published_at)) : null,
    opened: gaps.filter((g) => parseDate(g.created_at) >= since(29)).length,
    openedDaily: perDay(gaps.map((g) => g.created_at)),
    overdue: open.filter((g) => dueInfo(g).overdue).length,
    dueThisWeek: open.filter((g) => !dueInfo(g).overdue && parseDate(g.due_date) <= inWeek).length,
  };
}

// ── Hero ────────────────────────────────────────────────────────────────────

function hero(d, stats, policies, company) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const name = firstName();
  const setupDone = company && policies.length;
  const bySev = ["high", "medium", "low"].map((s) => [s, d.open.filter((g) => g.severity === s).length]);

  const step = (done, n, title, text, href, action) => html`<li class="${done ? "done" : ""}">
    <span class="num">${done ? icon("check") : n}</span>
    <div><b>${title}</b><p>${text}</p></div>
    ${done ? "" : html`<a class="btn sm primary" href="${href}">${action}</a>`}</li>`;

  return html`<section class="hero">
    <div>
      <div class="hero-top">
        <span class="greet">${greeting}${name ? `, ${name}` : ""}</span>
        <span class="live"><i></i>Watching RBI · SEBI · IRDAI</span>
      </div>
      <div class="label">Regulatory exposure</div>
      <div class="figure"><b>${d.open.length}</b><span>${d.open.length === 1 ? "gap" : "gaps"} to close</span></div>
      <div class="chips">
        ${d.open.length ? html`${bySev.map(([s, n]) => html`<span><i style="background: ${SEVERITY[s].c}; color: ${SEVERITY[s].c}"></i>${SEVERITY[s].label} ${n}</span>`)}
            <span class="${d.overdue ? "hot" : ""}">${d.overdue} overdue</span><span>${d.dueThisWeek} due this week</span>`
          : html`<span class="ok">${icon("check")} All clear</span>`}
      </div>
      <div class="actions">
        <a class="btn primary" href="#/gaps" data-filter='{}'>Review gaps ${icon("arrow")}</a>
        <a class="btn glass" href="#/circulars">Browse circulars</a>
      </div>
    </div>
    <div class="hero-side">
      ${setupDone ? html`
        <a class="glass glass-stat" href="#/circulars" data-status="analyzed">
          <span class="k">Circulars analysed<small>read and summarised by the agent</small></span><span class="v">${d.analysed.length}</span></a>
        <a class="glass glass-stat" href="#/circulars" data-status="analyzed">
          <span class="k">Apply to us<small>${d.analysed.length ? Math.round((d.applicable.length / d.analysed.length) * 100) : 0}% of those analysed</small></span>
          <span class="v">${d.applicable.length}</span></a>
        <a class="glass glass-stat" href="#/policies">
          <span class="k">Policies in the library<small>checked against every circular that applies</small></span><span class="v">${policies.length}</span></a>`
      : html`<div class="glass glass-steps">
          <h2>Set up the agent</h2>
          <ol>
            ${step(Boolean(company), 1, "Describe your company", "So it knows which circulars apply to you.", "#/company", "Describe it")}
            ${step(policies.length > 0, 2, "Add your policies", "So it can find the ones that are out of date.", "#/policies", "Add policies")}
          </ol>
        </div>`}
    </div>
  </section>`;
}

// ── KPI cards ───────────────────────────────────────────────────────────────

let sparkId = 0;
function sparkline(counts, color, label) {
  const w = 120, h = 36, max = Math.max(1, ...counts), id = `spark-${++sparkId}`;
  const pts = counts.map((v, i) => [(i / (counts.length - 1)) * w, h - 2 - (v / max) * (h - 6)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const total = counts.reduce((a, b) => a + b, 0);
  return html`<div class="spark" style="--c: ${color}" tabindex="0" data-tip data-tip-value="${total}" data-tip-label="${label}">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color: ${color}; stop-opacity: 0.3"></stop>
        <stop offset="1" style="stop-color: ${color}; stop-opacity: 0"></stop>
      </linearGradient></defs>
      <path d="${line}L${w},${h}L0,${h}Z" style="fill: url(#${id})"></path>
      <path class="line" d="${line}" style="fill: none; stroke: ${color}" stroke-width="2" vector-effect="non-scaling-stroke"
            stroke-linejoin="round" stroke-linecap="round"></path>
    </svg>
    <span class="dot" style="top: ${16 + (pts.at(-1)[1] / h) * 44}px"></span>
  </div>`;
}

function delta(now, before) {
  if (!before) return html`<span class="delta">${now ? "new" : "—"}</span>`;
  const pct = Math.round(((now - before) / before) * 100);
  return html`<span class="delta">${pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} ${Math.abs(pct)}%</span>`;
}

function kpis(d, company) {
  const card = ({ href, color, iconName, label, value, alert = false, foot, extra = "", attrs = "" }) => html`
    <a class="panel kpi" href="${href}" style="--c: ${color}" ${attrs}>
      <div class="kpi-top"><span class="kpi-icon">${icon(iconName)}</span><span class="label">${label}</span></div>
      <div class="value ${alert ? "alert" : ""}">${value}</div>
      <div class="foot">${foot}</div>
      ${extra}
    </a>`;
  const overdueShare = d.open.length ? (d.overdue / d.open.length) * 100 : 0;
  return html`<section class="kpis">
    ${card({
      href: "#/circulars", color: "var(--st-info)", iconName: "file", label: "Regulatory inflow",
      value: d.inflow, foot: html`${delta(d.inflow, d.inflowBefore)} circulars in 30 days, vs ${d.inflowBefore} before`,
      extra: sparkline(d.inflowDaily, "var(--st-info)", "circulars published in the last 30 days"),
    })}
    ${card({
      href: company ? "#/circulars" : "#/company", color: "var(--ok)", iconName: "shield", label: "Apply to us",
      value: company ? d.applicable.length : "—",
      foot: company ? html`of ${plural(d.analysed.length, "circular")} analysed` : html`Describe your company to find out`,
      extra: d.applicableDaily ? sparkline(d.applicableDaily, "var(--ok)", "circulars that apply to us, by publication date") : "",
    })}
    ${card({
      href: "#/gaps", color: "var(--accent)", iconName: "flag", label: "Gaps opened",
      value: d.opened, foot: html`in 30 days · ${d.open.length} still open`, attrs: html`data-filter='{}'`,
      extra: sparkline(d.openedDaily, "var(--accent)", "gaps opened in the last 30 days"),
    })}
    ${card({
      href: "#/gaps", color: "var(--danger)", iconName: "alert", label: "Overdue", alert: d.overdue > 0,
      value: d.overdue, foot: html`${d.dueThisWeek} more due in the next 7 days`, attrs: html`data-filter='{"overdue":true}'`,
      extra: html`<div class="meter"><div class="track"><div class="fill" style="width: ${overdueShare}%"></div></div>
        <div class="cap"><span>${d.open.length ? `${d.overdue} of ${d.open.length} open gaps` : "No open gaps"}</span>
        <span>${Math.round(overdueShare)}%</span></div></div>`,
    })}
  </section>`;
}

// ── Exposure by policy ──────────────────────────────────────────────────────

function exposure(open, policies) {
  if (!policies.length) {
    return html`<div class="empty" style="padding: 24px 0">Add your policies to see which ones circulars affect.
      <div style="margin-top: 14px"><a class="btn sm primary" href="#/policies">Add policies</a></div></div>`;
  }
  const byPolicy = policies.map((p) => ({ p, n: open.filter((g) => g.policy_id === p.id).length }))
    .filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 5);
  if (!byPolicy.length) return html`<div class="empty" style="padding: 24px 0">No policy has an open gap.</div>`;
  const max = byPolicy[0].n;
  return html`<div class="xbars">${byPolicy.map(({ p, n }) => html`
    <a class="xbar" href="#/policies/${p.id}">
      <div class="top"><span class="name"><span class="chip">${p.code}</span> ${p.title}</span><span class="n">${n}<small>open</small></span></div>
      <div class="track"><div class="fill" style="width: ${(n / max) * 100}%"></div></div>
    </a>`)}</div>`;
}

// ── Lists ───────────────────────────────────────────────────────────────────

function dueRow(g) {
  const { code, subject } = gapParts(g);
  const due = dueInfo(g);
  return html`<li><a href="#/gaps/${g.id}">
    <span class="sev-bar" style="--c: ${SEVERITY[g.severity]?.c}" title="${SEVERITY[g.severity]?.label} severity"></span>
    <div><div class="cell-title">${subject}</div>
      <div class="meta">${code ? html`<span class="chip">${code}</span>` : ""}${tag(GAP_STATUS[g.status])}<span>${g.owner}</span></div></div>
    <div class="end ${due.overdue ? "overdue" : "muted"}">${due.text}</div>
  </a></li>`;
}

function circularRow(c) {
  return html`<li><a href="#/circulars/${c.id}">
    <span class="reg-tile" style="--c: ${REG_COLOR[c.source]}">${c.source}</span>
    <div><div class="cell-title">${c.title}</div>
      <div class="meta"><span>${fmtDate(c.published_at)}</span>${c.addressed_to ? html`<span>To: ${c.addressed_to.slice(0, 80)}${c.addressed_to.length > 80 ? "…" : ""}</span>` : ""}</div></div>
    <div class="end">${c.status === "analyzed" ? applies(c) : tag(CIRCULAR_STATUS[c.status])}</div>
  </a></li>`;
}
