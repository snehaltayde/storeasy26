import { db } from "./db.js";
import { adminGraphql } from "./shopify-admin.js";
import {
  ORDER_STATUS,
  getOrder,
  beginShopifySync,
  completeShopifySync,
  failShopifySync,
} from "./orders.js";
import { sendAlert } from "./alerts.js";

// ---------------------------------------------------------------------------
// Reliable Shopify order push (Session 12) — productionizes the Session-8
// spike mechanism (docs/shopify-order-sync.md):
//   draft order → normal-price lines · free gift as a 100%-off line · ONE
//   order-level FIXED_AMOUNT discount = engine discountTotal · custom shipping
//   line · draftOrderComplete(paymentPending) ⇒ PAID (razorpay) / PENDING (COD)
//   · razorpay refs in customAttributes · tag = our order id.
//
// Reliability model:
//   • async: routes fire enqueueShopifyPush() via next/server after(); the
//     sweep (cron / webhook piggyback / manual) retries stragglers with
//     bounded exponential backoff on the S10 state machine
//     (paid|cod_pending|sync_failed → syncing_shopify → synced|sync_failed).
//   • idempotent: beginShopifySync is a CAS (concurrent pushes collapse), and
//     every attempt SEARCHES Shopify by the order-id tag first — a retry after
//     a crash adopts the existing order/draft instead of creating a duplicate.
//   • reconciled: Shopify total must equal the captured amount to the paisa
//     before the order is marked synced; mismatches fail loudly + alert.
//   • dead-letter: after MAX attempts the order stays sync_failed (snapshot
//     intact — nothing is ever lost), one alert fires, sweeps report it.
//
// All Shopify I/O goes through an injectable `gql` transport so tests can
// simulate failures without touching a real store.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = () => Number(process.env.SHOPIFY_SYNC_MAX_ATTEMPTS || 5);
const BACKOFF_BASE_MS = () => Number(process.env.SHOPIFY_SYNC_BACKOFF_MS || 60_000);
const STALE_SYNCING_MS = () => Number(process.env.SHOPIFY_SYNC_STALE_MS || 10 * 60_000);

const PUSHABLE = [ORDER_STATUS.PAID, ORDER_STATUS.COD_PENDING, ORDER_STATUS.SYNC_FAILED];

const money = (n) => Number(n).toFixed(2);

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return { firstName: parts[0] || "Customer", lastName: parts.slice(1).join(" ") || parts[0] || "-" };
}

function mailingAddress(order) {
  const snap = order.snapshot || {};
  const a = snap.address || {};
  const { firstName, lastName } = splitName(snap.contact?.name || order.name);
  return {
    firstName,
    lastName,
    address1: a.line1 || order.address_line1 || "-",
    address2: a.line2 || order.address_line2 || null,
    city: a.city || order.city || "-",
    province: a.state || order.state || null,
    zip: a.pincode || order.pincode || null,
    country: a.country || order.country || "India",
    phone: snap.contact?.phone || order.phone || null,
  };
}

// The draft input is built from the immutable ORDER SNAPSHOT (never the live
// cart/catalog), so a push days later still represents exactly what was sold.
export function buildDraftOrderInput(order) {
  const snap = order.snapshot;
  if (!snap?.items?.length) throw new Error(`Order ${order.id} has no snapshot items`);

  const address = mailingAddress(order);
  const shippingTitle =
    snap.shipping?.method && snap.shipping.method !== "free"
      ? snap.shipping.method
      : "Free shipping";

  const lineItems = [
    ...snap.items.map((it) => ({ variantId: it.variantId, quantity: it.quantity })),
    ...(snap.gifts || []).map((g) => ({
      variantId: g.variantId,
      quantity: 1,
      appliedDiscount: {
        valueType: "PERCENTAGE",
        value: 100,
        title: "Free gift",
        description: "FREE_GIFT offer",
      },
    })),
  ];

  const discountTotal = Number(snap.totals?.discountTotal || 0);
  const offerTitles = (snap.appliedOffers || []).map((o) => o.label).join(" + ");

  return {
    email: snap.contact?.email || order.email || undefined,
    shippingAddress: address,
    billingAddress: address,
    note: `storeasy26 order ${order.id}` + (order.razorpay_payment_id ? ` — paid via Razorpay ${order.razorpay_payment_id}` : " — Cash on Delivery"),
    tags: ["storeasy26", order.id],
    customAttributes: [
      { key: "bl_order_id", value: order.id },
      { key: "channel", value: "storeasy26-pwa" },
      { key: "captured_amount_inr", value: String(order.total) },
      ...(order.razorpay_order_id ? [{ key: "razorpay_order_id", value: order.razorpay_order_id }] : []),
      ...(order.razorpay_payment_id ? [{ key: "razorpay_payment_id", value: order.razorpay_payment_id }] : []),
    ],
    lineItems,
    ...(discountTotal > 0
      ? {
          appliedDiscount: {
            valueType: "FIXED_AMOUNT",
            value: discountTotal,
            title: "BeastLife offers",
            description: offerTitles.slice(0, 250) || "storeasy26 offer engine",
          },
        }
      : {}),
    shippingLine: {
      title: shippingTitle,
      price: money(order.shipping_total || snap.totals?.shippingTotal || 0),
    },
  };
}

const ORDER_FIELDS = `id name displayFinancialStatus totalPriceSet { shopMoney { amount } }`;

// A retry must never create a second Shopify order: look for an existing order
// (or a leftover draft from a crashed attempt) tagged with our order id.
async function findExisting(orderId, gql) {
  const q = `tag:'${orderId}'`;
  const data = await gql(
    `query($q: String!) {
      orders(first: 3, query: $q) { nodes { ${ORDER_FIELDS} } }
      draftOrders(first: 3, query: $q) { nodes { id status order { ${ORDER_FIELDS} } } }
    }`,
    { q },
  );
  const order = data?.orders?.nodes?.[0] || null;
  const draft = data?.draftOrders?.nodes?.find((d) => d.status !== "COMPLETED") || null;
  const completedDraftOrder = data?.draftOrders?.nodes?.find((d) => d.order)?.order || null;
  return { order: order || completedDraftOrder, draft };
}

async function createDraft(input, gql) {
  const data = await gql(
    `mutation($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
    }`,
    { input },
  );
  const r = data?.draftOrderCreate;
  if (r?.userErrors?.length) throw new Error(`draftOrderCreate: ${JSON.stringify(r.userErrors)}`);
  if (!r?.draftOrder?.id) throw new Error("draftOrderCreate returned no draft");
  return r.draftOrder;
}

async function completeDraft(draftId, paymentPending, gql) {
  const data = await gql(
    `mutation($id: ID!, $pending: Boolean!) {
      draftOrderComplete(id: $id, paymentPending: $pending) {
        draftOrder { id status order { ${ORDER_FIELDS} } }
        userErrors { field message }
      }
    }`,
    { id: draftId, pending: paymentPending },
  );
  const r = data?.draftOrderComplete;
  if (r?.userErrors?.length) throw new Error(`draftOrderComplete: ${JSON.stringify(r.userErrors)}`);
  const order = r?.draftOrder?.order;
  if (!order) throw new Error("draftOrderComplete returned no order");
  return order;
}

// Push one order. Safe to call repeatedly / concurrently from anywhere.
export async function pushOrderToShopify(orderId, { gql = adminGraphql } = {}) {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);

  if (order.status === ORDER_STATUS.SYNCED)
    return { ok: true, orderId, already: true, shopifyOrderId: order.shopify_order_id };
  if (!PUSHABLE.includes(order.status))
    return { ok: false, orderId, skipped: order.status };
  if (order.sync_attempts >= MAX_ATTEMPTS())
    return { ok: false, orderId, dead: true, attempts: order.sync_attempts };

  // CAS — exactly one worker proceeds; a concurrent duplicate sees already:true.
  const begun = await beginShopifySync(orderId);
  if (begun.already) return { ok: false, orderId, inFlight: true };
  const attempt = order.sync_attempts + 1;

  const paymentPending = order.payment_method === "cod";
  try {
    const existing = await findExisting(orderId, gql);
    let shopifyOrder = existing.order;
    let adopted = Boolean(existing.order);
    if (!shopifyOrder && existing.draft) {
      shopifyOrder = await completeDraft(existing.draft.id, paymentPending, gql);
      adopted = true;
    }
    if (!shopifyOrder) {
      const draft = await createDraft(buildDraftOrderInput(order), gql);
      shopifyOrder = await completeDraft(draft.id, paymentPending, gql);
    }

    // Reconciliation guard: Shopify's total must equal the captured amount.
    const shopifyTotal = Number(shopifyOrder.totalPriceSet.shopMoney.amount);
    if (Math.abs(shopifyTotal - order.total) > 0.009) {
      const msg = `RECONCILE_MISMATCH shopify ₹${shopifyTotal} != captured ₹${order.total} (${shopifyOrder.name} ${shopifyOrder.id})`;
      await failShopifySync(orderId, { error: msg });
      await sendAlert(`Shopify total mismatch on ${orderId}`, {
        orderId,
        shopifyOrderId: shopifyOrder.id,
        shopifyName: shopifyOrder.name,
        shopifyTotal,
        capturedTotal: order.total,
      });
      return { ok: false, orderId, mismatch: true, shopifyOrderId: shopifyOrder.id };
    }

    await completeShopifySync(orderId, { shopifyOrderId: shopifyOrder.id });
    return {
      ok: true,
      orderId,
      shopifyOrderId: shopifyOrder.id,
      shopifyName: shopifyOrder.name,
      shopifyStatus: shopifyOrder.displayFinancialStatus,
      total: shopifyTotal,
      adopted,
      attempt,
    };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    await failShopifySync(orderId, { error: msg });
    const dead = attempt >= MAX_ATTEMPTS();
    if (dead) {
      // Dead-letter: the order stays sync_failed with its full snapshot —
      // caught, visible in every sweep, never lost. Alert exactly once (here,
      // on the attempt that exhausted the budget).
      await sendAlert(`Shopify sync DEAD-LETTER: ${orderId} after ${attempt} attempts`, {
        orderId,
        attempts: attempt,
        error: msg,
      });
    }
    return { ok: false, orderId, failed: msg, attempt, dead };
  }
}

// Fire-and-forget wrapper for next/server after() — an immediate-attempt
// failure is fine (the sweep retries); it must never throw into the route.
export function enqueueShopifyPush(orderId) {
  return pushOrderToShopify(orderId).catch((e) =>
    console.error(`[shopify-push] ${orderId}: ${e?.message || e}`),
  );
}

const backoffDueAt = (updatedAt, attempts) =>
  new Date(updatedAt).getTime() + BACKOFF_BASE_MS() * 2 ** Math.max(0, attempts - 1);

// Sweep the queue: fresh paid/COD orders that never got their immediate push,
// sync_failed orders whose backoff has elapsed, and stale syncing_shopify rows
// from crashed workers. Returns a full accounting (dead-lettered orders are
// ALWAYS reported, every sweep — a paid-but-unsynced order stays visible).
export async function runSyncSweep({ limit = 10, gql = adminGraphql } = {}) {
  const now = Date.now();
  const rows = await db
    .selectFrom("orders")
    .select(["id", "status", "sync_attempts", "updated_at"])
    .where("status", "in", [...PUSHABLE, ORDER_STATUS.SYNCING_SHOPIFY])
    .orderBy("created_at", "asc")
    .limit(200)
    .execute();

  const summary = { scanned: rows.length, pushed: [], deferred: 0, stale_recovered: 0, dead: [] };
  for (const row of rows) {
    if (summary.pushed.length >= limit) break;

    if (row.status === ORDER_STATUS.SYNCING_SHOPIFY) {
      // A worker died mid-push: reclaim after the stale window; the NEXT sweep
      // (or backoff) retries it — search-first adoption keeps it duplicate-safe.
      if (now - new Date(row.updated_at).getTime() > STALE_SYNCING_MS()) {
        await failShopifySync(row.id, { error: "stale syncing_shopify — worker lost" });
        summary.stale_recovered++;
      }
      continue;
    }

    if (row.status === ORDER_STATUS.SYNC_FAILED) {
      if (row.sync_attempts >= MAX_ATTEMPTS()) {
        summary.dead.push({ orderId: row.id, attempts: row.sync_attempts });
        continue;
      }
      if (now < backoffDueAt(row.updated_at, row.sync_attempts)) {
        summary.deferred++;
        continue;
      }
    }

    try {
      summary.pushed.push(await pushOrderToShopify(row.id, { gql }));
    } catch (e) {
      summary.pushed.push({ ok: false, orderId: row.id, failed: String(e?.message || e) });
    }
  }
  return summary;
}
