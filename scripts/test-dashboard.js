// The merchant dashboard on the new UI (Phase 2 line 1, docs/plans/phase-2.md
// "Line 1"). pnpm test:dashboard
//   1. salesView with a fixed clock: "today" is the store's day (the midnight
//      edge in Asia/Kolkata), quiet days are zeros, 7 days and the range add up.
//   2. The page run as every caller with its components stubbed
//      (scripts/support/page-harness.js) on a store with canaries planted: an
//      order's customer, a contact message, the Shopify domain.
//        - signed out redirects to /admin/login
//        - support (and an operator's support session): no canary in any prop,
//          no Shopify domain, no href to a settings page, Run again not allowed
//        - staff: Run again not allowed, no settings link; owner and admin may
//        - the action queue: each row a count, plain words and its link;
//          order ids only; contact failures link Integrations only with settings.read
//   3. Each part is caught on its own: a table that can't be read gives that
//      row "Couldn't check", the rest still shows.
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CNY = {
  orderEmail: "cnydashmail0@example.test",
  orderPhone: "9876509876",
  orderName: "cnydashname0",
  orderAddress: "cnydashaddr0",
  msgName: "cnydashmsgname0",
  msgEmail: "cnydashmsgmail0@example.test",
  msgBody: "cnydashmsgbody0",
  shopDomain: "cnydashshop0.myshopify.com",
};
const SUPPORT_CANARIES = Object.values(CNY);

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-dash-default.db";
process.env.PLATFORM_SECRET = "test-dash-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
const network = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack && !e.message ? e.stack : e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

const D = await import("../lib/admin/dashboard.js");
const { dayInTz } = await import("../lib/reporting.js");
const { roleAllows } = await import("../lib/platform/authz.js");

// ---- 1. salesView, a fixed clock ---------------------------------------------------
console.log("— sales (a fixed clock)");

await t("today is the store's day: 00:15 in Kolkata counts the order at 00:05, not the one at 23:55 the day before", () => {
  const tz = "Asia/Kolkata";
  const nowMs = Date.parse("2026-11-24T18:45:00Z"); // 00:15 on 25 Nov in Kolkata, still 24 Nov in UTC
  const day = (iso) => dayInTz(iso, tz);
  eq(day("2026-11-24T18:35:00Z"), "2026-11-25", "00:05 IST:");
  eq(day("2026-11-24T18:25:00Z"), "2026-11-24", "23:55 IST:");
  const rollup = {
    tz,
    currency: "INR",
    orders: 3,
    gross: 1500,
    refunds: 200,
    net: 1300,
    aov: 500,
    series: [
      { day: "2026-11-25", orders: 1, gross: 400, refunds: 0, net: 400 },
      { day: "2026-11-24", orders: 1, gross: 600, refunds: 200, net: 400 },
      { day: "2026-11-10", orders: 1, gross: 500, refunds: 0, net: 500 },
    ],
  };
  const v = D.salesView(rollup, { days: 30, nowMs });
  eq(JSON.stringify(v.today), JSON.stringify({ net: 400, orders: 1 }), "today:");
  eq(JSON.stringify(v.week), JSON.stringify({ net: 800, orders: 2 }), "7 days (refunds netted):");
  eq(v.range.net, 1300, "the range's net:");
  eq(v.range.refunds, 200, "the range's refunds:");
  eq(v.aov, 500, "average order:");
  eq(v.series.length, 30, "one bar a day:");
  eq(v.series.at(-1).day, "2026-11-25", "the last bar is today in Kolkata:");
  eq(v.series[0].day, "2026-10-27", "the first bar is 29 days before:");
  eq(v.series.filter((d) => d.net === 0).length, 27, "quiet days are zeros:");
  const quiet = D.salesView({ ...rollup, orders: 0, gross: 0, refunds: 0, net: 0, aov: null, series: [] }, { days: 7, nowMs });
  eq(JSON.stringify(quiet.today), JSON.stringify({ net: 0, orders: 0 }), "no sales yet today:");
  eq(quiet.aov, null, "no average order without an order:");
  eq(quiet.series.length, 7, "7-day range:");
});

await t("the range is 7, 30 or 90", () => {
  eq(D.RANGES.join(","), "7,30,90", "");
});

// ---- 2. the page, every caller ---------------------------------------------------------
const store = await H.makeRoleStore({
  name: "dash",
  a: { products: 2, config: { shopify_store_domain: CNY.shopDomain }, secrets: { shopify_admin_token: "dash-shop-token" } },
});
const { a, cookies } = store;
const C = await import("../lib/platform/control.js");
const { db, libsql } = await import("../lib/db.js");

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const order = (id, over = {}) => ({
  id,
  idempotency_key: `idem-${id}`,
  cart_id: `cart-${id}`,
  email: CNY.orderEmail,
  phone: CNY.orderPhone,
  name: CNY.orderName,
  address_line1: CNY.orderAddress,
  city: "Pune",
  state: "MH",
  pincode: "411001",
  country: "IN",
  subtotal: 500,
  discount_total: 0,
  shipping_total: 0,
  total: 500,
  currency: "INR",
  snapshot: JSON.stringify({ contact: { email: CNY.orderEmail }, items: [] }),
  payment_method: "razorpay",
  payment_status: "paid",
  status: "synced",
  // a multi-row insert sends every column, so each row names the defaults too
  sync_attempts: 0,
  sync_error: null,
  shopify_order_id: null,
  financial_status: null,
  refunded_total: 0,
  created_at: iso(60_000),
  updated_at: iso(60_000),
  ...over,
});
await a.run(async () => {
  await db
    .insertInto("orders")
    .values([
      order("DASH-OK1", { shopify_order_id: "gid://shopify/Order/1" }),
      order("DASH-FAIL1", { status: "sync_failed", sync_attempts: 1, sync_error: "Shopify said no" }),
      order("DASH-FAIL2", { status: "sync_failed", sync_attempts: 1, sync_error: "Shopify said no" }),
      order("DASH-STUCK1", { status: "syncing_shopify", created_at: iso(3 * 3600_000), updated_at: iso(2 * 3600_000) }),
      order("DASH-REF1", { financial_status: "refunded", refunded_total: 0, shopify_order_id: "gid://shopify/Order/2" }),
      order("DASH-COD1", { status: "cod_pending", payment_method: "cod", payment_status: "cod", created_at: iso(20 * 60_000), updated_at: iso(20 * 60_000) }),
      order("DASH-COD2", { status: "cod_pending", payment_method: "cod", payment_status: "cod", created_at: iso(5 * 60_000), updated_at: iso(5 * 60_000) }),
    ])
    .execute();
  await db.insertInto("order_refunds").values({ id: "rf_dash1", order_id: "DASH-OK1", amount: 100, currency: "INR", created_at: iso(30_000) }).execute();
  await db
    .insertInto("return_requests")
    .values([
      { id: "ret_dash1", order_id: "DASH-OK1", customer_id: "cus_dash", reason: "too small", status: "requested", created_at: iso(60_000), updated_at: iso(60_000) },
      { id: "ret_dash2", order_id: "DASH-OK1", customer_id: "cus_dash", reason: "changed mind", status: "rejected", created_at: iso(60_000), updated_at: iso(60_000) },
    ])
    .execute();
  await db.insertInto("notifications").values({ id: "ntf_dash1", type: "contact_message", recipient: CNY.msgEmail, subject: "Contact", body: CNY.msgBody, status: "failed", error: "no inbox", created_at: iso(60_000) }).execute();
  await db.insertInto("contact_messages").values({ id: "msg_dash1", name: CNY.msgName, email: CNY.msgEmail, message: CNY.msgBody, notification_id: "ntf_dash1", created_at: iso(60_000) }).execute();
});

const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const PAGE = "app/(console)/admin/(authed)/dashboard/page.js";
const runs = {};
for (const caller of ["owner", "admin", "staff", "support", "operator-support", "signed-out"]) runs[caller] = await pages.run(PAGE, { cookies: cookies[caller] });
const propsOf = (run, name) => run.props.find((p) => p.component.endsWith(`#${name}`))?.props;
const ROLE_OF = { owner: "owner", admin: "admin", staff: "staff", support: "support", "operator-support": "support" };
const READERS = Object.keys(ROLE_OF);
const SETTINGS_HREF = /\/admin\/(settings|integrations|automations|billing|team)\b/;

console.log("— the page, every caller");

await t("signed out: redirects to /admin/login", () => {
  eq(runs["signed-out"].redirect, "/admin/login", "");
});

await t("every role renders the page (no error, nothing unresolved)", () => {
  for (const c of READERS) {
    ok(!runs[c].error, `${c}: ${runs[c].error?.message}`);
    eq(runs[c].unresolved.join(","), "", `${c} unresolved:`);
    for (const name of ["PageHeader", "RangeSwitch", "SalesSummary", "ActionQueue", "StoreStatus", "SalesChart"]) ok(propsOf(runs[c], name), `${c} renders ${name}: ${runs[c].props.map((p) => p.component).join(",")}`);
  }
});

await t("support (S1): no prop holds a customer name, email, phone or address, a contact-message address or body, or the Shopify domain", () => {
  for (const c of ["support", "operator-support"]) {
    const found = SUPPORT_CANARIES.filter((x) => runs[c].text.includes(x) || runs[c].text.toLowerCase().includes(x.toLowerCase()));
    eq(found.join(","), "", `${c} canaries:`);
  }
});

await t("the Shopify domain: owner and admin see it; staff and support see only connected or not", () => {
  for (const c of READERS) {
    const shopify = propsOf(runs[c], "StoreStatus").status.shopify;
    eq(shopify.connected, true, `${c} connected:`);
    eq(shopify.shopDomain, roleAllows(ROLE_OF[c], "settings.read") ? CNY.shopDomain : undefined, `${c} domain:`);
  }
});

await t("Run again (sync.run): a failed import shows the card; allowed for owner and admin, staff and support get the reason instead", async () => {
  eq(propsOf(runs.owner, "SyncCard"), undefined, "no card while the import is complete:");
  await a.run(() => libsql.execute({ sql: "INSERT INTO sync_runs (id, status, error, started_at, finished_at) VALUES ('sync_dashfail', 'failed', 'Shopify said no', ?, ?)", args: [iso(600_000), iso(540_000)] }));
  const failed = {};
  try {
    for (const c of READERS) failed[c] = await pages.run(PAGE, { cookies: cookies[c] });
  } finally {
    await a.run(() => libsql.execute("DELETE FROM sync_runs WHERE id = 'sync_dashfail'"));
  }
  for (const c of READERS) {
    const card = propsOf(failed[c], "SyncCard");
    ok(card, `${c}: the card shows for a failed import: ${failed[c].props.map((p) => p.component).join(",")}`);
    eq(card.initial.state, "failed", `${c} state:`);
    const can = roleAllows(ROLE_OF[c], "sync.run");
    eq(card.gate.allowed, can, `${c} canSync:`);
    if (!can) ok(typeof card.gate.reason === "string" && card.gate.reason.length > 10, `${c} sees why not: ${card.gate.reason}`);
    eq(card.canReconnect, roleAllows(ROLE_OF[c], "settings.write"), `${c} reconnect:`);
  }
});

await t("staff and support: no href to a settings page anywhere in the props", () => {
  for (const c of ["staff", "support", "operator-support"]) {
    eq(runs[c].text.match(SETTINGS_HREF)?.[0] ?? "", "", `${c} settings links:`);
  }
  eq(propsOf(runs.owner, "ActionQueue").rows.find((r) => r.id === "contact_failed")?.href, "/admin/integrations", "the owner's contact row links Integrations:");
});

await t("the action queue: counts, plain words, links, order ids only", () => {
  const rows = Object.fromEntries(propsOf(runs.support, "ActionQueue").rows.map((r) => [r.id, r]));
  eq(Object.keys(rows).sort().join(","), "cod_waiting,contact_failed,push_failed,push_stuck,refund_missing,returns_open", "rows:");
  eq(rows.push_failed.count, 2, "push failed:");
  eq(rows.push_failed.href, "/admin/orders?status=sync_failed", "push failed link:");
  eq(rows.push_stuck.orders.join(","), "DASH-STUCK1", "stuck → the order:");
  eq(rows.refund_missing.orders.join(","), "DASH-REF1", "refund not mirrored → the order:");
  eq(rows.returns_open.count, 1, "open returns (a rejected one is not open):");
  eq(rows.returns_open.href, "/admin/orders?view=returns", "returns link:");
  eq(rows.cod_waiting.count, 1, "COD over 15 minutes (the 5-minute one waits):");
  eq(rows.cod_waiting.href, "/admin/orders?status=cod_pending", "COD link:");
  eq(rows.contact_failed.count, 1, "contact failures:");
  eq(rows.contact_failed.href, undefined, "support gets no Integrations link:");
  ok(/admin/.test(rows.contact_failed.hint), `support is told to ask an admin: ${rows.contact_failed.hint}`);
  for (const r of Object.values(rows)) ok(typeof r.words === "string" && !/_/.test(r.words) && typeof r.count === "number", `plain words and a count: ${JSON.stringify(r)}`);
  const keys = new Set(Object.values(rows).flatMap((r) => Object.keys(r)));
  eq([...keys].filter((k) => !["id", "count", "words", "hint", "href", "orders"].includes(k)).join(","), "", "row keys:");
});

await t("sales: today's orders, refunds netted out, in the store's currency", () => {
  const s = propsOf(runs.support, "SalesSummary").sales;
  // sale statuses only: OK1, FAIL1, FAIL2, STUCK1, REF1, COD1, COD2 = 7 orders of 500, one refund of 100
  eq(s.range.orders, 7, "orders in range:");
  eq(s.range.net, 3400, "net (3500 - 100):");
  eq(s.currency, "INR", "currency:");
  eq(s.series.length, 30, "30 days by default:");
  eq(propsOf(runs.support, "SalesSummary").newStore, null, "a store with orders isn't new:");
});

await t("?days=7 and ?days=90 set the range; anything else is 30", async () => {
  for (const [q, want] of [["7", 7], ["90", 90], ["14", 30], ["x", 30]]) {
    const r = await pages.run(PAGE, { cookies: cookies.support, searchParams: { days: q } });
    eq(propsOf(r, "RangeSwitch").days, want, `?days=${q}:`);
    eq(propsOf(r, "SalesChart").sales.series.length, want, `?days=${q} chart:`);
  }
});

await t("store status: closed with the onboarding count, address, catalog, unpublished changes, no banner reason", () => {
  const st = propsOf(runs.support, "StoreStatus").status;
  eq(st.status, "active", "status:");
  eq(st.open.open, false, "closed (nothing published):");
  ok(Number.isInteger(st.open.doneCount) && st.open.total === 4, `onboarding n/4: ${JSON.stringify(st.open)}`);
  eq(st.address, a.tenant.domains[0], "address:");
  eq(st.catalog.count, 2, "products:");
  ok(typeof st.unpublished === "number", `unpublished: ${st.unpublished}`);
  eq(propsOf(runs.support, "StoreStatus").pushPct, 29, "pushed share (2 of 7 sales have a Shopify id):");
});

await t("the freshness line is plain words", () => {
  ok(/Last order .* ago\.|Last order just now\./.test(runs.support.text), "last order");
  ok(/Catalog (synced .*|never synced)\./.test(runs.support.text), "catalog");
  ok(/Analytics (sees about \d+%|coverage shows)/.test(runs.support.text), "analytics coverage");
});

// ---- 3. each part on its own --------------------------------------------------------------
console.log("— each part caught on its own");

await t("a table that can't be read: that row says Couldn't check, the rest still shows", async () => {
  await a.run(() => libsql.execute("ALTER TABLE return_requests RENAME TO return_requests_gone"));
  try {
    const rows = await a.run(() => D.actionQueue({ role: "support" }));
    const r = rows.find((x) => x.id === "returns_open");
    ok(r?.unknown === true && /^Couldn't check/.test(r.words), `returns row: ${JSON.stringify(r)}`);
    ok(rows.find((x) => x.id === "push_failed")?.count === 2, "push failed still counted");
    const run = await pages.run(PAGE, { cookies: cookies.support });
    ok(!run.error && propsOf(run, "ActionQueue"), `the page still renders: ${run.error?.message}`);
  } finally {
    await a.run(() => libsql.execute("ALTER TABLE return_requests_gone RENAME TO return_requests"));
  }
});

await t("the banner's facts: an active store has none; a store in maintenance; a suspended store", async () => {
  const { currentTenant } = await import("../lib/tenant-context.js");
  // the tenant object may be cached between calls: each case sets both facts, and the last puts them back
  const as = (change) =>
    a.run(() => {
      change(currentTenant());
      return D.storeStatus({ role: "support" });
    });
  const plain = await as(() => {});
  eq(`${plain.status}/${plain.maintenance}`, "active/false", "active:");
  const maint = await as((t0) => {
    t0.status = "active";
    t0.config = { ...t0.config, maintenance: { enabled: true } };
  });
  eq(`${maint.status}/${maint.maintenance}`, "active/true", "maintenance:");
  const susp = await as((t0) => {
    t0.status = "suspended";
    t0.config = { ...t0.config, maintenance: { enabled: false } };
  });
  eq(`${susp.status}/${susp.maintenance}`, "suspended/false", "suspended:");
  const back = await as((t0) => (t0.status = "active"));
  eq(`${back.status}/${back.maintenance}`, "active/false", "back to active:");
});

await t("the page source: every write is gated, and the dashboard is on the new-UI list", async () => {
  const src = await readFile(join(ROOT, PAGE), "utf8");
  ok(/gateAction\("sync\.run", role\)/.test(src), "Run again is gated on sync.run");
  const { isNewUiRoute } = await import("../lib/admin/new-ui-routes.js");
  ok(isNewUiRoute("/admin/dashboard"), "the dashboard is a new-UI route");
});

await t("over 50 dead-lettered orders: stuck pushes and missing refunds are still counted in full (real COUNTs, not a cut list)", async () => {
  const dead = Array.from({ length: 60 }, (_, i) => order(`DASH-DEAD${i}`, { status: "sync_failed", sync_attempts: 9, sync_error: "dead", created_at: iso(i * 1000), updated_at: iso(i * 1000) }));
  const stuck = Array.from({ length: 7 }, (_, i) => order(`DASH-STUCKX${i}`, { status: "syncing_shopify", created_at: iso(4 * 3600_000), updated_at: iso(2 * 3600_000) }));
  await a.run(() => db.insertInto("orders").values([...dead, ...stuck]).execute());
  const rows = Object.fromEntries((await a.run(() => D.actionQueue({ role: "support" }))).map((r) => [r.id, r]));
  eq(rows.push_failed.count, 62, "every failed push (2 + 60 dead-lettered):");
  eq(rows.push_stuck.count, 8, "every stuck push (1 + 7):");
  eq(rows.push_stuck.orders.length, D.ORDERS_SHOWN, "the row links the first few:");
  eq(rows.refund_missing.count, 1, "the missing refund still shows:");
  eq(rows.refund_missing.orders.join(","), "DASH-REF1", "and links its order:");
});

await t("?days=7: the summary gets the 7-day range (its card shows the refunds, not a second Last 7 days: drill:dashboard)", async () => {
  const r = await pages.run(PAGE, { cookies: cookies.support, searchParams: { days: "7" } });
  const s = propsOf(r, "SalesSummary").sales;
  eq(s.range.days, 7, "range:");
  eq(s.range.net, s.week.net, "the range is the week:");
  const src = await readFile(join(ROOT, "components/admin/dashboard/SalesSummary.js"), "utf8");
  ok(/range\.days === 7 \?/.test(src) && /Refunds, last 7 days/.test(src), "the 7-day range swaps its card");
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

await store.cleanup();
for (const f of [".test-dash-default.db", ".test-dash-default.db-wal", ".test-dash-default.db-shm"]) await rm(join(ROOT, f), { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
