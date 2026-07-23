"use client";

import { useEffect, useState } from "react";
import { CONSENT_COOKIE, readConsentCookie } from "@/lib/track/names";

// Basic DPDP-aware consent: analytics + ad pixels are OFF until the visitor
// says yes. The choice persists a year, first-party. Declining hides the
// banner and nothing non-essential ever fires (tracker, collector, and pixel
// loader all check the same cookie).
export default function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(readConsentCookie() == null);
  }, []);

  function decide(value) {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${CONSENT_COOKIE}=${value}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${secure}`;
    setVisible(false);
    if (value === "granted") window.dispatchEvent(new Event("consent-granted"));
  }

  if (!visible) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-white/95 px-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.08)] backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-zinc-600">
          We use analytics and advertising cookies to understand shopping activity and improve
          BeastLife. We only do this with your consent, and you can change your mind anytime.
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => decide("denied")}
            className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            No thanks
          </button>
          <button
            onClick={() => decide("granted")}
            className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
