import { NextResponse } from "next/server";
import { siteName, siteTagline } from "@/lib/site";
import { resolvedBrand } from "@/lib/content/resolve";
import { resolveBrand, accentShades } from "@/lib/brand";
import { tenantHandler } from "@/lib/tenant-request";

// Per-tenant PWA manifest (S36 / SF23 — replaces the static BeastLife file).
// Name and colors come from the tenant's LIVE release brand, so an installed
// app icon/splash matches whatever the storefront actually looks like.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async () => {
  const name = siteName();
  const brand = resolveBrand(await resolvedBrand());
  const accent = accentShades(brand.accent);
  return NextResponse.json(
    {
      name,
      short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
      description: siteTagline() || `Shop ${name} — fast.`,
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: brand.background,
      theme_color: accent[900],
      categories: ["shopping"],
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=300" } },
  );
});
