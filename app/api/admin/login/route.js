import { NextResponse } from "next/server";
import { checkAdminPassword, adminSessionToken, adminConfigured, ADMIN_COOKIE } from "@/lib/admin-auth";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  // brute-force guard: 5 attempts/min/ip
  const limited = rateLimit(request, { name: "admin", limit: 5 });
  if (limited) return limited;
  if (!adminConfigured())
    return NextResponse.json({ error: "Admin is not configured (set ADMIN_PASSWORD)" }, { status: 503 });

  const { password } = await request.json().catch(() => ({}));
  if (!(await checkAdminPassword(password))) {
    slog("admin_login_failed", {});
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  slog("admin_login", {});
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await adminSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
