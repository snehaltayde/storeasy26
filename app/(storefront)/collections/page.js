import Link from "next/link";
import CollectionCard from "@/components/CollectionCard";
import { getAllCollections, getCollectionsByHandles } from "@/lib/repo";
import { resolvedCollectionsIndex } from "@/lib/content/resolve";
import { tfetch } from "@/lib/storefront-request";

export const metadata = { title: "All collections" };
export const dynamic = "force-dynamic";

// S38 (SF02): the index respects the merchant's curation (collections_index
// block, release-governed): featured first, then the merchant's order, then
// the rest alphabetically; hidden handles don't render. No curation = the
// catalog-derived index, exactly as before.
export default async function CollectionsPage() {
  const { collections, featured } = await tfetch(async () => {
    const [all, index] = await Promise.all([getAllCollections(), resolvedCollectionsIndex()]);
    if (!index) return { collections: all, featured: [] };
    const hide = new Set(index.hide || []);
    const pinned = [...(index.featured || []), ...(index.order || []).filter((h) => !(index.featured || []).includes(h))];
    const byHandle = new Map(all.map((c) => [c.handle, c]));
    const head = pinned.map((h) => byHandle.get(h)).filter((c) => c && !hide.has(c.handle));
    const rest = all.filter((c) => !pinned.includes(c.handle) && !hide.has(c.handle));
    return { collections: [...head, ...rest], featured: (index.featured || []).filter((h) => byHandle.has(h) && !hide.has(h)) };
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">Collections</h1>
      <p className="mt-2 text-sm text-sf-text-subtle">
        {collections.length} {collections.length === 1 ? "collection" : "collections"}
      </p>

      {collections.length === 0 ? (
        <p className="mt-10 text-sf-text-subtle">
          No collections to show yet — please check back soon.
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <div key={c.handle} className="relative">
              {featured.includes(c.handle) && (
                <span className="absolute right-3 top-3 z-10 rounded-full bg-sf-accent px-2.5 py-1 text-sf-3xs font-bold uppercase tracking-wide text-sf-on-accent">
                  Featured
                </span>
              )}
              <CollectionCard collection={c} />
            </div>
          ))}
        </div>
      )}

      <p className="mt-10">
        <Link href="/" className="text-sm text-sf-accent-text hover:underline">
          ← Back home
        </Link>
      </p>
    </div>
  );
}
