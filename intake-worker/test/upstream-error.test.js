import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { startMockAnthropic } from "./mock-anthropic.js";

const ORIGIN = "https://aaavila03.github.io";
const req = () => new Request("https://w.example/autofill", { method: "POST", headers: { origin: ORIGIN },
  body: JSON.stringify({ documents: [{ name: "a.txt", mediaType: "text/plain", data: Buffer.from("x").toString("base64") }] }) });

for (const [label, opts, status, msg] of [
  ["refusal", { stopReason: "refusal" }, 422, /declined/],
  ["upstream 500", { status: 500 }, 502, /unavailable/],
]) {
  test(`maps ${label} to a safe error`, async () => {
    const mock = await startMockAnthropic(opts);
    try {
      const res = await worker.fetch(req(), { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: mock.url, ALLOWED_ORIGINS: ORIGIN });
      assert.equal(res.status, status);
      const body = await res.json();
      assert.match(body.error, msg);
      assert.doesNotMatch(body.error, /mock failure/);
    } finally { mock.server.close(); }
  });
}
