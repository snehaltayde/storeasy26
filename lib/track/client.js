"use client";

// First-party client tracker (Session 14). Fires funnel events at our own
// /api/track collector — same origin, so identity cookies are first-party and
// ad-blockers that kill third-party tags don't apply. sendBeacon survives
// navigation (add_payment_info right before the Razorpay redirect, purchase
// right before "continue shopping"); falls back to keepalive fetch.
export function track(name, data = {}) {
  if (typeof window === "undefined") return null;
  const event_id =
    data.event_id ||
    (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  return event_id;
}
