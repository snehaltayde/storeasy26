"use client";

// Phase 8 step 0: the sticky order summary, split out of CheckoutFlow.
// Stateless: it shows the cart and the shipping CheckoutFlow priced.
import { formatMoney } from "@/lib/format";

export default function OrderSummary({ cart, shipping, grandTotal }) {
  return (
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
  );
}
