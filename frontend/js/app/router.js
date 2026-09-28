/** Hash router. Pages register a pattern ("gaps/:id") and an async render function that
 * receives the params. The router highlights the sidebar, sets the breadcrumbs, and puts
 * the scroll position back when you return to a list. Pages are for signed-in users,
 * except those registered with { open: true } (login, sign-up), which are only for
 * signed-out ones: the router sends everyone else to the right place. */
import { $, $$, html, put } from "../lib/html.js";
import { hideTooltip } from "../ui/feedback.js";
import { signedIn } from "./session.js";

const routes = [];
const scrollMemory = {};
const afterRender = [];

export function route(pattern, render, { open = false } = {}) {
  routes.push({ parts: pattern.split("/"), render, open });
}

export const onRender = (fn) => afterRender.push(fn);

/** Breadcrumbs: [["Gaps", "#/gaps"], ["#12"]] (the last one is the current page). */
export function setCrumbs(items) {
  put($("#crumbs"), html`${items.map(([label, href], i) => html`
    ${i ? html`<span class="sep">/</span>` : ""}${href ? html`<a href="${href}">${label}</a>` : html`<b>${label}</b>`}`)}`);
  document.title = `${items.at(-1)[0]} · Circular Impact Desk`;
}

function match(hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) parts.push("overview");
  for (const r of routes) {
    if (r.parts.length !== parts.length) continue;
    const params = {};
    if (r.parts.every((p, i) => p.startsWith(":") ? ((params[p.slice(1)] = parts[i]), true) : p === parts[i])) {
      return { render: r.render, params, section: parts[0], open: r.open };
    }
  }
  return { render: routes[0].render, params: {}, section: "overview", open: false };
}

export async function render() {
  const { render: page, params, section, open } = match(location.hash);
  if (open === signedIn()) {
    location.replace(open ? "#/overview" : "#/login");   // fires hashchange, which renders
    return;
  }
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === section));
  hideTooltip();
  const view = $("#view");
  try {
    await page(params);
  } catch (e) {
    put(view, html`<div class="panel"><div class="empty">${e.message}</div></div>`);
  }
  scrollTo(0, scrollMemory[location.hash] ?? 0);
  afterRender.forEach((fn) => fn());
}

export function start() {
  addEventListener("hashchange", (e) => {
    scrollMemory[new URL(e.oldURL).hash] = scrollY;
    render();
  });
  render();
}
