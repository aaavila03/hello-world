// Vendor-facing intake questionnaire. Runs standalone: answers autosave to this
// browser and are handed back to the requester as a downloaded JSON file.
import { INTAKE_DOMAINS, INTAKE_QUESTIONS, INTAKE_FORMAT, INTAKE_VERSION } from "./intake-questions.js";
import { AUTOFILL_ENDPOINT } from "./config.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const params = new URLSearchParams(location.search);
const vendorName = params.get("v") || "";
const vendorRef = params.get("ref") || "";
const requester = params.get("org") || "";
const accessCode = params.get("code") || "";
const DRAFT_KEY = `riskpilot.intake.${vendorRef || vendorName || "draft"}`;

const form = $("#intake-form");

// ---------- header ----------
if (vendorName) $("#intro-title").textContent = `Security intake questionnaire – ${vendorName}`;
$("#ref-line").textContent = [requester && `Requested by ${requester}`, vendorRef && `Reference ${vendorRef}`].filter(Boolean).join(" · ");
if (vendorName) form.elements.legalName.value = vendorName;

// ---------- questions ----------
$("#domains").innerHTML = INTAKE_DOMAINS.map((d, i) => `
  <details class="card domain" ${i === 0 ? "open" : ""} data-domain="${d.id}">
    <summary><span>${escapeHtml(d.title)}</span><span class="domain-count small muted" data-count="${d.id}"></span></summary>
    ${d.questions.map((q) => `
      <div class="iq" data-q="${q.id}">
        <div class="iq-text"><span class="iq-id">${q.id}</span> ${escapeHtml(q.text)}<span class="iq-badge" data-badge="${q.id}"></span></div>
        <div class="iq-evidence hidden" data-evidence="${q.id}"></div>
        <div class="iq-answers" role="radiogroup" aria-label="${q.id}">
          ${["Yes", "No", "N/A"].map((a) => `<label><input type="radio" name="${q.id}" value="${a}" /> ${a}</label>`).join("")}
        </div>
        <textarea name="${q.id}_comment" rows="1" placeholder="Comment, compensating control or remediation date (optional)"></textarea>
      </div>`).join("")}
  </details>`).join("");

// ---------- state ----------
// AI suggestions per question: { answer, comment, evidence, document, reviewed }.
let aiMeta = {};
let aiRun = null;
const PROFILE_FIELDS = ["legalName", "website", "country", "employees", "contactName", "contactTitle", "contactEmail",
  "securityEmail", "serviceDescription", "access", "recordVolume", "hosting", "dataLocations", "certificationDetails", "subprocessors"];

function collect() {
  const profile = {};
  for (const f of PROFILE_FIELDS) profile[f] = form.elements[f].value.trim();
  profile.dataTypes = $$('input[name="dataTypes"]:checked').map((c) => c.value);
  profile.certifications = $$('input[name="certifications"]:checked').map((c) => c.value);
  const answers = {};
  for (const q of INTAKE_QUESTIONS) {
    const answer = form.querySelector(`input[name="${q.id}"]:checked`)?.value || "";
    const comment = form.elements[`${q.id}_comment`].value.trim();
    const m = aiMeta[q.id];
    if (answer || comment) {
      answers[q.id] = { answer, comment };
      if (m && m.answer !== "Unknown") {
        answers[q.id].source = answer === m.answer ? (m.reviewed ? "ai-reviewed" : "ai") : "vendor";
        if (m.evidence) Object.assign(answers[q.id], { evidence: m.evidence, document: m.document });
      }
    }
  }
  return {
    format: INTAKE_FORMAT, version: INTAKE_VERSION,
    vendorRef, vendorName, requester,
    profile, answers,
    attested: form.elements.attested.checked,
    ...(aiRun ? { aiAutofill: aiRun, aiMeta } : {}),
  };
}

function restore(data) {
  for (const f of PROFILE_FIELDS) if (data.profile?.[f] != null && form.elements[f]) form.elements[f].value = data.profile[f];
  for (const name of ["dataTypes", "certifications"]) {
    for (const c of $$(`input[name="${name}"]`)) c.checked = (data.profile?.[name] || []).includes(c.value);
  }
  for (const [id, r] of Object.entries(data.answers || {})) {
    const radio = form.querySelector(`input[name="${id}"][value="${r.answer}"]`);
    if (radio) radio.checked = true;
    if (form.elements[`${id}_comment`]) form.elements[`${id}_comment`].value = r.comment || "";
  }
  form.elements.attested.checked = !!data.attested;
  aiMeta = data.aiMeta || {};
  aiRun = data.aiAutofill || null;
}

function renderAiMarks() {
  for (const q of INTAKE_QUESTIONS) {
    const m = aiMeta[q.id];
    const badge = $(`[data-badge="${q.id}"]`);
    const ev = $(`[data-evidence="${q.id}"]`);
    const row = $(`[data-q="${q.id}"]`);
    if (!m) { badge.innerHTML = ""; ev.classList.add("hidden"); row.classList.remove("ai-pending"); continue; }
    const current = form.querySelector(`input[name="${q.id}"]:checked`)?.value || "";
    let label = "";
    if (m.answer === "Unknown") label = current ? "" : '<span class="ai-badge unknown">Not found in documents</span>';
    else if (current === m.answer) label = m.reviewed ? '<span class="ai-badge reviewed">AI-drafted · reviewed</span>' : '<span class="ai-badge">AI-drafted · please review</span>';
    else if (current) label = `<span class="ai-badge unknown">AI suggested: ${escapeHtml(m.answer)}</span>`;
    badge.innerHTML = label;
    row.classList.toggle("ai-pending", m.answer !== "Unknown" && current === m.answer && !m.reviewed);
    if (m.evidence) {
      ev.textContent = `“${m.evidence}”${m.document ? ` — ${m.document}` : ""}`;
      ev.classList.remove("hidden");
    } else ev.classList.add("hidden");
  }
}

const pendingReview = () => INTAKE_QUESTIONS.filter((q) => {
  const m = aiMeta[q.id];
  return m && m.answer !== "Unknown" && !m.reviewed && form.querySelector(`input[name="${q.id}"]:checked`)?.value === m.answer;
});

// Clicking an answer (even the drafted one) counts as the vendor reviewing it.
form.addEventListener("click", (e) => {
  const radio = e.target.closest('.iq-answers input[type="radio"]');
  if (radio && aiMeta[radio.name]) { aiMeta[radio.name].reviewed = true; autosave(); }
});

function updateProgress() {
  const data = collect();
  const answered = INTAKE_QUESTIONS.filter((q) => data.answers[q.id]?.answer).length;
  const pct = Math.round((answered / INTAKE_QUESTIONS.length) * 100);
  $("#progress-bar").style.width = `${pct}%`;
  $("#progress-text").textContent = `${answered} / ${INTAKE_QUESTIONS.length} answered`;
  for (const d of INTAKE_DOMAINS) {
    const n = d.questions.filter((q) => data.answers[q.id]?.answer).length;
    const el = $(`[data-count="${d.id}"]`);
    el.textContent = `${n}/${d.questions.length}`;
    el.classList.toggle("done", n === d.questions.length);
  }
  // Highlight a "No" or a red-flag "Yes" so the vendor knows a comment is expected.
  renderAiMarks();
  const pending = pendingReview().length;
  $("#progress-text").textContent += pending ? ` · ${pending} AI answers to review` : "";
  for (const q of INTAKE_QUESTIONS) {
    const a = data.answers[q.id]?.answer;
    const flagged = q.type === "inverse" ? a === "Yes" : q.type !== "info" && a === "No";
    $(`[data-q="${q.id}"]`).classList.toggle("needs-comment", flagged && !data.answers[q.id]?.comment);
  }
}

let saveTimer;
function autosave() {
  updateProgress();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...collect(), savedAt: new Date().toISOString() }));
      $("#save-state").textContent = `Draft saved ${new Date().toLocaleTimeString()}`;
    } catch {
      $("#save-state").textContent = "Autosave unavailable in this browser – download your response before closing.";
    }
  }, 400);
}
form.addEventListener("input", autosave);
form.addEventListener("change", autosave);

try {
  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  if (draft) { restore(draft); $("#save-state").textContent = "Draft restored"; }
} catch { /* no draft */ }
updateProgress();

// ---------- actions ----------
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function problems(data) {
  const out = [];
  for (const f of ["legalName", "country", "contactName", "contactEmail", "serviceDescription"]) {
    if (!data.profile[f]) out.push(form.elements[f].closest("label").firstChild.textContent.replace("*", "").trim());
  }
  if (data.profile.contactEmail && !form.elements.contactEmail.checkValidity()) out.push("A valid contact email");
  const unanswered = INTAKE_QUESTIONS.filter((q) => !data.answers[q.id]?.answer);
  if (unanswered.length) out.push(`${unanswered.length} unanswered control question(s) (first: ${unanswered[0].id})`);
  const pending = pendingReview();
  if (pending.length) out.push(`${pending.length} AI-drafted answer(s) not yet reviewed – click the answer to confirm it (first: ${pending[0].id})`);
  if (!data.attested) out.push("The attestation in section 5");
  return out;
}

$("#btn-download").addEventListener("click", () => {
  const data = collect();
  const missing = problems(data);
  $("#validation").textContent = "";
  if (missing.length) {
    $("#validation").textContent = `Still needed: ${missing.join("; ")}.`;
    const first = INTAKE_QUESTIONS.find((q) => !data.answers[q.id]?.answer) || pendingReview()[0];
    if (first) $(`[data-q="${first.id}"]`).closest("details").open = true;
    if (!confirm(`Your response is incomplete:\n\n• ${missing.join("\n• ")}\n\nDownload it anyway?`)) return;
  }
  data.submittedAt = new Date().toISOString();
  const safeName = (data.profile.legalName || "vendor").replace(/[^\w-]+/g, "_").slice(0, 60);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `security-intake-${safeName}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Response downloaded – email it to your contact with your evidence files");
});

$("#btn-print").addEventListener("click", () => {
  $$("details.domain").forEach((d) => { d.open = true; });
  window.print();
});

$("#btn-clear-intake").addEventListener("click", () => {
  if (!confirm("Clear all answers on this device?")) return;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  form.reset();
  aiMeta = {};
  aiRun = null;
  if (vendorName) form.elements.legalName.value = vendorName;
  updateProgress();
  $("#save-state").textContent = "";
});

// ---------- AI auto-fill from documents ----------
const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv" };
let docs = [];

function mediaType(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  return TYPES[ext] || (Object.values(TYPES).includes(file.type) ? file.type : null);
}

function renderDocs() {
  $("#doc-list").innerHTML = docs.map((f, i) => `<li><span>📄 ${escapeHtml(f.name)}</span><span class="small muted">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
    <button type="button" class="small" data-remove="${i}">Remove</button></li>`).join("");
  $("#btn-autofill").disabled = !docs.length;
}

function addFiles(list) {
  for (const f of list) {
    if (!mediaType(f)) { toast(`${f.name}: use PDF, TXT, Markdown or CSV (save Word files as PDF)`, true); continue; }
    if (docs.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} documents`, true); break; }
    if (docs.reduce((n, d) => n + d.size, 0) + f.size > MAX_BYTES) { toast("Documents can total at most 20 MB", true); break; }
    if (!docs.some((d) => d.name === f.name && d.size === f.size)) docs.push(f);
  }
  renderDocs();
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(new Error(`Could not read ${file.name}`));
  r.readAsDataURL(file);
});

function applyAutofill(result) {
  const now = new Date().toISOString();
  let filled = 0, kept = 0, unknown = 0;
  for (const a of result.answers || []) {
    if (!INTAKE_QUESTIONS.some((q) => q.id === a.id)) continue;
    const current = form.querySelector(`input[name="${a.id}"]:checked`)?.value;
    aiMeta[a.id] = { answer: a.answer, comment: a.comment, evidence: a.evidence, document: a.document, reviewed: false };
    if (a.answer === "Unknown") { unknown++; continue; }
    if (current) { kept++; continue; }
    form.querySelector(`input[name="${a.id}"][value="${a.answer}"]`).checked = true;
    const c = form.elements[`${a.id}_comment`];
    if (!c.value && a.comment) c.value = a.comment;
    filled++;
  }
  const p = result.profile || {};
  for (const f of ["certificationDetails", "hosting", "dataLocations", "subprocessors"]) {
    if (p[f] && !form.elements[f].value) form.elements[f].value = p[f];
  }
  for (const c of $$('input[name="certifications"]')) if ((p.certifications || []).includes(c.value)) c.checked = true;
  aiRun = { at: now, documents: docs.map((d) => ({ name: d.name, size: d.size })), summary: result.summary || "" };
  return { filled, kept, unknown };
}

if (AUTOFILL_ENDPOINT) {
  $("#autofill-card").classList.remove("hidden");
  const drop = $("#drop");
  $("#doc-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
  $("#doc-list").addEventListener("click", (e) => {
    const i = e.target.dataset.remove;
    if (i != null) { docs.splice(Number(i), 1); renderDocs(); }
  });

  $("#btn-autofill").addEventListener("click", async () => {
    const status = $("#autofill-status");
    const btn = $("#btn-autofill");
    btn.disabled = true;
    status.classList.remove("hidden");
    status.innerHTML = `<div class="spinner"></div> Reading ${docs.length} document(s) and drafting answers. This usually takes 1–3 minutes – please keep this page open.`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6 * 60 * 1000);
    try {
      const documents = await Promise.all(docs.map(async (f) => ({ name: f.name, mediaType: mediaType(f), data: await toBase64(f) })));
      const res = await fetch(`${AUTOFILL_ENDPOINT.replace(/\/$/, "")}/autofill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documents, accessCode, vendorName: vendorName || form.elements.legalName.value }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The auto-fill service returned an error (${res.status}).`);
      const { filled, kept, unknown } = applyAutofill(data);
      $$("details.domain").forEach((d) => { d.open = true; });
      autosave();
      status.innerHTML = `<strong>Drafted ${filled} answer(s) from your documents.</strong>
        ${kept ? `${kept} question(s) you had already answered were left unchanged. ` : ""}
        ${unknown ? `${unknown} question(s) weren't covered by the documents and are marked “Not found in documents” – please answer them yourself. ` : ""}
        <br>Answers marked <span class="ai-badge">AI-drafted · please review</span> show the supporting quote underneath. Click the correct answer on each one to confirm it before downloading.
        ${data.summary ? `<p class="small muted">${escapeHtml(data.summary)}</p>` : ""}`;
    } catch (err) {
      status.innerHTML = `<p class="error-text">${escapeHtml(err.name === "AbortError" ? "The request took too long. Try fewer or smaller documents." : err.message)}</p>`;
    } finally {
      clearTimeout(timer);
      btn.disabled = !docs.length;
    }
  });
}
