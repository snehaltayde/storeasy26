// Perf report + load fixtures (Session 42 / BE35; PERF-04).
//
//   pnpm test:perf                          library mode (below), unchanged
//   node scripts/perf-report.js http …      PERF-04: real HTTP requests against
//                                           a production build of the design
//                                           harness, perf fixture, edge runtime
//                                           (scripts/perf-http.js)
//   node scripts/perf-report.js check <run.json> --budget <file>
//                                           compare a run with a budget file
//   node scripts/perf-report.js fixture     sizes and content digest of the
//                                           seeded harness data
//
// Library mode measures the hot paths against a LARGE catalog (5,000 products
// / 120 collections / ~30k memberships), queue drain throughput,
// snapshot/publish with 50 pages, and a noisy-neighbor check (tenant A's
// search latency while tenant B hammers writes). Its thresholds are
// deliberately generous LOCAL GUARDS for local SQLite + CI variance — they
// catch ORDER-OF-MAGNITUDE regressions (a missing index, an accidental N+1),
// not micro-drift. They are not budgets: PERF-04 sets budgets only from hosted
// numbers (docs/perf/budgets.json). Numbers print as a report.
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

if (["http", "check", "fixture"].includes(process.argv[2])) {
  const { main } = await import("./perf-http.js");
  process.exit(await main(process.argv.slice(2)));
}

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-perf-default.db";
process.env.PLATFORM_DB_URL = "file:.test-perf-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-perf-default.db", ".test-perf-platform.db", ".test-perf-a.db", ".test-perf-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const repo = await import("../lib/repo.js");
const { evaluateOffers } = await import("../lib/offers/engine.js");
const R = await import("../lib/releases.js");
const S = await import("../lib/cms/store.js");
const { enqueueJob } = await import("../lib/platform/jobs.js");
const { runDueJobs } = await import("../lib/platform/worker.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
for (const [id, file] of [["pa", ".test-perf-a.db"], ["pb", ".test-perf-b.db"]]) {
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-secret` } });
}
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
for (const id of ["pa", "pb"]) {
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, migrations);
  });
}
const inA = async (fn) => withTenant(await C.getTenant("pa"), fn);
const inB = async (fn) => withTenant(await C.getTenant("pb"), fn);

// ---- load fixture: 5k products, 120 collections, ~30k memberships ------------
console.log("seeding large catalog (5,000 products)…");
const t0 = Date.now();
await inA(async () => {
  const TYPES = ["Protein", "Creatine", "Gear", "Wellness", "Snacks"];
  for (let batch = 0; batch < 10; batch++) {
    const stmts = [];
    for (let i = 0; i < 500; i++) {
      const n = batch * 500 + i;
      stmts.push({
        sql: "INSERT INTO products (id, handle, title, product_type, vendor, tags, price_min, price_max, available, created_at, currency) VALUES (?,?,?,?,?,?,?,?,?,?, 'INR')",
        args: [`gid://p/${n}`, `product-${n}`, `Product ${n} ${TYPES[n % 5]} Edition`, TYPES[n % 5], "PerfCo", JSON.stringify([TYPES[n % 5].toLowerCase(), `tag${n % 23}`]), 100 + (n % 400) * 10, 100 + (n % 400) * 10, n % 7 === 0 ? 0 : 1, new Date(Date.now() - n * 60000).toISOString()],
      });
    }
    await libsql.batch(stmts, "write");
  }
  const colStmts = [];
  for (let c = 0; c < 120; c++) colStmts.push({ sql: "INSERT INTO collections (id, handle, title) VALUES (?,?,?)", args: [`gid://c/${c}`, `collection-${c}`, `Collection ${c}`] });
  await libsql.batch(colStmts, "write");
  for (let c = 0; c < 120; c++) {
    const member = [];
    for (let i = 0; i < 250; i++) {
      const p = (c * 41 + i * 7) % 5000;
      member.push({ sql: "INSERT OR IGNORE INTO collection_products (collection_id, product_id, position) VALUES (?,?,?)", args: [`gid://c/${c}`, `gid://p/${p}`, i] });
    }
    await libsql.batch(member, "write");
  }
  for (let i = 0; i < 50; i++) {
    await S.upsertContentPage({ slug: `page-${i}`, title: `Page ${i}`, sections: [{ heading: "H", body: ["Lorem ipsum ".repeat(40)] }] });
  }
});
console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- measurement harness -----------------------------------------------------
const results = [];
let fail = 0;
// guardMs: a local order-of-magnitude guard, not a budget (see the header).
async function measure(name, guardMs, fn, { runs = 5 } = {}) {
  await fn(); // warm (connection, statement cache)
  const times = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const worst = times[times.length - 1];
  const ok = worst <= guardMs;
  if (!ok) fail++;
  results.push({ name, p50: +p50.toFixed(1), worst: +worst.toFixed(1), guard: `${guardMs}ms`, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}: p50 ${p50.toFixed(1)}ms · worst ${worst.toFixed(1)}ms (local guard ${guardMs}ms)`);
  return { p50, worst };
}

console.log("— storefront hot paths (5k-product catalog)");
await measure("product by handle (PDP)", 150, () => inA(() => repo.getProductByHandle("product-2500")));
await measure("collection page: featured sort + facets", 400, () =>
  inA(async () => {
    await repo.getProductsInCollection("collection-60", { limit: 48 });
    await repo.getCollectionTypeFacets("collection-60");
  }),
);
await measure("collection page: price sort + in-stock filter", 400, () => inA(() => repo.getProductsInCollection("collection-60", { limit: 48, sort: "price-asc", inStock: true })));
await measure("SQL search, multi-term (SF05 ranking)", 400, () => inA(() => repo.searchProductsInDb("protein edition 12", 8)));
await measure("home: newest + featured collections", 400, () =>
  inA(async () => {
    await repo.getNewestProducts(8);
    await repo.getFeaturedCollections(6);
  }),
);

console.log("— offers engine (20-line cart)");
const bigCart = Array.from({ length: 20 }, (_, i) => ({ variantId: `gid://v/${i}`, productId: `gid://p/${i}`, title: `P${i}`, price: 999, quantity: 2, tags: ["protein"], productType: "Protein", handle: `product-${i}` }));
await measure("evaluateOffers on 20 items", 50, async () => evaluateOffers(bigCart), { runs: 20 });

console.log("— releases (50 content pages)");
await measure("snapshot + hash (50 pages)", 600, () => inA(() => R.snapshotContent()));

console.log("— jobs queue drain");
{
  for (let i = 0; i < 200; i++) await enqueueJob({ type: "perf_noop", payload: { i }, idempotencyKey: `perf_${i}` });
  const s = performance.now();
  let done = 0;
  while (done < 200) {
    const r = await runDueJobs({ limit: 50, handlers: { perf_noop: async () => ({}) } });
    if (!r.length) break;
    done += r.length;
  }
  const secs = (performance.now() - s) / 1000;
  const rate = done / secs;
  const ok = rate >= 25;
  if (!ok) fail++;
  results.push({ name: "queue drain (200 noop jobs)", p50: +rate.toFixed(0), worst: +rate.toFixed(0), unit: " jobs/s", guard: "≥25/s", ok });
  console.log(`  ${ok ? "✓" : "✗"} queue drain: ${done} jobs in ${secs.toFixed(2)}s = ${rate.toFixed(0)} jobs/s (local guard ≥25/s)`);
}

console.log("— noisy neighbor (tenant B hammers writes while A searches)");
{
  const solo = await measure("search on A, quiet", 400, () => inA(() => repo.searchProductsInDb("protein edition", 8)), { runs: 10 });
  let stop = false;
  const noise = (async () => {
    let n = 0;
    while (!stop) {
      await inB(() => libsql.execute({ sql: "INSERT INTO products (id, handle, title, available, currency) VALUES (?,?,?,1,'INR')", args: [`gid://noise/${n}`, `noise-${n}`, `Noise ${n}`] }));
      n++;
    }
    return n;
  })();
  const noisy = await measure("search on A, while B writes (noisy neighbor)", 800, () => inA(() => repo.searchProductsInDb("protein edition", 8)), { runs: 10 });
  stop = true;
  const writes = await noise;
  console.log(`  (B completed ${writes} interleaved writes; A worst ${noisy.worst.toFixed(1)}ms vs quiet ${solo.worst.toFixed(1)}ms — separate DB files isolate I/O)`);
}

console.log("\n=== PERF REPORT (BE35): local guards, not budgets ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: p50 ${r.p50}${r.unit || "ms"} worst ${r.worst}${r.unit || "ms"} (local guard ${r.guard})`);
console.log(`\n${results.length - fail} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
