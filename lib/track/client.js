"use client";

import { META_EVENT_NAMES, META_STANDARD_EVENTS, readConsentCookie, isConsentGranted } from "./names.js";

// First-party client tracker (S14, consent + pixel co-fire in S15). One call
// fires an event on EVERY path with the SAME event_id, so the platforms dedup:
//   1. beacon → our /api/track collector → stored → GA4 MP (purchase) + Meta CAPI
//   2. gtag('event', …)          — GA4 browser copy (purchase dedups by
//      transaction_id; other names are browser-ONLY in GA4 → never double-counted)
//   3. fbq('track…', {eventID})  — Meta pixel copy (event_id dedups vs CAPI)
// DPDP consent gates the whole thing: no consent → no-op (and the collector +
// pixel loader independently enforce the same rule).
export function track(name, data = {}) {
  if (typeof window === "undefined") return null;
  if (!isConsentGranted(readConsentCookie())) return null;

  const event_id =
    data.event_id ||
    (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // ---- 1. first-party collector (durable path) ----
  const body = JSON.stringify({
    name,
    ...data,
    event_id,
    url: window.location.href,
    referrer: document.referrer || undefined,
  });
  try {
    const sent = navigator.sendBeacon?.("/api/track", new Blob([body], { type: "application/json" }));
    if (!sent) throw new Error("beacon refused");
  } catch {
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }

  // ---- 2. GA4 browser copy ----
  if (typeof window.gtag === "function") {
    const params = {
      ...(data.value != null ? { value: data.value } : {}),
      ...(data.currency ? { currency: data.currency } : {}),
      ...(data.params || {}),
      ...(data.items?.length
        ? {
            items: data.items.map((it) => ({
              item_id: String(it.id),
              item_name: it.name,
              ...(it.price != null ? { price: it.price } : {}),
              ...(it.quantity != null ? { quantity: it.quantity } : {}),
            })),
          }
        : {}),
    };
    if (name === "purchase") params.transaction_id = event_id;
    window.gtag("event", name, params);
  }

  // ---- 3. Meta pixel copy (shared eventID = CAPI dedup key) ----
  if (typeof window.fbq === "function") {
    const metaName = META_EVENT_NAMES[name] || name;
    const custom = {
      ...(data.value != null ? { value: data.value } : {}),
      ...(data.currency ? { currency: data.currency } : {}),
      ...(data.items?.length
        ? {
            content_type: "product",
            content_ids: data.items.map((it) => String(it.id)),
            contents: data.items.map((it) => ({ id: String(it.id), quantity: it.quantity ?? 1 })),
          }
        : {}),
      ...(name === "search" && data.params?.search_term ? { search_string: data.params.search_term } : {}),
    };
    window.fbq(
      META_STANDARD_EVENTS.has(metaName) ? "track" : "trackCustom",
      metaName,
      custom,
      { eventID: event_id },
    );
  }

  return event_id;
}
