/** Who is using the console. Every gap change and comment is recorded under this name. */
import { $ } from "../lib/html.js";

export function initSession() {
  const input = $("#actor");
  try { input.value = localStorage.getItem("rci.actor") || ""; } catch { /* storage blocked */ }
  input.addEventListener("change", () => {
    try { localStorage.setItem("rci.actor", input.value.trim()); } catch { /* storage blocked */ }
  });
}

/** The current name; throws (and focuses the box) if it's empty. */
export function actor() {
  const input = $("#actor");
  const name = input.value.trim();
  if (!name) {
    input.focus();
    throw new Error("Enter your name or email under “Signed in as” first.");
  }
  return name;
}

/** A first name for greetings: "priya.shah@bank.com" -> "Priya". Empty if nobody signed in. */
export function firstName() {
  const raw = ($("#actor").value || "").trim().split("@")[0].split(/[._\-\s]+/)[0] || "";
  return raw ? raw[0].toUpperCase() + raw.slice(1) : "";
}
