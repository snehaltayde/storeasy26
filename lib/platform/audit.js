// Append-only audit log (Session 27 / BE16 core). Control-plane table; the
// ONLY code paths are INSERT and scoped SELECT — no update or delete exists
// anywhere (tamper resistance by construction at the application layer; the
// storage policy is documented in the platform guide).
//
// Rows carry actor, action, tenant, resource, time, request id and a SAFE
// diff: values under secret-ish keys are redacted and the JSON is size-capped,
// so the log can never become a secrets or PII store. Writing is best-effort —
// an audit failure must never fail the mutation it describes (it is slog'd).
//
// Approval records bound to content hashes arrive with releases (S36/BE09).
import { platformDb } from "./control.js";
import { newId } from "./sessions.js";
import { currentTenant } from "../tenant-context.js";
import { slog } from "../log.js";

const SECRETISH = /password|secret|token|key|credential|authorization/i;
const MAX_DIFF = 2048;

export function redactDiff(diff) {
  if (diff == null) return null;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = SECRETISH.test(k) ? "[redacted]" : walk(val);
      return out;
    }
    return v;
  };
  let json = JSON.stringify(walk(diff));
  if (json.length > MAX_DIFF) json = JSON.stringify({ truncated: true, preview: json.slice(0, MAX_DIFF - 40) });
  return json;
}

// Phase 3 line 0: an operator write's actor. Takes requireOperator's operator
// ({ id, kind: "operator" | "bootstrap", ... }) so the setup password is
// recorded as bootstrap, or a bare id (older callers, CLIs) as an operator.
export const operatorActor = (a) => (a && typeof a === "object" ? { kind: String(a.kind || "operator"), id: String(a.id) } : { kind: "operator", id: String(a ?? "operator") });

// audit({ actor, action, resource?, diff?, tenantId?, requestId? })
//   actor: { kind: "merchant"|"operator"|"bootstrap"|"cli"|"system", id, role? }
//   tenantId defaults to the active tenant context.
export async function audit({ actor, action, resource = null, diff = null, tenantId, requestId = null }) {
  try {
    await platformDb().execute({
      sql: `INSERT INTO audit_log (id, at, actor, actor_kind, tenant_id, action, resource, request_id, diff)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId("a"),
        new Date().toISOString(),
        String(actor?.id ?? "unknown"),
        String(actor?.kind ?? "system"),
        tenantId !== undefined ? tenantId : (currentTenant()?.id ?? null),
        String(action),
        resource,
        requestId,
        redactDiff(diff),
      ],
    });
  } catch (e) {
    slog("audit_write_failed", { action, error: String(e?.message || e).slice(0, 200) });
  }
}

// Scoped read: a tenant console only ever sees its own rows.
// Phase 2 line 7 (the Audit log tab): optional filters, all exact or ranges on
// this tenant's rows: actor (an id), action, since / until (ISO times, since
// inclusive, until exclusive). before pages: a plain ISO time (rows older than
// it, as before) or "<at>|<id>" (the last row of the previous page, so rows
// that share a time are never skipped or repeated). Newest first, id breaks ties.
export async function listAudit({ tenantId, limit = 50, before = null, actor = null, action = null, since = null, until = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = [`tenant_id ${tenantId ? "= ?" : "IS NULL"}`];
  const args = tenantId ? [tenantId] : [];
  if (before) {
    const [at, id] = String(before).split("|");
    if (id) {
      where.push("(at < ? OR (at = ? AND id < ?))");
      args.push(at, at, id);
    } else {
      where.push("at < ?");
      args.push(at);
    }
  }
  const add = (sql, v) => {
    where.push(sql);
    args.push(String(v));
  };
  if (actor) add("actor = ?", actor);
  if (action) add("action = ?", action);
  if (since) add("at >= ?", since);
  if (until) add("at < ?", until);
  const res = await platformDb().execute({
    sql: `SELECT id, at, actor, actor_kind, tenant_id, action, resource, request_id, diff
          FROM audit_log
          WHERE ${where.join(" AND ")}
          ORDER BY at DESC, id DESC LIMIT ${cap}`,
    args,
  });
  return res.rows.map((r) => ({ ...r }));
}

// The Audit log tab's filter choices: who has acted on this tenant and which
// actions were recorded (most recent first, capped).
export async function auditFacets({ tenantId }) {
  const q = (col) =>
    platformDb().execute({
      sql: `SELECT ${col}, MAX(at) AS last FROM audit_log WHERE tenant_id = ? GROUP BY ${col} ORDER BY last DESC LIMIT 100`,
      args: [tenantId],
    });
  const [actors, actions] = await Promise.all([q("actor, actor_kind"), q("action")]);
  return { actors: actors.rows.map((r) => ({ actor: r.actor, kind: r.actor_kind })), actions: actions.rows.map((r) => r.action) };
}

// One row as the console shows it: the diff parsed and redacted again on the
// way out (a row written before a key became secret-ish still never shows a
// value), as short "key: value" lines.
export function auditChanges(diff) {
  if (diff == null || diff === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(redactDiff(typeof diff === "string" ? JSON.parse(diff) : diff));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [String(parsed)];
  return Object.entries(parsed).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`.slice(0, 300));
}

// Phase 3 line 4: operator ids (audit actors, feature_flags.updated_by) as names
// for the operator console: a user's name or email, "Bootstrap operator" for the
// setup password, the id itself when nobody matches. -> Map(id -> name)
export async function operatorNames(ids) {
  const want = [...new Set((ids || []).filter(Boolean).map(String))];
  const out = new Map(want.map((id) => [id, id === "bootstrap" ? "Bootstrap operator" : id]));
  const users = want.filter((id) => id !== "bootstrap");
  for (let i = 0; i < users.length; i += 200) {
    const chunk = users.slice(i, i + 200);
    const res = await platformDb()
      .execute({ sql: `SELECT id, name, email FROM users WHERE id IN (${chunk.map(() => "?").join(", ")})`, args: chunk })
      .catch(() => ({ rows: [] }));
    for (const r of res.rows) out.set(String(r.id), String(r.name || r.email || r.id));
  }
  return out;
}
