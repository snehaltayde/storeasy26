// P2-PREVIEW (PV-03, spec 8.8): preview sessions for stores in documents mode.
//
// A session is one row in preview_sessions (migration 0022). The preview
// cookie holds p.<exp>.<sid>.<hmac> (lib/releases.js previewToken), so the
// storefront knows which session a browser is in from the cookie alone, and
// the row says whether that session still counts and what it shows:
//
//   createPreviewSession({ actor })      a new row and its token (console route)
//   setShowDesign({ sid, on, actor? })   "Show them": add the design draft too
//   revokePreviewSession({ sid, actor? })  the session stops counting at once
//   revokePreviewSessionsFor({ actor })  logout: all of this person's sessions
//   endPreviewsAtLogout({ storeResolved, resolveActor })  the same, never throws
//   readPreviewSession(sid)              the storefront's read (one statement)
//
// The storefront never fails a shopper request because of this table:
//   · no table yet (a store before 0022): no overlay, nothing logged;
//   · any other read error: no overlay, one log line (preview_session_read_failed).
// Writes throw, so the console route answers a 5xx with a code.
//
// Edge-safe: libsql, Web Crypto and pure modules only.
import { libsql } from "./db.js";
import { tenantId } from "./tenant-context.js";
import { previewToken, PREVIEW_SID_RE } from "./releases.js";
import { notMigratedYet } from "./schema-shape.js";
import { slog } from "./log.js";

export const PREVIEW_COOKIE = "_preview";
export const PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000; // as long as the token: 1 hour
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const newPreviewSid = () => `ps_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;

// The person behind a session, as P2-DOCS writes created_by.
export const actorKey = (actor) => (actor && actor.kind && actor.id != null ? `${actor.kind}:${actor.id}` : "unknown");

const iso = (ms) => new Date(ms).toISOString();

export async function createPreviewSession({ actor, now = Date.now() } = {}) {
  const sid = newPreviewSid();
  const exp = Math.floor((now + PREVIEW_SESSION_TTL_MS) / 1000);
  const expiresAt = iso(exp * 1000);
  await libsql.execute({
    sql: "INSERT INTO preview_sessions (id, tenant_id, created_by, created_at, expires_at, revoked_at, show_design) VALUES (?, ?, ?, ?, ?, NULL, 0)",
    args: [sid, tenantId(), actorKey(actor), iso(now), expiresAt],
  });
  // sessions are scratch: drop the ones long gone (best-effort)
  await libsql.execute({ sql: "DELETE FROM preview_sessions WHERE expires_at < ?", args: [iso(now - PRUNE_AFTER_MS)] }).catch(() => {});
  const token = await previewToken({ sid, exp });
  return { sid, token, expiresAt, showDesign: false };
}

// true when a live session of this store (and of this person, when `actor` is
// given) was changed; false when there is none to change.
export async function setShowDesign({ sid, on, actor = null, now = Date.now() } = {}) {
  if (!PREVIEW_SID_RE.test(String(sid || ""))) return false;
  const r = await libsql.execute({
    sql: `UPDATE preview_sessions SET show_design = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > ?${actor ? " AND created_by = ?" : ""}`,
    args: [on ? 1 : 0, sid, tenantId(), iso(now), ...(actor ? [actorKey(actor)] : [])],
  });
  return Number(r.rowsAffected || 0) > 0;
}

export async function revokePreviewSession({ sid, actor = null, now = Date.now() } = {}) {
  if (!PREVIEW_SID_RE.test(String(sid || ""))) return false;
  const r = await libsql.execute({
    sql: `UPDATE preview_sessions SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL${actor ? " AND created_by = ?" : ""}`,
    args: [iso(now), sid, tenantId(), ...(actor ? [actorKey(actor)] : [])],
  });
  return Number(r.rowsAffected || 0) > 0;
}

// P3-SESSION (drills finding 1): console logout ends every preview this person
// opened on this store, on every device: each unrevoked row created_by this
// actor gets revoked_at. Another person's rows are untouched. Returns how many
// rows it revoked. An actor without a kind and id ("unknown") revokes nothing,
// so rows written without a known author are never swept up. Like the other
// writes it throws (a missing table too); the logout route catches, logs
// preview_logout_revoke_failed and still signs the person out.
export async function revokePreviewSessionsFor({ actor, now = Date.now() } = {}) {
  const key = actorKey(actor);
  if (key === "unknown") return 0;
  const r = await libsql.execute({
    sql: "UPDATE preview_sessions SET revoked_at = ? WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL",
    args: [iso(now), tenantId(), key],
  });
  return Number(r.rowsAffected || 0);
}

// The logout route's call (app/api/admin/logout/route.js). Never throws, so
// it can never block a logout:
//   storeResolved false (a host that names no store) -> nothing to revoke;
//   resolveActor() -> the person this console cookie belongs to, or null;
//   a missing table (a store before 0022) or any database error is logged.
// Each failure logs preview_logout_revoke_failed with a reason (no_tenant,
// no_table or error). Returns the number of sessions it ended.
export async function endPreviewsAtLogout({ storeResolved = true, resolveActor, now = Date.now() } = {}) {
  if (!storeResolved) {
    slog("preview_logout_revoke_failed", { reason: "no_tenant" });
    return 0;
  }
  try {
    const actor = typeof resolveActor === "function" ? await resolveActor() : null;
    if (!actor) return 0; // not signed in (or already signed out): nothing of theirs to end
    const revoked = await revokePreviewSessionsFor({ actor, now });
    if (revoked > 0) slog("preview_logout_revoked", { count: revoked });
    return revoked;
  } catch (e) {
    slog("preview_logout_revoke_failed", {
      reason: notMigratedYet(e, { table: "preview_sessions" }) ? "no_table" : "error",
      error: String(e?.cause?.message || e?.message || e).slice(0, 200),
    });
    return 0;
  }
}

// The storefront's read, one statement:
//   { ok: true, session: { id, showDesign, otherTab } }
//   { ok: false, reason: "no_table" | "not_found" | "other_store" | "expired" | "revoked" | "error" }
// otherTab: the same person opened a newer session that still counts (another
// editor tab). Never throws.
export async function readPreviewSession(sid, { now = Date.now() } = {}) {
  if (!PREVIEW_SID_RE.test(String(sid || ""))) return { ok: false, reason: "not_found" };
  let row;
  try {
    const r = await libsql.execute({
      sql: `SELECT s.id, s.tenant_id, s.expires_at, s.revoked_at, s.show_design,
              EXISTS (SELECT 1 FROM preview_sessions n
                       WHERE n.created_by = s.created_by AND n.id <> s.id AND n.created_at > s.created_at
                         AND n.revoked_at IS NULL AND n.expires_at > ?) AS newer
            FROM preview_sessions s WHERE s.id = ?`,
      args: [iso(now), sid],
    });
    row = r.rows[0];
  } catch (e) {
    if (notMigratedYet(e, { table: "preview_sessions" })) return { ok: false, reason: "no_table" };
    slog("preview_session_read_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return { ok: false, reason: "error" };
  }
  if (!row) return { ok: false, reason: "not_found" };
  if (String(row.tenant_id) !== tenantId()) return { ok: false, reason: "other_store" };
  if (row.revoked_at != null) return { ok: false, reason: "revoked" };
  if (String(row.expires_at) <= iso(now)) return { ok: false, reason: "expired" };
  return { ok: true, session: { id: String(row.id), showDesign: Number(row.show_design) === 1, otherTab: Number(row.newer) === 1 } };
}
