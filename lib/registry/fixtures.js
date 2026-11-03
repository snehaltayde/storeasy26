// P2-REG (DOC-03): worst-case fixtures for every section kind, for the
// rendered checks of P2-SECTIONS and the 375/768/1440 drills of P2-DRILLS.
// Pure, deterministic and edge-safe.
//
//   worstCase(kind) -> { kind, cases: [{ name, section, data }] }
//     Cases, each where the kind can have it:
//       long_text    every text at its limit (a 120-character title where the
//                    title allows 120; the declared max where it is lower, so
//                    the fixture stays valid), long product and collection names
//       no_image     the image left empty (shows the token-coloured fallback)
//       tall_image   a 600 x 2400 image
//       one_item     a list or catalog binding with one item
//       max_items    a list or binding at its maximum
//       sold_out     every bound product sold out
//     `section` is a full section (id, kind, v, settings…). `data` is the
//     catalog data a renderer would get for the section's bindings, with
//     `soldOut` markers on products.
//   fixtureDocument(type, sections)  a document body holding these sections,
//                                    with the type's protected module placed
//                                    within maxBeforeProtected
//   WORST_CASE_ASSETS                the image paths the fixtures use and their
//                                    sizes, for a drill to serve
//   LEGACY_HERO_FIXTURES             old-shape hero payloads, as the four bypass
//                                    writers store them today (DOC-02)
import { sectionType, newSection, emptyBody, protectedKinds, documentType } from "./index.js";

export const WORST_CASE_ASSETS = Object.freeze({
  "/api/media/worst-case-wide.jpg": { width: 2400, height: 1200 },
  "/api/media/worst-case-tall.jpg": { width: 600, height: 2400 },
});
const WIDE = "/api/media/worst-case-wide.jpg";
const TALL = "/api/media/worst-case-tall.jpg";

const WORDS = "Extraordinarily comprehensive handcrafted everyday essentials collection with internationally sourced materials and accessories".split(" ");
// Text of exactly n characters, made of real-length words, so wrapping behaves
// like real copy and never like one unbreakable string.
export function longText(n) {
  let out = "";
  for (let i = 0; out.length < n; i++) out += (out ? " " : "") + WORDS[i % WORDS.length];
  return out.slice(0, n).trimEnd().padEnd(n, "x");
}

const LONG_HANDLE = "worst-case-collection-with-a-really-long-handle";
const textAt = (s) => longText(Math.min(120, s.max ?? 120));
const listMax = (s) => s.max ?? 1;

function fill(s, { items = 1, image = WIDE } = {}) {
  switch (s.kind) {
    case "text":
      return textAt(s);
    case "number":
      return s.max ?? s.default ?? 1;
    case "boolean":
      return true;
    case "choice":
      return s.default ?? s.options[0];
    case "rich_text":
      return `<h2>${longText(80)}</h2><p>${longText(600)}</p>`;
    case "paragraphs":
      return Array.from({ length: items }, () => longText(Math.min(600, s.maxEach ?? 600)));
    case "qa_list":
      return Array.from({ length: items }, () => ({ q: longText(140), a: `<p>${longText(400)}</p>` }));
    case "link":
      return { type: "collection", handle: LONG_HANDLE };
    case "cta":
      return { label: longText(40), link: { type: "collection", handle: LONG_HANDLE } };
    case "image":
      return image ? { media: image, alt: longText(120) } : null;
    case "collection":
      return { handle: LONG_HANDLE, id: "gid://shopify/Collection/1" };
    case "product":
      return { handle: "worst-case-product", id: "gid://shopify/Product/1" };
    case "collection_list":
      return Array.from({ length: items }, (_, j) => ({ handle: `${LONG_HANDLE}-${j}` }));
    case "product_list":
      return Array.from({ length: items }, (_, j) => ({ handle: `worst-case-product-${j}` }));
    case "nav_items":
      return Array.from({ length: items }, () => ({ label: longText(40), link: { type: "collection", handle: LONG_HANDLE } }));
    default:
      return s.default ?? null;
  }
}

const isList = (s) => ["paragraphs", "qa_list", "collection_list", "product_list", "nav_items"].includes(s.kind);

function catalog(d, n, soldOut) {
  const data = {};
  for (const [key, b] of Object.entries(d.bindings)) {
    if (key === "collections") {
      data[key] = Array.from({ length: n }, (_, j) => ({ handle: `${LONG_HANDLE}-${j}`, title: longText(90), image: j % 2 ? null : WIDE }));
    } else if (key === "products" || key === "product") {
      const products = Array.from({ length: n }, (_, j) => ({
        handle: `worst-case-product-${j}`,
        title: longText(150),
        price: "₹12,49,999.00",
        compareAt: "₹15,99,999.00",
        image: j % 3 === 2 ? null : j % 3 === 1 ? TALL : WIDE,
        soldOut: soldOut || j === n - 1,
      }));
      data[key] = key === "product" ? products[0] : products;
    } else data[key] = { sources: b.sources };
  }
  return data;
}

export function worstCase(kind) {
  const d = sectionType(kind);
  if (!d) throw new Error(`worstCase: "${kind}" is not a registered section kind`);
  const limit = d.settings.find((s) => s.kind === "number" && s.key === "limit");
  const hasImage = d.settings.some((s) => s.kind === "image");
  const lists = d.settings.filter(isList);
  const bound = Object.keys(d.bindings).length > 0;
  const listBound = Object.keys(d.bindings).some((k) => k === "products" || k === "collections");
  const productsBound = Object.keys(d.bindings).some((k) => k === "products" || k === "product");

  const make = (name, { image = WIDE, items = 1, limitTo, soldOut = false, dataItems = 4 } = {}) => {
    const section = newSection(kind, { id: `sec_wc${name.replace(/_/g, "")}`.slice(0, 20) });
    for (const s of d.settings) {
      section.settings[s.key] = s.kind === "image" ? fill(s, { image }) : fill(s, { items: isList(s) ? (items === "max" ? listMax(s) : items) : 1 });
    }
    if (limit && limitTo != null) section.settings.limit = limitTo;
    return { name, section, data: bound ? catalog(d, dataItems, soldOut) : {} };
  };

  const cases = [make("long_text", { dataItems: limit ? Math.min(limit.max, 6) : 4 })];
  if (hasImage) cases.push(make("no_image", { image: null }), make("tall_image", { image: TALL }));
  if (lists.length || listBound) {
    cases.push(make("one_item", { items: 1, limitTo: 1, dataItems: 1 }));
    cases.push(make("max_items", { items: "max", limitTo: limit?.max, dataItems: limit?.max ?? 1 }));
  }
  if (productsBound) cases.push(make("sold_out", { soldOut: true, dataItems: limit ? Math.min(limit.max, 6) : 1 }));
  return { kind, cases };
}

// A body of `type` holding `sections`, valid around them: a route document gets
// an address and title, and the protected module sits within
// maxBeforeProtected.
export function fixtureDocument(type, sections) {
  const t = documentType(type);
  if (!t) throw new Error(`fixtureDocument: "${type}" is not a registered document type`);
  const body = emptyBody(type);
  if (t.route) Object.assign(body.meta, { slug: "worst-case", title: "Worst case" });
  const own = sections.filter((s) => !sectionType(s?.kind)?.protected);
  const given = sections.filter((s) => sectionType(s?.kind)?.protected);
  const prot = given.length ? given : body.sections.filter((s) => protectedKinds(type).includes(s.kind));
  const before = t.maxBeforeProtected ?? own.length;
  body.sections = prot.length ? [...own.slice(0, before), ...prot, ...own.slice(before)] : own;
  return body;
}

// Old-shape hero payloads, as each bypass writer stores them today.
export const LEGACY_HERO_FIXTURES = Object.freeze({
  // lib/experiments.js cleanVariantPayload: title, highlight, subtitle, and a
  // button only when both label and a /path href were given
  experiment_variant: { title: "Made for every single day.", highlight: "every", subtitle: "Small batches that ship fast.", primary: { label: "Shop the sale", href: "/collections/sale" } },
  // lib/ai/insights.js validateProposals: { title, highlight, subtitle } only
  ai_proposal: { title: "Gifts they will actually use", highlight: "actually", subtitle: "Twelve picks under one price." },
  // lib/platform/agency.js: the hero as exported from the source store, whole
  agency_kit: {
    title: "Your glow, daily.",
    highlight: "glow",
    subtitle: "Skincare and self-care rituals, picked with love.",
    primary: { label: "Shop the edit", href: "/collections" },
    secondary: { label: "What’s new", href: "#new" },
    badge: "New season",
  },
});
