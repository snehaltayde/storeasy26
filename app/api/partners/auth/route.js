import { NextResponse } from "next/server";
import { findUserByEmail, verifyPassword, loginThrottle, clearThrottle, consumeInvite, createUser } from "@/lib/platform/identity";
import { createSession, verifySession, MERCHANT_SESSION_TTL_MS } from "@/lib/platform/sessions";
import { agencyFromToken, addAgencyMember, AGENCY_COOKIE } from "@/lib/platform/agency";
import { platformDb, platformConfigured } from "@/lib/platform/control";
import { sameOrigin } from "@/lib/origin-check";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";

// Agency sign-in (S48 / BE28). Individual accounts (same identity store as
// merchants/operators, scrypt + revocable sessions), authorized via agency
// MEMBERSHIP — a user with no agency_members row has no agency session, and
// an agency session never passes merchant or operator checks (session kind).
//   POST {action:"login", email, password}
//   POST {action:"logout"}
//   POST {action:"accept_invite", token, name, password}  (agency-member invite)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" };
const fail = (status, error) => NextResponse.json({ error }, { status });

export async function POST(request) {
  if (!sameOrigin(request)) return fail(403, "Cross-origin request rejected");
  if (!platformConfigured()) return fail(503, "The partner console needs the platform control plane");
  const limited = rateLimit(request, { name: "partners_auth", limit: 10 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));

  if (body.action === "logout") {
    const token = request.cookies.get(AGENCY_COOKIE)?.value;
    const s = await verifySession(token, "agency");
    if (s) await platformDb().execute({ sql: "UPDATE sessions SET revoked_at = ? WHERE id = ?", args: [new Date().toISOString(), s.sessionId] });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(AGENCY_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
    return res;
  }

  if (body.action === "accept_invite") {
    // operator-issued agency-member invite (kind "agency-member", role
    // carries "agency-member:<agencyId>") → user created + membership
    const invite = await consumeInvite(String(body.token || ""), { kind: "agency-member" });
    const m = /^agency-member:(agc_[0-9a-f]+)$/.exec(invite?.role || "");
    if (!invite || !m) return fail(422, "That invitation is expired, used, or not an agency invitation");
    if (typeof body.password !== "string" || body.password.length < 10) return fail(422, "Password: at least 10 characters");
    let user = await findUserByEmail(invite.email);
    if (!user) user = await createUser({ email: invite.email, name: String(body.name || "").slice(0, 120) || null, password: body.password });
    await addAgencyMember(m[1], user.id, "member");
    slog("agency_member_joined", { agency: m[1] });
    return NextResponse.json({ ok: true, email: invite.email });
  }

  if (body.action === "login") {
    const email = String(body.email || "").toLowerCase();
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    for (const key of [`agency-login:${email}`, `agency-login-ip:${ip}`]) {
      const { blocked } = await loginThrottle(key);
      if (blocked) return fail(429, "Too many attempts — try again later");
    }
    const user = await findUserByEmail(email);
    const okPassword = user && user.status === "active" && (await verifyPassword(String(body.password || ""), user.password_hash));
    if (!okPassword) {
      slog("agency_login_failed", { reason: "credentials" });
      return fail(401, "Wrong email or password");
    }
    const member = await platformDb().execute({ sql: "SELECT agency_id FROM agency_members WHERE user_id = ?", args: [user.id] });
    if (!member.rows[0]) {
      slog("agency_login_failed", { reason: "no_agency" });
      return fail(401, "Wrong email or password"); // enumeration-safe
    }
    const { token } = await createSession({ userId: user.id, kind: "agency", ttlMs: MERCHANT_SESSION_TTL_MS, ip, ua: request.headers.get("user-agent")?.slice(0, 200) || null });
    await clearThrottle(`agency-login:${email}`);
    const actor = await agencyFromToken(token);
    if (!actor) return fail(403, "This agency is suspended");
    slog("agency_login", { agency: actor.agency.id });
    const res = NextResponse.json({ ok: true, agency: actor.agency.name });
    res.cookies.set(AGENCY_COOKIE, token, { ...COOKIE_OPTS, maxAge: MERCHANT_SESSION_TTL_MS / 1000 });
    return res;
  }

  return fail(400, "unknown action");
}
