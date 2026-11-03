// Merchandising CMS reads/writes (Session 23). SERVER-ONLY (imports db).
// Every read falls back to code defaults so an untouched tenant renders the
// pre-CMS storefront byte-for-byte; a missing/broken row can never 500 a page.
import { db } from "../db.js";
import { siteName } from "../site.js";
import { tenantCfg, tenantId } from "../tenant-context.js";
import { PAGES } from "../content/pages.js";
import { sanitizeHtml, wordsLostBySanitizing } from "../sanitize.js";
import {
  BLOCK_KEYS,
  DEFAULT_ANNOUNCEMENT,
  defaultHero,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_SURFACE_TEMPLATES,
  DEFAULT_NAV_HEADER,
  DEFAULT_NAV_FOOTER,
  DEFAULT_COLLECTIONS_INDEX,
  DEFAULT_PDP_EXTRAS,
} from "./defaults.js";
import { BLOCK_SCHEMAS, PAGE_SCHEMA, upgradeBlock, normalizePageSections } from "./schemas.js";
import { ensureSectionIds, HOME_SECTION_KINDS } from "./registry.js";
import { getCollectionHandlesByIds } from "../repo.js";

// ---- S57: handle→id reference healing ----------------------------------------
// Stored collection references keep the human/URL handle, but picker saves
// also record the catalog ID. At RENDER time the current handle is looked up
// by id, so a Shopify handle rename can't orphan curation. A reference whose
// id vanished from the catalog falls back to its stored handle (and naturally
// renders nothing if that is gone too). Editors read the RAW getters — they
// must show exactly what is stored.
async function currentHandleMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  try {
    return new Map((await getCollectionHandlesByIds(unique)).map((r) => [r.id, r.handle]));
  } catch {
    return new Map(); // healing is best-effort — stored handles still render
  }
}

export async function healHomeSections(sections) {
  const ids = sections.filter((s) => s.kind === "product_rail" && s.collection_id).map((s) => s.collection_id);
  if (!ids.length) return sections;
  const map = await currentHandleMap(ids);
  return sections.map((s) => {
    if (s.kind !== "product_rail" || !s.collection_id) return s;
    const cur = map.get(s.collection_id);
    return cur && cur !== s.collection ? { ...s, collection: cur } : s;
  });
}

export async function healCollectionsIndex(value) {
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
// S53 (0B-1): `strict` distinguishes "no row / table not migrated yet" from a
// READ FAILURE — the release snapshot uses strict so a transient error can
// never masquerade as "not customized" and produce a partial release.
export async function getBlockRow(key, { strict = false } = {}) {
  try {
    const row = await db.selectFrom("cms_blocks").selectAll().where("key", "=", key).executeTakeFirst();
    if (!row) return null;
    const value = upgradeBlock(key, parse(row.value), row.schema_version ?? 1);
    return { value, revision: row.revision ?? 0, schema_version: row.schema_version ?? 1, updated_at: row.updated_at || null };
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return null; // pre-migration tenant → defaults
    if (strict) throw e;
    return null;
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

// S53 (0B-1): reset/delete accept the revision the editor loaded — a reset
// racing a colleague's save now conflicts instead of silently discarding
// their work. Omitted = unchecked (scripts, privileged paths). A row that is
// already gone makes the delete idempotent, not a conflict.
export async function deleteBlock(key, { expectedRevision } = {}) {
  if (expectedRevision == null) {
    await db.deleteFrom("cms_blocks").where("key", "=", key).execute();
    return;
  }
  const res = await db.deleteFrom("cms_blocks").where("key", "=", key).where("revision", "=", expectedRevision).executeTakeFirst();
  if (Number(res?.numDeletedRows ?? 0) === 0) {
    const row = await getBlockRow(key);
    if (row) throw new CmsConflictError({ value: row.value, revision: row.revision });
  }
}

// Typed getters: stored value merged over defaults (missing fields heal).
export const getAnnouncement = async () => ({ ...DEFAULT_ANNOUNCEMENT, ...((await getBlock("announcement")) || {}) });

export const getHero = async () => ({ ...defaultHero(siteName()), ...((await getBlock("hero")) || {}) });

export async function getHomeSections() {
  const rows = await getBlock("home_sections");
  const sections = Array.isArray(rows) && rows.length ? rows : DEFAULT_HOME_SECTIONS;
  // S55: kinds come from the registry — hard-coded lists silently dropped new
  // sections. S57: renderer reads heal id-bearing collection refs.
  return healHomeSections(sections.filter((s) => s.enabled !== false && HOME_SECTION_KINDS.includes(s.kind)));
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
  return sections.filter((s) => s && HOME_SECTION_KINDS.includes(s.kind));
}

export async function getPdpExtrasRaw() {
  const value = await getBlock("pdp_extras");
  const list = Array.isArray(value) ? value : DEFAULT_PDP_EXTRAS || [];
  return list.filter((x) => x && typeof x === "object");
}

// S56: per-surface template assignment (family defaults), merged over the
// platform defaults so an unset surface keeps today's layout.
export async function getSurfaceTemplates() {
  const value = await getBlock("surface_templates");
  return { ...DEFAULT_SURFACE_TEMPLATES, ...(value && typeof value === "object" ? value : {}) };
}

// S38 (SF02): merchant-curated collection index; null = catalog-derived.
// S57: the renderer view heals renamed handles from recorded ids (and never
// exposes the ids sidecar); editors use the RAW getter below.
export async function getCollectionsIndex() {
  const value = await getBlock("collections_index");
  if (!(value && typeof value === "object")) return DEFAULT_COLLECTIONS_INDEX;
  return healCollectionsIndex(value);
}

export async function getCollectionsIndexRaw() {
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
//   { kind:"text",  heading?, body:[paragraph…] }  (the original shape; AU-05: needs a heading or a paragraph)
//   { kind:"rich",  heading?, html }               (allowlist-sanitized AT SAVE)
//   { kind:"image", src, alt, caption? }           (library /api/media/… or https)
// Legacy rows without `kind` read as "text" (normalizePageSections).
// AU-05: over-limit text is refused, never cut: a save must not report success
// having dropped the founder's words.
const withinLimit = (value, max, where, what) => {
  if (value.length > max) throw new Error(`${where}: the ${what} is too long (${value.length} characters, the limit is ${max})`);
  return value;
};
// Zero-width characters pasted from another app show nothing, so they don't
// count as content. Only the check ignores them: stored text keeps them, because
// some scripts and emoji need them to display correctly.
const isBlank = (value) => !value.replace(/[\u00AD\u200B-\u200D\u2060]/g, "").trim();
// Sanitizing may remove unsafe tags (AU-06 owns telling the founder), but never
// their words: refuse so the words stay in the form to fix.
const sanitizedKeepingWords = (raw, where) => {
  const html = sanitizeHtml(raw);
  const lost = wordsLostBySanitizing(raw, html);
  if (lost) throw new Error(`${where}: saving would lose these words: "${lost.length > 60 ? `${lost.slice(0, 60)}…` : lost}". This usually comes from < or > signs. Reword them or remove them, then save again.`);
  return html;
};

export function validatePageSections(sections) {
  if (!Array.isArray(sections)) throw new Error("sections must be an array");
  // S54: durable instance ids ride through validation; the registry stamp at
  // the end keeps valid unique ones and mints the rest.
  const built = sections.map((s, i) => {
    const kind = s?.kind || "text";
    const id = s?.id;
    const where = `section ${i + 1}`;
    const typedHeading = kind === "image" ? "" : String(s?.heading ?? "").trim(); // images have no heading
    const heading = isBlank(typedHeading) ? "" : withinLimit(typedHeading, 120, where, "heading");
    if (kind === "text") {
      if (s?.body != null && !Array.isArray(s.body)) throw new Error(`${where}: paragraphs must be a list`);
      const body = (s?.body || []).map((p) => String(p ?? "")).filter((p) => !isBlank(p));
      if (!heading && !body.length) throw new Error(`${where}: add a heading or some text, or remove this section.`);
      return { id, kind: "text", heading, body: body.map((p) => withinLimit(p, 4000, where, "paragraph")) };
    }
    if (kind === "rich") {
      const html = withinLimit(sanitizedKeepingWords(String(s?.html ?? ""), where), 20000, where, "content");
      if (isBlank(html)) throw new Error(`${where}: this section is empty. Add some content, or remove this section.`);
      return { id, kind: "rich", heading, html };
    }
    if (kind === "image") {
      const src = String(s?.src ?? "").trim();
      if (!src) throw new Error(`${where}: choose an image, or remove this section.`);
      if (!/^(https:\/\/|\/(?!\/))/.test(src)) throw new Error(`${where}: this image link isn't secure. Use a link that starts with https, or choose an image from your library.`);
      if (isBlank(String(s?.alt ?? ""))) throw new Error(`section ${i + 1}: image needs alt text`);
      return { id, kind: "image", src: withinLimit(src, 500, where, "image link"), alt: withinLimit(String(s.alt).trim(), 300, where, "alt text"), caption: withinLimit(String(s?.caption ?? "").trim(), 300, where, "caption") };
    }
    if (kind === "faq") {
      // S39 (SF16): question/answer accordions with stable deep-link anchors.
      if (!Array.isArray(s?.items) || !s.items.length) throw new Error(`section ${i + 1}: an FAQ section needs at least one question`);
      if (s.items.length > 30) throw new Error(`section ${i + 1}: at most 30 questions per FAQ section`);
      const items = s.items.map((it, j) => {
        const q = withinLimit(String(it?.q ?? "").trim(), 300, `${where}, question ${j + 1}`, "question");
        const a = withinLimit(sanitizedKeepingWords(String(it?.a ?? ""), `${where}, question ${j + 1}`), 8000, `${where}, question ${j + 1}`, "answer");
        if (isBlank(q)) throw new Error(`section ${i + 1}, question ${j + 1}: question text required`);
        if (isBlank(a)) throw new Error(`section ${i + 1}, question ${j + 1}: answer required`);
        return { q, a };
      });
      return { id, kind: "faq", heading, items };
    }
    throw new Error(`section ${i + 1}: unknown kind "${kind}"`);
  });
  return ensureSectionIds(built);
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

export async function deleteContentPage(slug, { expectedRevision } = {}) {
  if (expectedRevision == null) {
    await db.deleteFrom("cms_pages").where("slug", "=", slug).execute();
    return;
  }
  const res = await db.deleteFrom("cms_pages").where("slug", "=", slug).where("revision", "=", expectedRevision).executeTakeFirst();
  if (Number(res?.numDeletedRows ?? 0) === 0) {
    const row = await db.selectFrom("cms_pages").select(["title", "sections", "revision"]).where("slug", "=", slug).executeTakeFirst();
    if (row) throw new CmsConflictError({ value: { title: row.title, sections: JSON.parse(row.sections || "[]") }, revision: row.revision ?? 0 });
  }
}
