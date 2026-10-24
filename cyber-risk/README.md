# RiskPilot – AI cyber risk manager

A browser-only cyber risk management app with Claude-powered analysis. No build step or server: it runs on GitHub Pages (or any static host) at `/cyber-risk/`.

## Features

- **Dashboard** – KPIs (active, critical, high, average inherent/residual score, overdue actions), a clickable 5×5 likelihood × impact heat map, top risks and a category breakdown.
- **Risk register** – add, edit, delete, search, filter and sort risks; inherent and residual scoring; owner, status, treatment, controls and due date. Export to CSV/JSON and import from JSON.
- **✨ AI assess** – in the risk editor, Claude scores likelihood/impact, suggests a category, writes threat scenarios, and recommends prioritised controls mapped to NIST CSF 2.0 functions, plus an estimated residual score. One click applies it to the form.
- **Executive report** – a streamed, board-level summary of the whole register.
- **Ask the analyst** – a chat assistant that answers questions with your register as context.
- **Offline mode** – without an API key, a keyword-based heuristic still gives a baseline assessment.

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

- Risks are stored in your browser's `localStorage`; nothing is sent anywhere except to `api.anthropic.com` when you use an AI feature (the register is included as context for reports and chat).
- The API key is kept in `sessionStorage` by default, or `localStorage` if you tick “Remember”. Calling the API from the browser exposes the key to anyone with access to that browser, so use a dedicated key with a spend limit and avoid shared machines. For a multi-user deployment, move the AI calls behind a small backend that holds the key.
