// Vendor-facing intake questionnaire. Runs standalone: answers autosave to this
// browser and are handed back to the requester as a downloaded JSON file.
import { INTAKE_DOMAINS, INTAKE_QUESTIONS, INTAKE_FORMAT, INTAKE_VERSION } from "./intake-questions.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const params = new URLSearchParams(location.search);
const vendorName = params.get("v") || "";
const vendorRef = params.get("ref") || "";
const requester = params.get("org") || "";
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
        <div class="iq-text"><span class="iq-id">${q.id}</span> ${escapeHtml(q.text)}</div>
        <div class="iq-answers" role="radiogroup" aria-label="${q.id}">
          ${["Yes", "No", "N/A"].map((a) => `<label><input type="radio" name="${q.id}" value="${a}" /> ${a}</label>`).join("")}
        </div>
        <textarea name="${q.id}_comment" rows="1" placeholder="Comment, compensating control or remediation date (optional)"></textarea>
      </div>`).join("")}
  </details>`).join("");

// ---------- state ----------
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
    if (answer || comment) answers[q.id] = { answer, comment };
  }
  return {
    format: INTAKE_FORMAT, version: INTAKE_VERSION,
    vendorRef, vendorName, requester,
    profile, answers,
    attested: form.elements.attested.checked,
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
}

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
  if (!data.attested) out.push("The attestation in section 5");
  return out;
}

$("#btn-download").addEventListener("click", () => {
  const data = collect();
  const missing = problems(data);
  $("#validation").textContent = "";
  if (missing.length) {
    $("#validation").textContent = `Still needed: ${missing.join("; ")}.`;
    const first = INTAKE_QUESTIONS.find((q) => !data.answers[q.id]?.answer);
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
  if (vendorName) form.elements.legalName.value = vendorName;
  updateProgress();
  $("#save-state").textContent = "";
});
