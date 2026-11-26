// Phase 9 line 2: the subscriptions sweep (lib/plugins/sweeps.js runs it every
// 10-minute window, inside the store's withTenant, while the plugin is enabled
// and not turned off by Storeasy). Node only. Every step is a conditional
// write naming the state it moves from, so a window run twice changes nothing
// twice, and each email has its own idempotency key.
//   1. a pause with an end date that has passed → active again
//   2. a delivery within the reminder window → its cycle is marked due and the
//      subscriber gets one reminder (the amount from renewalFigure, the same
//      number the account and the checkout show; a link to /account, never a
//      payment link)
//   3. a due delivery not paid for within the grace days → missed, the next one
//      scheduled; a second miss in a row pauses the subscription, with an email
import { db } from "../../../db.js";
import { notify } from "../../../notifications.js";
import { formatMoney } from "../../../format.js";
import { currentTenant } from "../../../tenant-context.js";
import { storeOrigin } from "../../../platform/onboarding-ops.js";
import { normalizeSettings, addDays, DAY } from "../../../subscriptions/pricing.js";
import { subscriptionsReady, customerEmail } from "../../../subscriptions/store.js";
import { renewalFigure } from "../../../subscriptions/renewal.js";

const BATCH = 200;
const dateWords = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function names(sub) {
  const r = await db
    .selectFrom("variants as v")
    .innerJoin("products as p", "p.id", "v.product_id")
    .select(["p.title as product", "v.title as variant"])
    .where("v.id", "=", sub.variant_id)
    .executeTakeFirst();
  const variant = r?.variant && r.variant !== "Default Title" ? ` (${r.variant})` : "";
  return `${r?.product || "your product"}${variant}`;
}

const accountLink = () => {
  const origin = storeOrigin(currentTenant());
  return origin ? `${origin}/account` : "your account on our store";
};

async function remind(sub, { log }) {
  const to = await customerEmail(sub.customer_id);
  if (!to) return false;
  const figure = await renewalFigure(sub);
  const what = `${await names(sub)} × ${sub.quantity}`;
  await notify({
    type: "subscription_reminder",
    to,
    subject: `Your next delivery is due on ${dateWords(sub.next_due_at)}`,
    text: [
      `Your next subscription delivery, ${what}, is due on ${dateWords(sub.next_due_at)}.`,
      `Today it comes to ${formatMoney(figure.amount, figure.currency)} (price today; confirmed at checkout).`,
      "Nothing is charged automatically. To get this delivery, pay for it from your account:",
      accountLink(),
      "You can also skip it, pause, or cancel there.",
    ].join("\n\n"),
    idempotencyKey: `subrem:${sub.id}:${sub.cycle}`,
  });
  log("reminded", { cycle: Number(sub.cycle) });
  return true;
}

async function pausedEmail(sub) {
  const to = await customerEmail(sub.customer_id);
  if (!to) return;
  await notify({
    type: "subscription_paused",
    to,
    subject: "Your subscription is paused",
    text: [
      `Your subscription to ${await names(sub)} is paused because the last two deliveries weren't paid for.`,
      "Nothing was charged. Resume it from your account whenever you like:",
      accountLink(),
    ].join("\n\n"),
    idempotencyKey: `subpause:${sub.id}:${sub.cycle}`,
  });
}

export default async function subscriptionsSweep({ install, now, log = () => {} }) {
  if (!(await subscriptionsReady())) return { resumed: 0, reminded: 0, missed: 0 };
  const settings = normalizeSettings(install?.settings);
  const nowIso = new Date(now).toISOString();
  const out = { resumed: 0, reminded: 0, missed: 0 };

  // 1. pauses that have run out
  const resumed = await db
    .updateTable("subscriptions")
    .set((eb) => ({ status: "active", paused_until: null, missed_in_row: 0, next_due_at: eb.fn("max", ["next_due_at", eb.val(nowIso)]), updated_at: nowIso }))
    .where("status", "=", "paused")
    .where("paused_until", "is not", null)
    .where("paused_until", "<=", nowIso)
    .executeTakeFirst();
  out.resumed = Number(resumed?.numUpdatedRows ?? 0);

  // 2. due within the reminder window: mark the cycle due, remind once
  const dueBy = new Date(now + settings.reminderDays * DAY).toISOString();
  const due = await db.selectFrom("subscriptions").selectAll().where("status", "=", "active").where("next_due_at", "<=", dueBy).orderBy("next_due_at", "asc").limit(BATCH).execute();
  for (const sub of due) {
    await db
      .insertInto("subscription_cycles")
      .values({ subscription_id: sub.id, cycle: Number(sub.cycle), due_at: sub.next_due_at, status: "due", order_id: null, reminded_at: null, updated_at: nowIso })
      .onConflict((oc) => oc.columns(["subscription_id", "cycle"]).doNothing())
      .execute();
    const claim = await db
      .updateTable("subscription_cycles")
      .set({ reminded_at: nowIso, updated_at: nowIso })
      .where("subscription_id", "=", sub.id)
      .where("cycle", "=", Number(sub.cycle))
      .where("status", "=", "due")
      .where("reminded_at", "is", null)
      .executeTakeFirst();
    if (Number(claim?.numUpdatedRows ?? 0) && (await remind(sub, { log }))) out.reminded++;
  }

  // 3. past the grace days and not paid for: missed, the next one scheduled
  const lateBefore = new Date(now - settings.graceDays * DAY).toISOString();
  const late = await db.selectFrom("subscriptions").selectAll().where("status", "=", "active").where("next_due_at", "<=", lateBefore).orderBy("next_due_at", "asc").limit(BATCH).execute();
  for (const sub of late) {
    const cycle = Number(sub.cycle);
    const missedInRow = Number(sub.missed_in_row) + 1;
    const pauseIt = missedInRow >= 2;
    const res = await db
      .updateTable("subscriptions")
      .set({
        cycle: cycle + 1,
        next_due_at: addDays(sub.next_due_at, Number(sub.interval_days)),
        missed_in_row: missedInRow,
        ...(pauseIt ? { status: "paused", paused_until: null } : {}),
        updated_at: nowIso,
      })
      .where("id", "=", sub.id)
      .where("cycle", "=", cycle)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!Number(res?.numUpdatedRows ?? 0)) continue;
    await db
      .insertInto("subscription_cycles")
      .values({ subscription_id: sub.id, cycle, due_at: sub.next_due_at, status: "missed", order_id: null, reminded_at: null, updated_at: nowIso })
      .onConflict((oc) => oc.columns(["subscription_id", "cycle"]).doUpdateSet({ status: "missed", updated_at: nowIso }).where("subscription_cycles.order_id", "is", null))
      .execute();
    out.missed++;
    if (pauseIt) await pausedEmail({ ...sub, cycle });
    log("missed", { cycle, paused: pauseIt });
  }
  return out;
}
