import { NextResponse, after } from "next/server";
import { requireAdmin, ADMIN_COOKIE } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import {
  finishFounderConnect,
  CALLBACK_PATH,
  NONCE_COOKIE,
  tenantOrigin,
} from "@/lib/onboarding/connect";

// Phase 1 line 4: where Shopify sends the founder's browser back
// (settings.write through requireAdmin; a cross-site GET navigation, so the
// session cookie is SameSite=Lax and no Origin header is sent).
//   signed out → 401 page; staff, support → 403 page; no exchange in either
//   success → /admin/onboarding?step=import&connected=1
//   failure → /admin/onboarding?step=connect&connect_error=<code>
// The nonce cookie is cleared on every answer. lib/onboarding/connect.js
// finishFounderConnect does the checks in order; nothing is exchanged or
// stored before they pass.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const refusal = (status, words) =>
  new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Shopify not connected · Storeasy</title></head>` +
      `<body style="margin:0;background:#fafafa;color:#18181b;font-family:ui-sans-serif,system-ui,sans-serif;padding:48px 16px"><main style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:28px">` +
      `<h1 style="margin:0 0 8px;font-size:20px">Shopify wasn't connected</h1><p style="margin:0;font-size:14px;line-height:1.55;color:#52525b">${esc(words)}</p>` +
      `<p style="margin:20px 0 0"><a href="/admin/onboarding" style="color:#18181b;font-weight:600">Back to onboarding</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const clearNonce = (res) => {
  res.cookies.set(NONCE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: CALLBACK_PATH,
    maxAge: 0,
  });
  return res;
};

export const GET = tenantHandler(async (request) => {
  const started = Date.now();
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) {
    const words =
      auth.status === 401
        ? "Sign in to your store's console first, then press Connect again."
        : "Only the owner or an admin can connect Shopify.";
    return clearNonce(refusal(auth.status, words));
  }
  const origin = tenantOrigin(request);
  const url = request.nextUrl || new URL(request.url);
  let r;
  try {
    r = await finishFounderConnect({
      params: url.searchParams,
      search: url.search.slice(1),
      actor: auth.actor,
      adminCookie: request.cookies.get(ADMIN_COOKIE)?.value,
      nonce: request.cookies.get(NONCE_COOKIE)?.value,
      origin,
      defer: after,
      started,
    });
  } catch (e) {
    console.error(`[connect] founder callback: ${e?.message || e}`);
    r = { ok: false, code: "error" }; // an unknown code: the general words
  }
  const to = r.ok
    ? "/admin/onboarding?step=import&connected=1"
    : `/admin/onboarding?step=connect&connect_error=${encodeURIComponent(r.code)}`;
  return clearNonce(NextResponse.redirect(`${origin}${to}`, 303));
});
