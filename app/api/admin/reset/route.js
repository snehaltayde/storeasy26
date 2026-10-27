import { NextResponse } from "next/server";
import { acceptReset } from "@/lib/platform/identity";
import { sameOrigin } from "@/lib/origin-check";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Password reset submit (S26): consumes the single-use token, sets the new
// password, and revokes EVERY session of that user (stolen sessions die here).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  const limited = rateLimit(request, { name: "reset", limit: 5 });
  if (limited) return limited;
  const { token, password } = await request.json().catch(() => ({}));
  if (!token) return NextResponse.json({ error: "Reset token required" }, { status: 400 });
  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  const user = await acceptReset({ token, password }).catch(() => null);
  if (!user) {
    slog("admin_reset_rejected", {});
    return NextResponse.json({ error: "This reset link is invalid, expired, or already used" }, { status: 400 });
  }
  slog("admin_reset_done", { user: user.id });
  return NextResponse.json({ ok: true });
});
