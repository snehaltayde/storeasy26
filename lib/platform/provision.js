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
// P4-PROVISION (MIG-03, owner answer OQ-4): content_mode puts a FRESH, empty
// store on the new editor (cms_state 'documents') in one guarded statement.
// A database that already holds store content (an adopted --db-url, a
// --force re-provision) keeps the old editor and the run says why in plain
// words; existing stores move only by the owner's cutover. Fix 1: the step
// runs before register_tenant, so it never moves a store already registered
// under this id (not by this run), even when the run then fails or is forced,
// and a database the run did not create that holds products, collections,
// customers or orders keeps the old editor too. The store then
// stays closed ("Opening soon", PUB-06) until its first publish. Nothing is
// seeded for it: no documents, no release, no legacy rows, no theme_pin.
// applyTenantSchema is unchanged, so the env store (_default),
// scripts/migrate.js and every suite that calls it stay legacy.
//
// Phase 1 line 1: create_db goes through lib/platform/provisioner.js. The run's
// params.dbDriver is "turso" unless a caller asks otherwise (self-serve signup
// asks for "file" until line 2); dbDriver and source ("signup") are kept in the
// run's params so a resume uses the same driver, and a signup run needs no
// shopDomain. Turso database creation prefers the operator's authenticated `turso` CLI (no
// standing platform-wide API token on disk). If TURSO_API_TOKEN + TURSO_ORG
// are set, the Platform HTTP API is used instead (CI/automation opt-in).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createClient } from "@libsql/client";
import { upsertTenant, getTenant, listTenants, platformDb } from "./control.js";
import { createStoreDatabase, STORE_DB_DRIVERS } from "./provisioner.js";
import { slog } from "../log.js";

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

async function createDbViaApi(slug) {
  const org = process.env.TURSO_ORG;
  const apiToken = process.env.TURSO_API_TOKEN;
  const name = tenantDbName(slug);
  const api = (path, init = {}) =>
    fetch(`https://api.turso.tech/v1/organizations/${org}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", ...init.headers },
    });

  let res = await api("/databases", {
    method: "POST",
    body: JSON.stringify({ name, group: process.env.TURSO_GROUP || "default" }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Turso create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const show = await api(`/databases/${name}`);
  if (!show.ok) throw new Error(`Turso show failed (${show.status})`);
  const { database } = await show.json();
  const tok = await api(`/databases/${name}/auth/tokens`, { method: "POST" });
  if (!tok.ok) throw new Error(`Turso token mint failed (${tok.status})`);
  const { jwt } = await tok.json();
  return { dbUrl: `libsql://${database.Hostname}`, dbToken: jwt, created: res.status !== 409 };
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

export const CONTENT_MODES = Object.freeze(["documents", "legacy"]);

// Every tenant table that holds store content, or the trace of content work,
// in either editor (checked against migrations/tenant up to 0025). A row in
// any of them means the database is not a fresh store. The catalog (products,
// collections), commerce settings (offers, bundles, quizzes) and orders are
// not store content: a store's first catalog sync works the same in both
// modes.
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

// ONE statement: the store moves to documents only while it is still on
// legacy, has no live release and holds no content. Anything else leaves the
// row as it is (rowsAffected 0).
export const DOCUMENTS_FOR_FRESH_STORE_SQL = `UPDATE cms_state SET mode = 'documents', updated_at = ?
  WHERE id = 1 AND mode = 'legacy'
    AND (SELECT live_release_id FROM release_state WHERE id = 1) IS NULL
    ${CONTENT_TABLES.map((t) => `AND NOT EXISTS (SELECT 1 FROM ${t})`).join("\n    ")}`;

// P4-PROVISION fix 1: the tables that show a database already runs a store
// (its catalog, its shoppers, its orders). They are not editor content, so a
// database THIS run created may gain them later in either mode; but a
// database the run did not create (an adopted --db-url, a --force
// re-provision, a Turso database that already existed) that holds any row in
// them is a live store and keeps the old editor.
export const STORE_DATA_TABLES = Object.freeze(["products", "collections", "customers", "orders"]);

// The same ONE statement, also guarded on STORE_DATA_TABLES.
export const DOCUMENTS_FOR_UNUSED_DATABASE_SQL = `${DOCUMENTS_FOR_FRESH_STORE_SQL}
    ${STORE_DATA_TABLES.map((t) => `AND NOT EXISTS (SELECT 1 FROM ${t})`).join("\n    ")}`;

export const CONTENT_MODE_REASONS = Object.freeze({
  fresh: "A new store starts on the new editor. It stays private until its first publish.",
  holdsContent: "This database already holds store content, so it keeps the old editor. Move it with the cutover.",
  operator: "The operator asked for the old editor, so this store starts on it.",
  earlierRun: "This store's setup started before new stores began on the new editor, so it keeps the old editor. Move it with the cutover.",
  already: "This store already uses the new editor.",
  migrating: "This store is moving to the new editor right now, so provisioning left it as it is.",
  noRow: "This database has no editor setting, so it keeps the old editor. Move it with the cutover.",
  registered: "A store with this id is already registered, so it keeps the old editor. Move it with the cutover.",
  holdsStoreData: "This database already holds products, collections, customers or orders, so it keeps the old editor. Move it with the cutover.",
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
  const why = refs?.contentModeReason ? ` ${refs.contentModeReason}` : "";
  return `Editor: the old editor.${why}`;
}

const holdsAnyRow = async (client, tables) => {
  for (const t of tables) if ((await client.execute(`SELECT 1 FROM ${t} LIMIT 1`)).rows.length) return true;
  return false;
};

const readContentMode = async (client) => {
  const r = await client.execute("SELECT mode FROM cms_state WHERE id = 1");
  return r.rows[0] ? String(r.rows[0].mode) : null;
};

// Sets (or keeps) the store's editor. Re-reads cms_state first, so a resume
// after the UPDATE landed records what is there, never a second change.
// `legacyReason` names why a store asked to stay on legacy does (the operator's
// choice by default). `requireNoStoreData` also keeps a database that holds
// any STORE_DATA_TABLES row on legacy (for a database the run did not create).
export async function applyContentMode(client, { contentMode = "documents", legacyReason = CONTENT_MODE_REASONS.operator, requireNoStoreData = false, now = nowIso() } = {}) {
  const before = await readContentMode(client);
  if (before === "documents") return { contentMode: "documents", contentModeReason: CONTENT_MODE_REASONS.already };
  if (before === "migrating") return { contentMode: "migrating", contentModeReason: CONTENT_MODE_REASONS.migrating };
  if (before == null) return { contentMode: "legacy", contentModeReason: CONTENT_MODE_REASONS.noRow };
  if (contentMode === "legacy") return { contentMode: "legacy", contentModeReason: legacyReason };
  const r = await client.execute({ sql: requireNoStoreData ? DOCUMENTS_FOR_UNUSED_DATABASE_SQL : DOCUMENTS_FOR_FRESH_STORE_SQL, args: [now] });
  if (Number(r.rowsAffected || 0) === 1) return { contentMode: "documents", contentModeReason: CONTENT_MODE_REASONS.fresh };
  const after = await readContentMode(client);
  if (after === "documents") return { contentMode: "documents", contentModeReason: CONTENT_MODE_REASONS.already };
  if (requireNoStoreData && !(await holdsAnyRow(client, CONTENT_TABLES)) && (await holdsAnyRow(client, STORE_DATA_TABLES))) {
    return { contentMode: "legacy", contentModeReason: CONTENT_MODE_REASONS.holdsStoreData };
  }
  return { contentMode: "legacy", contentModeReason: CONTENT_MODE_REASONS.holdsContent };
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
        if (other) throw new Error(sharedDbWords(other.id));
        return { dbUrl: params.dbUrl, dbCreated: false, adopted: true };
      }
      // P4-PROVISION: a resumed run that adopted a database keeps no address
      // (its stored settings are redacted); never create a new one in its place
      if (params.adoptedDb) throw new Error("This run uses an existing database. Resume it with that database's address.");
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
      const driver = params.dbDriver || "turso";
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
      const client = createClient({ url: ctx.refs.dbUrl, authToken: ctx.secrets.dbToken || ctx.params.dbToken || undefined });
      await applyTenantSchema(client); // ledger is idempotent
      client.close?.();
      return { schemaApplied: true };
    },
  },
  {
    // P4-PROVISION: no compensation; the database is left in place, as today.
    name: "content_mode",
    async run(ctx) {
      const client = createClient({ url: ctx.refs.dbUrl, authToken: ctx.secrets.dbToken || ctx.params.dbToken || undefined });
      try {
        // a run started before this step existed has no contentMode: legacy
        const earlier = ctx.params.contentMode == null && ctx.resumed;
        // fix 1: this step runs before register_tenant (where an existing
        // tenant is refused), so it checks first: a store already registered
        // under this id, and not by this run, is never moved here; a failed
        // or forced re-provision leaves its editor as it is.
        const existing = await getTenant(ctx.params.id);
        const registered = Boolean(existing) && !ctx.refs.tenantCreated;
        // P4-FIX5 / P4-FIX6: a database another registered store already uses
        // is never moved here (moving it would close that store to its
        // shoppers), and the run stops instead of registering a second store
        // on it. create_db already stops an adopted address; this is the belt
        // for a resumed run or a store registered on it since.
        const shared = earlier || registered ? null : await otherTenantOnDb(ctx.params.id, ctx.refs.dbUrl);
        if (shared) throw new Error(sharedDbWords(shared.id));
        const opts = earlier
          ? { contentMode: "legacy", legacyReason: CONTENT_MODE_REASONS.earlierRun }
          : registered
            ? { contentMode: "legacy", legacyReason: CONTENT_MODE_REASONS.registered }
            : // a database this run did not create must also hold no store data
              { contentMode: ctx.params.contentMode || "documents", requireNoStoreData: !ctx.refs.dbCreated };
        const r = await applyContentMode(client, opts);
        ctx.log(r.contentMode === "documents" ? "→ the store starts on the new editor (private until its first publish)" : `→ the store keeps the old editor: ${r.contentModeReason}`);
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
        if (!params.force) throw new Error(`tenant "${params.id}" already exists (use force to re-provision)`);
      }
      if (existing && refs.tenantCreated) {
        ctx.log("→ tenant already registered by this run — keeping it (no secret rotation)");
        return {};
      }
      ctx.log("→ registering tenant…");
      // resume path: the db token lives only in step memory (never persisted) —
      // re-mint one for our own created database when it's gone
      if (!ctx.secrets.dbToken && !params.dbToken && !refs.adopted && String(refs.dbUrl || "").startsWith("libsql://")) {
        ctx.log("→ re-minting db token (resume)…");
        ctx.secrets.dbToken = (await createTenantDatabase(params.id)).dbToken;
      }
      const adminPassword = randomBytes(9).toString("base64url");
      const orderLinkSecret = randomBytes(32).toString("hex");
      await upsertTenant({
        id: params.id,
        name: params.name || params.id,
        domains: params.domains || [],
        dbUrl: refs.dbUrl,
        dbToken: ctx.secrets.dbToken || params.dbToken || null,
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
export async function runProvision(params, { resumeRunId = null, failAt = null, log = () => {} } = {}) {
  if (params.contentMode != null && !CONTENT_MODES.includes(params.contentMode)) throw new Error(`contentMode must be one of ${CONTENT_MODES.join(", ")}`);
  if (!resumeRunId) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(params.id || "")) throw new Error("tenant id must be a slug");
    // Phase 1 line 1: a self-serve signup has no Shopify store yet
    if (!params.shopDomain && params.source !== "signup") throw new Error("shopDomain required (x.myshopify.com)");
    if (params.dbDriver != null && !STORE_DB_DRIVERS.includes(params.dbDriver)) throw new Error(`dbDriver must be one of ${STORE_DB_DRIVERS.join(", ")}`);
  }

  let runRow;
  if (resumeRunId) {
    runRow = await getProvisionRun(resumeRunId);
    if (!runRow) throw new Error(`provision run ${resumeRunId} not found`);
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
  for (const step of STEPS) {
    const rec = runRow.steps.find((s) => s.name === step.name);
    if (rec.status === "done") continue; // resume: completed work stays done
    rec.status = "running";
    rec.startedAt = nowIso();
    await saveRun(runRow);
    try {
      if (failAt === step.name) throw new Error(`injected failure at ${step.name} (test hook)`);
      const patch = (await step.run(ctx)) || {};
      Object.assign(runRow.refs, patch);
      rec.status = "done";
      rec.finishedAt = nowIso();
      rec.detail = Object.keys(patch).join(",") || "ok";
      await saveRun(runRow);
    } catch (e) {
      rec.status = "failed";
      rec.finishedAt = nowIso();
      rec.detail = String(e?.message || e).slice(0, 300);
      runRow.status = "failed";
      runRow.error = `${step.name}: ${rec.detail}`;
      await saveRun(runRow);
      slog("provision_failed", { run: runRow.id, tenant: params.id, step: step.name });
      return { run: runRow, failedStep: step.name, error: rec.detail };
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
  if (!runRow) throw new Error(`provision run ${runId} not found`);
  if (runRow.status === "done") throw new Error("run completed — compensation is for failed runs (suspend/offboard a live tenant instead)");
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
