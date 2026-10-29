// Vendor-facing intake questionnaire.
//
// Online (hosted mode, link with an invite token): the questionnaire loads from
// and autosaves to the requester's workspace through the intake-ai function, the
// vendor submits it there, documents are stored with it, and follow-up questions
// from the requester appear when the vendor reopens the same link.
// File (demo mode, or an old link without a token): answers autosave to this
// browser and are handed back as a downloaded JSON file the requester imports.
import { INTAKE_DOMAINS, INTAKE_QUESTIONS, INTAKE_FORMAT, INTAKE_VERSION, INTAKE_MODULES, activeQuestions,
  validateIntake, cleanFollowups, mergeFollowups, awaitingVendor } from "./intake-questions.js";
import { addDocuments, autofillPrompt } from "./autofill.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

// Clickjacking defence for hosts that can't send a frame-ancestors header.
if (window.top !== window.self) {
  document.documentElement.innerHTML = "";
  throw new Error("Posture.ai cannot be embedded in another site.");
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const params = new URLSearchParams(location.search);
let vendorName = params.get("v") || "";
let vendorRef = params.get("ref") || "";
let requester = params.get("org") || "";
// Optional sections the requester turned on, e.g. ?m=cip013
let modules = (params.get("m") || "").split(",").filter((m) => m in INTAKE_MODULES);
const DRAFT_KEY = `riskpilot.intake.${vendorRef || vendorName || "draft"}`;
// Invite token from the requester's link (hosted mode).
const invite = /^[0-9a-f]{64}$/.test(params.get("t") || "") ? params.get("t") : "";
const online = Boolean(SUPABASE_URL && invite);

const form = $("#intake-form");
// Follow-up threads from the requester (see intake-questions.js).
let threads = {};
// Notes under questions, by id: Claude's suggestions from the vendor's documents
// ({ answer, comment, evidence, document, conflict }) or answers the requester
// pre-filled ({ kind: "requester" }).
let aiNotes = {};
let vendorAiFill = null; // { at, documents, summary }, passed on to the requester
// Documents: online, the list stored with the response (no file contents);
// file mode, the files themselves.
let docs = [];

for (const el of $$(".mode-online")) el.classList.toggle("hidden", !online);
for (const el of $$(".mode-file")) el.classList.toggle("hidden", online);

function renderHeader() {
  if (vendorName) $("#intro-title").textContent = `Security intake questionnaire – ${vendorName}`;
  $("#ref-line").textContent = [requester && `Requested by ${requester}`, vendorRef && `Reference ${vendorRef}`].filter(Boolean).join(" · ");
}

// ---------- questions ----------
const domainsInScope = () => INTAKE_DOMAINS.filter((d) => !d.module || modules.includes(d.module));

function renderDomains() {
  $("#domains").innerHTML = domainsInScope().map((d, i) => `
  <details class="card domain" ${i === 0 ? "open" : ""} data-domain="${d.id}">
    <summary><span>${escapeHtml(d.title)}</span><span class="domain-count small muted" data-count="${d.id}"></span></summary>
    ${d.questions.map((q) => `
      <div class="iq${q.parent ? " iq-child" : ""}" data-q="${q.id}" id="q-${q.id}">
        <div class="iq-text"><span class="iq-id">${q.id}</span> ${escapeHtml(q.text)}</div>
        <div class="iq-answers" role="radiogroup" aria-label="${q.id}">
          ${["Yes", "No", "N/A"].map((a) => `<label><input type="radio" name="${q.id}" value="${a}" /> ${a}</label>`).join("")}
        </div>
        <textarea name="${q.id}_comment" rows="1" placeholder="Comment, compensating control or remediation date (optional)"></textarea>
        <div class="iq-ai" data-ai="${q.id}"></div>
        <div class="iq-thread" data-thread="${q.id}"></div>
      </div>`).join("")}
  </details>`).join("");
}

// ---------- state ----------
const PROFILE_FIELDS = ["legalName", "website", "country", "employees", "ownership", "parentCompany", "yearFounded",
  "contactName", "contactTitle", "contactEmail", "securityEmail", "serviceDescription", "access", "recordVolume",
  "hosting", "dataLocations", "drLocation", "inScopeApps", "outsourcedServices", "certificationDetails", "subprocessors",
  "contributors", "approver"];
const PROFILE_LISTS = ["dataTypes", "delivery", "hostingModel", "softwareTypes", "certifications"];

function readAnswers() {
  const all = {};
  for (const q of INTAKE_QUESTIONS) {
    const answer = form.querySelector(`input[name="${q.id}"]:checked`)?.value || "";
    const comment = form.elements[`${q.id}_comment`]?.value.trim() || "";
    if (answer || comment) all[q.id] = { answer, comment };
  }
  // Keep only questions that apply, so a parent changed to "No" drops its follow-on answers.
  const active = new Set(activeQuestions(all, modules).map((q) => q.id));
  return Object.fromEntries(Object.entries(all).filter(([id]) => active.has(id)));
}

const readReplies = () => Object.fromEntries(Object.keys(threads)
  .map((id) => [id, form.elements[`${id}_reply`]?.value.trim() || ""]).filter(([, v]) => v));

const docsMeta = () => docs.map((d) => ({ name: d.name, size: d.size, mediaType: d.mediaType }));

function collect() {
  const profile = {};
  for (const f of PROFILE_FIELDS) profile[f] = form.elements[f].value.trim();
  for (const name of PROFILE_LISTS) profile[name] = $$(`input[name="${name}"]:checked`).map((c) => c.value);
  const answers = readAnswers();
  // Answers the vendor kept as Claude suggested them carry the source and evidence.
  for (const [id, r] of Object.entries(answers)) {
    const n = aiNotes[id];
    if (!n || n.kind === "requester") continue;
    if (!n.conflict && n.answer === r.answer) Object.assign(r, { source: "vendor-ai", evidence: n.evidence, document: n.document });
    else if (n.conflict) r.aiSuggestion = { answer: n.answer, comment: n.comment, evidence: n.evidence, document: n.document };
  }
  return {
    format: INTAKE_FORMAT, version: INTAKE_VERSION,
    vendorRef, vendorName, requester, modules,
    profile, answers,
    followups: threads, replies: readReplies(), aiNotes, vendorAiFill,
    documents: docsMeta(),
    attested: form.elements.attested.checked,
  };
}

function restore(data) {
  for (const f of PROFILE_FIELDS) if (data.profile?.[f] != null && form.elements[f]) form.elements[f].value = data.profile[f];
  for (const name of PROFILE_LISTS) {
    for (const c of $$(`input[name="${name}"]`)) c.checked = (data.profile?.[name] || []).includes(c.value);
  }
  for (const [id, r] of Object.entries(data.answers || {})) {
    const radio = form.querySelector(`input[name="${id}"][value="${r?.answer}"]`);
    if (radio) radio.checked = true;
    if (form.elements[`${id}_comment`]) form.elements[`${id}_comment`].value = r?.comment || "";
  }
  form.elements.attested.checked = !!data.attested;
  threads = cleanFollowups(data.followups);
  renderThreads(data.replies || {});
  aiNotes = data.aiNotes && typeof data.aiNotes === "object" ? data.aiNotes : Object.fromEntries(Object.entries(data.answers || {})
    .filter(([, r]) => r?.source === "vendor-ai").map(([id, r]) => [id, { answer: r.answer, comment: r.comment, evidence: r.evidence, document: r.document }]));
  vendorAiFill = data.vendorAiFill || null;
  renderAiNotes();
}

// ---------- follow-up threads ----------
function renderThreads(replies = readReplies()) {
  for (const el of $$("[data-thread]")) el.innerHTML = "";
  for (const [id, t] of Object.entries(threads)) {
    const el = $(`[data-thread="${id}"]`);
    if (!el) continue;
    const who = (m) => m.by === "requester" ? `Question from ${escapeHtml(m.name || requester || "the requester")}`
      : m.by === "vendor" ? `Reply from ${escapeHtml(m.name || "you")}` : "Note";
    el.innerHTML = `<div class="thread">
        <div class="thread-head">Follow-up ${t.status === "resolved" ? '<span class="tag">resolved</span>' : ""}</div>
        ${t.messages.map((m) => `<div class="thread-msg ${m.by}"><div class="small muted">${who(m)}${m.at ? ` · ${escapeHtml(m.at.slice(0, 10))}` : ""}</div>${escapeHtml(m.text)}</div>`).join("")}
        ${t.status === "open" ? `<textarea name="${id}_reply" rows="2" placeholder="Your reply – answer the question directly; update your answer above if it has changed">${escapeHtml(replies[id] || "")}</textarea>` : ""}
      </div>`;
  }
  const waiting = awaitingVendor(threads);
  const banner = $("#followup-banner");
  banner.classList.toggle("hidden", !waiting.length);
  banner.innerHTML = waiting.length
    ? `<strong>${waiting.length} follow-up question${waiting.length > 1 ? "s" : ""} need${waiting.length > 1 ? "" : "s"} your reply:</strong>
       ${waiting.map((id) => `<a href="#q-${id}" data-jump="${id}">${id}</a>`).join(" · ")}
       <p class="small muted">Reply in the box under each question, then click ${online ? "Submit" : "Download response and send the file back"}.</p>`
    : "";
  for (const id of waiting) $(`[data-thread="${id}"]`)?.closest("details")?.setAttribute("open", "");
}

$("#followup-banner").addEventListener("click", (e) => {
  const id = e.target.dataset.jump;
  if (!id) return;
  e.preventDefault();
  $(`#q-${id}`)?.closest("details")?.setAttribute("open", "");
  $(`#q-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- progress ----------
function updateProgress() {
  const data = collect();
  const active = activeQuestions(data.answers, modules);
  const activeIds = new Set(active.map((q) => q.id));
  // Show follow-on questions only when their parent's answer calls for them.
  for (const q of INTAKE_QUESTIONS) $(`[data-q="${q.id}"]`)?.classList.toggle("hidden", !activeIds.has(q.id));
  const answered = active.filter((q) => data.answers[q.id]?.answer).length;
  const pct = active.length ? Math.round((answered / active.length) * 100) : 0;
  $("#progress-bar").style.width = `${pct}%`;
  $("#progress-text").textContent = `${answered} / ${active.length} answered`;
  for (const d of domainsInScope()) {
    const qs = d.questions.filter((q) => activeIds.has(q.id));
    const n = qs.filter((q) => data.answers[q.id]?.answer).length;
    const el = $(`[data-count="${d.id}"]`);
    el.textContent = `${n}/${qs.length}`;
    el.classList.toggle("done", n === qs.length);
  }
  // Highlight a "No" or a red-flag "Yes" so the vendor knows a comment is expected.
  for (const q of active) {
    const a = data.answers[q.id]?.answer;
    const flagged = q.type === "inverse" ? a === "Yes" : q.type !== "info" && a === "No";
    $(`[data-q="${q.id}"]`).classList.toggle("needs-comment", flagged && !data.answers[q.id]?.comment);
  }
}

// ---------- server (online mode) ----------
async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/intake-ai`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ invite, action, ...payload }),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `The server returned an error (${res.status}).`);
  return body;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
let submittedAt = null;

function showStatus(status) {
  submittedAt = status.submittedAt || submittedAt;
  const unsent = status.status === "draft" && submittedAt;
  $("#save-state").textContent = status.status === "submitted" ? `Submitted ${when(submittedAt)}`
    : unsent ? `Changes saved ${new Date().toLocaleTimeString()} – not yet submitted`
    : `Saved ${new Date().toLocaleTimeString()}`;
  $("#btn-submit").textContent = submittedAt ? "Submit changes" : "Submit";
}

// ---------- saving ----------
let saveTimer, saving = Promise.resolve();
function autosave() {
  updateProgress();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (online) {
      saving = saving.then(() => api("save", { response: collect() }))
        .then(showStatus)
        .catch((err) => { $("#save-state").textContent = `Not saved: ${err.message}`; });
      return;
    }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...collect(), savedAt: new Date().toISOString() }));
      $("#save-state").textContent = `Draft saved ${new Date().toLocaleTimeString()}`;
    } catch {
      $("#save-state").textContent = "Autosave unavailable in this browser – download your response before closing.";
    }
  }, online ? 1500 : 400);
}

let ready = false;
form.addEventListener("input", () => ready && autosave());
form.addEventListener("change", () => ready && autosave());

async function start() {
  if (!online) {
    renderHeader();
    if (vendorName) form.elements.legalName.value = vendorName;
    renderDomains();
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (draft) {
        modules = [...new Set([...modules, ...(draft.modules || []).filter((m) => m in INTAKE_MODULES)])];
        renderDomains();
        restore(draft);
        $("#save-state").textContent = "Draft restored";
      }
    } catch { /* no draft */ }
    updateProgress();
    ready = true;
    return;
  }

  const loadState = $("#load-state");
  loadState.classList.remove("hidden");
  loadState.textContent = "Loading your questionnaire…";
  form.classList.add("hidden");
  let data;
  try {
    data = await api("load");
  } catch (err) {
    loadState.textContent = err.message;
    loadState.classList.replace("muted", "error-text");
    $(".intake-actions").classList.add("hidden");
    $(".attachments").classList.add("hidden");
    return;
  }
  vendorName = data.vendorName || vendorName;
  requester = data.requester || requester;
  modules = (data.modules || []).filter((m) => m in INTAKE_MODULES);
  renderHeader();
  renderDomains();
  const saved = data.response && typeof data.response === "object" ? data.response : null;
  if (saved) {
    restore(saved);
  } else {
    // First visit: start from what the requester already knows.
    restore({ profile: data.seed?.profile || {}, answers: data.seed?.answers || {} });
    aiNotes = Object.fromEntries(Object.keys(data.seed?.answers || {}).map((id) => [id, { kind: "requester" }]));
    renderAiNotes();
  }
  if (!form.elements.legalName.value && vendorName) form.elements.legalName.value = vendorName;
  // The requester's latest questions plus the vendor's own earlier replies.
  threads = mergeFollowups(cleanFollowups(data.followups), cleanFollowups(saved?.followups), {}, {});
  renderThreads(saved?.replies || {});
  docs = data.documents || [];
  renderDocs();
  submittedAt = data.submittedAt;
  if (data.status) showStatus({ status: data.status, submittedAt: data.submittedAt });
  if (data.status === "submitted") $("#save-state").textContent = `Submitted ${when(data.submittedAt)} – changes you make are saved as a draft until you submit again`;
  loadState.classList.add("hidden");
  form.classList.remove("hidden");
  updateProgress();
  ready = true;
}

// ---------- actions ----------
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 5000);
}

function problems(data) {
  const out = [];
  for (const f of ["legalName", "country", "contactName", "contactEmail", "serviceDescription"]) {
    if (!data.profile[f]) out.push(form.elements[f].closest("label").firstChild.textContent.replace("*", "").trim());
  }
  if (data.profile.contactEmail && !form.elements.contactEmail.checkValidity()) out.push("A valid contact email");
  // With documentation attached, the requester completes unanswered questions from it.
  const unanswered = activeQuestions(data.answers, modules).filter((q) => !data.answers[q.id]?.answer);
  if (unanswered.length && !docs.length) out.push(`${unanswered.length} unanswered control question(s) (first: ${unanswered[0].id}) – answer them or attach documentation that covers them`);
  const unreplied = awaitingVendor(threads).filter((id) => !data.replies[id]);
  if (unreplied.length) out.push(`A reply to follow-up question(s) ${unreplied.join(", ")}`);
  if (!data.attested) out.push("The attestation in section 5");
  return out;
}

// The finished response: answers plus follow-up threads with this round's replies added.
function finalResponse() {
  const data = collect();
  const at = new Date().toISOString();
  const followups = structuredClone(threads);
  for (const [id, text] of Object.entries(data.replies)) {
    if (followups[id]?.status === "open") followups[id].messages.push({ by: "vendor", name: data.profile.contactName, text, at });
  }
  const { replies, aiNotes: _notes, ...rest } = data;
  return { data: { ...rest, followups, submittedAt: at }, replies };
}

function checkComplete(data, replies, verb) {
  const missing = problems({ ...data, replies });
  $("#validation").textContent = "";
  if (!missing.length) return true;
  $("#validation").textContent = `Still needed: ${missing.join("; ")}.`;
  const first = activeQuestions(data.answers, modules).find((q) => !data.answers[q.id]?.answer);
  if (first) $(`[data-q="${first.id}"]`).closest("details").open = true;
  return confirm(`Your response is incomplete:\n\n• ${missing.join("\n• ")}\n\n${verb} it anyway?`);
}

$("#btn-submit").addEventListener("click", async () => {
  const { data, replies } = finalResponse();
  if (!checkComplete(data, replies, "Submit")) return;
  const btn = $("#btn-submit");
  btn.disabled = true;
  clearTimeout(saveTimer);
  try {
    await saving;
    const status = await api("submit", { response: data });
    // Replies are now part of the threads.
    threads = cleanFollowups(data.followups);
    renderThreads({});
    showStatus(status);
    toast(`Submitted to ${requester || "your contact"}. You can reopen this link to make changes or answer follow-up questions.`);
  } catch (err) {
    toast(`Couldn't submit: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

$("#btn-download").addEventListener("click", () => {
  const { data, replies } = finalResponse();
  if (!checkComplete(data, replies, "Download")) return;
  data.documents = docs;
  const safeName = (data.profile.legalName || "vendor").replace(/[^\w-]+/g, "_").slice(0, 60);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `security-intake-${safeName}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(docs.length
    ? `Response downloaded with ${docs.length} attached document(s) – email the file to your contact`
    : "Response downloaded – email it to your contact with any evidence files");
});

// File mode: continues from an earlier response or a follow-up file sent by the requester.
$("#resume-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data;
  try {
    data = validateIntake(JSON.parse(await file.text()));
  } catch (err) {
    return toast(`Couldn't open that file: ${err.message}`, true);
  }
  if (Object.keys(readAnswers()).length && !confirm("Replace the answers on this page with the ones in the file?")) return;
  vendorName ||= data.vendorName || "";
  vendorRef ||= data.vendorRef || "";
  requester ||= data.requester || "";
  modules = [...new Set([...modules, ...data.modules])];
  renderHeader();
  renderDomains();
  form.reset();
  restore(data);
  docs = (Array.isArray(data.documents) ? data.documents : []).filter((d) => typeof d?.name === "string" && typeof d.data === "string"
    && ["application/pdf", "text/plain", "text/markdown", "text/csv"].includes(d.mediaType));
  renderDocs();
  autosave();
  const waiting = awaitingVendor(threads).length;
  toast(waiting ? `Opened – ${waiting} follow-up question(s) need your reply` : "Opened – your answers are restored");
});

$("#btn-print").addEventListener("click", () => {
  $$("details.domain").forEach((d) => { d.open = true; });
  window.print();
});

$("#btn-clear-intake").addEventListener("click", () => {
  if (!confirm("Clear all answers on this device?")) return;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  form.reset();
  threads = {};
  renderThreads();
  aiNotes = {};
  vendorAiFill = null;
  renderAiNotes();
  if (vendorName) form.elements.legalName.value = vendorName;
  updateProgress();
  $("#save-state").textContent = "";
});

// ---------- supporting documentation ----------
function renderDocs() {
  $("#doc-list").innerHTML = docs.map((d, i) => `<li><span>📄 ${escapeHtml(d.name)}</span><span class="small muted">${(d.size / 1024 / 1024).toFixed(1)} MB</span>
    <button type="button" class="small" data-remove="${i}">Remove</button></li>`).join("");
  $("#ai-fill").classList.toggle("hidden", !online || !docs.length);
}

async function attach(files) {
  if (!online) {
    const errors = await addDocuments(docs, files);
    if (errors.length) toast(errors[0], true);
    renderDocs();
    return;
  }
  // Online: read and check each file locally (Excel is converted to text), then store it.
  const ready = [];
  const errors = await addDocuments(ready, files);
  for (const d of ready) {
    $("#save-state").textContent = `Uploading ${d.name}…`;
    try {
      docs = (await api("addDocument", { document: d })).documents;
    } catch (err) {
      errors.push(`${d.name}: ${err.message}`);
    }
  }
  $("#save-state").textContent = ready.length ? "Documents saved" : $("#save-state").textContent;
  if (errors.length) toast(errors[0], true);
  renderDocs();
  autosave();
}

const drop = $("#drop");
$("#doc-input").addEventListener("change", (e) => { attach([...e.target.files]); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); attach([...e.dataTransfer.files]); });
$("#doc-list").addEventListener("click", async (e) => {
  const i = e.target.dataset.remove;
  if (i == null) return;
  if (!online) { docs.splice(Number(i), 1); renderDocs(); return; }
  try {
    docs = (await api("removeDocument", { name: docs[Number(i)].name })).documents;
  } catch (err) {
    toast(`Couldn't remove it: ${err.message}`, true);
  }
  renderDocs();
  autosave();
});

// ---------- Claude fills answers from the vendor's documents ----------
function renderAiNotes() {
  for (const el of $$("[data-ai]")) el.innerHTML = "";
  for (const [id, n] of Object.entries(aiNotes)) {
    const el = $(`[data-ai="${id}"]`);
    if (!el) continue;
    if (n.kind === "requester") {
      el.innerHTML = `<div class="iq-evidence">Pre-filled by ${escapeHtml(requester || "your contact")}. Check it and change it if it's wrong.</div>`;
      continue;
    }
    const quote = n.evidence ? ` “${escapeHtml(n.evidence)}”${n.document ? ` — ${escapeHtml(n.document)}` : ""}` : "";
    el.innerHTML = n.conflict
      ? `<div class="iq-evidence warn">⚠ Your documents suggest <strong>${escapeHtml(n.answer)}</strong>:${quote}. Please check your answer.</div>`
      : `<div class="iq-evidence">✨ Filled by Claude from your documents:${quote}. Check it and change it if it's wrong.</div>`;
  }
}

$("#btn-ai-fill").addEventListener("click", async () => {
  const btn = $("#btn-ai-fill"), status = $("#ai-fill-status");
  btn.disabled = true;
  btn.textContent = "Reading your documents… (1–3 minutes)";
  status.textContent = "";
  status.classList.remove("error-text");
  try {
    const body = await api("fill", { prompt: autofillPrompt(form.elements.legalName.value || vendorName, modules) });
    const { filled, conflicts, unknown } = applyAiFill(body.result);
    status.textContent = `Claude filled ${filled} answer(s)${conflicts ? `; ${conflicts} of your answers disagree with your documents (marked ⚠)` : ""}${unknown ? `; ${unknown} question(s) aren't covered by the documents` : ""}. Review each one before you attest.${body.runsLeft != null ? ` ${body.runsLeft} AI run(s) left on this link.` : ""}`;
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error-text");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Fill answers from my documents";
  }
});

// Fills unanswered questions only; where the vendor already answered differently, adds a note.
function applyAiFill(result) {
  const mine = readAnswers();
  const known = new Set(INTAKE_QUESTIONS.map((q) => q.id));
  let filled = 0, conflicts = 0, unknown = 0;
  for (const a of result?.answers || []) {
    if (!known.has(a.id) || !["Yes", "No", "N/A", "Unknown"].includes(a.answer)) continue;
    if (a.answer === "Unknown") { unknown++; continue; }
    const note = { answer: a.answer, comment: String(a.comment || ""), evidence: String(a.evidence || ""), document: String(a.document || "") };
    const current = mine[a.id]?.answer;
    if (current) {
      if (current !== a.answer) { aiNotes[a.id] = { ...note, conflict: true }; conflicts++; }
      continue;
    }
    const radio = form.querySelector(`input[name="${a.id}"][value="${a.answer}"]`);
    if (!radio) continue;
    radio.checked = true;
    const comment = form.elements[`${a.id}_comment`];
    if (comment && !comment.value.trim()) comment.value = note.comment;
    aiNotes[a.id] = note;
    filled++;
  }
  const p = result?.profile || {};
  for (const f of ["certificationDetails", "hosting", "dataLocations", "subprocessors"]) {
    if (p[f] && form.elements[f] && !form.elements[f].value.trim()) form.elements[f].value = p[f];
  }
  for (const c of $$('input[name="certifications"]')) if ((p.certifications || []).includes(c.value)) c.checked = true;
  vendorAiFill = { at: new Date().toISOString(), documents: docsMeta(), summary: String(result?.summary || "") };
  renderAiNotes();
  autosave();
  return { filled, conflicts, unknown };
}

start();
