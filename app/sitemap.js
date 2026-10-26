import { db } from "@/lib/db";
import { siteUrl } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";
import { listContentPages } from "@/lib/cms/store";

// Full-catalog sitemap (Session 16): every product + collection from Turso,
// plus the content pages. Regenerated per request (catalog syncs mutate it).
export const dynamic = "force-dynamic";

// Tenant-scoped (S20): each host's sitemap lists ITS catalog on ITS origin,
// so the WHOLE body (queries + siteUrl() calls) runs inside the tenant scope.
export default function sitemap() {
  return tfetch(buildSitemap);
}

async function buildSitemap() {
  const [products, collections] = await Promise.all([
    db.selectFrom("products").select(["handle", "updated_at"]).execute(),
    db.selectFrom("collections").select(["handle", "updated_at"]).execute(),
  ]);

  // Content pages per tenant (S23): defaults + merchant-added, enabled only.
  const pages = (await listContentPages()).filter((p) => p.enabled);
  const statics = [
    "/",
    "/collections",
    "/search",
    ...pages.map((p) => (p.slug === "about" || p.slug === "contact" ? `/${p.slug}` : `/policies/${p.slug}`)),
  ];

  return [
    ...statics.map((path) => ({
      url: `${siteUrl()}${path}`,
      changeFrequency: path === "/" ? "daily" : "weekly",
      priority: path === "/" ? 1 : 0.5,
    })),
    ...collections.map((c) => ({
      url: `${siteUrl()}/collections/${c.handle}`,
      lastModified: c.updated_at || undefined,
      changeFrequency: "weekly",
      priority: 0.7,
    })),
    ...products.map((p) => ({
      url: `${siteUrl()}/products/${p.handle}`,
      lastModified: p.updated_at || undefined,
      changeFrequency: "weekly",
      priority: 0.8,
    })),
  ];
}
