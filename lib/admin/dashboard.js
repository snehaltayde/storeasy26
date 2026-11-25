// The dashboard's read-model (Phase 2 line 1, docs/plans/phase-2.md "Line 1").
// SERVER-ONLY, tenant-scoped: every read runs inside withTenant (the page's
// tfetch), against this store's own database. Numbers come from
// lib/reporting.js; this file adds the action queue, the store status and the
// pure shaping of the sales numbers (tested with a fixed clock).
//
//   salesView(rollup, { days, nowMs })   today, 7 days, the range, average order
//                                        and the dense daily series (quiet days 0)
//   actionQueue({ role, nowMs })          [{ id, count, words, href?, orders?, hint? }]
//                                        (count is the real COUNT; orders the first ORDERS_SHOWN ids)
//   storeStatus({ role })                 { status, maintenance, open, address, … }
//
// Each part is read and caught on its own: a part that can't be read comes back
// as { id, unknown: true, words: "Couldn't check …" }, never as a guess (a 0
// that might be wrong). Rows carry counts and order ids only: no customer
// name, email or phone, no contact-message address, and the Shopify domain
// only for a role with settings.read (support sees none).
import { db, libsql } from "../db.js";
import { currentTenant } from "../tenant-context.js";
import { roleAllows } from "../platform/authz.js";
import { dayInTz } from "../reporting.js";
import { connectFacts } from "../onboarding/connect.js";
import { onboardingProgress } from "../onboarding/service.js";
import { SYSTEM_PAUSE_REASONS } from "../plugins/topics.js";

export { RANGES } from "./dashboard-ranges.js";
const DAY_MS = 86_400_000;
export const STUCK_MS = 60 * 60_000; // a push "stuck" after an hour (reporting.discrepancies)
export const COD_WAIT_MS = 15 * 60_000;
export const ORDERS_SHOWN = 5; // order ids a queue row links; the rest are "and n more"
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- sales -------------------------------------------------------------------

// rollup: salesRollup({ days }). Day keys are the store's timezone (rollup.tz).
export function salesView(rollup, { days, nowMs = Date.now() } = {}) {
  const tz = rollup.tz;
  const keyAt = (msAgo) => dayInTz(new Date(nowMs - msAgo).toISOString(), tz);
  const byDay = new Map(rollup.series.map((d) => [d.day, d]));
  const series = Array.from({ length: days }, (_, i) => {
    const day = keyAt((days - 1 - i) * DAY_MS);
    const d = byDay.get(day);
    return { day, net: d?.net || 0, orders: d?.orders || 0 };
  });
  const todayRow = byDay.get(keyAt(0));
  const week = new Set(Array.from({ length: 7 }, (_, i) => keyAt(i * DAY_MS)));
  const w7 = rollup.series.filter((d) => week.has(d.day)).reduce((a, d) => ({ net: a.net + d.net, orders: a.orders + d.orders }), { net: 0, orders: 0 });
  return {
    tz,
    currency: rollup.currency,
    today: { net: todayRow?.net || 0, orders: todayRow?.orders || 0 },
    week: w7,
    range: { days, net: rollup.net, orders: rollup.orders, refunds: rollup.refunds },
    aov: rollup.aov == null ? null : Math.round(rollup.aov),
    series,
  };
}

// ---- orders to act on -----------------------------------------------------------

const count = async (q) => Number((await q.select(({ fn }) => fn.countAll().as("n")).executeTakeFirst())?.n ?? 0);
const unknown = (id, what) => ({ id, unknown: true, words: `Couldn't check ${what}. Reload to try again.` });

// Each part: () => row | null (null: nothing to act on).
function queueParts({ role, nowMs }) {
  const before = (ms) => new Date(nowMs - ms).toISOString();
  // a real count, and the first few ids to link (the row shows ORDERS_SHOWN)
  const countAndIds = async (q) => {
    const [n, rows] = await Promise.all([count(q), q.select("id").orderBy("created_at", "desc").limit(ORDERS_SHOWN).execute()]);
    return { n, ids: rows.map((r) => r.id) };
  };
  return [
    {
      id: "push_failed",
      what: "for orders that didn't reach Shopify",
      read: async () => {
        const n = await count(db.selectFrom("orders").where("status", "=", "sync_failed"));
        return n ? { count: n, words: `${plural(n, "order")} didn't reach Shopify`, hint: "Open them to send them again.", href: "/admin/orders?status=sync_failed" } : null;
      },
    },
    {
      id: "push_stuck",
      what: "for orders stuck on their way to Shopify",
      read: async () => {
        // the same rule as reporting.discrepancies' push_stuck, counted in full
        const { n, ids } = await countAndIds(db.selectFrom("orders").where("status", "=", "syncing_shopify").where("updated_at", "<", before(STUCK_MS)));
        return n ? { count: n, words: `${plural(n, "order has", "orders have")} been sending to Shopify for over an hour`, hint: "It retries by itself. Open the order if it stays stuck.", orders: ids } : null;
      },
    },
    {
      id: "refund_missing",
      what: "refunds",
      read: async () => {
        // the same rule as reporting.discrepancies' refund_mismatch, counted in full
        const { n, ids } = await countAndIds(db.selectFrom("orders").where("financial_status", "in", ["refunded", "partially_refunded"]).where("refunded_total", "<=", 0));
        return n ? { count: n, words: `${plural(n, "refund")} from your payment provider ${n === 1 ? "isn't" : "aren't"} showing here yet`, hint: "Open the order to check it.", orders: ids } : null;
      },
    },
    {
      id: "returns_open",
      what: "return requests",
      read: async () => {
        const n = await count(db.selectFrom("return_requests").where("status", "in", ["requested", "approved"]));
        return n ? { count: n, words: `${plural(n, "return request")} open`, hint: "Decide on them, or refund the approved ones.", href: "/admin/orders?view=returns" } : null;
      },
    },
    {
      id: "cod_waiting",
      what: "cash on delivery orders",
      read: async () => {
        const n = await count(db.selectFrom("orders").where("status", "=", "cod_pending").where("created_at", "<", before(COD_WAIT_MS)));
        return n ? { count: n, words: `${plural(n, "cash on delivery order")} not sent to Shopify after 15 minutes`, hint: "Open them to check why.", href: "/admin/orders?status=cod_pending" } : null;
      },
    },
    {
      // Phase 4 line 3: a custom app's endpoint paused by the system (410 or 3 days failing)
      id: "app_webhook_paused",
      what: "app webhooks",
      read: async () => {
        const n = await count(db.selectFrom("plugin_endpoints").where("status", "=", "paused").where("paused_reason", "in", [...SYSTEM_PAUSE_REASONS]));
        return n ? { count: n, words: n === 1 ? "An app's webhook address isn't answering" : `${n} apps' webhook addresses aren't answering`, hint: "Sending is paused. Check the address, then resume it.", href: "/admin/apps" } : null;
      },
    },
    {
      id: "contact_failed",
      what: "contact messages",
      read: async () => {
        const r = await libsql.execute("SELECT COUNT(*) AS n FROM contact_messages m JOIN notifications n ON n.id = m.notification_id WHERE n.status = 'failed'");
        const n = Number(r.rows[0]?.n ?? 0);
        if (!n) return null;
        const words = `${plural(n, "contact message")} didn't reach your inbox`;
        return roleAllows(role, "settings.read")
          ? { count: n, words, hint: "Set a support email in Integrations.", href: "/admin/integrations" }
          : { count: n, words, hint: "Ask the store owner or an admin to set a support email." };
      },
    },
  ];
}

export async function actionQueue({ role, nowMs = Date.now() } = {}) {
  if (!roleAllows(role, "orders.read")) return [];
  const parts = queueParts({ role, nowMs });
  const rows = await Promise.all(parts.map((p) => p.read().then((row) => (row ? { id: p.id, ...row } : null), () => unknown(p.id, p.what))));
  return rows.filter(Boolean);
}

// ---- store status -----------------------------------------------------------------

const part = (p) => p.then((value) => ({ value }), () => ({ unknown: true }));

export async function storeStatus({ role } = {}) {
  const tenant = currentTenant();
  const facts = tenant ? connectFacts(tenant) : null;
  const [open, products, unpublished] = await Promise.all([
    part(onboardingProgress()),
    part(libsql.execute("SELECT COUNT(*) AS n, MAX(synced_at) AS t FROM products").then((r) => ({ count: Number(r.rows[0]?.n ?? 0), syncedAt: r.rows[0]?.t ?? null }))),
    part(libsql.execute("SELECT COUNT(*) AS n FROM documents WHERE archived_at IS NULL AND type NOT IN ('blueprint') AND draft_hash IS NOT published_hash").then((r) => Number(r.rows[0]?.n ?? 0))),
  ]);
  const o = open.value;
  return {
    status: tenant?.status || "active",
    maintenance: Boolean(tenant?.config?.maintenance?.enabled),
    // open: true | false | null (can't tell); closed carries the onboarding count
    open: o?.openKnown ? { open: o.open, ...(o.open || !o.supported ? {} : { doneCount: o.doneCount, total: o.total }) } : { open: null },
    address: tenant?.domains?.[0] || null,
    shopify: facts
      ? {
          connected: facts.tokenHeld && !facts.uninstalledAt,
          ...(roleAllows(role, "settings.read") ? { shopDomain: facts.shopDomain } : {}),
        }
      : { connected: null },
    catalog: products.unknown ? { unknown: true } : products.value,
    unpublished: unpublished.unknown ? null : unpublished.value,
  };
}
