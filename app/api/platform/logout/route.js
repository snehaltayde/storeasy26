import { NextResponse } from "next/server";
import { PLATFORM_COOKIE } from "@/lib/platform/admin-auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
