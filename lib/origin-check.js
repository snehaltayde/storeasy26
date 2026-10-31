// CSRF/origin guard (Session 26 / BE02). Cookie-authenticated mutation routes
// reject cross-origin browser requests: when an Origin header is present its
// host must match the request Host. Requests WITHOUT an Origin header pass —
// curl/server-to-server clients don't send one, and browsers always do on
// cross-site POSTs (the attack this guards). SameSite=lax cookies are the
// first line; this is the explicit server-side check the handoff requires.
// Plain-Node importable (no next/* imports) so the suite can test it.
// The origin the BROWSER is on, for building same-origin redirects. Tenants
// are host-resolved (pavos.localhost:3007, pavos.in, …), and Next's
// request.nextUrl reflects the server's BIND address (localhost:3007 in dev,
// the deployment host behind a proxy) — a redirect built from it leaves the
// tenant's origin, and a fetch() following that 302 dies on CORS ("Failed to
// fetch", found on the pavos console's Designer preview). Proto comes from
// x-forwarded-proto when a proxy supplies it (Vercel), else the request URL.
export function requestOrigin(request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return request.nextUrl?.origin || new URL(request.url).origin;
  const proto = request.headers.get("x-forwarded-proto") || (request.nextUrl?.protocol || new URL(request.url).protocol).replace(":", "");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // no Origin header: not a cross-site browser POST
  if (origin === "null") return false; // sandboxed/opaque origin
  try {
    const host = String(request.headers.get("host") || "").toLowerCase();
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
