"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { formatMoney } from "@/lib/format";

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

export default function CheckoutFlow({ cart, razorpayEnabled }) {
  const [step, setStep] = useState(0);
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

  function goConfirmation(orderId) {
    // Full nav so the layout re-reads the (now-cleared) cart.
    window.location.href = `/checkout/confirmation/${orderId}`;
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

  async function placeOrder(isRetry = false) {
    setPlacing(true);
    setError("");
    try {
      if (method === "cod") {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cod", contact, address, idempotencyKey: paymentKey() }),
        });
        if (res.status === 409 && !isRetry) {
          paymentKey(true); // stale intent (cart changed) — new key, one retry
          return placeOrder(true);
        }
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Could not place order");
        goConfirmation(data.orderId);
        return;
      }

      // Razorpay
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "razorpay_create", contact, address, idempotencyKey: paymentKey() }),
      });
      if (res.status === 409 && !isRetry) {
        paymentKey(true);
        return placeOrder(true);
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Could not start payment");
      if (data.alreadyPaid) {
        // This intent's payment already landed (duplicate submit after verify).
        goConfirmation(data.orderId);
        return;
      }

      const ready = await loadRazorpay();
      if (!ready) throw new Error("Could not load Razorpay");

      const rzp = new window.Razorpay({
        key: data.keyId,
        order_id: data.razorpayOrderId,
        amount: data.amount,
        currency: data.currency,
        name: "BeastLife",
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
          if (v.ok) goConfirmation(v.orderId);
          else {
            setError(v.error || "Payment verification failed");
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
      setError(String(e.message || e));
      setPlacing(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" className="text-xl font-extrabold tracking-tight">
          BEAST<span className="text-lime-500">LIFE</span>
        </Link>
        <ol className="flex items-center gap-2 text-sm">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  i <= step ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-500"
                }`}
              >
                {i + 1}
              </span>
              <span className={i === step ? "font-semibold" : "text-zinc-400"}>{label}</span>
              {i < STEPS.length - 1 && <span className="text-zinc-300">→</span>}
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
                    <label className="mb-1 block text-xs font-medium text-zinc-500">{f.label}</label>
                    <input
                      type={f.type || "text"}
                      name={f.key}
                      autoComplete={AUTOCOMPLETE[f.key]}
                      value={form[f.key]}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={() => setStep(1)}
                disabled={!addressValid}
                className="mt-6 w-full rounded-xl bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                Continue to review
              </button>
            </section>
          )}

          {step === 1 && (
            <section>
              <h2 className="mb-4 text-lg font-bold">Review your order</h2>
              <div className="rounded-2xl border border-zinc-200 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Ship to</p>
                <p className="mt-1 text-sm font-medium">{form.name}</p>
                <p className="text-sm text-zinc-600">
                  {form.line1}
                  {form.line2 ? `, ${form.line2}` : ""}, {form.city}, {form.state} {form.pincode}
                </p>
                <p className="text-sm text-zinc-600">
                  {form.email} · {form.phone}
                </p>
                <button onClick={() => setStep(0)} className="mt-2 text-xs font-medium text-lime-700 hover:underline">
                  Edit
                </button>
              </div>
              <ul className="mt-4 divide-y divide-zinc-100">
                {cart.items.map((it) => (
                  <li key={it.variantId} className="flex items-center gap-3 py-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                      {it.image ? <Image src={it.image} alt={it.title} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{it.title}</p>
                      <p className="text-xs text-zinc-500">Qty {it.quantity}</p>
                    </div>
                    <span className="text-sm font-semibold">{formatMoney(it.lineTotal, cart.currency)}</span>
                  </li>
                ))}
                {cart.gifts.map((g) => (
                  <li key={`gift-${g.variantId}`} className="flex items-center gap-3 py-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                      {g.image ? <Image src={g.image} alt={g.title} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{g.title}</p>
                      <p className="text-xs text-zinc-500">Free gift 🎁</p>
                    </div>
                    <span className="text-sm font-semibold text-lime-700">FREE</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex gap-3">
                <button onClick={() => setStep(0)} className="rounded-xl border border-zinc-300 px-5 py-3 text-sm font-semibold hover:bg-zinc-50">
                  Back
                </button>
                <button onClick={() => setStep(2)} className="flex-1 rounded-xl bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800">
                  Continue to payment
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section>
              <h2 className="mb-4 text-lg font-bold">Payment</h2>
              <div className="space-y-3">
                <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 ${method === "cod" ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200"}`}>
                  <input type="radio" name="method" checked={method === "cod"} onChange={() => setMethod("cod")} className="mt-1" />
                  <div>
                    <p className="text-sm font-semibold">Cash on Delivery</p>
                    <p className="text-xs text-zinc-500">Pay in cash when your order arrives.</p>
                  </div>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 ${
                    method === "razorpay" ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200"
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
                      Razorpay <span className="font-normal text-zinc-400">· card / UPI / netbanking (test mode)</span>
                    </p>
                    <p className="text-xs text-zinc-500">
                      {razorpayEnabled ? "Secure payment via Razorpay." : "Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable."}
                    </p>
                  </div>
                </label>
              </div>

              {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

              <div className="mt-6 flex gap-3">
                <button onClick={() => setStep(1)} disabled={placing} className="rounded-xl border border-zinc-300 px-5 py-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">
                  Back
                </button>
                <button
                  onClick={() => placeOrder()}
                  disabled={placing}
                  className="flex-1 rounded-xl bg-lime-400 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:bg-lime-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {placing
                    ? "Processing…"
                    : method === "cod"
                      ? `Place order · ${formatMoney(cart.total, cart.currency)}`
                      : `Pay ${formatMoney(cart.total, cart.currency)}`}
                </button>
              </div>
            </section>
          )}
        </div>

        {/* sticky order summary — mirrors the cart drawer exactly */}
        <aside className="h-fit rounded-2xl border border-zinc-200 p-5 lg:sticky lg:top-6">
          <h3 className="mb-3 text-sm font-bold">Order summary</h3>
          <div className="space-y-1.5 border-b border-zinc-100 pb-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Subtotal</span>
              <span>{formatMoney(cart.subtotal, cart.currency)}</span>
            </div>
            {cart.appliedOffers
              .filter((o) => o.amount > 0)
              .map((o) => (
                <div key={o.id} className="flex justify-between gap-3 text-lime-700">
                  <span className="leading-snug">{o.label}</span>
                  <span className="whitespace-nowrap font-medium">−{formatMoney(o.amount, cart.currency)}</span>
                </div>
              ))}
            {cart.gifts.map((g) => (
              <div key={`g-${g.variantId}`} className="flex justify-between text-lime-700">
                <span>Free gift · {g.title}</span>
                <span className="font-medium">FREE</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between pt-3">
            <span className="font-semibold">Total</span>
            <span className="text-lg font-bold">{formatMoney(cart.total, cart.currency)}</span>
          </div>
          {cart.discountTotal > 0 && (
            <p className="mt-1 text-right text-xs font-semibold text-lime-700">
              You save {formatMoney(cart.discountTotal, cart.currency)}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
