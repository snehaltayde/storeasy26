import Link from "next/link";
import { notFound } from "next/navigation";
import ProductGrid from "@/components/ProductGrid";
import TrackEvent from "@/components/analytics/TrackEvent";
import { getCollectionByHandle, getProductsInCollection } from "@/lib/repo";
import { numericId } from "@/lib/ids";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { handle } = await params;
  const c = await getCollectionByHandle(handle);
  if (!c) return { title: "Collection not found" };
  return {
    title: c.title,
    description: c.description ? c.description.slice(0, 160) : undefined,
  };
}

export default async function CollectionPage({ params }) {
  const { handle } = await params;
  const collection = await getCollectionByHandle(handle);
  if (!collection) notFound();

  const { products, total } = await getProductsInCollection(handle, { limit: 48 });

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
      </p>

      <div className="mt-8">
        {products.length === 0 ? (
          <p className="text-zinc-500">No products in this collection yet.</p>
        ) : (
          <ProductGrid products={products} priorityCount={4} />
        )}
      </div>
    </div>
  );
}
