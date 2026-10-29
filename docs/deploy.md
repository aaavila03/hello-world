# Deploying Posture.ai as a hosted service

> New to this? Follow the beginner-friendly, click-by-click version for Mac instead: [deploy-step-by-step-mac.md](deploy-step-by-step-mac.md).

This sets up Posture.ai for multiple customers with sign-in, MFA, isolated workspaces and server-side AI. It takes about an hour. You need accounts with [Supabase](https://supabase.com), [Cloudflare](https://dash.cloudflare.com/sign-up) and [Anthropic](https://platform.claude.com).

Without these steps the app runs in **demo mode** (data in the browser, your own API key), which is fine for trying it out but not for customers.

## 1. Create the Supabase project

1. In Supabase, create a project. Choose the **region** your customers need (e.g. EU for European customers) and a strong database password. Use the **Pro** plan for production (daily backups, no pausing; add point-in-time recovery).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) and link the project:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```
3. Apply the database schema (tables, row-level security, roles, audit log):
   ```bash
   supabase db push
   ```

## 2. Configure authentication

In the Supabase dashboard under **Authentication**, match the settings in `supabase/config.toml`:

- **Sign In / Providers → Email:** enabled, **Confirm email** on, **Secure password change** on. Disable providers you don't use.
- **Passwords:** minimum length 12, require lowercase, uppercase, digits and symbols. Turn on leaked-password protection if your plan offers it.
- **Multi-Factor:** TOTP enabled (enrol and verify). The app requires it for every user.
- **Sessions:** access token expiry 3600 seconds, refresh token rotation on.
- **URL configuration:** set **Site URL** to your app's address (e.g. `https://app.yourcompany.com`) and add it to the redirect allow-list. Remove `localhost` entries in production.
- **Emails:** set up custom SMTP (Authentication → Emails → SMTP settings) so confirmation and reset emails come from your domain and aren't rate-limited. Brand the templates.

## 3. Deploy the AI function

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGINS=https://app.yourcompany.com
supabase functions deploy ai --use-api
```

Optional: `AI_MODEL` (default `claude-opus-5-5`) and `AI_EFFORT` (default `medium`).

In the Anthropic Console, create a **dedicated API key** for production and set a **monthly spend limit**. Each workspace's monthly AI allowance is the `ai_monthly_limit` column on `organizations` (default 300 requests). Change it per customer in the Supabase table editor or SQL editor, for example when they upgrade their plan.

## 4. Point the app at Supabase

In `config.js`, set your project's URL and **publishable** key from **Project Settings → API Keys** (it starts with `sb_publishable_`; older projects can use the legacy **anon** key instead):

```js
export const SUPABASE_URL = "https://<project-ref>.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_...";
```

The publishable key is meant to be public: it can only do what the row-level security policies allow. **Never put a secret (`sb_secret_…`) or service-role key in the app.**

If you use a custom Supabase domain, add it to `connect-src` in `_headers` and in the Content-Security-Policy meta tag in `index.html`.

## 5. Host on Cloudflare

1. In Cloudflare, go to **Workers & Pages → Create → Import a repository** and pick this repository. Leave the build command empty; the deploy command is `npx wrangler deploy`.
2. The repository's `wrangler.jsonc` publishes the root folder as static assets with the security headers from `_headers`. `.assetsignore` keeps `supabase/`, `docs/`, `.github/` and Markdown files off the website. (A Cloudflare Pages project also works: no build command, output directory empty; `_headers` applies there too, but `.assetsignore` doesn't.)
3. Deploy, then add your custom domain (e.g. `app.yourcompany.com`) under **Settings → Domains & Routes**.
4. Check the security headers from `_headers` are being sent, e.g. with `curl -I https://app.yourcompany.com` or [securityheaders.com](https://securityheaders.com).

Then turn off GitHub Pages for the repository (Settings → Pages) so there's only one public copy of the app, and update `.well-known/security.txt` with your security contact.

## 6. Go-live checklist

- [ ] Sign up, enrol MFA, create a workspace, invite a colleague as Viewer and confirm they can't edit.
- [ ] Generate a briefing and run an AI assessment; check usage appears under Settings → Workspace.
- [ ] Confirm `ALLOWED_ORIGINS` contains only your production domain.
- [ ] Spend limit set in the Anthropic Console; point-in-time recovery enabled in Supabase.
- [ ] Custom SMTP configured; `localhost` removed from redirect URLs.
- [ ] Security contact updated in `security.txt` and `SECURITY.md`.
- [ ] GitHub Pages disabled; branch protection on `master` requiring the **Security tests** workflow.
- [ ] Privacy policy, terms of service and a data processing agreement ready for customers (legal advice recommended).

## Running the tests

```bash
# Database security tests: needs a local PostgreSQL 16 you can create databases on
PGHOST=localhost PGUSER=postgres supabase/tests/run.sh

# AI function tests and shared-code check
node --test supabase/functions/ai/handler.test.js
supabase/tests/check-shared.sh

# Vendor questionnaire logic
node --test tests/intake-questions.test.js
```

These also run automatically in GitHub Actions (`.github/workflows/security-tests.yml`).

## Changing the AI task definitions

Edit `ai-tasks.js`, copy it to `supabase/functions/_shared/ai-tasks.js`, and redeploy the function (`supabase functions deploy ai`). CI fails if the two copies differ.
