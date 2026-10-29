// Supabase Edge Function: the vendor-facing questionnaire. A vendor, who has no
// account, opens the intake link; this function loads and saves their response
// and documents in the inviting organisation's workspace and lets Claude suggest
// answers from their documents (see the intake_invites and intake_responses
// migrations and handler.js).
//
// Deployed without gateway JWT verification (supabase/config.toml): requests
// carry an invite token instead of a session, which handler.js checks.
// Secrets: ANTHROPIC_API_KEY, ALLOWED_ORIGINS (shared with the ai function).
// Optional: AI_MODEL, AI_EFFORT. Provided by Supabase: SUPABASE_DB_URL.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import postgres from "npm:postgres@3.4.9";
import { createIntakeHandler } from "./handler.js";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

const listDocuments = (orgId: string, vendorRef: string) => sql`
  select name, media_type as "mediaType", size, created_at as "createdAt" from public.intake_documents
  where org_id = ${orgId} and vendor_ref = ${vendorRef} order by created_at`;

const handler = createIntakeHandler({
  env: {
    ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") ?? "",
    MODEL: Deno.env.get("AI_MODEL") ?? "claude-opus-5-5",
    EFFORT: Deno.env.get("AI_EFFORT") ?? "medium",
  },
  anthropic: new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") }),

  async findInvite(tokenHash: string) {
    const [row] = await sql`
      select id, org_id, vendor_ref from public.intake_invites
      where token_hash = ${tokenHash} and expires_at > now()`;
    return row ? { id: row.id, orgId: row.org_id, vendorRef: row.vendor_ref } : null;
  },

  // Atomically uses one of the invite's AI runs.
  async useAiRun(inviteId: string) {
    const [row] = await sql`
      update public.intake_invites set ai_uses = ai_uses + 1
      where id = ${inviteId} and ai_uses < ai_limit
      returning ai_limit - ai_uses as runs_left`;
    return row ? { runsLeft: row.runs_left } : null;
  },

  async refundAiRun(inviteId: string) {
    await sql`update public.intake_invites set ai_uses = greatest(ai_uses - 1, 0) where id = ${inviteId}`;
  },

  // The questionnaire as the vendor should see it: their own saved response, or
  // the requester's answers to start from, plus the requester's follow-up questions.
  async loadIntake(orgId: string, vendorRef: string) {
    const [vendor] = await sql`
      select v.data, o.name as org_name from public.vendors v join public.organizations o on o.id = v.org_id
      where v.org_id = ${orgId} and v.display_id = ${vendorRef}`;
    if (!vendor) throw Object.assign(new Error("This questionnaire is no longer available."), { status: 404 });
    const [saved] = await sql`
      select response, status, updated_at, submitted_at from public.intake_responses
      where org_id = ${orgId} and vendor_ref = ${vendorRef}`;
    const intake = vendor.data?.intake || {};
    return {
      vendorName: vendor.data?.name || "",
      requester: vendor.org_name,
      modules: vendor.data?.intakeModules ? [vendor.data.intakeModules] : [],
      response: saved?.response ?? null,
      status: saved?.status ?? null,
      updatedAt: saved?.updated_at ?? null,
      submittedAt: saved?.submitted_at ?? null,
      seed: { profile: intake.profile || {}, answers: intake.answers || {} },
      followups: intake.followups || {},
      documents: await listDocuments(orgId, vendorRef),
    };
  },

  async saveResponse(orgId: string, vendorRef: string, response: Record<string, unknown>, submit: boolean) {
    const [row] = await sql`
      insert into public.intake_responses (org_id, vendor_ref, response, status, updated_at, submitted_at)
      values (${orgId}, ${vendorRef}, ${sql.json(response)}, ${submit ? "submitted" : "draft"}, now(), ${submit ? sql`now()` : null})
      on conflict (org_id, vendor_ref) do update set
        response = excluded.response,
        status = excluded.status,
        updated_at = now(),
        submitted_at = coalesce(excluded.submitted_at, public.intake_responses.submitted_at)
      returning status, updated_at, submitted_at`;
    if (submit) {
      const email = String((response.profile as Record<string, unknown>)?.contactEmail ?? "").slice(0, 254) || null;
      await sql`
        insert into public.audit_log (org_id, actor, actor_email, action, entity, entity_id)
        values (${orgId}, null, ${email}, 'submit', 'intake_responses', ${vendorRef})`;
    }
    return { status: row.status, updatedAt: row.updated_at, submittedAt: row.submitted_at };
  },

  // Adds or replaces a document if the vendor stays within the file count and size limits.
  async addDocument(orgId: string, vendorRef: string, d: { name: string; mediaType: string; size: number; data: string }, limits: { maxFiles: number; maxBytes: number }) {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${orgId + vendorRef}))`;
      const [usage] = await tx`
        select count(*)::int as files, coalesce(sum(size), 0)::bigint as bytes from public.intake_documents
        where org_id = ${orgId} and vendor_ref = ${vendorRef} and name <> ${d.name}`;
      if (usage.files >= limits.maxFiles || Number(usage.bytes) + d.size > limits.maxBytes) return false;
      await tx`
        insert into public.intake_documents (org_id, vendor_ref, name, media_type, size, data)
        values (${orgId}, ${vendorRef}, ${d.name}, ${d.mediaType}, ${d.size}, ${d.data})
        on conflict (org_id, vendor_ref, name) do update set media_type = excluded.media_type, size = excluded.size, data = excluded.data, created_at = now()`;
      return true;
    });
  },

  async removeDocument(orgId: string, vendorRef: string, name: string) {
    await sql`delete from public.intake_documents where org_id = ${orgId} and vendor_ref = ${vendorRef} and name = ${name}`;
  },

  listDocuments,

  async getDocuments(orgId: string, vendorRef: string) {
    return await sql`
      select name, media_type as "mediaType", data from public.intake_documents
      where org_id = ${orgId} and vendor_ref = ${vendorRef} order by created_at`;
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
