import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { acceptInvite } from "@/lib/platform/identity";
import { createSession, MERCHANT_SESSION_TTL_MS } from "@/lib/platform/sessions";
import { ADMIN_COOKIE } from "@/lib/admin-auth";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { sameOrigin } from "@/lib/origin-check";
import { audit } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Invitation acceptance (S26): a tenant-bound single-use token (created with
// `pnpm invite:create`) becomes a user + membership on THIS tenant, then signs
// straight in. Cross-tenant acceptance is a hard 400 inside acceptInvite.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  const limited = rateLimit(request, { name: "accept-invite", limit: 5 });
  if (limited) return limited;
  if (!(platformConfigured() && currentTenant())) {
    return NextResponse.json({ error: "Invitations need the platform control plane" }, { status: 503 });
  }
  const { token, name, password } = await request.json().catch(() => ({}));
  if (!token) return NextResponse.json({ error: "Invitation token required" }, { status: 400 });
  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  let user;
  try {
    user = await acceptInvite({ token, name: name || null, password, tenantId: tenantId() });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/accept-invite" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
  if (!user) {
    slog("admin_invite_rejected", {});
    return NextResponse.json({ error: "This invitation is invalid, expired, or already used" }, { status: 400 });
  }
  const { token: session } = await createSession({
    userId: user.id,
    kind: "merchant",
    ttlMs: MERCHANT_SESSION_TTL_MS,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local",
    ua: request.headers.get("user-agent"),
  });
  slog("admin_invite_accepted", { user: user.id });
  await audit({ actor: { kind: "merchant", id: user.id }, action: "team.invite_accepted" });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MERCHANT_SESSION_TTL_MS / 1000,
  });
  return res;
});
