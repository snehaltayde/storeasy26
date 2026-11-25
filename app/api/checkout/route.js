import { NextResponse, after } from "next/server";
import { CART_COOKIE, getCart, clearCart, shopperCart } from "@/lib/cart";
import { computeShipping } from "@/lib/shipping";
import { tenantShippingConfig, currentTenant } from "@/lib/tenant-context";
import { CONSENT_COOKIE } from "@/lib/track/names";
import { rateLimitAsync } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import {
  createOrder,
  findOrderByIdempotencyKey,
  orderConfirmationPath,
  ORDER_STATUS,
  storeLinkSecret,
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
import { shopperErrorMessage } from "@/lib/shopper-errors";
import { paymentTerms, COD_OTP_MESSAGES } from "@/lib/checkout/payment-terms";
import { sendCodOtp, verifyCodOtp, requireVerified, consumeChallenge, CodOtpError } from "@/lib/checkout/cod-otp";

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

// A store without its own link secret can't sign the confirmation link, so in
// production it takes no order at all: refused before dedup or createOrder,
// never an order written and then a failed answer (lib/orders.js storeLinkSecret).
const noLinkSecret = () =>
  storeLinkSecret()
    ? null
    : NextResponse.json(
        { error: "Checkout is temporarily unavailable for this store. Nothing was charged.", code: "CHECKOUT_DISABLED" },
        { status: 503 },
      );

const CONFLICT_MESSAGE = "This checkout attempt no longer matches your cart. Please retry.";
const conflictResponse = () => NextResponse.json({ error: CONFLICT_MESSAGE, code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });

// If this idempotency key already produced an order FROM THIS CART (the cart
// cookie), short-circuit BEFORE any cart/validation checks — a retry after the
// first request cleared the cart must still return that order, not "Cart is
// empty". The key alone is never enough: no cart cookie means no dedup, and the
// key on another cart's order is a 409 with no order fields. Returns null (no
// dup), a NextResponse to send, or the order. `expectedTotal` is goods+shipping
// for THIS submission (order.total includes shipping since Session 13).
async function dedupByKey(key, cartId, cart, expectedTotal) {
  if (!cartId) return null;
  let existing;
  try {
    existing = await findOrderByIdempotencyKey(key, cartId);
  } catch (e) {
    if (e?.code === "IDEMPOTENCY_CONFLICT") return conflictResponse();
    throw e;
  }
  if (!existing) return null;
  // Same key but a different (non-empty) cart ⇒ not a retry: the client must
  // rotate its key. 409 tells it to.
  if (cart?.items?.length && !sameAmount(expectedTotal, existing.total)) return conflictResponse();
  return existing;
}

// Phase 8 line 2 (decision 10): both payment methods' totals, the prepaid
// nudge, whether COD is offered and whether it needs a code, from the server's
// cart, the store's saved rates and payment rules. Every action prices with
// this; nothing in the request body (prepaidDiscount, nudge, payment_discount)
// is ever read.
const termsFor = (cart, address) =>
  paymentTerms({
    cart,
    shippingConfig: tenantShippingConfig(),
    paymentConfig: currentTenant()?.config?.payment_config ?? null,
    pincode: address?.pincode || null,
    prepaidAvailable: razorpayConfigured(),
  });

const codUnavailable = (terms) =>
  NextResponse.json({ ok: false, code: "COD_UNAVAILABLE", error: terms.cod.reason, quote: terms }, { status: 409 });

// A code answer: its own sentence, its own code, nothing about anyone else.
const otpError = (e) =>
  NextResponse.json(
    { ok: false, code: e.code, error: e.message, ...e.extra },
    { status: e.code === "COD_OTP_COOLDOWN" || e.code === "COD_OTP_CART_CAP" ? 429 : e.code === "COD_OTP_UNAVAILABLE" ? 503 : 409 },
  );

// P1-RATES: never charge an amount the shopper wasn't shown (lib/checkout-price.js).
// The refusal also carries the server's cart and rates, which the checkout page
// already hands this shopper, so the UI redraws the summary and the button from
// the numbers the server will charge. undefined rates (the code default) drop
// out of the JSON and the UI's computeShipping falls back to the same default.
function priceCheck(body, cart, shipping, shippingConfig, terms, paymentDiscount = 0) {
  const currency = cart.currency || "INR";
  const m = priceMismatch({
    expectedTotal: body?.expectedTotal,
    expectedShipping: body?.expectedShipping,
    goodsTotal: cart.total || 0,
    shippingTotal: shipping.total,
    paymentDiscount,
    currency,
  });
  if (!m) return null;
  return NextResponse.json(
    // P4-EFFECTIVE (OVL-06): the browser gets the shopper's projection of the
    // cart (no Shopify title or SKU); createOrder below keeps the full cart.
    // Phase 8 line 2: and the fresh quote, so the page redraws both methods.
    { ok: false, code: PRICE_CHANGED, error: m.message, total: m.total, shippingTotal: m.shippingTotal, currency, cart: shopperCart(cart), shippingConfig, quote: terms },
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
  const cartId = cartIdFrom(request);
  const body = await request.json().catch(() => ({}));
  const { action, contact, address, idempotencyKey } = body;

  // Phase 8 line 2: the quote is asked for as the PIN code changes (60 a
  // minute); sending a code has its own cap (10 per IP per 15 minutes) and its
  // own sentence. Everything else shares the checkout limit.
  if (action === "cod_otp_send") {
    const capped = await rateLimitAsync(request, { name: "cod_otp_send", limit: 10, windowMs: 15 * 60_000 });
    if (capped) {
      slog("cod_otp_failed", { reason: "ip_cap" });
      return NextResponse.json({ ok: false, code: "COD_OTP_IP_CAP", error: COD_OTP_MESSAGES.ipCap }, { status: 429 });
    }
  } else {
    const limited = await rateLimitAsync(request, action === "quote" ? { name: "checkout_quote", limit: 60 } : { name: "checkout", limit: 10 });
    if (limited) return limited;
  }

  // PUB-06: a store that has never published takes no orders from shoppers.
  // A founder's valid preview session may place a cash on delivery test
  // order (it then goes through the normal order flow, Shopify push
  // included); card and UPI wait for the store to open. The orders table has
  // no notes or tags column, so the order is not marked as a test here.
  const closed = await closedStoreGate();
  if (closed) {
    if (!closed.preview) return NextResponse.json({ error: STORE_CLOSED_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 });
    if (!["cod", "quote", "cod_otp_send", "cod_otp_verify"].includes(action))
      return NextResponse.json({ error: STORE_CLOSED_COD_ONLY_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 });
    slog("closed_store_test_order", { action });
  }

  try {
    // Phase 8 line 2: a read of this cart cookie's cart only; no order, no write.
    if (action === "quote") {
      const cart = cartId ? await getCart(cartId) : { items: [], subtotal: 0, discountTotal: 0, total: 0 };
      return NextResponse.json({ ok: true, quote: termsFor(cart, address) });
    }

    // Phase 8 line 2 (decision 13): send or check the COD code. The challenge
    // is bound to this cart cookie, this key, this phone and this COD amount.
    if (action === "cod_otp_send" || action === "cod_otp_verify") {
      const disabled = noLinkSecret();
      if (disabled) return disabled;
      if (!idempotencyKey) return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      const cart = await getCart(cartId);
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
      if (!validate(contact, address)) return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      const terms = termsFor(cart, address);
      if (!terms.cod.available) return codUnavailable(terms);
      const bind = { cartId, key: String(idempotencyKey), phone: contact.phone, amount: terms.cod.total, currency: cart.currency || "INR", cart };
      try {
        if (action === "cod_otp_verify") return NextResponse.json({ ok: true, ...(await verifyCodOtp({ ...bind, challengeId: body.challengeId, code: body.code })) });
        if (!terms.cod.otpRequired) return NextResponse.json({ ok: true, required: false });
        const shippingConfig = tenantShippingConfig();
        const shipping = computeShipping({ subtotal: cart.subtotal || 0, discountTotal: cart.discountTotal || 0, paymentMethod: "cod", pincode: address?.pincode, config: shippingConfig });
        const changed = priceCheck(body, cart, shipping, shippingConfig, terms);
        if (changed) return changed;
        const sent = await sendCodOtp({ ...bind, email: contact.email, channel: terms.cod.otpChannel });
        return NextResponse.json({ ok: true, required: true, ...sent });
      } catch (e) {
        if (e instanceof CodOtpError) return otpError(e);
        throw e;
      }
    }

    if (action === "cod") {
      const disabled = noLinkSecret();
      if (disabled) return disabled;
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

      const terms = termsFor(cart, address);
      const dup = await dedupByKey(idempotencyKey, cartId, cart, terms.cod.total);
      if (dup instanceof NextResponse) return dup;
      if (dup) {
        // Finish what the first request started: it may have died before
        // scheduling its after() work, or before its cart clear landed.
        scheduleCodEffects(request, dup);
        if (cart.items.length) await clearPlacedCart(cartId, dup.id);
        return await codResponse(dup, true);
      }

      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
      // Phase 8 line 2: the quote hides COD here, so the route refuses it too.
      if (!terms.cod.available) return codUnavailable(terms);
      // P1-RATES: never store an amount the shopper wasn't shown.
      const changed = priceCheck(body, cart, shipping, shippingConfig, terms);
      if (changed) return changed;
      // Phase 8 line 2: a verified code for this cart, key, phone and amount.
      let challenge = null;
      if (terms.cod.otpRequired) {
        try {
          challenge = await requireVerified({ challengeId: body.challengeId, cartId, key: String(idempotencyKey), phone: contact.phone, amount: terms.cod.total, currency: cart.currency || "INR", cart });
        } catch (e) {
          if (e instanceof CodOtpError) return otpError(e);
          throw e;
        }
      }

      const order = await createOrder({
        cartId,
        cart,
        contact,
        address,
        paymentMethod: "cod",
        idempotencyKey,
        shipping,
        consent: request.cookies.get(CONSENT_COOKIE)?.value || null,
        codVerifiedAt: challenge?.verified_at || null,
      });
      if (challenge) await consumeChallenge(challenge.id, order.id);
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
      const disabled = noLinkSecret();
      if (disabled) return disabled;
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

      // Phase 8 line 2: the prepaid discount, priced by the server only.
      const terms = termsFor(cart, address);
      const paymentDiscount = terms.prepaid.discount;
      // Dedup BEFORE creating a Razorpay order, so a retry reopens the SAME
      // payment instead of minting a parallel one.
      const dup = await dedupByKey(idempotencyKey, cartId, cart, terms.prepaid.total);
      if (dup instanceof NextResponse) return dup;
      if (dup) return await razorpayResponse(dup, dup.razorpay_order_id, true);

      if (!cartId) return NextResponse.json({ error: "No cart session" }, { status: 400 });
      if (!validate(contact, address))
        return NextResponse.json({ error: "Please fill all required fields" }, { status: 400 });
      if (!cart.items.length) return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
      // P1-RATES: the Razorpay order is minted for the amount on the Pay button,
      // or not at all.
      const changed = priceCheck(body, cart, shipping, shippingConfig, terms, paymentDiscount);
      if (changed) return changed;

      // One getCart + one shipping compute → the SAME amount for the Razorpay
      // order, our order row, and (later) the Shopify shipping line.
      const rzOrder = await createRazorpayOrder({
        amountPaise: toMinor(terms.prepaid.total, cart.currency || "INR"),
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
        paymentDiscount,
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
    // GEN-03: shopper text only (a provider's or the driver's raw message
    // stays in the log); the code is kept for the client.
    if (e?.code === "IDEMPOTENCY_CONFLICT") return conflictResponse();
    slog("checkout_failed", { action, error: String(e?.message || e).slice(0, 200) });
    return NextResponse.json(
      { error: shopperErrorMessage(e, "Could not continue — your cart is untouched, please retry."), ...(e?.code ? { code: e.code } : {}) },
      { status: 400 },
    );
  }
}, { fresh: "prefer" });
