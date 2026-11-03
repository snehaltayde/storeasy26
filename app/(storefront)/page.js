import Link from "next/link";
import { headers, cookies } from "next/headers";
import EmptyCatalog from "@/components/EmptyCatalog";
import ExperimentPing from "@/components/ExperimentPing";
import MarketingHome from "@/components/site/MarketingHome";
import HomeSections from "@/components/sections/HomeSections";
import { runningExperimentFor, heroVariantFor, UNIT_COOKIE } from "@/lib/experiments";
// PV-08 (its own lines, away from the resolve/tfetch imports another branch edits)
import ExperimentNote from "@/components/preview/ExperimentNote";
import { contentSource } from "@/lib/content/resolve";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { getCatalogStats } from "@/lib/repo";
import { resolveHomeSectionData } from "@/lib/cms/section-data";
import { DEFAULT_HERO_SUBTITLE, EMPTY_STORE_HERO_SUBTITLE } from "@/lib/cms/defaults";
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

  const { hero, sections, stats, dataById, assignment, testNotice } = await tfetch(async () => {
    const [liveHero, sections, stats, index, src] = await Promise.all([resolvedHero(), resolvedHomeSections(), getCatalogStats(), resolvedCollectionsIndex(), contentSource()]);
    const heroExp = await runningExperimentFor("hero");
    // PV-08: a preview shows the founder's own hero. No variant, no exposure
    // ping (no assignment), and a note that a test runs on this section.
    const { hero, assignment, notice: testNotice = null } = heroVariantFor(heroExp, liveHero, unitId, { preview: src.preview });
    // S54: data resolves PER SECTION INSTANCE (registry bindings, batched) —
    // duplicate sections no longer overwrite each other's data or limits.
    const dataById = await resolveHomeSectionData(sections, { index });
    return { hero, sections, stats, dataById, assignment, testNotice };
  });
  const empty = stats.products === 0;
  // GEN-03: on an empty store the default words promise a catalog, and #new only
  // exists inside HomeSections. A founder's own subtitle stays as written.
  const subtitle = empty && hero.subtitle === DEFAULT_HERO_SUBTITLE ? EMPTY_STORE_HERO_SUBTITLE : hero.subtitle;
  const showSecondary = hero.secondary?.label && !(empty && (hero.secondary.href || "#new") === "#new");

  return (
    <div>
      {assignment && <ExperimentPing slug={assignment.slug} unit={unitId} />}
      {/* Hero */}
      <section data-sec="hero" className="relative overflow-hidden bg-hero text-hero-fg">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <ExperimentNote notice={testNotice} />
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-hero-fg/15 px-3 py-1 text-xs font-medium text-accent-400">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
            {empty ? "Coming soon" : hero.badge || `${stats.products} products · ${stats.collections} collections`}
          </p>
          <h1 className="max-w-3xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            <HeroTitle title={hero.title} highlight={hero.highlight} />
          </h1>
          {subtitle ? <p className="mt-5 max-w-xl text-lg text-hero-muted">{subtitle}</p> : null}
          <div className="mt-8 flex flex-wrap gap-3">
            {hero.primary?.label ? (
              <Link
                href={hero.primary.href || "/collections"}
                className="rounded-[var(--btn-radius,9999px)] bg-accent-400 px-6 py-3 text-sm font-bold text-accent-label transition hover:bg-accent-300"
              >
                {hero.primary.label}
              </Link>
            ) : null}
            {showSecondary ? (
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
        {empty ? <EmptyCatalog /> : <HomeSections sections={sections} dataById={dataById} />}
      </div>
    </div>
  );
}
