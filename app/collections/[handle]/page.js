import Link from "next/link";
import { notFound } from "next/navigation";
import ProductGrid from "@/components/ProductGrid";
import TrackEvent from "@/components/analytics/TrackEvent";
import { getCollectionByHandle, getProductsInCollection } from "@/lib/repo";
import { numericId } from "@/lib/ids";
import { abs } from "@/lib/site";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 48;
const pageNum = (sp) => Math.max(1, Number(sp?.page) || 1);

export async function generateMetadata({ params, searchParams }) {
  const { handle } = await params;
  const page = pageNum(await searchParams);
  const c = await getCollectionByHandle(handle);
  // Real 404 status must come from metadata — the loading boundary commits
  // a 200 before the page body can call notFound().
  if (!c) notFound();
  return {
    title: page > 1 ? `${c.title} — page ${page}` : c.title,
    description: c.description ? c.description.slice(0, 160) : undefined,
    alternates: { canonical: page > 1 ? `/collections/${handle}?page=${page}` : `/collections/${handle}` },
  };
}

export default async function CollectionPage({ params, searchParams }) {
  const { handle } = await params;
  const page = pageNum(await searchParams);
  const collection = await getCollectionByHandle(handle);
  if (!collection) notFound();

  const { products, total } = await getProductsInCollection(handle, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) notFound();

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

      <div className="mt-8">
        {products.length === 0 ? (
          <p className="text-zinc-500">No products in this collection yet.</p>
        ) : (
          <ProductGrid products={products} priorityCount={4} />
        )}
      </div>

      {totalPages > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Pagination">
          {page > 1 && (
            <Link
              href={page === 2 ? `/collections/${handle}` : `/collections/${handle}?page=${page - 1}`}
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
              href={`/collections/${handle}?page=${page + 1}`}
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
