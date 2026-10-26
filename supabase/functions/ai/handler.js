// Request handling for the server-side AI function. Dependencies (auth checks,
// database lookups, the Anthropic client) are injected so this file has no
// platform-specific imports and can be unit-tested.
import { TASKS, buildRequest, messageText, TaskInputError } from "../_shared/ai-tasks.js";

const RANK = { viewer: 1, analyst: 2, admin: 3, owner: 4 };
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const PER_USER_PER_MINUTE = 10;

export function createHandler(deps) {
  const allowed = (deps.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

  function corsHeaders(origin) {
    return allowed.includes(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin" }
      : {};
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
          "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (origin && !allowed.includes(origin)) return json({ error: "Origin not allowed" }, 403, null);
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413, origin);

    // Authentication: a valid session that has completed MFA.
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const user = token ? await deps.verifyUser(token) : null;
    if (!user) return json({ error: "Please sign in again." }, 401, origin);
    if (user.aal !== "aal2") return json({ error: "Multi-factor authentication is required." }, 403, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400, origin); }
    const task = TASKS[body?.task];
    if (!task || typeof body.orgId !== "string") return json({ error: "Invalid request." }, 400, origin);

    // Authorisation: membership of the workspace with a sufficient role (also enforced by RLS).
    const role = await deps.getRole(token, body.orgId);
    if (!role || RANK[role] < RANK[task.minRole]) return json({ error: "You don't have permission to do that." }, 403, origin);

    // Abuse and cost controls.
    if ((await deps.recentUserCalls(user.id)) >= PER_USER_PER_MINUTE) {
      return json({ error: "Too many AI requests. Please wait a minute." }, 429, origin);
    }
    const quota = await deps.getQuota(token, body.orgId);
    if (!quota || quota.used >= quota.limit) {
      return json({ error: "Your workspace has used its AI allowance for this month." }, 429, origin);
    }

    let params;
    try {
      params = buildRequest(body.task, body.input, { model: deps.env.MODEL || "claude-opus-5-5", effort: deps.env.EFFORT || "medium" });
    } catch (err) {
      if (err instanceof TaskInputError) return json({ error: err.message }, 400, origin);
      throw err;
    }

    const record = (message) => deps.recordUsage({
      org_id: body.orgId,
      user_id: user.id,
      task: body.task,
      model: message?.model || params.model,
      input_tokens: message?.usage?.input_tokens || 0,
      output_tokens: message?.usage?.output_tokens || 0,
    }).catch((e) => deps.log?.("usage record failed", e?.message));

    if (task.chat) return streamChat(params, record, origin);

    try {
      const message = await deps.anthropic.beta.messages.stream(params).finalMessage();
      await record(message);
      return json({ result: JSON.parse(messageText(message)) }, 200, origin);
    } catch (err) {
      return upstreamError(err, origin);
    }
  };

  // Chat replies stream as newline-delimited JSON: {"text": "..."} chunks, then {"done": true} or {"error": "..."}.
  function streamChat(params, record, origin) {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        try {
          const stream = deps.anthropic.beta.messages.stream(params);
          stream.on("text", (text) => send({ text }));
          const message = await stream.finalMessage();
          await record(message);
          messageText(message);
          send({ done: true });
        } catch (err) {
          send({ error: safeMessage(err) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", ...corsHeaders(origin) },
    });
  }

  function safeMessage(err) {
    if (err instanceof TaskInputError) return err.message;
    if (err?.status === 429) return "The AI service is busy. Please try again shortly.";
    if (err?.status === 400) return "The request could not be processed. Check any documents are readable PDF or text files.";
    deps.log?.("AI error", err?.status, err?.message);
    return "The AI service is unavailable. Please try again later.";
  }

  function upstreamError(err, origin) {
    const status = err instanceof TaskInputError ? 422 : err?.status === 429 ? 503 : err?.status === 400 ? 400 : 502;
    return json({ error: safeMessage(err) }, status, origin);
  }
}
