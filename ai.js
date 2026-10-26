// AI clients. Both expose the same methods; the task definitions (system
// prompts, schemas, limits) come from ai-tasks.js.
//
//   CloudAI  calls the server-side AI function; the API key never reaches the browser.
//   LocalAI  demo mode only: calls Anthropic from the browser with the user's own key.
import { buildRequest, messageText, TaskInputError } from "./ai-tasks.js";

class BaseAI {
  assessRisk(risk) {
    return this.run("assess_risk", { prompt: `Assess this cyber risk for our organisation.

Title: ${risk.title || "(none)"}
Asset / system: ${risk.asset || "(unspecified)"}
Description: ${risk.description || "(none)"}
Existing controls: ${risk.controls || "(none listed)"}

Score inherent likelihood and impact, list 2-4 realistic threat scenarios, recommend 3-6 prioritised controls,
and estimate residual likelihood/impact once those controls are in place.` });
  }

  vendorReview(prompt) { return this.run("vendor_review", { prompt }); }
  briefing(prompt) { return this.run("briefing", { prompt }); }
  fillFromDocuments(documents, prompt) { return this.run("fill_documents", { documents, prompt }); }

  chat(history, registerSummary, onText) {
    const context = `Current risk register and vendor inventory (JSON) for reference:\n\n${registerSummary}`;
    const [first, ...rest] = history;
    return this.runChat([{ role: "user", content: `${context}\n\n---\n\n${first.content}` }, ...rest], onText);
  }
}

export class CloudAI extends BaseAI {
  constructor({ client, url, anonKey, orgId }) {
    super();
    Object.assign(this, { client, url: `${url}/functions/v1/ai`, anonKey, orgId });
  }

  async request(task, input) {
    const { data } = await this.client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, apikey: this.anonKey },
      body: JSON.stringify({ task, orgId: this.orgId, input }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `The AI service returned an error (${res.status}).`);
    }
    return res;
  }

  async run(task, input) {
    const res = await this.request(task, input);
    return (await res.json()).result;
  }

  // The function streams newline-delimited JSON: {"text"} chunks then {"done"} or {"error"}.
  async runChat(messages, onText) {
    const res = await this.request("chat", { messages });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.text) { full += msg.text; onText(msg.text); }
      }
    }
    return full;
  }
}

let sdk;
async function loadSdk() {
  sdk ||= (await import("./vendor/anthropic-sdk.mjs")).default;
  return sdk;
}

export class LocalAI extends BaseAI {
  constructor({ apiKey, model, effort }) {
    super();
    Object.assign(this, { apiKey, model, effort });
  }

  async client() {
    const Anthropic = await loadSdk();
    return new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true });
  }

  async run(task, input) {
    const client = await this.client();
    const params = buildRequest(task, input, { model: this.model, effort: this.effort });
    const message = await client.beta.messages.stream(params).finalMessage();
    return JSON.parse(messageText(message));
  }

  async runChat(messages, onText) {
    const client = await this.client();
    const stream = client.beta.messages.stream(buildRequest("chat", { messages }, { model: this.model, effort: this.effort }));
    stream.on("text", (delta) => onText(delta));
    return messageText(await stream.finalMessage());
  }
}

export function describeError(err) {
  if (err instanceof TaskInputError) return err.message;
  if (!sdk) return err?.message || String(err);
  if (err instanceof sdk.AuthenticationError) return "Invalid API key. Check it in Settings.";
  if (err instanceof sdk.PermissionDeniedError) return "This API key is not permitted to use the selected model.";
  if (err instanceof sdk.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof sdk.APIConnectionError) return "Could not reach the Anthropic API. Check your connection.";
  if (err instanceof sdk.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err?.message || String(err);
}
