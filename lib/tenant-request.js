import { cache } from "react";
import { headers } from "next/headers";
import { getTenantByHost } from "./platform/control.js";
import { withTenant } from "./tenant-context.js";

// Next-facing tenant resolution (Session 20). Two entry shapes:
//
//   API routes:   export const POST = tenantHandler(async (request, ctx) => …)
//                 — resolves the tenant from the request Host and runs the
//                 handler inside withTenant(), so every db/config access in
//                 the call chain is tenant-scoped.
//
//   RSC pages:    const data = await tfetch(() => getProductByHandle(handle))
//                 — per-request memoized resolution (React cache) wrapping
//                 just the data work; pages already fetch-at-top and pass
//                 props down, so this is a one-line wrap per call site.
//
// Unmapped hosts resolve to null → env-fallback default tenant (BeastLife).

export const requestTenant = cache(async () => {
  try {
    const h = await headers();
    return await getTenantByHost(h.get("host"));
  } catch {
    return null; // outside a request scope (build-time, scripts) → fallback
  }
});

export async function tfetch(fn) {
  const tenant = await requestTenant();
  return withTenant(tenant, fn);
}

export function tenantHandler(handler) {
  return async (request, ctx) => {
    let tenant = null;
    try {
      tenant = await getTenantByHost(request.headers.get("host"));
    } catch {
      tenant = null;
    }
    return withTenant(tenant, () => handler(request, ctx));
  };
}
