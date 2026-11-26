// Phase 9 line 3: how often a store may send WhatsApp marketing (offers and
// cart reminders). SERVER-ONLY, tenant-scoped. Order updates are not capped
// and not held by quiet hours: the shopper asked for them, one per status.
//
//   QUIET          21:00 to 09:00 in the store's time zone: no marketing
//   inQuietHours(now, timeZone) → boolean (pure)
//   marketingRoom({ phone, now, dailyCap }) → null when a message may go, or
//       the reason it may not: "phone_day" (1 per phone per 24 h),
//       "phone_week" (2 per phone per 7 days), "store_day" (the store's cap
//       per 24 h, default 200). Counts every WhatsApp marketing row that was
//       not refused (queued or sent), so a send in flight counts.
import { sql } from "kysely";
import { db } from "../db.js";
import { tenantCfg } from "../tenant-context.js";

export const QUIET = Object.freeze({ from: 21, to: 9 });
export const PHONE_DAY_MAX = 1;
export const PHONE_WEEK_MAX = 2;
export const STORE_DAY_DEFAULT = 200;
const DAY = 86_400_000;

export const storeTimeZone = () => tenantCfg("merchant_timezone", null, "Asia/Kolkata") || "Asia/Kolkata";

export function inQuietHours(now, timeZone = "Asia/Kolkata") {
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
  } catch {
    hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
  }
  return hour >= QUIET.from || hour < QUIET.to;
}

const marketingSince = (sinceIso) =>
  db
    .selectFrom("notifications")
    .select(sql`count(*)`.as("n"))
    .where("type", "like", "whatsapp_%")
    .where("consent_class", "=", "marketing")
    .where("status", "!=", "failed")
    .where("created_at", ">", sinceIso);

export async function marketingRoom({ phone, now = Date.now(), dailyCap = STORE_DAY_DEFAULT }) {
  const day = new Date(now - DAY).toISOString();
  const week = new Date(now - 7 * DAY).toISOString();
  const count = async (q) => Number((await q.executeTakeFirst())?.n ?? 0);
  if ((await count(marketingSince(day).where("recipient", "=", phone))) >= PHONE_DAY_MAX) return "phone_day";
  if ((await count(marketingSince(week).where("recipient", "=", phone))) >= PHONE_WEEK_MAX) return "phone_week";
  const cap = Number.isInteger(dailyCap) && dailyCap > 0 ? dailyCap : STORE_DAY_DEFAULT;
  if ((await count(marketingSince(day))) >= cap) return "store_day";
  return null;
}
