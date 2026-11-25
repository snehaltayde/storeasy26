// Phase 8 line 2 (decision 13): the cash-on-delivery code. SERVER-ONLY.
//
// A challenge (cod_otps row) is bound to the cart id, the idempotency key, the
// phone (as sha256(e164|secret)) and the COD amount in minor units; the order it
// lets through is recorded on it. The code is 6 digits, stored only as
// sha256(code|challengeId|store link secret), compared in constant time, lives
// 5 minutes and allows 5 tries. Sends: one per 30 s per cart, 3 per cart per
// 30 minutes, 5 per phone per hour (the route adds 10 per IP per 15 minutes).
// A phone over its cap gets the same answer as any other phone, and no message,
// so the answer never says whether a number has been used before.
import { db } from "../db.js";
import { slog } from "../log.js";
import { storeLinkSecret } from "../orders.js";
import { toMinor } from "../money.js";
import { notify } from "../notifications.js";
import { siteName } from "../site.js";
import { sendSms, smsAvailable } from "../messaging/sms.js";
import { COD_OTP_MESSAGES as M } from "./payment-terms.js";

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 30_000;
export const CART_SENDS = { limit: 3, windowMs: 30 * 60_000 };
export const PHONE_SENDS = { limit: 5, windowMs: 60 * 60_000 };
// A verified code lets the order through for this long.
export const VERIFIED_TTL_MS = 15 * 60_000;

export class CodOtpError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const secret = () => {
  const s = storeLinkSecret();
  if (!s) throw new CodOtpError("COD_OTP_UNAVAILABLE", M.cantSend);
  return `${s}|cod-otp`;
};

// Constant time over the two hex digests (equal length by construction).
export function timingSafeEqual(a, b) {
  const A = String(a);
  const B = String(b);
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= (A.charCodeAt(i % (A.length || 1)) || 0) ^ (B.charCodeAt(i % (B.length || 1)) || 0);
  return diff === 0;
}

// Indian numbers by default: 10 digits → +91…; anything else keeps its digits.
export function e164(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}
export function maskPhone(number) {
  const n = e164(number);
  const cc = n.startsWith("+91") ? "+91" : n.slice(0, Math.max(2, n.length - 10));
  return `${cc} ••••••${n.slice(-4)}`;
}
export function maskEmail(email) {
  const [user = "", domain = ""] = String(email || "").split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}

export const phoneHash = async (phone) => sha256(`${e164(phone)}|${secret()}`);
const codeHash = (code, id) => sha256(`${String(code || "").trim()}|${id}|${secret()}`);
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

const sumSends = async (column, value, since) => {
  const r = await db.selectFrom("cod_otps").select((eb) => eb.fn.sum("sends").as("n")).where(column, "=", value).where("last_sent_at", ">=", since).executeTakeFirst();
  return Number(r?.n || 0);
};

// The channel used: the founder's, except SMS with no provider goes by email.
export const otpChannelFor = (wanted) => (wanted === "sms" && smsAvailable() ? "sms" : "email");

async function deliver(channel, { phone, email, code }) {
  const text = `${code} is your code to confirm your cash on delivery order at ${siteName()}. It expires in 5 minutes. Don't share it.`;
  if (channel === "sms") return sendSms({ to: e164(phone), text, type: "cod_otp" });
  return notify({ type: "cod_otp", to: email, subject: `Your ${siteName()} order code`, text });
}

// → { challengeId, channel, sentTo, resendIn, expiresIn }. Same shape whatever the phone.
export async function sendCodOtp({ cartId, key, phone, email, amount, currency = "INR", channel: wanted = "email", now = Date.now() }) {
  const channel = otpChannelFor(wanted);
  const at = new Date(now).toISOString();
  const pHash = await phoneHash(phone);
  const minor = toMinor(amount, currency);

  const last = await db.selectFrom("cod_otps").select(["last_sent_at"]).where("cart_id", "=", cartId).orderBy("last_sent_at", "desc").executeTakeFirst();
  if (last && now - Date.parse(last.last_sent_at) < RESEND_COOLDOWN_MS) {
    slog("cod_otp_failed", { reason: "cooldown" });
    throw new CodOtpError("COD_OTP_COOLDOWN", M.cooldown, { retryIn: Math.ceil((RESEND_COOLDOWN_MS - (now - Date.parse(last.last_sent_at))) / 1000) });
  }
  if ((await sumSends("cart_id", cartId, new Date(now - CART_SENDS.windowMs).toISOString())) >= CART_SENDS.limit) {
    slog("cod_otp_failed", { reason: "cart_cap" });
    throw new CodOtpError("COD_OTP_CART_CAP", M.cartCap);
  }
  const phoneCapped = (await sumSends("phone_hash", pHash, new Date(now - PHONE_SENDS.windowMs).toISOString())) >= PHONE_SENDS.limit;

  // A resend for the same binding reuses its challenge: a new code, fresh tries.
  const open = await db
    .selectFrom("cod_otps")
    .selectAll()
    .where("cart_id", "=", cartId)
    .where("idempotency_key", "=", key)
    .where("phone_hash", "=", pHash)
    .where("amount_minor", "=", minor)
    .where("currency", "=", currency)
    .where("verified_at", "is", null)
    .where("order_id", "is", null)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  const id = open?.id || `otp_${randomHex(12)}`;
  const code = newCode();
  const fields = { code_hash: await codeHash(code, id), expires_at: new Date(now + OTP_TTL_MS).toISOString(), attempts: 0, last_sent_at: at, channel };
  if (open) await db.updateTable("cod_otps").set((eb) => ({ ...fields, sends: eb("sends", "+", 1) })).where("id", "=", id).execute();
  else await db.insertInto("cod_otps").values({ id, cart_id: cartId, idempotency_key: key, phone_hash: pHash, amount_minor: minor, currency, sends: 1, verified_at: null, order_id: null, created_at: at, ...fields }).execute();

  if (phoneCapped) {
    // the same answer as a real send, and no message: the code is never known
    slog("cod_otp_failed", { reason: "phone_cap" });
  } else {
    try {
      await deliver(channel, { phone, email, code });
    } catch (e) {
      slog("cod_otp_failed", { reason: "send", error: String(e?.message || e).slice(0, 120) });
      throw new CodOtpError("COD_OTP_UNAVAILABLE", M.cantSend);
    }
    slog("cod_otp_sent", { channel });
  }
  return { challengeId: id, channel, sentTo: channel === "sms" ? maskPhone(phone) : maskEmail(email), resendIn: RESEND_COOLDOWN_MS / 1000, expiresIn: OTP_TTL_MS / 1000 };
}

// The row, when it belongs to this binding. Anything else is "stale": a new
// code is needed, and the answer says nothing about whose challenge it was.
async function boundRow({ challengeId, cartId, key, phone, amount, currency = "INR" }) {
  const row = challengeId ? await db.selectFrom("cod_otps").selectAll().where("id", "=", String(challengeId)).executeTakeFirst() : null;
  if (!row) return { row: null, why: "stale" };
  const same =
    row.cart_id === cartId &&
    row.idempotency_key === key &&
    timingSafeEqual(row.phone_hash, await phoneHash(phone)) &&
    Number(row.amount_minor) === toMinor(amount, currency) &&
    row.currency === currency;
  return same ? { row } : { row: null, why: "stale" };
}

export async function verifyCodOtp({ challengeId, code, cartId, key, phone, amount, currency = "INR", now = Date.now() }) {
  const { row } = await boundRow({ challengeId, cartId, key, phone, amount, currency });
  if (!row || row.order_id) {
    slog("cod_otp_failed", { reason: "stale" });
    throw new CodOtpError("COD_OTP_STALE", M.stale);
  }
  if (row.verified_at) return { verified: true };
  if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) {
    slog("cod_otp_failed", { reason: "locked" });
    throw new CodOtpError("COD_OTP_LOCKED", M.locked);
  }
  if (Date.parse(row.expires_at) <= now) {
    slog("cod_otp_failed", { reason: "expired" });
    throw new CodOtpError("COD_OTP_EXPIRED", M.expired);
  }
  // count the try first, atomically: two parallel guesses can't share one try
  const counted = await db.updateTable("cod_otps").set((eb) => ({ attempts: eb("attempts", "+", 1) })).where("id", "=", row.id).where("attempts", "<", OTP_MAX_ATTEMPTS).executeTakeFirst();
  if (!Number(counted?.numUpdatedRows || 0)) throw new CodOtpError("COD_OTP_LOCKED", M.locked);
  if (!/^\d{6}$/.test(String(code || "").trim()) || !timingSafeEqual(await codeHash(code, row.id), row.code_hash)) {
    slog("cod_otp_failed", { reason: "wrong" });
    throw new CodOtpError(Number(row.attempts) + 1 >= OTP_MAX_ATTEMPTS ? "COD_OTP_LOCKED" : "COD_OTP_WRONG", Number(row.attempts) + 1 >= OTP_MAX_ATTEMPTS ? M.locked : M.wrong);
  }
  await db.updateTable("cod_otps").set({ verified_at: new Date(now).toISOString() }).where("id", "=", row.id).where("verified_at", "is", null).execute();
  slog("cod_otp_verified", {});
  return { verified: true };
}

// The verified, unused challenge for this binding, or a CodOtpError.
export async function requireVerified({ challengeId, cartId, key, phone, amount, currency = "INR", now = Date.now() }) {
  const { row } = await boundRow({ challengeId, cartId, key, phone, amount, currency });
  if (!row || row.order_id || !row.verified_at || now - Date.parse(row.verified_at) > VERIFIED_TTL_MS) throw new CodOtpError("COD_OTP_REQUIRED", M.required);
  return row;
}

// The order this challenge let through. A challenge lets one order through.
export async function consumeChallenge(id, orderId) {
  await db.updateTable("cod_otps").set({ order_id: orderId }).where("id", "=", id).where("order_id", "is", null).execute();
}
