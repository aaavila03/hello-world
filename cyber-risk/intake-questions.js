// Vendor security intake questionnaire: an original short-form question set
// inspired by industry standard shared-assessment questionnaires (it is not
// the licensed SIG Lite content).
//
// Question types:
//   (default) Yes is the desired answer and is scored
//   inverse   Yes is a red flag (e.g. a breach in the last 3 years) and is scored
//   info      context only, not scored
// `maps` links a question to a control in the internal vendor questionnaire
// (see QUESTIONS in vendors.js) so an imported response can pre-fill it.

export const INTAKE_FORMAT = "riskpilot-intake";
export const INTAKE_VERSION = 1;

export const INTAKE_DOMAINS = [
  {
    id: "GOV", title: "Governance & risk management", questions: [
      { id: "GOV1", text: "Do you have a documented information security program approved by senior management?", maps: "policy" },
      { id: "GOV2", text: "Is a named individual (e.g. CISO) accountable for information security?" },
      { id: "GOV3", text: "Do you perform a formal information security risk assessment at least annually?" },
      { id: "GOV4", text: "Are security policies reviewed and updated at least annually?", maps: "policy" },
    ],
  },
  {
    id: "AUD", title: "Certifications & independent assurance", questions: [
      { id: "AUD1", text: "Do you have a current SOC 2 Type II report covering the services you will provide to us?", maps: "cert" },
      { id: "AUD2", text: "Are you certified to ISO/IEC 27001 for the services in scope?", maps: "cert" },
      { id: "AUD3", text: "Has an independent penetration test of in-scope systems been performed in the last 12 months?", maps: "pentest" },
      { id: "AUD4", text: "Have all critical and high findings from that test been remediated?", maps: "pentest" },
      { id: "AUD5", text: "Will you share audit reports and test summaries with us under NDA?" },
    ],
  },
  {
    id: "HR", title: "Human resources security", questions: [
      { id: "HR1", text: "Do you perform background checks, where legally permitted, on staff with access to customer data?" },
      { id: "HR2", text: "Do all staff and contractors sign confidentiality agreements?" },
      { id: "HR3", text: "Do staff complete security awareness training at onboarding and at least annually?" },
      { id: "HR4", text: "Do you run phishing simulations or equivalent testing?" },
      { id: "HR5", text: "Is access revoked within 24 hours when staff leave or change roles?", maps: "access_review" },
    ],
  },
  {
    id: "AST", title: "Asset & data management", questions: [
      { id: "AST1", text: "Do you maintain an up-to-date inventory of hardware, software and data assets?" },
      { id: "AST2", text: "Do you have a data classification scheme that covers customer data?" },
      { id: "AST3", text: "Is our data logically segregated from other customers' data?" },
      { id: "AST4", text: "Is storage media securely sanitised or destroyed before disposal (e.g. per NIST SP 800-88)?", maps: "retention" },
    ],
  },
  {
    id: "IAM", title: "Identity & access management", questions: [
      { id: "IAM1", text: "Is multi-factor authentication enforced for all remote access to your network?", maps: "mfa" },
      { id: "IAM2", text: "Is multi-factor authentication enforced for all administrative and privileged access?", maps: "mfa" },
      { id: "IAM3", text: "Is multi-factor authentication enforced for staff access to systems holding our data?", maps: "mfa" },
      { id: "IAM4", text: "Does every user have a unique ID, with shared or generic accounts prohibited or tightly controlled?" },
      { id: "IAM5", text: "Is access granted on a least-privilege, role-based basis?" },
      { id: "IAM6", text: "Are user access rights reviewed at least quarterly?", maps: "access_review" },
      { id: "IAM7", text: "Is privileged access managed with a PAM tool or just-in-time elevation?" },
      { id: "IAM8", text: "Can our users sign in to your service through our SSO (SAML / OIDC)?" },
    ],
  },
  {
    id: "DAT", title: "Data protection & encryption", questions: [
      { id: "DAT1", text: "Is our data encrypted at rest using AES-256 or equivalent?", maps: "encrypt" },
      { id: "DAT2", text: "Is our data encrypted in transit using TLS 1.2 or higher?", maps: "encrypt" },
      { id: "DAT3", text: "Are encryption keys managed in a KMS or HSM, with access restricted and keys rotated?", maps: "encrypt" },
      { id: "DAT4", text: "Do you use data loss prevention controls to detect or block unauthorised data transfers?" },
      { id: "DAT5", text: "Is our production data kept out of development and test environments?" },
      { id: "DAT6", text: "Will you return or securely delete our data at contract end and confirm deletion in writing?", maps: "retention" },
      { id: "DAT7", text: "Do you have a defined data retention schedule?", maps: "retention" },
    ],
  },
  {
    id: "PRV", title: "Privacy", questions: [
      { id: "PRV1", text: "Will you process personal data on our behalf?", type: "info" },
      { id: "PRV2", text: "Will you sign a data processing agreement (e.g. GDPR / CCPA terms)?" },
      { id: "PRV3", text: "Have you documented every country where our data will be stored or processed?", maps: "data_location" },
      { id: "PRV4", text: "Do you use an approved transfer mechanism (e.g. SCCs) for cross-border transfers of personal data?", maps: "data_location" },
      { id: "PRV5", text: "Do you have a designated privacy officer or DPO?" },
      { id: "PRV6", text: "Do you have a process to support data subject requests (access, deletion, correction)?" },
    ],
  },
  {
    id: "APP", title: "Application security & change management", questions: [
      { id: "APP1", text: "Do you follow a secure development lifecycle with security requirements and peer code review?" },
      { id: "APP2", text: "Do you run automated security testing (SAST, DAST and/or dependency scanning) before release?" },
      { id: "APP3", text: "Do developers receive secure coding training (e.g. OWASP Top 10) at least annually?" },
      { id: "APP4", text: "Are development, test and production environments separated?" },
      { id: "APP5", text: "Are production changes approved, tested and reversible through a change management process?" },
    ],
  },
  {
    id: "VUL", title: "Vulnerability & threat management", questions: [
      { id: "VUL1", text: "Do you run authenticated vulnerability scans of in-scope systems at least monthly?", maps: "vuln" },
      { id: "VUL2", text: "Are critical vulnerabilities patched within 14 days and high within 30 days?", maps: "vuln" },
      { id: "VUL3", text: "Do you monitor threat intelligence relevant to your technology stack?" },
      { id: "VUL4", text: "Do you have a public vulnerability disclosure policy or bug bounty program?" },
    ],
  },
  {
    id: "END", title: "Endpoint & server security", questions: [
      { id: "END1", text: "Is EDR or anti-malware deployed on all endpoints and servers?" },
      { id: "END2", text: "Is full-disk encryption enabled on all laptops and portable devices?" },
      { id: "END3", text: "Are systems built from hardened configuration baselines (e.g. CIS Benchmarks)?" },
      { id: "END4", text: "Are mobile devices that access company data managed (MDM) and able to be remotely wiped?" },
    ],
  },
  {
    id: "NET", title: "Network security", questions: [
      { id: "NET1", text: "Are firewalls configured with a default-deny policy and reviewed at least annually?" },
      { id: "NET2", text: "Are systems processing our data segmented from corporate and other networks?" },
      { id: "NET3", text: "Do you use intrusion detection or prevention on in-scope networks?" },
      { id: "NET4", text: "Is guest wireless separated from internal networks?" },
    ],
  },
  {
    id: "CLD", title: "Cloud & hosting", questions: [
      { id: "CLD1", text: "Is the service hosted on a public cloud provider (e.g. AWS, Azure, Google Cloud)?", type: "info" },
      { id: "CLD2", text: "Do you continuously monitor cloud configuration for misconfigurations (CSPM or equivalent)?" },
      { id: "CLD3", text: "Is infrastructure defined as code and security-reviewed before deployment?" },
    ],
  },
  {
    id: "LOG", title: "Logging & monitoring", questions: [
      { id: "LOG1", text: "Are security events from in-scope systems collected centrally (SIEM or equivalent)?", maps: "logging" },
      { id: "LOG2", text: "Are security alerts monitored 24x7, in-house or by a managed SOC?", maps: "logging" },
      { id: "LOG3", text: "Are logs retained for at least 12 months and protected from tampering?", maps: "logging" },
    ],
  },
  {
    id: "INC", title: "Incident management", questions: [
      { id: "INC1", text: "Do you have a documented incident response plan?", maps: "ir" },
      { id: "INC2", text: "Is the incident response plan tested (e.g. tabletop exercise) at least annually?", maps: "ir" },
      { id: "INC3", text: "Will you notify us within 72 hours of a security incident affecting our data?", maps: "notify" },
      { id: "INC4", text: "Have you had a reportable security breach in the last 36 months?", type: "inverse" },
    ],
  },
  {
    id: "BCM", title: "Business continuity & resilience", questions: [
      { id: "BCM1", text: "Do you have documented business continuity and disaster recovery plans?", maps: "bcp" },
      { id: "BCM2", text: "Are the BC/DR plans tested at least annually?", maps: "bcp" },
      { id: "BCM3", text: "Are backups encrypted, kept offline or immutable, and restores tested?", maps: "bcp" },
      { id: "BCM4", text: "Are recovery time and recovery point objectives defined for the services provided to us?" },
      { id: "BCM5", text: "Is the service hosted redundantly across multiple data centres or availability zones?" },
    ],
  },
  {
    id: "PHY", title: "Physical security", questions: [
      { id: "PHY1", text: "Are offices and data centres protected by badge access, CCTV or equivalent controls?" },
      { id: "PHY2", text: "Are visitors logged and escorted in secure areas?" },
    ],
  },
  {
    id: "SUB", title: "Subcontractors (fourth parties)", questions: [
      { id: "SUB1", text: "Will you provide a list of subprocessors that may access our data?", maps: "subproc" },
      { id: "SUB2", text: "Will you notify us before adding or changing subprocessors?", maps: "subproc" },
      { id: "SUB3", text: "Do you assess your own critical suppliers and flow down equivalent security requirements?", maps: "subproc" },
      { id: "SUB4", text: "Will staff or subcontractors located offshore access our data?", type: "info" },
    ],
  },
  {
    id: "CMP", title: "Compliance & insurance", questions: [
      { id: "CMP1", text: "Do you monitor and comply with laws and regulations applicable to the services (e.g. GDPR, HIPAA)?" },
      { id: "CMP2", text: "If you store, process or transmit payment card data, do you have a current PCI DSS attestation?" },
      { id: "CMP3", text: "Do you carry cyber liability insurance?", maps: "insurance" },
      { id: "CMP4", text: "Have you been subject to regulatory action or litigation relating to security or privacy in the last 3 years?", type: "inverse" },
    ],
  },
  {
    id: "AI", title: "Artificial intelligence", questions: [
      { id: "AI1", text: "Does the service use AI or machine learning to process our data?", type: "info" },
      { id: "AI2", text: "Is our data excluded from training AI models unless we explicitly agree?" },
      { id: "AI3", text: "Do you have an AI governance policy covering acceptable use, oversight and risk assessment?" },
    ],
  },
];

export const INTAKE_QUESTIONS = INTAKE_DOMAINS.flatMap((d) => d.questions.map((q) => ({ ...q, domain: d.title })));

// Summarises a response: counts, scored percentage and the red-flag answers.
export function summarizeIntake(response) {
  const counts = { Yes: 0, No: 0, "N/A": 0, unanswered: 0 };
  let good = 0, scored = 0;
  const flags = [];
  for (const q of INTAKE_QUESTIONS) {
    const r = response.answers?.[q.id];
    const a = r?.answer;
    if (!a) { counts.unanswered++; continue; }
    counts[a] = (counts[a] || 0) + 1;
    if (q.type === "info" || a === "N/A") continue;
    scored++;
    const ok = q.type === "inverse" ? a === "No" : a === "Yes";
    if (ok) good++;
    else flags.push({ id: q.id, domain: q.domain, text: q.text, answer: a, comment: r.comment || "" });
  }
  return { counts, total: INTAKE_QUESTIONS.length, score: scored ? Math.round((good / scored) * 100) : null, flags };
}

// Derives answers for the internal 15-control questionnaire from an intake response.
// All mapped questions Yes -> Yes, all No -> No, a mix -> Partial, all N/A -> N/A.
export function deriveControlAnswers(response) {
  const groups = {};
  for (const q of INTAKE_QUESTIONS) {
    const a = response.answers?.[q.id]?.answer;
    if (!q.maps || !a) continue;
    (groups[q.maps] ||= []).push(a);
  }
  const derived = {};
  for (const [control, answers] of Object.entries(groups)) {
    const applicable = answers.filter((a) => a !== "N/A");
    if (!applicable.length) derived[control] = "N/A";
    else if (applicable.every((a) => a === "Yes")) derived[control] = "Yes";
    else if (applicable.every((a) => a === "No")) derived[control] = "No";
    else derived[control] = "Partial";
  }
  return derived;
}

export function validateIntake(data) {
  if (!data || data.format !== INTAKE_FORMAT) throw new Error("This file is not a RiskPilot intake response.");
  if (data.version > INTAKE_VERSION) throw new Error("This response was made with a newer questionnaire version.");
  if (typeof data.answers !== "object" || !data.profile) throw new Error("The response file is incomplete.");
  return data;
}
