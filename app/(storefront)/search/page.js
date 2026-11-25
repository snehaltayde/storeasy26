import Link from "next/link";
import { redirect } from "next/navigation";
import ProductGrid from "@/components/ProductGrid";
import TrackEvent from "@/components/analytics/TrackEvent";
import SearchResults from "@/components/analytics/SearchResults";
import FacetRail from "@/components/search/FacetRail";
import FacetSheet from "@/components/search/FacetSheet";
import ActiveFilters from "@/components/search/ActiveFilters";
import SearchSort from "@/components/search/SearchSort";
import { numericId } from "@/lib/ids";
import { parseFacetParams, activeCount, facetHref, facetParams, clearedFilters, PER_PAGE } from "@/lib/catalog/facets";
import { runFacetSearch } from "@/lib/catalog/facet-search";
import { tfetch } from "@/lib/storefront-request";

export const dynamic = "force-dynamic";

// P7-FACETS: a filtered search page is not indexed (the plain query page is).
export async function generateMetadata({ searchParams }) {
  const s = parseFacetParams(await searchParams);
  return { title: s.q ? `Search: ${s.q}` : "Search", ...(activeCount(s) ? { robots: { index: false, follow: true } } : {}) };
}

// numbered links: the first, the last, and two either side of this page
function pageList(page, pages) {
  const out = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 2) out.push(n);
    else if (out[out.length - 1] !== "…") out.push("…");
  }
  return out;
}

const plural = (n) => `${n} ${n === 1 ? "product" : "products"}`;

export default async function SearchPage({ searchParams }) {
  const s = parseFacetParams(await searchParams);
  const filters = activeCount(s);
  const ran = s.q.length >= 2 || filters > 0;
  const result = ran ? await tfetch(() => runFacetSearch(s)) : null;
  const found = result?.found ?? 0;

  const products = (result?.hits ?? []).map((h) => ({
    handle: h.handle,
    title: h.title,
    // P4-EFFECTIVE (OVL-05): the card's type label is the display type
    display_type: h.display_type,
    featured_image: h.image,
    price_min: h.price,
    currency: h.currency,
    available: h.available,
  }));
  const pages = Math.max(1, Math.ceil(found / PER_PAGE));
  // paged past the end (an old link, a hand-typed page): the last page
  if (result && found > 0 && !result.hits.length && s.page > pages) redirect(facetHref(s, { page: pages }));
  const labels = Object.fromEntries((result?.groups ?? []).filter((g) => g.key.startsWith("o:")).map((g) => [g.key.slice(2), g.title]));
  const rail = (idPrefix) => (result ? <FacetRail state={s} groups={result.groups} price={result.price} full={result.full} idPrefix={idPrefix} /> : null);
  const keepForSort = [...facetParams({ ...s, sort: "relevance", page: 1 })];

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      {ran ? <TrackEvent name="search" data={{ params: { search_term: s.q, results: found, filters } }} /> : null}
      <h1 className="text-2xl font-bold tracking-tight">
        {s.q ? (
          <>
            Results for “<span className="text-sf-accent-text">{s.q}</span>”
          </>
        ) : (
          "Search"
        )}
      </h1>
      {ran ? (
        <p className="mt-1 text-sm text-sf-text-faint" data-search-count>
          {plural(found)}
        </p>
      ) : null}

      {!ran ? (
        <p className="mt-8 text-sf-text-subtle">Type at least 2 characters to search.</p>
      ) : (
        <div className="mt-6 lg:grid lg:grid-cols-[15rem_1fr] lg:gap-10">
          <aside className="hidden lg:block" aria-label="Filters">
            {rail("r")}
          </aside>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="lg:hidden">
                <FacetSheet active={filters} total={found}>
                  {rail("s")}
                </FacetSheet>
              </div>
              <div className="ml-auto">
                <SearchSort sort={s.sort} keep={keepForSort} />
              </div>
            </div>
            <noscript>
              <div className="mt-4 lg:hidden">{rail("n")}</div>
            </noscript>
            <div className="mt-4">
              <ActiveFilters state={s} labels={labels} />
            </div>

            <div className="mt-6">
              {products.length === 0 ? (
                <div className="rounded-sf-card border border-sf-border bg-sf-surface-muted p-8 text-center" data-search-empty>
                  {filters ? (
                    <>
                      <p className="font-medium text-sf-text-body">No products match these filters.</p>
                      <Link href={facetHref(clearedFilters(s))} className="mt-3 inline-block text-sm text-sf-accent-text hover:underline">
                        Clear all filters
                      </Link>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-sf-text-body">No products match “{s.q}”.</p>
                      <Link href="/collections" className="mt-3 inline-block text-sm text-sf-accent-text hover:underline">
                        Browse all collections →
                      </Link>
                    </>
                  )}
                </div>
              ) : (
                <SearchResults
                  query={s.q}
                  items={products.map((p, i) => ({
                    handle: p.handle,
                    id: numericId(p.id) || p.handle,
                    title: p.title,
                    price: p.price_min,
                    position: (s.page - 1) * PER_PAGE + i + 1,
                  }))}
                >
                  <ProductGrid products={products} priorityCount={4} />
                </SearchResults>
              )}
            </div>

            {pages > 1 ? (
              <nav aria-label="Pages" className="mt-10 flex flex-wrap items-center justify-center gap-1" data-search-pages>
                {pageList(s.page, pages).map((n, i) =>
                  n === "…" ? (
                    <span key={`gap-${i}`} className="px-2 text-sf-text-faint">
                      …
                    </span>
                  ) : (
                    <Link
                      key={n}
                      href={facetHref(s, { page: n })}
                      aria-current={n === s.page ? "page" : undefined}
                      className={`min-w-9 rounded-sf-small px-3 py-1.5 text-center text-sm tabular-nums ${n === s.page ? "bg-sf-inverse text-sf-on-inverse" : "text-sf-text-soft hover:bg-sf-surface-muted"}`}
                    >
                      {n}
                    </Link>
                  ),
                )}
              </nav>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
