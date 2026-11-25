"use client";

// Phase 8 step 0: checkout step 3, split out of CheckoutFlow. Stateless: the
// method, the totals and placing the order stay in CheckoutFlow.
// Phase 8 line 2: `terms` is the quote (lib/checkout/payment-terms.js). COD is
// hidden with its reason where it isn't offered; on the COD option the nudge
// says what paying online saves; the online option shows "Save ₹128".
import { formatMoney } from "@/lib/format";
import PrepaidNudge from "./PrepaidNudge";

export default function PaymentStep({ cart, method, onMethod, razorpayEnabled, codFee, grandTotal, error, placing, onBack, onPlace, policies, terms = null }) {
  const codShown = terms ? terms.cod.available : true;
  const save = terms?.nudge?.save > 0 ? terms.nudge.save : 0;
  const nothingToPay = !codShown && !razorpayEnabled;
  return (
    <section>
      <h2 className="mb-4 text-lg font-bold">Payment</h2>
      <div className="space-y-3">
        {!codShown && (
          <p data-checkout="cod-unavailable" className="rounded-sf-card border border-sf-border bg-sf-surface-muted px-4 py-3 text-sm text-sf-text-muted">
            {terms.cod.reason}.
          </p>
        )}
        {codShown && (
        <div>
        <label className={`flex cursor-pointer items-start gap-3 rounded-sf-card border p-4 ${method === "cod" ? "border-sf-inverse ring-1 ring-sf-inverse" : "border-sf-border"}`}>
          <input type="radio" name="method" checked={method === "cod"} onChange={() => onMethod("cod")} className="mt-1" />
          <div>
            <p className="text-sm font-semibold">
              Cash on Delivery
              {codFee > 0 && (
                <span className="font-normal text-sf-text-faint"> · +{formatMoney(codFee, cart.currency)} COD fee</span>
              )}
            </p>
            <p className="text-xs text-sf-text-subtle">Pay in cash when your order arrives.</p>
          </div>
        </label>
        {method === "cod" && razorpayEnabled && <PrepaidNudge nudge={terms?.nudge} currency={cart.currency} onPayOnline={() => onMethod("razorpay")} />}
        </div>
        )}
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
            onChange={() => onMethod("razorpay")}
            className="mt-1"
          />
          <div>
            <p className="text-sm font-semibold">
              Pay online <span className="font-normal text-sf-text-faint">· card / UPI / netbanking</span>
              {razorpayEnabled && save > 0 && (
                <span data-checkout="prepaid-save" className="ml-2 rounded-full bg-sf-surface-muted px-2 py-0.5 text-xs font-semibold text-sf-accent-text">
                  Save {formatMoney(save, cart.currency)}
                </span>
              )}
            </p>
            <p className="text-xs text-sf-text-subtle">
              {razorpayEnabled ? "You'll finish paying in a secure payment window." : "Online payment isn't available for this store right now."}
            </p>
          </div>
        </label>
      </div>

      {error && <p role="alert" className="mt-4 rounded-sf-control bg-sf-danger-surface px-4 py-3 text-sm text-sf-danger">{error}</p>}

      <div className="mt-6 flex gap-3">
        <button onClick={onBack} disabled={placing} className="rounded-sf-control border border-sf-border-strong px-5 py-3 text-sm font-semibold hover:bg-sf-surface-muted disabled:opacity-50">
          Back
        </button>
        <button
          onClick={() => onPlace()}
          disabled={placing || nothingToPay}
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
  );
}
