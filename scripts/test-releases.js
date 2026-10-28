// Releases suite (Session 36 / BE09 + SF23): snapshot determinism + content
// hashing, atomic publish with no draft→live leakage, rollback that preserves
// drafts, publish validation (required slots, dead catalog links, brand
// contrast), scheduled publish through the real jobs queue, and preview
// token expiry/tamper/tenant-binding.
//   pnpm test:releases
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rel-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rel-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-rel-default.db", ".test-rel-platform.db", ".test-rel-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const W = await import("../lib/platform/worker.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

// control plane + one registered tenant (the worker resolves job tenants here)
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({
  id: "rt",
  name: "Release Tenant",
  domains: ["rt.test"],
  dbUrl: "file:.test-rel-t1.db",
  config: { site: { name: "Release Tenant" } },
  secrets: { order_link_secret: "rt-link-secret" },
});

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const tenantMigrations = await loadMigrations("tenant");
const RT = (await C.getTenant("rt"));
await withTenant(RT, async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, tenantMigrations);
  // a tiny catalog for link validation
  await libsql.execute(
    "INSERT INTO collections (id, handle, title, synced_at) VALUES ('gid://shopify/Collection/1', 'whey', 'Whey', '2026-01-01')",
  );
});
const inTenant = (fn) => withTenant(RT, fn);

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

console.log("— snapshot & hash");

await t("snapshot is deterministic: same drafts → same canonical bytes → same hash", async () => {
  await inTenant(() => S.setBlock("hero", { title: "Release me", primary: { label: "Shop", href: "/collections/whey" } }));
  const [a, b] = [await inTenant(R.snapshotContent), await inTenant(R.snapshotContent)];
  eq(a.hash, b.hash);
  eq(a.canonical, b.canonical);
});

await t("stableStringify sorts keys recursively (field order can't change the hash)", async () => {
  eq(R.stableStringify({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
});

console.log("— publish / no leakage / rollback");

let relA, relB;
await t("publish flips the live pointer atomically and stamps published_at", async () => {
  relA = await inTenant(() => R.createRelease({ note: "first", actor: { kind: "merchant", id: "u1" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.id, relA.id);
  eq(live.content_hash, relA.hash);
  if (!live.published_at) throw new Error("published_at missing");
});

await t("editing a draft does NOT change the live release (no draft→live leak)", async () => {
  await inTenant(() => S.setBlock("hero", { title: "Draft-only edit", primary: { label: "Shop", href: "/collections/whey" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.content.blocks.hero.title, "Release me", "live hero:");
  // and the console sees the divergence
  const snap = await inTenant(R.snapshotContent);
  if (snap.hash === live.content_hash) throw new Error("dirty detection failed");
});

await t("second publish goes live; rollback to the first restores it and PRESERVES drafts", async () => {
  relB = await inTenant(() => R.createRelease({ note: "second", actor: { kind: "merchant", id: "u1" } }));
  eq((await inTenant(R.getLiveRelease)).id, relB.id);
  await inTenant(() => R.rollbackRelease(relA.id, { actor: { kind: "merchant", id: "u1" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.id, relA.id);
  eq(live.content.blocks.hero.title, "Release me");
  // drafts still carry the newer edit — rollback touched only the pointer
  eq((await inTenant(() => S.getBlockRow("hero"))).value.title, "Draft-only edit");
});

await t("release rows are immutable snapshots: A and B both still exist, hashes distinct", async () => {
  const { releases } = await inTenant(R.listReleases);
  eq(releases.length, 2);
  if (releases[0].content_hash === releases[1].content_hash) throw new Error("hashes should differ");
});

console.log("— publish validation");

await t("missing hero title blocks; dead catalog link blocks; unknown path warns", async () => {
  const base = { v: 1, blocks: {}, pages: [], brand: null };
  let r = await inTenant(() => R.validateRelease({ ...base, blocks: { hero: { title: "  " } } }));
  eq(r.ok, false, "empty hero:");
  r = await inTenant(() => R.validateRelease({ ...base, blocks: { hero: { title: "Hi", primary: { label: "x", href: "/collections/does-not-exist" } } } }));
  eq(r.ok, false, "dead link:");
  if (!/doesn't exist in the catalog/.test(r.errors.join(" "))) throw new Error(`wrong error: ${r.errors}`);
  r = await inTenant(() => R.validateRelease({ ...base, blocks: { nav_header: [{ label: "Blog", href: "/blog" }] } }));
  eq(r.ok, true, "unknown path is a warning:");
  // S38 adds missing-policy-page warnings for plain tenants — count only the path one
  eq(r.warnings.filter((w) => w.includes("isn't a storefront route")).length, 1);
});

await t("brand contrast failure blocks a publish even if it slipped into drafts", async () => {
  const r = await inTenant(() => R.validateRelease({ v: 1, blocks: {}, pages: [], brand: { foreground: "#cccccc", background: "#ffffff" } }));
  eq(r.ok, false);
  if (!/Brand:/.test(r.errors[0])) throw new Error(`wrong error: ${r.errors}`);
});

await t("createRelease refuses an invalid draft set with RELEASE_INVALID", async () => {
  await inTenant(() => S.setBlock("hero", { title: "" }));
  try {
    await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } }));
    throw new Error("expected RELEASE_INVALID");
  } catch (e) {
    eq(e.code, "RELEASE_INVALID");
  }
  await inTenant(() => S.setBlock("hero", { title: "Draft-only edit" })); // restore
});

console.log("— scheduled publish via the jobs queue");

await t("schedule creates the release WITHOUT flipping; the due job flips it", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const r = await inTenant(() => R.createRelease({ note: "scheduled", actor: { kind: "merchant", id: "u1" }, scheduledFor: future }));
  eq((await inTenant(R.getLiveRelease)).id, relA.id, "pointer untouched:");
  const job = (
    await C.platformDb().execute({ sql: "SELECT id, tenant_id, run_after, status FROM jobs WHERE idempotency_key = ?", args: [`publish_${r.id}`] })
  ).rows[0];
  if (!job) throw new Error("no queued job");
  eq(job.tenant_id, "rt");
  eq(job.run_after, future);
  // make it due, then run through the REAL worker path (tenant context included)
  await C.platformDb().execute({ sql: "UPDATE jobs SET run_after = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), job.id] });
  const res = await W.runJobById(job.id);
  eq(res.ok, true, "job:");
  eq((await inTenant(R.getLiveRelease)).id, r.id, "flipped:");
  if (!(await inTenant(R.getLiveRelease)).published_at) throw new Error("published_at missing after scheduled flip");
});

await t("publishReleaseById on an unknown id fails (job dead-letters, pointer safe)", async () => {
  const before = (await inTenant(R.getLiveRelease)).id;
  try {
    await inTenant(() => R.publishReleaseById("rel_nope"));
    throw new Error("expected throw");
  } catch (e) {
    if (!/not found/.test(e.message)) throw e;
  }
  eq((await inTenant(R.getLiveRelease)).id, before);
});

console.log("— preview tokens");

await t("preview token round-trips; expiry and tamper are rejected", async () => {
  const token = await inTenant(R.previewToken);
  eq(await inTenant(() => R.verifyPreviewToken(token)), true, "valid:");
  eq(await inTenant(() => R.verifyPreviewToken(token, { now: Date.now() + 2 * 3600_000 })), false, "expired:");
  const [p, exp, sig] = token.split(".");
  eq(await inTenant(() => R.verifyPreviewToken(`${p}.${exp}.${"0".repeat(20)}`)), false, "tampered:");
  eq(await inTenant(() => R.verifyPreviewToken("garbage")), false, "garbage:");
});

await t("preview token is tenant-bound: another tenant's context rejects it", async () => {
  const token = await inTenant(R.previewToken);
  const other = { ...RT, id: "other-tenant", secrets: { order_link_secret: "other-secret" } };
  eq(await withTenant(other, () => R.verifyPreviewToken(token)), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
