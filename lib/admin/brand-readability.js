// TOK-02 for the console: the pairing matrix for a brand on this store's
// (draft) theme kit, against what the live store shows now. Used by the
// Brand API (save and preview answers) and the Brand page (on load), so the
// founder sees the same warnings whether they just saved or came back later.
//
// P3-DESIGN (TOK-03): where the console reads a store's brand and look.
//   liveDesign()        a documents store's LIVE design document (doc_design
//                       as the live list holds it): { brand, theme, versionId }.
//                       null brand and theme when nothing is published: the
//                       platform default, which is what shoppers see. Two
//                       statements (the live list, then that one version); the
//                       founder's preview overlay is never applied.
//   storeDesign({ config })
//                       { mode, brand, theme }: liveDesign() on a documents
//                       store, else the legacy control-plane drafts
//                       (lib/themes/kits.js draftDesignOf). Onboarding, Help
//                       and this file read through it,
//                       so none of them reads config.brand or config.theme
//                       (the TOK-03 guard, scripts/test-design-doc.js).
import { checkBrand } from "../brand.js";
import { getLiveReleaseState, DOCUMENTS_RELEASE_VERSION } from "../releases.js";
import { kitAttr, draftDesignOf } from "../themes/kits.js";
import { currentTenant } from "../tenant-context.js";
import { DOCUMENTS_MESSAGE, getCmsMode } from "../cms-mode.js";
import { libsql } from "../db.js";
import { designFromBody } from "../content/documents-reader.js";

const DESIGN_ID = "doc_design";

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

export async function liveDesign() {
  const r = await libsql.execute("SELECT r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const list = parse(r.rows[0]?.content ?? null);
  const entry = list && list.v === 4 && list.documents && Object.hasOwn(list.documents, DESIGN_ID) ? list.documents[DESIGN_ID] : null;
  if (!entry || typeof entry.version !== "string") return { brand: null, theme: null, versionId: null };
  const v = await libsql.execute({ sql: "SELECT body FROM document_versions WHERE id = ? AND document_id = ?", args: [entry.version, DESIGN_ID] });
  const body = parse(v.rows[0]?.body ?? null);
  // a listed version that can't be read is not a guess at the default
  if (!body) throw new Error(`the live design version ${entry.version} couldn't be read`);
  return { ...designFromBody(body), versionId: entry.version };
}

export async function storeDesign() {
  const d = await liveDesign();
  return { mode: "documents", brand: d.brand, theme: d.theme };
}

const answer = (r) => ({ warnings: r.issues.map((i) => i.message), notes: r.notes, pairs: r.failing, blocking: r.errors.length > 0 });

export async function brandReadability(brand, { theme } = {}) {
  let live = { brand: null, theme: null };
  try {
    live = await liveDesign();
  } catch {
    live = { brand: null, theme: null };
  }
  const kit = theme !== undefined ? theme : live.theme;
  return { ...answer(checkBrand(brand, { kit: kitAttr(kit || null), live: live.brand || null, liveKit: kitAttr(live.theme || null) })), documents: true };
}
