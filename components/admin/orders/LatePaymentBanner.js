import { formatMoney } from "@/lib/format";

// Phase 9 line 2 review: a payment Razorpay captured for an order that was
// already cancelled (a replaced renewal attempt, lib/late-payment.js). The
// money has to go back; Storeasy has no refund API call, so the founder
// refunds in Razorpay (docs/refunds.md), with the steps here.
export function LatePaymentBanner({ events }) {
  const late = (events || []).map((e) => (typeof e.meta === "string" ? safe(e.meta) : e.meta)).filter((m) => m?.reason === "payment_on_replaced_order");
  if (!late.length) return null;
  return (
    <div role="alert" data-late-payment className="mb-4 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <p className="font-medium">A payment arrived for a replaced order; refund it.</p>
      {late.map((m) => (
        <div key={m.late_payment} className="mt-2 space-y-1">
          <p>
            Razorpay captured <span className="font-mono">{m.late_payment}</span> ({formatMoney(Number(m.amount) || 0, m.currency || "INR")}) after this order was cancelled. The shopper paid for this delivery another way, so this money must go back.
          </p>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>Open your Razorpay dashboard and go to Transactions → Payments.</li>
            <li>Search for <span className="font-mono">{m.late_payment}</span>.</li>
            <li>Press Refund and refund the full amount. The shopper gets it back in 5–7 working days.</li>
          </ol>
        </div>
      ))}
    </div>
  );
}

function safe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
