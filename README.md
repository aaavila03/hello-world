# Posture.ai – AI cyber risk manager

A browser-only cyber risk management app with Claude-powered analysis. No build step or server: it runs on GitHub Pages (or any static host).

## Features

- **Dashboard** – KPIs (active, critical, high, average inherent/residual score, overdue actions), a clickable 5×5 likelihood × impact heat map, top risks and a category breakdown.
- **Risk register** – add, edit, delete, search, filter and sort risks (click a risk's title or Edit; on desktop it opens beside the register in a split view, like vendors); inherent and residual scoring; owner, status, treatment, controls and due date. Export to CSV/JSON and import from JSON.
- **✨ AI assess** – in the risk editor, Claude scores likelihood/impact, suggests a category, writes threat scenarios, and recommends prioritised controls mapped to NIST CSF 2.0 functions, plus an estimated residual score. One click applies it to the form.
- **Vendor risk assessment** – a third-party inventory with:
  - click a vendor's name (or Edit) to open it; on desktop it opens beside the list in a split view, so you can move between vendors without closing it, and on phones and tablets it opens full screen. Changing tabs closes it, and unsaved changes are always confirmed first;
  - an inherent tier from business criticality, data sensitivity and access level;
  - a weighted control score across 15 key controls (governance, access control, data protection, operations, incident response, resilience and supply chain), worked out from the intake questionnaire's answers – all related answers Yes → in place, all No → missing, a mix → partial; unanswered controls count as not demonstrated and N/A is excluded;
  - a residual tier (up to two levels below inherent, never below Medium if a key control – MFA, encryption, breach notification – is missing);
  - review scheduling by inherent tier (Critical 6 months, High 12, Medium 24, Low 36) with overdue flags;
  - **✨ AI vendor review** – Claude reads the profile, answers and pasted evidence (e.g. a SOC 2 summary) and returns a risk tier, Approve / Approve with conditions / Needs more information / Reject, strengths, prioritised gaps with remediation, contract clauses to require and follow-up questions to send the vendor;
  - one click to raise a Third-Party risk in the register, and CSV export.
- **Vendor intake questionnaire** (`intake.html`) – a vendor-facing security questionnaire in the style of short-form industry questionnaires such as SIG Lite (original content, not the licensed Shared Assessments SIG):
  - a company profile (contacts, ownership, how the service is delivered and hosted, software types, in-scope applications, data types, data and disaster-recovery locations, outsourced IT services, certifications, subprocessors, who contributed and who approved) and Yes / No / N/A questions with comments across 19 domains: governance, assurance, HR, assets, identity & access, data protection, privacy, application security, vulnerability management, endpoint, network, cloud, logging, incident management, resilience, physical security, subcontractors, compliance & insurance and AI;
  - **follow-on questions** that appear only when they apply (e.g. contract terms only if subcontractors handle your data, root-cause questions only if there was a breach), so they don't count against vendors they don't apply to;
  - an optional **Utility supply chain (NERC CIP-013)** section, switched on per vendor with **Extra section** in the vendor editor: incident notification and coordination, access revocation, vulnerability disclosure (including proactive timelines), software integrity and remote access;
  - **follow-up questions**: on any answer needing attention, click **Ask follow-up**, then **Send follow-ups to vendor**, which saves the vendor and copies their link (in demo mode it downloads a file for them instead). The vendor opens the link, sees each question under the answer it's about, replies (and can change the answer), and submits. Their replies are added to each thread – changed answers are noted – and you resolve the thread or ask again. Open follow-ups show on the vendor list, and the AI vendor review reads every thread, treating replies that don't answer the question as gaps;
  - progress tracking, autosave in the vendor's browser, prompts for comments on unfavourable answers, an attestation, and Print / Save as PDF;
  - **saved straight into the vendor profile** (hosted mode): **Copy link for vendor** gives the vendor a private link (valid 30 days). The vendor never sees the app – the link opens their questionnaire, already holding any answers you entered, and autosaves to your workspace as they go, from any device. Documents they attach are stored with it. When they click **Submit**, their answers, documents and follow-up replies appear in the vendor profile the next time you open it (the vendor list shows *in progress* or *response submitted*), with no files to email or import. The full questionnaire is also shown inside the vendor profile, where you can answer or correct any question yourself (marked as yours);
  - in demo mode, or with an old link, the vendor downloads a response file and emails it back instead, and **Import response** loads it: it shows an intake score and the answers needing attention, fills in the 15-control questionnaire (all mapped answers Yes → Yes, all No → No, mixed → Partial), raises data sensitivity to match the declared data types, and gives the full response to the AI vendor review.
  - **✨ Fill answers from my documents** (hosted mode) – once a vendor attaches documents, Claude fills the questions they haven't answered, showing the passage each answer came from, and flags any of the vendor's own answers that their documents contradict. The vendor reviews every suggestion before attesting; answers they keep are marked as Claude-suggested in the response you import. It works through the invite token in the link from **Copy link for vendor** (valid 30 days, 5 AI runs, counted against your workspace's AI allowance), so vendors need no account.
  - **Documentation instead of answers** – vendors can attach up to 5 documents (SOC 2 report, ISO certificate, policies, whitepaper, a previous questionnaire; PDF, Excel (.xlsx), TXT, Markdown or CSV, 20 MB total). Excel workbooks, such as a completed SIG or SIG Lite, are converted to CSV in the browser, keeping every column including follow-up history. They're embedded in the response file, and the vendor may leave questions the documents cover unanswered.
  - **✨ Fill from documents** (in the vendor editor, using your own API key) – Claude reads the attached documents, or ones you add with **Add documents** when a vendor emails documentation instead of a questionnaire, and fills the unanswered questions, each with a supporting quote and source file. It reads completed questionnaires critically: answers that contradict each other, or follow-up replies that don't address the question, are marked Unknown with the reason. It never overwrites the vendor's own answers: where the documents contradict one, it's listed as a disagreement. You can review and change every AI-filled answer before saving, and the AI vendor review is told which answers came from the vendor, from Claude or from you. Documents are held in memory only (browser storage is too small for them); re-import the response file to use them again.
- **Executive briefing** – a designed, board-ready briefing: a cover with the overall posture and a one-line headline, KPI tiles, inherent vs residual heat maps, a risk-reduction chart (inherent → residual per risk), top-risk cards with why each matters and the recommended action, systemic themes, risks by category, third-party risk with vendors by tier, a three-phase 90-day roadmap with owners, and scores worth revisiting. Every number and chart is calculated from the register; Claude writes the narrative as structured data. Without an API key you still get the data-only briefing. **Print / save PDF** prints just the briefing, and **Copy as text** gives a Markdown version for email. Set your organisation name in Settings to brand the briefing (it's also shown on vendor questionnaire links).
- **Ask the analyst** – a chat assistant that answers questions with your register and vendors as context.
- **Offline mode** – without an API key, rule-based heuristics still give baseline risk and vendor assessments.

## Running

Open `index.html` through any static server, e.g.

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/
```

Then go to **Settings**, paste an Anthropic API key, and optionally **Load sample data**.

## Two modes

| | **Hosted (production)** | **Demo** |
|---|---|---|
| Turned on by | `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` in `config.js` | leaving them empty |
| Sign-in | Email + password with mandatory authenticator-app MFA | none |
| Data | Supabase PostgreSQL, one isolated workspace per customer, row-level security | this browser's `localStorage` |
| Users | Owner / Admin / Analyst / Viewer roles, invitations, audit log | single user |
| AI | Server-side function with the API key as a secret, per-workspace quotas and usage logging | the user's own key, called from the browser |

Set up hosting with [`docs/deploy.md`](docs/deploy.md), or the beginner-friendly [step-by-step guide for Mac](docs/deploy-step-by-step-mac.md). Security controls are described in [`SECURITY.md`](SECURITY.md).

## How the AI works

- Every AI task (risk assessment, vendor review, briefing, document fill, chat) is defined once in `ai-tasks.js`: its system prompt, structured-output JSON schema, token limit and the minimum role allowed to run it. The server function uses the same file (copied to `supabase/functions/_shared/`), so clients choose a task but can't change its instructions.
- Model `claude-opus-5-5` by default, with structured outputs so results are always well-formed, streaming to avoid timeouts, and server-side refusal fallbacks (`fallbacks: "default"`), since security topics can occasionally trip safety classifiers.
- In hosted mode the browser calls `supabase/functions/ai`, which checks the session, MFA, role, rate limit and monthly quota before calling Claude, then records token usage.

## Code map

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `styles.css` | App shell, dashboard, risk register, AI analyst, settings |
| `auth.js` | Sign-in, sign-up, password reset, MFA enrolment and challenge, workspace selection, idle timeout |
| `store.js` | Saves risks and vendors to `localStorage` or Supabase (diff-based), and sanitises records |
| `workspace.js` | Members, roles, invitations, AI usage, audit log |
| `ai.js`, `ai-tasks.js` | AI clients (cloud and demo) and the shared task definitions |
| `vendors.js`, `intake*.{html,js}`, `intake-questions.js`, `autofill.js` | Vendor risk, intake questionnaire, document fill |
| `report.js` | Executive briefing |
| `vendor/` | Pinned third-party libraries (see `vendor/README.md`) |
| `_headers`, `.well-known/security.txt` | Security headers and vulnerability contact for production hosting |
| `supabase/` | Database migrations, security tests, AI server function |

## Privacy and security notes

- **Hosted mode:** see [`SECURITY.md`](SECURITY.md). In short: mandatory MFA, row-level security enforcing workspace isolation and roles, an append-only audit log, the AI key kept server-side, a strict Content Security Policy and pinned dependencies.
- **Demo mode:** risks and vendors stay in this browser's `localStorage`, and AI features send the register to `api.anthropic.com` with your own key. The key is kept in `sessionStorage` by default, or `localStorage` if you tick “Remember”. Use a dedicated key with a spend limit and avoid shared machines. Don't use demo mode for real customer data.
