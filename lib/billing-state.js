// Billing-state helpers (S40 / BE33). PURE + EDGE-SAFE (no imports): the
// storefront reads the tenant's billing SNAPSHOT (config.billing, pushed by
// lib/platform/billing.js on every applied provider event) and derives
// service state locally — no control-plane round trip on the hot path.
//
// The one hard rule: a published store is NEVER hard-shut-down by billing.
// Degraded = checkout pauses with honest copy; browsing, content and order
// lookups stay live.

export const GRACE_DAYS_DEFAULT = 7;

// A snapshot: { plan, plan_version, status, grace_until, current_end, updated_at }
// No snapshot at all = unbilled/legacy tenant → full service (billing is
// opt-in until the platform puts every tenant on a plan).
export function billingDegraded(billing, now = Date.now()) {
  if (!billing || !billing.status) return false;
  if (!["halted", "cancelled", "expired"].includes(billing.status)) return false;
  if (!billing.grace_until) return true;
  return now > new Date(billing.grace_until).getTime();
}

// Grace = payment trouble, but the clock hasn't run out: full service plus
// warnings in the console.
export function billingInGrace(billing, now = Date.now()) {
  if (!billing || !billing.status) return false;
  if (!["halted", "cancelled", "expired"].includes(billing.status)) return false;
  return Boolean(billing.grace_until) && now <= new Date(billing.grace_until).getTime();
}

// Console chip for MC24/OP08: none | active | authenticated | grace | degraded | …
export function billingLabel(billing, now = Date.now()) {
  if (!billing || !billing.status) return "none";
  if (billingDegraded(billing, now)) return "degraded";
  if (billingInGrace(billing, now)) return "grace";
  return billing.status;
}

// Quota meter: used vs limit with the 80% pre-limit warning (BE33). A
// missing/zero-less limit means unmetered. Over-quota WARNS — enforcement
// beyond the degraded-checkout rule is a future, explicitly-scoped decision.
export function quotaStatus(features, usage) {
  const out = [];
  for (const [metric, limit] of Object.entries(features || {})) {
    if (!/^[a-z_]+_per_month$|^.+_seats$/.test(metric)) continue;
    if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) continue;
    const used = Number(usage?.[metric] ?? 0);
    out.push({
      metric,
      used,
      limit: Number(limit),
      warn: used >= Number(limit) * 0.8 && used < Number(limit),
      over: used >= Number(limit),
    });
  }
  return out;
}
