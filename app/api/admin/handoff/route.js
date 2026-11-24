import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/admin-auth";
import { consumeInvite, findUserByEmail } from "@/lib/platform/identity";
import { createSession, membershipRole, MERCHANT_SESSION_TTL_MS } from "@/lib/platform/sessions";
import { currentTenant } from "@/lib/tenant-context";
import { sameOrigin } from "@/lib/origin-check";
import { audit } from "@/lib/platform/audit";
import { rateLimitAsync, clientIp } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Signup handoff (Phase 1 line 1): the store's /admin/handoff page POSTs the
// single-use token from its URL fragment here. A valid, unexpired handoff
// token for THIS store's host signs its owner in. A token for another store is
// refused without being spent (consumeInvite checks the tenant inside its
// UPDATE). A session is not a token: a signed-in caller without one is refused.
//   POST { token } -> 200 { ok, redirect: "/admin/onboarding" } + _admin cookie | 400 { error }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" };
const REFUSED = "This sign-in link has expired or was already used. Sign in with your email and password.";
const refuse = (reason) => {
  slog("admin_handoff_failed", { reason });
  return NextResponse.json({ error: REFUSED }, { status: 400 });
};

export const POST = tenantHandler(async (request) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "admin-handoff", limit: 10 });
  if (limited) return limited;
  const tenant = currentTenant();
  if (!tenant) return refuse("no_store");
  const { token } = await request.json().catch(() => ({}));
  if (typeof token !== "string" || !/^[0-9a-f]{16,128}$/.test(token)) return refuse("malformed");
  const invite = await consumeInvite(token, { kind: "handoff", tenantId: tenant.id });
  if (!invite) return refuse("invalid");
  const user = await findUserByEmail(invite.email);
  const role = user && user.status === "active" ? await membershipRole(user.id, tenant.id) : null;
  if (!role) return refuse("no_membership");
  const { token: session } = await createSession({ userId: user.id, kind: "merchant", ttlMs: MERCHANT_SESSION_TTL_MS, ip: clientIp(request), ua: request.headers.get("user-agent") });
  slog("admin_handoff", { user: user.id, role });
  await audit({ actor: { kind: "merchant", id: user.id, role }, action: "auth.login", diff: { method: "handoff" } });
  const res = NextResponse.json({ ok: true, redirect: "/admin/onboarding" });
  res.cookies.set(ADMIN_COOKIE, session, { ...COOKIE_OPTS, maxAge: MERCHANT_SESSION_TTL_MS / 1000 });
  return res;
});
