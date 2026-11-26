// Tenant unit costs (Session 47 / OP09). Plain-Node, operator-side.
//
// The honesty model: the operator enters the REAL monthly provider totals
// (the bills); this module allocates each bucket to tenants by a MEASURED
// driver, states the method next to every number, and keeps whatever no
// driver covers as a visible UNALLOCATED remainder — missing measurement
// never turns into invented per-tenant precision.
//
// Buckets → drivers (all measured, all this month):
//   compute  ∝ orders created + platform jobs processed  (request volume proxy)
//   db       ∝ media bytes + row-count proxy             (storage)
//   mail     ∝ notifications attempted                   (tenant DB)
//   ai       ∝ ai_tokens + ai_copilot_tokens usage       (platform ledger)
//   other    → never allocated (shown whole as unallocated)
// Gaps stated in the report: bandwidth, build minutes and per-request edge
// compute are NOT measured per tenant — they live in the remainder.
import { platformDb, platformConfigured, listTenants } from "./control.js";
import { runAsTenant } from "./ops.js";
import { periodOf } from "./billing.js";
import { refuse } from "./refuse.js";

const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export async function setCostInputs(month, totals, note = "") {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw refuse(422, "month must be YYYY-MM");
  const clean = {};
  for (const k of ["compute", "db", "mail", "ai", "other"]) {
    const v = Number(totals?.[k] ?? 0);
    if (!Number.isFinite(v) || v < 0) throw refuse(422, `${k}: a non-negative number (INR)`);
    clean[k] = v;
  }
  await platformDb().execute({
    sql: `INSERT INTO cost_inputs (month, totals, note, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(month) DO UPDATE SET totals=excluded.totals, note=excluded.note, updated_at=excluded.updated_at`,
    args: [month, JSON.stringify(clean), String(note).slice(0, 300), nowIso()],
  });
  return { month, totals: clean };
}

export async function getCostInputs(month) {
  const r = await platformDb().execute({ sql: "SELECT * FROM cost_inputs WHERE month = ?", args: [month] });
  const row = r.rows[0];
  return row ? { month: row.month, totals: parse(row.totals, {}), note: row.note || "", updated_at: row.updated_at } : null;
}

// Measure this month's drivers for every active tenant. A tenant whose DB
// can't be reached is listed as UNMEASURED — its share stays unallocated
// instead of being silently zero.
async function measureDrivers(month) {
  const since = `${month}-01`;
  const tenants = (await listTenants()).filter((t) => t.status === "active");
  const rows = [];
  for (const t of tenants) {
    try {
      const m = await runAsTenant(t.id, async () => {
        const { db } = await import("../db.js");
        const count = (q) => q.executeTakeFirst().then((r) => Number(r?.n || 0)).catch(() => 0);
        const [orders, events, notifications, mediaBytes, products] = await Promise.all([
          count(db.selectFrom("orders").select(({ fn }) => fn.countAll().as("n")).where("created_at", ">=", since)),
          count(db.selectFrom("events").select(({ fn }) => fn.countAll().as("n")).where("created_at", ">=", since)),
          count(db.selectFrom("notifications").select(({ fn }) => fn.countAll().as("n")).where("created_at", ">=", since)),
          count(db.selectFrom("media").select(({ fn }) => fn.sum("size").as("n"))),
          count(db.selectFrom("products").select(({ fn }) => fn.countAll().as("n"))),
        ]);
        return { orders, events, notifications, mediaBytes, products };
      });
      rows.push({ tenant: t.id, name: t.name, measured: true, ...m });
    } catch (e) {
      rows.push({ tenant: t.id, name: t.name, measured: false, error: String(e?.message || e).slice(0, 120), orders: 0, events: 0, notifications: 0, mediaBytes: 0, products: 0 });
    }
  }
  // platform-side drivers
  const jobs = await platformDb().execute({
    sql: "SELECT tenant_id, COUNT(*) n FROM jobs WHERE created_at >= ? GROUP BY tenant_id",
    args: [since],
  });
  const jobsBy = Object.fromEntries(jobs.rows.map((r) => [r.tenant_id || "_default", Number(r.n)]));
  const ai = await platformDb().execute({
    sql: "SELECT tenant_id, SUM(qty) n FROM usage_events WHERE period = ? AND metric IN ('ai_tokens', 'ai_copilot_tokens') GROUP BY tenant_id",
    args: [month],
  });
  const aiBy = Object.fromEntries(ai.rows.map((r) => [r.tenant_id, Number(r.n)]));
  for (const r of rows) {
    r.jobs = jobsBy[r.tenant] || 0;
    r.aiTokens = aiBy[r.tenant] || 0;
  }
  return rows;
}

// Allocate one bucket proportionally to a driver. Driver total 0 → the
// whole bucket is unallocated (never split evenly just to look complete).
function allocate(total, rows, driver) {
  const sum = rows.reduce((s, r) => s + (r.measured ? driver(r) : 0), 0);
  const out = new Map();
  if (!total) return { out, allocated: 0 };
  if (!sum) return { out, allocated: 0 };
  let allocated = 0;
  for (const r of rows) {
    const share = r.measured ? (driver(r) / sum) * total : 0;
    const v = Math.round(share * 100) / 100;
    out.set(r.tenant, v);
    allocated += v;
  }
  return { out, allocated: Math.round(allocated * 100) / 100 };
}

export const COST_METHOD = {
  compute: "∝ orders created + platform jobs processed this month (request-volume proxy)",
  db: "∝ stored media bytes + 1KB per product row (storage proxy)",
  mail: "∝ notification intents this month",
  ai: "∝ metered AI tokens this month (insights and copilot)",
  other: "never allocated — shown whole in the remainder",
};

export const COST_GAPS = [
  "bandwidth, build minutes and per-request edge compute are not measured per tenant — they stay in the unallocated remainder",
  "storage proxy counts media bytes and product rows, not full DB size",
];

export async function costReport(month = periodOf()) {
  if (!platformConfigured()) return { month, configured: false };
  const inputs = await getCostInputs(month);
  const drivers = await measureDrivers(month);
  const totals = inputs?.totals || { compute: 0, db: 0, mail: 0, ai: 0, other: 0 };

  const buckets = {
    compute: allocate(totals.compute, drivers, (r) => r.orders + r.jobs),
    db: allocate(totals.db, drivers, (r) => r.mediaBytes + r.products * 1024),
    mail: allocate(totals.mail, drivers, (r) => r.notifications),
    ai: allocate(totals.ai, drivers, (r) => r.aiTokens),
  };

  const tenants = drivers.map((d) => {
    const per = Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, b.out.get(d.tenant) || 0]));
    const allocated = Math.round(Object.values(per).reduce((s, v) => s + v, 0) * 100) / 100;
    return { ...d, costs: per, allocated };
  });

  // budgets live in the tenant row's config (operator-set) — listTenants
  // returns no config, so read each tenant row (cached by the control plane)
  const { getTenant } = await import("./control.js");
  for (const t of tenants) {
    const cfg = (await getTenant(t.tenant).catch(() => null))?.config || {};
    const b = Number(cfg.cost_budget ?? NaN);
    t.budget = Number.isFinite(b) && b > 0 ? b : null;
    t.overBudget = t.budget != null && t.allocated > t.budget;
  }

  const grandTotal = Math.round(Object.values(totals).reduce((s, v) => s + Number(v || 0), 0) * 100) / 100;
  const grandAllocated = Math.round(Object.values(buckets).reduce((s, b) => s + b.allocated, 0) * 100) / 100;
  return {
    month,
    configured: true,
    inputs: inputs ? { totals, note: inputs.note, updated_at: inputs.updated_at } : null,
    method: COST_METHOD,
    gaps: COST_GAPS,
    tenants,
    unmeasured: tenants.filter((t) => !t.measured).map((t) => t.tenant),
    total: grandTotal,
    allocated: grandAllocated,
    unallocated: Math.round((grandTotal - grandAllocated) * 100) / 100,
    alerts: tenants.filter((t) => t.overBudget).map((t) => ({ tenant: t.tenant, allocated: t.allocated, budget: t.budget })),
  };
}
