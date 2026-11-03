import { db } from "@/lib/db";
import { siteUrl } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";
import { resolvedContentPageList, resolvedJournalEntries } from "@/lib/content/resolve";

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
  // S39: campaign pages are EXCLUDED (noindex, windowed). S46: journal posts
  // ARE listed at /journal/<slug> — but only once their publish window opens.
  // P2-READ (PERF-01): the posts come from resolvedJournalEntries(), which on
  // a documents store reads the journal index once (no per-post read) and on
  // a legacy store runs the same per-post loop as before.
  const all = (await resolvedContentPageList()).filter((p) => p.enabled);
  const pages = all.filter((p) => (p.family || "page") === "page");
  const journalPaths = (await resolvedJournalEntries()).map((p) => `/journal/${p.slug}`);
  const statics = [
    "/",
    "/collections",
    "/search",
    ...(journalPaths.length ? ["/journal"] : []),
    ...journalPaths,
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
