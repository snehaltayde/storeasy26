import { NextResponse } from "next/server";
import { checkPlatformPassword, platformSessionToken, platformAdminConfigured, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";

// Operator login (Session 22). No tenant context — the platform console is
// control-plane-scoped and works on any host.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const limited = rateLimit(request, { name: "platform-login", limit: 5 });
  if (limited) return limited;
  if (!platformAdminConfigured())
    return NextResponse.json({ error: "Platform console is not configured (set PLATFORM_ADMIN_PASSWORD)" }, { status: 503 });

  const { password } = await request.json().catch(() => ({}));
  if (!(await checkPlatformPassword(password))) {
    slog("platform_login_failed", {});
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  slog("platform_login", {});
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_COOKIE, await platformSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24, // operators re-auth daily
  });
  return res;
}
