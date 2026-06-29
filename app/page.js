import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import CollectionCard from "@/components/CollectionCard";
import { getFeaturedCollections, getNewestProducts, getCatalogStats } from "@/lib/repo";

// Catalog reflects the latest sync — render per request (sub-ms SQLite reads).
export const dynamic = "force-dynamic";

export default async function Home() {
  const [collections, products, stats] = await Promise.all([
    getFeaturedCollections(6),
    getNewestProducts(8),
    getCatalogStats(),
  ]);
  const empty = stats.products === 0;

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-lime-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-lime-300">
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
            {empty ? "Storefront ready" : `${stats.products} products · ${stats.collections} collections`}
          </p>
          <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            Fuel the <span className="text-lime-400">beast</span> in you.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-zinc-300">
            Science-backed protein, creatine and pre-workout — browse the full catalog at
            ludicrous speed.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/collections"
              className="rounded-full bg-lime-400 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:bg-lime-300"
            >
              Shop all collections
            </Link>
            <Link
              href="#new"
              className="rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              See what’s new
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {empty ? (
          <EmptyState />
        ) : (
          <>
            {collections.length > 0 && (
              <section className="py-14">
                <div className="mb-6 flex items-end justify-between">
                  <h2 className="text-2xl font-bold tracking-tight">Shop by collection</h2>
                  <Link href="/collections" className="text-sm font-medium text-lime-700 hover:underline">
                    View all →
                  </Link>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {collections.map((c) => (
                    <CollectionCard key={c.handle} collection={c} />
                  ))}
                </div>
              </section>
            )}

            <section id="new" className="scroll-mt-24 py-14">
              <div className="mb-6 flex items-end justify-between">
                <h2 className="text-2xl font-bold tracking-tight">Fresh drops</h2>
              </div>
              <ProductGrid products={products} priorityCount={4} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center">
        <h2 className="text-xl font-bold">Catalog not synced yet</h2>
        <p className="mt-2 text-sm text-zinc-600">
          Add your Shopify Storefront token to <code className="font-mono">.env.local</code>, then
          pull the real BeastLife catalog:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-900 px-4 py-3 text-left text-sm text-lime-300">
          <code>pnpm migrate{"\n"}pnpm sync</code>
        </pre>
        <p className="mt-4 text-xs text-zinc-500">
          Home, collections, product pages and search all light up automatically once products land.
        </p>
      </div>
    </section>
  );
}
