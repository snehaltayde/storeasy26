// Reporting rollups suite (Session 42 / BE21): TZ-correct day bucketing,
// sales/refunds/net, freshness, coverage honesty (nulls, never fake zeros),
// the discrepancy queue, and the consented-events analytics (funnel, top
// products from snapshots, search terms w/ zero-result flags, devices).
//   pnpm test:reporting
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rep-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rep-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-rep-default.db", ".test-rep-platform.db", ".test-rep-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const Rep = await import("../lib/reporting.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "rep", name: "Rep", domains: ["rep.test"], dbUrl: "file:.test-rep-t1.db", config: { timezone: "Asia/Kolkata" }, secrets: {} });
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await withTenant(await C.getTenant("rep"), async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, await loadMigrations("tenant"));
});
const inT = async (fn) => withTenant(await C.getTenant("rep"), fn);

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

const daysAgo = (n, hourUtc = 10) => {
  const d = new Date(Date.now() - n * 86400000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};
const order = (id, { total = 1000, status = "synced", created, refunded = 0, shopify = true, snapshot = null, financial = null }) => ({
  sql: `INSERT INTO orders (id, total, currency, status, created_at, updated_at, refunded_total, shopify_order_id, snapshot, financial_status, sync_attempts)
        VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
  args: [id, total, "INR", status, created, created, refunded, shopify ? `gid://shopify/Order/${id}` : null, snapshot, financial],
});

console.log("— honest unknowns on an EMPTY store");

await t("empty store: nulls with reasons, never fake zeros", async () => {
  const r = await inT(() => Rep.salesRollup({ days: 30 }));
  eq(r.orders, 0);
  eq(r.aov, null, "AOV unknown, not 0:");
  const cov = await inT(() => Rep.coverage({ days: 30 }));
  eq(cov.push_pct, null, "push % unknown with no sales:");
  eq(cov.event_coverage_pct, null);
  const f = await inT(() => Rep.funnel({ days: 30 }));
  eq(f.conversion_pct, null, "conversion unknown with no views:");
});

console.log("— sales rollup (TZ bucketing)");

await t("sales count money-committed statuses only; refunds net out; TZ buckets days", async () => {
  await inT(async () => {
    await libsql.execute(order("O1", { total: 1000, status: "synced", created: daysAgo(2) }));
    await libsql.execute(order("O2", { total: 500, status: "cod_pending", created: daysAgo(2), shopify: false }));
    await libsql.execute(order("O3", { total: 999, status: "pending_payment", created: daysAgo(1), shopify: false })); // never paid
    await libsql.execute(order("O4", { total: 750, status: "cancelled", created: daysAgo(1), shopify: false })); // cancelled
    await libsql.execute(order("O5", { total: 2000, status: "sync_failed", created: daysAgo(1), shopify: false }));
    await libsql.execute({ sql: "INSERT INTO order_refunds (id, order_id, amount, currency, created_at) VALUES ('rf1','O1',300,'INR',?)", args: [daysAgo(1)] });
  });
  const r = await inT(() => Rep.salesRollup({ days: 30 }));
  eq(r.orders, 3, "O1+O2+O5 only:");
  eq(r.gross, 3500);
  eq(r.refunds, 300);
  eq(r.net, 3200);
  eq(Math.round(r.aov), 1167);
  // 18:30 UTC = midnight IST: an order at 19:00 UTC lands on the NEXT IST day
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 5);
  d.setUTCHours(19, 0, 0, 0);
  await inT(() => libsql.execute(order("O6", { total: 100, status: "synced", created: d.toISOString() })));
  const r2 = await inT(() => Rep.salesRollup({ days: 30 }));
  const istDay = Rep.dayInTz(d.toISOString(), "Asia/Kolkata");
  const utcDay = d.toISOString().slice(0, 10);
  ok(istDay > utcDay, "19:00 UTC is the next IST day");
  ok(r2.series.some((x) => x.day === istDay && x.orders >= 1), "bucketed in MERCHANT TZ, not UTC");
});

console.log("— coverage + freshness");

await t("coverage: push % counts shopify-linked sales; event coverage from purchase events", async () => {
  const cov = await inT(() => Rep.coverage({ days: 30 }));
  eq(cov.sales, 4);
  eq(cov.pushed_to_shopify, 2, "O1+O6 have shopify ids:");
  eq(cov.push_pct, 50);
  await inT(() =>
    libsql.execute({
      sql: "INSERT INTO events (event_id, name, payload, status, created_at) VALUES ('e1','purchase','{}','forwarded',?)",
      args: [daysAgo(1)],
    }),
  );
  const cov2 = await inT(() => Rep.coverage({ days: 30 }));
  eq(cov2.event_coverage_pct, 25, "1 purchase event / 4 sales:");
});

await t("freshness reports real watermarks", async () => {
  const f = await inT(Rep.freshness);
  ok(f.last_order_at, "orders watermark");
  ok(f.last_event_at, "events watermark");
  eq(f.catalog_synced_at, null, "no catalog sync yet = null, not now:");
});

console.log("— discrepancy queue");

await t("dead pushes, stuck pushes and refund mismatches each explain themselves", async () => {
  const old = daysAgo(1);
  await inT(async () => {
    await libsql.execute({
      sql: "INSERT INTO orders (id, total, status, sync_attempts, sync_error, created_at, updated_at, refunded_total) VALUES ('D1', 500, 'sync_failed', 5, 'HTTP 500 from Shopify', ?, ?, 0)",
      args: [old, old],
    });
    await libsql.execute({
      sql: "INSERT INTO orders (id, total, status, sync_attempts, created_at, updated_at, refunded_total) VALUES ('D2', 500, 'syncing_shopify', 1, ?, ?, 0)",
      args: [old, old],
    });
    await libsql.execute({
      sql: "INSERT INTO orders (id, total, status, financial_status, refunded_total, created_at, updated_at, sync_attempts) VALUES ('D3', 500, 'synced', 'refunded', 0, ?, ?, 0)",
      args: [old, old],
    });
  });
  const q = await inT(Rep.discrepancies);
  const kinds = q.map((x) => x.kind).sort();
  ok(kinds.includes("push_dead"), "dead push listed");
  ok(kinds.includes("push_stuck"), "stuck push listed");
  ok(kinds.includes("refund_mismatch"), "refund mismatch listed");
  for (const row of q) ok(row.action, `${row.kind} carries an action`);
});

console.log("— behavioural analytics (consented events)");

await t("funnel, search terms (zero-result flags), devices, top products", async () => {
  await inT(async () => {
    const ev = (name, payload, ua = "Mozilla/5.0 (iPhone; CPU iPhone OS)") =>
      libsql.execute({
        sql: "INSERT INTO events (event_id, name, payload, user_agent, status, created_at) VALUES (?,?,?,?,'forwarded',?)",
        args: [`ev_${name}_${Math.random().toString(36).slice(2, 8)}`, name, JSON.stringify(payload), ua, daysAgo(1)],
      });
    for (let i = 0; i < 10; i++) await ev("view_item", {});
    for (let i = 0; i < 4; i++) await ev("add_to_cart", {});
    await ev("begin_checkout", {});
    await ev("search", { params: { search_term: "Whey", results: 8 } }, "Mozilla/5.0 (Windows NT 10.0)");
    await ev("search", { params: { search_term: "whey", results: 8 } }, "Mozilla/5.0 (Windows NT 10.0)");
    await ev("search", { params: { search_term: "unicorn dust", results: 0 } });
    await ev("view_campaign", { params: { campaign_slug: "glow-days", utm_source: "ig" } });
  });
  const f = await inT(() => Rep.funnel({ days: 30 }));
  eq(f.steps.find((s) => s.name === "view_item").count, 10);
  eq(f.steps.find((s) => s.name === "add_to_cart").pct_of_views, 40);
  const terms = await inT(() => Rep.searchTerms({ days: 30 }));
  eq(terms.terms[0].term, "whey", "case-folded + ranked:");
  eq(terms.terms[0].searches, 2);
  eq(terms.terms.find((x) => x.term === "unicorn dust").zero_results, 1, "zero-result flagged:");
  const camps = await inT(() => Rep.campaignViews({ days: 30 }));
  eq(camps.campaigns[0].campaign, "glow-days");
  const dev = await inT(() => Rep.deviceSplit({ days: 30 }));
  ok(dev.mobile > 0 && dev.desktop > 0, "both classes seen");
  // top products parse order snapshots
  const snap = JSON.stringify({ items: [{ title: "Whey Gold", quantity: 2, lineTotal: 1800 }, { title: "Shaker", quantity: 1, lineTotal: 200 }] });
  await inT(() => libsql.execute(order("O7", { total: 2000, status: "synced", created: daysAgo(1), snapshot: snap })));
  const tp = await inT(() => Rep.topProducts({ days: 30 }));
  eq(tp.products[0].title, "Whey Gold");
  eq(tp.products[0].revenue, 1800);
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
