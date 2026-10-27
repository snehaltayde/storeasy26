import { NextResponse } from "next/server";
import { findUserByEmail, createInvite, loginThrottle } from "@/lib/platform/identity";
import { membershipRole } from "@/lib/platform/sessions";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { sendMail } from "@/lib/mail";
import { sameOrigin } from "@/lib/origin-check";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Password recovery (S26): emails a 1-hour single-use reset link. The response
// is the same whether or not the account exists (no user enumeration).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC = { ok: true, message: "If that account exists, a reset link is on its way." };

export const POST = tenantHandler(async (request) => {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  const limited = rateLimit(request, { name: "recover", limit: 3 });
  if (limited) return limited;
  if (!(platformConfigured() && currentTenant())) {
    return NextResponse.json({ error: "Recovery needs the platform control plane" }, { status: 503 });
  }
  const { email } = await request.json().catch(() => ({}));
  if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

  const { blocked } = await loginThrottle(`recover:${String(email).toLowerCase()}`, { limit: 3 });
  if (blocked) return NextResponse.json(GENERIC); // quietly drop — same response

  const user = await findUserByEmail(email);
  if (user && user.status === "active" && (await membershipRole(user.id, tenantId()))) {
    const { token } = await createInvite({
      email,
      tenantId: tenantId(),
      kind: "reset",
      ttlMs: 60 * 60 * 1000,
    });
    const host = request.headers.get("host");
    const proto = process.env.NODE_ENV === "production" ? "https" : "http";
    await sendMail({
      to: user.email,
      subject: "Reset your store console password",
      text: `Someone requested a password reset for your store console account.\n\nReset it here (valid 1 hour):\n${proto}://${host}/admin/reset?token=${token}\n\nIf this wasn't you, ignore this email.`,
    });
    slog("admin_recover_sent", { user: user.id });
  } else {
    slog("admin_recover_noop", {});
  }
  return NextResponse.json(GENERIC);
});
