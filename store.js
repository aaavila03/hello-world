// Persistence for risks and vendors: browser storage in demo mode, or the
// Supabase database (protected by row-level security) in cloud mode.

// Storage keys keep the original "riskpilot." prefix so existing browser data still loads.
const LOCAL_KEYS = { risks: "riskpilot.risks", vendors: "riskpilot.vendors", briefing: "riskpilot.briefing" };

// Fields that may be stored for each record; anything else (e.g. from an
// imported file) is dropped, and strings are length-capped.
const FIELDS = {
  risks: ["id", "title", "description", "asset", "category", "likelihood", "impact", "residualLikelihood", "residualImpact",
    "owner", "status", "treatment", "controls", "due", "created", "updated"],
  vendors: ["id", "name", "service", "owner", "status", "criticality", "dataSensitivity", "access", "lastAssessed", "dataTypes",
    "notes", "answers", "aiAssessment", "intake", "intakeModules", "created", "updated"],
};
const MAX_STRING = 20000;

function clean(value, depth = 0) {
  if (typeof value === "string") return value.slice(0, MAX_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value == null) return value ?? null;
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => clean(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 500)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k.slice(0, 100)] = clean(v, depth + 1);
    }
    return out;
  }
  return null;
}

export function sanitizeRecord(kind, record) {
  const out = {};
  for (const f of FIELDS[kind]) if (record?.[f] !== undefined) out[f] = clean(record[f]);
  return out;
}

export const ID_PATTERN = { risks: /^R-\d{3,6}$/, vendors: /^V-\d{3,6}$/ };

export class LocalStore {
  constructor({ safeGet, safeSet }) { Object.assign(this, { safeGet, safeSet }); this.cloud = false; }

  async load() {
    const read = (k) => { try { return JSON.parse(this.safeGet(localStorage, LOCAL_KEYS[k]) || "[]"); } catch { return []; } };
    return { risks: read("risks"), vendors: read("vendors") };
  }

  save(kind, list) {
    this.safeSet(localStorage, LOCAL_KEYS[kind], JSON.stringify(list));
    return Promise.resolve();
  }

  async loadBriefing() {
    try { return JSON.parse(this.safeGet(localStorage, LOCAL_KEYS.briefing) || "null"); } catch { return null; }
  }

  async saveBriefing(report) {
    this.safeSet(localStorage, LOCAL_KEYS.briefing, JSON.stringify(report));
  }
}

// Saves by diffing against the last state known to match the server, so only
// changed records are written. Saves are queued so they apply in order.
export class CloudStore {
  constructor({ client, orgId, onError }) {
    Object.assign(this, { client, orgId, onError });
    this.cloud = true;
    this.snapshot = { risks: new Map(), vendors: new Map() };
    this.queue = Promise.resolve();
  }

  async load() {
    const out = {};
    for (const kind of ["risks", "vendors"]) {
      const { data, error } = await this.client.from(kind).select("display_id, data").eq("org_id", this.orgId).order("display_id");
      if (error) throw error;
      out[kind] = data.map((row) => ({ ...row.data, id: row.display_id }));
      this.snapshot[kind] = new Map(out[kind].map((r) => [r.id, JSON.stringify(sanitizeRecord(kind, r))]));
    }
    return out;
  }

  async loadBriefing() {
    const { data, error } = await this.client.from("briefings").select("report").eq("org_id", this.orgId).maybeSingle();
    if (error) throw error;
    return data?.report ?? null;
  }

  // Replaces the workspace's saved briefing (analysts and above; see save_briefing in the schema).
  async saveBriefing(report) {
    const { error } = await this.client.rpc("save_briefing", { org: this.orgId, briefing: report });
    if (error) throw error;
  }

  save(kind, list) {
    const next = new Map(list.map((r) => [r.id, JSON.stringify(sanitizeRecord(kind, r))]));
    this.queue = this.queue.then(() => this.sync(kind, next)).catch((err) => this.onError(err));
    return this.queue;
  }

  async sync(kind, next) {
    const prev = this.snapshot[kind];
    const removed = [...prev.keys()].filter((id) => !next.has(id));
    const added = [...next.keys()].filter((id) => !prev.has(id));
    const changed = [...next.keys()].filter((id) => prev.has(id) && prev.get(id) !== next.get(id));
    const body = (id) => { const { id: _, ...data } = JSON.parse(next.get(id)); return data; };

    if (removed.length) {
      const { error } = await this.client.from(kind).delete().eq("org_id", this.orgId).in("display_id", removed);
      if (error) throw error;
    }
    if (added.length) {
      const rows = added.map((id) => ({ org_id: this.orgId, display_id: id, data: body(id) }));
      const { error } = await this.client.from(kind).insert(rows);
      if (error) throw error;
    }
    for (const id of changed) {
      const { error } = await this.client.from(kind).update({ data: body(id) }).eq("org_id", this.orgId).eq("display_id", id);
      if (error) throw error;
    }
    this.snapshot[kind] = next;
  }
}
