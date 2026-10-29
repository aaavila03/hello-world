// Reads an Excel workbook (.xlsx) in the browser and returns its cell text as
// CSV, one block per sheet, so completed questionnaires (e.g. SIG) can be used
// as vendor documents. No dependencies: an .xlsx file is a zip of XML parts.

const MAX_PART_BYTES = 50 * 1024 * 1024; // guards against zip bombs

// Inflates one zip entry, stopping if it expands beyond MAX_PART_BYTES.
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PART_BYTES) { reader.cancel(); throw new Error("the spreadsheet is too large once unpacked"); }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// Maps each file name in the zip to a function returning its text.
function readZip(buf) {
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("it isn't a valid .xlsx file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("it isn't a valid .xlsx file");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = names.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.set(name, async () => {
      const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      const raw = new Uint8Array(buf, start, size);
      if (method !== 0 && method !== 8) throw new Error("it uses an unsupported compression method");
      return new TextDecoder().decode(method === 8 ? await inflate(raw) : raw);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
const textOf = (el) => [...el.getElementsByTagName("t")].map((t) => t.textContent).join("");

// Zero-based column index from a cell reference such as "AB12".
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Converts an .xlsx file to CSV text. Empty rows are dropped.
export async function xlsxToCsv(file) {
  const parts = readZip(await file.arrayBuffer());
  const part = (name) => (parts.has(name) ? parts.get(name)() : Promise.resolve(null));
  const workbook = await part("xl/workbook.xml");
  if (!workbook) throw new Error("it isn't an Excel workbook (save .xls files as .xlsx)");

  const shared = await part("xl/sharedStrings.xml");
  const strings = shared ? [...xml(shared).getElementsByTagName("si")].map(textOf) : [];
  const rels = new Map([...xml((await part("xl/_rels/workbook.xml.rels")) || "<r/>").getElementsByTagName("Relationship")]
    .map((r) => [r.getAttribute("Id"), r.getAttribute("Target").replace(/^\/?(xl\/)?/, "xl/")]));

  const out = [];
  for (const sheet of xml(workbook).getElementsByTagName("sheet")) {
    const rid = [...sheet.attributes].find((a) => a.localName === "id")?.value;
    const text = await part(rels.get(rid));
    if (!text) continue;
    const rows = [];
    for (const row of xml(text).getElementsByTagName("row")) {
      const cells = [];
      let col = -1;
      for (const c of row.getElementsByTagName("c")) {
        const type = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        const value = type === "s" ? strings[Number(v)] ?? ""
          : type === "inlineStr" ? textOf(c)
          : type === "b" ? (v === "1" ? "TRUE" : "FALSE")
          : v;
        col = c.getAttribute("r") ? columnIndex(c.getAttribute("r")) : col + 1;
        cells[col] = value.trim();
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, (v) => csvCell(v ?? "")).join(","));
    }
    if (rows.length) out.push(`# Sheet: ${sheet.getAttribute("name")}`, ...rows, "");
  }
  if (!out.length) throw new Error("it has no cell data");
  return out.join("\n");
}
