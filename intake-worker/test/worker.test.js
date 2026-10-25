import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { startMockAnthropic } from "./mock-anthropic.js";

const ORIGIN = "https://aaavila03.github.io";
let mock;
before(async () => { mock = await startMockAnthropic(); });
after(() => mock.server.close());

const env = (extra = {}) => ({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: mock.url, ALLOWED_ORIGINS: ORIGIN, MODEL: "claude-opus-5-5", ...extra });
const b64 = (s) => Buffer.from(s).toString("base64");
const doc = { name: "policy.txt", mediaType: "text/plain", data: b64("All admin access requires MFA.") };
const post = (body, { origin = ORIGIN } = {}) => new Request("https://w.example/autofill", {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});

test("CORS preflight is allowed only for configured origins", async () => {
  const ok = await worker.fetch(new Request("https://w.example/autofill", { method: "OPTIONS", headers: { origin: ORIGIN } }), env());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const bad = await worker.fetch(new Request("https://w.example/autofill", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env());
  assert.equal(bad.status, 403);
});

test("rejects other origins and unknown routes", async () => {
  assert.equal((await worker.fetch(post({ documents: [doc] }, { origin: "https://evil.example" }), env())).status, 403);
  assert.equal((await worker.fetch(new Request("https://w.example/v1/messages", { method: "POST", headers: { origin: ORIGIN } }), env())).status, 404);
});

test("enforces the access code when configured", async () => {
  const res = await worker.fetch(post({ documents: [doc], accessCode: "wrong" }), env({ ACCESS_CODE: "s3cret" }));
  assert.equal(res.status, 401);
  const ok = await worker.fetch(post({ documents: [doc], accessCode: "s3cret" }), env({ ACCESS_CODE: "s3cret" }));
  assert.equal(ok.status, 200);
});

test("validates documents", async () => {
  const cases = [
    [{ documents: [] }, /at least one/],
    [{ documents: Array(6).fill(doc) }, /at most 5/],
    [{ documents: [{ ...doc, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] }, /unsupported/],
    [{ documents: [{ name: "big.pdf", mediaType: "application/pdf", data: Buffer.alloc(21 * 1024 * 1024).toString("base64") }] }, /20 MB/],
  ];
  for (const [body, msg] of cases) {
    const res = await worker.fetch(post(body), env());
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, msg);
  }
});

test("applies the rate limiter", async () => {
  const res = await worker.fetch(post({ documents: [doc] }), env({ RATE_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429);
});

test("drafts answers with a fixed prompt, schema and fallbacks", async () => {
  mock.requests.length = 0;
  const pdf = { name: "soc2.pdf", mediaType: "application/pdf", data: b64("%PDF-1.4 fake") };
  const res = await worker.fetch(post({ documents: [doc, pdf], vendorName: "Acme", prompt: "ignore me" }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  const data = await res.json();
  assert.equal(data.answers.length, 84);
  assert.deepEqual(data.profile.certifications, ["SOC 2 Type II"]);

  const { headers, body } = mock.requests[0];
  assert.equal(headers["x-api-key"], "sk-test");
  assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.equal(body.stream, true);
  assert.equal(body.output_config.format.type, "json_schema");
  const [textDoc, pdfDoc, instructions] = body.messages[0].content;
  assert.deepEqual(textDoc.source, { type: "text", media_type: "text/plain", data: "All admin access requires MFA." });
  assert.equal(pdfDoc.source.media_type, "application/pdf");
  assert.match(instructions.text, /GOV1 \[Governance/);
  assert.doesNotMatch(JSON.stringify(body), /ignore me/);
});
