// P2-READ (PUB-01): the FROZEN legacy reader. The pure rules that turn a
// version 1, 2 or 3 release snapshot into what each storefront getter returns.
// Moved here unchanged from lib/content/resolve.js (the live branches) and
// lib/content/presentation.js (the S53 presentation helpers), so the v4 reader
// can grow next to them without touching how legacy releases read.
//
// Frozen: a change here changes what every legacy store's shoppers see. The
// release suite compares these answers with outputs recorded from a6d028e
// (scripts/fixtures/legacy-release-outputs.a6d028e.json).
//
// Pure and edge-safe: no database, no React, no Next, no node: imports. Each
// function takes the release's `content` (a v1, v2 or v3 snapshot). Callers in
// resolve.js add what needs the database (healing renamed collection handles,
// the v1 fall-back to live tables, catalog reads).
import { normalizePageSections } from "../cms/schemas.js";
import { DEFAULT_ANNOUNCEMENT, defaultHero, DEFAULT_HOME_SECTIONS, DEFAULT_NAV_HEADER, DEFAULT_NAV_FOOTER, DEFAULT_SURFACE_TEMPLATES } from "../cms/defaults.js";

export const liveBlock = (content, key) => (Object.hasOwn(content.blocks || {}, key) ? content.blocks[key] : null);

export const legacyAnnouncement = (content) => ({ ...DEFAULT_ANNOUNCEMENT, ...(liveBlock(content, "announcement") || {}) });

export const legacyHero = (content, name) => ({ ...defaultHero(name), ...(liveBlock(content, "hero") || {}) });

// Before healing (resolve.js heals renamed collection handles from ids).
export function legacyHomeSections(content, homeKinds) {
  const rows = liveBlock(content, "home_sections");
  const sections = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  return sections.filter((s) => s.enabled !== false && homeKinds.includes(s.kind));
}

export function legacyNav(content, which) {
  const value = liveBlock(content, which === "footer" ? "nav_footer" : "nav_header");
  if (Array.isArray(value)) return value.filter((i) => i && i.label && i.href);
  return which === "footer" ? DEFAULT_NAV_FOOTER : DEFAULT_NAV_HEADER;
}

// null, or the stored value before healing.
export function legacyCollectionsIndex(content) {
  const value = liveBlock(content, "collections_index");
  return value && typeof value === "object" ? value : null;
}

export function legacyPdpExtras(content) {
  const value = liveBlock(content, "pdp_extras");
  const list = Array.isArray(value) ? value : [];
  return list.filter((x) => x && x.enabled !== false && x.title && x.html);
}

// { row: true, page } when the release lists the slug (page null when it is
// switched off); { row: false } when it doesn't (the caller then serves the
// code default page).
export function legacyContentPage(content, slug) {
  const row = (content.pages || []).find((p) => p.slug === slug);
  if (!row) return { row: false };
  return {
    row: true,
    page: row.enabled
      ? {
          slug: row.slug,
          title: row.title,
          description: row.description || "",
          sections: normalizePageSections(row.sections),
          effective_at: row.effective_at || null,
          family: row.family || "page",
          window_start: row.window_start || null,
          window_end: row.window_end || null,
        }
      : null,
  };
}

// Sitemap/console list: the RELEASE's pages + defaults (`defaultPages` is the
// PAGES map when the store's brand defaults apply, otherwise null).
export function legacyContentPageList(content, defaultPages) {
  const bySlug = new Map((content.pages || []).map((r) => [r.slug, { slug: r.slug, title: r.title, enabled: !!r.enabled, source: "custom", family: r.family || "page" }]));
  if (defaultPages) {
    for (const slug of Object.keys(defaultPages)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: defaultPages[slug].title, enabled: true, source: "default" });
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export const legacyBrand = (content) => content.brand || null;
export const legacyTheme = (content) => content.theme || null;

export function legacySurfaceTemplates(content) {
  const value = liveBlock(content, "surface_templates");
  return { ...DEFAULT_SURFACE_TEMPLATES, ...(value && typeof value === "object" ? value : {}) };
}

// ---- S53 (0B-2): pure snapshot-selection helpers for the presentation sets a
// v2 release freezes (product overrides, collection pins, placements, slug
// redirects). A v1 snapshot returns `null` = "this release never froze that
// set; fall back to the live tables" (the pre-S53 behavior those releases were
// reviewed under). Formerly lib/content/presentation.js, which now re-exports.

const isV2 = (content) => (content?.v ?? 1) >= 2;

export function presentationProductOverride(content, productId) {
  if (!isV2(content)) return null;
  const row = (content.product_overrides || []).find((r) => r.product_id === productId);
  return { found: row ? { modules: row.modules || [], badge: row.badge || "" } : { modules: [], badge: "" } };
}

export function presentationCollectionPins(content, collectionId) {
  if (!isV2(content)) return null;
  const row = (content.collection_pins || []).find((r) => r.collection_id === collectionId);
  return { found: row ? row.pinned || [] : [] };
}

export function presentationPlacements(content, kind) {
  if (!isV2(content)) return null;
  return (content.placements || [])
    .filter((p) => p.kind === kind && p.enabled !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export function presentationSlugRedirect(content, slug) {
  if (!isV2(content)) return null;
  const row = (content.redirects || []).find((r) => r.from_slug === slug);
  return { found: row ? row.to_slug : null };
}
