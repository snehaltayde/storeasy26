import { NextResponse } from "next/server";
import { getTenant } from "@/lib/platform/control.js";
import { signState, buildAuthorizeUrl } from "@/lib/platform/oauth.js";

// Start the per-tenant Shopify OAuth connect flow (Session 21).
//   GET /api/connect/shopify/start?tenant=<slug>&secret=<CRON_SECRET>
// Operator-gated (v1 is hand-onboarding): resolves the tenant by SLUG — not by
// Host, since the operator drives this from the platform host — and redirects
// to the tenant's custom-distribution app authorize URL. The callback route
// verifies the signed state, so this endpoint stores nothing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // local dev
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}` || request.nextUrl.searchParams.get("secret") === secret;
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const slug = request.nextUrl.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "tenant query param required" }, { status: 400 });

  const tenant = await getTenant(slug);
  if (!tenant) return NextResponse.json({ error: `unknown tenant "${slug}"` }, { status: 404 });

  const shopDomain = tenant.config?.shopify_store_domain;
  const clientId = tenant.config?.shopify_client_id;
  if (!shopDomain || !clientId || !tenant.secrets?.shopify_client_secret) {
    return NextResponse.json(
      { error: "tenant is missing shopify_store_domain / shopify_client_id / shopify_client_secret — provision first" },
      { status: 409 },
    );
  }

  const redirectUri = `${request.nextUrl.origin}/api/connect/shopify/callback`;
  const url = buildAuthorizeUrl({ shopDomain, clientId, redirectUri, state: signState(slug) });
  return NextResponse.redirect(url, 302);
}
