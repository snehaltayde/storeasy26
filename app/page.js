import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import CollectionCard from "@/components/CollectionCard";
import { getFeaturedCollections, getNewestProducts, getCatalogStats } from "@/lib/repo";
import { getHero, getHomeSections } from "@/lib/cms/store";
import { tfetch } from "@/lib/tenant-request";

// Catalog reflects the latest sync — render per request (sub-ms SQLite reads).
// Session 23: hero + section layout come from the tenant's CMS (defaults when
// nothing is configured), so merchandising edits go live without a deploy.
export const dynamic = "force-dynamic";

// Wrap the hero title's highlight substring in the accent color.
function HeroTitle({ title, highlight }) {
  const i = highlight ? title.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  if (i < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, i)}
      <span className="text-accent-400">{title.slice(i, i + highlight.length)}</span>
      {title.slice(i + highlight.length)}
    </>
  );
}

export default async function Home() {
  const { hero, sections, stats, data } = await tfetch(async () => {
    const [hero, sections, stats] = await Promise.all([getHero(), getHomeSections(), getCatalogStats()]);
    const data = {};
    for (const s of sections) {
      if (s.kind === "collections") data.collections = await getFeaturedCollections(s.limit || 6);
      if (s.kind === "new") data.products = await getNewestProducts(s.limit || 8);
    }
    return { hero, sections, stats, data };
  });
  const empty = stats.products === 0;

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-accent-300">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
            {empty ? "Storefront ready" : hero.badge || `${stats.products} products · ${stats.collections} collections`}
          </p>
          <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            <HeroTitle title={hero.title} highlight={hero.highlight} />
          </h1>
          {hero.subtitle ? <p className="mt-5 max-w-xl text-lg text-zinc-300">{hero.subtitle}</p> : null}
          <div className="mt-8 flex flex-wrap gap-3">
            {hero.primary?.label ? (
              <Link
                href={hero.primary.href || "/collections"}
                className="rounded-full bg-accent-400 px-6 py-3 text-sm font-bold text-accent-label transition hover:bg-accent-300"
              >
                {hero.primary.label}
              </Link>
            ) : null}
            {hero.secondary?.label ? (
              <Link
                href={hero.secondary.href || "#new"}
                className="rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                {hero.secondary.label}
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {empty ? (
          <EmptyState />
        ) : (
          sections.map((s) => {
            if (s.kind === "collections" && data.collections?.length > 0) {
              return (
                <section key={`${s.kind}-${s.title}`} className="py-14">
                  <div className="mb-6 flex items-end justify-between">
                    <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                    <Link href="/collections" className="text-sm font-medium text-accent-700 hover:underline">
                      View all →
                    </Link>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {data.collections.map((c) => (
                      <CollectionCard key={c.handle} collection={c} />
                    ))}
                  </div>
                </section>
              );
            }
            if (s.kind === "new" && data.products?.length > 0) {
              return (
                <section key={`${s.kind}-${s.title}`} id="new" className="scroll-mt-24 py-14">
                  <div className="mb-6 flex items-end justify-between">
                    <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                  </div>
                  <ProductGrid products={data.products} priorityCount={4} />
                </section>
              );
            }
            return null;
          })
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
          Connect the store&rsquo;s Shopify account, then pull the catalog:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-900 px-4 py-3 text-left text-sm text-accent-300">
          <code>pnpm migrate{"\n"}pnpm sync</code>
        </pre>
        <p className="mt-4 text-xs text-zinc-500">
          Home, collections, product pages and search all light up automatically once products land.
        </p>
      </div>
    </section>
  );
}
