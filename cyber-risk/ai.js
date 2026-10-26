// Claude integration for the cyber risk app.
// Runs entirely in the browser with the user's own Anthropic API key.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const SYSTEM_PROMPT = `You are a senior cyber risk analyst supporting an organisation's risk management program.
You help defenders identify, score, prioritise and treat cyber security risks.
Scoring uses a 5x5 matrix: likelihood 1 (rare) to 5 (almost certain), impact 1 (negligible) to 5 (severe); score = likelihood x impact.
Map recommended controls to NIST CSF 2.0 functions (Govern, Identify, Protect, Detect, Respond, Recover) and, where useful, CIS Controls v8.
For third-party risk, assess vendors on criticality, data sensitivity, access and the strength of their security controls.
Be concrete, defensive and business-focused. Do not provide offensive exploitation steps.`;

const ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["Ransomware/Malware", "Phishing/Social Engineering", "Data Breach", "Insider Threat",
        "Third-Party/Supply Chain", "Cloud Misconfiguration", "Vulnerability/Patching",
        "Identity & Access", "Availability/DDoS", "Compliance/Regulatory", "Other"],
    },
    likelihood: { type: "integer", enum: [1, 2, 3, 4, 5] },
    impact: { type: "integer", enum: [1, 2, 3, 4, 5] },
    rationale: { type: "string" },
    threat_scenarios: { type: "array", items: { type: "string" } },
    recommended_controls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          control: { type: "string" },
          csf_function: { type: "string", enum: ["Govern", "Identify", "Protect", "Detect", "Respond", "Recover"] },
          priority: { type: "string", enum: ["High", "Medium", "Low"] },
        },
        required: ["control", "csf_function", "priority"],
        additionalProperties: false,
      },
    },
    residual_likelihood: { type: "integer", enum: [1, 2, 3, 4, 5] },
    residual_impact: { type: "integer", enum: [1, 2, 3, 4, 5] },
    treatment: { type: "string", enum: ["Mitigate", "Transfer", "Avoid", "Accept"] },
  },
  required: ["category", "likelihood", "impact", "rationale", "threat_scenarios", "recommended_controls",
    "residual_likelihood", "residual_impact", "treatment"],
  additionalProperties: false,
};

export class RiskAI {
  constructor({ apiKey, model, effort }) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.model = model;
    this.effort = effort;
  }

  baseParams() {
    return {
      model: this.model,
      system: SYSTEM_PROMPT,
      output_config: { effort: this.effort },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    };
  }

  // One-shot request whose reply is constrained to the given JSON schema.
  // Streams so long answers don't hit request timeouts.
  async structured(prompt, schema) {
    const stream = this.client.beta.messages.stream({
      ...this.baseParams(),
      max_tokens: 32000,
      output_config: { effort: this.effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    });
    const response = await stream.finalMessage();
    checkRefusal(response);
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  }

  // Long-input structured task over attached documents, with its own system prompt.
  // Streams so large documents and long answers don't hit request timeouts.
  async documentTask({ system, content, schema }) {
    const stream = this.client.beta.messages.stream({
      ...this.baseParams(),
      system,
      max_tokens: 64000,
      output_config: { effort: this.effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content }],
    });
    const response = await stream.finalMessage();
    checkRefusal(response);
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  }

  assessRisk(risk) {
    return this.structured(`Assess this cyber risk for our organisation.

Title: ${risk.title || "(none)"}
Asset / system: ${risk.asset || "(unspecified)"}
Description: ${risk.description || "(none)"}
Existing controls: ${risk.controls || "(none listed)"}

Score inherent likelihood and impact, list 2-4 realistic threat scenarios, recommend 3-6 prioritised controls,
and estimate residual likelihood/impact once those controls are in place.`, ASSESSMENT_SCHEMA);
  }

  // Streams markdown text to onText; resolves with the full text.
  async stream(messages, onText) {
    const stream = this.client.beta.messages.stream({
      ...this.baseParams(),
      max_tokens: 64000,
      messages,
    });
    stream.on("text", (delta) => onText(delta));
    const final = await stream.finalMessage();
    checkRefusal(final);
    return final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  chat(history, registerSummary, onText) {
    const context = `Current risk register and vendor inventory (JSON) for reference:\n\n${registerSummary}`;
    const [first, ...rest] = history;
    const messages = [{ role: "user", content: `${context}\n\n---\n\n${first.content}` }, ...rest];
    return this.stream(messages, onText);
  }
}

function checkRefusal(message) {
  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation || message.stop_details?.category || "policy";
    throw new Error(`The model declined this request (${why}). Try rephrasing it in defensive terms.`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The response was cut off (max_tokens reached).");
  }
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid API key. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key is not permitted to use the selected model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err?.message || String(err);
}
