// Phase 9 line 3: WhatsApp messaging consent. SERVER-ONLY, tenant-scoped
// (withTenant), no node: imports (the stop page and the cart-restore route
// are storefront files).
//
// A consent row is one explicit opt-in: a purpose (updates | marketing), the
// phone it covers, the exact words shown (lib/messaging/wording.js) and where
// it was given (checkout | account), bound to the cart and/or the customer it
// came from. Nothing here sends; lib/messaging/whatsapp.js re-reads
// liveConsent() at send time, so any revocation stops pending sends.
//
//   grantConsent({ purpose, phone, country, cartId, customerId, source })
//       → the live row. One live row per binding and purpose: a new phone
//       revokes the old one (revoked_via "replaced").
//   revokeConsent({ purpose, cartId, customerId, via }) → rows revoked
//   revokePhone(phone, via)       every live consent for that phone (STOP)
//   liveConsent({ purpose, phone, cartId, customerId }) → row | null: live,
//       the same phone, and bound to that cart or that customer
//   stopToken(consentId) / verifyStopToken(t) → consent id | null
//   cartToken(consentId) / verifyCartToken(t) → consent id | null
//       Signed (HMAC-SHA256, the store's link secret), expiring; they carry
//       only the random consent id: no phone, no email, no cart id.
//   eraseConsents({ email, phones, cartIds }) privacy erase: deletes the person's rows
//   cartState / syncCart  the checkout boxes' stored state (cart cookie only)
import { sql } from "kysely";
import { db } from "../db.js";
import { storeLinkSecret } from "../orders.js";
import { e164 } from "../checkout/phone.js";
import { CONSENT_WORDING, PURPOSES } from "./wording.js";

export const CHANNEL = "whatsapp";
export const STOP_TTL_MS = 400 * 86_400_000;
export const CART_TTL_MS = 7 * 86_400_000;
export class ConsentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const newConsentId = () => "mc_" + hex(crypto.getRandomValues(new Uint8Array(12)));
const iso = (now) => new Date(now ?? Date.now()).toISOString();

function secret() {
  const s = storeLinkSecret();
  if (!s) throw new ConsentError(503, "NO_LINK_SECRET", "WhatsApp messages aren't available for this store right now.");
  return `${s}|whatsapp`;
}

async function hmacHex(message, key) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
}

// branch-free over the longer string; a length mismatch is folded in
export function timingSafeEqual(a, b) {
  const A = String(a ?? "");
  const B = String(b ?? "");
  if (!A.length || !B.length) return false;
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= A.charCodeAt(i % A.length) ^ B.charCodeAt(i % B.length);
  return diff === 0;
}

export const phoneHash = async (phone) => hmacHex(`phone|${phone}`, secret());

const bound = (eb, { cartId, customerId }) => {
  const ors = [];
  if (cartId) ors.push(eb("cart_id", "=", String(cartId)));
  if (customerId) ors.push(eb("customer_id", "=", String(customerId)));
  return ors.length ? eb.or(ors) : sql`1 = 0`;
};

const checkPurpose = (purpose) => {
  if (!PURPOSES.includes(purpose)) throw new ConsentError(400, "BAD_PURPOSE", "Choose which messages you want.");
};

export async function grantConsent({ purpose, phone, country = "IN", cartId = null, customerId = null, source, now } = {}) {
  checkPurpose(purpose);
  if (!cartId && !customerId) throw new ConsentError(400, "NO_BINDING", "Add something to your cart first.");
  const to = e164(phone, country);
  if (!to) throw new ConsentError(422, "BAD_PHONE", "Please enter a valid phone number.");
  const hash = await phoneHash(to);
  const at = iso(now);
  const live = await db
    .selectFrom("messaging_consents")
    .selectAll()
    .where("purpose", "=", purpose)
    .where("revoked_at", "is", null)
    .where((eb) => bound(eb, { cartId, customerId }))
    .execute();
  const same = live.find((r) => r.phone_hash === hash && (r.cart_id ?? null) === (cartId ?? null) && (r.customer_id ?? null) === (customerId ?? null));
  const stale = live.filter((r) => r !== same).map((r) => r.id);
  if (stale.length) await db.updateTable("messaging_consents").set({ revoked_at: at, revoked_via: "replaced" }).where("id", "in", stale).execute();
  if (same) return same;
  const words = CONSENT_WORDING[purpose];
  const row = { id: newConsentId(), channel: CHANNEL, purpose, phone_e164: to, phone_hash: hash, customer_id: customerId, cart_id: cartId, source: String(source), wording: words.text, wording_version: words.version, granted_at: at, revoked_at: null, revoked_via: null };
  await db.insertInto("messaging_consents").values(row).execute();
  return row;
}

export async function revokeConsent({ purpose, cartId = null, customerId = null, via, now } = {}) {
  checkPurpose(purpose);
  const r = await db
    .updateTable("messaging_consents")
    .set({ revoked_at: iso(now), revoked_via: String(via) })
    .where("purpose", "=", purpose)
    .where("revoked_at", "is", null)
    .where((eb) => bound(eb, { cartId, customerId }))
    .executeTakeFirst();
  return Number(r?.numUpdatedRows ?? 0);
}

export async function revokePhone(phone, via, { now } = {}) {
  const to = e164(phone, String(phone).startsWith("+") ? "XX" : "IN");
  if (!to) return 0;
  const r = await db.updateTable("messaging_consents").set({ revoked_at: iso(now), revoked_via: String(via) }).where("phone_hash", "=", await phoneHash(to)).where("revoked_at", "is", null).executeTakeFirst();
  return Number(r?.numUpdatedRows ?? 0);
}

export async function revokeById(consentId, via, { now } = {}) {
  const row = await db.selectFrom("messaging_consents").select(["phone_hash"]).where("id", "=", String(consentId)).executeTakeFirst();
  if (!row) return 0;
  const r = await db.updateTable("messaging_consents").set({ revoked_at: iso(now), revoked_via: String(via) }).where("phone_hash", "=", row.phone_hash).where("revoked_at", "is", null).executeTakeFirst();
  return Number(r?.numUpdatedRows ?? 0);
}

export async function liveConsent({ purpose, phone, cartId = null, customerId = null }) {
  if (!PURPOSES.includes(purpose) || !phone || (!cartId && !customerId)) return null;
  const hash = await phoneHash(phone);
  return (
    (await db
      .selectFrom("messaging_consents")
      .selectAll()
      .where("channel", "=", CHANNEL)
      .where("purpose", "=", purpose)
      .where("phone_hash", "=", hash)
      .where("revoked_at", "is", null)
      .where((eb) => bound(eb, { cartId, customerId }))
      .orderBy("granted_at", "desc")
      .executeTakeFirst()) ?? null
  );
}

export const consentById = async (id) => (await db.selectFrom("messaging_consents").selectAll().where("id", "=", String(id)).executeTakeFirst()) ?? null;

// the purposes a customer holds a live consent for, and the phone they cover
export async function customerConsents(customerId) {
  const rows = await db.selectFrom("messaging_consents").select(["purpose", "phone_e164"]).where("customer_id", "=", String(customerId)).where("revoked_at", "is", null).execute();
  return Object.fromEntries(PURPOSES.map((p) => [p, rows.find((r) => r.purpose === p)?.phone_e164 ?? null]));
}

// --- signed links -----------------------------------------------------------
async function sign(kind, consentId, ttl, now) {
  const exp = Math.floor((now + ttl) / 1000);
  return `${consentId}.${exp}.${(await hmacHex(`${kind}|${consentId}|${exp}`, secret())).slice(0, 32)}`;
}
async function verify(kind, token, now) {
  const m = /^(mc_[0-9a-f]{24})\.(\d{1,12})\.([0-9a-f]{32})$/.exec(String(token ?? ""));
  if (!m) return null;
  if (Number(m[2]) * 1000 <= now) return null;
  let key;
  try {
    key = secret();
  } catch {
    return null;
  }
  const want = (await hmacHex(`${kind}|${m[1]}|${m[2]}`, key)).slice(0, 32);
  return timingSafeEqual(want, m[3]) ? m[1] : null;
}
export const stopToken = (consentId, { now = Date.now() } = {}) => sign("stop", consentId, STOP_TTL_MS, now);
export const verifyStopToken = (t, { now = Date.now() } = {}) => verify("stop", t, now);
export const cartToken = (consentId, { now = Date.now() } = {}) => sign("cart", consentId, CART_TTL_MS, now);
export const verifyCartToken = (t, { now = Date.now() } = {}) => verify("cart", t, now);

// --- privacy erase ----------------------------------------------------------
// Every consent for this person is deleted, with its reminder rows: by each
// phone given (the request's, the matched orders', the account's), by each
// cart given (the matched orders' carts), and bound to the account of that
// email. Revoked first, in case a send is mid-flight.
export async function eraseConsents({ email = null, phones = [], cartIds = [] } = {}) {
  const ids = new Set();
  const e = email ? String(email).trim().toLowerCase() : null;
  const custs = e ? await db.selectFrom("customers").select(["id", "phone"]).where("email", "=", e).execute() : [];
  const numbers = [...new Set([...phones, ...custs.map((c) => c.phone)].map((p) => (p ? e164(p, String(p).startsWith("+") ? "XX" : "IN") : "")).filter(Boolean))];
  let hashes = [];
  try {
    hashes = await Promise.all(numbers.map((n) => phoneHash(n)));
  } catch {
    hashes = [];
  }
  const carts = [...new Set(cartIds.filter(Boolean).map(String))];
  const custIds = custs.map((c) => c.id);
  const rows = await db
    .selectFrom("messaging_consents")
    .select("id")
    .where((eb) => {
      const ors = [];
      if (numbers.length) ors.push(eb("phone_e164", "in", numbers));
      if (hashes.length) ors.push(eb("phone_hash", "in", hashes));
      if (carts.length) ors.push(eb("cart_id", "in", carts));
      if (custIds.length) ors.push(eb("customer_id", "in", custIds));
      return ors.length ? eb.or(ors) : sql`1 = 0`;
    })
    .execute();
  for (const r of rows) ids.add(r.id);
  if (!ids.size) return 0;
  const list = [...ids];
  await db.updateTable("messaging_consents").set({ revoked_at: iso(), revoked_via: "privacy_erase" }).where("id", "in", list).where("revoked_at", "is", null).execute();
  await db.deleteFrom("whatsapp_reminders").where((eb) => eb.or([eb("consent_id", "in", list), ...(carts.length ? [eb("cart_id", "in", carts)] : [])])).execute();
  await db.deleteFrom("messaging_consents").where("id", "in", list).execute();
  return list.length;
}

// --- the checkout boxes -------------------------------------------------------
// cartState(cartId) → { updates, marketing, phone } where phone is the live
// consents' number (the route masks it). syncCart(cartId, phone) withdraws any
// live consent on this cart for a different number (revoked_via
// "phone_changed") and answers what is live for this one.
export async function cartState(cartId) {
  const rows = cartId ? await db.selectFrom("messaging_consents").select(["purpose", "phone_e164"]).where("cart_id", "=", String(cartId)).where("revoked_at", "is", null).execute() : [];
  return { updates: rows.some((r) => r.purpose === "updates"), marketing: rows.some((r) => r.purpose === "marketing"), phone: rows[0]?.phone_e164 ?? null };
}
export async function syncCart(cartId, phone, country = "IN", { now } = {}) {
  const to = e164(phone, country);
  if (!cartId || !to) return cartState(cartId);
  await db.updateTable("messaging_consents").set({ revoked_at: iso(now), revoked_via: "phone_changed" }).where("cart_id", "=", String(cartId)).where("revoked_at", "is", null).where("phone_hash", "!=", await phoneHash(to)).execute();
  return cartState(cartId);
}
