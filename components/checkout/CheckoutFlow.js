"use client";

import { useEffect, useRef, useState } from "react";
import Image from "@/components/StoreImage";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { computeShipping } from "@/lib/shipping";
import { friendlyCheckoutError } from "@/lib/shopper-errors";
import { PRICE_CHANGED } from "@/lib/checkout-price";
import { track } from "@/lib/track/client";

const STEPS = ["Address", "Review", "Payment"];

const AUTOCOMPLETE = {
  email: "email",
  phone: "tel",
  name: "name",
  line1: "address-line1",
  line2: "address-line2",
  city: "address-level2",
  state: "address-level1",
  pincode: "postal-code",
};

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

const FIELDS = [
  { key: "email", label: "Email", type: "email", required: true, half: true },
  { key: "phone", label: "Phone", type: "tel", required: true, half: true },
  { key: "name", label: "Full name", required: true },
  { key: "line1", label: "Address", required: true },
  { key: "line2", label: "Apartment, suite (optional)", required: false },
  { key: "city", label: "City", required: true, half: true },
  { key: "state", label: "State", required: true, half: true },
  { key: "pincode", label: "PIN code", required: true, half: true },
];

export default function CheckoutFlow({ cart: pageCart, razorpayEnabled, storeName = "Store", logo = null, policies = [], shippingConfig: pageShippingConfig }) {
  const [step, setStep] = useState(0);
  // P1-RATES: the cart and rates this page prices with. They start as the
  // page's and are replaced by the server's when it refuses a total that has
  // changed, so the summary and the button show what the server will charge.
  const [cart, setCart] = useState(pageCart);
  const [shippingConfig, setShippingConfig] = useState(pageShippingConfig);
  const [form, setForm] = useState({
    email: "",
    phone: "",
    name: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    pincode: "",
  });
  const [method, setMethod] = useState("cod");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addressValid =
    form.email.includes("@") &&
    form.phone.trim().length >= 7 &&
    ["name", "line1", "city", "state", "pincode"].every((k) => form[k].trim());

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
          const v = await fetch("/api/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "razorpay_verify",
              orderId: data.orderId,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }),
          }).then((r) => r.json());
          if (v.ok) goConfirmation(v);
          else {
            // GEN-03: the verify error is technical; say what to do instead.
            setError(`We couldn't confirm your payment for order ${data.orderId}. If money left your account, please don't pay again — contact the store with this order number.`);
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
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
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
          {step === 0 && (
            <section>
              <h2 className="mb-4 text-lg font-bold">Contact &amp; shipping address</h2>
              <div className="grid grid-cols-2 gap-3">
                {FIELDS.map((f) => (
                  <div key={f.key} className={f.half ? "col-span-1" : "col-span-2"}>
                    <label className="mb-1 block text-xs font-medium text-sf-text-subtle">{f.label}</label>
                    <input
                      type={f.type || "text"}
                      name={f.key}
                      autoComplete={AUTOCOMPLETE[f.key]}
                      value={form[f.key]}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="w-full rounded-sf-control border border-sf-border px-3 py-2.5 text-sm outline-none focus:border-sf-border-hover"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={() => setStep(1)}
                disabled={!addressValid}
                className="mt-6 w-full rounded-sf-control bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse transition hover:bg-sf-inverse-hover disabled:cursor-not-allowed disabled:bg-sf-surface-disabled"
              >
                Continue to review
              </button>
            </section>
          )}

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
            <section>
              <h2 className="mb-4 text-lg font-bold">Payment</h2>
              <div className="space-y-3">
                <label className={`flex cursor-pointer items-start gap-3 rounded-sf-card border p-4 ${method === "cod" ? "border-sf-inverse ring-1 ring-sf-inverse" : "border-sf-border"}`}>
                  <input type="radio" name="method" checked={method === "cod"} onChange={() => setMethod("cod")} className="mt-1" />
                  <div>
                    <p className="text-sm font-semibold">
                      Cash on Delivery
                      {codPreview.codFee > 0 && (
                        <span className="font-normal text-sf-text-faint"> · +{formatMoney(codPreview.codFee, cart.currency)} COD fee</span>
                      )}
                    </p>
                    <p className="text-xs text-sf-text-subtle">Pay in cash when your order arrives.</p>
                  </div>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-sf-card border p-4 ${
                    method === "razorpay" ? "border-sf-inverse ring-1 ring-sf-inverse" : "border-sf-border"
                  } ${razorpayEnabled ? "" : "opacity-50"}`}
                >
                  <input
                    type="radio"
                    name="method"
                    checked={method === "razorpay"}
                    disabled={!razorpayEnabled}
                    onChange={() => setMethod("razorpay")}
                    className="mt-1"
                  />
                  <div>
                    <p className="text-sm font-semibold">
                      Pay online <span className="font-normal text-sf-text-faint">· card / UPI / netbanking</span>
                    </p>
                    <p className="text-xs text-sf-text-subtle">
                      {razorpayEnabled ? "You'll finish paying in a secure payment window." : "Online payment isn't available for this store right now."}
                    </p>
                  </div>
                </label>
              </div>

              {error && <p role="alert" className="mt-4 rounded-sf-control bg-sf-danger-surface px-4 py-3 text-sm text-sf-danger">{error}</p>}

              <div className="mt-6 flex gap-3">
                <button onClick={() => setStep(1)} disabled={placing} className="rounded-sf-control border border-sf-border-strong px-5 py-3 text-sm font-semibold hover:bg-sf-surface-muted disabled:opacity-50">
                  Back
                </button>
                <button
                  onClick={() => placeOrder()}
                  disabled={placing}
                  className="flex-1 rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent transition hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {placing
                    ? "Processing…"
                    : method === "cod"
                      ? `Place order · ${formatMoney(grandTotal, cart.currency)}`
                      : `Pay ${formatMoney(grandTotal, cart.currency)}`}
                </button>
              </div>

              {/* S38 (SF14): the store's own policies, right where the money moves */}
              {policies.length > 0 && (
                <p className="mt-3 text-center text-xs text-sf-text-faint">
                  By placing this order you agree to our{" "}
                  {policies.map((p, i) => (
                    <span key={p.href}>
                      {i > 0 && (i === policies.length - 1 ? " and " : ", ")}
                      <a href={p.href} target="_blank" rel="noopener" className="underline hover:text-sf-text-muted">
                        {p.label}
                      </a>
                    </span>
                  ))}
                  .
                </p>
              )}
            </section>
          )}
        </div>

        {/* sticky order summary — mirrors the cart drawer exactly */}
        <aside className="h-fit rounded-sf-card border border-sf-border p-5 lg:sticky lg:top-6">
          <h3 className="mb-3 text-sm font-bold">Order summary</h3>
          <div className="space-y-1.5 border-b border-sf-border-soft pb-3 text-sm">
            <div className="flex justify-between">
              <span className="text-sf-text-subtle">Subtotal</span>
              <span>{formatMoney(cart.subtotal, cart.currency)}</span>
            </div>
            {cart.appliedOffers
              .filter((o) => o.amount > 0)
              .map((o) => (
                <div key={o.id} className="flex justify-between gap-3 text-sf-accent-text">
                  <span className="leading-snug">{o.label}</span>
                  <span className="whitespace-nowrap font-medium">−{formatMoney(o.amount, cart.currency)}</span>
                </div>
              ))}
            {cart.gifts.map((g) => (
              <div key={`g-${g.variantId}`} className="flex justify-between text-sf-accent-text">
                <span>Free gift · {g.title}</span>
                <span className="font-medium">FREE</span>
              </div>
            ))}
            <div className="flex justify-between">
              <span className="text-sf-text-subtle">
                Shipping
                {shipping.codFee > 0 && <span className="text-xs"> (incl. COD fee)</span>}
              </span>
              {shipping.total === 0 ? (
                <span className="font-semibold text-sf-accent-text">FREE</span>
              ) : (
                <span>{formatMoney(shipping.total, cart.currency)}</span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between pt-3">
            <span className="font-semibold">Total</span>
            <span className="text-lg font-bold">{formatMoney(grandTotal, cart.currency)}</span>
          </div>
          {cart.discountTotal > 0 && (
            <p className="mt-1 text-right text-xs font-semibold text-sf-accent-text">
              You save {formatMoney(cart.discountTotal, cart.currency)}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
