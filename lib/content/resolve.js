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
import { getLiveRelease, verifyPreviewToken } from "../releases.js";
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

export const PREVIEW_COOKIE = "_preview";

// { mode: "draft" | "live", content: snapshot|null, preview: bool }
export const contentSource = cache(async () => {
  let preview = false;
  try {
    const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
    if (token && (await verifyPreviewToken(token))) preview = true;
  } catch {
    /* no request scope (scripts) → not a preview */
  }
  if (preview) return { mode: "draft", content: null, preview: true };
  const live = await getLiveRelease();
  return live ? { mode: "live", content: live.content, preview: false } : { mode: "draft", content: null, preview: false };
});

const liveBlock = (content, key) => (Object.hasOwn(content.blocks || {}, key) ? content.blocks[key] : null);

export async function resolvedAnnouncement() {
  const src = await contentSource();
  if (src.mode === "draft") return getAnnouncement();
  return { ...DEFAULT_ANNOUNCEMENT, ...(liveBlock(src.content, "announcement") || {}) };
}

export async function resolvedHero() {
  const src = await contentSource();
  if (src.mode === "draft") return getHero();
  return { ...defaultHero(siteName()), ...(liveBlock(src.content, "hero") || {}) };
}

export async function resolvedHomeSections() {
  const src = await contentSource();
  if (src.mode === "draft") return getHomeSections();
  const rows = liveBlock(src.content, "home_sections");
  const sections = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  return sections.filter((s) => s.enabled !== false && ["collections", "new", "banner", "rich_text"].includes(s.kind));
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
  return value && typeof value === "object" ? value : null;
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
