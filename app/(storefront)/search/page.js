import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import TrackEvent from "@/components/analytics/TrackEvent";
import SearchResults from "@/components/analytics/SearchResults";
import { numericId } from "@/lib/ids";
import { typesenseSearch } from "@/lib/typesense-search";
import { searchProductsInDb, displayHits } from "@/lib/repo";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }) {
  const sp = await searchParams;
  const q = (sp?.q || "").trim();
  return { title: q ? `Search: ${q}` : "Search" };
}

async function runSearch(q) {
  try {
    const ts = await typesenseSearch(q, { limit: 36 });
    if (ts) return displayHits(ts);
  } catch {
    /* fall back */
  }
  return searchProductsInDb(q, 36);
}

export default async function SearchPage({ searchParams }) {
  const sp = await searchParams;
  const q = (sp?.q || "").trim();
  const result = q.length >= 2 ? await tfetch(() => runSearch(q)) : { hits: [], found: 0, source: "none" };

  const products = result.hits.map((h) => ({
    handle: h.handle,
    title: h.title,
    // P4-EFFECTIVE (OVL-05): the card's type label is the display type
    display_type: h.display_type,
    featured_image: h.image,
    price_min: h.price,
    currency: h.currency,
    available: h.available,
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      {q ? (
        <TrackEvent name="search" data={{ params: { search_term: q, results: products.length } }} />
      ) : null}
      <h1 className="text-2xl font-bold tracking-tight">
        {q ? (
          <>
            Results for “<span className="text-sf-accent-text">{q}</span>”
          </>
        ) : (
          "Search"
        )}
      </h1>
      {q ? (
        <p className="mt-1 text-sm text-sf-text-faint">
          {products.length} {products.length === 1 ? "product" : "products"}
        </p>
      ) : null}

      <div className="mt-8">
        {!q ? (
          <p className="text-sf-text-subtle">Type at least 2 characters to search.</p>
        ) : products.length === 0 ? (
          <div className="rounded-sf-card border border-sf-border bg-sf-surface-muted p-8 text-center">
            <p className="font-medium text-sf-text-body">No products match “{q}”.</p>
            <Link
              href="/collections"
              className="mt-3 inline-block text-sm text-sf-accent-text hover:underline"
            >
              Browse all collections →
            </Link>
          </div>
        ) : (
          <SearchResults
            query={q}
            items={products.map((p, i) => ({
              handle: p.handle,
              id: numericId(p.id) || p.handle,
              title: p.title,
              price: p.price_min,
              position: i + 1,
            }))}
          >
            <ProductGrid products={products} priorityCount={4} />
          </SearchResults>
        )}
      </div>
    </div>
  );
}
