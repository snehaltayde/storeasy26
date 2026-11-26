// Phase 9 line 1: Reviews' scheduled work (lib/plugins/sweeps.js runs it every
// 10 minutes inside withTenant). When the founder has invite emails on, each
// order whose invites are due (send_after passed, not sent, not used, not
// expired) gets one email (notify, transactional, idempotencyKey
// review_invite:<order>) listing a link per product and a signed "Don't ask me
// for reviews" link. An address on the opt-out list, or an order with no email
// (redacted), gets nothing; its invites are marked handled (sent_at) so the
// sweep doesn't read them again, and the order page's links still work.
// Invites due more than CATCH_UP_DAYS ago are never emailed: turning emails on
// doesn't mail every past buyer at once (bulk invites are a later line).
import { db } from "../../../db.js";
import { notify } from "../../../notifications.js";
import { abs, siteName } from "../../../site.js";
import { emailHash, optOutToken, reviewWritePath } from "../../../reviews/tokens.js";
import { displayNameFrom, isOptedOut } from "../../../reviews/store.js";
import { byIds } from "../../../catalog/effective.js";

const DAY = 24 * 60 * 60 * 1000;
export const CATCH_UP_DAYS = 3;
export const SWEEP_ORDERS_MAX = 50;

export function inviteEmail({ name, store, links, optOutUrl }) {
  const first = String(name || "").split(" ")[0];
  return {
    subject: `How was your order from ${store}?`,
    text: [
      `Hi${first ? ` ${first}` : ""},`,
      "",
      `Thanks for shopping with ${store}. If you have a minute, tell other shoppers what you thought:`,
      "",
      ...links.map((l) => `${l.label}: ${l.url}`),
      "",
      "Each link works once and stays open for 60 days. The store reads every review before it shows, and your email is never shown.",
      "",
      `Don't ask me for reviews: ${optOutUrl}`,
    ].join("\n"),
  };
}

export async function sweepReviews({ install, now, log }) {
  if (install?.settings?.invite_emails !== true) return { orders: 0 };
  const nowIso = new Date(now).toISOString();
  // the due orders first (at most SWEEP_ORDERS_MAX), then every due invite of
  // those orders, so an order is never split across two sweeps
  const due = (q) =>
    q
      .where("sent_at", "is", null)
      .where("used_at", "is", null)
      .where("send_after", "<=", nowIso)
      .where("send_after", ">", new Date(now - CATCH_UP_DAYS * DAY).toISOString())
      .where("expires_at", ">", nowIso);
  const orders = (await due(db.selectFrom("review_invites").select("order_id")).groupBy("order_id").orderBy((eb) => eb.fn.min("send_after")).orderBy("order_id").limit(SWEEP_ORDERS_MAX).execute()).map((r) => r.order_id);
  if (!orders.length) return { orders: 0, skipped: 0 };
  const rows = await due(db.selectFrom("review_invites").select(["id", "order_id", "product_id", "expires_at"])).where("order_id", "in", orders).orderBy("send_after").orderBy("id").execute();
  // titles as shoppers see them (the founder's published title)
  const titles = new Map((await byIds([...new Set(rows.map((r) => r.product_id))])).map((p) => [String(p.id), String(p.title)]));
  const byOrder = new Map(orders.map((o) => [o, []]));
  for (const r of rows) byOrder.get(r.order_id)?.push(r);
  let sent = 0;
  let skipped = 0;
  for (const [orderId, invites] of byOrder) {
    if (!invites.length) continue;
    const order = await db.selectFrom("orders").select(["email", "name"]).where("id", "=", orderId).executeTakeFirst();
    const hash = await emailHash(order?.email);
    const optOut = hash ? await optOutToken(hash) : null;
    const links = [];
    for (const inv of invites) {
      const path = titles.has(String(inv.product_id)) ? await reviewWritePath(inv) : null;
      if (path) links.push({ label: `Review ${titles.get(String(inv.product_id))}`, url: abs(path) });
    }
    if (!hash || !optOut || !links.length || (await isOptedOut(hash))) {
      skipped++;
      log("invite_skipped", { reason: !hash ? "no_email" : !optOut || !links.length ? "no_link_secret" : "opted_out" });
    } else {
      const mail = inviteEmail({ name: displayNameFrom(order.name), store: siteName(), links, optOutUrl: abs(`/reviews/optout?t=${optOut}`) });
      await notify({ type: "review_invite", to: order.email, subject: mail.subject, text: mail.text, idempotencyKey: `review_invite:${orderId}`, consentClass: "transactional" });
      sent++;
    }
    // handled either way: never read again by the sweep
    await db.updateTable("review_invites").set({ sent_at: nowIso }).where("id", "in", invites.map((i) => i.id)).where("sent_at", "is", null).execute();
  }
  if (sent || skipped) log("invites_sent", { sent, skipped });
  return { orders: sent, skipped };
}
