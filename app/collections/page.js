import Link from "next/link";
import CollectionCard from "@/components/CollectionCard";
import { getAllCollections } from "@/lib/repo";

export const metadata = { title: "All collections" };
export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const collections = await getAllCollections();

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">Collections</h1>
      <p className="mt-2 text-sm text-zinc-500">
        {collections.length} {collections.length === 1 ? "collection" : "collections"}
      </p>

      {collections.length === 0 ? (
        <p className="mt-10 text-zinc-500">
          No collections yet — run <code className="font-mono">pnpm sync</code>.
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <CollectionCard key={c.handle} collection={c} />
          ))}
        </div>
      )}

      <p className="mt-10">
        <Link href="/" className="text-sm text-lime-700 hover:underline">
          ← Back home
        </Link>
      </p>
    </div>
  );
}
