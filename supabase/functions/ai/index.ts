// Supabase Edge Function: runs RiskPilot's AI tasks with the server-held
// Anthropic API key, on behalf of signed-in, MFA-verified workspace members.
//
// Secrets (supabase secrets set ...): ANTHROPIC_API_KEY, ALLOWED_ORIGINS
// Optional: AI_MODEL (default claude-opus-5-5), AI_EFFORT (default medium)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { createHandler } from "./handler.js";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const userClient = (token: string) =>
  createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });

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

  async verifyUser(token: string) {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email, aal: claims(token).aal };
  },

  // Runs as the user, so row-level security applies.
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
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true })
      .eq("user_id", userId).gte("at", since);
    return count ?? 0;
  },

  async recordUsage(row: Record<string, unknown>) {
    const { error } = await admin.from("ai_usage").insert(row);
    if (error) throw error;
  },

  log: (...args: unknown[]) => console.error(...args),
});

Deno.serve(handler);
