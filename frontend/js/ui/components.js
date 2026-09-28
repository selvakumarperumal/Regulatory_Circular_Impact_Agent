/** The pieces pages are built from: tags, page headers, panels, tables, property lists. */
import { html } from "../lib/html.js";
import { initials } from "../lib/format.js";
import { icon } from "./icons.js";

// ── Tags: a coloured dot plus a word, never colour alone ────────────────────

export const SEVERITY = {
  high: { label: "High", c: "var(--sev-high)" },
  medium: { label: "Medium", c: "var(--sev-medium)" },
  low: { label: "Low", c: "var(--sev-low)" },
};
export const GAP_STATUS = {
  open: { label: "Open", c: "var(--st-open)" },
  in_progress: { label: "In progress", c: "var(--st-progress)" },
  closed: { label: "Closed", c: "var(--st-closed)" },
  dismissed: { label: "Dismissed", c: "var(--st-quiet)" },
};
export const CIRCULAR_STATUS = {
  new: { label: "New", c: "var(--st-quiet)" },
  parsed: { label: "In progress", c: "var(--st-open)" },
  analyzed: { label: "Analysed", c: "var(--st-closed)" },
  failed: { label: "Failed", c: "var(--danger)" },
  skipped: { label: "Skipped", c: "var(--st-quiet)" },
};

/** Each regulator keeps one colour everywhere: charts, tiles and chips. */
export const REGULATORS = [["RBI", "var(--reg-rbi)"], ["SEBI", "var(--reg-sebi)"], ["IRDAI", "var(--reg-irdai)"]];
export const REG_COLOR = Object.fromEntries(REGULATORS);
export const regChip = (source) => html`<span class="chip reg" style="--c: ${REG_COLOR[source] || "var(--st-quiet)"}">${source}</span>`;

export const tag = (spec) => spec ? html`<span class="tag" style="--c: ${spec.c}"><i></i>${spec.label}</span>` : "";

/** Whether a circular applies is only known once the company has been described. */
export function applies(c, { quiet = false } = {}) {
  if (c.applicable === true) return html`<span class="pill-ok">${icon("check")}Applies to us</span>`;
  if (c.applicable === false) return html`<span class="tag" style="--c: var(--st-quiet)"><i></i>Not for us</span>`;
  if (c.status === "analyzed" && !quiet) return html`<span class="tag" style="--c: var(--st-quiet)"><i></i>Not checked</span>`;
  return quiet ? html`<span class="muted">—</span>` : "";
}

export const person = (owner) => html`<span class="person"><span class="avatar">${initials(owner)}</span><span>${owner}</span></span>`;

// ── Page structure ──────────────────────────────────────────────────────────

export function pageHead(eyebrow, title, lead, actions = "") {
  return html`<header class="page-head">
    <div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="lead">${lead}</p></div>
    ${actions ? html`<div class="page-actions">${actions}</div>` : ""}
  </header>`;
}

/** A card with a titled header. `count` shows beside the title; `actions` on the right. */
export function panel({ title, count, actions = "", body, id = "", flush = false }) {
  return html`<section class="panel" ${id ? html`id="${id}"` : ""}>
    ${title ? html`<header class="panel-head"><h2>${title}${count !== undefined ? html` <span class="count">${count}</span>` : ""}</h2>${actions}</header>` : ""}
    ${flush ? body : html`<div class="panel-body">${body}</div>`}
  </section>`;
}

/** A data table: `cols` is a CSS grid template, `head` the column titles, `rows` html rows. */
export function table({ cols, head, rows, empty }) {
  return html`<div style="--cols: ${cols}">
    <div class="thead" role="row">${head.map((h) => html`<div class="cell ${h.startsWith("#") ? "num" : ""}">${h.replace(/^#/, "")}</div>`)}</div>
    ${rows.length ? rows : html`<div class="empty">${empty}</div>`}
  </div>`;
}

/** A property list for detail sidebars: [[label, value], ...]. */
export const plist = (items) => html`<dl class="plist">${items.filter(Boolean).map(([k, v]) =>
  html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;

export function segmented(name, choices, selected) {
  return html`<div class="segmented" role="radiogroup">${choices.map(([value, label, color]) => html`
    <label><input type="radio" name="${name}" value="${value}" ${value === selected ? html`checked` : ""} />
      <span>${color ? html`<i style="--c: ${color}"></i>` : ""}${label}</span></label>`)}</div>`;
}

export function emptyState({ iconName, title, text, actions = "", extra = "" }) {
  return html`<div class="panel"><div class="empty-state">
    <span class="icon">${icon(iconName)}</span><h2>${title}</h2><p>${text}</p>
    ${actions ? html`<div class="page-actions">${actions}</div>` : ""}${extra}
  </div></div>`;
}
