import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import { typesenseSearch } from "@/lib/typesense-search";
import { searchProductsInDb } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }) {
  const sp = await searchParams;
  const q = (sp?.q || "").trim();
  return { title: q ? `Search: ${q}` : "Search" };
}

async function runSearch(q) {
  try {
    const ts = await typesenseSearch(q, { limit: 36 });
    if (ts) return ts;
  } catch {
    /* fall back */
  }
  return searchProductsInDb(q, 36);
}

export default async function SearchPage({ searchParams }) {
  const sp = await searchParams;
  const q = (sp?.q || "").trim();
  const result = q.length >= 2 ? await runSearch(q) : { hits: [], found: 0, source: "none" };

  const products = result.hits.map((h) => ({
    handle: h.handle,
    title: h.title,
    product_type: h.product_type,
    featured_image: h.image,
    price_min: h.price,
    currency: h.currency,
    available: h.available,
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">
        {q ? (
          <>
            Results for “<span className="text-lime-700">{q}</span>”
          </>
        ) : (
          "Search"
        )}
      </h1>
      {q ? (
        <p className="mt-1 text-sm text-zinc-400">
          {products.length} {products.length === 1 ? "product" : "products"}
        </p>
      ) : null}

      <div className="mt-8">
        {!q ? (
          <p className="text-zinc-500">Type at least 2 characters to search.</p>
        ) : products.length === 0 ? (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center">
            <p className="font-medium text-zinc-700">No products match “{q}”.</p>
            <Link
              href="/collections"
              className="mt-3 inline-block text-sm text-lime-700 hover:underline"
            >
              Browse all collections →
            </Link>
          </div>
        ) : (
          <ProductGrid products={products} priorityCount={4} />
        )}
      </div>
    </div>
  );
}
