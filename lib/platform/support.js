// Support-access grants (Session 34 / OP10). An operator may enter a tenant's
// merchant console ONLY through an active grant: time-limited, with a stated
// reason, audited at creation/revocation, merchant-visible as a banner, and
// always as the SUPPORT role (read-only, PII-redacted — S27/S31 do the rest).
// Expiry is checked fresh on every request (no cache), so a lapsed grant fails
// on the operator's very next call, open tabs included.
// Edge-safe: admin pages verify through this.
import { platformDb, platformConfigured } from "./control.js";
import { newId } from "./sessions.js";
import { audit, operatorActor } from "./audit.js";

const nowIso = () => new Date().toISOString();

export async function createSupportGrant({ tenantId, reason, hours = 4, operator = "operator" }) {
  if (!tenantId) throw new Error("tenantId required");
  if (!reason || String(reason).trim().length < 5) throw new Error("a real reason is required (min 5 chars)");
  const ttl = Math.min(Math.max(Number(hours) || 4, 1), 72); // 1h–72h
  const id = newId("sg");
  const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
  await platformDb().execute({
    sql: `INSERT INTO support_grants (id, tenant_id, operator, reason, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, tenantId, operatorActor(operator).id, String(reason).trim(), nowIso(), expiresAt],
  });
  await audit({
    actor: operatorActor(operator),
    action: "support.grant_created",
    tenantId,
    resource: `grant:${id}`,
    diff: { reason: String(reason).trim(), hours: ttl },
  });
  return { id, tenantId, expiresAt };
}

export async function revokeSupportGrant(id, { operator = "operator" } = {}) {
  const res = await platformDb().execute({
    sql: "UPDATE support_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING tenant_id",
    args: [nowIso(), id],
  });
  const row = res.rows[0];
  if (!row) return false;
  await audit({
    actor: operatorActor(operator),
    action: "support.grant_revoked",
    tenantId: row.tenant_id,
    resource: `grant:${id}`,
  });
  return true;
}

// The live grant for a tenant (if any) — fresh lookup, never cached.
export async function activeSupportGrant(tenantId) {
  if (!platformConfigured() || !tenantId) return null;
  try {
    const res = await platformDb().execute({
      sql: `SELECT id, operator, reason, expires_at FROM support_grants
            WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ?
            ORDER BY expires_at DESC LIMIT 1`,
      args: [tenantId, nowIso()],
    });
    return res.rows[0] ? { ...res.rows[0] } : null;
  } catch {
    return null; // pre-migration control plane → no grants
  }
}

export async function listSupportGrants({ tenantId = null, limit = 50 } = {}) {
  const res = tenantId
    ? await platformDb().execute({
        sql: "SELECT * FROM support_grants WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [tenantId, Math.min(Number(limit) || 50, 200)],
      })
    : await platformDb().execute({
        sql: "SELECT * FROM support_grants ORDER BY created_at DESC LIMIT ?",
        args: [Math.min(Number(limit) || 50, 200)],
      });
  return res.rows.map((r) => ({ ...r }));
}
