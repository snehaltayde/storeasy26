"use client";

import { useEffect, useRef, useState } from "react";
import DeliveryEstimate from "./DeliveryEstimate";
import { pincodePatch } from "./checkoutModel";
import {
  BAD_PIN,
  NOT_FOUND,
  PIN_RE,
  lookupPin,
  savePin,
  savedPin,
} from "@/lib/pincode/client";

// Phase 8 line 1: the checkout's PIN code, asked first. Six valid digits look
// the PIN up (/api/pincode); city and state fill through pincodePatch (never
// over what the shopper typed), and the store's delivery estimate shows under
// it. A PIN the dataset doesn't know still lets the order through.
// While city and state hold the lookup's values it shows them as a chip with
// Change; `children(chip)` renders the rest of the address (AddressStep), which
// leaves those two fields out while the chip shows.
export default function PincodeField({ form, onAddress, children }) {
  const pin = form.pincode.trim();
  const [answer, setAnswer] = useState(null); // the last lookup's answer for `pin`
  const [touched, setTouched] = useState(false);
  const [editPlace, setEditPlace] = useState(false);
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
      return;
    }
    const ctl = new AbortController();
    lookupPin(pin, { signal: ctl.signal })
      .then((a) => {
        setAnswer({ pin, ...a });
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

  const badFormat =
    pin.length > 0 &&
    (/\D/.test(pin) ||
      pin.length > 6 ||
      (pin.length === 6 && !PIN_RE.test(pin)) ||
      (touched && pin.length < 6));
  const current = answer?.pin === pin ? answer : null;
  const place = current?.found ? current : null;
  const chip = Boolean(
    !editPlace &&
    place &&
    form.city === place.city &&
    form.state === place.state,
  );
  const message = badFormat
    ? BAD_PIN
    : current?.error || (current && !current.found ? NOT_FOUND : "");

  return (
    <>
      <div data-pincode-field className="mb-3">
        <label
          htmlFor="checkout-pincode"
          className="mb-1 block text-xs font-medium text-sf-text-subtle"
        >
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
        <div
          id="checkout-pincode-note"
          aria-live="polite"
          className="mt-1.5 space-y-1"
        >
          {message && (
            <p
              data-pincode-message
              className={`text-xs ${badFormat ? "text-sf-danger" : "text-sf-text-subtle"}`}
            >
              {message}
            </p>
          )}
          {current && !current.error && (
            <DeliveryEstimate
              estimate={current.estimate}
              timeZone={current.timeZone}
            />
          )}
        </div>
        {chip && (
          <p data-pincode-place className="mt-2 text-sm text-sf-text-body">
            {place.city}, {place.state} ·{" "}
            <button
              type="button"
              onClick={() => setEditPlace(true)}
              className="font-semibold text-sf-accent-text underline"
            >
              Change
            </button>
          </p>
        )}
      </div>
      {children?.(chip)}
    </>
  );
}
