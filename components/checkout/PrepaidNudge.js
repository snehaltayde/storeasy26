"use client";

// Phase 8 line 2: on the cash-on-delivery option, what paying online saves,
// in amounts only: "Pay online and save ₹128: no ₹49 COD fee and 5% off".
// Stateless; the numbers are the quote's (lib/checkout/payment-terms.js).
import { nudgeSentence } from "@/lib/checkout/payment-terms";

export default function PrepaidNudge({ nudge, currency, onPayOnline }) {
  const sentence = nudgeSentence(nudge, currency);
  if (!sentence) return null;
  return (
    <div data-checkout="prepaid-nudge" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sf-small bg-sf-surface-muted px-3 py-2 text-xs">
      <span className="text-sf-text-muted">{sentence}</span>
      <button type="button" onClick={onPayOnline} className="font-semibold text-sf-accent-text hover:underline">
        Pay online instead
      </button>
    </div>
  );
}
