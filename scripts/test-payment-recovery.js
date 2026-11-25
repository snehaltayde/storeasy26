// What a customer and the order see when a Turso blip hits checkout: the real
// /api/checkout and /api/razorpay/webhook routes against a fake Turso that really
// commits a write and then loses the response. No Razorpay modal and no outbound
// network: test keys only, anything but localhost is refused.
//   node scripts/test-payment-recovery.js          (pnpm test:payment-recovery)
import { createHmac } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { drainAfter } from "./support/route-harness.js";
import { fakeTurso } from "./support/fake-turso.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-payment-recovery.db", ".test-payment-recovery-platform.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const KEY_SECRET = "test-key-secret";
const WEBHOOK_SECRET = "test-webhook-secret";
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input?.url || input);
  if (!LOCAL.test(url)) return Promise.reject(new Error("outbound network blocked in this test"));
  return realFetch(input, init);
};

// Tenant database: real SQLite behind the fake server.
const backing = createClient({ url: "file:.test-payment-recovery.db" });
await (await import("../lib/platform/provision.js")).applyTenantSchema(backing);
const turso = fakeTurso(backing);
const port = await turso.listen();

process.env.TURSO_DB_URL = `http://127.0.0.1:${port}`;
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "";
process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.RATE_LIMIT_DISABLED = "1";
process.env.PLATFORM_SECRET = "test-platform-secret";
delete process.env.PLATFORM_DB_URL; // legacy mode: no job queue, until the platform section
delete process.env.ALERT_WEBHOOK_URL;

const { NextRequest } = await import("next/server");
const O = await import("../lib/orders.js");
const C = await import("../lib/platform/control.js");
const { pushOrderToShopify } = await import("../lib/shopify-push.js");
const { withTenant } = await import("../lib/tenant-context.js");
const checkout = await import("../app/api/checkout/route.js");
const webhook = await import("../app/api/razorpay/webhook/route.js");

// --- harness ---------------------------------------------------------------

let pass = 0;
let fail = 0;
const realErr = console.error;
const realLog = console.log;
console.log = () => {}; // the code under test logs structured events on stdout
const report = (line) => realLog(line);
async function t(name, fn) {
  turso.state.outage = false;
  turso.state.faults.length = 0;
  turso.state.received.length = 0;
  console.error = () => {}; // the code under test logs its failures loudly
  try {
    await fn();
    pass++;
    report(`✓ ${name}`);
  } catch (e) {
    fail++;
    report(`✗ ${name}\n   ${e?.message || e}`);
  } finally {
    console.error = realErr;
    turso.state.outage = false;
    await drainAfter().catch(() => {});
  }
}
const eq = (got, want, label) => {
  if (got !== want) throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(`${label}: expected truthy`);
};

// --- fixtures ----------------------------------------------------------------

const VARIANT = "gid://shopify/ProductVariant/1";
const PRODUCT = "gid://shopify/Product/1";
await backing.execute({
  sql: "INSERT INTO products (id, handle, title, currency, available) VALUES (?, 'p', 'Whey', 'INR', 1)",
  args: [PRODUCT],
});
await backing.execute({
  sql: "INSERT INTO variants (id, product_id, title, price, currency, available) VALUES (?, ?, 'Choc', 1000, 'INR', 1)",
  args: [VARIANT, PRODUCT],
});
const { emptyList } = await import("../lib/content/documents-reader.js");
const openNow = new Date().toISOString();
await backing.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), openNow, openNow] });
await backing.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [openNow] });

const CART = {
  items: [{ variantId: VARIANT, productId: PRODUCT, title: "Whey", variantTitle: "Choc", image: null, price: 1000, quantity: 2, lineTotal: 2000, discount: 0 }],
  gifts: [{ variantId: "gid://shopify/ProductVariant/2", productId: "gid://shopify/Product/2", title: "Shaker", image: null }],
  appliedOffers: [],
  subtotal: 2000,
  discountTotal: 0,
  total: 2000,
  currency: "INR",
};
const CONTACT = { email: "snehal@mediastic.in", phone: "9000000000", name: "Test" };
const ADDRESS = { line1: "1 Lane", city: "Pune", state: "MH", pincode: "411001" };

let seq = 0;
const uid = (s) => `${s}_${++seq}`;

async function seedCart() {
  const cartId = uid("cart");
  const old = "2020-01-01T00:00:00.000Z";
  await backing.execute({ sql: "INSERT INTO carts (id, created_at, updated_at) VALUES (?, ?, ?)", args: [cartId, old, old] });
  await backing.execute({
    sql: "INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, added_at) VALUES (?, ?, ?, 1, ?)",
    args: [cartId, VARIANT, PRODUCT, old],
  });
  return cartId;
}

async function pendingOrder() {
  const cartId = await seedCart();
  const razorpayOrderId = uid("order_rz");
  const order = await O.createOrder({
    cartId, cart: CART, contact: CONTACT, address: ADDRESS, paymentMethod: "razorpay",
    idempotencyKey: uid("key"), razorpayOrderId, consent: "granted",
  });
  return { orderId: order.id, cartId, razorpayOrderId, paymentId: uid("pay") };
}

const sign = (rz, pay) => createHmac("sha256", KEY_SECRET).update(`${rz}|${pay}`).digest("hex");

const post = (route, payload, { cartId, host = "shop.test", headers = {} } = {}) =>
  route.POST(
    new NextRequest(`http://${host}/api/x`, {
      method: "POST",
      headers: { host, "content-type": "application/json", cookie: cartId ? `cart_session=${cartId}` : "", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
  );

const callVerify = async (o, opts = {}) => {
  const res = await post(checkout, {
    action: "razorpay_verify",
    orderId: o.orderId,
    razorpay_order_id: o.razorpayOrderId,
    razorpay_payment_id: o.paymentId,
    razorpay_signature: sign(o.razorpayOrderId, o.paymentId),
  }, { cartId: o.cartId, ...opts });
  return { status: res.status, body: await res.json() };
};

const callWebhook = async (o, opts = {}) => {
  const raw = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: o.paymentId, order_id: o.razorpayOrderId, amount: 200000, currency: "INR" } } },
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const res = await post(webhook, raw, { headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": uid("evt") }, ...opts });
  return { status: res.status, body: await res.json() };
};

const one = async (sql, ...args) => (await backing.execute({ sql, args })).rows[0];
const orderRow = (id) => one("SELECT * FROM orders WHERE id = ?", id);
const paidEvents = async (id) => Number((await one("SELECT count(*) AS n FROM order_events WHERE order_id = ? AND to_status = 'paid'", id)).n);
const cartItems = async (id) => Number((await one("SELECT count(*) AS n FROM cart_items WHERE cart_id = ?", id)).n);
const purchaseEvents = async (id) => Number((await one("SELECT count(*) AS n FROM events WHERE event_id = ?", id)).n);
const itemRows = async (id) => Number((await one("SELECT count(*) AS n FROM order_items WHERE order_id = ?", id)).n);

// The money state moved, the audit row exists once, and nothing was lost downstream.
async function assertFullyPaid(o, label) {
  const row = await orderRow(o.orderId);
  eq(row.payment_status, "paid", `${label} payment_status`);
  eq(row.razorpay_payment_id, o.paymentId, `${label} payment id`);
  eq(await paidEvents(o.orderId), 1, `${label} paid events`);
  eq(await cartItems(o.cartId), 0, `${label} cart items`);
  eq(await purchaseEvents(o.orderId), 1, `${label} purchase events`);
}

const UPDATE_ORDER = /^update "orders"/i;
const INSERT_ORDER = /^insert into "orders"/i;
const INSERT_ITEMS = /^insert into "order_items"/i;
const INSERT_PAID_EVENT = /insert into "?order_events"?/i;

// A second worker's own connection, straight to the same SQLite file.
const DIRECT = { id: "direct", dbUrl: "file:.test-payment-recovery.db" };

// --- 1. payment verify: unknown outcome on the paid write -----------------------

await t("verify: paid write commits, response lost → customer sees success", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "commit_then_drop" });
  const r = await callVerify(o);
  eq(r.status, 200, "status");
  eq(r.body.ok, true, "ok");
  ok(r.body.confirmationPath, "confirmationPath");
  await drainAfter();
  await assertFullyPaid(o, "after recovery");
});

await t("verify: paid write lost before running → re-read, then the same CAS succeeds", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "drop_before" });
  const r = await callVerify(o);
  eq(r.status, 200, "status");
  eq(r.body.ok, true, "ok");
  await drainAfter();
  await assertFullyPaid(o, "after recovery");
});

await t("verify: database down throughout → 'confirming' answer, never a raw error", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "commit_then_drop", then: () => (turso.state.outage = true) });
  const r = await callVerify(o);
  eq(r.status, 202, "status");
  eq(r.body.pending, true, "pending");
  ok(!/fetch failed|socket|SERVER_ERROR/i.test(JSON.stringify(r.body)), "no raw error text");
  ok(r.body.confirmationPath, "confirmationPath, as the order was tied to this payment");
});

await t("verify: client's retry after an outage finishes everything exactly once", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "commit_then_drop", then: () => (turso.state.outage = true) });
  eq((await callVerify(o)).status, 202, "during outage");
  turso.state.outage = false;
  const r = await callVerify(o);
  eq(r.status, 200, "retry status");
  eq(r.body.ok, true, "retry ok");
  await drainAfter();
  await assertFullyPaid(o, "after retry");
});

await t("verify: read failing before the order is tied to the payment → no status link", async () => {
  const o = await pendingOrder();
  turso.state.outage = true;
  const r = await callVerify(o);
  eq(r.status, 202, "status");
  eq(r.body.confirmationPath, undefined, "a link for an unverified order id would leak its details");
});

await t("verify: a real rejection stays a rejection", async () => {
  const o = await pendingOrder();
  const bad = await post(checkout, {
    action: "razorpay_verify", orderId: o.orderId, razorpay_order_id: o.razorpayOrderId,
    razorpay_payment_id: o.paymentId, razorpay_signature: "0".repeat(64),
  });
  eq(bad.status, 400, "bad signature");
  eq((await callVerify({ ...o, razorpayOrderId: "order_rz_other" })).status, 400, "order mismatch");
  eq((await callVerify(o)).status, 200, "genuine verify");
  const other = await callVerify({ ...o, paymentId: "pay_other" });
  eq(other.status, 400, "different payment on a paid order");
  eq((await orderRow(o.orderId)).razorpay_payment_id, o.paymentId, "payment id kept");
});

await t("verify: paid write commits, response lost, order moved on before the re-read → still success", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({
    match: UPDATE_ORDER,
    mode: "commit_then_drop",
    // The webhook's Shopify push starts before this request gets to re-read.
    then: () => backing.execute({ sql: "UPDATE orders SET status = 'syncing_shopify' WHERE id = ?", args: [o.orderId] }),
  });
  const r = await callVerify(o);
  eq(r.status, 200, `status (${r.body.error})`);
  eq(r.body.ok, true, "ok");
  eq(await paidEvents(o.orderId), 1, "paid events");
});

await t("verify: paid write lost and the order cancelled meanwhile → the same refusal as without the blip", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({
    match: UPDATE_ORDER,
    mode: "drop_before",
    then: () => backing.execute({ sql: "UPDATE orders SET status = 'cancelled' WHERE id = ?", args: [o.orderId] }),
  });
  const r = await callVerify(o);
  eq(r.status, 400, "status");
  ok(/invalid order transition cancelled → paid/i.test(r.body.error), `error (${r.body.error})`);
  eq(await paidEvents(o.orderId), 0, "paid events");
});

// The webhook pays the order, and with `push` its follow-up work starts the Shopify
// push, while the browser's paid write is at the server: on its own connection, as
// it would be live.
const webhookPays = (o, { paymentId = o.paymentId, push = true } = {}) => () =>
  withTenant(DIRECT, async () => {
    await O.markOrderPaid(o.orderId, { razorpayPaymentId: paymentId, source: "webhook" });
    if (push) await O.beginShopifySync(o.orderId);
  });

const RACES = [
  ["commit_then_drop", "paid write lost after running"],
  ["drop_before", "paid write lost before running"],
  [undefined, "no blip, between the read and the write"],
];

for (const [mode, how] of RACES) {
  await t(`verify: webhook pays and starts the push meanwhile (${how}) → success, not a refusal`, async () => {
    const o = await pendingOrder();
    turso.state.faults.push({ match: UPDATE_ORDER, mode, before: webhookPays(o) });
    const r = await callVerify(o);
    eq(r.status, 200, `status (${r.body.error})`);
    eq(r.body.ok, true, "ok");
    ok(r.body.confirmationPath, "confirmationPath");
    eq((await orderRow(o.orderId)).status, "syncing_shopify", "the push is left to run");
    await drainAfter();
    await assertFullyPaid(o, "after verify");
  });
}

// A second captured payment is refused whether or not the push has started yet:
// one of the two needs a refund either way.
for (const [mode, how] of RACES) {
  for (const push of [false, true]) {
    await t(`verify: a different payment lands meanwhile (${how}${push ? ", push started" : ""}) → the different-payment refusal`, async () => {
      const o = await pendingOrder();
      turso.state.faults.push({ match: UPDATE_ORDER, mode, before: webhookPays(o, { paymentId: "pay_other", push }) });
      const r = await callVerify(o);
      eq(r.status, 400, `status (${JSON.stringify(r.body)})`);
      ok(/different payment/i.test(r.body.error), `error (${r.body.error})`);
      eq((await orderRow(o.orderId)).razorpay_payment_id, "pay_other", "payment id kept");
    });
  }
}

await t("webhook: the browser applies a different payment meanwhile → flagged, not acknowledged as paid", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({
    match: UPDATE_ORDER,
    before: () => withTenant(DIRECT, () => O.markOrderPaid(o.orderId, { razorpayPaymentId: o.paymentId, source: "browser_callback" })),
  });
  const r = await callWebhook({ ...o, paymentId: "pay_other" });
  eq(r.status, 200, "status");
  ok(/different payment/i.test(r.body.flagged), `flagged (${JSON.stringify(r.body)})`);
  eq((await orderRow(o.orderId)).razorpay_payment_id, o.paymentId, "payment id kept");
});

await t("verify then webhook: both fire, paid event and effects happen once", async () => {
  const o = await pendingOrder();
  eq((await callVerify(o)).status, 200, "verify");
  eq((await callWebhook(o)).status, 200, "webhook");
  await drainAfter();
  await assertFullyPaid(o, "after both");
});

// --- 2. replays must not lose or repeat side effects --------------------------

await t("webhook: paid write commits, response lost → redelivery finishes the effects", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "commit_then_drop", then: () => (turso.state.outage = true) });
  eq((await callWebhook(o)).status, 500, "first delivery asks for a redelivery");
  turso.state.outage = false;
  eq((await callWebhook(o)).status, 200, "redelivery");
  await drainAfter();
  await assertFullyPaid(o, "after redelivery");
});

await t("status + paid event are one write: there is no paid order without its event", async () => {
  const o = await pendingOrder();
  turso.state.faults.push({ match: INSERT_PAID_EVENT, mode: "drop_before", then: () => (turso.state.outage = true) });
  await callVerify(o);
  turso.state.outage = false;
  const row = await orderRow(o.orderId);
  eq(await paidEvents(o.orderId), row.payment_status === "paid" ? 1 : 0, "paid event matches the status");
});

await t("a late webhook replay doesn't wipe a cart the customer has since refilled", async () => {
  const o = await pendingOrder();
  eq((await callVerify(o)).status, 200, "verify");
  await drainAfter();
  eq(await cartItems(o.cartId), 0, "cart cleared by the payment");
  await backing.execute({
    sql: "INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, added_at) VALUES (?, ?, ?, 1, ?)",
    args: [o.cartId, VARIANT, PRODUCT, new Date().toISOString()],
  });
  await backing.execute({ sql: "UPDATE carts SET updated_at = ? WHERE id = ?", args: [new Date(Date.now() + 1000).toISOString(), o.cartId] });
  eq((await callWebhook(o)).status, 200, "replay");
  await drainAfter();
  eq(await cartItems(o.cartId), 1, "new cart kept");
});

await t("effects: a paid order records its experiment conversion and runs order_placed automations", async () => {
  const at = new Date().toISOString();
  await backing.batch([
    { sql: "INSERT INTO experiments (id, slug, name, variants, status, created_at, updated_at) VALUES ('exp-pr', 'exp-pr', 'PR', '[]', 'running', ?, ?)", args: [at, at] },
    { sql: "INSERT INTO experiment_exposures (experiment_id, unit_id, variant, first_exposed_at) VALUES ('exp-pr', 'unit-pr', 'a', ?)", args: [at] },
    {
      sql: "INSERT INTO automations (id, name, trigger, action, enabled, created_at, updated_at) VALUES ('aut-pr', 'PR', 'order_placed', ?, 1, ?, ?)",
      args: [JSON.stringify({ kind: "notify_merchant", text: "new order" }), at, at],
    },
  ], "write");
  try {
    const o = await pendingOrder();
    const r = await callVerify(o, { headers: { cookie: `cart_session=${o.cartId}; _unit=unit-pr` } });
    eq(r.status, 200, "verify");
    await drainAfter();
    eq(Number((await one("SELECT count(*) AS n FROM experiment_conversions WHERE order_id = ?", o.orderId)).n), 1, "conversion");
    eq(Number((await one("SELECT count(*) AS n FROM automation_runs WHERE event_key = ?", `order_placed:${o.orderId}`)).n), 1, "automation run");
  } finally {
    await backing.batch(["DELETE FROM automations WHERE id = 'aut-pr'", "DELETE FROM experiments WHERE id = 'exp-pr'"], "write");
  }
});

// --- 2b. Shopify push: only the pusher that won the begin goes on ------------------

// A fake Shopify that records each draft it creates in `creates`; `onFind` can hold
// a pusher just after its begin.
const fakeShopify = (creates, onFind) => async (query, variables) => {
  if (query.includes("draftOrderCreate")) {
    creates.push(variables.input.tags);
    return { draftOrderCreate: { draftOrder: { id: `gid://shopify/DraftOrder/${creates.length}`, name: "#D" }, userErrors: [] } };
  }
  if (query.includes("draftOrderComplete")) {
    const order = { id: "gid://shopify/Order/1", name: "#1", displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: "2000" } } };
    return { draftOrderComplete: { draftOrder: { id: variables.id, status: "COMPLETED", order }, userErrors: [] } };
  }
  await onFind?.();
  return { orders: { nodes: [] }, draftOrders: { nodes: [] } };
};

await t("push: the begin race's loser loses its response too → it stands down, one Shopify order", async () => {
  const o = await pendingOrder();
  await O.markOrderPaid(o.orderId, { razorpayPaymentId: o.paymentId });
  const creates = [];
  let begunB, releaseB, pushB;
  const begun = new Promise((r) => (begunB = r));
  const released = new Promise((r) => (releaseB = r));
  // B wins the compare-and-set while A's begin is at the server; A's write then
  // applies nothing, and its response is lost.
  turso.state.faults.push({
    match: UPDATE_ORDER,
    mode: "commit_then_drop",
    before: async () => {
      pushB = withTenant(DIRECT, () =>
        pushOrderToShopify(o.orderId, { gql: fakeShopify(creates, async () => (begunB(), released)) }),
      );
      await begun;
    },
  });
  const a = await pushOrderToShopify(o.orderId, { gql: fakeShopify(creates) });
  releaseB();
  const b = await pushB;
  eq(a.inFlight, true, `A stands down (${JSON.stringify(a)})`);
  eq(b.ok, true, `B pushes (${JSON.stringify(b)})`);
  eq(creates.length, 1, "draftOrderCreate calls");
  eq((await orderRow(o.orderId)).status, "synced", "status");
});

await t("push: begin commits, response lost → the same pusher goes on, one Shopify order", async () => {
  const o = await pendingOrder();
  await O.markOrderPaid(o.orderId, { razorpayPaymentId: o.paymentId });
  const creates = [];
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "commit_then_drop" });
  const r = await pushOrderToShopify(o.orderId, { gql: fakeShopify(creates) });
  eq(r.ok, true, `pushed (${JSON.stringify(r)})`);
  eq(creates.length, 1, "draftOrderCreate calls");
  eq((await orderRow(o.orderId)).status, "synced", "status");
});

// --- 3. createOrder: never report success on an order with no lines -------------

const placeCod = async (cartId, idempotencyKey) => {
  const res = await post(checkout, { action: "cod", contact: CONTACT, address: ADDRESS, idempotencyKey, expectedTotal: 1049, expectedShipping: 49 }, {
    cartId, headers: { cookie: `cart_session=${cartId}; _consent=granted` },
  });
  return { status: res.status, body: await res.json() };
};

await t("COD: a normal order still gets its Shopify push attempt and purchase event", async () => {
  const cartId = await seedCart();
  const placed = await placeCod(cartId, uid("key"));
  eq(placed.body.ok, true, "ok");
  await drainAfter();
  const row = await orderRow(placed.body.orderId);
  eq(row.sync_attempts, 1, "push attempted");
  eq(await purchaseEvents(placed.body.orderId), 1, "purchase event");
  eq(await cartItems(cartId), 0, "cart");
});

await t("a replay doesn't use up a failed push's retries", async () => {
  const o = await pendingOrder();
  eq((await callVerify(o)).status, 200, "verify");
  await drainAfter();
  const before = await orderRow(o.orderId);
  eq(before.status, "sync_failed", "push failed (no Shopify in this test)");
  eq((await callWebhook(o)).status, 200, "webhook replay");
  await drainAfter();
  eq((await orderRow(o.orderId)).sync_attempts, before.sync_attempts, "attempts");
});

await t("COD: blip while writing the lines → the retry never confirms an empty order", async () => {
  const cartId = await seedCart();
  const key = uid("key");
  turso.state.faults.push({ match: INSERT_ITEMS, mode: "drop_before" });
  const first = await placeCod(cartId, key);
  const retry = first.body.ok ? first : await placeCod(cartId, key);
  eq(retry.body.ok, true, "the customer can complete the order");
  ok((await itemRows(retry.body.orderId)) > 0, "the confirmed order has lines");
  eq(Number((await one("SELECT count(*) AS n FROM orders WHERE idempotency_key = ?", key)).n), 1, "one order");
});

await t("COD: order insert commits, response lost → one complete order, cart cleared", async () => {
  const cartId = await seedCart();
  const key = uid("key");
  turso.state.faults.push({ match: INSERT_ORDER, mode: "commit_then_drop" });
  // No retry: the same request re-reads, finds its order, and finishes the work.
  const placed = await placeCod(cartId, key);
  eq(placed.status, 200, `status (${placed.body.error})`);
  eq(placed.body.ok, true, "ok");
  eq(await itemRows(placed.body.orderId), 1, "lines");
  await drainAfter();
  eq(await cartItems(cartId), 0, "cart");
  eq(await purchaseEvents(placed.body.orderId), 1, "purchase event");
  eq(Number((await one("SELECT count(*) AS n FROM order_events WHERE order_id = ? AND from_status IS NULL", placed.body.orderId)).n), 1, "created event");
});

await t("COD: cart clear fails after the order is placed → success, and the cart still gets cleared", async () => {
  const cartId = await seedCart();
  turso.state.faults.push({ match: /^delete from "cart_items"/i, mode: "drop_before" });
  const placed = await placeCod(cartId, uid("key"));
  eq(placed.status, 200, `status (${placed.body.error})`);
  eq(placed.body.ok, true, "ok");
  await drainAfter();
  eq(await cartItems(cartId), 0, "cleared by the follow-up work");
  eq(await purchaseEvents(placed.body.orderId), 1, "purchase event");
});

await t("COD: order commits and the re-read fails too → the retry finishes the follow-up work", async () => {
  const cartId = await seedCart();
  const key = uid("key");
  turso.state.faults.push({ match: INSERT_ORDER, mode: "commit_then_drop", then: () => (turso.state.outage = true) });
  const first = await placeCod(cartId, key);
  eq(first.status, 503, "first attempt");
  turso.state.outage = false;
  const retry = await placeCod(cartId, key);
  eq(retry.body.ok, true, "retry");
  eq(await itemRows(retry.body.orderId), 1, "lines");
  await drainAfter();
  eq(await cartItems(cartId), 0, "cart");
  eq(await purchaseEvents(retry.body.orderId), 1, "purchase event");
});

await t("COD: blip with nothing written → no raw error, and the retry places the order", async () => {
  const cartId = await seedCart();
  const key = uid("key");
  turso.state.faults.push({ match: INSERT_ORDER, mode: "drop_before" });
  const first = await placeCod(cartId, key);
  eq(first.status, 503, `first attempt (${first.body.error})`);
  ok(!/fetch failed|socket|SERVER_ERROR/i.test(first.body.error), `no raw error text (${first.body.error})`);
  const retry = await placeCod(cartId, key);
  eq(retry.body.ok, true, "retry");
  eq(await itemRows(retry.body.orderId), 1, "lines");
});

await t("createOrder: a real same-key race still dedups to one order", async () => {
  const key = uid("key");
  const args = { cart: CART, contact: CONTACT, address: ADDRESS, paymentMethod: "cod", idempotencyKey: key };
  const [a, b] = await Promise.all([O.createOrder(args), O.createOrder(args)]);
  eq(a.id, b.id, "same order");
  eq(await itemRows(a.id), 2, "lines written once (item + gift)");
});

// --- 4. no webhook, tab closed: the durable job recovers it (platform mode) ------

process.env.PLATFORM_DB_URL = "file:.test-payment-recovery-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
C.__resetPlatformClient();
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
const M = await import("../lib/platform/migrate.js");
await M.runMigrations(C.platformDb(), await M.loadMigrations("platform"));
await C.upsertTenant({
  id: "pr", name: "Recovery", domains: ["pr.test"], dbUrl: `http://127.0.0.1:${port}`, config: { razorpay_key_id: "rzp_test_key" },
  secrets: { razorpay_key_secret: KEY_SECRET, razorpay_webhook_secret: WEBHOOK_SECRET },
});
const { runDueJobs } = await import("../lib/platform/worker.js");
const tenant = await C.getTenant("pr");
const jobs = async () => (await C.platformDb().execute("SELECT type, status, payload FROM jobs WHERE type = 'payment_confirm'")).rows;

await t("platform: outage, customer gone, no webhook → the job marks the order paid", async () => {
  const o = await withTenant(tenant, pendingOrder);
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "drop_before", then: () => (turso.state.outage = true) });
  eq((await callVerify(o, { host: "pr.test" })).status, 202, "during outage");
  turso.state.outage = false;
  eq((await orderRow(o.orderId)).payment_status, "pending", "not paid yet");
  await runDueJobs();
  await drainAfter();
  await assertFullyPaid(o, "after the job");
  eq((await jobs()).at(-1).status, "done", "job done");
});

await t("platform: a job can't pay an order other than the one its payment belongs to", async () => {
  const victim = await withTenant(tenant, pendingOrder);
  const attacker = await withTenant(tenant, pendingOrder);
  turso.state.outage = true;
  // A valid signature for the attacker's payment, pointed at the victim's order id.
  const r = await callVerify({ ...attacker, orderId: victim.orderId }, { host: "pr.test" });
  eq(r.status, 202, "status");
  eq(r.body.confirmationPath, undefined, "no link to the victim's order");
  turso.state.outage = false;
  await runDueJobs();
  await drainAfter();
  eq((await orderRow(victim.orderId)).payment_status, "pending", "victim untouched");
  eq((await orderRow(attacker.orderId)).razorpay_payment_id, attacker.paymentId, "the job settles the attacker's own order");
});

await t("platform: webhook's paid write commits into an outage → its queued replay finishes the effects", async () => {
  const o = await withTenant(tenant, pendingOrder);
  turso.state.faults.push({ match: UPDATE_ORDER, mode: "commit_then_drop", then: () => (turso.state.outage = true) });
  const r = await callWebhook(o, { host: "pr.test" });
  eq(r.status, 200, "acknowledged");
  eq(r.body.queued, true, "queued its own retry");
  turso.state.outage = false;
  eq(await cartItems(o.cartId), 1, "nothing done yet");
  await runDueJobs();
  await drainAfter();
  await assertFullyPaid(o, "after the replay");
});

// --- 5. the browser's side of the retry ------------------------------------------

await t("client: retries while confirming, stops on success, rejection, or running out", async () => {
  const { confirmPayment } = await import("../lib/checkout/confirm-payment.js");
  const noSleep = async () => {};
  const scripted = (...steps) => {
    let calls = 0;
    const post = async () => {
      const s = steps[Math.min(calls++, steps.length - 1)];
      if (s === "network") throw new TypeError("Failed to fetch");
      return s;
    };
    return { post, calls: () => calls };
  };
  const pending = { status: 202, data: { ok: false, pending: true, confirmationPath: "/c" } };
  const success = { status: 200, data: { ok: true, confirmationPath: "/c" } };

  let s = scripted(pending, "network", { status: 503, data: {} }, { status: 429, data: {} }, success);
  let r = await confirmPayment(s.post, { sleep: noSleep });
  eq(r.state, "confirmed", "recovers through 202, network loss, 503, 429");
  eq(s.calls(), 5, "calls");

  s = scripted({ status: 400, data: { error: "Order mismatch" } });
  r = await confirmPayment(s.post, { sleep: noSleep });
  eq(r.state, "rejected", "a real rejection isn't retried");
  eq(r.error, "Order mismatch", "its message");
  eq(s.calls(), 1, "calls");

  s = scripted(pending);
  r = await confirmPayment(s.post, { sleep: noSleep });
  eq(r.state, "pending", "gives up as still-confirming, not as a failure");
  eq(r.confirmationPath, "/c", "and keeps the link");

  s = scripted("network");
  r = await confirmPayment(s.post, { sleep: noSleep });
  eq(r.state, "pending", "network never came back");
  eq(r.confirmationPath, undefined, "no link to offer");
});

await turso.close();
report(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
