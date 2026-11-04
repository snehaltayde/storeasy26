// Merchandising CMS reads/writes (Session 23). SERVER-ONLY (imports db).
// Every read falls back to code defaults so an untouched tenant renders the
// pre-CMS storefront byte-for-byte; a missing/broken row can never 500 a page.
import { db } from "../db.js";
import { siteName } from "../site.js";
import { tenantCfg, tenantId } from "../tenant-context.js";
import { isBrandTenant } from "../brand-tenants.js";
import { PAGES } from "../content/pages.js";
import { sanitizeHtml, wordsLostBySanitizing, addressesLostBySanitizing, markupTagIn } from "../sanitize.js";
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
import { issue, ValidationError, infraKind } from "./issues.js";
import { notMigratedYet } from "../schema-shape.js";
import { getCollectionHandlesByIds } from "../repo.js";
import { runLegacyBatch } from "../cms-mode.js";

// P4-GUARD (MIG-03): every write to cms_blocks, cms_pages and page_redirects
// below is a Kysely query that is COMPILED, never executed, and sent through
// runLegacyBatch: one batch with the legacy guard in front. A store that left
// legacy after the caller's pre-check refuses there (409, plain words) and
// nothing is written. scripts/test-writers.js fails on an executed write here.
const affected = (r) => Number(r?.rowsAffected ?? 0);

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
    if (notMigratedYet(e, { table: "cms_blocks" })) return null; // pre-migration tenant → defaults
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
  if (!BLOCK_KEYS.includes(key)) throw new ValidationError([issue({ code: "UNKNOWN_BLOCK", message: `unknown block "${key}"` })]);
  const now = new Date().toISOString();
  const schemaVersion = BLOCK_SCHEMAS[key]?.version ?? 1;
  // DOC-04: STRICT. A failed read used to come back as "no row", so the save
  // answered 409 "edited by someone else" for what was a database failure.
  const current = await getBlockRow(key, { strict: true });
  if (expectedRevision !== undefined) {
    const want = expectedRevision == null ? null : Number(expectedRevision);
    const have = current ? current.revision : null;
    if (want !== have) throw new CmsConflictError(current);
  }
  if (current) {
    // CAS guard closes the read→write race: zero rows updated = lost the race.
    const [res] = await runLegacyBatch([
      db
        .updateTable("cms_blocks")
        .set({ value: JSON.stringify(value), updated_at: now, revision: current.revision + 1, schema_version: schemaVersion })
        .where("key", "=", key)
        .where("revision", "=", current.revision),
    ]);
    if (affected(res) === 0) throw new CmsConflictError(await getBlockRow(key, { strict: true }));
    return { value, revision: current.revision + 1 };
  }
  try {
    await runLegacyBatch([db.insertInto("cms_blocks").values({ key, value: JSON.stringify(value), updated_at: now, revision: 1, schema_version: schemaVersion })]);
  } catch (e) {
    // two first saves raced and the other one created the row
    if (isRaceOnInsert(e)) throw new CmsConflictError(await getBlockRow(key, { strict: true }));
    throw e;
  }
  return { value, revision: 1 };
}

// S53 (0B-1): reset/delete accept the revision the editor loaded — a reset
// racing a colleague's save now conflicts instead of silently discarding
// their work. Omitted = unchecked (scripts, privileged paths). A row that is
// already gone makes the delete idempotent, not a conflict.
export async function deleteBlock(key, { expectedRevision } = {}) {
  if (expectedRevision == null) {
    await runLegacyBatch([db.deleteFrom("cms_blocks").where("key", "=", key)]);
    return;
  }
  const [res] = await runLegacyBatch([db.deleteFrom("cms_blocks").where("key", "=", key).where("revision", "=", expectedRevision)]);
  if (affected(res) === 0) {
    const row = await getBlockRow(key, { strict: true });
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
  return isBrandTenant(tenantId());
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
// DOC-04: `strict` (the editors' view) lets a failed read throw, so the
// console never shows a store's pages as gone. A tenant that hasn't got the
// table or the family column yet still reads as it always did; any other
// schema error is a failed read (P1-FIX-C: "no such column" in general used to
// pass, so a broken read showed no pages).
export async function listContentPages({ strict = false } = {}) {
  let rows = [];
  try {
    rows = await db.selectFrom("cms_pages").select(["slug", "title", "enabled", "updated_at", "family"]).execute();
  } catch (e) {
    if (strict && !notMigratedYet(e, { table: "cms_pages", columns: ["family"] })) throw e;
    try {
      rows = await db.selectFrom("cms_pages").select(["slug", "title", "enabled", "updated_at"]).execute();
    } catch (e2) {
      if (strict && !notMigratedYet(e2, { table: "cms_pages" })) throw e2;
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
// DOC-04: every problem is a structured issue naming the section id and field,
// all of them are collected, and no message carries a position. The editor
// puts "section 2" in front, worked out from the id.
const tooLong = (value, max, what) => `the ${what} is too long (${value.length} characters, the limit is ${max})`;
// Characters pasted from another app that show nothing (zero-width, direction
// and joining marks, lone combining marks, blank Braille and Hangul fillers)
// don't count as content. Only the check ignores them: stored text keeps them,
// because some scripts and emoji need them to display correctly.
const isBlank = (value) => !value.replace(/[\p{Cc}\p{Cf}\p{Mn}\u2800\u3164\u115F\u1160\uFFA0]/gu, "").trim();
// Sanitized HTML shows nothing with only empty tags in it: "<p>&nbsp;</p>". A
// browser reads the nbsp forms with or without the semicolon, the others only with.
const BLANK_ENTITY = /&(?:(?:nbsp|#160|#xa0);?|(?:ensp|emsp|thinsp|zwj|zwnj|#8203|#x200b);)/gi;
const isBlankHtml = (html) => !/<(img|hr)\b/i.test(html) && isBlank(html.replace(/<[^>]*>/g, "").replace(BLANK_ENTITY, " "));
const quoted = (text) => `"${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`;
const LOST_ADDRESS = {
  link: (address) => `saving would lose this link or image address: ${address}. It needs to start with https or a slash (/). Change it or remove it, then save again.`,
  media: (address) => `this page can't show embedded videos or sound yet, so saving would lose ${address}. Remove it or link to it instead.`,
  picture: (address) => `this page can't show this type of picture yet, so saving would lose ${address}. Add it as an image section, or remove it.`,
};
// Sanitizing may remove unsafe tags (AU-06 owns telling the founder), but never
// their words, a real link's address, or a video or picture: refuse so they
// stay in the form to fix. Returns the problem's { code, message }, or null.
// Stray < or > signs are the cause only when the lost words hold no tag; a tag
// is named instead (P3-FIX4). This editor's box already shows the HTML, so the
// founder removes the tag there.
// P3-FIX5: named only when it reads as markup (lib/sanitize.js markupTagIn).
const wordsLostMessage = (lost) => {
  const found = markupTagIn(lost);
  if (!found) return `saving would lose these words: ${quoted(lost)}. This usually comes from < or > signs. Reword them or remove them, then save again.`;
  const tag = found.length > 24 ? `${found.slice(0, 24)}…` : found; // a long one is quoted short, as the words are
  return `saving would lose these words: ${quoted(lost)}. They come from a <${tag}> tag this page can't show, often from pasted text. Remove that tag, or reword it if you typed it, then save again.`;
};
const lostBySanitizing = (raw, html) => {
  const lost = wordsLostBySanitizing(raw, html);
  if (lost) return { code: "WORDS_LOST", message: wordsLostMessage(lost) };
  const [gone] = addressesLostBySanitizing(raw);
  if (gone) return { code: gone.kind === "link" ? "ADDRESS_LOST" : gone.kind === "media" ? "MEDIA_LOST" : "PICTURE_LOST", message: LOST_ADDRESS[gone.kind](quoted(gone.address)) };
  return null;
};

// sections -> { issues, value }. Every section is checked and every problem
// collected; `value` is the cleaned list, meaningful only when there are no
// issues. Ids are stamped FIRST (valid unique incoming ids kept, the rest
// minted), so each issue names the id that section is saved under.
export function checkPageSections(sections) {
  const issues = [];
  if (!Array.isArray(sections)) {
    issues.push(issue({ field: "sections", code: "INVALID_SHAPE", message: "The sections couldn't be read. Reload the page and try again." }));
    return { issues, value: [] };
  }
  const stamped = ensureSectionIds(sections.map((s) => (s && typeof s === "object" ? s : {})));
  const value = stamped.map((s) => {
    const kind = s.kind || "text";
    const id = s.id;
    const problem = (field, code, message) => issues.push(issue({ sectionId: id, field, code, message }));
    // a limit is checked on its own; the value goes on either way so the
    // other fields are still checked
    const limited = (text, max, field, what) => {
      if (text.length > max) problem(field, "TOO_LONG", tooLong(text, max, what));
      return text;
    };
    // an HTML field: lost words or addresses, then the limit, then blankness,
    // each only if the one before passed (an embed alone is "would lose", not
    // "empty"). Returns the sanitized html, or null when it already failed.
    const htmlField = (raw, max, field, what) => {
      const html = sanitizeHtml(raw);
      const lost = lostBySanitizing(raw, html);
      if (lost) return problem(field, lost.code, lost.message), null;
      if (html.length > max) return problem(field, "TOO_LONG", tooLong(html, max, what)), null;
      return html;
    };
    const typedHeading = kind === "image" ? "" : String(s.heading ?? "").trim(); // images have no heading
    const heading = isBlank(typedHeading) ? "" : limited(typedHeading, 120, "heading", "heading");
    if (kind === "text") {
      if (s.body != null && !Array.isArray(s.body)) {
        problem("body", "INVALID_SHAPE", "paragraphs must be a list");
        return { id, kind: "text", heading, body: [] };
      }
      const body = (s.body || []).map((p) => String(p ?? "")).filter((p) => !isBlank(p));
      if (!heading && !body.length) problem("body", "SECTION_EMPTY", "add a heading or some text, or remove this section.");
      const over = body.find((p) => p.length > 4000);
      if (over) problem("body", "TOO_LONG", tooLong(over, 4000, "paragraph"));
      return { id, kind: "text", heading, body };
    }
    if (kind === "rich") {
      const html = htmlField(String(s.html ?? ""), 20000, "html", "content");
      if (html != null && isBlankHtml(html)) problem("html", "SECTION_EMPTY", "this section is empty. Add some content, or remove this section.");
      return { id, kind: "rich", heading, html: html ?? "" };
    }
    if (kind === "image") {
      const src = String(s.src ?? "").trim();
      if (!src) problem("src", "SECTION_EMPTY", "choose an image, or remove this section.");
      else if (!/^(https:\/\/|\/(?!\/))/.test(src)) problem("src", "IMAGE_INVALID", "this image link isn't secure. Use a link that starts with https, or choose an image from your library.");
      else {
        limited(src, 500, "src", "image link");
        if (isBlank(String(s.alt ?? ""))) problem("alt", "REQUIRED", "image needs alt text");
      }
      const alt = limited(String(s.alt ?? "").trim(), 300, "alt", "alt text");
      const caption = limited(String(s.caption ?? "").trim(), 300, "caption", "caption");
      return { id, kind: "image", src, alt, caption };
    }
    if (kind === "faq") {
      // S39 (SF16): question/answer accordions with stable deep-link anchors.
      if (!Array.isArray(s.items) || !s.items.length) {
        problem("items", "SECTION_EMPTY", "an FAQ section needs at least one question");
        return { id, kind: "faq", heading, items: [] };
      }
      if (s.items.length > 30) problem("items", "TOO_MANY", "at most 30 questions per FAQ section");
      const items = s.items.map((it, j) => {
        const q = limited(String(it?.q ?? "").trim(), 300, `items.${j}.q`, "question");
        if (isBlank(q)) problem(`items.${j}.q`, "REQUIRED", "question text required");
        const a = htmlField(String(it?.a ?? ""), 8000, `items.${j}.a`, "answer");
        if (a != null && isBlankHtml(a)) problem(`items.${j}.a`, "REQUIRED", "answer required");
        return { q, a: a ?? "" };
      });
      return { id, kind: "faq", heading, items };
    }
    problem("kind", "UNKNOWN_KIND", `unknown kind "${kind}"`);
    return null;
  });
  return { issues, value: value.filter(Boolean) };
}

// The throwing form older callers use: the clean list, or a ValidationError
// carrying EVERY issue.
export function validatePageSections(sections) {
  const { issues, value } = checkPageSections(sections);
  if (issues.length) throw new ValidationError(issues);
  return value;
}

// S39 (SF17): is a campaign page inside its UTC visibility window?
export function campaignVisible(page, now = Date.now()) {
  if (page.window_start && now < new Date(page.window_start).getTime()) return false;
  if (page.window_end && now >= new Date(page.window_end).getTime()) return false;
  return true;
}

// DOC-04: a uniqueness failure on a CMS write means two first saves raced.
// That is a 409 with the current row (DOC-02), never a 422 and never a 5xx.
// Only a UNIQUE or PRIMARY KEY failure counts: a NOT NULL or CHECK failure is
// a bug of ours, and answers 500 rather than "edited by someone else".
const isRaceOnInsert = (e) => infraKind(e) === "conflict";

export async function upsertContentPage({ slug, title, description = "", sections = [], enabled = true, effective_at = null, family = "page", window_start = null, window_end = null, redirect_from = null }, { expectedRevision } = {}) {
  // DOC-04: every problem with the page is collected before anything is
  // written, and refused together.
  const issues = [];
  const problem = (field, code, message) => issues.push(issue({ field, code, message }));
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) problem("slug", "SLUG_INVALID", "slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) problem("title", "REQUIRED", "title required");
  const checked = checkPageSections(sections);
  issues.push(...checked.issues);
  const clean = checked.value;
  // SF14: optional effective date (YYYY-MM-DD) shown on policy pages.
  let effectiveAt = null;
  if (effective_at) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_at))) problem("effective_at", "DATE_INVALID", "effective date must be YYYY-MM-DD");
    else effectiveAt = String(effective_at);
  }
  // S39 (SF17): campaign pages serve at /campaigns/<slug> inside a UTC window.
  // S46 (SF20): journal posts serve at /journal/<slug>; window_start doubles
  // as their SCHEDULED PUBLISH instant. The CONSOLE converts the merchant's
  // local wall time to UTC ISO — the server only ever accepts instants.
  if (!["page", "campaign", "journal"].includes(family)) problem("family", "FAMILY_INVALID", `unknown page family "${family}"`);
  const instant = (v, label, field) => {
    if (!v) return null;
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) {
      problem(field, "DATE_INVALID", `${label} must be a UTC ISO instant`);
      return null;
    }
    return t.toISOString();
  };
  const winStart = instant(window_start, "window start", "window_start");
  const winEnd = instant(window_end, "window end", "window_end");
  if (winStart && winEnd && winEnd <= winStart) problem("window_end", "WINDOW_INVALID", "window end must be after window start");
  if (family === "page" && (winStart || winEnd)) problem("window_start", "WINDOW_INVALID", "visibility windows are for campaign and journal pages");
  // DOC-04: checked BEFORE the write. It used to be checked after, so a bad
  // value refused the save with a 422 while the page row was already stored.
  const from = redirect_from ? String(redirect_from).trim().toLowerCase() : null;
  if (from && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(from)) problem("redirect_from", "SLUG_INVALID", "redirect-from must be a slug");
  else if (from && from === slug) problem("redirect_from", "REDIRECT_SELF", "a page can't redirect to itself");
  if (issues.length) throw new ValidationError(issues);
  const now = new Date().toISOString();
  const row = { slug, title: title.trim(), description: description || "", sections: JSON.stringify(clean), enabled: enabled ? 1 : 0, effective_at: effectiveAt, family, window_start: winStart, window_end: winEnd, updated_at: now, schema_version: PAGE_SCHEMA.version };
  const current = await db.selectFrom("cms_pages").select(["revision", "sections", "title"]).where("slug", "=", slug).executeTakeFirst();
  if (expectedRevision !== undefined) {
    const want = expectedRevision == null ? null : Number(expectedRevision);
    const have = current ? (current.revision ?? 0) : null;
    if (want !== have) throw new CmsConflictError(current ? { value: { title: current.title, sections: parse(current.sections, []) }, revision: current.revision ?? 0 } : null);
  }
  if (current) {
    const [res] = await runLegacyBatch([
      db
        .updateTable("cms_pages")
        .set({ ...row, revision: (current.revision ?? 0) + 1 })
        .where("slug", "=", slug)
        .where("revision", "=", current.revision ?? 0),
    ]);
    if (affected(res) === 0) throw new CmsConflictError(null);
  } else {
    try {
      await runLegacyBatch([db.insertInto("cms_pages").values({ ...row, revision: 1 })]);
    } catch (e) {
      if (!isRaceOnInsert(e)) throw e;
      const won = await db.selectFrom("cms_pages").select(["revision", "sections", "title"]).where("slug", "=", slug).executeTakeFirst();
      throw new CmsConflictError(won ? { value: { title: won.title, sections: parse(won.sections, []) }, revision: won.revision ?? 0 } : null);
    }
  }
  // S46 (SF20): slug changes keep old URLs alive — "redirect_from" records
  // that an old slug now points here (self-redirects and loops refused).
  // A page saved at a slug always kills any redirect FROM that slug: a live
  // page beats a stale redirect, and no redirect chain can loop back here.
  // pre-migration tenants lack the table; any other failure is a failed save
  // (P1-FIX-C: this used to swallow every error, so a save could answer 200
  // with an old redirect still pointing away from this page)
  // P4-GUARD: each in its own guarded batch, as before each was its own
  // statement (a store from before 0011 has no page_redirects, and the page write
  // above must not depend on it).
  await runLegacyBatch([db.deleteFrom("page_redirects").where("from_slug", "=", slug)]).catch((e) => {
    if (!notMigratedYet(e, { table: "page_redirects" })) throw e;
  });
  if (from) {
    await runLegacyBatch([
      db
        .insertInto("page_redirects")
        .values({ from_slug: from, to_slug: slug, created_at: now })
        .onConflict((oc) => oc.column("from_slug").doUpdateSet({ to_slug: slug, created_at: now })),
    ]);
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
// DOC-04: `strict`, as above. A failed read here must not reach the editor as
// "no revisions": its next save would then fail as a false conflict.
export async function pageRevisions({ strict = false } = {}) {
  try {
    const rows = await db.selectFrom("cms_pages").select(["slug", "revision"]).execute();
    return Object.fromEntries(rows.map((r) => [r.slug, r.revision ?? 0]));
  } catch (e) {
    // only a store from before the pages table or its revision column (0006)
    if (strict && !notMigratedYet(e, { table: "cms_pages", columns: ["revision"] })) throw e;
    return {};
  }
}

export async function deleteContentPage(slug, { expectedRevision } = {}) {
  if (expectedRevision == null) {
    await runLegacyBatch([db.deleteFrom("cms_pages").where("slug", "=", slug)]);
    return;
  }
  const [res] = await runLegacyBatch([db.deleteFrom("cms_pages").where("slug", "=", slug).where("revision", "=", expectedRevision)]);
  if (affected(res) === 0) {
    const row = await db.selectFrom("cms_pages").select(["title", "sections", "revision"]).where("slug", "=", slug).executeTakeFirst();
    if (row) throw new CmsConflictError({ value: { title: row.title, sections: JSON.parse(row.sections || "[]") }, revision: row.revision ?? 0 });
  }
}
