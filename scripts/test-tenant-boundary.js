// Tenant-boundary suite (Session 25 / BE01+SF23+SF08): fail-closed host
// resolution, control-plane outage behavior, ops gates, and the order-token
// scheme — with TWO UNRELATED TENANT FIXTURES SHARING AN OVERLAPPING HANDLE.
//   pnpm test:tenant-boundary
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// --- env BEFORE imports (modules read env at call time, but be safe) --------
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-boundary-default.db";
const GOOD_PLATFORM_URL = "file:.test-boundary-platform.db";
const BROKEN_PLATFORM_URL = "file:/nonexistent-dir-storeasy-xyz/platform.db";
process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50"; // fast TTL
process.env.PLATFORM_STALE_MS = "400"; // small outage budget

const dbs = [
  ".test-boundary-default.db",
  ".test-boundary-platform.db",
  ".test-boundary-alpha.db",
  ".test-boundary-beta.db",
];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const OPS = await import("../lib/platform/ops.js");
const { withTenant, tenantId } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const { getProductByHandle } = await import("../lib/repo.js");
const { orderStatusToken, verifyOrderStatusToken, orderConfirmationPath } = await import("../lib/orders.js");
const { GATE, isGated } = await import("../lib/tenant-gate.js");

// --- tiny harness ------------------------------------------------------------
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixtures: two UNRELATED tenants, OVERLAPPING handle ---------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({
  id: "alpha",
  name: "Alpha Apparel",
  domains: ["alpha.test"],
  dbUrl: "file:.test-boundary-alpha.db",
  config: {},
  secrets: { order_link_secret: "alpha-link-secret" },
});
await C.upsertTenant({
  id: "beta",
  name: "Beta Botanicals",
  domains: ["beta.test"],
  dbUrl: "file:.test-boundary-beta.db",
  config: {},
  secrets: { order_link_secret: "beta-link-secret" },
});
const ALPHA = await C.getTenant("alpha");
const BETA = await C.getTenant("beta");

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await withTenant(ALPHA, () => libsql.executeMultiple(schema));
await withTenant(BETA, () => libsql.executeMultiple(schema));
const seed = (title, price) =>
  libsql.execute({
    sql: "INSERT INTO products (id, handle, title, price_min, price_max, currency, available) VALUES (?, ?, ?, ?, ?, ?, 1)",
    args: [`gid://shopify/Product/${title}`, "signature-tee", title, price, price, "INR"],
  });
await withTenant(ALPHA, () => seed("Alpha Signature Tee", 999));
await withTenant(BETA, () => seed("Beta Signature Tee", 1499));

// --- A. resolution outcomes --------------------------------------------------
await t("legacy mode: no PLATFORM_DB_URL → outcome legacy, env-default context works", async () => {
  process.env.PLATFORM_DB_URL = "";
  const r = await C.resolveHost("anything.test");
  eq(r.outcome, "legacy", "outcome");
  eq(r.tenant, null, "tenant");
  eq(await withTenant(null, () => tenantId()), "_default", "default context label");
  process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
  C.__resetPlatformClient();
});

await t("resolved: active tenant for a known host (secrets decrypted)", async () => {
  const r = await C.resolveHost("alpha.test");
  eq(r.outcome, "resolved", "outcome");
  eq(r.tenant?.id, "alpha", "tenant id");
  eq(r.name, "Alpha Apparel", "name");
  eq(r.tenant?.secrets?.order_link_secret, "alpha-link-secret", "decrypted secret");
});

await t("host matching: case-insensitive, port-stripped", async () => {
  const r = await C.resolveHost("ALPHA.test:443");
  eq(r.outcome, "resolved", "outcome");
  eq(r.tenant?.id, "alpha", "tenant id");
});

await t("unknown host: fail closed (and compat wrapper returns null)", async () => {
  const r = await C.resolveHost("ghost.test");
  eq(r.outcome, "unknown", "outcome");
  eq(r.tenant, null, "tenant");
  eq(await C.getTenantByHost("ghost.test"), null, "compat wrapper");
});

await t("missing host in platform mode: unknown", async () => {
  eq((await C.resolveHost(null)).outcome, "unknown", "null host");
  eq((await C.resolveHost("")).outcome, "unknown", "empty host");
});

await t("OVERLAPPING HANDLE isolation: same handle, each host gets its own product", async () => {
  const a = await withTenant((await C.resolveHost("alpha.test")).tenant, () => getProductByHandle("signature-tee"));
  const b = await withTenant((await C.resolveHost("beta.test")).tenant, () => getProductByHandle("signature-tee"));
  eq(a.title, "Alpha Signature Tee", "alpha title");
  eq(b.title, "Beta Signature Tee", "beta title");
  eq(a.priceMin ?? a.price_min, 999, "alpha price");
  eq(b.priceMin ?? b.price_min, 1499, "beta price");
});

await t("suspended ≠ unknown: suspended host carries the control-plane name", async () => {
  await C.patchTenant("beta", { status: "suspended" });
  const r = await C.resolveHost("beta.test");
  eq(r.outcome, "suspended", "outcome");
  eq(r.tenant, null, "tenant withheld");
  eq(r.name, "Beta Botanicals", "display name");
  eq(await C.getTenantByHost("beta.test"), null, "compat wrapper");
  eq((await C.resolveHost("ghost.test")).outcome, "unknown", "unknown stays unknown");
});

await t("reactivation round-trip resolves again", async () => {
  await C.patchTenant("beta", { status: "active" });
  eq((await C.resolveHost("beta.test")).outcome, "resolved", "outcome");
});

// --- B. control-plane failure ------------------------------------------------
await t("cold control-plane failure: unavailable (never throws, never legacy)", async () => {
  process.env.PLATFORM_DB_URL = BROKEN_PLATFORM_URL;
  C.__resetPlatformClient();
  const r = await C.resolveHost("alpha.test");
  eq(r.outcome, "unavailable", "outcome");
  eq(r.tenant, null, "tenant");
});

await t("warm outage: stale snapshot serves within PLATFORM_STALE_MS", async () => {
  process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
  C.__resetPlatformClient();
  eq((await C.resolveHost("alpha.test")).outcome, "resolved", "prime");
  process.env.PLATFORM_DB_URL = BROKEN_PLATFORM_URL;
  C.__resetPlatformClient({ preserveCaches: true });
  await sleep(80); // past PLATFORM_CACHE_MS → refresh attempt fails → stale path
  const r = await C.resolveHost("alpha.test");
  eq(r.outcome, "resolved", "stale-if-fresh");
  eq(r.tenant?.id, "alpha", "tenant id");
});

await t("warm outage: unknown host stays unknown (no fallback)", async () => {
  eq((await C.resolveHost("ghost.test")).outcome, "unknown", "outcome");
});

await t("outage past PLATFORM_STALE_MS: unavailable, never legacy/env", async () => {
  await sleep(420); // past the 400ms stale budget
  const r = await C.resolveHost("alpha.test");
  eq(r.outcome, "unavailable", "outcome");
  eq(r.tenant, null, "tenant");
});

await t("recovery: control plane back → resolves again", async () => {
  process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
  C.__resetPlatformClient();
  eq((await C.resolveHost("alpha.test")).outcome, "resolved", "outcome");
});

// --- C. gate mapping (what tenantHandler/pages enforce) ----------------------
await t("GATE: exact status/code per outcome; legacy/resolved not gated", async () => {
  eq(GATE.unknown.status, 404, "unknown status");
  eq(GATE.unknown.code, "TENANT_UNKNOWN", "unknown code");
  eq(GATE.suspended.status, 503, "suspended status");
  eq(GATE.suspended.code, "TENANT_SUSPENDED", "suspended code");
  eq(GATE.unavailable.status, 503, "unavailable status");
  eq(GATE.unavailable.code, "CONTROL_PLANE_UNAVAILABLE", "unavailable code");
  ok(GATE.unavailable.retryAfter, "unavailable retryAfter");
  eq(isGated({ outcome: "legacy" }), false, "legacy not gated");
  eq(isGated({ outcome: "resolved" }), false, "resolved not gated");
  eq(isGated({ outcome: "unknown" }), true, "unknown gated");
  eq(isGated(null), false, "null not gated");
});

// --- D. ops gates --------------------------------------------------------------
await t("runAsTenant rejects a suspended tenant (fn never runs)", async () => {
  await C.patchTenant("beta", { status: "suspended" });
  let ran = false;
  let threw = null;
  try {
    await OPS.runAsTenant("beta", () => {
      ran = true;
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && /suspended/.test(threw.message), "throws with status");
  eq(ran, false, "fn not run");
});

await t("runAsTenant allowSuspended override enters the tenant", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    eq(await OPS.runAsTenant("beta", () => tenantId(), { allowSuspended: true }), "beta", "tenant id");
  } finally {
    console.warn = warn;
  }
});

await t("forEachActiveTenant: control-plane failure → one _platform failure row, fn not run", async () => {
  process.env.PLATFORM_DB_URL = BROKEN_PLATFORM_URL;
  C.__resetPlatformClient();
  let ran = false;
  const res = await OPS.forEachActiveTenant(() => {
    ran = true;
  });
  eq(res.length, 1, "one row");
  eq(res[0].tenant, "_platform", "row label");
  eq(res[0].ok, false, "failed");
  ok(/control plane unavailable/.test(res[0].error), "error text");
  eq(ran, false, "fn not run");
  process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
  C.__resetPlatformClient();
});

await t("forEachActiveTenant: configured + zero active tenants → [] (no default run)", async () => {
  await C.patchTenant("alpha", { status: "suspended" }); // beta already suspended
  let ran = false;
  const res = await OPS.forEachActiveTenant(() => {
    ran = true;
  });
  eq(res.length, 0, "empty results");
  eq(ran, false, "fn not run");
  await C.patchTenant("alpha", { status: "active" });
  await C.patchTenant("beta", { status: "active" });
});

await t("forEachActiveTenant: legacy (unconfigured) keeps the single _default run", async () => {
  process.env.PLATFORM_DB_URL = "";
  const res = await OPS.forEachActiveTenant(() => tenantId());
  eq(res.length, 1, "one row");
  eq(res[0].tenant, "_default", "label");
  eq(res[0].ok, true, "ok");
  eq(res[0].result, "_default", "ran in env context");
  process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
  C.__resetPlatformClient();
});

await t("aggregateHealth ranks a _platform failure as down", async () => {
  const roll = OPS.aggregateHealth([{ tenant: "_platform", ok: false, error: "control plane unavailable" }]);
  eq(roll.status, "down", "status");
});

// --- E. SF08 order-token scheme ----------------------------------------------
await t("orderConfirmationPath carries the 20-hex token", async () => {
  const p = await withTenant(ALPHA, () => orderConfirmationPath("BL-TEST1234"));
  ok(/^\/checkout\/confirmation\/BL-TEST1234\?t=[0-9a-f]{20}$/.test(p), `path shape (${p})`);
});

await t("token verifies under its tenant; wrong/missing/truncated fail", async () => {
  const tok = await withTenant(ALPHA, () => orderStatusToken("BL-TEST1234"));
  eq(await withTenant(ALPHA, () => verifyOrderStatusToken("BL-TEST1234", tok)), true, "valid");
  eq(await withTenant(ALPHA, () => verifyOrderStatusToken("BL-TEST1234", "0".repeat(20))), false, "wrong");
  eq(await withTenant(ALPHA, () => verifyOrderStatusToken("BL-TEST1234", "")), false, "missing");
  eq(await withTenant(ALPHA, () => verifyOrderStatusToken("BL-TEST1234", tok.slice(0, 19))), false, "truncated");
});

await t("CROSS-TENANT rejection: alpha's token never unlocks beta's order id", async () => {
  const tok = await withTenant(ALPHA, () => orderStatusToken("BL-TEST1234"));
  eq(await withTenant(BETA, () => verifyOrderStatusToken("BL-TEST1234", tok)), false, "rejected under beta");
});

await t("tokens are tenant-secret-derived (alpha ≠ beta for the same id)", async () => {
  const a = await withTenant(ALPHA, () => orderStatusToken("BL-TEST1234"));
  const b = await withTenant(BETA, () => orderStatusToken("BL-TEST1234"));
  ok(a !== b, "distinct tokens");
});

// --- summary -----------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
