import { NextResponse } from "next/server";
import { checkAdminPassword, adminSessionToken, adminConfigured, adminBootstrapMode, ADMIN_COOKIE } from "@/lib/admin-auth";
import { findUserByEmail, verifyPassword, loginThrottle, clearThrottle } from "@/lib/platform/identity";
import { createSession, membershipRole, MERCHANT_SESSION_TTL_MS } from "@/lib/platform/sessions";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { sameOrigin } from "@/lib/origin-check";
import { audit } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Merchant sign-in (S26 / MC01): individual email+password accounts with
// revocable sessions, tenant-authorized via membership. The shared tenant
// password remains ONLY as the bootstrap path (no member users yet) and in
// legacy single-tenant mode.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

const fail = (status, error) => NextResponse.json({ error }, { status });

export const POST = tenantHandler(async (request) => {
  if (!sameOrigin(request)) return fail(403, "Cross-origin request rejected");
  // fast per-isolate guard stays; the control-plane throttle below is the
  // distributed one (BE02: limits survive multiple instances)
  const limited = rateLimit(request, { name: "admin", limit: 5 });
  if (limited) return limited;

  const { email, password } = await request.json().catch(() => ({}));
  if (typeof password !== "string" || !password) return fail(400, "Password required");

  const sessionsAvailable = platformConfigured() && currentTenant();

  // --- individual account path (platform mode, email given) ---
  if (email && sessionsAvailable) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const keys = [`login:${String(email).toLowerCase()}`, `login-ip:${ip}`];
    for (const key of keys) {
      const { blocked } = await loginThrottle(key);
      if (blocked) {
        slog("admin_login_failed", { reason: "throttled" });
        return fail(429, "Too many attempts — try again later");
      }
    }
    const user = await findUserByEmail(email);
    const okPassword = user && user.status === "active" && (await verifyPassword(password, user.password_hash));
    const role = okPassword ? await membershipRole(user.id, tenantId()) : null;
    if (!okPassword || !role) {
      slog("admin_login_failed", { reason: !okPassword ? "credentials" : "no_membership" });
      return fail(401, "Wrong email or password");
    }
    const { token } = await createSession({
      userId: user.id,
      kind: "merchant",
      ttlMs: MERCHANT_SESSION_TTL_MS,
      ip,
      ua: request.headers.get("user-agent"),
    });
    for (const key of keys) await clearThrottle(key);
    slog("admin_login", { method: "session", user: user.id, role });
    await audit({ actor: { kind: "merchant", id: user.id, role }, action: "auth.login", diff: { method: "session" } });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_COOKIE, token, { ...COOKIE_OPTS, maxAge: MERCHANT_SESSION_TTL_MS / 1000 });
    return res;
  }

  // --- bootstrap / legacy shared-password path ---
  if (sessionsAvailable && !(await adminBootstrapMode())) {
    slog("admin_login_failed", { reason: "email_required" });
    return fail(401, "Sign in with your email and password");
  }
  if (!adminConfigured()) return fail(503, "Admin is not configured (set ADMIN_PASSWORD)");
  if (!(await checkAdminPassword(password))) {
    slog("admin_login_failed", { reason: "credentials", method: "bootstrap" });
    return fail(401, "Wrong password");
  }
  slog("admin_login", { method: "bootstrap" });
  await audit({ actor: { kind: "bootstrap", id: "bootstrap" }, action: "auth.login", diff: { method: "bootstrap" } });
  const res = NextResponse.json({ ok: true, bootstrap: true });
  res.cookies.set(ADMIN_COOKIE, await adminSessionToken(), { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 });
  return res;
});
