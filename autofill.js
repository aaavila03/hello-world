// Vendor documentation: limits and file handling shared by the vendor form and
// the analyst, plus the question list for "Fill from documents" (its system
// prompt and response schema live in ai-tasks.js).
import { INTAKE_QUESTIONS } from "./intake-questions.js";
import { xlsxToCsv } from "./xlsx.js";

export const DOC_LIMITS = { maxFiles: 5, maxBytes: 20 * 1024 * 1024 };
const TYPES = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv" };

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const isXlsx = (file) => file.name.toLowerCase().endsWith(".xlsx") || file.type === XLSX_TYPE;

// Media type for a supported file, or null (Word files must be saved as PDF).
// Excel workbooks are converted to CSV before they're stored.
export function docMediaType(file) {
  if (isXlsx(file)) return "text/csv";
  const ext = file.name.split(".").pop().toLowerCase();
  return TYPES[ext] || (Object.values(TYPES).includes(file.type) ? file.type : null);
}

const textToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

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
    if (!mediaType) { errors.push(`${f.name}: use PDF, Excel (.xlsx), TXT, Markdown or CSV (save Word files as PDF)`); continue; }
    if (list.length >= DOC_LIMITS.maxFiles) { errors.push(`You can attach up to ${DOC_LIMITS.maxFiles} documents`); break; }
    let doc;
    if (isXlsx(f)) {
      // Keep the original name so answers cite the questionnaire the vendor sent.
      let data;
      try { data = textToBase64(await xlsxToCsv(f)); } catch (err) { errors.push(`${f.name}: couldn't read it because ${err.message}`); continue; }
      doc = { name: f.name, mediaType, size: Math.ceil((data.length * 3) / 4), data };
    } else {
      doc = { name: f.name, mediaType, size: f.size, data: null };
    }
    if (list.reduce((n, d) => n + d.size, 0) + doc.size > DOC_LIMITS.maxBytes) { errors.push("Documents can total at most 20 MB"); break; }
    if (list.some((d) => d.name === doc.name && d.size === doc.size)) continue;
    list.push({ ...doc, data: doc.data ?? await fileToBase64(f) });
  }
  return errors;
}

export function autofillPrompt(vendorName, modules = []) {
  const list = INTAKE_QUESTIONS.filter((q) => !q.module || modules.includes(q.module)).map((q) => {
    const note = q.type === "inverse" ? " (Yes is a red flag)" : q.type === "info" ? " (context only)" : "";
    const only = q.parent ? ` (only applies if ${q.parent} is ${q.showIf}; otherwise answer N/A)` : "";
    return `${q.id} [${q.domain}] ${q.text}${note}${only}`;
  }).join("\n");
  return `Vendor: ${vendorName || "unknown"}\n\nAnswer every one of these questions from the documents above:\n\n${list}`;
}
