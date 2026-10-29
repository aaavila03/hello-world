// Unit tests for the vendor AI function: node --test supabase/functions/intake-ai/handler.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntakeHandler, sha256Hex } from "./handler.js";

const ORIGIN = "https://app.posture.example";
const ORG = "11111111-1111-1111-1111-111111111111";
const TOKEN = "a".repeat(64);
const doc = { name: "soc2.txt", mediaType: "text/plain", data: btoa("We use MFA everywhere.") };
const good = { invite: TOKEN, input: { documents: [doc], prompt: "Answer GOV1" } };
const fill = { answers: [{ id: "GOV1", answer: "Yes", comment: "", evidence: "MFA", document: "soc2.txt" }], profile: { certifications: [], certificationDetails: "", hosting: "", dataLocations: "", subprocessors: "" }, summary: "ok" };

function setup(over = {}) {
  const usage = [], redeemed = [], calls = [];
  const handler = createIntakeHandler({
    env: { ALLOWED_ORIGINS: ORIGIN, MODEL: "claude-opus-5-5", EFFORT: "medium" },
    anthropic: { beta: { messages: { stream(params) {
      calls.push(params);
      return { async finalMessage() {
        if (over.fail) throw over.fail;
        return { model: params.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(fill) }], usage: { input_tokens: 10, output_tokens: 5 } };
      } };
    } } } },
    redeemInvite: async (hash) => { redeemed.push(hash); return "invite" in over ? over.invite : { orgId: ORG, runsLeft: 4 }; },
    getQuota: async () => over.quota ?? { used: 0, limit: 100 },
    recordUsage: async (row) => { usage.push(row); },
  });
  return { handler, usage, redeemed, calls };
}

const req = (body, { origin = ORIGIN } = {}) => new Request("https://fn.example/intake-ai", {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});

test("only allowed origins, and Origin is required", async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request("https://fn/x", { method: "OPTIONS", headers: { origin: ORIGIN } }))).status, 204);
  assert.equal((await handler(new Request("https://fn/x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }))).status, 403);
  assert.equal((await handler(req(good, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await handler(req(good, { origin: "" }))).status, 403);
});

test("fills answers with a valid invite, by hash, and records usage", async () => {
  const { handler, usage, redeemed, calls } = setup();
  const res = await handler(req(good));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.answers[0].id, "GOV1");
  assert.equal(body.runsLeft, 4);
  assert.deepEqual(redeemed, [await sha256Hex(TOKEN)]);
  assert.equal(calls[0].output_config.format.type, "json_schema");
  assert.equal(usage[0].org_id, ORG);
  assert.equal(usage[0].user_id, null);
  assert.equal(usage[0].task, "fill_documents_vendor");
});

test("rejects malformed, unknown, expired or used-up invites", async () => {
  assert.equal((await setup().handler(req({ ...good, invite: "short" }))).status, 401);
  assert.equal((await setup().handler(req({ ...good, invite: undefined }))).status, 401);
  assert.equal((await setup({ invite: null }).handler(req(good))).status, 401);
});

test("bad input is rejected before an invite run is used", async () => {
  const { handler, redeemed } = setup();
  assert.equal((await handler(req({ invite: TOKEN, input: { documents: [], prompt: "x" } }))).status, 400);
  assert.equal((await handler(req({ invite: TOKEN, input: { documents: [{ ...doc, mediaType: "image/png" }], prompt: "x" } }))).status, 400);
  assert.equal(redeemed.length, 0);
});

test("respects the organisation's monthly AI allowance", async () => {
  const { handler, calls } = setup({ quota: { used: 300, limit: 300 } });
  assert.equal((await handler(req(good))).status, 429);
  assert.equal(calls.length, 0);
});

test("upstream failures return safe messages", async () => {
  const res = await setup({ fail: Object.assign(new Error("secret detail"), { status: 500 }) }).handler(req(good));
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /secret detail/);
});
