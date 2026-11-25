"use client";

import { useEffect, useRef, useState } from "react";
import DeliveryEstimate from "./DeliveryEstimate";
import { pincodePatch } from "./checkoutModel";
import { BAD_PIN, NOT_FOUND, PIN_RE, lookupPin, savePin, savedPin } from "@/lib/pincode/client";

// Phase 8 line 1: the checkout's PIN code, asked first. Six valid digits look
// the PIN up (/api/pincode); city and state fill through pincodePatch (never
// over what the shopper typed), and the store's delivery estimate shows under
// it. A PIN the dataset doesn't know still lets the order through.
//   onLookup(place | null): tells AddressStep what the PIN found, so the city
//   and state fields can show as the chip while they hold the lookup's values.
export default function PincodeField({ form, onAddress, onLookup }) {
  const pin = form.pincode.trim();
  const [answer, setAnswer] = useState(null); // the last lookup's answer for `pin`
  const [touched, setTouched] = useState(false);
  const filled = useRef({}); // the { city, state } the lookup last wrote
  const latest = useRef(form); // the form when an answer lands, not when it was asked
  latest.current = form;

  // A PIN the shopper checked on a product page prefills an empty field once.
  useEffect(() => {
    if (!form.pincode) {
      const saved = savedPin();
      if (saved) onAddress({ pincode: saved }, "pincode");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!PIN_RE.test(pin)) {
      setAnswer(null);
      onLookup?.(null);
      return;
    }
    const ctl = new AbortController();
    lookupPin(pin, { signal: ctl.signal })
      .then((a) => {
        setAnswer({ pin, ...a });
        onLookup?.(a.found ? a : null);
        if (!a.found) return;
        savePin(pin);
        const patch = pincodePatch(latest.current, a, filled.current);
        if (Object.keys(patch).length) {
          filled.current = { ...filled.current, ...patch };
          onAddress(patch, "pincode");
        }
      })
      .catch(() => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const badFormat = pin.length > 0 && (/\D/.test(pin) || pin.length > 6 || (pin.length === 6 && !PIN_RE.test(pin)) || (touched && pin.length < 6));
  const current = answer?.pin === pin ? answer : null;
  const message = badFormat ? BAD_PIN : current?.error || (current && !current.found ? NOT_FOUND : "");

  return (
    <div data-pincode-field>
      <label htmlFor="checkout-pincode" className="mb-1 block text-xs font-medium text-sf-text-subtle">
        PIN code
      </label>
      <input
        id="checkout-pincode"
        type="text"
        name="pincode"
        inputMode="numeric"
        maxLength={6}
        autoComplete="postal-code"
        value={form.pincode}
        onChange={(e) => onAddress({ pincode: e.target.value }, "typed")}
        onBlur={() => setTouched(true)}
        aria-invalid={badFormat ? true : undefined}
        aria-describedby="checkout-pincode-note"
        className="w-full rounded-sf-control border border-sf-border px-3 py-2.5 text-sm outline-none focus:border-sf-border-hover sm:w-1/2"
      />
      <div id="checkout-pincode-note" aria-live="polite" className="mt-1.5 space-y-1">
        {message && (
          <p data-pincode-message className={`text-xs ${badFormat ? "text-sf-danger" : "text-sf-text-subtle"}`}>
            {message}
          </p>
        )}
        {current && !current.error && <DeliveryEstimate estimate={current.estimate} timeZone={current.timeZone} />}
      </div>
    </div>
  );
}
