// Request handling for the vendor-facing AI function. A vendor has no account,
// so instead of a session it presents the invite token from the intake link.
// The token only allows "fill_documents" (suggest questionnaire answers from the
// vendor's own documents), a few times per invite, within the inviting
// organisation's monthly AI allowance. Dependencies are injected for testing.
import { buildRequest, messageText, TaskInputError } from "../_shared/ai-tasks.js";

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{64}$/;

export function createIntakeHandler(deps) {
  const allowed = (deps.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

  function corsHeaders(origin) {
    return allowed.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
  }

  function json(body, status, origin) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(origin) },
    });
  }

  return async function handle(request) {
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") {
      if (!allowed.includes(origin)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, apikey, x-client-info",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    // Browsers always send Origin on cross-site POSTs; requiring it keeps scripts elsewhere out.
    if (!allowed.includes(origin)) return json({ error: "Origin not allowed" }, 403, null);
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400, origin); }
    if (typeof body?.invite !== "string" || !TOKEN.test(body.invite)) return json({ error: "This link can't use AI help." }, 401, origin);

    // Validate the documents and prompt before spending one of the invite's runs.
    let params;
    try {
      params = buildRequest("fill_documents", body.input, { model: deps.env.MODEL || "claude-opus-5-5", effort: deps.env.EFFORT || "medium" });
    } catch (err) {
      if (err instanceof TaskInputError) return json({ error: err.message }, 400, origin);
      throw err;
    }

    // Uses one run if the invite is valid, unexpired and has runs left.
    const invite = await deps.redeemInvite(await sha256Hex(body.invite));
    if (!invite) return json({ error: "This link can't use AI help any more: it may have expired or used its allowance. You can still answer the questions yourself." }, 401, origin);
    const quota = await deps.getQuota(invite.orgId);
    if (!quota || quota.used >= quota.limit) return json({ error: "AI help isn't available right now. You can still answer the questions yourself." }, 429, origin);

    try {
      const message = await deps.anthropic.beta.messages.stream(params).finalMessage();
      await deps.recordUsage({
        org_id: invite.orgId, user_id: null, task: "fill_documents_vendor",
        model: message?.model || params.model,
        input_tokens: message?.usage?.input_tokens || 0, output_tokens: message?.usage?.output_tokens || 0,
      }).catch((e) => deps.log?.("usage record failed", e?.message));
      return json({ result: JSON.parse(messageText(message)), runsLeft: invite.runsLeft }, 200, origin);
    } catch (err) {
      if (err instanceof TaskInputError) return json({ error: err.message }, 422, origin);
      deps.log?.("AI error", err?.status, err?.message);
      if (err?.status === 400) return json({ error: "The documents could not be processed. Check they are readable PDF, Excel or text files." }, 400, origin);
      return json({ error: "The AI service is unavailable. Please try again later." }, err?.status === 429 ? 503 : 502, origin);
    }
  };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
