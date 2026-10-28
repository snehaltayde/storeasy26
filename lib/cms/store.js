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
import { BLOCK_SCHEMAS, PAGE_SCHEMA, upgradeBlock } from "./schemas.js";

const parse = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---- blocks ----------------------------------------------------------------

export async function getBlock(key) {
  const row = await getBlockRow(key);
  return row ? row.value : null;
}

// Full row for the console: value + revision (the CAS token) + schema version.
export async function getBlockRow(key) {
  try {
    const row = await db.selectFrom("cms_blocks").selectAll().where("key", "=", key).executeTakeFirst();
    if (!row) return null;
    const value = upgradeBlock(key, parse(row.value), row.schema_version ?? 1);
    return { value, revision: row.revision ?? 0, schema_version: row.schema_version ?? 1 };
  } catch {
    return null; // table missing (pre-migration tenant) → defaults
  }
}

// S35 (BE08): expected-revision conflict. An editor saves WITH the revision it
// loaded; a mismatch means someone else saved first → CmsConflictError carries
// the server's current row so BOTH versions survive (server keeps its value,
// the editor keeps the unsaved one and decides). expectedRevision === undefined
// skips the check (scripts/seeds); null means "I expect to create this row".
export class CmsConflictError extends Error {
  constructor(current) {
    super("edited by someone else since you loaded it");
    this.code = "CMS_CONFLICT";
    this.current = current; // { value, revision } | null (row was deleted)
  }
}

export async function setBlock(key, value, { expectedRevision } = {}) {
  if (!BLOCK_KEYS.includes(key)) throw new Error(`unknown cms block "${key}"`);
  const now = new Date().toISOString();
  const schemaVersion = BLOCK_SCHEMAS[key]?.version ?? 1;
  const current = await getBlockRow(key);
  if (expectedRevision !== undefined) {
    const want = expectedRevision == null ? null : Number(expectedRevision);
    const have = current ? current.revision : null;
    if (want !== have) throw new CmsConflictError(current);
  }
  if (current) {
    // CAS guard closes the read→write race: zero rows updated = lost the race.
    const res = await db
      .updateTable("cms_blocks")
      .set({ value: JSON.stringify(value), updated_at: now, revision: current.revision + 1, schema_version: schemaVersion })
      .where("key", "=", key)
      .where("revision", "=", current.revision)
      .executeTakeFirst();
    if (Number(res?.numUpdatedRows ?? 0) === 0) throw new CmsConflictError(await getBlockRow(key));
    return { value, revision: current.revision + 1 };
  }
  await db
    .insertInto("cms_blocks")
    .values({ key, value: JSON.stringify(value), updated_at: now, revision: 1, schema_version: schemaVersion })
    .execute();
  return { value, revision: 1 };
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
  return sections.filter((s) => s.enabled !== false && ["collections", "new", "banner", "rich_text"].includes(s.kind));
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
export function defaultPage(slug) {
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

export async function upsertContentPage({ slug, title, description = "", sections = [], enabled = true }, { expectedRevision } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) throw new Error("slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) throw new Error("title required");
  if (!Array.isArray(sections)) throw new Error("sections must be an array");
  for (const s of sections) {
    if (!s?.heading?.trim() || !Array.isArray(s.body)) throw new Error("each section needs a heading and body paragraphs");
  }
  const now = new Date().toISOString();
  const row = { slug, title: title.trim(), description: description || "", sections: JSON.stringify(sections), enabled: enabled ? 1 : 0, updated_at: now, schema_version: PAGE_SCHEMA.version };
  const current = await db.selectFrom("cms_pages").select(["revision", "sections", "title"]).where("slug", "=", slug).executeTakeFirst();
  if (expectedRevision !== undefined) {
    const want = expectedRevision == null ? null : Number(expectedRevision);
    const have = current ? (current.revision ?? 0) : null;
    if (want !== have) throw new CmsConflictError(current ? { value: { title: current.title, sections: parse(current.sections, []) }, revision: current.revision ?? 0 } : null);
  }
  if (current) {
    const res = await db
      .updateTable("cms_pages")
      .set({ ...row, revision: (current.revision ?? 0) + 1 })
      .where("slug", "=", slug)
      .where("revision", "=", current.revision ?? 0)
      .executeTakeFirst();
    if (Number(res?.numUpdatedRows ?? 0) === 0) throw new CmsConflictError(null);
  } else {
    await db.insertInto("cms_pages").values({ ...row, revision: 1 }).execute();
  }
  return getContentPage(slug);
}

// Console list of page rows WITH revisions (the CAS tokens the editor saves with).
export async function pageRevisions() {
  try {
    const rows = await db.selectFrom("cms_pages").select(["slug", "revision"]).execute();
    return Object.fromEntries(rows.map((r) => [r.slug, r.revision ?? 0]));
  } catch {
    return {};
  }
}

export async function deleteContentPage(slug) {
  await db.deleteFrom("cms_pages").where("slug", "=", slug).execute();
}
