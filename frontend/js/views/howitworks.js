/** How it works: the system, animated. One tab per scene: the whole system end to end,
 * then the watcher, the worker and the api in detail, and Redis from zero to advanced. Each scene is plain data in
 * views/how/; player.js draws and plays it. */
import { $, html, put } from "../lib/html.js";
import { pageHead } from "../ui/components.js";
import { setCrumbs } from "../app/router.js";
import { play } from "./how/player.js";
import system from "./how/system.js";
import watcher from "./how/watcher.js";
import worker from "./how/worker.js";
import api from "./how/api.js";
import redis from "./how/redis.js";

const SCENES = [system, watcher, worker, api, redis];

export async function howPage({ scene = "system" } = {}) {
  const current = SCENES.find((s) => s.id === scene) ?? system;
  setCrumbs(current === system ? [["How it works"]] : [["How it works", "#/how"], [current.tab]]);
  put($("#view"), html`
    ${pageHead("How it works", current.heading, current.lead)}
    <nav class="how-tabs" aria-label="Animations">
      ${SCENES.map((s) => html`<a href="#/how/${s.id}" class="${s === current ? "on" : ""}"
          ${s === current ? html`aria-current="page"` : ""}><b>${s.tab}</b><small>${s.hint} · ${s.steps.length} steps</small></a>`)}
    </nav>
    <div id="how-player"></div>`);
  play(current, $("#how-player"));
}
