// Supabase Edge Function: runs Posture.ai's AI tasks with the server-held
// Anthropic API key, on behalf of signed-in, MFA-verified workspace members.
//
// Secrets (supabase secrets set ...): ANTHROPIC_API_KEY, ALLOWED_ORIGINS
// Optional: AI_MODEL (default claude-opus-5-5), AI_EFFORT (default medium)
// Provided by Supabase: SUPABASE_URL, SUPABASE_DB_URL and SUPABASE_PUBLISHABLE_KEYS
// (or the legacy SUPABASE_ANON_KEY on older projects).
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import postgres from "npm:postgres@3.4.9";
import { createHandler } from "./handler.js";

const url = Deno.env.get("SUPABASE_URL")!;

// The project's public key: the new publishable key, or the legacy anon key.
function publishableKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    if (keys.default) return keys.default;
  } catch { /* fall back to the legacy key */ }
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}
const publicKey = publishableKey();

// Server-side bookkeeping (usage records, rate limiting) goes straight to the
// database, so it doesn't depend on which API key format the project uses.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

// Acts as the signed-in user, so row-level security applies.
const userClient = (token: string) =>
  createClient(url, publicKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });

// Payload of a JWT that the auth server has already validated.
function claims(token: string): Record<string, unknown> {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
}

const handler = createHandler({
  env: {
    ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") ?? "",
    MODEL: Deno.env.get("AI_MODEL") ?? "claude-opus-5-5",
    EFFORT: Deno.env.get("AI_EFFORT") ?? "medium",
  },
  anthropic: new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") }),

  // Asks the auth server to validate the token (signature, expiry, revocation).
  async verifyUser(token: string) {
    const { data, error } = await userClient(token).auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email, aal: claims(token).aal };
  },

  async getRole(token: string, orgId: string) {
    const { data, error } = await userClient(token).rpc("my_organizations");
    if (error) return null;
    return data?.find((o: { org_id: string }) => o.org_id === orgId)?.role ?? null;
  },

  async getQuota(token: string, orgId: string) {
    const { data, error } = await userClient(token).rpc("ai_quota", { org: orgId });
    if (error || !data?.length) return null;
    return { used: data[0].used, limit: data[0].monthly_limit };
  },

  async recentUserCalls(userId: string) {
    const [row] = await sql`
      select count(*)::int as n from public.ai_usage
      where user_id = ${userId} and at > now() - interval '1 minute'`;
    return row.n;
  },

  async recordUsage(row: { org_id: string; user_id: string; task: string; model: string; input_tokens: number; output_tokens: number }) {
    await sql`
      insert into public.ai_usage (org_id, user_id, task, model, input_tokens, output_tokens)
      values (${row.org_id}, ${row.user_id}, ${row.task}, ${row.model}, ${row.input_tokens}, ${row.output_tokens})`;
  },

  log: (...args: unknown[]) => console.error(...args),
});

Deno.serve(handler);
