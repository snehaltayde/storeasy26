// Merchandising CMS reads/writes (Session 23). SERVER-ONLY (imports db).
// Every read falls back to code defaults so an untouched tenant renders the
// pre-CMS storefront byte-for-byte; a missing/broken row can never 500 a page.
import { db } from "../db.js";
import { siteName } from "../site.js";
import { tenantCfg } from "../tenant-context.js";
import { PAGES } from "../content/pages.js";
import {
  BLOCK_KEYS,
  DEFAULT_ANNOUNCEMENT,
  defaultHero,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_NAV_HEADER,
  DEFAULT_NAV_FOOTER,
} from "./defaults.js";

const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---- blocks ----------------------------------------------------------------

export async function getBlock(key) {
  try {
    const row = await db.selectFrom("cms_blocks").select("value").where("key", "=", key).executeTakeFirst();
    return row ? parse(row.value) : null;
  } catch {
    return null; // table missing (pre-migration tenant) → defaults
  }
}

export async function setBlock(key, value) {
  if (!BLOCK_KEYS.includes(key)) throw new Error(`unknown cms block "${key}"`);
  const now = new Date().toISOString();
  await db
    .insertInto("cms_blocks")
    .values({ key, value: JSON.stringify(value), updated_at: now })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value), updated_at: now }))
    .execute();
  return value;
}

export async function deleteBlock(key) {
  await db.deleteFrom("cms_blocks").where("key", "=", key).execute();
}

// Typed getters: stored value merged over defaults (missing fields heal).
export const getAnnouncement = async () => ({ ...DEFAULT_ANNOUNCEMENT, ...((await getBlock("announcement")) || {}) });

export const getHero = async () => ({ ...defaultHero(siteName()), ...((await getBlock("hero")) || {}) });

export async function getHomeSections() {
  const rows = await getBlock("home_sections");
  const sections = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  return sections.filter((s) => s.enabled !== false && ["collections", "new"].includes(s.kind));
}

// null = "derive from catalog" (pre-CMS behavior); [] = explicitly empty.
export async function getNav(which) {
  const value = await getBlock(which === "footer" ? "nav_footer" : "nav_header");
  if (Array.isArray(value)) return value.filter((i) => i && i.label && i.href);
  return which === "footer" ? DEFAULT_NAV_FOOTER : DEFAULT_NAV_HEADER;
}

// ---- content pages ---------------------------------------------------------

// Defaults carry BeastLife-sourced copy (tenant #1's real content); a tenant
// override replaces the whole page. The default CONTACT page swaps in the
// tenant's own support details where configured.
function defaultPage(slug) {
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

export async function getContentPage(slug) {
  try {
    const row = await db.selectFrom("cms_pages").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (row) {
      if (!row.enabled) return null;
      return { slug: row.slug, title: row.title, description: row.description || "", sections: parse(row.sections, []) };
    }
  } catch {
    /* table missing → defaults */
  }
  return defaultPage(slug);
}

// Union of default slugs and tenant-added pages (for sitemap + console list).
export async function listContentPages() {
  let rows = [];
  try {
    rows = await db.selectFrom("cms_pages").select(["slug", "title", "enabled", "updated_at"]).execute();
  } catch {
    rows = [];
  }
  const bySlug = new Map(rows.map((r) => [r.slug, { slug: r.slug, title: r.title, enabled: !!r.enabled, source: "custom", updated_at: r.updated_at }]));
  for (const slug of Object.keys(PAGES)) {
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: PAGES[slug].title, enabled: true, source: "default", updated_at: null });
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function upsertContentPage({ slug, title, description = "", sections = [], enabled = true }) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) throw new Error("slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) throw new Error("title required");
  if (!Array.isArray(sections)) throw new Error("sections must be an array");
  for (const s of sections) {
    if (!s?.heading?.trim() || !Array.isArray(s.body)) throw new Error("each section needs a heading and body paragraphs");
  }
  const now = new Date().toISOString();
  const row = { slug, title: title.trim(), description: description || "", sections: JSON.stringify(sections), enabled: enabled ? 1 : 0, updated_at: now };
  await db
    .insertInto("cms_pages")
    .values(row)
    .onConflict((oc) => oc.column("slug").doUpdateSet(row))
    .execute();
  return getContentPage(slug);
}

export async function deleteContentPage(slug) {
  await db.deleteFrom("cms_pages").where("slug", "=", slug).execute();
}
