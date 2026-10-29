// Supabase Edge Function: lets a vendor, who has no account, ask Claude to fill
// intake questionnaire answers from their own documents, using an invite token
// from the intake link (see the intake_invites migration and handler.js).
//
// Deployed without gateway JWT verification (supabase/config.toml): requests
// carry an invite token instead of a session, which handler.js checks.
// Secrets: ANTHROPIC_API_KEY, ALLOWED_ORIGINS (shared with the ai function).
// Optional: AI_MODEL, AI_EFFORT. Provided by Supabase: SUPABASE_DB_URL.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import postgres from "npm:postgres@3.4.9";
import { createIntakeHandler } from "./handler.js";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

const handler = createIntakeHandler({
  env: {
    ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") ?? "",
    MODEL: Deno.env.get("AI_MODEL") ?? "claude-opus-5-5",
    EFFORT: Deno.env.get("AI_EFFORT") ?? "medium",
  },
  anthropic: new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") }),

  // Atomically uses one run of a valid invite.
  async redeemInvite(tokenHash: string) {
    const [row] = await sql`
      update public.intake_invites set ai_uses = ai_uses + 1
      where token_hash = ${tokenHash} and expires_at > now() and ai_uses < ai_limit
      returning org_id, ai_limit - ai_uses as runs_left`;
    return row ? { orgId: row.org_id, runsLeft: row.runs_left } : null;
  },

  async getQuota(orgId: string) {
    const [row] = await sql`
      select
        (select count(*)::int from public.ai_usage u where u.org_id = ${orgId} and u.at >= date_trunc('month', now())) as used,
        (select o.ai_monthly_limit from public.organizations o where o.id = ${orgId}) as monthly_limit`;
    return row?.monthly_limit == null ? null : { used: row.used, limit: row.monthly_limit };
  },

  async recordUsage(row: { org_id: string; user_id: null; task: string; model: string; input_tokens: number; output_tokens: number }) {
    await sql`
      insert into public.ai_usage (org_id, user_id, task, model, input_tokens, output_tokens)
      values (${row.org_id}, ${row.user_id}, ${row.task}, ${row.model}, ${row.input_tokens}, ${row.output_tokens})`;
  },

  log: (...args: unknown[]) => console.error(...args),
});

Deno.serve(handler);
