/** Circulars: the list (a filterable, searchable table) and a circular's own page. */
import { api } from "../lib/api.js";
import { $, $$, html, put } from "../lib/html.js";
import { dueInfo, fmtDate, gapParts, plural } from "../lib/format.js";
import { icon } from "../ui/icons.js";
import { busy, dimWhile, toast } from "../ui/feedback.js";
import { CIRCULAR_STATUS, GAP_STATUS, SEVERITY, applies, pageHead, panel, plist, regChip, segmented, table, tag } from "../ui/components.js";
import { filters } from "../app/state.js";
import { setCrumbs } from "../app/router.js";
import { refreshBadges } from "../app/status.js";

// ── The list ────────────────────────────────────────────────────────────────

const STATUS_FILTERS = [["active", "All but skipped"], ["all", "Everything"], ["analyzed", "Analysed"],
                        ["waiting", "Waiting for the worker"], ["failed", "Failed"], ["skipped", "Skipped (too old)"]];

export async function circularsPage() {
  setCrumbs([["Circulars"]]);
  const f = filters.circulars;
  put($("#view"), html`
    ${pageHead("Circulars", "From the regulators",
               "Found by the watcher, read with OCR, and checked against your company and policy library by the worker.")}
    <section class="panel">
      <div class="table-toolbar">
        ${segmented("f-source", [["", "All"], ["RBI", "RBI"], ["SEBI", "SEBI"], ["IRDAI", "IRDAI"]], f.source)}
        <select id="f-status" aria-label="Status">${STATUS_FILTERS.map(([v, l]) =>
          html`<option value="${v}" ${v === f.status ? html`selected` : ""}>${l}</option>`)}</select>
        <input id="f-q" type="search" placeholder="Search titles and addressees" value="${f.q}" />
        <span class="count" id="count"></span>
      </div>
      <div id="circular-table"><div class="empty">Loading…</div></div>
    </section>`);
  $$("input[name=f-source]").forEach((r) => r.addEventListener("change", () => { f.source = r.value; loadTable(); }));
  $("#f-status").addEventListener("change", (e) => { f.status = e.target.value; loadTable(); });
  $("#f-q").addEventListener("input", (e) => { f.q = e.target.value; loadTable(); });
  await loadTable();
}

async function loadTable() {
  const f = filters.circulars;
  const q = new URLSearchParams({ limit: "500" });
  if (f.source) q.set("source", f.source);
  if (["analyzed", "failed", "skipped"].includes(f.status)) q.set("status", f.status);
  let rows = await dimWhile($("#circular-table"), api(`/circulars?${q}`));
  if (f.status === "active") rows = rows.filter((c) => c.status !== "skipped");
  if (f.status === "waiting") rows = rows.filter((c) => c.status === "new" || c.status === "parsed");
  const needle = f.q.trim().toLowerCase();
  if (needle) rows = rows.filter((c) => `${c.title} ${c.addressed_to ?? ""}`.toLowerCase().includes(needle));
  $("#count").textContent = plural(rows.length, "circular");
  put($("#circular-table"), table({
    cols: "70px minmax(0, 1fr) 120px 130px 120px",
    head: ["Source", "Circular", "Published", "For us", "Status"],
    rows: rows.map((c) => html`<a class="trow" href="#/circulars/${c.id}">
      <div class="cell">${regChip(c.source)}</div>
      <div class="cell"><div class="cell-title">${c.title}</div>
        ${c.addressed_to ? html`<div class="cell-sub">To: ${c.addressed_to}</div>` : ""}</div>
      <div class="cell muted">${fmtDate(c.published_at)}</div>
      <div class="cell">${applies(c, { quiet: true })}</div>
      <div class="cell">${tag(CIRCULAR_STATUS[c.status])}</div>
    </a>`),
    empty: "No circulars match these filters.",
  }));
}

// ── One circular ────────────────────────────────────────────────────────────

export async function circularPage({ id }) {
  setCrumbs([["Circulars", "#/circulars"], [`Circular #${id}`]]);
  const { circular: c, gaps, checks } = await dimWhile($("#view"), api(`/circulars/${id}`));
  const analysed = c.status === "analyzed";

  put($("#view"), html`
    <header class="detail-head">
      <div class="eyebrow">${c.source} circular · ${fmtDate(c.published_at)}</div>
      <h1>${c.title}</h1>
      <div class="tags">${tag(CIRCULAR_STATUS[c.status])} ${applies(c)}</div>
    </header>

    <div class="detail">
      <div class="detail-main">
        ${c.error ? panel({ title: "Why it failed", body: html`<div class="callout" style="--c: var(--danger)">${c.error}</div>` }) : ""}
        ${analysed ? html`
          ${panel({ title: "Summary", body: html`<p class="prose">${c.summary || "—"}</p>` })}
          ${panel({
            title: "What it requires", count: c.requirements?.length ?? 0,
            body: c.requirements?.length ? html`<ol class="obligations">${c.requirements.map((r) => html`<li><span>${r}</span></li>`)}</ol>`
                                         : html`<p class="hint">Nothing: the circular is informational.</p>`,
          })}`
        : panel({ body: html`<p class="hint">Not analysed yet. The worker picks circulars up newest first, within a minute or two.</p>` })}
        ${panel({
          title: "Gaps opened", count: gaps.length, flush: Boolean(gaps.length),
          body: gaps.length ? gapTable(gaps)
            : html`<p class="hint">${!analysed ? "None yet."
                : c.applicable === null ? "Not checked against your policies: the company hasn't been described yet."
                : c.applicable ? "No policy in the library was found out of date."
                : "It doesn't apply to the company, so no policy was checked."}</p>`,
        })}
        ${checks.length ? panel({
          title: "Checked against your policies", count: checks.length, flush: true,
          body: table({
            cols: "minmax(0, 1fr) 90px 130px",
            head: ["Policy", "Similarity", "Verdict"],
            rows: checks.map((k) => html`<a class="trow" href="#/policies/${k.policy_id}">
              <div class="cell"><div class="cell-title"><span class="chip">${k.code}</span> ${k.title}</div>
                <div class="cell-sub">Version ${k.version} · checked ${fmtDate(k.checked_at)}</div></div>
              <div class="cell num">${Math.round(k.similarity * 100)}%</div>
              <div class="cell">${tag(k.impacted ? { label: "Out of date", c: "var(--danger)" } : { label: "Up to date", c: "var(--ok)" })}</div>
            </a>`),
          }),
        }) : ""}
        ${panel({
          title: "OCR text",
          body: html`<details class="more" id="ocr-toggle"><summary>Show the text read from the PDF</summary>
            <div id="ocr"><p class="hint">Loading…</p></div></details>`,
        })}
      </div>

      <aside class="detail-side">
        ${panel({
          title: "Details",
          body: plist([
            ["Regulator", regChip(c.source)],
            ["Published", fmtDate(c.published_at)],
            ["Status", tag(CIRCULAR_STATUS[c.status])],
            analysed && ["Addressed to", c.addressed_to || html`<span class="muted">Not named</span>`],
            analysed && ["For us", c.applicable === null
              ? html`<span class="muted">Not checked. <a href="#/company">Describe your company</a> first.</span>`
              : html`${applies(c)}<span class="muted">${c.applies_reason}</span>`],
          ]),
        })}
        ${panel({
          title: "Source",
          body: html`<div class="links">
            <a href="${c.detail_url}" target="_blank" rel="noopener">${icon("external")}Regulator's page</a>
            <a href="${c.pdf_url}" target="_blank" rel="noopener">${icon("file")}The PDF</a></div>`,
        })}
        ${panel({
          title: "Run it again",
          body: html`<div class="form"><p class="hint">Gemini reads the saved OCR text again and re-checks it against your policies.
            No new OCR, and gaps already opened are kept.</p>
            <button class="btn block" id="reprocess">${icon("refresh")}Reprocess</button></div>`,
        })}
      </aside>
    </div>`);

  $("#reprocess").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    await api(`/circulars/${c.id}/reprocess`, { method: "POST" });
    toast("Queued: the worker picks it up within a minute");
    await circularPage({ id });
    refreshBadges();
  }));
  $("#ocr-toggle").addEventListener("toggle", async (e) => {
    if (!e.target.open || e.target.dataset.loaded) return;
    e.target.dataset.loaded = "1";
    try {
      const ocr = await api(`/circulars/${c.id}/text`);
      put($("#ocr"), ocr ? html`<pre class="ocr">${ocr}</pre>` : html`<p class="hint">No OCR text yet.</p>`);
    } catch (err) {
      put($("#ocr"), html`<p class="hint">${err.message}</p>`);
    }
  });
}

/** Gaps as a compact table, for circular and policy pages. */
export function gapTable(gaps) {
  return table({
    cols: "90px minmax(0, 1fr) 120px 140px",
    head: ["Severity", "Gap", "Status", "Due"],
    rows: gaps.map((g) => {
      const { code, subject } = gapParts(g);
      const due = dueInfo(g);
      return html`<a class="trow" href="#/gaps/${g.id}">
        <div class="cell">${tag(SEVERITY[g.severity])}</div>
        <div class="cell"><div class="cell-title">${subject}</div><div class="cell-sub">${code ? html`<span class="chip">${code}</span> ` : ""}gap #${g.id}</div></div>
        <div class="cell">${tag(GAP_STATUS[g.status])}</div>
        <div class="cell ${due.overdue ? "overdue" : "muted"}">${due.text}</div>
      </a>`;
    }),
    empty: "",
  });
}
