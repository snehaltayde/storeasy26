// Durable-jobs suite (Session 29 / BE14+BE19): idempotent enqueue, atomic
// leasing, crash recovery via lease expiry, backoff + dead-letter, replay with
// audit, the webhook inbox, the money-idempotency acceptance (duplicate
// payment replay changes state once), and queue stats/pruning.
//   pnpm test:jobs
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-jobs-default.db";
process.env.PLATFORM_DB_URL = "file:.test-jobs-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
delete process.env.ALERT_WEBHOOK_URL;

const dbs = [".test-jobs-default.db", ".test-jobs-platform.db", ".test-jobs-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const J = await import("../lib/platform/jobs.js");
const W = await import("../lib/platform/worker.js");
const A = await import("../lib/platform/audit.js");
const { withTenant, tenantId } = await import("../lib/tenant-context.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const quiet = async (fn) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

// fixtures
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
const migs = await (await import("../lib/platform/migrate.js")).loadMigrations("platform");
await (await import("../lib/platform/migrate.js")).runMigrations(C.platformDb(), migs);
await C.upsertTenant({ id: "jt", name: "Jobs Tenant", domains: ["jt.test"], dbUrl: "file:.test-jobs-t1.db", config: {}, secrets: {} });
const tenantClient = createClient({ url: "file:.test-jobs-t1.db" });
const { applyTenantSchema } = await import("../lib/platform/provision.js");
await applyTenantSchema(tenantClient);

// --- enqueue -------------------------------------------------------------------
await t("enqueueJob: idempotency key → one row, existed on repeat", async () => {
  const a = await J.enqueueJob({ type: "x", payload: { n: 1 }, idempotencyKey: "k1" });
  const b = await J.enqueueJob({ type: "x", payload: { n: 2 }, idempotencyKey: "k1" });
  eq(a.existed, false, "first");
  eq(b.existed, true, "second");
  eq(b.id, a.id, "same row");
});

await t("enqueueDurable: tenant from context; legacy mode is a safe no-op", async () => {
  const T = await C.getTenant("jt");
  const r = await withTenant(T, () => J.enqueueDurable("x", { a: 1 }, "k-durable"));
  ok(r?.id, "enqueued");
  const rows = await J.listJobs({ tenant: "jt" });
  ok(rows.some((j) => j.idempotency_key === "k-durable"), "tenant tagged");
  process.env.PLATFORM_DB_URL = "";
  eq(await J.enqueueDurable("x", {}, "k-legacy"), null, "legacy no-op");
  process.env.PLATFORM_DB_URL = "file:.test-jobs-platform.db";
  C.__resetPlatformClient();
});

// --- leasing --------------------------------------------------------------------
await t("leaseJobs: atomic — a second lease pass gets nothing; future run_after skipped", async () => {
  await J.enqueueJob({ type: "x", idempotencyKey: "k-lease" });
  await J.enqueueJob({ type: "x", idempotencyKey: "k-future", runAfter: new Date(Date.now() + 3600_000).toISOString() });
  const leased = await J.leaseJobs({ limit: 50 });
  ok(leased.some((j) => j.idempotency_key === "k-lease"), "due job leased");
  eq(leased.some((j) => j.idempotency_key === "k-future"), false, "future job not leased");
  const second = await J.leaseJobs({ limit: 50 });
  eq(second.length, 0, "nothing double-leased");
});

await t("crash recovery: an expired lease re-leases with attempts incremented", async () => {
  const row = (await J.listJobs({})).find((j) => j.idempotency_key === "k-lease");
  eq(row.status, "leased", "still leased (worker 'crashed')");
  const before = Number(row.attempts);
  await C.platformDb().execute({
    sql: "UPDATE jobs SET lease_until = ? WHERE id = ?",
    args: [new Date(Date.now() - 1000).toISOString(), row.id],
  });
  const leased = await J.leaseJobs({ limit: 50 });
  const again = leased.find((j) => j.id === row.id);
  ok(again, "re-leased after expiry — ack'd work is never lost");
  eq(Number(again.attempts), before + 1, "attempts incremented");
  await J.completeJob(row.id);
});

await t("failJob: backoff schedules a future retry; exhaustion dead-letters (alert fired)", async () => {
  await J.enqueueJob({ type: "x", idempotencyKey: "k-fail", maxAttempts: 2 });
  let [job] = await J.leaseJobs({ limit: 1 });
  let r = await quiet(() => J.failJob(job, new Error("boom 1")));
  eq(r.dead, false, "retry scheduled");
  let row = (await J.listJobs({})).find((j) => j.id === job.id);
  eq(row.status, "pending", "pending again");
  ok(new Date(row.run_after).getTime() > Date.now(), "run_after in the future");
  await C.platformDb().execute({ sql: "UPDATE jobs SET run_after = NULL WHERE id = ?", args: [job.id] });
  [job] = await J.leaseJobs({ limit: 1 });
  r = await quiet(() => J.failJob(job, new Error("boom 2")));
  eq(r.dead, true, "dead at max_attempts");
  row = (await J.listJobs({ status: "dead" })).find((j) => j.id === job.id);
  ok(row, "listed as dead");
});

await t("replayJob: dead → pending with a fresh budget, audited", async () => {
  const dead = (await J.listJobs({ status: "dead" }))[0];
  eq(await J.replayJob(dead.id), true, "replayed");
  const row = (await J.listJobs({})).find((j) => j.id === dead.id);
  eq(row.status, "pending", "pending");
  eq(Number(row.attempts), 0, "attempts reset");
  const trail = await A.listAudit({ tenantId: dead.tenant_id ?? null, limit: 20 });
  ok(trail.some((a) => a.action === "queue.replay" && a.resource === `job:${dead.id}`), "audit row");
  await J.leaseJobs({ limit: 10 }).then((l) => Promise.all(l.map((j) => J.completeJob(j.id)))); // drain
});

// --- worker ----------------------------------------------------------------------
await t("runDueJobs: handler runs under the job's tenant context; failures feed backoff", async () => {
  await J.enqueueJob({ type: "probe", tenantId: "jt", idempotencyKey: "k-ctx" });
  await J.enqueueJob({ type: "probe-fail", tenantId: "jt", idempotencyKey: "k-ctx-fail", maxAttempts: 1 });
  const seen = [];
  const results = await quiet(() =>
    W.runDueJobs({
      limit: 10,
      handlers: {
        probe: async () => {
          seen.push(tenantId());
          return { ok: 1 };
        },
        "probe-fail": async () => {
          throw new Error("handler exploded");
        },
      },
    }),
  );
  eq(seen[0], "jt", "tenant context");
  const good = results.find((r) => r.type === "probe");
  const bad = results.find((r) => r.type === "probe-fail");
  eq(good.ok, true, "success completed");
  eq(bad.ok, false, "failure reported");
  eq(bad.dead, true, "maxAttempts 1 → dead");
});

await t("runJobById: fast path runs once; tick can never double-run it", async () => {
  const { id } = await J.enqueueJob({ type: "probe", idempotencyKey: "k-once" });
  let runs = 0;
  const handlers = {
    probe: async () => {
      runs++;
    },
  };
  const first = await W.runJobById(id, { handlers });
  eq(first.ok, true, "ran");
  eq(await W.runJobById(id, { handlers }), null, "second call no-ops");
  const viaTick = await W.runDueJobs({ limit: 10, handlers });
  eq(viaTick.some((r) => r.id === id), false, "tick skips the done job");
  eq(runs, 1, "exactly one execution");
});

// --- webhook inbox -----------------------------------------------------------------
await t("inbox: receipt persists raw body + hash; status transitions; lists hide payloads", async () => {
  const id = await J.recordWebhook({
    source: "shopify",
    topic: "products/update",
    shopDomain: "x.myshopify.com",
    tenantId: "jt",
    rawBody: '{"id":123,"title":"secret-ish body"}',
    headers: { webhook_id: "w1" },
    hmacOk: true,
  });
  const row = await J.getInbox(id);
  eq(row.status, "pending", "pending");
  ok(row.payload.includes("secret-ish body"), "raw body stored for replay");
  ok(/^[0-9a-f]{64}$/.test(row.body_hash), "hash");
  const listed = (await J.listInbox({})).find((r) => r.id === id);
  eq(listed.payload, undefined, "inspector list has NO payload");
  await J.markInbox(id, "dead", { error: "simulated" });
  eq((await J.getInbox(id)).status, "dead", "dead");
});

await t("replayInbox: dead receipt → pending + apply job recreated/reset, audited", async () => {
  const dead = (await J.listInbox({ status: "dead" }))[0];
  eq(await J.replayInbox(dead.id), true, "replayed");
  eq((await J.getInbox(dead.id)).status, "pending", "pending again");
  const job = (await J.listJobs({})).find((j) => j.idempotency_key === `wh:${dead.id}`);
  eq(job.status, "pending", "apply job pending");
  const trail = await A.listAudit({ tenantId: "jt", limit: 20 });
  ok(trail.some((a) => a.action === "queue.replay" && a.resource === `inbox:${dead.id}`), "audit row");
});

// --- BE14 acceptance: duplicate payment replay changes money state ONCE ------------
await t("ACCEPTANCE: razorpay webhook_apply replay marks the order paid exactly once", async () => {
  // quiesce leftovers from earlier tests so this batch is only ours
  await C.platformDb().execute("UPDATE jobs SET status = 'done', done_at = datetime('now') WHERE status IN ('pending','leased')");
  await tenantClient.execute({
    sql: `INSERT INTO orders (id, status, payment_method, payment_status, total, currency, razorpay_order_id, created_at)
          VALUES ('BL-JOBSTEST', 'pending_payment', 'razorpay', 'pending', 500, 'INR', 'order_jobs1', ?)`,
    args: [new Date().toISOString()],
  });
  const rawBody = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_jobs1", order_id: "order_jobs1", amount: 50000 } } },
  });
  const inboxId = await J.recordWebhook({ source: "razorpay", topic: "payment.captured", tenantId: "jt", rawBody, hmacOk: true });
  await J.enqueueJob({ type: "webhook_apply", tenantId: "jt", payload: { inboxId }, idempotencyKey: `wh:${inboxId}` });
  const r1 = await quiet(() => W.runDueJobs({ limit: 5 }));
  const first = r1.find((r) => r.type === "webhook_apply");
  eq(first.ok, true, "first apply ok");
  eq(first.result?.already, false, "first apply PAID the order");
  const paidRow = await tenantClient.execute("SELECT status, razorpay_payment_id, paid_at FROM orders WHERE id = 'BL-JOBSTEST'");
  ok(["paid", "syncing_shopify", "sync_failed"].includes(paidRow.rows[0].status), `paid (${paidRow.rows[0].status})`);
  const paidAt = paidRow.rows[0].paid_at;
  // duplicate delivery: replay the SAME receipt
  await J.replayInbox(inboxId);
  const r2 = await quiet(() => W.runDueJobs({ limit: 5 }));
  const second = r2.find((r) => r.type === "webhook_apply");
  eq(second.ok, true, "replay ok");
  eq(second.result?.already, true, "replay was a no-op on money state");
  const after = await tenantClient.execute("SELECT paid_at, razorpay_payment_id FROM orders WHERE id = 'BL-JOBSTEST'");
  eq(after.rows[0].paid_at, paidAt, "paid_at unchanged");
  eq(after.rows[0].razorpay_payment_id, "pay_jobs1", "same payment");
  eq((await J.getInbox(inboxId)).status, "done", "receipt done");
});

// --- GEN-02: long jobs, budgets, requeue ------------------------------------------------
const same = (got, want, label) => eq(JSON.stringify(got), JSON.stringify(want), label);
await t("long jobs (catalog_sync) only run for a caller with a budget, and after the others", async () => {
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  await J.enqueueJob({ type: "catalog_sync", tenantId: "jt", payload: { runId: "r1" }, idempotencyKey: "k-long" });
  await J.enqueueJob({ type: "probe", tenantId: "jt", idempotencyKey: "k-short" });
  const order = [];
  const handlers = { probe: async () => order.push("probe"), catalog_sync: async (_p, ctx) => order.push(`sync:${ctx.deadline != null}`) };
  const without = await W.runDueJobs({ limit: 10, handlers });
  eq(without.map((r) => r.type).join(","), "probe", "no budget: only the short job:");
  const pending = (await J.listJobs({})).find((j) => j.idempotency_key === "k-long");
  same([pending.status, Number(pending.attempts)], ["pending", 0], "the long job untouched:");
  await J.enqueueJob({ type: "probe", tenantId: "jt", idempotencyKey: "k-short-2" });
  await W.runDueJobs({ limit: 10, handlers, budgetMs: 50_000 });
  eq(order.slice(1).join(","), "probe,sync:true", "with a budget: short first, the long one last and given the deadline:");
});

await t("Phase 1 line 2: provision_store is a long job (only budgeted callers lease it), with a handler", async () => {
  ok(W.LONG_JOB_TYPES.includes("provision_store"), "long");
  eq(typeof W.HANDLERS.provision_store, "function", "handler");
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  await J.enqueueJob({ type: "provision_store", payload: { signupId: "sgn_x" }, idempotencyKey: "k-prov" });
  const ran = [];
  const handlers = { provision_store: async () => ran.push("prov") };
  await W.runDueJobs({ limit: 10, handlers });
  eq(ran.length, 0, "no budget: not leased");
  await W.runDueJobs({ limit: 10, handlers, budgetMs: 50_000 });
  eq(ran.join(), "prov", "with a budget: run");
});

await t("Phase 1 line 8: onboarding_sweep is a long job with a handler (only budgeted callers lease it)", async () => {
  ok(W.LONG_JOB_TYPES.includes("onboarding_sweep"), "long");
  eq(typeof W.HANDLERS.onboarding_sweep, "function", "handler");
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  await J.enqueueJob({ type: "onboarding_sweep", idempotencyKey: "k-sweep" });
  const ran = [];
  const handlers = { onboarding_sweep: async (_p, ctx) => ran.push(ctx.deadline != null) };
  await W.runDueJobs({ limit: 10, handlers });
  eq(ran.length, 0, "no budget: not leased");
  await W.runDueJobs({ limit: 10, handlers, budgetMs: 50_000 });
  eq(ran.join(), "true", "with a budget: run, given the deadline");
});

await t("a job leased but not reached before the deadline is handed back with its attempt", async () => {
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  await J.enqueueJob({ type: "probe", idempotencyKey: "k-slow" });
  await J.enqueueJob({ type: "probe", idempotencyKey: "k-late" });
  let t0 = 0;
  const now = () => t0;
  const handlers = { probe: async () => (t0 += 60_000) }; // the first job eats the whole budget
  const results = await W.runDueJobs({ limit: 10, handlers, budgetMs: 50_000, now });
  eq(results.length, 1, "ran:");
  const rows = (await J.listJobs({})).filter((j) => ["k-slow", "k-late"].includes(j.idempotency_key));
  const late = rows.find((j) => j.id !== results[0].id);
  same([late.status, Number(late.attempts), late.lease_until], ["pending", 0, null], "handed back:");
});

await t("a handler that has more to do requeues its job: pending, due, fresh attempts, back of the line", async () => {
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  const { id } = await J.enqueueJob({ type: "catalog_sync", idempotencyKey: "k-requeue" });
  const before = (await J.listJobs({})).find((j) => j.id === id).created_at;
  const res = await W.runJobById(id, { handlers: { catalog_sync: async () => ({ requeue: true }) }, budgetMs: 40_000 });
  eq(res.requeued, true, "requeued:");
  const row = (await J.listJobs({})).find((j) => j.id === id);
  same([row.status, Number(row.attempts), row.run_after], ["pending", 0, null], "row:");
  ok(row.created_at >= before, "moved to the back of the line");
  const later = new Date(Date.now() + 60_000).toISOString();
  await W.runJobById(id, { handlers: { catalog_sync: async () => ({ requeue: true, runAfter: later }) }, budgetMs: 40_000 });
  eq((await J.listJobs({})).find((j) => j.id === id).run_after, later, "a requeue can wait for another runner:");
});

await t("makeJobDue takes over a job whose runner was killed (lease ran out), never one a live runner holds", async () => {
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  const { id } = await J.enqueueJob({ type: "catalog_sync", idempotencyKey: "k-killed" });
  const set = (until) => C.platformDb().execute({ sql: "UPDATE jobs SET status = 'leased', attempts = 3, lease_until = ? WHERE id = ?", args: [until, id] });
  const row = async () => (await J.listJobs({})).find((j) => j.id === id);
  await set(new Date(Date.now() + 60_000).toISOString());
  await J.makeJobDue(id);
  eq((await row()).status, "leased", "a live lease is left alone:");
  await set(new Date(Date.now() - 1_000).toISOString());
  await J.makeJobDue(id);
  const r = await row();
  same([r.status, Number(r.attempts), r.lease_until, r.run_after], ["pending", 0, null, null], "a lapsed lease becomes due, with a fresh budget:");
});

// --- stats + retention ---------------------------------------------------------------
await t("queueStats + prune: counts are sane; OLD done rows age out, recent done + dead stay", async () => {
  const stats = await J.queueStats();
  ok(typeof stats.jobs.pending === "number" && typeof stats.inbox.dead === "number", "shape");
  const oldIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await C.platformDb().execute({
    sql: "INSERT INTO jobs (id, type, status, updated_at, created_at) VALUES ('job_olddone','x','done', ?, ?), ('job_newdead','x','dead', ?, ?)",
    args: [oldIso, oldIso, new Date().toISOString(), new Date().toISOString()],
  });
  await J.pruneQueues({ doneDays: 7 });
  const doneIds = (await J.listJobs({ status: "done" })).map((j) => j.id);
  eq(doneIds.includes("job_olddone"), false, "old done pruned");
  ok((await J.listJobs({ status: "dead" })).some((j) => j.id === "job_newdead"), "recent dead kept");
});

// --- Phase 3 line 6: discarded dead letters --------------------------------------------
const actor = { kind: "operator", id: "u_ops_test" };
await t("discard: only a dead job; the tick never runs a discarded job", async () => {
  await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE status IN ('pending','leased')");
  const { id } = await J.enqueueJob({ type: "noop_discard", idempotencyKey: "k-discard-tick" });
  eq(await J.discardJob(id, { actor }), false, "a pending job is not discarded:");
  await C.platformDb().execute({ sql: "UPDATE jobs SET status = 'dead' WHERE id = ?", args: [id] });
  eq(await J.discardJob(id, { actor }), true, "a dead job is discarded:");
  let ran = 0;
  const results = await W.runDueJobs({ handlers: { noop_discard: async () => void ran++ } });
  eq(ran, 0, "handler never called:");
  ok(!results.some((r) => r.id === id), "not in the tick's results");
  eq((await J.listJobs({})).find((j) => j.id === id).status, "discarded", "still discarded:");
});

await t("makeJobDue leaves a discarded job alone (an automatic poll); with revive (an explicit retry) it is pending with a fresh budget, and the tick runs it", async () => {
  const { id } = await J.enqueueJob({ type: "noop_retry", idempotencyKey: "k-discard-retry" });
  await C.platformDb().execute({ sql: "UPDATE jobs SET status = 'dead', attempts = 5 WHERE id = ?", args: [id] });
  await J.discardJob(id, { actor });
  await J.makeJobDue(id);
  eq((await J.listJobs({})).find((j) => j.id === id).status, "discarded", "no revive, still discarded:");
  await J.makeJobDue(id, { revive: true });
  const r = (await J.listJobs({})).find((j) => j.id === id);
  same([r.status, Number(r.attempts), r.run_after], ["pending", 0, null], "due again:");
  let ran = 0;
  await W.runDueJobs({ handlers: { noop_retry: async () => void ran++ } });
  eq(ran, 1, "the handler ran:");
});

await t("prune: a discarded job ages out on the dead-letter schedule and frees its idempotency key; a recent one stays", async () => {
  const old = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  await C.platformDb().execute({
    sql: "INSERT INTO jobs (id, type, status, idempotency_key, updated_at, created_at) VALUES ('job_olddisc','x','discarded','k-old-disc', ?, ?), ('job_newdisc','x','discarded','k-new-disc', ?, ?)",
    args: [old, old, now, now],
  });
  await J.pruneQueues({ deadDays: 60 });
  const ids = (await J.listJobs({ limit: 200 })).map((j) => j.id);
  eq(ids.includes("job_olddisc"), false, "old discarded pruned:");
  ok(ids.includes("job_newdisc"), "recent discarded kept");
  eq((await J.enqueueJob({ type: "x", idempotencyKey: "k-old-disc" })).existed, false, "the key is free again:");
});

console.log(`\n${pass} passed, ${fail} failed`);
tenantClient.close?.();
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
