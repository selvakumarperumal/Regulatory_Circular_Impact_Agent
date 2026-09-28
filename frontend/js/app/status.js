/** The sidebar's live bits: the API status line and the count badges. */
import { api, API_URL } from "../lib/api.js";
import { $ } from "../lib/html.js";
import { updateSession } from "./session.js";

export async function checkHealth() {
  const el = $("#api-status");
  try {
    await api("/health");
    el.className = "api-status ok";
    el.lastElementChild.textContent = "API connected";
    el.title = API_URL || location.origin;
  } catch (e) {
    el.className = "api-status down";
    el.lastElementChild.textContent = "API unreachable";
    el.title = e.message;
  }
}

export async function refreshBadges() {
  try {
    const [stats, policies, company] = await Promise.all([api("/stats"), api("/policies"), api("/company")]);
    const g = stats.gaps, c = stats.circulars;
    $("#badge-gaps").textContent = (g.open || 0) + (g.in_progress || 0) || "";
    $("#badge-circulars").textContent = (c.new || 0) + (c.parsed || 0) || "";
    $("#badge-policies").textContent = policies.length || "";
    $("#badge-company").hidden = Boolean(company.profile);
    updateSession({ company });
    $("#last-refresh").textContent = `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
  } catch { /* the status line already says the API is down */ }
}
