// Session 24 — platform ops tests: the tenant-loop primitive (context entry,
// suspended skipped, failure isolation, env fallback), health rollup math,
// tenant-tagged logs/alerts, and the shared --tenant CLI flag.
//   node scripts/test-platform-ops.js      (pnpm test:platform-ops)
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-ops-default.db";
process.env.PLATFORM_DB_URL = "file:.test-ops-platform.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
delete process.env.ALERT_WEBHOOK_URL;

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-ops-default.db", ".test-ops-platform.db", ".test-ops-a.db", ".test-ops-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { withTenant, tenantId } = await import("../lib/tenant-context.js");
const C = await import("../lib/platform/control.js");
const { forEachActiveTenant, aggregateHealth, parseTenantFlag, runAsTenant } = await import("../lib/platform/ops.js");
const { slog } = await import("../lib/log.js");
const { sendAlert } = await import("../lib/alerts.js");

const platformSchema = await readFile(join(here, "../lib/platform/schema.sql"), "utf8");
await C.migratePlatform(platformSchema);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

// --- loop primitive --------------------------------------------------------------
await t("forEachActiveTenant: EMPTY registry → one run in the default/env context", async () => {
  const res = await forEachActiveTenant(async () => tenantId());
  eq(res.length, 1);
  eq(res[0].tenant, "_default");
  eq(res[0].result, "_default", "ran without tenant context");
  eq(res[0].ok, true);
});

await t("forEachActiveTenant: runs per ACTIVE tenant in its own context; suspended skipped", async () => {
  await C.upsertTenant({ id: "ta", name: "A", domains: [], dbUrl: "file:.test-ops-a.db", config: {}, secrets: {} });
  await C.upsertTenant({ id: "tb", name: "B", domains: [], dbUrl: "file:.test-ops-b.db", config: {}, secrets: {} });
  await C.upsertTenant({ id: "tz", name: "Z", status: "suspended", domains: [], dbUrl: "file:.test-ops-b.db", config: {}, secrets: {} });
  const res = await forEachActiveTenant(async () => tenantId());
  eq(res.map((r) => r.tenant).sort().join(","), "ta,tb", "active only");
  for (const r of res) eq(r.result, r.tenant, `context entered for ${r.tenant}`);
});

await t("forEachActiveTenant: one tenant's failure never stops the others", async () => {
  const res = await forEachActiveTenant(async () => {
    if (tenantId() === "ta") throw new Error("boom-a");
    return "fine";
  });
  const a = res.find((r) => r.tenant === "ta");
  const b = res.find((r) => r.tenant === "tb");
  eq(a.ok, false);
  ok(a.error.includes("boom-a"), "error captured");
  eq(b.ok, true);
  eq(b.result, "fine");
});

// --- health rollup ----------------------------------------------------------------
await t("aggregateHealth: worst-of ranking; thrown check = down", async () => {
  eq(aggregateHealth([{ tenant: "a", ok: true, result: { status: "ok" } }]).status, "ok");
  eq(
    aggregateHealth([
      { tenant: "a", ok: true, result: { status: "ok" } },
      { tenant: "b", ok: true, result: { status: "degraded" } },
    ]).status,
    "degraded",
  );
  const withError = aggregateHealth([
    { tenant: "a", ok: true, result: { status: "ok" } },
    { tenant: "b", ok: false, error: "db unreachable" },
  ]);
  eq(withError.status, "down");
  eq(withError.tenants.find((t) => t.tenant === "b").status, "down");
  eq(withError.tenants.find((t) => t.tenant === "b").error, "db unreachable");
});

// --- CLI flag ---------------------------------------------------------------------
await t("parseTenantFlag + runAsTenant", async () => {
  const p = parseTenantFlag(["BL-1", "oops", "--tenant", "demo", "--refunded", "rf_1"]);
  eq(p.tenantSlug, "demo");
  eq(p.rest.join(","), "BL-1,oops,--refunded,rf_1", "flag removed, order kept");
  eq(parseTenantFlag(["BL-1"]).tenantSlug, null);
  eq(await runAsTenant(null, async () => tenantId()), "_default", "no slug = default context");
  eq(await runAsTenant("ta", async () => tenantId()), "ta", "slug enters context");
  let threw = false;
  try {
    await runAsTenant("ghost", async () => {});
  } catch (e) {
    threw = /not found/.test(e.message);
  }
  ok(threw, "unknown slug throws");
});

// --- tenant-tagged logs + alerts ----------------------------------------------------
await t("slog carries the active tenant id on every line", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    slog("test_evt", { x: 1 });
    const A = await C.getTenant("ta");
    await withTenant(A, () => slog("test_evt", { x: 2 }));
  } finally {
    console.log = orig;
  }
  eq(JSON.parse(lines[0]).tenant, "_default");
  const second = JSON.parse(lines[1]);
  eq(second.tenant, "ta");
  eq(second.x, 2, "fields intact");
});

await t("sendAlert: [tenant] prefix + tenant field; no prefix for the default tenant", async () => {
  const errs = [];
  const orig = console.error;
  console.error = (s) => errs.push(String(s));
  try {
    const r1 = await sendAlert("something broke", { a: 1 });
    eq(r1.delivered, false, "no webhook configured");
    const A = await C.getTenant("ta");
    await withTenant(A, () => sendAlert("something broke", { a: 2 }));
  } finally {
    console.error = orig;
  }
  ok(errs[0].startsWith("[ALERT] something broke"), "default untagged");
  ok(errs[1].startsWith("[ALERT] [ta] something broke"), "tenant tagged");
});

// --- credential scoping (the S24 dry-run finding) -----------------------------------
await t("credentials NEVER fall back to env for a resolved tenant; default tenant keeps env", async () => {
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_envkey";
  process.env.META_PIXEL_ID_SENTINEL = "x"; // noop guard
  const { tenantOwnCfg, tenantOwnSecret } = await import("../lib/tenant-context.js");
  // default context → env fallback intact (pre-platform behavior)
  eq(tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID"), "rzp_test_envkey", "default ctx uses env");
  // resolved tenant WITHOUT the key → unconfigured, not the env value
  const bare = { id: "bare", name: "B", status: "active", dbUrl: "file:.test-ops-b.db", config: {}, secrets: {} };
  eq(await withTenant(bare, async () => tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID")), undefined, "tenant ctx never borrows env creds");
  eq(await withTenant(bare, async () => tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET", null)), null, "secret scoped too");
  // resolved tenant WITH its own key → its own value
  const owned = { ...bare, config: { razorpay_key_id: "rzp_test_own" } };
  eq(await withTenant(owned, async () => tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID")), "rzp_test_own", "own value wins");
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
