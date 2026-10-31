// Storefront content resolution (Session 36 / BE09 + SF23). SERVER COMPONENT
// ONLY (imports next/headers) — pages and the layout read content through
// here instead of the draft store, so:
//   · a LIVE release exists → its frozen snapshot serves, drafts never leak;
//   · no release yet (pre-first-publish) → drafts serve (pre-S36 behavior);
//   · a valid preview cookie → drafts serve to THAT browser only, with
//     Cache-Control kept dynamic (cookie-based, so no published URL ever
//     carries preview content).
// One release row read per request (React cache), shared by every getter.
import { cache } from "react";
import { cookies } from "next/headers";
import { getLiveReleaseState, verifyPreviewToken } from "../releases.js";
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
} from "../cms/store.js";
import { normalizePageSections } from "../cms/schemas.js";
import { DEFAULT_ANNOUNCEMENT, defaultHero, DEFAULT_HOME_SECTIONS, DEFAULT_NAV_HEADER, DEFAULT_NAV_FOOTER } from "../cms/defaults.js";
import { siteName } from "../site.js";
import { tenantOwnCfg } from "../tenant-context.js";

import { getPreviewCandidate, PREVIEW_COOKIE } from "../cms/candidates.js";

export { PREVIEW_COOKIE }; // canonical definition moved to candidates.js (plain-Node importable)

// S53 (audit A2): thrown when published content SHOULD exist but cannot be
// read or validated. The storefront's error boundary renders — shoppers
// never silently receive drafts because a release read failed.
export class ContentUnavailableError extends Error {
  constructor(detail) {
    super("published content unavailable");
    this.code = "CONTENT_UNAVAILABLE";
    this.detail = detail;
  }
}

// { mode: "draft" | "live", content: snapshot|null, preview: bool, candidate }
export const contentSource = cache(async () => {
  let preview = false;
  let token = null;
  try {
    token = (await cookies()).get(PREVIEW_COOKIE)?.value;
    if (token && (await verifyPreviewToken(token))) preview = true;
  } catch {
    /* no request scope (scripts) → not a preview */
  }
  if (preview) {
    // S59: this preview session's UNSAVED edits (designer-pushed, validated
    // at write). Best-effort — null means "show the last save", never a 500.
    const candidate = await getPreviewCandidate(token);
    return { mode: "draft", content: null, preview: true, candidate };
  }
  const s = await getLiveReleaseState();
  if (s.state === "live") return { mode: "live", content: s.release.content, preview: false };
  if (s.state === "none") return { mode: "draft", content: null, preview: false }; // pre-first-publish: drafts serve, as always
  throw new ContentUnavailableError(s.error); // read failure ≠ "no release" — fail closed
});

const liveBlock = (content, key) => (Object.hasOwn(content.blocks || {}, key) ? content.blocks[key] : null);

export async function resolvedAnnouncement() {
  const src = await contentSource();
  if (src.candidate?.announcement) return { ...DEFAULT_ANNOUNCEMENT, ...src.candidate.announcement }; // S59: unsaved edits, this preview only
  if (src.mode === "draft") return getAnnouncement();
  return { ...DEFAULT_ANNOUNCEMENT, ...(liveBlock(src.content, "announcement") || {}) };
}

export async function resolvedHero() {
  const src = await contentSource();
  if (src.candidate?.hero) return { ...defaultHero(siteName()), ...src.candidate.hero }; // S59
  if (src.mode === "draft") return getHero();
  return { ...defaultHero(siteName()), ...(liveBlock(src.content, "hero") || {}) };
}

export async function resolvedHomeSections() {
  const src = await contentSource();
  if (Array.isArray(src.candidate?.home_sections)) {
    // S59: unsaved sections — validated shapes, same filter + healing as a save
    const { HOME_SECTION_KINDS } = await import("../cms/registry.js");
    const { healHomeSections } = await import("../cms/store.js");
    return healHomeSections(src.candidate.home_sections.filter((s) => s.enabled !== false && HOME_SECTION_KINDS.includes(s.kind)));
  }
  if (src.mode === "draft") return getHomeSections();
  const rows = liveBlock(src.content, "home_sections");
  const sections = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  const { HOME_SECTION_KINDS } = await import("../cms/registry.js");
  // S57: live snapshots are immutable, but the CATALOG isn't release-owned —
  // id-bearing collection refs heal to the catalog's current handles.
  const { healHomeSections } = await import("../cms/store.js");
  return healHomeSections(sections.filter((s) => s.enabled !== false && HOME_SECTION_KINDS.includes(s.kind)));
}

export async function resolvedNav(which) {
  const src = await contentSource();
  if (src.mode === "draft") return getNav(which);
  const value = liveBlock(src.content, which === "footer" ? "nav_footer" : "nav_header");
  if (Array.isArray(value)) return value.filter((i) => i && i.label && i.href);
  return which === "footer" ? DEFAULT_NAV_FOOTER : DEFAULT_NAV_HEADER;
}

// S38 (SF02 + SF04): curated collection index and PDP accordions follow the
// same release discipline as every other block.
export async function resolvedCollectionsIndex() {
  const src = await contentSource();
  if (src.mode === "draft") return getCollectionsIndex();
  const value = liveBlock(src.content, "collections_index");
  if (!(value && typeof value === "object")) return null;
  const { healCollectionsIndex } = await import("../cms/store.js");
  return healCollectionsIndex(value); // S57: heal renamed handles from ids
}

export async function resolvedPdpExtras() {
  const src = await contentSource();
  if (src.mode === "draft") return getPdpExtras();
  const value = liveBlock(src.content, "pdp_extras");
  const list = Array.isArray(value) ? value : [];
  return list.filter((x) => x && x.enabled !== false && x.title && x.html);
}

export async function resolvedContentPage(slug) {
  const src = await contentSource();
  if (src.mode === "draft") return getContentPage(slug);
  const row = (src.content.pages || []).find((p) => p.slug === slug);
  if (row) {
    return row.enabled
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
      : null;
  }
  return defaultPage(slug);
}

// Sitemap/console list: live mode lists the RELEASE's pages + defaults, so an
// unpublished draft page never shows up in the published sitemap.
export async function resolvedContentPageList() {
  const src = await contentSource();
  if (src.mode === "draft") return listContentPages();
  const bySlug = new Map((src.content.pages || []).map((r) => [r.slug, { slug: r.slug, title: r.title, enabled: !!r.enabled, source: "custom", family: r.family || "page" }]));
  if (brandDefaultsApply()) {
    const { PAGES } = await import("../content/pages.js");
    for (const slug of Object.keys(PAGES)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: PAGES[slug].title, enabled: true, source: "default" });
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// Brand tokens are part of the release too: once published, a brand edit in
// the console stays draft until the next publish (previewable like content).
export async function resolvedBrand() {
  const src = await contentSource();
  if (src.mode === "draft") return tenantOwnCfg("brand", null, null) || null;
  return src.content.brand || null;
}

// Theme kit pin (S37) — same release discipline as brand.
export async function resolvedTheme() {
  const src = await contentSource();
  if (src.mode === "draft") return tenantOwnCfg("theme", null, null) || null;
  return src.content.theme || null;
}

// S56: per-surface templates — release-governed like every block (preview
// shows the draft pick; shoppers see it after publish).
export async function resolvedSurfaceTemplates() {
  const src = await contentSource();
  const { getSurfaceTemplates } = await import("../cms/store.js");
  if (src.mode === "draft") return getSurfaceTemplates();
  const { DEFAULT_SURFACE_TEMPLATES } = await import("../cms/defaults.js");
  const value = liveBlock(src.content, "surface_templates");
  return { ...DEFAULT_SURFACE_TEMPLATES, ...(value && typeof value === "object" ? value : {}) };
}

// S57: the template ONE entity renders with — explicit entity assignment →
// family default → platform default, same release discipline as every block
// (drafts read the table, live reads the frozen snapshot). Returns
// { template, source } so callers can also explain the choice.
export async function resolvedSurfaceTemplateFor(surface, entityId) {
  const src = await contentSource();
  const { effectiveSurfaceTemplate } = await import("../cms/defaults.js");
  if (src.mode === "draft") {
    const { getBlock } = await import("../cms/store.js");
    return effectiveSurfaceTemplate(await getBlock("surface_templates"), surface, entityId);
  }
  return effectiveSurfaceTemplate(liveBlock(src.content, "surface_templates"), surface, entityId);
}

// ---- S53 (0B-2): the rest of the presentation state ------------------------
// Product modules/badges, collection pins, upsell placements and slug
// redirects used to apply on save, outside preview/publish/rollback. They now
// follow the same discipline: drafts (and preview) read the tables; live
// reads the v2 snapshot. A v1 release never froze these sets, so the pure
// helpers return null and we fall back to the tables — exactly what those
// releases were reviewed under.
import {
  presentationProductOverride,
  presentationCollectionPins,
  presentationPlacements,
  presentationSlugRedirect,
} from "./presentation.js";
import { getProductOverride } from "../catalog-overrides.js";
import { getPdpPairs, getCartUpsell } from "../cms/placements.js";
import { resolveSlugRedirect } from "../cms/store.js";
import { collectionPinsByHandle } from "../repo.js";
import { db } from "../db.js";

export async function resolvedProductOverride(productId) {
  const src = await contentSource();
  if (src.mode === "draft") return getProductOverride(productId);
  const hit = presentationProductOverride(src.content, productId);
  return hit ? hit.found : getProductOverride(productId); // null = v1 release → live tables
}

export async function resolvedCollectionPins(handle) {
  const src = await contentSource();
  if (src.mode === "draft") return collectionPinsByHandle(handle);
  if (!presentationCollectionPins(src.content, "")) return collectionPinsByHandle(handle); // v1
  let collectionId = null;
  try {
    const row = await db.selectFrom("collections").select("id").where("handle", "=", handle).executeTakeFirst();
    collectionId = row?.id || null;
  } catch {
    return [];
  }
  if (!collectionId) return [];
  return presentationCollectionPins(src.content, collectionId).found;
}

export async function resolvedPdpPairs(productId, { limit = 4 } = {}) {
  const src = await contentSource();
  if (src.mode === "draft") return getPdpPairs(productId, { limit });
  const rows = presentationPlacements(src.content, "pdp_pairs");
  return getPdpPairs(productId, { limit, ...(rows ? { placementRows: rows } : {}) });
}

export async function resolvedCartUpsell(excludeProductIds = [], { limit = 3 } = {}) {
  const src = await contentSource();
  if (src.mode === "draft") return getCartUpsell(excludeProductIds, { limit });
  const rows = presentationPlacements(src.content, "cart_upsell");
  return getCartUpsell(excludeProductIds, { limit, ...(rows ? { placementRows: rows } : {}) });
}

export async function resolvedSlugRedirect(slug) {
  const src = await contentSource();
  if (src.mode === "draft") return resolveSlugRedirect(slug);
  const hit = presentationSlugRedirect(src.content, slug);
  return hit ? hit.found : resolveSlugRedirect(slug); // v1 → live table
}
