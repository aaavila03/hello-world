# RiskPilot intake auto-fill worker

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that lets vendors upload their security documentation on the intake questionnaire (`cyber-risk/intake.html`) and have Claude draft the answers.

It keeps your Anthropic API key server-side and only performs this one task: the questionnaire and prompt are fixed in the worker, so it can't be used as a general-purpose Claude proxy.

## What it does

`POST /autofill` with `{ documents: [{ name, mediaType, data (base64) }], accessCode?, vendorName? }`

- Accepts up to 5 PDF, TXT, Markdown or CSV files, 20 MB in total.
- Sends them to Claude (`claude-opus-5-5` by default) with the 84 intake questions, using structured outputs so every answer comes back as `Yes` / `No` / `N/A` / `Unknown` with a comment, a supporting quote and the source file name. It also extracts certifications, hosting, data locations and subprocessors.
- Returns that JSON to the questionnaire, which fills in unanswered questions and makes the vendor confirm each drafted answer before they can download their response.

`GET /health` returns `{ ok: true, accessCode: <whether a code is required> }`.

## Protections

- **Origin allowlist** – only pages on `ALLOWED_ORIGINS` (default `https://aaavila03.github.io`) can call it from a browser.
- **Rate limit** – 3 requests per minute per IP address (per Cloudflare location).
- **Optional access code** – set an `ACCESS_CODE` secret and enter the same value in RiskPilot → Settings → *Intake auto-fill access code*. Vendor links copied from RiskPilot then include it, and requests without it are refused. Recommended: it stops strangers who find the form from using your credit.
- **Input limits** – file count, size and type are checked before anything is sent to Claude. Documents are treated as untrusted data in the prompt.
- **Nothing is stored** by the worker. Errors returned to the browser never include upstream details.

**Also set a monthly spend limit** on the Anthropic workspace that owns the API key (Anthropic Console → Settings → Limits). Each auto-fill reads the vendor's whole document set, so a large SOC 2 report can cost roughly $0.50–$2 per run with Claude Opus 5.5.

## Deploy (about 10 minutes)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and an [Anthropic API key](https://console.anthropic.com/).

```bash
cd intake-worker
npm install
npx wrangler login                          # opens a browser to authorise Wrangler
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key when prompted
npx wrangler secret put ACCESS_CODE         # optional but recommended: any hard-to-guess string
npx wrangler deploy
```

`wrangler deploy` prints the worker URL, e.g. `https://riskpilot-intake.<your-subdomain>.workers.dev`. Then:

1. Put that URL in `cyber-risk/config.js`:
   ```js
   export const AUTOFILL_ENDPOINT = "https://riskpilot-intake.<your-subdomain>.workers.dev";
   ```
   and commit it (the URL is not a secret).
2. If you set an `ACCESS_CODE`, enter the same value in RiskPilot → **Settings** → *Intake auto-fill access code* and save.
3. Send vendors links with **Copy link for vendor** in the vendor editor. The questionnaire now shows *Optional: auto-fill from your documentation*.

Check it's running: `curl https://riskpilot-intake.<your-subdomain>.workers.dev/health`.

If you host RiskPilot somewhere other than `https://aaavila03.github.io`, change `ALLOWED_ORIGINS` in `wrangler.toml` (comma-separated) and deploy again. To use a different model, change `MODEL`.

## Development

```bash
npm test          # unit tests against a local mock of the Anthropic API
npx wrangler dev  # run locally; put ANTHROPIC_API_KEY=... in .dev.vars (git-ignored)
```
