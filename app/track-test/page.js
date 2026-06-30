"use client";

// Session 9 spike harness — fires ONE purchase with a shared event_id to the
// browser pixels (gtag + fbq) AND our first-party /api/track (which relays to
// GA4 MP + Meta CAPI). Same id → GA4/Meta dedup the browser + server copies.
// Spike-only; remove or gate before production.
import { useEffect, useState } from "react";

const GA4 = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID || "";
const PIXEL = process.env.NEXT_PUBLIC_META_PIXEL_ID || "";

const SAMPLE = {
  value: 13565,
  currency: "INR",
  items: [
    { id: "45321217147097", name: "Beast Recovery BCAA (Mango)", price: 499, quantity: 3 },
    { id: "45042167054553", name: "Isorich Whey 924g", price: 4949, quantity: 1 },
    { id: "45323586633945", name: "Isorich Whey 1.848kg", price: 9749, quantity: 1 },
  ],
  email: "spike@beastlife.in",
  phone: "9000000000",
};

function loadGtag(id) {
  if (!id || window.gtag) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", id, { debug_mode: true });
}

function loadFbq(id) {
  if (!id || window.fbq) return;
  /* eslint-disable */
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  /* eslint-enable */
  window.fbq("init", id);
  window.fbq("track", "PageView");
}

export default function TrackTest() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState("");

  useEffect(() => {
    loadGtag(GA4);
    loadFbq(PIXEL);
  }, []);

  async function fire(withBrowserPixel) {
    setBusy(true);
    setResult(null);
    const eventId = `BL-SPIKE-${Date.now()}`;
    setLastId(eventId);
    const { value, currency, items } = SAMPLE;

    if (withBrowserPixel) {
      window.gtag?.("event", "purchase", {
        transaction_id: eventId,
        value,
        currency,
        items: items.map((i) => ({ item_id: i.id, item_name: i.name, price: i.price, quantity: i.quantity })),
      });
      window.fbq?.(
        "track",
        "Purchase",
        { value, currency, content_type: "product", content_ids: items.map((i) => i.id), contents: items.map((i) => ({ id: i.id, quantity: i.quantity })) },
        { eventID: eventId },
      );
    }

    const res = await fetch("/api/track?debug=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debug: true, sourceUrl: window.location.href, event: { name: "Purchase", event_id: eventId, ...SAMPLE } }),
    });
    setResult(await res.json());
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <h1 className="text-xl font-bold">Tracking spike — purchase event</h1>
      <p className="mt-1 text-sm text-zinc-500">
        GA4: <code>{GA4 || "(unset)"}</code> · Pixel: <code>{PIXEL || "(unset)"}</code>
      </p>

      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={() => fire(true)} disabled={busy} className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          Fire purchase — browser pixel + server (dedup test)
        </button>
        <button onClick={() => fire(false)} disabled={busy} className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
          Fire server-only
        </button>
      </div>

      {lastId && (
        <p className="mt-4 text-sm">
          Shared <strong>event_id</strong>: <code>{lastId}</code> — look for it in GA4 DebugView (as <code>transaction_id</code>) and Meta Test Events (deduplicated).
        </p>
      )}
      {result && (
        <pre className="mt-3 overflow-auto rounded-lg bg-zinc-900 p-4 text-xs text-lime-200">{JSON.stringify(result, null, 2)}</pre>
      )}
    </main>
  );
}
