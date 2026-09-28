/** Gaps: the list (a filterable table) and a gap's own page. */
import { api } from "../lib/api.js";
import { $, $$, html, put } from "../lib/html.js";
import { dueInfo, fmtDate, fmtDateTime, gapParts, plural } from "../lib/format.js";
import { icon } from "../ui/icons.js";
import { busy, dimWhile, toast } from "../ui/feedback.js";
import { GAP_STATUS, SEVERITY, pageHead, panel, person, plist, segmented, table, tag } from "../ui/components.js";
import { filters } from "../app/state.js";
import { setCrumbs } from "../app/router.js";
import { refreshBadges } from "../app/status.js";

// ── The list ────────────────────────────────────────────────────────────────

export async function gapsPage() {
  setCrumbs([["Gaps"]]);
  const f = filters.gaps;
  put($("#view"), html`
    ${pageHead("Gaps", "Policies to update", "Each gap is a policy a circular has made out of date, with a drafted change for its owner.")}
    <section class="panel">
      <div class="table-toolbar">
        ${segmented("f-status", [["", "All"], ["open", "Open", GAP_STATUS.open.c], ["in_progress", "In progress", GAP_STATUS.in_progress.c],
                                 ["closed", "Closed", GAP_STATUS.closed.c], ["dismissed", "Dismissed", GAP_STATUS.dismissed.c]], f.status)}
        <input id="f-owner" type="search" placeholder="Filter by owner email" value="${f.owner}" />
        <div class="checks"><label><input id="f-overdue" type="checkbox" ${f.overdue ? html`checked` : ""} /><span>Overdue only</span></label></div>
        <span class="count" id="count"></span>
      </div>
      <div id="gap-table"><div class="empty">Loading…</div></div>
    </section>`);
  $$("input[name=f-status]").forEach((r) => r.addEventListener("change", () => { f.status = r.value; loadTable(); }));
  $("#f-owner").addEventListener("change", (e) => { f.owner = e.target.value.trim(); loadTable(); });
  $("#f-overdue").addEventListener("change", (e) => { f.overdue = e.target.checked; loadTable(); });
  await loadTable();
}

async function loadTable() {
  const f = filters.gaps;
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.owner) q.set("owner", f.owner);
  if (f.overdue) q.set("overdue", "true");
  const gaps = await dimWhile($("#gap-table"), api(`/gaps?${q}`));
  $("#count").textContent = plural(gaps.length, "gap");
  put($("#gap-table"), table({
    cols: "96px minmax(0, 1fr) 220px 120px 150px",
    head: ["Severity", "Gap", "Owner", "Status", "Due"],
    rows: gaps.map((g) => {
      const { code, source, subject } = gapParts(g);
      const due = dueInfo(g);
      return html`<a class="trow" href="#/gaps/${g.id}">
        <div class="cell">${tag(SEVERITY[g.severity])}</div>
        <div class="cell"><div class="cell-title">${subject}</div>
          <div class="cell-sub">${code ? html`<span class="chip">${code}</span> ` : ""}${source} circular · gap #${g.id}</div></div>
        <div class="cell hide-sm">${person(g.owner)}</div>
        <div class="cell">${tag(GAP_STATUS[g.status])}</div>
        <div class="cell ${due.overdue ? "overdue" : "muted"}">${due.text}</div>
      </a>`;
    }),
    empty: "No gaps match these filters.",
  }));
}

// ── One gap ─────────────────────────────────────────────────────────────────

const EVENT = {
  opened: ["sparkle", "opened this gap"],
  status: ["arrow", "changed the status"],
  owner: ["user", "reassigned it"],
  due_date: ["calendar", "moved the due date"],
  comment: ["message", "commented"],
  policy_updated: ["shield", "updated the policy"],
};
const prettyNote = (note) => note.replaceAll("in_progress", "in progress").replaceAll(" -> ", " → ");

export async function gapPage({ id }) {
  setCrumbs([["Gaps", "#/gaps"], [`Gap #${id}`]]);
  renderGap(await dimWhile($("#view"), api(`/gaps/${id}`)));
}

function renderGap({ gap, circular, policy, events }) {
  const due = dueInfo(gap);
  const sev = SEVERITY[gap.severity];
  const { code } = gapParts(gap);

  put($("#view"), html`
    <header class="detail-head">
      <div class="eyebrow">Gap #${gap.id} · opened ${fmtDate(gap.created_at)}</div>
      <h1>${policy.title}</h1>
      <p class="sub">is out of date because of the ${circular.source} circular
        <a href="#/circulars/${circular.id}">“${circular.title}”</a>.</p>
      <div class="tags">${tag(sev)} ${tag(GAP_STATUS[gap.status])}
        <span class="${due.overdue ? "overdue" : "muted"}">${due.text}</span></div>
    </header>

    <div class="detail">
      <div class="detail-main">
        ${panel({ title: "What the policy is missing", body: html`<div class="callout" style="--c: ${sev?.c}">${gap.impact}</div>` })}
        ${panel({
          title: "Proposed wording",
          actions: html`<button class="btn ghost sm" id="copy-draft">${icon("copy")}Copy</button>`,
          body: html`<div class="doc">${gap.draft_change || "No draft was produced."}</div>`,
        })}
        ${panel({
          title: "Activity", count: events.length,
          body: html`<ol class="timeline">${events.map((e) => {
            const [ico, verb] = EVENT[e.action] || ["info", e.action];
            return html`<li><span class="ico ${e.actor === "agent" ? "agent" : ""}">${icon(ico)}</span><div>
              <div class="who"><b>${e.actor}</b> ${verb} <span class="when">· ${fmtDateTime(e.at)}</span></div>
              ${e.note ? html`<div class="note">${prettyNote(e.note)}</div>` : ""}</div></li>`;
          })}</ol>`,
        })}
        ${panel({
          title: "Add a comment",
          body: html`<form class="composer" id="comment-form">
            <textarea name="note" placeholder="Leave a note for the history: a question, a decision, a link" required></textarea>
            <div class="form-foot"><button class="btn" type="submit">${icon("message")}Comment</button></div>
          </form>`,
        })}
      </div>

      <aside class="detail-side">
        ${panel({
          title: "Update",
          body: html`<form class="form" id="gap-form">
            <label class="field"><span>Status</span><select name="status">${Object.entries(GAP_STATUS).map(([v, s]) =>
              html`<option value="${v}" ${v === gap.status ? html`selected` : ""}>${s.label}</option>`)}</select></label>
            <label class="field"><span>Owner</span><input name="owner" value="${gap.owner}" /></label>
            <label class="field"><span>Due date</span><input name="due_date" type="date" value="${gap.due_date}" /></label>
            <label class="field"><span>Note</span><textarea name="note" placeholder="Why, e.g. POL-KYC v2 approved by the board"></textarea></label>
            <span class="hint">A note is required to close or dismiss.</span>
            <button class="btn primary block" type="submit">Save changes</button>
          </form>`,
        })}
        ${panel({
          title: "Details",
          body: plist([
            ["Severity", tag(sev)],
            ["Owner", person(gap.owner)],
            ["Due", html`<span class="${due.overdue ? "overdue" : ""}">${fmtDate(gap.due_date)}</span>`],
            gap.closed_at && ["Closed", fmtDate(gap.closed_at)],
            ["Policy", html`<a href="#/policies/${policy.id}">${code || policy.code}</a>
              <span class="muted">${policy.version > gap.policy_version ? `found in v${gap.policy_version}, now v${policy.version}` : `v${policy.version}`}</span>`],
            ["Circular", html`<a href="#/circulars/${circular.id}">${circular.source} · ${fmtDate(circular.published_at)}</a>`],
            gap.affected_controls.length && ["Controls", gap.affected_controls.map((k) => html`<span class="chip">${k}</span>`)],
          ]),
        })}
      </aside>
    </div>`);

  $("#copy-draft").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(gap.draft_change);
      toast("Proposed wording copied");
    } catch {
      toast("Couldn't copy: the browser blocked the clipboard", true);
    }
  });

  $("#gap-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    busy(e.submitter, async () => {
      const body = { note: form.get("note").trim() };
      for (const field of ["status", "owner", "due_date"]) {
        if (form.get(field) !== gap[field]) body[field] = form.get(field);          // send only what changed
      }
      if (Object.keys(body).length === 1) throw new Error("Nothing changed. To add a note on its own, use Comment.");
      renderGap(await api(`/gaps/${gap.id}`, { method: "PATCH", body }));
      toast("Changes saved");
      refreshBadges();
    });
  });

  $("#comment-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const note = new FormData(e.target).get("note").trim();
    busy(e.submitter, async () => {
      await api(`/gaps/${gap.id}/comments`, { method: "POST", body: { note } });
      toast("Comment added");
      renderGap(await api(`/gaps/${gap.id}`));
    });
  });
}
