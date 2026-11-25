import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { currentTenant } from "@/lib/tenant-context";
import { requestOrigin } from "@/lib/origin-check";
import { consumeSupportEntry, SUPPORT_COOKIE } from "@/lib/platform/support";

// Phase 3 line 5: an operator enters this store's console across hosts
// (docs/plans/phase-3.md "Line 5", decision 4). The operator console
// auto-submits a form POST here with a single-use entry token in the body
// (never in a URL). The token is the only credential, so this route takes no
// session; the post comes from the operator console's host by design, and its
// Origin must be the console origin the token was minted on (a form post only:
// a JSON body is refused). It uses the token up (one conditional UPDATE), checks the
// grant is open and belongs to THIS host's store, and issues a support session
// tied to the grant in a host-only `__Host-support` cookie (no Domain attribute):
// 303 to /admin. Anything else is a 400 that sets no cookie. The token is never
// logged, audited or echoed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

const refused = () =>
  new NextResponse(
    "<!doctype html><meta charset=utf-8><title>Support entry</title><p>This entry link is used up, has expired, or is for another store. Open the store's console again from the operator console.</p>",
    { status: 400, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } },
  );

// Only a browser form post: the urlencoded or multipart body's `token`. A JSON
// body (a script's call) is refused.
async function tokenFrom(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded") && !type.startsWith("multipart/form-data")) return null;
  try {
    const v = (await request.formData()).get("token");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export const POST = tenantHandler(async (request) => {
  // the posting page must be the operator console the token was minted on
  // (consumeSupportEntry matches the Origin header to it exactly)
  const origin = request.headers.get("origin");
  const token = origin ? await tokenFrom(request) : null;
  const tenant = currentTenant();
  const entry = token && tenant ? await consumeSupportEntry(token, tenant.id, origin).catch(() => null) : null;
  if (!entry) return refused();
  // the store's own origin from the Host header: request.url carries the
  // server's bind address (see app/api/admin/maintenance-pass/route.js)
  const res = new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: new URL("/admin", requestOrigin(request)).toString() } });
  res.cookies.set(SUPPORT_COOKIE, entry.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // required by the __Host- prefix; browsers accept it on http://localhost and *.localhost
    path: "/",
    maxAge: Math.max(1, Math.floor((new Date(entry.expiresAt).getTime() - Date.now()) / 1000)),
  });
  return res;
});
