import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin, ADMIN_COOKIE } from "@/lib/admin-auth";
import { requestOrigin } from "@/lib/origin-check";
import { tenantHandler } from "@/lib/tenant-request";
import { withTenant, tenantId } from "@/lib/tenant-context";
import { getTenant } from "@/lib/platform/control";
import { ConnectError } from "@/lib/platform/shopify-connect";
import { startFounderConnect, CALLBACK_PATH, NONCE_COOKIE } from "@/lib/onboarding/connect";
import { onboardingFor } from "@/lib/onboarding/service";
import { connectErrorWords } from "@/lib/onboarding/connect-words";

// Phase 1 line 4: onboarding step 1's Connect (settings.write).
//   POST { shop } → saves the shop domain while it isn't locked, then
//     200 { ok, appReady: false, ...the onboarding model }   the app isn't set up yet
//     200 { ok, appReady: true, authorizeUrl }               + the nonce cookie
//         (httpOnly, SameSite=Lax, the callback's path only, 10 minutes)
//     422/409 { error, code }                                nothing saved
// The store is the request's host; nothing here calls Shopify.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS = { locked: 409, other_store: 409, suspended: 409 };

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    const origin = requestOrigin(request);
    const r = await startFounderConnect({ actor: auth.actor, shopInput: body?.shop, origin, adminCookie: request.cookies.get(ADMIN_COOKIE)?.value });
    if (!r.appReady) {
      const fresh = await getTenant(tenantId(), { fresh: true });
      return NextResponse.json({ ok: true, appReady: false, ...(await withTenant(fresh, () => onboardingFor(auth.actor))) });
    }
    const res = NextResponse.json({ ok: true, appReady: true, authorizeUrl: r.authorizeUrl });
    res.cookies.set(NONCE_COOKIE, r.nonce, { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https://"), path: CALLBACK_PATH, maxAge: 600 });
    return res;
  } catch (e) {
    if (e instanceof ConnectError) {
      const words = e.message && e.message !== e.code ? e.message : connectErrorWords(e.code);
      return NextResponse.json({ error: words, code: e.code }, { status: STATUS[e.code] || 422 });
    }
    const infra = infraResponse(e, { route: "admin/shopify/connect" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    throw e;
  }
});
