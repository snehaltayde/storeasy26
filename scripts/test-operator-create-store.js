// Operator create-store suite (Phase 1 line 9, docs/plans/phase-1.md "Line 9").
// An operator creates a store for a founder in one form: /api/platform/stores
// (live checks, create, progress), the provision_store job's operator branch
// (shop and app credentials, the owner invite instead of a user, the secret
// cleared once done), the accept page for new and existing accounts, Resend
// through line 8's owner_invite, line 8's Resume and rows that never lapse, the
// retired POST /api/platform/tenants, and the §3 least-trusted tests.
// The store databases come from the local Turso stand-in
// (scripts/support/fake-turso-api.js) behind a fetch guard: nothing leaves
// this machine.
//   pnpm test:operator-create-store
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const { loopbackFetchGuard, startFakeTursoApi } = await import("./support/fake-turso-api.js");
const guard = loopbackFetchGuard();

const logged = [];
for (const k of ["log", "error", "warn"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    logged.push(a.map(String).join(" "));
    if (!/^\{"ts"/.test(String(a[0])) && !/^\[ALERT/.test(String(a[0])) && !/mock mail|\[mail/i.test(String(a[0]))) orig(...a);
  };
}

const TMP = await mkdtemp(join(tmpdir(), "storeasy-opcreate-"));
const API_TOKEN = `fake-api-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`;
const fake = await startFakeTursoApi({ token: API_TOKEN, org: "local-fake", dataDir: TMP, backend: "file" });
process.env.DATABASE_URL = "file:.test-opcreate-default.db";
process.env.PLATFORM_SECRET = "test-operator-create-store-secret";
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-opcreate";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "storeasy.test";
process.env.SIGNUP_STORE_DOMAIN = "stores.test";
process.env.TURSO_API_URL = fake.url;
process.env.TURSO_API_TOKEN = API_TOKEN;
process.env.TURSO_ORG = "local-fake";
process.env.TURSO_GROUP = "default";
process.env.RATE_LIMIT_DISABLED = "1";
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

const store = await H.makeRoleStore({ name: "opcreate" });
const C = await import("../lib/platform/control.js");
const I = await import("../lib/platform/identity.js");
const SE = await import("../lib/platform/sessions.js");
const AA = await import("../lib/platform/admin-auth.js");
const SP = await import("../lib/platform/signup-provision.js");
const OS = await import("../lib/platform/operator-stores.js");
const OPS = await import("../lib/platform/onboarding-ops.js");
const S = await import("../lib/platform/signup.js");
const W = await import("../components/platform/stores/createStoreWords.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = C.platformDb();
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const one = async (sql, args = []) => (await q(sql, args))[0] ?? null;
const count = async (sql, args = []) => Number((await one(sql, args))?.n ?? 0);
const iso = (ms) => new Date(ms).toISOString();

const clock = { at: Date.now() };
SP.signupClock.now = () => clock.at;
const fault = (f) => fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify(f) });
const clearFaults = () => fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });

const PLATFORM_HOST = "platform.test";
const operatorId = store.users.operator.id;
const opToken = async (userId = operatorId, ttlMs = 10 * 60_000) => (await SE.createSession({ userId, kind: "operator", ttlMs })).token;
const OP = { _platform: await opToken() };

async function platformCall(path, method, { query = "", body, cookies = OP, origin } = {}) {
  const route = await import(pathToFileURL(join(ROOT, `app/api/platform/${path}/route.js`)).href);
  if (typeof route[method] !== "function") return { status: 405, body: null, text: "" };
  const headers = { host: PLATFORM_HOST };
  const o = origin === undefined ? (method === "GET" ? null : `http://${PLATFORM_HOST}`) : origin;
  if (o) headers.origin = o;
  if (cookies && Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  let reqBody;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await route[method](new NextRequest(`http://${PLATFORM_HOST}/api/platform/${path}${query ? `?${query}` : ""}`, { method, headers, body: reqBody }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty
  }
  return { status: res.status, body: json, text, headers: res.headers };
}
const stores = (method, opts) => platformCall("stores", method, opts);
const create = (body, opts = {}) => stores("POST", { body, ...opts });
const check = (params, opts = {}) => stores("GET", { query: `check=1&${new URLSearchParams(params)}`, ...opts });
const status = (signup, opts = {}) => stores("GET", { query: `signup=${signup}`, ...opts });
const onboarding = (body) => platformCall("onboarding", "POST", { body });

// An answer never holds a token, a link with a token, a secret, a database
// address or a 64-hex value.
const BAD_KEY = /token|_enc$|Enc$|^secrets?$|secret$|Secret$|^db_|^dbUrl|password|_hash$/i;
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
    if (value.includes(SECRET)) throw new Error(`the app secret at ${path}`);
  }
}

const SECRET = "shpss_line9-app-secret-canary-7f3e";
const auditCount = () => count("SELECT COUNT(*) AS n FROM audit_log");
const lastAudit = (action) => one("SELECT actor, actor_kind, action, tenant_id, resource, diff FROM audit_log WHERE action = ? ORDER BY rowid DESC LIMIT 1", [action]);
const latestInvite = async (to) => {
  const m = await one("SELECT body, recipient, kind, status FROM platform_mail WHERE recipient = ? ORDER BY rowid DESC LIMIT 1", [to]);
  return { mail: m, token: m?.body?.match(/accept-invite\?token=([0-9a-f]{64})/)?.[1] || null };
};
async function finish(signup) {
  await H.drainAfter();
  for (let i = 0; i < 5; i++) {
    const r = await status(signup);
    if (r.body?.status !== "provisioning") return r;
  }
  return status(signup);
}
const acceptCall = (host, method, opts = {}) => store.call(opts.as || "signed-out", "accept-invite", method, { host, ...opts });

const GOOD = { storeName: "Line Nine Goods", email: "founder@linenine.test", founderName: "Asha Rao", shop: "https://admin.shopify.com/store/line-nine-goods/products", clientId: "client-id-line9", clientSecret: SECRET };

// ---- data -----------------------------------------------------------------------

await t("migration 0015: signups source, created_by, shop_domain, app columns, invite columns and the two indexes", async () => {
  const cols = (await q("PRAGMA table_info(signups)")).map((c) => c.name);
  for (const c of ["source", "created_by", "shop_domain", "shopify_client_id", "shopify_secret_enc", "invite_id", "invite_status"]) ok(cols.includes(c), `signups.${c}`);
  const idx = (await q("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
  for (const i of ["idx_signups_shop_live", "idx_signups_source"]) ok(idx.includes(i), i);
  eq((await one("SELECT dflt_value AS d FROM pragma_table_info('signups') WHERE name = 'source'")).d, "'signup'", "source defaults to signup");
});

// ---- permissions (§3) ---------------------------------------------------------------

await t("§3: signed out and every merchant role (owner, admin, staff, support, owner of store B) get 401 on the checks, the progress and create", async () => {
  for (const who of ["signed-out", "owner", "admin", "staff", "support", "owner-b"]) {
    const jar = store.cookies[who] || {};
    eq((await check({ slug: "abc" }, { cookies: jar })).status, 401, `${who} check`);
    eq((await status("sgn_0000000000000000", { cookies: jar })).status, 401, `${who} progress`);
    eq((await create(GOOD, { cookies: jar })).status, 401, `${who} create`);
  }
  eq(await count("SELECT COUNT(*) AS n FROM signups WHERE source = 'operator'"), 0, "nothing created");
});

await t("§3: a merchant token in _platform, a non-operator's 'operator' session, a revoked one and the bootstrap token once operators exist get 401", async () => {
  const revoked = await opToken();
  await SE.revokeSessionByToken(revoked);
  const jars = { merchantToken: { _platform: store.cookies.owner._admin }, nonOperator: { _platform: await opToken(store.users.owner.id) }, revoked: { _platform: revoked }, bootstrap: { _platform: await AA.platformSessionToken() } };
  for (const [name, jar] of Object.entries(jars)) {
    eq((await check({ slug: "abc" }, { cookies: jar })).status, 401, `${name} check`);
    eq((await create(GOOD, { cookies: jar })).status, 401, `${name} create`);
  }
});

await t("§3: a cross-origin POST is refused (403) before anything else, signed in or not", async () => {
  for (const jar of [OP, {}]) eq((await create(GOOD, { cookies: jar, origin: "http://evil.test" })).status, 403, "cross-origin");
});

await t("§3: POST /api/platform/tenants is retired (405, no handler); GET stays operator-only; guard tables match the routes", async () => {
  const route = await import(pathToFileURL(join(ROOT, "app/api/platform/tenants/route.js")).href);
  eq(typeof route.POST, "undefined", "no POST handler");
  eq((await platformCall("tenants", "POST", { body: { id: "x" } })).status, 405, "POST 405");
  eq((await platformCall("tenants", "GET", { cookies: {} })).status, 401, "GET signed out");
  const { SHOPPER_ROUTES } = await import("./support/shopper-routes.js");
  const row = (p) => SHOPPER_ROUTES.find((r) => r.path === p);
  eq(JSON.stringify(row("platform/tenants").methods), '["GET"]', "tenants row");
  eq(JSON.stringify(row("platform/stores").methods), '["GET","POST"]', "stores row");
  const stores = await import(pathToFileURL(join(ROOT, "app/api/platform/stores/route.js")).href);
  eq(Object.keys(stores).filter((k) => /^[A-Z]+$/.test(k)).sort().join(","), "GET,POST", "stores methods");
  const { EXEMPT_ROUTES } = await import("./support/admin-routes.js");
  ok(EXEMPT_ROUTES.some((r) => r.path === "accept-invite" && r.method === "GET" && r.kind === "token"), "accept-invite GET row");
});

await t("§3: the console no longer offers the old New tenant form", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(ROOT, "components/platform/PlatformAdmin.js"), "utf8");
  ok(!/NewTenantForm|New tenant/.test(src), "no New tenant form or button");
  ok(/\/platform\/stores\/new/.test(src), "a New store link");
});

// ---- validation and live checks -------------------------------------------------------

await t("validation: each field's words; the app's id and secret only as a pair; an admin URL becomes the shop; a custom domain gets line 4's words", async () => {
  const v = OS.validateOperatorStore({ storeName: "x", email: "nope", founderName: "y".repeat(81), shop: "brand.com", slug: "Bad--slug", clientId: "id-only" });
  for (const k of ["storeName", "email", "founderName", "shop", "slug", "app"]) ok(v.errors[k], `error on ${k}`);
  ok(/won't work|your own domain|myshopify/i.test(v.errors.shop), `custom domain words: ${v.errors.shop}`);
  eq(OS.validateOperatorStore({ ...GOOD, clientId: "", clientSecret: SECRET }).errors.app, OS.WORDS.appPair, "secret only");
  const good = OS.validateOperatorStore(GOOD);
  eq(Object.keys(good.errors).length, 0, JSON.stringify(good.errors));
  eq(good.fields.shop, "line-nine-goods.myshopify.com", "admin URL normalised");
  eq(good.fields.slug, "line-nine-goods", "default address from the name");
  eq(OS.validateOperatorStore({ ...GOOD, shop: "Line-Nine-Goods" }).fields.shop, "line-nine-goods.myshopify.com", "bare handle, any case");
  const r = await create({ ...GOOD, email: "" });
  eq(r.status, 400, r.text);
  ok(r.body.errors.email, "field error in the answer");
  sweep(r.body);
});

await t("live checks: reserved and taken addresses, a live signup's address, a shop any store uses (any status, any case, admin URL), an existing account", async () => {
  eq((await check({ slug: "admin" })).body.slug.ok, false, "reserved");
  ok(/reserved/.test((await check({ slug: "admin" })).body.slug.words), "reserved words");
  eq((await check({ slug: store.a.id })).body.slug.ok, false, "a store's id");
  const free = (await check({ slug: "brand-new-address" })).body.slug;
  eq(free.ok, true, "free");
  eq(free.host, "brand-new-address.stores.test", "shown as <slug>.<domain>");
  await db.execute({
    sql: `INSERT INTO signups (id, email, name, store_name, slug, browser_hash, status, created_at, updated_at, expires_at) VALUES ('sgn_aaaaaaaaaaaaaaaa', 'held@x.test', 'H', 'Held', 'held-address', 'bh', 'pending', ?, ?, ?)`,
    args: [iso(Date.now()), iso(Date.now()), iso(Date.now() + 3600_000)],
  });
  eq((await check({ slug: "held-address" })).body.slug.ok, false, "a live signup holds it");
  // store B uses a Shopify store; suspend it: still refused
  await C.patchTenant(store.b.id, { status: "suspended", config: { shopify_store_domain: "Taken-Shop.myshopify.com" } });
  for (const shop of ["taken-shop.myshopify.com", "TAKEN-SHOP", "https://admin.shopify.com/store/taken-shop"]) {
    const r = (await check({ shop })).body.shop;
    eq(r.ok, false, shop);
    eq(r.words, `${store.b.tenant.name} already uses this Shopify store.`, "words name the store");
  }
  eq((await check({ shop: "brand.com" })).body.shop.ok, false, "custom domain");
  eq((await check({ shop: "fresh-shop" })).body.shop.ok, true, "free shop");
  const acct = (await check({ email: store.users.staff.email })).body.email;
  eq(acct.existingAccount, true, "existing account");
  eq(acct.words, "They'll accept with their existing Storeasy password.", "words");
  eq((await check({ email: "nobody@new.test" })).body.email.existingAccount, false, "new");
  const refused = await create({ ...GOOD, shop: "TAKEN-SHOP", slug: "held-address" });
  eq(refused.status, 409, refused.text);
  ok(refused.body.errors.shop && refused.body.errors.slug, "both refused on submit too");
  await C.patchTenant(store.b.id, { status: "active" });
});

await t("create is refused in plain words without SIGNUP_STORE_DOMAIN or a database driver; nothing is written", async () => {
  const before = await count("SELECT COUNT(*) AS n FROM signups");
  const dom = process.env.SIGNUP_STORE_DOMAIN;
  delete process.env.SIGNUP_STORE_DOMAIN;
  try {
    const r = await create(GOOD);
    eq(r.status, 503, r.text);
    ok(/SIGNUP_STORE_DOMAIN/.test(r.body.error), "words");
  } finally {
    process.env.SIGNUP_STORE_DOMAIN = dom;
  }
  const tok = process.env.TURSO_API_TOKEN;
  const env = process.env.NODE_ENV;
  delete process.env.TURSO_API_TOKEN;
  process.env.NODE_ENV = "production";
  try {
    const r = await create(GOOD);
    eq(r.status, 503, r.text);
    ok(/database/.test(r.body.error), "words");
  } finally {
    process.env.TURSO_API_TOKEN = tok;
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
  }
  eq(await count("SELECT COUNT(*) AS n FROM signups"), before, "no row");
});

// ---- create, progress, done -------------------------------------------------------------

let first;
await t("create: one audited POST queues the job; the row is an operator signup that can't lapse; the secret is encrypted; the URL id is all that comes back", async () => {
  const before = await auditCount();
  const r = await create(GOOD);
  eq(r.status, 200, r.text);
  eq(await auditCount(), before + 1, "exactly one audit row");
  sweep(r.body);
  eq(Object.keys(r.body).sort().join(","), "ok,signup", "answer keys");
  ok(/^sgn_[0-9a-f]{16}$/.test(r.body.signup), "signup id");
  first = r.body.signup;
  const a = await lastAudit("tenant.provision");
  eq(a.actor, operatorId, "names the operator");
  eq(a.actor_kind, "operator", "kind");
  const diff = JSON.parse(a.diff);
  eq(JSON.stringify(diff), JSON.stringify({ via: "operator-form", signup: first, slug: "line-nine-goods", shop: "line-nine-goods.myshopify.com", appReady: true }), "diff");
  const row = await one("SELECT * FROM signups WHERE id = ?", [first]);
  eq(row.source, "operator", "source");
  eq(row.created_by, operatorId, "created_by");
  eq(row.status, "provisioning", "claimed");
  eq(row.password_hash, null, "no password");
  eq(row.expires_at, OS.NEVER_EXPIRES, "never expires");
  eq(row.name, "Asha Rao", "founder name");
  ok(/^k1:/.test(row.shopify_secret_enc) && !row.shopify_secret_enc.includes(SECRET), "encrypted at rest");
  eq(SP.signupLapsed({ ...row, expires_at: iso(0) }), false, "never lapses, even past an old expiry");
  const job = await one("SELECT payload FROM jobs WHERE id = ?", [row.job_id]);
  ok(!job.payload.includes(SECRET) && !job.payload.includes("k1:"), "no secret in the job");
});

await t("progress: line 2's steps with the last relabelled; then done: invite to the owner, the address, the app, the redirect URL, the store's row; the secret is cleared", async () => {
  const p = await status(first);
  eq(p.status, 200, p.text);
  eq(p.body.steps.length, 4, "four steps");
  eq(p.body.steps[3].label, "Sending the owner's invite", "last step relabelled");
  const d = await finish(first);
  eq(d.body.status, "done", d.text);
  sweep(d.body);
  ok(d.body.steps.every((s) => s.state === "done"), "every step done");
  eq(d.body.address, "line-nine-goods.stores.test", "address");
  eq(d.body.subject, "tenant:line-nine-goods", "the store's row");
  eq(d.body.done.inviteTo, "founder@linenine.test", "invite to");
  eq(d.body.done.invite, "mock", "local mail");
  eq(d.body.done.appReady, true, "app set up");
  eq(d.body.done.redirectUrl, "http://line-nine-goods.stores.test/api/admin/shopify/callback", "redirect URL on the operator's protocol");
  const row = await one("SELECT * FROM signups WHERE id = ?", [first]);
  eq(row.status, "done", "done");
  eq(row.shopify_secret_enc, null, "secret cleared");
  eq(row.user_id, null, "no user made");
  eq(row.invite_status, "mock", "invite status");
  const tenant = await C.getTenant("line-nine-goods", { fresh: true });
  eq(tenant.config.shopify_store_domain, "line-nine-goods.myshopify.com", "shop on the store");
  eq(tenant.config.shopify_client_id, "client-id-line9", "client id on the store");
  eq(tenant.secrets.shopify_client_secret, SECRET, "secret in the store's encrypted secrets");
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'line-nine-goods'"), 0, "no member until the invite is accepted");
  const prov = await lastAudit("tenant.provisioned");
  eq(prov.actor, "operator-create", "system actor");
  eq(JSON.parse(prov.diff).operator, operatorId, "names the operator");
  const inv = await lastAudit("team.invite_created");
  eq(inv.actor, operatorId, "invite audited as the operator");
  eq(JSON.stringify(JSON.parse(inv.diff)), JSON.stringify({ role: "owner", via: "store-created", mail: "mock" }), "invite diff");
  const { mail, token } = await latestInvite("founder@linenine.test");
  eq(mail.kind, "operator_store_invite", "mail kind");
  ok(/Hi Asha Rao/.test(mail.body) && /http:\/\/line-nine-goods\.stores\.test\/admin\/accept-invite\?token=/.test(mail.body), "greeting and the store's own origin");
  const i = await one("SELECT role, created_at, expires_at FROM invitations WHERE token_hash = ?", [await SE.sha256Hex(token)]);
  eq(i.role, "owner", "owner invite");
  eq(Date.parse(i.expires_at) - Date.parse(i.created_at), 7 * 86400_000, "7 days");
  ok(logged.some((l) => /"evt":"operator_store_queued"/.test(l)) && logged.some((l) => /"evt":"operator_store_invite"/.test(l) && /"status":"mock"/.test(l)), "slog lines");
});

await t("the secret is never in jobs, provision_runs, audit_log, a log line or any answer", async () => {
  for (const [tbl, cols] of [["jobs", "payload, last_error"], ["provision_runs", "params, refs, steps, error"], ["audit_log", "diff, resource"], ["signups", "shopify_secret_enc, error"]]) {
    const rows = await q(`SELECT ${cols} FROM ${tbl}`);
    ok(!JSON.stringify(rows).includes(SECRET), `${tbl} holds no secret`);
  }
  ok(!logged.some((l) => l.includes(SECRET)), "no log line");
  const list = (await platformCall("onboarding", "GET", { query: "view=all&q=line-nine" })).body;
  sweep(list);
  sweep((await platformCall("onboarding", "GET", { query: "subject=tenant:line-nine-goods" })).body);
  // (the older provisions panel shows a run's database address to operators; only the secret is checked there)
  ok(!(await platformCall("provisions", "GET", {})).text.includes(SECRET), "provisions: no secret");
});

await t("a double submit and two simultaneous creates make one row; the shop's live row refuses another store", async () => {
  const again = await create(GOOD);
  eq(again.status, 409, again.text);
  ok(again.body.errors.slug && again.body.errors.shop, "address and shop both taken");
  const twin = { ...GOOD, storeName: "Twin Store", shop: "twin-shop", clientId: "", clientSecret: "", email: "twin@linenine.test" };
  const [a, b] = await Promise.all([create(twin), create(twin)]);
  eq([a.status, b.status].filter((s) => s === 200).length, 1, `one wins: ${a.status} ${b.status}`);
  eq(await count("SELECT COUNT(*) AS n FROM signups WHERE slug = 'twin-store'"), 1, "one row");
  const viaLive = await create({ ...twin, storeName: "Other Name", email: "other@x.test", shop: "https://admin.shopify.com/store/TWIN-SHOP" });
  eq(viaLive.status, 409, viaLive.text);
  eq(viaLive.body.errors.shop, "Twin Store already uses this Shopify store.", "a live operator row holds the shop");
  // the unique index itself: two live rows for one shop can't exist
  let threw = false;
  try {
    await db.execute({ sql: "INSERT INTO signups (id, email, name, store_name, slug, browser_hash, status, created_at, updated_at, expires_at, source, shop_domain) VALUES ('sgn_bbbbbbbbbbbbbbbb','z@z.test','','Z','zz-store','bh','verified',?,?,?,'operator','twin-shop.myshopify.com')", args: [iso(Date.now()), iso(Date.now()), OS.NEVER_EXPIRES] });
  } catch {
    threw = true;
  }
  ok(threw, "idx_signups_shop_live refuses it");
  await H.drainAfter();
});

await t("20 creates per operator per hour: the 21st is refused with words and writes nothing", async () => {
  await db.execute({ sql: "INSERT INTO login_limits (key, count, reset_at) VALUES (?, 20, ?) ON CONFLICT(key) DO UPDATE SET count = 20, reset_at = excluded.reset_at", args: [`operator-create:${operatorId}`, iso(Date.now() + 3600_000)] });
  const before = await auditCount();
  const r = await create({ ...GOOD, storeName: "Limited Store", shop: "limited-shop", email: "l@x.test" });
  eq(r.status, 429, r.text);
  ok(/20 stores/.test(r.body.error), "words");
  eq(await auditCount(), before, "no audit row");
  eq(await count("SELECT COUNT(*) AS n FROM signups WHERE slug = 'limited-store'"), 0, "no row");
  await db.execute({ sql: "DELETE FROM login_limits WHERE key = ?", args: [`operator-create:${operatorId}`] });
});

// ---- accepting the invite ----------------------------------------------------------------

const HOST1 = "line-nine-goods.stores.test";
await t("accept: the page's peek shows the store and the invited email; user B signed in posting the token gets nothing; store B's host refuses it without spending it", async () => {
  const { token } = await latestInvite("founder@linenine.test");
  const peek = await acceptCall(HOST1, "GET", { query: `token=${token}` });
  eq(peek.status, 200, peek.text);
  eq(peek.body.email, "founder@linenine.test", "invited email");
  eq(peek.body.existingAccount, false, "a new account");
  eq(peek.body.storeName, "Line Nine Goods", "store name");
  sweep(peek.body);
  eq((await acceptCall(store.b.tenant.domains[0], "GET", { query: `token=${token}` })).status, 400, "peek on store B");
  const wrongHost = await acceptCall(store.b.tenant.domains[0], "POST", { body: { token, name: "X", password: "line9-founder-pass" } });
  eq(wrongHost.status, 400, "store B's host refused");
  // user B (owner of store B) is signed in on this host and posts the token: the membership is the invite's email's, never B's
  const asB = await acceptCall(HOST1, "POST", { as: "owner-b", body: { token, name: "Asha", password: "line9-founder-pass" } });
  eq(asB.status, 200, asB.text);
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'line-nine-goods' AND user_id = ?", [store.users["owner-b"].id]), 0, "B gets nothing");
  const owner = await I.findUserByEmail("founder@linenine.test");
  ok(owner?.email_verified_at, "a new account with a verified email");
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'line-nine-goods' AND user_id = ? AND role = 'owner'", [owner.id]), 1, "owner membership to the invite's email");
  ok(asB.setCookie.some((c) => c.startsWith("_admin=")), "signed in as the new owner");
  const a = await lastAudit("team.invite_accepted");
  eq(a.tenant_id, "line-nine-goods", "tenantId");
  eq(JSON.stringify(JSON.parse(a.diff)), JSON.stringify({ role: "owner", existingAccount: false }), "diff");
  eq((await acceptCall(HOST1, "POST", { body: { token, name: "x", password: "line9-founder-pass" } })).status, 400, "used token refused");
  eq((await acceptCall(HOST1, "GET", { query: `token=${token}` })).status, 400, "used token: peek refused");
});

await t("the new owner's step 1 shows their shop with Connect ready (the app was set up)", async () => {
  const sheet = (await platformCall("onboarding", "GET", { query: "subject=tenant:line-nine-goods" })).body;
  eq(sheet.onboarding.current, "connect", "step 1");
  const { connectFacts } = await import("../lib/onboarding/connect.js");
  const f = await connectFacts(await C.getTenant("line-nine-goods", { fresh: true }));
  eq(f.shopDomain, "line-nine-goods.myshopify.com", "their shop");
  eq(f.appReady, true, "Connect enabled");
  eq(f.locked, true, "shop locked");
});

let second;
await t("a store without app credentials: done says the app isn't set up; the owner's step 1 says Storeasy's team is preparing it", async () => {
  const r = await create({ storeName: "Prep Store", email: store.users.staff.email, shop: "prep-shop" });
  eq(r.status, 200, r.text);
  second = r.body.signup;
  const d = await finish(second);
  eq(d.body.status, "done", d.text);
  eq(d.body.done.appReady, false, "not set up");
  ok(/preparing/.test(W.appWords(d.body.done)), "done words");
  const sheet = (await platformCall("onboarding", "GET", { query: "subject=tenant:prep-store" })).body;
  const connect = sheet.onboarding.steps.find((s) => s.id === "connect");
  eq(connect.state, "in_progress", "step 1 waits on Storeasy");
  ok(/preparing/.test(connect.words), `words: ${connect.words}`);
});

await t("resend = line 8's owner_invite: only the newest invite works; the automatic one doesn't count; the 6th within an hour is throttled", async () => {
  const to = store.users.staff.email;
  const auto = (await latestInvite(to)).token;
  ok(auto, "the automatic invite");
  const before = await auditCount();
  const r1 = await onboarding({ action: "owner_invite", subject: "tenant:prep-store" });
  eq(r1.status, 200, r1.text);
  eq(await auditCount(), before + 1, "one audit row");
  eq(JSON.parse((await lastAudit("team.invite_created")).diff).via, "operator-onboarding", "line 8's row");
  ok(!/token|http/.test(r1.text), "no token or link");
  eq((await latestInvite(to)).mail.kind, "operator_store_invite", "the store invite's words again");
  eq((await acceptCall("prep-store.stores.test", "GET", { query: `token=${auto}` })).status, 400, "the earlier invite expired");
  for (let i = 2; i <= 5; i++) eq((await onboarding({ action: "owner_invite", subject: "tenant:prep-store" })).status, 200, `resend ${i}`);
  const sixth = await onboarding({ action: "owner_invite", subject: "tenant:prep-store" });
  eq(sixth.status, 429, sixth.text);
  eq((await one("SELECT invite_status FROM signups WHERE id = ?", [second])).invite_status, "mock", "row keeps the invite status");
});

await t("an existing account accepts with its current password: a wrong one is refused and leaves the invite usable; then resend is refused (an owner exists)", async () => {
  const { token } = await latestInvite(store.users.staff.email);
  const peek = await acceptCall("prep-store.stores.test", "GET", { query: `token=${token}` });
  eq(peek.body.existingAccount, true, "existing account mode");
  const wrong = await acceptCall("prep-store.stores.test", "POST", { body: { token, password: "not-the-password" } });
  eq(wrong.status, 400, wrong.text);
  eq(wrong.body.code, "WRONG_PASSWORD", "code");
  ok(logged.some((l) => /"evt":"admin_invite_rejected"/.test(l) && /wrong_password/.test(l)), "slog reason");
  eq((await acceptCall("prep-store.stores.test", "GET", { query: `token=${token}` })).status, 200, "still usable");
  const right = await acceptCall("prep-store.stores.test", "POST", { body: { token, password: "staff-pass-opcreate" } });
  eq(right.status, 200, right.text);
  eq(JSON.parse((await lastAudit("team.invite_accepted")).diff).existingAccount, true, "audited as existing");
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'prep-store' AND user_id = ? AND role = 'owner'", [store.users.staff.id]), 1, "owner");
  const after = await onboarding({ action: "owner_invite", subject: "tenant:prep-store" });
  eq(after.status, 409, after.text);
  ok(/already has an owner/.test(after.body.error), "words");
});

await t("an expired invite is refused", async () => {
  const inv = await I.createInvite({ email: "late@x.test", tenantId: "prep-store", role: "owner", ttlMs: -1 });
  eq((await acceptCall("prep-store.stores.test", "POST", { body: { token: inv.token, name: "L", password: "late-pass-123" } })).status, 400, "expired");
});

// ---- retries, needs-operator, resume, lapse ------------------------------------------------

await t("fake Turso 503: the job retries with line 2's note; once the fault is gone it finishes", async () => {
  await fault({ route: "create", status: 503, times: 1 });
  const r = await create({ storeName: "Retry Store", email: "retry@x.test", shop: "retry-shop" });
  eq(r.status, 200, r.text);
  await H.drainAfter();
  const p = await status(r.body.signup);
  eq(p.body.status, "provisioning", p.text);
  ok(/slow to answer/.test(p.body.note || ""), `retry note: ${p.body.note}`);
  clock.at += 10 * 60_000;
  const d = await finish(r.body.signup);
  eq(d.body.status, "done", d.text);
  await clearFaults();
});

await t("fake Turso 402: needs an operator (Try again words); Resume via /api/platform/onboarding finishes it; the client secret stays encrypted until then", async () => {
  await fault({ route: "create", status: 402 });
  const r = await create({ storeName: "Stuck Store", email: "stuck@x.test", shop: "stuck-shop", clientId: "cid-stuck", clientSecret: SECRET });
  const f = await finish(r.body.signup);
  eq(f.body.status, "failed", f.text);
  eq(f.body.failureKind, "needs_operator", "kind");
  eq(f.body.canRetry, true, "Try again offered");
  ok(/needs fixing/.test(W.failureWords(f.body.failureKind)), "operator words");
  ok((await one("SELECT shopify_secret_enc AS s FROM signups WHERE id = ?", [r.body.signup])).s, "secret kept for the retry");
  await clearFaults();
  const before = await auditCount();
  const res = await onboarding({ action: "resume", subject: `signup:${r.body.signup}` });
  eq(res.status, 200, res.text);
  eq(await auditCount(), before + 1, "resume audited once");
  const d = await finish(r.body.signup);
  eq(d.body.status, "done", d.text);
  eq((await one("SELECT shopify_secret_enc AS s FROM signups WHERE id = ?", [r.body.signup])).s, null, "cleared once done");
  eq((await C.getTenant("stuck-store", { fresh: true })).secrets.shopify_client_secret, SECRET, "the resumed run still set the app up");
});

await t("rows never lapse; line 8's list and sheet carry source 'operator'; the provisions panel's run carries it too", async () => {
  const r = await create({ storeName: "Old Store", email: "old@x.test", shop: "old-shop" });
  await db.execute({ sql: "UPDATE signups SET status = 'failed', failure_kind = 'needs_operator', created_at = ?, updated_at = ? WHERE id = ?", args: [iso(Date.now() - 30 * 86400_000), iso(Date.now() - 30 * 86400_000), r.body.signup] });
  const row = (await platformCall("onboarding", "GET", { query: "view=all&q=old store" })).body.rows.find((x) => x.subject === `signup:${r.body.signup}`);
  ok(row, "listed");
  eq(row.source, "operator", "source");
  ok(row.status !== "failed_lapsed", `not lapsed: ${row.status}`);
  const sheet = (await platformCall("onboarding", "GET", { query: `subject=signup:${r.body.signup}` })).body;
  eq(sheet.signup.lapsed, false, "sheet: not lapsed");
  eq(sheet.signup.source, "operator", "sheet source");
  eq(sheet.actions.resume, true, "resume offered");
  eq(sheet.actions.release, false, "never freed as lapsed");
  const storeRow = (await platformCall("onboarding", "GET", { query: "view=all&q=line nine" })).body.rows.find((x) => x.subject === "tenant:line-nine-goods");
  eq(storeRow.source, "operator", "the store's row carries it");
  const runs = (await platformCall("provisions", "GET", {})).body.runs;
  ok(runs.some((x) => x.signup?.source === "operator"), "provisions: source on the run");
  await H.drainAfter();
});

await t("a done operator row is kept by the signup pruning (it carries the badge)", async () => {
  await db.execute({ sql: "UPDATE signups SET created_at = ? WHERE id = ?", args: [iso(Date.now() - 30 * 86400_000), first] });
  await S.startSignup({ input: { name: "P", email: "prune@x.test", password: "prune-pass-123", storeName: "Prune Me" }, ip: "10.1.1.1" });
  ok(await one("SELECT id FROM signups WHERE id = ?", [first]), "kept");
});

await t("the accept page's peek is rate-limited", async () => {
  delete process.env.RATE_LIMIT_DISABLED;
  try {
    let last;
    for (let i = 0; i < 21; i++) last = await acceptCall(HOST1, "GET", { query: "token=nope" });
    eq(last.status, 429, "21st peek");
  } finally {
    process.env.RATE_LIMIT_DISABLED = "1";
  }
});

// ---- review fixes ------------------------------------------------------------------------------

await t("review 1: an existing account accepting an invite shares login's lockout (per email and per IP), cleared on success; a suspended user can't accept", async () => {
  const u = await I.createUser({ email: "lockout@x.test", password: "lockout-pass-123" });
  const inv = await I.createInvite({ email: "lockout@x.test", tenantId: "prep-store", role: "admin" });
  await db.execute({ sql: "DELETE FROM login_limits WHERE key LIKE 'login%'" });
  let last;
  for (let i = 0; i < 11; i++) last = await acceptCall("prep-store.stores.test", "POST", { body: { token: inv.token, password: `wrong-pass-${i}` } });
  eq(last.status, 429, `11th wrong password: ${last.text}`);
  ok(await one("SELECT count FROM login_limits WHERE key = 'login:lockout@x.test'"), "the login key counts");
  // the right password is refused too while locked, and the invite stays usable
  eq((await acceptCall("prep-store.stores.test", "POST", { body: { token: inv.token, password: "lockout-pass-123" } })).status, 429, "locked");
  ok(await I.peekInvite(inv.token, "prep-store"), "not spent");
  await db.execute({ sql: "DELETE FROM login_limits WHERE key LIKE 'login%'" });
  eq((await acceptCall("prep-store.stores.test", "POST", { body: { token: inv.token, password: "lockout-pass-123" } })).status, 200, "accepted once unlocked");
  eq(await count("SELECT COUNT(*) AS n FROM login_limits WHERE key = 'login:lockout@x.test'"), 0, "cleared on success");
  const off = await I.createUser({ email: "suspended@x.test", password: "suspended-pass-1" });
  await I.setUserStatus(off.id, "disabled");
  const inv2 = await I.createInvite({ email: "suspended@x.test", tenantId: "prep-store", role: "admin" });
  const r = await acceptCall("prep-store.stores.test", "POST", { body: { token: inv2.token, password: "suspended-pass-1" } });
  eq(r.status, 403, r.text);
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?", [off.id]), 0, "no membership");
  ok(await I.peekInvite(inv2.token, "prep-store"), "not spent");
  ok(u, "user");
});

await t("review 2: an operator row that isn't provisioning can be cancelled (audited, secret cleared, runs superseded): the shop and address are free again; merchant roles 401", async () => {
  await fault({ route: "create", status: 402 });
  const r = await create({ storeName: "Cancel Me", email: "cancel@x.test", shop: "cancel-shop", clientId: "cid-c", clientSecret: SECRET });
  const f = await finish(r.body.signup);
  eq(f.body.status, "failed", f.text);
  await clearFaults();
  const subject = `signup:${r.body.signup}`;
  for (const who of ["signed-out", "owner", "admin", "staff", "support", "owner-b"]) {
    eq((await platformCall("onboarding", "POST", { body: { action: "cancel_store", subject }, cookies: store.cookies[who] || {} })).status, 401, who);
  }
  const sheet = (await platformCall("onboarding", "GET", { query: `subject=${subject}` })).body;
  eq(sheet.actions.cancel, true, "the sheet offers cancel");
  const before = await auditCount();
  const c = await onboarding({ action: "cancel_store", subject });
  eq(c.status, 200, c.text);
  eq(await auditCount(), before + 1, "one audit row");
  const a = await lastAudit("signup.store_cancelled");
  eq(a.actor, operatorId, "names the operator");
  const row = await one("SELECT status, shopify_secret_enc FROM signups WHERE id = ?", [r.body.signup]);
  eq(row.status, "released", "released");
  eq(row.shopify_secret_enc, null, "secret cleared");
  eq(await count("SELECT COUNT(*) AS n FROM provision_runs WHERE tenant_id = 'cancel-me' AND status != 'superseded' AND status != 'done'"), 0, "runs superseded");
  eq((await check({ shop: "cancel-shop", slug: "cancel-me" })).body.shop.ok, true, "shop free");
  eq((await check({ slug: "cancel-me" })).body.slug.ok, true, "address free");
  eq((await onboarding({ action: "cancel_store", subject })).status, 409, "again: refused");
  // a founder's own signup and a provisioning row can't be cancelled this way
  const prov = await create({ storeName: "Busy Store", email: "busy@x.test", shop: "busy-shop" });
  eq((await onboarding({ action: "cancel_store", subject: `signup:${prov.body.signup}` })).status, 409, "provisioning: refused");
  await H.drainAfter();
});

await t("review 2: freeing a lapsed address also clears any stored app secret", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(ROOT, "lib/platform/onboarding-ops.js"), "utf8");
  ok(/status = 'released'[^"]*shopify_secret_enc = NULL/.test(src), "the release update clears shopify_secret_enc");
});

await t("review 3: recovery mails a reset link to someone holding a live invite to this store; same answer either way", async () => {
  const u = await I.createUser({ email: "invited-only@x.test", password: "invited-only-pass" });
  await I.createInvite({ email: "invited-only@x.test", tenantId: "prep-store", role: "admin" });
  const before = await count("SELECT COUNT(*) AS n FROM invitations WHERE email = 'invited-only@x.test' AND kind = 'reset'");
  const r = await store.call("signed-out", "recover", "POST", { host: "prep-store.stores.test", body: { email: "invited-only@x.test" } });
  eq(r.status, 200, r.text);
  eq(await count("SELECT COUNT(*) AS n FROM invitations WHERE email = 'invited-only@x.test' AND kind = 'reset'"), before + 1, "a reset link made");
  const none = await store.call("signed-out", "recover", "POST", { host: "prep-store.stores.test", body: { email: "nobody-here@x.test" } });
  eq(none.text, r.text, "same answer");
  ok(u, "user");
});

await t("review 4: when queueing fails after the row is written, the row goes, the answer is a 500, and a retry works", async () => {
  await db.execute("ALTER TABLE jobs RENAME TO jobs_hidden");
  let r;
  try {
    r = await create({ storeName: "Queue Fail", email: "qf@x.test", shop: "queue-fail-shop" });
  } finally {
    await db.execute("ALTER TABLE jobs_hidden RENAME TO jobs");
  }
  eq(r.status, 500, r.text);
  ok(/no store was created/.test(r.body.error), "truthful words");
  eq(await count("SELECT COUNT(*) AS n FROM signups WHERE slug = 'queue-fail' AND status IN ('verified','provisioning','failed')"), 0, "no live row left");
  const again = await create({ storeName: "Queue Fail", email: "qf@x.test", shop: "queue-fail-shop" });
  eq(again.status, 200, again.text);
  await H.drainAfter();
});

await t("review 5: a second runner can't send another invite: the invite is claimed before sending", async () => {
  const r = await create({ storeName: "Claim Store", email: "claim@x.test", shop: "claim-shop" });
  // another runner already claimed the invite
  await db.execute({ sql: "UPDATE signups SET invite_status = 'sending' WHERE id = ?", args: [r.body.signup] });
  const d = await finish(r.body.signup);
  eq(d.body.status, "done", d.text);
  eq(await count("SELECT COUNT(*) AS n FROM platform_mail WHERE recipient = 'claim@x.test'"), 0, "no second invite sent");
});

// ---- the screen's words (pure) ----------------------------------------------------------------

await t("createStoreWords: invite and app words, failure words for both kinds, the address preview matches the server, the first error field", async () => {
  eq(W.inviteWords({ invite: "sent", inviteTo: "a@b.test" }), "Invite sent to a@b.test", "sent");
  ok(/Invite not sent/.test(W.inviteWords({ invite: "failed", inviteTo: "a@b.test" })), "failed");
  eq(W.inviteSent({ invite: "mock" }), true, "mock counts as sent");
  ok(/connect Shopify/.test(W.appWords({ appReady: true, shop: "x.myshopify.com" })), "ready");
  ok(W.failureWords("retry_exhausted") !== W.failureWords("needs_operator"), "two kinds");
  for (const name of ["Line Nine Goods", "Café & Co", "  --x--  ", "A", "Ünïcödé Store 2026", "x".repeat(70)]) eq(W.slugPreview(name), S.slugFor(name), name);
  eq(W.firstErrorField({ slug: "x", email: "y" }), "email", "form order");
  eq(W.PROGRESS.title("Line Nine Goods"), "Setting up Line Nine Goods", "title");
});

await t("no call left this machine, and no structured log line holds a token", async () => {
  eq(guard.blocked.length, 0, `blocked: ${guard.blocked.join(", ")}`);
  ok(!logged.filter((l) => l.startsWith('{"ts"')).some((l) => /token=|[0-9a-f]{64}/.test(l)), "no token in structured logs");
});

await fake.close();
guard.restore?.();
await store.cleanup?.();
await rm(TMP, { recursive: true, force: true });
for (const ext of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `.test-opcreate-default.db${ext}`), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
