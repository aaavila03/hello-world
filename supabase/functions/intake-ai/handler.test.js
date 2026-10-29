// Unit tests for the vendor questionnaire function: node --test supabase/functions/intake-ai/handler.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntakeHandler, sha256Hex } from "./handler.js";

const ORIGIN = "https://app.posture.example";
const ORG = "11111111-1111-1111-1111-111111111111";
const TOKEN = "a".repeat(64);
const doc = { name: "soc2.txt", mediaType: "text/plain", data: btoa("We use MFA everywhere.") };
const fill = { answers: [{ id: "GOV1", answer: "Yes", comment: "", evidence: "MFA", document: "soc2.txt" }], profile: { certifications: [], certificationDetails: "", hosting: "", dataLocations: "", subprocessors: "" }, summary: "ok" };

function setup(over = {}) {
  const log = { usage: [], looked: [], saved: [], added: [], removed: [], runs: [], calls: [] };
  const handler = createIntakeHandler({
    env: { ALLOWED_ORIGINS: ORIGIN, MODEL: "claude-opus-5-5", EFFORT: "medium" },
    anthropic: { beta: { messages: { stream(params) {
      log.calls.push(params);
      return { async finalMessage() {
        if (over.fail) throw over.fail;
        return { model: params.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(fill) }], usage: { input_tokens: 10, output_tokens: 5 } };
      } };
    } } } },
    findInvite: async (hash) => { log.looked.push(hash); return "invite" in over ? over.invite : { id: "i1", orgId: ORG, vendorRef: "V-001" }; },
    useAiRun: async (id) => { log.runs.push(id); return "run" in over ? over.run : { runsLeft: 4 }; },
    refundAiRun: async (id) => { log.refunds = [...(log.refunds || []), id]; },
    loadIntake: async (org, ref) => { if (over.gone) throw Object.assign(new Error("This questionnaire is no longer available."), { status: 404 }); return { vendorName: "Acme", org, ref, documents: [] }; },
    saveResponse: async (org, ref, r, submit) => { log.saved.push({ org, ref, r, submit }); return { status: submit ? "submitted" : "draft" }; },
    addDocument: async (org, ref, d, limits) => { log.added.push({ d, limits }); return over.full ? false : true; },
    removeDocument: async (org, ref, name) => { log.removed.push(name); },
    listDocuments: async () => [{ name: "soc2.txt" }],
    getDocuments: async () => over.docs ?? [doc],
    getQuota: async () => over.quota ?? { used: 0, limit: 100 },
    recordUsage: async (row) => { log.usage.push(row); },
  });
  return { handler, log };
}

const req = (body, { origin = ORIGIN } = {}) => new Request("https://fn.example/intake-ai", {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ invite: TOKEN, ...body }),
});

test("only allowed origins, and Origin is required", async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request("https://fn/x", { method: "OPTIONS", headers: { origin: ORIGIN } }))).status, 204);
  assert.equal((await handler(new Request("https://fn/x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }))).status, 403);
  assert.equal((await handler(req({ action: "load" }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await handler(req({ action: "load" }, { origin: "" }))).status, 403);
});

test("rejects malformed, unknown or expired invites, links without a vendor, and unknown actions", async () => {
  assert.equal((await setup().handler(req({ action: "load", invite: "short" }))).status, 401);
  assert.equal((await setup({ invite: null }).handler(req({ action: "load" }))).status, 401);
  assert.equal((await setup({ invite: { id: "i", orgId: ORG, vendorRef: "" } }).handler(req({ action: "load" }))).status, 400);
  assert.equal((await setup().handler(req({ action: "dropTables" }))).status, 400);
});

test("load looks the invite up by hash and returns the vendor's questionnaire", async () => {
  const { handler, log } = setup();
  const res = await handler(req({ action: "load" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ref, "V-001");
  assert.deepEqual(log.looked, [await sha256Hex(TOKEN)]);
  assert.equal((await setup({ gone: true }).handler(req({ action: "load" }))).status, 404);
});

test("save and submit store the response for the invite's vendor only", async () => {
  const { handler, log } = setup();
  assert.equal((await handler(req({ action: "save", response: { answers: {} } }))).status, 200);
  assert.equal((await handler(req({ action: "submit", response: { answers: {} }, vendorRef: "V-999" }))).status, 200);
  assert.deepEqual(log.saved.map((s) => [s.ref, s.submit]), [["V-001", false], ["V-001", true]]);
  assert.equal((await handler(req({ action: "save", response: [1] }))).status, 400);
  assert.equal((await handler(req({ action: "save", response: { big: "x".repeat(1.1 * 1024 * 1024) } }))).status, 413);
});

test("documents are validated and limited", async () => {
  const { handler, log } = setup();
  assert.equal((await handler(req({ action: "addDocument", document: doc }))).status, 200);
  assert.equal(log.added[0].d.size, 22);
  assert.deepEqual(log.added[0].limits, { maxFiles: 5, maxBytes: 20 * 1024 * 1024 });
  assert.equal((await handler(req({ action: "addDocument", document: { ...doc, mediaType: "application/x-msdownload" } }))).status, 400);
  assert.equal((await setup({ full: true }).handler(req({ action: "addDocument", document: doc }))).status, 409);
  assert.equal((await handler(req({ action: "removeDocument", name: "soc2.txt" }))).status, 200);
  assert.deepEqual(log.removed, ["soc2.txt"]);
});

test("fill uses the stored documents, one AI run, and records usage", async () => {
  const { handler, log } = setup();
  const res = await handler(req({ action: "fill", prompt: "Answer GOV1" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.answers[0].id, "GOV1");
  assert.equal(body.runsLeft, 4);
  assert.equal(log.calls[0].messages[0].content[0].title, "soc2.txt");
  assert.deepEqual(log.runs, ["i1"]);
  assert.deepEqual([log.usage[0].org_id, log.usage[0].user_id, log.usage[0].task], [ORG, null, "fill_documents_vendor"]);
});

test("fill limits: no documents, bad prompt, no runs left, or allowance used", async () => {
  assert.equal((await setup({ docs: [] }).handler(req({ action: "fill", prompt: "x" }))).status, 400);
  const bad = setup();
  assert.equal((await bad.handler(req({ action: "fill", prompt: "" }))).status, 400);
  assert.equal(bad.log.runs.length, 0, "no run used for a bad request");
  assert.equal((await setup({ run: null }).handler(req({ action: "fill", prompt: "x" }))).status, 429);
  const broke = setup({ quota: { used: 300, limit: 300 } });
  assert.equal((await broke.handler(req({ action: "fill", prompt: "x" }))).status, 429);
  assert.equal(broke.log.calls.length, 0);
});

test("upstream failures return safe messages and give the run back", async () => {
  const { handler, log } = setup({ fail: Object.assign(new Error("secret detail"), { status: 500 }) });
  const res = await handler(req({ action: "fill", prompt: "x" }));
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /secret detail/);
  assert.deepEqual(log.refunds, ["i1"]);
});
