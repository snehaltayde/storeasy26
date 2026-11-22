// Storefront content resolution (Documents-only v4). SERVER COMPONENT ONLY.
//
// Reads published v4 release lists and lays valid preview-session drafts over
// them for signed-in preview browsers only. Before a store's first publish,
// anonymous shoppers get mode "closed" ("Opening soon") — drafts never leak.
import { cache } from "react";
import { cookies } from "next/headers";
import { getLiveReleaseState, readPreviewToken, DOCUMENTS_RELEASE_VERSION } from "../releases.js";
import { readPreviewSession, PREVIEW_COOKIE } from "../preview-sessions.js";
import { slog } from "../log.js";
import { DEFAULT_ANNOUNCEMENT, defaultHero, DEFAULT_HOME_SECTIONS, SURFACE_TEMPLATE_CHOICES, effectiveSurfaceTemplate } from "../cms/defaults.js";
import { siteName } from "../site.js";
import { tenantCfg, tenantId } from "../tenant-context.js";
import { isBrandTenant } from "../brand-tenants.js";
import { livePath } from "../documents/paths.js";
import { legacyHeroToSection, legacyHomeSectionsToSections } from "../registry/legacy.js";
import { PAGES, campaignVisible } from "./pages.js";
import * as Docs from "./documents-reader.js";
import { ContentUnavailableError, isContentUnavailable as isContentUnavailableError } from "./documents-reader.js";
import { getPdpPairs, getCartUpsell } from "../catalog/upsells.js";
import { contentRowFor, collectionRowFor } from "../catalog/effective.js";
import { liveRowFor } from "../documents/live-rows.js";
import { db, libsql } from "../db.js";

export { PREVIEW_COOKIE };
export { ContentUnavailableError, isContentUnavailable } from "./documents-reader.js";

const HOME_LEGACY_KINDS = ["collections", "new", "banner", "product_rail"];
const ENTITY_SURFACE = { pdp: "product", collection: "collection" };
const V4_TEMPLATE_DOCUMENT = { pdp: "doc_product_layout", collection: "doc_collection_layout", header: "doc_header", footer: "doc_footer" };
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const parseJsonList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};

// ---- catalog handle healing & brand default pages ---------------------------

async function currentHandleMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  try {
    const rows = await db.selectFrom("collections").select(["id", "handle"]).where("id", "in", uniq).execute();
    return new Map(rows.map((r) => [r.id, r.handle]));
  } catch {
    return new Map();
  }
}

async function healHomeSections(sections) {
  const ids = sections.filter((s) => s.kind === "product_rail" && s.collection_id).map((s) => s.collection_id);
  if (!ids.length) return sections;
  const map = await currentHandleMap(ids);
  return sections.map((s) => {
    if (s.kind !== "product_rail" || !s.collection_id) return s;
    const cur = map.get(s.collection_id);
    return cur && cur !== s.collection ? { ...s, collection: cur } : s;
  });
}

async function healCollectionsIndex(value) {
  if (!value || typeof value !== "object") return value;
  const { ids, ...lists } = value;
  if (!ids || !Object.keys(ids).length) return lists;
  const map = await currentHandleMap(Object.values(ids));
  const heal = (list) => {
    const out = [];
    for (const h of Array.isArray(list) ? list : []) {
      const cur = ids[h] ? map.get(ids[h]) : null;
      const healed = cur || h;
      if (!out.includes(healed)) out.push(healed);
    }
    return out;
  };
  return { featured: heal(lists.featured), order: heal(lists.order), hide: heal(lists.hide) };
}

function defaultPage(slug) {
  if (!isBrandTenant(tenantId())) return null;
  const page = PAGES[slug];
  if (!page) return null;
  const site = tenantCfg("site", null, null) || {};
  if (slug !== "contact" || (!site.support_email && !site.support_phone)) return page;
  return {
    ...page,
    sections: page.sections.map((s) =>
      s.heading === "Customer care"
        ? {
            ...s,
            body: [
              site.support_email ? `Email: ${site.support_email}` : null,
              site.support_phone ? `Phone: ${site.support_phone}` : null,
            ].filter(Boolean),
          }
        : s,
    ),
  };
}

// ---- content source & preview resolution ------------------------------------

export const contentSource = cache(async () => {
  const src = await readContentSource();
  noteRequestScope(src);
  return src;
});

async function readContentSource() {
  let token = null;
  let parsed = null;
  let ended = null;
  try {
    token = (await cookies()).get(PREVIEW_COOKIE)?.value;
    if (token) parsed = await readPreviewToken(token);
    if (token && !parsed) ended = await readPreviewToken(token, { now: 0 });
  } catch {
    /* no request scope (scripts) -> not a preview */
  }
  if (parsed || ended?.sid) {
    if (!parsed) return { ...(await liveSource()), previewRefused: "expired" };
    if (parsed.sid) {
      const overlaid = await documentsPreview(parsed.sid);
      if (overlaid?.refused) return { ...(await liveSource()), previewRefused: overlaid.refused };
      if (overlaid) return overlaid;
    }
  }
  return liveSource();
}

export const REQUEST_SCOPE_KEY = Symbol.for("storeasy.requestScope");
const requestScope = (globalThis[REQUEST_SCOPE_KEY] ??= cache(() => ({ storeId: null, documentsPreview: false })));
function noteRequestScope(src) {
  try {
    const scope = requestScope();
    const id = tenantId();
    if (id && id !== "_default") scope.storeId = id;
    scope.documentsPreview = src?.preview === true && src?.v === DOCUMENTS_RELEASE_VERSION;
  } catch {
    /* no scope */
  }
}

async function liveSource() {
  const s = await getLiveReleaseState();
  if (s.state === "live") {
    if (s.release.v !== DOCUMENTS_RELEASE_VERSION) {
      throw new ContentUnavailableError({ code: "UNKNOWN_VERSION", release: s.release.id, v: s.release.v });
    }
    const list = Docs.parseList(s.release.content, { releaseId: s.release.id });
    return { mode: "live", v: DOCUMENTS_RELEASE_VERSION, list, releaseId: s.release.id, content: null, preview: false };
  }
  if (s.state === "none") {
    if (s.unmigrated) {
      return { mode: "live", v: DOCUMENTS_RELEASE_VERSION, list: Docs.emptyList(), releaseId: null, content: null, preview: false };
    }
    return { mode: "closed", v: DOCUMENTS_RELEASE_VERSION, list: Docs.emptyList(), releaseId: null, content: null, preview: false };
  }
  throw new ContentUnavailableError(s.error);
}

const REFUSED = { revoked: "revoked", expired: "expired", not_found: "not_found", other_store: "not_found" };
async function documentsPreview(sid) {
  const session = await readPreviewSession(sid);
  if (!session.ok) return Object.hasOwn(REFUSED, session.reason) ? { refused: REFUSED[session.reason] } : null;
  const s = await getLiveReleaseState();
  let base;
  let releaseId = null;
  if (s.state === "live") {
    if (s.release.v !== DOCUMENTS_RELEASE_VERSION) return null;
    base = Docs.parseList(s.release.content, { releaseId: s.release.id });
    releaseId = s.release.id;
  } else if (s.state === "none") {
    base = Docs.previewBaseList();
  } else {
    return null;
  }
  let rows;
  let offline;
  let entityRows;
  try {
    [rows, offline, entityRows] = await Promise.all([Docs.readDirtyDrafts(), offlineDocumentIds(), dirtyEntityDrafts()]);
  } catch (e) {
    slog("preview_drafts_read_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return null;
  }
  const { list, documents, designDirty } = Docs.overlayList(base, rows, { showDesign: session.session.showDesign });
  const shown = new Set(documents);
  const docs = {};
  for (const r of rows) if (shown.has(r.id)) docs[r.id] = r.draft_hash;
  const skipped = rows.filter((r) => !shown.has(r.id)).map((r) => r.id);
  for (const r of entityRows) {
    if (Docs.previewDraftBody(r)) docs[r.id] = r.draft_hash;
    else skipped.push(r.id);
  }
  return {
    mode: "live",
    v: DOCUMENTS_RELEASE_VERSION,
    list,
    releaseId,
    content: null,
    preview: true,
    overlay: {
      sid,
      documents,
      designDirty,
      showDesign: session.session.showDesign,
      otherTab: session.session.otherTab,
      docs,
      offline,
      skipped,
      designShown: shown.has("doc_design"),
    },
  };
}

async function dirtyEntityDrafts() {
  try {
    return await Docs.readDirtyEntityDrafts();
  } catch (e) {
    slog("preview_entity_drafts_read_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return [];
  }
}

async function offlineDocumentIds() {
  try {
    const r = await libsql.execute("SELECT id FROM documents WHERE archived_at IS NULL AND published_version_id IS NULL AND undone_version_id IS NOT NULL ORDER BY id");
    return r.rows.map((row) => String(row.id));
  } catch (e) {
    slog("preview_offline_read_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return [];
  }
}

export async function previewFrameRoutes() {
  const src = await contentSource();
  if (!(src.preview === true && isV4(src))) return null;
  const routes = { "/": "doc_home", "/collections": "doc_collections_index" };
  for (const p of src.list.pages) {
    const path = livePath(p.type === "campaign" ? "campaign" : "page", { slug: p.slug });
    if (path !== "/" && !Object.hasOwn(routes, path)) routes[path] = p.document;
  }
  try {
    for (const e of await journalIndexEntries(src)) {
      const path = livePath("journal", { slug: e.slug });
      if (e.document && path !== "/" && !Object.hasOwn(routes, path)) routes[path] = e.document;
    }
  } catch {
    /* journal index unreadable */
  }
  return routes;
}

const isV4 = (src) => src.v === DOCUMENTS_RELEASE_VERSION;
const bodiesOf = (src) => ({ bodies: src.bodies ?? null });
const docBodies = (src, ids) => Docs.documentBodies(src.list, ids, bodiesOf(src));
const chrome = (src) => docBodies(src, Docs.CHROME_DOCUMENTS);
const home = (src) => docBodies(src, Docs.HOME_DOCUMENTS);
async function pageChromeGuard(src) {
  await chrome(src);
}

// ---- closed store gate (PUB-06) ---------------------------------------------

export const STORE_CLOSED_CODE = "STORE_CLOSED";
export const STORE_CLOSED_MESSAGE = "This store isn't open yet.";
export const STORE_CLOSED_COD_ONLY_MESSAGE = "Card and UPI payments open when your store does. Use cash on delivery for a test order.";

export const closedSource = (src) =>
  !src || typeof src !== "object" || src.mode === "closed" || (src.preview === true && isV4(src) && src.releaseId == null);

export async function isStoreClosed() {
  return closedSource(await contentSource());
}

export async function closedStoreGate() {
  let src;
  try {
    src = await contentSource();
  } catch (e) {
    const code = e?.detail?.code;
    if (isContentUnavailableError(e) && (code === "CMS_MODE_UNAVAILABLE" || code === "UNKNOWN_CMS_MODE")) return { preview: false };
    return null;
  }
  if (src.mode === "closed") return { preview: false };
  if (src.preview === true && isV4(src) && src.releaseId == null) return { preview: true };
  return null;
}

// ---- candidate source & bound getters ---------------------------------------

export function candidateSource({ list, releaseId = null, bodies = new Map(), entityRows = null } = {}) {
  return Object.freeze({
    mode: "live",
    v: DOCUMENTS_RELEASE_VERSION,
    list: Docs.parseList(list, { releaseId }),
    releaseId,
    content: null,
    preview: false,
    bodies: bodies ?? new Map(),
    entityRows: entityRows ?? null,
  });
}

export function contentGettersFor(src) {
  if (!src || typeof src !== "object") throw new TypeError("contentGettersFor needs a content source");
  return Object.freeze({
    resolvedAnnouncement: () => announcementFrom(src),
    resolvedHero: () => heroFrom(src),
    resolvedHomeSections: () => homeSectionsFrom(src),
    resolvedHomePage: () => homePageFrom(src),
    resolvedNav: (which) => navFrom(src, which),
    resolvedCollectionsIndex: () => collectionsIndexFrom(src),
    resolvedPdpExtras: () => pdpExtrasFrom(src),
    resolvedContentPage: (slug) => contentPageFrom(src, slug),
    resolvedContentPageList: () => contentPageListFrom(src),
    resolvedJournalEntries: () => journalEntriesFrom(src),
    resolvedBrand: () => brandFrom(src),
    resolvedTheme: () => themeFrom(src),
    resolvedLogo: () => logoFrom(src),
    resolvedSurfaceTemplates: () => surfaceTemplatesFrom(src),
    resolvedSurfaceTemplateFor: (surface, entityId) => surfaceTemplateForFrom(src, surface, entityId),
    resolvedProductOverride: (productId) => productOverrideFrom(src, productId),
    resolvedCollectionPins: (handle) => collectionPinsFrom(src, handle),
    resolvedPdpPairs: (productId, opts) => pdpPairsFrom(src, productId, opts),
    resolvedCartUpsell: (excludeProductIds, opts) => cartUpsellFrom(src, excludeProductIds, opts),
    resolvedSlugRedirect: (slug) => slugRedirectFrom(src, slug),
  });
}

// ---- resolved getters -------------------------------------------------------

export async function resolvedAnnouncement() {
  return announcementFrom(await contentSource());
}
async function announcementFrom(src) {
  const body = (await chrome(src)).doc_announcement;
  return body ? Docs.announcementFromBody(body) : { ...DEFAULT_ANNOUNCEMENT };
}

export async function resolvedHero() {
  return heroFrom(await contentSource());
}
async function heroFrom(src) {
  const body = (await home(src)).doc_home;
  if (!body) return defaultHero(siteName());
  const hero = Docs.heroSectionOf(body);
  return hero ? Docs.heroFromSection(hero, defaultHero(siteName())) : null;
}

export async function resolvedHomeSections() {
  return homeSectionsFrom(await contentSource());
}
async function homeSectionsFrom(src) {
  const body = (await home(src)).doc_home;
  const sections = body ? Docs.homeSectionsFromBody(body) : DEFAULT_HOME_SECTIONS;
  return healHomeSections(sections);
}

export async function resolvedHomePage() {
  return homePageFrom(await contentSource());
}
async function homePageFrom(src) {
  const [, bodies] = await Promise.all([pageChromeGuard(src), home(src)]);
  const body = bodies.doc_home;
  if (!body) return [legacyHeroToSection(defaultHero(siteName())), ...legacyHomeSectionsToSections(await homeSectionsFrom(src))];
  return healRegistrySections(Docs.registrySectionsFromBody(body));
}

async function healRegistrySections(sections) {
  const rails = sections.map((s) =>
    s.kind === "product_rail" && s.settings?.collection?.id
      ? { kind: "product_rail", collection: s.settings.collection.handle, collection_id: s.settings.collection.id }
      : { kind: "other" },
  );
  if (!rails.some((r) => r.kind === "product_rail")) return sections;
  const healed = await healHomeSections(rails);
  return sections.map((s, i) =>
    healed[i].kind === "product_rail" && healed[i].collection !== s.settings.collection.handle
      ? { ...s, settings: { ...s.settings, collection: { ...s.settings.collection, handle: healed[i].collection } } }
      : s,
  );
}

export async function resolvedNav(...args) {
  return navFrom(await contentSource(), ...args);
}
async function navFrom(src, which) {
  return Docs.navFromBody((await chrome(src))[which === "footer" ? "doc_footer" : "doc_header"]);
}

export async function resolvedCollectionsIndex() {
  return collectionsIndexFrom(await contentSource());
}
async function collectionsIndexFrom(src) {
  const value = Docs.collectionsIndexFromBody((await home(src)).doc_collections_index);
  return value ? healCollectionsIndex(value) : null;
}

export async function resolvedPdpExtras() {
  return pdpExtrasFrom(await contentSource());
}
async function pdpExtrasFrom(src) {
  const [, bodies] = await Promise.all([pageChromeGuard(src), docBodies(src, Docs.PRODUCT_LAYOUT_DOCUMENTS)]);
  return Docs.pdpExtrasFromBody(bodies.doc_product_layout);
}

async function journalIndexEntries(src) {
  const e = src.list.indexes.journal;
  const published = e ? Docs.journalEntriesFromBody(await Docs.versionBody(e.version, { type: "journal_index", ...bodiesOf(src) })) : [];
  return Docs.overlayJournalEntries(published, src.list.journalDrafts);
}

export async function resolvedContentPage(...args) {
  return contentPageFrom(await contentSource(), ...args);
}
async function contentPageFrom(src, slug) {
  return (await Promise.all([pageChromeGuard(src), v4ContentPage(src, slug)]))[1];
}

async function v4ContentPage(src, slug) {
  const row = src.list.pages.find((p) => p.slug === slug);
  if (row) {
    if (row.enabled === false) return null;
    const draft = Docs.draftOf(src.list, row.document);
    if (draft) return Docs.pageFromBody(draft, row);
    const entry = Docs.entryOf(src.list, row.document);
    if (!entry) throw new ContentUnavailableError({ code: "MISSING_PAGE_VERSION", document: row.document, slug });
    return Docs.pageFromBody(await Docs.versionBody(entry.version, { documentId: row.document, ...bodiesOf(src) }), row);
  }
  const post = (await journalIndexEntries(src)).find((p) => p.slug === slug);
  if (post) {
    if (post.enabled === false) return null;
    const draft = Docs.draftOf(src.list, post.document);
    if (draft) return Docs.pageFromBody(draft, { ...post, type: "journal" });
    if (typeof post.version !== "string") throw new ContentUnavailableError({ code: "MISSING_PAGE_VERSION", slug });
    return Docs.pageFromBody(await Docs.versionBody(post.version, { ...(post.document ? { documentId: post.document } : {}), ...bodiesOf(src) }), { ...post, type: "journal" });
  }
  return Docs.usesCodeDefaults(src.list) ? defaultPage(slug) : null;
}

export async function resolvedContentPageList() {
  return contentPageListFrom(await contentSource());
}
async function contentPageListFrom(src) {
  const defaults = isBrandTenant(tenantId()) && Docs.usesCodeDefaults(src.list) ? PAGES : null;
  const bySlug = new Map(src.list.pages.map((r) => [r.slug, { slug: r.slug, title: r.title, enabled: r.enabled !== false, source: "custom", family: r.type || "page" }]));
  for (const slug of Object.keys(defaults || {})) if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: defaults[slug].title, enabled: true, source: "default" });
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function resolvedJournalEntries() {
  return journalEntriesFrom(await contentSource());
}
async function journalEntriesFrom(src) {
  return (await journalIndexEntries(src))
    .filter((e) => e.enabled !== false && campaignVisible(e))
    .map((e) => ({
      slug: e.slug,
      title: e.title ?? "",
      description: e.description || "",
      family: "journal",
      effective_at: e.effective_at || null,
      window_start: e.window_start || null,
      window_end: e.window_end || null,
    }));
}

export async function resolvedBrand() {
  return brandFrom(await contentSource());
}
async function brandFrom(src) {
  return Docs.designFromBody((await chrome(src)).doc_design).brand;
}

export async function resolvedTheme() {
  return themeFrom(await contentSource());
}
async function themeFrom(src) {
  return Docs.designFromBody((await chrome(src)).doc_design).theme;
}

export async function resolvedLogo() {
  return logoFrom(await contentSource());
}
async function logoFrom(src) {
  if (src.mode === "closed") return null;
  return Docs.designFromBody((await chrome(src)).doc_design).logo;
}

export async function resolvedSurfaceTemplates() {
  return surfaceTemplatesFrom(await contentSource());
}
async function surfaceTemplatesFrom(src) {
  const c = await chrome(src);
  return {
    header: effectiveSurfaceTemplate({ header: Docs.templateFromBody(c.doc_header) }, "header").template,
    footer: effectiveSurfaceTemplate({ footer: Docs.templateFromBody(c.doc_footer) }, "footer").template,
  };
}

export async function resolvedSurfaceTemplateFor(...args) {
  return surfaceTemplateForFrom(await contentSource(), ...args);
}
async function surfaceTemplateForFrom(src, surface, entityId) {
  const id = Object.hasOwn(V4_TEMPLATE_DOCUMENT, surface) ? V4_TEMPLATE_DOCUMENT[surface] : null;
  if (!id) {
    await pageChromeGuard(src);
    return effectiveSurfaceTemplate(null, surface, null);
  }
  const set = surface === "pdp" ? Docs.PRODUCT_LAYOUT_DOCUMENTS : surface === "collection" ? Docs.COLLECTION_LAYOUT_DOCUMENTS : Docs.CHROME_DOCUMENTS;
  const kind = entityId != null ? ENTITY_SURFACE[surface] : null;
  const [, bodies, row] = await Promise.all([pageChromeGuard(src), docBodies(src, set), kind ? entityRowOrNone(src, kind, String(entityId), "template") : null]);
  const own = row?.layout_template ?? null;
  if (own != null) {
    if ((SURFACE_TEMPLATE_CHOICES[surface] || []).includes(own)) return { template: own, source: "entity" };
    slog("entity_template_unavailable", { surface, entity: String(entityId).slice(0, 120), template: String(own).slice(0, 60) });
  }
  const body = bodies[id];
  return effectiveSurfaceTemplate({ [surface]: Docs.templateFromBody(body) }, surface, null);
}

// ---- entity live rows & draft preview overlay -------------------------------

async function entityRow(src, kind, id) {
  if (src.mode === "closed" || typeof id !== "string" || !id) return null;
  if (src.entityRows) {
    const m = src.entityRows[kind];
    const row = m instanceof Map ? m.get(id) : isPlainObj(m) && Object.hasOwn(m, id) ? m[id] : null;
    return isPlainObj(row) ? row : null;
  }
  return kind === "product" ? contentRowFor(id) : collectionRowFor(id);
}

async function entityRowOrNone(src, kind, id, part) {
  try {
    return await entityRow(src, kind, id);
  } catch (e) {
    slog("entity_row_read_failed", { kind, part, entity: String(id).slice(0, 120), error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return null;
  }
}

function overrideFromRow(row) {
  const modules = parseJsonList(row?.modules)
    .filter((m) => isPlainObj(m) && typeof m.title === "string" && typeof m.html === "string")
    .map((m) => ({ title: m.title, html: m.html }));
  return { modules, badge: typeof row?.badge === "string" ? row.badge : "" };
}

function pairsPlacement(productId, row) {
  const ids = parseJsonList(row?.pairs).filter((x) => typeof x === "string" && x);
  return ids.length
    ? [{ source_product_id: productId, target_product_ids: ids, title: typeof row.pairs_title === "string" && row.pairs_title ? row.pairs_title : null, enabled: true, position: 0 }]
    : [];
}

export async function previewEntityRow(type, entityId) {
  if (type !== "product_content" && type !== "collection_content") return null;
  if (typeof entityId !== "string" || !entityId) return null;
  const src = await contentSource();
  if (!(src.preview === true && isV4(src) && isPlainObj(src.overlay))) return null;
  try {
    const doc = await Docs.readEntityDraft(type, entityId);
    if (!doc) return null;
    const body = Docs.previewDraftBody(doc);
    if (!body) return null;
    return liveRowFor(type, body, { documentId: doc.id, versionId: null, publishedAt: null, entityId });
  } catch (e) {
    slog("preview_entity_draft_failed", { type, error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return null;
  }
}

export async function productPreviewView(productId, row, { limit = 4 } = {}) {
  const src = { ...(await contentSource()), entityRows: { product: new Map([[productId, row]]), collection: new Map() } };
  const [override, pairs, surface] = await Promise.all([productOverrideFrom(src, productId), pdpPairsFrom(src, productId, { limit }), surfaceTemplateForFrom(src, "pdp", productId)]);
  return { override, pairs, surface };
}

export async function collectionPreviewView(handle, collectionId, row) {
  const src = { ...(await contentSource()), entityRows: { product: new Map(), collection: new Map([[collectionId, row]]) } };
  const [pins, surface] = await Promise.all([collectionPinsFrom(src, handle), surfaceTemplateForFrom(src, "collection", collectionId)]);
  return { pins, surface };
}

export async function resolvedProductOverride(...args) {
  return productOverrideFrom(await contentSource(), ...args);
}
async function productOverrideFrom(src, productId) {
  return overrideFromRow(await entityRow(src, "product", productId));
}

export async function resolvedCollectionPins(...args) {
  return collectionPinsFrom(await contentSource(), ...args);
}
async function collectionPinsFrom(src, handle) {
  if (src.mode === "closed" || typeof handle !== "string" || !handle) return [];
  const found = await db.selectFrom("collections").select("id").where("handle", "=", handle).executeTakeFirst();
  if (!found?.id) return [];
  const pins = parseJsonList((await entityRow(src, "collection", String(found.id)))?.pinned);
  return pins.filter((x) => typeof x === "string" && x);
}

export async function resolvedPdpPairs(...args) {
  return pdpPairsFrom(await contentSource(), ...args);
}
async function pdpPairsFrom(src, productId, { limit = 4 } = {}) {
  return getPdpPairs(productId, { limit, placementRows: pairsPlacement(productId, await entityRowOrNone(src, "product", productId, "pairs")) });
}

export async function resolvedCartUpsell(...args) {
  return cartUpsellFrom(await contentSource(), ...args);
}
async function cartUpsellFrom(src, excludeProductIds = [], { limit = 3 } = {}) {
  const body = (await docBodies(src, Docs.CART_DOCUMENTS)).doc_cart;
  return getCartUpsell(excludeProductIds, { limit, placementRows: await cartPlacementRows(body) });
}

async function cartPlacementRows(body) {
  const list = Array.isArray(body?.settings?.products) ? body.settings.products.filter((p) => p && typeof p.handle === "string") : [];
  if (!list.length) return [];
  const needIds = list.filter((p) => !p.id).map((p) => p.handle);
  let byHandle = new Map();
  if (needIds.length) {
    try {
      byHandle = new Map((await db.selectFrom("products").select(["id", "handle"]).where("handle", "in", needIds).execute()).map((r) => [r.handle, r.id]));
    } catch {
      byHandle = new Map();
    }
  }
  const ids = list.map((p) => p.id || byHandle.get(p.handle)).filter(Boolean);
  return ids.length ? [{ kind: "cart_upsell", target_product_ids: ids, title: body.settings.title || null, enabled: true, position: 0 }] : [];
}

export async function resolvedSlugRedirect(...args) {
  return slugRedirectFrom(await contentSource(), ...args);
}
async function slugRedirectFrom(src, slug) {
  if (src.list.pages.some((p) => p.slug === slug)) return null;
  const hit = src.list.redirects.find((r) => r.from_slug === slug);
  if (!hit) return null;
  if ((await journalIndexEntries(src)).some((p) => p.slug === slug)) return null;
  return hit.to_slug;
}
