// Session 10 — order model tests: idempotent creation + status state machine.
//   node scripts/test-orders.js          (pnpm test:orders)
//
// Runs against an ISOLATED throwaway libSQL file — env is forced BEFORE
// lib/db.js is imported, so this can never touch the configured Turso DB.
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-orders.db";

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, "../.test-orders.db"), { force: true });

const { libsql, db } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const O = await import("../lib/orders.js");

// --- tiny harness (same spirit as test-offers.js) ---------------------------
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
function eq(got, want, label = "") {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function ok(cond, label) {
  if (!cond) throw new Error(label || "expected truthy");
}
async function throws(fn, match, label = "") {
  try {
    await fn();
  } catch (e) {
    if (match && !String(e.message).toLowerCase().includes(match.toLowerCase()))
      throw new Error(`${label} threw, but "${e.message}" does not match "${match}"`);
    return e;
  }
  throw new Error(`${label} expected to throw`);
}

// --- fixtures ---------------------------------------------------------------
const CART = {
  items: [
    {
      variantId: "gid://shopify/ProductVariant/45042167054553",
      productId: "gid://shopify/Product/8996072095961",
      title: "Isorich Whey 924g",
      variantTitle: "Chocolate",
      image: null,
      price: 4949,
      quantity: 2,
      lineTotal: 9898,
      discount: 494.9,
    },
    {
      variantId: "gid://shopify/ProductVariant/45321217147097",
      productId: "gid://shopify/Product/9088743964889",
      title: "Beast Recovery BCAA (Mango)",
      variantTitle: null,
      image: null,
      price: 499,
      quantity: 1,
      lineTotal: 499,
      discount: 0,
    },
  ],
  gifts: [
    {
      variantId: "gid://shopify/ProductVariant/45042167185625",
      productId: "gid://shopify/Product/8996072128729",
      title: "Beast Shaker 700ml",
      image: null,
    },
  ],
  appliedOffers: [
    { id: "tier-whey", label: "Whey ×2 — 5% off", amount: 494.9 },
    { id: "coupon-BEAST10", label: "Coupon BEAST10 (10%)", amount: 990.21 },
  ],
  couponStatus: { valid: true, code: "BEAST10" },
  subtotal: 10397,
  discountTotal: 1485.11,
  total: 8911.89,
  currency: "INR",
};
const CONTACT = { email: "test@beastlife.in", phone: "9000000000", name: "Test Beast" };
const ADDRESS = { line1: "1 Gym Lane", line2: "", city: "Pune", state: "MH", pincode: "411001", country: "India" };

const key = (s) => `test-intent-${s}`;
const mk = (over = {}) =>
  O.createOrder({ cart: CART, contact: CONTACT, address: ADDRESS, paymentMethod: "cod", ...over });

const orderRow = (id) =>
  db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirst();
const countBy = async (table, col, val) =>
  Number(
    (await db.selectFrom(table).select(db.fn.countAll().as("n")).where(col, "=", val).executeTakeFirst()).n,
  );
const events = (id) =>
  db.selectFrom("order_events").selectAll().where("order_id", "=", id).orderBy("id", "asc").execute();

// --- creation + snapshot ----------------------------------------------------
await t("create: COD order lands in cod_pending with full snapshot", async () => {
  const o = await mk({ idempotencyKey: key("create") });
  eq(o.deduped, false, "deduped");
  eq(o.status, "cod_pending", "status");
  const row = await orderRow(o.id);
  eq(row.payment_status, "cod", "payment_status");
  eq(row.idempotency_key, key("create"), "idempotency_key");
  eq(row.total, 8911.89, "total");
  eq(row.shipping_total, 0, "shipping_total");
  const snap = JSON.parse(row.snapshot);
  eq(snap.v, 1, "snapshot.v");
  eq(snap.items.length, 2, "snapshot items");
  eq(snap.gifts.length, 1, "snapshot gifts");
  eq(snap.appliedOffers.length, 2, "snapshot offers");
  eq(snap.coupon.code, "BEAST10", "snapshot coupon");
  eq(snap.totals.total, 8911.89, "snapshot totals.total");
  eq(snap.totals.discountTotal, 1485.11, "snapshot discountTotal");
  eq(snap.address.pincode, "411001", "snapshot address");
  eq(snap.payment.method, "cod", "snapshot payment");
  eq(await countBy("order_items", "order_id", o.id), 3, "order_items (2 paid + 1 gift)");
  const ev = await events(o.id);
  eq(ev.length, 1, "events");
  eq(ev[0].from_status, null, "event from");
  eq(ev[0].to_status, "cod_pending", "event to");
});

await t("sequential duplicate: same key returns the SAME order, writes nothing", async () => {
  const a = await mk({ idempotencyKey: key("dup-seq") });
  const b = await mk({ idempotencyKey: key("dup-seq") });
  eq(b.deduped, true, "second call deduped");
  eq(b.id, a.id, "same order id");
  eq(await countBy("orders", "idempotency_key", key("dup-seq")), 1, "orders rows");
  eq(await countBy("order_items", "order_id", a.id), 3, "items not duplicated");
  eq((await events(a.id)).length, 1, "events not duplicated");
});

await t("concurrent duplicate: two rapid submissions → exactly ONE order", async () => {
  const [a, b] = await Promise.all([
    mk({ idempotencyKey: key("dup-race") }),
    mk({ idempotencyKey: key("dup-race") }),
  ]);
  eq(a.id, b.id, "both callers got the same order");
  ok(a.deduped !== b.deduped, "exactly one insert won the race");
  eq(await countBy("orders", "idempotency_key", key("dup-race")), 1, "orders rows");
});

await t("different keys → different orders", async () => {
  const a = await mk({ idempotencyKey: key("k1") });
  const b = await mk({ idempotencyKey: key("k2") });
  ok(a.id !== b.id, "distinct orders");
});

await t("key reuse with a DIFFERENT total → IDEMPOTENCY_CONFLICT", async () => {
  await mk({ idempotencyKey: key("conflict") });
  const changed = { ...CART, total: CART.total + 499 };
  const e = await throws(
    () => mk({ idempotencyKey: key("conflict"), cart: changed }),
    "different cart total",
    "conflicting reuse",
  );
  eq(e.code, "IDEMPOTENCY_CONFLICT", "error code");
});

await t("missing idempotencyKey is rejected", async () => {
  await throws(() => mk({}), "idempotencyKey is required", "no key");
});

// --- payment transitions ----------------------------------------------------
await t("razorpay order starts pending_payment; markOrderPaid → paid", async () => {
  const o = await mk({
    idempotencyKey: key("pay"),
    paymentMethod: "razorpay",
    razorpayOrderId: "order_TEST123",
  });
  eq(o.status, "pending_payment", "initial status");
  const r = await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_TEST123" });
  eq(r.already, false, "first verify transitions");
  const row = await orderRow(o.id);
  eq(row.status, "paid", "status");
  eq(row.payment_status, "paid", "payment_status");
  eq(row.razorpay_payment_id, "pay_TEST123", "payment id");
  ok(row.paid_at, "paid_at set");
  const ev = await events(o.id);
  eq(ev.length, 2, "events: created + paid");
  eq(ev[1].from_status, "pending_payment", "paid event from");
  eq(JSON.parse(ev[1].meta).razorpay_payment_id, "pay_TEST123", "paid event meta");
});

await t("duplicate payment callback (same payment id) is a no-op", async () => {
  const o = await mk({ idempotencyKey: key("pay-dup"), paymentMethod: "razorpay", razorpayOrderId: "order_D1" });
  await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_D1" });
  const before = (await orderRow(o.id)).paid_at;
  const r = await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_D1" });
  eq(r.already, true, "second verify is a replay");
  eq((await orderRow(o.id)).paid_at, before, "paid_at unchanged");
  eq((await events(o.id)).length, 2, "no third event");
});

await t("DIFFERENT payment id on an already-paid order → error", async () => {
  const o = await mk({ idempotencyKey: key("pay-diff"), paymentMethod: "razorpay", razorpayOrderId: "order_D2" });
  await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_A" });
  await throws(() => O.markOrderPaid(o.id, { razorpayPaymentId: "pay_B" }), "different payment", "conflicting payment");
});

await t("concurrent verify race → exactly one paid event", async () => {
  const o = await mk({ idempotencyKey: key("pay-race"), paymentMethod: "razorpay", razorpayOrderId: "order_D3" });
  const [a, b] = await Promise.all([
    O.markOrderPaid(o.id, { razorpayPaymentId: "pay_R" }),
    O.markOrderPaid(o.id, { razorpayPaymentId: "pay_R" }),
  ]);
  ok(a.ok && b.ok, "both callers succeed");
  eq((await events(o.id)).length, 2, "created + ONE paid event");
});

// --- state machine rules ----------------------------------------------------
await t("invalid transitions throw (paid ↛ synced, cod_pending ↛ paid)", async () => {
  const rz = await mk({ idempotencyKey: key("sm-1"), paymentMethod: "razorpay", razorpayOrderId: "order_S1" });
  await O.markOrderPaid(rz.id, { razorpayPaymentId: "pay_S1" });
  await throws(() => O.transitionOrder(rz.id, "synced"), "invalid order transition", "paid → synced skips syncing");
  const cod = await mk({ idempotencyKey: key("sm-2") });
  await throws(() => O.markOrderPaid(cod.id), "invalid order transition", "cod_pending → paid not modelled yet");
});

await t("cancel: pending_payment → cancelled; cancelled is terminal", async () => {
  const o = await mk({ idempotencyKey: key("cancel"), paymentMethod: "razorpay", razorpayOrderId: "order_C1" });
  const r = await O.transitionOrder(o.id, "cancelled", { meta: { reason: "user abandoned" } });
  eq(r.status, "cancelled", "cancelled");
  await throws(() => O.markOrderPaid(o.id, { razorpayPaymentId: "pay_C1" }), "invalid order transition", "pay after cancel");
});

// --- shopify sync lifecycle -------------------------------------------------
await t("lifecycle: paid → syncing_shopify → synced, event chain in order", async () => {
  const o = await mk({ idempotencyKey: key("sync"), paymentMethod: "razorpay", razorpayOrderId: "order_Y1" });
  await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_Y1" });
  const s = await O.beginShopifySync(o.id);
  eq(s.status, "syncing_shopify", "syncing");
  eq((await orderRow(o.id)).sync_attempts, 1, "attempt counted");
  await O.completeShopifySync(o.id, { shopifyOrderId: "gid://shopify/Order/597492" });
  const row = await orderRow(o.id);
  eq(row.status, "synced", "synced");
  eq(row.shopify_order_id, "gid://shopify/Order/597492", "shopify id stored");
  ok(row.synced_at, "synced_at set");
  eq(row.payment_status, "paid", "payment_status survives workflow moves");
  const chain = (await events(o.id)).map((e) => e.to_status).join(" → ");
  eq(chain, "pending_payment → paid → syncing_shopify → synced", "event chain");
  await throws(() => O.beginShopifySync(o.id), "invalid order transition", "synced is terminal");
});

await t("sync failure loop: fail → retry → synced; error recorded then cleared", async () => {
  const o = await mk({ idempotencyKey: key("sync-fail"), paymentMethod: "razorpay", razorpayOrderId: "order_Y2" });
  await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_Y2" });
  await O.beginShopifySync(o.id);
  await O.failShopifySync(o.id, { error: "429 throttled by Shopify" });
  let row = await orderRow(o.id);
  eq(row.status, "sync_failed", "failed");
  eq(row.sync_error, "429 throttled by Shopify", "error stored");
  await O.beginShopifySync(o.id);
  eq((await orderRow(o.id)).sync_attempts, 2, "second attempt counted");
  await O.completeShopifySync(o.id, { shopifyOrderId: "gid://shopify/Order/597493" });
  row = await orderRow(o.id);
  eq(row.status, "synced", "synced after retry");
  eq(row.sync_error, null, "error cleared");
  const froms = (await events(o.id)).map((e) => `${e.from_status}→${e.to_status}`);
  eq(
    froms.join(", "),
    "null→pending_payment, pending_payment→paid, paid→syncing_shopify, syncing_shopify→sync_failed, sync_failed→syncing_shopify, syncing_shopify→synced",
    "full audit trail",
  );
});

await t("COD order also syncs: cod_pending → syncing_shopify → synced", async () => {
  const o = await mk({ idempotencyKey: key("sync-cod") });
  await O.beginShopifySync(o.id);
  await O.completeShopifySync(o.id, { shopifyOrderId: "gid://shopify/Order/597494" });
  const row = await orderRow(o.id);
  eq(row.status, "synced", "synced");
  eq(row.payment_status, "cod", "still COD money-wise");
});

await t("concurrent beginShopifySync → one event, one attempt", async () => {
  const o = await mk({ idempotencyKey: key("sync-race"), paymentMethod: "razorpay", razorpayOrderId: "order_Y3" });
  await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_Y3" });
  await Promise.all([O.beginShopifySync(o.id), O.beginShopifySync(o.id)]);
  const row = await orderRow(o.id);
  eq(row.status, "syncing_shopify", "syncing");
  eq(row.sync_attempts, 1, "attempts not double-counted");
  eq((await events(o.id)).filter((e) => e.to_status === "syncing_shopify").length, 1, "one syncing event");
});

// --- reads ------------------------------------------------------------------
await t("getOrder returns parsed snapshot, items, and the event trail", async () => {
  const o = await mk({ idempotencyKey: key("read"), paymentMethod: "razorpay", razorpayOrderId: "order_G1" });
  await O.markOrderPaid(o.id, { razorpayPaymentId: "pay_G1" });
  const full = await O.getOrder(o.id);
  eq(full.snapshot.totals.total, 8911.89, "snapshot parsed");
  eq(full.items.length, 3, "items");
  eq(full.items[2].is_gift, true, "gift flagged");
  eq(full.events.length, 2, "events included");
  eq(full.events[1].meta.razorpay_payment_id, "pay_G1", "event meta parsed");
  eq(full.appliedOffers.length, 2, "offers parsed");
});

await t("findOrderByIdempotencyKey returns the row (and null for unknown)", async () => {
  const o = await mk({ idempotencyKey: key("find") });
  eq((await O.findOrderByIdempotencyKey(key("find"))).id, o.id, "found");
  eq(await O.findOrderByIdempotencyKey(key("nope")), null, "unknown → null");
  eq(await O.findOrderByIdempotencyKey(null), null, "null key → null");
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
await rm(join(here, "../.test-orders.db"), { force: true });
process.exit(fail ? 1 : 0);
