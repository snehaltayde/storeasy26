// P2-REG (DOC-02, DOC-07): pure adapters between today's (legacy) content
// shapes and registry settings. Edge-safe.
//
//   legacyHeroToSettings(hero)          old flat hero -> hero section settings
//   settingsToLegacyHero(settings)      and back (the image has no legacy home)
//   legacyHeroToSection(hero, {id})     a whole hero section: declared defaults
//                                       under the legacy values
//   legacyAnnouncementToSettings(a)     old announcement -> announcement settings
//   legacyHomeSectionsToSections(list)  old home_sections -> sections, with the
//                                       same sec_l<i> ids lib/cms/schemas.js
//                                       stamps at read
//   legacyPageSectionsToSections(list)  old page sections -> sections, through
//                                       LEGACY_KIND_NAMES
//
// The one rule: an adapter never drops a legacy field, even one that fails
// validation. The value is carried over as it was (a bad link stays a bad
// link, an unknown field stays) and validateDocument reports it. Only the
// shape changes: an href becomes a typed { type: "url", href } link, a
// button's { label, href } becomes { label, link }, a page section's
// "heading" becomes "title".
import { sectionType, defaultSettings } from "./index.js";
import { linkHref } from "./settings.js";
import { SECTION_ID_RE } from "./body.js";
import { LEGACY_KIND_NAMES } from "./sections.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A lookup in a plain table that ignores names inherited from Object.prototype
// ("constructor", "toString", "__proto__"), so they read as unknown.
const own = (table, k) => (typeof k === "string" && Object.hasOwn(table, k) ? table[k] : undefined);
const hasKey = (o, k) => Object.hasOwn(o, k);

// An href, as a typed link. Absent stays absent; anything present is carried,
// even "" or a value that isn't a storefront route.
const hrefToLink = (href) => ({ type: "url", href });

function legacyButton(b) {
  if (b == null) return null;
  if (!isObj(b)) return b; // carried; validation reports it
  const { label, href, ...rest } = b;
  const out = { ...rest };
  if (hasKey(b, "label")) out.label = label;
  if (hasKey(b, "href")) out.link = href == null ? null : hrefToLink(href);
  return out;
}

function buttonToLegacy(c) {
  if (c == null) return null;
  if (!isObj(c)) return c;
  const { label, link, ...rest } = c;
  const out = { ...rest };
  if (hasKey(c, "label")) out.label = label;
  if (hasKey(c, "link")) out.href = link == null ? null : isObj(link) && link.type === "url" ? link.href : (linkHref(link) ?? link);
  return out;
}

export function legacyHeroToSettings(hero) {
  if (!isObj(hero)) return {};
  const out = {};
  for (const [k, v] of Object.entries(hero)) out[k] = k === "primary" || k === "secondary" ? legacyButton(v) : v;
  return out;
}

export function settingsToLegacyHero(settings) {
  if (!isObj(settings)) return {};
  const out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (k === "image") continue; // the legacy hero has no image
    out[k] = k === "primary" || k === "secondary" ? buttonToLegacy(v) : v;
  }
  return out;
}

// The hero becomes section 0 of the home document (DOC-07). Its id is fixed,
// so a backfill run twice gives the same body.
export const HERO_SECTION_ID = "sec_hero";

export function legacyHeroToSection(hero, { id = HERO_SECTION_ID, enabled = true } = {}) {
  return { id, kind: "hero", v: sectionType("hero").version, enabled, settings: { ...defaultSettings(sectionType("hero")), ...legacyHeroToSettings(hero) }, blocks: [] };
}

export function legacyAnnouncementToSettings(a) {
  if (!isObj(a)) return {};
  const { href, ...rest } = a;
  const out = { ...rest };
  // an empty href is how the legacy bar says "no link"
  if (hasKey(a, "href")) out.link = href == null || href === "" ? null : hrefToLink(href);
  return out;
}

// ---- section lists -------------------------------------------------------------

const nonEmpty = (v) => v != null && v !== "";

function bannerButton(fields) {
  const { label, href } = fields;
  if (!nonEmpty(label) && !nonEmpty(href)) return null;
  return { label: label ?? "", link: nonEmpty(href) ? hrefToLink(href) : null };
}

// Each mapper takes the legacy fields (everything but id, kind and enabled)
// and returns settings. Fields a mapper doesn't name are carried as they are.
const HOME_MAPPERS = {
  collections: (f) => ({ ...f }),
  new: (f) => ({ ...f }),
  rich_text: (f) => ({ ...f }),
  banner: ({ label, href, ...rest }) => {
    const out = { ...rest };
    if (label !== undefined || href !== undefined) out.button = bannerButton({ label, href });
    return out;
  },
  image_with_text: ({ image, image_alt, label, href, ...rest }) => {
    const out = { ...rest };
    if (nonEmpty(image) || nonEmpty(image_alt)) out.image = { media: image ?? "", alt: image_alt ?? "" };
    else if (image !== undefined || image_alt !== undefined) out.image = null;
    if (label !== undefined || href !== undefined) out.button = bannerButton({ label, href });
    return out;
  },
  product_rail: ({ collection, collection_id, ...rest }) => {
    const out = { ...rest };
    if (nonEmpty(collection) || nonEmpty(collection_id)) out.collection = { handle: collection ?? "", ...(nonEmpty(collection_id) ? { id: collection_id } : {}) };
    else if (collection !== undefined) out.collection = null;
    return out;
  },
};

function toSection(s, id, mappers) {
  if (!isObj(s)) return { id, kind: null, v: 1, enabled: true, settings: {}, blocks: [], legacy_value: s };
  const { id: _id, kind, enabled, ...fields } = s;
  const map = own(mappers, kind);
  const d = sectionType(kind);
  return { id, kind, v: d ? d.version : 1, enabled: enabled !== false, settings: map ? map(fields) : { ...fields }, blocks: [] };
}

// Ids exactly as lib/cms/schemas.js stamps them at read: a valid id is kept
// (even a duplicate, which validation then reports), anything else becomes
// sec_l<index in the stored list>.
const legacyId = (s, i) => (isObj(s) && typeof s.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : `sec_l${i}`);

export function legacyHomeSectionsToSections(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s, i) => toSection(s, legacyId(s, i), HOME_MAPPERS));
}

// Page sections, through the merged names. As normalizePageSections does: a
// section with no kind is a text section, empty entries are skipped, and ids
// are stamped by index after that.
function renameFields(fields, renames) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const to = own(renames, k);
    if (!to) out[k] = v;
    else if (to.includes(".")) {
      const [outer, inner] = to.split(".");
      out[outer] = isObj(out[outer]) ? out[outer] : {};
      out[outer][inner] = v;
    } else out[to] = v;
  }
  return out;
}

export function legacyPageSectionsToSections(list) {
  if (!Array.isArray(list)) return [];
  const normalized = list.map((s) => (s && !s.kind ? { kind: "text", ...s } : s)).filter(Boolean);
  return normalized.map((s, i) => {
    const id = legacyId(s, i);
    if (!isObj(s)) return toSection(s, id, {});
    const named = own(LEGACY_KIND_NAMES, s.kind);
    if (!named) return toSection(s, id, {});
    const { id: _id, kind: _kind, enabled, ...fields } = s;
    const d = sectionType(named.kind);
    return { id, kind: named.kind, v: d ? d.version : 1, enabled: enabled !== false, settings: renameFields(fields, named.fields), blocks: [] };
  });
}
