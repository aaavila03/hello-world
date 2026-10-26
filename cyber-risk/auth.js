// Sign-in, multi-factor authentication and workspace selection (cloud mode).
// Nothing in the app is shown until the user has an MFA-verified (aal2)
// session and has chosen a workspace; the database enforces the same rules.
import { SUPABASE_URL, SUPABASE_ANON_KEY, IDLE_TIMEOUT_MINUTES } from "./config.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LAST_ORG_KEY = "riskpilot.lastOrg";

let client;
let onReadyCb;

function loadSupabase() {
  if (window.supabase?.createClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("./vendor/supabase.js", import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load the sign-in library."));
    document.head.append(s);
  });
}

function screen(html) {
  $("#auth-screen").classList.remove("hidden");
  $("#auth-body").innerHTML = html;
  $("#auth-error").textContent = "";
  const first = $("#auth-body input");
  if (first) first.focus();
}

function fail(err) {
  $("#auth-error").textContent = err?.message || String(err);
}

// Disables the form's buttons while an async action runs.
function busy(form, fn) {
  return async (e) => {
    e.preventDefault();
    const buttons = form.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    $("#auth-error").textContent = "";
    try { await fn(new FormData(form)); } catch (err) { fail(err); } finally { buttons.forEach((b) => { b.disabled = false; }); }
  };
}

const redirectTo = () => `${location.origin}${location.pathname}`;

// ---------- screens ----------
function signInScreen(message = "") {
  screen(`
    <h1>Sign in</h1>
    ${message ? `<p class="auth-note">${esc(message)}</p>` : ""}
    <form id="f-signin">
      <label>Work email <input name="email" type="email" autocomplete="username" required /></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
      <button class="primary wide">Sign in</button>
    </form>
    <div class="auth-links"><a href="#" id="l-signup">Create an account</a> · <a href="#" id="l-reset">Forgot password?</a></div>`);
  const f = $("#f-signin");
  f.addEventListener("submit", busy(f, async (d) => {
    const { error } = await client.auth.signInWithPassword({ email: d.get("email"), password: d.get("password") });
    if (error) throw new Error(error.message === "Email not confirmed" ? "Please confirm your email address first – check your inbox." : "Incorrect email or password.");
    await route();
  }));
  $("#l-signup").addEventListener("click", (e) => { e.preventDefault(); signUpScreen(); });
  $("#l-reset").addEventListener("click", (e) => { e.preventDefault(); resetScreen(); });
}

function signUpScreen() {
  screen(`
    <h1>Create your account</h1>
    <form id="f-signup">
      <label>Work email <input name="email" type="email" autocomplete="username" required /></label>
      <label>Password <input name="password" type="password" autocomplete="new-password" minlength="12" required /></label>
      <p class="small muted">At least 12 characters, with upper and lower case letters, a number and a symbol. You'll also set up an authenticator app.</p>
      <button class="primary wide">Create account</button>
    </form>
    <div class="auth-links"><a href="#" id="l-signin">I already have an account</a></div>`);
  const f = $("#f-signup");
  f.addEventListener("submit", busy(f, async (d) => {
    const { data, error } = await client.auth.signUp({ email: d.get("email"), password: d.get("password"), options: { emailRedirectTo: redirectTo() } });
    if (error) throw error;
    if (data.session) return route();
    signInScreen("Check your email and click the confirmation link, then sign in.");
  }));
  $("#l-signin").addEventListener("click", (e) => { e.preventDefault(); signInScreen(); });
}

function resetScreen() {
  screen(`
    <h1>Reset your password</h1>
    <form id="f-reset">
      <label>Work email <input name="email" type="email" autocomplete="username" required /></label>
      <button class="primary wide">Send reset link</button>
    </form>
    <div class="auth-links"><a href="#" id="l-signin">Back to sign in</a></div>`);
  const f = $("#f-reset");
  f.addEventListener("submit", busy(f, async (d) => {
    await client.auth.resetPasswordForEmail(d.get("email"), { redirectTo: redirectTo() });
    // Same message whether or not the account exists, so emails can't be enumerated.
    signInScreen("If that email has an account, a reset link is on its way.");
  }));
  $("#l-signin").addEventListener("click", (e) => { e.preventDefault(); signInScreen(); });
}

function newPasswordScreen() {
  screen(`
    <h1>Choose a new password</h1>
    <form id="f-newpw">
      <label>New password <input name="password" type="password" autocomplete="new-password" minlength="12" required /></label>
      <button class="primary wide">Save password</button>
    </form>`);
  const f = $("#f-newpw");
  f.addEventListener("submit", busy(f, async (d) => {
    const { error } = await client.auth.updateUser({ password: d.get("password") });
    if (error) throw error;
    await route();
  }));
}

async function enrollScreen() {
  // Remove abandoned, unverified factors so enrolment can start cleanly.
  const { data: factors } = await client.auth.mfa.listFactors();
  for (const f of factors?.all || []) if (f.status !== "verified") await client.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
  if (error) throw error;
  screen(`
    <h1>Set up two-factor authentication</h1>
    <p>RiskPilot requires an authenticator app (such as Microsoft Authenticator, Google Authenticator, 1Password or Authy). Scan this code, then enter the 6-digit code it shows.</p>
    <img class="qr" alt="QR code for your authenticator app" src="${esc(data.totp.qr_code)}" />
    <details class="small"><summary>Can't scan? Enter this key instead</summary><code class="secret">${esc(data.totp.secret)}</code></details>
    <form id="f-enroll">
      <label>6-digit code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
      <button class="primary wide">Verify and continue</button>
    </form>
    <div class="auth-links"><a href="#" id="l-signout">Sign out</a></div>`);
  const f = $("#f-enroll");
  f.addEventListener("submit", busy(f, async (d) => {
    const { error: err } = await client.auth.mfa.challengeAndVerify({ factorId: data.id, code: d.get("code") });
    if (err) throw new Error("That code didn't work. Check your app's clock and try the newest code.");
    await route();
  }));
  $("#l-signout").addEventListener("click", signOutLink);
}

function challengeScreen(factor) {
  screen(`
    <h1>Two-factor authentication</h1>
    <p>Enter the 6-digit code from your authenticator app.</p>
    <form id="f-mfa">
      <label>6-digit code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
      <button class="primary wide">Verify</button>
    </form>
    <div class="auth-links"><a href="#" id="l-signout">Sign out</a></div>`);
  const f = $("#f-mfa");
  f.addEventListener("submit", busy(f, async (d) => {
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: d.get("code") });
    if (error) throw new Error("That code didn't work. Try the newest code from your app.");
    await route();
  }));
  $("#l-signout").addEventListener("click", signOutLink);
}

function createOrgScreen(hasOthers) {
  screen(`
    <h1>Create your workspace</h1>
    <p>A workspace holds your organisation's risks and vendors. You'll be its owner and can invite colleagues.</p>
    <form id="f-org">
      <label>Organisation name <input name="name" maxlength="120" required /></label>
      <button class="primary wide">Create workspace</button>
    </form>
    <p class="small muted">Expecting an invitation? Ask your administrator to invite this email address, then sign in again.</p>
    <div class="auth-links">${hasOthers ? '<a href="#" id="l-pick">Back to my workspaces</a> · ' : ""}<a href="#" id="l-signout">Sign out</a></div>`);
  const f = $("#f-org");
  f.addEventListener("submit", busy(f, async (d) => {
    const { data, error } = await client.rpc("create_organization", { org_name: d.get("name") });
    if (error) throw error;
    localStorage.setItem(LAST_ORG_KEY, data);
    await route();
  }));
  $("#l-pick")?.addEventListener("click", (e) => { e.preventDefault(); pickOrg(true); });
  $("#l-signout").addEventListener("click", signOutLink);
}

function pickOrgScreen(orgs) {
  screen(`
    <h1>Choose a workspace</h1>
    <div class="org-list">${orgs.map((o) => `<button class="org-choice" data-org="${esc(o.org_id)}"><strong>${esc(o.name)}</strong><span class="pill">${esc(o.role)}</span></button>`).join("")}</div>
    <div class="auth-links"><a href="#" id="l-create">Create another workspace</a> · <a href="#" id="l-signout">Sign out</a></div>`);
  document.querySelectorAll(".org-choice").forEach((b) => b.addEventListener("click", () => enter(orgs.find((o) => o.org_id === b.dataset.org))));
  $("#l-create").addEventListener("click", (e) => { e.preventDefault(); createOrgScreen(true); });
  $("#l-signout").addEventListener("click", signOutLink);
}

// ---------- flow ----------
async function route() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) return signInScreen();
  const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal.currentLevel !== "aal2") {
    const { data: factors } = await client.auth.mfa.listFactors();
    const verified = (factors?.totp || []).find((f) => f.status === "verified");
    return verified ? challengeScreen(verified) : enrollScreen().catch(fail);
  }
  await client.rpc("accept_invitations");
  return pickOrg(false);
}

async function pickOrg(forceChoice) {
  const { data: orgs, error } = await client.rpc("my_organizations");
  if (error) return fail(error);
  if (!orgs.length) return createOrgScreen(false);
  const last = orgs.find((o) => o.org_id === localStorage.getItem(LAST_ORG_KEY));
  if (!forceChoice && (orgs.length === 1 || last)) return enter(last || orgs[0]);
  pickOrgScreen(orgs);
}

async function enter(org) {
  localStorage.setItem(LAST_ORG_KEY, org.org_id);
  const { data: { user } } = await client.auth.getUser();
  screen(`<h1>${esc(org.name)}</h1><div class="spinner"></div> Loading workspace…`);
  try {
    await onReadyCb({ client, user, org: { id: org.org_id, name: org.name, role: org.role }, url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  } catch (err) {
    return fail(err);
  }
  $("#auth-screen").classList.add("hidden");
  startIdleTimer();
}

async function signOutLink(e) {
  e?.preventDefault();
  await signOut();
}

export async function signOut(message = "") {
  await client.auth.signOut();
  sessionStorage.setItem("riskpilot.signoutMessage", message);
  location.reload();
}

export function switchWorkspace() {
  localStorage.removeItem(LAST_ORG_KEY);
  location.reload();
}

function startIdleTimer() {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => signOut("You were signed out after a period of inactivity."), IDLE_TIMEOUT_MINUTES * 60 * 1000);
  };
  for (const ev of ["pointerdown", "keydown", "scroll", "visibilitychange"]) document.addEventListener(ev, reset, { passive: true });
  reset();
}

export async function startAuth(onReady) {
  onReadyCb = onReady;
  $("#auth-screen").classList.remove("hidden");
  try {
    await loadSupabase();
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    let recovering = false;
    client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") { recovering = true; newPasswordScreen(); }
      // Signed out elsewhere (another tab, session revoked) while the app is open.
      if (event === "SIGNED_OUT" && $("#auth-screen").classList.contains("hidden")) location.reload();
    });
    const msg = sessionStorage.getItem("riskpilot.signoutMessage");
    sessionStorage.removeItem("riskpilot.signoutMessage");
    await new Promise((r) => setTimeout(r, 0));
    if (recovering) return;
    if (msg) return signInScreen(msg);
    await route();
  } catch (err) {
    screen("<h1>RiskPilot</h1>");
    fail(err);
  }
}
