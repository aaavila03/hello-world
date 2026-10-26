// Keyword-based fallback assessment used when no API key is configured.
// Returns the same shape as RiskAI.assessRisk so the UI can treat both alike.

const RULES = [
  {
    category: "Ransomware/Malware", keywords: ["ransom", "malware", "encrypt", "virus", "trojan", "wiper"],
    likelihood: 4, impact: 5,
    scenarios: ["Phishing email delivers ransomware that encrypts file servers", "Attacker exfiltrates data before encryption for double extortion"],
    controls: [["Maintain offline, immutable, regularly tested backups", "Recover", "High"],
      ["Deploy EDR on all endpoints and servers", "Detect", "High"],
      ["Rehearse a ransomware incident response playbook", "Respond", "Medium"]],
  },
  {
    category: "Phishing/Social Engineering", keywords: ["phish", "email", "social engineer", "bec", "invoice", "impersonat"],
    likelihood: 5, impact: 3,
    scenarios: ["Credential-harvesting email leads to mailbox takeover", "Business email compromise redirects a supplier payment"],
    controls: [["Enforce phishing-resistant MFA (FIDO2/passkeys)", "Protect", "High"],
      ["Run regular phishing awareness training and simulations", "Protect", "Medium"],
      ["Require out-of-band verification for payment changes", "Govern", "High"]],
  },
  {
    category: "Data Breach", keywords: ["breach", "pii", "personal data", "leak", "exfiltrat", "customer data", "database"],
    likelihood: 3, impact: 5,
    scenarios: ["Sensitive records exfiltrated via a compromised account", "Unencrypted backup exposed publicly"],
    controls: [["Classify data and encrypt sensitive data at rest and in transit", "Protect", "High"],
      ["Deploy data loss prevention and egress monitoring", "Detect", "Medium"],
      ["Maintain a breach notification procedure", "Respond", "Medium"]],
  },
  {
    category: "Third-Party/Supply Chain", keywords: ["vendor", "supplier", "third party", "third-party", "saas", "supply chain", "msp"],
    likelihood: 3, impact: 4,
    scenarios: ["Compromised vendor update introduces malicious code", "Critical SaaS provider suffers an outage or breach"],
    controls: [["Perform risk-based vendor security assessments", "Govern", "High"],
      ["Include security and breach-notification clauses in contracts", "Govern", "Medium"],
      ["Limit and monitor vendor access to internal systems", "Protect", "Medium"]],
  },
  {
    category: "Cloud Misconfiguration", keywords: ["cloud", "s3", "bucket", "aws", "azure", "gcp", "misconfig", "public"],
    likelihood: 4, impact: 4,
    scenarios: ["Storage bucket accidentally made public", "Over-permissive IAM role abused after key leak"],
    controls: [["Enable CSPM to continuously detect misconfigurations", "Detect", "High"],
      ["Apply infrastructure-as-code with policy guardrails", "Protect", "Medium"],
      ["Enforce least-privilege IAM and rotate access keys", "Protect", "High"]],
  },
  {
    category: "Vulnerability/Patching", keywords: ["patch", "vulnerab", "cve", "outdated", "legacy", "unpatched", "end of life", "eol"],
    likelihood: 4, impact: 4,
    scenarios: ["Internet-facing system exploited via a known CVE", "Unsupported OS cannot receive security fixes"],
    controls: [["Run continuous vulnerability scanning with risk-based SLAs", "Identify", "High"],
      ["Patch internet-facing critical vulnerabilities within 7 days", "Protect", "High"],
      ["Isolate or replace end-of-life systems", "Protect", "Medium"]],
  },
  {
    category: "Identity & Access", keywords: ["password", "credential", "mfa", "access", "privilege", "admin", "account", "identity"],
    likelihood: 4, impact: 4,
    scenarios: ["Password spraying compromises an account without MFA", "Excessive privileges enable lateral movement"],
    controls: [["Enforce MFA for all users and privileged access", "Protect", "High"],
      ["Implement privileged access management and JIT access", "Protect", "Medium"],
      ["Run quarterly access reviews", "Govern", "Medium"]],
  },
  {
    category: "Insider Threat", keywords: ["insider", "employee", "disgruntled", "leaver", "contractor"],
    likelihood: 2, impact: 4,
    scenarios: ["Departing employee takes sensitive data", "Privileged user abuses access"],
    controls: [["Automate access removal in the leaver process", "Protect", "High"],
      ["Monitor for anomalous user behaviour (UEBA)", "Detect", "Medium"]],
  },
  {
    category: "Availability/DDoS", keywords: ["ddos", "outage", "availability", "downtime", "denial of service"],
    likelihood: 3, impact: 4,
    scenarios: ["Volumetric DDoS takes customer portal offline", "Single point of failure causes prolonged outage"],
    controls: [["Use a DDoS protection / CDN service", "Protect", "High"],
      ["Test disaster recovery and failover regularly", "Recover", "Medium"]],
  },
  {
    category: "Compliance/Regulatory", keywords: ["gdpr", "hipaa", "pci", "sox", "regulat", "compliance", "audit", "fine"],
    likelihood: 3, impact: 4,
    scenarios: ["Regulatory audit identifies missing controls", "Fine following a reportable incident"],
    controls: [["Map controls to applicable frameworks and track gaps", "Govern", "High"],
      ["Assign compliance ownership and report to leadership", "Govern", "Medium"]],
  },
];

export function assessOffline(risk) {
  const text = `${risk.title} ${risk.description} ${risk.asset}`.toLowerCase();
  const scored = RULES.map((r) => ({ r, hits: r.keywords.filter((k) => text.includes(k)).length }))
    .sort((a, b) => b.hits - a.hits);
  const best = scored[0].hits ? scored[0].r : null;
  const controlCount = (risk.controls || "").split(/\n|;|,/).filter((s) => s.trim()).length;
  const likelihood = best ? best.likelihood : 3;
  const impact = best ? best.impact : 3;
  const residualLikelihood = Math.max(1, likelihood - 1 - Math.min(1, Math.floor(controlCount / 3)));

  return {
    category: best ? best.category : "Other",
    likelihood,
    impact,
    rationale: best
      ? `Matched indicators of ${best.category.toLowerCase()} risk (${best.keywords.filter((k) => text.includes(k)).join(", ")}). Scores are typical industry baselines – adjust for your context.`
      : "No specific threat indicators recognised; defaulting to a moderate baseline score. Add more detail or use Claude for a tailored assessment.",
    threat_scenarios: best ? best.scenarios : [],
    recommended_controls: (best ? best.controls : [["Document the risk, assign an owner and define a treatment plan", "Govern", "Medium"]])
      .map(([control, csf_function, priority]) => ({ control, csf_function, priority })),
    residual_likelihood: residualLikelihood,
    residual_impact: impact,
    treatment: likelihood * impact >= 6 ? "Mitigate" : "Accept",
  };
}

// Rule-based vendor review used when no API key is configured.
// Mirrors the shape of the Claude vendor assessment.
const REMEDIATION = {
  policy: "Request the vendor's information security policy and evidence of annual review.",
  cert: "Request a current SOC 2 Type II report or ISO 27001 certificate, or perform an on-site / remote audit.",
  pentest: "Request an executive summary of a recent independent penetration test and remediation status.",
  mfa: "Require MFA for all vendor staff and administrative access before granting access.",
  access_review: "Require quarterly access reviews and timely leaver de-provisioning.",
  encrypt: "Require encryption of our data at rest (AES-256) and in transit (TLS 1.2+).",
  retention: "Define data retention, return and certified deletion at contract end.",
  data_location: "Require documentation of data storage and processing locations.",
  vuln: "Require defined patching SLAs (e.g. critical within 14 days) and evidence of compliance.",
  logging: "Require security event logging, monitoring and log retention.",
  ir: "Request the incident response plan and evidence of a recent exercise.",
  notify: "Add a contractual obligation to notify us of breaches within 72 hours.",
  bcp: "Request BC/DR plans and recent test results aligned to our recovery objectives.",
  subproc: "Require a subprocessor list, change notification and flow-down of security terms.",
  insurance: "Require cyber liability insurance with adequate coverage.",
};

export function assessVendorOffline(v, questions) {
  const crit = { Low: 1, Medium: 2, High: 3, Critical: 4 }[v.criticality] || 2;
  const data = { None: 1, Internal: 2, Confidential: 3, "Regulated (PII/PHI/PCI)": 4 }[v.dataSensitivity] || 2;
  const answered = questions.filter((q) => ["Yes", "Partial", "No"].includes(v.answers?.[q.id]));
  const strengths = questions.filter((q) => v.answers?.[q.id] === "Yes").map((q) => q.text);
  const gaps = questions
    .filter((q) => ["No", "Partial"].includes(v.answers?.[q.id]))
    .map((q) => ({
      gap: `${q.text} (${v.answers[q.id]})`,
      severity: q.key || q.weight > 1 ? (v.answers[q.id] === "No" ? "High" : "Medium") : "Low",
      remediation: REMEDIATION[q.id],
    }))
    .sort((a, b) => ["High", "Medium", "Low"].indexOf(a.severity) - ["High", "Medium", "Low"].indexOf(b.severity));
  const unanswered = questions.filter((q) => !v.answers?.[q.id]);
  const highGaps = gaps.filter((g) => g.severity === "High").length;

  const exposure = crit + data;
  const tier = highGaps >= 2 && exposure >= 6 ? "Critical"
    : highGaps >= 1 || exposure >= 7 ? "High"
    : gaps.length || exposure >= 5 ? "Medium" : "Low";
  const recommendation = answered.length < questions.length / 2 ? "Needs more information"
    : highGaps >= 2 && exposure >= 6 ? "Reject"
    : gaps.length ? "Approve with conditions" : "Approve";

  return {
    risk_tier: tier,
    recommendation,
    summary: `${v.name} has ${v.criticality || "unspecified"} business criticality and handles ${v.dataSensitivity || "unspecified"} data. `
      + `${answered.length} of ${questions.length} questionnaire items are answered, with ${gaps.length} gap(s) including ${highGaps} high-severity. `
      + (recommendation === "Needs more information" ? "Complete the questionnaire before deciding." : ""),
    strengths,
    gaps,
    contract_clauses: [
      "Right to audit and to receive annual independent assurance reports",
      "Breach notification within 72 hours with cooperation in investigations",
      ...(data >= 3 ? ["Data processing agreement covering purpose limitation, retention, deletion and subprocessors"] : []),
      ...(crit >= 3 ? ["Service levels, business continuity commitments and exit / transition assistance"] : []),
    ],
    follow_up_questions: unanswered.slice(0, 6).map((q) => `Please confirm: ${q.text.charAt(0).toLowerCase()}${q.text.slice(1)}?`),
  };
}
