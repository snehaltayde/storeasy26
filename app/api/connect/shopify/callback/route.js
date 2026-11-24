import { NextResponse, after } from "next/server";
import { getTenant } from "@/lib/platform/control.js";
import { verifyState, verifyOAuthCallbackHmac } from "@/lib/platform/oauth.js";
import { completeConnection } from "@/lib/platform/shopify-connect.js";

// Shopify OAuth callback (Session 21). NOT operator-gated — Shopify redirects
// the merchant's browser here. Security: the HMAC-signed state names the
// tenant, Shopify's own hmac param is verified with THAT tenant's app secret,
// and the shop param must match the tenant's configured store. On success the
// permanent Admin token is stored encrypted, webhooks are registered, and the
// first catalog sync is QUEUED (GEN-02): a recorded, resumable run whose
// first slice starts after the response and whose rest the queue finishes —
// any catalog size, no CLI step. Phase 1 line 4: the exchange and storage are
// lib/platform/shopify-connect.js (shared with the founder flow, so this flow
// gets expiring tokens too), and only an operator ("op") state is taken here:
// a founder's state is refused, as the founder callback refuses this one.
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
  const started = Date.now();
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
    const { scope, missing, webhooks, syncQueued } = await completeConnection({
      tenant,
      code,
      shop,
      platformUrl: process.env.PLATFORM_URL || request.nextUrl.origin,
      defer: after,
      started,
    });
    const tok = { scope };

    const firstDomain = (tenant.domains || [])[0];
    const storeOrigin = firstDomain
      ? `${/(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(firstDomain) ? "http" : "https"}://${firstDomain}`
      : null;
    return page({
      ok: true,
      title: "Store connected",
      lead:
        `<b>${esc(tenant.name)}</b> is now linked to <span style="font-family:ui-monospace,monospace;font-size:13px">${esc(shop)}</span>. ` +
        (syncQueued
          ? "Your products are on their way in. The store console shows how far along it is."
          : "Your products haven't started coming in yet. Open the store console and press Bring in products."),
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
