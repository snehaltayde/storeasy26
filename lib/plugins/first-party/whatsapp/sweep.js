// Phase 9 line 3: WhatsApp's abandoned-cart sweep (lib/plugins/sweeps.js
// BUILT_IN), every 10 minutes per store with WhatsApp on. SERVER-ONLY.
//
// A cart gets one reminder, ever, when all of these hold:
//   - a live marketing consent bound to that cart
//   - the cart still has items and no order was placed from it
//   - both the cart and the consent have been idle for the delay (1 to 24 h,
//     the install's reminder_delay_hours, default 2) and the cart moved in the
//     last 7 days
//   - sendGated's own checks at send time: the consent is still live, the
//     template approved, outside quiet hours, within the caps
// The send's key is wa:cart_reminder:<cartId> (one row per cart, ever) and a
// whatsapp_reminders row marks the cart done. A cart held back by quiet hours
// or a cap is tried again in a later window.
// The link is /cart/r/<signed token>: the token carries the consent id only.
import { sql } from "kysely";
import { db } from "../../../db.js";
import { siteName } from "../../../site.js";
import { cartToken } from "../../../messaging/consent.js";
import { PHONE_DAY_MAX, PHONE_WEEK_MAX } from "../../../messaging/caps.js";
import { sendGated, storeUrl } from "../../../messaging/whatsapp.js";

// Candidates a window looks at. A cart that can't send now never takes a place:
// revoked consents aren't read, and a phone at its cap (1 a day, 2 a week) is
// left out in the query itself, so a run of capped carts can't starve the rest.
// Quiet hours and the store's cap hold every cart alike (the walk stops).
export const BATCH = 50;
const MKT_SINCE = (since) =>
  sql`(SELECT COUNT(*) FROM notifications n WHERE n.recipient = mc.phone_e164 AND n.type LIKE 'whatsapp_%' AND n.consent_class = 'marketing' AND n.status != 'failed' AND n.created_at > ${since})`;
const HOUR = 3_600_000;
const STALE_MS = 7 * 24 * HOUR;
export const delayHours = (settings) => {
  const h = Number(settings?.reminder_delay_hours);
  return Number.isInteger(h) && h >= 1 && h <= 24 ? h : 2;
};

export async function sweepCarts({ install, now = Date.now(), secrets, fetch, log }) {
  const idleBefore = new Date(now - delayHours(install?.settings) * HOUR).toISOString();
  const oldest = new Date(now - STALE_MS).toISOString();
  const due = await db
    .selectFrom("messaging_consents as mc")
    .innerJoin("carts as c", "c.id", "mc.cart_id")
    .select(["mc.id", "mc.cart_id", "mc.phone_e164"])
    .where("mc.channel", "=", "whatsapp")
    .where("mc.purpose", "=", "marketing")
    .where("mc.revoked_at", "is", null)
    .where("mc.granted_at", "<=", idleBefore)
    .where("c.updated_at", "<=", idleBefore)
    .where("c.updated_at", ">", oldest)
    .where(({ exists, not, selectFrom }) => not(exists(selectFrom("whatsapp_reminders as r").select(sql`1`.as("x")).whereRef("r.cart_id", "=", "mc.cart_id"))))
    .where(({ exists, not, selectFrom }) => not(exists(selectFrom("orders as o").select(sql`1`.as("x")).whereRef("o.cart_id", "=", "mc.cart_id"))))
    .where(({ exists, selectFrom }) => exists(selectFrom("cart_items as i").select(sql`1`.as("x")).whereRef("i.cart_id", "=", "mc.cart_id")))
    .where(sql`${MKT_SINCE(new Date(now - 24 * HOUR).toISOString())} < ${PHONE_DAY_MAX}`)
    .where(sql`${MKT_SINCE(new Date(now - 7 * 24 * HOUR).toISOString())} < ${PHONE_WEEK_MAX}`)
    .orderBy("c.updated_at")
    .limit(BATCH)
    .execute();
  let sent = 0;
  const skipped = {};
  for (const row of due) {
    const r = await sendGated({
      kind: "cart_reminder",
      purpose: "marketing",
      phone: row.phone_e164,
      cartId: row.cart_id,
      key: `wa:cart_reminder:${row.cart_id}`,
      vars: { store: siteName(), link: storeUrl(`/cart/r/${await cartToken(row.id, { now })}`) },
      install,
      secrets,
      fetch,
      now,
      log: log ? (evt, f) => log(evt, f) : undefined,
    });
    if (r.sent || r.skipped === "already_sent" || r.skipped === "provider_failed") {
      await db.insertInto("whatsapp_reminders").values({ cart_id: row.cart_id, consent_id: row.id, sent_at: new Date(now).toISOString() }).onConflict((oc) => oc.doNothing()).execute();
      if (r.sent) sent++;
    } else skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
    // quiet hours hold every cart in this window
    if (r.skipped === "quiet_hours" || r.skipped === "store_day" || r.skipped === "not_connected" || r.skipped === "template_unapproved") break;
  }
  return { due: due.length, sent, skipped };
}
