import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { resolveHost } from "./platform/control.js";
import { withTenant } from "./tenant-context.js";
import { GATE, isGated, ControlPlaneUnavailableError } from "./tenant-gate.js";

// Next-facing tenant resolution (Session 20, fail-closed since S25). Two shapes:
//
//   API routes:   export const POST = tenantHandler(async (request, ctx) => …)
//                 — resolves the tenant from the request Host and runs the
//                 handler inside withTenant(). Gated hosts (unknown/suspended/
//                 control-plane-down) get the exact GATE JSON (404/503) BEFORE
//                 the handler body runs, unless { allowUnresolved: true }.
//
//   RSC pages:    const data = await tfetch(() => getProductByHandle(handle))
//                 — per-request memoized resolution (React cache) wrapping just
//                 the data work. Gated hosts: unknown/suspended → notFound()
//                 (neutral shell via layout), unavailable → throws into the
//                 neutral error boundary.
//
// Legacy mode (PLATFORM_DB_URL unset) resolves to outcome "legacy": tenant is
// null and every consumer keeps today's env-default behavior. In platform mode
// an unresolved host NEVER falls back to the default store.

export const requestResolution = cache(async () => {
  try {
    const h = await headers();
    return await resolveHost(h.get("host"));
  } catch {
    // outside a request scope (build-time, scripts) → env-default behavior
    return { outcome: "legacy", tenant: null, name: null };
  }
});

// Compat: the resolved tenant, or null (legacy OR gated). Prefer
// requestResolution() when the outcome matters.
export const requestTenant = async () => (await requestResolution()).tenant;

export async function tfetch(fn) {
  const r = await requestResolution();
  if (r.outcome === "unknown" || r.outcome === "suspended") notFound();
  if (r.outcome === "unavailable") throw new ControlPlaneUnavailableError();
  return withTenant(r.tenant, fn);
}

export function tenantHandler(handler, { allowUnresolved = false } = {}) {
  return async (request, ctx) => {
    let r;
    try {
      r = await resolveHost(request.headers.get("host"));
    } catch {
      r = { outcome: "unavailable", tenant: null, name: null };
    }
    if (!allowUnresolved && isGated(r)) {
      const g = GATE[r.outcome];
      return NextResponse.json(
        { error: g.message, code: g.code },
        { status: g.status, headers: g.retryAfter ? { "Retry-After": g.retryAfter } : undefined },
      );
    }
    return withTenant(r.tenant, () => handler(request, ctx));
  };
}
