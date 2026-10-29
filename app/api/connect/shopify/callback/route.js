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

// The connect result page (restyled S51): the one route a merchant's browser
// lands on outside the app shell, so it carries the console design language
// inline — and always offers a way back instead of "close this tab".
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ICONS = {
  ok: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  fail: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
};

// rows: [label, html] pairs · actions: [{href, label, primary}]
function page({ ok, title, lead, rows = [], warn = null, actions = [] }) {
  const detailRows = rows
    .map(
      ([k, v]) =>
        `<div style="display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-top:1px solid #f4f4f5"><span style="color:#71717a;white-space:nowrap">${esc(k)}</span><span style="color:#18181b;text-align:right;overflow-wrap:anywhere">${v}</span></div>`,
    )
    .join("");
  const buttons = actions
    .map(({ href, label, primary }) =>
      primary
        ? `<a href="${esc(href)}" style="display:inline-block;background:#18181b;color:#fff;border-radius:6px;padding:9px 16px;font-size:13px;font-weight:600;text-decoration:none">${esc(label)}</a>`
        : `<a href="${esc(href)}" style="display:inline-block;background:#fff;color:#18181b;border:1px solid #d4d4d8;border-radius:6px;padding:8px 15px;font-size:13px;font-weight:500;text-decoration:none">${esc(label)}</a>`,
    )
    .join(`<span style="display:inline-block;width:8px"></span>`);
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Storeasy</title></head>` +
      `<body style="margin:0;background:#fafafa;color:#18181b;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px">` +
      `<main style="width:100%;max-width:440px">` +
      `<div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05);padding:28px">` +
      `<div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:999px;background:${ok ? "#ecfdf5" : "#fef2f2"}">${ICONS[ok ? "ok" : "fail"]}</div>` +
      `<h1 style="margin:14px 0 6px;font-size:20px;font-weight:600;letter-spacing:-.01em">${esc(title)}</h1>` +
      `<p style="margin:0;font-size:14px;line-height:1.55;color:#52525b">${lead}</p>` +
      (detailRows ? `<div style="margin-top:16px;font-size:13px">${detailRows}</div>` : "") +
      (warn
        ? `<div style="margin-top:16px;border:1px solid #fde68a;background:#fffbeb;border-radius:6px;padding:10px 12px;font-size:13px;line-height:1.5;color:#92400e">${warn}</div>`
        : "") +
      (buttons ? `<div style="margin-top:22px">${buttons}</div>` : "") +
      `</div>` +
      `<p style="margin:14px 4px 0;font-size:12px;color:#a1a1aa">Store console · powered by Store<b style="color:#52525b">asy</b></p>` +
      `</main></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html" } },
  );
}

const failPage = (reason) =>
  page({
    ok: false,
    title: "Connection failed",
    lead: esc(reason),
    actions: [
      { href: "/platform", label: "Back to platform", primary: true },
    ],
  });

export async function GET(request) {
  const params = request.nextUrl.searchParams;

  const state = verifyState(params.get("state"));
  if (!state) return failPage("Invalid or expired state — restart the connect flow from the platform console.");

  const tenant = await getTenant(state.tenantId);
  if (!tenant) return failPage(`Unknown tenant "${state.tenantId}".`);
  if (tenant.status !== "active") return failPage("This store is suspended.");

  const clientSecret = tenant.secrets?.shopify_client_secret;
  if (!clientSecret) return failPage("Tenant has no app client secret configured.");
  if (!verifyOAuthCallbackHmac(request.nextUrl.search.slice(1), clientSecret))
    return failPage("HMAC verification failed.");

  const shop = (params.get("shop") || "").toLowerCase();
  const expected = String(tenant.config?.shopify_store_domain || "").toLowerCase();
  if (!shop || shop !== expected)
    return failPage(`Shop mismatch: got "${shop}", expected "${expected}".`);

  const code = params.get("code");
  if (!code) return failPage("No authorization code in the callback.");

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

    const firstDomain = (tenant.domains || [])[0];
    const storeOrigin = firstDomain
      ? `${/(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(firstDomain) ? "http" : "https"}://${firstDomain}`
      : null;
    return page({
      ok: true,
      title: "Store connected",
      lead: `<b>${esc(tenant.name)}</b> is now linked to <span style="font-family:ui-monospace,monospace;font-size:13px">${esc(shop)}</span>. The first catalog sync is running in the background.`,
      rows: [
        ["Admin token", `<span style="color:#059669;font-weight:600">saved</span>`],
        ["Webhooks", esc(webhooks)],
        ["Scopes", `${tok.scope ? esc(tok.scope.split(",").length) : 0} granted`],
      ],
      warn: missing.length
        ? `The token is missing scope(s): <b>${esc(missing.join(", "))}</b> — some features will fail until the app's scopes are fixed and this flow is re-run.`
        : null,
      actions: [
        { href: "/platform", label: "Back to platform", primary: true },
        ...(storeOrigin ? [{ href: `${storeOrigin}/admin`, label: "Open store console" }] : []),
      ],
    });
  } catch (e) {
    console.error(`[connect] ${tenant.id}: ${e?.message || e}`);
    return failPage(String(e?.message || e));
  }
}
