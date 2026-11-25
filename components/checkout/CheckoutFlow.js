"use client";

import { useEffect, useRef, useState } from "react";
import Image from "@/components/StoreImage";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { computeShipping } from "@/lib/shipping";
import { friendlyCheckoutError } from "@/lib/shopper-errors";
import { PRICE_CHANGED } from "@/lib/checkout-price";
import { track } from "@/lib/track/client";
import { confirmPayment } from "@/lib/checkout/confirm-payment";
import AddressStep from "./AddressStep";
import PaymentStep from "./PaymentStep";
import OrderSummary from "./OrderSummary";
import { emptyForm, applyAddress, addressValid } from "./checkoutModel";

const STEPS = ["Address", "Review", "Payment"];

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

export default function CheckoutFlow({ cart: pageCart, razorpayEnabled, storeName = "Store", logo = null, policies = [], shippingConfig: pageShippingConfig }) {
  const [step, setStep] = useState(0);
  // P1-RATES: the cart and rates this page prices with. They start as the
  // page's and are replaced by the server's when it refuses a total that has
  // changed, so the summary and the button show what the server will charge.
  const [cart, setCart] = useState(pageCart);
  const [shippingConfig, setShippingConfig] = useState(pageShippingConfig);
  const [form, setForm] = useState(emptyForm());
  const [method, setMethod] = useState("cod");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");

  // Phase 8 step 0: the form changes only through applyAddress (./checkoutModel).
  const changeAddress = (patch, source) => setForm((f) => applyAddress(f, patch, source));
  const valid = addressValid(form);

  const contact = { email: form.email, phone: form.phone, name: form.name };
  const address = {
    line1: form.line1,
    line2: form.line2,
    city: form.city,
    state: form.state,
    pincode: form.pincode,
    country: "India",
  };

  // Live shipping — same pure engine the drawer and the checkout API use, so
  // what's shown here is what the server charges. Recomputes as the payment
  // method / pincode change. GEN-03: `config` is the store's own rates from the
  // server; without it this preview showed the code default on every store.
  const shipInputs = { subtotal: cart.subtotal, discountTotal: cart.discountTotal, pincode: form.pincode || null, config: shippingConfig };
  const shipping = computeShipping({ ...shipInputs, paymentMethod: method === "cod" ? "cod" : "prepaid" });
  const codPreview = computeShipping({ ...shipInputs, paymentMethod: "cod" });
  const grandTotal = cart.total + shipping.total;

  const eventItems = () =>
    cart.items.map((it) => ({
      id: it.variantNumericId,
      name: it.title,
      price: it.price,
      quantity: it.quantity,
    }));

  // begin_checkout — once per checkout visit
  const beganRef = useRef(false);
  useEffect(() => {
    if (beganRef.current) return;
    beganRef.current = true;
    track("begin_checkout", {
      value: cart.total,
      currency: cart.currency,
      items: eventItems(),
      params: cart.couponStatus?.valid ? { coupon: cart.couponStatus.code } : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goConfirmation(data) {
    // Full nav so the layout re-reads the (now-cleared) cart. The server hands
    // back a tokenized confirmationPath (S25/SF08 — the confirmation page
    // requires it). The tokenless fallback only fires on deploy skew (old
    // server + new client) and lands on a neutral 404, never a PII leak.
    window.location.href = data.confirmationPath || `/checkout/confirmation/${data.orderId}`;
  }

  // One idempotency key per payment ATTEMPT — minted on first submit, reused by
  // retries (double click, network retry, Razorpay modal reopen) so the server
  // returns the SAME order instead of creating a second one. Rotated only when
  // the server 409s (the key no longer matches the cart).
  const intentKey = useRef(null);
  function paymentKey(rotate = false) {
    if (rotate || !intentKey.current) {
      intentKey.current =
        globalThis.crypto?.randomUUID?.() ||
        `ik-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return intentKey.current;
  }

  // P1-RATES: the server refused because the total changed. Redraw every
  // amount from its cart and rates, say the new total, and wait for the
  // shopper to press the button again. Nothing was created or charged.
  function priceChanged(data) {
    if (data.cart?.items) setCart(data.cart);
    setShippingConfig(data.shippingConfig ?? undefined);
    paymentKey(true);
    setError(friendlyCheckoutError(data));
    setPlacing(false);
  }

  async function placeOrder(isRetry = false) {
    setPlacing(true);
    setError("");
    // What the button says: the server charges this or nothing.
    const shown = { expectedTotal: grandTotal, expectedShipping: shipping.total };
    // add_payment_info — the user committed a payment method (fired once per
    // attempt; the stable id makes an auto-retry after 409 a dedup no-op).
    if (!isRetry) {
      track("add_payment_info", {
        event_id: `api-${paymentKey()}`,
        value: grandTotal,
        currency: cart.currency,
        items: eventItems(),
        params: { payment_type: method },
      });
    }
    try {
      if (method === "cod") {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cod", contact, address, idempotencyKey: paymentKey(), ...shown }),
        });
        const data = await res.json();
        if (data.code === PRICE_CHANGED) return priceChanged(data);
        if (res.status === 409 && !isRetry) {
          paymentKey(true); // stale intent (cart changed) — new key, one retry
          return placeOrder(true);
        }
        if (!data.ok) throw new Error(friendlyCheckoutError(data));
        goConfirmation(data);
        return;
      }

      // Razorpay
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "razorpay_create", contact, address, idempotencyKey: paymentKey(), ...shown }),
      });
      const data = await res.json();
      if (data.code === PRICE_CHANGED) return priceChanged(data);
      if (res.status === 409 && !isRetry) {
        paymentKey(true);
        return placeOrder(true);
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

  return (
    <div data-protected="checkout" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Link href="/" className="text-xl font-extrabold tracking-tight">
          {/* S55 fix: the tenant's own wordmark — this hardcoded BEASTLIFE on every store */}
          {logo?.text1 || storeName}
          {logo?.text2 ? <span className="text-sf-accent-mark">{logo.text2}</span> : null}
        </Link>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  i <= step ? "bg-sf-inverse text-sf-on-inverse" : "bg-sf-surface-strong text-sf-text-subtle"
                }`}
              >
                {i + 1}
              </span>
              <span className={i === step ? "font-semibold" : "text-sf-text-faint"}>{label}</span>
              {i < STEPS.length - 1 && <span className="hidden text-sf-mark sm:inline">→</span>}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_380px]">
        {/* main column */}
        <div>
          {step === 0 && <AddressStep form={form} valid={valid} onAddress={changeAddress} onContinue={() => setStep(1)} />}

          {step === 1 && (
            <section>
              <h2 className="mb-4 text-lg font-bold">Review your order</h2>
              <div className="rounded-sf-card border border-sf-border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-sf-text-faint">Ship to</p>
                <p className="mt-1 text-sm font-medium">{form.name}</p>
                <p className="text-sm text-sf-text-muted">
                  {form.line1}
                  {form.line2 ? `, ${form.line2}` : ""}, {form.city}, {form.state} {form.pincode}
                </p>
                <p className="text-sm text-sf-text-muted">
                  {form.email} · {form.phone}
                </p>
                <button onClick={() => setStep(0)} className="mt-2 text-xs font-medium text-sf-accent-text hover:underline">
                  Edit
                </button>
              </div>
              <ul className="mt-4 divide-y divide-sf-border-soft">
                {cart.items.map((it) => (
                  <li key={it.variantId} className="flex items-center gap-3 py-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                      {it.image ? <Image src={it.image} alt={it.title} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{it.title}</p>
                      <p className="text-xs text-sf-text-subtle">Qty {it.quantity}</p>
                    </div>
                    <span className="text-sm font-semibold">{formatMoney(it.lineTotal, cart.currency)}</span>
                  </li>
                ))}
                {cart.gifts.map((g) => (
                  <li key={`gift-${g.variantId}`} className="flex items-center gap-3 py-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                      {g.image ? <Image src={g.image} alt={g.title} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{g.title}</p>
                      <p className="text-xs text-sf-text-subtle">Free gift 🎁</p>
                    </div>
                    <span className="text-sm font-semibold text-sf-accent-text">FREE</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex gap-3">
                <button onClick={() => setStep(0)} className="rounded-sf-control border border-sf-border-strong px-5 py-3 text-sm font-semibold hover:bg-sf-surface-muted">
                  Back
                </button>
                <button onClick={() => setStep(2)} className="flex-1 rounded-sf-control bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover">
                  Continue to payment
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <PaymentStep
              cart={cart}
              method={method}
              onMethod={setMethod}
              razorpayEnabled={razorpayEnabled}
              codFee={codPreview.codFee}
              grandTotal={grandTotal}
              error={error}
              placing={placing}
              onBack={() => setStep(1)}
              onPlace={placeOrder}
              policies={policies}
            />
          )}
        </div>

        {/* sticky order summary — mirrors the cart drawer exactly */}
        <OrderSummary cart={cart} shipping={shipping} grandTotal={grandTotal} />
      </div>
    </div>
  );
}
