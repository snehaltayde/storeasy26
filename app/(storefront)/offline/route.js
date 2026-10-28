import { siteName } from "@/lib/site";
import { resolvedBrand } from "@/lib/content/resolve";
import { resolveBrand, accentShades } from "@/lib/brand";
import { tenantHandler } from "@/lib/tenant-request";

// Branded offline shell (S36 / SF23 — replaces static offline.html). The
// service worker precaches THIS route at install, so each tenant's origin
// caches its own name and colors. Deliberately self-contained (inline CSS,
// no app chunks): it must render with the network fully gone.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const GET = tenantHandler(async () => {
  const name = esc(siteName());
  const brand = resolveBrand(await resolvedBrand());
  const accent = accentShades(brand.accent);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Offline · ${name}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:${brand.foreground}; color:#fff; font-family:system-ui,-apple-system,sans-serif; text-align:center; }
  .wrap { padding:2rem; }
  .brand { color:${accent[400]}; font-weight:800; letter-spacing:0.02em; font-size:1.1rem; }
  h1 { font-size:1.5rem; margin:0.75rem 0 0.5rem; }
  p { color:#a1a1aa; margin:0; }
  button { margin-top:1.5rem; background:${accent[400]}; color:${brand.accent_label || "#0a0a0b"}; border:0;
           padding:0.75rem 1.5rem; border-radius:9999px; font-weight:700; font-size:0.9rem; cursor:pointer; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">${name}</div>
    <h1>You're offline</h1>
    <p>Check your connection — your cart is safe and waiting.</p>
    <button onclick="location.reload()">Try again</button>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
});
