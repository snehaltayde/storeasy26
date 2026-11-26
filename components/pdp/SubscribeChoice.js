"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";

// Phase 9 line 2: the buy box's "One-time" or "Subscribe" choice. The offer
// and every subscribed price come from the server (GET /api/cart?subscribe=);
// nothing here computes money. Shown only when the server offers it for this
// product (subscriptions on, the product eligible, the base market).
//   onChange({ interval, unitPrice }) — interval null = one-time
export default function SubscribeChoice({ productId, variantId, price, currency = "INR", onChange }) {
  const [offer, setOffer] = useState(null);
  const [mode, setMode] = useState("once");
  const [interval, setInterval] = useState(null);

  useEffect(() => {
    if (!productId) return;
    let live = true;
    fetch(`/api/cart?subscribe=${encodeURIComponent(productId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d?.offer?.intervals?.length) return;
        setOffer(d.offer);
        setInterval(d.offer.intervals.includes(30) ? 30 : d.offer.intervals[0]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [productId]);

  const unitPrice = offer && variantId != null ? offer.prices?.[variantId] : null;
  useEffect(() => {
    onChange?.(mode === "subscribe" && offer && unitPrice != null ? { interval, unitPrice } : { interval: null, unitPrice: null });
  }, [mode, interval, offer, unitPrice]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!offer || unitPrice == null) return null;
  const save = offer.percent > 0 ? ` and save ${offer.percent}%` : "";
  const box = (on) => `sf-focus-within flex min-h-11 cursor-pointer items-start gap-3 rounded-sf-control border px-4 py-3 text-sm transition ${on ? "border-sf-inverse bg-sf-surface ring-1 ring-sf-inverse" : "border-sf-border bg-sf-surface hover:border-sf-border-hover"}`;
  return (
    <fieldset className="mt-6 space-y-2" data-subscribe-choice>
      <legend className="mb-2 text-sm font-semibold text-sf-text-body">How would you like it?</legend>
      <label className={box(mode === "once")}>
        <input type="radio" name="purchase-mode" value="once" checked={mode === "once"} onChange={() => setMode("once")} className="mt-0.5 size-4 accent-current" />
        <span className="flex-1">One-time</span>
        <span className="font-semibold tabular-nums">{formatMoney(price, currency)}</span>
      </label>
      <label className={box(mode === "subscribe")}>
        <input type="radio" name="purchase-mode" value="subscribe" checked={mode === "subscribe"} onChange={() => setMode("subscribe")} className="mt-0.5 size-4 accent-current" data-subscribe-radio />
        <span className="flex-1">
          <span className="block">
            Subscribe{save}: <span className="font-semibold tabular-nums" data-subscribe-price>{formatMoney(unitPrice, currency)}</span> every{" "}
            <select
              aria-label="Delivery every"
              value={interval ?? ""}
              onChange={(e) => {
                setInterval(Number(e.target.value));
                setMode("subscribe");
              }}
              className="sf-field mt-1 min-h-11 rounded-sf-small border border-sf-border bg-sf-surface px-2 py-1 sm:mt-0 sm:min-h-0"
              data-subscribe-interval
            >
              {offer.intervals.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </span>
          <span className="mt-2 block text-xs text-sf-text-subtle">You pay for each delivery when it&rsquo;s due. Nothing is charged automatically.</span>
        </span>
      </label>
    </fieldset>
  );
}
