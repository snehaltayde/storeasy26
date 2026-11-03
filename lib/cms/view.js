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

export async function storefrontView() {
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
    listContentPages(),
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
    pageRevisions: await pageRevisions(),
    pages,
  };
}
