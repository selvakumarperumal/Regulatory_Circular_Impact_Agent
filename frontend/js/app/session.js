/** Who is signed in: the login token, the user and their company. Kept in localStorage,
 * so a reload stays signed in; the API client sends the token with every call, and when
 * the API says it has ended, the console signs out and shows the login page. */
import { useAuth } from "../lib/api.js";
import { initials } from "../lib/format.js";
import { $ } from "../lib/html.js";

const KEY = "rci.session";
let current = null;
try { current = JSON.parse(localStorage.getItem(KEY)); } catch { /* storage blocked */ }

function store() {
  try {
    if (current) localStorage.setItem(KEY, JSON.stringify(current));
    else localStorage.removeItem(KEY);
  } catch { /* storage blocked: the session lasts until the tab closes */ }
}

export const signedIn = () => Boolean(current?.token);
export const currentUser = () => current?.user ?? null;
const currentCompany = () => current?.company ?? null;

/** After login or sign-up: keep what the API returned ({ token, user, company }). */
export function signIn({ token, user, company }) {
  current = { token, user, company };
  store();
  showUser();
}

/** The company or user changed (a rename): keep the sidebar in step. */
export function updateSession({ user, company }) {
  if (!current) return;
  if (user) current.user = user;
  if (company) current.company = company;
  store();
  showUser();
}

function signOut() {
  current = null;
  store();
  showUser();
  location.hash = "#/login";
}

function showUser() {
  document.body.classList.toggle("signed-out", !signedIn());
  const user = currentUser();
  $("#you-name").textContent = user?.name ?? "";
  $(".you").title = user?.email ?? "";
  $("#you-company").textContent = currentCompany()?.name ?? "";
  $("#you-avatar").textContent = user ? initials(user.name) : "";
}

export function initSession() {
  useAuth(() => current?.token, signOut);
  $("#sign-out").addEventListener("click", signOut);
  showUser();
}

/** A first name for greetings: "Priya Shah" -> "Priya". */
export function firstName() {
  const first = (currentUser()?.name || "").trim().split(/\s+/)[0] || "";
  return first ? first[0].toUpperCase() + first.slice(1) : "";
}
