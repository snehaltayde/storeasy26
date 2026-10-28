// Merchant billing view (S40 / MC24) — ONE assembler shared by the /admin
// /billing page (server render) and /api/admin/billing (refresh after a plan
// change), so the two can never drift. Node-only (control-plane imports).
import { db } from "../db.js";
import { currentTenant } from "../tenant-context.js";
import { platformConfigured } from "../platform/control.js";
import { billingLabel, billingDegraded, billingInGrace, quotaStatus } from "../billing-state.js";

async function ordersThisMonth() {
  try {
    const start = `${new Date().toISOString().slice(0, 7)}-01`;
    const r = await db
      .selectFrom("orders")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("created_at", ">=", start)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function buildBillingView() {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return { supported: false, reason: "Billing needs the platform control plane — this store runs on environment config." };
  }
  const B = await import("../platform/billing.js");
  const { platformDb } = await import("../platform/control.js");
  await B.ensureDefaultPlans();
  const [plans, sub, ent, usage, ordersUsed] = await Promise.all([
    B.listPlans(),
    B.subscriptionFor(tenant.id),
    B.entitlementsFor(tenant.id),
    B.usageTotals(tenant.id),
    ordersThisMonth(),
  ]);
  const billing = tenant.config?.billing || (sub ? await B.syncTenantBillingSnapshot(tenant.id) : null);
  const history = (
    await platformDb().execute({
      sql: "SELECT type, amount, occurred_at, payment_id FROM billing_events WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT 20",
      args: [tenant.id],
    })
  ).rows.map((r) => ({ type: r.type, amount: Number(r.amount), occurred_at: r.occurred_at, payment_id: r.payment_id }));

  return {
    supported: true,
    plans: plans.map((p) => ({ id: p.id, version: p.version, name: p.name, price: p.price, currency: p.currency, interval: p.interval, features: p.features })),
    subscription: sub
      ? { plan: sub.plan_id, version: sub.plan_version, status: sub.status, current_end: sub.current_end, grace_until: sub.grace_until, short_url: sub.short_url }
      : null,
    entitlements: ent,
    label: billingLabel(billing),
    degraded: billingDegraded(billing),
    inGrace: billingInGrace(billing),
    quotas: quotaStatus(ent.features, { orders_per_month: ordersUsed, ...usage }),
    ordersUsed,
    history,
  };
}
