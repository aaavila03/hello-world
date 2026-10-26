// Vendor documentation: limits and file handling shared by the vendor form and
// the analyst, plus the question list for "Fill from documents" (its system
// prompt and response schema live in ai-tasks.js).
import { INTAKE_QUESTIONS } from "./intake-questions.js";

export const DOC_LIMITS = { maxFiles: 5, maxBytes: 20 * 1024 * 1024 };
const TYPES = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv" };

// Media type for a supported file, or null (Word files must be saved as PDF).
export function docMediaType(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  return TYPES[ext] || (Object.values(TYPES).includes(file.type) ? file.type : null);
}

export const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(new Error(`Could not read ${file.name}`));
  r.readAsDataURL(file);
});

// Adds files to a document list, enforcing type, count and total size.
// Returns the list of problems to report.
export async function addDocuments(list, files) {
  const errors = [];
  for (const f of files) {
    const mediaType = docMediaType(f);
    if (!mediaType) { errors.push(`${f.name}: use PDF, TXT, Markdown or CSV (save Word files as PDF)`); continue; }
    if (list.length >= DOC_LIMITS.maxFiles) { errors.push(`You can attach up to ${DOC_LIMITS.maxFiles} documents`); break; }
    if (list.reduce((n, d) => n + d.size, 0) + f.size > DOC_LIMITS.maxBytes) { errors.push("Documents can total at most 20 MB"); break; }
    if (list.some((d) => d.name === f.name && d.size === f.size)) continue;
    list.push({ name: f.name, mediaType, size: f.size, data: await fileToBase64(f) });
  }
  return errors;
}

export function autofillPrompt(vendorName) {
  const list = INTAKE_QUESTIONS.map((q) => {
    const note = q.type === "inverse" ? " (Yes is a red flag)" : q.type === "info" ? " (context only)" : "";
    return `${q.id} [${q.domain}] ${q.text}${note}`;
  }).join("\n");
  return `Vendor: ${vendorName || "unknown"}\n\nAnswer every one of these questions from the documents above:\n\n${list}`;
}
