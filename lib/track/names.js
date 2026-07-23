// Shared, CLIENT-SAFE tracking vocabulary (no node imports) — used by both the
// browser tracker/pixels and the server relay, so names and consent semantics
// can never drift between the two sides.

export const FUNNEL_EVENTS = [
  "view_item",
  "view_item_list",
  "search",
  "select_item", // search-result click-through (S16 search analytics)
  "add_to_cart",
  "begin_checkout",
  "add_payment_info",
  "purchase",
];

// Canonical (GA4) name → Meta event. ViewItemList has no Meta standard event,
// so the pixel fires it via trackCustom (STANDARD=false).
export const META_EVENT_NAMES = {
  view_item: "ViewContent",
  view_item_list: "ViewItemList",
  search: "Search",
  select_item: "SelectItem",
  add_to_cart: "AddToCart",
  begin_checkout: "InitiateCheckout",
  add_payment_info: "AddPaymentInfo",
  purchase: "Purchase",
};
export const META_STANDARD_EVENTS = new Set([
  "ViewContent",
  "Search",
  "AddToCart",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
]);

// ---- consent (DPDP-aware, basic) ----
// "granted" | "denied" | unset(null). Non-essential tracking (all funnel
// analytics + pixels) fires ONLY on "granted". Order processing itself is
// contractual necessity and never depends on this.
export const CONSENT_COOKIE = "_consent";
export const isConsentGranted = (value) => value === "granted";

export function readConsentCookie() {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)_consent=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
