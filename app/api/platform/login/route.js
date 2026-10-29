import { NextResponse } from "next/server";
import {
  checkPlatformPassword,
  platformSessionToken,
  platformAdminConfigured,
  PLATFORM_COOKIE,
} from "@/lib/platform/admin-auth";
import {
  findUserByEmail,
  verifyPassword,
  ensureTotpSecret,
  verifyTotp,
  confirmTotp,
  totpUri,
  loginThrottle,
  clearThrottle,
} from "@/lib/platform/identity";
import { createSession, operatorsExist, OPERATOR_SESSION_TTL_MS } from "@/lib/platform/sessions";
import { platformConfigured } from "@/lib/platform/control";
import { sameOrigin } from "@/lib/origin-check";
import { audit } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";

// Operator sign-in (S26 / OP01): individual operator users, MANDATORY TOTP,
// short revocable sessions (12h). First login enrolls TOTP: password is
// verified, then the secret/otpauth URI is returned once and the first valid
// code confirms enrollment. The legacy PLATFORM_ADMIN_PASSWORD path works only
// while no operator user exists (bootstrap). No tenant context — the console
// is control-plane-scoped and works on any host.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (status, error) => NextResponse.json({ error }, { status });

const sessionResponse = async (user, request) => {
  const { token } = await createSession({
    userId: user.id,
    kind: "operator",
    ttlMs: OPERATOR_SESSION_TTL_MS,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local",
    ua: request.headers.get("user-agent"),
  });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OPERATOR_SESSION_TTL_MS / 1000,
  });
  return res;
};

export async function POST(request) {
  if (!sameOrigin(request)) return fail(403, "Cross-origin request rejected");
  const limited = rateLimit(request, { name: "platform-login", limit: 5 });
  if (limited) return limited;

  const { email, password, totp } = await request.json().catch(() => ({}));
  if (typeof password !== "string" || !password) return fail(400, "Password required");

  // --- operator account path ---
  if (email && platformConfigured()) {
    const key = `op-login:${String(email).toLowerCase()}`;
    const { blocked } = await loginThrottle(key);
    if (blocked) {
      slog("platform_login_failed", { reason: "throttled" });
      return fail(429, "Too many attempts — try again later");
    }
    const user = await findUserByEmail(email);
    const okPassword =
      user &&
      user.status === "active" &&
      Number(user.is_operator) === 1 &&
      (await verifyPassword(password, user.password_hash));
    if (!okPassword) {
      slog("platform_login_failed", { reason: "credentials" });
      return fail(401, "Wrong email or password");
    }

    // TOTP is mandatory. Unconfirmed → enrollment handshake.
    if (!Number(user.totp_confirmed)) {
      const secret = await ensureTotpSecret(user.id);
      if (!totp) {
        slog("platform_login_enroll_started", { user: user.id });
        return NextResponse.json({
          enroll: true,
          secret,
          otpauth: totpUri(secret, user.email),
          message: "Scan the secret in your authenticator app, then sign in again with the 6-digit code.",
        });
      }
      if (!verifyTotp(secret, totp)) {
        slog("platform_login_failed", { reason: "totp_enroll" });
        return fail(401, "That code didn't match — try the current code");
      }
      await confirmTotp(user.id);
      await clearThrottle(key);
      slog("platform_login", { user: user.id, enrolled: true });
      await audit({ actor: { kind: "operator", id: user.id }, action: "auth.operator_login", tenantId: null, diff: { enrolled: true } });
      return sessionResponse(user, request);
    }

    if (!totp) return fail(401, "Authenticator code required");
    const secret = await ensureTotpSecret(user.id);
    if (!verifyTotp(secret, totp)) {
      slog("platform_login_failed", { reason: "totp" });
      return fail(401, "Wrong authenticator code");
    }
    await clearThrottle(key);
    slog("platform_login", { user: user.id });
    await audit({ actor: { kind: "operator", id: user.id }, action: "auth.operator_login", tenantId: null });
    return sessionResponse(user, request);
  }

  // --- bootstrap / legacy shared-password path ---
  // S53 (audit A3): an operator-lookup FAILURE refuses the bootstrap path
  // (same response as "operators exist") — it never reads as "no operators".
  if (platformConfigured()) {
    let haveOperators = true;
    try {
      haveOperators = await operatorsExist();
    } catch {
      haveOperators = true;
    }
    if (haveOperators) {
      slog("platform_login_failed", { reason: "email_required" });
      return fail(401, "Sign in with your operator email, password and code");
    }
  }
  if (!platformAdminConfigured()) {
    return fail(503, "Platform console is not configured (set PLATFORM_ADMIN_PASSWORD)");
  }
  if (!(await checkPlatformPassword(password))) {
    slog("platform_login_failed", { reason: "credentials", method: "bootstrap" });
    return fail(401, "Wrong password");
  }
  slog("platform_login", { method: "bootstrap" });
  await audit({ actor: { kind: "bootstrap", id: "bootstrap" }, action: "auth.operator_login", tenantId: null, diff: { method: "bootstrap" } });
  const res = NextResponse.json({ ok: true, bootstrap: true });
  res.cookies.set(PLATFORM_COOKIE, await platformSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return res;
}
