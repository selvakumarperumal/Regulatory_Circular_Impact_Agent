/** Sign in and sign up: the only pages shown before signing in. Signing up creates the
 * company and its first user; teammates are added later from the Company page. */
import { api } from "../lib/api.js";
import { $, html, put } from "../lib/html.js";
import { icon } from "../ui/icons.js";
import { busy } from "../ui/feedback.js";
import { setCrumbs } from "../app/router.js";
import { signIn } from "../app/session.js";

const field = (label, name, type, autocomplete, extra = "") => html`<label class="field">
  <span>${label}</span><input name="${name}" type="${type}" autocomplete="${autocomplete}" required ${extra} /></label>`;

function authPage({ title, lead, fields, submit, foot }) {
  put($("#view"), html`<div class="auth">
    <section class="auth-pitch">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${icon("file")}</span>
        <span class="brand-text"><b>Circular Impact</b><small>Compliance desk</small></span>
      </div>
      <div>
        <h1>Every new circular, checked against your policies.</h1>
        <ul>
          <li>${icon("check")}<span>RBI, SEBI and IRDAI circulars read the day they come out</span></li>
          <li>${icon("check")}<span>Only the ones that apply to your company are checked</span></li>
          <li>${icon("check")}<span>Out-of-date policies become gap tickets for their owners</span></li>
        </ul>
      </div>
      <span class="live"><i></i>Watching RBI · SEBI · IRDAI</span>
    </section>
    <section class="auth-form">
      <header><h2>${title}</h2><p class="muted">${lead}</p></header>
      <form class="form" id="auth-form">
        ${fields}
        <button class="btn primary block" type="submit">${submit}</button>
      </form>
      <p class="auth-foot">${foot}</p>
    </section>
  </div>`);
  $("#auth-form input").focus();
}

function onSubmit(path, toBody, next) {
  $("#auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    busy(e.submitter, async () => {
      signIn(await api(path, { method: "POST", body: toBody(form) }));
      location.hash = next;
    });
  });
}

export async function loginPage() {
  setCrumbs([["Sign in"]]);
  authPage({
    title: "Welcome back",
    lead: "Sign in to your company's compliance desk.",
    fields: html`${field("Email", "email", "email", "username")}
      ${field("Password", "password", "password", "current-password")}`,
    submit: "Sign in",
    foot: html`New here? <a href="#/signup">Create an account for your company</a>`,
  });
  onSubmit("/auth/login", (f) => ({ email: f.get("email").trim(), password: f.get("password") }), "#/overview");
}

export async function signupPage() {
  setCrumbs([["Sign up"]]);
  authPage({
    title: "Set up your company",
    lead: "You'll be its first user, and can add your team afterwards.",
    fields: html`${field("Company", "company", "text", "organization", 'minlength="2"')}
      ${field("Your name", "name", "text", "name")}
      ${field("Work email", "email", "email", "username")}
      ${field("Password", "password", "password", "new-password", 'minlength="8"')}`,
    submit: "Create account",
    foot: html`Already have an account? <a href="#/login">Sign in</a>`,
  });
  onSubmit("/auth/signup", (f) => ({
    company: f.get("company").trim(), name: f.get("name").trim(),
    email: f.get("email").trim(), password: f.get("password"),
  }), "#/company");
}
