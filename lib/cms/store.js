// Merchandising CMS reads/writes (Session 23). SERVER-ONLY (imports db).
// Every read falls back to code defaults so an untouched tenant renders the
// pre-CMS storefront byte-for-byte; a missing/broken row can never 500 a page.
import { db } from "../db.js";
import { siteName } from "../site.js";
import { tenantCfg, tenantId } from "../tenant-context.js";
import { PAGES } from "../content/pages.js";
import { sanitizeHtml } from "../sanitize.js";
import {
  BLOCK_KEYS,
  DEFAULT_ANNOUNCEMENT,
  defaultHero,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_NAV_HEADER,
  DEFAULT_NAV_FOOTER,
  DEFAULT_COLLECTIONS_INDEX,
  DEFAULT_PDP_EXTRAS,
} from "./defaults.js";
import { BLOCK_SCHEMAS, PAGE_SCHEMA, upgradeBlock, normalizePageSections } from "./schemas.js";

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
    return { value, revision: row.revision ?? 0, schema_version: row.schema_version ?? 1, updated_at: row.updated_at || null };
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

// S52: RAW variants for the EDITOR. The renderer getters above drop disabled
// entries — feeding those into an editor silently DELETED every hidden home
// section / disabled PDP accordion on the next save round-trip. Editors load
// these; shoppers keep the filtered getters.
export async function getHomeSectionsRaw() {
  const rows = await getBlock("home_sections");
  const sections = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  return sections.filter((s) => s && ["collections", "new", "banner", "rich_text"].includes(s.kind));
}

export async function getPdpExtrasRaw() {
  const value = await getBlock("pdp_extras");
  const list = Array.isArray(value) ? value : DEFAULT_PDP_EXTRAS || [];
  return list.filter((x) => x && typeof x === "object");
}

// S38 (SF02): merchant-curated collection index; null = catalog-derived.
export async function getCollectionsIndex() {
  const value = await getBlock("collections_index");
  return value && typeof value === "object" ? value : DEFAULT_COLLECTIONS_INDEX;
}

// S38 (SF04): PDP accordions; [] when none configured.
export async function getPdpExtras() {
  const value = await getBlock("pdp_extras");
  const list = Array.isArray(value) ? value : DEFAULT_PDP_EXTRAS || [];
  return list.filter((x) => x && x.enabled !== false && x.title && x.html);
}

// ---- content pages ---------------------------------------------------------

// S38 (SF14): the default page templates carry BEASTLIFE's real legal/brand
// copy (lib/content/pages.js was sourced from beastlife.in). Serving another
// tenant's shoppers BeastLife's policies would be cross-tenant legal text, so
// the defaults apply ONLY to BeastLife itself: the legacy env-default context
// and the beastlife control-plane tenants. Every other tenant starts with no
// pages — the console's templates (MC09) are the starting point instead.
export function brandDefaultsApply() {
  return ["_default", "beastlife", "beastlife-staging"].includes(tenantId());
}

// Defaults carry BeastLife-sourced copy (tenant #1's real content); a tenant
// override replaces the whole page. The default CONTACT page swaps in the
// tenant's own support details where configured.
export function defaultPage(slug) {
  if (!brandDefaultsApply()) return null;
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
      return {
        slug: row.slug,
        title: row.title,
        description: row.description || "",
        sections: normalizePageSections(parse(row.sections, [])),
        effective_at: row.effective_at || null,
        family: row.family || "page",
        window_start: row.window_start || null,
        window_end: row.window_end || null,
      };
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
    rows = await db.selectFrom("cms_pages").select(["slug", "title", "enabled", "updated_at", "family"]).execute();
  } catch {
    try {
      rows = await db.selectFrom("cms_pages").select(["slug", "title", "enabled", "updated_at"]).execute();
    } catch {
      rows = [];
    }
  }
  const bySlug = new Map(rows.map((r) => [r.slug, { slug: r.slug, title: r.title, enabled: !!r.enabled, source: "custom", family: r.family || "page", updated_at: r.updated_at }]));
  if (brandDefaultsApply()) {
    for (const slug of Object.keys(PAGES)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: PAGES[slug].title, enabled: true, source: "default", updated_at: null });
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// S38 (SF13): typed page sections. Three kinds —
//   { kind:"text",  heading, body:[paragraph…] }   (the original shape)
//   { kind:"rich",  heading?, html }               (allowlist-sanitized AT SAVE)
//   { kind:"image", src, alt, caption? }           (library /api/media/… or https)
// Legacy rows without `kind` read as "text" (normalizePageSections).
export function validatePageSections(sections) {
  if (!Array.isArray(sections)) throw new Error("sections must be an array");
  return sections.map((s, i) => {
    const kind = s?.kind || "text";
    if (kind === "text") {
      if (!s?.heading?.trim() || !Array.isArray(s.body)) throw new Error(`section ${i + 1}: a text section needs a heading and body paragraphs`);
      return { kind: "text", heading: String(s.heading).trim().slice(0, 120), body: s.body.map((p) => String(p ?? "").slice(0, 4000)).filter(Boolean) };
    }
    if (kind === "rich") {
      const html = sanitizeHtml(String(s?.html ?? "")).slice(0, 20000);
      if (!html.trim()) throw new Error(`section ${i + 1}: rich section is empty`);
      return { kind: "rich", heading: String(s?.heading ?? "").trim().slice(0, 120), html };
    }
    if (kind === "image") {
      const src = String(s?.src ?? "").trim();
      if (!/^(https:\/\/|\/(?!\/))/.test(src)) throw new Error(`section ${i + 1}: image src must be https:// or a library path (/api/media/…)`);
      if (!String(s?.alt ?? "").trim()) throw new Error(`section ${i + 1}: image needs alt text`);
      return { kind: "image", src: src.slice(0, 500), alt: String(s.alt).trim().slice(0, 300), caption: String(s?.caption ?? "").trim().slice(0, 300) };
    }
    if (kind === "faq") {
      // S39 (SF16): question/answer accordions with stable deep-link anchors.
      if (!Array.isArray(s?.items) || !s.items.length) throw new Error(`section ${i + 1}: an FAQ section needs at least one question`);
      if (s.items.length > 30) throw new Error(`section ${i + 1}: at most 30 questions per FAQ section`);
      const items = s.items.map((it, j) => {
        const q = String(it?.q ?? "").trim().slice(0, 300);
        const a = sanitizeHtml(String(it?.a ?? "")).slice(0, 8000);
        if (!q) throw new Error(`section ${i + 1}, question ${j + 1}: question text required`);
        if (!a.trim()) throw new Error(`section ${i + 1}, question ${j + 1}: answer required`);
        return { q, a };
      });
      return { kind: "faq", heading: String(s?.heading ?? "").trim().slice(0, 120), items };
    }
    throw new Error(`section ${i + 1}: unknown kind "${kind}"`);
  });
}

// S39 (SF17): is a campaign page inside its UTC visibility window?
export function campaignVisible(page, now = Date.now()) {
  if (page.window_start && now < new Date(page.window_start).getTime()) return false;
  if (page.window_end && now >= new Date(page.window_end).getTime()) return false;
  return true;
}

export async function upsertContentPage({ slug, title, description = "", sections = [], enabled = true, effective_at = null, family = "page", window_start = null, window_end = null, redirect_from = null }, { expectedRevision } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) throw new Error("slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) throw new Error("title required");
  const clean = validatePageSections(sections);
  // SF14: optional effective date (YYYY-MM-DD) shown on policy pages.
  let effectiveAt = null;
  if (effective_at) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_at))) throw new Error("effective date must be YYYY-MM-DD");
    effectiveAt = String(effective_at);
  }
  // S39 (SF17): campaign pages serve at /campaigns/<slug> inside a UTC window.
  // S46 (SF20): journal posts serve at /journal/<slug>; window_start doubles
  // as their SCHEDULED PUBLISH instant. The CONSOLE converts the merchant's
  // local wall time to UTC ISO — the server only ever accepts instants.
  if (!["page", "campaign", "journal"].includes(family)) throw new Error(`unknown page family "${family}"`);
  const instant = (v, label) => {
    if (!v) return null;
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) throw new Error(`${label} must be a UTC ISO instant`);
    return t.toISOString();
  };
  const winStart = instant(window_start, "window start");
  const winEnd = instant(window_end, "window end");
  if (winStart && winEnd && winEnd <= winStart) throw new Error("window end must be after window start");
  if (family === "page" && (winStart || winEnd)) throw new Error("visibility windows are for campaign and journal pages");
  const now = new Date().toISOString();
  const row = { slug, title: title.trim(), description: description || "", sections: JSON.stringify(clean), enabled: enabled ? 1 : 0, effective_at: effectiveAt, family, window_start: winStart, window_end: winEnd, updated_at: now, schema_version: PAGE_SCHEMA.version };
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
  // S46 (SF20): slug changes keep old URLs alive — "redirect_from" records
  // that an old slug now points here (self-redirects and loops refused).
  // A page saved at a slug always kills any redirect FROM that slug: a live
  // page beats a stale redirect, and no redirect chain can loop back here.
  await db.deleteFrom("page_redirects").where("from_slug", "=", slug).execute().catch(() => {}); // pre-migration tenants lack the table
  if (redirect_from) {
    const from = String(redirect_from).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(from)) throw new Error("redirect-from must be a slug");
    if (from === slug) throw new Error("a page can't redirect to itself");
    await db
      .insertInto("page_redirects")
      .values({ from_slug: from, to_slug: slug, created_at: now })
      .onConflict((oc) => oc.column("from_slug").doUpdateSet({ to_slug: slug, created_at: now }))
      .execute();
  }
  return getContentPage(slug);
}

// S46 (SF20): one-hop redirect lookup for journal/policy slugs.
export async function resolveSlugRedirect(slug) {
  try {
    const r = await db.selectFrom("page_redirects").select("to_slug").where("from_slug", "=", slug).executeTakeFirst();
    return r?.to_slug || null;
  } catch {
    return null; // pre-migration tenant
  }
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
