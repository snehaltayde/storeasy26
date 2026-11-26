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
// and only when sanitizing loses none of the founder's words or addresses
// (P6-LOGO-REG: and trimming the spaces around a logo description).
//
// Links are typed (spec 8.5):
//   { type: "url", href }                         a storefront path or #anchor
//   { type: "collection", handle, id? }           /collections/<handle>
//   { type: "product", handle, id? }              /products/<handle>
//   { type: "page", slug, family, document? }     /policies|/campaigns|/journal/<slug>
// (P5-SETTING) A bundle is chosen by id, never by link: { id } (kind bundle)
// or [{ id }] (kind bundle_list).
// A link that is not a storefront route (another site, /admin, //host, a path
// with "..") is LINK_NOT_STOREFRONT.
import { validateBrand, BRAND_TOKEN_KEYS, KIT_SURFACES } from "../brand.js";
import { sanitize, lostBySanitizing, isBlank, isBlankHtml } from "./text.js";
import { PACKAGE_ID_RE } from "../themes/package-format.js";

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
  /^\/(?:$|[?#]|collections(?:$|[/?#])|products\/[^/?#]|search(?:$|[?#])|about(?:$|[?#])|contact(?:$|[?#])|policies\/[^/?#]|campaigns\/[^/?#]|orders\/[^/?#]|cart(?:$|[?#])|journal(?:$|[/?#])|quiz\/[^/?#]|bundles\/[^/?#]|wishlist(?:$|[?#])|account(?:$|[/?#])|reviews\/(?:write|optout)(?:$|[?#]))/;
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
  heading_font: "The heading font isn't one of the choices. Pick Sans or Serif.",
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
      unknownKeys(v, [...BRAND_TOKEN_KEYS, "accent_label"], path, "the brand", report);
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
      // Phase 5: an uploaded theme package rides on its base kit (`package`, thm_ + 16 hex)
      unknownKeys(v, ["kit", "version", "applied_at", "package"], path, "the theme", report);
      if (!KIT_SURFACES[`${v.kit}-${v.version}`]) report(path, "THEME_INVALID", `There's no look called ${shown(`${v.kit} ${v.version}`)}. Choose a look again.`, "invalid");
      if (v.package != null && (typeof v.package !== "string" || !PACKAGE_ID_RE.test(v.package))) report(`${path}.package`, "THEME_INVALID", "Your uploaded theme couldn't be found. Choose it again.", "invalid");
      return v;
    },
  },
  // P6-LOGO-REG (GEN-04, TOK-03, MED-03): the store's picture logo, on the
  // design document. null (no picture: the text wordmark shows) or
  //   { media, alt? }
  // media  a file of the store's own library, exactly /api/media/<id>: no
  //        other site's address, no other path, no query string
  // alt    optional words for screen readers, at most 120 characters once
  //        trimmed (stored trimmed). Missing or empty is never incomplete and
  //        never an error, in a draft or at publish: the storefront then says
  //        the store's name (P6-LOGO-RENDER).
  // The control is the brand step at /admin/onboarding?step=brand; the editor's inspector has
  // no logo control yet (it is one of test-editor-inspector's waiting kinds).
  logo: {
    control: "logo",
    empty: emptyNull,
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", "Your logo couldn't be read. Choose it again.", "structure");
        return v;
      }
      unknownKeys(v, ["media", "alt"], path, "the logo", report);
      if (typeof v.media !== "string") report(`${path}.media`, "INVALID_VALUE", "Your logo couldn't be read. Choose it again.", "structure");
      else if (!LOGO_MEDIA_RE.test(v.media)) report(`${path}.media`, "LOGO_INVALID", "Your logo must be a picture from your own library. Upload it again.", "invalid");
      if (v.alt == null) return v;
      if (typeof v.alt !== "string") {
        report(`${path}.alt`, "INVALID_VALUE", "The logo description must be text.", "structure");
        return v;
      }
      const alt = v.alt.trim();
      if (alt.length > LOGO_ALT_MAX) report(`${path}.alt`, "TOO_LONG", `The logo description is too long (${alt.length} characters, the limit is ${LOGO_ALT_MAX}).`, "invalid");
      return alt === v.alt ? v : { ...v, alt };
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
  // P4-LIVEROW (OVL-01, MED-03): an ordered list of product images,
  // [{ media, alt }]. media is a secure address (https or a path on the
  // store); which hosts may go live is the publish rule of the document type
  // (galleryMediaAllowed, the OVL-13 allowlist), so a draft can still hold a
  // pasted address while the founder fixes it.
  gallery: {
    control: "gallery",
    empty: emptyNull,
    check(v, s, path, report) {
      if (!checkList(v, s, path, report, "image")) return v;
      if (!v.length) report(path, "GALLERY_EMPTY", "There are no images in this list. Add at least one, or choose Use Shopify's images.", "invalid");
      v.forEach((it, j) => {
        const at = `${path}.${j}`;
        if (!isObj(it)) {
          report(at, "INVALID_VALUE", "This image couldn't be read. Remove it and add it again.", "structure");
          return;
        }
        unknownKeys(it, ["media", "alt"], at, "an image", report);
        if (typeof it.media !== "string" || isBlank(it.media)) report(`${at}.media`, "INVALID_VALUE", "This image couldn't be read. Choose it again.", "structure");
        else if (!/^(https:\/\/|\/(?!\/))/.test(it.media) || /\s/.test(it.media))
          report(`${at}.media`, "IMAGE_INVALID", "This image link isn't secure. Use a link that starts with https, or choose an image from your library.", "invalid");
        else if (it.media.length > 1000) report(`${at}.media`, "TOO_LONG", `The image link is too long (${it.media.length} characters, the limit is 1000).`, "invalid");
        if (it.alt != null) checkText(it.alt, s, `${at}.alt`, report, { max: 512, softMax: null, label: "alt text" });
      });
      return v;
    },
  },
  // P4-LIVEROW (ED-12): products shown with this one, { title, products: [ids] }
  // (Shopify product ids, in order).
  pairs: {
    control: "pairs",
    empty: (v) => v == null || (isObj(v) && Array.isArray(v.products) && v.products.length === 0 && (v.title == null || (typeof v.title === "string" && isBlank(v.title)))),
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Choose the products again.`, "structure");
        return v;
      }
      unknownKeys(v, ["title", "products"], path, "the products shown with this one", report);
      if (v.title != null) checkText(v.title, s, `${path}.title`, report, { max: 80, softMax: null, label: "title" });
      checkIdList(v.products, { ...s, label: s.label }, `${path}.products`, report);
      return v;
    },
  },
  // P4-LIVEROW (ED-12): an ordered list of Shopify product ids.
  product_ids: {
    control: "product_ids",
    empty: (v) => v == null || (Array.isArray(v) && v.length === 0),
    check(v, s, path, report) {
      checkIdList(v, s, path, report);
      return v;
    },
  },
  // P4-LIVEROW (OVL-01, OVL-04): a value that follows Shopify until the
  // founder changes it. null follows Shopify; otherwise
  //   { value, base_hash, base_value }
  // value       the founder's value, checked as the declared `of` kind
  // base_value  what Shopify sent when the founder first changed it (the
  //             service sets it; never checked here, it is Shopify's)
  // base_hash   the hash of that value (image addresses without their query)
  overlay: {
    control: "overlay",
    empty: (v) => v == null || (isObj(v) && v.value == null),
    check(v, s, path, report) {
      if (!isObj(v)) {
        report(path, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Reload the page and try again.`, "structure");
        return v;
      }
      unknownKeys(v, ["value", "base_hash", "base_value"], path, `the ${lower(s.label)}`, report);
      if (v.base_hash != null && typeof v.base_hash !== "string") report(`${path}.base_hash`, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Reload the page and try again.`, "structure");
      if (v.value == null) return v;
      if (s.nonEmpty && typeof v.value === "string" && isBlank(v.value)) {
        report(`${path}.value`, "TITLE_EMPTY", `A product needs a ${lower(s.label)}. Type one, or choose Use Shopify's to follow Shopify again.`, "structure");
        return v;
      }
      const inner = own(SETTING_KINDS, s.of);
      const value = inner.check(v.value, s, `${path}.value`, report);
      return value === v.value ? v : { ...v, value };
    },
  },
  // P5-SETTING (COM-01, COM-02, TREE-01): one bundle, chosen by its id:
  // { id } or null. The body holds the id only: never a title, price or
  // stock, which are read live when the section renders (P5-SOURCES
  // bundle_by_id). Any other key is UNKNOWN_FIELD (structure).
  bundle: {
    control: "bundle",
    empty: emptyNull,
    check(v, s, path, report) {
      checkBundleChoice(v, path, report, "The bundle couldn't be read. Choose the bundle again.");
      return v;
    },
  },
  // P5-SETTING: the bundles of a grid, in order: [{ id }], at most the
  // setting's max (BUNDLE_LIST_MAX when it declares none), no bundle twice.
  bundle_list: {
    control: "bundle_list",
    empty: (v) => v == null || (Array.isArray(v) && v.length === 0),
    check(v, s, path, report) {
      if (!Array.isArray(v)) {
        report(path, "INVALID_VALUE", `The ${lower(s.label)} couldn't be read. Reload the page and try again.`, "structure");
        return v;
      }
      const max = s.max ?? BUNDLE_LIST_MAX;
      if (v.length > max) report(path, "INVALID_VALUE", `A grid shows at most ${max} bundles.`, "invalid");
      const seen = new Set();
      v.forEach((item, j) => {
        const at = `${path}.${j}`;
        if (!checkBundleChoice(item, at, report, "A bundle in this grid couldn't be read. Remove it and pick it again.")) return;
        if (seen.has(item.id)) report(at, "INVALID_VALUE", "This bundle is already in the grid.", "invalid");
        else seen.add(item.id);
      });
      return v;
    },
  },
});

// P6-LOGO-REG: a logo is a library file, by its exact path (the media id
// shape of lib/documents/refs.js), and its description's limit.
export const LOGO_MEDIA_RE = /^\/api\/media\/[A-Za-z0-9_-]{1,120}$/;
export const LOGO_ALT_MAX = 120;

// P5-SETTING: a bundle id as lib/bundles.js makes it (bun-<hex>) and as older
// rows hold it (bnd_p1c).
export const BUNDLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const BUNDLE_LIST_MAX = 12;

// One { id } bundle choice. true when the id can be used.
function checkBundleChoice(v, path, report, unreadable) {
  if (!isObj(v)) {
    report(path, "INVALID_VALUE", unreadable, "structure");
    return false;
  }
  unknownKeys(v, ["id"], path, "a bundle choice", report);
  if (typeof v.id !== "string" || !BUNDLE_ID_RE.test(v.id)) {
    report(`${path}.id`, "INVALID_VALUE", unreadable, "structure");
    return false;
  }
  return true;
}

// A list of Shopify ids: strings, no repeats, at most s.max.
function checkIdList(v, s, path, report) {
  if (!checkList(v, s, path, report, "product")) return;
  const seen = new Set();
  v.forEach((id, j) => {
    if (typeof id !== "string" || !id || id.length > 120) report(`${path}.${j}`, "INVALID_VALUE", "A product in this list couldn't be read. Choose it again.", "structure");
    else if (seen.has(id)) report(`${path}.${j}`, "DUPLICATE", "This product is in the list twice. Remove one.", "invalid");
    else seen.add(id);
  });
}

// P4-LIVEROW (OVL-13, pulled forward with OVL-01 and MED-03): the only image
// addresses a product gallery may put live: Shopify's own image host, and a
// file of the store's own library (/api/media/<id>).
export const GALLERY_HOSTS = Object.freeze(["cdn.shopify.com", "/api/media/<id>"]);
export function galleryMediaAllowed(src) {
  if (typeof src !== "string") return false;
  if (/^\/api\/media\/[A-Za-z0-9_-]{1,80}(?:[?#].*)?$/.test(src)) return true;
  try {
    const u = new URL(src);
    return u.protocol === "https:" && u.hostname === "cdn.shopify.com" && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

// ---- declaring and checking ------------------------------------------------------

const labelOf = (key) => cap(key.replace(/_/g, " "));

// A setting declaration, checked and frozen. Throws on a broken declaration:
// that is a bug in code, found when the module loads.
export function defineSetting(s, where) {
  if (!isObj(s) || typeof s.key !== "string" || !KEY_RE.test(s.key)) throw new Error(`${where}: a setting needs a key of lower-case letters, digits and _`);
  if (!own(SETTING_KINDS, s.kind)) throw new Error(`${where}: setting "${s.key}" has an unknown kind "${s.kind}"`);
  if (s.kind === "choice" && (!Array.isArray(s.options) || !s.options.length)) throw new Error(`${where}: choice setting "${s.key}" needs options`);
  if (s.kind === "overlay" && (!own(SETTING_KINDS, s.of) || s.of === "overlay")) throw new Error(`${where}: overlay setting "${s.key}" needs an "of" kind`);
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
  for (const n of ["max", "softMax", "min", "maxEach", "placeholder", "help", "of"]) if (s[n] != null) c[n] = s[n];
  if (s.options) c.options = [...s.options];
  if (s.default !== undefined) c.default = s.default;
  return c;
}

// P4-MEDIA (MED-03): the images and links written inside text: every
// <img src> as a media ref and every <a href> as a url link ref (marked
// inText: true), in the order they appear. Pure: a tag scan, no DOM. The
// value is read as the sanitizer leaves it (lib/registry/text.js), and
// attribute quotes may be double, single or missing. Entities in the value
// (&amp;, &quot;, &#39;, &#47;) are decoded first.
const TEXT_TAG = /<(img|a)\b([^>]*)>/gi;
const ATTR_OF = { img: /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i, a: /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i };
const decodeAttr = (v) =>
  v
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#0*47;|&#x0*2f;/gi, "/")
    .replace(/&amp;/gi, "&");
export function refsOfText(html, field) {
  const out = [];
  if (typeof html !== "string" || !html.includes("<")) return out;
  for (const m of html.matchAll(TEXT_TAG)) {
    const tag = m[1].toLowerCase();
    const a = ATTR_OF[tag].exec(m[2]);
    if (!a) continue;
    const v = decodeAttr(String(a[1] ?? a[2] ?? a[3] ?? "").trim());
    if (!v) continue;
    if (tag === "img") out.push({ field, ref: "media", src: v, inText: true });
    else out.push({ field, ref: "link", type: "url", href: v, inText: true });
  }
  return out;
}

// The references and media a setting's value holds, for the media scan, link
// healing and publish checks.
//
// P4-MEDIA (MED-03): with { text: true } it also gives the images and links
// written inside rich text, FAQ answers and paragraphs (refsOfText). Off by
// default, so the publish checks (lib/documents/checks.js) and every other
// caller see exactly what they saw before; lib/documents/refs.js asks for
// them, so the reference index holds them.
export function refsOfSetting(s, value, path = s.key, { text = false } = {}) {
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
    // P6-LOGO-REG (MED-03): the logo file, so document_refs holds it, the
    // publish checks see it (MEDIA_MISSING) and a used file can't be deleted
    case "logo":
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
    case "rich_text":
      if (text) out.push(...refsOfText(value, path));
      break;
    case "paragraphs":
      if (text && Array.isArray(value)) value.forEach((p, j) => out.push(...refsOfText(p, `${path}.${j}`)));
      break;
    case "qa_list":
      if (text && Array.isArray(value)) value.forEach((it, j) => isObj(it) && out.push(...refsOfText(it.a, `${path}.${j}.a`)));
      break;
    // P4-LIVEROW (MED-03): every gallery image is a media ref
    case "gallery":
      if (Array.isArray(value)) value.forEach((it, j) => isObj(it) && typeof it.media === "string" && it.media && out.push({ field: `${path}.${j}.media`, ref: "media", src: it.media }));
      break;
    // P5-SETTING: a bundle by its id (document_refs ref_type 'bundle')
    case "bundle":
      if (isObj(value) && typeof value.id === "string" && value.id) out.push({ field: path, ref: "bundle", id: value.id });
      break;
    case "bundle_list":
      if (Array.isArray(value)) value.forEach((v, j) => isObj(v) && typeof v.id === "string" && v.id && out.push({ field: `${path}.${j}`, ref: "bundle", id: v.id }));
      break;
    // the founder's value, as its own kind; Shopify's base_value is not ours
    case "overlay":
      if (isObj(value) && value.value != null && own(SETTING_KINDS, s.of)) out.push(...refsOfSetting({ ...s, kind: s.of }, value.value, `${path}.value`, { text }));
      break;
    default:
      break;
  }
  return out;
}
