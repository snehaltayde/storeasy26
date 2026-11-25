// Revocable server-side sessions + membership lookups (Session 26 / BE02).
//
// EDGE-SAFE on purpose: admin/platform pages render under the edge layout and
// verify the cookie per request, so everything here uses web crypto
// (crypto.subtle / getRandomValues) and the libsql HTTP client — never
// node:crypto. Password hashing and TOTP live in lib/platform/identity.js,
// which is Node-only and used exclusively by login routes, CLIs and tests.
//
// Model: the cookie carries a random 32-byte token; the DB stores only its
// SHA-256. Verification is a fresh control-plane lookup every time — that is
// what makes revocation hold across isolates/instances (BE02 acceptance).
import { platformDb } from "./control.js";

export const MERCHANT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // operators re-auth twice a day

export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const randHex = (bytes) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export const newToken = () => randHex(32);
export const newId = (prefix) => `${prefix}_${randHex(8)}`;

// Phase 3 line 5: grantId ties a support_entry or support session to its
// support grant (platform migration 0017); it is named only when it is set.
export async function createSession({ userId, kind, ttlMs, ip = null, ua = null, grantId = null }) {
  const token = newToken();
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const id = newId("s");
  const cols = ["id", "token_hash", "user_id", "kind", "created_at", "expires_at", "ip", "ua", ...(grantId ? ["grant_id"] : [])];
  await platformDb().execute({
    sql: `INSERT INTO sessions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    args: [id, await sha256Hex(token), userId, kind, new Date(now).toISOString(), expiresAt, ip, ua, ...(grantId ? [grantId] : [])],
  });
  // opportunistic prune: drop rows expired for 30+ days (keeps the table tiny)
  try {
    await platformDb().execute({
      sql: "DELETE FROM sessions WHERE expires_at < ?",
      args: [new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()],
    });
  } catch {}
  return { token, id, expiresAt };
}

// Session kinds that belong to an operator (users.is_operator required) and,
// for the support kinds, to a support grant (sessions.grant_id, Phase 3 line 5).
const OPERATOR_KINDS = new Set(["operator", "support_entry", "support"]);
const GRANT_KINDS = new Set(["support_entry", "support"]);

// → { userId, sessionId, kind, expiresAt, grantId } for a live session of this
// kind, else null. Operator and support sessions additionally require
// users.is_operator; grantId is set for the support kinds only (the column is
// read only for them, so the other kinds work on a control plane before 0017).
export async function verifySession(token, kind) {
  if (!token || typeof token !== "string") return null;
  try {
    const res = await platformDb().execute({
      sql: `SELECT s.id, s.user_id, s.kind, s.expires_at, s.revoked_at, u.status AS user_status, u.is_operator${GRANT_KINDS.has(kind) ? ", s.grant_id" : ""}
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?`,
      args: [await sha256Hex(token)],
    });
    const row = res.rows[0];
    if (!row) return null;
    if (row.kind !== kind) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    if (row.user_status !== "active") return null;
    if (OPERATOR_KINDS.has(kind) && !Number(row.is_operator)) return null;
    if (GRANT_KINDS.has(kind) && !row.grant_id) return null;
    return { userId: row.user_id, sessionId: row.id, kind: row.kind, expiresAt: row.expires_at, grantId: row.grant_id ?? null };
  } catch {
    // control plane unreachable or pre-S26 schema → no session (callers may
    // fall back to the legacy shared-password path where that's allowed)
    return null;
  }
}

export async function revokeSessionByToken(token) {
  if (!token) return;
  try {
    await platformDb().execute({
      sql: "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      args: [new Date().toISOString(), await sha256Hex(token)],
    });
  } catch {}
}

export async function revokeUserSessions(userId, { kind = null } = {}) {
  const now = new Date().toISOString();
  if (kind) {
    await platformDb().execute({
      sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind = ? AND revoked_at IS NULL",
      args: [now, userId, kind],
    });
  } else {
    await platformDb().execute({
      sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      args: [now, userId],
    });
  }
}

export async function membershipRole(userId, tenantId) {
  if (!userId || !tenantId) return null;
  try {
    const res = await platformDb().execute({
      sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?",
      args: [userId, tenantId],
    });
    return res.rows[0]?.role ?? null;
  } catch {
    return null;
  }
}

// Bootstrap detector: a tenant with NO member users still accepts the legacy
// shared-password console login; the first membership switches it off.
// S53 (audit A3): a LOOKUP FAILURE now THROWS instead of reading as "no
// members" — swallowing it let a control-plane outage re-enable the retained
// bootstrap password on a tenant that has real accounts. Callers decide what
// a failure means (auth denies; UI shows unknown).
export async function tenantHasMembers(tenantId) {
  if (!tenantId) return false;
  const res = await platformDb().execute({
    sql: "SELECT 1 FROM memberships WHERE tenant_id = ? LIMIT 1",
    args: [tenantId],
  });
  return res.rows.length > 0;
}

// Same idea platform-wide: PLATFORM_ADMIN_PASSWORD works only until the first
// active operator user exists. S53 (audit A3): lookup failures THROW — they
// must never read as "no operators" and resurrect the bootstrap password.
export async function operatorsExist() {
  const res = await platformDb().execute(
    "SELECT 1 FROM users WHERE is_operator = 1 AND status = 'active' LIMIT 1",
  );
  return res.rows.length > 0;
}
