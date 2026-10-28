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
  getHomeSections,
  getNav,
  getCollectionsIndex,
  getPdpExtras,
  listContentPages,
  pageRevisions,
} from "./store.js";
import { BLOCK_KEYS } from "./defaults.js";

export async function storefrontView() {
  const [announcement, hero, homeSections, navHeader, navFooter, collectionsIndex, pdpExtras, pages] = await Promise.all([
    getAnnouncement(),
    getHero(),
    getHomeSections(),
    getNav("header"),
    getNav("footer"),
    getCollectionsIndex(),
    getPdpExtras(),
    listContentPages(),
  ]);
  const customized = {};
  const revisions = {}; // S35: CAS tokens — the editor saves with the revision it loaded
  for (const key of BLOCK_KEYS) {
    const row = await getBlockRow(key);
    customized[key] = row != null;
    revisions[key] = row ? row.revision : null; // null = "I expect to create it"
  }
  return {
    blocks: { announcement, hero, home_sections: homeSections, nav_header: navHeader, nav_footer: navFooter, collections_index: collectionsIndex, pdp_extras: pdpExtras },
    customized,
    revisions,
    pageRevisions: await pageRevisions(),
    pages,
  };
}
