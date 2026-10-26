# RiskPilot security overview

This document describes how RiskPilot protects customer data. It is written for customers' security and procurement teams and reflects the controls implemented in this repository. Items marked **Planned** are on the roadmap and not yet in place.

To report a vulnerability, email the address in [`/.well-known/security.txt`](cyber-risk/.well-known/security.txt). We aim to acknowledge reports within two business days.

## Architecture

| Layer | Technology | Notes |
|---|---|---|
| Web app | Static HTML/JS served by Cloudflare Pages | No server-side rendering; all data access goes through authenticated APIs |
| Authentication | Supabase Auth | Email + password with mandatory TOTP multi-factor authentication |
| Database | Supabase PostgreSQL | Row-level security on every table; encrypted at rest (AES-256) by the provider |
| AI | Supabase Edge Function calling Anthropic's Claude API | The API key is a server-side secret; the browser never sees it |

All traffic is encrypted in transit with TLS 1.2+, and HSTS is enforced with preload.

## Identity and access

- **Mandatory MFA.** Every user must enrol an authenticator app. The database grants no access to any data unless the session has completed MFA (`aal2`); this is enforced in the row-level security policies themselves, not only in the user interface.
- **Password policy.** Minimum 12 characters with upper and lower case letters, digits and symbols. Email addresses must be verified. Sign-in, sign-up and verification endpoints are rate-limited. Password-reset responses don't reveal whether an account exists.
- **Sessions.** Access tokens expire after one hour; refresh tokens rotate and are single-use. Users are signed out automatically after 30 minutes of inactivity.
- **Role-based access control.** Each workspace member has one role:

  | Role | Permissions |
  |---|---|
  | Viewer | Read risks, vendors and briefings; use the AI analyst chat |
  | Analyst | + create, edit and delete risks and vendors; run AI assessments and document fill |
  | Admin | + invite and manage viewers and analysts; view the audit log and AI usage |
  | Owner | + manage admins and owners; rename the workspace; delete all workspace data |

  Role changes are made through database functions that enforce these rules: admins can't grant or remove admin or owner rights, and a workspace always keeps at least one owner.
- **Invitations** are tied to an email address, expire after 7 days and can only be accepted by a user whose email address is verified and who has completed MFA.

## Tenant isolation

Each customer organisation is a separate workspace. Every business record carries its workspace ID, and PostgreSQL row-level security restricts every read and write to members of that workspace. Records cannot be moved between workspaces, and authorship fields (`created_by`, `updated_by`, timestamps) are set by the database, not the client. Clients can only write the specific columns they need. Anonymous users have no table access at all.

These rules are verified by an automated suite of 59 tests (`supabase/tests/`) covering cross-tenant reads and writes, MFA enforcement, every role boundary, invitation handling, input limits and audit-log immutability. The suite runs on every change in GitHub Actions.

## Audit logging

Every create, update and delete of risks, vendors, members, invitations and workspace settings is recorded by database triggers with the time, user, action, record and the list of changed fields. The audit log is **append-only**: updates and deletes are rejected by the database even for its owner. Admins can view and export the log.

## AI and data handling

- AI requests go to a server-side function that verifies the user's session, MFA status and workspace role, applies a per-user rate limit and a monthly per-workspace quota, and records token usage.
- The function only runs a fixed set of tasks. Their system prompts, output schemas, models and token limits are defined server-side, so a user can't repurpose it as a general AI proxy or change the instructions.
- Uploaded vendor documents are validated (type, count, size), sent to Anthropic only to answer the request, and not stored by RiskPilot. Document content is treated as untrusted data in prompts.
- Under Anthropic's commercial terms, API inputs and outputs are not used to train models. Anthropic is a subprocessor (see below).
- Errors returned to users never include upstream details or secrets.

## Application security

- **Content Security Policy:** scripts only from RiskPilot's own origin (no third-party CDNs and no inline scripts), connections only to RiskPilot and its database, no plug-ins, frames or form posts elsewhere. Automated tests confirm that injected inline scripts, external scripts and data exfiltration attempts are blocked.
- **Clickjacking:** `frame-ancestors 'none'`, `X-Frame-Options: DENY`, plus a script guard for hosts that can't send headers.
- **Other headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and cross-origin opener and resource policies.
- **Output encoding:** all user- and AI-supplied text is HTML-escaped before display.
- **Input validation:** imported files and records are restricted to known fields, with length, size and count limits; the database enforces size limits and ID formats.
- **Supply chain:** third-party libraries are pinned to exact versions, served from RiskPilot's own origin, and checked against recorded SHA-256 hashes in CI. Neither library uses `eval`.

## Subprocessors

| Subprocessor | Purpose | Data |
|---|---|---|
| Supabase, Inc. | Authentication, database, server functions | Account details and all workspace data |
| Cloudflare, Inc. | Web hosting and content delivery | Request metadata (no customer content is stored) |
| Anthropic, PBC | AI analysis | Content sent with AI requests, processed transiently |

The hosting region is chosen when the Supabase project is created (for example EU or US) and should match customers' data-residency requirements.

## Backups and resilience

Supabase takes daily database backups; point-in-time recovery is available on paid plans and should be enabled for production. Customers can export their risks and vendors at any time as JSON or CSV, and the audit log as CSV.

## Roadmap (planned controls)

- **Planned:** SAML single sign-on for enterprise customers (Supabase SSO), with optional enforcement per workspace.
- **Planned:** vendor portal: vendors submit questionnaires and documents through expiring, single-use links instead of email, with documents stored encrypted per workspace.
- **Planned:** self-service workspace data deletion and account deletion.
- **Planned:** independent penetration test before general availability, then annually.
- **Planned:** SOC 2 Type I, followed by Type II.
- **Planned:** security monitoring and alerting on authentication anomalies and quota abuse.
