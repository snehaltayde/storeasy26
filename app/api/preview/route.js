import { NextResponse } from "next/server";
import { verifyPreviewToken, readPreviewToken } from "@/lib/releases";
import { PREVIEW_COOKIE } from "@/lib/content/resolve";
import { tenantHandler } from "@/lib/tenant-request";
import { requestOrigin, sameOrigin } from "@/lib/origin-check";
import { setShowDesign } from "@/lib/preview-sessions";
import { slog } from "@/lib/log";

// The header the console's cookie fetch sends (documentsApi.js PREVIEW_CONFIRM_HEADER).
const PREVIEW_CONFIRM_HEADER = "x-storeasy-preview-confirm";

// Draft preview switch (S36 / BE09).
//   GET ?token=p.<exp>.<hmac>[&to=/path] → verify, set the preview cookie
//     (httpOnly, lifetime = the token's remaining life), redirect to `to`.
//   GET ?exit=1 → clear the cookie, back to the live release.
//   POST design=on|off[&to=/path] (P2-PREVIEW, the preview bar's "Show them")
//     → the session in THIS browser's cookie shows (or stops showing) the
//     design draft, then back to `to`. Only a session token counts; the cookie
//     is the authority (httpOnly, SameSite=lax, same-origin POST only).
// Cookie-based on purpose: preview content never hangs off a shareable URL
// that a cache or crawler could pick up — the token URL itself only ever
// 302s, and an invalid/expired token lands on the live site with no cookie.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The page the preview bar was on, when the browser says so and it is this host.
function sameHostPath(referer, host) {
  try {
    const u = new URL(referer);
    return host && u.host.toLowerCase() === String(host).toLowerCase() ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

// Where to send the browser: a path on THIS store, or the home page (P2-FIX4).
// The URL parser forgives a lot: "/\evil.com" reads as "//evil.com", tabs and
// newlines are dropped ("/\t/evil.com" too), and a server or proxy further on
// may decode "%2F" or "%5C". So a value is kept only when it is a plain
// root-relative path with no backslash, no control character, no encoded
// slash or backslash in its path part, and when the URL it resolves to is on
// this request's own origin. Anything else is "/". The GET answers with this
// redirect even for a bad token, so this is what stops the switch being an
// open redirect off the store's domain.
function destination(p, origin) {
  const home = new URL("/", origin);
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//")) return home;
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return home;
  const pathPart = p.split(/[?#]/, 1)[0];
  if (/%(?:2f|5c)/i.test(pathPart) || /%25/i.test(pathPart)) return home; // encoded "/" or "\", or an encoded "%" (double encoding)
  let u;
  try {
    u = new URL(p, origin);
  } catch {
    return home;
  }
  return u.origin === home.origin ? u : home;
}

export const GET = tenantHandler(async (request) => {
  const params = request.nextUrl.searchParams;
  // Host-header origin, NOT nextUrl.origin: tenant hosts (pavos.localhost,
  // custom domains) otherwise get bounced to the server's bind address — a
  // cross-origin 302 that kills the console's cookie-mint fetch with CORS.
  const dest = destination(params.get("to"), requestOrigin(request));

  if (params.get("exit")) {
    const res = NextResponse.redirect(dest, 302);
    res.cookies.set(PREVIEW_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  }

  // P3-FIX1: the new editor's cookie fetch (components/admin/editor/
  // documentsApi.js) sends this header and gets a JSON answer it can check,
  // instead of a redirect it would have to follow to the home page. Without
  // the header (a link, the legacy Designer) the answers are unchanged.
  const confirm = request.headers.get(PREVIEW_CONFIRM_HEADER) === "1";
  const token = params.get("token") || "";
  if (!(await verifyPreviewToken(token))) {
    if (confirm) {
      return NextResponse.json(
        { error: "This preview link has expired or isn't valid, so the preview didn't open. Close it and open the preview again.", code: "PREVIEW_TOKEN_REFUSED" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    // expired or forged → live site, no cookie, no hint
    return NextResponse.redirect(dest, 302);
  }
  const exp = Number(token.split(".")[1]) * 1000;
  const res = confirm ? NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } }) : NextResponse.redirect(dest, 302);
  res.cookies.set(PREVIEW_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.max(60, Math.floor((exp - Date.now()) / 1000)),
  });
  return res;
});

export const POST = tenantHandler(async (request) => {
  const form = await request.formData().catch(() => null);
  const dest = destination(form?.get("to") || sameHostPath(request.headers.get("referer"), request.headers.get("host")), requestOrigin(request));
  if (!sameOrigin(request)) return new NextResponse("Cross-origin request rejected", { status: 403 });
  const parsed = await readPreviewToken(request.cookies.get(PREVIEW_COOKIE)?.value || "");
  if (!parsed?.sid) return NextResponse.redirect(dest, 303); // no session preview here: nothing to change
  try {
    await setShowDesign({ sid: parsed.sid, on: form?.get("design") === "on" });
  } catch (e) {
    slog("preview_design_toggle_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return new NextResponse("We couldn't change your preview just now, so it didn't change. Go back and try again. (PREVIEW_TOGGLE_FAILED)", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.redirect(dest, 303);
});
