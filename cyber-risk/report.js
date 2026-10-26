// Executive briefing: Claude writes the narrative as structured data (schema in
// ai-tasks.js); every number and chart is computed here from the register itself.


export function reportPrompt(registerJson) {
  return `Here is our current cyber risk register and third-party vendor inventory as JSON:

${registerJson}

Prepare the narrative for a board-level cyber risk briefing:
- posture: overall cyber risk posture.
- headline: one sentence (max 25 words) a director should remember.
- summary: 3-4 sentences on overall posture and direction.
- top_risks: the 3-5 risks needing board attention (by id), each with why it matters in business terms and the recommended action (1-2 sentences each).
- themes: 2-4 systemic weaknesses or patterns across the register, each with a short title and 1-2 sentence detail.
- vendor_commentary: 2-3 sentences on third-party risk; vendors_of_concern: up to 3 vendors (by id) and the concern.
- roadmap: 5-8 concrete actions for the next 90 days, spread across the three phases, each with an owner role and related risk/vendor ids.
- score_challenges: up to 4 risks whose inherent score (likelihood x impact) looks too high or too low, with the score you'd suggest and why. Use an empty list if none.
Write for non-technical directors: plain language, no jargon, refer to items by id.`;
}

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sevClass = (s) => (s >= 20 ? "critical" : s >= 12 ? "high" : s >= 6 ? "medium" : "low");
const sevLabel = (s) => ({ critical: "Critical", high: "High", medium: "Medium", low: "Low" }[sevClass(s)]);
const tierClass = (t) => String(t || "").toLowerCase();
const POSTURE = {
  Low: { cls: "low", icon: "✓", level: 1 },
  Guarded: { cls: "low", icon: "✓", level: 2 },
  Elevated: { cls: "medium", icon: "!", level: 3 },
  High: { cls: "high", icon: "!", level: 4 },
  Severe: { cls: "critical", icon: "‼", level: 5 },
};

// Posture estimated from the data alone, used when there is no AI narrative.
function dataPosture(active) {
  const crit = active.filter((r) => r.inherent >= 20).length;
  const high = active.filter((r) => r.inherent >= 12).length;
  return crit >= 2 ? "High" : crit || high >= 3 ? "Elevated" : high ? "Guarded" : "Low";
}

function metrics({ risks, vendors }) {
  const active = risks.filter((r) => r.status !== "Closed");
  const avg = (k) => (active.length ? active.reduce((s, r) => s + r[k], 0) / active.length : 0);
  const today = new Date(new Date().toDateString());
  const liveVendors = vendors.filter((v) => v.status !== "Offboarded");
  return {
    active,
    critical: active.filter((r) => r.inherent >= 20).length,
    high: active.filter((r) => r.inherent >= 12 && r.inherent < 20).length,
    avgInherent: avg("inherent"),
    avgResidual: avg("residual"),
    overdue: active.filter((r) => r.due && new Date(r.due) < today).length,
    liveVendors,
    riskyVendors: liveVendors.filter((v) => ["High", "Critical"].includes(v.residualTier)).length,
    vendorsDue: liveVendors.filter((v) => v.overdue).length,
  };
}

// ---------- charts ----------
function heatmap(active, lKey, iKey, title) {
  let cells = "";
  for (let l = 5; l >= 1; l--) {
    for (let i = 1; i <= 5; i++) {
      const hits = active.filter((r) => r[lKey] === l && r[iKey] === i);
      const tip = `Likelihood ${l} × Impact ${i} = ${l * i}${hits.length ? `: ${hits.map((r) => r.id).join(", ")}` : ""}`;
      cells += `<div class="rh-cell ${sevClass(l * i)}${hits.length ? " has" : ""}" data-tip="${esc(tip)}">${hits.length || ""}</div>`;
    }
  }
  return `<figure class="rh-heat"><figcaption>${title}</figcaption>
    <div class="rh-heat-grid"><span class="rh-axis-y">Likelihood</span><div class="rh-cells">${cells}</div><span class="rh-axis-x">Impact</span></div></figure>`;
}

// Inherent -> residual score per risk on one 0-25 axis.
function dumbbell(active) {
  const rows = [...active].sort((a, b) => b.inherent - a.inherent).slice(0, 7);
  if (!rows.length) return "";
  const pct = (v) => `${(v / 25) * 100}%`;
  const body = rows.map((r) => {
    const lo = Math.min(r.inherent, r.residual), hi = Math.max(r.inherent, r.residual);
    const drop = r.inherent ? Math.round((1 - r.residual / r.inherent) * 100) : 0;
    const tip = `${r.id} ${r.title}: inherent ${r.inherent} → residual ${r.residual} (${drop}% reduction)`;
    return `<div class="db-row" data-tip="${esc(tip)}">
      <span class="db-label"><b>${esc(r.id)}</b> ${esc(r.title)}</span>
      <span class="db-track">
        <span class="db-link" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})"></span>
        <span class="db-dot residual" style="left:${pct(r.residual)}"><i>${r.residual}</i></span>
        <span class="db-dot inherent" style="left:${pct(r.inherent)}"><i>${r.inherent}</i></span>
      </span>
    </div>`;
  }).join("");
  return `<figure class="rh-dumbbell">
    <figcaption>Risk reduction from planned controls
      <span class="db-legend"><span class="db-key inherent"></span>Inherent <span class="db-key residual"></span>Residual</span></figcaption>
    ${body}
    <div class="db-axis"><span>0</span><span>5</span><span>10</span><span>15</span><span>20</span><span>25</span></div>
  </figure>`;
}

function categoryBars(active) {
  const counts = {};
  active.forEach((r) => { counts[r.category] = (counts[r.category] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return `<figure class="rh-bars"><figcaption>Active risks by category</figcaption>${rows.map(([c, n]) =>
    `<div class="rb-row" data-tip="${esc(`${c}: ${n} risk${n === 1 ? "" : "s"}`)}"><span>${esc(c)}</span><span class="rb-track"><span class="rb-fill" style="width:${(n / max) * 100}%"></span></span><b>${n}</b></div>`).join("")}</figure>`;
}

function vendorTiers(liveVendors) {
  const tiers = ["Critical", "High", "Medium", "Low"];
  const counts = tiers.map((t) => liveVendors.filter((v) => v.residualTier === t).length);
  const max = Math.max(1, ...counts);
  return `<figure class="rh-bars"><figcaption>Vendors by residual risk tier</figcaption>${tiers.map((t, k) =>
    `<div class="rb-row" data-tip="${esc(`${t}: ${counts[k]} vendor${counts[k] === 1 ? "" : "s"}`)}"><span><span class="sev-dot ${tierClass(t)}"></span>${t}</span><span class="rb-track"><span class="rb-fill status ${tierClass(t)}" style="width:${(counts[k] / max) * 100}%"></span></span><b>${counts[k]}</b></div>`).join("")}</figure>`;
}

// ---------- report ----------
export function renderReport({ risks, vendors, ai, generatedAt, title }) {
  const m = metrics({ risks, vendors });
  const byId = Object.fromEntries([...risks, ...vendors].map((x) => [x.id, x]));
  const posture = ai?.posture || dataPosture(m.active);
  const P = POSTURE[posture];
  const reduction = m.avgInherent ? Math.round((1 - m.avgResidual / m.avgInherent) * 100) : 0;
  const date = new Date(generatedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const aiNote = `<p class="rh-ai-note">Add your Anthropic API key in Settings to include Claude's analysis in this section.</p>`;
  const idChip = (id) => byId[id] ? `<span class="rh-chip" data-tip="${esc(byId[id].title || byId[id].name)}">${esc(id)}</span>` : `<span class="rh-chip">${esc(id)}</span>`;

  const kpis = [
    ["Active risks", m.active.length, ""],
    ["Critical / High", `${m.critical} / ${m.high}`, m.critical ? "critical" : m.high ? "high" : ""],
    ["Avg score", `${m.avgInherent.toFixed(1)} → ${m.avgResidual.toFixed(1)}`, "", reduction ? `${reduction}% lower after controls` : ""],
    ["Overdue actions", m.overdue, m.overdue ? "high" : ""],
    ["High-risk vendors", m.riskyVendors, m.riskyVendors ? "high" : ""],
    ["Vendor reviews due", m.vendorsDue, m.vendorsDue ? "high" : ""],
  ].map(([label, value, cls, sub]) => `<div class="rh-kpi ${cls}"><div class="rh-kpi-val">${value}</div><div class="rh-kpi-label">${label}</div>${sub ? `<div class="rh-kpi-sub">${sub}</div>` : ""}</div>`).join("");

  const topIds = ai?.top_risks?.length ? ai.top_risks : [...m.active].sort((a, b) => b.inherent - a.inherent).slice(0, 4).map((r) => ({ id: r.id }));
  const topCards = topIds.map((t) => {
    const r = byId[t.id];
    if (!r || r.inherent == null) return "";
    return `<article class="rh-risk ${sevClass(r.inherent)}">
      <header><span class="rh-risk-id">${esc(r.id)}</span><h4>${esc(r.title)}</h4>
        <span class="badge ${sevClass(r.inherent)}">${r.inherent} ${sevLabel(r.inherent)}</span></header>
      <div class="rh-risk-meta">${esc(r.category)} · Owner: ${esc(r.owner || "unassigned")}${r.due ? ` · Due ${esc(r.due)}` : ""} · Residual ${r.residual}</div>
      ${t.why_it_matters ? `<p><b>Why it matters.</b> ${esc(t.why_it_matters)}</p><p><b>Action.</b> ${esc(t.recommended_action)}</p>` : `<p class="muted">${esc(r.description || "")}</p>`}
    </article>`;
  }).join("");

  const phases = ["0-30 days", "31-60 days", "61-90 days"];
  const roadmap = ai?.roadmap?.length ? `<div class="rh-roadmap">${phases.map((ph, k) => `
      <div class="rh-phase"><div class="rh-phase-head"><span class="rh-phase-num">${k + 1}</span>${ph}</div>
        ${ai.roadmap.filter((x) => x.phase === ph).map((x) => `<div class="rh-action"><div>${esc(x.action)}</div>
          <div class="rh-action-meta">${esc(x.owner)} ${x.related_ids.map(idChip).join("")}</div></div>`).join("") || '<p class="muted small">No actions</p>'}
      </div>`).join("")}</div>` : aiNote;

  const challenges = ai?.score_challenges?.length ? `<div class="rh-table-wrap"><table class="rh-table"><thead><tr><th>Risk</th><th>Current</th><th>Suggested</th><th>Why</th></tr></thead><tbody>
      ${ai.score_challenges.map((c) => `<tr><td>${idChip(c.id)} ${esc(byId[c.id]?.title || "")}</td>
        <td><span class="badge ${sevClass(c.current_score)}">${c.current_score}</span></td>
        <td><span class="badge ${sevClass(c.suggested_score)}">${c.suggested_score}</span> ${c.suggested_score > c.current_score ? "↑" : "↓"}</td>
        <td>${esc(c.reason)}</td></tr>`).join("")}</tbody></table></div>` : (ai ? '<p class="muted">No scores flagged for review.</p>' : aiNote);

  return `<div class="rh-doc">
    <header class="rh-cover">
      <div class="rh-cover-top"><span class="rh-eyebrow">🛡️ ${esc(title)}</span><span class="rh-date">${esc(date)}</span></div>
      <h1>Cyber Risk Executive Briefing</h1>
      <div class="rh-posture">
        <div class="rh-posture-badge ${P.cls}" data-tip="Overall posture${ai ? " (Claude's assessment)" : " (estimated from scores)"}">
          <span class="rh-posture-icon">${P.icon}</span><div><small>Overall posture</small><strong>${posture}</strong></div></div>
        <div class="rh-meter" aria-label="Posture ${P.level} of 5">${[1, 2, 3, 4, 5].map((n) => `<span class="${n <= P.level ? `on ${P.cls}` : ""}"></span>`).join("")}</div>
        <p class="rh-headline">${esc(ai?.headline || `${m.active.length} active risks, ${m.critical} critical, across ${new Set(m.active.map((r) => r.category)).size} categories.`)}</p>
      </div>
    </header>

    <section class="rh-kpis">${kpis}</section>

    <section class="rh-section">
      <h3>Executive summary</h3>
      ${ai ? `<p class="rh-lead">${esc(ai.summary)}</p>` : aiNote}
    </section>

    <section class="rh-section rh-two">
      <div class="rh-heats">${heatmap(m.active, "likelihood", "impact", "Inherent")}${heatmap(m.active, "residualLikelihood", "residualImpact", "Residual")}</div>
      ${dumbbell(m.active)}
    </section>

    <section class="rh-section">
      <h3>Top risks requiring attention</h3>
      <div class="rh-risks">${topCards || '<p class="muted">No active risks.</p>'}</div>
    </section>

    <section class="rh-section rh-two">
      <div><h3>Themes and systemic weaknesses</h3>
        ${ai?.themes?.length ? `<div class="rh-themes">${ai.themes.map((t, k) => `<div class="rh-theme"><span class="rh-theme-num">${k + 1}</span><div><b>${esc(t.title)}</b><p>${esc(t.detail)}</p></div></div>`).join("")}</div>` : aiNote}
      </div>
      ${categoryBars(m.active)}
    </section>

    <section class="rh-section rh-two">
      <div><h3>Third-party risk</h3>
        ${ai ? `<p>${esc(ai.vendor_commentary)}</p>${ai.vendors_of_concern.map((v) => `<div class="rh-vendor">${idChip(v.id)} <b>${esc(byId[v.id]?.name || "")}</b>
          ${byId[v.id]?.residualTier ? `<span class="badge ${tierClass(byId[v.id].residualTier)}">${esc(byId[v.id].residualTier)}</span>` : ""}<p>${esc(v.concern)}</p></div>`).join("")}` : aiNote}
      </div>
      ${m.liveVendors.length ? vendorTiers(m.liveVendors) : '<p class="muted">No vendors in the inventory.</p>'}
    </section>

    <section class="rh-section">
      <h3>90-day roadmap</h3>
      ${roadmap}
    </section>

    <section class="rh-section">
      <h3>Scores to revisit</h3>
      ${challenges}
    </section>

    <footer class="rh-foot">Scores use a 5×5 likelihood × impact matrix (Critical ≥ 20, High ≥ 12, Medium ≥ 6). Residual scores assume planned controls are in place.
      Metrics and charts are calculated from the register${ai ? "; narrative drafted by Claude and should be reviewed before distribution" : ""}. Generated by RiskPilot.</footer>
  </div>`;
}

// Markdown version for pasting into email or documents.
export function reportMarkdown({ risks, vendors, ai, generatedAt }) {
  const m = metrics({ risks, vendors });
  const byId = Object.fromEntries([...risks, ...vendors].map((x) => [x.id, x]));
  const name = (id) => byId[id]?.title || byId[id]?.name || "";
  const lines = [
    `# Cyber Risk Executive Briefing – ${new Date(generatedAt).toLocaleDateString()}`,
    "",
    `**Overall posture: ${ai?.posture || dataPosture(m.active)}**${ai ? ` – ${ai.headline}` : ""}`,
    "",
    `Active risks: ${m.active.length} · Critical: ${m.critical} · High: ${m.high} · Avg score ${m.avgInherent.toFixed(1)} → ${m.avgResidual.toFixed(1)} · Overdue actions: ${m.overdue} · High-risk vendors: ${m.riskyVendors} · Vendor reviews due: ${m.vendorsDue}`,
  ];
  if (ai) {
    lines.push("", "## Executive summary", ai.summary,
      "", "## Top risks requiring attention", ...ai.top_risks.map((t) => `- **${t.id} ${name(t.id)}** – ${t.why_it_matters} *Action:* ${t.recommended_action}`),
      "", "## Themes", ...ai.themes.map((t) => `- **${t.title}** – ${t.detail}`),
      "", "## Third-party risk", ai.vendor_commentary, ...ai.vendors_of_concern.map((v) => `- **${v.id} ${name(v.id)}** – ${v.concern}`),
      "", "## 90-day roadmap", ...ai.roadmap.map((x) => `- [${x.phase}] ${x.action} (${x.owner}${x.related_ids.length ? `; ${x.related_ids.join(", ")}` : ""})`));
    if (ai.score_challenges.length) lines.push("", "## Scores to revisit", ...ai.score_challenges.map((c) => `- ${c.id} ${name(c.id)}: ${c.current_score} → ${c.suggested_score} – ${c.reason}`));
  }
  return lines.join("\n");
}
