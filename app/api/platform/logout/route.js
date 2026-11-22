import { NextResponse } from "next/server";
import { PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { revokeSessionByToken } from "@/lib/platform/sessions";
import { sameOrigin } from "@/lib/origin-check";
import { PREVIEW_COOKIE } from "@/lib/preview-sessions";
import { MAINTENANCE_PASS_COOKIE } from "@/lib/maintenance";

export const runtime = "nodejs";

export async function POST(request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  // S26: revoke the operator session server-side (no-op for bootstrap tokens).
  await revokeSessionByToken(request.cookies.get(PLATFORM_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  // P3-SESSION: and this browser's store preview, with the attributes
  // /api/preview sets. Preview sessions an operator opened live in each
  // store's own database and are not revoked here: they end within the hour
  // (known limit, P3-SESSION.md).
  res.cookies.set(PREVIEW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  res.cookies.set(MAINTENANCE_PASS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
