// Feature flags (Session 47 / OP13). Plain-Node, control-plane backed.
//
// DELIBERATELY SEPARATE from entitlements: billing (S40) answers "what did
// this merchant BUY"; flags answer "what has the OPERATOR rolled out/killed".
// Keys are namespaced ff_* so the two vocabularies can't collide, and
// nothing in billing reads this table.
//
// Evaluation is SERVER-SIDE only:
//   · critical flags (the checkout kill-switch) are read UNCACHED on every
//     evaluation — an emergency disable takes effect on the next request on
//     every instance, no cache window;
//   · non-critical flags cache for FLAG_CACHE_MS (default 30s) per process.
// Fail-open by design: a missing row or an unreachable control plane means
// the fallback (feature stays up) — a kill-switch that fails closed would
// let a platform outage kill every checkout, which is the wrong failure.
import { platformDb, platformConfigured } from "./control.js";
import { audit, operatorActor, operatorNames } from "./audit.js";
import { slog } from "../log.js";

const KEY_RE = /^ff_[a-z0-9][a-z0-9-]{0,40}$/;
export const FLAG_KEY_RE = KEY_RE;

// Phase 3 line 4: what the code does when a flag is missing (its flagEnabled
// fallback at the call site), so a delete can say what happens next. A key not
// here falls back to flagEnabled's default: on. test-flags-incidents checks
// these against the call sites.
export const FLAG_FALLBACKS = Object.freeze({ ff_checkout: true, "ff_self-signup": false });
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const flagAudit = (actor, action, key, diff = null) => audit({ actor: operatorActor(actor), action, resource: `flag:${key}`, tenantId: null, diff });
const FLAG_CACHE_MS = Number(process.env.FLAG_CACHE_MS || 30000);
const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

let cache = { at: 0, rows: null };
export const __resetFlagCache = () => {
  cache = { at: 0, rows: null };
};

async function readFlags() {
  const r = await platformDb().execute("SELECT * FROM feature_flags");
  return r.rows.map((row) => ({ ...row, tenants: parse(row.tenants, {}) }));
}

function evaluate(flag, tenantSlug) {
  if (!flag) return null; // caller applies the fallback
  if (flag.expires_at && flag.expires_at <= nowIso()) return false; // expired = off, for everyone
  const t = flag.tenants || {};
  if (tenantSlug != null && Object.hasOwn(t, tenantSlug)) return Boolean(Number(t[tenantSlug]));
  return Boolean(Number(flag.default_on));
}

// The one evaluator. fallback applies when the flag doesn't exist, the
// platform isn't configured (legacy mode), or the control plane is down.
export async function flagEnabled(key, tenantSlug = null, { fallback = true } = {}) {
  try {
    return (await flagState(key, tenantSlug)) ?? fallback;
  } catch {
    return fallback; // control-plane outage never decides a feature
  }
}

// Phase 4 line 2: the same evaluation, for a caller that decides an outage
// itself: true / false, null when there is no such flag (or no control
// plane, legacy mode), and a throw when the control plane can't be read.
export async function flagState(key, tenantSlug = null) {
  if (!platformConfigured()) return null;
  // critical? the row itself says — but we don't know before reading it,
  // so: cached read first; a row marked critical forces a fresh re-read.
  let rows = cache.rows && Date.now() - cache.at < FLAG_CACHE_MS ? cache.rows : null;
  if (!rows) {
    rows = await readFlags();
    cache = { at: Date.now(), rows };
  }
  let flag = rows.find((f) => f.key === key);
  if (flag?.critical) {
    // checkout-critical: ALWAYS re-read the row — every evaluation sees
    // the current state, so an emergency disable is immediate everywhere.
    // (Only the critical bit itself rides the cache: flip a flag TO
    // critical and the stricter read starts within the cache window.)
    const fresh = await platformDb().execute({ sql: "SELECT * FROM feature_flags WHERE key = ?", args: [key] });
    flag = fresh.rows[0] ? { ...fresh.rows[0], tenants: parse(fresh.rows[0].tenants, {}) } : null;
  }
  return evaluate(flag, tenantSlug);
}

export async function listFlags() {
  if (!platformConfigured()) return [];
  const rows = await readFlags();
  const names = await operatorNames(rows.map((f) => f.updated_by));
  return rows
    .map((f) => ({
      ...f,
      critical: !!Number(f.critical),
      default_on: !!Number(f.default_on),
      expired: Boolean(f.expires_at && f.expires_at <= nowIso()),
      updated_by_name: f.updated_by ? names.get(String(f.updated_by)) || String(f.updated_by) : null,
      fallback: Object.hasOwn(FLAG_FALLBACKS, f.key) ? FLAG_FALLBACKS[f.key] : true,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// Create or edit. create: true only inserts (409 when the key exists). An edit
// never writes overrides: the stored ones are kept (they change only through
// setFlagOverride, one store at a time), so an edit can't undo another
// operator's override. tenants seeds the overrides of a new flag only.
// A key in FLAG_FALLBACKS (a kill switch) takes no expiry: an expired flag is
// off, and an expired checkout switch would stop every checkout.
export async function setFlag({ key, description = "", default_on = false, tenants = {}, critical = false, expires_at = null, create = false, actor = "operator" }) {
  if (!KEY_RE.test(key || "")) throw fail(400, "Flag keys are namespaced: ff_ then lowercase letters, digits and dashes (entitlements live in billing, not here).");
  const clean = {};
  for (const [slug, v] of Object.entries(tenants || {})) {
    if (SLUG_RE.test(slug)) clean[slug] = v ? 1 : 0;
  }
  if (expires_at && Number.isNaN(Date.parse(expires_at))) throw fail(400, "The expiry must be a date and time.");
  if (expires_at && Object.hasOwn(FLAG_FALLBACKS, key)) throw fail(422, `${key} is a kill switch, so it can't expire: an expired flag is off for every store. Leave the expiry empty.`);
  if (expires_at) expires_at = new Date(expires_at).toISOString();
  expires_at = expires_at || null;
  const r = await platformDb().execute({
    sql: `INSERT INTO feature_flags (key, description, default_on, tenants, critical, expires_at, updated_at, updated_by)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(key) DO ${
            create
              ? "NOTHING"
              : `UPDATE SET description=excluded.description, default_on=excluded.default_on,
            tenants=COALESCE(feature_flags.tenants, excluded.tenants), critical=excluded.critical, expires_at=excluded.expires_at,
            updated_at=excluded.updated_at, updated_by=excluded.updated_by`
          }`,
    args: [key, String(description).slice(0, 300), default_on ? 1 : 0, JSON.stringify(clean), critical ? 1 : 0, expires_at, nowIso(), operatorActor(actor).id.slice(0, 80)],
  });
  if (!r.rowsAffected) throw fail(409, `A flag called ${key} already exists. Edit it instead.`);
  __resetFlagCache();
  await flagAudit(actor, "flags.set", key, { default_on: !!default_on, critical: !!critical, expires_at, ...(create ? { created: true, tenants: Object.keys(clean).length } : {}) });
  slog("flag_set", { flag: key, default_on: !!default_on, critical: !!critical });
  return { key };
}

// The emergency path: default off, every cohort cleared, audited loudly.
export async function emergencyDisable(key, actor = "operator") {
  if (!KEY_RE.test(key || "")) throw fail(400, "Not a flag key.");
  const r = await platformDb().execute({
    sql: "UPDATE feature_flags SET default_on = 0, tenants = '{}', updated_at = ?, updated_by = ? WHERE key = ?",
    args: [nowIso(), operatorActor(actor).id.slice(0, 80), key],
  });
  if (!r.rowsAffected) throw fail(404, "No flag with that key.");
  __resetFlagCache();
  await flagAudit(actor, "flags.emergency_disable", key);
  slog("flag_emergency_disable", { flag: key });
  return { key, disabled: true };
}

export async function deleteFlag(key, actor = "operator") {
  const r = await platformDb().execute({ sql: "DELETE FROM feature_flags WHERE key = ?", args: [key] });
  if (!r.rowsAffected) throw fail(404, "No flag with that key.");
  __resetFlagCache();
  await flagAudit(actor, "flags.delete", key, { fallback: Object.hasOwn(FLAG_FALLBACKS, key) ? FLAG_FALLBACKS[key] : true });
  return { key, deleted: true };
}

// Phase 3 line 4: one store's override. on: true | false sets it, null removes
// it (the store follows the flag's default again). The store must exist (404).
export async function setFlagOverride({ key, tenant, on, actor }) {
  if (!KEY_RE.test(key || "")) throw fail(400, "Not a flag key.");
  const slug = String(tenant || "");
  const t = await platformDb().execute({ sql: "SELECT id FROM tenants WHERE id = ?", args: [slug] });
  if (!t.rows[0]) throw fail(404, "No store with that id.");
  if (!SLUG_RE.test(slug)) throw fail(404, "No store with that id.");
  // one statement: the change is made to the stored overrides, never to a copy read earlier
  const path = `$."${slug}"`;
  const r = await platformDb().execute({
    sql: `UPDATE feature_flags SET tenants = ${on == null ? "json_remove(COALESCE(tenants, '{}'), ?)" : "json_set(COALESCE(tenants, '{}'), ?, ?)"}, updated_at = ?, updated_by = ? WHERE key = ?`,
    args: [path, ...(on == null ? [] : [on ? 1 : 0]), nowIso(), operatorActor(actor).id.slice(0, 80), key],
  });
  if (!r.rowsAffected) throw fail(404, "No flag with that key.");
  __resetFlagCache();
  await flagAudit(actor, "flags.override", key, { store: slug, on: on == null ? "removed" : !!on });
  return { key, tenant: slug, on: on == null ? null : !!on };
}

// A flag's history, newest first: { at, action, by, changes }.
export async function flagHistory(key, { limit = 50 } = {}) {
  if (!KEY_RE.test(key || "")) throw fail(400, "Not a flag key.");
  const res = await platformDb().execute({
    sql: `SELECT at, actor, action, diff FROM audit_log WHERE tenant_id IS NULL AND resource = ? ORDER BY at DESC, rowid DESC LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`,
    args: [`flag:${key}`],
  });
  const names = await operatorNames(res.rows.map((r) => r.actor));
  return res.rows.map((r) => ({ at: r.at, action: String(r.action), by: names.get(String(r.actor)) || String(r.actor), changes: parse(r.diff, {}) }));
}
