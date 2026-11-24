// Signup provisioning suite (Phase 1 line 2, docs/plans/phase-1.md §1–§5).
// Verify queues a provision_store job and answers at once; the job makes the
// store's database through the Turso Platform API, here always the local fake
// (scripts/support/fake-turso-api.js, file backend) behind a fetch guard that
// fails on any host that is not loopback. Covers the step ledger (one database
// even when a create times out after it was made), the retry delays on a fake
// clock, the needs-operator answers and alert, Try again resuming the same run,
// the status route (steps, retry note, handoff tokens), the operator resume, a
// sweep for secrets in the database and the logs, and the §4 least-trusted tests.
//   pnpm test:signup-provision
import { rm, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const { loopbackFetchGuard, startFakeTursoApi } = await import("./support/fake-turso-api.js");
const guard = loopbackFetchGuard();

// every line the code logs is kept for the secret sweep (and still printed)
const logged = [];
for (const k of ["log", "error", "warn"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    logged.push(a.map(String).join(" "));
    if (!/^\{"ts"/.test(String(a[0])) && !/^\[ALERT/.test(String(a[0]))) orig(...a);
  };
}

const TMP = await mkdtemp(join(tmpdir(), "storeasy-sgnprov-"));
const API_TOKEN = `fake-api-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`;
const fake = await startFakeTursoApi({ token: API_TOKEN, org: "local-fake", dataDir: TMP, backend: "file" });
process.env.DATABASE_URL = "file:.test-sgnprov-default.db";
process.env.PLATFORM_SECRET = "test-signup-provision-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "storeasy.test";
process.env.SIGNUP_STORE_DOMAIN = "stores.test";
process.env.TURSO_API_URL = fake.url;
process.env.TURSO_API_TOKEN = API_TOKEN;
process.env.TURSO_ORG = "local-fake";
process.env.TURSO_GROUP = "default";
delete process.env.VERCEL;
delete process.env.CRON_SECRET;
if (process.env.NODE_ENV === "production") delete process.env.NODE_ENV;

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

const store = await H.makeRoleStore({ name: "sgp" });
const C = await import("../lib/platform/control.js");
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/signup.js");
const SP = await import("../lib/platform/signup-provision.js");
const P = await import("../lib/platform/provision.js");
const PV = await import("../lib/platform/provisioner.js");
const J = await import("../lib/platform/jobs.js");
const W = await import("../lib/platform/worker.js");
const A = await import("../lib/platform/turso-api.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = C.platformDb();
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const one = async (sql, args = []) => (await q(sql, args))[0] ?? null;
const count = async (sql, args = []) => Number((await one(sql, args))?.n ?? 0);
await db.execute({
  sql: `INSERT INTO feature_flags (key, description, default_on, tenants, critical, updated_at) VALUES (?, 'signup', 1, '{}', 0, ?)
        ON CONFLICT(key) DO UPDATE SET default_on = 1`,
  args: [S.SIGNUP_FLAG, new Date().toISOString()],
});

const MARKETING = "storeasy.test";
let ipSeq = 0;
async function api(path, method, { body, host = MARKETING, origin, cookie, cookies, ip } = {}) {
  const route = await import(pathToFileURL(join(ROOT, "app/api", path, "route.js")).href);
  const headers = { host, "x-forwarded-for": ip || `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` };
  const o = origin === undefined ? `http://${host}` : origin;
  if (o) headers.origin = o;
  const jar = { ...(cookie ? { [S.SIGNUP_COOKIE]: cookie } : {}), ...(cookies || {}) };
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  let reqBody;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await route[method](new NextRequest(`http://${host}/api/${path}`, { method, headers, body: reqBody }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty
  }
  return { status: res.status, body: json, text, setCookie: res.headers.getSetCookie() };
}
const cookieFrom = (res) => res.setCookie.find((c) => c.startsWith(`${S.SIGNUP_COOKIE}=`))?.split(";")[0].split("=")[1] ?? null;
let seq = 0;
async function start(storeName) {
  const n = ++seq;
  const f = { name: `Founder ${n}`, email: `prov${n}@sgp.test`, password: `pass-word-${n}-long`, storeName: storeName || `Prov Store ${n}` };
  const res = await api("signup", "POST", { body: f });
  eq(res.status, 200, `start ${res.text}`);
  return { f, cookie: cookieFrom(res), slug: S.slugFor(f.storeName) };
}
const rowFor = (email) => one("SELECT * FROM signups WHERE email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [email]);
const codeFor = async (email) =>
  String((await one("SELECT body FROM platform_mail WHERE recipient = ? AND kind = 'signup_code' ORDER BY created_at DESC, rowid DESC LIMIT 1", [email]))?.body || "").match(/\b(\d{6})\b/)?.[1];
const verify = async (s) => api("signup/verify", "POST", { body: { code: await codeFor(s.f.email) }, cookie: s.cookie });
const poll = (s, opts = {}) => api("signup/status", "POST", { body: {}, cookie: s.cookie, ...opts });
const fault = (f) => fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify(f) });
const clearFaults = () => fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });
const creates = (name) => fake.state.log.filter((l) => l.route === "create" && l.name === name);
// run the signup's job once, now (the fake clock decides the signup's own delays)
async function runJob(s) {
  const row = await rowFor(s.f.email);
  await J.makeJobDue(row.job_id);
  return W.runJobById(row.job_id, { budgetMs: 50_000 });
}
const clock = { at: Date.now() };
SP.signupClock.now = () => clock.at;
const tick = (ms) => (clock.at += ms);

// --- data, driver, gate ------------------------------------------------------------

await t("migrations 0012 and 0013: signups gains job_id, provision_attempts, next_attempt_at, failure_kind, handoff_invite_id, done_at, alerted_kinds and a (status, updated_at) index", async () => {
  const cols = (await q("PRAGMA table_info(signups)")).map((c) => c.name);
  for (const c of ["job_id", "provision_attempts", "next_attempt_at", "failure_kind", "handoff_invite_id", "done_at", "alerted_kinds"]) ok(cols.includes(c), c);
  ok(await one("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_signups_status'"), "index");
});

await t("driver: the Turso API when TURSO_API_TOKEN and TURSO_ORG are set, else a local file outside production, else none", () => {
  eq(PV.signupDbDriver({ TURSO_API_TOKEN: "x", TURSO_ORG: "y" }), "turso-api", "api");
  eq(PV.signupDbDriver({}), "file", "local");
  eq(PV.signupDbDriver({ NODE_ENV: "production" }), null, "production without the API");
  eq(PV.signupDbDriver({ VERCEL: "1" }), null, "Vercel without the API");
  ok(PV.STORE_DB_DRIVERS.includes("turso-api"), "a known driver");
});

await t("production without the Turso API: every signup route answers 503 'Signups are unavailable'", async () => {
  const keep = { token: process.env.TURSO_API_TOKEN, env: process.env.NODE_ENV };
  process.env.TURSO_API_TOKEN = "";
  process.env.NODE_ENV = "production";
  process.env.RESEND_API_KEY = "re_test_not_a_real_key"; // mail configured, so the database gate is what answers
  try {
    for (const path of ["signup", "signup/verify", "signup/status"]) {
      const r = await api(path, "POST", { body: {} });
      eq(r.status, 503, `${path}: ${r.text}`);
      ok(/Signups are unavailable/.test(r.body.error), r.body.error);
    }
  } finally {
    process.env.TURSO_API_TOKEN = keep.token;
    process.env.RESEND_API_KEY = "";
    if (keep.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = keep.env;
  }
});

// --- the happy path ---------------------------------------------------------------------

let happy;
await t("verify answers at once with 'provisioning' and queues provision_store {signupId} under provision_store:<id>; nothing is made before the job runs", async () => {
  happy = await start("Quick Queue Co");
  const r = await verify(happy);
  eq(r.status, 200, r.text);
  eq(r.body.status, "provisioning", "provisioning");
  ok(!r.body.redirect && !r.text.includes("jobId"), "no redirect yet, no job id");
  const row = await rowFor(happy.f.email);
  eq(row.status, "provisioning", "row");
  const job = await J.getJobByKey(`provision_store:${row.id}`);
  ok(job && job.id === row.job_id, "job keyed by the signup");
  eq(job.type, "provision_store", "type");
  eq(job.tenant_id, null, "no tenant on the job");
  eq(job.payload.signupId, row.id, "payload");
  eq(creates("storeasy-t-quick-queue-co").length, 0, "no database yet");
});

await t("the job (after()) makes the database through the API, registers the store with a never-expiring k1: token, makes the user and owner; no token in the job", async () => {
  await H.drainAfter();
  const row = await rowFor(happy.f.email);
  eq(row.status, "done", `done: ${row.error}`);
  ok(row.done_at, "done_at");
  eq(row.password_hash, null, "hash cleared");
  const tn = await C.getTenant("quick-queue-co", { fresh: true });
  ok(tn.dbUrl.startsWith("http://127.0.0.1:"), `the fake's database ${tn.dbUrl}`);
  const raw = await one("SELECT db_token_enc FROM tenants WHERE id = 'quick-queue-co'");
  ok(String(raw.db_token_enc).startsWith("k1:"), "encrypted at rest");
  const minted = fake.state.minted.filter((m) => m.name === "storeasy-t-quick-queue-co");
  eq(minted.at(-1).expiration, "never", "register_tenant minted a never-expiring token");
  eq(tn.dbToken, minted.at(-1).jwt, "that token is the store's");
  ok(minted.slice(0, -1).every((m) => m.expiration === "1h"), "every other token was 1 hour");
  eq(creates("storeasy-t-quick-queue-co").length, 1, "one create");
  const run = await P.getProvisionRun(row.provision_run_id);
  eq(run.params.dbDriver, "turso-api", "driver");
  ok(run.refs.dbCreateRequestedAt, "dbCreateRequestedAt saved");
  const job = await J.getJobByKey(`provision_store:${row.id}`);
  eq(job.status, "done", "job done");
  ok(!JSON.stringify(job).includes(tn.dbToken), "no token in the job");
  const user = await I.findUserByEmail(happy.f.email);
  const { membershipRole } = await import("../lib/platform/sessions.js");
  eq(await membershipRole(user.id, "quick-queue-co"), "owner", "owner");
  const c = (await import("@libsql/client")).createClient({ url: tn.dbUrl, authToken: tn.dbToken });
  ok(String((await c.execute("SELECT * FROM cms_state LIMIT 1")).rows[0] ? "yes" : ""), "schema applied");
  c.close();
});

let firstToken;
await t("status: done with four steps done and a handoff redirect; a newer poll kills the earlier token (at most one live)", async () => {
  const r = await poll(happy);
  eq(r.status, 200, r.text);
  eq(r.body.status, "done", "done");
  eq(r.body.steps.map((s) => s.label).join("|"), "Creating your store's database|Preparing your store|Registering your store address|Creating your account", "labels");
  ok(r.body.steps.every((s) => s.state === "done"), JSON.stringify(r.body.steps));
  const m = String(r.body.redirect).match(/^http:\/\/quick-queue-co\.stores\.test\/admin\/handoff#t=([0-9a-f]{64})$/);
  ok(m, r.body.redirect);
  firstToken = m[1];
  const r2 = await poll(happy);
  const second = String(r2.body.redirect).match(/#t=([0-9a-f]{64})$/)?.[1];
  ok(second && second !== firstToken, "a new token");
  eq(await count("SELECT COUNT(*) AS n FROM invitations WHERE token_hash = ?", [sha(firstToken)]), 0, "the earlier token is gone");
  eq(await count("SELECT COUNT(*) AS n FROM invitations WHERE kind = 'handoff' AND email = ? AND accepted_at IS NULL", [happy.f.email]), 1, "one live handoff");
  eq((await rowFor(happy.f.email)).handoff_invite_id, (await one("SELECT id FROM invitations WHERE token_hash = ?", [sha(second)])).id, "recorded");
  firstToken = second;
});

await t("least-trusted: the earlier poll's token is refused by the handoff route; the newest works once; then status gives loginUrl, not a token", async () => {
  const handoff = await import(pathToFileURL(join(ROOT, "app/api/admin/handoff/route.js")).href);
  const host = "quick-queue-co.stores.test";
  const call = (token) => handoff.POST(new NextRequest(`http://${host}/api/admin/handoff`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json" }, body: JSON.stringify({ token }) }));
  const r = await poll(happy);
  const newest = String(r.body.redirect).match(/#t=([0-9a-f]{64})$/)[1];
  eq((await call(firstToken)).status, 400, "the earlier token is dead");
  eq((await call(newest)).status, 200, "the newest works");
  const after = await poll(happy);
  ok(!after.body.redirect && /\/admin\/login$/.test(after.body.loginUrl), JSON.stringify(after.body));
});

await t("a done signup 30 minutes on gets loginUrl, never a new token", async () => {
  const s = await start("Late Login Co");
  await verify(s);
  await H.drainAfter();
  await db.execute({ sql: "UPDATE signups SET done_at = ? WHERE email = ?", args: [new Date(Date.now() - 31 * 60_000).toISOString(), s.f.email] });
  const r = await poll(s);
  eq(r.body.status, "done", r.text);
  ok(!r.body.redirect && r.body.loginUrl, JSON.stringify(r.body));
  eq(await count("SELECT COUNT(*) AS n FROM invitations WHERE kind = 'handoff' AND email = ?", [s.f.email]), 0, "no token made");
});

// --- the ledger: a timeout after the database was made ---------------------------------

await t("a create that times out after Turso made the database: retry after 5 s, the 409 is adopted as this run's database: one database, done", async () => {
  const s = await start("Hung Create Co");
  const keep = A.tursoApiTiming.timeoutMs;
  A.tursoApiTiming.timeoutMs = 300;
  try {
    await fault({ route: "create", commitThenHang: true, delayMs: 3000 });
    await verify(s);
    await H.drainAfter();
  } finally {
    A.tursoApiTiming.timeoutMs = keep;
  }
  let row = await rowFor(s.f.email);
  eq(row.status, "provisioning", `still provisioning: ${row.error}`);
  eq(Number(row.provision_attempts), 1, "one retry counted");
  eq(Date.parse(row.next_attempt_at) - clock.at, 5_000, "5 s");
  const run = await P.getProvisionRun(row.provision_run_id);
  ok(run.refs.dbCreateRequestedAt, "the request was recorded before the call");
  ok(!/eyJ|Bearer/.test(String(run.error)), "no secret in the run error");
  const p = await poll(s);
  eq(p.body.note, "Our hosting provider is slow to answer. Trying again in 5 seconds (try 1 of 5)", "retry note");
  eq(p.body.steps[0].state, "working", "the database step is working");
  tick(5_000);
  const p2 = await poll(s); // due: the poll runs the founder's own job
  eq(p2.body.status, "done", `done after the retry: ${p2.text}`);
  row = await rowFor(s.f.email);
  eq(fake.dbs().filter((d) => d.name === "storeasy-t-hung-create-co").length, 1, "one database");
  eq(creates("storeasy-t-hung-create-co").filter((c) => c.status === 200 || c.status === "hung").length, 1, "made once");
  eq(creates("storeasy-t-hung-create-co").filter((c) => c.status === 409).length, 1, "the second ask was the 409, adopted");
  eq(row.provision_run_id, run.id, "the same run");
  eq((await P.getProvisionRun(run.id)).refs.dbCreated, true, "the database is this run's");
});

// --- retries on a fake clock -----------------------------------------------------------

await t("retry delays: 5 s, 15 s, 45 s, 2 min, 5 min; after the fifth retry: retry_exhausted with Try again words", async () => {
  const s = await start("Flaky Cloud Co");
  await fault({ route: "create", status: 503, times: 6 });
  await verify(s);
  await H.drainAfter();
  const delays = [];
  for (let i = 0; i < 5; i++) {
    const row = await rowFor(s.f.email);
    eq(row.status, "provisioning", `try ${i + 1}`);
    delays.push((Date.parse(row.next_attempt_at) - clock.at) / 1000);
    tick(Date.parse(row.next_attempt_at) - clock.at);
    await runJob(s);
  }
  eq(delays.join(","), "5,15,45,120,300", "delays");
  const row = await rowFor(s.f.email);
  eq(row.status, "failed", "failed");
  eq(row.failure_kind, "retry_exhausted", "kind");
  const p = await poll(s);
  eq(p.body.status, "failed", "status");
  eq(p.body.error, "We couldn't finish setting up your store. Nothing you entered is lost: press Try again.", "words");
  eq(p.body.canRetry, true, "can retry");
  eq(p.body.failureKind, "retry_exhausted", "kind shown");
  ok(logged.some((l) => /"evt":"signup_provision_retry"/.test(l) && /"status":503/.test(l)), "signup_provision_retry logged with the status");
  await clearFaults();
});

await t("429 waits at least Retry-After (here 30 s instead of 5 s), capped at 10 minutes", async () => {
  const s = await start("Rate Limit Co");
  await fault({ route: "create", status: 429, retryAfter: 30 });
  await verify(s);
  await H.drainAfter();
  let row = await rowFor(s.f.email);
  eq(Date.parse(row.next_attempt_at) - clock.at, 30_000, "30 s");
  await fault({ route: "create", status: 429, retryAfter: 99_999 });
  tick(30_000);
  await runJob(s);
  row = await rowFor(s.f.email);
  eq(Date.parse(row.next_attempt_at) - clock.at, 600_000, "capped");
  await clearFaults();
  tick(600_000);
  await runJob(s);
  eq((await rowFor(s.f.email)).status, "done", "done");
});

// --- needs us ---------------------------------------------------------------------------

let paid;
await t("402 stops at once: needs_operator, the founder's words, an alert naming the signup, step and status (never a token)", async () => {
  paid = await start("Plan Limit Co");
  await fault({ route: "create", status: 402 });
  await verify(paid);
  await H.drainAfter();
  const row = await rowFor(paid.f.email);
  eq(row.status, "failed", "failed");
  eq(row.failure_kind, "needs_operator", "kind");
  eq(Number(row.provision_attempts), 0, "no retries");
  const p = await poll(paid);
  eq(p.body.error, "Something on our side needs fixing. We've been told. Press Try again in a while.", "words");
  eq(p.body.canRetry, true, "Try again offered");
  eq(p.body.steps[0].state, "failed", "the database step failed");
  const alert = logged.find((l) => l.startsWith("[ALERT") && l.includes(row.id));
  ok(alert && /create_db/.test(alert) && /402/.test(alert), `alert: ${alert}`);
  ok(!alert.includes(API_TOKEN) && !/eyJ/.test(alert), "no token in the alert");
  ok(logged.some((l) => /"evt":"signup_provision_failed"/.test(l) && /"kind":"needs_operator"/.test(l)), "signup_provision_failed logged");
});

await t("Try again resumes the same run once the fault is gone: create count 1, done", async () => {
  const before = (await rowFor(paid.f.email)).provision_run_id;
  const r = await api("signup/verify", "POST", { body: { retry: true }, cookie: paid.cookie });
  eq(r.body.status, "provisioning", r.text);
  ok(logged.some((l) => /"evt":"signup_retry"/.test(l)), "signup_retry logged");
  await H.drainAfter();
  const row = await rowFor(paid.f.email);
  eq(row.status, "done", `done: ${row.failure_kind}`);
  eq(row.provision_run_id, before, "the same run");
  eq(creates("storeasy-t-plan-limit-co").filter((c) => c.status === 200).length, 1, "one database made");
  eq(await count("SELECT COUNT(*) AS n FROM provision_runs WHERE tenant_id = 'plan-limit-co'"), 1, "one run");
});

await t("a 409 the run never asked for (someone else's database with that name) needs an operator; nothing is adopted", async () => {
  const s = await start("Taken Name Co");
  await fake.addDatabase("storeasy-t-taken-name-co");
  await verify(s);
  await H.drainAfter();
  const row = await rowFor(s.f.email);
  eq(`${row.status}:${row.failure_kind}`, "failed:needs_operator", "needs us");
  eq(await C.getTenant("taken-name-co", { fresh: true }), null, "no store registered");
  const run = await P.getProvisionRun(row.provision_run_id);
  ok(!run.refs.dbCreateRequestedAt, "a clear 409 leaves no unknown ask behind");
  // Try again: still someone else's database, still needs us, never adopted
  const r = await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie });
  eq(r.body.status, "provisioning", r.text);
  await H.drainAfter();
  const again = await rowFor(s.f.email);
  eq(`${again.status}:${again.failure_kind}`, "failed:needs_operator", "Try again still needs us");
  eq(again.provision_run_id, row.provision_run_id, "the same run");
  const run2 = await P.getProvisionRun(row.provision_run_id);
  ok(!run2.refs.dbUrl && run2.refs.dbCreated == null, `nothing adopted: ${JSON.stringify(run2.refs)}`);
  eq(creates("storeasy-t-taken-name-co").filter((c) => c.status === 409).length, 2, "two asks, two 409s");
  eq(await C.getTenant("taken-name-co", { fresh: true }), null, "still no store registered");
});

await t("a 429 after a timed-out ask keeps the unknown ask, so the next 409 is adopted (one database); a clear 4xx alone leaves none", async () => {
  const s = await start("Hung Then Busy Co");
  const keep = A.tursoApiTiming.timeoutMs;
  A.tursoApiTiming.timeoutMs = 300;
  try {
    await fault({ route: "create", commitThenHang: true, delayMs: 3000 });
    await verify(s);
    await H.drainAfter();
  } finally {
    A.tursoApiTiming.timeoutMs = keep;
  }
  let row = await rowFor(s.f.email);
  const asked = (await P.getProvisionRun(row.provision_run_id)).refs.dbCreateRequestedAt;
  ok(asked, "the timed-out ask is kept");
  await fault({ route: "create", status: 429 });
  tick(Date.parse(row.next_attempt_at) - clock.at);
  await runJob(s);
  eq((await P.getProvisionRun(row.provision_run_id)).refs.dbCreateRequestedAt, asked, "a clear 429 keeps the earlier unknown ask");
  row = await rowFor(s.f.email);
  tick(Date.parse(row.next_attempt_at) - clock.at);
  await runJob(s);
  row = await rowFor(s.f.email);
  eq(row.status, "done", `done: ${row.failure_kind}`);
  eq(fake.dbs().filter((d) => d.name === "storeasy-t-hung-then-busy-co").length, 1, "one database");
  eq((await P.getProvisionRun(row.provision_run_id)).refs.dbCreated, true, "adopted as this run's");
});

await t("the operator is alerted once per signup per failure kind: a second needs-us failure after Try again sends no second alert", async () => {
  const s = await start("Alert Once Co");
  await fault({ route: "create", status: 402 });
  await verify(s);
  await H.drainAfter();
  const row = await rowFor(s.f.email);
  eq(`${row.status}:${row.failure_kind}`, "failed:needs_operator", "needs us");
  const alerts = () => logged.filter((l) => l.startsWith("[ALERT") && l.includes(row.id)).length;
  eq(alerts(), 1, "one alert");
  eq(row.alerted_kinds, ",needs_operator,", "recorded on the signup");
  for (let i = 0; i < 2; i++) {
    await fault({ route: "create", status: 402 });
    await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie });
    await H.drainAfter();
    eq((await rowFor(s.f.email)).failure_kind, "needs_operator", `try ${i + 2} needs us`);
  }
  eq(alerts(), 1, "still one alert after two Try agains");
  await clearFaults();
});

await t("two runners racing on one signup (the first one's lease ran out mid-create): one database, one long token, the signup done and never overwritten to failed", async () => {
  const s = await start("Race Pair Co");
  const name = "storeasy-t-race-pair-co";
  await fault({ route: "create", status: 503 });
  await verify(s);
  await H.drainAfter();
  let row = await rowFor(s.f.email);
  eq(row.status, "provisioning", "waiting on a retry");
  tick(Date.parse(row.next_attempt_at) - clock.at);
  // runner A asks Turso and waits on a slow answer
  await fault({ route: "create", delayMs: 1500 });
  const first = runJob(s);
  for (let i = 0; i < 100 && !creates(name).some((c) => c.status === 0); i++) await new Promise((r) => setTimeout(r, 20));
  ok(creates(name).some((c) => c.status === 0), "runner A is waiting on Turso");
  // A's lease runs out; runner B takes the job and finishes the store
  await db.execute({ sql: "UPDATE jobs SET lease_until = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), row.job_id] });
  const second = await runJob(s);
  ok(second.ok && !second.lostLease, `runner B ran: ${JSON.stringify(second)}`);
  eq((await rowFor(s.f.email)).status, "done", "B finished");
  const a = await first;
  ok(a.lostLease, `runner A stopped on a lost lease: ${JSON.stringify(a)}`);
  row = await rowFor(s.f.email);
  eq(row.status, "done", `still done: ${row.failure_kind}`);
  eq(row.failure_kind, null, "no failure written");
  eq(fake.dbs().filter((d) => d.name === name).length, 1, "one database");
  eq(fake.state.minted.filter((m) => m.name === name && m.expiration === "never").length, 1, "one long token");
  eq((await P.getProvisionRun(row.provision_run_id)).status, "done", "the run stays done");
  eq((await one("SELECT status FROM jobs WHERE id = ?", [row.job_id])).status, "done", "the job is done");
});

await t("400 (bad group), 401 and 403 also stop at once as needs_operator", async () => {
  for (const [status, name] of [[400, "Bad Group Co"], [401, "Bad Token Co"], [403, "Forbidden Co"]]) {
    const s = await start(name);
    await fault({ route: "create", status });
    await verify(s);
    await H.drainAfter();
    const row = await rowFor(s.f.email);
    eq(`${row.status}:${row.failure_kind}:${row.provision_attempts}`, "failed:needs_operator:0", String(status));
  }
});

await t("a lapsed signup's job fails as lapsed and Try again says start again", async () => {
  const s = await start("Lapsed Shop Co");
  await fault({ route: "create", status: 503 });
  await verify(s);
  await H.drainAfter();
  await db.execute({ sql: "UPDATE signups SET password_hash = NULL, expires_at = ? WHERE email = ?", args: [new Date(Date.now() - 49 * 3600_000).toISOString(), s.f.email] });
  await clearFaults();
  await runJob(s);
  const row = await rowFor(s.f.email);
  eq(`${row.status}:${row.failure_kind}`, "failed:lapsed", "lapsed");
  const p = await poll(s);
  eq(p.body.canRetry, false, "no Try again");
  eq(p.body.error, S.SIGNUP_LAPSED, "start again");
  eq((await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie })).body.error, S.SIGNUP_LAPSED, "retry says start again");
});

// --- operator view ------------------------------------------------------------------------

await t("operator: resuming a signup run makes its job due (not run inline); the list carries the signup badge data and failure kind", async () => {
  const s = await start("Operator Fix Co");
  await fault({ route: "create", status: 402 });
  await verify(s);
  await H.drainAfter();
  const row = await rowFor(s.f.email);
  const op = { _platform: store.cookies["operator-support"]._platform };
  const list = await api("platform/provisions", "GET", { cookies: op, origin: null });
  const listed = list.body.runs.find((r) => r.id === row.provision_run_id);
  ok(listed?.signup && listed.signup.failureKind === "needs_operator", JSON.stringify(listed?.signup));
  const r = await api("platform/provisions", "POST", { body: { action: "resume", run: row.provision_run_id }, cookies: op });
  eq(r.status, 200, r.text);
  eq(r.body.queued, true, "queued");
  eq((await P.getProvisionRun(row.provision_run_id)).status, "failed", "not run inline");
  const job = await J.getJobByKey(`provision_store:${row.id}`);
  eq(job.status, "pending", "job due");
  eq(job.run_after, null, "due now");
  eq((await rowFor(s.f.email)).status, "provisioning", "signup provisioning");
  ok(await one("SELECT 1 FROM audit_log WHERE action = 'tenant.provision' AND resource = ?", [`run:${row.provision_run_id}`]), "audited");
  await H.drainAfter();
  eq((await rowFor(s.f.email)).status, "done", "done, user and owner made");
  ok(await I.findUserByEmail(s.f.email), "user");
});

// --- least-trusted (§4) ---------------------------------------------------------------------

await t("least-trusted: status with no cookie or another browser's cookie: the same generic 400", async () => {
  const none = await api("signup/status", "POST", { body: {} });
  const other = await api("signup/status", "POST", { body: {}, cookie: "f".repeat(64) });
  eq(none.status, 400, none.text);
  eq(other.status, 400, other.text);
  eq(none.text, other.text, "identical");
  eq(none.body.error, S.SIGNUP_GONE, "generic");
});

await t("least-trusted: a pending signup and an existing-email signup get identical status answers", async () => {
  const fresh = await start("Fresh Mail Co");
  const user = await I.createUser({ email: "already@sgp.test", password: "already-pass-long" });
  ok(user, "an account");
  const existing = await api("signup", "POST", { body: { name: "X", email: "already@sgp.test", password: "pass-word-xx-long", storeName: "Existing Mail Co" } });
  const a = await poll(fresh);
  const b = await poll({ cookie: cookieFrom(existing) });
  eq(a.status, b.status, "status");
  eq(a.text, b.text, "body");
});

await t("least-trusted: status cross-origin is 403; on a store host 404", async () => {
  eq((await poll(happy, { origin: "http://evil.test" })).status, 403, "cross-origin");
  eq((await poll(happy, { host: "quick-queue-co.stores.test" })).status, 404, "store host");
});

await t("least-trusted: /api/jobs/tick in production with no secret, or a wrong one, is 401", async () => {
  const keep = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const tickRoute = await import(pathToFileURL(join(ROOT, "app/api/jobs/tick/route.js")).href);
    eq((await tickRoute.POST(new NextRequest("http://storeasy.test/api/jobs/tick", { method: "POST" }))).status, 401, "no secret configured");
    process.env.CRON_SECRET = "right-secret";
    eq((await tickRoute.POST(new NextRequest("http://storeasy.test/api/jobs/tick?secret=wrong", { method: "POST" }))).status, 401, "wrong secret");
  } finally {
    delete process.env.CRON_SECRET;
    if (keep === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = keep;
  }
});

await t("least-trusted: a support member's session (and a signed-out caller) gets 401 on /api/platform/provisions", async () => {
  for (const jar of [store.cookies.support, store.cookies.owner, {}]) {
    eq((await api("platform/provisions", "GET", { cookies: jar, origin: null })).status, 401, "GET");
    eq((await api("platform/provisions", "POST", { body: { action: "resume", run: "x" }, cookies: jar })).status, 401, "POST");
  }
});

// --- jobs, guard rows -----------------------------------------------------------------------

await t("provision_store is a long job type with a handler; the status route has its guard row", async () => {
  ok(W.LONG_JOB_TYPES.includes("provision_store"), "long");
  const { SHOPPER_ROUTES } = await import("./support/shopper-routes.js");
  const row = SHOPPER_ROUTES.find((r) => r.path === "signup/status");
  ok(row && row.class === "token" && row.methods.join() === "POST" && row.suite === "test-signup-provision.js", JSON.stringify(row));
});

await t("an unexpected throw falls back to the queue's backoff (maxAttempts 3) with a scrubbed error; dead marks the signup needs_operator", async () => {
  const s = await start("Throwing Job Co");
  await verify(s);
  const row = await rowFor(s.f.email);
  const boom = async () => {
    throw new Error(`boom Bearer ${API_TOKEN} eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.c2lnbmF0dXJl`);
  };
  const handlers = { ...W.HANDLERS, provision_store: (p, ctx) => SP.withScrubbedErrors(boom)(p, ctx) };
  for (let i = 0; i < 3; i++) {
    await J.makeJobDue(row.job_id);
    await W.runJobById(row.job_id, { handlers });
  }
  const job = await J.getJobByKey(`provision_store:${row.id}`);
  eq(job.max_attempts, 3, "three tries");
  eq(job.status, "dead", "dead");
  ok(!job.last_error.includes(API_TOKEN) && !/eyJ/.test(job.last_error), job.last_error);
  const after = await rowFor(s.f.email);
  eq(`${after.status}:${after.failure_kind}`, "failed:needs_operator", "the founder sees needs us");
});

// --- secrets ----------------------------------------------------------------------------------

await t("secret sweep: the API token and every minted token appear nowhere in signups, provision_runs, jobs, audit_log, platform_mail or the logs", async () => {
  const secrets = [API_TOKEN, ...fake.state.minted.map((m) => m.jwt)];
  ok(secrets.length > 5, "tokens were minted");
  for (const table of ["signups", "provision_runs", "jobs", "audit_log", "platform_mail", "tenants"]) {
    const text = JSON.stringify(await q(`SELECT * FROM ${table}`));
    for (const s of secrets) ok(!text.includes(s), `${table} holds a secret`);
  }
  const logs = logged.join("\n");
  for (const s of secrets) ok(!logs.includes(s), "a log line holds a secret");
});

await t("no call left this machine", () => {
  eq(guard.blocked.length, 0, guard.blocked.join(", "));
});

await fake.close();
await store.cleanup();
guard.restore();
await rm(TMP, { recursive: true, force: true });
for (const ext of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `.test-sgnprov-default.db${ext}`), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
