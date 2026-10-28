import { NextResponse } from "next/server";
import { verifyPreviewToken } from "@/lib/releases";
import { PREVIEW_COOKIE } from "@/lib/content/resolve";
import { tenantHandler } from "@/lib/tenant-request";

// Draft preview switch (S36 / BE09).
//   GET ?token=p.<exp>.<hmac>[&to=/path] → verify, set the preview cookie
//     (httpOnly, lifetime = the token's remaining life), redirect to `to`.
//   GET ?exit=1 → clear the cookie, back to the live release.
// Cookie-based on purpose: preview content never hangs off a shareable URL
// that a cache or crawler could pick up — the token URL itself only ever
// 302s, and an invalid/expired token lands on the live site with no cookie.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safePath = (p) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : "/");

export const GET = tenantHandler(async (request) => {
  const params = request.nextUrl.searchParams;
  const to = safePath(params.get("to"));
  const dest = new URL(to, request.nextUrl.origin);

  if (params.get("exit")) {
    const res = NextResponse.redirect(dest, 302);
    res.cookies.set(PREVIEW_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  }

  const token = params.get("token") || "";
  if (!(await verifyPreviewToken(token))) {
    // expired or forged → live site, no cookie, no hint
    return NextResponse.redirect(dest, 302);
  }
  const exp = Number(token.split(".")[1]) * 1000;
  const res = NextResponse.redirect(dest, 302);
  res.cookies.set(PREVIEW_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.max(60, Math.floor((exp - Date.now()) / 1000)),
  });
  return res;
});
