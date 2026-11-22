import { cache } from "react";
import { cookies, headers } from "next/headers";
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
//
// Fresh reads (P1-FIX-C). The store's row (settings, brand, theme, identity)
// is cached for 30 s per instance (lib/platform/control.js). The console must
// never show a founder's own save as undone, and hosted runs many instances,
// so console pages (lib/console-request.js) and every /api/admin route read
// the row fresh on each request. Shopper pages and APIs keep the cache, except
// a page opened in a founder's preview session, which shows drafts and reads
// the row fresh too.
async function hostResolution(fresh) {
  let h;
  try {
    h = await headers();
  } catch {
    // outside a request scope (build-time, scripts) → env-default behavior
    return { outcome: "legacy", tenant: null, name: null };
  }
  const host = h.get("host");
  const r = await resolveHost(host, { fresh });
  if (fresh || r.outcome !== "resolved" || !(await inPreview(r.tenant))) return r;
  return resolveHost(host, { fresh: true });
}

// A founder's preview session: a preview cookie this store signed (checked
// against the cached row, which holds the signing context). A cookie that
// isn't valid costs one local HMAC and nothing else. P2-PREVIEW: the same
// verifier as the storefront's (lib/releases.js readPreviewToken), so both
// the session token p.<exp>.<sid>.<hmac> and the old p.<exp>.<hmac> count.
// Whether a session token still counts (its preview_sessions row) is
// decided by lib/content/resolve.js; here a signed, unexpired cookie only
// makes the row read fresh.
async function inPreview(tenant) {
  try {
    const { PREVIEW_COOKIE } = await import("./preview-sessions.js");
    const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
    if (!token) return false;
    const { readPreviewToken } = await import("./releases.js");
    return (await withTenant(tenant, () => readPreviewToken(token))) !== null;
  } catch {
    return false;
  }
}

export const requestResolution = cache(() => hostResolution(false));
const consoleResolution = cache(() => hostResolution(true));

// Compat: the resolved tenant, or null (legacy OR gated). Prefer
// requestResolution() when the outcome matters.
export const requestTenant = async () => (await requestResolution()).tenant;

// { fresh: true } is the console's (lib/console-request.js).
export async function tfetch(fn, { fresh = false } = {}) {
  const r = await (fresh ? consoleResolution() : requestResolution());
  if (r.outcome === "unknown" || r.outcome === "suspended") notFound();
  if (r.outcome === "unavailable") throw new ControlPlaneUnavailableError();
  return withTenant(r.tenant, fn);
}

// The console's API: every route under /api/admin/ reads the store's row fresh.
export const CONSOLE_API_PREFIX = "/api/admin/";
function isConsoleApi(request) {
  try {
    return (request.nextUrl?.pathname ?? new URL(request.url).pathname).startsWith(CONSOLE_API_PREFIX);
  } catch {
    return false;
  }
}

export function tenantHandler(handler, { allowUnresolved = false, fresh } = {}) {
  return async (request, ctx) => {
    let r;
    const host = request.headers.get("host");
    try {
      // "prefer" (P1-RATES, the checkout API): read the row fresh, and if that
      // read fails, serve the cached row as a shopper route always has.
      if (fresh === "prefer") {
        r = await resolveHost(host, { fresh: true }).catch(() => null);
        if (!r || r.outcome === "unavailable") r = await resolveHost(host);
      } else {
        r = await resolveHost(host, { fresh: fresh ?? isConsoleApi(request) });
      }
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
