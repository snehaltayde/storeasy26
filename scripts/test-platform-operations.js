// Operations on the new UI (Phase 3 line 6, docs/plans/phase-3.md "Line 6"):
// the queues, provisioning runs, privacy requests, themes and case-studies
// routes behind /platform/operations.
//   pnpm test:platform-operations
// 1. Least-trusted: signed out, a merchant owner's and a support member's
//    _admin cookie, and a merchant token put in _platform get 401 on every
//    read and write, and nothing changes; a cross-origin write gets 403.
// 2. Queues: discard takes a dead job to 'discarded' and a dead webhook to
//    'ignored', only when dead; retry brings a discarded job back. Payloads
//    never leave the server.
// 3. Provisioning runs carry no params or refs (founder email, database
//    address, tokens); abandoning a failed run is audited.
// 4. Privacy requests carry no shopper email, phone or customer id (canary);
//    an empty store is refused before anything runs; erasure is audited as
//    privacy.redact with counts only.
// 5. Every write's audit row names the real operator.
// 6. Static: the page and its components use components/ui and kit only, the
//    nav ends with Operations, and platform-pages.js lists the page.
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const network = H.blockNetwork();
process.env.DATABASE_URL = "file:.test-platform-ops-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.message || e).split("\n").join("\n    ")}`);
  }
}
const same = (a, b, m = "") => eq(JSON.stringify(a), JSON.stringify(b), m);
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

const store = await H.makeRoleStore({ name: "plops" });
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const { createClient } = await import("@libsql/client");
const pdb = () => C.platformDb();
const sql = async (q, args = []) => (await pdb().execute({ sql: q, args })).rows;
const tenantDb = createClient({ url: store.a.tenant.dbUrl });

const { NextRequest } = await import("./support/next-server-stub.js");
const routes = {};
async function call(path, { method = "GET", cookies = {}, body, origin, query = "" } = {}) {
  routes[path] ??= await import(pathToFileURL(join(ROOT, "app/api/platform", path, "route.js")).href);
  const headers = { host: "ops.test" };
  const o = origin === undefined ? (method === "GET" ? null : "http://ops.test") : origin;
  if (o) headers.origin = o;
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`http://ops.test/api/platform/${path}${query ? `?${query}` : ""}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await routes[path][method](req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty
  }
  return { status: res.status, body: json, text };
}

const operator = store.cookies["operator-support"];
const operatorId = store.users.operator.id;
const merchantToken = (await S.createSession({ userId: store.users.owner.id, kind: "merchant", ttlMs: 10 * 60_000 })).token;
const OUTSIDERS = {
  "signed out": {},
  "merchant owner (_admin)": store.cookies.owner,
  "merchant support member (_admin)": store.cookies.support,
  "merchant token in _platform": { _platform: merchantToken },
};

// canaries that must never reach an operator response
const CANARY_EMAIL = "canary-shopper-7f3a@ops.test";
const CANARY_PHONE = "9876500123";
const CANARY_CUSTOMER = "gid://shopify/Customer/canary-551";
const CANARY_FOUNDER = "founder-canary-91@ops.test";
const CANARY_DB = "libsql://canary-db-ops.turso.io";
const CANARY_PAYLOAD = "payload-canary-shopper@ops.test";
const CANARY_SHOP = "canary-shop-44.myshopify.com";

const now = new Date().toISOString();
async function seedJobs() {
  await pdb().execute({ sql: "DELETE FROM jobs WHERE id LIKE 'job_ops_%'", args: [] });
  await pdb().execute({ sql: "DELETE FROM webhook_inbox WHERE id LIKE 'wh_ops_%'", args: [] });
  for (const [id, status] of [["job_ops_dead", "dead"], ["job_ops_dead2", "dead"], ["job_ops_pending", "pending"]]) {
    await pdb().execute({
      sql: `INSERT INTO jobs (id, type, tenant_id, payload, idempotency_key, status, attempts, max_attempts, last_error, created_at, updated_at)
            VALUES (?, 'noop_test', ?, ?, ?, ?, 5, 5, 'boom', ?, ?)`,
      args: [id, store.a.id, JSON.stringify({ email: CANARY_PAYLOAD }), `ops:${id}`, status, now, now],
    });
  }
  await pdb().execute({
    sql: `INSERT INTO webhook_inbox (id, source, topic, shop_domain, tenant_id, body_hash, payload, headers, hmac_ok, status, received_at)
          VALUES ('wh_ops_dead', 'shopify', 'orders/create', 'ops.myshopify.com', ?, 'h', ?, '{}', 1, 'dead', ?)`,
    args: [store.a.id, JSON.stringify({ email: CANARY_PAYLOAD }), now],
  });
}
const jobStatus = async (id) => (await sql("SELECT status FROM jobs WHERE id = ?", [id]))[0]?.status;
const inboxStatus = async (id) => (await sql("SELECT status FROM webhook_inbox WHERE id = ?", [id]))[0]?.status;
const auditFor = async (action, resource) => sql("SELECT * FROM audit_log WHERE action = ? AND resource = ? ORDER BY at", [action, resource]);

async function seedRun(id) {
  await pdb().execute({ sql: "DELETE FROM provision_runs WHERE id = ?", args: [id] });
  await pdb().execute({
    sql: `INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, error, created_at, updated_at) VALUES (?, 'ops-ghost', 'failed', ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      JSON.stringify([{ name: "create_db", status: "failed", detail: `could not reach ${CANARY_DB}: quota` }, { name: "register_tenant", status: "pending" }]),
      JSON.stringify({ dbUrl: CANARY_DB }),
      JSON.stringify({ id: "ops-ghost", supportEmail: CANARY_FOUNDER, siteName: "Ghost", dbUrl: CANARY_DB, source: "operator" }),
      `create_db: could not reach ${CANARY_DB}: quota`,
      now,
      now,
    ],
  });
}

async function seedPrivacy(id) {
  await tenantDb.execute({ sql: "DELETE FROM privacy_requests WHERE id = ?", args: [id] });
  await tenantDb.execute({
    sql: "INSERT INTO privacy_requests (id, kind, email, phone, customer_id, shop_domain, status, notes, created_at) VALUES (?, 'customer_redact', ?, ?, ?, ?, 'manual', NULL, ?)",
    args: [id, CANARY_EMAIL, CANARY_PHONE, CANARY_CUSTOMER, CANARY_SHOP, now],
  });
}
const noCanary = (text, m) => {
  for (const c of [CANARY_EMAIL, CANARY_PHONE, CANARY_CUSTOMER, CANARY_FOUNDER, CANARY_DB, CANARY_PAYLOAD, CANARY_SHOP]) ok(!String(text).includes(c), `${m}: no ${c}`);
};

await seedJobs();
await seedRun("run_ops_failed");
await seedPrivacy("pr_ops_one");

// ---------------------------------------------------------------------------
console.log("— least-trusted callers");

const READS = ["queues", "provisions", "privacy", "themes", "case-studies"];
const WRITES = [
  ["queues", { action: "discard", kind: "job", id: "job_ops_dead" }],
  ["queues", { action: "replay", kind: "job", id: "job_ops_dead" }],
  ["queues", { action: "discard", kind: "inbox", id: "wh_ops_dead" }],
  ["queues", { action: "tick" }],
  ["provisions", { action: "compensate", run: "run_ops_failed" }],
  ["provisions", { action: "resume", run: "run_ops_failed" }],
  ["privacy", { action: "redact", tenant: store.a.id, requestId: "pr_ops_one" }],
  ["case-studies", { case_study: { slug: "ops-outsider", title: "Outsider" } }],
];

for (const [who, cookies] of Object.entries(OUTSIDERS)) {
  await t(`${who}: every operations read is 401 with no data`, async () => {
    for (const path of READS) {
      const r = await call(path, { cookies });
      eq(r.status, 401, `${path}:`);
      noCanary(r.text, path);
      ok(!r.text.includes(store.a.id), `${path}: no store id`);
    }
  });
  await t(`${who}: every operations write is 401 and changes nothing`, async () => {
    for (const [path, body] of WRITES) eq((await call(path, { method: "POST", cookies, body })).status, 401, `${path} ${JSON.stringify(body)}:`);
    eq(await jobStatus("job_ops_dead"), "dead", "job:");
    eq(await inboxStatus("wh_ops_dead"), "dead", "inbox:");
    eq((await sql("SELECT status FROM provision_runs WHERE id = 'run_ops_failed'"))[0].status, "failed", "run:");
    eq((await tenantDb.execute("SELECT status FROM privacy_requests WHERE id = 'pr_ops_one'")).rows[0].status, "manual", "privacy:");
    eq((await sql("SELECT 1 FROM case_studies WHERE slug = 'ops-outsider'")).length, 0, "case study:");
  });
}

await t("cross-origin: an operator's write from another site is 403 and changes nothing", async () => {
  for (const [path, body] of WRITES) eq((await call(path, { method: "POST", cookies: operator, body, origin: "https://evil.example" })).status, 403, `${path}:`);
  eq(await jobStatus("job_ops_dead"), "dead", "job:");
});

// ---------------------------------------------------------------------------
console.log("— queues");

await t("operator: counts by state and the dead letters, without payloads", async () => {
  const r = await call("queues", { cookies: operator, query: "status=dead" });
  eq(r.status, 200, r.text);
  ok(r.body.stats.jobs.dead >= 2, "dead jobs counted");
  ok(r.body.stats.inbox.dead >= 1, "dead webhook counted");
  ok(r.body.jobs.some((j) => j.id === "job_ops_dead"), "dead job listed");
  ok(r.body.inbox.some((w) => w.id === "wh_ops_dead"), "dead webhook listed");
  noCanary(r.text, "queues");
});

await t("discard: a dead job becomes 'discarded', audited with the operator's id", async () => {
  const r = await call("queues", { method: "POST", cookies: operator, body: { action: "discard", kind: "job", id: "job_ops_dead" } });
  eq(r.status, 200, r.text);
  eq(await jobStatus("job_ops_dead"), "discarded");
  const rows = await auditFor("queue.discard", "job:job_ops_dead");
  eq(rows.length, 1, "one audit row:");
  eq(rows[0].actor, operatorId, "actor:");
  eq(rows[0].actor_kind, "operator", "actor kind:");
});

await t("discard: a job that isn't dead is 404 and unchanged; a second discard is 404", async () => {
  eq((await call("queues", { method: "POST", cookies: operator, body: { action: "discard", kind: "job", id: "job_ops_pending" } })).status, 404);
  eq(await jobStatus("job_ops_pending"), "pending");
  eq((await call("queues", { method: "POST", cookies: operator, body: { action: "discard", kind: "job", id: "job_ops_dead" } })).status, 404);
  eq((await auditFor("queue.discard", "job:job_ops_pending")).length, 0, "no audit row for a refused discard:");
});

await t("retry: a discarded job is queued again, audited with the operator's id", async () => {
  const r = await call("queues", { method: "POST", cookies: operator, body: { action: "replay", kind: "job", id: "job_ops_dead" } });
  eq(r.status, 200, r.text);
  eq(await jobStatus("job_ops_dead"), "pending");
  const rows = await auditFor("queue.replay", "job:job_ops_dead");
  eq(rows.at(-1)?.actor, operatorId, "actor:");
});

await t("discard: a dead webhook becomes 'ignored', audited with the operator's id", async () => {
  const r = await call("queues", { method: "POST", cookies: operator, body: { action: "discard", kind: "inbox", id: "wh_ops_dead" } });
  eq(r.status, 200, r.text);
  eq(await inboxStatus("wh_ops_dead"), "ignored");
  eq((await auditFor("queue.discard", "inbox:wh_ops_dead"))[0]?.actor, operatorId, "actor:");
});

await t("an unknown queue action is 400", async () => {
  eq((await call("queues", { method: "POST", cookies: operator, body: { action: "discard", kind: "nope", id: "x" } })).status, 400);
});

// ---------------------------------------------------------------------------
console.log("— provisioning runs");

await t("operator: runs list steps and state, never params or refs (founder email, database address)", async () => {
  const r = await call("provisions", { cookies: operator });
  eq(r.status, 200, r.text);
  const run = r.body.runs.find((x) => x.id === "run_ops_failed");
  ok(run, "run listed");
  eq(run.status, "failed");
  eq(run.source, "operator", "source:");
  eq(run.steps.map((s) => s.name).join(","), "create_db,register_tenant", "steps:");
  ok(!("params" in run) && !("refs" in run), "no params or refs");
  ok(run.steps[0].detail.includes("[redacted]") && run.error.includes("[redacted]"), "the database address in a step's detail and the run error is scrubbed");
  noCanary(r.text, "provisions");
});

await t("abandon: a failed run is compensated, audited with the operator's id; the response has no params", async () => {
  const r = await call("provisions", { method: "POST", cookies: operator, body: { action: "compensate", run: "run_ops_failed" } });
  eq(r.status, 200, r.text);
  eq(r.body.run.status, "compensated");
  noCanary(r.text, "compensate");
  const rows = await auditFor("tenant.provision", "run:run_ops_failed");
  eq(rows.at(-1)?.actor, operatorId, "actor:");
  ok(!String(rows.at(-1)?.diff).includes(CANARY_FOUNDER), "diff holds no founder email");
});

await t("resume: a successful resume returns the console password once; a later list never carries it", async () => {
  const P = await import("../lib/platform/provision.js");
  const failed = await P.runProvision({ id: "ops-resume", name: "Ops Resume", shopDomain: "ops-resume.myshopify.com", domains: ["ops-resume.test"], dbUrl: "file:.test-platform-ops-resume.db" }, { failAt: "register_tenant" });
  eq(failed.failedStep, "register_tenant", "failed first:");
  const r = await call("provisions", { method: "POST", cookies: operator, body: { action: "resume", run: failed.run.id } });
  eq(r.status, 200, r.text);
  eq(r.body.run.status, "done", `resumed (${r.body.failedStep}):`);
  const password = r.body.generated?.admin_password;
  ok(typeof password === "string" && password.length >= 8, "the password, once");
  same(Object.keys(r.body.generated), ["admin_password"], "nothing else generated is sent:");
  ok(!("params" in r.body.run) && !("refs" in r.body.run), "the run view, not the raw run");
  const later = await call("provisions", { cookies: operator });
  ok(later.body.runs.some((x) => x.id === failed.run.id), "listed");
  ok(!later.text.includes(password), "a later GET never carries the password");
  ok(!(await sql("SELECT * FROM provision_runs WHERE id = ?", [failed.run.id])).some((row) => JSON.stringify(row).includes(password)), "not stored in the run");
});

await t("tick: a discarded job is never run", async () => {
  await pdb().execute({ sql: "UPDATE jobs SET status = 'dead' WHERE id = 'job_ops_dead2'", args: [] });
  eq((await call("queues", { method: "POST", cookies: operator, body: { action: "discard", kind: "job", id: "job_ops_dead2" } })).status, 200);
  const before = (await sql("SELECT updated_at, attempts FROM jobs WHERE id = 'job_ops_dead2'"))[0];
  const r = await call("queues", { method: "POST", cookies: operator, body: { action: "tick" } });
  eq(r.status, 200, r.text);
  const after = (await sql("SELECT status, updated_at, attempts FROM jobs WHERE id = 'job_ops_dead2'"))[0];
  same([after.status, after.updated_at, after.attempts], ["discarded", before.updated_at, before.attempts], "untouched by the tick:");
});

// ---------------------------------------------------------------------------
console.log("— privacy requests");

await t("operator: requests carry kind, state and the store's name, never the shopper's email, phone or customer id", async () => {
  const r = await call("privacy", { cookies: operator });
  eq(r.status, 200, r.text);
  const row = r.body.requests.find((x) => x.id === "pr_ops_one");
  ok(row, "listed");
  eq(row.tenant, store.a.id, "tenant:");
  ok(row.storeName, "store name");
  eq(row.kind, "customer_redact");
  for (const k of ["email", "phone", "customer_id", "shop_domain"]) ok(!(k in row), `no ${k}`);
  noCanary(r.text, "privacy");
});

await t("erasure without a store is 400 and runs nothing on the default database", async () => {
  const r = await call("privacy", { method: "POST", cookies: operator, body: { action: "redact", tenant: "", requestId: "pr_ops_one" } });
  eq(r.status, 400, r.text);
  eq((await tenantDb.execute("SELECT status FROM privacy_requests WHERE id = 'pr_ops_one'")).rows[0].status, "manual");
});

await t("erasure in an unknown store is refused (422), nothing changes", async () => {
  eq((await call("privacy", { method: "POST", cookies: operator, body: { action: "redact", tenant: "no-such-store", requestId: "pr_ops_one" } })).status, 422);
  eq((await auditFor("privacy.redact", "privacy:pr_ops_one")).length, 0, "no audit row:");
});

await t("erasure: the request is done, audited as privacy.redact with the operator's id and counts only", async () => {
  const r = await call("privacy", { method: "POST", cookies: operator, body: { action: "redact", tenant: store.a.id, requestId: "pr_ops_one" } });
  eq(r.status, 200, r.text);
  noCanary(r.text, "redact response");
  eq((await tenantDb.execute("SELECT status FROM privacy_requests WHERE id = 'pr_ops_one'")).rows[0].status, "done");
  const rows = await auditFor("privacy.redact", "privacy:pr_ops_one");
  eq(rows.length, 1, "one audit row:");
  eq(rows[0].actor, operatorId, "actor:");
  eq(rows[0].tenant_id, store.a.id, "tenant:");
  ok(!String(rows[0].diff).includes(CANARY_EMAIL) && !String(rows[0].diff).includes(CANARY_PHONE), "diff holds no shopper details");
  eq((await sql("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tenant.status' AND diff LIKE '%pr_ops_one%'"))[0].n, 0, "no old tenant.status row:");
});

await t("a done request again: no second audit row", async () => {
  eq((await call("privacy", { method: "POST", cookies: operator, body: { action: "redact", tenant: store.a.id, requestId: "pr_ops_one" } })).status, 200);
  eq((await auditFor("privacy.redact", "privacy:pr_ops_one")).length, 1);
});

// ---------------------------------------------------------------------------
console.log("— themes and case studies");

await t("operator: themes list the kits and each store's pin", async () => {
  const r = await call("themes", { cookies: operator });
  eq(r.status, 200, r.text);
  ok(r.body.kits.length > 0, "kits");
  ok(r.body.tenants.some((x) => x.id === store.a.id), "store a listed");
  ok(!r.text.includes("db_url") && !r.text.includes(String(store.a.tenant.dbUrl)), "no database address");
});

const MEASURED = {
  slug: "ops-growth",
  title: "Ops grew",
  tenant_id: store.a.id,
  consent_ref: "written approval, 2026-11-20",
  period: "Q3 2026",
  method: "reconciled orders",
  limitations: "one store",
  confounders: "none known",
  results: [{ metric: "orders", before: "10", after: "20" }],
};

await t("case studies: create, publish and archive, each audited with the operator's id", async () => {
  eq((await call("case-studies", { method: "POST", cookies: operator, body: { case_study: MEASURED } })).status, 200);
  eq((await call("case-studies", { method: "POST", cookies: operator, body: { publish_case: { slug: "ops-growth", published: true } } })).status, 200);
  eq((await call("case-studies", { method: "POST", cookies: operator, body: { publish_case: { slug: "ops-growth", published: false } } })).status, 200, "archive:");
  const row = (await sql("SELECT published FROM case_studies WHERE slug = 'ops-growth'"))[0];
  eq(Number(row.published), 0, "archived: off the site, kept");
  for (const action of ["case_study.save", "case_study.publish"]) {
    const rows = await auditFor(action, "case:ops-growth");
    ok(rows.length >= 1, `${action} audited`);
    ok(rows.every((x) => x.actor === operatorId && x.actor_kind === "operator"), `${action}: the operator's id`);
  }
});

await t("case studies: delete is audited with the operator's id, the slug and a note of what was removed", async () => {
  eq((await call("case-studies", { method: "POST", cookies: operator, body: { case_study: { ...MEASURED, slug: "ops-gone" } } })).status, 200);
  eq((await call("case-studies", { method: "POST", cookies: operator, body: { delete_case: { slug: "ops-gone" } } })).status, 200);
  eq((await sql("SELECT 1 FROM case_studies WHERE slug = 'ops-gone'")).length, 0, "gone:");
  const rows = await auditFor("case_study.delete", "case:ops-gone");
  eq(rows.length, 1, "one row:");
  eq(rows[0].actor, operatorId, "actor:");
  const diff = JSON.parse(rows[0].diff);
  eq(diff.slug, "ops-gone", "slug kept:");
  ok(/consent/.test(diff.removed) && /measurement/.test(diff.removed), `note: ${diff.removed}`);
});

await t("case studies: an edit of a published study takes it back to draft", async () => {
  await call("case-studies", { method: "POST", cookies: operator, body: { publish_case: { slug: "ops-growth", published: true } } });
  eq((await call("case-studies", { method: "POST", cookies: operator, body: { case_study: { ...MEASURED, title: "Ops grew 2x" } } })).status, 200);
  eq(Number((await sql("SELECT published FROM case_studies WHERE slug = 'ops-growth'"))[0].published), 0);
});

// ---------------------------------------------------------------------------
console.log("— static");

await t("static: the page and its components import components/ui and kit, never components/console", async () => {
  const files = ["app/(console)/platform/operations/page.js", "app/(console)/platform/operations/loading.js"];
  for (const f of await readdir(join(ROOT, "components/platform/operations"))) files.push(`components/platform/operations/${f}`);
  for (const f of files) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!/components\/console/.test(src), `${f} imports components/console`);
    ok(!/data-legacy/.test(src), `${f} uses data-legacy`);
  }
  ok(files.length >= 8, "page, loading and the five tabs");
});

await t("static: the nav ends with Operations and platform-pages.js lists the page", async () => {
  const { PLATFORM_NAV } = await import("../lib/platform/nav.js");
  ok(PLATFORM_NAV.some((i) => i.id === "operations" && i.href === "/platform/operations"), "nav item");
  const { PLATFORM_PAGES } = await import("./support/platform-pages.js");
  ok(PLATFORM_PAGES.some((p) => p.path === "/platform/operations" && !p.signIn), "page row");
});

await t("static: the page sends anyone who isn't an operator to /platform", async () => {
  const src = await readFile(join(ROOT, "app/(console)/platform/operations/page.js"), "utf8");
  ok(/platformOperator\(/.test(src) && /redirect\("\/platform"\)/.test(src), "guarded");
});

await t("no network: nothing reached fetch()", async () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

tenantDb.close();
await store.cleanup();
const { rm } = await import("node:fs/promises");
for (const f of [".test-platform-ops-resume.db", ".test-platform-ops-resume.db-wal", ".test-platform-ops-resume.db-shm", ".test-platform-ops-default.db", ".test-platform-ops-default.db-wal", ".test-platform-ops-default.db-shm"]) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
