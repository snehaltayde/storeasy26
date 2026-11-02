import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/admin-auth";
import { revokeSessionByToken } from "@/lib/platform/sessions";
import { sameOrigin } from "@/lib/origin-check";
import { MAINTENANCE_PASS_COOKIE } from "@/lib/maintenance";

export const runtime = "nodejs";

export async function POST(request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  // S26: revoke the server-side session (no-op for legacy/bootstrap tokens),
  // then clear the cookie — the token is dead everywhere, not just here.
  await revokeSessionByToken(request.cookies.get(ADMIN_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(MAINTENANCE_PASS_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
