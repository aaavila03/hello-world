// Minimal stand-in for the Anthropic Messages API (streaming), for tests.
import http from "node:http";
import { INTAKE_QUESTIONS } from "../../cyber-risk/intake-questions.js";

export function cannedResult() {
  return {
    answers: INTAKE_QUESTIONS.map((q) => {
      if (q.id === "IAM2") return { id: q.id, answer: "No", comment: "Admin MFA is being rolled out.", evidence: "MFA for administrators will be enforced by Q1 2027.", document: "policy.txt" };
      if (q.id.startsWith("AI") || q.id === "PHY2") return { id: q.id, answer: "Unknown", comment: "", evidence: "", document: "" };
      return { id: q.id, answer: q.type === "inverse" ? "No" : "Yes", comment: "Covered in the security policy.", evidence: `Quote for ${q.id}`, document: "soc2.pdf" };
    }),
    profile: { certifications: ["SOC 2 Type II"], certificationDetails: "SOC 2 Type II, Jan–Dec 2025", hosting: "AWS eu-west-1", dataLocations: "Ireland", subprocessors: "AWS (hosting, Ireland)" },
    summary: "The documents cover most controls; AI usage and visitor management are not described.",
  };
}

export function startMockAnthropic({ status = 200, stopReason = "end_turn" } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock failure" } }));
      }
      const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
      const text = JSON.stringify(cannedResult());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
        + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
        + ev("content_block_stop", { type: "content_block_stop", index: 0 })
        + ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 100 } })
        + ev("message_stop", { type: "message_stop" }));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}
