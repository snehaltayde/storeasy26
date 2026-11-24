// Turso Platform API client suite (Phase 1 line 2, docs/plans/phase-1.md §1 items
// 8–10 and 13, §6 items 2, 10 and 12). Every call goes to the local fake
// (scripts/support/fake-turso-api.js); a fetch guard fails on any host that is
// not loopback, and the real check is only run on its refusal and --dry-run
// paths, with made-up credentials and a guard that blocks every fetch.
//   pnpm test:turso-api
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import { loopbackFetchGuard, startFakeTursoApi } from "./support/fake-turso-api.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = loopbackFetchGuard();
for (const k of ["TURSO_API_URL", "TURSO_API_TOKEN", "TURSO_ORG", "TURSO_GROUP", "TURSO_REAL_CHECK", "VERCEL"]) delete process.env[k];
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
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const throwsWith = (fn, re, label) => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  ok(err && re.test(err.message), `${label}: ${err?.message ?? "no error"}`);
};

const A = await import("../lib/platform/turso-api.js");
const TMP = mkdtempSync(join(tmpdir(), "storeasy-turso-api-"));
const API_TOKEN = `fake-api-${Math.random().toString(36).slice(2)}-secret`;
const fake = await startFakeTursoApi({ token: API_TOKEN, org: "acme", dataDir: TMP, backend: "file" });
const env = { TURSO_API_URL: fake.url, TURSO_API_TOKEN: API_TOKEN, TURSO_ORG: "acme", TURSO_GROUP: "default" };
const caught = async (p) => p.then(() => null, (e) => e);

await t("address rule: the default is https://api.turso.tech; production refuses any other value; elsewhere a non-default value must be loopback", () => {
  eq(A.DEFAULT_TURSO_API_URL, "https://api.turso.tech", "default");
  eq(A.tursoApiBase({}), "https://api.turso.tech", "unset");
  eq(A.tursoApiBase({ TURSO_API_URL: "  " }), "https://api.turso.tech", "blank");
  eq(A.tursoApiBase({ NODE_ENV: "production" }), "https://api.turso.tech", "production default");
  eq(A.tursoApiBase({ NODE_ENV: "production", TURSO_API_URL: "https://api.turso.tech/" }), "https://api.turso.tech", "production, the default spelled with a slash");
  throwsWith(() => A.tursoApiBase({ NODE_ENV: "production", TURSO_API_URL: "http://127.0.0.1:9" }), /production/i, "production + loopback");
  throwsWith(() => A.tursoApiBase({ VERCEL: "1", TURSO_API_URL: "http://127.0.0.1:9" }), /production|Vercel/i, "Vercel + loopback");
  for (const u of ["http://127.0.0.1:18020", "http://localhost:9", "http://[::1]:9"]) eq(A.tursoApiBase({ TURSO_API_URL: u }), u, u);
  for (const u of ["https://evil.example", "http://10.0.0.1:80", "http://127.0.0.1.nip.io:80", "http://user@evil.example", "ftp://127.0.0.1", "not a url", "http://169.254.169.254"]) {
    throwsWith(() => A.tursoApiBase({ TURSO_API_URL: u }), /loopback|TURSO_API_URL/i, u);
  }
  ok(A.tursoApiConfigured(env) && !A.tursoApiConfigured({ TURSO_API_TOKEN: "x" }) && !A.tursoApiConfigured({ TURSO_ORG: "x" }), "configured needs both");
});

await t("errors are sorted: 400/401/402/403 need an operator, 404 not found, 409 conflict, 429 and 5xx retry; Retry-After in seconds or a date, capped at 10 minutes", () => {
  for (const s of [400, 401, 402, 403, 418]) eq(A.classifyStatus(s), "needs_operator", String(s));
  eq(A.classifyStatus(404), "not_found", "404");
  eq(A.classifyStatus(409), "conflict", "409");
  for (const s of [429, 500, 502, 503, 504]) eq(A.classifyStatus(s), "retry", String(s));
  eq(A.retryAfterMs("30"), 30_000, "seconds");
  eq(A.retryAfterMs("99999"), 600_000, "capped");
  eq(A.retryAfterMs(new Date(Date.now() + 120_000).toUTCString()) > 100_000, true, "a date");
  eq(A.retryAfterMs(null), null, "none");
  eq(A.retryAfterMs("soon"), null, "junk");
});

await t("secrets are scrubbed: Bearer values, JWT-looking strings and named secrets", () => {
  const jwt = "eyJhbGciOiJFZERTQSJ9.eyJhIjoiYiJ9.c2lnbmF0dXJlLXBhcnQ";
  const s = A.scrubSecrets(`Authorization: Bearer abc.def-123 failed; token ${jwt}; key ${API_TOKEN}`, [API_TOKEN]);
  ok(!s.includes("abc.def-123") && !s.includes(jwt) && !s.includes(API_TOKEN), s);
  ok(/\[redacted\]/.test(s), "marked");
  eq(A.scrubSecrets(null), "", "null");
});

await t("create, retrieve and mint through the fake: Turso's reply shapes; a 1-hour full-access token opens the new database, no token is refused", async () => {
  const api = A.tursoApi(env);
  const made = await api.createDatabase("storeasy-t-alpha");
  ok(made.DbId && made.Name === "storeasy-t-alpha" && made.Hostname === "storeasy-t-alpha-acme.turso.io", JSON.stringify(made));
  const got = await api.getDatabase("storeasy-t-alpha");
  eq(got.Name, "storeasy-t-alpha", "retrieve");
  const jwt = await api.mintToken("storeasy-t-alpha", { expiration: "1h" });
  ok(/^eyJ/.test(jwt), "a jwt");
  const minted = fake.state.minted.at(-1);
  eq(minted.expiration, "1h", "asked for 1 hour");
  const url = api.dbUrlFor(got);
  ok(url.startsWith("http://127.0.0.1:"), `the fake's local address ${url}`);
  const c = createClient({ url, authToken: jwt });
  eq(Number((await c.execute("select 1 as one")).rows[0].one), 1, "opens");
  c.close();
  const bare = createClient({ url });
  ok(await caught(bare.execute("select 1")), "no token: refused");
  bare.close();
  const tokenReq = fake.state.log.filter((l) => l.route === "token").at(-1);
  eq(tokenReq.status, 200, "token call logged");
});

await t("needs-operator and conflict answers: a wrong API token is 401, a bad group 400, an existing name 409, an unknown database 404; no secret in the message", async () => {
  const wrong = await caught(A.tursoApi({ ...env, TURSO_API_TOKEN: "not-the-token" }).getDatabase("storeasy-t-alpha"));
  ok(wrong instanceof A.TursoApiError, "typed");
  eq(`${wrong.kind}:${wrong.status}`, "needs_operator:401", "401");
  ok(!wrong.message.includes("not-the-token"), wrong.message);
  const group = await caught(A.tursoApi({ ...env, TURSO_GROUP: "nope" }).createDatabase("storeasy-t-beta"));
  eq(`${group.kind}:${group.status}`, "needs_operator:400", "group");
  const dup = await caught(A.tursoApi(env).createDatabase("storeasy-t-alpha"));
  eq(`${dup.kind}:${dup.status}`, "conflict:409", "409");
  const gone = await caught(A.tursoApi(env).getDatabase("storeasy-t-missing"));
  eq(`${gone.kind}:${gone.status}`, "not_found:404", "404");
  for (const e of [wrong, group, dup, gone]) ok(!e.message.includes(API_TOKEN), `no API token in ${e.message}`);
});

await t("faults: 503 retries, 429 carries Retry-After, 402 needs an operator, a slow answer times out as a retry", async () => {
  const api = A.tursoApi(env);
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ route: "get", status: 503 }) });
  eq((await caught(api.getDatabase("storeasy-t-alpha"))).kind, "retry", "503");
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ route: "get", status: 429, retryAfter: 30 }) });
  const limited = await caught(api.getDatabase("storeasy-t-alpha"));
  eq(`${limited.kind}:${limited.retryAfterMs}`, "retry:30000", "429");
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ route: "create", status: 402 }) });
  eq((await caught(api.createDatabase("storeasy-t-gamma"))).kind, "needs_operator", "402");
  const keep = A.tursoApiTiming.timeoutMs;
  A.tursoApiTiming.timeoutMs = 200;
  try {
    await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ route: "get", delayMs: 1000 }) });
    const slow = await caught(api.getDatabase("storeasy-t-alpha"));
    eq(`${slow.kind}:${slow.status}`, "retry:null", "timeout");
    ok(/time/i.test(slow.message), slow.message);
  } finally {
    A.tursoApiTiming.timeoutMs = keep;
  }
  eq((await api.getDatabase("storeasy-t-alpha")).Name, "storeasy-t-alpha", "faults spent");
});

await t("a create that commits then hangs times out as a retry, and the database is there afterwards (one database)", async () => {
  const api = A.tursoApi(env);
  const keep = A.tursoApiTiming.timeoutMs;
  A.tursoApiTiming.timeoutMs = 200;
  try {
    await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ route: "create", commitThenHang: true, delayMs: 2000 }) });
    eq((await caught(api.createDatabase("storeasy-t-hang"))).kind, "retry", "timed out");
  } finally {
    A.tursoApiTiming.timeoutMs = keep;
  }
  eq((await api.getDatabase("storeasy-t-hang")).Name, "storeasy-t-hang", "made anyway");
  eq((await caught(api.createDatabase("storeasy-t-hang"))).kind, "conflict", "a second create is a 409");
});

await t("the fake's localUrl is honoured only for a loopback API address and a loopback (or file) database address", () => {
  const d = { Hostname: "x-acme.turso.io", localUrl: "http://127.0.0.1:5000" };
  eq(A.tursoApi(env).dbUrlFor(d), "http://127.0.0.1:5000", "loopback API + loopback db");
  eq(A.tursoApi({ ...env, TURSO_API_URL: "" }).dbUrlFor(d), "libsql://x-acme.turso.io", "the real API address never honours it");
  eq(A.tursoApi(env).dbUrlFor({ ...d, localUrl: "http://evil.example:5000" }), "libsql://x-acme.turso.io", "a non-loopback localUrl is ignored");
  eq(A.tursoApi(env).dbUrlFor({ ...d, localUrl: "libsql://evil.example" }), "libsql://x-acme.turso.io", "other schemes ignored");
  eq(A.tursoApi(env).dbUrlFor({ Hostname: "x-acme.turso.io" }), "libsql://x-acme.turso.io", "no localUrl");
});

await t("delete through the fake: the database is gone (404 after)", async () => {
  const api = A.tursoApi(env);
  await api.deleteDatabase("storeasy-t-hang");
  eq((await caught(api.getDatabase("storeasy-t-hang"))).kind, "not_found", "gone");
});

await t("with no TURSO_API_URL the client would call api.turso.tech, and the guard stops it (the only blocked call in this suite)", async () => {
  const e = await caught(A.tursoApi({ ...env, TURSO_API_URL: "" }).getDatabase("storeasy-t-alpha"));
  eq(e?.kind, "retry", "a network error is a retry");
  eq(guard.blocked.length, 1, `blocked: ${guard.blocked.join(", ")}`);
  ok(guard.blocked[0].startsWith("https://api.turso.tech/v1/organizations/acme/"), guard.blocked[0]);
  guard.blocked.length = 0;
});

// --- the opt-in real check: refusals and --dry-run only ---------------------------
const BLOCK_ALL = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async (u) => { console.error('BLOCKED ' + String(u?.url ?? u)); process.exit(97); };")}`;
const realCheck = (args, extraEnv = {}) => {
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  const r = spawnSync(process.execPath, ["--import", BLOCK_ALL, join(ROOT, "scripts/turso-real-check.js"), ...args], { cwd: ROOT, env: childEnv, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};
const CONSENT = { TURSO_REAL_CHECK: "yes-i-accept-a-real-database" };
const CREDS = { TURSO_API_TOKEN: "made-up-real-check-token", TURSO_ORG: "made-up-org" };

await t("real check: refuses without TURSO_REAL_CHECK, without --create-one-database, without the token and org, and with a non-default address; never calls out", () => {
  const cases = [
    [[], { ...CREDS }, /TURSO_REAL_CHECK/],
    [["--create-one-database"], { ...CREDS, TURSO_REAL_CHECK: "yes" }, /TURSO_REAL_CHECK/],
    [[], { ...CREDS, ...CONSENT }, /--create-one-database/],
    [["--create-one-database"], { ...CONSENT }, /TURSO_API_TOKEN|TURSO_ORG/],
    [["--create-one-database"], { ...CONSENT, TURSO_API_TOKEN: "x" }, /TURSO_ORG/],
    [["--create-one-database"], { ...CREDS, ...CONSENT, TURSO_API_URL: "http://127.0.0.1:9" }, /default Turso address|TURSO_API_URL/],
    [["--create-one-database"], { ...CREDS, ...CONSENT, TURSO_API_URL: "https://evil.example" }, /default Turso address|TURSO_API_URL/],
  ];
  for (const [args, e, re] of cases) {
    const r = realCheck(args, e);
    ok(r.code !== 0 && r.code !== 97, `${JSON.stringify(args)} ${Object.keys(e)}: exit ${r.code}`);
    ok(re.test(r.out), `${re}: ${r.out}`);
    ok(!r.out.includes("made-up-real-check-token"), "never prints the token");
    ok(!/BLOCKED/.test(r.out), "no network");
  }
});

await t("real check: --dry-run with every gate open says what it would do (one storeasy-check-<6hex> database, a 1-hour token, the schema, delete) and calls nothing", () => {
  const r = realCheck(["--create-one-database", "--dry-run"], { ...CREDS, ...CONSENT });
  eq(r.code, 0, r.out);
  ok(/storeasy-check-[0-9a-f]{6}/.test(r.out), r.out);
  ok(/1-hour|1h/i.test(r.out) && /delete/i.test(r.out) && /dry run/i.test(r.out), r.out);
  ok(!r.out.includes("made-up-real-check-token") && !/BLOCKED/.test(r.out), "no token, no network");
  const keep = realCheck(["--create-one-database", "--dry-run", "--keep"], { ...CREDS, ...CONSENT });
  ok(/keep/i.test(keep.out) && keep.code === 0, keep.out);
});

await t("check:turso-real is not a test:* script, so pnpm test never runs it", async () => {
  const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(join(ROOT, "package.json"), "utf8"));
  eq(pkg.scripts["check:turso-real"], "node scripts/turso-real-check.js", "the script");
  ok(!Object.entries(pkg.scripts).some(([k, v]) => k.startsWith("test:") && /turso-real-check/.test(v)), "no test:* runs it");
});

await t("no call left this machine", () => {
  eq(guard.blocked.length, 0, guard.blocked.join(", "));
});

await fake.close();
guard.restore();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
