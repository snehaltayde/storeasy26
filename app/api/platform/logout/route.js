import { NextResponse } from "next/server";
import { PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { revokeSessionByToken } from "@/lib/platform/sessions";
import { sameOrigin } from "@/lib/origin-check";

export const runtime = "nodejs";

export async function POST(request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  // S26: revoke the operator session server-side (no-op for bootstrap tokens).
  await revokeSessionByToken(request.cookies.get(PLATFORM_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
