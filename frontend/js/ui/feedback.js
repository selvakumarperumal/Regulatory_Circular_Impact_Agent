/** Feedback: the toast, the chart tooltip, and busy states for buttons and pages. */
import { $ } from "../lib/html.js";

let toastTimer;
export function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3200);
}

/** One tooltip for every chart mark: data-tip-value / data-tip-label, set with textContent. */
export function initTooltip() {
  const tip = $("#tip");
  const showTip = (el, x, y) => {
    tip.replaceChildren();
    const value = document.createElement("b");
    value.textContent = el.dataset.tipValue;
    tip.append(value, document.createTextNode(`  ${el.dataset.tipLabel}`));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
  };
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) showTip(el, e.clientX, e.clientY);
    else tip.hidden = true;
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    const r = el.getBoundingClientRect();
    showTip(el, r.left, r.bottom);
  });
}

export const hideTooltip = () => { $("#tip").hidden = true; };

/** Run a button's action: disable it meanwhile, and show any error as a toast. */
export async function busy(button, action) {
  if (button) button.disabled = true;
  try {
    await action();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

/** Keep the old content on screen, dimmed, while the new one loads (no flash). */
export async function dimWhile(el, promise) {
  el.classList.add("is-busy");
  try { return await promise; } finally { el.classList.remove("is-busy"); }
}
