# RiskPilot – AI cyber risk manager

A browser-only cyber risk management app with Claude-powered analysis. No build step or server: it runs on GitHub Pages (or any static host) at `/cyber-risk/`.

## Features

- **Dashboard** – KPIs (active, critical, high, average inherent/residual score, overdue actions), a clickable 5×5 likelihood × impact heat map, top risks and a category breakdown.
- **Risk register** – add, edit, delete, search, filter and sort risks; inherent and residual scoring; owner, status, treatment, controls and due date. Export to CSV/JSON and import from JSON.
- **✨ AI assess** – in the risk editor, Claude scores likelihood/impact, suggests a category, writes threat scenarios, and recommends prioritised controls mapped to NIST CSF 2.0 functions, plus an estimated residual score. One click applies it to the form.
- **Vendor risk assessment** – a third-party inventory with:
  - an inherent tier from business criticality, data sensitivity and access level;
  - a 15-question security questionnaire across governance, access control, data protection, operations, incident response, resilience and supply chain, giving a weighted control score (unanswered questions count as not demonstrated, N/A is excluded);
  - a residual tier (up to two levels below inherent, never below Medium if a key control – MFA, encryption, breach notification – is missing);
  - review scheduling by inherent tier (Critical 6 months, High 12, Medium 24, Low 36) with overdue flags;
  - **✨ AI vendor review** – Claude reads the profile, answers and pasted evidence (e.g. a SOC 2 summary) and returns a risk tier, Approve / Approve with conditions / Needs more information / Reject, strengths, prioritised gaps with remediation, contract clauses to require and follow-up questions to send the vendor;
  - one click to raise a Third-Party risk in the register, and CSV export.
- **Vendor intake questionnaire** (`intake.html`) – a vendor-facing security questionnaire in the style of short-form industry questionnaires such as SIG Lite (original content, not the licensed Shared Assessments SIG):
  - a company profile (contacts, services, data types, hosting and data locations, certifications, subprocessors) and 84 Yes / No / N/A questions with comments across 19 domains: governance, assurance, HR, assets, identity & access, data protection, privacy, application security, vulnerability management, endpoint, network, cloud, logging, incident management, resilience, physical security, subcontractors, compliance & insurance and AI;
  - progress tracking, autosave in the vendor's browser, prompts for comments on unfavourable answers, an attestation, and Print / Save as PDF;
  - the vendor downloads a response file and emails it back. In the vendor editor, **Copy link for vendor** creates a pre-filled link and **Import response** loads the file: it shows an intake score and the answers needing attention, fills in the 15-control questionnaire (all mapped answers Yes → Yes, all No → No, mixed → Partial), raises data sensitivity to match the declared data types, and gives the full response to the AI vendor review.
  - **Documentation instead of answers** – vendors can attach up to 5 documents (SOC 2 report, ISO certificate, policies, whitepaper, a previous questionnaire; PDF, TXT, Markdown or CSV, 20 MB total). They're embedded in the response file, and the vendor may leave questions the documents cover unanswered.
  - **✨ Fill from documents** (in the vendor editor, using your own API key) – Claude reads the attached documents, or ones you add with **Add documents** when a vendor emails documentation instead of a questionnaire, and fills the unanswered questions, each with a supporting quote and source file. It never overwrites the vendor's own answers: where the documents contradict one, it's listed as a disagreement. You can review and change every AI-filled answer before saving, and the AI vendor review is told which answers came from the vendor, from Claude or from you. Documents are held in memory only (browser storage is too small for them); re-import the response file to use them again.
- **Executive report** – a streamed, board-level summary of the whole register and vendor inventory.
- **Ask the analyst** – a chat assistant that answers questions with your register and vendors as context.
- **Offline mode** – without an API key, rule-based heuristics still give baseline risk and vendor assessments.

## Running

Open `cyber-risk/index.html` through any static server, e.g.

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/cyber-risk/
```

Then go to **Settings**, paste an Anthropic API key, and optionally **Load sample data**.

## How the AI works

`ai.js` uses the official Anthropic TypeScript SDK (loaded from jsDelivr) directly in the browser:

- Model defaults to `claude-opus-5-5` (Sonnet 5.5 and Haiku 5.5 selectable), with an adjustable effort level.
- Risk assessments use structured outputs (`output_config.format` with a JSON schema) so results are always well-formed.
- Reports and chat are streamed.
- Server-side refusal fallbacks (`fallbacks: "default"`) are enabled, since security topics can occasionally trip safety classifiers; a remaining refusal is shown as an error.

## Privacy and security notes

- Risks and vendors are stored in your browser's `localStorage`; nothing is sent anywhere except to `api.anthropic.com` when you use an AI feature (the register and vendor inventory are included as context for reports and chat). **Export JSON** saves a backup of both.
- The API key is kept in `sessionStorage` by default, or `localStorage` if you tick “Remember”. Calling the API from the browser exposes the key to anyone with access to that browser, so use a dedicated key with a spend limit and avoid shared machines. For a multi-user deployment, move the AI calls behind a small backend that holds the key.
