# Launching Posture.ai as a hosted service: a step-by-step guide for Mac

This guide assumes you've never done this before. Follow the steps in order. Plan for about **2 hours** the first time, mostly waiting for things to install or set up.

By the end you'll have:

- Posture.ai running at its own web address, with sign-in and two-factor authentication
- a database that keeps each customer company's data separate
- the AI features running on your server, so customers never need an API key

> **How to read the commands.** Grey boxes like this one are commands to paste into the Terminal app:
>
> ```bash
> echo "hello"
> ```
>
> Copy the whole line, paste it into Terminal, and press **Return**. Text in `<angle brackets>` is a placeholder: replace it, *including the brackets*, with your own value.

---

## What you'll sign up for

| Service | What it does for Posture.ai | Cost |
|---|---|---|
| **GitHub** (you already have it) | Stores the code | Free |
| **Supabase** | Sign-in, database and the server that runs the AI | Free to set up and test; **Pro plan, about $25/month**, before real customers use it (daily backups, no pausing) |
| **Cloudflare** | Hosts the website | Free |
| **Anthropic** | The Claude AI | Pay per use. Start with $10–$20 of credit |
| A domain name (optional) | e.g. `app.yourcompany.com` | About $10–$15/year |

Keep a **password manager** open (e.g. 1Password, Bitwarden, or Apple's Passwords app). You'll create several passwords and keys that you must save somewhere safe.

---

## Part 1: Get your Mac ready (about 20 minutes)

### 1.1 Open Terminal

1. Press **⌘ Command + Space** to open Spotlight.
2. Type `Terminal` and press **Return**.
3. A window with a blinking cursor opens. This is where you'll paste commands.

> When Terminal asks for your **password**, it's your Mac login password. **Nothing appears as you type**, not even dots. That's normal. Type it and press Return.

### 1.2 Install Homebrew (a tool that installs other tools)

Paste this and press Return:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

- Enter your Mac password when asked, and press Return when it says "Press RETURN to continue".
- If a window pops up asking to install **Command Line Developer Tools**, click **Install** and wait for it to finish.
- It takes 5–15 minutes. **At the end it prints "Next steps" with two or three commands.** Copy and run those exactly as shown. They usually look like this:

  ```bash
  echo >> ~/.zprofile
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  eval "$(/opt/homebrew/bin/brew shellenv)"
  ```

Check it worked:

```bash
brew --version
```

You should see something like `Homebrew 4.x.x`.

### 1.3 Install Git and the Supabase tool

```bash
brew install git supabase/tap/supabase
```

Check both worked:

```bash
git --version
supabase --version
```

Each should print a version number.

### 1.4 Download the Posture.ai code

This puts a copy of the project in your **Documents** folder:

```bash
cd ~/Documents
git clone https://github.com/aaavila03/posture.ai.git
cd posture.ai
```

> If you haven't renamed the repository yet, use `hello-world` instead of `posture.ai` in both places above.
>
> If Git asks for a username and password (because the repository is private), run `brew install gh` then `gh auth login`, choose **GitHub.com → HTTPS → Login with a web browser**, follow the prompts, then run `gh repo clone aaavila03/posture.ai` instead of the `git clone` line.

From now on, **every Terminal command in this guide must be run from inside this folder.** If you close Terminal and come back later, first run:

```bash
cd ~/Documents/posture.ai
```

---

## Part 2: Create your Anthropic API key (about 10 minutes)

This is what lets Posture.ai use Claude. It will live only on your server.

1. Go to **https://platform.claude.com** and sign up or sign in.
2. **Add credit:** open **Settings → Billing** and buy credit ($10–$20 is plenty to start).
3. **Set a spending cap:** open **Settings → Limits** and set a monthly limit (e.g. $50). This protects you from surprise bills.
4. **Create the key:** open **API Keys → Create Key**, name it `posture-production`, and click **Create**.
5. **Copy the key now** (it starts with `sk-ant-`) and save it in your password manager. **It's only shown once.**

> Never paste this key into the website files, an email, or a chat. Only into the Terminal command in Part 5.

---

## Part 3: Create the Supabase project (about 20 minutes)

### 3.1 Create the project

1. Go to **https://supabase.com** and click **Start your project**. Signing in with GitHub is easiest.
2. Create an **organization** if asked (use your company name) and pick a plan. The Free plan is fine while you set up; upgrade to **Pro** before real customers sign up.
3. Click **New project** and fill in:
   - **Name:** `posture-ai`
   - **Database password:** click **Generate a password**, then **copy it into your password manager**. You'll need it in step 3.2.
   - **Region:** choose the one closest to your customers (e.g. *East US*, *West EU (Ireland)*). **You can't change this later.** If your customers are in Europe, choose an EU region.
4. Click **Create new project** and wait 2–3 minutes until the dashboard says the project is ready.
5. Find your **Project ID** (also called the *project ref*). It's the random string in the browser's address bar after `/project/`, e.g. `abcdefghijklmnopqrst`. It's also under **Project Settings → General**. Copy it into your notes.

### 3.2 Connect your Mac to the project

In Terminal (inside the `posture.ai` folder):

```bash
supabase login
```

A browser window opens. Click to authorize, then return to Terminal.

```bash
supabase link --project-ref <your-project-id>
```

Paste your **database password** from step 3.1 when asked. Remember, nothing shows as you type or paste.

### 3.3 Create the database

This creates all the tables, security rules and the audit log:

```bash
supabase db push
```

It lists one migration file and asks to confirm. Type `Y` and press Return.

**Check:** in the Supabase dashboard, open **Table Editor**. You should see tables named `organizations`, `memberships`, `risks`, `vendors`, `audit_log` and so on.

### 3.4 Lock down sign-in settings

In the Supabase dashboard, open **Authentication** in the left sidebar. Menu names occasionally move; if you can't find one, use the search box at the top of the dashboard.

1. **Sign In / Providers → Email:**
   - **Enable Email provider:** on
   - **Confirm email:** on
   - **Secure email change** and **Secure password change:** on
   - Leave other providers (Google, Apple, phone…) off for now.
2. **Passwords** (sometimes under **Sign In / Providers** or **Policies**):
   - **Minimum password length:** `12`
   - **Password requirements:** lowercase, uppercase, digits **and** symbols
   - **Prevent use of leaked passwords:** on, if your plan offers it
3. **Multi-Factor:** make sure **TOTP (App Authenticator)** is **enabled**.
4. **Sessions:** leave **refresh token rotation** on. Access token expiry (JWT expiry) should be `3600`.
5. **Rate limits:** leave the defaults.

You'll set the **URL configuration** in Part 6, once you know your website's address.

### 3.5 Copy your project's public connection details

Open **Project Settings → API Keys** (or **Project Settings → API** on older dashboards) and copy two things into your notes:

- **Project URL:** looks like `https://abcdefghijklmnopqrst.supabase.co` (also shown under **Project Settings → Data API**)
- **Publishable key:** starts with `sb_publishable_`. If your project only shows *legacy* keys, use the **anon / public** key instead.

> These two are meant to be public, because the database's security rules protect the data. **Never** copy the *secret* key (`sb_secret_…`) or the *service_role* key anywhere.

---

## Part 4: Point the website at your database (about 5 minutes)

You'll make this edit on the GitHub website, so you don't need any coding tools.

1. Go to **https://github.com/aaavila03/posture.ai** and click the file **`config.js`**.
2. Click the **pencil icon** (✏️ "Edit this file") near the top right of the file.
3. Find these two lines and replace the text **between the quote marks** with **your own** Project URL and publishable key from step 3.5. Keep the quote marks and the semicolon at the end:

   ```js
   export const SUPABASE_URL = "<your Project URL>";
   export const SUPABASE_PUBLISHABLE_KEY = "<your publishable key>";
   ```

   For example, if your Project URL is `https://kqzvxyabcdmnopqrstuv.supabase.co`, the first line becomes:

   ```js
   export const SUPABASE_URL = "https://kqzvxyabcdmnopqrstuv.supabase.co";
   ```

   The publishable key is long (about 40+ characters) and starts with `sb_publishable_`. Paste the whole thing: **don't** leave `...` or any `< >` brackets in the file.

4. Click **Commit changes…**, keep the option **Commit directly to the master branch**, and click **Commit changes**.

> This switches the public site from demo mode to the real, signed-in version.

---

## Part 5: Put the website online with Cloudflare (about 15 minutes)

### 5.1 Create the site

1. Go to **https://dash.cloudflare.com/sign-up** and create a free account (or sign in).
2. In the left sidebar, open **Compute (Workers) → Workers & Pages** (on some accounts it's just **Workers & Pages**), then click **Create** (or **Create application**).
3. Choose **Import a repository** (it may say *Continue with GitHub*).
4. Sign in to GitHub when asked, and allow Cloudflare access to the **posture.ai** repository only.
5. Select **posture.ai** and fill in:
   - **Project name:** `posture-ai`
   - **Build command:** *leave empty*
   - **Deploy command:** `npx wrangler deploy` (usually already filled in)
   - Leave everything else as it is. The repository includes a `wrangler.jsonc` file that tells Cloudflare how to publish the site, and which folders to keep private.
6. Click **Deploy** (or **Create and deploy**) and wait for "Success".
7. Open the address Cloudflare shows. It looks like `https://posture-ai.<your-account-name>.workers.dev`. You should see the Posture.ai sign-in screen. **Don't create an account yet**: the server part isn't switched on until Part 6.

> Some accounts see a **Pages** option instead. That works too: choose **Connect to Git**, pick the repository, leave the build command and output directory empty, and your address will end in `.pages.dev`.

Write down your site address. The rest of this guide calls it **your site address**.

### 5.2 Turn off the old GitHub Pages copy

So there's only one public copy of the app:

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **None** (or click **Unpublish site**).

---

## Part 6: Switch on the AI server and finish settings (about 15 minutes)

### 6.1 Store your secrets on the server

In Terminal (in the `posture.ai` folder), replace both placeholders and run:

```bash
supabase secrets set ANTHROPIC_API_KEY=<your-sk-ant-key> ALLOWED_ORIGINS=<your-site-address>
```

For example, `ALLOWED_ORIGINS=https://posture-ai.yourname.workers.dev`. Use exactly your site address, starting with `https://`, with **no slash at the end**.

### 6.2 Deploy the AI function

```bash
supabase functions deploy ai --use-api
```

It should end with a message that the function was deployed. **Check:** in the Supabase dashboard, **Edge Functions** now lists `ai`.

### 6.3 Tell Supabase your site address

In the Supabase dashboard, open **Authentication → URL Configuration**:

- **Site URL:** your site address, e.g. `https://posture-ai.yourname.workers.dev`
- **Redirect URLs:** click **Add URL** and add your site address followed by `/**`, e.g. `https://posture-ai.yourname.workers.dev/**`

Click **Save**. Without this, the links in confirmation and password-reset emails won't work.

### 6.4 Test everything

1. Open your site address in **Chrome or Safari**.
2. Click **Create an account**, use your work email and a strong password (12+ characters with a symbol).
3. Open the confirmation email, click the link, then **sign in**.
4. **Set up two-factor authentication:** install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy, or the one built into 1Password), scan the QR code, and type in the 6-digit code.
5. **Create your workspace** with your company name. You're now its **Owner**.
6. Go to **Settings → Load sample data**, then **AI analyst → ✨ Generate briefing**. A briefing should appear within a minute.
7. **Test roles:** in **Settings → Workspace**, invite a second email address you own as a **Viewer**. Sign up with it in a private browser window and confirm you can see data but can't edit it.
8. Delete the sample data when you're done (**Settings → Delete all data**).

> **Confirmation emails not arriving?** Supabase's built-in email service only sends a handful of emails per hour and is meant for testing. Check your spam folder, wait a few minutes, and set up proper email (Part 7.2) before inviting customers.

---

## Part 7: Before your first real customer

### 7.1 Use your own domain (recommended)

1. Buy a domain if you don't have one (Cloudflare sells them under **Domain Registration**).
2. In Cloudflare, open **Workers & Pages → posture-ai → Settings → Domains & Routes → Add → Custom domain** (on Pages projects: **Custom domains → Set up a custom domain**), enter e.g. `app.yourcompany.com`, and follow the prompts.
3. Update the server to allow the new address. List both addresses, separated by a comma:

   ```bash
   supabase secrets set ALLOWED_ORIGINS=https://app.yourcompany.com,https://posture-ai.yourname.workers.dev
   ```

4. In **Supabase → Authentication → URL Configuration**, change **Site URL** to `https://app.yourcompany.com` and add `https://app.yourcompany.com/**` to **Redirect URLs**.

### 7.2 Send emails from your own domain

Set up an email-sending service (e.g. **Resend**, **Postmark** or **Amazon SES**). Each has a guide for Supabase. Then enter its details in **Supabase → Authentication → Emails → SMTP Settings**. While you're there, edit the **email templates** to use the Posture.ai name.

### 7.3 Turn on backups and upgrade

In Supabase, upgrade the project to **Pro**, then add **Point in Time Recovery** under **Project Settings → Add-ons** (or **Database → Backups**). This lets you restore data to any minute if something goes wrong.

### 7.4 Update your security contact

On GitHub, edit **`.well-known/security.txt`** (the same way you edited `config.js`) and replace `security@your-domain.example` with a real address, such as a `security@` mailbox on your domain. Make the same change in **`SECURITY.md`**.

### 7.5 Protect the main branch

On GitHub, open **Settings → Branches → Add branch protection rule** (or **Add classic branch protection rule**) for `master`. Tick **Require status checks to pass before merging** and select the two **Security tests** checks. This stops changes that break the security tests from going live.

### 7.6 Legal documents

Before charging customers you'll need a **privacy policy**, **terms of service** and a **data processing agreement**. A lawyer, or a service like Termly or iubenda as a starting point, can help. Give customers' security teams **`SECURITY.md`**; it describes your security controls and lists Supabase, Cloudflare and Anthropic as subprocessors.

---

## Everyday tasks

**Give a customer more AI requests.** Each workspace gets 300 AI requests per month by default. In Supabase, open **Table Editor → organizations**, find the customer's row, double-click **ai_monthly_limit**, change the number, and save.

**See what the AI server is doing.** In Supabase, open **Edge Functions → ai → Logs**.

**When the code is updated** (for example, after a pull request is merged):

- **The website** updates on its own: Cloudflare redeploys within a minute or two.
- **If the update changed files in `supabase/`**, run these in Terminal:

  ```bash
  cd ~/Documents/posture.ai
  git pull
  supabase db push
  supabase functions deploy ai --use-api
  ```

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `command not found: brew` | Run the "Next steps" commands from step 1.2, or close and reopen Terminal. |
| `command not found: supabase` | Run `brew install supabase/tap/supabase` again. |
| `supabase link` says the password is wrong | Reset it in Supabase under **Project Settings → Database → Reset database password**, then try again. |
| The site says **"Setup isn't finished"** | `config.js` still has example values or is missing the key. Redo Part 4 with your own Project URL and publishable key, wait two minutes, then hard-refresh with **⌘ Command + Shift + R**. |
| The site still shows demo mode (an *API key* box in Settings) | Check `config.js` on GitHub has your URL and key, wait two minutes for Cloudflare, then hard-refresh with **⌘ Command + Shift + R**. |
| "Incorrect email or password" right after signing up | You need to click the link in the confirmation email first. |
| AI says "Origin not allowed" or nothing happens | The address in `ALLOWED_ORIGINS` must match your site address exactly, starting with `https://` and with no slash at the end. Re-run step 6.1, then step 6.2. |
| AI says "Your workspace has used its AI allowance" | Raise `ai_monthly_limit` (see **Everyday tasks**). |
| AI says "The AI service is unavailable" | Check your Anthropic credit and spending limit, then look at **Edge Functions → ai → Logs**. |
| `functions deploy` mentions Docker | Make sure you included `--use-api` at the end of the command. |
| Someone lost their phone or authenticator app | After confirming who they are (e.g. a video call), open **Supabase → SQL Editor**, paste `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'person@company.com');` with their email, and click **Run**. They'll be asked to set up a new authenticator at their next sign-in. |

If you get stuck, copy the exact error message and ask for help.
