// Self-serve signup suite (Phase 1 line 1, docs/plans/phase-1.md §1–§4).
// The real routes under plain Node on file: databases only: the outside
// services are blank and the network is blocked (a "real send" below is a
// stand-in fetch). Covers the provisioner's file driver and its refusals,
// createUser({ passwordHash, emailVerifiedAt }), the signup rules (fields,
// addresses, kill switch, limits, the email code, browser binding, no
// enumeration, expiry), verify → store + user + owner + handoff, a failed
// setup resumed by Try again, the audit rows, platform_mail, and every
// least-trusted test in §3 but the support page read (test-support-reads).
//   pnpm test:signup
import { rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_DIR = join(ROOT, ".test-signup-stores");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-sgn-default.db";
process.env.PLATFORM_SECRET = "test-signup-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "storeasy.test";
process.env.SIGNUP_STORE_DOMAIN = "stores.test";
process.env.STORE_DB_DIR = STORE_DIR;
delete process.env.VERCEL;
if (process.env.NODE_ENV === "production") delete process.env.NODE_ENV;
const network = H.blockNetwork();
await rm(STORE_DIR, { recursive: true, force: true });

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- the fixture: stores A and B with their members, under one control plane ---
const store = await H.makeRoleStore({ name: "sgn" });
const { a, b } = store;
const C = await import("../lib/platform/control.js");
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/signup.js");
const P = await import("../lib/platform/provision.js");
const PV = await import("../lib/platform/provisioner.js");
const { sendPlatformMail } = await import("../lib/platform/platform-mail.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = C.platformDb();
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const one = async (sql, args = []) => (await q(sql, args))[0] ?? null;

const MARKETING = "storeasy.test";
const setFlag = async (on) =>
  db.execute({
    sql: `INSERT INTO feature_flags (key, description, default_on, tenants, critical, updated_at) VALUES (?, 'signup', ?, '{}', 0, ?)
          ON CONFLICT(key) DO UPDATE SET default_on = excluded.default_on, updated_at = excluded.updated_at`,
    args: [S.SIGNUP_FLAG, on ? 1 : 0, new Date().toISOString()],
  });

// One call to a signup route (app/api/signup[/verify|/resend]).
let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
async function api(path, method, { body, host = MARKETING, origin, cookie, ip = freshIp(), query } = {}) {
  const route = await import(pathToFileURL(join(ROOT, "app/api", path, "route.js")).href);
  const headers = { host, "x-forwarded-for": ip };
  const o = origin === undefined ? (method === "GET" ? null : `http://${host}`) : origin;
  if (o) headers.origin = o;
  if (cookie) headers.cookie = `${S.SIGNUP_COOKIE}=${cookie}`;
  let reqBody;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await route[method](new NextRequest(`http://${host}/api/${path}${query ? `?${query}` : ""}`, { method, headers, body: reqBody }));
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
const form = (over = {}) => {
  const n = ++seq;
  return { name: `Founder ${n}`, email: `founder${n}@sgn.test`, password: `pass-word-${n}-long`, storeName: `Signup Store ${n}`, ...over };
};
const mailFor = (email, kind = "signup_code") => one("SELECT * FROM platform_mail WHERE recipient = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [email, kind]);
const codeFor = async (email) => String((await mailFor(email))?.body || "").match(/\b(\d{6})\b/)?.[1] ?? null;
const rowFor = (email) => one("SELECT * FROM signups WHERE email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [email]);
async function start(over = {}, opts = {}) {
  const f = form(over);
  const res = await api("signup", "POST", { body: f, ...opts });
  return { f, res, cookie: cookieFrom(res) };
}

await setFlag(true);

// --- data and the building blocks -----------------------------------------------

await t("migration 0011: signups, platform_mail and users.email_verified_at exist on a migrated control plane", async () => {
  const cols = (await q("PRAGMA table_info(users)")).map((c) => c.name);
  ok(cols.includes("email_verified_at"), "users.email_verified_at");
  for (const tbl of ["signups", "platform_mail"]) ok(await one("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [tbl]), tbl);
  ok(await one("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_signups_slug_live'"), "the live-slug index");
});

await t("provisioner: the file driver makes <STORE_DB_DIR>/storeasy-t-<slug>.db and hands back only a file: URL", async () => {
  const r = await PV.createStoreDatabase("pv-one", "file");
  eq(r.dbUrl, `file:${join(STORE_DIR, "storeasy-t-pv-one.db")}`, "url");
  eq(r.dbToken, null, "no token");
  eq(r.created, true, "created");
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: r.dbUrl });
  await c.execute("SELECT 1");
  c.close();
  eq((await PV.createStoreDatabase("pv-one", "file", { resumeUrl: r.dbUrl })).created, false, "its own run resuming adopts the file");
});

await t("provisioner: the file driver refuses NODE_ENV=production, VERCEL and a URL-like STORE_DB_DIR; unknown drivers and bad slugs are refused", async () => {
  const keep = { NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL, STORE_DB_DIR: process.env.STORE_DB_DIR };
  const refuses = async (label, re) => {
    let err = null;
    try {
      await PV.createStoreDatabase("pv-two", "file");
    } catch (e) {
      err = e;
    }
    ok(err && re.test(err.message), `${label}: ${err?.message}`);
  };
  try {
    process.env.NODE_ENV = "production";
    await refuses("production", /local use only/);
    delete process.env.NODE_ENV;
    process.env.VERCEL = "1";
    await refuses("vercel", /Vercel/);
    delete process.env.VERCEL;
    for (const url of ["libsql://x.turso.io", "https://example.com/dir", "file:///tmp/x", "http://127.0.0.1:8080"]) {
      process.env.STORE_DB_DIR = url;
      await refuses(url, /not a URL/);
    }
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  let err = null;
  await PV.createStoreDatabase("pv-two", "sqlite").catch((e) => (err = e));
  ok(/dbDriver must be one of/.test(err?.message), "unknown driver");
  err = null;
  await PV.createStoreDatabase("../x", "file").catch((e) => (err = e));
  ok(/slug/.test(err?.message), "bad slug");
  let thrown = null;
  await P.runProvision({ id: "pv-three", source: "signup", dbDriver: "sqlite" }).catch((e) => (thrown = e));
  ok(/dbDriver/.test(thrown?.message), "runProvision checks the driver");
});

await t("provisioner: the turso driver is today's createTenantDatabase (the CLI stub seam); runProvision still needs shopDomain outside signup", async () => {
  const calls = [];
  globalThis[P.TURSO_TEST_RUNNER] = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "list") return "NAME\n";
    if (args[1] === "show") return "libsql://pv-turso.example.test";
    if (args[1] === "tokens") return "tok";
    return "";
  };
  try {
    const r = await PV.createStoreDatabase("pv-turso");
    eq(r.dbUrl, "libsql://pv-turso.example.test", "url");
    ok(calls.includes("db create storeasy-t-pv-turso"), calls.join(" | "));
  } finally {
    delete globalThis[P.TURSO_TEST_RUNNER];
  }
  let err = null;
  await P.runProvision({ id: "pv-four" }).catch((e) => (err = e));
  ok(/shopDomain required/.test(err?.message), "operators and the CLI still give a Shopify domain");
});

await t("createUser({ passwordHash, emailVerifiedAt }) stores the hash as given and the verified time; a non-scrypt hash is refused; the old form still works", async () => {
  const hash = await I.hashPassword("hashed-before-123");
  const at = "2026-11-24T10:00:00.000Z";
  const u = await I.createUser({ email: "Prehashed@Sgn.test", name: "Pre", passwordHash: hash, emailVerifiedAt: at });
  eq(u.password_hash, hash, "hash kept");
  eq(u.email_verified_at, at, "verified at");
  eq(u.email, "prehashed@sgn.test", "email normalised");
  ok(await I.verifyPassword("hashed-before-123", u.password_hash), "the password signs in");
  let err = null;
  await I.createUser({ email: "plain@sgn.test", passwordHash: "plain-text" }).catch((e) => (err = e));
  ok(/scrypt/.test(err?.message), "a plain password as a hash is refused");
  const old = await I.createUser({ email: "old-form@sgn.test", password: "old-form-pass" });
  eq(old.email_verified_at, null, "no verified time unless given");
});

await t("password rules: 8–200 characters and not the email", () => {
  ok(I.passwordProblem("short", ""), "too short");
  ok(I.passwordProblem("x".repeat(201), ""), "too long");
  ok(I.passwordProblem("Me@Shop.test", "me@shop.test"), "the email");
  eq(I.passwordProblem("a fine password", "me@shop.test"), null, "fine");
});

await t("slugFor and the address rules: format, reserved words, marketing-host labels, store ids, store domains, live signups", async () => {
  eq(S.slugFor("Café & Crème Co."), "cafe-and-creme-co", "derived");
  eq(S.slugFor("!!"), "", "nothing left");
  eq(S.slugFor("a".repeat(60)).length, 40, "40 at most");
  for (const s of ["a", "-ab", "ab-", "Ab", "a_b", "a".repeat(41)]) eq((await S.slugAvailable(s)).reason, "format", s);
  for (const s of ["www", "admin", "api", "app", "platform", "storeasy", "mail", "help", "status", "signup", "test"]) eq((await S.slugAvailable(s)).reason, "reserved", s);
  eq((await S.slugAvailable(a.id)).reason, "taken", "a store's id");
  await C.patchTenant(b.id, { domains: [...b.tenant.domains, "held-by-b.stores.test"] });
  eq((await S.slugAvailable("held-by-b")).reason, "taken", "a store's domain");
  eq((await S.slugAvailable("brand-new-shop")).ok, true, "free");
});

await t("form validation: every field gets its own words; nothing says the email is taken", async () => {
  const r = await api("signup", "POST", { body: { name: "", email: "nope", password: "short", storeName: "x", slug: "-bad" } });
  eq(r.status, 422, "status");
  eq(Object.keys(r.body.errors).sort().join(","), "email,name,password,slug,storeName", "fields");
  ok(!/taken|exists|already/i.test(JSON.stringify(r.body)), "no account words");
  eq(r.setCookie.length, 0, "no cookie for a bad form");
});

// --- where signup is open -------------------------------------------------------

await t("kill switch: with ff_self-signup off every signup route says signups are closed, with a link to /contact", async () => {
  await setFlag(false);
  try {
    for (const [path, method] of [["signup", "GET"], ["signup", "POST"], ["signup/verify", "POST"], ["signup/resend", "POST"]]) {
      const r = await api(path, method, { body: method === "POST" ? form() : undefined, query: "slug=open-shop" });
      eq(r.status, 403, `${method} ${path}`);
      eq(r.body.code, "SIGNUPS_CLOSED", `${method} ${path} code`);
      eq(r.body.contact, "/contact", `${method} ${path} contact`);
    }
    eq(await one("SELECT COUNT(*) AS n FROM signups WHERE email LIKE 'founder%' AND status = 'pending' AND created_at > ?", [new Date(Date.now() - 1000).toISOString()]).then((r) => Number(r.n)), 0, "nothing started");
  } finally {
    await setFlag(true);
  }
  // a missing flag row is closed too (fallback false)
  await db.execute({ sql: "DELETE FROM feature_flags WHERE key = ?", args: [S.SIGNUP_FLAG] });
  eq((await api("signup", "GET", { query: "slug=open-shop" })).status, 403, "no flag row");
  await setFlag(true);
});

await t("least-trusted: /api/signup, verify and resend on a store host (or an unknown host) are 404", async () => {
  for (const host of [a.tenant.domains[0], "nobody.example.test"]) {
    for (const [path, method] of [["signup", "GET"], ["signup", "POST"], ["signup/verify", "POST"], ["signup/resend", "POST"]]) {
      const r = await api(path, method, { host, body: method === "POST" ? form() : undefined });
      eq(r.status, 404, `${method} ${path} on ${host}`);
    }
  }
});

await t("least-trusted: a cross-origin POST to signup, verify, resend or handoff is 403", async () => {
  for (const path of ["signup", "signup/verify", "signup/resend"]) {
    const r = await api(path, "POST", { body: form(), origin: "https://evil.example" });
    eq(r.status, 403, path);
  }
  const h = await store.call("signed-out", "handoff", "POST", { body: { token: "0".repeat(64) }, origin: "https://evil.example" });
  eq(h.status, 403, "handoff");
});

await t("availability check: GET ?slug= and ?storeName= answer available, or why not, with the address", async () => {
  const free = await api("signup", "GET", { query: "storeName=Sunny%20Socks" });
  eq(free.status, 200, "status");
  eq(free.body.slug, "sunny-socks", "derived slug");
  eq(free.body.available, true, "free");
  eq(free.body.address, "sunny-socks.stores.test", "address");
  const taken = await api("signup", "GET", { query: `slug=${a.id}` });
  eq(taken.body.available, false, "taken");
  eq(taken.body.reason, "taken", "reason");
  ok(taken.body.message, "words");
});

// --- start, the code, binding ------------------------------------------------------

let main; // the happy-path signup, verified further down
await t("start: 200, a host-only httpOnly SameSite=Lax se_signup cookie, and only hashes at rest", async () => {
  main = await start({ storeName: "Happy Path Goods" });
  eq(main.res.status, 200, "status");
  ok(main.cookie && /^[0-9a-f]{64}$/.test(main.cookie), "cookie token");
  const sc = main.res.setCookie.find((c) => c.startsWith(`${S.SIGNUP_COOKIE}=`));
  ok(/HttpOnly/i.test(sc) && /SameSite=lax/i.test(sc) && /Path=\//.test(sc), sc);
  ok(!/Domain=/i.test(sc), "host-only (no Domain)");
  eq(main.res.body.signup.address, "happy-path-goods.stores.test", "address");
  const row = await rowFor(main.f.email);
  eq(row.status, "pending", "pending");
  eq(row.browser_hash, sha(main.cookie), "only the cookie's hash");
  ok(!JSON.stringify(row).includes(main.cookie), "the cookie itself is not stored");
  ok(/^scrypt:/.test(row.password_hash), "the password is hashed");
  ok(!JSON.stringify(row).includes(main.f.password), "never the password");
  const code = await codeFor(main.f.email);
  ok(/^\d{6}$/.test(code), "a 6-digit code was mailed (mock)");
  eq(row.code_hash, sha(`${row.id}:${code}`), "code stored as sha256(signupId:code)");
  ok(Date.parse(row.code_expires_at) - Date.parse(row.created_at) === 15 * 60_000, "15-minute code");
  ok(Date.parse(row.expires_at) - Date.parse(row.created_at) === 24 * 3600_000, "24-hour signup");
  eq((await S.slugAvailable("happy-path-goods")).reason, "taken", "a live signup holds its address");
});

await t("least-trusted: an existing-email probe gets the same status, the same response keys and a cookie; its email has no code", async () => {
  const newOne = await start();
  const probe = await start({ email: `owner@${a.id}.test` }); // store A's owner
  eq(probe.res.status, newOne.res.status, "status");
  const keys = (o) => JSON.stringify(Object.keys(o).sort()) + JSON.stringify(Object.keys(o.signup || {}).sort());
  eq(keys(probe.res.body), keys(newOne.res.body), "response keys");
  ok(probe.cookie, "a cookie too");
  const row = await rowFor(`owner@${a.id}.test`);
  eq(row.status, "existing", "existing");
  eq(row.password_hash, null, "no password kept");
  eq(row.code_hash, null, "no code");
  const mail = await mailFor(`owner@${a.id}.test`, "signup_existing");
  ok(mail && /already have an account/i.test(mail.body) && !/\b\d{6}\b/.test(mail.body), "sign-in-or-reset words, no code");
  eq(await mailFor(`owner@${a.id}.test`, "signup_code"), null, "no code mail");
  // every code fails with the same words a wrong code gets
  const v = await api("signup/verify", "POST", { body: { code: "123456" }, cookie: probe.cookie });
  eq(v.status, 400, "existing: status");
  eq(v.body.error, S.CODE_FAILED, "existing: the generic words");
  const r = await api("signup/resend", "POST", { cookie: probe.cookie });
  eq(r.status, 429, "the same resend rule (too soon) as a new email");
});

await t("least-trusted: verify with no cookie or another browser's cookie fails generically and spends none of the victim's tries", async () => {
  const victim = await start();
  const code = await codeFor(victim.f.email);
  const attacker = await start();
  const none = await api("signup/verify", "POST", { body: { code } });
  eq(none.status, 400, "no cookie");
  eq(none.body.error, S.CODE_FAILED, "no cookie: generic");
  const other = await api("signup/verify", "POST", { body: { code }, cookie: attacker.cookie });
  eq(other.status, 400, "another browser");
  eq(other.body.error, S.CODE_FAILED, "another browser: generic");
  const forged = await api("signup/verify", "POST", { body: { code }, cookie: "f".repeat(64) });
  eq(forged.status, 400, "a made-up cookie");
  const row = await rowFor(victim.f.email);
  eq(Number(row.code_attempts), 0, "victim's tries untouched");
  eq(row.status, "pending", "victim still pending");
  const retry = await api("signup/verify", "POST", { body: { retry: true } });
  eq(retry.status, 400, "retry without a cookie");
  const resend = await api("signup/resend", "POST", {});
  eq(resend.status, 400, "resend without a cookie");
});

await t("five wrong codes and the code is dead: the right one then fails with the same words", async () => {
  const s = await start();
  const code = await codeFor(s.f.email);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) eq((await api("signup/verify", "POST", { body: { code: wrong }, cookie: s.cookie })).body.error, S.CODE_FAILED, `wrong ${i + 1}`);
  const right = await api("signup/verify", "POST", { body: { code }, cookie: s.cookie });
  eq(right.status, 400, "dead");
  eq(right.body.error, S.CODE_FAILED, "same words");
  eq((await rowFor(s.f.email)).status, "pending", "nothing created");
});

await t("a code past its 15 minutes fails generically", async () => {
  const s = await start();
  const code = await codeFor(s.f.email);
  await db.execute({ sql: "UPDATE signups SET code_expires_at = ? WHERE email = ?", args: [new Date(Date.now() - 1000).toISOString(), s.f.email] });
  const r = await api("signup/verify", "POST", { body: { code }, cookie: s.cookie });
  eq(r.body.error, S.CODE_FAILED, "expired code");
});

await t("resend: not within 60 s, then a new code (the old one stops working, tries reset), at most 5 sends per signup", async () => {
  const s = await start();
  const first = await codeFor(s.f.email);
  const soon = await api("signup/resend", "POST", { cookie: s.cookie });
  eq(soon.status, 429, "too soon");
  ok(soon.body.retry_after_seconds > 0, "says how long");
  const back = () => db.execute({ sql: "UPDATE signups SET last_sent_at = ? WHERE email = ?", args: [new Date(Date.now() - 61_000).toISOString(), s.f.email] });
  await api("signup/verify", "POST", { body: { code: "999999" === first ? "888888" : "999999" }, cookie: s.cookie });
  await back();
  const again = await api("signup/resend", "POST", { cookie: s.cookie });
  eq(again.status, 200, "resent");
  const second = await codeFor(s.f.email);
  let row = await rowFor(s.f.email);
  eq(Number(row.code_attempts), 0, "tries reset");
  eq(Number(row.sends), 2, "two sends");
  eq(row.code_hash, sha(`${row.id}:${second}`), "a new code stored");
  if (second !== first) eq((await api("signup/verify", "POST", { body: { code: first }, cookie: s.cookie })).body.error, S.CODE_FAILED, "the old code is dead");
  for (let i = 3; i <= 5; i++) {
    await back();
    eq((await api("signup/resend", "POST", { cookie: s.cookie })).status, 200, `send ${i}`);
  }
  await back();
  const sixth = await api("signup/resend", "POST", { cookie: s.cookie });
  eq(sixth.status, 429, "a sixth send is refused");
  row = await rowFor(s.f.email);
  eq(Number(row.sends), 5, "five sends");
});

await t("the same email starting again supersedes its older signup; the older browser's code no longer works", async () => {
  const email = "twice@sgn.test";
  const first = await start({ email });
  const firstCode = await codeFor(email);
  const second = await start({ email });
  const rows = await q("SELECT status FROM signups WHERE email = ? ORDER BY created_at, rowid", [email]);
  eq(rows.map((r) => r.status).join(","), "superseded,pending", "statuses");
  eq((await api("signup/verify", "POST", { body: { code: firstCode }, cookie: first.cookie })).body.error, S.CODE_FAILED, "old signup dead");
  ok(second.cookie !== first.cookie, "a new cookie");
});

await t("expiry: a signup older than 24 hours never makes a user or a store and frees its address; rows older than 7 days are pruned on the next start", async () => {
  const s = await start({ storeName: "Lapsed Label" });
  const code = await codeFor(s.f.email);
  await db.execute({ sql: "UPDATE signups SET expires_at = ? WHERE email = ?", args: [new Date(Date.now() - 1000).toISOString(), s.f.email] });
  eq((await S.slugAvailable("lapsed-label")).ok, true, "address free once lapsed");
  const v = await api("signup/verify", "POST", { body: { code }, cookie: s.cookie });
  eq(v.body.error, S.CODE_FAILED, "verify fails");
  eq((await rowFor(s.f.email)).status, "expired", "marked expired");
  eq(await I.findUserByEmail(s.f.email), null, "no user");
  eq(await C.getTenant("lapsed-label", { fresh: true }), null, "no store");
  // someone else takes the address
  const other = await start({ storeName: "Lapsed Label" });
  eq(other.res.status, 200, "the address is taken again");
  // pruning
  const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  await db.execute({
    sql: "INSERT INTO signups (id, email, name, store_name, slug, browser_hash, status, created_at, updated_at, expires_at) VALUES ('sgn_old0000000000000', 'old@sgn.test', 'Old', 'Old', 'old-one', 'x', 'expired', ?, ?, ?)",
    args: [old, old, old],
  });
  await start();
  eq(await one("SELECT id FROM signups WHERE id = 'sgn_old0000000000000'"), null, "pruned");
});

await t("limits: start 5 per IP an hour, 3 per email an hour, verify 20 per IP in 15 minutes", async () => {
  const ip = "10.77.0.1";
  for (let i = 1; i <= 5; i++) eq((await start({}, { ip })).res.status, 200, `start ${i}`);
  eq((await start({}, { ip })).res.status, 429, "sixth from one IP");
  const email = "limited@sgn.test";
  for (let i = 1; i <= 3; i++) eq((await start({ email })).res.status, 200, `email start ${i}`);
  eq((await start({ email })).res.status, 429, "fourth for one email");
  const vip = "10.77.0.2";
  for (let i = 1; i <= 20; i++) await api("signup/verify", "POST", { body: { code: "000000" }, ip: vip });
  eq((await api("signup/verify", "POST", { body: { code: "000000" }, ip: vip })).status, 429, "21st verify");
});

// --- verify → store, user, owner, handoff ---------------------------------------------

let done; // { body, token, slug, host }
await t("verify: creates the store (file database, documents mode, closed, Free plan, signup source), the user and the owner; clears the password hash", async () => {
  const code = await codeFor(main.f.email);
  const r = await api("signup/verify", "POST", { body: { code }, cookie: main.cookie });
  eq(r.status, 200, `status ${r.text}`);
  eq(r.body.status, "done", "done");
  const m = String(r.body.redirect).match(/^http:\/\/happy-path-goods\.stores\.test\/admin\/handoff#t=([0-9a-f]{64})$/);
  ok(m, `redirect ${r.body.redirect}`);
  done = { token: m[1], slug: "happy-path-goods", host: "happy-path-goods.stores.test" };
  const tn = await C.getTenant(done.slug, { fresh: true });
  eq(tn.status, "active", "active");
  eq(JSON.stringify(tn.domains), JSON.stringify([done.host]), "domain");
  ok(tn.dbUrl.startsWith("file:") && tn.dbUrl.includes(".test-signup-stores"), `file db ${tn.dbUrl}`);
  eq(tn.config.onboarding?.source, "signup", "onboarding.source");
  eq(tn.config.shopify_store_domain, undefined, "no Shopify domain yet");
  eq(tn.config.site?.name, "Happy Path Goods", "site name");
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: tn.dbUrl });
  eq((await c.execute("SELECT value FROM cms_state WHERE key = 'mode'").catch(async () => c.execute("SELECT * FROM cms_state LIMIT 1"))).rows.length > 0, true, "cms_state present");
  const st = (await c.execute("SELECT * FROM cms_state LIMIT 1")).rows[0];
  c.close();
  ok(JSON.stringify(st).includes("documents"), `documents mode (closed until first publish): ${JSON.stringify(st)}`);
  const { subscriptionFor } = await import("../lib/platform/billing.js");
  eq((await subscriptionFor(done.slug))?.plan_id ?? (await subscriptionFor(done.slug))?.plan, "free", "Free plan");
  const user = await I.findUserByEmail(main.f.email);
  ok(user?.email_verified_at, "email_verified_at");
  ok(await I.verifyPassword(main.f.password, user.password_hash), "the founder's password");
  const { membershipRole } = await import("../lib/platform/sessions.js");
  eq(await membershipRole(user.id, done.slug), "owner", "owner");
  const row = await rowFor(main.f.email);
  eq(row.status, "done", "signup done");
  eq(row.password_hash, null, "password hash cleared");
  eq(row.user_id, user.id, "user recorded");
  eq(row.tenant_id, done.slug, "tenant recorded");
  const run = await P.getProvisionRun(row.provision_run_id);
  eq(run.status, "done", "run done");
  eq(run.params.dbDriver, "file", "run params: driver");
  eq(run.params.source, "signup", "run params: source");
  done.user = user;
});

await t("audit: signup.verified (the new owner) and tenant.provisioned (system/signup, source and run) on the new store", async () => {
  const rows = await q("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY at", [done.slug]);
  const v = rows.find((r) => r.action === "signup.verified");
  ok(v, "signup.verified");
  eq(v.actor, done.user.id, "actor: the owner");
  eq(v.actor_kind, "merchant", "merchant");
  const p = rows.find((r) => r.action === "tenant.provisioned");
  ok(p, "tenant.provisioned");
  eq(`${p.actor_kind}:${p.actor}`, "system:signup", "system actor");
  const diff = JSON.parse(p.diff);
  eq(diff.source, "signup", "diff.source");
  eq(diff.run, (await rowFor(main.f.email)).provision_run_id, "diff.run");
});

await t("least-trusted: a used code can't be replayed (same words), and verify again creates nothing", async () => {
  const code = await codeFor(main.f.email);
  const r = await api("signup/verify", "POST", { body: { code }, cookie: main.cookie });
  eq(r.status, 400, "replay");
  eq(r.body.error, S.CODE_FAILED, "generic");
  eq(Number((await one("SELECT COUNT(*) AS n FROM provision_runs WHERE tenant_id = ?", [done.slug])).n), 1, "one run");
});

await t("least-trusted: a random, malformed or expired handoff token is 400; a merchant session is not a token", async () => {
  const host = done.host;
  for (const token of ["a".repeat(64), "not-a-token", "", undefined]) {
    const r = await store.call("signed-out", "handoff", "POST", { body: { token }, host });
    eq(r.status, 400, `token ${token}`);
    eq(r.setCookie.length, 0, "no cookie");
  }
  const expired = await I.createInvite({ email: main.f.email, tenantId: done.slug, role: "owner", kind: "handoff", ttlMs: -1000 });
  eq((await store.call("signed-out", "handoff", "POST", { body: { token: expired.token }, host })).status, 400, "expired");
  // store A's owner, signed in, posting no token to A's handoff
  eq((await store.call("owner", "handoff", "POST", { body: {} })).status, 400, "a session without a token");
  // an invite token (kind invite) is not a handoff token
  const inv = await I.createInvite({ email: "x@sgn.test", tenantId: done.slug, role: "staff" });
  eq((await store.call("signed-out", "handoff", "POST", { body: { token: inv.token }, host })).status, 400, "an invite token");
});

let ownerSession;
await t("least-trusted: the handoff token on another store's host is 400 and still works once on the right host (session cookie, /admin/onboarding, auth.login audit)", async () => {
  const wrong = await store.call("signed-out", "handoff", "POST", { body: { token: done.token }, host: a.tenant.domains[0] });
  eq(wrong.status, 400, "wrong host");
  const right = await store.call("signed-out", "handoff", "POST", { body: { token: done.token }, host: done.host });
  eq(right.status, 200, `right host ${right.text}`);
  eq(right.body.redirect, "/admin/onboarding", "redirect");
  const sc = right.setCookie.find((c) => c.startsWith("_admin="));
  ok(sc && /HttpOnly/i.test(sc), "merchant session cookie");
  ownerSession = sc.split(";")[0].split("=")[1];
  const login = await one("SELECT * FROM audit_log WHERE tenant_id = ? AND action = 'auth.login' ORDER BY at DESC LIMIT 1", [done.slug]);
  ok(login && JSON.parse(login.diff).method === "handoff" && login.actor === done.user.id, "auth.login {method: handoff}");
  const again = await store.call("signed-out", "handoff", "POST", { body: { token: done.token }, host: done.host });
  eq(again.status, 400, "single use");
});

await t("least-trusted: the new owner gets 401 on another store's admin routes and /api/admin/login, and signs in on their own store", async () => {
  const other = await store.call("x", "audit", "GET", { cookies: { _admin: ownerSession } });
  eq(other.status, 401, "store A's audit with the new owner's session");
  const otherB = await store.call("x", "audit", "GET", { cookies: { _admin: ownerSession }, host: b.tenant.domains[0] });
  eq(otherB.status, 401, "store B too");
  const own = await store.call("x", "audit", "GET", { cookies: { _admin: ownerSession }, host: done.host });
  eq(own.status, 200, `own store ${own.text.slice(0, 120)}`);
  const badLogin = await store.call("signed-out", "login", "POST", { body: { email: main.f.email, password: main.f.password } });
  eq(badLogin.status, 401, "login on store A");
  const goodLogin = await store.call("signed-out", "login", "POST", { body: { email: main.f.email, password: main.f.password }, host: done.host });
  eq(goodLogin.status, 200, `login on the new store ${goodLogin.text}`);
  const memberships = await q("SELECT tenant_id FROM memberships WHERE user_id = ?", [done.user.id]);
  eq(memberships.map((m) => m.tenant_id).join(","), done.slug, "one store only");
});

await t("a failed setup says so in plain words, shows in the provisions list, and Try again resumes the same run (cookie-bound)", async () => {
  const s = await start({ storeName: "Retry Rugs" });
  const code = await codeFor(s.f.email);
  // STORE_DB_DIR is a file, so the database can't be made
  const blocker = join(ROOT, ".test-signup-blocker");
  await writeFile(blocker, "not a folder");
  const keep = process.env.STORE_DB_DIR;
  process.env.STORE_DB_DIR = join(blocker, "inside");
  let r;
  try {
    r = await api("signup/verify", "POST", { body: { code }, cookie: s.cookie });
  } finally {
    process.env.STORE_DB_DIR = keep;
    await rm(blocker, { force: true });
  }
  eq(r.status, 200, "an answer, not a crash");
  eq(r.body.status, "failed", "failed");
  eq(r.body.canRetry, true, "can retry");
  ok(/couldn't finish setting up your store/i.test(r.body.error) && !/ENOTDIR|EEXIST|Error:/.test(r.body.error), `plain words: ${r.body.error}`);
  const row = await rowFor(s.f.email);
  eq(row.status, "failed", "row failed");
  ok(row.provision_run_id, "run recorded");
  const runs = await P.listProvisionRuns({ limit: 50 });
  const listed = runs.find((x) => x.id === row.provision_run_id);
  ok(listed && listed.status === "failed", "in the /platform provisions list as failed");
  eq(await I.findUserByEmail(s.f.email), null, "no user yet");
  // Try again needs this browser
  eq((await api("signup/verify", "POST", { body: { retry: true } })).status, 400, "no cookie");
  const other = await start();
  eq((await api("signup/verify", "POST", { body: { retry: true }, cookie: other.cookie })).status, 400, "another browser's signup is not failed");
  eq((await rowFor(s.f.email)).status, "failed", "still failed");
  const again = await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie });
  eq(again.status, 200, again.text);
  eq(again.body.status, "done", "done on retry");
  const after = await rowFor(s.f.email);
  eq(after.provision_run_id, row.provision_run_id, "the same run resumed");
  eq(Number((await one("SELECT COUNT(*) AS n FROM provision_runs WHERE tenant_id = 'retry-rugs'")).n), 1, "one run");
  ok(await I.findUserByEmail(s.f.email), "user now");
  const doneAgain = await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie });
  eq(doneAgain.body.status, "done", "retry after done just points at sign-in");
  ok(!doneAgain.body.redirect && doneAgain.body.loginUrl, "no second handoff token");
});

// --- platform_mail ----------------------------------------------------------------------

await t("platform_mail: a mocked send keeps the body; a real send nulls it and keeps the provider id; a failed send nulls it too", async () => {
  const mock = await sendPlatformMail({ kind: "signup_code", to: "mock@sgn.test", subject: "s", text: "code 123456", ref: "sgn_x" });
  eq(mock.status, "mock", "mock");
  eq((await one("SELECT body FROM platform_mail WHERE id = ?", [mock.id])).body, "code 123456", "body kept when mocked");
  const realFetch = globalThis.fetch;
  const sent = [];
  process.env.RESEND_API_KEY = "re_test_stand_in";
  try {
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const real = await sendPlatformMail({ kind: "signup_code", to: "real@sgn.test", subject: "s", text: "code 654321", ref: "sgn_y" });
    eq(real.status, "sent", "sent");
    const row = await one("SELECT * FROM platform_mail WHERE id = ?", [real.id]);
    eq(row.body, null, "body nulled after a real send");
    eq(row.provider_id, "re_123", "provider id");
    ok(row.sent_at, "sent_at");
    eq(sent[0].body.text, "code 654321", "the provider got the text");
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "nope" }), { status: 422 });
    const bad = await sendPlatformMail({ kind: "signup_existing", to: "bad@sgn.test", subject: "s", text: "hello", ref: "sgn_z" });
    eq(bad.status, "failed", "failed");
    const brow = await one("SELECT * FROM platform_mail WHERE id = ?", [bad.id]);
    eq(brow.body, null, "body nulled after a failed send");
    eq(brow.error, "nope", "error kept");
  } finally {
    globalThis.fetch = realFetch;
    process.env.RESEND_API_KEY = "";
  }
  let err = null;
  await sendPlatformMail({ kind: "other", to: "x@sgn.test", subject: "s", text: "t" }).catch((e) => (err = e));
  ok(err, "an unknown kind is refused");
});

await t("scripts/support/signup-mail.js reads the newest mocked code, and refuses a non-local database", async () => {
  const { latestSignupCode } = await import("./support/signup-mail.js");
  const s = await start();
  const r = await latestSignupCode({ platformUrl: process.env.PLATFORM_DB_URL, email: s.f.email });
  eq(r?.code, await codeFor(s.f.email), "the code");
  let err = null;
  await latestSignupCode({ platformUrl: "libsql://prod.turso.io", email: s.f.email }).catch((e) => (err = e));
  ok(err, "a hosted URL is refused");
});

await t("guard tables: the signup routes and the handoff exemption are registered", async () => {
  const { SHOPPER_ROUTES } = await import("./support/shopper-routes.js");
  const { EXEMPT_ROUTES } = await import("./support/admin-routes.js");
  for (const [path, cls] of [["signup", "collector"], ["signup/verify", "token"], ["signup/resend", "token"]]) eq(SHOPPER_ROUTES.find((r) => r.path === path)?.class, cls, path);
  ok(EXEMPT_ROUTES.some((r) => r.path === "handoff" && r.method === "POST" && r.kind === "token"), "handoff exempt");
});

// --- review fixes (Line 1 review) ------------------------------------------------------

const count = async (sql, args = []) => Number((await one(sql, args)).n);

await t("migration 0011: signups has indexes on created_at and (status, expires_at)", async () => {
  for (const name of ["idx_signups_created", "idx_signups_status_expires"]) ok(await one("SELECT name FROM sqlite_master WHERE type='index' AND name = ?", [name]), name);
  const live = await one("SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_signups_slug_live'");
  ok(/'existing'/.test(live.sql), "the live-slug index holds 'existing' too");
});

await t("least-trusted (fix 1): an existing-email signup holds its address exactly like a new-email signup", async () => {
  const fresh = await start({ storeName: "Hold New Label" });
  const probe = await start({ email: `owner@${b.id}.test`, storeName: "Hold Old Label" });
  eq(fresh.res.status, 200, "new: started");
  eq(probe.res.status, 200, "existing: started");
  eq((await rowFor(`owner@${b.id}.test`)).status, "existing", "the probe row is 'existing'");
  const g1 = await api("signup", "GET", { query: "slug=hold-new-label" });
  const g2 = await api("signup", "GET", { query: "slug=hold-old-label" });
  const strip = (x) => JSON.stringify({ ...x.body, slug: 0, address: 0 });
  eq(g1.body.available, false, "new: held");
  eq(strip(g2), strip(g1), "GET ?slug= answers the same");
  const s1 = await start({ storeName: "Hold New Label" });
  const s2 = await start({ storeName: "Hold Old Label" });
  eq(s1.res.status, 422, "new: a second signup is refused");
  eq(s2.res.status, s1.res.status, "existing: the same status");
  eq(JSON.stringify(s2.res.body), JSON.stringify(s1.res.body), "the same answer");
});

await t("fix 2: two verifies with the right code at once make exactly one store, one user and one owner membership", async () => {
  const s = await start({ storeName: "Twin Click Co" });
  const code = await codeFor(s.f.email);
  const rs = await Promise.all([1, 2].map(() => api("signup/verify", "POST", { body: { code }, cookie: s.cookie })));
  eq(rs.filter((r) => r.body?.status === "done").length, 1, `one done: ${rs.map((r) => r.text).join(" | ")}`);
  eq(await count("SELECT COUNT(*) AS n FROM tenants WHERE id = 'twin-click-co'"), 1, "one store");
  eq(await count("SELECT COUNT(*) AS n FROM users WHERE email = ?", [s.f.email]), 1, "one user");
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'twin-click-co' AND role = 'owner'"), 1, "one owner");
  eq(await count("SELECT COUNT(*) AS n FROM provision_runs WHERE tenant_id = 'twin-click-co'"), 1, "one run");
});

await t("fix 2: a failure during account creation (after the store is made), then Try again: one user, one membership, done", async () => {
  const s = await start({ storeName: "Fault Line Goods" });
  const code = await codeFor(s.f.email);
  await db.execute("CREATE TRIGGER sgn_fault BEFORE INSERT ON memberships WHEN NEW.tenant_id = 'fault-line-goods' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  let r;
  try {
    r = await api("signup/verify", "POST", { body: { code }, cookie: s.cookie });
  } finally {
    await db.execute("DROP TRIGGER IF EXISTS sgn_fault");
  }
  eq(r.body.status, "failed", r.text);
  ok(await C.getTenant("fault-line-goods", { fresh: true }), "the store was made");
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'fault-line-goods'"), 0, "no membership yet");
  const again = await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie });
  eq(again.body.status, "done", again.text);
  eq(await count("SELECT COUNT(*) AS n FROM users WHERE email = ?", [s.f.email]), 1, "one user");
  eq(await count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = 'fault-line-goods' AND role = 'owner'"), 1, "one owner membership");
  eq((await rowFor(s.f.email)).status, "done", "signup done");
});

await t("fix 3: after 10 failed code tries in a day for an email, new signups, resends and verifies answer the same and send nothing", async () => {
  const email = "capped@sgn.test";
  for (let i = 0; i < 2; i++) {
    const s = await start({ email });
    for (let k = 0; k < 5; k++) eq((await api("signup/verify", "POST", { body: { code: "000000" }, cookie: s.cookie })).body.error, S.CODE_FAILED, "wrong code");
  }
  const mails = await count("SELECT COUNT(*) AS n FROM platform_mail WHERE recipient = ?", [email]);
  const capped = await start({ email });
  const normal = await start();
  eq(capped.res.status, normal.res.status, "start: the same status");
  eq(JSON.stringify(Object.keys(capped.res.body).sort()), JSON.stringify(Object.keys(normal.res.body).sort()), "start: the same keys");
  ok(capped.cookie, "start: a cookie too");
  eq(await count("SELECT COUNT(*) AS n FROM platform_mail WHERE recipient = ?", [email]), mails, "start: nothing sent");
  eq((await rowFor(email)).code_hash, null, "no code stored");
  const v = await api("signup/verify", "POST", { body: { code: "123456" }, cookie: capped.cookie });
  eq(v.status, 400, "verify: status");
  eq(v.body.error, S.CODE_FAILED, "verify: the generic words");
  await db.execute({ sql: "UPDATE signups SET last_sent_at = ? WHERE email IN (?, ?)", args: [new Date(Date.now() - 120_000).toISOString(), email, normal.f.email] });
  const rc = await api("signup/resend", "POST", { cookie: capped.cookie });
  const rn = await api("signup/resend", "POST", { cookie: normal.cookie });
  eq(rc.status, rn.status, "resend: the same status");
  eq(JSON.stringify(Object.keys(rc.body).sort()), JSON.stringify(Object.keys(rn.body).sort()), "resend: the same keys");
  eq(await count("SELECT COUNT(*) AS n FROM platform_mail WHERE recipient = ?", [email]), mails, "resend: nothing sent");
  // a right code on an email that reaches the cap stops working too
  const late = await start();
  const code = await codeFor(late.f.email);
  for (let k = 0; k < 10; k++) await I.loginThrottle(S.codeFailKey(late.f.email), S.LIMITS.codeFailsPerEmail);
  eq((await api("signup/verify", "POST", { body: { code }, cookie: late.cookie })).body.error, S.CODE_FAILED, "a capped email's right code fails generically");
  eq(await I.findUserByEmail(late.f.email), null, "no user");
});

await t("fix 4: in production with mail not configured, signups are closed and no code is stored or printed", async () => {
  const keepEnv = process.env.NODE_ENV;
  const keepLog = console.log;
  const logs = [];
  process.env.NODE_ENV = "production";
  process.env.RESEND_API_KEY = "";
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const f = form();
    const r = await api("signup", "POST", { body: f });
    eq(r.status, 403, r.text);
    eq(r.body.code, "SIGNUPS_CLOSED", "closed");
    eq((await api("signup", "GET", { query: "slug=prod-closed" })).body.code, "SIGNUPS_CLOSED", "GET closed too");
    eq(await rowFor(f.email), null, "no signup row");
    eq(await mailFor(f.email), null, "no mail row");
    const m = await sendPlatformMail({ kind: "signup_code", to: "prod@sgn.test", subject: "s", text: "code 112233", ref: "sgn_p" });
    eq(m.status, "failed", "not a mock in production");
    eq((await one("SELECT body FROM platform_mail WHERE id = ?", [m.id])).body, null, "no body kept");
    const { sendMail } = await import("../lib/mail.js");
    eq((await sendMail({ to: "prod@sgn.test", subject: "s", text: "code 445566" })).ok, false, "sendMail refuses");
    ok(!logs.join("\n").includes("112233") && !logs.join("\n").includes("445566"), "no code printed");
  } finally {
    console.log = keepLog;
    if (keepEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = keepEnv;
  }
});

await t("fix 4: the body is stored only once the send is known to be a mock (none while a real send is in flight)", async () => {
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test_stand_in";
  let during = "unset";
  try {
    globalThis.fetch = async () => {
      during = (await one("SELECT body FROM platform_mail WHERE recipient = 'during@sgn.test'"))?.body;
      return new Response(JSON.stringify({ id: "re_9" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await sendPlatformMail({ kind: "signup_code", to: "during@sgn.test", subject: "s", text: "code 778899", ref: "sgn_d" });
  } finally {
    globalThis.fetch = realFetch;
    process.env.RESEND_API_KEY = "";
  }
  eq(during, null, "no body at rest during the send");
});

await t("fix 5: pruning deletes only done, expired and superseded rows older than 7 days", async () => {
  const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  const statuses = ["done", "expired", "superseded", "failed", "verified", "provisioning"];
  for (const st of statuses) {
    await db.execute({
      sql: "INSERT INTO signups (id, email, name, store_name, slug, browser_hash, status, created_at, updated_at, expires_at) VALUES (?, 'prune@sgn.test', 'P', 'P', ?, 'x', ?, ?, ?, ?)",
      args: [`sgn_prune_${st}`, `prune-${st}`, st, old, old, old],
    });
  }
  await start();
  const left = (await q("SELECT status FROM signups WHERE id LIKE 'sgn_prune_%'")).map((r) => r.status).sort();
  eq(JSON.stringify(left), JSON.stringify(["failed", "provisioning", "verified"]), "kept");
});

await t("fix 5: the file driver refuses a leftover database file unless the run is resuming its own", async () => {
  const r1 = await PV.createStoreDatabase("pv-left", "file");
  await writeFile(r1.dbUrl.slice(5), "");
  let err = null;
  await PV.createStoreDatabase("pv-left", "file").catch((e) => (err = e));
  ok(err && /already/i.test(err.message), `refused: ${err?.message}`);
  eq((await PV.createStoreDatabase("pv-left", "file", { resumeUrl: r1.dbUrl })).created, false, "its own run adopts it");
  // through signup: a leftover file for the address fails the setup instead of being reused
  await writeFile(join(STORE_DIR, "storeasy-t-leftover-loft.db"), "");
  const s = await start({ storeName: "Leftover Loft" });
  const v = await api("signup/verify", "POST", { body: { code: await codeFor(s.f.email) }, cookie: s.cookie });
  eq(v.body.status, "failed", v.text);
  eq(await C.getTenant("leftover-loft", { fresh: true }), null, "no store on the leftover file");
});

await t("fix 6: a failed, verified or provisioning signup a day past its expiry loses its password hash, and Try again says start again", async () => {
  const s = await start({ storeName: "Stale Studio" });
  const recent = await start({ storeName: "Recent Studio" });
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  await db.execute({ sql: "UPDATE signups SET status = 'failed', expires_at = ? WHERE email = ?", args: [at(25), s.f.email] });
  await db.execute({ sql: "UPDATE signups SET status = 'failed', expires_at = ? WHERE email = ?", args: [at(1), recent.f.email] });
  await start();
  eq((await rowFor(s.f.email)).password_hash, null, "cleared a day past expiry");
  ok((await rowFor(recent.f.email)).password_hash, "kept inside the day");
  const r = await api("signup/verify", "POST", { body: { retry: true }, cookie: s.cookie });
  eq(r.status, 400, r.text);
  eq(r.body.error, S.SIGNUP_LAPSED, "start-again words");
  eq(await I.findUserByEmail(s.f.email), null, "no user");
});

await t("fix 7: addresses can't start with xn-- or hold --, and the new reserved words are reserved", async () => {
  for (const s of ["xn--abc", "ab--cd", "a--b"]) eq((await S.slugAvailable(s)).reason, "format", s);
  ok(S.validateSignup({ ...form(), slug: "xn--shop" }).errors.slug, "validation refuses xn--");
  for (const w of ["login", "billing", "support", "security", "account", "accounts", "checkout", "cdn", "assets", "static", "docs", "blog", "shop", "store", "stores"]) {
    eq((await S.slugAvailable(w)).reason, "reserved", w);
  }
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

await store.cleanup();
await rm(STORE_DIR, { recursive: true, force: true });
for (const f of ["default"]) for (const ext of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `.test-sgn-${f}.db${ext}`), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
