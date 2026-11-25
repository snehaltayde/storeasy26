// Phase 4 line 4: scoped API tokens for custom apps (tenant table
// plugin_tokens, migration 0033). SERVER-ONLY, tenant-scoped (withTenant).
//
// A token is "sea_<tok_id>.<64 hex secret>". It is answered once, by
// mintToken; only sha256(secret) is stored and it is compared in constant
// time. What a call may read is the token's scopes ∩ the app's current
// approval, worked out on every call (verifyToken), so narrowing the app's
// approval narrows every token at once. Revoking keeps the row. Every write
// records an audit row on app:<install id>; no row ever holds the secret or
// its hash, and no diff key is named like one.
//
//   tokensView(installId)                    the API access card's data
//   mintToken(installId, { name, scopes, days }, { actor }) → { token, secret }
//   revokeToken(installId, tokId, { actor })
//   setScopes(installId, { scopes, confirm }, { actor })  narrowing at once;
//                                            widening only with confirm
//   verifyToken(raw)                         the API gate's lookup (api-auth.js)
//   callsView(installId)                     the last 100 calls (audit rows)
import { db, libsql } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { audit, listAudit } from "../platform/audit.js";
import { newId, newToken, sha256Hex } from "../platform/sessions.js";
import { APP_PERMISSIONS } from "../platform/authz.js";
import { namesFor, plainName } from "../documents/versions.js";
import { AppError, isKilled } from "./installs.js";
import { requiredScope } from "./topics.js";

export const TOKEN_PREFIX = "sea_";
export const MAX_ACTIVE_TOKENS = 5;
export const EXPIRY_DAYS = Object.freeze([30, 90, 365]);
export const DEFAULT_EXPIRY_DAYS = 90;
export const EXPIRING_SOON_DAYS = 7;
export const CALLS_SHOWN = 100;
export const API_CALL_ACTION = "apps.api_call";
const DAY = 24 * 60 * 60_000;
// "sea_tok_<16 hex>.<64 hex>"
const TOKEN_RE = /^sea_(tok_[0-9a-f]{16})\.([0-9a-f]{64})$/;

const nowIso = () => new Date().toISOString();
const resourceOf = (id) => `app:${id}`;
const actorString = (actor) => `${actor?.kind ?? "system"}:${actor?.id ?? ""}`;
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const NOT_FOUND = () => new AppError(404, "NOT_FOUND", "This app isn't installed on your store. It may have been uninstalled.");

// Constant-time string comparison (both are 64 hex characters when well formed).
export function sameSecret(a, b) {
  const A = String(a ?? "");
  const B = String(b ?? "");
  if (!A.length || !B.length) return false;
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= A.charCodeAt(i % A.length) ^ B.charCodeAt(i % B.length);
  return diff === 0;
}

export function tokenStatus(row, now = Date.now()) {
  if (row.revoked_at) return "revoked";
  const exp = Date.parse(row.expires_at);
  if (!(exp > now)) return "expired";
  return exp - now <= EXPIRING_SOON_DAYS * DAY ? "expiring" : "active";
}

async function customApp(id) {
  if (typeof id !== "string" || !/^pin_[0-9a-f]{16}$/.test(id)) throw NOT_FOUND();
  const row = await db.selectFrom("plugin_installs").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row || row.status === "uninstalled") throw NOT_FOUND();
  if (row.kind !== "custom") throw new AppError(409, "NOT_CUSTOM", "Only custom apps get API tokens.");
  return row;
}

const scopeWords = (s) => ({ scope: s, words: APP_PERMISSIONS[s] ?? s });

function tokenView(r, names, now) {
  return {
    id: String(r.id),
    name: String(r.name),
    scopes: parse(r.scopes, []),
    createdByName: plainName(r.created_by, names),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    lastUsedAt: r.last_used_at ?? null,
    revokedAt: r.revoked_at ?? null,
    status: tokenStatus(r, now),
  };
}

// The API access card: what the app may see, what may be offered, its tokens
// (newest first, revoked ones kept). Never a secret or a hash.
export async function tokensView(installId) {
  const app = await customApp(installId);
  const [rows, names] = await Promise.all([
    db.selectFrom("plugin_tokens").select(["id", "name", "scopes", "created_by", "created_at", "expires_at", "last_used_at", "revoked_at"]).where("install_id", "=", app.id).orderBy("created_at", "desc").orderBy("id", "desc").execute(),
    namesFor(tenantId()),
  ]);
  const now = Date.now();
  const granted = parse(app.granted_scopes, []);
  return {
    scopes: granted.map(scopeWords),
    offered: Object.keys(APP_PERMISSIONS).map(scopeWords),
    tokens: rows.map((r) => tokenView(r, names, now)),
    maxActive: MAX_ACTIVE_TOKENS,
    expiryDays: [...EXPIRY_DAYS],
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
  };
}

export async function mintToken(installId, { name, scopes, days } = {}, { actor }) {
  const app = await customApp(installId);
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > 60) throw new AppError(422, "NAME_INVALID", "Give the token a name of up to 60 characters.", { errors: { name: "Give the token a name of up to 60 characters." } });
  const granted = parse(app.granted_scopes, []);
  const s = Array.isArray(scopes) ? [...new Set(scopes.map(String))].sort() : [];
  if (s.some((x) => !granted.includes(x))) {
    throw new AppError(422, "SCOPES_INVALID", "A token can only have permissions this app was given.", { errors: { scopes: "A token can only have permissions this app was given." } });
  }
  if (!s.length && granted.length) throw new AppError(422, "SCOPES_INVALID", "Choose at least one permission.", { errors: { scopes: "Choose at least one permission." } });
  const d = days === undefined || days === null || days === "" ? DEFAULT_EXPIRY_DAYS : Number(days);
  if (!EXPIRY_DAYS.includes(d)) throw new AppError(422, "EXPIRY_INVALID", "Choose 30, 90 or 365 days.", { errors: { days: "Choose 30, 90 or 365 days." } });
  const id = newId("tok");
  const secret = newToken();
  const at = nowIso();
  const expires = new Date(Date.now() + d * DAY).toISOString();
  // the cap is counted inside the insert, so two creates at 4 active make one token
  const r = await libsql.execute({
    sql: `INSERT INTO plugin_tokens (id, install_id, name, secret_hash, scopes, created_by, created_at, expires_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM plugin_tokens WHERE install_id = ? AND revoked_at IS NULL AND expires_at > ?) < ?`,
    args: [id, app.id, n, await sha256Hex(secret), JSON.stringify(s), actorString(actor), at, expires, app.id, at, MAX_ACTIVE_TOKENS],
  });
  if (!Number(r?.rowsAffected ?? 0)) throw new AppError(409, "TOO_MANY", `An app can have up to ${MAX_ACTIVE_TOKENS} active tokens. Revoke one to create another.`);
  await audit({ actor, action: "apps.token_create", resource: resourceOf(app.id), diff: { via: id, name: n, scopes: s, expires_at: expires } });
  const names = await namesFor(tenantId());
  const row = await db.selectFrom("plugin_tokens").select(["id", "name", "scopes", "created_by", "created_at", "expires_at", "last_used_at", "revoked_at"]).where("id", "=", id).executeTakeFirst();
  return { token: tokenView(row, names, Date.now()), secret: `${TOKEN_PREFIX}${id}.${secret}` };
}

export async function revokeToken(installId, tokId, { actor }) {
  const app = await customApp(installId);
  const id = typeof tokId === "string" ? tokId : "";
  const row = /^tok_[0-9a-f]{16}$/.test(id) ? await db.selectFrom("plugin_tokens").select(["id", "revoked_at"]).where("id", "=", id).where("install_id", "=", app.id).executeTakeFirst() : null;
  if (!row) throw new AppError(404, "TOKEN_NOT_FOUND", "We couldn't find that token. Reload the page to see this app's tokens.");
  if (row.revoked_at) throw new AppError(409, "ALREADY_REVOKED", "That token is already revoked.");
  await db.updateTable("plugin_tokens").set({ revoked_at: nowIso(), revoked_by: actorString(actor) }).where("id", "=", id).where("revoked_at", "is", null).execute();
  await audit({ actor, action: "apps.token_revoke", resource: resourceOf(app.id), diff: { via: id } });
  return tokensView(app.id);
}

// The app's approved permissions. Narrowing takes effect on the next call of
// every token; widening asks again (confirm: true, after the same words the
// create dialog shows). A permission the app's webhook events need stays.
export async function setScopes(installId, { scopes, confirm = false } = {}, { actor }) {
  const app = await customApp(installId);
  const s = Array.isArray(scopes) ? [...new Set(scopes.map(String))].sort() : null;
  if (!s || s.some((x) => !Object.hasOwn(APP_PERMISSIONS, x))) throw new AppError(422, "SCOPES_INVALID", "One of those permissions isn't offered.", { errors: { scopes: "One of those permissions isn't offered." } });
  const before = parse(app.granted_scopes, []).slice().sort();
  const added = s.filter((x) => !before.includes(x));
  if (added.length && confirm !== true) {
    throw new AppError(409, "CONFIRM_WIDEN", "This gives the app more access. Review what it will be able to see and approve it.", { added: added.map(scopeWords) });
  }
  const ep = await db.selectFrom("plugin_endpoints").select(["topics"]).where("install_id", "=", app.id).executeTakeFirst();
  const needed = [...new Set(parse(ep?.topics, []).map(requiredScope))].filter((x) => x && !s.includes(x));
  if (needed.length) {
    const w = `The app's webhook events need "${APP_PERMISSIONS[needed[0]]}". Stop sending those events first.`;
    throw new AppError(422, "SCOPES_NEEDED", w, { errors: { scopes: w } });
  }
  if (s.join(",") === before.join(",")) return tokensView(app.id);
  const r = await db
    .updateTable("plugin_installs")
    .set({ granted_scopes: JSON.stringify(s), updated_at: nowIso(), updated_by: actorString(actor) })
    .where("id", "=", app.id)
    .where("updated_at", "=", app.updated_at)
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new AppError(409, "CHANGED", "This app was changed somewhere else. Nothing was saved. Reload the page and try again.");
  await audit({ actor, action: "apps.scopes", resource: resourceOf(app.id), diff: { from: before, to: s } });
  return tokensView(app.id);
}

// The gate's lookup. → { ok: true, token, install, scopes } (scopes: the
// effective ones) | { ok: false, reason, token?, install? }. A reason with a
// token is attributable (its secret matched); without one it is not.
//   reason: malformed | unknown | revoked | expired | app_off
export async function verifyToken(raw) {
  const m = TOKEN_RE.exec(String(raw ?? ""));
  if (!m) return { ok: false, reason: "malformed" };
  const [, id, secret] = m;
  const row = await db.selectFrom("plugin_tokens").selectAll().where("id", "=", id).executeTakeFirst();
  // hash either way, so an unknown id and a wrong secret take the same work
  const hash = await sha256Hex(secret);
  if (!row || !sameSecret(hash, row.secret_hash)) return { ok: false, reason: "unknown" };
  const token = { id: String(row.id), installId: String(row.install_id), name: String(row.name), scopes: parse(row.scopes, []), lastUsedAt: row.last_used_at ?? null };
  const install = await db.selectFrom("plugin_installs").select(["id", "plugin_id", "kind", "name", "status", "granted_scopes"]).where("id", "=", row.install_id).executeTakeFirst();
  const status = tokenStatus(row);
  if (status === "revoked" || status === "expired") return { ok: false, reason: status, token, install };
  if (!install || install.kind !== "custom" || install.status !== "enabled" || (await isKilled(install.plugin_id))) return { ok: false, reason: "app_off", token, install };
  const granted = parse(install.granted_scopes, []);
  return { ok: true, token, install, scopes: token.scopes.filter((s) => granted.includes(s)).sort() };
}

// last_used_at, at most once a minute per token; never fails the call.
export async function touchToken(token) {
  const now = Date.now();
  if (token.lastUsedAt && now - Date.parse(token.lastUsedAt) < 60_000) return;
  try {
    await db.updateTable("plugin_tokens").set({ last_used_at: new Date(now).toISOString() }).where("id", "=", token.id).execute();
  } catch {
    // the call itself is audited; a missed last-used time is not worth failing it
  }
}

// The Calls list: the app's last 100 API calls from the audit log (actor =
// the install id), with each token's name. resource is "GET /api/apps/v1/…".
export async function callsView(installId) {
  const app = await customApp(installId);
  const rows = await listAudit({ tenantId: tenantId(), actor: app.id, action: API_CALL_ACTION, limit: CALLS_SHOWN });
  const toks = await db.selectFrom("plugin_tokens").select(["id", "name"]).where("install_id", "=", app.id).execute();
  const nameOf = new Map(toks.map((t) => [String(t.id), String(t.name)]));
  return {
    calls: rows.map((r) => {
      const d = parse(r.diff, {});
      const [method, ...rest] = String(r.resource ?? "").split(" ");
      return {
        id: String(r.id),
        at: String(r.at),
        method: method || "GET",
        path: rest.join(" "),
        status: Number(d.status) || null,
        tokenId: typeof d.via === "string" ? d.via : null,
        tokenName: nameOf.get(String(d.via)) ?? null,
      };
    }),
  };
}
