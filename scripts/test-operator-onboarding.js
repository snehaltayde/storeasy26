// Operator onboarding suite (Phase 1 line 8, docs/plans/phase-1.md "Line 8").
// The operator's /platform/onboarding screen: one row per signup (until its
// store exists) and per store, views, search, keyset paging, the stuck filter
// on a fake clock, the detail sheet, every help action and its refusals, the
// onboarding snapshot and its sweep job, the retired hand-off route, and the
// §3 least-trusted tests (signed out, every merchant role, a merchant token in
// _platform, a non-operator's "operator" session, revoked and expired sessions,
// the bootstrap token once operators exist, cross-origin writes).
// The store databases come from the local Turso stand-in
// (scripts/support/fake-turso-api.js) behind a fetch guard: nothing leaves
// this machine.
//   pnpm test:operator-onboarding
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const { loopbackFetchGuard, startFakeTursoApi } = await import("./support/fake-turso-api.js");
const guard = loopbackFetchGuard();

// keep structured log lines out of the output (still searchable)
const logged = [];
for (const k of ["log", "error", "warn"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    logged.push(a.map(String).join(" "));
    if (!/^\{"ts"/.test(String(a[0])) && !/^\[ALERT/.test(String(a[0]))) orig(...a);
  };
}

const TMP = await mkdtemp(join(tmpdir(), "storeasy-opsonb-"));
const API_TOKEN = `fake-api-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`;
const fake = await startFakeTursoApi({ token: API_TOKEN, org: "local-fake", dataDir: TMP, backend: "file" });
process.env.DATABASE_URL = "file:.test-opsonb-default.db";
process.env.PLATFORM_SECRET = "test-operator-onboarding-secret";
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-opsonb";
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

const store = await H.makeRoleStore({ name: "opsonb" });
const C = await import("../lib/platform/control.js");
const I = await import("../lib/platform/identity.js");
const SE = await import("../lib/platform/sessions.js");
const AA = await import("../lib/platform/admin-auth.js");
const S = await import("../lib/platform/signup.js");
const SP = await import("../lib/platform/signup-provision.js");
const OPS = await import("../lib/platform/onboarding-ops.js");
const SNAP = await import("../lib/onboarding/snapshot.js");
const J = await import("../lib/platform/jobs.js");
const W = await import("../lib/platform/worker.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = C.platformDb();
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const one = async (sql, args = []) => (await q(sql, args))[0] ?? null;
const count = async (sql, args = []) => Number((await one(sql, args))?.n ?? 0);

const PLATFORM_HOST = "platform.test";
const operatorId = store.users.operator.id;
const opToken = async (userId = operatorId, ttlMs = 10 * 60_000) => (await SE.createSession({ userId, kind: "operator", ttlMs })).token;
const OP = { _platform: await opToken() };

async function api(method, { query = "", body, cookies = OP, origin } = {}) {
  const route = await import(pathToFileURL(join(ROOT, "app/api/platform/onboarding/route.js")).href);
  const headers = { host: PLATFORM_HOST };
  const o = origin === undefined ? (method === "GET" ? null : `http://${PLATFORM_HOST}`) : origin;
  if (o) headers.origin = o;
  if (cookies && Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  let reqBody;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await route[method](new NextRequest(`http://${PLATFORM_HOST}/api/platform/onboarding${query ? `?${query}` : ""}`, { method, headers, body: reqBody }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty
  }
  return { status: res.status, body: json, text, setCookie: res.headers.getSetCookie() };
}
const post = (body, opts = {}) => api("POST", { body, ...opts });

// a signup row written straight to the control plane
let sgSeq = 0;
const iso = (ms) => new Date(ms).toISOString();
async function addSignup({ status = "pending", at = Date.now(), slug, email, storeName, failureKind = null, passwordHash = "scrypt:test", expiresAt, updatedAt, tenantId = null, sends = 1, lastSentAt } = {}) {
  const n = ++sgSeq;
  const id = `sgn_${String(n).padStart(16, "0")}`;
  const s = slug || `ops-signup-${n}`;
  await db.execute({
    sql: `INSERT INTO signups (id, email, name, store_name, slug, password_hash, browser_hash, code_hash, code_expires_at, code_attempts, sends, last_sent_at,
            status, ip, created_at, updated_at, expires_at, failure_kind, tenant_id)
          VALUES (?,?,?,?,?,?,?,NULL,?,0,?,?,?,?,?,?,?,?,?)`,
    args: [id, email || `founder${n}@ops.test`, `Founder ${n}`, storeName || `Ops Store ${n}`, s, passwordHash, `bh${n}`, iso(at + 15 * 60_000), sends, lastSentAt || iso(at - 120_000), status, "10.0.0.9", iso(at), updatedAt || iso(at), expiresAt || iso(at + 24 * 3600_000), failureKind, tenantId],
  });
  return { id, slug: s, subject: `signup:${id}` };
}

// response sweep: no hashes, ip, database address or token, and no 64-hex value
const BAD_KEY = /(_hash|Hash)$|^(ip|db_url|dbUrl|db_token|dbToken|token|secrets?|password)$/;
function sweep(value, path = "") {
  if (Array.isArray(value)) return value.forEach((v, i) => sweep(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (BAD_KEY.test(k)) throw new Error(`forbidden key ${path}.${k}`);
      sweep(v, `${path}.${k}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (/\b[0-9a-f]{64}\b/.test(value)) throw new Error(`64-hex value at ${path}`);
    if (/token=/.test(value)) throw new Error(`token= in ${path}`);
  }
}
const auditCount = () => count("SELECT COUNT(*) AS n FROM audit_log");
async function oneAudit(fn, action) {
  const before = await auditCount();
  const r = await fn();
  const after = await auditCount();
  eq(after - before, 1, `${action}: audit rows written`);
  const row = await one("SELECT actor, actor_kind, action, diff FROM audit_log ORDER BY rowid DESC LIMIT 1");
  eq(row.action, action, "audit action");
  eq(row.actor, operatorId, "audit names the operator");
  eq(row.actor_kind, "operator", "actor kind");
  return { r, row };
}

const ACTION_BODIES = [
  { action: "resume", subject: "signup:sgn_x" },
  { action: "resend_code", subject: "signup:sgn_x" },
  { action: "signin_help", subject: `tenant:${store.a.id}` },
  { action: "owner_invite", subject: `tenant:${store.a.id}` },
  { action: "support_open", subject: `tenant:${store.a.id}`, reason: "a real reason", hours: 1 },
  { action: "support_revoke", subject: `tenant:${store.a.id}`, grant: "sg_x" },
  { action: "release", subject: "signup:sgn_x" },
  { action: "note", subject: `tenant:${store.a.id}`, text: "hello" },
];

// ---- data -----------------------------------------------------------------------

await t("migration 0014: onboarding_progress, operator_notes, signups.released_at/released_by and the two signup indexes", async () => {
  const cols = (tbl) => q(`PRAGMA table_info(${tbl})`).then((r) => r.map((c) => c.name));
  const p = await cols("onboarding_progress");
  for (const c of ["tenant_id", "supported", "open", "current_step", "done_count", "steps", "step_since", "step_since_exact", "checked_at", "check_error"]) ok(p.includes(c), `onboarding_progress.${c}`);
  const n = await cols("operator_notes");
  for (const c of ["id", "subject", "body", "operator_id", "created_at"]) ok(n.includes(c), `operator_notes.${c}`);
  const s = await cols("signups");
  ok(s.includes("released_at") && s.includes("released_by"), "signups released columns");
  const idx = (await q("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
  for (const i of ["idx_signups_created", "idx_signups_tenant", "idx_onboarding_progress_stuck", "idx_onboarding_progress_checked", "idx_operator_notes_subject"]) ok(idx.includes(i), i);
});

// ---- permissions (§3) --------------------------------------------------------------

await t("§3: signed out and every merchant role (owner, admin, staff, support, owner of store B) get 401 on the list, the sheet and every action", async () => {
  const callers = ["signed-out", "owner", "admin", "staff", "support", "owner-b"];
  for (const who of callers) {
    const jar = store.cookies[who] || {};
    eq((await api("GET", { cookies: jar })).status, 401, `${who} list`);
    eq((await api("GET", { cookies: jar, query: `subject=tenant:${store.a.id}` })).status, 401, `${who} sheet`);
    for (const b of ACTION_BODIES) eq((await post(b, { cookies: jar })).status, 401, `${who} ${b.action}`);
  }
});

await t("§3: a merchant session token put in _platform is refused (401)", async () => {
  const jar = { _platform: store.cookies.owner._admin };
  eq((await api("GET", { cookies: jar })).status, 401, "list");
  for (const b of ACTION_BODIES) eq((await post(b, { cookies: jar })).status, 401, b.action);
});

await t("§3: an 'operator' session for a user who isn't an operator is refused (401)", async () => {
  const jar = { _platform: await opToken(store.users.owner.id) };
  eq((await api("GET", { cookies: jar })).status, 401, "list");
  eq((await post(ACTION_BODIES[7], { cookies: jar })).status, 401, "note");
});

await t("§3: revoked and expired operator sessions are refused (401)", async () => {
  const revoked = await opToken();
  await SE.revokeSessionByToken(revoked);
  eq((await api("GET", { cookies: { _platform: revoked } })).status, 401, "revoked");
  const expired = await opToken(operatorId, 10 * 60_000);
  await db.execute({ sql: "UPDATE sessions SET expires_at = ? WHERE token_hash = ?", args: [iso(Date.now() - 1000), await SE.sha256Hex(expired)] });
  eq((await api("GET", { cookies: { _platform: expired } })).status, 401, "expired");
  eq((await post(ACTION_BODIES[7], { cookies: { _platform: expired } })).status, 401, "expired write");
});

await t("§3: the bootstrap token stops working once an operator exists; platformOperator names the bootstrap only while none does", async () => {
  const boot = await AA.platformSessionToken();
  eq((await api("GET", { cookies: { _platform: boot } })).status, 401, "bootstrap with operators");
  eq((await AA.platformOperator(boot)), null, "platformOperator(bootstrap)");
  eq((await AA.platformOperator(OP._platform))?.id, operatorId, "platformOperator(operator) is the user id");
  await db.execute("UPDATE users SET is_operator = 0 WHERE is_operator = 1");
  try {
    eq((await AA.platformOperator(boot))?.id, "bootstrap", "no operators: bootstrap");
  } finally {
    await db.execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorId] });
  }
});

await t("§3: an operator's password without the TOTP code sets no _platform cookie", async () => {
  const route = await import(pathToFileURL(join(ROOT, "app/api/platform/login/route.js")).href);
  const res = await route.POST(new NextRequest(`http://${PLATFORM_HOST}/api/platform/login`, {
    method: "POST",
    headers: { host: PLATFORM_HOST, origin: `http://${PLATFORM_HOST}`, "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify({ email: `operator@opsonb.test`, password: "operator-pass-opsonb" }),
  }));
  ok(!res.headers.getSetCookie().some((c) => c.startsWith("_platform=")), "no cookie");
});

await t("§3: a cross-origin POST is refused (403) before anything else, signed in or not", async () => {
  for (const jar of [OP, {}]) for (const b of ACTION_BODIES) eq((await post(b, { cookies: jar, origin: "http://evil.test" })).status, 403, b.action);
});

await t("an unknown action is a 400 with words", async () => {
  const r = await post({ action: "rotate_password", subject: `tenant:${store.a.id}` });
  eq(r.status, 400, "status");
  ok(/Unknown action/.test(r.body.error), "words");
});

// ---- the retired hand-off route (feature 9) ---------------------------------------------

await t("feature 9: the old operator hand-off route is gone (404: no route file), out of the guard table and the console", async () => {
  ok(!existsSync(join(ROOT, "app/api/platform/tenants/[id]/handoff")), "no route directory");
  const { SHOPPER_ROUTES } = await import("./support/shopper-routes.js");
  ok(!SHOPPER_ROUTES.some((r) => r.path.includes("tenants/[id]/handoff")), "no guard row");
  ok(SHOPPER_ROUTES.some((r) => r.path === "platform/onboarding" && r.class === "operator"), "the new route is guarded as operator");
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(ROOT, "components/platform/PlatformAdmin.js"), "utf8");
  ok(!/\/handoff|HandoffDialog|rotate_password/.test(src), "no hand-off UI");
  ok(src.includes('href="/platform/onboarding"'), "nav link");
});

// ---- list, views, search, paging ----------------------------------------------------------

const NOW = Date.now();
await t("one row per subject: a signup without a store has its own row; every store has a row; a signup whose store exists is carried by the store", async () => {
  const pending = await addSignup({ status: "pending", at: NOW - 60_000 });
  const carried = await addSignup({ status: "done", at: NOW - 3600_000, slug: store.b.id, tenantId: store.b.id, email: "founder-b@ops.test" });
  const r = await api("GET", { query: "view=all" });
  eq(r.status, 200, r.text);
  sweep(r.body);
  const subjects = r.body.rows.map((x) => x.subject);
  ok(subjects.includes(pending.subject), "pending signup row");
  ok(!subjects.includes(carried.subject), "done signup is not its own row");
  ok(subjects.includes(`tenant:${store.a.id}`) && subjects.includes(`tenant:${store.b.id}`), "both stores");
  eq(new Set(subjects).size, subjects.length, "no duplicates");
  const b = r.body.rows.find((x) => x.subject === `tenant:${store.b.id}`);
  ok(/owner@/.test(b.who.owners), "store row names its owners");
  eq(r.body.rows.find((x) => x.subject === pending.subject).status, "waiting_code", "status code");
});

await t("views: In signup, Lapsed or freed, Closed and Open hold the right rows, with a count on each view", async () => {
  const failed = await addSignup({ status: "failed", failureKind: "needs_operator", at: NOW - 600_000 });
  const lapsed = await addSignup({ status: "failed", failureKind: "lapsed", at: NOW - 3 * 86400_000, expiresAt: iso(NOW - 2 * 86400_000) });
  const superseded = await addSignup({ status: "superseded", at: NOW - 7200_000 });
  const views = {};
  for (const v of OPS.VIEWS) views[v] = (await api("GET", { query: `view=${v}` })).body;
  const has = (v, s) => views[v].rows.some((x) => x.subject === s.subject);
  ok(has("signup", failed) && !has("signup", lapsed) && !has("signup", superseded), "in signup");
  ok(has("lapsed", lapsed) && has("lapsed", superseded) && !has("lapsed", failed), "lapsed or freed");
  ok(has("attention", failed) && !has("attention", lapsed), "needs attention: the failed one, not the lapsed one");
  ok(views.closed.rows.every((x) => x.kind === "tenant"), "closed: stores only");
  for (const v of OPS.VIEWS) eq(views.all.counts[v], views[v].rows.length, `count for ${v}`);
  eq(views.all.rows.find((x) => x.subject === failed.subject).status, "failed_needs_us", "failed words code");
  eq(views.all.rows.find((x) => x.subject === lapsed.subject).status, "failed_lapsed", "lapsed code");
});

await t("search: text with @ is an exact email match (signup or owner); other text matches store name, address or founder name", async () => {
  await addSignup({ status: "pending", email: "exact.match@ops.test", storeName: "Mango Lassi Co", slug: "mango-lassi" });
  const byEmail = (await api("GET", { query: `view=all&q=${encodeURIComponent("Exact.Match@ops.test")}` })).body.rows;
  eq(byEmail.length, 1, "one exact email");
  eq((await api("GET", { query: `view=all&q=${encodeURIComponent("exact.match@ops")}` })).body.rows.length, 0, "no partial email match");
  const owner = (await api("GET", { query: `view=all&q=${encodeURIComponent(`owner@${store.a.id}.test`)}` })).body.rows;
  ok(owner.some((x) => x.subject === `tenant:${store.a.id}`), "an owner's email finds the store");
  eq((await api("GET", { query: "view=all&q=lassi" })).body.rows.length, 1, "store name substring");
  eq((await api("GET", { query: "view=all&q=mango-la" })).body.rows.length, 1, "address substring");
  ok((await api("GET", { query: `view=all&q=${encodeURIComponent("100%")}` })).body.rows.length === 0, "LIKE wildcards are literal");
});

await t("paging: 50 rows a page with keyset cursors, no duplicates and nothing missed, in both sorts", async () => {
  for (let i = 0; i < 70; i++) await addSignup({ status: "pending", at: NOW - 86400_000 + i * 1000, storeName: `Paged ${i}` });
  for (const sort of ["newest", "stuck"]) {
    const seen = [];
    let cursor = null;
    let pages = 0;
    let total = 0;
    do {
      const r = (await api("GET", { query: `view=all&sort=${sort}${cursor ? `&cursor=${cursor}` : ""}` })).body;
      ok(r.rows.length <= 50, "page size");
      seen.push(...r.rows.map((x) => x.subject));
      total = r.counts.all;
      cursor = r.next;
      pages++;
    } while (cursor && pages < 10);
    eq(new Set(seen).size, seen.length, `${sort}: no duplicates`);
    eq(seen.length, total, `${sort}: every row once`);
    ok(pages >= 2, "more than one page");
  }
  const newest = (await api("GET", { query: "view=all&sort=newest" })).body.rows;
  ok(newest[0].createdAt >= newest[1].createdAt, "newest first");
});

await t("the stuck filter on a fake clock: a signup setting up for 2 h shows at 1 h, not at 6 h, until the clock moves on", async () => {
  const real = OPS.opsClock.now;
  const s = await addSignup({ status: "provisioning", at: NOW - 2 * 3600_000, updatedAt: iso(NOW - 2 * 3600_000) });
  OPS.opsClock.now = () => NOW;
  try {
    const at = async (h) => (await api("GET", { query: `view=attention&stuck=${h}` })).body.rows.some((x) => x.subject === s.subject);
    ok(await at(1), "stuck 1 h");
    ok(!(await at(6)), "not stuck 6 h");
    OPS.opsClock.now = () => NOW + 5 * 3600_000;
    ok(await at(6), "7 h later: stuck 6 h");
    ok(!(await at(24)), "not stuck 24 h");
    const def = (await api("GET")).body;
    eq(def.params.view, "attention", "default view");
    eq(def.params.stuckHours, 24, "default stuck");
  } finally {
    OPS.opsClock.now = real;
  }
});

// ---- the detail sheet -----------------------------------------------------------------------

await t("the store sheet: live steps (and the snapshot updated), owners, pending invites without tokens, mail without bodies, grants, notes, audit", async () => {
  await I.createInvite({ email: "pending-admin@ops.test", tenantId: store.a.id, role: "admin" });
  const r = await api("GET", { query: `subject=tenant:${store.a.id}` });
  eq(r.status, 200, r.text);
  sweep(r.body);
  const b = r.body;
  ok(Array.isArray(b.onboarding.steps) && b.onboarding.steps.length === 4, "four live steps");
  ok(await one("SELECT checked_at FROM onboarding_progress WHERE tenant_id = ?", [store.a.id]), "snapshot row written");
  ok(b.members.some((m) => m.role === "owner"), "owners");
  ok(b.invites.some((i) => i.email === "pending-admin@ops.test" && i.expiresAt), "pending invite");
  ok(b.invites.every((i) => Object.keys(i).sort().join() === "email,expiresAt,role"), "invite keys");
  ok(b.grants.length >= 1, "grants");
  eq(b.actions.signinHelp, true, "sign-in help applies");
  eq(b.actions.ownerInvite, false, "owner invite does not apply (owners exist)");
});

await t("the signup sheet: facts, scrubbed run steps, mail history without bodies, and actions that apply", async () => {
  const s = await addSignup({ status: "pending" });
  await db.execute({ sql: "INSERT INTO platform_mail (id, kind, recipient, subject, body, status, ref, created_at) VALUES (?, 'signup_code', 'x@ops.test', 'code', 'Your code is 123456', 'mock', ?, ?)", args: [`pml_${s.id.slice(-8)}`, s.id, iso(NOW)] });
  const r = await api("GET", { query: `subject=${s.subject}` });
  eq(r.status, 200, r.text);
  sweep(r.body);
  ok(!r.text.includes("123456"), "no mail body");
  eq(r.body.mail.length, 1, "mail row");
  eq(r.body.actions.resendCode, true, "resend applies");
  eq(r.body.actions.release, false, "release does not");
  eq((await api("GET", { query: "subject=bogus" })).status, 400, "bad subject");
  eq((await api("GET", { query: "subject=signup:sgn_nope" })).status, 404, "missing signup");
});

// ---- help actions ----------------------------------------------------------------------------

await t("resend the email code: same gap and limit, audited once, words say it works only in the founder's browser", async () => {
  const s = await addSignup({ status: "pending", lastSentAt: iso(Date.now() - 120_000) });
  const { r } = await oneAudit(() => post({ action: "resend_code", subject: s.subject }), "signup.code_resent");
  eq(r.status, 200, r.text);
  ok(/browser/.test(r.body.note), "words");
  const again = await post({ action: "resend_code", subject: s.subject });
  eq(again.status, 429, "60 s gap");
  const maxed = await addSignup({ status: "pending", sends: S.MAX_SENDS });
  eq((await post({ action: "resend_code", subject: maxed.subject })).status, 429, "send limit");
  const failed = await addSignup({ status: "failed", failureKind: "needs_operator" });
  eq((await post({ action: "resend_code", subject: failed.subject })).status, 409, "not waiting for a code");
});

let resumed;
await t("resume provisioning: a failed signup's job is queued and run; the store is made and then shows as a store row on step 1 with a stuck time", async () => {
  resumed = await addSignup({ status: "failed", failureKind: "needs_operator", passwordHash: await I.hashPassword("resume-pass-long-1"), slug: "resumed-store", email: "resumed@ops.test", storeName: "Resumed Store" });
  const { r } = await oneAudit(() => post({ action: "resume", subject: resumed.subject }), "tenant.provision");
  eq(r.status, 200, r.text);
  eq(r.body.queued, true, "queued");
  ok(!("jobId" in r.body), "the job id stays on the server");
  const row = await one("SELECT job_id, status FROM signups WHERE id = ?", [resumed.id]);
  eq(row.status, "provisioning", "claimed");
  await H.drainAfter();
  const done = await one("SELECT status FROM signups WHERE id = ?", [resumed.id]);
  if (done.status !== "done") {
    await J.makeJobDue(row.job_id);
    await W.runJobById(row.job_id, { budgetMs: 50_000 });
  }
  eq((await one("SELECT status FROM signups WHERE id = ?", [resumed.id])).status, "done", "signup done");
  ok(await C.getTenant("resumed-store", { fresh: true }), "store registered");
  const list = (await api("GET", { query: "view=all&q=resumed" })).body.rows;
  eq(list.length, 1, "one row");
  eq(list[0].subject, "tenant:resumed-store", "the store carries it");
  const sheet = (await api("GET", { query: "subject=tenant:resumed-store" })).body;
  eq(sheet.onboarding.current, "connect", "step 1");
  const p = await one("SELECT current_step, step_since, step_since_exact FROM onboarding_progress WHERE tenant_id = 'resumed-store'");
  const created = (await one("SELECT created_at FROM tenants WHERE id = 'resumed-store'")).created_at;
  eq(p.step_since, created, "step 1 since the store was made");
  eq(Number(p.step_since_exact), 1, "exact");
  const again = await post({ action: "resume", subject: resumed.subject });
  eq(again.status, 409, "done: refused");
  ok(/already done/.test(again.body.error), "words");
});

await t("resume refusals: a lapsed signup, one still waiting for its code", async () => {
  const lapsed = await addSignup({ status: "failed", failureKind: "lapsed" });
  const r = await post({ action: "resume", subject: lapsed.subject });
  eq(r.status, 409, "lapsed");
  ok(/lapsed/.test(r.body.error) && /Free its address/.test(r.body.error), "says what to do");
  const pending = await addSignup({ status: "pending" });
  ok(/Resend the email code/.test((await post({ action: "resume", subject: pending.subject })).body.error), "pending");
  eq((await post({ action: "resume", subject: `tenant:${store.a.id}` })).status, 409, "a store with nothing failed");
});

await t("sign-in help: mails the store's login and a one-hour single-use reset link to an owner on file; never returns a token or link; a 'to' in the body is ignored", async () => {
  const ownerEmail = `owner@${store.a.id}.test`;
  const { r } = await oneAudit(() => post({ action: "signin_help", subject: `tenant:${store.a.id}`, email: ownerEmail, to: "attacker@evil.test" }), "founder.signin_help_sent");
  eq(r.status, 200, r.text);
  sweep(r.body);
  ok(!/token|http/.test(r.text), "no token or link in the answer");
  eq(r.body.sentTo, ownerEmail, "to the owner");
  eq(await count("SELECT COUNT(*) AS n FROM platform_mail WHERE recipient = 'attacker@evil.test'"), 0, "nothing to the body's address");
  const mail = await one("SELECT body, ref FROM platform_mail WHERE kind = 'operator_signin_help' ORDER BY rowid DESC LIMIT 1");
  eq(mail.ref, `tenant:${store.a.id}`, "ref");
  ok(mail.body.includes(`/admin/login`), "login address");
  const token = mail.body.match(/\/admin\/reset\?token=([0-9a-f]{64})/)?.[1];
  ok(token, "reset link");
  const inv = await one("SELECT expires_at, created_at, kind FROM invitations WHERE token_hash = ?", [await SE.sha256Hex(token)]);
  eq(inv.kind, "reset", "reset kind");
  eq(Date.parse(inv.expires_at) - Date.parse(inv.created_at), 3600_000, "one hour");
  ok(await I.acceptReset({ token, password: "a-new-pass-word-1" }), "the link works");
  eq(await I.acceptReset({ token, password: "a-new-pass-word-2" }), null, "single use");
  const diff = (await one("SELECT diff FROM audit_log WHERE action = 'founder.signin_help_sent' ORDER BY rowid DESC LIMIT 1")).diff;
  ok(!diff.includes("@"), "no email in the audit diff");
  eq((await post({ action: "signin_help", subject: `tenant:${store.a.id}`, email: "attacker@evil.test" })).status, 400, "a non-owner address is refused");
  eq((await post({ action: "signin_help", subject: resumed ? resumed.subject : "signup:x" })).status, 400, "a signup subject is refused");
});

await t("help emails are throttled to 5 per store per hour, with words", async () => {
  const ownerEmail = `owner@${store.b.id}.test`;
  for (let i = 0; i < 5; i++) eq((await post({ action: "signin_help", subject: `tenant:${store.b.id}`, email: ownerEmail })).status, 200, `send ${i + 1}`);
  const r = await post({ action: "signin_help", subject: `tenant:${store.b.id}`, email: ownerEmail });
  eq(r.status, 429, "sixth");
  ok(/Wait an hour/.test(r.body.error), "words");
});

await t("owner invite: a store with no owner gets a 7-day invite to the founder's email on file; earlier unused owner invites expire; no token returned", async () => {
  // resumed-store's owner membership goes, so it has none
  await db.execute("DELETE FROM memberships WHERE tenant_id = 'resumed-store'");
  const earlier = await I.createInvite({ email: "resumed@ops.test", tenantId: "resumed-store", role: "owner" });
  const { r } = await oneAudit(() => post({ action: "owner_invite", subject: "tenant:resumed-store", email: "attacker@evil.test" }), "team.invite_created");
  eq(r.status, 200, r.text);
  ok(!/token|http/.test(r.text), "no token or link");
  eq(r.body.sentTo, "resumed@ops.test", "the email on file");
  const old = await one("SELECT expires_at FROM invitations WHERE id = ?", [earlier.id]);
  ok(Date.parse(old.expires_at) <= Date.now(), "earlier invite expired");
  const mail = await one("SELECT body, recipient FROM platform_mail WHERE kind = 'operator_owner_invite' ORDER BY rowid DESC LIMIT 1");
  eq(mail.recipient, "resumed@ops.test", "recipient");
  const token = mail.body.match(/accept-invite\?token=([0-9a-f]{64})/)?.[1];
  const inv = await one("SELECT role, expires_at, created_at FROM invitations WHERE token_hash = ?", [await SE.sha256Hex(token)]);
  eq(inv.role, "owner", "role");
  eq(Date.parse(inv.expires_at) - Date.parse(inv.created_at), 7 * 86400_000, "7 days");
  const diff = JSON.parse((await one("SELECT diff FROM audit_log WHERE action = 'team.invite_created' ORDER BY rowid DESC LIMIT 1")).diff);
  eq(diff.via, "operator-onboarding", "via");
  eq((await post({ action: "owner_invite", subject: `tenant:${store.a.id}` })).status, 409, "a store with an owner: refused");
});

await t("support access: reason of 5+ characters and 1–72 hours; opens a grant naming the operator, lists it on the row; revoke closes it; each audited once", async () => {
  eq((await post({ action: "support_open", subject: `tenant:${store.b.id}`, reason: "hey", hours: 4 })).status, 400, "short reason");
  eq((await post({ action: "support_open", subject: `tenant:${store.b.id}`, reason: "a good reason", hours: 73 })).status, 400, "73 hours");
  eq((await post({ action: "support_open", subject: `tenant:${store.b.id}`, reason: "a good reason", hours: 0 })).status, 400, "0 hours");
  const { r } = await oneAudit(() => post({ action: "support_open", subject: `tenant:${store.b.id}`, reason: "checking the import", hours: 2 }), "support.grant_created");
  eq(r.status, 200, r.text);
  ok(r.body.consoleUrl.endsWith("/admin"), "console link");
  const g = await one("SELECT operator FROM support_grants WHERE id = ?", [r.body.grant.id]);
  eq(g.operator, operatorId, "grant names the operator");
  const row = (await api("GET", { query: `view=all&q=${store.b.id}` })).body.rows.find((x) => x.subject === `tenant:${store.b.id}`);
  ok(row.supportUntil, "support access open until");
  eq((await post({ action: "support_revoke", subject: `tenant:${store.a.id}`, grant: r.body.grant.id })).status, 409, "another store's grant is not this one's");
  const { r: rv } = await oneAudit(() => post({ action: "support_revoke", subject: `tenant:${store.b.id}`, grant: r.body.grant.id }), "support.grant_revoked");
  eq(rv.status, 200, rv.text);
});

await t("add a note: 1–1000 characters, append-only, with the operator and time; shows on the row; the text never reaches an audit diff", async () => {
  eq((await post({ action: "note", subject: `tenant:${store.a.id}`, text: "" })).status, 400, "empty");
  eq((await post({ action: "note", subject: `tenant:${store.a.id}`, text: "x".repeat(1001) })).status, 400, "too long");
  const secretish = "Founder said call back Tuesday re: sync";
  const { r, row } = await oneAudit(() => post({ action: "note", subject: `tenant:${store.a.id}`, text: secretish }), "operator.note_added");
  eq(r.status, 200, r.text);
  ok(!row.diff.includes("Tuesday"), "no note text in the diff");
  eq(JSON.parse(row.diff).chars, secretish.length, "chars");
  const listRow = (await api("GET", { query: `view=all&q=${store.a.id}` })).body.rows.find((x) => x.subject === `tenant:${store.a.id}`);
  eq(listRow.note.text, secretish, "latest note on the row");
  const n = await one("SELECT operator_id FROM operator_notes WHERE subject = ? ORDER BY rowid DESC LIMIT 1", [`tenant:${store.a.id}`]);
  eq(n.operator_id, operatorId, "operator");
  eq((await post({ action: "note", subject: "signup:sgn_gone", text: "x" })).status, 404, "missing subject");
});

await t("free a lapsed address: refused when not lapsed, still provisioning, a store uses it, its database still exists, or it can't be checked; then slugAvailable is ok", async () => {
  const notLapsed = await addSignup({ status: "failed", failureKind: "needs_operator" });
  ok(/hasn't lapsed/.test((await post({ action: "release", subject: notLapsed.subject })).body.error), "not lapsed");
  const prov = await addSignup({ status: "provisioning", expiresAt: iso(Date.now() - 3 * 86400_000) });
  ok(/still being set up/.test((await post({ action: "release", subject: prov.subject })).body.error), "provisioning");
  // a store already uses the address: a done signup's store (lapsed signup rows are not unique by slug once failed? use a store id)
  const taken = await addSignup({ status: "superseded", slug: store.a.id });
  await db.execute({ sql: "UPDATE signups SET status = 'failed', failure_kind = 'lapsed' WHERE id = ?", args: [taken.id] });
  ok(/A store uses/.test((await post({ action: "release", subject: taken.subject })).body.error), "store uses it");
  // a database the run made still exists at the provider
  const withDb = await addSignup({ status: "failed", failureKind: "lapsed", slug: "lapsed-with-db" });
  await db.execute({ sql: "INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, created_at, updated_at) VALUES ('prov_lapsedwithdb', 'lapsed-with-db', 'failed', '[]', ?, ?, ?, ?)", args: [JSON.stringify({ dbUrl: "http://127.0.0.1:1/x", dbCreated: true }), JSON.stringify({ dbDriver: "turso-api", source: "signup" }), iso(NOW), iso(NOW)] });
  await fake.addDatabase("storeasy-t-lapsed-with-db");
  ok(/still exists at the hosting provider/.test((await post({ action: "release", subject: withDb.subject })).body.error), "database exists");
  // the provider can't answer
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ route: "get", status: 500, times: 1 }) });
  const cant = await post({ action: "release", subject: withDb.subject });
  eq(cant.status, 503, "can't check");
  ok(/couldn't check/.test(cant.body.error), "words");
  // the CLI driver can't be checked at all
  const cli = await addSignup({ status: "failed", failureKind: "lapsed", slug: "lapsed-cli" });
  await db.execute({ sql: "INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, created_at, updated_at) VALUES ('prov_lapsedcli', 'lapsed-cli', 'failed', '[]', ?, ?, ?, ?)", args: [JSON.stringify({ dbUrl: "libsql://x", dbCreated: true }), JSON.stringify({ dbDriver: "turso" }), iso(NOW), iso(NOW)] });
  eq((await post({ action: "release", subject: cli.subject })).status, 503, "CLI driver");
  // a file database that is still on disk, then gone
  const file = await addSignup({ status: "failed", failureKind: "lapsed", slug: "lapsed-file" });
  const path = join(TMP, "lapsed-file.db");
  await writeFile(path, "");
  await db.execute({ sql: "INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, created_at, updated_at) VALUES ('prov_lapsedfile', 'lapsed-file', 'failed', '[]', ?, ?, ?, ?)", args: [JSON.stringify({ dbUrl: `file:${path}`, dbCreated: true }), JSON.stringify({ dbDriver: "file" }), iso(NOW), iso(NOW)] });
  ok(/file still exists/.test((await post({ action: "release", subject: file.subject })).body.error), "file exists");
  await rm(path);
  const { r: freedFile, row: fileAudit } = await oneAudit(() => post({ action: "release", subject: file.subject }), "signup.address_released");
  eq(freedFile.status, 200, freedFile.text);
  eq(JSON.parse(fileAudit.diff).db, "absent", "db absent");
  // no database ever: freed, with the founder told
  const none = await addSignup({ status: "failed", failureKind: "lapsed", slug: "lapsed-none", email: "lapsed-none@ops.test" });
  eq((await S.slugAvailable("lapsed-none")).ok, false, "held before");
  const { r, row } = await oneAudit(() => post({ action: "release", subject: none.subject, notify: true }), "signup.address_released");
  eq(r.status, 200, r.text);
  eq(r.body.notified, true, "notified");
  const d = JSON.parse(row.diff);
  eq(d.slug, "lapsed-none", "slug");
  eq(d.db, "none", "db none");
  ok(!row.diff.includes("@"), "no email in the diff");
  eq((await S.slugAvailable("lapsed-none")).ok, true, "free afterwards");
  const s = await one("SELECT status, released_by, released_at, password_hash FROM signups WHERE id = ?", [none.id]);
  eq(s.status, "released", "status");
  eq(s.released_by, operatorId, "by");
  ok(s.released_at && s.password_hash === null, "released_at; password hash dropped");
  eq(await count("SELECT COUNT(*) AS n FROM platform_mail WHERE kind = 'operator_start_again' AND recipient = 'lapsed-none@ops.test'"), 1, "start-again mail");
  ok(/already free/.test((await post({ action: "release", subject: none.subject })).body.error), "twice: refused");
  const lapsedView = (await api("GET", { query: "view=lapsed" })).body.rows.find((x) => x.subject === none.subject);
  eq(lapsedView.status, "address_freed", "shows as address freed");
});

// ---- snapshot and sweep ---------------------------------------------------------------------------

await t("snapshot: step_since holds while the step and state hold and moves when they change; a failed read keeps the steps and records the error", async () => {
  const tenant = await C.getTenant(store.a.id, { fresh: true });
  await db.execute({ sql: "DELETE FROM onboarding_progress WHERE tenant_id = ?", args: [tenant.id] });
  const first = await SNAP.snapshotTenant(tenant, { now: NOW });
  ok(first.ok, "first ok");
  const p1 = await one("SELECT * FROM onboarding_progress WHERE tenant_id = ?", [tenant.id]);
  const second = await SNAP.snapshotTenant(tenant, { now: NOW + 3600_000 });
  ok(second.ok, "second ok");
  const p2 = await one("SELECT * FROM onboarding_progress WHERE tenant_id = ?", [tenant.id]);
  eq(p2.step_since, p1.step_since, "unchanged step keeps its time");
  eq(p2.checked_at, iso(NOW + 3600_000), "checked again");
  ok(!/"facts"|"actions"|"words"/.test(p2.steps), "compact steps only");
  // a change of state moves it
  await db.execute({ sql: "UPDATE onboarding_progress SET steps = '[]', current_step = 'brand' WHERE tenant_id = ?", args: [tenant.id] });
  await SNAP.snapshotTenant(tenant, { now: NOW + 7200_000 });
  const p3 = await one("SELECT * FROM onboarding_progress WHERE tenant_id = ?", [tenant.id]);
  eq(p3.step_since, iso(NOW + 7200_000), "changed: since now");
  const realRead = SNAP.snapshotReader.read;
  SNAP.snapshotReader.read = async () => {
    throw new Error("store database unreachable");
  };
  let bad;
  try {
    bad = await SNAP.snapshotTenant(tenant, { now: NOW + 9000_000 });
  } finally {
    SNAP.snapshotReader.read = realRead;
  }
  eq(bad.ok, false, "failed read");
  const p4 = await one("SELECT * FROM onboarding_progress WHERE tenant_id = ?", [tenant.id]);
  ok(p4.check_error, "error recorded");
  eq(p4.steps, p3.steps, "steps kept");
  const row = (await api("GET", { query: `view=all&q=${tenant.id}` })).body.rows.find((x) => x.subject === `tenant:${tenant.id}`);
  ok(row.onboarding?.problem, "the row shows the problem");
  await SNAP.snapshotTenant(tenant, { now: NOW + 9500_000 });
});

await t("sweep: never-checked stores first, then closed ones not checked for 30 min; open ones wait a day; queueOnboardingSweep makes one job per 10-minute window", async () => {
  await db.execute("DELETE FROM onboarding_progress");
  const r1 = await SNAP.sweepOnboarding({ limit: 10, now: () => NOW });
  const active = await count("SELECT COUNT(*) AS n FROM tenants WHERE status = 'active'");
  eq(r1.checked, active, "every never-checked store");
  const r2 = await SNAP.sweepOnboarding({ limit: 10, now: () => NOW + 60_000 });
  eq(r2.checked, 0, "nothing due a minute later");
  const r3 = await SNAP.sweepOnboarding({ limit: 10, now: () => NOW + 31 * 60_000 });
  eq(r3.checked, await count("SELECT COUNT(*) AS n FROM onboarding_progress WHERE COALESCE(open, 0) != 1"), "closed ones after 30 min");
  const deadline = await SNAP.sweepOnboarding({ limit: 10, deadline: NOW + 1000, now: () => NOW + 62 * 60_000 });
  eq(deadline.checked, 0, "stops when a store's cap no longer fits the deadline");
  const a = await SNAP.queueOnboardingSweep(NOW - (NOW % SNAP.SWEEP_WINDOW_MS) + 1000);
  const b = await SNAP.queueOnboardingSweep(NOW - (NOW % SNAP.SWEEP_WINDOW_MS) + 5 * 60_000);
  const c = await SNAP.queueOnboardingSweep(NOW - (NOW % SNAP.SWEEP_WINDOW_MS) + 11 * 60_000);
  eq(b.id, a.id, "same window: one job");
  eq(b.existed, true, "deduplicated");
  ok(c.id !== a.id, "next window: a new job");
  ok(W.LONG_JOB_TYPES.includes("onboarding_sweep"), "a long job");
  const ran = await W.runJobById(a.id, { budgetMs: 50_000 });
  eq(ran.ok, true, "the worker runs it");
  ok("checked" in ran.result, "sweep result");
});

await t("the tick queues the sweep", async () => {
  process.env.CRON_SECRET = "tick-secret-opsonb";
  try {
    await db.execute("DELETE FROM jobs WHERE type = 'onboarding_sweep'");
    const route = await import(pathToFileURL(join(ROOT, "app/api/jobs/tick/route.js")).href);
    const res = await route.GET(new NextRequest(`http://${PLATFORM_HOST}/api/jobs/tick?secret=tick-secret-opsonb&limit=0`, { headers: { host: PLATFORM_HOST, authorization: "Bearer tick-secret-opsonb" } }));
    ok(res.status === 200, `tick ${res.status}`);
    ok((await count("SELECT COUNT(*) AS n FROM jobs WHERE type = 'onboarding_sweep'")) >= 1, "queued");
  } finally {
    delete process.env.CRON_SECRET;
  }
});

// ---- words (WP-B) ---------------------------------------------------------------------------------

await t("onboardingWords: every status code has plain words and a tone; stuck time reads '2 d 4 h'; 'at least' when not exact", async () => {
  const Wd = await import("../components/platform/onboarding/onboardingWords.js");
  for (const code of ["waiting_code", "has_account", "setting_up", "failed_retries", "failed_needs_us", "failed_lapsed", "address_freed", "superseded", "expired", "closed", "open", "suspended"]) {
    const w = Wd.statusWords(code);
    ok(w.label && !/_/.test(w.label), `${code} label`);
    ok(["success", "warning", "danger", "info", "muted"].includes(w.tone), `${code} tone`);
  }
  eq(Wd.stuckFor(iso(NOW - (2 * 86400_000 + 4 * 3600_000 + 60_000)), NOW), "2 d 4 h", "days and hours");
  eq(Wd.stuckFor(iso(NOW - 5 * 60_000), NOW), "5 min", "minutes");
  eq(Wd.stuckLabel({ since: iso(NOW - 3 * 3600_000), sinceExact: false }, NOW), "stuck at least 3 h", "at least");
  eq(Wd.stuckLabel({ since: iso(NOW - 3 * 3600_000), sinceExact: true }, NOW), "stuck 3 h", "exact");
});

// ---- the whole suite's sweep -------------------------------------------------------------------------

await t("no call left this machine, and no log line holds a token", async () => {
  eq(guard.blocked.length, 0, `blocked: ${guard.blocked.join(", ")}`);
  // (the local mock mailer prints a mock mail's body; structured log lines never hold one)
  ok(!logged.filter((l) => l.startsWith('{"ts"')).some((l) => /token=|[0-9a-f]{64}/.test(l)), "no token in structured logs");
});

await fake.close();
guard.restore?.();
await store.cleanup?.();
await rm(TMP, { recursive: true, force: true });
for (const ext of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `.test-opsonb-default.db${ext}`), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
