import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { requestOrigin } from "@/lib/origin-check";
import { issueMaintenancePass, MAINTENANCE_PASS_COOKIE, MAINTENANCE_PASS_TTL_S } from "@/lib/maintenance";

// Maintenance sign-in pass (S43 / OP12): the branded maintenance page links
// here, publicly. Everyone is sent to /admin/login, which sits outside the
// curtain. Only a verified staff session also gets a signed pass — it lifts
// the CURTAIN for 15 minutes, grants no console access, and checkout stays
// closed regardless. Anonymous visitors get no cookie.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  // Same-origin redirect built from the Host header — request.url carries the
  // server's bind address, which is the wrong origin on tenant hosts.
  const res = NextResponse.redirect(new URL("/admin/login", requestOrigin(request)), 302);
  const pass = await issueMaintenancePass(request.cookies);
  if (pass) {
    res.cookies.set(MAINTENANCE_PASS_COOKIE, pass, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: MAINTENANCE_PASS_TTL_S,
    });
  }
  return res;
});
