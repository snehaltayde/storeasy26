import { headers, cookies } from "next/headers";
import EmptyCatalog from "@/components/EmptyCatalog";
import ExperimentPing from "@/components/ExperimentPing";
import MarketingHome from "@/components/site/MarketingHome";
import HomeSections from "@/components/sections/HomeSections";
import { SectionView } from "@/components/sections/index";
import { runningExperimentFor, heroVariantFor, heroVariantSettings, signedInToConsole, UNIT_COOKIE } from "@/lib/experiments";
import { contentSource } from "@/lib/content/resolve";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { getCatalogStats } from "@/lib/repo";
import { resolveHomeSectionData } from "@/lib/cms/section-data";
import { defaultHero } from "@/lib/cms/defaults";
import { resolvedHomePage, resolvedCollectionsIndex } from "@/lib/content/resolve";
import { DOCUMENTS_RELEASE_VERSION } from "@/lib/releases";
import { legacyHeroToSettings } from "@/lib/registry/legacy";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Catalog reflects the latest sync — render per request (sub-ms SQLite reads).
// Session 23: hero + section layout come from the tenant's CMS (defaults when
// nothing is configured), so merchandising edits go live without a deploy.
//
// P2-SECTIONS (DOC-03, DOC-07): the page renders from resolvedHomePage(), the
// home page as registry sections with the hero as section 0, through the
// renderer map (components/sections/index.js). Every store goes this way:
// legacy stores get their hero and sections adapted, a documents store its
// published home document. A documents store may hide its hero: the page then
// starts with the sections, and never fails for want of a hero.
export const dynamic = "force-dynamic";

// The hero's settings with today's fallbacks under any key a stored hero
// lacks (as resolvedHero() always gave): "Shop <store>." and the default
// buttons. A legacy hero already holds every key, so nothing changes there.
function heroWithDefaults(section) {
  return { ...section, settings: { ...legacyHeroToSettings(defaultHero(siteName())), ...section.settings } };
}

export default async function Home() {
  // S44: on a designated PLATFORM host, "/" is the marketing homepage.
  if (isPlatformSiteHost((await headers()).get("host"))) return <MarketingHome />;

  // S47 (BE22): a running hero experiment overlays the assigned variant.
  // The unit cookie is functional (like the cart cookie); a first-time
  // visitor gets an id the ping component persists — the pure-hash
  // assignment makes this render and every later one agree on the variant.
  const jar = await cookies();
  const unitId = jar.get(UNIT_COOKIE)?.value || crypto.randomUUID();
  // PV-08: a browser signed in to the console is the founder's, preview or not
  // (the preview cookie lapses with its token while the Designer stays open).
  const founder = signedInToConsole(jar);

  const { hero, sections, stats, dataById, assignment, testNotice } = await tfetch(async () => {
    const [page, stats, index, src] = await Promise.all([resolvedHomePage(), getCatalogStats(), resolvedCollectionsIndex(), contentSource()]);
    const at = page.findIndex((s) => s.kind === "hero");
    const liveHero = at < 0 ? null : heroWithDefaults(page[at]);
    const sections = page.filter((_, i) => i !== at);
    let hero = liveHero;
    let assignment = null;
    let testNotice = null;
    // A hidden hero is not shown, so no visitor is assigned to its test.
    if (liveHero) {
      const heroExp = await runningExperimentFor("hero");
      // PV-08: a preview shows the founder's own hero. No variant, no exposure
      // ping (no assignment), and a note that a test runs on this section.
      // Signed in but out of preview: the live hero, no variant, no ping, no note.
      const picked = heroVariantFor(heroExp, liveHero.settings, unitId, { preview: src.preview, founder });
      assignment = picked.assignment;
      testNotice = picked.notice || null;
      // DOC-07: the variant's flat payload is merged at the settings level, so
      // what it doesn't name (the other button, the badge, the image) stays.
      const variant = picked.hero !== liveHero.settings && assignment ? heroExp.variants.find((v) => v.key === assignment.variant) : null;
      if (variant?.payload) hero = { ...liveHero, settings: heroVariantSettings(liveHero.settings, variant.payload) };
    }
    // S54: data resolves PER SECTION INSTANCE (registry bindings, batched) —
    // duplicate sections no longer overwrite each other's data or limits.
    // A documents store's rails never read the legacy pins (plan decision 9).
    const dataById = await resolveHomeSectionData(sections, { index, documents: src.v === DOCUMENTS_RELEASE_VERSION });
    return { hero, sections, stats, dataById, assignment, testNotice };
  });
  const empty = stats.products === 0;

  return (
    <div>
      {assignment && <ExperimentPing slug={assignment.slug} unit={unitId} />}
      {hero ? <SectionView section={hero} ctx={{ surface: "home", empty, stats, notice: testNotice }} /> : null}

      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {/* S54: one shared renderer for shoppers AND preview, keyed by durable
            section ids with per-instance data. */}
        {empty ? <EmptyCatalog /> : <HomeSections sections={sections} dataById={dataById} emptyNote={!hero} />}
      </div>
    </div>
  );
}
