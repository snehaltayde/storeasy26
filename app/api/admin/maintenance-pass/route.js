import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { requestOrigin } from "@/lib/origin-check";

// Maintenance sign-in pass (S43 / OP12): the branded maintenance page links
// here so the store team can still reach /admin/login while the storefront
// is closed. The cookie only lifts the maintenance CURTAIN for 15 minutes —
// it grants no access (login still authenticates normally) and checkout
// stays closed regardless.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  // Same-origin redirect built from the Host header — request.url carries the
  // server's bind address, which is the wrong origin on tenant hosts.
  const res = NextResponse.redirect(new URL("/admin/login", requestOrigin(request)), 302);
  res.cookies.set("_mx", "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 15 * 60 });
  return res;
});
