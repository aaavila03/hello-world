// Vendor (third-party) risk assessment: inventory, security questionnaire,
// tiering, review scheduling and Claude-powered due diligence.
import { assessVendorOffline } from "./heuristics.js";
import { INTAKE_QUESTIONS, INTAKE_FORMAT, INTAKE_VERSION, activeQuestions, summarizeIntake, deriveControlAnswers,
  validateIntake, mergeFollowups, followupRounds, awaitingVendor, lastSpeaker } from "./intake-questions.js";
import { addDocuments, autofillPrompt } from "./autofill.js";


const LEVELS = ["Low", "Medium", "High", "Critical"];
const CRITICALITY = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const DATA = { None: 1, Internal: 2, Confidential: 3, "Regulated (PII/PHI/PCI)": 4 };
const ACCESS = { None: 1, "Read-only / API": 2, "Network access": 3, "Privileged / admin": 4 };
const REVIEW_MONTHS = { Critical: 6, High: 12, Medium: 24, Low: 36 };

// Questions marked key are controls whose absence keeps a vendor at Medium or above.
export const QUESTIONS = [
  { id: "policy", domain: "Governance", text: "Maintains a documented, approved information security policy", weight: 1 },
  { id: "cert", domain: "Governance", text: "Holds a current SOC 2 Type II or ISO 27001 certification", weight: 2 },
  { id: "pentest", domain: "Governance", text: "Has an independent penetration test in the last 12 months", weight: 1 },
  { id: "mfa", domain: "Access control", text: "Enforces MFA for all staff and administrative access", weight: 2, key: true },
  { id: "access_review", domain: "Access control", text: "Reviews user access at least quarterly and removes leavers promptly", weight: 1 },
  { id: "encrypt", domain: "Data protection", text: "Encrypts our data at rest and in transit", weight: 2, key: true },
  { id: "retention", domain: "Data protection", text: "Deletes or returns our data at contract end, with defined retention", weight: 1 },
  { id: "data_location", domain: "Data protection", text: "Documents where our data is stored and processed", weight: 1 },
  { id: "vuln", domain: "Operations", text: "Patches critical vulnerabilities within defined SLAs", weight: 2 },
  { id: "logging", domain: "Operations", text: "Logs and monitors security events (SIEM or equivalent)", weight: 1 },
  { id: "ir", domain: "Incident response", text: "Has a tested incident response plan", weight: 1 },
  { id: "notify", domain: "Incident response", text: "Commits contractually to breach notification within 72 hours", weight: 2, key: true },
  { id: "bcp", domain: "Resilience", text: "Has tested business continuity and disaster recovery plans", weight: 1 },
  { id: "subproc", domain: "Supply chain", text: "Discloses subprocessors and flows security requirements down to them", weight: 1 },
  { id: "insurance", domain: "Supply chain", text: "Carries cyber liability insurance", weight: 1 },
];
const ANSWER_VALUE = { Yes: 1, Partial: 0.5, No: 0 };


// ---------- scoring ----------
export function inherentTier(v) {
  const sum = (CRITICALITY[v.criticality] || 2) + (DATA[v.dataSensitivity] || 2) + (ACCESS[v.access] || 1);
  return sum >= 10 ? "Critical" : sum >= 8 ? "High" : sum >= 6 ? "Medium" : "Low";
}

// Percentage of weighted questionnaire controls in place, or null if nothing is answered.
// Unanswered questions count as not demonstrated; N/A questions are left out.
export function controlScore(v) {
  let got = 0, max = 0, answered = 0;
  for (const q of QUESTIONS) {
    const a = v.answers?.[q.id];
    if (a === "N/A") continue;
    max += q.weight;
    if (a in ANSWER_VALUE) {
      got += ANSWER_VALUE[a] * q.weight;
      answered++;
    }
  }
  return answered && max ? Math.round((got / max) * 100) : null;
}

export function residualTier(v) {
  const base = LEVELS.indexOf(inherentTier(v));
  const pct = controlScore(v);
  if (pct == null) return LEVELS[base];
  const reduction = pct >= 85 ? 2 : pct >= 65 ? 1 : 0;
  let idx = Math.max(0, base - reduction);
  if (QUESTIONS.some((q) => q.key && v.answers?.[q.id] === "No")) idx = Math.max(idx, 1);
  return LEVELS[idx];
}

export function nextReview(v) {
  if (!v.lastAssessed) return null;
  const d = new Date(v.lastAssessed);
  d.setMonth(d.getMonth() + REVIEW_MONTHS[inherentTier(v)]);
  return d.toISOString().slice(0, 10);
}

export function isOverdue(v) {
  if (v.status === "Offboarded") return false;
  const due = nextReview(v);
  return !due || new Date(due) < new Date(new Date().toDateString());
}

const tierClass = (t) => ({ Low: "low", Medium: "medium", High: "high", Critical: "critical" }[t]);

// ---------- module ----------
const openFollowups = (intake) => Object.values(intake?.followups || {}).filter((t) => t.status === "open").length;

export function initVendors({ $, $$, escapeHtml, toast, download, initial, persist, getAI, getOrgName, addRegisterRisk, onChange, createInvite, intakeServer }) {
  let vendors = initial || [];
  let sortKey = "residual", sortDir = -1;

  const save = () => {
    persist(vendors);
    render();
    onChange();
  };

  const nextId = () => {
    const max = vendors.reduce((m, v) => Math.max(m, Number(String(v.id).replace(/\D/g, "")) || 0), 0);
    return `V-${String(max + 1).padStart(3, "0")}`;
  };

  // ---------- table ----------
  function render() {
    const q = $("#vendor-search").value.toLowerCase();
    const tierFilter = $("#vendor-filter-tier").value;
    const tierRank = (t) => LEVELS.indexOf(t);
    const val = (v) => ({
      inherent: tierRank(inherentTier(v)),
      residual: tierRank(residualTier(v)),
      score: controlScore(v) ?? -1,
      review: nextReview(v) || "",
    }[sortKey] ?? String(v[sortKey] ?? "").toLowerCase());

    const rows = vendors
      .filter((v) => !q || JSON.stringify(v).toLowerCase().includes(q))
      .filter((v) => !tierFilter || residualTier(v) === tierFilter)
      .sort((a, b) => {
        const [x, y] = [val(a), val(b)];
        return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
      });

    $("#vendor-table tbody").innerHTML = rows.map((v) => {
      const inh = inherentTier(v), res = residualTier(v), pct = controlScore(v), due = nextReview(v);
      return `<tr>
        <td>${escapeHtml(v.id)}</td>
        <td><strong>${escapeHtml(v.name)}</strong>${v.intake ? ' <span class="tag" title="Intake questionnaire received">intake ✓</span>' : ""}${newSubmission(v) ? ' <span class="tag p-medium" title="The vendor submitted their questionnaire – open the vendor to review it">response submitted</span>'
          : responses.get(v.id)?.status === "draft" && !v.intake?.serverSubmittedAt ? ' <span class="tag" title="The vendor has started their questionnaire">in progress</span>' : ""}${openFollowups(v.intake) ? ` <span class="tag p-medium" title="Follow-up questions not yet resolved">${openFollowups(v.intake)} follow-up${openFollowups(v.intake) > 1 ? "s" : ""} open</span>` : ""}<div class="muted small">${escapeHtml(v.service)}</div></td>
        <td>${escapeHtml(v.criticality)}</td>
        <td>${escapeHtml(v.dataSensitivity)}</td>
        <td><span class="badge ${tierClass(inh)}">${inh}</span></td>
        <td>${pct == null ? '<span class="muted">Not assessed</span>' : `${pct}%`}</td>
        <td><span class="badge ${tierClass(res)}">${res}</span></td>
        <td class="${isOverdue(v) ? "overdue" : ""}">${escapeHtml(due || "Not assessed")}</td>
        <td>${escapeHtml(v.status)}</td>
        <td><button class="small" data-vendor="${escapeHtml(v.id)}">Edit</button></td>
      </tr>`;
    }).join("");
    $("#empty-vendors").classList.toggle("hidden", rows.length > 0);
  }

  $("#vendor-search").addEventListener("input", render);
  $("#vendor-filter-tier").addEventListener("change", render);
  $$("#vendor-table th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
    sortKey = th.dataset.sort;
    render();
  }));
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-vendor]");
    if (btn) { e.preventDefault(); openEditor(vendors.find((v) => v.id === btn.dataset.vendor)); }
  });

  // ---------- editor ----------
  const dialog = $("#vendor-dialog");
  const form = $("#vendor-form");
  let editingId = null;
  let pendingAssessment = null;
  let pendingIntake = null;
  // Control answers saved before the intake existed, kept for vendors without one.
  let legacyAnswers = {};

  // The 15 controls behind the tiers and score are worked out from the intake
  // questionnaire (see deriveControlAnswers); there is no separate form for them.
  function readForm() {
    const data = Object.fromEntries(new FormData(form));
    return { ...data, answers: pendingIntake ? deriveControlAnswers(pendingIntake) : legacyAnswers };
  }

  function updateLiveScore() {
    const v = readForm();
    const pct = controlScore(v), inh = inherentTier(v), res = residualTier(v);
    $("#vendor-score").innerHTML = `Inherent <span class="badge ${tierClass(inh)}">${inh}</span>
      · Controls ${pct == null ? "–" : `${pct}%`}
      · Residual <span class="badge ${tierClass(res)}">${res}</span>`;
  }
  form.addEventListener("input", updateLiveScore);
  form.addEventListener("change", updateLiveScore);

  function openEditor(vendor) {
    editingId = vendor?.id ?? null;
    pendingAssessment = vendor?.aiAssessment ?? null;
    pendingIntake = vendor?.intake ? structuredClone(vendor.intake) : null;
    legacyAnswers = vendor?.answers || {};
    intakeDocs = [];
    askDrafts.clear();
    form.reset();
    $("#vendor-dialog-title").textContent = vendor ? `Edit ${vendor.id} · ${vendor.name}` : "New vendor";
    $("#btn-vendor-delete").classList.toggle("hidden", !vendor);
    $("#btn-vendor-to-risk").classList.toggle("hidden", !vendor);
    if (vendor) {
      for (const [k, v] of Object.entries(vendor)) if (form.elements[k] && typeof v !== "object") form.elements[k].value = v ?? "";
    }
    const panel = $("#vendor-ai-panel");
    if (pendingAssessment) showAssessment(pendingAssessment);
    else panel.classList.add("hidden");
    renderIntake();
    updateLiveScore();
    dialog.showModal();
    syncOnline(vendor);
  }

  // ---------- intake questionnaire ----------
  // Documents from the imported response or added by the analyst. Kept in memory
  // only (they can be too large for browser storage); names are saved with the intake.
  let intakeDocs = [];

  function renderIntake() {
    renderIntakeDocs();
    const box = $("#vendor-intake");
    renderAnswers();
    if (!pendingIntake) {
      box.innerHTML = intakeServer
        ? `<span class="muted">${serverStatus?.status === "draft" ? `The vendor has started the questionnaire (last saved ${escapeHtml(serverStatus.updatedAt.slice(0, 10))}) but hasn't submitted it yet.` : "No response yet. Save the vendor, then click Copy link for vendor and send it to them: their answers and documents appear here when they submit. You can also answer questions yourself below."}</span>`
        : `<span class="muted">No response yet. Copy the link, send it to the vendor, then import the file they send back. If they send documentation instead, use Add documents and Fill from documents.</span>`;
      return;
    }
    pendingIntake.modules = selectedModules();
    const s = summarizeIntake(pendingIntake);
    const p = pendingIntake.profile;
    const flagList = s.flags.map((f) => `<li><span class="iq-id">${escapeHtml(f.id)}</span> ${escapeHtml(f.text)} <strong>${escapeHtml(f.answer)}</strong>${f.comment ? ` – <em>${escapeHtml(f.comment)}</em>` : ""} ${askButton(f.id)}</li>`).join("");
    const delivery = [...(p.delivery || []), ...(p.hostingModel || [])].join(", ");
    const header = pendingIntake.analystCreated
      ? `<div><strong>Completed from documents</strong> – no questionnaire response from the vendor</div>`
      : `<div><strong>Response received</strong> ${pendingIntake.submittedAt ? escapeHtml(pendingIntake.submittedAt.slice(0, 10)) : ""}
        from ${escapeHtml(p.contactName || "unknown")}${p.contactEmail ? ` (${escapeHtml(p.contactEmail)})` : ""}
        ${pendingIntake.attested ? "" : ' <span class="tag p-high">not attested</span>'}</div>`;
    const online = serverStatus ? `<div class="small">${serverStatus.status === "submitted" ? `Submitted online ${escapeHtml(serverStatus.submittedAt.slice(0, 10))}`
      : `Vendor is editing their response (last saved ${escapeHtml(serverStatus.updatedAt.slice(0, 10))})${serverStatus.submittedAt ? " – changes not yet submitted" : ""}`}</div>` : "";
    box.innerHTML = `
      ${header}${online}
      <div>Intake score <strong>${s.score ?? "–"}%</strong> · ${s.counts.Yes} Yes · ${s.counts.No} No · ${s.counts["N/A"]} N/A · ${s.counts.unanswered} unanswered</div>
      <div class="small">Certifications: ${escapeHtml(p.certifications?.join(", ") || "none listed")}${p.dataLocations ? ` · Data locations: ${escapeHtml(p.dataLocations)}` : ""}${p.drLocation ? ` · DR: ${escapeHtml(p.drLocation)}` : ""}${delivery ? ` · ${escapeHtml(delivery)}` : ""}</div>
      ${s.flags.length ? `<details><summary>${s.flags.length} answer(s) needing attention</summary><ul>${flagList}</ul></details>` : ""}
      ${aiFillSection()}
      ${followupSection()}`;
  }

  // ---------- the questionnaire inside the profile ----------
  const SOURCE_TAG = { ai: "Claude", analyst: "you", "vendor-ai": "vendor, suggested by Claude" };

  function renderAnswers() {
    const answers = pendingIntake?.answers || {};
    const active = new Set(activeQuestions(answers, selectedModules()).map((q) => q.id));
    const domains = INTAKE_QUESTIONS.reduce((m, q) => ((m[q.domain] ||= []).push(q), m), {});
    const rows = Object.entries(domains).map(([domain, qs]) => {
      const shown = qs.filter((q) => active.has(q.id));
      if (!shown.length) return "";
      return `<h4>${escapeHtml(domain)}</h4>${shown.map((q) => {
        const r = answers[q.id] || {};
        const who = r.answer ? (SOURCE_TAG[r.source] || "vendor") : "";
        return `<div class="ia-row${q.parent ? " iq-child" : ""}">
          <div><span class="iq-id">${q.id}</span> ${escapeHtml(q.text)} ${who ? `<span class="tag">${escapeHtml(who)}</span>` : ""}</div>
          <div class="ia-inputs">
            <select data-ia-answer="${q.id}" aria-label="${q.id} answer">${["", "Yes", "No", "N/A"].map((a) => `<option value="${a}" ${a === (r.answer || "") ? "selected" : ""}>${a || "–"}</option>`).join("")}</select>
            <input data-ia-comment="${q.id}" value="${escapeHtml(r.comment || "")}" placeholder="Comment" aria-label="${q.id} comment" />
          </div>
          ${r.evidence ? `<div class="iq-evidence">“${escapeHtml(r.evidence)}”${r.document ? ` — ${escapeHtml(r.document)}` : ""}</div>` : ""}
        </div>`;
      }).join("")}`;
    }).join("");
    $("#intake-answers-list").innerHTML = rows;
    const answered = [...active].filter((id) => answers[id]?.answer).length;
    $("#intake-answers-count").textContent = `${answered} / ${active.size} answered`;
  }

  // The analyst answers or corrects a question in the profile.
  $("#intake-answers-list").addEventListener("change", (e) => {
    const id = e.target.dataset.iaAnswer || e.target.dataset.iaComment;
    if (!id) return;
    const name = form.elements.name.value.trim();
    pendingIntake ||= {
      format: INTAKE_FORMAT, version: INTAKE_VERSION, vendorRef: editingId || "", vendorName: name,
      profile: { legalName: name }, answers: {}, attested: false, analystCreated: true, modules: selectedModules(),
    };
    const r = pendingIntake.answers[id] || {};
    const answer = e.target.dataset.iaAnswer ? e.target.value : r.answer || "";
    const comment = e.target.dataset.iaComment ? e.target.value.trim() : r.comment || "";
    if (!answer && !comment) delete pendingIntake.answers[id];
    else pendingIntake.answers[id] = { answer, comment, source: "analyst" };
    applyDerivedControls();
    renderIntake();
  });

  // ---------- follow-up questions ----------
  // Questions the analyst has started a follow-up on but not yet written.
  const askDrafts = new Set();
  const selectedModules = () => (form.elements.intakeModules.value ? [form.elements.intakeModules.value] : []);
  const askButton = (id) => pendingIntake.followups?.[id] || askDrafts.has(id) ? ""
    : `<button type="button" class="small link" data-ask="${id}">Ask follow-up</button>`;

  function followupSection() {
    const threads = pendingIntake.followups || {};
    const ids = [...new Set([...Object.keys(threads), ...askDrafts])];
    if (!ids.length) return "";
    const q = Object.fromEntries(INTAKE_QUESTIONS.map((x) => [x.id, x]));
    const who = (m) => m.by === "requester" ? `Asked by ${escapeHtml(m.name || "us")}` : m.by === "vendor" ? `Vendor reply${m.name ? ` (${escapeHtml(m.name)})` : ""}` : "Note";
    const waiting = awaitingVendor(threads);
    const rows = ids.map((id) => {
      const t = threads[id] || { status: "open", messages: [] };
      const r = pendingIntake.answers[id];
      const lastVendor = lastSpeaker(t) === "vendor";
      const state = t.status === "resolved" ? '<span class="tag">resolved</span>'
        : !t.messages.length ? '<span class="tag">draft</span>'
        : lastVendor ? '<span class="tag p-medium">vendor replied – review</span>' : '<span class="tag">waiting on vendor</span>';
      return `<div class="thread">
        <div class="thread-head"><span class="iq-id">${id}</span> ${escapeHtml(q[id]?.text || "")} ${state}
          ${followupRounds(t) ? `<span class="small muted">round ${followupRounds(t)}</span>` : ""}</div>
        <div class="small">Answer: <strong>${escapeHtml(r?.answer || "not answered")}</strong>${r?.comment ? ` – ${escapeHtml(r.comment)}` : ""}</div>
        ${t.messages.map((m) => `<div class="thread-msg ${m.by}"><div class="small muted">${who(m)}${m.at ? ` · ${escapeHtml(m.at.slice(0, 10))}` : ""}</div>${escapeHtml(m.text)}</div>`).join("")}
        ${t.status === "open" ? `<textarea rows="2" data-ask-text="${id}" placeholder="${t.messages.length ? "Ask again or clarify" : "What do you need the vendor to clarify?"}"></textarea>` : ""}
        <div class="thread-actions">
          ${t.status === "open" ? `<button type="button" class="small" data-ask-send="${id}">Add question</button>` : ""}
          ${t.status === "open" && t.messages.length ? `<button type="button" class="small" data-resolve="${id}">Mark resolved</button>` : ""}
          ${t.status === "resolved" ? `<button type="button" class="small" data-reopen="${id}">Reopen</button>` : ""}
          ${!t.messages.length ? `<button type="button" class="small" data-ask-cancel="${id}">Cancel</button>` : ""}
        </div>
      </div>`;
    }).join("");
    return `<details open><summary>Follow-up questions (${Object.values(threads).filter((t) => t.status === "open").length} open)</summary>
      ${rows}
      <div class="thread-actions">
        <button type="button" data-send-followups ${waiting.length ? "" : "disabled"}>Send ${waiting.length || ""} follow-up${waiting.length === 1 ? "" : "s"} to vendor</button>
        <span class="small muted">${intakeServer ? "Saves this vendor and copies their link. Send it to them: they'll see your questions when they open it, and their replies appear here when they submit."
          : "Downloads a file for the vendor and copies the form link. They open the file on the form, reply, and send their response back for you to import."}</span>
      </div></details>`;
  }

  $("#vendor-intake").addEventListener("click", async (e) => {
    const d = e.target.dataset;
    if (!pendingIntake) return;
    const threads = (pendingIntake.followups ||= {});
    if (d.ask) {
      askDrafts.add(d.ask);
      renderIntake();
      $(`[data-ask-text="${d.ask}"]`)?.focus();
    } else if (d.askSend) {
      const text = $(`[data-ask-text="${d.askSend}"]`).value.trim();
      if (!text) return toast("Write the follow-up question first", true);
      const t = (threads[d.askSend] ||= { status: "open", messages: [] });
      t.messages.push({ by: "requester", name: getOrgName() || "", text, at: new Date().toISOString() });
      askDrafts.delete(d.askSend);
      renderIntake();
    } else if (d.askCancel) {
      askDrafts.delete(d.askCancel);
      renderIntake();
    } else if (d.resolve || d.reopen) {
      threads[d.resolve || d.reopen].status = d.resolve ? "resolved" : "open";
      renderIntake();
    } else if ("sendFollowups" in d) {
      await sendFollowups();
    }
  });

  // The file the vendor opens on the intake form: their answers (not Claude's) and the threads.
  async function sendFollowups() {
    const name = form.elements.name.value.trim() || pendingIntake.vendorName || "vendor";
    if (intakeServer) {
      // Online: the vendor reads the questions from the saved profile through their link.
      if (!editingId) return toast("Save the vendor first", true);
      saveEditor({ close: false });
      const link = await intakeLink(name);
      try {
        await navigator.clipboard.writeText(link);
        toast("Saved and link copied – send it to the vendor so they can reply");
      } catch {
        prompt("Saved. Send the vendor this link so they can reply:", link);
      }
      return;
    }
    const answers = Object.fromEntries(Object.entries(pendingIntake.answers)
      .filter(([, r]) => !["ai", "analyst"].includes(r.source))
      .map(([id, r]) => [id, { answer: r.answer, comment: r.comment || "",
        ...(r.source === "vendor-ai" ? { source: r.source, evidence: r.evidence, document: r.document } : {}) }]));
    const file = {
      format: INTAKE_FORMAT, version: INTAKE_VERSION,
      vendorRef: editingId || pendingIntake.vendorRef || "", vendorName: name, requester: getOrgName() || "",
      modules: selectedModules(), profile: pendingIntake.profile, answers,
      followups: pendingIntake.followups, attested: false,
    };
    download(`follow-up-${name.replace(/[^\w-]+/g, "_").slice(0, 60)}.json`, JSON.stringify(file, null, 2), "application/json");
    const link = await intakeLink(name);
    try {
      await navigator.clipboard.writeText(link);
      toast("Follow-up file downloaded and form link copied – email both to the vendor, then Save");
    } catch {
      prompt("Follow-up file downloaded. Send it to the vendor with this form link:", link);
    }
  }

  // The form link. In hosted mode it carries a new invite token so the vendor can
  // ask Claude to fill answers from their documents (5 runs, 30 days).
  async function intakeLink(name) {
    const url = new URL("intake.html", location.href);
    url.searchParams.set("v", name);
    if (editingId) url.searchParams.set("ref", editingId);
    if (getOrgName()) url.searchParams.set("org", getOrgName());
    if (selectedModules().length) url.searchParams.set("m", selectedModules().join(","));
    if (createInvite) {
      try {
        url.searchParams.set("t", await createInvite(editingId || ""));
      } catch (err) {
        toast(`The link works, but without AI help for the vendor: ${err.message}`, true);
      }
    }
    return url.href;
  }

  form.elements.intakeModules.addEventListener("change", () => {
    if (!pendingIntake) return renderAnswers();
    pendingIntake.modules = selectedModules();
    applyDerivedControls();
    renderIntake();
  });

  function aiFillSection() {
    const run = pendingIntake.aiFill;
    if (!run) return "";
    const entries = INTAKE_QUESTIONS.map((q) => [q, pendingIntake.answers[q.id]]).filter(([, r]) => r);
    const filled = entries.filter(([, r]) => r.source === "ai" || r.source === "analyst");
    const conflicts = entries.filter(([, r]) => r.aiSuggestion);
    const evidence = (r) => r.evidence ? `<div class="iq-evidence">“${escapeHtml(r.evidence)}”${r.document ? ` — ${escapeHtml(r.document)}` : ""}</div>` : "";
    const rows = filled.map(([q, r]) => `<li><span class="iq-id">${q.id}</span> ${escapeHtml(q.text)}
      <select data-ai-answer="${q.id}">${["Yes", "No", "N/A"].map((a) => `<option ${a === r.answer ? "selected" : ""}>${a}</option>`).join("")}</select>
      ${r.source === "analyst" ? '<span class="tag">changed by you</span>' : ""} ${askButton(q.id)}${evidence(r)}</li>`).join("");
    const conflictRows = conflicts.map(([q, r]) => `<li><span class="iq-id">${q.id}</span> ${escapeHtml(q.text)}
      Vendor: <strong>${escapeHtml(r.answer)}</strong> · documents suggest: <strong>${escapeHtml(r.aiSuggestion.answer)}</strong>${evidence(r.aiSuggestion)}</li>`).join("");
    const byVendor = entries.filter(([, r]) => r.source === "vendor-ai").length;
    return `
      <div class="ai-fill-line">✨ ${run.byVendor ? `The vendor used Claude to suggest answers from ${run.documents.length} document(s) (${escapeHtml(run.documents.map((d) => d.name).join(", "))}) on ${escapeHtml(run.at.slice(0, 10))} and kept ${byVendor} of them, which they attested`
        : `Claude filled ${filled.length} answer(s) from ${run.documents.length} document(s) (${escapeHtml(run.documents.map((d) => d.name).join(", "))}) on ${escapeHtml(run.at.slice(0, 10))}`}.
        ${conflicts.length ? `<span class="error-text">${conflicts.length} vendor answer(s) disagree with the documents.</span>` : ""}</div>
      ${run.summary ? `<div class="small muted">${escapeHtml(run.summary)}</div>` : ""}
      ${conflicts.length ? `<details open><summary>Vendor answers that disagree with the documents (${conflicts.length})</summary><ul>${conflictRows}</ul></details>` : ""}
      ${filled.length ? `<details><summary>Review AI-filled answers (${filled.length})</summary><p class="small muted">Change any answer here; the security questionnaire below updates to match.</p><ul class="ai-review">${rows}</ul></details>` : ""}`;
  }

  // The analyst corrects an AI-filled answer.
  $("#vendor-intake").addEventListener("change", (e) => {
    const id = e.target.dataset.aiAnswer;
    if (!id) return;
    Object.assign(pendingIntake.answers[id], { answer: e.target.value, source: "analyst" });
    applyDerivedControls();
    renderIntake();
    $("#vendor-intake details:last-of-type").open = true;
  });

  function applyDerivedControls() {
    updateLiveScore();
  }

  function renderIntakeDocs() {
    const stored = serverDocs.filter((d) => !intakeDocs.some((x) => x.name === d.name));
    const saved = pendingIntake?.documents || [];
    const missing = saved.filter((d) => !intakeDocs.some((x) => x.name === d.name) && !stored.some((x) => x.name === d.name));
    $("#intake-doc-list").innerHTML = intakeDocs.map((d, i) => `<li><span>📄 ${escapeHtml(d.name)}</span>
        <span class="small muted">${(d.size / 1024 / 1024).toFixed(1)} MB</span>
        <button type="button" class="small" data-open-doc="${i}">Open</button>
        <button type="button" class="small" data-remove-doc="${i}">Remove</button></li>`).join("")
      + stored.map((d) => `<li><span>📄 ${escapeHtml(d.name)} <span class="tag">from vendor</span></span>
        <span class="small muted">${(d.size / 1024 / 1024).toFixed(1)} MB</span>
        <button type="button" class="small" data-open-stored="${escapeHtml(d.name)}">Open</button></li>`).join("")
      + (missing.length ? `<li class="small muted">Not loaded: ${escapeHtml(missing.map((d) => d.name).join(", "))} – documents aren't kept in the browser, so re-import the response file to use them again.</li>` : "");
    $("#btn-intake-fill").classList.toggle("hidden", !intakeDocs.length && !stored.length);
  }

  // Documents the vendor stored online, with their contents.
  const storedWithData = () => (serverDocs.length && editingId ? intakeServer.documents(editingId, { withData: true }) : Promise.resolve([]));

  $("#intake-doc-list").addEventListener("click", async (e) => {
    const stored = e.target.dataset.openStored;
    if (stored) {
      const d = (await storedWithData()).find((x) => x.name === stored);
      if (d) window.open(URL.createObjectURL(new Blob([Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0))], { type: d.mediaType })), "_blank", "noopener");
      return;
    }
    const open = e.target.dataset.openDoc, remove = e.target.dataset.removeDoc;
    if (open != null) {
      const d = intakeDocs[Number(open)];
      const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
      window.open(URL.createObjectURL(new Blob([bytes], { type: d.mediaType })), "_blank", "noopener");
    }
    if (remove != null) { intakeDocs.splice(Number(remove), 1); renderIntakeDocs(); }
  });

  $("#intake-docs").addEventListener("change", async (e) => {
    const errors = await addDocuments(intakeDocs, [...e.target.files]);
    e.target.value = "";
    if (errors.length) toast(errors[0], true);
    renderIntakeDocs();
  });

  $("#btn-intake-fill").addEventListener("click", async () => {
    const ctx = await getAI();
    if (!ctx) return toast("Add your Anthropic API key in Settings to fill from documents", true);
    const btn = $("#btn-intake-fill");
    const name = form.elements.name.value.trim();
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Reading documents… (1–3 min)`;
    try {
      const fromVendor = (await storedWithData()).filter((d) => !intakeDocs.some((x) => x.name === d.name));
      const docsForFill = [...intakeDocs, ...fromVendor].slice(0, 5);
      const result = await ctx.ai.fillFromDocuments(docsForFill, autofillPrompt(name, selectedModules()));
      const { filled, conflicts, unknown } = applyAiFill(result, name);
      renderIntake();
      toast(`Filled ${filled} answer(s) from the documents${conflicts ? `; ${conflicts} disagree with the vendor` : ""}${unknown ? `; ${unknown} not covered` : ""}. Review them, then click Save.`);
    } catch (err) {
      toast(`Fill from documents failed: ${ctx.describe(err)}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ Fill from documents";
    }
  });

  // Merges Claude's answers into the intake: fills unanswered questions, never
  // overwrites the vendor's own answers, and records where the documents disagree.
  function applyAiFill(result, name) {
    pendingIntake ||= {
      format: INTAKE_FORMAT, version: INTAKE_VERSION, vendorRef: editingId || "", vendorName: name,
      profile: { legalName: name }, answers: {}, attested: false, analystCreated: true, modules: selectedModules(),
    };
    let filled = 0, conflicts = 0, unknown = 0;
    for (const a of result.answers || []) {
      if (!INTAKE_QUESTIONS.some((q) => q.id === a.id)) continue;
      if (a.answer === "Unknown") { unknown++; continue; }
      const r = pendingIntake.answers[a.id];
      const ai = { answer: a.answer, comment: a.comment, evidence: a.evidence, document: a.document };
      if (r?.answer && !["ai", "analyst"].includes(r.source)) {
        if (r.answer !== a.answer) { r.aiSuggestion = ai; conflicts++; }
        else { delete r.aiSuggestion; if (!r.evidence) Object.assign(r, { evidence: a.evidence, document: a.document }); }
        continue;
      }
      pendingIntake.answers[a.id] = { ...ai, source: "ai" };
      filled++;
    }
    const p = pendingIntake.profile;
    const rp = result.profile || {};
    for (const f of ["certificationDetails", "hosting", "dataLocations", "subprocessors"]) if (rp[f] && !p[f]) p[f] = rp[f];
    p.certifications = [...new Set([...(p.certifications || []).filter((c) => c !== "None"), ...(rp.certifications || [])])];
    const docsMeta = [...intakeDocs, ...serverDocs].map((d) => ({ name: d.name, size: d.size, mediaType: d.mediaType }));
    pendingIntake.documents = [...(pendingIntake.documents || []).filter((d) => !docsMeta.some((x) => x.name === d.name)), ...docsMeta];
    pendingIntake.aiFill = { at: new Date().toISOString(), documents: docsMeta, summary: result.summary || "" };
    applyDerivedControls();
    return { filled, conflicts, unknown };
  }

  $("#btn-intake-link").addEventListener("click", async () => {
    const name = form.elements.name.value.trim();
    if (!name) return toast("Add a vendor name first", true);
    if (intakeServer && !editingId) return toast("Save the vendor first – the link opens their questionnaire in your workspace", true);
    if (intakeServer) saveEditor({ close: false });
    const link = await intakeLink(name);
    try {
      await navigator.clipboard.writeText(link);
      toast(createInvite ? "Intake link copied – the vendor can use it for 30 days, including AI help with their documents" : "Intake link copied – send it to the vendor");
    } catch {
      prompt("Copy this link and send it to the vendor:", link);
    }
  });

  $("#intake-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let data;
    try {
      data = validateIntake(JSON.parse(await file.text()));
    } catch (err) {
      return toast(`Import failed: ${err.message}`, true);
    }
    if (editingId && data.vendorRef && data.vendorRef !== editingId
      && !confirm(`This response was sent for ${data.vendorRef}${data.vendorName ? ` (${data.vendorName})` : ""}, not ${editingId}. Import it anyway?`)) return;

    mergeIncoming(data, Array.isArray(data.documents) ? data.documents : []);
    const unanswered = summarizeIntake(pendingIntake).counts.unanswered;
    const replied = Object.values(pendingIntake.followups).filter((t) => t.status === "open" && lastSpeaker(t) === "vendor").length;
    if (replied) return toast(`Response imported – the vendor replied to ${replied} follow-up(s). Review them, resolve or ask again, then Save.`);
    toast(intakeDocs.length && unanswered
      ? `Intake imported with ${intakeDocs.length} document(s). ${unanswered} question(s) are unanswered – click ✨ Fill from documents.`
      : "Intake imported. Click Save to keep it.");
  });

  // Merges a vendor's response (imported file or online submission) into the
  // profile: keeps our follow-up threads, Claude's answers the vendor didn't
  // replace and any earlier document fill, and updates the profile fields.
  function mergeIncoming(data, attached = []) {
    // Keep attached documents in memory only; save just their names.
    const incoming = attached.filter((d) => d && typeof d.name === "string" && typeof d.data === "string"
      && ["application/pdf", "text/plain", "text/markdown", "text/csv"].includes(d.mediaType));
    if (incoming.length) intakeDocs = incoming;
    const prev = pendingIntake;
    const docsMeta = attached.map((d) => ({ name: String(d?.name), size: d?.size, mediaType: d?.mediaType }));
    const kept = Object.fromEntries(Object.entries(prev?.answers || {})
      .filter(([id, r]) => ["ai", "analyst"].includes(r.source) && !data.answers[id]?.answer));
    pendingIntake = {
      ...data,
      answers: { ...kept, ...data.answers },
      followups: mergeFollowups(prev?.followups, data.followups, prev?.answers, data.answers),
      documents: [...(prev?.documents || []).filter((d) => !docsMeta.some((x) => x.name === d.name)), ...docsMeta],
      ...(prev?.aiFill ? { aiFill: prev.aiFill } : data.vendorAiFill ? { aiFill: { ...data.vendorAiFill, byVendor: true } } : {}),
      ...(prev?.serverSubmittedAt ? { serverSubmittedAt: prev.serverSubmittedAt } : {}),
    };
    if (data.modules.length && !form.elements.intakeModules.value) form.elements.intakeModules.value = data.modules[0];
    const f = form.elements;
    const p = data.profile;
    if (!f.name.value && p.legalName) f.name.value = p.legalName;
    if (!f.service.value && p.serviceDescription) f.service.value = p.serviceDescription.split(/[.\n]/)[0].slice(0, 120);
    if (!f.dataTypes.value && p.dataTypes?.length) f.dataTypes.value = p.dataTypes.join(", ");
    if (p.access) f.access.value = p.access;
    // Raise (never lower) data sensitivity based on the data types declared.
    const levels = ["None", "Internal", "Confidential", "Regulated (PII/PHI/PCI)"];
    const types = p.dataTypes || [];
    const declared = types.some((t) => /PII|PHI|card/i.test(t)) ? 3
      : types.some((t) => /Financial|Employee|Credentials|Confidential/i.test(t)) ? 2 : 0;
    if (declared > levels.indexOf(f.dataSensitivity.value)) f.dataSensitivity.value = levels[declared];
    applyDerivedControls();
    renderIntake();
  }

  // ---------- online responses (hosted mode) ----------
  // The vendor's response saved through their link, and documents they stored.
  let serverStatus = null, serverDocs = [];
  const responses = new Map(); // vendor id -> { status, submitted_at, updated_at }

  async function refreshResponses() {
    if (!intakeServer) return;
    try {
      responses.clear();
      for (const r of await intakeServer.list()) responses.set(r.vendor_ref, r);
      render();
    } catch { /* the list still works without statuses */ }
  }

  // A submission newer than the one already merged into the profile.
  const newSubmission = (v) => {
    const r = responses.get(v.id);
    return r?.submitted_at && r.submitted_at !== v.intake?.serverSubmittedAt;
  };

  async function syncOnline(vendor) {
    serverStatus = null;
    serverDocs = [];
    if (!intakeServer || !vendor) return;
    const id = vendor.id;
    try {
      const [row, docsList] = await Promise.all([intakeServer.get(id), intakeServer.documents(id)]);
      if (editingId !== id) return; // the analyst moved on
      serverStatus = row ? { status: row.status, updatedAt: row.updated_at, submittedAt: row.submitted_at } : null;
      serverDocs = docsList;
      if (row?.submitted_at && row.submitted_at !== pendingIntake?.serverSubmittedAt) {
        mergeIncoming(validateIntake(structuredClone(row.response)), docsList);
        pendingIntake.serverSubmittedAt = row.submitted_at;
        const replied = Object.values(pendingIntake.followups).filter((t) => t.status === "open" && lastSpeaker(t) === "vendor").length;
        toast(`The vendor submitted their questionnaire on ${row.submitted_at.slice(0, 10)}${replied ? ` and replied to ${replied} follow-up(s)` : ""}. It's been added to this profile – review it, then click Save.`);
      }
      renderIntake();
    } catch (err) {
      toast(`Couldn't load the vendor's online response: ${err.message}`, true);
    }
  }

  $("#btn-vendor-add").addEventListener("click", () => openEditor(null));
  dialog.addEventListener("close", refreshResponses);
  if (intakeServer) $("#intake-import").classList.add("hidden");
  refreshResponses();
  $("#btn-vendor-cancel").addEventListener("click", () => dialog.close());
  $("#btn-vendor-delete").addEventListener("click", () => {
    if (!confirm(`Delete vendor ${editingId}?`)) return;
    vendors = vendors.filter((v) => v.id !== editingId);
    dialog.close();
    save();
  });

  function saveEditor({ close = true } = {}) {
    const data = { ...readForm(), aiAssessment: pendingAssessment, intake: pendingIntake };
    if (editingId) {
      vendors = vendors.map((v) => (v.id === editingId ? { ...v, ...data, updated: new Date().toISOString() } : v));
    } else {
      editingId = nextId();
      vendors.push({ id: editingId, ...data, created: new Date().toISOString() });
    }
    if (close) dialog.close();
    save();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveEditor();
    toast("Vendor saved");
  });

  $("#btn-vendor-to-risk").addEventListener("click", () => {
    const v = { ...vendors.find((x) => x.id === editingId), ...readForm() };
    const res = residualTier(v);
    const impact = { Low: 2, Medium: 3, High: 4, Critical: 5 }[inherentTier(v)];
    const likelihood = { Low: 1, Medium: 2, High: 3, Critical: 4 }[res];
    const gaps = (pendingAssessment?.gaps || []).map((g) => `- ${g.gap}: ${g.remediation}`);
    const missing = QUESTIONS.filter((q) => ["No", "Partial"].includes(v.answers[q.id])).map((q) => `- Gap: ${q.text} (${v.answers[q.id]})`);
    const id = addRegisterRisk({
      title: `Third-party risk: ${v.name}`,
      description: `${v.name} provides ${v.service || "services"} with ${v.access || "unspecified"} access to ${v.dataSensitivity || "unspecified"} data. Residual vendor tier: ${res}.`,
      asset: v.service || v.name,
      category: "Third-Party/Supply Chain",
      likelihood, impact,
      residualLikelihood: Math.max(1, likelihood - 1), residualImpact: impact,
      owner: v.owner || "",
      status: "Open",
      treatment: "Mitigate",
      controls: [...(gaps.length ? gaps : missing)].join("\n"),
      due: nextReview(v) || "",
    });
    toast(`Added ${id} to the risk register`);
  });

  $("#btn-vendor-ai").addEventListener("click", async () => {
    const v = readForm();
    if (!v.name) return toast("Add a vendor name first", true);
    const panel = $("#vendor-ai-panel");
    const btn = $("#btn-vendor-ai");
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="spinner"></div> Reviewing vendor…`;
    btn.disabled = true;
    try {
      const ctx = await getAI();
      const result = ctx ? await ctx.ai.vendorReview(vendorPrompt(v)) : assessVendorOffline(v, QUESTIONS);
      pendingAssessment = { ...result, offline: !ctx, at: new Date().toISOString() };
      if (!form.elements.lastAssessed.value) form.elements.lastAssessed.value = new Date().toISOString().slice(0, 10);
      showAssessment(pendingAssessment);
      updateLiveScore();
    } catch (err) {
      const ctx = await getAI().catch(() => null);
      panel.innerHTML = `<p class="error-text">Vendor assessment failed: ${escapeHtml(ctx ? ctx.describe(err) : err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  });

  function vendorPrompt(v) {
    const answers = QUESTIONS.map((q) => `- [${q.domain}] ${q.text}: ${v.answers[q.id] || "Not answered"}`).join("\n");
    return `Perform a third-party (vendor) security risk assessment.

Vendor: ${v.name}
Service provided: ${v.service || "(unspecified)"}
Business criticality: ${v.criticality}
Data sensitivity: ${v.dataSensitivity}
Access to our environment: ${v.access}
Data types / scope: ${v.dataTypes || "(unspecified)"}
Calculated inherent tier: ${inherentTier(v)}; questionnaire control score: ${controlScore(v) ?? "not answered"}%; calculated residual tier: ${residualTier(v)}

Control summary (worked out from the intake questionnaire below):
${answers}

Analyst notes / evidence (e.g. SOC 2 summary, questionnaire excerpts):
${v.notes || "(none)"}
${intakeContext()}

Give the residual risk tier you judge appropriate, a recommendation, a 2-4 sentence summary, strengths, prioritised control gaps with remediation,
contract clauses we should require, and follow-up due-diligence questions to send the vendor. Treat unanswered questions as unknown, not as compliant.`;
  }

  // The vendor's self-assessment intake response, if one has been imported.
  function intakeContext() {
    if (!pendingIntake) return "\nVendor intake questionnaire: not yet received.";
    const p = pendingIntake.profile;
    const s = summarizeIntake(pendingIntake);
    const lines = activeQuestions(pendingIntake.answers, selectedModules()).map((q) => {
      const r = pendingIntake.answers[q.id];
      const tag = q.type === "inverse" ? " (Yes is a red flag)" : q.type === "info" ? " (context only)" : "";
      const src = r?.source === "ai" ? " [filled by Claude from the vendor's documents, not attested by the vendor]"
        : r?.source === "analyst" ? " [set by our analyst]"
        : r?.source === "vendor-ai" ? " [suggested by Claude from the vendor's documents, kept and attested by the vendor]" : "";
      const ev = r?.evidence ? ` – evidence from ${r.document || "documents"}: "${r.evidence}"` : "";
      const conflict = r?.aiSuggestion ? ` – NOTE: the vendor's documents suggest "${r.aiSuggestion.answer}" instead${r.aiSuggestion.evidence ? ` ("${r.aiSuggestion.evidence}")` : ""}` : "";
      const t = pendingIntake.followups?.[q.id];
      const thread = t ? `\n    Follow-up (${t.status}, ${followupRounds(t)} round(s)): ${t.messages.map((m) => `${m.by === "requester" ? "We asked" : m.by === "vendor" ? "Vendor replied" : "Note"}: ${m.text}`).join(" | ")}` : "";
      return `- ${q.id} [${q.domain}] ${q.text}${tag}: ${r?.answer || "Not answered"}${src}${r?.comment ? ` – comment: ${r.comment}` : ""}${ev}${conflict}${thread}`;
    }).join("\n");
    return `
${pendingIntake.analystCreated
    ? "Intake questionnaire completed by Claude from the vendor's documents (the vendor has not answered or attested it):"
    : `Vendor intake questionnaire (self-assessment completed by the vendor${pendingIntake.attested ? ", attested as accurate" : ", NOT attested"}):`}
Company: ${p.legalName}; HQ: ${p.country}; employees: ${p.employees || "?"}; ownership: ${[p.ownership, p.parentCompany].filter(Boolean).join(", ") || "?"}; founded: ${p.yearFounded || "?"}
Delivery: ${(p.delivery || []).join(", ") || "?"}; hosting model: ${(p.hostingModel || []).join(", ") || "?"}; software: ${(p.softwareTypes || []).join(", ") || "?"}
Hosting: ${p.hosting || "?"}; data locations: ${p.dataLocations || "?"}; DR/backup sites: ${p.drLocation || "?"}
In-scope applications: ${p.inScopeApps || "?"}
Outsourced IT services: ${p.outsourcedServices || "?"}
Completed by: ${p.contributors || "?"}; approved by: ${p.approver || "?"}
Service: ${p.serviceDescription || "?"}
Data types: ${(p.dataTypes || []).join(", ") || "?"}; record volume: ${p.recordVolume || "?"}; access requested: ${p.access || "?"}
Certifications: ${(p.certifications || []).join(", ") || "none"}${p.certificationDetails ? ` (${p.certificationDetails})` : ""}
Subprocessors: ${p.subprocessors || "none listed"}
Intake score: ${s.score ?? "n/a"}% of scored answers favourable.
${lines}
${pendingIntake.aiFill ? `Documents reviewed: ${pendingIntake.aiFill.documents.map((d) => d.name).join(", ")}. Document summary: ${pendingIntake.aiFill.summary}\n` : ""}Remember vendor answers are self-attested; weigh them against independent evidence such as audit reports.
Check the profile and answers against each other (e.g. "no outsourcing" but subcontractors host the data; data locations that differ between answers).
A follow-up reply that doesn't answer what we asked, or repeats boilerplate, doesn't support the control: treat it as a gap and suggest a sharper follow-up question.`;
  }

  function showAssessment(a) {
    const panel = $("#vendor-ai-panel");
    panel.classList.remove("hidden");
    const list = (items) => `<ul>${items.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
    panel.innerHTML = `
      <div class="ai-head"><strong>${a.offline ? "Offline heuristic review" : "✨ Claude vendor review"}</strong>
        <span class="badge ${tierClass(a.risk_tier)}">${escapeHtml(a.risk_tier)} risk</span>
        <span class="tag">${escapeHtml(a.recommendation)}</span>
        ${a.at ? `<span class="muted small">${escapeHtml(a.at.slice(0, 10))}</span>` : ""}
      </div>
      <p>${escapeHtml(a.summary)}</p>
      ${a.strengths.length ? `<h4>Strengths</h4>${list(a.strengths)}` : ""}
      ${a.gaps.length ? `<h4>Gaps</h4><ul>${a.gaps.map((g) => `<li><span class="tag p-${escapeHtml(g.severity).toLowerCase()}">${escapeHtml(g.severity)}</span> <strong>${escapeHtml(g.gap)}</strong> – ${escapeHtml(g.remediation)}</li>`).join("")}</ul>` : ""}
      ${a.contract_clauses.length ? `<h4>Contract clauses to require</h4>${list(a.contract_clauses)}` : ""}
      ${a.follow_up_questions.length ? `<h4>Follow-up questions for the vendor</h4>${list(a.follow_up_questions)}` : ""}
      ${a.offline ? `<p class="muted small">Add an Anthropic API key in Settings for a full Claude-powered review that also reads your notes and evidence.</p>` : ""}
      <p class="muted small">The review is saved with the vendor when you click Save.</p>`;
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------- import / export ----------
  $("#btn-vendor-export").addEventListener("click", () => {
    const cols = ["id", "name", "service", "owner", "criticality", "dataSensitivity", "access", "status", "lastAssessed"];
    const cell = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const csv = [[...cols, "inherentTier", "controlScore", "residualTier", "nextReview"].join(","),
      ...vendors.map((v) => [...cols.map((c) => v[c]), inherentTier(v), controlScore(v) ?? "", residualTier(v), nextReview(v) ?? ""].map(cell).join(","))].join("\n");
    download("vendors.csv", csv, "text/csv");
  });

  return {
    render,
    all: () => vendors,
    addMany(list) {
      for (const v of list) vendors.push({ ...v, id: nextId(), created: new Date().toISOString() });
      save();
    },
    replaceAll(list) { vendors = list; save(); },
    // Replaces the list with data just loaded from storage, without saving it back.
    reload(list) { vendors = list; render(); onChange(); },
    summary: () => vendors.map((v) => ({
      id: v.id, name: v.name, service: v.service, criticality: v.criticality, dataSensitivity: v.dataSensitivity,
      access: v.access, status: v.status, inherentTier: inherentTier(v), controlScore: controlScore(v),
      residualTier: residualTier(v), nextReview: nextReview(v), overdue: isOverdue(v),
      gaps: QUESTIONS.filter((q) => v.answers?.[q.id] === "No").map((q) => q.text),
      aiRecommendation: v.aiAssessment?.recommendation,
      intakeScore: v.intake ? summarizeIntake(v.intake).score : null,
      openFollowups: openFollowups(v.intake),
    })),
  };
}
