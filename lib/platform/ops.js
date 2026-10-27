// Platform operations helpers (Session 24): the tenant-loop primitive for
// crons/rollups, health aggregation, and the shared --tenant CLI flag.
import { listTenants, getTenant, platformConfigured } from "./control.js";
import { withTenant, tenantId } from "../tenant-context.js";

// Run `fn` once per ACTIVE tenant, each inside its own context; one tenant's
// failure never stops the others. LEGACY mode only (no configured control
// plane) degrades to ONE run in the default/env context — the pre-platform
// cron behavior. In platform mode (S25 fail-closed): a control-plane failure
// returns a single `_platform` failure row (never a silent env-default run),
// and an intentionally empty registry returns [].
export async function forEachActiveTenant(fn) {
  if (!platformConfigured()) {
    try {
      return [{ tenant: "_default", ok: true, result: await fn() }];
    } catch (e) {
      return [{ tenant: "_default", ok: false, error: String(e?.message || e).slice(0, 300) }];
    }
  }
  let tenants;
  try {
    tenants = (await listTenants()).filter((t) => t.status === "active");
  } catch (e) {
    return [
      { tenant: "_platform", ok: false, error: `control plane unavailable: ${String(e?.message || e).slice(0, 250)}` },
    ];
  }
  const results = [];
  for (const row of tenants) {
    try {
      const tenant = await getTenant(row.id);
      if (!tenant) throw new Error("vanished from control plane");
      const result = await withTenant(tenant, () => fn());
      results.push({ tenant: row.id, ok: true, result });
    } catch (e) {
      results.push({ tenant: row.id, ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  }
  return results;
}

// Worst-of rollup for /api/health?all=1: down > degraded > ok. A tenant whose
// check itself threw counts as down.
export function aggregateHealth(results) {
  const rank = { ok: 0, degraded: 1, down: 2 };
  let worst = "ok";
  for (const r of results) {
    const s = r.ok ? r.result?.status || "down" : "down";
    if (rank[s] > rank[worst]) worst = s;
  }
  return {
    status: worst,
    tenants: results.map((r) => ({
      tenant: r.tenant,
      status: r.ok ? r.result?.status || "down" : "down",
      ...(r.ok ? { checks: r.result?.checks } : { error: r.error }),
    })),
  };
}

// Shared `--tenant <slug>` parsing for ops CLIs. Returns { tenantSlug, rest }.
export function parseTenantFlag(argv) {
  const i = argv.indexOf("--tenant");
  if (i < 0) return { tenantSlug: null, rest: argv };
  return {
    tenantSlug: argv[i + 1] || null,
    rest: argv.filter((_, j) => j !== i && j !== i + 1),
  };
}

// CLI helper: resolve + enter a tenant context when --tenant was given,
// otherwise run in the default/env context (pre-platform behavior).
// S25: non-active tenants are rejected unless the caller explicitly opts in
// (operator CLIs like order tracing/cancellation pass allowSuspended).
export async function runAsTenant(tenantSlug, fn, { allowSuspended = false } = {}) {
  if (!tenantSlug) return fn();
  const tenant = await getTenant(tenantSlug);
  if (!tenant) throw new Error(`tenant "${tenantSlug}" not found in the control plane`);
  if (tenant.status !== "active") {
    if (!allowSuspended) throw new Error(`tenant "${tenantSlug}" is ${tenant.status} (pass allowSuspended to override)`);
    console.warn(`⚠ entering ${tenant.status} tenant "${tenantSlug}"`);
  }
  return withTenant(tenant, fn);
}

export const currentTenantLabel = () => tenantId();
