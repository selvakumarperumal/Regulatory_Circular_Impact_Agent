/** Policies: the library (a searchable table), a policy's page, the new-policy form, and
 * importing a whole library from JSON. */
import { api } from "../lib/api.js";
import { $, html, put } from "../lib/html.js";
import { OPEN, fmtDate, plural } from "../lib/format.js";
import { icon } from "../ui/icons.js";
import { busy, dimWhile, toast } from "../ui/feedback.js";
import { emptyState, pageHead, panel, person, plist, regChip, table, tag } from "../ui/components.js";
import { filters } from "../app/state.js";
import { render, setCrumbs } from "../app/router.js";
import { refreshBadges } from "../app/status.js";
import { gapTable } from "./circulars.js";

const REGULATORS = ["RBI", "SEBI", "IRDAI"];
const SAMPLE_JSON = `[
  {
    "code": "POL-KYC",
    "title": "Know Your Customer and Anti-Money Laundering Policy",
    "owner": "head.kyc@yourbank.com",
    "regulators": ["RBI", "SEBI"],
    "text": [
      "1. Scope: ...",
      "2. Customer due diligence: ..."
    ],
    "controls": [
      { "code": "CTL-KYC-01", "description": "Upload new KYC records to CKYCR",
        "owner": "ops.kyc@yourbank.com", "frequency": "daily" }
    ]
  }
]`;

/** Saving a policy queues a policy.check task; the worker stamps checked_at when it's done. */
const checked = (p) => Boolean(p.checked_at) && new Date(p.checked_at) >= new Date(p.updated_at);
const workerTag = (p) => checked(p)
  ? tag({ label: `Checked ${fmtDate(p.checked_at)}`, c: "var(--st-closed)" })
  : html`<span class="tag working" style="--c: var(--st-progress)"><i></i>Waiting for the worker</span>`;

/** While the worker hasn't checked the policy, look again every 3 seconds. */
function watchWorker(p) {
  const page = location.hash;
  const timer = setInterval(async () => {
    if (location.hash !== page) return clearInterval(timer);
    const { policy } = await api(`/policies/${p.id}`).catch(() => ({}));
    if (!policy || !checked(policy)) return;
    clearInterval(timer);
    toast(`${policy.code} checked by the worker`);
    if ($("#policy-form")) put($("#worker-status"), workerTag(policy));
    else policyPage({ id: p.id });
  }, 3000);
}

const libraryActions = () => html`
  <button class="btn" data-import>${icon("upload")}Import JSON</button>
  <a class="btn primary" href="#/policies/new">${icon("plus")}New policy</a>`;

// ── The library ─────────────────────────────────────────────────────────────

export async function policiesPage() {
  setCrumbs([["Policies"]]);
  const [policies, gaps] = await dimWhile($("#view"), Promise.all([api("/policies"), api("/gaps")]));
  const head = pageHead("Policies", "The policy library",
    "The company's own policies and controls. Every circular that applies to the company is checked against them.",
    libraryActions());

  if (!policies.length) {
    put($("#view"), html`${head}${emptyState({
      iconName: "book", title: "Your policy library is empty",
      text: "Add the company's policies and their controls. The agent checks each circular that applies to the company "
          + "against them, and opens a gap with drafted wording when one is out of date. Policies you add now are also "
          + "checked against the circulars of the last few weeks.",
      actions: libraryActions(),
      extra: html`<details class="more"><summary>What the import file looks like</summary><pre class="sample">${SAMPLE_JSON}</pre></details>`,
    })}`);
    return;
  }

  const openGaps = (id) => gaps.filter((g) => g.policy_id === id && OPEN.includes(g.status)).length;
  put($("#view"), html`${head}
    <section class="panel">
      <div class="table-toolbar">
        <input id="p-search" type="search" placeholder="Search by code, title or owner" value="${filters.policies.q}" />
        <span class="count" id="count"></span>
      </div>
      ${table({
        cols: "110px minmax(0, 1fr) 150px 230px 70px 90px",
        head: ["Code", "Policy", "Regulators", "Owner", "#Version", "#Open gaps"],
        rows: policies.map((p) => html`<a class="trow" href="#/policies/${p.id}" data-search="${`${p.code} ${p.title} ${p.owner}`.toLowerCase()}">
          <div class="cell"><span class="chip">${p.code}</span></div>
          <div class="cell"><div class="cell-title">${p.title}</div><div class="cell-sub">${workerTag(p)}</div></div>
          <div class="cell">${p.regulators.map((r) => html`${regChip(r)} `)}</div>
          <div class="cell hide-sm">${person(p.owner)}</div>
          <div class="cell num">v${p.version}</div>
          <div class="cell num">${openGaps(p.id) || html`<span class="muted">0</span>`}</div>
        </a>`),
        empty: "",
      })}
    </section>`);
  const search = () => {
    const needle = $("#p-search").value.trim().toLowerCase();
    filters.policies.q = needle;
    const rows = [...document.querySelectorAll("#view a.trow")];
    rows.forEach((r) => { r.hidden = needle !== "" && !r.dataset.search.includes(needle); });
    $("#count").textContent = plural(rows.filter((r) => !r.hidden).length, "policy", "policies");
  };
  $("#p-search").addEventListener("input", search);
  search();
}

// ── One policy ──────────────────────────────────────────────────────────────

export async function policyPage({ id }, { editing = false } = {}) {
  const data = await dimWhile($("#view"), api(`/policies/${id}`));
  const { policy: p, controls, gaps } = data;
  setCrumbs([["Policies", "#/policies"], [p.code]]);
  const openCount = gaps.filter((g) => OPEN.includes(g.status)).length;

  put($("#view"), html`
    <header class="detail-head">
      <div class="eyebrow">${p.code} · version ${p.version}</div>
      <h1>${p.title}</h1>
      <div class="tags" id="worker-status">${workerTag(p)}</div>
    </header>

    <div class="detail">
      <div class="detail-main">
        ${editing ? panel({ title: `Edit ${p.code}`, body: policyForm(p) })
          : panel({
            title: "Policy text",
            actions: html`<button class="btn sm" id="edit-policy">${icon("edit")}Edit</button>`,
            body: html`<div class="doc policy">${p.text.split("\n").filter((l) => l.trim()).map((l) => html`<p>${l}</p>`)}</div>`,
          })}
        ${panel({
          title: "Controls", count: controls.length, flush: true,
          actions: html`<button class="btn sm" id="toggle-control">${icon("plus")}Add control</button>`,
          body: html`${controls.length ? table({
            cols: "120px minmax(0, 1fr) 210px 110px",
            head: ["Code", "What it checks", "Owner", "How often"],
            rows: controls.map((k) => html`<div class="trow">
              <div class="cell"><span class="chip">${k.code}</span></div>
              <div class="cell">${k.description}</div>
              <div class="cell hide-sm">${person(k.owner)}</div>
              <div class="cell muted">${k.frequency}</div></div>`),
            empty: "",
          }) : html`<div class="panel-body"><p class="hint">No controls yet: add the checks that put this policy into practice.</p></div>`}
          <div class="panel-body" id="control-form-wrap" ${controls.length ? html`hidden` : ""}>
            <form class="form" id="control-form">
            <div class="form-row">
              <label class="field"><span>Code</span><input name="code" placeholder="CTL-KYC-05" required /></label>
              <label class="field"><span>Owner</span><input name="owner" placeholder="owner@yourbank.com" required /></label>
              <label class="field"><span>How often</span><input name="frequency" placeholder="monthly" /></label>
            </div>
            <label class="field"><span>What it checks</span><input name="description" required /></label>
            <div class="form-foot"><span></span><button class="btn primary" type="submit">${icon("plus")}Add control</button></div>
          </form></div>`,
        })}
        ${panel({
          title: "Gaps", count: gaps.length, flush: Boolean(gaps.length),
          body: gaps.length ? gapTable(gaps) : html`<p class="hint">No circular has made this policy out of date.</p>`,
        })}
      </div>

      <aside class="detail-side">
        ${panel({
          title: "Details",
          body: plist([
            ["Code", html`<span class="chip">${p.code}</span>`],
            ["Version", `v${p.version}`],
            ["Owner", person(p.owner)],
            ["Regulators", html`<span class="chip-row">${p.regulators.map(regChip)}</span>`],
            ["Updated", fmtDate(p.updated_at)],
            ["Worker", checked(p) ? `Checked ${fmtDate(p.checked_at)}` : "Waiting"],
            ["Open gaps", String(openCount)],
          ]),
        })}
        ${panel({
          title: "How the agent uses it",
          body: html`<p class="hint">Circulars from ${p.regulators.join(", ")} that apply to the company are matched against
            this text. Editing the text makes a new version; its open gaps get a note, and the worker checks the
            new version against the recent circulars.</p>`,
        })}
      </aside>
    </div>`);

  $("#toggle-control").addEventListener("click", () => {
    const wrap = $("#control-form-wrap");
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) $("#control-form input[name=code]").focus();
  });
  if (!checked(p)) watchWorker(p);
  if (editing) bindPolicyForm(p);
  else $("#edit-policy").addEventListener("click", () => policyPage({ id }, { editing: true }));

  $("#control-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const body = Object.fromEntries(["code", "owner", "description", "frequency"].map((k) => [k, form.get(k).trim()]));
    if (!body.frequency) delete body.frequency;                                  // the API defaults it
    busy(e.submitter, async () => {
      await api(`/policies/${p.id}/controls`, { method: "POST", body });
      toast(`Control ${body.code} added`);
      await policyPage({ id });
    });
  });
}

// ── New policy ──────────────────────────────────────────────────────────────

export async function newPolicyPage() {
  setCrumbs([["Policies", "#/policies"], ["New policy"]]);
  put($("#view"), html`
    <header class="detail-head"><div class="eyebrow">New policy</div><h1>Add a policy to the library</h1></header>
    <div class="detail">
      <div class="detail-main">${panel({ title: "The policy", body: policyForm(null) })}</div>
      <aside class="detail-side">
        ${panel({
          title: "Tips",
          body: html`<ul class="tips">
            <li><b>Paste the real wording</b>, clause by clause. The agent compares circulars with this text.</li>
            <li><b>Tick every regulator</b> whose circulars can affect it.</li>
            <li><b>The owner</b> receives the gap tickets for this policy.</li>
          </ul>`,
        })}
        ${panel({
          title: "Many policies?",
          body: html`<div class="form"><p class="hint">Import a whole library, with controls, from one JSON file.</p>
            <button class="btn block" data-import>${icon("upload")}Import JSON</button></div>`,
        })}
      </aside>
    </div>`);
  bindPolicyForm(null);
}

/** One form for both: `p` is the policy when editing, null for a new one. */
function policyForm(p) {
  const v = p ?? { code: "", title: "", owner: "", regulators: [], text: "" };
  return html`<form class="form" id="policy-form">
    <div class="form-row">
      <label class="field"><span>Code</span><input name="code" value="${v.code}" required placeholder="POL-KYC"
        ${p ? html`readonly title="The code can't be changed"` : ""} /></label>
      <label class="field"><span>Owner, who gets the gap tickets</span>
        <input name="owner" value="${v.owner}" required placeholder="head.kyc@yourbank.com" /></label>
    </div>
    <label class="field"><span>Title</span><input name="title" value="${v.title}" required
      placeholder="Know Your Customer and Anti-Money Laundering Policy" /></label>
    <div class="field"><span>Regulators whose circulars are checked against it</span>
      <div class="checks codes">${REGULATORS.map((r) => html`<label><input type="checkbox" name="regulators" value="${r}"
        ${v.regulators.includes(r) ? html`checked` : ""} /><span>${r}</span></label>`)}</div></div>
    <label class="field"><span>Policy text</span>
      <textarea class="doc-edit" name="text" required placeholder="1. Scope: …&#10;2. …">${v.text}</textarea></label>
    <div class="form-foot">
      <label class="btn ghost sm">${icon("upload")}Load text from a file<input type="file" id="text-file" accept=".txt,.md,text/plain" hidden /></label>
      <span class="hint">${p ? "A text change makes a new version." : ""}</span>
      ${p ? html`<a class="btn" href="#/policies/${p.id}" id="cancel-edit">Cancel</a>` : ""}
      <button class="btn primary" type="submit">${p ? "Save" : "Create policy"}</button>
    </div>
  </form>`;
}

function bindPolicyForm(p) {
  $("#text-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) $("#policy-form textarea[name=text]").value = await file.text();
  });
  $("#cancel-edit")?.addEventListener("click", (e) => { e.preventDefault(); policyPage({ id: p.id }); });
  $("#policy-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const body = {
      code: form.get("code").trim(), title: form.get("title").trim(), owner: form.get("owner").trim(),
      regulators: form.getAll("regulators"), text: form.get("text").trim(),
    };
    busy(e.submitter, async () => {
      if (!body.regulators.length) throw new Error("Pick at least one regulator.");
      if (!p) {
        const created = await api("/policies", { method: "POST", body });
        toast(`${created.code} saved and queued: a worker is checking it now`);
        location.hash = `#/policies/${created.id}`;
      } else {
        const saved = await api(`/policies/${p.id}`, { method: "PUT", body });
        toast(`${saved.version > p.version ? `Saved as version ${saved.version}` : "Saved"}, and queued for the worker`);
        await policyPage({ id: p.id });
      }
      refreshBadges();
    });
  });
}

// ── Import a library from JSON ──────────────────────────────────────────────

/** Imports a JSON list of policies (each may carry "controls"); existing codes are skipped. */
export async function importPolicies(file) {
  let list;
  try {
    const data = JSON.parse(await file.text());
    list = Array.isArray(data) ? data : data.policies;
    if (!Array.isArray(list)) throw new Error("expected a list of policies");
  } catch (err) {
    toast(`Couldn't read ${file.name}: ${err.message}`, true);
    return;
  }
  let added = 0;
  const skipped = [], problems = [];
  for (const item of list) {
    const body = {
      code: item.code, title: item.title, owner: item.owner, regulators: item.regulators ?? [],
      text: Array.isArray(item.text) ? item.text.join("\n") : item.text,
    };
    try {
      const policy = await api("/policies", { method: "POST", body });
      added += 1;
      for (const control of item.controls ?? []) {
        try {
          await api(`/policies/${policy.id}/controls`, { method: "POST", body: control });
        } catch (err) {
          problems.push(`${control.code}: ${err.message}`);
        }
      }
    } catch (err) {
      (err.message.startsWith("409") ? skipped : problems).push(`${item.code ?? "(no code)"}: ${err.message}`);
    }
  }
  const parts = [`Imported ${plural(added, "policy", "policies")}`];
  if (skipped.length) parts.push(`${skipped.length} already there`);
  if (problems.length) parts.push(`${plural(problems.length, "problem")}: ${problems.slice(0, 2).join("; ")}`);
  toast(parts.join(" · "), problems.length > 0);
  if (location.hash === "#/policies") render(); else location.hash = "#/policies";
}
