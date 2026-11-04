// P4-MAPPER (MIG-01, DOC-03): the legacy store as documents (spec 8.3, 8.11).
// It WRITES NOTHING: every database call here is a SELECT.
//
//   readLegacySource({ platform })   every legacy row the mapping reads, in the
//                                    tenant's context (withTenant). platform is
//                                    the control plane's client, for agency
//                                    grants (null: not checked, a refusal)
//   mapLegacy(source, { storeOpen, editability })
//                                    pure apart from Web Crypto: the documents,
//                                    the v4 list, the version bodies, refs, the
//                                    reconcile report and the source hash
//   mapTenant({ storeOpen, platform })
//                                    both, in the tenant's context
//
// Output of mapLegacy:
//   { state, documents, list, bodies, liveRows, refs, report, sourceHash,
//     releaseId, entities }
//   documents   [{ id, type, slug, entityId, label, draft, draftHash,
//                  published: { versionId, bodyHash, body } | null,
//                  publishedHash, dirty }]
//   list        the v4 list a cutover would put live (null when the state has
//               no published versions: refused, or not launched)
//   bodies      Map versionId -> { document_id, body } of every version the
//               list names (the journal index and posts included)
//   liveRows    { product: [], collection: [] } (P4-LIVEROW's liveRowFor, once
//               the entity part is built: map-entities.js)
//   refs        document_refs rows of every published version (MED-03)
//   report      the facts report.js renders (see buildFacts below)
//   sourceHash  a stable hash of every source row the mapping read
//
// How each legacy shape maps (the traps of spec 8.11 included):
//   announcement     doc_announcement; no row is the code default (null)
//   nav_header/footer + surface_templates.header/footer
//                    doc_header / doc_footer: null (or any non-list) is
//                    {mode: auto}, [] is {mode: custom, items: []}, no row
//                    and no template is the code default (null)
//   hero + home_sections
//                    doc_home, the hero as section 0 (sec_hero). Neither row:
//                    null (the code default follows the store name). One half
//                    stored: the other half is materialized. The default hero
//                    keeps NO title or highlight of its own: the reader and
//                    the home page fill a hero field the body lacks from the
//                    store's default hero ("Shop <store name>.", the store
//                    name highlighted), so it keeps following Settings. That
//                    is the {store_name} binding: no token is stored, because
//                    nothing in the reader fills one. A stored hero keeps
//                    exactly the fields it has, for the same reason.
//                    home_sections stored as [] (or not a list) reads as the
//                    default sections today, so they are materialized. A
//                    section with no usable id gets sec_l<n>, n its place
//                    among the sections shoppers see (the id resolvedHomePage
//                    gives it today; its old data-sec key was i-<n>); a
//                    hidden one gets sec_lh<n>, n its stored place. A
//                    generated id never repeats a stored one (it becomes
//                    sec_l<n>x2 and so on). Kinds the
//                    old home page never showed are left out (listed in the
//                    report with their stored value).
//   collections_index  doc_collections_index; handles become {handle, id?}
//                    with the ids sidecar
//   pdp_extras + surface_templates.pdp
//                    doc_product_layout: the product module first, then one
//                    rich text section per accordion
//   surface_templates.collection
//                    doc_collection_layout
//   brand, theme     doc_design (the draft design kits.js draftDesignOf reads;
//                    none on the env store _default, as its storefront reads).
//                    A store with no release whose brand would not pass a
//                    publish shows shoppers the default look today, so the
//                    published design holds no brand and the founder's brand
//                    is a draft
//   placements cart_upsell
//                    doc_cart: the enabled offers in position order, their
//                    products merged, the first one's title. Only when
//                    cartEditable() (lib/registry/editability.js)
//   cms_pages        doc_p_<hash of slug> (backfillRouteId) by family: page,
//                    campaign, journal (a journal index version lists the
//                    posts). Sections go through the merged kind names
//                    (legacyPageSectionsToSections); a section with no kind is
//                    text. Code-default pages (_default and BeastLife) get no
//                    document: the reader still serves them from code
//   page_redirects   onto the target page's meta.redirect_from, else
//                    reported as unresolved
//   surface_templates.products/.collections, product_overrides,
//   collection_overrides, pdp_pairs
//                    the entity part (map-entities.js; a stub until P4-OVL07)
//
// Values that fail strict validation or go over a limit are carried exactly
// as stored (never cut) and reported per document; the founder sees them as
// inherited warnings. Only what was never shown and can't be represented
// (an unknown section kind, a non-object entry) is left out of a body, and
// is listed in the report with its stored value; the old tables keep it.
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";
import { siteName } from "../site.js";
import { tenantId, currentTenant } from "../tenant-context.js";
import { brandDefaultsApply } from "../cms/store.js";
import { upgradeBlock } from "../cms/schemas.js";
import { HOME_SECTION_KINDS } from "../cms/registry.js";
import { DEFAULT_HOME_SECTIONS, defaultHero } from "../cms/defaults.js";
import { publishBlocked } from "../brand.js";
import { kitAttr, draftDesignOf } from "../themes/kits.js";
import { PAGES } from "../content/pages.js";
import {
  SCHEMA_VERSION,
  documentType,
  sectionType,
  singletonTypes,
  emptyBody,
  stableStringify,
  validateDocument,
  legacyHeroToSettings,
  legacyAnnouncementToSettings,
  legacyHomeSectionsToSections,
  legacyPageSectionsToSections,
  SECTION_ID_RE,
} from "../registry/index.js";
import { HERO_SECTION_ID } from "../registry/legacy.js";
import * as Editability from "../registry/editability.js";
import { backfillRouteId, productDocumentId, collectionDocumentId, ROUTE_TYPES } from "../documents/ids.js";
import { emptyList, setEntries } from "../documents/release-list.js";
import { JOURNAL_INDEX_ID, journalIndexBodyFrom } from "../documents/journal-index.js";
import { refRows } from "../documents/refs.js";
import { livePath } from "../documents/paths.js";
import { classifyState, readTenantState } from "./state.js";
import { migratedVersion, migratedReleaseId, draftHash as hashDraft, sha256Hex } from "./ids.js";
import { mapEntities } from "./map-entities.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.hasOwn(o, k);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const parseJson = (s, fallback = null) => {
  if (s == null) return fallback;
  try {
    return JSON.parse(String(s));
  } catch {
    return fallback;
  }
};

export const PRODUCT_MAIN_SECTION_ID = "sec_productmain";
export const CART_DEFAULT_TITLE = "You might also like";
// The highest sinceManifest of any singleton: the manifest a first list uses.
export const currentManifest = () => Math.max(1, ...singletonTypes().map((t) => documentType(t).sinceManifest || 1));

// ---- reading (SELECT only) ------------------------------------------------------------

// A plain copy of a row (libsql rows carry getters and array indexes).
const plainRow = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : typeof row[c] === "bigint" ? Number(row[c]) : row[c]]));

async function selectRows(sql, table, args = []) {
  try {
    const r = await libsql.execute({ sql, args });
    return r.rows.map((row) => plainRow(row, r.columns));
  } catch (e) {
    if (notMigratedYet(e, { table })) return [];
    throw e;
  }
}

/**
 * Every legacy row the mapping reads, inside the tenant's context. SELECTs
 * only. `platform` is the control plane's client (agency grants); without
 * one, agency access can't be checked and the report refuses for it.
 */
export async function readLegacySource({ platform = null } = {}) {
  const id = tenantId() || "_default";
  const raw = {
    cms_blocks: await selectRows("SELECT * FROM cms_blocks ORDER BY key", "cms_blocks"),
    cms_pages: await selectRows("SELECT * FROM cms_pages ORDER BY slug", "cms_pages"),
    page_redirects: await selectRows("SELECT * FROM page_redirects ORDER BY from_slug", "page_redirects"),
    placements: await selectRows("SELECT * FROM placements ORDER BY kind, position, id", "placements"),
    product_overrides: await selectRows("SELECT * FROM product_overrides ORDER BY product_id", "product_overrides"),
    collection_overrides: await selectRows("SELECT * FROM collection_overrides ORDER BY collection_id", "collection_overrides"),
    cms_templates: await selectRows("SELECT id, name, family, sections, version, revision, updated_at FROM cms_templates ORDER BY id", "cms_templates"),
    cms_approvals: await selectRows("SELECT id, draft_hash, actor, created_at FROM cms_approvals ORDER BY id", "cms_approvals"),
    cms_state: await selectRows("SELECT id, mode, cutover_release_id FROM cms_state", "cms_state"),
    release_state: await selectRows("SELECT id, live_release_id FROM release_state", "release_state"),
    live_release: await selectRows(
      "SELECT r.id, r.content, r.content_hash, r.published_at FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1",
      "releases",
    ),
    documents: await selectRows(
      "SELECT id, type, slug, entity_id, label, draft, draft_hash, published_version_id, published_hash, archived_at, revision FROM documents ORDER BY id",
      "documents",
    ),
    product_content_live: await selectRows("SELECT product_id, document_id, version_id FROM product_content_live ORDER BY product_id", "product_content_live"),
    collection_content_live: await selectRows("SELECT collection_id, document_id, version_id FROM collection_content_live ORDER BY collection_id", "collection_content_live"),
  };
  const state = await readTenantState();
  raw.pending_schedules = state.pendingSchedules;
  // the draft brand and theme, read through kits.js (the one place that reads
  // them from tenant config): exactly what resolvedBrand / resolvedTheme read
  // on a legacy store. The env store (_default) has no tenant config, so both
  // are null there, as its storefront reads them.
  const design = draftDesignOf(currentTenant()?.config ?? null);

  // agency access lives in the control plane
  let agency = { checked: false, grants: [] };
  if (id === "_default") agency = { checked: true, grants: [] };
  else if (platform) {
    try {
      const r = await platform.execute({ sql: "SELECT id, agency_id, role, status FROM agency_grants WHERE tenant_id = ? AND status = 'accepted' ORDER BY id", args: [id] });
      agency = { checked: true, grants: r.rows.map((row) => plainRow(row, r.columns)) };
    } catch (e) {
      agency = notMigratedYet(e, { table: "agency_grants" }) ? { checked: true, grants: [] } : { checked: false, grants: [], error: String(e?.message || e).slice(0, 200) };
    }
  }

  // the catalog's handles of the products a cart offer names (Shopify-owned,
  // read for the cart document's product picks; not part of the source hash)
  const cartIds = new Set();
  for (const p of raw.placements) if (p.kind === "cart_upsell") for (const pid of parseJson(p.target_product_ids, [])) if (typeof pid === "string") cartIds.add(pid);
  const live = state.live?.state === "live" ? state.live.release : null;
  if (live && live.v >= 2 && Array.isArray(live.content?.placements))
    for (const p of live.content.placements) if (isObj(p) && p.kind === "cart_upsell") for (const pid of Array.isArray(p.target_product_ids) ? p.target_product_ids : []) if (typeof pid === "string") cartIds.add(pid);
  const handles = {};
  const want = [...cartIds].sort();
  for (let i = 0; i < want.length; i += 200) {
    const part = want.slice(i, i + 200);
    for (const row of await selectRows(`SELECT id, handle FROM products WHERE id IN (${part.map(() => "?").join(", ")})`, "products", part)) handles[row.id] = row.handle;
  }

  return {
    tenantId: id,
    storeName: siteName(),
    brandDefaults: brandDefaultsApply(),
    codeDefaultPages: brandDefaultsApply() ? Object.keys(PAGES).sort() : [],
    state,
    design,
    agency,
    catalog: { handles },
    raw,
  };
}

// ---- the legacy content, as one shape per side ------------------------------------------
//
// A "side" is what one source holds: { blocks, pages, redirects, cart, brand,
// theme }. blocks: key -> value, a missing key is "no row". The draft side
// reads the draft tables (blocks upgraded exactly as getBlockRow does); the
// published side reads the live release (plus the live tables for what a v1
// release never froze), or the drafts for a store open with no release.

const placementTargets = (p) => (Array.isArray(p.target_product_ids) ? p.target_product_ids : parseJson(p.target_product_ids, []));

function enabledCart(rows) {
  return rows
    .filter((p) => isObj(p) && p.kind === "cart_upsell" && p.enabled !== false && p.enabled !== 0)
    .map((p, i) => ({ ...p, _i: i }))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a._i - b._i)
    .map(({ _i, ...p }) => ({ ...p, target_product_ids: placementTargets(p) }));
}

function draftSide(source) {
  const blocks = {};
  for (const row of source.raw.cms_blocks) blocks[row.key] = upgradeBlock(row.key, parseJson(row.value), row.schema_version ?? 1);
  const pages = source.raw.cms_pages.map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
    sections: parseJson(r.sections, []),
    enabled: !!r.enabled,
    effective_at: r.effective_at ?? null,
    family: r.family ?? "page",
    window_start: r.window_start ?? null,
    window_end: r.window_end ?? null,
  }));
  const redirects = source.raw.page_redirects.map((r) => ({ from_slug: r.from_slug, to_slug: r.to_slug }));
  const cart = enabledCart(source.raw.placements);
  return { blocks, pages, redirects, cart, brand: source.design.brand ?? null, theme: source.design.theme ?? null };
}

function releaseSide(source, content, { tables }) {
  const blocks = isObj(content.blocks) ? clone(content.blocks) : {};
  const pages = (Array.isArray(content.pages) ? content.pages : []).map((r) => ({ ...r, enabled: !!r?.enabled }));
  const fromTables = draftSide(source);
  return {
    blocks,
    pages,
    redirects: tables ? fromTables.redirects : (Array.isArray(content.redirects) ? content.redirects : []).filter(isObj),
    cart: tables ? fromTables.cart : enabledCart(Array.isArray(content.placements) ? content.placements : []),
    brand: content.brand || null,
    theme: content.theme || null,
  };
}

// ---- one document per legacy shape ----------------------------------------------------------

const singletonBody = (type, settings) => ({ schema: SCHEMA_VERSION, type, meta: {}, settings });

function mapAnnouncement(side, note) {
  if (!has(side.blocks, "announcement")) return null;
  const v = side.blocks.announcement;
  if (v == null) return null;
  if (!isObj(v)) {
    note({ what: "announcement", reason: "not_an_object", value: v });
    return null;
  }
  return singletonBody("announcement", { ...emptyBody("announcement").settings, ...legacyAnnouncementToSettings(v) });
}

function navItem(it) {
  if (!isObj(it)) return it; // carried; validation reports it
  const { label, href, children, ...rest } = it;
  const out = { ...rest };
  if (has(it, "label")) out.label = label;
  if (has(it, "href")) out.link = href == null || href === "" ? null : { type: "url", href };
  if (has(it, "children")) out.children = Array.isArray(children) ? children.map(navItem) : children;
  return out;
}

function mapNav(side, which) {
  const key = which === "footer" ? "nav_footer" : "nav_header";
  const type = which === "footer" ? "footer" : "header";
  const st = isObj(side.blocks.surface_templates) ? side.blocks.surface_templates : null;
  const hasTemplate = has(st, type) && st[type] != null;
  if (!has(side.blocks, key) && !hasTemplate) return null;
  // no template of its own: none is stored, so the platform default still
  // applies, and is still reported as the platform's
  const { template: _tpl, ...settings } = emptyBody(type).settings;
  if (hasTemplate) settings.template = st[type];
  const v = side.blocks[key];
  if (Array.isArray(v)) {
    settings.mode = "custom";
    settings.items = v.map(navItem);
  } else settings.mode = "auto"; // null (follow the catalog), absent, or not a list
  return singletonBody(type, settings);
}

// The default hero, materialized with its name-bound fields left out (title
// and highlight follow the store name at read; see the top of this file).
export function boundDefaultHeroSettings() {
  const { title: _t, highlight: _h, ...rest } = defaultHero("store");
  return legacyHeroToSettings(rest);
}

const heroSection = (settings) => ({ id: HERO_SECTION_ID, kind: "hero", v: sectionType("hero").version, enabled: true, settings, blocks: [] });

// P4-FIX1: section ids are unique within a body. Two sections sharing an id
// would stop every draft save in the new editor ("Two sections share one
// id"), with nothing the founder could do about it.
const storedId = (s) => (isObj(s) && typeof s.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : null);

// `want`, or the first of <want>x2, <want>x3 … (sec_dup<k> when that would be
// too long for an id) that no section has taken.
function freeSectionId(want, taken) {
  if (!taken.has(want)) return want;
  for (let k = 2; ; k++) {
    const id = SECTION_ID_RE.test(`${want}x${k}`) ? `${want}x${k}` : `sec_dup${k}`;
    if (!taken.has(id)) return id;
  }
}

// entries: [{ id, stored }] in body order. Stored ids are kept first (the
// first of two equal ones keeps it); a generated id, or a repeat of a stored
// one, skips every id already taken. `reserved` holds ids the body's own
// fixed sections use (sec_hero, sec_productmain).
export function uniqueSectionIds(entries, reserved = []) {
  const taken = new Set(reserved);
  const out = new Array(entries.length).fill(null);
  entries.forEach((e, i) => {
    if (e.stored && !taken.has(e.id)) {
      taken.add(e.id);
      out[i] = e.id;
    }
  });
  entries.forEach((e, i) => {
    if (out[i] !== null) return;
    out[i] = freeSectionId(e.id, taken);
    taken.add(out[i]);
  });
  return out;
}

// Ids for home sections, as the old home page read them (see the top), made
// unique (a generated sec_l<n> never repeats a stored id).
function homeSectionIds(list) {
  const shownKinds = new Set(HOME_SECTION_KINDS);
  let shownIndex = 0;
  const entries = list.map((s, i) => {
    const shown = isObj(s) && s.enabled !== false && shownKinds.has(s.kind);
    const stored = storedId(s);
    const id = stored ?? (shown ? `sec_l${shownIndex}` : `sec_lh${i}`);
    if (shown) shownIndex++;
    return { id, stored: stored != null };
  });
  return uniqueSectionIds(entries, [HERO_SECTION_ID]);
}

function mapHomeSections(list, note, where) {
  const known = new Set(HOME_SECTION_KINDS);
  const ids = homeSectionIds(list);
  const mapped = legacyHomeSectionsToSections(list);
  const out = [];
  list.forEach((s, i) => {
    if (!isObj(s) || !known.has(s.kind) || !sectionType(s.kind)) {
      note({ what: where, reason: isObj(s) ? "unknown_kind" : "not_an_object", index: i, value: s });
      return;
    }
    out.push({ ...mapped[i], id: ids[i] });
  });
  return out;
}

function mapHome(side, note) {
  const heroStored = has(side.blocks, "hero") && side.blocks.hero != null;
  const sectionsStored = has(side.blocks, "home_sections") && side.blocks.home_sections != null;
  if (!heroStored && !sectionsStored) return null; // the whole home is the code default
  return materializedHome(side.blocks, note);
}

// The home body for these blocks; also the draft that stands for "the code
// default home" when only the live side holds one.
function materializedHome(blocks, note = () => {}) {
  const hero = has(blocks, "hero") && blocks.hero != null ? blocks.hero : null;
  let heroSettings;
  if (hero == null) heroSettings = boundDefaultHeroSettings();
  else if (isObj(hero)) heroSettings = legacyHeroToSettings(hero);
  else {
    note({ what: "hero", reason: "not_an_object", value: hero });
    heroSettings = boundDefaultHeroSettings();
  }
  const rows = has(blocks, "home_sections") ? blocks.home_sections : undefined;
  const list = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  return { schema: SCHEMA_VERSION, type: "home", meta: {}, sections: [heroSection(heroSettings), ...mapHomeSections(list, note, "home_sections")] };
}

function mapCollectionsIndex(side, note) {
  if (!has(side.blocks, "collections_index")) return null;
  const v = side.blocks.collections_index;
  if (v == null) return null;
  if (!isObj(v)) {
    note({ what: "collections_index", reason: "not_an_object", value: v });
    return null;
  }
  const { ids, featured, order, hide, ...rest } = v;
  const idOf = isObj(ids) ? ids : {};
  const list = (l) => (l === undefined ? [] : Array.isArray(l) ? l.map((h) => (typeof h === "string" ? { handle: h, ...(typeof idOf[h] === "string" && idOf[h] ? { id: idOf[h] } : {}) } : h)) : l);
  return singletonBody("collections_index", { ...rest, featured: list(featured), order: list(order), hide: list(hide) });
}

function mapProductLayout(side, note) {
  const st = isObj(side.blocks.surface_templates) ? side.blocks.surface_templates : null;
  const hasTemplate = has(st, "pdp") && st.pdp != null;
  const extras = has(side.blocks, "pdp_extras") ? side.blocks.pdp_extras : undefined;
  if (extras == null && !hasTemplate) return null;
  const { template: _tpl, ...settings } = emptyBody("product_layout").settings;
  if (hasTemplate) settings.template = st.pdp;
  const sections = [{ id: PRODUCT_MAIN_SECTION_ID, kind: "product_main", v: sectionType("product_main").version, enabled: true, settings: {}, blocks: [] }];
  if (extras != null && !Array.isArray(extras)) note({ what: "pdp_extras", reason: "not_a_list", value: extras });
  const list = Array.isArray(extras) ? extras : [];
  const ids = uniqueSectionIds(
    list.map((x, i) => ({ id: storedId(x) ?? `sec_l${i}`, stored: storedId(x) != null })),
    [PRODUCT_MAIN_SECTION_ID],
  );
  list.forEach((x, i) => {
    if (!isObj(x)) {
      note({ what: "pdp_extras", reason: "not_an_object", index: i, value: x });
      return;
    }
    const { id: _id, enabled, ...fields } = x;
    sections.push({ id: ids[i], kind: "rich_text", v: sectionType("rich_text").version, enabled: enabled !== false, settings: fields, blocks: [] });
  });
  return { schema: SCHEMA_VERSION, type: "product_layout", meta: {}, settings, sections };
}

function mapCollectionLayout(side) {
  const st = isObj(side.blocks.surface_templates) ? side.blocks.surface_templates : null;
  if (!(has(st, "collection") && st.collection != null)) return null;
  return { schema: SCHEMA_VERSION, type: "collection_layout", meta: {}, settings: { ...emptyBody("collection_layout").settings, template: st.collection }, sections: [] };
}

function mapDesign(side) {
  if (side.brand == null && side.theme == null) return null;
  return singletonBody("design", { brand: side.brand ?? null, theme: side.theme ?? null });
}

// Each product pick keeps the catalog's handle next to its id. The handle is
// needed: the cart reader (resolve.js cartPlacementRows) only takes picks
// with a handle, the product_list check requires one, and MED-03 references
// are by handle. The catalog is Shopify's and outside the source hash, so a
// Shopify handle change between a rehearsal and the cutover leaves the source
// hash the same while the cart version id and the release id change
// (P4-CUTOVER: compare source hashes, never expect those ids to match).
function mapCart(side, catalog, note) {
  if (!side.cart.length) return null;
  const ids = [];
  for (const p of side.cart) for (const pid of Array.isArray(p.target_product_ids) ? p.target_product_ids : []) if (!ids.includes(pid)) ids.push(pid);
  const first = side.cart[0];
  side.cart.slice(1).forEach((p) => note({ what: "cart_upsell", reason: "later_offer_title_not_shown", id: p.id ?? null, title: p.title ?? null, position: p.position ?? 0 }));
  const products = ids.map((pid) => (typeof pid === "string" ? { handle: catalog.handles[pid] ?? "", id: pid } : pid));
  return singletonBody("cart", { title: first.title == null || first.title === "" ? CART_DEFAULT_TITLE : first.title, products });
}

const dateOrNull = (v) => (v == null || v === "" ? null : v);

// The pages of one side, keyed by document id: { id, type, body, family }.
async function mapPages(side, note) {
  const out = new Map();
  const seen = new Set();
  for (const [i, row] of side.pages.entries()) {
    if (!isObj(row) || typeof row.slug !== "string" || !row.slug) {
      note({ what: "page", reason: "no_slug", index: i, value: row });
      continue;
    }
    if (seen.has(row.slug)) {
      note({ what: "page", reason: "duplicate_slug", slug: row.slug });
      continue;
    }
    seen.add(row.slug);
    const family = row.family ?? "page";
    const type = ROUTE_TYPES.includes(family) ? family : "page";
    if (type !== family) note({ what: "page", reason: "unknown_family", slug: row.slug, family });
    const id = await backfillRouteId(type, row.slug);
    const sections = [];
    // P4-FIX2: one list, worked out once (a kind-less row is a text section,
    // empty rows dropped), is both what gets mapped and what "stored" is read
    // from, so mapped[j] is always normalized[j]. legacyPageSectionsToSections
    // normalizes the same way, so handing it the normalized list changes
    // nothing it returns.
    const normalized = (Array.isArray(row.sections) ? row.sections : []).map((s) => (s && !s.kind ? { kind: "text", ...s } : s)).filter(Boolean);
    const mapped = legacyPageSectionsToSections(normalized);
    if (mapped.length !== normalized.length) throw new Error(`mapPages: ${row.slug}: ${mapped.length} sections mapped from ${normalized.length}`);
    // a generated sec_l<i> never repeats a stored id (P4-FIX1)
    const ids = uniqueSectionIds(mapped.map((s, j) => ({ id: s.id, stored: storedId(normalized[j]) === s.id })));
    mapped.forEach((s, j) => {
      if (!sectionType(s.kind)) note({ what: "page_section", reason: isObj(normalized[j]) ? "unknown_kind" : "not_an_object", slug: row.slug, index: j, value: normalized[j] });
      else sections.push(ids[j] === s.id ? s : { ...s, id: ids[j] });
    });
    const meta = {
      slug: row.slug,
      title: row.title ?? null,
      description: row.description ?? "",
      enabled: !!row.enabled,
      effective_at: dateOrNull(row.effective_at),
      window_start: dateOrNull(row.window_start),
      window_end: dateOrNull(row.window_end),
      redirect_from: [],
    };
    out.set(id, { id, type, family, body: { schema: SCHEMA_VERSION, type, meta, sections } });
  }
  return out;
}

// Each redirect onto its target page's meta.redirect_from. Returns the ones
// with no page to go to.
function attachRedirects(side, pages) {
  const bySlug = new Map([...pages.values()].map((p) => [p.body.meta.slug, p]));
  const unresolved = [];
  const seen = new Set();
  for (const r of side.redirects) {
    if (!isObj(r) || typeof r.from_slug !== "string" || !r.from_slug) continue;
    if (seen.has(r.from_slug)) continue; // the first wins, as the old lookup did
    seen.add(r.from_slug);
    if (r.from_slug === r.to_slug) continue;
    const target = bySlug.get(r.to_slug);
    if (!target) {
      unresolved.push({ from_slug: r.from_slug, to_slug: r.to_slug ?? null });
      continue;
    }
    const list = target.body.meta.redirect_from;
    if (!list.includes(r.from_slug)) list.push(r.from_slug);
  }
  return unresolved;
}

// Every singleton's body for one side: { doc_x: body | null }.
function mapSingletons(side, { catalog, note, cart }) {
  return {
    doc_announcement: mapAnnouncement(side, note),
    doc_header: mapNav(side, "header"),
    doc_footer: mapNav(side, "footer"),
    doc_design: mapDesign(side),
    doc_home: mapHome(side, note),
    doc_collections_index: mapCollectionsIndex(side, note),
    doc_product_layout: mapProductLayout(side, note),
    doc_collection_layout: mapCollectionLayout(side),
    doc_cart: cart ? mapCart(side, catalog, note) : null,
  };
}

// What stands for "the code default" as a draft, when only the live side has
// the document. null when a draft can't say it (the founder's draft then
// equals what is live, and the report says so).
function defaultDraftBody(type) {
  if (type === "home") return materializedHome({});
  if (type === "collections_index") return null; // "follow the catalog" has no body
  if (type === "design") return singletonBody("design", { brand: null, theme: null });
  const t = documentType(type);
  if (!t?.singleton) return null;
  const body = emptyBody(type);
  if (type === "product_layout") body.sections = [{ id: PRODUCT_MAIN_SECTION_ID, kind: "product_main", v: sectionType("product_main").version, enabled: true, settings: {}, blocks: [] }];
  return body;
}

function labelOf(type, body) {
  const t = documentType(type);
  if (t?.route) {
    const title = body?.meta?.title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : t.label;
  }
  return t?.label ?? type;
}

// ---- the whole mapping ------------------------------------------------------------------------

const pageRow = (type, body) => {
  const m = body.meta;
  return { slug: m.slug, type, title: m.title, description: m.description ?? null, enabled: m.enabled !== false, effective_at: m.effective_at ?? null, window_start: m.window_start ?? null, window_end: m.window_end ?? null };
};
const redirectsOf = (body) => (Array.isArray(body.meta?.redirect_from) ? [...new Set(body.meta.redirect_from)].filter((s) => s !== body.meta.slug).map((from) => ({ from_slug: from, to_slug: body.meta.slug })) : []);

// Every source row the mapping read, minus the catalog (Shopify-owned).
export async function sourceHashOf(source) {
  const { raw } = source;
  return sha256Hex(
    stableStringify({
      tenant: source.tenantId,
      raw,
      design: source.design,
      agency: source.agency,
      state: { mode: source.state.mode, live: source.state.live?.state === "live" ? { id: source.state.live.release.id } : source.state.live ?? null },
    }),
  );
}

/**
 * The mapping. Pure apart from Web Crypto.
 *   storeOpen     true | false | undefined (the operator's flag)
 *   editability   { typeHasEditor, cartEditable } (lib/registry/editability.js;
 *                 a test may hand in its own)
 *   entities      the entity mapper (map-entities.js; a test may hand in its own)
 */
export async function mapLegacy(source, { storeOpen, editability = Editability, entities = mapEntities } = {}) {
  const st = classifyState({ ...source.state, storeOpen });
  const left = [];
  const note = (side) => (n) => left.push({ side, ...n });
  const cart = editability.cartEditable() === true;

  const live = source.state.live?.state === "live" ? source.state.live.release : null;
  const drafts = draftSide(source);
  let published = null;
  if (st.published === "release") published = releaseSide(source, live.content, { tables: false });
  else if (st.published === "release+tables") published = releaseSide(source, live.content, { tables: true });
  else if (st.published === "drafts") {
    published = draftSide(source);
    // what shoppers see today: drafts serve, but an unreadable brand shows the
    // default look (lib/content/resolve.js brandFrom)
    if (published.brand && publishBlocked(published.brand, { kit: kitAttr(published.theme) })) published.brand = null;
  }

  const draftSingletons = mapSingletons(drafts, { catalog: source.catalog, note: note("draft"), cart });
  const pubSingletons = published ? mapSingletons(published, { catalog: source.catalog, note: note("published"), cart }) : {};
  const draftPages = await mapPages(drafts, note("draft"));
  const pubPages = published ? await mapPages(published, note("published")) : new Map();
  const unresolvedDraft = attachRedirects(drafts, draftPages);
  const unresolvedPublished = published ? attachRedirects(published, pubPages) : [];

  // ---- documents --------------------------------------------------------------------
  const docs = [];
  const notes = [];
  for (const id of Object.keys(draftSingletons)) {
    const type = id.slice(4);
    let draft = draftSingletons[id];
    const pub = pubSingletons[id] ?? null;
    if (!draft && !pub) continue;
    if (!draft) {
      draft = defaultDraftBody(type) ?? clone(pub);
      notes.push({ document: id, code: defaultDraftBody(type) ? "DRAFT_IS_CODE_DEFAULT" : "DRAFT_REMOVAL_NOT_CARRIED" });
    }
    docs.push({ id, type, slug: null, entityId: null, draft, pub });
  }
  const pageIds = [...new Set([...draftPages.keys(), ...pubPages.keys()])].sort();
  for (const id of pageIds) {
    const d = draftPages.get(id) ?? null;
    const p = pubPages.get(id) ?? null;
    const type = (d ?? p).type;
    if (d && p && d.type !== p.type) notes.push({ document: id, code: "FAMILY_CHANGED", draft: d.type, published: p.type });
    let draft = d?.body ?? null;
    if (!draft) {
      draft = clone(p.body);
      notes.push({ document: id, code: "PAGE_DELETED_IN_DRAFTS", slug: p.body.meta.slug });
    }
    docs.push({ id, type, slug: draft.meta.slug, entityId: null, draft, pub: p?.body ?? null, pubType: p?.type ?? null });
  }

  // ---- versions, hashes and the list ------------------------------------------------
  const bodies = new Map();
  const documents = [];
  const posts = [];
  const changes = [];
  for (const d of docs) {
    const draftHashV = await hashDraft(d.draft);
    let pubV = null;
    let publishedHashV = null;
    if (d.pub) {
      const v = await migratedVersion(d.id, d.pub);
      pubV = { versionId: v.id, bodyHash: v.bodyHash, body: d.pub };
      publishedHashV = await hashDraft(d.pub);
      bodies.set(v.id, { document_id: d.id, body: d.pub, schema_version: SCHEMA_VERSION });
      const t = documentType(d.pubType ?? d.type);
      if (t.singleton) changes.push({ document: d.id, entry: { version: v.id, hash: v.bodyHash } });
      else if (t.type === "journal") {
        posts.push({ documentId: d.id, versionId: v.id, body: d.pub });
        changes.push({ document: d.id, entry: { version: v.id, hash: v.bodyHash }, pages: [], redirects: redirectsOf(d.pub) });
      } else changes.push({ document: d.id, entry: { version: v.id, hash: v.bodyHash }, pages: [pageRow(t.type, d.pub)], redirects: redirectsOf(d.pub) });
    }
    documents.push({
      id: d.id,
      type: d.type,
      slug: d.slug,
      entityId: d.entityId,
      label: labelOf(d.type, d.draft),
      draft: d.draft,
      draftHash: draftHashV,
      published: pubV,
      publishedHash: publishedHashV,
      dirty: draftHashV !== publishedHashV,
    });
  }

  // the entity part (product and collection content)
  const existingByEntity = new Map(source.raw.documents.filter((r) => r.entity_id != null).map((r) => [`${r.type}\u0000${r.entity_id}`, r]));
  const ent = await entities(source, { published: st.published, release: live?.content ?? null, existing: existingByEntity });
  for (const d of ent.documents) documents.push(d);
  for (const [k, v] of ent.bodies) bodies.set(k, v);

  let list = null;
  let releaseId = null;
  if (published) {
    if (posts.length) {
      const indexBody = journalIndexBodyFrom(posts);
      const iv = await migratedVersion(JOURNAL_INDEX_ID, indexBody);
      bodies.set(iv.id, { document_id: JOURNAL_INDEX_ID, body: indexBody, schema_version: SCHEMA_VERSION });
      changes.push({ index: "journal", entry: { version: iv.id, hash: iv.bodyHash } });
    }
    list = setEntries(emptyList(currentManifest(), singletonTypes()), changes);
    for (const p of posts) delete list.documents[p.documentId]; // posts are listed through the index only
    releaseId = await migratedReleaseId(list);
  } else {
    // nothing published (not launched, or refused): no version is listed
    for (const d of documents) if (d.published) d.published = null;
  }

  const refs = [];
  for (const [versionId, v] of [...bodies.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) refs.push(...refRows(versionId, v.body));
  for (const r of ent.refs || []) refs.push(r);

  const facts = await buildFacts(source, {
    st,
    storeOpen,
    documents,
    list,
    bodies,
    left,
    notes,
    unresolved: { draft: unresolvedDraft, published: unresolvedPublished },
    drafts,
    published,
    editability,
    cart,
    entities: ent,
    refsCount: refs.length,
  });
  const sourceHash = await sourceHashOf(source);
  return {
    state: { name: st.state, published: st.published, flag: storeOpen === true ? "--store-open" : storeOpen === false ? "--not-launched" : null },
    documents,
    list,
    bodies,
    liveRows: ent.liveRows,
    refs,
    report: facts,
    sourceHash,
    releaseId,
    entities: { built: ent.built, holds: ent.holds },
  };
}

// ---- the facts the report renders ----------------------------------------------------------

const pathOf = (type, body) => livePath(type, body?.meta);

function issueSummary(body, documentId) {
  const r = validateDocument(body, { mode: "publish", documentId });
  const errors = r.issues.filter((i) => i.severity === "error");
  const sections = [...new Set(errors.map((i) => i.sectionId).filter(Boolean))];
  const draftCheck = validateDocument(body, { mode: "draft", documentId });
  return {
    errors: errors.length,
    sections: sections.length,
    codes: [...new Set(errors.map((i) => i.code))].sort(),
    messages: [...new Set(errors.map((i) => i.message))].slice(0, 5),
    blocksSaving: draftCheck.issues.filter((i) => i.severity === "error").length,
  };
}

async function buildFacts(source, ctx) {
  const { st, documents, list, left, notes, unresolved, editability, cart, entities } = ctx;
  const refusals = [...st.refusals];
  const raw = source.raw;

  // DOC-13 is not built: approvals and agency access refuse
  if (raw.cms_approvals.length) refusals.push({ code: "APPROVALS_IN_USE", rows: raw.cms_approvals.length });
  if (!source.agency.checked) refusals.push({ code: "AGENCY_UNCHECKED", error: source.agency.error ?? null });
  else if (source.agency.grants.length) refusals.push({ code: "AGENCY_ACCESS", grants: source.agency.grants.map((g) => ({ id: g.id, agency: g.agency_id, role: g.role })) });

  // types that hold content but have no editor (MIG-03)
  const holding = new Map();
  for (const d of documents) holding.set(d.type, (holding.get(d.type) || 0) + 1);
  const cartHolds = ctx.drafts.cart.length > 0 || (ctx.published?.cart.length ?? 0) > 0;
  if (cartHolds) holding.set("cart", Math.max(1, holding.get("cart") || 0));
  const typesWithoutEditor = [];
  for (const [type, n] of [...holding.entries()].sort()) {
    const editable = editability.typeHasEditor(type) && (type !== "cart" || cart);
    if (!editable) typesWithoutEditor.push({ type, documents: n });
  }
  for (const t of typesWithoutEditor) refusals.push({ code: "NO_EDITOR", type: t.type });

  // the entity part: refuse while it can't be moved
  const holds = entities.holds || {};
  const entityContent = Object.values(holds).some((n) => n > 0);
  if (entityContent && !entities.built) refusals.push({ code: "ENTITY_CONTENT_NOT_MOVABLE", holds });

  // ---- reconcile: rows already there --------------------------------------------------
  const existing = new Map(raw.documents.map((r) => [r.id, r]));
  const mappedIds = new Set(documents.map((d) => d.id));
  const reconcile = { byId: [], entity: [], collisions: [], liveRows: { product: raw.product_content_live, collection: raw.collection_content_live }, kept: [] };
  for (const d of documents) {
    const row = existing.get(d.id);
    if (!row) continue;
    const differs = String(row.draft_hash) !== d.draftHash;
    reconcile.byId.push({ id: d.id, type: row.type, label: row.label, draftDiffers: differs, archived: row.archived_at != null });
    if (differs) reconcile.kept.push({ id: d.id, type: d.type, label: row.label, slug: row.slug ?? null });
  }
  for (const row of raw.documents) {
    if (row.entity_id == null) continue;
    const want = row.type === "product_content" ? await productDocumentId(String(row.entity_id)) : row.type === "collection_content" ? await collectionDocumentId(String(row.entity_id)) : null;
    reconcile.entity.push({ id: row.id, type: row.type, entityId: row.entity_id, deterministicId: want, reused: want != null && want !== row.id });
  }
  const slugs = new Map(documents.filter((d) => d.slug).map((d) => [d.slug, d]));
  for (const row of raw.documents) {
    if (row.archived_at != null || row.slug == null) continue;
    const d = slugs.get(row.slug);
    if (d && d.id !== row.id && !mappedIds.has(row.id)) reconcile.collisions.push({ slug: row.slug, mapped: { id: d.id, label: d.label }, existing: { id: row.id, label: row.label } });
  }
  for (const c of reconcile.collisions) refusals.push({ code: "SLUG_COLLISION", slug: c.slug, existing: c.existing.id, mapped: c.mapped.id });

  // ---- strict validation, per document --------------------------------------------------
  const validation = [];
  for (const d of documents) {
    const draft = issueSummary(d.draft, d.id);
    const pub = d.published ? issueSummary(d.published.body, d.id) : null;
    if (draft.errors || pub?.errors || draft.blocksSaving) validation.push({ id: d.id, type: d.type, label: d.label, path: pathOf(d.type, d.draft), draft, published: pub });
  }

  // ---- saved templates (not mapped: blueprints are DOC-09) ------------------------------
  const byFamily = {};
  for (const t of raw.cms_templates) byFamily[t.family || "page"] = (byFamily[t.family || "page"] || 0) + 1;

  const unresolvedRedirects = [];
  const seenR = new Set();
  for (const side of ["published", "draft"])
    for (const r of unresolved[side]) {
      const k = `${r.from_slug}\u0000${r.to_slug}`;
      if (seenR.has(k)) continue;
      seenR.add(k);
      unresolvedRedirects.push({ ...r, side });
    }

  const backfill = documents.length + ctx.bodies.size;
  return {
    tenant: source.tenantId,
    state: st.state,
    published: st.published,
    flag: ctx.storeOpen === true ? "--store-open" : ctx.storeOpen === false ? "--not-launched" : null,
    stateNotes: st.notes,
    live: source.state.live?.state === "live" ? { id: source.state.live.release.id, v: source.state.live.release.v } : null,
    refusals,
    documents: documents.map((d) => ({
      id: d.id,
      type: d.type,
      label: d.label,
      path: pathOf(d.type, d.draft),
      slug: d.slug,
      entityId: d.entityId,
      draftHash: d.draftHash,
      publishedVersionId: d.published?.versionId ?? null,
      publishedHash: d.publishedHash,
      dirty: d.dirty,
      neverPublished: !d.published,
    })),
    list,
    notes,
    leftOut: left,
    unresolvedRedirects,
    validation,
    typesWithoutEditor,
    reconcile,
    templates: { count: raw.cms_templates.length, byFamily },
    codeDefaultPages: source.codeDefaultPages,
    cartOffer: cartHolds,
    entities: { built: !!entities.built, holds },
    estimates: {
      backfillStatements: backfill + ctx.refsCount + reconcile.kept.length + (entities.liveRows?.product?.length || 0) + (entities.liveRows?.collection?.length || 0),
      flipStatements: list ? 5 : 0,
    },
  };
}

/** The mapping for the store in context. Read-only. */
export async function mapTenant({ storeOpen, platform = null, editability, entities } = {}) {
  const source = await readLegacySource({ platform });
  return { source, ...(await mapLegacy(source, { storeOpen, editability, entities })) };
}
