// P2-REG (DOC-03, DOC-04): setting kinds for the document registry. Pure and
// edge-safe: no React, no Next, no node: imports.
//
// A setting is declared once, on a section type or a document type:
//   { key, kind, label, required, default, max, softMax, min, maxEach,
//     options, placeholder }
// and this file is the one place that knows, for each kind:
//   - how to check a value (checkSetting), reporting problems through
//     report(field, code, message, cls) where cls is one of
//       "structure"   the value has the wrong shape: an error in every mode
//       "invalid"     the value breaks a limit or rule: an error in every mode
//       "incomplete"  something required is missing: "incomplete" in a draft,
//                     an error at publish (DOC-05)
//       "warning"     worth saying, never blocks
//   - what the editor control is (controlOf)
//   - which references and media it holds (refsOfSetting)
//
// Nothing here strips or cuts a value. An over-long title is reported as
// TOO_LONG and stays as typed; a field nobody declared is reported as
// UNKNOWN_FIELD and stays. The only change a check makes is sanitizing HTML,
// and only when sanitizing loses none of the founder's words or addresses.
//
// Links are typed (spec 8.5):
//   { type: "url", href }                         a storefront path or #anchor
//   { type: "collection", handle, id? }           /collections/<handle>
//   { type: "product", handle, id? }              /products/<handle>
//   { type: "page", slug, family, document? }     /policies|/campaigns|/journal/<slug>
// A link that is not a storefront route (another site, /admin, //host, a path
// with "..") is LINK_NOT_STOREFRONT.
import { validateBrand, DEFAULT_BRAND, KIT_SURFACES } from "../brand.js";
import { sanitize, lostBySanitizing, isBlank, isBlankHtml } from "./text.js";

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A lookup in a plain table that ignores names inherited from Object.prototype
// ("constructor", "toString", "__proto__"), so they read as unknown.
const own = (table, k) => (typeof k === "string" && Object.hasOwn(table, k) ? table[k] : undefined);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const shown = (v) => {
  const t = String(v);
  return `"${t.length > 60 ? `${t.slice(0, 60)}…` : t}"`;
};

// ---- typed links -------------------------------------------------------------

export const LINK_TYPES = Object.freeze(["url", "collection", "product", "page"]);
const LINK_KEYS = {
  url: ["type", "href"],
  collection: ["type", "handle", "id"],
  product: ["type", "handle", "id"],
  page: ["type", "slug", "family", "document"],
};
export const PAGE_FAMILIES = Object.freeze({ page: "/policies/", campaign: "/campaigns/", journal: "/journal/" });

// The storefront's own routes. The same list as KNOWN_PATHS in lib/releases.js,
// tightened: a product, page or quiz route needs something after its slash.
const STOREFRONT_PATH =
  /^\/(?:$|[?#]|collections(?:$|[/?#])|products\/[^/?#]|search(?:$|[?#])|about(?:$|[?#])|contact(?:$|[?#])|policies\/[^/?#]|campaigns\/[^/?#]|orders\/[^/?#]|cart(?:$|[?#])|journal(?:$|[/?#])|quiz\/[^/?#]|bundles\/[^/?#]|wishlist(?:$|[?#])|account(?:$|[/?#]))/;
// Whitespace, backslashes, dot segments and encoded slashes or dots can turn a
// storefront-looking path into another one once the browser normalizes it.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH = /[\s\\\u0000-\u001f\u007f]|\.\.|%(?:2e|2f|5c|00)/i;
const ANCHOR = /^#[A-Za-z][\w-]{0,60}$/;

export function isStorefrontHref(href) {
  const h = String(href ?? "");
  if (ANCHOR.test(h)) return true;
  if (!h.startsWith("/") || h.startsWith("//") || UNSAFE_PATH.test(h)) return false;
  return STOREFRONT_PATH.test(h);
}

// Where a typed link goes, as a path. null when the link can't be read.
export function linkHref(link) {
  if (!isObj(link)) return null;
  if (link.type === "url") return typeof link.href === "string" ? link.href : null;
  if (link.type === "collection" && typeof link.handle === "string") return `/collections/${link.handle}`;
  if (link.type === "product" && typeof link.handle === "string") return `/products/${link.handle}`;
  if (link.type === "page" && typeof link.slug === "string" && own(PAGE_FAMILIES, link.family)) return `${own(PAGE_FAMILIES, link.family)}${link.slug}`;
  return null;
}

function unknownKeys(value, allowed, path, what, report) {
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) report(`${path}.${k}`, "UNKNOWN_FIELD", `"${k}" isn't something ${what} can hold, so this can't be saved. Nothing was removed: delete it or correct the name.`, "structure");
  }
}

function checkLink(v, path, label, report) {
  const what = `the ${lower(label)}`;
  if (!isObj(v) || typeof v.type !== "string") {
    report(path, "LINK_INVALID", `${cap(what)} couldn't be read. Choose where it goes again.`, "structure");
    return v;
  }
  if (!own(LINK_KEYS, v.type)) {
    report(path, "LINK_INVALID", `${cap(what)} has a kind of link we don't know (${shown(v.type)}). Choose where it goes again.`, "structure");
    return v;
  }
  unknownKeys(v, own(LINK_KEYS, v.type), path, "a link", report);
  if (v.type === "url") {
    if (typeof v.href !== "string" || isBlank(v.href)) report(`${path}.href`, "REQUIRED", `${cap(what)} has no address. Choose where it goes.`, "incomplete");
    else if (!isStorefrontHref(v.href))
      report(
        `${path}.href`,
        "LINK_NOT_STOREFRONT",
        `${cap(what)} goes to ${shown(v.href)}, which isn't a page of your store. Link to a collection, a product, one of your pages or a section of this page (#name).`,
        "invalid",
      );
    return v;
  }
  if (v.type === "collection" || v.type === "product") {
    if (typeof v.handle !== "string" || !HANDLE_RE.test(v.handle))
      report(`${path}.handle`, "LINK_INVALID", `${cap(what)} points at a ${v.type} we can't find (${shown(v.handle ?? "")}). Choose the ${v.type} again.`, "invalid");
    if (v.id != null && (typeof v.id !== "string" || v.id.length > 120)) report(`${path}.id`, "INVALID_VALUE", `${cap(what)} has a ${v.type} id that couldn't be read. Choose the ${v.type} again.`, "structure");
    return v;
  }
  // page
  if (typeof v.slug !== "string" || !SLUG_RE.test(v.slug)) report(`${path}.slug`, "LINK_INVALID", `${cap(what)} points at a page address that isn't valid (${shown(v.slug ?? "")}). Choose the page again.`, "invalid");
  if (!own(PAGE_FAMILIES, v.family)) report(`${path}.family`, "LINK_INVALID", `${cap(what)} points at a kind of page we don't know. Choose the page again.`, "structure");
  if (v.document != null && typeof v.document !== "string") report(`${path}.document`, "INVALID_VALUE", `${cap(what)} couldn't be read. Choose the page again.`, "structure");
  return v;
}

// ---- small checks shared by kinds ---------------------------------------------

function checkText(v, s, path, report, { max = s.max, softMax = s.softMax, label = s.label } = {}) {
  if (typeof v !== "string") {
    report(path, "INVALID_VALUE", `The ${lower(label)} must be text.`, "structure");
    return v;
  }
  if (max != null && v.length > max) report(path, "TOO_LONG", `The ${lower(label)} is too long (${v.length} characters, the limit is ${max}).`, "invalid");
  else if (softMax != null && v.length > softMax)
    report(path, "LONG", `The ${lower(label)} is ${v.length} characters. Over ${softMax} it may wrap onto several lines on phones.`, "warning");
  return v;
}

// Sanitizes; refuses when sanitizing would lose the founder's words. Returns
// the sanitized HTML, or the raw value untouched when it was refused.
function checkHtml(v, path, label, max, report) {
  if (typeof v !== "string") {
    report(path, "INVALID_VALUE", `The ${lower(label)} must be text.`, "structure");
    return v;
  }
  const html = sanitize(v);
  const lost = lostBySanitizing(v, html);
  if (lost) {
    report(path, lost.code, cap(lost.message), "structure");
    return v;
  }
  if (max != null && html.length > max) report(path, "TOO_LONG", `The ${lower(label)} is too long (${html.length} characters, the limit is ${max}).`, "invalid");
  return html;
}

function checkRef(v, path, label, noun, report) {
  if (!isObj(v)) {
    report(path, "INVALID_VALUE", `The ${lower(label)} couldn't be read. Choose the ${noun} again.`, "structure");
    return v;
  }
  unknownKeys(v, ["handle", "id"], path, `a ${noun} choice`, report);
  if (typeof v.handle !== "string" || !HANDLE_RE.test(v.handle)) report(`${path}.handle`, "INVALID_VALUE", `The ${lower(label)} isn't a ${noun} we can find (${shown(v.handle ?? "")}). Choose the ${noun} again.`, "invalid");
  if (v.id != null && (typeof v.id !== "string" || v.id.length > 120)) report(`${path}.id`, "INVALID_VALUE", `The ${lower(label)} has an id that couldn't be read. Choose the ${noun} again.`, "structure");
  return v;
}

function checkList(v, s, path, report, noun) {
  if (!Array.isArray(v)) {
    report(path, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Reload the page and try again.`, "structure");
    return false;
  }
  if (s.max != null && v.length > s.max) {
    const extra = v.length - s.max;
    report(path, "TOO_MANY", `The ${lower(s.label)} list has ${v.length} ${noun}s, and the limit is ${s.max}. Remove ${extra === 1 ? `one ${noun}` : `${extra} ${noun}s`}.`, "invalid");
  }
  return true;
}

// lib/brand.js validateBrand words its errors for code ("accent must be a
// 6-digit hex color (e.g. #84cc16)", "type_scale must be one of …"). The
// registry says the same in plain sentences, keyed by the setting each one
// names (the first word of the message).
const BRAND_WORDS = {
  accent: "Your accent colour isn't a colour we can read. Pick it again.",
  background: "Your background colour isn't a colour we can read. Pick it again.",
  foreground: "Your text colour isn't a colour we can read. Pick it again.",
  radius: "The corner style isn't one of the choices. Pick one again.",
  type_scale: "The text size isn't one of the choices. Pick one again.",
  button_shape: "The button shape isn't one of the choices. Pick one again.",
  section_spacing: "The space between sections isn't one of the choices. Pick one again.",
};
function brandMessage(message) {
  const key = String(message).split(" ")[0];
  return own(BRAND_WORDS, key) || "One of your brand settings couldn't be read. Pick it again.";
}

// ---- the kinds -----------------------------------------------------------------

const emptyNull = (v) => v == null;

export const SETTING_KINDS = Object.freeze({
  text: {
    control: "text",
    empty: (v) => v == null || (typeof v === "string" && isBlank(v)),
    check: (v, s, path, report) => checkText(v, s, path, report),
  },
  number: {
    control: "number",
    empty: emptyNull,
    check(v, s, path, report) {
      if (typeof v !== "number" || !Number.isInteger(v)) report(path, "INVALID_VALUE", `The ${lower(s.label)} must be a whole number.`, "structure");
      else if ((s.min != null && v < s.min) || (s.max != null && v > s.max))
        report(path, "OUT_OF_RANGE", `The ${lower(s.label)} must be from ${s.min ?? 0} to ${s.max}. It is ${v}.`, "invalid");
      return v;
    },
  },
  boolean: {
    control: "toggle",
    empty: emptyNull,
    check(v, s, path, report) {
      if (typeof v !== "boolean") report(path, "INVALID_VALUE", `The ${lower(s.label)} must be on or off.`, "structure");
      return v;
    },
  },
  choice: {
    control: "choice",
    empty: emptyNull,
    check(v, s, path, report) {
      if (!s.options.includes(v)) report(path, "INVALID_CHOICE", `The ${lower(s.label)} must be one of: ${s.options.join(", ")}.`, "invalid");
      return v;
    },
  },
  rich_text: {
    control: "rich_text",
    empty: (v) => v == null || (typeof v === "string" && isBlankHtml(sanitize(v))),
    check: (v, s, path, report) => checkHtml(v, path, s.label, s.max, report),
  },
  paragraphs: {
    control: "paragraphs",
    empty: (v) => v == null || (Array.isArray(v) && v.every((p) => typeof p === "string" && isBlank(p))),
    check(v, s, path, report) {
      if (!checkList(v, s, path, report, "paragraph")) return v;
      v.forEach((p, j) => checkText(p, s, `${path}.${j}`, report, { max: s.maxEach, softMax: null, label: "paragraph" }));
      return v;
    },
  },
  qa_list: {
    control: "qa_list",
    empty: (v) => v == null || (Array.isArray(v) && v.length === 0),
    check(v, s, path, report) {
      if (!checkList(v, s, path, report, "question")) return v;
      return v.map((item, j) => {
        const at = `${path}.${j}`;
        if (!isObj(item)) {
          report(at, "INVALID_VALUE", "This question couldn't be read. Remove it and add it again.", "structure");
          return item;
        }
        unknownKeys(item, ["q", "a"], at, "a question", report);
        if (item.q == null || (typeof item.q === "string" && isBlank(item.q))) report(`${at}.q`, "REQUIRED", "This question has no text. Write the question.", "incomplete");
        else checkText(item.q, s, `${at}.q`, report, { max: 300, softMax: null, label: "question" });
        let a = item.a;
        if (a == null || (typeof a === "string" && isBlankHtml(sanitize(a)))) report(`${at}.a`, "REQUIRED", "This question has no answer. Write the answer.", "incomplete");
        else a = checkHtml(a, `${at}.a`, "answer", 8000, report);
        return a === item.a ? item : { ...item, a };
      });
    },
  },
  link: {
    control: "link",
    empty: emptyNull,
    check: (v, s, path, report) => checkLink(v, path, s.label, report),
  },
  cta: {
    control: "button",
    empty: emptyNull,
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Set the button up again.`, "structure");
        return v;
      }
      unknownKeys(v, ["label", "link"], path, "a button", report);
      const hasLabel = typeof v.label === "string" && !isBlank(v.label);
      if (v.label != null) checkText(v.label, s, `${path}.label`, report, { max: 40, softMax: null, label: `${s.label} text` });
      if (v.link == null) {
        if (hasLabel) report(`${path}.link`, "REQUIRED", `The ${lower(s.label)} has text but no link. Choose where it goes.`, "incomplete");
      } else {
        checkLink(v.link, `${path}.link`, `${s.label} link`, report);
        if (!hasLabel) report(`${path}.label`, "NO_LABEL", `The ${lower(s.label)} has no text, so shoppers won't see it.`, "warning");
      }
      return v;
    },
  },
  image: {
    control: "image",
    empty: (v) => v == null || (isObj(v) && (v.media == null || (typeof v.media === "string" && isBlank(v.media)))),
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Choose the image again.`, "structure");
        return v;
      }
      unknownKeys(v, ["media", "alt"], path, "an image", report);
      if (typeof v.media !== "string") report(`${path}.media`, "INVALID_VALUE", "The image couldn't be read. Choose it again.", "structure");
      else if (!/^(https:\/\/|\/(?!\/))/.test(v.media) || /\s/.test(v.media))
        report(`${path}.media`, "IMAGE_INVALID", "This image link isn't secure. Use a link that starts with https, or choose an image from your library.", "invalid");
      else if (v.media.length > 500) report(`${path}.media`, "TOO_LONG", `The image link is too long (${v.media.length} characters, the limit is 500).`, "invalid");
      if (v.alt == null || (typeof v.alt === "string" && isBlank(v.alt))) report(`${path}.alt`, "REQUIRED", "Add alt text for the image: it's what screen readers say.", "incomplete");
      else checkText(v.alt, s, `${path}.alt`, report, { max: 300, softMax: null, label: "alt text" });
      return v;
    },
  },
  collection: {
    control: "collection",
    empty: (v) => v == null || (isObj(v) && (v.handle == null || v.handle === "")),
    check: (v, s, path, report) => checkRef(v, path, s.label, "collection", report),
  },
  product: {
    control: "product",
    empty: (v) => v == null || (isObj(v) && (v.handle == null || v.handle === "")),
    check: (v, s, path, report) => checkRef(v, path, s.label, "product", report),
  },
  collection_list: {
    control: "collections",
    empty: (v) => v == null || (Array.isArray(v) && v.length === 0),
    check(v, s, path, report) {
      if (checkList(v, s, path, report, "collection")) v.forEach((c, j) => checkRef(c, `${path}.${j}`, s.label, "collection", report));
      return v;
    },
  },
  product_list: {
    control: "products",
    empty: (v) => v == null || (Array.isArray(v) && v.length === 0),
    check(v, s, path, report) {
      if (checkList(v, s, path, report, "product")) v.forEach((c, j) => checkRef(c, `${path}.${j}`, s.label, "product", report));
      return v;
    },
  },
  nav_items: {
    control: "menu",
    empty: (v) => v == null || (Array.isArray(v) && v.length === 0),
    check(v, s, path, report) {
      if (!checkList(v, s, path, report, "item")) return v;
      const item = (it, at, depth) => {
        if (!isObj(it)) {
          report(at, "INVALID_VALUE", "This menu item couldn't be read. Remove it and add it again.", "structure");
          return;
        }
        unknownKeys(it, depth === 0 ? ["label", "link", "children"] : ["label", "link", "children"], at, "a menu item", report);
        if (it.label == null || (typeof it.label === "string" && isBlank(it.label))) report(`${at}.label`, "REQUIRED", "This menu item has no text. Write its label.", "incomplete");
        else checkText(it.label, s, `${at}.label`, report, { max: 40, softMax: null, label: "menu label" });
        if (it.link == null) report(`${at}.link`, "REQUIRED", "This menu item has no link. Choose where it goes.", "incomplete");
        else checkLink(it.link, `${at}.link`, "menu link", report);
        if (it.children == null) return;
        if (depth > 0) {
          report(`${at}.children`, "TOO_DEEP", "Menus go one level deep. Move these items up a level.", "structure");
          return;
        }
        if (!Array.isArray(it.children)) {
          report(`${at}.children`, "INVALID_VALUE", "The sub-items couldn't be read. Reload the page and try again.", "structure");
          return;
        }
        if (it.children.length > 8) report(`${at}.children`, "TOO_MANY", `This menu item has ${it.children.length} sub-items, and the limit is 8.`, "invalid");
        it.children.forEach((c, j) => item(c, `${at}.children.${j}`, depth + 1));
      };
      v.forEach((it, j) => item(it, `${path}.${j}`, 0));
      return v;
    },
  },
  brand: {
    control: "brand",
    empty: emptyNull,
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", "Your brand settings couldn't be read. Reload the page and try again.", "structure");
        return v;
      }
      unknownKeys(v, [...Object.keys(DEFAULT_BRAND), "accent_label"], path, "the brand", report);
      for (const message of validateBrand(v).errors) report(path, "BRAND_INVALID", brandMessage(message), "invalid");
      return v;
    },
  },
  theme: {
    control: "theme",
    empty: emptyNull,
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", "Your theme couldn't be read. Reload the page and try again.", "structure");
        return v;
      }
      unknownKeys(v, ["kit", "version", "applied_at"], path, "the theme", report);
      if (!KIT_SURFACES[`${v.kit}-${v.version}`]) report(path, "THEME_INVALID", `There's no look called ${shown(`${v.kit} ${v.version}`)}. Choose a look again.`, "invalid");
      return v;
    },
  },
  entries: {
    control: null, // system documents only: never edited
    empty: emptyNull,
    check(v, s, path, report) {
      if (!Array.isArray(v)) report(path, "INVALID_VALUE", "The list couldn't be read. Reload the page and try again.", "structure");
      return v;
    },
  },
});

// ---- declaring and checking ------------------------------------------------------

const labelOf = (key) => cap(key.replace(/_/g, " "));

// A setting declaration, checked and frozen. Throws on a broken declaration:
// that is a bug in code, found when the module loads.
export function defineSetting(s, where) {
  if (!isObj(s) || typeof s.key !== "string" || !KEY_RE.test(s.key)) throw new Error(`${where}: a setting needs a key of lower-case letters, digits and _`);
  if (!own(SETTING_KINDS, s.kind)) throw new Error(`${where}: setting "${s.key}" has an unknown kind "${s.kind}"`);
  if (s.kind === "choice" && (!Array.isArray(s.options) || !s.options.length)) throw new Error(`${where}: choice setting "${s.key}" needs options`);
  for (const n of ["max", "softMax", "min", "maxEach"]) {
    if (s[n] != null && !(Number.isInteger(s[n]) && s[n] >= 0)) throw new Error(`${where}: setting "${s.key}" has a bad ${n}`);
  }
  if (s.softMax != null && s.max != null && s.softMax > s.max) throw new Error(`${where}: setting "${s.key}" has softMax above max`);
  return Object.freeze({ ...s, label: s.label || labelOf(s.key), required: !!s.required, options: s.options ? Object.freeze([...s.options]) : undefined });
}

export function requiredMessage(s) {
  return `The ${lower(s.label)} is empty. Fill it in before publishing.`;
}

// Check one setting's value. Returns the value to store: the same value, or
// sanitized HTML. report(field, code, message, cls).
export function checkSetting(s, value, path, report) {
  const kind = SETTING_KINDS[s.kind];
  if (kind.empty(value)) {
    if (s.required) report(path, "REQUIRED", requiredMessage(s), "incomplete");
    return value;
  }
  return kind.check(value, s, path, report);
}

export const isEmptySetting = (s, value) => SETTING_KINDS[s.kind].empty(value);

// The editor control a setting gets, derived from its declaration.
export function controlOf(s) {
  const c = { key: s.key, control: SETTING_KINDS[s.kind].control, kind: s.kind, label: s.label, required: s.required };
  for (const n of ["max", "softMax", "min", "maxEach", "placeholder", "help"]) if (s[n] != null) c[n] = s[n];
  if (s.options) c.options = [...s.options];
  if (s.default !== undefined) c.default = s.default;
  return c;
}

// The references and media a setting's value holds, for the media scan, link
// healing and publish checks.
export function refsOfSetting(s, value, path = s.key) {
  const out = [];
  const link = (l, at) => {
    if (!isObj(l)) return;
    const r = { field: at, ref: "link", type: l.type, href: linkHref(l) };
    if (l.handle != null) r.handle = l.handle;
    if (l.id != null) r.id = l.id;
    if (l.slug != null) r.slug = l.slug;
    if (l.document != null) r.document = l.document;
    out.push(r);
  };
  const ref = (kind, v, at) => {
    if (isObj(v) && v.handle) out.push({ field: at, ref: kind, handle: v.handle, ...(v.id != null ? { id: v.id } : {}) });
  };
  if (value == null) return out;
  switch (s.kind) {
    case "link":
      link(value, path);
      break;
    case "cta":
      if (isObj(value)) link(value.link, `${path}.link`);
      break;
    case "image":
      if (isObj(value) && typeof value.media === "string" && value.media) out.push({ field: `${path}.media`, ref: "media", src: value.media });
      break;
    case "collection":
    case "product":
      ref(s.kind, value, path);
      break;
    case "collection_list":
    case "product_list":
      if (Array.isArray(value)) value.forEach((v, j) => ref(s.kind === "collection_list" ? "collection" : "product", v, `${path}.${j}`));
      break;
    case "nav_items":
      if (Array.isArray(value))
        value.forEach((it, j) => {
          if (!isObj(it)) return;
          link(it.link, `${path}.${j}.link`);
          if (Array.isArray(it.children)) it.children.forEach((c, k) => isObj(c) && link(c.link, `${path}.${j}.children.${k}.link`));
        });
      break;
    default:
      break;
  }
  return out;
}
