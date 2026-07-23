import { db } from "@/lib/db";
import { SITE_URL } from "@/lib/site";
import { POLICY_SLUGS } from "@/lib/content/pages";

// Full-catalog sitemap (Session 16): every product + collection from Turso,
// plus the content pages. Regenerated per request (catalog syncs mutate it).
export const dynamic = "force-dynamic";

export default async function sitemap() {
  const [products, collections] = await Promise.all([
    db.selectFrom("products").select(["handle", "updated_at"]).execute(),
    db.selectFrom("collections").select(["handle", "updated_at"]).execute(),
  ]);

  const statics = ["/", "/collections", "/search", "/about", "/contact", ...POLICY_SLUGS.map((s) => `/policies/${s}`)];

  return [
    ...statics.map((path) => ({
      url: `${SITE_URL}${path}`,
      changeFrequency: path === "/" ? "daily" : "weekly",
      priority: path === "/" ? 1 : 0.5,
    })),
    ...collections.map((c) => ({
      url: `${SITE_URL}/collections/${c.handle}`,
      lastModified: c.updated_at || undefined,
      changeFrequency: "weekly",
      priority: 0.7,
    })),
    ...products.map((p) => ({
      url: `${SITE_URL}/products/${p.handle}`,
      lastModified: p.updated_at || undefined,
      changeFrequency: "weekly",
      priority: 0.8,
    })),
  ];
}
