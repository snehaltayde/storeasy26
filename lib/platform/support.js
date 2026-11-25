// Support-access grants (Session 34 / OP10). An operator may enter a tenant's
// merchant console ONLY through an active grant: time-limited, with a stated
// reason, audited at creation/revocation, merchant-visible as a banner, and
// always as the SUPPORT role (read-only, PII-redacted — S27/S31 do the rest).
// Expiry is checked fresh on every request (no cache), so a lapsed grant fails
// on the operator's very next call, open tabs included.
// Edge-safe: admin pages verify through this.
//
// Phase 3 line 5 (docs/plans/phase-3.md "Line 5", decision 4): entry across
// hosts. The operator console mints a single-use `support_entry` session (60
// seconds, tied to the grant, never for bootstrap); the store's
// /api/admin/support-entry uses it up with one conditional UPDATE and issues a
// `support` session tied to the same grant, which the store's host-only
// `__Host-support` cookie carries. Closing a grant revokes both kinds at once, and
// supportActor (lib/admin-auth.js) re-checks the grant on every request, so an
// expired grant ends the session at once too. Tokens are returned to the
// caller only: never logged, audited or put in a URL.
import { platformDb, platformConfigured, getTenant } from "./control.js";
import { newId, createSession, sha256Hex, verifySession, OPERATOR_SESSION_TTL_MS } from "./sessions.js";
import { audit, operatorActor } from "./audit.js";
import { sendMail, mailConfigured } from "../mail.js";

const nowIso = () => new Date().toISOString();

export const SUPPORT_HOURS = Object.freeze([1, 4, 8, 24, 72]);
export const SUPPORT_ENTRY_TTL_MS = 60_000;
export const SUPPORT_COOKIE = "__Host-support"; // host-only by the browser's own rule: Secure, Path=/, no Domain
const HISTORY_LIMIT = 20;

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

// Ends the grant's entry and support sessions (best effort on a control plane
// before 0017, which has no sessions.grant_id and so no such sessions).
async function revokeGrantSessions(grantId) {
  try {
    await platformDb().execute({
      sql: "UPDATE sessions SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
      args: [nowIso(), grantId],
    });
  } catch {}
}

// `actor`: an audit actor ({ kind, id, role? }) for a merchant ending access;
// otherwise `operator` names the operator (requireOperator's operator or an id).
// tenantId, when given, must be the grant's store (a merchant ends only its own).
export async function revokeSupportGrant(id, { operator = "operator", actor = null, tenantId = null } = {}) {
  const res = await platformDb().execute({
    sql: `UPDATE support_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL${tenantId ? " AND tenant_id = ?" : ""} RETURNING tenant_id`,
    args: [nowIso(), id, ...(tenantId ? [tenantId] : [])],
  });
  const row = res.rows[0];
  if (!row) return false;
  await revokeGrantSessions(id);
  await audit({
    actor: actor || operatorActor(operator),
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
      sql: `SELECT id, operator, reason, created_at, expires_at FROM support_grants
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

// --- names -------------------------------------------------------------------------
// The words a store's team (and the operator console) see for an operator id:
// the operator's name, never their id or email.
export const OPERATOR_FALLBACK = "A Storeasy operator";
export const BOOTSTRAP_LABEL = "Storeasy setup sign-in";

async function userNames(ids) {
  const list = [...new Set(ids.filter((x) => x && x !== "bootstrap").map(String))];
  const out = new Map();
  if (!list.length) return out;
  const res = await platformDb()
    .execute({ sql: `SELECT id, name FROM users WHERE id IN (${list.map(() => "?").join(", ")})`, args: list })
    .catch(() => ({ rows: [] }));
  for (const r of res.rows) if (r.name) out.set(String(r.id), String(r.name));
  return out;
}

const labelFor = (names, id) => (id === "bootstrap" ? BOOTSTRAP_LABEL : names.get(String(id)) || OPERATOR_FALLBACK);

// id → the words for each operator id (one read), for the team's audit view.
export async function operatorNames(ids) {
  const names = await userNames(ids);
  return new Map([...new Set(ids.map(String))].map((id) => [id, labelFor(names, id)]));
}

export async function operatorName(id) {
  return labelFor(await userNames([id]), id);
}

// --- history -----------------------------------------------------------------------
// A store's last 20 grants, newest first, each with who opened it, why, when,
// and how it ended: open, closed (and by whom: an operator's name, or "Your
// team" / a member's name for a merchant) or expired.
//   → [{ id, operatorName, reason, openedAt, expiresAt, state, endedAt, endedBy }]
export async function supportHistory(tenantId, { limit = HISTORY_LIMIT } = {}) {
  if (!platformConfigured() || !tenantId) return [];
  const grants = (
    await platformDb().execute({
      sql: "SELECT id, operator, reason, created_at, expires_at, revoked_at FROM support_grants WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      args: [tenantId, Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), HISTORY_LIMIT)],
    })
  ).rows;
  const closedIds = grants.filter((g) => g.revoked_at).map((g) => `grant:${g.id}`);
  const closers = new Map();
  if (closedIds.length) {
    const res = await platformDb()
      .execute({
        sql: `SELECT resource, actor, actor_kind FROM audit_log WHERE tenant_id = ? AND action = 'support.grant_revoked' AND resource IN (${closedIds.map(() => "?").join(", ")})`,
        args: [tenantId, ...closedIds],
      })
      .catch(() => ({ rows: [] }));
    for (const r of res.rows) closers.set(String(r.resource).slice("grant:".length), { id: String(r.actor), kind: String(r.actor_kind) });
  }
  const names = await userNames([...grants.map((g) => g.operator), ...[...closers.values()].map((c) => c.id)]);
  const now = Date.now();
  return grants.map((g) => {
    const closer = closers.get(String(g.id));
    const state = g.revoked_at ? "closed" : new Date(g.expires_at).getTime() <= now ? "expired" : "open";
    const endedBy = !closer ? null : closer.kind === "merchant" ? names.get(closer.id) || "Your team" : labelFor(names, closer.kind === "bootstrap" ? "bootstrap" : closer.id);
    return {
      id: String(g.id),
      operatorName: labelFor(names, g.operator),
      reason: String(g.reason),
      openedAt: g.created_at,
      expiresAt: g.expires_at,
      state,
      endedAt: state === "closed" ? g.revoked_at : state === "expired" ? g.expires_at : null,
      endedBy: state === "closed" ? endedBy : null,
    };
  });
}

// The open grant (or null) and the history, for one store's team and the
// operator's store page. → { open: { id, operatorName, reason, openedAt, expiresAt } | null, history }
export async function supportAccessView(tenantId) {
  const history = await supportHistory(tenantId);
  const g = history.find((h) => h.state === "open") || null;
  return { open: g ? { id: g.id, operatorName: g.operatorName, reason: g.reason, openedAt: g.openedAt, expiresAt: g.expiresAt } : null, history };
}

// Every open grant across stores, for /platform/support-access.
//   → [{ id, tenantId, storeName, operatorName, reason, openedAt, expiresAt }]
export async function openSupportGrants() {
  const res = await platformDb().execute({
    sql: `SELECT g.id, g.tenant_id, g.operator, g.reason, g.created_at, g.expires_at, t.name AS store_name
          FROM support_grants g LEFT JOIN tenants t ON t.id = g.tenant_id
          WHERE g.revoked_at IS NULL AND g.expires_at > ? ORDER BY g.expires_at ASC LIMIT 200`,
    args: [nowIso()],
  });
  const names = await userNames(res.rows.map((r) => r.operator));
  return res.rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenant_id),
    storeName: r.store_name ? String(r.store_name) : String(r.tenant_id),
    operatorName: labelFor(names, r.operator),
    reason: String(r.reason),
    openedAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

// --- the store's team hears about it ------------------------------------------------
// Owners and admins are emailed when access opens. Best effort: a failure is
// counted, never thrown. → { configured, sent, failed }
export async function mailSupportOpened({ tenantId, grant, operator }) {
  const out = { configured: mailConfigured(), sent: 0, failed: 0 };
  try {
    const tenant = await getTenant(tenantId).catch(() => null);
    const to = (
      await platformDb().execute({
        sql: "SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role IN ('owner', 'admin') AND u.status = 'active'",
        args: [tenantId],
      })
    ).rows.map((r) => String(r.email));
    const who = operator?.kind === "bootstrap" ? BOOTSTRAP_LABEL : operator?.name || (await operatorName(operator?.id));
    const store = tenant?.name || tenantId;
    const until = new Date(grant.expiresAt).toUTCString();
    for (const email of to) {
      const r = await sendMail({
        to: email,
        subject: `Storeasy support access to ${store} is open`,
        text: `${who} from Storeasy opened read-only support access to ${store} until ${until}.\nReason: ${grant.reason}\n\nSupport access can't change anything and never sees customer contact details. An owner or admin can end it at any time from Settings, Team in your store's console.`,
      }).catch(() => ({ ok: false }));
      if (r?.ok) out.sent++;
      else out.failed++;
    }
  } catch {
    out.failed++;
  }
  return out;
}

// --- entry across hosts -------------------------------------------------------------
const isLocalHost = (host) => /(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(host);

export class SupportEntryRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Mint the single-use entry token for `operator` (requireOperator's operator)
// on the store's open grant. → { token, entryUrl, expiresAt }. Refuses (with a
// status): no such store (404), no open grant (409), the setup password (403),
// a store without a domain (409). storeOrigin(tenant) → the store's origin
// (the route passes lib/platform/onboarding-ops.js storeOrigin, which keeps the
// console's port for a local store); by default its first domain.
// consoleOrigin: the operator console's origin the mint request came from
// (lib/origin-check.js requestOrigin); the entry route accepts the token only
// from a form posted by that origin.
export async function mintSupportEntry({ tenantId, operator, consoleOrigin, storeOrigin = null }) {
  const tenant = typeof tenantId === "string" && tenantId ? await getTenant(tenantId, { fresh: true }).catch(() => null) : null;
  if (!tenant) throw new SupportEntryRefused(404, "No such store.");
  const grant = await activeSupportGrant(tenant.id);
  if (!grant) throw new SupportEntryRefused(409, "Support access isn't open for this store. Open it first.");
  if (!operator || operator.kind !== "operator") {
    throw new SupportEntryRefused(403, "The setup password can't enter a store's console. Sign in with your operator account and authenticator code.");
  }
  const host = tenant.domains?.[0];
  const origin = host ? (storeOrigin ? storeOrigin(tenant) : `${isLocalHost(host) ? "http" : "https"}://${host}`) : null;
  if (!origin) throw new SupportEntryRefused(409, "This store has no domain yet, so its console can't be opened.");
  if (typeof consoleOrigin !== "string" || !/^https?:\/\/[^/]+$/.test(consoleOrigin)) throw new SupportEntryRefused(400, "The operator console's address is unknown.");
  const { token, id, expiresAt } = await createSession({ userId: operator.id, kind: "support_entry", ttlMs: SUPPORT_ENTRY_TTL_MS, grantId: grant.id });
  // a row without its origin can never be used (consume matches it exactly)
  await platformDb().execute({ sql: "UPDATE sessions SET entry_origin = ? WHERE id = ?", args: [consoleOrigin, id] });
  await audit({ actor: operatorActor(operator), action: "support.entry_issued", tenantId: tenant.id, resource: `grant:${grant.id}` });
  return { token, expiresAt, entryUrl: `${origin}/api/admin/support-entry` };
}

// Use up an entry token on the store `tenantId` (the host-resolved store).
// The conditional UPDATE is the single use: of two racing calls, one gets the
// row. Then the operator must still be an active operator, and the grant open
// and this store's. → { token, expiresAt, grantId, userId } for the new
// support session, or null. `origin` is the posting page's Origin header: it
// must be the console origin the token was minted on, or the token is not
// touched; any other refusal spends it.
export async function consumeSupportEntry(token, tenantId, origin) {
  if (!token || typeof token !== "string" || token.length > 128 || !tenantId || !platformConfigured()) return null;
  if (typeof origin !== "string" || !origin || origin === "null") return null;
  const now = nowIso();
  let row;
  try {
    row = (
      await platformDb().execute({
        sql: `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND kind = 'support_entry' AND revoked_at IS NULL AND expires_at > ? AND entry_origin = ?
              RETURNING user_id, grant_id`,
        args: [now, await sha256Hex(token), now, origin],
      })
    ).rows[0];
  } catch {
    return null;
  }
  if (!row?.grant_id) return null;
  const user = (await platformDb().execute({ sql: "SELECT status, is_operator FROM users WHERE id = ?", args: [row.user_id] })).rows[0];
  if (!user || user.status !== "active" || !Number(user.is_operator)) return null;
  const grant = await activeSupportGrant(tenantId);
  if (!grant || String(grant.id) !== String(row.grant_id)) return null;
  // the session ends with the grant (or the operator's usual 12 hours, if sooner)
  const ttlMs = Math.min(new Date(grant.expires_at).getTime() - Date.now(), OPERATOR_SESSION_TTL_MS);
  if (ttlMs <= 0) return null;
  const s = await createSession({ userId: String(row.user_id), kind: "support", ttlMs, grantId: String(grant.id) });
  await audit({ actor: operatorActor(String(row.user_id)), action: "support.entered", tenantId, resource: `grant:${grant.id}` });
  return { token: s.token, expiresAt: s.expiresAt, grantId: String(grant.id), userId: String(row.user_id) };
}

// A `__Host-support` cookie on store `tenantId`: a live support session whose grant
// is this store's open grant. → { userId, grantId, sessionId } or null.
export async function verifySupportSession(token, tenantId) {
  if (!token || !tenantId) return null;
  const s = await verifySession(token, "support");
  if (!s) return null;
  const grant = await activeSupportGrant(tenantId);
  if (!grant || String(grant.id) !== String(s.grantId)) return null;
  return { userId: s.userId, grantId: s.grantId, sessionId: s.sessionId };
}
