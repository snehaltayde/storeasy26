// Tenant provisioning (Session 21; reworked S41 / BE26): create a tenant's
// Turso database, apply the schema, register the tenant — as RECORDED,
// RESUMABLE, IDEMPOTENT steps with conservative compensation.
//
//   create_db → apply_schema → seed_defaults → register_tenant →
//   init_billing → record_onboarding
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
// Database creation prefers the operator's authenticated `turso` CLI (no
// standing platform-wide API token on disk). If TURSO_API_TOKEN + TURSO_ORG
// are set, the Platform HTTP API is used instead (CI/automation opt-in).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { upsertTenant, getTenant, platformDb } from "./control.js";
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

async function turso(args) {
  const { stdout } = await run("turso", args, { timeout: 120_000 });
  return stdout.trim();
}

// ---- database creation -------------------------------------------------------

async function createDbViaCli(slug) {
  const name = tenantDbName(slug);
  const existing = await turso(["db", "list"]).catch(() => "");
  if (!existing.includes(name)) {
    await turso(["db", "create", name]);
  }
  const dbUrl = await turso(["db", "show", name, "--url"]);
  const dbToken = await turso(["db", "tokens", "create", name]);
  return { dbUrl, dbToken, created: !existing.includes(name) };
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
      if (params.dbUrl) return { dbUrl: params.dbUrl, dbCreated: false, adopted: true };
      if (refs.dbUrl) {
        // resume: db already resolved — re-mint a token only if we never got one
        if (!ctx.secrets.dbToken) {
          const r = await createTenantDatabase(params.id); // create is adopt-if-exists
          ctx.secrets.dbToken = r.dbToken;
          return { dbUrl: r.dbUrl, dbCreated: refs.dbCreated || r.created };
        }
        return {};
      }
      ctx.log(`→ creating Turso database ${tenantDbName(params.id)}…`);
      const r = await createTenantDatabase(params.id);
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
          shopify_store_domain: params.shopDomain,
          shopify_api_version: process.env.SHOPIFY_API_VERSION || "2025-10",
          ...(params.clientId ? { shopify_client_id: params.clientId } : {}),
          typesense_collection: `products_${params.id}`,
          site_url: params.domains?.[0] ? `https://${params.domains[0]}` : null,
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
        await patchTenant(ctx.params.id, { config: { onboarding: { provisioned_at: nowIso(), run_id: ctx.runId, manual: {} } } });
      }
      return { onboardingRecorded: true };
    },
  },
];

// Execute (or RESUME) a provisioning run. `resumeRunId` re-enters that run:
// done steps are skipped, the failed/pending tail re-executes with the
// stored refs. `failAt` is a TEST hook (injects a failure before that step).
export async function runProvision(params, { resumeRunId = null, failAt = null, log = () => {} } = {}) {
  if (!resumeRunId) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(params.id || "")) throw new Error("tenant id must be a slug");
    if (!params.shopDomain) throw new Error("shopDomain required (x.myshopify.com)");
  }

  let runRow;
  if (resumeRunId) {
    runRow = await getProvisionRun(resumeRunId);
    if (!runRow) throw new Error(`provision run ${resumeRunId} not found`);
    if (runRow.status === "done") return { run: runRow, resumedNoop: true };
    params = { ...runRow.params, ...params, id: runRow.tenant_id }; // stored redacted params win the identity
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
      params: { id: params.id, name: params.name || null, shopDomain: params.shopDomain, domains: params.domains || [], siteName: params.siteName || null, supportEmail: params.supportEmail || null, adoptedDb: Boolean(params.dbUrl), force: Boolean(params.force) },
      error: null,
      created_at: nowIso(),
    };
  }
  await saveRun(runRow);

  const ctx = { params, refs: runRow.refs, secrets: {}, runId: runRow.id, log };
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

export async function provisionTenant({ id, name, domains = [], shopDomain, clientId = null, clientSecret = null, siteName = null, supportEmail = null, dbUrl = null, dbToken = null, force = false, log = () => {} }) {
  const r = await runProvision({ id, name, domains, shopDomain, clientId, clientSecret, siteName, supportEmail, dbUrl, dbToken, force }, { log });
  if (r.failedStep) {
    const err = new Error(`${r.error} (run ${r.run.id} — resume from the platform console)`);
    err.runId = r.run.id;
    throw err;
  }
  return { tenant: r.tenant, generated: r.generated || { admin_password: "(unchanged — tenant already existed)" }, run: r.run };
}
