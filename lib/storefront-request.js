import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { tfetch as tenantFetch, tenantHandler } from "./tenant-request.js";
import { MAINTENANCE_GATE, maintenanceConfig, maintenanceCurtain, maintenanceOn } from "./maintenance.js";

// The storefront's data path: lib/tenant-request.js plus the maintenance gate.
// The curtain in app/(storefront)/layout.js is NOT enough on its own. Next
// serializes every page segment into the response whether or not the layout
// renders `children`, and an RSC navigation can skip the layout entirely. So a
// closed store must not FETCH shopper data for this visitor at all.
//
// Storefront pages import tfetch from here; consoles keep the ungated one (the
// sign-in pages must work during maintenance). scripts/test-maintenance.js
// fails if a storefront page imports the ungated one.

// Fail closed: a cookie read that throws counts as "no credential".
const curtainFor = cache(async () => {
  try {
    return await maintenanceCurtain(await cookies());
  } catch {
    return maintenanceConfig();
  }
});

// The maintenance config when this visitor must not see the store, else null.
// One decision per request, shared by the layout, its metadata and every data
// read below. Call inside the tenant context.
export const storeCurtain = async () => (maintenanceOn() ? curtainFor() : null);

export function tfetch(fn) {
  return tenantFetch(async () => {
    if (await storeCurtain()) notFound();
    return fn();
  });
}

// tenantHandler for shopper APIs that return catalog data. Not for webhooks,
// jobs or console APIs, which must keep working during maintenance.
export function storefrontHandler(handler) {
  return tenantHandler(async (request, ctx) => {
    if (await maintenanceCurtain(request.cookies)) {
      const { status, code, message, retryAfter } = MAINTENANCE_GATE;
      return NextResponse.json({ error: message, code }, { status, headers: { "Retry-After": retryAfter } });
    }
    return handler(request, ctx);
  });
}
