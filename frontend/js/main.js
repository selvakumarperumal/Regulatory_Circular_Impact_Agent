/** Circular Impact Desk: the console over the Regulatory Circular Impact Agent API.
 *
 * Plain JavaScript modules, no build step:
 *   lib/    api client, html escaping, formatting
 *   ui/     icons, components, feedback (toast, tooltip, busy states)
 *   app/    router, session (who is signed in), list filters, sidebar status
 *   views/  one module per page
 */
import { $ } from "./lib/html.js";
import { initTooltip } from "./ui/feedback.js";
import { onRender, render, route, start } from "./app/router.js";
import { initSession, signedIn } from "./app/session.js";
import { checkHealth, refreshBadges } from "./app/status.js";
import { overviewPage } from "./views/overview.js";
import { gapPage, gapsPage } from "./views/gaps.js";
import { circularPage, circularsPage } from "./views/circulars.js";
import { importPolicies, newPolicyPage, policiesPage, policyPage } from "./views/policies.js";
import { companyPage } from "./views/company.js";
import { loginPage, signupPage } from "./views/auth.js";

route("overview", overviewPage);                 // the first route is also the fallback
route("gaps", gapsPage);
route("gaps/:id", gapPage);
route("circulars", circularsPage);
route("circulars/:id", circularPage);
route("policies", policiesPage);
route("policies/new", newPolicyPage);
route("policies/:id", policyPage);
route("company", companyPage);
route("login", loginPage, { open: true });
route("signup", signupPage, { open: true });

// "Import JSON" buttons appear on several pages; one hidden file input serves them all.
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-import]")) $("#import-file").click();
});
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";                            // the same file can be picked again
  if (file) await importPolicies(file);
});
$("#refresh").addEventListener("click", () => { render(); checkHealth(); });

initSession();
initTooltip();
onRender(() => signedIn() && refreshBadges());
checkHealth();
setInterval(checkHealth, 30_000);
start();
