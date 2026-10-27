import { NextResponse, after } from "next/server";
import { getTenant, patchTenant } from "@/lib/platform/control.js";
import { verifyState, verifyOAuthCallbackHmac, missingScopes } from "@/lib/platform/oauth.js";
import { sendAlert } from "@/lib/alerts";
import { registerWebhooks } from "@/lib/platform/shopify-webhooks.js";
import { exchangeCodeForToken } from "@/lib/shopify-admin.js";
import { withTenant } from "@/lib/tenant-context.js";
import { syncTenantCatalog } from "@/lib/sync.js";
import { slog } from "@/lib/log";

// Shopify OAuth callback (Session 21). NOT operator-gated — Shopify redirects
// the merchant's browser here. Security: the HMAC-signed state names the
// tenant, Shopify's own hmac param is verified with THAT tenant's app secret,
// and the shop param must match the tenant's configured store. On success the
// permanent Admin token is stored encrypted, webhooks are registered, and the
// initial catalog sync starts after the response.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const page = (title, body, ok = true) =>
  new NextResponse(
    `<html><body style="font-family:system-ui;background:#0a0a0b;color:#fff;text-align:center;padding-top:18vh">` +
      `<h2 style="color:${ok ? "#a3e635" : "#f87171"}">${title}</h2><p>${body}</p></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html" } },
  );

export async function GET(request) {
  const params = request.nextUrl.searchParams;

  const state = verifyState(params.get("state"));
  if (!state) return page("Authorization failed", "Invalid or expired state — restart the connect flow.", false);

  const tenant = await getTenant(state.tenantId);
  if (!tenant) return page("Authorization failed", `Unknown tenant "${state.tenantId}".`, false);
  if (tenant.status !== "active") return page("Authorization failed", "This store is suspended.", false);

  const clientSecret = tenant.secrets?.shopify_client_secret;
  if (!clientSecret) return page("Authorization failed", "Tenant has no app client secret configured.", false);
  if (!verifyOAuthCallbackHmac(request.nextUrl.search.slice(1), clientSecret))
    return page("Authorization failed", "HMAC verification failed.", false);

  const shop = (params.get("shop") || "").toLowerCase();
  const expected = String(tenant.config?.shopify_store_domain || "").toLowerCase();
  if (!shop || shop !== expected)
    return page("Authorization failed", `Shop mismatch: got "${shop}", expected "${expected}".`, false);

  const code = params.get("code");
  if (!code) return page("Authorization failed", "No authorization code in the callback.", false);

  try {
    // exchangeCodeForToken reads the store domain + app creds from tenant context.
    const tok = await withTenant(tenant, () => exchangeCodeForToken(code));
    await patchTenant(tenant.id, {
      secrets: { shopify_admin_token: tok.access_token },
      config: {
        shopify_scopes: tok.scope || null,
        shopify_connected_at: new Date().toISOString(),
        shopify_app_uninstalled_at: null, // a reconnect clears the uninstall flag
      },
    });
    slog("shopify_connected", { tenant: tenant.id, shop, scopes: tok.scope });

    // S30 (BE25): scope check at mint time — a partial grant is a loud warning
    // now instead of a mystery failure later (e.g. orderCancel sans write_orders).
    const missing = missingScopes(tok.scope);
    if (missing.length) {
      await sendAlert(
        `Shopify token for ${tenant.id} is missing scope(s): ${missing.join(", ")} — re-run the connect flow after fixing the app's scopes`,
        { tenant: tenant.id, shop, missing },
        { severity: "warn" },
      );
    }

    // Webhooks need a publicly reachable https URL — on localhost this fails
    // harmlessly (register later with `pnpm webhooks:register <slug>`).
    const platformUrl = process.env.PLATFORM_URL || request.nextUrl.origin;
    let webhooks = "skipped (no https platform URL)";
    if (platformUrl.startsWith("https://")) {
      const fresh = await getTenant(tenant.id);
      const results = await registerWebhooks(fresh, { callbackUrl: `${platformUrl}/api/shopify/webhooks` }).catch(
        (e) => ({ error: String(e?.message || e) }),
      );
      webhooks = Array.isArray(results)
        ? `${results.filter((r) => r.status !== "error").length}/${results.length} registered`
        : `failed: ${results.error}`;
    }

    // Initial catalog pull — best-effort here (big catalogs: pnpm tenant:sync).
    after(async () => {
      const fresh = await getTenant(tenant.id);
      await syncTenantCatalog(fresh).then(
        (r) => slog("initial_sync_done", { tenant: tenant.id, products: r.products, collections: r.collections }),
        (e) => console.error(`[connect] initial sync failed for ${tenant.id}: ${e?.message || e}`),
      );
    });

    return page(
      "✓ Store connected",
      `Admin token saved for tenant <b>${tenant.id}</b>. Webhooks: ${webhooks}. Initial catalog sync is running — close this tab.` +
        (missing.length
          ? `<br><br>⚠️ The token is MISSING scope(s): <b>${missing.join(", ")}</b> — some features will fail until the app's scopes are fixed and this flow is re-run.`
          : ""),
    );
  } catch (e) {
    console.error(`[connect] ${tenant.id}: ${e?.message || e}`);
    return page("Authorization failed", String(e?.message || e), false);
  }
}
