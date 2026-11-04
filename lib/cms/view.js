// The storefront-console view (S50 fix). SERVER-ONLY, tenant-scoped.
//
// ONE builder for the editor's world: effective blocks, which are customized,
// and — critically — the CAS revision tokens the editor must save with. The
// admin page and the API route previously built this differently: the page's
// hand-rolled copy omitted `revisions`/`pageRevisions` and two whole blocks
// (collections_index, pdp_extras), so the FIRST save of an already-customized
// block sent revision:null → a false 409 conflict, and the overwrite retry
// could wipe the two missing blocks with empty values. Both callers now share
// this function, so the shapes can never drift again.
//
// P4-ED05 (spec 8.13): on a documents store the view is the published
// documents (documentsView below); the old tables are frozen there.
import {
  getBlockRow,
  getAnnouncement,
  getHero,
  getHomeSectionsRaw,
  getNav,
  getCollectionsIndexRaw,
  getPdpExtrasRaw,
  listContentPages,
  pageRevisions,
} from "./store.js";
import { BLOCK_KEYS } from "./defaults.js";
import { getCmsMode } from "../cms-mode.js";

// ---- P4-ED05 (spec 8.13, ED-05): the documents source -------------------------------
//
// On a documents store the old tables are frozen: a reader of them would show
// content from before the move. The console readers that used them (this
// view, AI insights, the setup checklist, GET /api/admin/catalog) read what
// shoppers see instead: the PUBLISHED documents, through the storefront's own
// getters (lib/content/resolve.js) bound to the live release.
//
//   publishedSource()   the live source with no preview (a founder's preview
//                       cookie never lays drafts over it): the live v4 list,
//                       a live legacy release as it is, or the closed store
//                       (never published). A broken live release throws the
//                       storefront's ContentUnavailableError, never a guess.
//   publishedGetters()  contentGettersFor(publishedSource()): every resolved*
//                       getter, bound to that source, plus `closed` (true
//                       when the store has never published: what the getters
//                       answer then is the empty store, not a published one)
//
// resolve.js is imported only on the documents path: it reads next/headers,
// and the legacy path (and its suites) never needs it.
export async function publishedSource() {
  const [{ getLiveReleaseState, DOCUMENTS_RELEASE_VERSION }, Reader] = await Promise.all([import("../releases.js"), import("../content/documents-reader.js")]);
  const s = await getLiveReleaseState();
  if (s.state === "live") {
    if (s.release.v === DOCUMENTS_RELEASE_VERSION) {
      const { candidateSource } = await import("../content/resolve.js");
      return candidateSource({ list: s.release.content, releaseId: s.release.id });
    }
    return { mode: "live", content: s.release.content, preview: false };
  }
  if (s.state === "none") return { mode: "closed", v: DOCUMENTS_RELEASE_VERSION, list: Reader.emptyList(), releaseId: null, content: null, preview: false };
  throw new Reader.ContentUnavailableError(s.error);
}

export async function publishedGetters() {
  const [src, { contentGettersFor }] = await Promise.all([publishedSource(), import("../content/resolve.js")]);
  return Object.freeze({ ...contentGettersFor(src), closed: src.mode === "closed" });
}

// The view on a documents store: what is published, in the view's shape.
// Nothing here is an old draft, so nothing is "customized" and there is no
// revision to save with (the old editors redirect, and their writes refuse).
async function documentsView() {
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

export async function storefrontView() {
  // P4-ED05: a documents store's view is its published documents (a mode
  // that can't be read throws, as every other read of this view does)
  if ((await getCmsMode()) === "documents") return documentsView();
  // S52: the view feeds EDITORS, so list blocks use the RAW getters — the
  // filtered (renderer) getters drop disabled entries, and an editor fed the
  // filtered list silently deleted them on its next save.
  const [announcement, hero, homeSections, navHeader, navFooter, collectionsIndex, pdpExtras, surfaceTemplatesRow, pages] = await Promise.all([
    getAnnouncement(),
    getHero(),
    getHomeSectionsRaw(),
    getNav("header"),
    getNav("footer"),
    getCollectionsIndexRaw(), // S57: the editor shows what is STORED — healed handles stay a render concern
    getPdpExtrasRaw(),
    getBlockRow("surface_templates"), // S57: RAW stored value — editors need explicit-vs-default, not the merged view
    listContentPages({ strict: true }), // DOC-04: a failed read is a failed load, never "no pages"
  ]);
  const customized = {};
  const revisions = {}; // S35: CAS tokens — the editor saves with the revision it loaded
  const blockMeta = {}; // S52: updated_at per customized block (overview "recent edits")
  for (const key of BLOCK_KEYS) {
    // DOC-04: STRICT. A failed read must not reach the editor as "not
    // customized, revision null": its next save would then fail as a false
    // conflict. A missing table still reads as not customized.
    const row = await getBlockRow(key, { strict: true });
    customized[key] = row != null;
    revisions[key] = row ? row.revision : null; // null = "I expect to create it"
    if (row) blockMeta[key] = { updated_at: row.updated_at };
  }
  return {
    blocks: {
      announcement,
      hero,
      home_sections: homeSections,
      nav_header: navHeader,
      nav_footer: navFooter,
      collections_index: collectionsIndex,
      pdp_extras: pdpExtras,
      surface_templates: surfaceTemplatesRow?.value ?? null,
    },
    customized,
    revisions,
    blockMeta,
    pageRevisions: await pageRevisions({ strict: true }),
    pages,
  };
}
