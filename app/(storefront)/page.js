import Link from "next/link";
import { headers, cookies } from "next/headers";
import ExperimentPing from "@/components/ExperimentPing";
import MarketingHome from "@/components/site/MarketingHome";
import HomeSections from "@/components/sections/HomeSections";
import { runningExperimentFor, heroVariantFor, UNIT_COOKIE } from "@/lib/experiments";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { getCatalogStats } from "@/lib/repo";
import { resolveHomeSectionData } from "@/lib/cms/section-data";
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

  const { hero, sections, stats, dataById, assignment } = await tfetch(async () => {
    const [liveHero, sections, stats, index] = await Promise.all([resolvedHero(), resolvedHomeSections(), getCatalogStats(), resolvedCollectionsIndex()]);
    const heroExp = await runningExperimentFor("hero");
    const { hero, assignment } = heroVariantFor(heroExp, liveHero, unitId);
    // S54: data resolves PER SECTION INSTANCE (registry bindings, batched) —
    // duplicate sections no longer overwrite each other's data or limits.
    const dataById = await resolveHomeSectionData(sections, { index });
    return { hero, sections, stats, dataById, assignment };
  });
  const empty = stats.products === 0;

  return (
    <div>
      {assignment && <ExperimentPing slug={assignment.slug} unit={unitId} />}
      {/* Hero */}
      <section data-sec="hero" className="relative overflow-hidden bg-hero text-hero-fg">
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
                className="rounded-[var(--btn-radius,9999px)] bg-accent-400 px-6 py-3 text-sm font-bold text-accent-label transition hover:bg-accent-300"
              >
                {hero.primary.label}
              </Link>
            ) : null}
            {hero.secondary?.label ? (
              <Link
                href={hero.secondary.href || "#new"}
                className="rounded-[var(--btn-radius,9999px)] border border-hero-fg/20 px-6 py-3 text-sm font-semibold text-hero-fg transition hover:bg-hero-fg/10"
              >
                {hero.secondary.label}
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {/* S54: one shared renderer for shoppers AND preview, keyed by durable
            section ids with per-instance data. */}
        {empty ? <EmptyState /> : <HomeSections sections={sections} dataById={dataById} />}
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
