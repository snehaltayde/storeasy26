// Server-side, first-party tracking core (Session 9 spike).
// The browser talks ONLY to our own /api/track; this module relays the event
// server-side to GA4 (Measurement Protocol) and Meta (Conversions API), with a
// shared id for browser↔server dedup and SHA-256-hashed PII for Meta.
import crypto from "node:crypto";

// ---- config (server secrets stay server-only; the *_PUBLIC_* ids feed the browser tags) ----
// Read at CALL time (not module load) so store-only mode, tests, and future
// env changes behave without a process restart.
export const GA4_MEASUREMENT_ID = () => process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID || "";
export const GA4_API_SECRET = () => process.env.GA4_API_SECRET || "";
export const META_PIXEL_ID = () => process.env.NEXT_PUBLIC_META_PIXEL_ID || "";
export const META_CAPI_TOKEN = () => process.env.META_CAPI_TOKEN || "";
export const META_TEST_EVENT_CODE = () => process.env.META_TEST_EVENT_CODE || "";
export const META_API_VERSION = () => process.env.META_API_VERSION || "v21.0";

export const ga4Configured = () => Boolean(GA4_MEASUREMENT_ID() && GA4_API_SECRET());
export const metaConfigured = () => Boolean(META_PIXEL_ID() && META_CAPI_TOKEN());

// ---- SHA-256 of normalised PII (Meta requirement) ----
export const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
export const hashEmail = (email) => (email ? sha256(String(email).trim().toLowerCase()) : null);
export function hashPhone(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/[^0-9]/g, "");
  if (d.length === 10) d = "91" + d; // bare Indian mobile → add country code
  d = d.replace(/^0+/, "");
  return sha256(d);
}

// Meta match-quality fields (Session 15): normalize per Meta spec — lowercase,
// strip punctuation/whitespace — then SHA-256. Raw values are never stored.
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashName = (v) => (v && norm(v) ? sha256(norm(v)) : null); // fn / ln
export const hashCity = (v) => (v && norm(v) ? sha256(norm(v)) : null); // ct
export const hashState = (v) => (v && norm(v) ? sha256(norm(v)) : null); // st
export function hashZip(v) {
  const z = String(v ?? "").trim().toLowerCase().replace(/\s/g, "");
  return z ? sha256(z) : null; // zp
}
export function hashCountry(v) {
  // Meta wants the 2-letter ISO code, lowercase
  const map = { india: "in", in: "in" };
  const c = norm(v);
  const code = map[c] || (c.length === 2 ? c : null);
  return code ? sha256(code) : null;
}
export const hashExternalId = (v) => (v ? sha256(String(v).trim()) : null);

// ---- funnel vocabulary — shared with the client tracker/pixels ----
export { FUNNEL_EVENTS, META_EVENT_NAMES } from "./track/names.js";
import { META_EVENT_NAMES } from "./track/names.js";

// Landing-page click ids → first-party capture (fbc format per Meta spec).
export function extractTrackingIds(url) {
  try {
    const u = new URL(url);
    return {
      fbclid: u.searchParams.get("fbclid") || null,
      gclid: u.searchParams.get("gclid") || null,
    };
  } catch {
    return { fbclid: null, gclid: null };
  }
}
export const fbcFromFbclid = (fbclid) => (fbclid ? `fb.1.${Date.now()}.${fbclid}` : null);

// ---- first-party identifiers ----
// GA4 client_id: prefer the _ga cookie so server MP and browser gtag report the
// SAME user; fall back to our own first-party _fp_cid.
export function ga4ClientId(cookies) {
  const ga = cookies._ga; // "GA1.1.1234567890.1234567890"
  if (ga) {
    const parts = ga.split(".");
    if (parts.length >= 4) return parts.slice(-2).join(".");
  }
  return cookies._fp_cid || null;
}
export const newClientId = () =>
  `${Math.floor(Math.random() * 1e10)}.${Math.floor(Date.now() / 1000)}`;
export const newFbp = () => `fb.1.${Date.now()}.${Math.floor(Math.random() * 1e16)}`;

// ---- GA4 Measurement Protocol ----
// Full-funnel builder. `event.name` is the canonical GA4 name. purchase gets
// transaction_id = event_id (GA4's gtag↔MP dedup key); search gets
// search_term; view_item_list gets its list params. Extra event.params merge in.
export function buildGa4Payload({ clientId, event, debug = false }) {
  const params = {
    ...(event.value != null ? { value: event.value } : {}),
    ...(event.currency ? { currency: event.currency } : {}),
    engagement_time_msec: 1,
    ...(event.params || {}),
  };
  if (event.name === "purchase") params.transaction_id = event.event_id;
  if (event.name === "search" && event.params?.search_term == null)
    params.search_term = event.params?.q || "";
  if (event.items?.length) {
    params.items = event.items.map((it) => ({
      item_id: String(it.id),
      item_name: it.name,
      ...(it.price != null ? { price: it.price } : {}),
      ...(it.quantity != null ? { quantity: it.quantity } : {}),
    }));
  }
  if (debug) params.debug_mode = 1; // surfaces the event in GA4 DebugView
  return {
    client_id: clientId,
    ...(event.user_id ? { user_id: event.user_id } : {}),
    events: [{ name: event.name === "Purchase" ? "purchase" : event.name, params }],
  };
}

// validate=true hits the /debug endpoint (returns validationMessages, does NOT ingest);
// validate=false hits /mp/collect (ingests; 204 no body; shows in DebugView when debug_mode set).
export async function sendGa4({ payload, validate = false }) {
  if (!ga4Configured()) return { skipped: "ga4 not configured" };
  const path = validate ? "debug/mp/collect" : "mp/collect";
  const url = `https://www.google-analytics.com/${path}?measurement_id=${encodeURIComponent(
    GA4_MEASUREMENT_ID(),
  )}&api_secret=${encodeURIComponent(GA4_API_SECRET())}`;
  const res = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text || null; }
  return { status: res.status, ...(validate ? { validationMessages: body?.validationMessages ?? body } : {}) };
}

// ---- Meta Conversions API ----
// event_id is the dedup key shared with the browser pixel's fbq(...,{eventID}).
export function buildMetaPayload({ event, userData, eventSourceUrl, testCode }) {
  const ud = {};
  if (userData.emailHash) ud.em = [userData.emailHash];
  if (userData.phoneHash) ud.ph = [userData.phoneHash];
  // match-quality extras (all pre-hashed)
  if (userData.firstNameHash) ud.fn = [userData.firstNameHash];
  if (userData.lastNameHash) ud.ln = [userData.lastNameHash];
  if (userData.cityHash) ud.ct = [userData.cityHash];
  if (userData.stateHash) ud.st = [userData.stateHash];
  if (userData.zipHash) ud.zp = [userData.zipHash];
  if (userData.countryHash) ud.country = [userData.countryHash];
  if (userData.externalIdHash) ud.external_id = [userData.externalIdHash];
  if (userData.fbp) ud.fbp = userData.fbp;
  if (userData.fbc) ud.fbc = userData.fbc;
  if (userData.ip) ud.client_ip_address = userData.ip;
  if (userData.userAgent) ud.client_user_agent = userData.userAgent;
  const customData = {
    ...(event.currency ? { currency: event.currency } : {}),
    ...(event.value != null ? { value: event.value } : {}),
  };
  if (event.items?.length) {
    customData.content_type = "product";
    customData.content_ids = event.items.map((it) => String(it.id));
    customData.contents = event.items.map((it) => ({
      id: String(it.id),
      quantity: it.quantity ?? 1,
      ...(it.price != null ? { item_price: it.price } : {}),
    }));
  }
  const searchTerm = event.params?.search_term ?? event.params?.q;
  if (event.name === "search" && searchTerm != null) customData.search_string = searchTerm;

  const payload = {
    data: [
      {
        // canonical GA4 name in, Meta standard event out
        event_name: META_EVENT_NAMES[event.name] || event.name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: event.event_id,
        action_source: "website",
        ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
        user_data: ud,
        custom_data: customData,
      },
    ],
  };
  if (testCode) payload.test_event_code = testCode;
  return payload;
}

export async function sendMeta({ payload }) {
  if (!metaConfigured()) return { skipped: "meta not configured" };
  const url = `https://graph.facebook.com/${META_API_VERSION()}/${META_PIXEL_ID()}/events?access_token=${encodeURIComponent(
    META_CAPI_TOKEN(),
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, response: json };
}
