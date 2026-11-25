// Phase 3 line 1: the operator's Stores list and store page
// (docs/plans/phase-3.md, "Line 1"). Node only; every caller has already
// passed requireOperator() (lib/platform/require-operator.js).
//
//   listStores({ q, status, plan, attention, sort, dir, offset })
//       -> { stores, total, offset, pageSize, counts, plans, params }
//       Control-plane SQL only (no store database is opened), 50 a page.
//   storeHealth(ids) -> { [id]: { state, reasons, ... } }
//       Opens each named store's database, at most 5 seconds each. A failed
//       or slow check is "unreachable", never healthy.
//   storeDetail(id) -> the store page's read model, or null for an unknown id
//
// Nothing here returns db_url, the database token, a secret value or a
// password hash: secrets appear by name only (scripts/test-platform-stores.js
// holds the canaries).
import { existsSync } from "node:fs";
import { platformDb, getTenant } from "./control.js";
import { loadMigrations } from "./migrate.js";
import { scrubSecrets } from "./turso-api.js";
import { withTenant } from "../tenant-context.js";
import { getLiveRelease } from "../releases.js";
import { DOCUMENTS_MESSAGE } from "../cms-mode.js";
import { themePinOf, kitAttr } from "../themes/kits.js";
import { db } from "../db.js";
import { sql } from "kysely";

export const PAGE_SIZE = 50;
export const STATUSES = Object.freeze(["active", "suspended", "maintenance"]);
export const SORTS = Object.freeze(["name", "created", "updated"]);
export const HEALTH_TIMEOUT_MS = 5000;
export const HEALTH_MAX_IDS = PAGE_SIZE;
export const MAX_OFFSET = 1_000_000;
// health reasons, in the order a row shows them
export const HEALTH_REASONS = Object.freeze(["sync_failed", "shopify_uninstalled", "pushes_failing", "migrations_behind"]);

export const storesClock = { now: () => Date.now() };
const rows = async (sql, args = []) => (await platformDb().execute({ sql, args })).rows.map((r) => ({ ...r }));
const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const isLocal = (host) => /(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(host);
export const storefrontUrl = (domains) => (domains?.[0] ? `${isLocal(domains[0]) ? "http" : "https"}://${domains[0]}` : null);

let repoHeadCache = null;
async function repoHead() {
  repoHeadCache ??= loadMigrations("tenant").then((m) => m.at(-1)?.id || "0001_baseline");
  return repoHeadCache;
}

// ---- the list ---------------------------------------------------------------------

export function listParams(input = {}) {
  const get = (k) => (typeof input.get === "function" ? input.get(k) : input[k]);
  const status = STATUSES.includes(get("status")) ? get("status") : null;
  const sort = SORTS.includes(get("sort")) ? get("sort") : "created";
  const dir = get("dir") === "asc" ? "asc" : get("dir") === "desc" ? "desc" : sort === "name" ? "asc" : "desc";
  const raw = Math.floor(Number(get("offset")) || 0);
  const offset = Number.isSafeInteger(raw) ? Math.min(Math.max(0, raw), MAX_OFFSET) : 0;
  const plan = String(get("plan") || "").trim().slice(0, 64) || null;
  const attention = ["1", "true", true].includes(get("attention"));
  return { q: String(get("q") || "").trim().slice(0, 200), status, plan, attention, sort, dir, offset: offset - (offset % PAGE_SIZE) };
}

// Every store with the facts the list filters, sorts and shows. ?1 = now.
// The latest subscription per store uses idx_subscriptions_tenant.
const BASE = `
WITH base AS (
  SELECT t.id, t.name, t.status, t.domains, t.created_at, t.updated_at,
    CASE WHEN t.status != 'active' THEN t.status
         WHEN json_extract(t.config, '$.maintenance.enabled') = 1 THEN 'maintenance'
         ELSE 'active' END AS shown_status,
    s.plan_id, s.status AS sub_status,
    p.supported AS ob_supported, p.open AS ob_open, p.done_count AS ob_done,
    CASE WHEN p.check_error IS NOT NULL OR instr(COALESCE(p.steps, ''), '"problem"') > 0 THEN 1 ELSE 0 END AS ob_problem,
    CASE WHEN json_extract(t.config, '$.shopify_app_uninstalled_at') IS NOT NULL THEN 1 ELSE 0 END AS uninstalled,
    EXISTS (SELECT 1 FROM support_grants g WHERE g.tenant_id = t.id AND g.revoked_at IS NULL AND g.expires_at > ?1) AS support_open,
    EXISTS (SELECT 1 FROM incidents i WHERE i.tenant_id = t.id AND i.status = 'open') AS incident_open
  FROM tenants t
  LEFT JOIN subscriptions s ON s.id = (SELECT id FROM subscriptions s2 WHERE s2.tenant_id = t.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
  LEFT JOIN onboarding_progress p ON p.tenant_id = t.id
),
v AS (
  SELECT base.*,
    CASE WHEN uninstalled = 1 OR ob_problem = 1 OR incident_open = 1 OR sub_status IN ('halted', 'cancelled', 'expired') THEN 1 ELSE 0 END AS attention
  FROM base
)`;

function whereFor({ q, status, plan, attention }) {
  const sql = [];
  const args = [];
  if (q) {
    if (q.includes("@")) {
      // owner email: an exact lower-case match, never LIKE over emails
      sql.push("EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = v.id AND m.role = 'owner' AND u.email = ?)");
      args.push(q.toLowerCase());
    } else {
      const like = `%${likeEscape(q.toLowerCase())}%`;
      sql.push("(lower(v.name) LIKE ? ESCAPE '\\' OR lower(v.id) LIKE ? ESCAPE '\\' OR lower(v.domains) LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
  }
  if (status) {
    sql.push("v.shown_status = ?");
    args.push(status);
  }
  if (plan === "none") sql.push("v.plan_id IS NULL");
  else if (plan) {
    sql.push("v.plan_id = ?");
    args.push(plan);
  }
  if (attention) sql.push("v.attention = 1");
  return { sql: sql.length ? ` WHERE ${sql.join(" AND ")}` : "", args };
}

const ORDER = { name: "lower(v.name)", created: "COALESCE(v.created_at, '')", updated: "COALESCE(v.updated_at, v.created_at, '')" };

function attentionReasons(r) {
  const out = [];
  if (r.uninstalled) out.push("shopify_uninstalled");
  if (r.ob_problem) out.push("onboarding_problem");
  if (r.incident_open) out.push("incident_open");
  if (["halted", "cancelled", "expired"].includes(r.sub_status)) out.push("billing_lapsed");
  return out;
}

const shapeRow = (r) => {
  const domains = parseJson(r.domains || "[]", []);
  return {
    id: r.id,
    name: r.name,
    status: r.shown_status,
    domains,
    storefrontUrl: storefrontUrl(domains),
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || r.created_at || null,
    plan: r.plan_id || null,
    subscription: r.sub_status || null,
    // null: no onboarding record yet; supported 0: a store that predates the steps
    onboarding: r.ob_supported == null ? null : { supported: Number(r.ob_supported) === 1, open: r.ob_open == null ? null : Number(r.ob_open) === 1, done: Number(r.ob_done || 0), total: 4 },
    attention: Number(r.attention) === 1,
    attentionReasons: attentionReasons(r),
    supportOpen: Number(r.support_open) === 1,
    incidentOpen: Number(r.incident_open) === 1,
  };
};

export async function listStores(input = {}, { now = storesClock.now() } = {}) {
  const params = listParams(input);
  const w = whereFor(params);
  const nowIso = new Date(now).toISOString();
  const order = `${ORDER[params.sort]} ${params.dir.toUpperCase()}, v.id ${params.dir.toUpperCase()}`;
  const [page, total, counts, plans] = await Promise.all([
    rows(`${BASE} SELECT * FROM v${w.sql} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${params.offset}`, [nowIso, ...w.args]),
    rows(`${BASE} SELECT COUNT(*) AS n FROM v${w.sql}`, [nowIso, ...w.args]),
    rows(`${BASE} SELECT shown_status, COUNT(*) AS n, SUM(attention) AS attention FROM v GROUP BY shown_status`, [nowIso]),
    rows("SELECT id, name FROM plans p WHERE version = (SELECT MAX(version) FROM plans p2 WHERE p2.id = p.id) ORDER BY price ASC, id ASC"),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.shown_status, Number(c.n)]));
  return {
    stores: page.map(shapeRow),
    total: Number(total[0]?.n || 0),
    offset: params.offset,
    pageSize: PAGE_SIZE,
    counts: {
      all: counts.reduce((s, c) => s + Number(c.n), 0),
      active: byStatus.active || 0,
      suspended: byStatus.suspended || 0,
      maintenance: byStatus.maintenance || 0,
      offboarded: byStatus.offboarded || 0,
      attention: counts.reduce((s, c) => s + Number(c.attention || 0), 0),
    },
    plans: plans.map((p) => ({ id: p.id, name: p.name })),
    params,
  };
}

// ---- live health ---------------------------------------------------------------------

// A query that fails when the store's database can't be reached: the other
// reads swallow their own errors (a missing table reads as empty), so
// reachability is never inferred from them.
// storesHooks: the probe and the limit, swappable by the unit suite (a store
// that never answers) the way storesClock swaps the time.
// deadlineMs and concurrency bound a fleet-wide pass (the overview).
export const storesHooks = { probe: () => sql`SELECT 1 AS ok`.execute(db), timeoutMs: HEALTH_TIMEOUT_MS, deadlineMs: 15_000, concurrency: 10 };

// A local file: store whose database file is missing is unreachable: opening
// it would make an empty new database that a probe happily answers.
export function storeFileMissing(dbUrl) {
  const url = String(dbUrl || "");
  if (!/^file:/i.test(url)) return false;
  const path = url.replace(/^file:(\/\/)?/i, "").split("?")[0];
  return !path || !existsSync(path);
}

// fn(tenant) inside each store's own context, for every row, at most
// `concurrency` at once, each bounded by timeoutMs and all by deadlineAt (a
// time in ms). A store not done in time, missing, or failing is
// { ok: false }, never a result. Results keep the rows' order. The overview
// uses this; forEachActiveTenant (lib/platform/ops.js) stays one by one for
// the jobs that rely on it.
export async function mapStores(rows, fn, { concurrency = storesHooks.concurrency, timeoutMs = storesHooks.timeoutMs, deadlineAt = Date.now() + storesHooks.deadlineMs } = {}) {
  const out = new Array(rows.length);
  let next = 0;
  async function one(row) {
    const left = deadlineAt - Date.now();
    if (left <= 0) return { tenant: row.id, ok: false, error: "deadline" };
    try {
      const tenant = await getTenant(row.id);
      if (!tenant) return { tenant: row.id, ok: false, error: "missing" };
      if (storeFileMissing(tenant.dbUrl)) return { tenant: row.id, ok: false, error: "unreachable" };
      return { tenant: row.id, ok: true, result: await withTimeout(withTenant(tenant, async () => { await probeStore(); return fn(tenant); }), Math.min(timeoutMs, left)) };
    } catch (e) {
      return { tenant: row.id, ok: false, error: e?.message === "timeout" ? "timeout" : "unreachable" };
    }
  }
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      out[i] = await one(rows[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, worker));
  return out;
}
export const probeStore = () => storesHooks.probe();

export function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]).finally(() => clearTimeout(timer));
}

// The ids a ?health= query names: known-shaped, deduplicated, at most a page.
export function healthIds(raw) {
  const ids = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s));
  return [...new Set(ids)].slice(0, HEALTH_MAX_IDS);
}

const UNREACHABLE = Object.freeze({ state: "unreachable", reasons: [], reachable: false, error: "Can't reach the store's database" });

async function oneHealth(id, head, timeoutMs) {
  let tenant;
  try {
    tenant = await getTenant(id, { fresh: true });
  } catch {
    return { ...UNREACHABLE };
  }
  if (!tenant) return { state: "missing", reasons: [], reachable: false, error: "No such store" };
  if (storeFileMissing(tenant.dbUrl)) return { ...UNREACHABLE };
  try {
    const facts = await withTimeout(
      withTenant(tenant, async () => {
        await probeStore();
        const [p, o, failedPushes, lastSync, mig] = await Promise.all([
          db.selectFrom("products").select([(eb) => eb.fn.countAll().as("n"), (eb) => eb.fn.max("synced_at").as("last")]).executeTakeFirst(),
          db.selectFrom("orders").select((eb) => eb.fn.countAll().as("n")).where("status", "in", ["paid", "syncing_shopify", "sync_failed"]).executeTakeFirst(),
          db.selectFrom("orders").select((eb) => eb.fn.countAll().as("n")).where("status", "=", "sync_failed").executeTakeFirst(),
          db.selectFrom("sync_runs").select(["status"]).orderBy("started_at", "desc").limit(1).executeTakeFirst().catch(() => null),
          db.selectFrom("schema_migrations").select(({ fn }) => fn.max("id").as("head")).executeTakeFirst().catch(() => null),
        ]);
        return { p, o, failedPushes: Number(failedPushes?.n || 0), lastSync, migrationHead: mig?.head || null };
      }),
      timeoutMs,
    );
    const uninstalledAt = tenant.config?.shopify_app_uninstalled_at || null;
    const behind = (facts.migrationHead || "") < head;
    const reasons = [];
    if (facts.lastSync?.status === "failed") reasons.push("sync_failed");
    if (uninstalledAt) reasons.push("shopify_uninstalled");
    if (facts.failedPushes > 0) reasons.push("pushes_failing");
    if (behind) reasons.push("migrations_behind");
    return {
      state: reasons.length ? "attention" : "healthy",
      reasons,
      reachable: true,
      products: Number(facts.p?.n || 0),
      lastSyncedAt: facts.p?.last || null,
      ordersInFlight: Number(facts.o?.n || 0),
      failedPushes: facts.failedPushes,
      migrationHead: facts.migrationHead,
      repoHead: head,
      behind,
      shopifyConnected: Boolean(tenant.secrets?.shopify_admin_token),
      uninstalledAt,
      shopDomain: tenant.config?.shopify_store_domain || null,
      maintenance: Boolean(tenant.config?.maintenance?.enabled),
    };
  } catch {
    // the raw error can name the database: it never leaves the server
    return { ...UNREACHABLE };
  }
}

export async function storeHealth(ids, { timeoutMs = storesHooks.timeoutMs } = {}) {
  const head = await repoHead();
  const list = (Array.isArray(ids) ? [...new Set(ids)] : healthIds(ids)).slice(0, HEALTH_MAX_IDS);
  const out = await Promise.all(list.map((id) => oneHealth(id, head, timeoutMs)));
  return Object.fromEntries(list.map((id, i) => [id, out[i]]));
}

// The live look's pin as "<kit>-<version>" (as kitAttr writes it), or null.
// themePinOf() is an object (theme_pin, or a legacy config.theme).
export const themePinLabel = (config) => {
  const pin = themePinOf(config);
  return pin ? kitAttr(pin) : null;
};

// ---- the store page ------------------------------------------------------------------

const redirectUrls = (domains) => (domains || []).map((d) => `${isLocal(d) ? "http" : "https"}://${d}/api/admin/shopify/callback`);

async function namesFor(ids) {
  const real = [...new Set(ids.filter((x) => x && !["bootstrap", "cli", "system", "operator"].includes(x)))];
  const named = real.length ? await rows(`SELECT id, name, email FROM users WHERE id IN (${real.map(() => "?").join(",")})`, real) : [];
  const map = new Map(named.map((u) => [u.id, u.name || u.email || u.id]));
  return (id) => (id === "bootstrap" ? "Setup password" : id === "cli" ? "Command line" : id === "system" ? "Storeasy" : map.get(id) || id || "Unknown");
}

async function liveState(tenant, head) {
  if (storeFileMissing(tenant.dbUrl)) return { reachable: false, repoHead: head, onboarding: null };
  try {
    return await withTimeout(
      withTenant(tenant, async () => {
        await probeStore();
        const [mig, live, onboarding] = await Promise.all([
          db.selectFrom("schema_migrations").select(({ fn }) => fn.max("id").as("head")).executeTakeFirst().catch(() => null),
          getLiveRelease(),
          import("../onboarding/service.js").then((m) => m.onboardingFor({ role: "support" })).catch(() => null),
        ]);
        return {
          reachable: true,
          migrationHead: mig?.head || null,
          repoHead: head,
          behind: (mig?.head || "") < head,
          release: live
            ? live.documents
              ? { id: live.id, documents: true, message: DOCUMENTS_MESSAGE, publishedAt: live.published_at || null }
              : { id: live.id, hash: String(live.content_hash || "").slice(0, 12), publishedAt: live.published_at || null }
            : null,
          onboarding,
        };
      }),
      storesHooks.timeoutMs,
    );
  } catch {
    return { reachable: false, repoHead: head, onboarding: null };
  }
}

export async function storeDetail(id, { now = storesClock.now() } = {}) {
  if (typeof id !== "string" || !id) return null;
  const tenant = await getTenant(id, { fresh: true }); // the operator's next view after a save shows it
  if (!tenant) return null;
  const nowIso = new Date(now).toISOString();
  const head = await repoHead();
  const subject = `tenant:${id}`;

  const [runsRaw, sub, auditRaw, incidents, grant, notesRaw, progress, owners, live] = await Promise.all([
    rows("SELECT id, status, steps, error, created_at FROM provision_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10", [id]),
    rows(
      `SELECT s.plan_id, s.plan_version, s.status, s.current_end, s.grace_until, p.name AS plan_name
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id AND p.version = s.plan_version
       WHERE s.tenant_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
      [id],
    ).then((r) => r[0] || null),
    rows("SELECT id, at, actor, actor_kind, action, resource FROM audit_log WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT 20", [id]),
    rows("SELECT id, title, public_message, created_at FROM incidents WHERE tenant_id = ? AND status = 'open' ORDER BY created_at DESC", [id]),
    rows("SELECT operator, reason, created_at, expires_at FROM support_grants WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1", [id, nowIso]).then((r) => r[0] || null),
    rows("SELECT id, body, operator_id, created_at FROM operator_notes WHERE subject = ? ORDER BY created_at DESC LIMIT 5", [subject]),
    rows("SELECT supported, open, current_step, done_count, steps, checked_at, check_error FROM onboarding_progress WHERE tenant_id = ?", [id]).then((r) => r[0] || null),
    rows("SELECT u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = 'owner' ORDER BY u.email", [id]),
    liveState(tenant, head),
  ]);
  const name = await namesFor([...auditRaw.map((a) => a.actor), ...notesRaw.map((n) => n.operator_id), grant?.operator]);

  const runs = runsRaw.map((r) => ({
    id: r.id,
    status: r.status,
    steps: parseJson(r.steps || "[]", []).map((s) => ({ name: s.name, status: s.status })),
    error: r.error ? scrubSecrets(r.error, [tenant.dbUrl, tenant.dbToken]).slice(0, 300) : null,
    created_at: r.created_at,
  }));
  const ob = live.onboarding;
  const secretNames = Object.keys(tenant.secrets || {}).sort();

  return {
    // the store record's own fields (CLIs and test-shopify-connect read them)
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      domains: tenant.domains || [],
      config: {
        shop_domain: tenant.config?.shopify_store_domain || null,
        client_id: tenant.config?.shopify_client_id || null,
        order_prefix: tenant.config?.order_prefix || null,
        site_name: tenant.config?.site?.name || null,
        support_email: tenant.config?.site?.support_email || null,
        checkout_mode: tenant.config?.checkout_mode || "direct",
        theme_pin: themePinOf(tenant.config),
        billing: tenant.config?.billing || null,
        onboarding_manual: tenant.config?.onboarding?.manual || {},
      },
      secretsPresent: Object.fromEntries(secretNames.map((k) => [k, true])),
    },
    connect: {
      appReady: Boolean(tenant.config?.shopify_client_id && tenant.secrets?.shopify_client_secret),
      redirectUrls: redirectUrls(tenant.domains),
    },
    onboarding: ob && ob.supported ? { doneCount: ob.doneCount, total: ob.total, open: ob.open, steps: ob.steps.map((s) => ({ id: s.id, label: s.label, state: s.state })) } : null,
    runs,
    // the store page (Phase 3 line 1)
    store: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status !== "active" ? tenant.status : tenant.config?.maintenance?.enabled ? "maintenance" : "active",
      domains: tenant.domains || [],
      storefrontUrl: storefrontUrl(tenant.domains),
      owners: owners.map((o) => ({ email: o.email, name: o.name || null })),
    },
    shopify: {
      shopDomain: tenant.config?.shopify_store_domain || null,
      connected: Boolean(tenant.secrets?.shopify_admin_token),
      uninstalledAt: tenant.config?.shopify_app_uninstalled_at || null,
      clientId: tenant.config?.shopify_client_id || null,
    },
    subscription: sub ? { plan: sub.plan_id, planName: sub.plan_name || sub.plan_id, version: Number(sub.plan_version), status: sub.status, currentEnd: sub.current_end || null, graceUntil: sub.grace_until || null } : null,
    live: { reachable: live.reachable, migrationHead: live.migrationHead ?? null, repoHead: head, behind: live.reachable ? live.behind : null, release: live.release ?? null, themePin: themePinLabel(tenant.config) },
    onboardingCache: progress
      ? { supported: Number(progress.supported) === 1, open: progress.open == null ? null : Number(progress.open) === 1, currentStep: progress.current_step || null, done: Number(progress.done_count || 0), steps: parseJson(progress.steps || "[]", []).map((s) => ({ id: s.id, state: s.state, problem: s.problem || null })), checkedAt: progress.checked_at, checkFailed: Boolean(progress.check_error) }
      : null,
    secretNames,
    audit: auditRaw.map((a) => ({ id: a.id, at: a.at, action: a.action, resource: a.resource || null, actorKind: a.actor_kind, actorName: name(a.actor) })),
    incidents: incidents.map((i) => ({ id: i.id, title: i.title, publicMessage: i.public_message || null, createdAt: i.created_at })),
    support: grant ? { open: true, operatorName: name(grant.operator), reason: grant.reason, since: grant.created_at, expiresAt: grant.expires_at } : { open: false },
    notes: notesRaw.map((n) => ({ id: n.id, body: n.body, operatorName: name(n.operator_id), createdAt: n.created_at })),
  };
}
