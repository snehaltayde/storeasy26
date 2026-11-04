// Storefront content resolution (Session 36 / BE09 + SF23). SERVER COMPONENT
// ONLY (imports next/headers) — pages and the layout read content through
// here instead of the draft store, so:
//   · a LIVE release exists → its frozen snapshot serves, drafts never leak;
//   · no release yet (pre-first-publish) → drafts serve (pre-S36 behavior);
//   · a valid preview cookie → drafts serve to THAT browser only, with
//     Cache-Control kept dynamic (cookie-based, so no published URL ever
//     carries preview content).
// One statement per request reads the pointer and its release row together
// (React cache), shared by every getter.
//
// P2-READ (PUB-01): the release's version picks the reader BEFORE any helper
// runs. v1, v2 and v3 go to the frozen legacy reader (./legacy-release.js);
// v4 goes to the documents reader (./documents-reader.js), which reads only
// the document versions a route needs. Each getter below has both branches.
import { cache } from "react";
import { cookies } from "next/headers";
import { getLiveReleaseState, readPreviewToken, LEGACY_RELEASE_VERSIONS, DOCUMENTS_RELEASE_VERSION } from "../releases.js";
import { readPreviewSession } from "../preview-sessions.js";
import { slog } from "../log.js";
import {
  getAnnouncement,
  getHero,
  getHomeSections,
  getNav,
  getCollectionsIndex,
  getPdpExtras,
  getContentPage,
  listContentPages,
  defaultPage,
  brandDefaultsApply,
  campaignVisible,
} from "../cms/store.js";
import { DEFAULT_ANNOUNCEMENT, defaultHero, DEFAULT_HOME_SECTIONS, DEFAULT_SURFACE_TEMPLATES, effectiveSurfaceTemplate } from "../cms/defaults.js";
import { siteName } from "../site.js";
import { tenantOwnCfg, tenantId } from "../tenant-context.js";
import { livePath } from "../documents/paths.js";
import { publishBlocked } from "../brand.js";
import { kitAttr } from "../themes/kits.js";
import { getCmsMode } from "../cms-mode.js";
import { legacyHeroToSection, legacyHomeSectionsToSections } from "../registry/legacy.js";
import * as Legacy from "./legacy-release.js";
import * as Docs from "./documents-reader.js";
import { ContentUnavailableError, isContentUnavailable as isContentUnavailableError } from "./documents-reader.js";

import { getPreviewCandidate, PREVIEW_COOKIE } from "../cms/candidates.js";

export { PREVIEW_COOKIE }; // canonical definition moved to candidates.js (plain-Node importable)

// S53 (audit A2): thrown when published content SHOULD exist but cannot be
// read or validated. Defined in ./documents-reader.js (the v4 reader throws it
// too) and re-exported here, where every caller has always imported it.
export { ContentUnavailableError, isContentUnavailable } from "./documents-reader.js";

// { mode: "draft" | "live", content: snapshot|null, preview: bool, candidate }
// v4: { mode: "live", v: 4, list, releaseId, content: null, preview: false }
// closed (PUB-06: documents mode, never published): { mode: "closed", v: 4,
//   list: Docs.emptyList(), releaseId: null, content: null, preview: false }.
//   v4-shaped on purpose: every getter takes its v4 path over the empty list
//   and returns neutral empties; no getter has a closed branch of its own.
// v4 preview (P2-PREVIEW): { mode: "live", v: 4, list (drafts laid over),
//   releaseId, content: null, preview: true, overlay }
//
// Which preview a cookie gets (PV-03, plan section 6):
//   · legacy or migrating store, any valid token: today's draft preview
//     (drafts from the legacy tables, plus the S59 candidate);
//   · documents store, a session token (p.<exp>.<sid>.<hmac>) whose
//     preview_sessions row is this store's, unexpired and not revoked: the
//     live list with every saved draft laid over it;
//   · documents store, an old-format token, or a session that doesn't count
//     (or can't be read): live content only, never legacy drafts.
//
// P3-FRAME (PV-01): a session token this store signed whose session no longer
// counts (revoked, expired, or not found) is a preview that ENDED: the live
// content serves, with previewRefused = that reason, so the layout can say
// "Your preview has ended" and tell the editor's frame. A token that is not
// this store's signature (tampered, forged) is no preview at all, as before.
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
    // signed by this store, but past its own expiry: a session that ended
    if (token && !parsed) ended = await readPreviewToken(token, { now: 0 });
  } catch {
    /* no request scope (scripts) → not a preview */
  }
  if (parsed || ended?.sid) {
    // Only a founder's browser gets here (a token this store signed). The
    // mode decides which preview: an unreadable mode gives no preview at all
    // (the live path below fails closed on its own if it must).
    let mode = null;
    try {
      mode = await getCmsMode();
    } catch {
      mode = null;
    }
    if (parsed && (mode === "legacy" || mode === "migrating")) {
      // S59: this preview session's UNSAVED edits (designer-pushed, validated
      // at write). Best-effort — null means "show the last save", never a 500.
      const candidate = await getPreviewCandidate(token);
      return { mode: "draft", content: null, preview: true, candidate };
    }
    if (mode === "documents" && !parsed) return { ...(await liveSource()), previewRefused: "expired" };
    if (mode === "documents" && parsed.sid) {
      const overlaid = await documentsPreview(parsed.sid);
      if (overlaid?.refused) return { ...(await liveSource()), previewRefused: overlaid.refused };
      if (overlaid) return overlaid;
    }
  }
  return liveSource();
}

// ---- P3-FRAME: what this request renders, for the components ---------------------
//
// The section renderers (components/sections/index.js) run outside tfetch,
// as plain synchronous functions, and can't import this module (next/headers
// would reach every suite that renders them). So contentSource, which runs
// inside the request's store, notes two facts in a per-request holder (React
// cache, the same per-request scope as contentSource itself), published
// under a global symbol the components read:
//   storeId           the store's id, for their log lines (section_render_failed)
//   documentsPreview  this request is a founder's documents preview: the
//                     preview-only data-doc / data-field attributes render
// Outside a request (scripts, a plain render) the holder is a fresh object
// each call, so the answer there is "unknown" and "not a preview".
export const REQUEST_SCOPE_KEY = Symbol.for("storeasy.requestScope");
const requestScope = (globalThis[REQUEST_SCOPE_KEY] ??= cache(() => ({ storeId: null, documentsPreview: false })));
function noteRequestScope(src) {
  try {
    const scope = requestScope();
    const id = tenantId();
    if (id && id !== "_default") scope.storeId = id;
    scope.documentsPreview = src?.preview === true && src?.v === DOCUMENTS_RELEASE_VERSION;
  } catch {
    /* no scope: nothing to note */
  }
}

async function liveSource() {
  const s = await getLiveReleaseState();
  if (s.state === "live") {
    // The version gate (P2-VGATE): only a v1, v2 or v3 snapshot may reach the
    // legacy helpers; a v4 list goes to the documents reader. getLiveReleaseState
    // already refuses other versions; this repeats it so no helper sees one.
    if (s.release.v === DOCUMENTS_RELEASE_VERSION) {
      const list = Docs.parseList(s.release.content, { releaseId: s.release.id });
      return { mode: "live", v: DOCUMENTS_RELEASE_VERSION, list, releaseId: s.release.id, content: null, preview: false };
    }
    if (!LEGACY_RELEASE_VERSIONS.includes(s.release.v)) {
      throw new ContentUnavailableError({ code: "UNKNOWN_VERSION", release: s.release.id, v: s.release.v });
    }
    return { mode: "live", content: s.release.content, preview: false };
  }
  if (s.state === "none") {
    // No release: which content system the store runs on decides (spec 8.7).
    // legacy (also a store from before 0021, with no cms_state table) and
    // migrating keep today's draft path; a documents store that has never
    // published has nothing to show; anything else fails closed.
    let mode;
    try {
      mode = await getCmsMode();
    } catch (e) {
      throw new ContentUnavailableError({ code: "CMS_MODE_UNAVAILABLE", error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    }
    if (mode === "legacy" || mode === "migrating") return { mode: "draft", content: null, preview: false }; // pre-first-publish: drafts serve, as always
    // PUB-06: a documents store before its first publish is closed. Drafts
    // never serve here; a founder's valid preview session went to
    // documentsPreview above, before this.
    if (mode === "documents") return { mode: "closed", v: DOCUMENTS_RELEASE_VERSION, list: Docs.emptyList(), releaseId: null, content: null, preview: false };
    throw new ContentUnavailableError({ code: "UNKNOWN_CMS_MODE", mode: String(mode).slice(0, 40) });
  }
  throw new ContentUnavailableError(s.error); // read failure ≠ "no release" — fail closed
}

// P2-PREVIEW: the documents preview for a session token, or null for "no
// overlay" (the caller then serves live content). Never throws for the
// session or drafts read: a shopper-path 5xx is never the answer to a broken
// preview table. A broken live release still fails closed, as for anyone.
// P3-FRAME: { refused: reason } when the session ended (revoked, expired) or
// is not this store's (not_found; a row of another store reads the same).
// A missing table or a read error stays null: nothing to say to the founder.
const REFUSED = { revoked: "revoked", expired: "expired", not_found: "not_found", other_store: "not_found" };
async function documentsPreview(sid) {
  const session = await readPreviewSession(sid); // logs a read error itself
  if (!session.ok) return Object.hasOwn(REFUSED, session.reason) ? { refused: REFUSED[session.reason] } : null;
  const s = await getLiveReleaseState();
  let base;
  let releaseId = null;
  if (s.state === "live") {
    if (s.release.v !== DOCUMENTS_RELEASE_VERSION) return null; // a legacy release on a documents store: nothing to lay drafts over
    base = Docs.parseList(s.release.content, { releaseId: s.release.id });
    releaseId = s.release.id;
  } else if (s.state === "none") {
    base = Docs.previewBaseList(); // never published: drafts over emptyList(m)
  } else {
    return null; // the live path reports the read failure
  }
  let rows;
  let offline;
  try {
    [rows, offline] = await Promise.all([Docs.readDirtyDrafts(), offlineDocumentIds()]);
  } catch (e) {
    slog("preview_drafts_read_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return null;
  }
  const { list, documents, designDirty } = Docs.overlayList(base, rows, { showDesign: session.session.showDesign });
  // P3-FRAME: what the editor's frame is told it shows. docs: each overlaid
  // document's draft hash (so the editor knows which save it sees); skipped:
  // dirty drafts the preview could not show (unreadable, or the design while
  // its colours are hidden); offline: documents taken offline (Undo of a first
  // publish, or unpublish), whose page the banner flags.
  const shown = new Set(documents);
  const docs = {};
  for (const r of rows) if (shown.has(r.id)) docs[r.id] = r.draft_hash;
  const skipped = rows.filter((r) => !shown.has(r.id)).map((r) => r.id);
  return {
    mode: "live",
    v: DOCUMENTS_RELEASE_VERSION,
    list,
    releaseId,
    content: null,
    preview: true,
    overlay: { sid, documents, designDirty, showDesign: session.session.showDesign, otherTab: session.session.otherTab, docs, offline, skipped, designShown: shown.has("doc_design") },
  };
}

// P3-FRAME: documents taken offline (decision 4: published_version_id null,
// undone_version_id set), not archived. Preview only. A read failure is an
// empty list (the banner just doesn't say "offline"), logged.
async function offlineDocumentIds() {
  try {
    const r = await libsql.execute("SELECT id FROM documents WHERE archived_at IS NULL AND published_version_id IS NULL AND undone_version_id IS NOT NULL ORDER BY id");
    return r.rows.map((row) => String(row.id));
  } catch (e) {
    slog("preview_offline_read_failed", { error: String(e?.cause?.message || e?.message || e).slice(0, 200) });
    return [];
  }
}

// P3-FRAME (ED-04, ED-02): in a documents preview, which document each of the
// store's addresses shows: "/" the home page, "/collections" the collections
// index, each page and campaign row at its address (livePath), and each
// journal post (published or draft). null outside a documents preview. The
// layout hands it to the client pieces that know the address (data-doc on
// <main>, the banner's offline line); components/preview/bridge-core.js
// routeDocFor adds product and collection pages (their layout documents).
// Costs the journal index read in a preview only (cached per request).
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
    /* the journal index can't be read: its posts carry no data-doc */
  }
  return routes;
}

const isV4 = (src) => src.v === DOCUMENTS_RELEASE_VERSION;
const chrome = (src) => Docs.documentBodies(src.list, Docs.CHROME_DOCUMENTS);
const home = (src) => Docs.documentBodies(src.list, Docs.HOME_DOCUMENTS);

// Finding 3 (P2-DRILLS, PUB-01): a chrome version that can't be read must give
// the error page, not a page inside neutral chrome. The layout keeps its
// neutral-chrome catch (the error page needs a frame); the page getters await
// the same chrome read, so the page itself throws ContentUnavailableError and
// error.js renders. It is the very read the layout makes (same ids, same
// per-request cache), so a full render issues no extra statement. A request
// that skips the layout (an RSC navigation) pays that one statement.
async function pageChromeGuard(src) {
  if (isV4(src)) await chrome(src);
}

// ---- PUB-06: the closed store --------------------------------------------------------

export const STORE_CLOSED_CODE = "STORE_CLOSED";
export const STORE_CLOSED_MESSAGE = "This store isn't open yet.";
export const STORE_CLOSED_COD_ONLY_MESSAGE = "Card and UPI payments open when your store does. Use cash on delivery for a test order.";

// The store has never published on the new editor, so it is closed to
// shoppers. Also true inside a founder's preview of such a store: the store
// is still closed, the preview only lets that one browser look in. Reads the
// request's cached source (no statement where a getter already ran).
export async function isStoreClosed() {
  const src = await contentSource();
  return src.mode === "closed" || (src.preview === true && isV4(src) && src.releaseId == null);
}

// For the routes that take shopper input (checkout and the forms):
//   null                 the store is open (or legacy): carry on as today
//   { preview: false }   closed, and this request has no valid preview session
//   { preview: true }    closed, and this request carries a valid preview
//                        session (a _preview token this store signed whose
//                        preview_sessions row counts). A bare console cookie
//                        (_admin, _platform, _mx) is not proof.
// When the content source can't be read: closed only if the failure was
// deciding the mode of a store with no release (it may be a closed one);
// any other failure leaves the route as it is today, as a store with a
// release is open.
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

export async function resolvedAnnouncement() {
  const src = await contentSource();
  if (src.candidate?.announcement) return { ...DEFAULT_ANNOUNCEMENT, ...src.candidate.announcement }; // S59: unsaved edits, this preview only
  if (src.mode === "draft") return getAnnouncement();
  if (isV4(src)) {
    const body = (await chrome(src)).doc_announcement;
    return body ? Docs.announcementFromBody(body) : { ...DEFAULT_ANNOUNCEMENT };
  }
  return Legacy.legacyAnnouncement(src.content);
}

// v4: the home document's hero section, in the legacy hero shape; null when
// the published home page shows no hero (DOC-07 lets the founder hide it).
export async function resolvedHero() {
  const src = await contentSource();
  if (src.candidate?.hero) return { ...defaultHero(siteName()), ...src.candidate.hero }; // S59
  if (src.mode === "draft") return getHero();
  if (isV4(src)) {
    const body = (await home(src)).doc_home;
    if (!body) return defaultHero(siteName());
    const hero = Docs.heroSectionOf(body);
    return hero ? Docs.heroFromSection(hero, defaultHero(siteName())) : null;
  }
  return Legacy.legacyHero(src.content, siteName());
}

export async function resolvedHomeSections() {
  const src = await contentSource();
  const { HOME_SECTION_KINDS } = await import("../cms/registry.js");
  const { healHomeSections } = await import("../cms/store.js");
  if (Array.isArray(src.candidate?.home_sections)) {
    // S59: unsaved sections — validated shapes, same filter + healing as a save
    return healHomeSections(src.candidate.home_sections.filter((s) => s.enabled !== false && HOME_SECTION_KINDS.includes(s.kind)));
  }
  if (src.mode === "draft") return getHomeSections();
  if (isV4(src)) {
    const body = (await home(src)).doc_home;
    // null: the code default. A published home with no sections (besides the
    // hero) is an explicit empty, never DEFAULT_HOME_SECTIONS (DOC-07).
    const sections = body ? Docs.homeSectionsFromBody(body) : DEFAULT_HOME_SECTIONS;
    return healHomeSections(sections.filter((s) => s.enabled !== false && HOME_SECTION_KINDS.includes(s.kind)));
  }
  // S57: live snapshots are immutable, but the CATALOG isn't release-owned —
  // id-bearing collection refs heal to the catalog's current handles.
  return healHomeSections(Legacy.legacyHomeSections(src.content, HOME_SECTION_KINDS));
}

// P2-READ (DOC-07): the home page as registry-shaped sections, the hero
// included, for every store. Legacy stores (and previews, with the S59
// candidate) are built from the legacy getters through lib/registry/legacy.js.
// Experiments are applied by the page, not here.
export async function resolvedHomePage() {
  const src = await contentSource();
  if (isV4(src)) {
    const [, bodies] = await Promise.all([pageChromeGuard(src), home(src)]);
    const body = bodies.doc_home;
    if (!body) return [legacyHeroToSection(defaultHero(siteName())), ...legacyHomeSectionsToSections(await resolvedHomeSections())];
    return healRegistrySections(Docs.registrySectionsFromBody(body));
  }
  const [hero, sections] = await Promise.all([resolvedHero(), resolvedHomeSections()]);
  // P2-SECTIONS: a section from an old live snapshot that has no id keeps the
  // key the home page always gave it ("i-<n>", its data-sec), as legacyKey.
  return [legacyHeroToSection(hero), ...legacyHomeSectionsToSections(sections).map((s, i) => (sections[i]?.id ? s : { ...s, legacyKey: `i-${i}` }))];
}

// healHomeSections for registry-shaped rails: the stored handle is replaced
// by the catalog's current one for the recorded collection id.
async function healRegistrySections(sections) {
  const { healHomeSections } = await import("../cms/store.js");
  const rails = sections.map((s) =>
    s.kind === "product_rail" && s.settings?.collection?.id ? { kind: "product_rail", collection: s.settings.collection.handle, collection_id: s.settings.collection.id } : { kind: "other" },
  );
  if (!rails.some((r) => r.kind === "product_rail")) return sections;
  const healed = await healHomeSections(rails);
  return sections.map((s, i) => (healed[i].kind === "product_rail" && healed[i].collection !== s.settings.collection.handle ? { ...s, settings: { ...s.settings, collection: { ...s.settings.collection, handle: healed[i].collection } } } : s));
}

export async function resolvedNav(which) {
  const src = await contentSource();
  if (src.mode === "draft") return getNav(which);
  if (isV4(src)) return Docs.navFromBody((await chrome(src))[which === "footer" ? "doc_footer" : "doc_header"]);
  return Legacy.legacyNav(src.content, which);
}

// S38 (SF02 + SF04): curated collection index and PDP accordions follow the
// same release discipline as every other block.
export async function resolvedCollectionsIndex() {
  const src = await contentSource();
  if (src.mode === "draft") return getCollectionsIndex();
  const value = isV4(src) ? Docs.collectionsIndexFromBody((await home(src)).doc_collections_index) : Legacy.legacyCollectionsIndex(src.content);
  if (!value) return null;
  const { healCollectionsIndex } = await import("../cms/store.js");
  return healCollectionsIndex(value); // S57: heal renamed handles from ids
}

export async function resolvedPdpExtras() {
  const src = await contentSource();
  if (src.mode === "draft") return getPdpExtras();
  if (isV4(src)) {
    const [, bodies] = await Promise.all([pageChromeGuard(src), Docs.documentBodies(src.list, Docs.PRODUCT_LAYOUT_DOCUMENTS)]);
    return Docs.pdpExtrasFromBody(bodies.doc_product_layout);
  }
  return Legacy.legacyPdpExtras(src.content);
}

// v4: the journal index version, read once per request (journal routes only).
// In a preview, draft posts are laid over the published entries.
async function journalIndexEntries(src) {
  const e = src.list.indexes.journal;
  const published = e ? Docs.journalEntriesFromBody(await Docs.versionBody(e.version, { type: "journal_index" })) : [];
  return Docs.overlayJournalEntries(published, src.list.journalDrafts);
}

export async function resolvedContentPage(slug) {
  const src = await contentSource();
  if (src.mode === "draft") return getContentPage(slug);
  if (isV4(src)) return (await Promise.all([pageChromeGuard(src), v4ContentPage(src, slug)]))[1];
  const hit = Legacy.legacyContentPage(src.content, slug);
  return hit.row ? hit.page : defaultPage(slug);
}

// v4 (and closed): a page, a campaign or a journal post, else the code
// default page (never on the closed list).
async function v4ContentPage(src, slug) {
  // a page or campaign: the list row, then only that page's version
  const row = src.list.pages.find((p) => p.slug === slug);
  if (row) {
    if (row.enabled === false) return null;
    const draft = Docs.draftOf(src.list, row.document); // preview only
    if (draft) return Docs.pageFromBody(draft, row);
    const entry = Docs.entryOf(src.list, row.document);
    if (!entry) throw new ContentUnavailableError({ code: "MISSING_PAGE_VERSION", document: row.document, slug });
    return Docs.pageFromBody(await Docs.versionBody(entry.version, { documentId: row.document }), row);
  }
  // a journal post: its index entry, then its version
  const post = (await journalIndexEntries(src)).find((p) => p.slug === slug);
  if (post) {
    if (post.enabled === false) return null;
    const draft = Docs.draftOf(src.list, post.document); // preview only
    if (draft) return Docs.pageFromBody(draft, { ...post, type: "journal" });
    if (typeof post.version !== "string") throw new ContentUnavailableError({ code: "MISSING_PAGE_VERSION", slug });
    return Docs.pageFromBody(await Docs.versionBody(post.version, post.document ? { documentId: post.document } : {}), { ...post, type: "journal" });
  }
  return Docs.usesCodeDefaults(src.list) ? defaultPage(slug) : null;
}

// Sitemap/console list: live mode lists the RELEASE's pages + defaults, so an
// unpublished draft page never shows up in the published sitemap.
// v4: list.pages (pages and campaigns, from the list itself) plus the code
// default pages. No version body is read and the journal index never is: the
// layout's footer and the checkout's policy links call this on every page.
// Journal posts come from resolvedJournalEntries().
export async function resolvedContentPageList() {
  const src = await contentSource();
  if (src.mode === "draft") return listContentPages();
  let defaults = null;
  if (brandDefaultsApply() && (!isV4(src) || Docs.usesCodeDefaults(src.list))) ({ PAGES: defaults } = await import("../content/pages.js"));
  if (isV4(src)) {
    const bySlug = new Map(src.list.pages.map((r) => [r.slug, { slug: r.slug, title: r.title, enabled: r.enabled !== false, source: "custom", family: r.type || "page" }]));
    for (const slug of Object.keys(defaults || {})) if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: defaults[slug].title, enabled: true, source: "default" });
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }
  return Legacy.legacyContentPageList(src.content, defaults);
}

// P2-READ (PERF-01): the journal posts shoppers may see now, for /journal and
// the sitemap. v4: the journal index version, read once, filtered with
// campaignVisible on the index's own fields (no post body is read). Legacy:
// today's loop (the page list, then each post), so the output is unchanged.
export async function resolvedJournalEntries() {
  const src = await contentSource();
  if (isV4(src)) {
    // No chrome guard here (finding 3): the sitemap reads this too, and its
    // statement count is pinned at the pointer plus the index (test-perf-docs).
    // A journal post's own page is guarded (resolvedContentPage).
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
  const list = (await resolvedContentPageList()).filter((p) => p.enabled && p.family === "journal");
  const out = [];
  for (const p of list) {
    const page = await resolvedContentPage(p.slug);
    if (page && campaignVisible(page)) out.push(page);
  }
  return out;
}

// Brand tokens are part of the release too: once published, a brand edit in
// the console stays draft until the next publish (previewable like content).
export async function resolvedBrand() {
  const src = await contentSource();
  if (src.mode === "draft") {
    const brand = tenantOwnCfg("brand", null, null) || null;
    // TOK-02: saving no longer refuses an unreadable colour (publishing does).
    // Before the first publish the drafts ARE the live store, so shoppers get
    // the platform default look until the brand would pass a publish. The
    // founder's preview still shows exactly what they saved.
    if (brand && !src.preview && publishBlocked(brand, { kit: kitAttr(tenantOwnCfg("theme", null, null) || null) })) return null;
    return brand;
  }
  if (isV4(src)) return Docs.designFromBody((await chrome(src)).doc_design).brand;
  return Legacy.legacyBrand(src.content);
}

// Theme kit pin (S37) — same release discipline as brand.
export async function resolvedTheme() {
  const src = await contentSource();
  if (src.mode === "draft") return tenantOwnCfg("theme", null, null) || null;
  if (isV4(src)) return Docs.designFromBody((await chrome(src)).doc_design).theme;
  return Legacy.legacyTheme(src.content);
}

// S56: per-surface templates — release-governed like every block (preview
// shows the draft pick; shoppers see it after publish).
// v4: the chrome templates, from the header and footer documents. The product
// and collection templates are read per route (resolvedSurfaceTemplateFor),
// so the layout never loads the layout documents.
export async function resolvedSurfaceTemplates() {
  const src = await contentSource();
  const { getSurfaceTemplates } = await import("../cms/store.js");
  if (src.mode === "draft") return getSurfaceTemplates();
  if (isV4(src)) {
    const c = await chrome(src);
    return {
      header: effectiveSurfaceTemplate({ header: Docs.templateFromBody(c.doc_header) }, "header").template,
      footer: effectiveSurfaceTemplate({ footer: Docs.templateFromBody(c.doc_footer) }, "footer").template,
    };
  }
  return Legacy.legacySurfaceTemplates(src.content);
}

// S57: the template ONE entity renders with — explicit entity assignment →
// family default → platform default, same release discipline as every block
// (drafts read the table, live reads the frozen snapshot). Returns
// { template, source } so callers can also explain the choice.
// v4: per-entity templates wait for OVL; every entity gets the family default
// from its layout document (the header and footer from theirs).
const V4_TEMPLATE_DOCUMENT = { pdp: "doc_product_layout", collection: "doc_collection_layout", header: "doc_header", footer: "doc_footer" };
export async function resolvedSurfaceTemplateFor(surface, entityId) {
  const src = await contentSource();
  if (src.mode === "draft") {
    const { getBlock } = await import("../cms/store.js");
    return effectiveSurfaceTemplate(await getBlock("surface_templates"), surface, entityId);
  }
  if (isV4(src)) {
    const id = Object.hasOwn(V4_TEMPLATE_DOCUMENT, surface) ? V4_TEMPLATE_DOCUMENT[surface] : null;
    if (!id) {
      await pageChromeGuard(src);
      return effectiveSurfaceTemplate(null, surface, null);
    }
    const set = surface === "pdp" ? Docs.PRODUCT_LAYOUT_DOCUMENTS : surface === "collection" ? Docs.COLLECTION_LAYOUT_DOCUMENTS : Docs.CHROME_DOCUMENTS;
    const [, bodies] = await Promise.all([pageChromeGuard(src), Docs.documentBodies(src.list, set)]);
    const body = bodies[id];
    return effectiveSurfaceTemplate({ [surface]: Docs.templateFromBody(body) }, surface, null);
  }
  return effectiveSurfaceTemplate(Legacy.liveBlock(src.content, "surface_templates"), surface, entityId);
}

// ---- S53 (0B-2): the rest of the presentation state ------------------------
// Product modules/badges, collection pins, upsell placements and slug
// redirects used to apply on save, outside preview/publish/rollback. They now
// follow the same discipline: drafts (and preview) read the tables; live
// reads the v2 snapshot. A v1 release never froze these sets, so the pure
// helpers return null and we fall back to the tables — exactly what those
// releases were reviewed under.
// v4 (plan decision 9): product overrides, collection pins and PDP pairs are
// neutral empties until OVL lands, and never fall back to the legacy tables.
import { getProductOverride } from "../catalog-overrides.js";
import { getPdpPairs, getCartUpsell } from "../cms/placements.js";
import { resolveSlugRedirect } from "../cms/store.js";
import { collectionPinsByHandle } from "../repo.js";
import { db, libsql } from "../db.js";

export async function resolvedProductOverride(productId) {
  const src = await contentSource();
  if (src.mode === "draft") return getProductOverride(productId);
  if (isV4(src)) return { modules: [], badge: "" };
  const hit = Legacy.presentationProductOverride(src.content, productId);
  return hit ? hit.found : getProductOverride(productId); // null = v1 release → live tables
}

export async function resolvedCollectionPins(handle) {
  const src = await contentSource();
  if (src.mode === "draft") return collectionPinsByHandle(handle);
  if (isV4(src)) return [];
  if (!Legacy.presentationCollectionPins(src.content, "")) return collectionPinsByHandle(handle); // v1
  let collectionId = null;
  try {
    const row = await db.selectFrom("collections").select("id").where("handle", "=", handle).executeTakeFirst();
    collectionId = row?.id || null;
  } catch {
    return [];
  }
  if (!collectionId) return [];
  return Legacy.presentationCollectionPins(src.content, collectionId).found;
}

// v4: no hand-picked pairs (an empty placement set, so the placements table is
// never read); the automatic same-collection strip still comes from the catalog,
// as on a v2 or v3 release with no pairs.
export async function resolvedPdpPairs(productId, { limit = 4 } = {}) {
  const src = await contentSource();
  if (src.mode === "draft") return getPdpPairs(productId, { limit });
  if (isV4(src)) return getPdpPairs(productId, { limit, placementRows: [] });
  const rows = Legacy.presentationPlacements(src.content, "pdp_pairs");
  return getPdpPairs(productId, { limit, ...(rows ? { placementRows: rows } : {}) });
}

// v4: the cart document's suggestions; no document is no upsell (the code
// default, as an untouched legacy cart).
export async function resolvedCartUpsell(excludeProductIds = [], { limit = 3 } = {}) {
  const src = await contentSource();
  if (src.mode === "draft") return getCartUpsell(excludeProductIds, { limit });
  if (isV4(src)) {
    const body = (await Docs.documentBodies(src.list, Docs.CART_DOCUMENTS)).doc_cart;
    return getCartUpsell(excludeProductIds, { limit, placementRows: await cartPlacementRows(body) });
  }
  const rows = Legacy.presentationPlacements(src.content, "cart_upsell");
  return getCartUpsell(excludeProductIds, { limit, ...(rows ? { placementRows: rows } : {}) });
}

async function cartPlacementRows(body) {
  const list = Array.isArray(body?.settings?.products) ? body.settings.products.filter((p) => p && typeof p.handle === "string") : [];
  if (!list.length) return [];
  // a pick made by handle only: the catalog's id for it (a catalog read)
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

// v4: list.redirects; a page or journal post at the same slug wins.
export async function resolvedSlugRedirect(slug) {
  const src = await contentSource();
  if (src.mode === "draft") return resolveSlugRedirect(slug);
  if (isV4(src)) {
    if (src.list.pages.some((p) => p.slug === slug)) return null;
    const hit = src.list.redirects.find((r) => r.from_slug === slug);
    if (!hit) return null;
    if ((await journalIndexEntries(src)).some((p) => p.slug === slug)) return null;
    return hit.to_slug;
  }
  const hit = Legacy.presentationSlugRedirect(src.content, slug);
  return hit ? hit.found : resolveSlugRedirect(slug); // v1 → live table
}
