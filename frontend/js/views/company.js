/** Company: the description the agent judges every circular against. */
import { api } from "../lib/api.js";
import { $, html, put } from "../lib/html.js";
import { fmtDateTime, plural } from "../lib/format.js";
import { busy, dimWhile, toast } from "../ui/feedback.js";
import { pageHead, panel } from "../ui/components.js";
import { setCrumbs } from "../app/router.js";
import { refreshBadges } from "../app/status.js";

const EXAMPLE = `A private sector scheduled commercial bank in India and an Authorised Dealer Category-I. `
  + `It also runs a stock broking and depository participant business (regulated by SEBI) and distributes `
  + `insurance as a corporate agent (regulated by IRDAI). It is not a co-operative bank, small finance bank, `
  + `payments bank, NBFC, insurer or mutual fund.`;

export async function companyPage() {
  setCrumbs([["Company"]]);
  const company = await dimWhile($("#view"), api("/company"));
  put($("#view"), html`
    ${pageHead("Company", "Who the agent works for",
               "A few sentences about your company. The agent reads every circular's addressees against it to decide whether the circular applies to you.")}
    <div class="company">
      ${panel({
        title: "Your company",
        actions: company ? html`<span class="muted">Last changed ${fmtDateTime(company.updated_at)}</span>` : "",
        body: html`<form class="form" id="company-form">
          <textarea class="doc-edit" name="profile" required minlength="20" style="min-height: 220px"
            placeholder="What kind of entity is it? Which licences does it hold, which businesses does it run, and who regulates it?">${company?.profile ?? ""}</textarea>
          <div class="form-foot">
            <span class="hint">${company ? "Saving a change re-checks every analysed circular." : "Nothing is judged until this is saved."}</span>
            <button class="btn primary" type="submit">Save</button>
          </div>
        </form>`,
      })}
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
      </aside>
    </div>`);

  $("#company-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const profile = new FormData(e.target).get("profile").trim();
    busy(e.submitter, async () => {
      const saved = await api("/company", { method: "PUT", body: { profile } });
      toast(saved.requeued
        ? `Saved. ${plural(saved.requeued, "circular")} will be re-checked against it within a few minutes.`
        : "Saved.");
      await companyPage();
      refreshBadges();
    });
  });
}
