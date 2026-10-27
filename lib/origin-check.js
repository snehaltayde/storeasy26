// CSRF/origin guard (Session 26 / BE02). Cookie-authenticated mutation routes
// reject cross-origin browser requests: when an Origin header is present its
// host must match the request Host. Requests WITHOUT an Origin header pass —
// curl/server-to-server clients don't send one, and browsers always do on
// cross-site POSTs (the attack this guards). SameSite=lax cookies are the
// first line; this is the explicit server-side check the handoff requires.
// Plain-Node importable (no next/* imports) so the suite can test it.
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
