import { NextResponse } from "next/server";
import { siteName, siteTagline } from "@/lib/site";
import { contentSource, contentGettersFor, closedSource } from "@/lib/content/resolve";
import { resolveBrand, accentShades } from "@/lib/brand";
import { tenantHandler } from "@/lib/tenant-request";

// Per-tenant PWA manifest (S36 / SF23 — replaces the static BeastLife file).
// Name and colors come from the tenant's LIVE release brand, so an installed
// app icon/splash matches whatever the storefront actually looks like.
//
// P6-FIX1 (PUB-06): a closed store's manifest says nothing about it beyond
// its name, as the closed metadata does (app/(storefront)/layout.js): while
// the store is closed the description is the neutral "Opening soon.", never
// the founder's tagline (the brand step asks for one before the store opens).
// "Closed" is isStoreClosed()'s own rule, closedSource() from
// lib/content/resolve.js (P6-FIX2: shared, not copied), asked of the same
// content source the brand comes from: a route handler runs outside React's
// cache(), so a second contentSource() call would pay a second pointer read
// (scripts/test-perf-docs.js pins one per call). A founder's preview of a
// closed store is closed too. When the source can't be read the route fails
// as it did before (the brand read needs it).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLOSED_DESCRIPTION = "Opening soon.";

export const GET = tenantHandler(async () => {
  const name = siteName();
  const src = await contentSource();
  const closed = closedSource(src);
  const brand = resolveBrand(await contentGettersFor(src).resolvedBrand());
  const accent = accentShades(brand.accent);
  return NextResponse.json(
    {
      name,
      short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
      description: closed ? CLOSED_DESCRIPTION : siteTagline() || `Shop ${name} — fast.`,
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
