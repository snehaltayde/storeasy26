import Link from "next/link";
import { notFound } from "next/navigation";
import ProductGrid from "@/components/ProductGrid";
import CollectionControls from "@/components/CollectionControls";
import TrackEvent from "@/components/analytics/TrackEvent";
import { getCollectionByHandle, getProductsInCollection, getCollectionTypeFacets, COLLECTION_SORTS } from "@/lib/repo";
import { numericId } from "@/lib/ids";
import { abs } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 48;
const pageNum = (sp) => Math.max(1, Number(sp?.page) || 1);

// S38 (SF03): sort + filters are URL-backed (?sort=&type=&instock=1&page=) so
// back/forward, reload and shared links restore the exact view.
function readParams(sp) {
  const sort = COLLECTION_SORTS.includes(sp?.sort) ? sp.sort : "featured";
  const type = typeof sp?.type === "string" ? sp.type.slice(0, 80) : "";
  const inStock = sp?.instock === "1";
  return { sort, type, inStock };
}

const qs = (handle, { sort, type, inStock, page }) => {
  const p = new URLSearchParams();
  if (sort && sort !== "featured") p.set("sort", sort);
  if (type) p.set("type", type);
  if (inStock) p.set("instock", "1");
  if (page && page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/collections/${handle}?${s}` : `/collections/${handle}`;
};

export async function generateMetadata({ params, searchParams }) {
  const { handle } = await params;
  const page = pageNum(await searchParams);
  const c = await tfetch(() => getCollectionByHandle(handle));
  // Real 404 status must come from metadata — the loading boundary commits
  // a 200 before the page body can call notFound().
  if (!c) notFound();
  return {
    title: page > 1 ? `${c.title} — page ${page}` : c.title,
    description: c.description ? c.description.slice(0, 160) : undefined,
    // canonical ignores filters/sort — they're views of the same list
    alternates: { canonical: page > 1 ? `/collections/${handle}?page=${page}` : `/collections/${handle}` },
  };
}

export default async function CollectionPage({ params, searchParams }) {
  const { handle } = await params;
  const sp = await searchParams;
  const page = pageNum(sp);
  const filters = readParams(sp);
  const collection = await tfetch(() => getCollectionByHandle(handle));
  if (!collection) notFound();

  const { products, total, facets, template } = await tfetch(async () => {
    // S53 (0B-2): pin order is release-gated — the resolver supplies the
    // frozen pins in live mode, the draft table in preview/pre-publish.
    const { resolvedCollectionPins, resolvedSurfaceTemplateFor } = await import("@/lib/content/resolve");
    // S57: this collection's explicit assignment wins over the family default
    const [pins, surface] = await Promise.all([resolvedCollectionPins(handle), resolvedSurfaceTemplateFor("collection", collection.id)]);
    const [{ products, total }, facets] = await Promise.all([
      getProductsInCollection(handle, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...filters, pins }),
      getCollectionTypeFacets(handle),
    ]);
    return { products, total, facets, template: surface.template };
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages && total > 0) notFound();
  const filtered = Boolean(filters.type || filters.inStock || filters.sort !== "featured");

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <TrackEvent
        name="view_item_list"
        data={{
          params: { item_list_id: handle, item_list_name: collection.title },
          items: products.slice(0, 10).map((p) => ({
            id: numericId(p.id),
            name: p.title,
            price: p.price_min,
          })),
        }}
      />
      <nav className="mb-4 text-sm text-zinc-400">
        <Link href="/" className="hover:text-zinc-600">
          Home
        </Link>{" "}
        /{" "}
        <Link href="/collections" className="hover:text-zinc-600">
          Collections
        </Link>{" "}
        / <span className="text-zinc-600">{collection.title}</span>
      </nav>

      <h1 className="text-3xl font-extrabold tracking-tight">{collection.title}</h1>
      {collection.description ? (
        <p className="mt-3 max-w-2xl text-zinc-500">{collection.description}</p>
      ) : null}
      <p className="mt-2 text-sm text-zinc-400">
        {total} {total === 1 ? "product" : "products"}
        {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ""}
      </p>

      {/* S56: template variants — "standard" keeps the original filter bar;
          "sidebar" moves the SAME link-based filters into a left rail on
          desktop (every state still has a URL). Picked in Theme → Page
          templates, release-governed. */}
      {(() => {
        const facetChip = (f) => {
          const active = filters.type === f.type;
          return (
            <Link
              key={f.type}
              href={qs(handle, { ...filters, type: active ? "" : f.type })}
              aria-pressed={active}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                active ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
              }`}
            >
              {f.type} <span className={active ? "text-zinc-300" : "text-zinc-400"}>{f.count}</span>
            </Link>
          );
        };
        const inStockChip = (
          <Link
            href={qs(handle, { ...filters, inStock: !filters.inStock })}
            aria-pressed={filters.inStock}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
              filters.inStock ? "border-accent-700 bg-accent-100 text-accent-800" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
            }`}
          >
            In stock
          </Link>
        );
        const clearLink = filtered && (
          <Link href={`/collections/${handle}`} className="text-sm font-medium text-accent-700 hover:underline">
            Clear all
          </Link>
        );
        const controls = (
          <CollectionControls basePath={`/collections/${handle}`} params={{ ...(filters.type ? { type: filters.type } : {}), ...(filters.inStock ? { instock: "1" } : {}) }} sort={filters.sort} />
        );
        const grid =
          products.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-10 text-center">
              <p className="font-medium text-zinc-700">
                {filtered ? "Nothing matches these filters." : "No products in this collection yet."}
              </p>
              {filtered && (
                <Link href={`/collections/${handle}`} className="mt-3 inline-block rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800">
                  Clear all filters
                </Link>
              )}
            </div>
          ) : (
            <ProductGrid products={products} priorityCount={4} />
          );

        if (template === "sidebar") {
          return (
            <div data-collection-template="sidebar" className="mt-6 gap-8 lg:grid lg:grid-cols-[13rem_1fr]">
              <aside className="mb-6 lg:mb-0 lg:sticky lg:top-24 lg:self-start" aria-label="Filters">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Filter</p>
                <div className="flex flex-wrap gap-2 lg:flex-col lg:items-start">
                  {facets.length > 1 && facets.map(facetChip)}
                  {inStockChip}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 lg:flex-col lg:items-start">
                  {controls}
                  {clearLink}
                </div>
              </aside>
              {/* data-sec: S59 surface designer click-target */}
              <div data-sec="collection-products">{grid}</div>
            </div>
          );
        }
        return (
          <div data-collection-template="standard">
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {facets.length > 1 && facets.map(facetChip)}
              {inStockChip}
              <span className="ml-auto flex items-center gap-3">
                {clearLink}
                {controls}
              </span>
            </div>
            <div data-sec="collection-products" className="mt-8">{grid}</div>
          </div>
        );
      })()}

      {totalPages > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Pagination">
          {page > 1 && (
            <Link
              href={qs(handle, { ...filters, page: page - 1 })}
              className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50"
            >
              ← Previous
            </Link>
          )}
          <span className="px-2 text-sm text-zinc-500">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={qs(handle, { ...filters, page: page + 1 })}
              className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50"
            >
              Next →
            </Link>
          )}
        </nav>
      )}

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: abs("/") },
              { "@type": "ListItem", position: 2, name: "Collections", item: abs("/collections") },
              { "@type": "ListItem", position: 3, name: collection.title, item: abs(`/collections/${handle}`) },
            ],
          }),
        }}
      />
    </div>
  );
}
