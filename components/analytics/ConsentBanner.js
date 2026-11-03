"use client";

import { useEffect, useState } from "react";
import { CONSENT_COOKIE, readConsentCookie, parseConsent, serializeConsent } from "@/lib/track/names";

// DPDP consent with PURPOSES (S33 / SF24): analytics (GA4) and marketing
// (Meta) are separate choices, persisted as a versioned first-party cookie.
// A persistent "Privacy" chip reopens the panel anytime; saving a change
// reloads so pixels and the tracker re-evaluate immediately — withdrawal
// stops client tags now and server-side forwarding gates per purpose on the
// consent stored with each event. Order processing never depends on this.
export default function ConsentBanner({ storeName = "this store" }) {
  const [visible, setVisible] = useState(false);
  const [chip, setChip] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  const [marketing, setMarketing] = useState(true);

  useEffect(() => {
    const raw = readConsentCookie();
    const c = parseConsent(raw);
    if (!c.known) {
      setVisible(true);
    } else {
      setChip(true);
      setAnalytics(c.analytics);
      setMarketing(c.marketing);
    }
  }, []);

  function persist(next) {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(serializeConsent(next))}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${secure}`;
    const had = parseConsent(readConsentCookie());
    setVisible(false);
    setChip(true);
    if (next.analytics || next.marketing) window.dispatchEvent(new Event("consent-granted"));
    // A change (incl. withdrawal) reloads so every tag re-evaluates — honest
    // and simple; a fresh choice on a clean page just continues.
    if (had.known) window.location.reload();
  }

  if (!visible) {
    return chip ? (
      <button
        onClick={() => {
          setExpanded(true);
          setVisible(true);
        }}
        aria-label="Privacy settings"
        className="fixed bottom-3 left-3 z-40 rounded-full border border-sf-border bg-sf-surface/90 px-3 py-1.5 text-xs font-semibold text-sf-text-subtle shadow backdrop-blur hover:text-sf-text-soft"
      >
        Privacy
      </button>
    ) : null;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-sf-border bg-sf-surface/95 px-4 py-4 shadow-sf-sheet backdrop-blur sm:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-sf-text-muted">
            We use analytics and advertising cookies to understand shopping activity and improve{" "}
            {storeName}. Only with your consent — change your mind anytime via the Privacy button.
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              onClick={() => setExpanded((e) => !e)}
              className="rounded-sf-control border border-sf-border-strong px-4 py-2 text-sm font-semibold text-sf-text-body hover:bg-sf-surface-muted"
            >
              Settings
            </button>
            <button
              onClick={() => persist({ analytics: false, marketing: false })}
              className="rounded-sf-control border border-sf-border-strong px-4 py-2 text-sm font-semibold text-sf-text-body hover:bg-sf-surface-muted"
            >
              No thanks
            </button>
            <button
              onClick={() => persist({ analytics: true, marketing: true })}
              className="rounded-sf-control bg-sf-inverse px-4 py-2 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover"
            >
              Allow all
            </button>
          </div>
        </div>
        {expanded && (
          <div className="mt-3 flex flex-col gap-2 border-t border-sf-border-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-6">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked disabled />
                <span className="text-sf-text-faint">Essential (orders, cart) — always on</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} />
                Analytics (Google Analytics)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
                Marketing (Meta ads)
              </label>
            </div>
            <button
              onClick={() => persist({ analytics, marketing })}
              className="rounded-sf-control bg-sf-inverse px-4 py-2 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover"
            >
              Save choices
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
