// Marketing-site suite (Session 44 / MK01–08): host detection (never leaks a
// tenant), pricing-from-the-live-plan-catalog (no drift by construction),
// honest kit gallery data, lead capture (consent flags, durable store).
//   pnpm test:marketing
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.DATABASE_URL = "file:.test-mkt-default.db";
process.env.PLATFORM_DB_URL = "file:.test-mkt-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_SITE_HOSTS = "www.storeasy.test, Site.Localhost:3007";

const dbs = [".test-mkt-default.db", ".test-mkt-platform.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { isPlatformSiteHost, platformSiteHosts } = await import("../lib/platform-site.js");
const B = await import("../lib/platform/billing.js");
const { KITS } = await import("../lib/themes/kits.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

console.log("— host detection (MK gate)");

await t("marketing hosts match case-insensitively, with and without port; everything else is NOT marketing", async () => {
  eq(platformSiteHosts().join(","), "www.storeasy.test,site.localhost:3007", "normalized:");
  eq(isPlatformSiteHost("WWW.Storeasy.TEST"), true);
  eq(isPlatformSiteHost("www.storeasy.test:443"), true, "bare-host fallback:");
  eq(isPlatformSiteHost("site.localhost:3007"), true);
  eq(isPlatformSiteHost("beastlife.in"), false, "tenant host:");
  eq(isPlatformSiteHost("localhost:3007"), false, "env-default host:");
  eq(isPlatformSiteHost(""), false);
  eq(isPlatformSiteHost(null), false);
});

console.log("— pricing (MK02: live catalog, no drift)");

await t("pricing reads the SAME rows billing charges from — a version bump shows immediately", async () => {
  await B.ensureDefaultPlans();
  const before = await B.listPlans();
  eq(before.find((p) => p.id === "starter").price, 99900);
  await B.createPlanVersion("starter", { name: "Starter", price: 119900, features: { orders_per_month: 600, staff_seats: 5 } });
  const after = await B.listPlans();
  const starter = after.find((p) => p.id === "starter");
  eq(starter.price, 119900, "new version serves:");
  eq(starter.version, 2);
  eq(after.filter((p) => p.id === "starter").length, 1, "one ACTIVE version listed:");
});

console.log("— template gallery (MK03: honest)");

await t("gallery data = the live kit registry (2 available kits, versioned)", async () => {
  const kits = Object.values(KITS);
  eq(kits.length, 2);
  for (const k of kits) {
    ok(k.version >= 1 && k.label && k.vertical && k.swatch.length >= 2, `${k.id} complete`);
  }
});

console.log("— lead capture (MK08: durable + consent-aware)");

await t("leads store with the SEPARATE marketing opt-in defaulting to 0", async () => {
  const db = C.platformDb();
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO leads (id, name, email, store_url, message, marketing_consent, source, created_at) VALUES ('ld1','Pat','pat@brand.in','brand.myshopify.com','hello', 0, '/contact', ?)",
    args: [now],
  });
  await db.execute({
    sql: "INSERT INTO leads (id, name, email, marketing_consent, source, created_at) VALUES ('ld2','Sam','sam@brand.in', 1, '/pricing', ?)",
    args: [now],
  });
  const rows = (await db.execute("SELECT id, marketing_consent FROM leads ORDER BY id")).rows;
  eq(rows.length, 2);
  eq(Number(rows[0].marketing_consent), 0, "contact-only default:");
  eq(Number(rows[1].marketing_consent), 1, "explicit opt-in stored:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
