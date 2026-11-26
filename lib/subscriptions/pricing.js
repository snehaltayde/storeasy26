// Phase 9 line 2: what a subscribed line costs, and when a line counts as
// subscribed. Edge-safe (the cart route and the storefront read it): no node:
// modules. The SUBSCRIPTION offer the engine applies is built here, on the
// server, from the plugin's settings and the line's stored interval; nothing a
// request carries (a discount, a percent, a subscription id) is ever read.
//
// A line counts as subscribed only when the plugin is installed, enabled and
// not turned off by Storeasy, the interval is one the store offers, the product
// is eligible and the cart is priced in the base market. Otherwise the line is
// priced one-time. A renewal cart's line keeps the percent its subscription was
// signed up at (decision 8: discount locked at signup, price follows the product).
import { db } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { flagEnabled } from "../platform/flags.js";
import { killFlag } from "../plugins/catalog.js";

export const SUBSCRIPTIONS_PLUGIN = "subscriptions";
export const INTERVALS = Object.freeze([14, 30, 45, 60, 90]);
export const PERCENT_MAX = 30;
export const QUANTITY_MAX = 10;
export const SUBSCRIPTION_OFFER_ID = "subscription";
const DAY_MS = 24 * 60 * 60 * 1000;

const whole = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// The install's plain settings → the numbers the rest of the line uses.
export function normalizeSettings(raw = {}) {
  const s = raw && typeof raw === "object" ? raw : {};
  const tag = typeof s.eligible_tag === "string" ? s.eligible_tag.trim().toLowerCase() : "";
  return {
    percent: whole(s.discount_percent, 0, PERCENT_MAX, 0),
    intervals: INTERVALS.filter((d) => s[`every_${d}`] === true),
    eligible: s.eligible === "tag" ? { kind: "tag", tag } : { kind: "all" },
    reminderDays: whole(s.reminder_days, 1, 7, 3),
    graceDays: whole(s.grace_days, 1, 14, 7),
  };
}

// The live install's settings, or null when subscriptions are off for this
// store (not installed, turned off, or turned off by Storeasy; a store whose
// database has no plugin table yet has none).
export async function subscriptionSettings() {
  let row;
  try {
    row = await db
      .selectFrom("plugin_installs")
      .select(["id", "settings"])
      .where("plugin_id", "=", SUBSCRIPTIONS_PLUGIN)
      .where("status", "=", "enabled")
      .executeTakeFirst();
  } catch {
    return null;
  }
  if (!row) return null;
  if (!(await flagEnabled(killFlag(SUBSCRIPTIONS_PLUGIN), tenantId(), { fallback: true }))) return null;
  let raw = {};
  try {
    raw = row.settings ? JSON.parse(row.settings) : {};
  } catch {
    raw = {};
  }
  const settings = normalizeSettings(raw);
  return settings.intervals.length ? { ...settings, installId: String(row.id) } : null;
}

// Is a product (its raw Shopify tags) one the store lets shoppers subscribe to?
export function eligibleFor(settings, tags) {
  if (!settings) return false;
  if (settings.eligible.kind === "all") return true;
  if (!settings.eligible.tag) return false;
  return (Array.isArray(tags) ? tags : []).some((t) => String(t).trim().toLowerCase() === settings.eligible.tag);
}

// One unit's discount, rounded to whole units the way the engine rounds a line
// discount (Math.round); a line's discount is this times its quantity, so the
// product page's "₹X each" times the quantity is exactly the cart line.
export const unitDiscount = (price, percent) => Math.round(((Number(price) || 0) * (Number(percent) || 0)) / 100);
export const subscribedUnitPrice = (price, percent) => (Number(price) || 0) - unitDiscount(price, percent);

// The engine's SUBSCRIPTION offer: { variantId: percent } for every line that
// is subscribed. Priority below every stored offer, so it claims first.
export function subscriptionOffer(lines) {
  const entries = Object.entries(lines || {});
  if (!entries.length) return null;
  return {
    id: SUBSCRIPTION_OFFER_ID,
    type: "SUBSCRIPTION",
    scope: "line",
    priority: Number.MIN_SAFE_INTEGER,
    title: "Subscribe and save",
    lines: Object.fromEntries(entries),
  };
}

// Which of a cart's lines are subscribed, at what percent.
//   items     engine lines ({ variantId, tags })
//   intervals Map variantId → stored subscription_interval
//   renewal   { subscription } for a live renewal cart, else null
//   settings  subscriptionSettings() (null: off)
//   market    the presentment market (null: base)
// → { lines: { variantId: percent }, perItem: Map variantId → { interval, percent, active, renewal },
//     wanted: n lines that would be subscribed in the base market }
export function resolveSubscriptions({ items, intervals, renewal = null, settings, market = null }) {
  const lines = {};
  const perItem = new Map();
  let wanted = 0;
  for (const i of items) {
    const interval = intervals?.get(i.variantId) ?? null;
    if (interval == null) continue;
    const sub = renewal?.subscription;
    const isRenewal = Boolean(sub && sub.variant_id === i.variantId);
    // a sign-up subscribes at most QUANTITY_MAX per delivery (the account's own limit)
    const overLimit = !isRenewal && Number(i.quantity) > QUANTITY_MAX;
    const ok = Boolean(settings) && !overLimit && (isRenewal || (settings.intervals.includes(Number(interval)) && eligibleFor(settings, i.tags)));
    const percent = isRenewal ? Number(sub.discount_percent) || 0 : settings?.percent ?? 0;
    if (ok) wanted++;
    const active = ok && !market;
    if (active) lines[i.variantId] = percent;
    perItem.set(i.variantId, {
      interval: isRenewal ? Number(sub.interval_days) : Number(interval),
      percent: active ? percent : 0,
      active,
      ...(isRenewal ? { renewal: true } : {}),
      ...(overLimit && settings ? { limit: QUANTITY_MAX } : {}),
    });
  }
  return { lines, perItem, wanted };
}

export const addDays = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();
export const DAY = DAY_MS;

// The product page's choice (components/pdp/SubscribeChoice.js): null when
// this product can't be subscribed to here (subscriptions off, not eligible,
// outside the base market); else the percent, the intervals and each variant's
// subscribed unit price, computed here so the page shows the cart's number.
export async function productSubscribeOffer(productId, { market = null } = {}) {
  if (market || typeof productId !== "string" || !productId) return null;
  const settings = await subscriptionSettings();
  if (!settings) return null;
  const p = await db.selectFrom("products").select(["id", "tags"]).where("id", "=", productId).executeTakeFirst();
  if (!p) return null;
  let tags = [];
  try {
    tags = JSON.parse(p.tags ?? "[]");
  } catch {
    tags = [];
  }
  if (!eligibleFor(settings, tags)) return null;
  const variants = await db.selectFrom("variants").select(["id", "price"]).where("product_id", "=", p.id).execute();
  return {
    percent: settings.percent,
    intervals: settings.intervals,
    prices: Object.fromEntries(variants.map((v) => [v.id, subscribedUnitPrice(v.price, settings.percent)])),
  };
}
