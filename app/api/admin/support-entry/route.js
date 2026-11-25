import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { currentTenant } from "@/lib/tenant-context";
import { consumeSupportEntry, SUPPORT_COOKIE } from "@/lib/platform/support";

// Phase 3 line 5: an operator enters this store's console across hosts
// (docs/plans/phase-3.md "Line 5", decision 4). The operator console
// auto-submits a form POST here with a single-use entry token in the body
// (never in a URL). The token is the only credential, so this route takes no
// session and no Origin check (the post comes from the operator console's
// host by design). It uses the token up (one conditional UPDATE), checks the
// grant is open and belongs to THIS host's store, and issues a support session
// tied to the grant in a host-only `_support` cookie (no Domain attribute):
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

async function tokenFrom(request) {
  try {
    const type = request.headers.get("content-type") || "";
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const v = (await request.formData()).get("token");
      return typeof v === "string" ? v : null;
    }
    const body = await request.json();
    return typeof body?.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

export const POST = tenantHandler(async (request) => {
  const token = await tokenFrom(request);
  const tenant = currentTenant();
  const entry = token && tenant ? await consumeSupportEntry(token, tenant.id).catch(() => null) : null;
  if (!entry) return refused();
  const res = new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: new URL("/admin", request.url).toString() } });
  res.cookies.set(SUPPORT_COOKIE, entry.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // always (the plan): browsers accept it on http://localhost and *.localhost
    path: "/",
    maxAge: Math.max(1, Math.floor((new Date(entry.expiresAt).getTime() - Date.now()) / 1000)),
  });
  return res;
});
