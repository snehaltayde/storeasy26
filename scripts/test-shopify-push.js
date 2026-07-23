// Session 12 — Shopify push pipeline tests: idempotency, retries with bounded
// backoff, dead-letter + alert, reconciliation guard, stale-worker recovery.
//   node scripts/test-shopify-push.js          (pnpm test:shopify-push)
//
// Fully isolated: throwaway libSQL file (env forced BEFORE lib/db.js loads),
// injectable fake Shopify transports (no real store), and a LOCAL http server
// as the alert webhook catcher (real delivery path, no external service).
import { rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-shopify-push.db";
process.env.SHOPIFY_SYNC_MAX_ATTEMPTS = "3";
process.env.SHOPIFY_SYNC_BACKOFF_MS = "1"; // everything due immediately unless a test overrides
process.env.SHOPIFY_SYNC_STALE_MS = "999999999";

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, "../.test-shopify-push.db"), { force: true });

// local alert catcher — the REAL sendAlert delivery path, caught locally
const alerts = [];
const catcher = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    alerts.push(JSON.parse(body));
    res.writeHead(200).end("{}");
  });
});
await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${catcher.address().port}/alert`;

const { libsql, db } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const O = await import("../lib/orders.js");
const P = await import("../lib/shopify-push.js");

// --- harness ---------------------------------------------------------------
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

// --- fixtures --------------------------------------------------------------
const CART = {
  items: [
    { variantId: "gid://shopify/ProductVariant/45042167054553", productId: "gid://shopify/Product/1", title: "Isorich Whey 924g", variantTitle: "Chocolate", image: null, price: 4949, quantity: 2, lineTotal: 9898, discount: 494.9 },
    { variantId: "gid://shopify/ProductVariant/45321217147097", productId: "gid://shopify/Product/2", title: "BCAA Mango", variantTitle: null, image: null, price: 499, quantity: 1, lineTotal: 499, discount: 0 },
  ],
  gifts: [{ variantId: "gid://shopify/ProductVariant/48656508289241", productId: "gid://shopify/Product/3", title: "Beast Shaker", image: null }],
  appliedOffers: [
    { id: "tier-whey", label: "Whey ×2 — 5% off", amount: 494.9 },
    { id: "coupon-BEAST10", label: "BEAST10 (10%)", amount: 990.21 },
  ],
  couponStatus: { valid: true, code: "BEAST10" },
  subtotal: 10397,
  discountTotal: 1485.11,
  total: 8911.89,
  currency: "INR",
};
const CONTACT = { email: "push@beastlife.in", phone: "9000000012", name: "Push Tester" };
const ADDRESS = { line1: "12 Sync St", line2: "", city: "Pune", state: "MH", pincode: "411001", country: "India" };

let seq = 0;
async function seedOrder({ method = "razorpay", paid = true } = {}) {
  const o = await O.createOrder({
    cart: CART,
    contact: CONTACT,
    address: ADDRESS,
    paymentMethod: method,
    idempotencyKey: `push-test-${++seq}`,
    razorpayOrderId: method === "razorpay" ? `order_T${seq}` : null,
  });
  if (paid && method === "razorpay") await O.markOrderPaid(o.id, { razorpayPaymentId: `pay_T${seq}` });
  return o.id;
}

// Fake Shopify: mutation checks FIRST (the find query also mentions draftOrders).
function mockShopify({ total = CART.total, failures = 0, existingOrder = null, existingDraft = null } = {}) {
  const calls = [];
  let failuresLeft = failures;
  const gql = async (query, variables) => {
    const op = query.includes("draftOrderCreate")
      ? "create"
      : query.includes("draftOrderComplete")
        ? "complete"
        : "find";
    calls.push({ op, variables });
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error("simulated Shopify 502");
    }
    if (op === "find")
      return {
        orders: { nodes: existingOrder ? [existingOrder] : [] },
        draftOrders: { nodes: existingDraft ? [existingDraft] : [] },
      };
    if (op === "create")
      return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/999", name: "#D999" }, userErrors: [] } };
    return {
      draftOrderComplete: {
        draftOrder: {
          id: variables.id,
          status: "COMPLETED",
          order: {
            id: "gid://shopify/Order/424242",
            name: "#TEST42",
            displayFinancialStatus: variables.pending ? "PENDING" : "PAID",
            totalPriceSet: { shopMoney: { amount: String(total) } },
          },
        },
        userErrors: [],
      },
    };
  };
  gql.calls = calls;
  return gql;
}

const orderRow = (id) => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirst();
const chain = async (id) =>
  (await db.selectFrom("order_events").selectAll().where("order_id", "=", id).orderBy("id", "asc").execute())
    .map((e) => e.to_status)
    .join(" → ");

// --- happy paths -----------------------------------------------------------
await t("paid order pushes: draft input correct, PAID, synced, reconciled", async () => {
  const id = await seedOrder();
  const gql = mockShopify();
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, `push failed: ${JSON.stringify(r)}`);
  eq(r.shopifyName, "#TEST42", "shopify name");
  eq(r.shopifyStatus, "PAID", "financial status");
  eq(r.adopted, false, "fresh create");
  eq(gql.calls.map((c) => c.op).join(","), "find,create,complete", "call sequence");

  const input = gql.calls[1].variables.input;
  eq(input.lineItems.length, 3, "2 paid lines + 1 gift");
  eq(input.lineItems[2].appliedDiscount.value, 100, "gift 100% off");
  eq(input.lineItems[2].appliedDiscount.valueType, "PERCENTAGE", "gift discount type");
  eq(input.appliedDiscount.valueType, "FIXED_AMOUNT", "order discount type");
  eq(input.appliedDiscount.value, 1485.11, "order discount = engine discountTotal");
  eq(input.shippingLine.price, "0.00", "shipping line present (free)");
  ok(input.tags.includes(id), "tagged with our order id");
  ok(input.customAttributes.some((a) => a.key === "razorpay_payment_id"), "razorpay ref attached");
  eq(input.shippingAddress.city, "Pune", "address mapped");
  eq(gql.calls[2].variables.pending, false, "paid ⇒ paymentPending false");

  const row = await orderRow(id);
  eq(row.status, "synced", "synced");
  eq(row.shopify_order_id, "gid://shopify/Order/424242", "gid stored");
  eq(row.sync_attempts, 1, "one attempt");
  ok(row.synced_at, "synced_at");
  eq(await chain(id), "pending_payment → paid → syncing_shopify → synced", "event chain");
});

await t("COD order pushes as payment-pending, stays cod money-wise", async () => {
  const id = await seedOrder({ method: "cod" });
  const gql = mockShopify();
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, JSON.stringify(r));
  eq(gql.calls[2].variables.pending, true, "COD ⇒ paymentPending true");
  eq(r.shopifyStatus, "PENDING", "financial status pending");
  const row = await orderRow(id);
  eq(row.status, "synced", "synced");
  eq(row.payment_status, "cod", "payment_status untouched");
});

// --- idempotency -----------------------------------------------------------
await t("duplicate push after synced: no-op, zero Shopify calls", async () => {
  const id = await seedOrder();
  await P.pushOrderToShopify(id, { gql: mockShopify() });
  const gql2 = mockShopify();
  const r = await P.pushOrderToShopify(id, { gql: gql2 });
  eq(r.already, true, "already synced");
  eq(gql2.calls.length, 0, "no Shopify traffic");
});

await t("push while another worker is syncing: skipped, no Shopify calls", async () => {
  const id = await seedOrder();
  await O.beginShopifySync(id); // another worker owns it
  const gql = mockShopify();
  const r = await P.pushOrderToShopify(id, { gql });
  eq(r.skipped, "syncing_shopify", "skipped");
  eq(gql.calls.length, 0, "no Shopify traffic");
});

await t("retry adopts an EXISTING Shopify order (crashed after create) — no duplicate", async () => {
  const id = await seedOrder();
  await P.pushOrderToShopify(id, { gql: mockShopify({ failures: 99 }) }); // attempt 1 dies
  eq((await orderRow(id)).status, "sync_failed", "failed once");
  const existingOrder = {
    id: "gid://shopify/Order/777",
    name: "#EXISTING",
    displayFinancialStatus: "PAID",
    totalPriceSet: { shopMoney: { amount: String(CART.total) } },
  };
  const gql = mockShopify({ existingOrder });
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, JSON.stringify(r));
  eq(r.adopted, true, "adopted");
  eq(r.shopifyOrderId, "gid://shopify/Order/777", "existing gid");
  eq(gql.calls.map((c) => c.op).join(","), "find", "search only — nothing created");
});

await t("retry completes a leftover OPEN draft instead of creating a second", async () => {
  const id = await seedOrder();
  await P.pushOrderToShopify(id, { gql: mockShopify({ failures: 99 }) });
  const gql = mockShopify({ existingDraft: { id: "gid://shopify/DraftOrder/555", status: "OPEN", order: null } });
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, JSON.stringify(r));
  eq(r.adopted, true, "adopted the draft");
  eq(gql.calls.map((c) => c.op).join(","), "find,complete", "no create call");
  eq(gql.calls[1].variables.id, "gid://shopify/DraftOrder/555", "completed the leftover");
});

// --- retries / dead-letter / alerts ---------------------------------------
await t("transient failure retries via sweep and succeeds", async () => {
  const id = await seedOrder();
  const r1 = await P.pushOrderToShopify(id, { gql: mockShopify({ failures: 1 }) });
  eq(r1.ok, false, "first attempt fails");
  eq((await orderRow(id)).status, "sync_failed", "sync_failed");
  ok((await orderRow(id)).sync_error.includes("simulated Shopify 502"), "error recorded");
  const sweep = await P.runSyncSweep({ gql: mockShopify() });
  const mine = sweep.pushed.find((p) => p.orderId === id);
  ok(mine?.ok, `sweep retry: ${JSON.stringify(sweep)}`);
  const row = await orderRow(id);
  eq(row.status, "synced", "synced after retry");
  eq(row.sync_attempts, 2, "two attempts");
  eq(row.sync_error, null, "error cleared");
});

await t("forced permanent failure dead-letters with EXACTLY ONE alert, zero loss", async () => {
  const id = await seedOrder();
  const before = alerts.length;
  const dead = mockShopify({ failures: Infinity });
  for (let i = 0; i < 3; i++) {
    await P.runSyncSweep({ gql: dead });
    await new Promise((r) => setTimeout(r, 10)); // clear the (1ms-base) backoff window
  }
  await new Promise((r) => setTimeout(r, 50)); // let alert delivery land
  const row = await orderRow(id);
  eq(row.status, "sync_failed", "stays sync_failed");
  eq(row.sync_attempts, 3, "attempts capped at MAX");
  const mine = alerts.slice(before).filter((a) => a.subject.includes(id));
  eq(mine.length, 1, "exactly one dead-letter alert");
  ok(mine[0].subject.includes("DEAD-LETTER"), "alert names the condition");
  // caught forever, lost never:
  const sweep = await P.runSyncSweep({ gql: dead });
  ok(sweep.dead.some((d) => d.orderId === id), "every sweep reports the dead order");
  eq((await orderRow(id)).sync_attempts, 3, "no further attempts");
  const full = await O.getOrder(id);
  eq(full.snapshot.items.length, 2, "snapshot intact — order fully recoverable");
  await new Promise((r) => setTimeout(r, 30));
  eq(alerts.slice(before).filter((a) => a.subject.includes(id)).length, 1, "no repeat alerts");
});

await t("reconciliation mismatch: flagged loudly, NOT synced, Shopify id recorded", async () => {
  const id = await seedOrder();
  const before = alerts.length;
  const r = await P.pushOrderToShopify(id, { gql: mockShopify({ total: CART.total - 100 }) });
  await new Promise((res) => setTimeout(res, 50));
  eq(r.mismatch, true, "mismatch surfaced");
  const row = await orderRow(id);
  eq(row.status, "sync_failed", "not synced");
  ok(row.sync_error.startsWith("RECONCILE_MISMATCH"), "error names the guard");
  ok(row.sync_error.includes("gid://shopify/Order/424242"), "shopify order traceable");
  const mine = alerts.slice(before).filter((a) => a.subject.includes(id));
  eq(mine.length, 1, "mismatch alert fired");
  eq(mine[0].detail.shopifyTotal, CART.total - 100, "alert carries both totals");
});

// --- sweep mechanics --------------------------------------------------------
await t("sweep recovers stale syncing_shopify from a crashed worker", async () => {
  const id = await seedOrder();
  await O.beginShopifySync(id); // worker "crashes" here
  await db.updateTable("orders").set({ updated_at: new Date(Date.now() - 3600e3).toISOString() }).where("id", "=", id).execute();
  process.env.SHOPIFY_SYNC_STALE_MS = "1000";
  const s1 = await P.runSyncSweep({ gql: mockShopify() });
  process.env.SHOPIFY_SYNC_STALE_MS = "999999999";
  eq(s1.stale_recovered, 1, "reclaimed");
  eq((await orderRow(id)).status, "sync_failed", "converted for retry");
  const s2 = await P.runSyncSweep({ gql: mockShopify() });
  ok(s2.pushed.find((p) => p.orderId === id)?.ok, "retried next sweep");
  eq((await orderRow(id)).status, "synced", "recovered to synced");
});

await t("backoff gates retries: not-yet-due order is deferred, then runs", async () => {
  const id = await seedOrder();
  await P.pushOrderToShopify(id, { gql: mockShopify({ failures: 1 }) });
  process.env.SHOPIFY_SYNC_BACKOFF_MS = String(10 * 60_000); // 10 min
  const s1 = await P.runSyncSweep({ gql: mockShopify() });
  ok(s1.deferred >= 1, "deferred while backing off");
  ok(!s1.pushed.find((p) => p.orderId === id), "not pushed early");
  eq((await orderRow(id)).status, "sync_failed", "unchanged");
  process.env.SHOPIFY_SYNC_BACKOFF_MS = "1";
  const s2 = await P.runSyncSweep({ gql: mockShopify() });
  ok(s2.pushed.find((p) => p.orderId === id)?.ok, "pushed once due");
});

await t("sweep picks up a paid order that never got its immediate push", async () => {
  const id = await seedOrder(); // paid, no push attempted
  const s = await P.runSyncSweep({ gql: mockShopify() });
  ok(s.pushed.find((p) => p.orderId === id)?.ok, "swept");
  eq((await orderRow(id)).status, "synced", "synced");
});

await t("sweep respects its limit", async () => {
  const ids = [await seedOrder(), await seedOrder(), await seedOrder()];
  const s = await P.runSyncSweep({ limit: 2, gql: mockShopify() });
  eq(s.pushed.length, 2, "limit honored");
  const untouched = await Promise.all(ids.map(async (i) => (await orderRow(i)).status));
  eq(untouched.filter((st) => st === "paid").length, 1, "one left for next sweep");
  await P.runSyncSweep({ gql: mockShopify() }); // drain for cleanliness
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
catcher.close();
await rm(join(here, "../.test-shopify-push.db"), { force: true });
process.exit(fail ? 1 : 0);
