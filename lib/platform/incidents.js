// Incidents (S43 / OP12; Phase 3 line 4) — the merchant console banner's read
// and the operator's open, update, note, resolve, list and timeline. The
// INTERNAL note never leaves the operator surface: it is not in the banner
// read, and no audit row ever holds its text (incident rows carry the
// incident's store as tenant_id, so that store's Audit log tab lists them).
// The history is audit_log (incident.open | incident.update | incident.resolve,
// resource incident:<id>); no table of its own. Rows before line 4 say
// tenant.status and are read as open or resolve.
import { platformDb, platformConfigured } from "./control.js";
import { audit, operatorActor, operatorNames } from "./audit.js";
import { newId } from "./sessions.js";
import { slog } from "../log.js";
import { MAX_OFFSET } from "./paging.js";

export const INCIDENT_PAGE = 50;
const TITLE_MAX = 200;
const PUBLIC_MAX = 500;
const NOTE_MAX = 2000;

const nowIso = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => {
  const s = v == null ? "" : String(v).trim().slice(0, max);
  return s || null;
};

// Open incidents visible to a TENANT's console: public message only.
export async function openIncidentsFor(tenantId) {
  if (!platformConfigured()) return [];
  try {
    const r = await platformDb().execute({
      sql: "SELECT id, tenant_id, title, public_message, created_at FROM incidents WHERE status = 'open' AND public_message IS NOT NULL AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY created_at DESC LIMIT 5",
      args: [tenantId || "_none"],
    });
    return r.rows.map((row) => ({ ...row }));
  } catch {
    return []; // pre-migration control plane
  }
}

async function incidentRow(id) {
  const r = await platformDb().execute({ sql: "SELECT * FROM incidents WHERE id = ?", args: [String(id || "")] });
  if (!r.rows[0]) throw fail(404, "No incident with that id.");
  return { ...r.rows[0] };
}

const record = (actor, action, inc, diff) => audit({ actor: operatorActor(actor), action, resource: `incident:${inc.id}`, tenantId: inc.tenant_id ?? null, diff });

// Operator list: open first, then resolved, newest first within each, 50 a page.
//   scope: "all" | "platform" | a store id
export async function listIncidents({ scope = "all", page = 1 } = {}) {
  const where = [];
  const args = [];
  if (scope === "platform") where.push("i.tenant_id IS NULL");
  else if (scope && scope !== "all") {
    where.push("i.tenant_id = ?");
    args.push(String(scope));
  }
  const n = Math.floor(Number(page));
  const p = Number.isNaN(n) ? 1 : Math.min(Math.max(1, n), Math.floor(MAX_OFFSET / INCIDENT_PAGE) + 1);
  const res = await platformDb().execute({
    sql: `SELECT i.*, t.name AS store_name FROM incidents i LEFT JOIN tenants t ON t.id = i.tenant_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.created_at DESC, i.id DESC
          LIMIT ${INCIDENT_PAGE} OFFSET ${(p - 1) * INCIDENT_PAGE}`,
    args,
  });
  const counts = await platformDb().execute({
    sql: `SELECT COUNT(*) AS total, SUM(CASE i.status WHEN 'open' THEN 1 ELSE 0 END) AS open FROM incidents i ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    args,
  });
  const c = counts.rows[0] || {};
  return { incidents: res.rows.map((r) => ({ ...r })), page: p, pageSize: INCIDENT_PAGE, total: Number(c.total || 0), openCount: Number(c.open || 0) };
}

// Platform-wide when tenantId is empty; a store the server checks exists (404).
export async function openIncident({ title, tenantId = null, publicMessage = null, internalNote = null, actor }) {
  const t = text(title, TITLE_MAX);
  if (!t) throw fail(400, "Give the incident a title.");
  const tenant = text(tenantId, 80);
  if (tenant) {
    const r = await platformDb().execute({ sql: "SELECT id FROM tenants WHERE id = ?", args: [tenant] });
    if (!r.rows[0]) throw fail(404, "No store with that id.");
  }
  const inc = { id: newId("inc"), tenant_id: tenant, title: t, internal_note: text(internalNote, NOTE_MAX), public_message: text(publicMessage, PUBLIC_MAX), status: "open", created_at: nowIso() };
  await platformDb().execute({
    sql: "INSERT INTO incidents (id, tenant_id, title, internal_note, public_message, status, created_at) VALUES (?,?,?,?,?, 'open', ?)",
    args: [inc.id, inc.tenant_id, inc.title, inc.internal_note, inc.public_message, inc.created_at],
  });
  await record(actor, "incident.open", inc, { title: inc.title, public_message: inc.public_message, scope: tenant ? "store" : "platform" });
  slog("incident_opened", { id: inc.id, tenant: tenant || "platform" });
  return inc;
}

// A new public message (the banner changes; the old one stays in the timeline).
export async function postIncidentUpdate({ id, publicMessage, actor }) {
  const inc = await incidentRow(id);
  if (inc.status !== "open") throw fail(409, "This incident is resolved. Open a new one instead.");
  const msg = text(publicMessage, PUBLIC_MAX);
  if (!msg) throw fail(400, "Write the update merchants will see.");
  const r = await platformDb().execute({ sql: "UPDATE incidents SET public_message = ? WHERE id = ? AND status = 'open'", args: [msg, inc.id] });
  if (!r.rowsAffected) throw fail(409, "This incident is resolved. Open a new one instead.");
  await record(actor, "incident.update", inc, { public_message: msg });
  return { ...inc, public_message: msg };
}

// The internal note: operators only. Its audit row says it changed, never what it says.
export async function editInternalNote({ id, internalNote, actor }) {
  const inc = await incidentRow(id);
  const note = text(internalNote, NOTE_MAX);
  await platformDb().execute({ sql: "UPDATE incidents SET internal_note = ? WHERE id = ?", args: [note, inc.id] });
  await record(actor, "incident.update", inc, { note_edited: true });
  return { ...inc, internal_note: note };
}

// Resolve, with an optional closing message (kept in the timeline; the banner goes away).
export async function resolveIncident({ id, closingMessage = null, actor }) {
  const inc = await incidentRow(id);
  if (inc.status !== "open") throw fail(409, "This incident is already resolved.");
  const msg = text(closingMessage, PUBLIC_MAX);
  const at = nowIso();
  // only the first of two concurrent resolves changes the row and writes the audit row
  const r = await platformDb().execute({ sql: "UPDATE incidents SET status = 'resolved', resolved_at = ?, public_message = COALESCE(?, public_message) WHERE id = ? AND status = 'open'", args: [at, msg, inc.id] });
  if (!r.rowsAffected) throw fail(409, "This incident is already resolved.");
  await record(actor, "incident.resolve", inc, msg ? { closing_message: msg } : { resolved: true });
  slog("incident_resolved", { id: inc.id });
  return { ...inc, status: "resolved", resolved_at: at, public_message: msg ?? inc.public_message };
}

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

// The timeline, oldest first: { at, kind: open | update | note | resolve, by, message }.
// Reads audit_log by the incident's store and resource (idx_audit_tenant_at);
// rows from before line 4 were written with no store, so those are read too.
export async function incidentTimeline(id) {
  const inc = await incidentRow(id);
  const res = await platformDb().execute({
    sql: `SELECT at, actor, actor_kind, action, diff FROM audit_log
          WHERE (tenant_id IS ? OR tenant_id IS NULL) AND resource = ?
            AND action IN ('incident.open', 'incident.update', 'incident.resolve', 'tenant.status')
          ORDER BY at, rowid`,
    args: [inc.tenant_id ?? null, `incident:${inc.id}`],
  });
  const names = await operatorNames(res.rows.map((r) => r.actor));
  return res.rows.map((r) => {
    const d = parse(r.diff);
    let kind = String(r.action).replace("incident.", "");
    if (r.action === "tenant.status") kind = d.resolved ? "resolve" : "open";
    if (kind === "update" && d.note_edited) kind = "note";
    const message = kind === "resolve" ? d.closing_message || null : kind === "note" ? null : d.public_message || null;
    return { at: r.at, kind, by: names.get(String(r.actor)) || String(r.actor), message };
  });
}

// Stores for the operator's pickers (flags overrides, incident scope).
export async function storeChoices() {
  const r = await platformDb().execute("SELECT id, name FROM tenants ORDER BY name, id LIMIT 1000");
  return r.rows.map((x) => ({ id: String(x.id), name: String(x.name || x.id) }));
}
