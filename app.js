// Posture.ai – AI cyber risk manager. Plain ES modules, no build step.
import { assessOffline } from "./heuristics.js";
import { initVendors, residualTier, isOverdue } from "./vendors.js";
import { reportPrompt, renderReport, reportMarkdown } from "./report.js";
import { LocalStore, CloudStore, sanitizeRecord, ID_PATTERN } from "./store.js";
import { CloudAI, LocalAI, describeError } from "./ai.js";
import { SUPABASE_URL } from "./config.js";

const SETTINGS_KEY = "riskpilot.settings";
const API_KEY_KEY = "riskpilot.apiKey";

// Clickjacking defence for hosts that can't send a frame-ancestors header.
if (window.top !== window.self) {
  document.documentElement.innerHTML = "";
  throw new Error("Posture.ai cannot be embedded in another site.");
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- storage ----------
function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}
function safeSet(storage, key, value) {
  try { value == null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* storage unavailable */ }
}

let risks = [];
let store;          // LocalStore (demo) or CloudStore (signed in)
let cloud = null;   // { client, user, org, url, anonKey } when signed in
let cloudAI = null;
let workspaceApi = null;
let vendorsApi;
let settings = { model: "claude-opus-5-5", effort: "medium", remember: false, orgName: "",
  ...JSON.parse(safeGet(localStorage, SETTINGS_KEY) || "{}") };
let apiKey = safeGet(localStorage, API_KEY_KEY) || safeGet(sessionStorage, API_KEY_KEY) || "";

function saveRisks() {
  store.save("risks", risks);
  render();
}

const canEdit = () => !cloud || ["analyst", "admin", "owner"].includes(cloud.org.role);
const orgName = () => (cloud ? cloud.org.name : settings.orgName);

// ---------- scoring ----------
const score = (l, i) => Number(l) * Number(i);
function rating(s) {
  if (s >= 20) return { label: "Critical", cls: "critical" };
  if (s >= 12) return { label: "High", cls: "high" };
  if (s >= 6) return { label: "Medium", cls: "medium" };
  return { label: "Low", cls: "low" };
}
const inherent = (r) => score(r.likelihood, r.impact);
const residual = (r) => score(r.residualLikelihood || r.likelihood, r.residualImpact || r.impact);

function nextId() {
  const max = risks.reduce((m, r) => Math.max(m, Number(String(r.id).replace(/\D/g, "")) || 0), 0);
  return `R-${String(max + 1).padStart(3, "0")}`;
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Minimal, safe Markdown renderer (input is escaped first).
function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "", inList = null;
  const inline = (t) => t
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      const lvl = Math.min(m[1].length + 1, 4);
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) {
      if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- AI ----------
async function getAI() {
  if (cloud) return { ai: cloudAI, describe: describeError };
  if (!apiKey) return null;
  return { ai: new LocalAI({ apiKey, model: settings.model, effort: settings.effort }), describe: describeError };
}

// Refreshes the usage meter after an AI call in cloud mode.
const afterAI = () => workspaceApi?.refreshUsage();

function registerSummary() {
  return JSON.stringify({ risks: riskSummary(), vendors: vendorsApi.summary() }, null, 1);
}

function riskSummary() {
  return risks.map((r) => ({
    id: r.id, title: r.title, description: r.description, asset: r.asset, category: r.category,
    likelihood: Number(r.likelihood), impact: Number(r.impact), inherent: inherent(r),
    residualLikelihood: Number(r.residualLikelihood || r.likelihood), residualImpact: Number(r.residualImpact || r.impact),
    residual: residual(r), owner: r.owner, status: r.status, treatment: r.treatment,
    controls: r.controls, due: r.due,
  }));
}

function updateAiStatus() {
  const el = $("#ai-status");
  if (cloud) {
    el.textContent = "AI: on";
    el.className = "pill ok";
    el.title = "Claude runs on the Posture.ai server";
    return;
  }
  el.textContent = apiKey ? `AI: ${settings.model}` : "AI: offline mode";
  el.className = `pill ${apiKey ? "ok" : "warn"}`;
  el.title = apiKey ? "Claude is connected" : "Add an API key in Settings for Claude-powered analysis";
}

// ---------- rendering ----------
let sortKey = "score", sortDir = -1, cellFilter = null;

function render() {
  renderDashboard();
  vendorsApi.render();
  renderTable();
  updateAiStatus();
}

function renderDashboard() {
  const active = risks.filter((r) => r.status !== "Closed");
  const crit = active.filter((r) => inherent(r) >= 20).length;
  const high = active.filter((r) => inherent(r) >= 12 && inherent(r) < 20).length;
  const avgIn = active.length ? (active.reduce((s, r) => s + inherent(r), 0) / active.length).toFixed(1) : "–";
  const avgRes = active.length ? (active.reduce((s, r) => s + residual(r), 0) / active.length).toFixed(1) : "–";
  const liveVendors = vendorsApi.all().filter((v) => v.status !== "Offboarded");
  const vendorsDue = liveVendors.filter(isOverdue).length;
  const overdue = active.filter((r) => r.due && new Date(r.due) < new Date(new Date().toDateString())).length;
  $("#kpis").innerHTML = [
    ["Active risks", active.length, ""],
    ["Critical", crit, "critical"],
    ["High", high, "high"],
    ["Avg inherent score", avgIn, ""],
    ["Avg residual score", avgRes, ""],
    ["Overdue actions", overdue, overdue ? "high" : ""],
    ["High-risk vendors", liveVendors.filter((v) => ["High", "Critical"].includes(residualTier(v))).length, ""],
    ["Vendor reviews due", vendorsDue, vendorsDue ? "high" : ""],
  ].map(([k, v, c]) => `<div class="kpi ${c}"><div class="kpi-val">${v}</div><div class="kpi-label">${k}</div></div>`).join("");

  // Heat map: rows likelihood 5..1, columns impact 1..5
  let cells = "";
  for (let l = 5; l >= 1; l--) {
    for (let i = 1; i <= 5; i++) {
      const n = active.filter((r) => Number(r.likelihood) === l && Number(r.impact) === i).length;
      cells += `<button class="cell ${rating(l * i).cls}" data-l="${l}" data-i="${i}" title="Likelihood ${l} × Impact ${i}">${n || ""}</button>`;
    }
  }
  $("#heatmap").innerHTML = cells;

  const top = [...active].sort((a, b) => inherent(b) - inherent(a)).slice(0, 5);
  $("#top-risks").innerHTML = top.length
    ? top.map((r) => `<li><a href="#" data-edit="${escapeHtml(r.id)}">${escapeHtml(r.id)} · ${escapeHtml(r.title)}</a>
        <span class="badge ${rating(inherent(r)).cls}">${inherent(r)}</span></li>`).join("")
    : `<li class="muted">No active risks yet.</li>`;

  const tiers = ["Critical", "High", "Medium", "Low"];
  const tierCounts = tiers.map((t) => liveVendors.filter((v) => residualTier(v) === t).length);
  const maxTier = Math.max(1, ...tierCounts);
  $("#vendor-tiers").innerHTML = liveVendors.length
    ? tiers.map((t, k) => `<div class="bar-row"><span>${t}</span><div class="bar"><div class="${t.toLowerCase()}" style="width:${(tierCounts[k] / maxTier) * 100}%"></div></div><span>${tierCounts[k]}</span></div>`).join("")
    : `<p class="muted">No vendors yet.</p>`;

  const byCat = {};
  active.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + 1; });
  const maxCat = Math.max(1, ...Object.values(byCat));
  $("#by-category").innerHTML = Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<div class="bar-row"><span>${escapeHtml(c)}</span><div class="bar"><div style="width:${(n / maxCat) * 100}%"></div></div><span>${n}</span></div>`)
    .join("") || `<p class="muted">–</p>`;
}

function renderTable() {
  const q = $("#search").value.toLowerCase();
  const st = $("#filter-status").value;
  const rows = risks
    .filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q))
    .filter((r) => !st || r.status === st)
    .filter((r) => !cellFilter || (Number(r.likelihood) === cellFilter.l && Number(r.impact) === cellFilter.i))
    .sort((a, b) => {
      const val = (r) => sortKey === "score" ? inherent(r) : sortKey === "residual" ? residual(r) : String(r[sortKey] ?? "");
      const [x, y] = [val(a), val(b)];
      return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
    });

  $("#risk-table tbody").innerHTML = rows.map((r) => {
    const ri = rating(inherent(r)), rr = rating(residual(r));
    return `<tr>
      <td>${escapeHtml(r.id)}</td>
      <td><strong>${escapeHtml(r.title)}</strong><div class="muted small">${escapeHtml(r.asset)}</div></td>
      <td>${escapeHtml(r.category)}</td>
      <td>${escapeHtml(r.owner)}</td>
      <td><span class="badge ${ri.cls}">${inherent(r)} ${ri.label}</span></td>
      <td><span class="badge ${rr.cls}">${residual(r)} ${rr.label}</span></td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.due)}</td>
      <td><button class="small" data-edit="${escapeHtml(r.id)}">Edit</button></td>
    </tr>`;
  }).join("");
  $("#empty-register").classList.toggle("hidden", rows.length > 0);

  const pill = $("#cell-filter");
  pill.classList.toggle("hidden", !cellFilter);
  if (cellFilter) pill.innerHTML = `L${cellFilter.l} × I${cellFilter.i} <button class="link" id="clear-cell">✕</button>`;
}

// ---------- navigation ----------
function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}
$$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

// ---------- register events ----------
$("#search").addEventListener("input", renderTable);
$("#filter-status").addEventListener("change", renderTable);
$$("#risk-table th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
  sortKey = th.dataset.sort;
  renderTable();
}));
$("#heatmap").addEventListener("click", (e) => {
  const c = e.target.closest(".cell");
  if (!c) return;
  cellFilter = { l: Number(c.dataset.l), i: Number(c.dataset.i) };
  showView("register");
  renderTable();
});
$("#cell-filter").addEventListener("click", (e) => {
  if (e.target.id === "clear-cell") { cellFilter = null; renderTable(); }
});
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-edit]");
  if (btn) { e.preventDefault(); openEditor(risks.find((r) => r.id === btn.dataset.edit)); }
});

// ---------- editor ----------
const dialog = $("#risk-dialog");
const form = $("#risk-form");
let editingId = null;

function openEditor(risk) {
  editingId = risk?.id ?? null;
  form.reset();
  $("#ai-panel").classList.add("hidden");
  $("#dialog-title").textContent = risk ? `Edit ${risk.id}` : "New risk";
  $("#btn-delete").classList.toggle("hidden", !risk);
  if (risk) for (const [k, v] of Object.entries(risk)) if (form.elements[k]) form.elements[k].value = v ?? "";
  dialog.showModal();
}

$("#btn-add").addEventListener("click", () => openEditor(null));
$("#btn-cancel").addEventListener("click", () => dialog.close());
$("#btn-delete").addEventListener("click", () => {
  if (!confirm(`Delete ${editingId}?`)) return;
  risks = risks.filter((r) => r.id !== editingId);
  dialog.close();
  saveRisks();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!canEdit()) return;
  const data = Object.fromEntries(new FormData(form));
  for (const k of ["likelihood", "impact", "residualLikelihood", "residualImpact"]) {
    data[k] = Math.min(5, Math.max(1, Number(data[k]) || 1));
  }
  if (editingId) {
    risks = risks.map((r) => (r.id === editingId ? { ...r, ...data, updated: new Date().toISOString() } : r));
  } else {
    risks.push({ id: nextId(), ...data, created: new Date().toISOString() });
  }
  dialog.close();
  saveRisks();
  toast("Risk saved");
});

$("#btn-ai-assess").addEventListener("click", async () => {
  const data = Object.fromEntries(new FormData(form));
  if (!data.title && !data.description) return toast("Add a title or description first", true);
  const panel = $("#ai-panel");
  const btn = $("#btn-ai-assess");
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="spinner"></div> Analysing risk…`;
  btn.disabled = true;
  try {
    const ctx = await getAI();
    const result = ctx ? await ctx.ai.assessRisk(data) : assessOffline(data);
    showAssessment(result, !ctx);
    if (ctx) afterAI();
  } catch (err) {
    const msg = describeError(err);
    panel.innerHTML = `<p class="error-text">AI assessment failed: ${escapeHtml(msg)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

function showAssessment(a, offline) {
  const panel = $("#ai-panel");
  panel.innerHTML = `
    <div class="ai-head"><strong>${offline ? "Offline heuristic assessment" : "✨ Claude assessment"}</strong>
      <span class="badge ${rating(a.likelihood * a.impact).cls}">Inherent ${a.likelihood}×${a.impact} = ${a.likelihood * a.impact}</span>
      <span class="badge ${rating(a.residual_likelihood * a.residual_impact).cls}">Residual ${a.residual_likelihood * a.residual_impact}</span>
    </div>
    <p>${escapeHtml(a.rationale)}</p>
    ${a.threat_scenarios?.length ? `<h4>Threat scenarios</h4><ul>${a.threat_scenarios.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
    <h4>Recommended controls</h4>
    <ul>${a.recommended_controls.map((c) => `<li><span class="tag">${escapeHtml(c.csf_function)}</span> <span class="tag p-${escapeHtml(c.priority).toLowerCase()}">${escapeHtml(c.priority)}</span> ${escapeHtml(c.control)}</li>`).join("")}</ul>
    ${offline ? `<p class="muted small">Add an Anthropic API key in Settings for a full Claude-powered assessment.</p>` : ""}
    <button type="button" id="btn-apply-ai" class="primary small">Apply to form</button>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("#btn-apply-ai").addEventListener("click", () => {
    const f = form.elements;
    f.category.value = a.category;
    f.likelihood.value = a.likelihood;
    f.impact.value = a.impact;
    f.residualLikelihood.value = a.residual_likelihood;
    f.residualImpact.value = a.residual_impact;
    f.treatment.value = a.treatment;
    const recs = a.recommended_controls.map((c) => `- [${c.csf_function}/${c.priority}] ${c.control}`).join("\n");
    f.controls.value = [f.controls.value.trim(), recs].filter(Boolean).join("\n");
    toast("Assessment applied – review and save");
  });
}

// ---------- AI analyst ----------
let lastReport = null;

// Shows a briefing: a new one built from the register now, or the saved one.
function showReport(report) {
  lastReport = report;
  $("#report").innerHTML = renderReport(report);
  const when = new Date(report.generatedAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  $("#report-meta").textContent = `Generated ${when}${report.generatedBy ? ` by ${report.generatedBy}` : ""}. Stays here until the next briefing is generated.`;
  $("#report-meta").classList.remove("hidden");
  $("#btn-print-report").classList.remove("hidden");
  $("#btn-copy-report").classList.remove("hidden");
}

// Builds a briefing from the current register, shows it, and saves it as the latest.
async function publishReport(ai) {
  const report = { risks: riskSummary(), vendors: vendorsApi.summary(), ai, generatedAt: new Date().toISOString(),
    generatedBy: cloud?.user?.email || null, title: orgName() || "Posture.ai" };
  showReport(report);
  if (!canEdit()) return toast("Viewers can generate briefings, but only analysts and above can replace the saved one.");
  try {
    await store.saveBriefing(report);
  } catch (err) {
    toast(`Couldn't save the briefing: ${err.message}`, true);
  }
}

$("#btn-report").addEventListener("click", async () => {
  const out = $("#report");
  if (!risks.length) return toast("Your register is empty", true);
  const ctx = await getAI();
  if (!ctx) {
    await publishReport(null);
    toast("Showing the data-only briefing. Add an API key in Settings for Claude's analysis.");
    return;
  }
  const btn = $("#btn-report");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Writing briefing…`;
  out.innerHTML = `<div class="rh-loading"><div class="spinner"></div><p>Claude is analysing ${risks.length} risks and ${vendorsApi.all().length} vendors. This usually takes under a minute.</p></div>`;
  try {
    await publishReport(await ctx.ai.briefing(reportPrompt(registerSummary())));
    afterAI();
  } catch (err) {
    out.innerHTML = `<p class="error-text">Briefing failed: ${escapeHtml(ctx.describe(err))}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate briefing";
  }
});

$("#btn-copy-report").addEventListener("click", () => {
  if (lastReport) navigator.clipboard.writeText(reportMarkdown(lastReport)).then(() => toast("Briefing copied as text"));
});
$("#btn-print-report").addEventListener("click", () => {
  document.body.classList.add("printing-report");
  window.print();
});
window.addEventListener("afterprint", () => document.body.classList.remove("printing-report"));

// Hover tooltips for anything with a data-tip attribute (charts, chips).
const tooltip = $("#tooltip");
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) { tooltip.classList.add("hidden"); return; }
  tooltip.textContent = el.dataset.tip;
  tooltip.classList.remove("hidden");
});
document.addEventListener("mousemove", (e) => {
  if (tooltip.classList.contains("hidden")) return;
  const x = Math.min(e.clientX + 14, innerWidth - tooltip.offsetWidth - 8);
  const y = e.clientY + 18 + tooltip.offsetHeight > innerHeight ? e.clientY - tooltip.offsetHeight - 10 : e.clientY + 18;
  tooltip.style.transform = `translate(${x}px, ${y}px)`;
});

document.addEventListener("click", (e) => {
  if (e.target.id === "go-settings") { e.preventDefault(); showView("settings"); }
});

const chatHistory = [];
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const log = $("#chat-log");
  log.insertAdjacentHTML("beforeend", `<div class="msg user">${escapeHtml(q)}</div>`);
  const bubble = document.createElement("div");
  bubble.className = "msg assistant markdown";
  log.append(bubble);

  const ctx = await getAI();
  if (!ctx) {
    bubble.innerHTML = `Add your Anthropic API key in <a href="#" id="go-settings">Settings</a> to chat with the AI analyst.`;
    return;
  }
  chatHistory.push({ role: "user", content: q });
  bubble.innerHTML = `<div class="spinner"></div>`;
  let text = "";
  try {
    text = await ctx.ai.chat(chatHistory, registerSummary(), (d) => {
      text += d;
      bubble.innerHTML = renderMarkdown(text);
      log.scrollTop = log.scrollHeight;
    });
    bubble.innerHTML = renderMarkdown(text);
    chatHistory.push({ role: "assistant", content: text });
    afterAI();
  } catch (err) {
    chatHistory.pop();
    bubble.innerHTML = `<span class="error-text">${escapeHtml(ctx.describe(err))}</span>`;
  }
  log.scrollTop = log.scrollHeight;
});

// ---------- settings ----------
function loadSettingsForm() {
  $("#api-key").value = apiKey;
  $("#remember-key").checked = settings.remember;
  $("#model").value = settings.model;
  $("#effort").value = settings.effort;
  $("#org-name").value = settings.orgName;
}
$("#btn-save-settings").addEventListener("click", () => {
  apiKey = $("#api-key").value.trim();
  settings = { model: $("#model").value, effort: $("#effort").value, remember: $("#remember-key").checked, orgName: $("#org-name").value.trim() };
  safeSet(localStorage, SETTINGS_KEY, JSON.stringify(settings));
  safeSet(localStorage, API_KEY_KEY, settings.remember && apiKey ? apiKey : null);
  safeSet(sessionStorage, API_KEY_KEY, apiKey || null);
  updateAiStatus();
  $("#settings-saved").classList.remove("hidden");
  setTimeout(() => $("#settings-saved").classList.add("hidden"), 2000);
});

$("#btn-sample").addEventListener("click", async () => {
  if (!canEdit()) return;
  if ((risks.length || vendorsApi.all().length) && !confirm("Add sample risks and vendors to your existing data?")) return;
  const { SAMPLE_RISKS, SAMPLE_VENDORS } = await import("./sample-data.js");
  for (const r of SAMPLE_RISKS) risks.push({ ...r, id: nextId(), created: new Date().toISOString() });
  vendorsApi.addMany(SAMPLE_VENDORS);
  saveRisks();
  toast(`Loaded ${SAMPLE_RISKS.length} sample risks and ${SAMPLE_VENDORS.length} vendors`);
  showView("dashboard");
});
$("#btn-clear").addEventListener("click", () => {
  if (cloud && cloud.org.role !== "owner") return;
  const where = cloud ? `the ${cloud.org.name} workspace` : "this browser";
  if (!confirm(`Delete ALL risks and vendors in ${where}? Export JSON first if you need a backup.`)) return;
  if (cloud && prompt(`Type the workspace name (${cloud.org.name}) to confirm`) !== cloud.org.name) return;
  risks = [];
  vendorsApi.replaceAll([]);
  saveRisks();
});

// ---------- import / export ----------
const CSV_COLS = ["id", "title", "description", "asset", "category", "likelihood", "impact",
  "residualLikelihood", "residualImpact", "owner", "status", "treatment", "controls", "due"];
$("#btn-export-csv").addEventListener("click", () => {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [CSV_COLS.join(","), ...risks.map((r) => CSV_COLS.map((c) => cell(r[c])).join(","))].join("\n");
  download("risk-register.csv", csv, "text/csv");
});
$("#btn-export-json").addEventListener("click", () => {
  download("posture-ai-backup.json", JSON.stringify({ risks, vendors: vendorsApi.all() }, null, 2), "application/json");
});
$("#import-json").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !canEdit()) return;
  if (file.size > 25 * 1024 * 1024) { e.target.value = ""; return toast("That file is too large to import", true); }
  try {
    const parsed = JSON.parse(await file.text());
    // Accepts a plain array of risks (older exports) or a { risks, vendors } backup.
    const data = Array.isArray(parsed) ? parsed : parsed.risks;
    if (!Array.isArray(data)) throw new Error("Expected an array of risks or a Posture.ai backup");
    if (data.length > 5000) throw new Error("Too many records in one file");
    // Only known fields are kept and strings are length-capped (see store.js).
    const newVendors = Array.isArray(parsed.vendors) ? parsed.vendors.filter((v) => typeof v?.name === "string").map((v) => sanitizeRecord("vendors", v)) : [];
    if (newVendors.length) vendorsApi.addMany(newVendors);
    for (const raw of data) {
      if (typeof raw?.title !== "string") continue;
      const r = sanitizeRecord("risks", raw);
      const id = ID_PATTERN.risks.test(r.id) && !risks.some((x) => x.id === r.id) ? r.id : nextId();
      risks.push({ ...r, id });
    }
    saveRisks();
    toast(`Imported ${data.length} risks${newVendors.length ? ` and ${newVendors.length} vendors` : ""}`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, true);
  }
  e.target.value = "";
});

// ---------- vendors ----------
function addRegisterRisk(risk) {
  const id = nextId();
  risks.push({ ...risk, id, created: new Date().toISOString() });
  saveRisks();
  return id;
}

// ---------- start-up ----------
function applyRoleUI() {
  document.body.classList.toggle("read-only", !canEdit());
  document.body.classList.toggle("not-owner", !!cloud && cloud.org.role !== "owner");
  document.body.classList.toggle("cloud", !!cloud);
}

async function loadData() {
  const data = await store.load();
  risks = data.risks;
  return data;
}

async function boot() {
  const data = await loadData();
  vendorsApi = initVendors({
    $, $$, escapeHtml, toast, download, getAI, addRegisterRisk,
    initial: data.vendors,
    persist: (list) => store.save("vendors", list),
    getOrgName: orgName,
    onChange: renderDashboard,
    // Hosted mode: an invite token lets the vendor's form use Claude on their documents.
    // Hosted mode: vendors' questionnaires saved online through their links.
    intakeServer: store.cloud ? {
      list: () => store.listIntakeResponses(),
      get: (ref) => store.getIntakeResponse(ref),
      documents: (ref, opts) => store.getIntakeDocuments(ref, opts),
    } : null,
    createInvite: cloud ? async (vendorRef) => {
      const { data: token, error } = await cloud.client.rpc("create_intake_invite", { org: cloud.org.id, vendor: vendorRef || "" });
      if (error) throw error;
      return token;
    } : null,
  });
  applyRoleUI();
  loadSettingsForm();
  render();
  store.loadBriefing().then((saved) => { if (saved) showReport(saved); })
    .catch((err) => toast(`Couldn't load the saved briefing: ${err.message}`, true));
}

// When a save is rejected (e.g. a role change or a concurrent edit), reload the server's data.
async function onSaveError(err) {
  toast(`Couldn't save your change: ${err.message}. Reloading the latest data.`, true);
  const data = await loadData();
  vendorsApi.reload(data.vendors);
  render();
}

if (SUPABASE_URL) {
  const { startAuth, signOut, switchWorkspace } = await import("./auth.js");
  $("#local-settings").classList.add("hidden");
  $("#data-note").textContent = "Data is stored in your organisation's workspace, protected by role-based access, and every change is recorded in the audit log.";
  startAuth(async (ctx) => {
    cloud = ctx;
    store = new CloudStore({ client: ctx.client, orgId: ctx.org.id, onError: onSaveError });
    cloudAI = new CloudAI({ client: ctx.client, url: ctx.url, anonKey: ctx.anonKey, orgId: ctx.org.id });
    $("#user-menu").classList.remove("hidden");
    $("#ws-label").textContent = `${ctx.org.name} · ${ctx.org.role}`;
    $("#btn-signout").addEventListener("click", () => signOut());
    $("#btn-switch-ws").addEventListener("click", switchWorkspace);
    await boot();
    const { initWorkspace } = await import("./workspace.js");
    workspaceApi = initWorkspace({
      $, escapeHtml, toast, download, ctx, signOut,
      onRenamed: (name) => { $("#ws-label").textContent = `${name} · ${ctx.org.role}`; },
    });
  });
} else {
  store = new LocalStore({ safeGet, safeSet });
  await boot();
}
