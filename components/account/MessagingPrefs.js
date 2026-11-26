"use client";

import { useEffect, useState } from "react";
import { CONSENT_WORDING, PURPOSES } from "@/lib/messaging/wording";

// Phase 9 line 3: the account page's WhatsApp toggles (GET/POST
// /api/account/messaging, the signed-in shopper's own consents only). Both
// off until the shopper turns them on; turning one on uses the account's
// phone (or the one typed here).
export default function MessagingPrefs() {
  const [state, setState] = useState(null);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/account/messaging", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setState(j?.ok ? j : null))
      .catch(() => setState(null));
  }, []);

  async function toggle(purpose, on) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/messaging", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose, granted: on, ...(phone ? { phone } : {}) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || "That didn't save. Try again.");
      setState(json);
    } catch (e) {
      setError(e.message || "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <section className="mt-8 rounded-sf-card border border-sf-border p-6" data-wa="account">
      <h2 className="text-base font-semibold">WhatsApp messages</h2>
      {state.phone ? (
        <p className="mt-1 text-sm text-sf-text-subtle">For {state.phone}</p>
      ) : (
        <div className="mt-3">
          <label htmlFor="wa-phone" className="mb-1 block text-xs font-medium text-sf-text-subtle">
            Phone for WhatsApp
          </label>
          <input id="wa-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full sf-field rounded-sf-control border border-sf-border px-3 py-2" />
        </div>
      )}
      <div className="mt-3 space-y-2">
        {PURPOSES.map((p) => (
          <label key={p} className="flex items-start gap-2 text-sm text-sf-text-subtle">
            <input type="checkbox" data-wa-account={p} className="sf-focus mt-0.5 size-4" checked={Boolean(state[p])} disabled={busy} onChange={(e) => toggle(p, e.target.checked)} />
            <span>{CONSENT_WORDING[p].text}</span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-sf-danger">
          {error}
        </p>
      )}
    </section>
  );
}
