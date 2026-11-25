// Tenant provisioning (Session 21; reworked S41 / BE26): create a tenant's
// Turso database, apply the schema, register the tenant — as RECORDED,
// RESUMABLE, IDEMPOTENT steps with conservative compensation.
//
//   create_db → apply_schema → content_mode → seed_defaults →
//   register_tenant → init_billing → record_onboarding
//
// Every attempt is a provision_runs row (step states + NON-SECRET resource
// refs). A resume re-executes from the first unfinished step; each step
// checks REAL state first (db exists? tenant registered? subscription
// present?) so retries never duplicate a resource. Compensation walks done
// steps in reverse and is deliberately conservative: it deregisters a tenant
// THIS run created and removes the free subscription it started, but NEVER
// deletes a Turso database automatically — that stays a manual, operator-
// authorized action (recorded in the run as left-in-place).
//
// S41 neutral seeds (quirk #14 closed): provisioning seeds NOTHING
// brand-flavored. The six BeastLife offers used to be inserted into every
// fresh tenant — now `applyTenantSchema` seeds offers only when explicitly
// asked (the BeastLife/env store's own scripts/migrate.js path). CMS/page/
// brand defaults already derive neutrally at render (S23/S35/S38).
//
// P4-PROVISION (MIG-03): every store is on the new editor (tenant migration
// 0026 sets cms_state 'documents'; Phase 1 removed the old editor), and
// content_mode only reads it and records whether the database was fresh. A
// database whose stored mode is anything else stops the run. The store then
// stays closed ("Opening soon", PUB-06) until its first publish. Nothing is
// seeded for it: no documents, no release, no theme_pin.

// Phase 1 line 1: create_db goes through lib/platform/provisioner.js. The run's
// params.dbDriver is "turso" unless a caller asks otherwise (self-serve signup
// asks for "file" until line 2); dbDriver and source ("signup") are kept in the
// run's params so a resume uses the same driver, and a signup run needs no
// shopDomain. Turso database creation prefers the operator's authenticated `turso` CLI (no
// standing platform-wide API token on disk). If TURSO_API_TOKEN + TURSO_ORG
// are set, the Platform HTTP API is used instead (CI/automation opt-in).
//
// Phase 1 line 2: self-serve signup uses the "turso-api" driver (the Platform
// API through lib/platform/turso-api.js, never the CLI). create_db keeps
// refs.dbCreateRequestedAt only while an ask's outcome is unknown (timeout,
// network error, 5xx), so a later 409 is this run's own database (adopted);
// any other 409 needs an operator, on every Try again. Tokens are never stored in the run: ensureDbToken() mints a 1-hour
// token for apply_schema and content_mode when the run has none (fixes a resume
// at those steps having no token), and register_tenant mints the store's
// never-expiring token (the 'turso' driver re-mints for any remote address, not
// only libsql://). A failed run reports failedKind: "retry" or "needs_operator"
// (from TursoApiError), or null for anything else; step errors are scrubbed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createClient } from "@libsql/client";
import { upsertTenant, getTenant, listTenants, platformDb } from "./control.js";
import { createStoreDatabase, STORE_DB_DRIVERS } from "./provisioner.js";
import { slog } from "../log.js";
import { tursoApi, TursoApiError, scrubSecrets } from "./turso-api.js";
import { refuse } from "./refuse.js";

const run = promisify(execFile);
const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export const tenantDbName = (slug) => `storeasy-t-${slug}`;

// P4-FIX5 / P4-FIX6: tests replace the `turso` CLI with a stub (never the real
// one) through a test-only seam: a function a test puts on globalThis under
// this registered symbol. Nothing in the shipped code sets it, and this module
// exports no setter.
export const TURSO_TEST_RUNNER = Symbol.for("storeasy.provision.tursoRunnerForTest");

async function turso(args) {
  const tursoRunner = typeof globalThis[TURSO_TEST_RUNNER] === "function" ? globalThis[TURSO_TEST_RUNNER] : null;
  if (tursoRunner) return String((await tursoRunner(args)) ?? "").trim();
  const { stdout } = await run("turso", args, { timeout: 120_000 });
  return stdout.trim();
}

// ---- database creation -------------------------------------------------------

// The database names in `turso db list` output: the first column of each row,
// header and blank lines skipped. P4-FIX5: a name is matched exactly, never
// as a substring ("storeasy-t-shop" is not "storeasy-t-shop2").
export function listedDbNames(output) {
  const names = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0];
    if (first && first !== "NAME") names.add(first);
  }
  return names;
}

async function createDbViaCli(slug) {
  const name = tenantDbName(slug);
  const existing = listedDbNames(await turso(["db", "list"]).catch(() => ""));
  const created = !existing.has(name);
  if (created) {
    await turso(["db", "create", name]);
  }
  const dbUrl = await turso(["db", "show", name, "--url"]);
  const dbToken = await turso(["db", "tokens", "create", name]);
  return { dbUrl, dbToken, created };
}

// The operator path ('turso' driver with the API configured): adopt-if-exists.
async function createDbViaApi(slug) {
  const api = tursoApi();
  const name = tenantDbName(slug);
  let created = true;
  try {
    await api.createDatabase(name);
  } catch (e) {
    if (e?.kind !== "conflict") throw e;
    created = false;
  }
  const database = await api.getDatabase(name);
  return { dbUrl: api.dbUrlFor(database), dbToken: await api.mintToken(name, { expiration: "never" }), created };
}

// The signup path ('turso-api' driver). refs.dbCreateRequestedAt marks an ask
// whose outcome is unknown: it is saved before each ask and stays only when no
// clear answer came back (a timeout, a network error, a 5xx), since Turso may
// have made the database. A clear 4xx (a 409 included) restores the earlier
// value, so a 409 is this run's database only when an earlier ask's outcome
// was unknown.
const outcomeUnknown = (e) => !(e instanceof TursoApiError) || (e.kind === "retry" && (e.status == null || e.status >= 500));
async function createDbForRun(ctx) {
  const { params, refs } = ctx;
  const api = tursoApi();
  const name = tenantDbName(params.id);
  const unknownBefore = refs.dbCreateRequestedAt || null;
  await ctx.saveRefs({ dbCreateRequestedAt: unknownBefore || nowIso() });
  let database;
  let conflict = false;
  try {
    database = await api.createDatabase(name);
  } catch (e) {
    if (!outcomeUnknown(e) && !(e?.kind === "conflict" && unknownBefore)) await ctx.saveRefs({ dbCreateRequestedAt: unknownBefore });
    if (e?.kind !== "conflict") throw e;
    conflict = true;
    // line 9: an operator-made store's run (source "operator") holds the same rule
    if (!unknownBefore && (params.source === "signup" || params.source === "operator")) {
      throw new TursoApiError(`a database named ${name} already exists and this run did not ask for it (409)`, { kind: "needs_operator", status: 409 });
    }
    ctx.log(`→ ${name} already exists; ${unknownBefore ? "an earlier ask of this run may have made it, so it is adopted" : "adopted"}`);
  }
  if (!database?.localUrl) database = await api.getDatabase(name);
  // a 409 is this run's database only when an earlier ask's outcome was unknown
  return { dbUrl: api.dbUrlFor(database), dbCreated: !conflict || Boolean(unknownBefore) };
}

const isFileUrl = (u) => /^file:/i.test(String(u || ""));

// A token for this run's database, minted when the run holds none (tokens live
// only in step memory). The 'turso' driver re-mints through createTenantDatabase
// (adopt-if-exists) for any remote address; the 'turso-api' driver mints a
// 1-hour token. Adopted databases use the operator's token; file databases none.
async function ensureDbToken(ctx) {
  if (ctx.secrets.dbToken) return ctx.secrets.dbToken;
  if (ctx.params.dbToken) return ctx.params.dbToken;
  const { params, refs } = ctx;
  if (refs.adopted || params.adoptedDb || !refs.dbUrl || isFileUrl(refs.dbUrl)) return null;
  const driver = params.dbDriver || "turso";
  if (driver === "turso-api") ctx.secrets.dbToken = await tursoApi().mintToken(tenantDbName(params.id), { expiration: "1h" });
  else if (driver === "turso") {
    ctx.log("→ minting a database token (resume)…");
    ctx.secrets.dbToken = (await createTenantDatabase(params.id)).dbToken;
  }
  return ctx.secrets.dbToken || null;
}

export async function createTenantDatabase(slug) {
  if (process.env.TURSO_API_TOKEN && process.env.TURSO_ORG) return createDbViaApi(slug);
  return createDbViaCli(slug);
}

// ---- schema + seed -----------------------------------------------------------

// Apply the commerce schema (versioned migration ledger) to ANY libsql
// client. S41: NEUTRAL by default — the brand-offer seed runs only when
// explicitly requested (the BeastLife/env store's own bootstrap).
export async function applyTenantSchema(client, { seedBrandOffers = false } = {}) {
  const { loadMigrations, runMigrations } = await import("./migrate.js");
  await runMigrations(client, await loadMigrations("tenant"));

  let seeded = 0;
  if (seedBrandOffers) {
    const { OFFERS } = await import("../offers/config.js");
    const now = nowIso();
    for (const offer of OFFERS) {
      const res = await client.execute({
        sql: "INSERT OR IGNORE INTO offers (id, type, label, enabled, config, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
        args: [offer.id, offer.type, offer.title || offer.id, JSON.stringify(offer), now, now],
      });
      seeded += Number(res.rowsAffected || 0);
    }
  }
  return { seededOffers: seeded };
}

// ---- content mode (P4-PROVISION) ---------------------------------------------

export const CONTENT_MODES = Object.freeze(["documents"]);

// Every tenant table that holds store content, or the trace of content work,
// old tables included (checked against migrations/tenant up to 0025). A row
// in any of them means the database is not a fresh store. The catalog
// (products, collections), commerce settings (offers, bundles, quizzes) and
// orders are not store content.
export const CONTENT_TABLES = Object.freeze([
  "releases",
  "publish_log",
  "documents",
  "document_versions",
  "document_refs",
  "product_content_live",
  "collection_content_live",
  "cms_blocks",
  "cms_pages",
  "cms_templates",
  "cms_history",
  "cms_approvals",
  "cms_preview_candidates",
  "placements",
  "product_overrides",
  "collection_overrides",
  "page_redirects",
  "cms_migration_runs",
  "content_live_reversed",
]);

export const CONTENT_MODE_REASONS = Object.freeze({
  fresh: "A new store starts on the new editor. It stays private until its first publish.",
  already: "This store already uses the new editor.",
});

// P4-FIX6: provisioning stops (the run fails at that step, nothing is
// registered) when another registered store already uses the database.
export const sharedDbWords = (otherId) =>
  `Another registered store ("${otherId}") already uses this database, so this store was not set up on it and the other store was left as it is. Give this store a database of its own.`;

// P4-FIX5 / P4-FIX6: two addresses of one database compare equal:
//   · spaces, trailing slashes, the query (?authToken=…, ?tls=…) and the
//     fragment are dropped;
//   · a remote database is its host (lower case, no user part, no default
//     port) and path, whatever the scheme: libsql://, https://, http://,
//     wss:// and ws:// name the same server (Turso serves libsql:// and
//     https:// on one host);
//   · a file database is its absolute path: relative paths resolve against
//     the working directory, as the libsql client opens them ("file:a.db",
//     "file:./a.db", "file:/abs/a.db" and "file:///abs/a.db" can all be one).
// Empty addresses never match.
const REMOTE_SCHEMES = new Set(["libsql", "https", "http", "wss", "ws"]);
const DEFAULT_PORT = { libsql: "443", https: "443", wss: "443", http: "80", ws: "80" };
export function dbAddressKey(u) {
  const s = String(u ?? "").trim();
  if (!s) return "";
  const m = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(s);
  if (!m) return s;
  const scheme = m[1].toLowerCase();
  const rest = m[2].replace(/[?#].*$/, "");
  if (scheme === "file") {
    let p = rest;
    if (p.startsWith("//")) {
      p = p.slice(2);
      // file://host/path: the path; file:///path: already the path
      if (!p.startsWith("/")) p = p.includes("/") ? p.slice(p.indexOf("/")) : `/${p}`;
    }
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep it as written */
    }
    if (!p) return "";
    return `file:${resolvePath(process.cwd(), p)}`;
  }
  if (REMOTE_SCHEMES.has(scheme)) {
    const r = rest.replace(/^\/\//, "");
    const at = r.indexOf("/");
    let host = (at >= 0 ? r.slice(0, at) : r).replace(/^[^@]*@/, "").toLowerCase();
    const path = (at >= 0 ? r.slice(at) : "").replace(/\/+$/, "");
    const port = /:(\d+)$/.exec(host)?.[1];
    if (port && port === DEFAULT_PORT[scheme]) host = host.slice(0, -(port.length + 1));
    if (!host) return "";
    return `remote://${host}${path}`;
  }
  return `${scheme}:${rest.replace(/\/+$/, "")}`;
}
export function sameDbAddress(a, b) {
  const x = dbAddressKey(a);
  return Boolean(x) && x === dbAddressKey(b);
}

// Another registered tenant (any status) whose database is this one, or null.
async function otherTenantOnDb(id, dbUrl) {
  if (!dbUrl) return null;
  const all = await listTenants();
  return all.find((t) => t.id !== id && sameDbAddress(t.db_url, dbUrl)) || null;
}

// The provisioning summary's line on which editor the store starts on, in
// plain words (scripts/provision-tenant.js prints it).
export function editorSummary(refs = {}) {
  if (refs?.contentMode === "documents") {
    return 'Editor: the new editor. The store stays private (shoppers see "Opening soon") until its first publish from the editor. Publishing opens it.';
  }
  return `Editor: not set up.${refs?.contentModeReason ? ` ${refs.contentModeReason}` : ""}`;
}

const holdsAnyRow = async (client, tables) => {
  for (const t of tables) if ((await client.execute(`SELECT 1 FROM ${t} LIMIT 1`)).rows.length) return true;
  return false;
};

const readContentMode = async (client) => {
  const r = await client.execute("SELECT mode FROM cms_state WHERE id = 1");
  return r.rows[0] ? String(r.rows[0].mode) : null;
};

// The store's editor, read (tenant migration 0026 sets every store to
// documents; nothing here writes cms_state). "fresh" when the database holds
// no store content yet (every CONTENT_TABLES table empty), else "already". A
// database whose stored mode is anything else stops the run (STORE_MODE_INVALID).
export async function applyContentMode(client) {
  const mode = await readContentMode(client);
  if (mode != null && mode !== "documents") {
    const e = new Error(`This database's editor setting is "${mode}", which Storeasy no longer runs, so setup stopped. Contact support.`);
    e.code = "STORE_MODE_INVALID";
    throw e;
  }
  const fresh = !(await holdsAnyRow(client, CONTENT_TABLES));
  return { contentMode: "documents", contentModeReason: fresh ? CONTENT_MODE_REASONS.fresh : CONTENT_MODE_REASONS.already };
}

// ---- provision runs (BE26) ---------------------------------------------------

const provId = () => `prov_${randomBytes(9).toString("hex")}`;

async function saveRun(runRow) {
  await platformDb().execute({
    sql: `INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, error, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, steps = excluded.steps, refs = excluded.refs,
            error = excluded.error, updated_at = excluded.updated_at`,
    args: [runRow.id, runRow.tenant_id, runRow.status, JSON.stringify(runRow.steps), JSON.stringify(runRow.refs), JSON.stringify(runRow.params), runRow.error, runRow.created_at, nowIso()],
  });
}

export async function getProvisionRun(id) {
  const r = await platformDb().execute({ sql: "SELECT * FROM provision_runs WHERE id = ?", args: [id] });
  const row = r.rows[0];
  return row ? { ...row, steps: parse(row.steps, []), refs: parse(row.refs, {}), params: parse(row.params, {}) } : null;
}

export async function listProvisionRuns({ limit = 20 } = {}) {
  const r = await platformDb().execute(`SELECT * FROM provision_runs ORDER BY created_at DESC LIMIT ${Math.min(limit, 100)}`);
  return r.rows.map((row) => ({ ...row, steps: parse(row.steps, []), refs: parse(row.refs, {}), params: parse(row.params, {}) }));
}

// Phase 3 line 6: what a provisioning run shows an operator. An allowlist:
// never params (the founder's support email, store settings) or refs (the
// database address); steps carry their name, state and scrubbed detail only.
export function provisionRunView(run) {
  if (!run) return null;
  // a step's detail and the run's error can quote the database address
  // (a driver error naming the URL): scrubbed by value, not by pattern
  const known = [run.refs?.dbUrl, run.params?.dbUrl];
  const scrub = (text) => (text ? scrubSecrets(text, known) : null);
  return {
    id: run.id,
    tenant_id: run.tenant_id,
    status: run.status,
    source: run.params?.source || null,
    steps: (Array.isArray(run.steps) ? run.steps : []).map((s) => ({ name: s.name, status: s.status, detail: scrub(s.detail) })),
    error: scrub(run.error),
    created_at: run.created_at,
    updated_at: run.updated_at || null,
  };
}

// The step set. Each step: run(ctx) → ref-patch; compensate(ctx) best-effort.
// ctx = { params, refs, secrets (NEVER persisted), log }.
const STEPS = [
  {
    name: "create_db",
    async run(ctx) {
      const { params, refs } = ctx;
      if (params.dbUrl) {
        // P4-FIX6: a database another registered store uses stops the run
        // here, before the schema touches it and before anything is registered
        const other = await otherTenantOnDb(params.id, params.dbUrl);
        if (other) throw refuse(422, sharedDbWords(other.id));
        return { dbUrl: params.dbUrl, dbCreated: false, adopted: true };
      }
      // P4-PROVISION: a resumed run that adopted a database keeps no address
      // (its stored settings are redacted); never create a new one in its place
      if (params.adoptedDb) throw refuse(422, "This run uses an existing database. Resume it with that database's address.");
      const driver = params.dbDriver || "turso";
      if (driver === "turso-api") {
        if (refs.dbUrl) return {};
        ctx.log(`→ creating Turso database ${tenantDbName(params.id)} (Platform API)…`);
        return createDbForRun(ctx);
      }
      if (refs.dbUrl) {
        // resume: db already resolved — re-mint a token only if we never got one
        if (!ctx.secrets.dbToken) {
          // create is adopt-if-exists; a file database only adopts the one this run recorded
          const r = await createStoreDatabase(params.id, params.dbDriver || "turso", { resumeUrl: refs.dbUrl });
          ctx.secrets.dbToken = r.dbToken;
          return { dbUrl: r.dbUrl, dbCreated: refs.dbCreated || r.created };
        }
        return {};
      }
      ctx.log(`→ creating ${driver === "file" ? "local file" : "Turso"} database ${tenantDbName(params.id)}…`);
      const r = await createStoreDatabase(params.id, driver);
      ctx.secrets.dbToken = r.dbToken;
      return { dbUrl: r.dbUrl, dbCreated: r.created };
    },
    async compensate(ctx) {
      // NEVER auto-delete a database — even one this run created. Deleting
      // storage is a manual, operator-authorized action.
      return ctx.refs.dbCreated ? `database ${tenantDbName(ctx.params.id)} left in place — delete manually if unwanted` : null;
    },
  },
  {
    name: "apply_schema",
    async run(ctx) {
      ctx.log("→ applying schema (migration ledger)…");
      const client = createClient({ url: ctx.refs.dbUrl, authToken: (await ensureDbToken(ctx)) || undefined });
      await applyTenantSchema(client); // ledger is idempotent
      client.close?.();
      return { schemaApplied: true };
    },
  },
  {
    // P4-PROVISION: no compensation; the database is left in place, as today.
    name: "content_mode",
    async run(ctx) {
      const client = createClient({ url: ctx.refs.dbUrl, authToken: (await ensureDbToken(ctx)) || undefined });
      try {
        // fix 1: this step runs before register_tenant (where an existing
        // tenant is refused): a store already registered under this id, and
        // not by this run, is left as it is.
        const existing = await getTenant(ctx.params.id);
        const registered = Boolean(existing) && !ctx.refs.tenantCreated;
        // P4-FIX5 / P4-FIX6: the run stops instead of registering a second
        // store on a database another registered store already uses.
        // create_db already stops an adopted address; this is the belt for a
        // resumed run or a store registered on it since.
        const shared = registered ? null : await otherTenantOnDb(ctx.params.id, ctx.refs.dbUrl);
        if (shared) throw refuse(422, sharedDbWords(shared.id));
        const r = await applyContentMode(client);
        ctx.log("→ the store starts on the new editor (private until its first publish)");
        return r;
      } finally {
        client.close?.();
      }
    },
  },
  {
    name: "seed_defaults",
    async run(ctx) {
      // S41: NOTHING brand-flavored is seeded. CMS blocks, pages, brand and
      // theme all derive neutral defaults at render; offers start EMPTY.
      ctx.log("→ neutral defaults (no brand content seeded; offers start empty)");
      return { neutralSeeds: true };
    },
  },
  {
    name: "register_tenant",
    async run(ctx) {
      const { params, refs } = ctx;
      const existing = await getTenant(params.id);
      if (existing && !refs.tenantCreated) {
        if (!params.force) throw refuse(422, `tenant "${params.id}" already exists (use force to re-provision)`);
      }
      if (existing && refs.tenantCreated) {
        ctx.log("→ tenant already registered by this run — keeping it (no secret rotation)");
        return {};
      }
      ctx.log("→ registering tenant…");
      // the store's own token: never-expiring for the Platform API path (the
      // 1-hour step token is not kept); otherwise the run's token, re-minted
      // for any remote address when a resume has none
      const dbToken =
        (params.dbDriver || "turso") === "turso-api" && !refs.adopted
          ? await tursoApi().mintToken(tenantDbName(params.id), { expiration: "never" })
          : await ensureDbToken(ctx);
      const adminPassword = randomBytes(9).toString("base64url");
      const orderLinkSecret = randomBytes(32).toString("hex");
      await upsertTenant({
        id: params.id,
        name: params.name || params.id,
        domains: params.domains || [],
        dbUrl: refs.dbUrl,
        dbToken: dbToken || null,
        config: {
          ...(params.shopDomain ? { shopify_store_domain: params.shopDomain } : {}),
          shopify_api_version: process.env.SHOPIFY_API_VERSION || "2025-10",
          ...(params.clientId ? { shopify_client_id: params.clientId } : {}),
          typesense_collection: `products_${params.id}`,
          site_url: params.siteUrl || (params.domains?.[0] ? `https://${params.domains[0]}` : null),
          site: { name: params.siteName || params.name || params.id, ...(params.supportEmail ? { support_email: params.supportEmail } : {}) },
        },
        secrets: {
          ...(params.clientSecret ? { shopify_client_secret: params.clientSecret } : {}),
          admin_password: adminPassword,
          order_link_secret: orderLinkSecret,
        },
      });
      ctx.secrets.adminPassword = adminPassword; // returned once, never persisted
      return { tenantCreated: !existing };
    },
    async compensate(ctx) {
      if (!ctx.refs.tenantCreated) return null;
      const { deleteTenant } = await import("./control.js");
      await deleteTenant(ctx.params.id);
      return `tenant row "${ctx.params.id}" deregistered`;
    },
  },
  {
    name: "init_billing",
    async run(ctx) {
      const { subscriptionFor, startSubscription, ensureDefaultPlans } = await import("./billing.js");
      await ensureDefaultPlans();
      const existing = await subscriptionFor(ctx.params.id);
      if (existing) return { subscriptionId: existing.id, billingExisted: true };
      ctx.log("→ starting on the Free plan…");
      const r = await startSubscription(ctx.params.id, "free");
      return { subscriptionId: r.id };
    },
    async compensate(ctx) {
      if (!ctx.refs.subscriptionId || ctx.refs.billingExisted) return null;
      await platformDb().execute({ sql: "DELETE FROM subscriptions WHERE id = ?", args: [ctx.refs.subscriptionId] });
      return "free subscription removed";
    },
  },
  {
    name: "record_onboarding",
    async run(ctx) {
      const { patchTenant } = await import("./control.js");
      const tenant = await getTenant(ctx.params.id);
      if (!tenant.config?.onboarding) {
        await patchTenant(ctx.params.id, { config: { onboarding: { provisioned_at: nowIso(), run_id: ctx.runId, manual: {}, ...(ctx.params.source ? { source: ctx.params.source } : {}) } } });
      }
      return { onboardingRecorded: true };
    },
  },
];

// Execute (or RESUME) a provisioning run. `resumeRunId` re-enters that run:
// done steps are skipped, the failed/pending tail re-executes with the
// stored refs. `failAt` is a TEST hook (injects a failure before that step).
// holdLease() is asked before each step and before a step's outcome is saved;
// false stops the run where it is, writing nothing more (the signup job's
// lease was lost: another runner owns the run now).
export async function runProvision(params, { resumeRunId = null, failAt = null, log = () => {}, holdLease = null } = {}) {
  if (params.contentMode != null && !CONTENT_MODES.includes(params.contentMode)) throw refuse(422, `contentMode must be one of ${CONTENT_MODES.join(", ")}`);
  if (!resumeRunId) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(params.id || "")) throw refuse(422, "tenant id must be a slug");
    // Phase 1 line 1: a self-serve signup has no Shopify store yet
    if (!params.shopDomain && params.source !== "signup") throw refuse(422, "shopDomain required (x.myshopify.com)");
    if (params.dbDriver != null && !STORE_DB_DRIVERS.includes(params.dbDriver)) throw refuse(422, `dbDriver must be one of ${STORE_DB_DRIVERS.join(", ")}`);
  }

  let runRow;
  if (resumeRunId) {
    runRow = await getProvisionRun(resumeRunId);
    if (!runRow) throw refuse(422, `provision run ${resumeRunId} not found`);
    if (runRow.status === "done") return { run: runRow, resumedNoop: true };
    params = { ...runRow.params, ...params, id: runRow.tenant_id }; // stored redacted params win the identity
    // a run from before content_mode existed gets the step appended in order
    for (const [i, s] of STEPS.entries()) if (!runRow.steps.some((x) => x.name === s.name)) runRow.steps.splice(i, 0, { name: s.name, status: "pending" });
    runRow.status = "running";
    runRow.error = null;
  } else {
    runRow = {
      id: provId(),
      tenant_id: params.id,
      status: "running",
      steps: STEPS.map((s) => ({ name: s.name, status: "pending" })),
      refs: {},
      // redacted params only — never tokens/secrets
      params: { id: params.id, name: params.name || null, shopDomain: params.shopDomain || null, domains: params.domains || [], siteName: params.siteName || null, supportEmail: params.supportEmail || null, adoptedDb: Boolean(params.dbUrl), force: Boolean(params.force), contentMode: params.contentMode || "documents", dbDriver: params.dbDriver || "turso", source: params.source || null, siteUrl: params.siteUrl || null },
      error: null,
      created_at: nowIso(),
    };
  }
  await saveRun(runRow);

  const ctx = { params, refs: runRow.refs, secrets: {}, runId: runRow.id, log, resumed: Boolean(resumeRunId) };
  // a step records non-secret refs before a call whose outcome may be unknown
  const lost = async () => Boolean(holdLease) && (await holdLease()) === false;
  ctx.saveRefs = async (patch) => {
    Object.assign(runRow.refs, patch);
    if (!(await lost())) await saveRun(runRow);
  };
  for (const step of STEPS) {
    const rec = runRow.steps.find((s) => s.name === step.name);
    if (rec.status === "done") continue; // resume: completed work stays done
    if (await lost()) return { run: runRow, lostLease: true };
    rec.status = "running";
    rec.startedAt = nowIso();
    await saveRun(runRow);
    try {
      if (failAt === step.name) throw new Error(`injected failure at ${step.name} (test hook)`);
      const patch = (await step.run(ctx)) || {};
      if (await lost()) return { run: runRow, lostLease: true };
      Object.assign(runRow.refs, patch);
      rec.status = "done";
      rec.finishedAt = nowIso();
      rec.detail = Object.keys(patch).join(",") || "ok";
      await saveRun(runRow);
    } catch (e) {
      // a runner that lost its lease leaves the run to the one that took it
      if (await lost()) return { run: runRow, lostLease: true };
      const failedKind = e instanceof TursoApiError ? (e.kind === "retry" ? "retry" : "needs_operator") : null;
      rec.status = "failed";
      rec.finishedAt = nowIso();
      rec.detail = scrubSecrets(e?.message || e, [ctx.secrets.dbToken, params.dbToken, params.clientSecret]).slice(0, 300);
      if (failedKind === "retry") runRow.refs.transientStatus = e.status ?? "network";
      runRow.status = "failed";
      runRow.error = `${step.name}: ${rec.detail}`;
      await saveRun(runRow);
      slog("provision_failed", { run: runRow.id, tenant: params.id, step: step.name, ...(failedKind ? { kind: failedKind, status: e.status ?? null } : {}) });
      return { run: runRow, failedStep: step.name, error: rec.detail, failedKind, failedStatus: e?.status ?? null, retryAfterMs: e?.retryAfterMs ?? null };
    }
  }
  runRow.status = "done";
  await saveRun(runRow);
  slog("provision_done", { run: runRow.id, tenant: params.id });
  return {
    run: runRow,
    tenant: await getTenant(params.id),
    generated: ctx.secrets.adminPassword ? { admin_password: ctx.secrets.adminPassword } : null,
  };
}

// Conservative rollback of a FAILED run: compensate done steps in reverse.
export async function compensateProvision(runId) {
  const runRow = await getProvisionRun(runId);
  if (!runRow) throw refuse(422, `provision run ${runId} not found`);
  if (runRow.status === "done") throw refuse(422, "run completed — compensation is for failed runs (suspend/offboard a live tenant instead)");
  const ctx = { params: runRow.params, refs: runRow.refs, secrets: {}, runId, log: () => {} };
  const notes = [];
  for (const step of [...STEPS].reverse()) {
    const rec = runRow.steps.find((s) => s.name === step.name);
    if (rec?.status !== "done" || !step.compensate) continue;
    const note = await step.compensate(ctx).catch((e) => `compensation failed: ${String(e?.message || e).slice(0, 150)}`);
    if (note) notes.push(`${step.name}: ${note}`);
    rec.status = "compensated";
  }
  runRow.status = "compensated";
  runRow.error = (runRow.error ? runRow.error + " · " : "") + (notes.join(" · ") || "nothing to compensate");
  await saveRun(runRow);
  slog("provision_compensated", { run: runId, notes: notes.length });
  return { run: runRow, notes };
}

// ---- compatibility wrapper (CLI + wizard) ------------------------------------

export async function provisionTenant({ id, name, domains = [], shopDomain, clientId = null, clientSecret = null, siteName = null, supportEmail = null, dbUrl = null, dbToken = null, force = false, contentMode = "documents", log = () => {} }) {
  const r = await runProvision({ id, name, domains, shopDomain, clientId, clientSecret, siteName, supportEmail, dbUrl, dbToken, force, contentMode }, { log });
  if (r.failedStep) {
    const err = new Error(`${r.error} (run ${r.run.id} — resume from the platform console)`);
    err.runId = r.run.id;
    throw err;
  }
  return { tenant: r.tenant, generated: r.generated || { admin_password: "(unchanged — tenant already existed)" }, run: r.run };
}
