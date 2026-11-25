"use client";

import { useEffect, useState } from "react";
import DeliveryEstimate from "@/components/checkout/DeliveryEstimate";
import { formatMoney } from "@/lib/format";
import { BAD_PIN, NOT_FOUND, PIN_RE, lookupPin, savePin, savedPin } from "@/lib/pincode/client";

// Phase 8 line 1: "Check delivery" on the product page. A PIN code gives this
// store's delivery estimate, whether cash on delivery is open there (the
// zone's `cod`) and the zone's free-shipping amount. The PIN is kept in
// localStorage (sf_pin) and prefills the checkout.
export default function DeliveryCheck({ currency = "INR" }) {
  const [pin, setPin] = useState("");
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function check(value) {
    const p = value.trim();
    if (!PIN_RE.test(p)) {
      setAnswer(null);
      setError(BAD_PIN);
      return;
    }
    setBusy(true);
    setError("");
    const a = await lookupPin(p);
    setBusy(false);
    if (a.error) {
      setAnswer(null);
      setError(a.error);
      return;
    }
    savePin(p);
    setAnswer({ pin: p, ...a });
  }

  useEffect(() => {
    const saved = savedPin();
    if (saved) {
      setPin(saved);
      check(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section data-delivery-check aria-labelledby="delivery-check-title" className="mt-6 rounded-sf-card border border-sf-border p-4">
      <h2 id="delivery-check-title" className="text-sm font-semibold text-sf-text">
        Check delivery
      </h2>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          check(pin);
        }}
      >
        <label htmlFor="delivery-check-pin" className="sr-only">
          PIN code
        </label>
        <input
          id="delivery-check-pin"
          name="pin"
          inputMode="numeric"
          maxLength={6}
          autoComplete="postal-code"
          placeholder="PIN code"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby="delivery-check-result"
          className="min-w-0 flex-1 rounded-sf-control border border-sf-border px-3 py-2 text-sm outline-none focus:border-sf-border-hover"
        />
        <button type="submit" disabled={busy} className="rounded-sf-control border border-sf-border px-4 py-2 text-sm font-semibold text-sf-text-body transition hover:border-sf-border-hover disabled:opacity-60">
          Check
        </button>
      </form>
      <div id="delivery-check-result" aria-live="polite" className="mt-2 space-y-1 text-sm">
        {error && <p className="text-xs text-sf-danger">{error}</p>}
        {answer && (
          <>
            {answer.found === true && <p className="text-sf-text-body">{answer.city}, {answer.state}</p>}
            {answer.found === false && <p className="text-xs text-sf-text-subtle">{NOT_FOUND}</p>}
            <DeliveryEstimate estimate={answer.estimate} timeZone={answer.timeZone} />
            <p data-delivery-cod={answer.cod ? "yes" : "no"} className="text-sf-text-muted">
              {answer.cod ? "Cash on delivery available" : "Cash on delivery isn't available for this PIN code"}
            </p>
            {answer.freeThreshold != null && (
              <p className="text-sf-text-muted">
                {answer.freeThreshold > 0 ? `Free shipping on orders of ${formatMoney(answer.freeThreshold, currency)} or more` : "Free shipping"}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
