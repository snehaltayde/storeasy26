import { NextResponse, after } from "next/server";
import { CART_COOKIE, getCart, clearCart, shopperCart } from "@/lib/cart";
import { computeShipping } from "@/lib/shipping";
import { tenantShippingConfig } from "@/lib/tenant-context";
import { CONSENT_COOKIE } from "@/lib/track/names";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import {
  createOrder,
  findOrderByIdempotencyKey,
  orderConfirmationPath,
  ORDER_STATUS,
} from "@/lib/orders";
import { verifyBrowserPayment, runOrderEffects } from "@/lib/payment-settle";
import { razorpayConfigured, razorpayKeyId, createRazorpayOrder } from "@/lib/razorpay";
import { toMinor, sameAmount } from "@/lib/money";
import { priceMismatch, PRICE_CHANGED } from "@/lib/checkout-price";
import { checkoutCapability } from "@/lib/commerce/adapter";
import { tenantHandler } from "@/lib/tenant-request";
import { conversionUnit } from "@/lib/experiments";
import { closedStoreGate, STORE_CLOSED_CODE, STORE_CLOSED_MESSAGE, STORE_CLOSED_COD_ONLY_MESSAGE } from "@/lib/content/resolve";
import { isTransient } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cartIdFrom = (request) => request.cookies.get(CART_COOKIE)?.value || null;

function validate(contact, address) {
  const required = [
    contact?.email,
    contact?.phone,
    contact?.name,
    address?.line1,
    address?.city,
    address?.state,
    address?.pincode,
  ];
  return required.every((v) => v && String(v).trim());
}

// S31 (BE36): amount comparisons happen at minor-unit precision via lib/money.

// If this idempotency key already produced an order, short-circuit BEFORE any
// cart/validation checks — a retry after the first request cleared the cart
// must still return that order, not "Cart is empty". Returns null (no dup),
// a NextResponse to send, or throws nothing. `expectedTotal` is goods+shipping
// for THIS submission (order.total includes shipping since Session 13).
async function dedupByKey(key, cart, expectedTotal) {
  const existing = await findOrderByIdempotencyKey(key);
  if (!existing) return null;
  // Same key but a different (non-empty) cart ⇒ not a retry: the client must
  // rotate its key. 409 tells it to.
  if (cart?.items?.length && !sameAmount(expectedTotal, existing.total)) {
    return NextResponse.json(
      { error: "This checkout attempt no longer matches your cart. Please retry.", code: "IDEMPOTENCY_CONFLICT" },
      { status: 409 },
    );
  }
  return existing;
}

// P1-RATES: never charge an amount the shopper wasn't shown (lib/checkout-price.js).
// The refusal also carries the server's cart and rates, which the checkout page
// already hands this shopper, so the UI redraws the summary and the button from
// the numbers the server will charge. undefined rates (the code default) drop
// out of the JSON and the UI's computeShipping falls back to the same default.
function priceCheck(body, cart, shipping, shippingConfig) {
  const currency = cart.currency || "INR";
  const m = priceMismatch({
    expectedTotal: body?.expectedTotal,
    expectedShipping: body?.expectedShipping,
    goodsTotal: cart.total || 0,
    shippingTotal: shipping.total,
    currency,
  });
  if (!m) return null;
  return NextResponse.json(
    // P4-EFFECTIVE (OVL-06): the browser gets the shopper's projection of the
    // cart (no Shopify title or SKU); createOrder below keeps the full cart.
    { ok: false, code: PRICE_CHANGED, error: m.message, total: m.total, shippingTotal: m.shippingTotal, currency, cart: shopperCart(cart), shippingConfig },
    { status: 409 },
  );
}

// S25 (SF08): every response the client navigates to confirmation from carries
// a server-computed tokenized path — the confirmation page requires it. Minted
// inside the tenantHandler context, so the right tenant's secret signs it.
const codResponse = async (order, deduped = false) =>
  NextResponse.json({
    ok: true,
    orderId: order.id,
    confirmationPath: await orderConfirmationPath(order.id),
    ...(deduped ? { deduped: true } : {}),
  });

async function razorpayResponse(order, razorpayOrderId, deduped = false) {
  // An order that already left pending_payment means the payment landed —
  // don't reopen the modal; the client goes straight to confirmation.
  if (order.status && order.status !== ORDER_STATUS.PENDING_PAYMENT) {
    return NextResponse.json({
      ok: true,
      orderId: order.id,
      status: order.status,
      alreadyPaid: true,
      confirmationPath: await orderConfirmationPath(order.id),
    });
  }
  return NextResponse.json({
    ok: true,
    orderId: order.id,
    razorpayOrderId,
    amount: toMinor(order.total, order.currency || "INR"),
    currency: order.currency || "INR",
    // TENANT-scoped (S24 quirk fix): the modal must open under the SAME account
    // that minted razorpayOrderId — never the env default's key.
    keyId: razorpayKeyId(),
    ...(deduped ? { deduped: true } : {}),
  });
}

// Async after the response: Shopify push (payment-pending) + the server-side
// purchase event (durable, browser-independent), the S47 (BE22) experiment
// conversion join (PV-08: none from the founder's browser), and S49 (MC28)
// bounded merchant automations. Post-money, best-effort, and safe to repeat.
function scheduleCodEffects(request, order) {
  const expUnit = conversionUnit(request);
  after(() => runOrderEffects(order.id, { expUnit }));
}

// The order exists by now, so a failure here mustn't turn into "please try
// again": the effects scheduled first clear the cart again.
const clearPlacedCart = (cartId, orderId) =>
  clearCart(cartId).catch((e) => console.error(`[checkout] cart ${orderId}: ${e?.message || e}`));

// P1-RATES: priced with the store's row as saved now, not this instance's
// 30 s copy (tenantHandler's "prefer"), so a founder's new rates apply from
// the next order and a refusal hands the shopper the rates that will be
// charged. A failed fresh read falls back to the cached row: a control-plane
// blip never closes checkout, and the amount check holds either way.
export const POST = tenantHandler(async (request) => {
  // S32 (BE06): the per-tenant capability gate — checkout modes are explicit
  // configuration, never silently switched. Browsing and the cart stay up.
  const capability = checkoutCapability();
  if (!capability.available) {
    return NextResponse.json(
      { error: capability.reason || "Checkout is disabled for this store", code: "CHECKOUT_DISABLED" },
      { status: 503 },
    );
  }
  // S47 (OP13): the operator kill-switch — ff_checkout is CRITICAL, so this
  // read is uncached: an emergency disable stops the very next request on
  // every instance. Fail-open: a control-plane outage never closes checkout.
  {
    const { flagEnabled } = await import("@/lib/platform/flags");
    const { currentTenant } = await import("@/lib/tenant-context");
    if (!(await flagEnabled("ff_checkout", currentTenant()?.id || null, { fallback: true }))) {
      return NextResponse.json(
        { error: "Checkout is briefly paused — nothing was charged. Please try again shortly.", code: "CHECKOUT_DISABLED" },
        { status: 503 },
      );
    }
  }
  const limited = rateLimit(request, { name: "checkout", limit: 10 });
  if (limited) return limited;

  const cartId = cartIdFrom(request);
  const body = await request.json().catch(() => ({}));
  const { action, contact, address, idempotencyKey } = body;

  // PUB-06: a store that has never published takes no orders from shoppers.
  // A founder's valid preview session may place a cash on delivery test
  // order (it then goes through the normal order flow, Shopify push
  // included); card and UPI wait for the store to open. The orders table has
  // no notes or tags column, so the order is not marked as a test here.
  const closed = await closedStoreGate();
  if (closed) {
    if (!closed.preview) return NextResponse.json({ error: STORE_CLOSED_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 });
    if (action !== "cod") return NextResponse.json({ error: STORE_CLOSED_COD_ONLY_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 });
    slog("closed_store_test_order", { action });
  }

  try {
    if (action === "cod") {
      if (!idempotencyKey)
        return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
      const cart = cartId ? await getCart(cartId) : { items: [] };

      // Authoritative shipping: same pure engine the drawer/checkout UI use,
      // now with the real payment method + destination pincode. One read of the
      // rates for the whole request (the row was read fresh, see POST below).
      const shippingConfig = tenantShippingConfig();
      const shipping = computeShipping({
        subtotal: cart.subtotal || 0,
        discountTotal: cart.discountTotal || 0,
        paymentMethod: "cod",
        pincode: address?.pincode,
        config: shippingConfig,
      });

      const dup = await dedupByKey(idempotencyKey, cart, (cart.total || 0) + shipping.total);
      if (dup instanceof NextResponse) return dup;
      if (dup) {
        // Finish what the first request started: it may have died before
        // scheduling its after() work, or before its cart clear landed.
        scheduleCodEffects(request, dup);
        if (cartId && cart.items.length) await clearPlacedCart(cartId, dup.id);
        return await codResponse(dup, true);
      }

      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
      // P1-RATES: never store an amount the shopper wasn't shown.
      const changed = priceCheck(body, cart, shipping, shippingConfig);
      if (changed) return changed;

      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "cod",
        idempotencyKey,
        shipping,
        consent: request.cookies.get(CONSENT_COOKIE)?.value || null,
      });
      slog(order.deduped ? "order_deduped" : "order_created", {
        order_id: order.id,
        method: "cod",
        total: order.total,
        cart_id: cartId,
      });
      // `recovered`: the insert's response was lost but it may be ours, so this
      // request still owes the follow-up work.
      if (!order.deduped || order.recovered) {
        scheduleCodEffects(request, order);
        await clearPlacedCart(cartId, order.id);
      }
      return await codResponse(order, order.deduped);
    }

    if (action === "razorpay_create") {
      if (!razorpayConfigured())
        return NextResponse.json({ error: "Online payment isn't available for this store right now." }, { status: 400 });
      if (!idempotencyKey)
        return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
      const cart = cartId ? await getCart(cartId) : { items: [] };

      const shippingConfig = tenantShippingConfig();
      const shipping = computeShipping({
        subtotal: cart.subtotal || 0,
        discountTotal: cart.discountTotal || 0,
        paymentMethod: "prepaid",
        pincode: address?.pincode,
        config: shippingConfig,
      });

      // Dedup BEFORE creating a Razorpay order, so a retry reopens the SAME
      // payment instead of minting a parallel one.
      const dup = await dedupByKey(idempotencyKey, cart, (cart.total || 0) + shipping.total);
      if (dup instanceof NextResponse) return dup;
      if (dup) return await razorpayResponse(dup, dup.razorpay_order_id, true);

      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
      // P1-RATES: the Razorpay order is minted for the amount on the Pay button,
      // or not at all.
      const changed = priceCheck(body, cart, shipping, shippingConfig);
      if (changed) return changed;

      // One getCart + one shipping compute → the SAME amount for the Razorpay
      // order, our order row, and (later) the Shopify shipping line.
      const rzOrder = await createRazorpayOrder({
        amountPaise: toMinor(cart.total + shipping.total, cart.currency || "INR"),
        receipt: `cart_${cartId.slice(0, 12)}`,
      });
      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "razorpay",
        idempotencyKey,
        razorpayOrderId: rzOrder.id,
        shipping,
        consent: request.cookies.get(CONSENT_COOKIE)?.value || null,
      });
      slog(order.deduped ? "order_deduped" : "order_created", {
        order_id: order.id,
        method: "razorpay",
        total: order.total,
        cart_id: cartId,
        razorpay_order_id: order.deduped ? order.razorpayOrderId : rzOrder.id,
      });
      // Lost a same-key insert race: answer with the winner's Razorpay order
      // (this request's rzOrder is an orphan — never paid, expires unused).
      if (order.deduped) return await razorpayResponse(order, order.razorpayOrderId, true);
      return await razorpayResponse(order, rzOrder.id);
    }

    if (action === "razorpay_verify") {
      const expUnit = conversionUnit(request); // PV-08: none from the founder's browser
      const result = await verifyBrowserPayment(body, { expUnit });
      if (result.settled) after(() => runOrderEffects(body.orderId, { expUnit }));
      return NextResponse.json(result.body, { status: result.status });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    // Nothing was charged on these actions, and the same idempotency key is safe to
    // resend. The raw driver error means nothing to a customer.
    if (isTransient(e))
      return NextResponse.json(
        { error: "We hit a temporary problem placing your order. Please try again. You won't be charged or get a duplicate order." },
        { status: 503 },
      );
    const status = e?.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
    return NextResponse.json(
      { error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) },
      { status },
    );
  }
}, { fresh: "prefer" });
