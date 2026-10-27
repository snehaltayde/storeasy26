// Order projection + money suite (Session 31 / BE10+BE36+SF09+MC16):
// authoritative reconciliation (dedup, out-of-order watermark, no revenue
// double-count, no status regression), two-parcel fixtures, minor-unit money,
// drift-free allocation, role redaction and the push-message mapper.
//   pnpm test:order-projection
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-proj-default.db";
process.env.PLATFORM_DB_URL = "file:.test-proj-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-proj-default.db", ".test-proj-platform.db", ".test-proj-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const M = await import("../lib/money.js");
const P = await import("../lib/order-projection.js");
const W = await import("../lib/platform/shopify-webhooks.js");
const V = await import("../lib/admin/order-view.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { applyTenantSchema } = await import("../lib/platform/provision.js");
const { readFile } = await import("node:fs/promises");

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

// --- BE36: money ---------------------------------------------------------------
await t("money: minor units per currency, roundMoney kills float noise, sameAmount", () => {
  eq(M.toMinor(437, "INR"), 43700, "INR paise");
  eq(M.toMinor("12.345", "KWD"), 12345, "3-decimal KWD");
  eq(M.toMinor(500, "JPY"), 500, "0-decimal JPY");
  eq(M.fromMinor(43700, "INR"), 437, "back");
  eq(M.roundMoney(0.1 + 0.2, "INR"), 0.3, "float noise");
  eq(M.sameAmount(0.1 + 0.2, 0.3, "INR"), true, "same");
  eq(M.sameAmount(100, 100.01, "INR"), false, "one paisa apart");
  eq(M.sameAmount(100, 100.4, "JPY"), true, "sub-minor in JPY rounds together");
  eq(M.currencyExponent("XYZ"), 2, "unknown currency → ISO default 2");
});

await t("money: allocateProportional sums exactly, largest-remainder, degenerate weights", () => {
  const parts = M.allocateProportional(100, [1, 1, 1], "INR"); // 10000 paise / 3
  eq(parts.reduce((a, b) => a + b, 0), 10000, "no drift");
  eq(JSON.stringify(parts), "[3334,3333,3333]", "largest remainder");
  const weighted = M.allocateProportional(437, [289, 99, 49], "INR");
  eq(weighted.reduce((a, b) => a + b, 0), 43700, "weighted sums exactly");
  eq(JSON.stringify(M.allocateProportional(50, [0, 0], "INR")), "[5000,0]", "zero weights → first part");
});

// --- fixtures ----------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "pj", name: "Projection", domains: [], dbUrl: "file:.test-proj-t1.db", config: {}, secrets: {} });
await applyTenantSchema(createClient({ url: "file:.test-proj-t1.db" }));
const PJ = await C.getTenant("pj");
const inT = (fn) => withTenant(PJ, fn);

const GID = "gid://shopify/Order/9001";
await inT(() =>
  db
    .insertInto("orders")
    .values({
      id: "BL-PROJTEST",
      status: "synced",
      payment_method: "razorpay",
      payment_status: "paid",
      total: 437,
      currency: "INR",
      shopify_order_id: GID,
      email: "pii@example.com",
      phone: "9999999999",
      name: "Pii Person",
      address_line1: "Secret Lane",
      city: "Pune",
      created_at: new Date().toISOString(),
    })
    .execute(),
);

const snapshot = ({ updatedAt, refunds = [], fulfillments = [], financial = "PAID", fulfillment = "UNFULFILLED", cancelledAt = null }) => ({
  node: {
    id: GID,
    name: "OID9001",
    updatedAt,
    cancelledAt,
    displayFinancialStatus: financial,
    displayFulfillmentStatus: fulfillment,
    refunds,
    fulfillments,
  },
});
const gqlFor = (snap) => async () => snap;
const refund = (id, amount, createdAt) => ({
  id: `gid://shopify/Refund/${id}`,
  createdAt,
  note: null,
  totalRefundedSet: { shopMoney: { amount: String(amount), currencyCode: "INR" } },
});
const parcel = (id, number, { status = "SUCCESS", updatedAt = "2026-10-28T10:00:00Z", url = null } = {}) => ({
  id: `gid://shopify/Fulfillment/${id}`,
  status,
  updatedAt,
  trackingInfo: number ? [{ company: "Delhivery", number, url }] : [],
});

// --- BE10: reconciliation ---------------------------------------------------------
await t("reconcile: snapshot writes refunds + parcels + status/totals", async () => {
  const r = await inT(() =>
    P.reconcileOrderProjection("BL-PROJTEST", {
      gql: gqlFor(
        snapshot({
          updatedAt: "2026-10-28T10:00:00Z",
          financial: "PARTIALLY_REFUNDED",
          fulfillment: "PARTIALLY_FULFILLED",
          refunds: [refund(1, 100, "2026-10-28T09:00:00Z")],
          fulfillments: [parcel("f1", "TRK001", { url: "https://track/1" })],
        }),
      ),
    }),
  );
  eq(r.ok, true, "ok");
  eq(r.financial_status, "partially_refunded", "financial");
  eq(r.fulfillment_status, "partially_fulfilled", "fulfillment");
  eq(r.refunded_total, 100, "refunded total");
  const proj = await inT(() => P.getOrderProjection("BL-PROJTEST"));
  eq(proj.refunds.length, 1, "refund row");
  eq(proj.fulfillments[0].tracking_number, "TRK001", "tracking");
});

await t("DEDUP: replaying the identical snapshot cannot double revenue", async () => {
  const snap = snapshot({
    updatedAt: "2026-10-28T10:00:00Z",
    financial: "PARTIALLY_REFUNDED",
    refunds: [refund(1, 100, "2026-10-28T09:00:00Z")],
  });
  await inT(() => P.reconcileOrderProjection("BL-PROJTEST", { gql: gqlFor(snap) }));
  await inT(() => P.reconcileOrderProjection("BL-PROJTEST", { gql: gqlFor(snap) }));
  const row = await inT(() => db.selectFrom("orders").select(["refunded_total"]).where("id", "=", "BL-PROJTEST").executeTakeFirst());
  eq(row.refunded_total, 100, "still 100, not 200");
  eq((await inT(() => P.getOrderProjection("BL-PROJTEST"))).refunds.length, 1, "one refund row");
});

await t("OUT-OF-ORDER: an older snapshot is refused — no status/revenue regression", async () => {
  const stale = await inT(() =>
    P.reconcileOrderProjection("BL-PROJTEST", {
      gql: gqlFor(snapshot({ updatedAt: "2026-10-28T08:00:00Z", financial: "PAID", refunds: [] })),
    }),
  );
  eq(stale.stale, true, "refused as stale");
  const row = await inT(() => db.selectFrom("orders").select(["financial_status", "refunded_total"]).where("id", "=", "BL-PROJTEST").executeTakeFirst());
  eq(row.financial_status, "partially_refunded", "no regression to paid");
  eq(row.refunded_total, 100, "revenue not rewound");
});

await t("newer snapshot: second refund accumulates; full refund maps to refunded", async () => {
  const r = await inT(() =>
    P.reconcileOrderProjection("BL-PROJTEST", {
      gql: gqlFor(
        snapshot({
          updatedAt: "2026-10-28T11:00:00Z",
          financial: "REFUNDED",
          refunds: [refund(1, 100, "2026-10-28T09:00:00Z"), refund(2, 337, "2026-10-28T10:30:00Z")],
        }),
      ),
    }),
  );
  eq(r.refunded_total, 437, "sums exactly to the total");
  eq(r.financial_status, "refunded", "refunded");
});

await t("TWO-PARCEL fixture: independent rows with distinct tracking (SF09 data)", async () => {
  await inT(() =>
    P.reconcileOrderProjection("BL-PROJTEST", {
      gql: gqlFor(
        snapshot({
          updatedAt: "2026-10-28T12:00:00Z",
          fulfillment: "PARTIALLY_FULFILLED",
          refunds: [refund(1, 100, "2026-10-28T09:00:00Z"), refund(2, 337, "2026-10-28T10:30:00Z")],
          fulfillments: [
            parcel("f1", "TRK001", { updatedAt: "2026-10-28T10:00:00Z" }),
            parcel("f2", "TRK002", { updatedAt: "2026-10-28T11:30:00Z" }),
          ],
        }),
      ),
    }),
  );
  const proj = await inT(() => P.getOrderProjection("BL-PROJTEST"));
  eq(proj.fulfillments.length, 2, "two parcels");
  eq(proj.fulfillments.map((f) => f.tracking_number).join(","), "TRK001,TRK002", "distinct tracking");
  ok(proj.fulfillments.every((f) => f.updated_at), "per-parcel last-update timestamps");
});

await t("guards: unpushed order skipped; unknown shopify order ignored", async () => {
  await inT(() => db.insertInto("orders").values({ id: "BL-UNPUSHED", status: "paid", total: 10, created_at: new Date().toISOString() }).execute());
  eq((await inT(() => P.reconcileOrderProjection("BL-UNPUSHED"))).skipped, "not_pushed", "unpushed");
  eq((await inT(() => P.reconcileByShopifyOrderGid("gid://shopify/Order/404404"))).ignored, "no_local_order", "unknown gid");
});

await t("webhook router: refunds/fulfillments/cancelled hints trigger the reconcile", async () => {
  const snap = snapshot({ updatedAt: "2026-10-28T13:00:00Z", financial: "REFUNDED", fulfillment: "FULFILLED",
    refunds: [refund(1, 100, "2026-10-28T09:00:00Z"), refund(2, 337, "2026-10-28T10:30:00Z")],
    fulfillments: [parcel("f1", "TRK001")] });
  const r = await inT(() => W.applyWebhook("refunds/create", { order_id: 9001 }, { gql: gqlFor(snap) }));
  eq(r.ok, true, "refund hint reconciled");
  eq(r.fulfillment_status, "fulfilled", "status refreshed");
  eq(W.orderGid({ order_id: 9001 }), "gid://shopify/Order/9001", "numeric order_id → gid");
  eq(W.orderGid({ id: 7 }), "gid://shopify/Order/7", "orders/* id → gid");
  eq(W.orderGid({ admin_graphql_api_order_id: "gid://shopify/Order/5" }), "gid://shopify/Order/5", "gid passthrough");
});

// --- MC16: view helpers ---------------------------------------------------------------
await t("redactOrderForRole: support loses PII + snapshot; other roles untouched", async () => {
  const order = await inT(() => db.selectFrom("orders").selectAll().where("id", "=", "BL-PROJTEST").executeTakeFirst());
  const red = V.redactOrderForRole({ ...order, snapshot: "{\"contact\":{}}" }, "support");
  eq(red.email, null, "email gone");
  eq(red.phone, null, "phone gone");
  eq(red.address_line1, null, "address gone");
  eq(red.snapshot, null, "snapshot gone");
  eq(red.pii_redacted, true, "flagged");
  eq(red.total, 437, "money stays");
  eq(V.redactOrderForRole({ ...order }, "staff").email, "pii@example.com", "staff keeps PII");
});

await t("pushResultMessage: refusal shapes get honest copy (the 'Push failed: 200' fix)", () => {
  ok(/Not pushable from status "cancelled"/.test(V.pushResultMessage({ ok: false, skipped: "cancelled" }, 200)), "skipped");
  ok(/already in flight/.test(V.pushResultMessage({ ok: false, inFlight: true }, 200)), "inFlight");
  ok(/didn't match/.test(V.pushResultMessage({ ok: false, mismatch: true }, 200)), "mismatch");
  ok(/Dead-lettered/.test(V.pushResultMessage({ ok: false, dead: true, attempts: 5 }, 200)), "dead");
  ok(/Dead-lettered: boom/.test(V.pushResultMessage({ ok: false, failed: "boom", dead: true }, 200)), "failed+dead");
  eq(V.pushResultMessage({ ok: true }, 200), "Pushed to Shopify ✓", "ok");
  eq(V.pushResultMessage({ ok: true, already: true }, 200), "Already synced to Shopify", "already");
  ok(/HTTP 500/.test(V.pushResultMessage({}, 500)), "real http error");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
