"use client";

import { useEffect, useRef, useState } from "react";
import { e164 } from "@/lib/checkout/phone";
import { CONSENT_WORDING, PURPOSES } from "@/lib/messaging/wording";

// Phase 9 line 3: the two WhatsApp opt-ins at checkout, both unticked. Each
// tick or untick is saved at once (POST /api/messaging/consent, bound to this
// cart on the server) for the phone typed above. If that phone changes after
// a tick, the tick is withdrawn and the box clears, so a consent never covers
// a number the shopper didn't tick it for.
//   phone, country: the address form's values
export default function WhatsAppConsent({ phone, country = "IN" }) {
  const number = e164(phone, country);
  const [granted, setGranted] = useState({}); // purpose → the number it covers
  const [error, setError] = useState(null);
  const latest = useRef(granted);
  latest.current = granted;

  // the box follows the click at once and goes back if the save fails
  async function save(purpose, on) {
    setError(null);
    const was = latest.current[purpose] ?? null;
    setGranted((g) => ({ ...g, [purpose]: on ? number : null }));
    try {
      const res = await fetch("/api/messaging/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose, granted: on, phone, country }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || "That didn't save. Try again.");
    } catch (e) {
      setGranted((g) => ({ ...g, [purpose]: was }));
      setError(e.message || "That didn't save. Try again.");
    }
  }

  // the phone changed after a tick: withdraw it
  useEffect(() => {
    for (const p of PURPOSES) if (latest.current[p] && latest.current[p] !== number) save(p, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  return (
    <fieldset className="mt-4 space-y-2" data-wa="consent">
      <legend className="sr-only">WhatsApp messages</legend>
      {PURPOSES.map((p) => (
        <label key={p} className="flex items-start gap-2 text-sm text-sf-text-subtle">
          <input
            type="checkbox"
            name={`wa-${p}`}
            data-wa-consent={p}
            className="sf-focus mt-0.5 size-4"
            checked={Boolean(granted[p] && granted[p] === number)}
            disabled={!number}
            onChange={(e) => save(p, e.target.checked)}
          />
          <span>{CONSENT_WORDING[p].text}</span>
        </label>
      ))}
      {!number && <p className="text-xs text-sf-text-faint">Add your phone number above to choose WhatsApp messages.</p>}
      {error && (
        <p role="alert" className="text-xs text-sf-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}
