// Phase 9 line 1: the signed review links. Edge-safe (Web Crypto only).
//
// An invite link carries `<rvi_id>.<exp>.<sig>`, where exp is the invite's
// expires_at in epoch seconds and sig is base64url(HMAC-SHA256(
//   "review-invite|" + id + "|" + order + "|" + product + "|" + exp,
//   storeLinkSecret())). Nothing is stored but the invite row: the link is
// recomputed from it (the order page's "Review" links, the email), so no
// token is ever kept in plain text. Checked in constant time against the
// row's own order and product, so a token can't be moved to another order,
// product or store. A store with no link secret (production without one)
// mints nothing and accepts nothing.
//
// An opt-out link carries `<email_hash>.<sig>` with sig over
// "review-optout|" + email_hash; it never expires and holds no email.
import { storeLinkSecret } from "../orders.js";

const enc = new TextEncoder();
const b64url = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hexOf = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export function timingEq(a, b) {
  const A = String(a ?? "");
  const B = String(b ?? "");
  if (!A.length || !B.length) return false;
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= A.charCodeAt(i % A.length) ^ B.charCodeAt(i % B.length);
  return diff === 0;
}

export const INVITE_TTL_DAYS = 60;
const INVITE_ID = /^rvi_[0-9a-f]{16}$/;
const expSecs = (iso) => Math.floor(Date.parse(iso) / 1000);
const inviteMessage = (inv, exp) => `review-invite|${inv.id}|${inv.order_id}|${inv.product_id}|${exp}`;

// The invite id a token names, or null when it can't be one (no secret needed).
export function tokenInviteId(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || !INVITE_ID.test(parts[0]) || !/^\d{1,12}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  return parts[0];
}

// → the token for an invite row ({ id, order_id, product_id, expires_at }), or
// null when this store has no link secret.
export async function inviteToken(invite) {
  const secret = storeLinkSecret();
  if (!secret) return null;
  const exp = expSecs(invite.expires_at);
  return `${invite.id}.${exp}.${await hmac(inviteMessage(invite, exp), secret)}`;
}

// true when the token is this invite's own, unexpired at `now` (ms).
export async function verifyInviteToken(invite, token, now = Date.now()) {
  const secret = storeLinkSecret();
  if (!secret || !invite) return false;
  const [id, expStr, sig] = String(token ?? "").split(".");
  if (id !== invite.id) return false;
  const exp = Number(expStr);
  // the exp in the link must be the row's own, and still ahead
  if (!Number.isInteger(exp) || exp !== expSecs(invite.expires_at) || exp * 1000 <= now) return false;
  return timingEq(await hmac(inviteMessage(invite, exp), secret), sig);
}

export const reviewWritePath = async (invite) => {
  const t = await inviteToken(invite);
  return t ? `/reviews/write?t=${t}` : null;
};

// The opt-out list holds a hash, never the email.
export async function emailHash(email) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return null;
  return hexOf(await crypto.subtle.digest("SHA-256", enc.encode(`review-optout-email|${e}`)));
}

export async function optOutToken(hash) {
  const secret = storeLinkSecret();
  if (!secret || !/^[0-9a-f]{64}$/.test(String(hash ?? ""))) return null;
  return `${hash}.${await hmac(`review-optout|${hash}`, secret)}`;
}

// → the email hash an opt-out token carries, or null.
export async function verifyOptOutToken(token) {
  const secret = storeLinkSecret();
  const [hash, sig] = String(token ?? "").split(".");
  if (!secret || !/^[0-9a-f]{64}$/.test(hash || "")) return null;
  return timingEq(await hmac(`review-optout|${hash}`, secret), sig) ? hash : null;
}
