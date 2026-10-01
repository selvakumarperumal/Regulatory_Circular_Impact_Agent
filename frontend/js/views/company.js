/** Company: its name, the description the agent judges every circular against, the team
 * who can sign in, and your own password. */
import { api } from "../lib/api.js";
import { $, html, put } from "../lib/html.js";
import { fmtDate, fmtDateTime } from "../lib/format.js";
import { busy, dimWhile, toast } from "../ui/feedback.js";
import { pageHead, panel, person } from "../ui/components.js";
import { setCrumbs } from "../app/router.js";
import { currentUser, updateSession } from "../app/session.js";
import { refreshBadges } from "../app/status.js";

const EXAMPLE = `A private sector scheduled commercial bank in India and an Authorised Dealer Category-I. `
  + `It also runs a stock broking and depository participant business (regulated by SEBI) and distributes `
  + `insurance as a corporate agent (regulated by IRDAI). It is not a co-operative bank, small finance bank, `
  + `payments bank, NBFC, insurer or mutual fund.`;

export async function companyPage() {
  setCrumbs([["Company"]]);
  const [company, team] = await dimWhile($("#view"), Promise.all([api("/company"), api("/users")]));
  const described = Boolean(company.profile);
  const me = currentUser();

  put($("#view"), html`
    ${pageHead("Company", company.name,
               "A few sentences about your company. The agent reads every circular's addressees against it to decide whether the circular applies to you.")}
    <div class="company">
      <div class="detail-main">
        ${panel({
          title: "Your company",
          actions: described ? html`<span class="muted">Last changed ${fmtDateTime(company.updated_at)}</span>` : "",
          body: html`<form class="form" id="company-form">
            <label class="field"><span>Name</span>
              <input name="name" required minlength="2" value="${company.name}" autocomplete="organization" /></label>
            <label class="field"><span>Description</span>
              <textarea class="doc-edit" name="profile" required minlength="20" style="min-height: 220px"
                placeholder="What kind of entity is it? Which licences does it hold, which businesses does it run, and who regulates it?">${company.profile}</textarea></label>
            <div class="form-foot">
              <span class="hint">${described ? "Changing the description re-checks every analysed circular." : "Nothing is judged until this is saved."}</span>
              <button class="btn primary" type="submit">Save</button>
            </div>
          </form>`,
        })}
        ${panel({
          title: "Team", count: team.length, flush: true,
          body: html`<ul class="list team">${team.map((u) => html`<li>
              ${person(u.name)}<span class="muted">${u.email}</span>
              <span class="muted nowrap">${u.id === me?.id ? "You" : `Joined ${fmtDate(u.created_at)}`}</span></li>`)}</ul>
            <form class="form panel-body" id="team-form">
              <div class="form-row">
                <label class="field"><span>Name</span><input name="name" required autocomplete="off" /></label>
                <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="off" /></label>
                <label class="field"><span>First password</span><input name="password" type="text" required minlength="8" autocomplete="off" /></label>
              </div>
              <div class="form-foot">
                <span class="hint">They sign in with this email and password, and see everything your company sees.</span>
                <button class="btn" type="submit">Add teammate</button>
              </div>
            </form>`,
        })}
      </div>
      <aside class="detail-side">
        ${panel({
          title: "What makes a good description",
          body: html`<ul class="tips">
            <li><b>The kind of entity</b> the regulators would address: "scheduled commercial bank", "stock broker", "corporate agent".</li>
            <li><b>Every licence and business</b>, with its regulator, so circulars for each of your roles are caught.</li>
            <li><b>What you are not</b>, when it's easy to confuse: "not a small finance bank or NBFC".</li>
          </ul>`,
        })}
        ${panel({
          title: "An example",
          body: html`<p class="prose" style="font-size: 15px">${EXAMPLE}</p>`,
        })}
        ${panel({
          title: "Your password",
          body: html`<form class="form" id="password-form">
            <input type="email" name="username" value="${me?.email ?? ""}" autocomplete="username" hidden />
            <label class="field"><span>Current password</span><input name="current" type="password" required autocomplete="current-password" /></label>
            <label class="field"><span>New password</span><input name="new" type="password" required minlength="8" autocomplete="new-password" /></label>
            <div class="form-foot"><span class="hint">At least 8 characters.</span><button class="btn" type="submit">Change</button></div>
          </form>`,
        })}
      </aside>
    </div>`);

  $("#company-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    busy(e.submitter, async () => {
      const saved = await api("/company", {
        method: "PUT", body: { name: form.get("name").trim(), profile: form.get("profile").trim() },
      });
      updateSession({ company: saved.company });
      toast(saved.checking ? "Saved. A worker is checking your recent circulars against it now." : "Saved.");
      await companyPage();
      refreshBadges();
    });
  });

  $("#team-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    busy(e.submitter, async () => {
      const added = await api("/users", {
        method: "POST",
        body: { name: form.get("name").trim(), email: form.get("email").trim(), password: form.get("password") },
      });
      toast(`${added.name} can now sign in as ${added.email}`);
      await companyPage();
    });
  });

  $("#password-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    busy(e.submitter, async () => {
      await api("/auth/password", { method: "PUT", body: { current: form.get("current"), new: form.get("new") } });
      e.target.reset();
      toast("Password changed");
    });
  });
}
