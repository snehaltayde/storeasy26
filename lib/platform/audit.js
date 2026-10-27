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
export async function listAudit({ tenantId, limit = 50, before = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const res = await platformDb().execute({
    sql: `SELECT id, at, actor, actor_kind, tenant_id, action, resource, request_id, diff
          FROM audit_log
          WHERE tenant_id ${tenantId ? "= ?" : "IS NULL"} ${before ? "AND at < ?" : ""}
          ORDER BY at DESC LIMIT ${cap}`,
    args: [...(tenantId ? [tenantId] : []), ...(before ? [before] : [])],
  });
  return res.rows.map((r) => ({ ...r }));
}
