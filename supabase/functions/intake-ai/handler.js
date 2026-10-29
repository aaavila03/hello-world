// Request handling for the vendor-facing questionnaire function. A vendor has no
// account, so instead of a session every request carries the invite token from
// the intake link. The token is tied to one vendor in one organisation and lets
// the vendor's form:
//   load            open the questionnaire (their saved response, or the
//                   requester's answers to start from) and any follow-up questions
//   save / submit   save their response (submit marks it as sent to the requester)
//   addDocument / removeDocument   manage their supporting documents
//   fill            ask Claude to suggest answers from those documents (a few runs
//                   per invite, within the organisation's monthly AI allowance)
// Dependencies are injected so this file can be unit-tested.
import { buildRequest, messageText, toDocumentBlocks, TaskInputError, INPUT_LIMITS } from "../_shared/ai-tasks.js";

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN = /^[0-9a-f]{64}$/;
const ACTIONS = ["load", "save", "submit", "addDocument", "removeDocument", "fill"];

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
    const action = body?.action || "fill";
    if (!ACTIONS.includes(action)) return json({ error: "Invalid request." }, 400, origin);
    if (typeof body.invite !== "string" || !TOKEN.test(body.invite)) return json({ error: "This link isn't valid. Ask your contact for a new one." }, 401, origin);

    const invite = await deps.findInvite(await sha256Hex(body.invite));
    if (!invite) return json({ error: "This link has expired or isn't valid. Ask your contact for a new one." }, 401, origin);
    if (!invite.vendorRef) return json({ error: "This link isn't tied to a vendor. Ask your contact for a new one." }, 400, origin);
    const { orgId, vendorRef } = invite;

    try {
      if (action === "load") return json(await deps.loadIntake(orgId, vendorRef), 200, origin);

      if (action === "save" || action === "submit") {
        const r = body.response;
        if (!r || typeof r !== "object" || Array.isArray(r)) return json({ error: "Invalid response." }, 400, origin);
        if (new TextEncoder().encode(JSON.stringify(r)).byteLength > MAX_RESPONSE_BYTES) return json({ error: "Your response is too large to save." }, 413, origin);
        const saved = await deps.saveResponse(orgId, vendorRef, r, action === "submit");
        return json(saved, 200, origin);
      }

      if (action === "addDocument") {
        const d = body.document;
        try { toDocumentBlocks([d]); } catch (err) { if (err instanceof TaskInputError) return json({ error: err.message }, 400, origin); throw err; }
        const size = (d.data.length * 3) / 4 - (d.data.match(/=*$/)[0].length);
        const added = await deps.addDocument(orgId, vendorRef, { name: d.name.slice(0, 200), mediaType: d.mediaType, size, data: d.data },
          { maxFiles: INPUT_LIMITS.maxFiles, maxBytes: INPUT_LIMITS.maxBytes });
        if (!added) return json({ error: `You can store up to ${INPUT_LIMITS.maxFiles} documents, 20 MB in total.` }, 409, origin);
        return json({ documents: await deps.listDocuments(orgId, vendorRef) }, 200, origin);
      }

      if (action === "removeDocument") {
        if (typeof body.name !== "string") return json({ error: "Invalid request." }, 400, origin);
        await deps.removeDocument(orgId, vendorRef, body.name);
        return json({ documents: await deps.listDocuments(orgId, vendorRef) }, 200, origin);
      }

      // fill: Claude suggests answers from the vendor's stored documents.
      const documents = await deps.getDocuments(orgId, vendorRef);
      if (!documents.length) return json({ error: "Attach at least one document first." }, 400, origin);
      let params;
      try {
        params = buildRequest("fill_documents", { documents, prompt: body.prompt }, { model: deps.env.MODEL || "claude-opus-5-5", effort: deps.env.EFFORT || "medium" });
      } catch (err) {
        if (err instanceof TaskInputError) return json({ error: err.message }, 400, origin);
        throw err;
      }
      const run = await deps.useAiRun(invite.id);
      if (!run) return json({ error: "This link has used its AI help. You can still answer the questions yourself." }, 429, origin);
      const quota = await deps.getQuota(orgId);
      if (!quota || quota.used >= quota.limit) return json({ error: "AI help isn't available right now. You can still answer the questions yourself." }, 429, origin);
      let message;
      try {
        message = await deps.anthropic.beta.messages.stream(params).finalMessage();
      } catch (err) {
        await deps.refundAiRun(invite.id).catch(() => {}); // a failed call doesn't use up the vendor's runs
        throw err;
      }
      await deps.recordUsage({
        org_id: orgId, user_id: null, task: "fill_documents_vendor",
        model: message?.model || params.model,
        input_tokens: message?.usage?.input_tokens || 0, output_tokens: message?.usage?.output_tokens || 0,
      }).catch((e) => deps.log?.("usage record failed", e?.message));
      return json({ result: JSON.parse(messageText(message)), runsLeft: run.runsLeft }, 200, origin);
    } catch (err) {
      if (err instanceof TaskInputError) return json({ error: err.message }, 422, origin);
      if (err?.status === 404) return json({ error: err.message }, 404, origin);
      deps.log?.("intake error", action, err?.status, err?.message);
      if (err?.status === 400) return json({ error: "The documents could not be processed. Check they are readable PDF, Excel or text files." }, 400, origin);
      return json({ error: "Something went wrong. Please try again later." }, err?.status === 429 ? 503 : 502, origin);
    }
  };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
