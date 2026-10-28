import Link from "next/link";
import { headers, cookies } from "next/headers";
import ProductGrid from "@/components/ProductGrid";
import CollectionCard from "@/components/CollectionCard";
import ExperimentPing from "@/components/ExperimentPing";
import MarketingHome from "@/components/site/MarketingHome";
import { runningExperimentFor, heroVariantFor, UNIT_COOKIE } from "@/lib/experiments";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getCatalogStats } from "@/lib/repo";
import { resolvedHero, resolvedHomeSections, resolvedCollectionsIndex } from "@/lib/content/resolve";
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
  // S44: on a designated PLATFORM host, "/" is the marketing homepage.
  if (isPlatformSiteHost((await headers()).get("host"))) return <MarketingHome />;

  // S47 (BE22): a running hero experiment overlays the assigned variant.
  // The unit cookie is functional (like the cart cookie); a first-time
  // visitor gets an id the ping component persists — the pure-hash
  // assignment makes this render and every later one agree on the variant.
  const unitId = (await cookies()).get(UNIT_COOKIE)?.value || crypto.randomUUID();

  const { hero, sections, stats, data, assignment } = await tfetch(async () => {
    const [liveHero, sections, stats, index] = await Promise.all([resolvedHero(), resolvedHomeSections(), getCatalogStats(), resolvedCollectionsIndex()]);
    const heroExp = await runningExperimentFor("hero");
    const { hero, assignment } = heroVariantFor(heroExp, liveHero, unitId);
    const data = {};
    for (const s of sections) {
      if (s.kind === "collections") {
        // S38 (SF02): merchant-featured collections win over the size heuristic
        const curated = index?.featured?.length ? await getCollectionsByHandles(index.featured) : [];
        data.collections = curated.length ? curated.slice(0, s.limit || 6) : await getFeaturedCollections(s.limit || 6);
      }
      if (s.kind === "new") data.products = await getNewestProducts(s.limit || 8);
    }
    return { hero, sections, stats, data, assignment };
  });
  const empty = stats.products === 0;

  return (
    <div>
      {assignment && <ExperimentPing slug={assignment.slug} unit={unitId} />}
      {/* Hero */}
      <section className="relative overflow-hidden bg-hero text-hero-fg">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-hero-fg/15 px-3 py-1 text-xs font-medium text-accent-400">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
            {empty ? "Storefront ready" : hero.badge || `${stats.products} products · ${stats.collections} collections`}
          </p>
          <h1 className="max-w-3xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            <HeroTitle title={hero.title} highlight={hero.highlight} />
          </h1>
          {hero.subtitle ? <p className="mt-5 max-w-xl text-lg text-hero-muted">{hero.subtitle}</p> : null}
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
                className="rounded-full border border-hero-fg/20 px-6 py-3 text-sm font-semibold text-hero-fg transition hover:bg-hero-fg/10"
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
            {/* S37 (MC08): merchant-composed sections */}
            if (s.kind === "banner") {
              return (
                <section key={`banner-${s.title}-${s.text}`} className="py-14">
                  <div className="rounded-brand bg-accent-100 px-6 py-10 text-center sm:px-10">
                    {s.title ? <h2 className="font-display text-2xl font-bold tracking-tight text-accent-900">{s.title}</h2> : null}
                    {s.text ? <p className="mx-auto mt-2 max-w-xl text-accent-800">{s.text}</p> : null}
                    {s.href && s.label ? (
                      <Link href={s.href} className="mt-5 inline-block rounded-full bg-accent-400 px-6 py-3 text-sm font-bold text-accent-label transition hover:bg-accent-300">
                        {s.label}
                      </Link>
                    ) : null}
                  </div>
                </section>
              );
            }
            if (s.kind === "rich_text") {
              // html is allowlist-SANITIZED at save (lib/cms/validate.js, S37)
              return (
                <section key={`rich-${s.title}`} className="py-14">
                  {s.title ? <h2 className="mb-4 text-2xl font-bold tracking-tight">{s.title}</h2> : null}
                  <div className="rte max-w-3xl" dangerouslySetInnerHTML={{ __html: s.html || "" }} />
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
