import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";

// Maintenance sign-in pass (S43 / OP12): the branded maintenance page links
// here so the store team can still reach /admin/login while the storefront
// is closed. The cookie only lifts the maintenance CURTAIN for 15 minutes —
// it grants no access (login still authenticates normally) and checkout
// stays closed regardless.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const res = NextResponse.redirect(new URL("/admin/login", request.url), 302);
  res.cookies.set("_mx", "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 15 * 60 });
  return res;
});
