import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { acceptInvite, peekInvite } from "@/lib/platform/identity";
import { createSession, MERCHANT_SESSION_TTL_MS } from "@/lib/platform/sessions";
import { ADMIN_COOKIE } from "@/lib/admin-auth";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { sameOrigin } from "@/lib/origin-check";
import { audit } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { siteName } from "@/lib/site";

// Invitation acceptance (S26): a tenant-bound single-use token (created with
// `pnpm invite:create`) becomes a user + membership on THIS tenant, then signs
// straight in. Cross-tenant acceptance is a hard 400 inside acceptInvite.
// Phase 1 line 9: GET ?token= peeks (never spends) the invite on THIS store:
// { email, existingAccount, storeName }, so the page asks an existing account
// for its current password instead of a new one. An existing session is never
// used: the membership goes only to the invite's own email.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVALID = "This invitation is invalid, expired, or already used. Ask whoever invited you for a new one.";
const noStore = { "Cache-Control": "no-store" };

export const GET = tenantHandler(async (request) => {
  const limited = rateLimit(request, { name: "accept-invite-peek", limit: 20 });
  if (limited) return limited;
  if (!(platformConfigured() && currentTenant())) {
    return NextResponse.json({ error: "Invitations need the platform control plane" }, { status: 503, headers: noStore });
  }
  const token = request.nextUrl.searchParams.get("token") || "";
  let invite;
  try {
    invite = await peekInvite(token, tenantId());
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/accept-invite" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status, headers: noStore });
    throw e;
  }
  if (!invite) {
    slog("admin_invite_rejected", { reason: "peek_invalid" });
    return NextResponse.json({ error: INVALID }, { status: 400, headers: noStore });
  }
  return NextResponse.json({ ok: true, email: invite.email, existingAccount: invite.existingAccount, storeName: await siteName() }, { headers: noStore });
});

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
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ error: "Enter a password." }, { status: 400 });
  }
  let user;
  try {
    user = await acceptInvite({ token, name: name || null, password, tenantId: tenantId() });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/accept-invite" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
  if (user?.wrongPassword) {
    slog("admin_invite_rejected", { reason: "wrong_password" });
    return NextResponse.json({ error: "That isn't the password for your Storeasy account. Try again, or use \"Forgot password\" on the sign-in page.", code: "WRONG_PASSWORD" }, { status: 400 });
  }
  if (user?.passwordProblem) return NextResponse.json({ error: user.passwordProblem }, { status: 400 });
  if (!user) {
    slog("admin_invite_rejected", { reason: "invalid" });
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }
  const { token: session } = await createSession({
    userId: user.id,
    kind: "merchant",
    ttlMs: MERCHANT_SESSION_TTL_MS,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local",
    ua: request.headers.get("user-agent"),
  });
  slog("admin_invite_accepted", { user: user.id });
  await audit({ actor: { kind: "merchant", id: user.id }, action: "team.invite_accepted", tenantId: tenantId(), diff: { role: user.inviteRole, existingAccount: user.existingAccount } });
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
