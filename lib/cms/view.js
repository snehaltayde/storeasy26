// Published content view for console and AI readers (Documents-only).
// SERVER-ONLY, tenant-scoped.
//
// Reads what shoppers see: the PUBLISHED documents through the storefront's own
// getters (lib/content/resolve.js) bound to the live v4 release (never drafts).
import { BLOCK_KEYS } from "./defaults.js";

export async function publishedSource() {
  const [{ getLiveReleaseState, DOCUMENTS_RELEASE_VERSION }, Reader] = await Promise.all([
    import("../releases.js"),
    import("../content/documents-reader.js"),
  ]);
  const s = await getLiveReleaseState();
  if (s.state === "live") {
    if (s.release.v === DOCUMENTS_RELEASE_VERSION) {
      const { candidateSource } = await import("../content/resolve.js");
      return candidateSource({ list: s.release.content, releaseId: s.release.id });
    }
    throw new Reader.ContentUnavailableError({ code: "UNSUPPORTED_RELEASE_VERSION", v: s.release.v });
  }
  if (s.state === "none") {
    return { mode: "closed", v: DOCUMENTS_RELEASE_VERSION, list: Reader.emptyList(), releaseId: null, content: null, preview: false };
  }
  throw new Reader.ContentUnavailableError(s.error);
}

export async function publishedGetters() {
  const [src, { contentGettersFor }] = await Promise.all([publishedSource(), import("../content/resolve.js")]);
  return Object.freeze({ ...contentGettersFor(src), closed: src.mode === "closed" });
}

export async function storefrontView() {
  const g = await publishedGetters();
  const [announcement, hero, homeSections, navHeader, navFooter, collectionsIndex, pdpExtras, surfaceTemplates, pages] = await Promise.all([
    g.resolvedAnnouncement(),
    g.resolvedHero(),
    g.resolvedHomeSections(),
    g.resolvedNav("header"),
    g.resolvedNav("footer"),
    g.resolvedCollectionsIndex(),
    g.resolvedPdpExtras(),
    g.resolvedSurfaceTemplates(),
    g.resolvedContentPageList(),
  ]);
  const none = (v) => Object.fromEntries(BLOCK_KEYS.map((k) => [k, v]));
  return {
    documents: true,
    blocks: {
      announcement,
      hero,
      home_sections: homeSections,
      nav_header: navHeader,
      nav_footer: navFooter,
      collections_index: collectionsIndex,
      pdp_extras: pdpExtras,
      surface_templates: surfaceTemplates ?? null,
    },
    customized: none(false),
    revisions: none(null),
    blockMeta: {},
    pageRevisions: {},
    pages,
  };
}
