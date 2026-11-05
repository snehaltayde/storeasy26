// P6-GEN (GEN-01, US-01, US-04, PUB-06): the first store, made from the
// catalog with no AI. Node only (the database, the sync state). Runs inside
// the store's tenant context.
//
//   generateFirstStore({ trigger: 'sync' | 'console' | 'editor', actor })
//     -> { ran: false, reason, … }                     nothing was written
//     -> { ran: true, written, created, refilled, unchanged, skipped,
//          products, collections, runId, summary, trigger }
//   describeFirstStore({ actor }) -> what the start page shows (below)
//
// Who may run it:
//   'console' and 'editor'  only an actor who can edit the store (canEdit,
//                           storefront.write, as the documents API's writes
//                           need); anyone else: { ran:false, reason:'cannot_edit' }
//   'sync'                  the worker, after a catalog sync completed (no actor)
//
// When it runs (eligibility, checked here BEFORE the writer is called: the
// writer answers written:false with no batch when nothing needs writing, even
// on a live, legacy or migrating store, and that is never "generated"):
//   1. the store is on the new editor (documents mode)   else 'legacy' | 'migrating'
//   2. the store has never opened (no live release)       else 'live'
//   3. the latest catalog sync is complete                else 'catalog_not_confirmed'
//   4. doc_home is absent, generator-owned (last written by system:first-run,
//      never published, not archived) or untouched-empty (revision 1, never
//      published, not archived, the empty body's hash): the writer's own rules.
//      A home the founder wrote: 'founder_started', and NOTHING is written, not
//      even the design (a closed store whose founder already built a home page
//      is left alone). The sync trigger never refills an untouched-empty home
//      (one the founder's editor may have just made): 'home_left_for_founder',
//      nothing written.
// What it writes: planFirstStore's home and design, through
// createFirstRunDocuments (the one writer, all or none), as system:first-run,
// with allowEmptyRefill = (trigger !== 'sync'). A lost race (FIRST_RUN_RACE)
// is tried once more from the top. The writer's own refusals after the checks
// above (the store changed mode or opened meanwhile) are answered as ran:false
// with their reason; anything else is thrown.
// It never publishes (PUB-06): the founder's first Publish carries the set.
import { libsql } from "../db.js";
import { getCmsMode } from "../cms-mode.js";
import { confirmedCatalogSync } from "../sync.js";
import { siteName } from "../site.js";
import { tenantOwnCfg } from "../tenant-context.js";
import { createFirstRunDocuments, FIRST_RUN_ACTOR, FIRST_RUN_BY, DocumentError } from "../documents/service.js";
import { canEdit } from "../admin/entity-entry.js";
import { emptyBody, validateDocument, ensureIds, documentHash } from "../registry/index.js";
import { startingPaletteId } from "../themes/palettes.js";
import { slog } from "../log.js";
import { planFirstStore, summarizeFirstStore } from "./plan.js";

export const FIRST_RUN_TRIGGERS = Object.freeze(["sync", "console", "editor"]);
export const HOME_ID = "doc_home";
export const DESIGN_ID = "doc_design";

// Plain words for each reason nothing was made, for the console.
export const FIRST_RUN_WORDS = Object.freeze({
  cannot_edit: "Only someone who can edit this store can make its starting pages.",
  legacy: "This store still uses the current Storefront editor, so no starting store was made here.",
  migrating: "Your store is being updated. Try again in a few minutes.",
  live: "Your store is already open, so the starting store wasn't made again. Your live store hasn't changed.",
  catalog_not_confirmed: "Your products are still coming in from Shopify. Your starting store is made once they have all arrived.",
  founder_started: "You've already started your home page, so it was left as it is.",
  home_left_for_founder: "Your home page is open in the editor, so it was left for you.",
  race: "Your store changed while the starting store was being made, so nothing was saved. Try again.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const marks = (n) => Array.from({ length: n }, () => "?").join(", ");

// The draft_hash createDocument stores for a type's empty body (the hash
// strips section ids, so it can be compared).
const emptyHashes = new Map();
async function emptyHashOf(type) {
  if (!emptyHashes.has(type)) emptyHashes.set(type, await documentHash(validateDocument(ensureIds(emptyBody(type)), { mode: "draft" }).body));
  return emptyHashes.get(type);
}

async function readRows() {
  const r = await libsql.execute({
    sql: `SELECT id, type, revision, draft, draft_hash, published_version_id, archived_at, updated_by FROM documents WHERE id IN (${marks(2)})`,
    args: [HOME_ID, DESIGN_ID],
  });
  return new Map(r.rows.map(rowOf).map((d) => [d.id, d]));
}

const text = (v) => (v == null ? null : String(v));
// one documents row, read-only (the null checks are reads, not writes)
function rowOf(row) {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    draft: text(row.draft),
    draftHash: text(row.draft_hash),
    publishedVersionId: text(row.published_version_id),
    archivedAt: text(row.archived_at),
    updatedBy: text(row.updated_by),
  };
}

// The writer's rules, read-only: 'absent' | 'owned' | 'empty' | 'founder'
async function classify(row, type) {
  if (!row) return "absent";
  if (row.archivedAt || row.publishedVersionId) return "founder";
  if (row.updatedBy === FIRST_RUN_BY) return "owned";
  if (row.revision === 1 && row.draftHash === (await emptyHashOf(type))) return "empty";
  return "founder";
}

async function liveReleaseId() {
  const r = await libsql.execute("SELECT live_release_id FROM release_state WHERE id = 1");
  return r.rows[0]?.live_release_id ?? null;
}

// The catalog, read from the store's own tables (what the last sync copied).
export async function readFirstRunCatalog() {
  const p = await libsql.execute("SELECT id, title, available, featured_image, featured_image_alt, created_at FROM products ORDER BY created_at DESC, id");
  const products = p.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ""),
    available: Number(r.available) === 1,
    featured_image: r.featured_image == null ? null : String(r.featured_image),
    featured_image_alt: r.featured_image_alt == null ? null : String(r.featured_image_alt),
    created_at: r.created_at == null ? null : String(r.created_at),
  }));
  const c = await libsql.execute(
    "SELECT c.id AS id, c.handle AS handle, c.title AS title, " +
      "(SELECT count(*) FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id = c.id AND p.available = 1) AS available, " +
      "(SELECT count(*) FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id = c.id) AS total " +
      "FROM collections c ORDER BY c.title COLLATE NOCASE, c.id",
  );
  const members = await libsql.execute("SELECT collection_id, product_id FROM collection_products ORDER BY collection_id, position, product_id");
  const ids = new Map();
  for (const m of members.rows) {
    const k = String(m.collection_id);
    if (!ids.has(k)) ids.set(k, []);
    ids.get(k).push(String(m.product_id));
  }
  const collections = c.rows.map((r) => ({
    id: String(r.id),
    handle: String(r.handle),
    title: String(r.title ?? ""),
    available: Number(r.available || 0),
    total: Number(r.total || 0),
    productIds: ids.get(String(r.id)) || [],
  }));
  return { products, collections };
}

// The checks, read-only. -> { eligible, reason, mode, live, sync, home, design, rows }
async function eligibility(trigger) {
  const mode = await getCmsMode();
  const base = { mode, live: null, sync: null, home: null, design: null, rows: new Map() };
  if (mode !== "documents") return { ...base, eligible: false, reason: mode === "migrating" ? "migrating" : "legacy" };
  const live = await liveReleaseId();
  if (live != null) return { ...base, live, eligible: false, reason: "live" };
  const sync = await confirmedCatalogSync();
  const rows = await readRows();
  const home = await classify(rows.get(HOME_ID), "home");
  const design = await classify(rows.get(DESIGN_ID), "design");
  const out = { ...base, live, sync, home, design, rows };
  if (!sync.confirmed) return { ...out, eligible: false, reason: "catalog_not_confirmed" };
  if (home === "founder") return { ...out, eligible: false, reason: "founder_started" };
  if (home === "empty" && trigger === "sync") return { ...out, eligible: false, reason: "home_left_for_founder" };
  return { ...out, eligible: true, reason: null };
}

const refusal = (reason, extra = {}) => ({ ran: false, reason, message: FIRST_RUN_WORDS[reason] ?? null, ...extra });

const WRITER_REASONS = { STORE_USES_LEGACY: "legacy", STORE_MIGRATING: "migrating", FIRST_RUN_STORE_LIVE: "live" };

export async function generateFirstStore({ trigger, actor = null } = {}) {
  if (!FIRST_RUN_TRIGGERS.includes(trigger)) throw new TypeError(`generateFirstStore: unknown trigger "${trigger}"`);
  if (trigger !== "sync" && !canEdit(actor)) return refusal("cannot_edit", { trigger });
  for (let attempt = 1; ; attempt++) {
    const el = await eligibility(trigger);
    if (!el.eligible) return refusal(el.reason, { trigger, syncReason: el.sync && !el.sync.confirmed ? el.sync.reason ?? null : undefined });
    const catalog = await readFirstRunCatalog();
    const paletteId = startingPaletteId(tenantOwnCfg("onboarding", null, null));
    const { home, design, summary } = planFirstStore({ siteName: siteName(), catalog, paletteId });
    let result;
    try {
      result = await createFirstRunDocuments({
        docs: [
          { type: "home", id: HOME_ID, body: home },
          { type: "design", id: DESIGN_ID, body: design },
        ],
        actor: FIRST_RUN_ACTOR,
        allowEmptyRefill: trigger !== "sync",
      });
    } catch (e) {
      if (e instanceof DocumentError && e.code === "FIRST_RUN_RACE") {
        if (attempt < 2) continue;
        return refusal("race", { trigger });
      }
      if (e instanceof DocumentError && WRITER_REASONS[e.code]) return refusal(WRITER_REASONS[e.code], { trigger });
      throw e;
    }
    const out = { ran: true, trigger, ...result, products: catalog.products.length, collections: catalog.collections.length, runId: el.sync.runId ?? null, summary };
    slog("first_run", { trigger, written: result.written, created: result.created, refilled: result.refilled, unchanged: result.unchanged, skipped: result.skipped.map((s) => `${s.id}:${s.reason}`), products: out.products, collections: out.collections, run: out.runId });
    return out;
  }
}

const parse = (row) => {
  if (!row?.draft) return null;
  try {
    const b = JSON.parse(row.draft);
    return isObj(b) ? b : null;
  } catch {
    return null;
  }
};

// What the start page shows ('what was made'), read-only:
//   { eligible, reason, generated, byGenerator, kept, empty, noCollections, summary }
//   eligible / reason  whether generateFirstStore({ trigger: 'console' }) would
//                      write now, and why not (the console trigger's rules)
//   generated          a home page exists (made by the generator or not)
//   byGenerator        the ids still generator-owned (never saved by the founder)
//   kept               the ids the generator would skip as the founder's
//   empty              the catalog has no products
//   noCollections      no collection has a product in stock
//   summary            re-derived from the current generator-owned drafts (null
//                      when the home is not the generator's)
export async function describeFirstStore({ actor = null } = {}) {
  const el = await eligibility("console");
  const editable = canEdit(actor);
  const catalog = el.mode === "documents" ? await readFirstRunCatalog() : { products: [], collections: [] };
  const byGenerator = [];
  const kept = [];
  for (const [id, k] of [[HOME_ID, el.home], [DESIGN_ID, el.design]]) {
    if (k === "owned") byGenerator.push(id);
    else if (k === "founder") kept.push(id);
  }
  const homeRow = el.rows.get(HOME_ID);
  const designRow = el.rows.get(DESIGN_ID);
  const summary =
    el.home === "owned"
      ? summarizeFirstStore({ home: parse(homeRow), design: el.design === "owned" ? parse(designRow) : null, catalog })
      : null;
  return {
    eligible: el.eligible && editable,
    reason: el.eligible && !editable ? "cannot_edit" : el.reason,
    generated: Boolean(homeRow),
    byGenerator,
    kept,
    empty: catalog.products.length === 0,
    noCollections: !catalog.collections.some((c) => c.available > 0),
    summary,
  };
}
