import { NextResponse } from "next/server";
import { ADMIN_COOKIE, SUPPORT_COOKIE, verifyAdminToken } from "@/lib/admin-auth";
import { revokeSessionByToken, verifySession } from "@/lib/platform/sessions";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant } from "@/lib/tenant-context";
import { PREVIEW_COOKIE, endPreviewsAtLogout } from "@/lib/preview-sessions";
import { tenantHandler } from "@/lib/tenant-request";
import { sameOrigin } from "@/lib/origin-check";
import { MAINTENANCE_PASS_COOKIE } from "@/lib/maintenance";

export const runtime = "nodejs";

// The attributes /api/preview sets on the preview cookie (and the login
// route on _admin), so the browser replaces exactly that cookie.
const CLEAR = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 };

// Who this cookie belongs to, as requireAdmin would name them: a live merchant
// session, else the bootstrap (shared password) cookie, else nobody.
async function actorOf(token) {
  if (!token) return null;
  const s = await verifySession(token, "merchant");
  if (s) return { kind: "merchant", id: s.userId };
  if (await verifyAdminToken(token)) return { kind: "bootstrap", id: "bootstrap" };
  return null;
}

// P3-SESSION (drills finding 1): logout ends this person's previews on this
// store, on every device. lib/preview-sessions.js endPreviewsAtLogout never
// throws: a store before 0022 (no table), a host that resolved to no store, or
// a database error is logged as preview_logout_revoke_failed and the person
// is signed out all the same.
const endPreviews = (token) =>
  endPreviewsAtLogout({ storeResolved: !(platformConfigured() && !currentTenant()), resolveActor: () => actorOf(token) });

// allowUnresolved: logout always answers and always clears the cookies, even
// on a host that no longer resolves to a store.
export const POST = tenantHandler(
  async (request) => {
    if (!sameOrigin(request)) {
      return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
    }
    const token = request.cookies.get(ADMIN_COOKIE)?.value;
    // The actor is read BEFORE the session is revoked: after it, the token
    // no longer names anyone.
    await endPreviews(token);
    // S26: revoke the server-side session (no-op for legacy/bootstrap tokens),
    // then clear the cookies: the token is dead everywhere, not just here.
    await revokeSessionByToken(token);
    // Phase 3 line 5: an operator's support session on this host ends too
    // (revokeSessionByToken only ever matches the token it is given).
    await revokeSessionByToken(request.cookies.get(SUPPORT_COOKIE)?.value);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_COOKIE, "", CLEAR);
    res.cookies.set(SUPPORT_COOKIE, "", CLEAR);
    res.cookies.set(PREVIEW_COOKIE, "", CLEAR);
    res.cookies.set(MAINTENANCE_PASS_COOKIE, "", CLEAR);
    return res;
  },
  { allowUnresolved: true },
);
