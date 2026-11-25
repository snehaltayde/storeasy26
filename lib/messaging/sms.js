// Phase 8 line 2 (decision 13): SMS for the cash-on-delivery code. SERVER-ONLY.
//
// No real provider is chosen yet (India needs DLT template registration; the
// owner picks MSG91, Gupshup or Twilio: plan risk 3). Until then the only
// provider is `stub`, which records the message as a `notifications` row (type
// cod_otp, status sent, provider sms-stub) so local runs and drills can read it.
// The stub never runs in production: there smsAvailable() is false, settings
// refuse the SMS channel and checkout sends the code by email.
import { db } from "../db.js";
import { slog } from "../log.js";

const prod = () => process.env.NODE_ENV === "production";
const ntfId = () => "ntf_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");

export const stub = {
  name: "stub",
  async send({ to, text, type = "sms" }) {
    if (prod()) throw new Error("The SMS stub never runs in production");
    const now = new Date().toISOString();
    const id = ntfId();
    await db
      .insertInto("notifications")
      .values({ id, type, recipient: to, subject: "SMS", body: text, status: "sent", error: null, provider_id: "sms-stub", consent_class: "transactional", consent_ref: null, idempotency_key: null, created_at: now, sent_at: now })
      .execute();
    return { id };
  },
};

const PROVIDERS = { stub };

// The provider this process may use, or null. SMS_PROVIDER names one; outside
// production the stub is the default; in production the stub is never chosen.
export function smsProvider() {
  const name = (process.env.SMS_PROVIDER || "").trim() || (prod() ? "" : "stub");
  if (!name || (name === "stub" && prod())) return null;
  return PROVIDERS[name] || null;
}

export const smsAvailable = () => Boolean(smsProvider());

export async function sendSms({ to, text, type }) {
  const provider = smsProvider();
  if (!provider) throw new Error("No SMS provider is set for this store");
  const r = await provider.send({ to, text, type });
  slog("sms_sent", { provider: provider.name, type });
  return r;
}
