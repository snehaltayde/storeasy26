"use client";

// Phase 8 line 2: placing the order, moved out of CheckoutFlow (which keeps the
// state and hands this its setters as `ctx`). Every request names the total the
// button showed (P1-RATES); the server prices again and charges that or nothing.
// A COD order that needs a code first asks the server to send one and opens the
// code dialog; after the code is checked the same key places the order with
// the verified challenge.
import { friendlyCheckoutError } from "@/lib/shopper-errors";
import { PRICE_CHANGED } from "@/lib/checkout-price";
import { track } from "@/lib/track/client";
import { confirmPayment } from "@/lib/checkout/confirm-payment";

function loadRazorpay() {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export const postCheckout = async (body) => {
  const res = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, data: await res.json() };
};

function goConfirmation(data) {
  // Full nav so the layout re-reads the (now-cleared) cart. The server hands
  // back a tokenized confirmationPath (S25/SF08 — the confirmation page
  // requires it). The tokenless fallback only fires on deploy skew (old
  // server + new client) and lands on a neutral 404, never a PII leak.
  window.location.href = data.confirmationPath || `/checkout/confirmation/${data.orderId}`;
}

// A stale intent (the key's order was made from another cart total): new key, one retry.
const staleIntent = (res, data) => res.status === 409 && data?.code === "IDEMPOTENCY_CONFLICT";

// ctx: { method, cart, contact, address, form, storeName, grandTotal, shown,
//        otpRequired, challenge, paymentKey, eventItems, priceChanged,
//        newQuote, openOtp, setError, setPlacing }
export async function placeOrder(ctx, isRetry = false) {
  const { method, cart, contact, address, form, storeName, grandTotal, shown, paymentKey, setError, setPlacing } = ctx;
  setPlacing(true);
  setError("");
  // add_payment_info — the user committed a payment method (fired once per
  // attempt; the stable id makes an auto-retry after 409 a dedup no-op).
  if (!isRetry) {
    track("add_payment_info", {
      event_id: `api-${paymentKey()}`,
      value: grandTotal,
      currency: cart.currency,
      items: ctx.eventItems(),
      params: { payment_type: method },
    });
  }
  try {
    if (method === "cod") {
      // Phase 8 line 2: no verified code yet → the server sends one, the dialog opens.
      if (ctx.otpRequired && !ctx.challenge) {
        const { res, data } = await postCheckout({ action: "cod_otp_send", contact, address, idempotencyKey: paymentKey(), ...shown });
        if (data.code === PRICE_CHANGED) return ctx.priceChanged(data);
        if (staleIntent(res, data) && !isRetry) {
          paymentKey(true);
          return placeOrder(ctx, true);
        }
        if (data.code === "COD_UNAVAILABLE") ctx.newQuote(data.quote);
        if (!data.ok) throw new Error(friendlyCheckoutError(data));
        if (data.required) {
          ctx.openOtp(data);
          setPlacing(false);
          return;
        }
      }
      const { res, data } = await postCheckout({ action: "cod", contact, address, idempotencyKey: paymentKey(), challengeId: ctx.challenge || undefined, ...shown });
      if (data.code === PRICE_CHANGED) return ctx.priceChanged(data);
      if (staleIntent(res, data) && !isRetry) {
        paymentKey(true); // stale intent (cart changed) — new key, one retry
        return placeOrder({ ...ctx, challenge: null }, true);
      }
      if (data.code === "COD_OTP_REQUIRED") ctx.openOtp(null);
      if (data.code === "COD_UNAVAILABLE") ctx.newQuote(data.quote);
      if (!data.ok) throw new Error(friendlyCheckoutError(data));
      goConfirmation(data);
      return;
    }

    // Razorpay
    const { res, data } = await postCheckout({ action: "razorpay_create", contact, address, idempotencyKey: paymentKey(), ...shown });
    if (data.code === PRICE_CHANGED) return ctx.priceChanged(data);
    if (staleIntent(res, data) && !isRetry) {
      paymentKey(true);
      return placeOrder(ctx, true);
    }
    if (!data.ok) throw new Error(friendlyCheckoutError(data));
    if (data.alreadyPaid) {
      // This intent's payment already landed (duplicate submit after verify).
      goConfirmation(data);
      return;
    }

    const ready = await loadRazorpay();
    if (!ready) throw new Error("Could not open the payment window — check your connection and try again.");

    const rzp = new window.Razorpay({
      key: data.keyId,
      order_id: data.razorpayOrderId,
      amount: data.amount,
      currency: data.currency,
      name: storeName,
      description: `Order ${data.orderId}`,
      prefill: { name: form.name, email: form.email, contact: form.phone },
      theme: { color: "#0a0a0b" },
      handler: async (response) => {
        const result = await confirmPayment(async () => {
          const r = await fetch("/api/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "razorpay_verify",
              orderId: data.orderId,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }),
          });
          return { status: r.status, data: await r.json().catch(() => ({})) };
        });
        if (result.state === "confirmed") goConfirmation(result.data);
        else if (result.state === "pending" && result.confirmationPath) goConfirmation(result);
        else {
          setError(
            result.state === "rejected"
              ? `We couldn't confirm your payment for order ${data.orderId}. If money left your account, please don't pay again — contact the store with this order number.`
              : `Your payment went through and we're confirming order ${data.orderId}. Please don't pay again. We'll email you once it's confirmed.`,
          );
          setPlacing(false);
        }
      },
      modal: { ondismiss: () => setPlacing(false) },
    });
    rzp.on("payment.failed", (resp) => {
      setError(resp?.error?.description || "Payment failed");
      setPlacing(false);
    });
    rzp.open();
  } catch (e) {
    // GEN-03: fetch/JSON failures carry browser wording, not ours.
    const raw = e instanceof TypeError || e instanceof SyntaxError;
    setError(raw ? "Could not reach the store — your cart is untouched. Check your connection and try again." : String(e.message || e));
    setPlacing(false);
  }
}
