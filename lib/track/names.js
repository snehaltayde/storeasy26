// Shared, CLIENT-SAFE tracking vocabulary (no node imports) — used by both the
// browser tracker/pixels and the server relay, so names and consent semantics
// can never drift between the two sides.

export const FUNNEL_EVENTS = [
  "view_item",
  "view_item_list",
  "search",
  "select_item", // search-result click-through (S16 search analytics)
  "view_campaign", // campaign-landing view with utm params (S39 / SF17)
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
  view_campaign: "ViewCampaign", // non-standard → trackCustom
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

// ---- consent (DPDP-aware; PURPOSES + versioning since S33 / SF24) ----
// v2 cookie value = JSON {"v":2,"a":0|1,"m":0|1,"at":"<iso>"}:
//   a = ANALYTICS purpose  → GA4 (gtag + Measurement Protocol)
//   m = MARKETING purpose  → Meta (pixel + CAPI)
// v1 legacy values "granted"/"denied" map to both-on/both-off. Order
// processing is contractual necessity and never depends on any of this.
export const CONSENT_COOKIE = "_consent";
export const CONSENT_VERSION = 2;

export function parseConsent(value) {
  if (!value) return { known: false, version: 0, analytics: false, marketing: false, at: null };
  if (value === "granted") return { known: true, version: 1, analytics: true, marketing: true, at: null };
  if (value === "denied") return { known: true, version: 1, analytics: false, marketing: false, at: null };
  try {
    const j = JSON.parse(value);
    if (j && j.v >= 2) {
      return { known: true, version: j.v, analytics: !!j.a, marketing: !!j.m, at: j.at || null };
    }
  } catch {
    /* unknown format → treat as no consent */
  }
  return { known: false, version: 0, analytics: false, marketing: false, at: null };
}

export const serializeConsent = ({ analytics, marketing }) =>
  JSON.stringify({ v: CONSENT_VERSION, a: analytics ? 1 : 0, m: marketing ? 1 : 0, at: new Date().toISOString() });

export const consentAllows = (value, purpose) => parseConsent(value)[purpose] === true;

// "any non-essential purpose granted" — the store-level gate (per-destination
// gating happens at forward time against the purposes).
export const isConsentGranted = (value) => {
  const c = parseConsent(value);
  return c.analytics || c.marketing;
};

export function readConsentCookie() {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)_consent=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// S33 (BE20): raw PII never enters general analytics properties — param values
// that look like emails or Indian phone numbers are stripped at the collector
// (hashed identity goes through user_data, nothing else).
export function scrubPiiParams(params) {
  if (!params || typeof params !== "object") return params;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v) || /(?:^|\D)[6-9]\d{9}(?:\D|$)/.test(v))) {
      out[k] = "[pii-stripped]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// S33 (SF08 residuals): strip secret-bearing query params before a URL leaves
// our first-party context (trackers, error reports, CAPI event_source_url).
export function scrubTrackingUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url, "https://x.invalid");
    u.searchParams.delete("t"); // order-proof tokens
    u.searchParams.delete("preview"); // future signed previews
    const out = u.toString();
    return url.startsWith("http") ? out : out.replace("https://x.invalid", "");
  } catch {
    return String(url).split("?")[0];
  }
}
