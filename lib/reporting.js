// Reconciled reporting rollups (Session 42 / BE21). SERVER-ONLY, tenant-scoped.
//
// Honesty rules, enforced here so every consumer inherits them:
//   · Sales numbers come from the ORDERS table (the money truth for direct
//     checkout) with refunds from the PROVIDER-MIRRORED projection (S31) —
//     labeled a local projection; Shopify stays authoritative.
//   · Day buckets use the MERCHANT's timezone (config.timezone), not UTC.
//   · Behavioural numbers (funnel, search, devices) come from CONSENTED
//     events only and say so — coverage is measured, never assumed.
//   · Unknown is unknown: a metric we can't compute returns null with a
//     reason, never a fake 0.
import { db } from "./db.js";
import { tenantCfg } from "./tenant-context.js";
import { isTimeZone } from "./admin/schedule.js";
import { byIds } from "./catalog/effective.js";
import { sql } from "kysely";
import { hasColumns } from "./schema-compat.js";

const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

// Money has moved (or will, for COD) — everything except never-paid and cancelled.
export const SALE_STATUSES = ["paid", "cod_pending", "syncing_shopify", "synced", "sync_failed"];

// A saved zone Intl doesn't know (a typo, "", an offset) falls back to
// Asia/Kolkata here, once, so no reader of it throws.
export const merchantTz = () => {
  const tz = tenantCfg("timezone", null, "Asia/Kolkata");
  return isTimeZone(tz) ? tz : "Asia/Kolkata";
};

// ISO instant → "YYYY-MM-DD" in the merchant's timezone.
export function dayInTz(iso, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

const sinceIso = (days) => new Date(Date.now() - days * 86400000).toISOString();

// ---- sales rollup ------------------------------------------------------------

// Phase 8 line 4: a market order counts in base money, COALESCE(base_total,
// total), so a USD order never adds dollars to rupees. Before 0039 every order
// is a base order and `total` is read as it always was.
export async function salesRollup({ days = 30 } = {}) {
  const tz = merchantTz();
  const since = sinceIso(days);
  const baseTotals = await hasColumns("orders", ["base_total"]);
  const [orders, refunds] = await Promise.all([
    db
      .selectFrom("orders")
      .select(["id", baseTotals ? sql`COALESCE(base_total, total)`.as("total") : "total", "currency", ...(baseTotals ? ["base_currency"] : []), "status", "created_at", "refunded_total"])
      .where("status", "in", SALE_STATUSES)
      .where("created_at", ">=", since)
      .execute(),
    db.selectFrom("order_refunds").select(["amount", "created_at"]).where("created_at", ">=", since).execute().catch(() => []),
  ]);

  const byDay = new Map();
  const bucket = (day) => {
    if (!byDay.has(day)) byDay.set(day, { day, orders: 0, gross: 0, refunds: 0, net: 0 });
    return byDay.get(day);
  };
  let gross = 0;
  for (const o of orders) {
    const b = bucket(dayInTz(o.created_at, tz));
    b.orders += 1;
    b.gross += Number(o.total || 0);
    gross += Number(o.total || 0);
  }
  let refunded = 0;
  for (const r of refunds) {
    bucket(dayInTz(r.created_at || new Date().toISOString(), tz)).refunds += Number(r.amount || 0);
    refunded += Number(r.amount || 0);
  }
  for (const b of byDay.values()) b.net = b.gross - b.refunds;

  const daysOut = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    tz,
    days,
    // Phase 8 line 4: the sums are base money, so the label is the store's base
    // currency (a market order's own currency would mislabel them)
    currency: tenantCfg("currency", null, null) || orders.find((o) => !o.base_currency)?.currency || orders.find((o) => o.base_currency)?.base_currency || "INR",
    orders: orders.length,
    gross,
    refunds: refunded,
    net: gross - refunded,
    aov: orders.length ? gross / orders.length : null,
    series: daysOut,
    source: "local orders projection (direct checkout) + provider-mirrored refunds — Shopify is authoritative",
  };
}

// ---- freshness + coverage ----------------------------------------------------

export async function freshness() {
  const [catalog, order, event, projection] = await Promise.all([
    db.selectFrom("products").select(({ fn }) => fn.max("synced_at").as("t")).executeTakeFirst().catch(() => null),
    db.selectFrom("orders").select(({ fn }) => fn.max("created_at").as("t")).executeTakeFirst().catch(() => null),
    db.selectFrom("events").select(({ fn }) => fn.max("created_at").as("t")).executeTakeFirst().catch(() => null),
    db.selectFrom("orders").select(({ fn }) => fn.max("provider_updated_at").as("t")).executeTakeFirst().catch(() => null),
  ]);
  return {
    catalog_synced_at: catalog?.t || null,
    last_order_at: order?.t || null,
    last_event_at: event?.t || null,
    projection_updated_at: projection?.t || null,
  };
}

// Coverage: how much of reality the numbers actually see.
export async function coverage({ days = 30 } = {}) {
  const since = sinceIso(days);
  const [sales, pushed, purchases] = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll().as("n")).where("status", "in", SALE_STATUSES).where("created_at", ">=", since).executeTakeFirst(),
    db
      .selectFrom("orders")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("status", "in", SALE_STATUSES)
      .where("created_at", ">=", since)
      .where("shopify_order_id", "is not", null)
      .executeTakeFirst(),
    db.selectFrom("events").select(({ fn }) => fn.countAll().as("n")).where("name", "=", "purchase").where("created_at", ">=", since).executeTakeFirst().catch(() => ({ n: 0 })),
  ]);
  const salesN = Number(sales?.n ?? 0);
  return {
    days,
    sales: salesN,
    pushed_to_shopify: Number(pushed?.n ?? 0),
    push_pct: salesN ? Math.round((Number(pushed?.n ?? 0) / salesN) * 100) : null,
    purchase_events: Number(purchases?.n ?? 0),
    // events exist only WITH consent — this ratio is the honest ceiling on
    // every behavioural metric below
    event_coverage_pct: salesN ? Math.min(100, Math.round((Number(purchases?.n ?? 0) / salesN) * 100)) : null,
  };
}

// ---- discrepancy queue -------------------------------------------------------

// Orders whose local state disagrees with itself or with the provider mirror —
// each row names WHY it's here and what fixes it.
export async function discrepancies({ limit = 20 } = {}) {
  const maxAttempts = Number(process.env.SHOPIFY_SYNC_MAX_ATTEMPTS || 5);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const out = [];

  const dead = await db
    .selectFrom("orders")
    .select(["id", "total", "currency", "sync_attempts", "sync_error", "created_at"])
    .where("status", "=", "sync_failed")
    .where("sync_attempts", ">=", maxAttempts)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  for (const o of dead) out.push({ kind: "push_dead", order: o.id, detail: `push dead-lettered after ${o.sync_attempts} attempts: ${(o.sync_error || "?").slice(0, 120)}`, action: "retry from Orders tab or trace the order" });

  const stuck = await db
    .selectFrom("orders")
    .select(["id", "updated_at"])
    .where("status", "=", "syncing_shopify")
    .where("updated_at", "<", hourAgo)
    .limit(limit)
    .execute();
  for (const o of stuck) out.push({ kind: "push_stuck", order: o.id, detail: `pushing for over an hour (since ${o.updated_at})`, action: "the sweep retries it; check /api/health if it persists" });

  const refundMismatch = await db
    .selectFrom("orders")
    .select(["id", "financial_status", "refunded_total", "total"])
    .where("financial_status", "in", ["refunded", "partially_refunded"])
    .where("refunded_total", "<=", 0)
    .limit(limit)
    .execute()
    .catch(() => []);
  for (const o of refundMismatch) out.push({ kind: "refund_mismatch", order: o.id, detail: `provider says ${o.financial_status} but no refund amount is mirrored locally`, action: "run the order reconcile (trace-order) — a refund webhook was likely missed" });

  return out.slice(0, limit);
}

// ---- behavioural analytics (consented events only) ---------------------------

export async function funnel({ days = 30 } = {}) {
  const since = sinceIso(days);
  const rows = await db
    .selectFrom("events")
    .select(["name"])
    .select(({ fn }) => fn.countAll().as("n"))
    .where("created_at", ">=", since)
    .groupBy("name")
    .execute()
    .catch(() => []);
  const counts = Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
  const ORDER = ["view_item_list", "view_item", "search", "add_to_cart", "begin_checkout", "add_payment_info", "purchase"];
  const views = counts.view_item || 0;
  return {
    days,
    steps: ORDER.map((name) => ({ name, count: counts[name] || 0, pct_of_views: views ? Math.round(((counts[name] || 0) / views) * 100) : null })),
    conversion_pct: views ? +(((counts.purchase || 0) / views) * 100).toFixed(2) : null,
    note: "consented sessions only — see coverage",
  };
}

// OVL-06: report lines group by PRODUCT ID, not by title, so a product renamed
// (in Shopify today, in Storeasy once titles can be edited) stays one row. A
// snapshot line with no product id groups by its title, as before.
export const productLineKey = (it) =>
  it?.productId ? `id:${it.productId}` : `title:${it?.title || it?.handle || it?.variantId || "unknown"}`;

// OVL-06: the title a report shows for each product id: the name shoppers see
// now. P4-SEARCH (OVL-03): the effective title (lib/catalog/effective.js
// byIds: the founder's published name over Shopify's, never a draft). Ids no
// longer in the catalog are absent, and callers keep the newest title their
// orders saw. Callers group by product id (productLineKey), so a rename keeps
// one row with the current name.
export async function currentProductTitles(ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  try {
    for (let i = 0; i < list.length; i += 200) {
      const rows = await byIds(list.slice(i, i + 200));
      for (const r of rows) out.set(r.id, r.title);
    }
  } catch {
    /* catalog unreadable → the titles orders saw */
  }
  return out;
}

export async function topProducts({ days = 30, limit = 10 } = {}) {
  const since = sinceIso(days);
  const orders = await db
    .selectFrom("orders")
    .select(["snapshot", "currency"])
    .where("status", "in", SALE_STATUSES)
    .where("created_at", ">=", since)
    .orderBy("created_at", "desc")
    .limit(500)
    .execute();
  const agg = new Map();
  for (const o of orders) {
    const snap = parse(o.snapshot, {}) || {};
    const items = snap.items || [];
    // Phase 8 line 4: a market order's revenue is its base run's line (base money)
    const baseLine = new Map((snap.base?.items || []).map((b) => [b.variantId, b]));
    for (const it of items) {
      const key = productLineKey(it);
      // newest order first, so the first title seen is the newest one
      const row = agg.get(key) || { product_id: it.productId || null, title: it.title || it.handle || it.variantId || "unknown", qty: 0, revenue: 0 };
      row.qty += Number(it.qty || it.quantity || 1);
      const b = baseLine.get(it.variantId);
      row.revenue += Number(b ? b.lineTotal : it.lineTotal ?? it.line_total ?? (it.price || 0) * (it.qty || it.quantity || 1));
      agg.set(key, row);
    }
  }
  const titles = await currentProductTitles([...agg.values()].map((r) => r.product_id));
  for (const row of agg.values()) if (titles.has(row.product_id)) row.title = titles.get(row.product_id);
  return {
    days,
    sampled_orders: orders.length,
    truncated: orders.length === 500,
    products: [...agg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit),
  };
}

export async function searchTerms({ days = 30, limit = 12 } = {}) {
  const since = sinceIso(days);
  const rows = await db
    .selectFrom("events")
    .select(["payload"])
    .where("name", "=", "search")
    .where("created_at", ">=", since)
    .orderBy("created_at", "desc")
    .limit(1000)
    .execute()
    .catch(() => []);
  const agg = new Map();
  for (const r of rows) {
    const p = parse(r.payload, {});
    const term = String(p?.params?.search_term || "").toLowerCase().trim();
    if (!term) continue;
    const row = agg.get(term) || { term, searches: 0, zero_results: 0 };
    row.searches += 1;
    if (Number(p?.params?.results ?? -1) === 0) row.zero_results += 1;
    agg.set(term, row);
  }
  return { days, terms: [...agg.values()].sort((a, b) => b.searches - a.searches).slice(0, limit) };
}

export async function campaignViews({ days = 30, limit = 12 } = {}) {
  const since = sinceIso(days);
  const rows = await db
    .selectFrom("events")
    .select(["payload"])
    .where("name", "=", "view_campaign")
    .where("created_at", ">=", since)
    .limit(2000)
    .execute()
    .catch(() => []);
  const agg = new Map();
  for (const r of rows) {
    const p = parse(r.payload, {})?.params || {};
    const key = `${p.campaign_slug || "?"}|${p.utm_source || "direct"}`;
    const row = agg.get(key) || { campaign: p.campaign_slug || "?", source: p.utm_source || "direct", views: 0 };
    row.views += 1;
    agg.set(key, row);
  }
  return { days, campaigns: [...agg.values()].sort((a, b) => b.views - a.views).slice(0, limit) };
}

export async function deviceSplit({ days = 30 } = {}) {
  const since = sinceIso(days);
  const rows = await db
    .selectFrom("events")
    .select(["user_agent"])
    .where("created_at", ">=", since)
    .limit(5000)
    .execute()
    .catch(() => []);
  let mobile = 0;
  let tablet = 0;
  let desktop = 0;
  let unknown = 0;
  for (const r of rows) {
    const ua = String(r.user_agent || "");
    if (!ua) unknown += 1;
    else if (/ipad|tablet/i.test(ua)) tablet += 1;
    else if (/mobi|android|iphone/i.test(ua)) mobile += 1;
    else desktop += 1;
  }
  const total = mobile + tablet + desktop + unknown;
  return {
    days,
    sampled_events: total,
    mobile,
    tablet,
    desktop,
    unknown,
    note: "coarse user-agent classes over consented events — not a visitor count",
  };
}
