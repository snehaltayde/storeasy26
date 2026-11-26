"use client";

import { useEffect, useRef, useState } from "react";
import { e164 } from "@/lib/checkout/phone";
import { CONSENT_WORDING, PURPOSES } from "@/lib/messaging/wording";

// Phase 9 line 3: the two WhatsApp opt-ins at checkout, both unticked until
// the shopper ticks them. They start from what this cart already holds (GET
// /api/messaging/consent, the cart cookie only), so a reload shows the truth.
// Each tick or untick is saved at once for the phone typed above; the box
// follows the click and goes back if the save fails. Whenever a valid phone is
// typed while a consent is live, the server is told (sync), and a consent for
// any other number is withdrawn, so a consent never covers a number the
// shopper didn't tick it for (after a reload too).
//   phone, country: the address form's values
const post = async (body) => {
  const res = await fetch("/api/messaging/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || "That didn't save. Try again.");
  return json;
};

export default function WhatsAppConsent({ phone, country = "IN" }) {
  const number = e164(phone, country);
  const [live, setLive] = useState({ updates: false, marketing: false }); // as the server last said
  const [syncedFor, setSyncedFor] = useState(null); // the number the server last matched
  const [error, setError] = useState(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    fetch("/api/messaging/consent", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.ok && setLive({ updates: Boolean(j.updates), marketing: Boolean(j.marketing) }))
      .catch(() => {});
  }, []);

  // a valid phone while something is live: the server keeps only this number's consents
  useEffect(() => {
    if (!number || number === syncedFor || !(liveRef.current.updates || liveRef.current.marketing)) return;
    post({ sync: true, phone, country })
      .then((j) => {
        setLive({ updates: Boolean(j.updates), marketing: Boolean(j.marketing) });
        setSyncedFor(number);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, live.updates, live.marketing]);

  async function save(purpose, on) {
    setError(null);
    const was = liveRef.current[purpose];
    const wasFor = syncedFor;
    setLive((l) => ({ ...l, [purpose]: on }));
    if (on) setSyncedFor(number); // a tick is saved for this number
    try {
      let j = await post({ purpose, granted: on, phone, country });
      // a tick for a number not yet matched: withdraw any other number's consent too
      if (on && wasFor !== number) j = await post({ sync: true, phone, country });
      setLive({ updates: Boolean(j.updates), marketing: Boolean(j.marketing) });
    } catch (e) {
      setLive((l) => ({ ...l, [purpose]: was }));
      setSyncedFor(wasFor);
      setError(e.message || "That didn't save. Try again.");
    }
  }

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
            checked={Boolean(number && live[p] && syncedFor === number)}
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
