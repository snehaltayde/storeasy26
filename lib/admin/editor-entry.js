// P3-ROUTES (ED-02, PUB-11): which document the new editor opens.
// Pure: no database, no request, no node: imports. The editor page reads the
// store's documents once and hands them in.
//
//   editorEntry({ doc, path }, documents)
//     ?doc=<id>       that document
//     ?path=<path>    the document that lives at that store address: the
//                     reverse of livePath() in lib/documents/paths.js
//     neither         the home page (ED-02: entering the editor opens home)
//     anything it can't place (an id that isn't there, an address with no
//     page behind it) opens the home page, with a note that says so.
//     P3-FIX3: a store address built from the store's data is never called
//     "nothing": /products/<x> opens the product page layout and
//     /collections/<x> the collection page layout (each with a note that
//     says every such page uses it), /collections the collections page, and
//     the other store routes (/journal, /campaigns, /search, /cart, /checkout,
//     …: STORE_ROUTES) open home with NOTES.storeData.
//   -> { document: { id, type, label, slug }, note: string | null }
//
//   documents: rows like listDocuments() returns ({ id, type, slug, label }).
//   A singleton (home, header, design, …) opens even before its row exists,
//   because the store already shows its code default.
//
//   editorHref(docId)  "/admin/editor?doc=<id>", or "/admin/editor" for none
//   LEGACY_ROUTE_DOCS  where each old console screen sends a documents store
import { livePath } from "../documents/paths.js";
import { documentType } from "../registry/index.js";

export const EDITOR_PATH = "/admin/editor";
export const HOME_ID = "doc_home";

export const editorHref = (docId) => (typeof docId === "string" && docId ? `${EDITOR_PATH}?doc=${encodeURIComponent(docId)}` : EDITOR_PATH);

// The old content, brand and theme screens, and the document each one edited.
// A documents store is sent to the new editor at that document (plan
// decision 11). The Designer is never reached on a documents store.
export const LEGACY_ROUTE_DOCS = Object.freeze({
  "/admin/storefront": HOME_ID,
  "/admin/storefront/designer": HOME_ID,
  "/admin/storefront/home": HOME_ID,
  "/admin/storefront/navigation": "doc_header",
  // the list of pages has no document of its own; the editor's switcher
  // (P3-EDITOR) lists them, and it opens on home
  "/admin/storefront/pages": HOME_ID,
  "/admin/storefront/product-pages": "doc_product_layout",
  "/admin/brand": "doc_design",
  "/admin/theme": "doc_design",
});

export const NOTES = Object.freeze({
  missingDoc: "We couldn't find that page, so the editor opened your home page. It may have been deleted.",
  unknownPath: (path) => `Nothing on your store lives at ${String(path).slice(0, 120)} yet, so the editor opened your home page.`,
  storeData: "This page is built from your store's data, so the editor opened your home page.",
  productLayout: "Every product page uses this layout, so a change here shows on all of them.",
  collectionLayout: "Every collection page uses this layout, so a change here shows on all of them.",
});

// P3-FIX3: the storefront's own routes (app/(storefront)/<route>, plus /cart),
// whose pages come from the store's data, not from a document of their own.
// The test checks this list against the app's folders.
export const STORE_ROUTES = Object.freeze(
  new Set(["account", "bundles", "campaigns", "cart", "checkout", "collections", "customers", "integrations", "journal", "legal", "offline", "orders", "policies", "pricing", "products", "quiz", "search", "templates", "trust", "verticals", "wishlist", "about", "contact"]),
);
// One path segment after the route: a product or a collection.
const LAYOUT_ROUTES = [
  ["/products/", "doc_product_layout", "productLayout"],
  ["/collections/", "doc_collection_layout", "collectionLayout"],
];

// Route prefixes, the reverse of livePath's. "/policies/about" also places
// the about page (livePath gives "/about", the storefront serves both).
const ROUTES = [
  ["/policies/", "page"],
  ["/campaigns/", "campaign"],
  ["/journal/", "journal"],
];
const OWN_ROUTE = new Set(["about", "contact"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const first = (v) => (Array.isArray(v) ? v[0] : v);

// "/campaigns/spring-edit?x=1#top" -> "/campaigns/spring-edit". Only a plain
// path on this store; anything else is null.
export function cleanPath(raw) {
  const s = first(raw);
  if (typeof s !== "string") return null;
  let p = s.trim().split("#")[0].split("?")[0];
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";
  return p;
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

// The type and slug a store path names, or null when it names no document.
// "/" is home. The address is not checked against any list here.
export function placePath(path) {
  const p = cleanPath(path);
  if (p == null) return null;
  if (p === "/") return { type: "home", slug: null };
  for (const [prefix, type] of ROUTES) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest || rest.includes("/")) return null;
    const slug = decode(rest);
    return slug ? { type, slug } : null;
  }
  const own = p.slice(1);
  if (OWN_ROUTE.has(own)) return { type: "page", slug: own };
  return null;
}

function singletonEntry(id) {
  const m = /^doc_([a-z][a-z0-9_]*)$/.exec(id);
  const t = m && documentType(m[1]);
  return t && t.singleton ? { id, type: t.type, label: t.label, slug: null } : null;
}

const asEntry = (d) => ({ id: String(d.id), type: String(d.type), label: String(d.label ?? ""), slug: d.slug == null ? null : String(d.slug) });

function homeEntry(documents) {
  const row = documents.find((d) => d.id === HOME_ID);
  return row ? asEntry(row) : singletonEntry(HOME_ID);
}

export function editorEntry(query, documents) {
  const q = isObj(query) ? query : {};
  const docs = (Array.isArray(documents) ? documents : []).filter((d) => isObj(d) && typeof d.id === "string");
  const home = homeEntry(docs);
  const doc = first(q.doc);
  if (typeof doc === "string" && doc) {
    const row = docs.find((d) => d.id === doc);
    if (row) return { document: asEntry(row), note: null };
    const single = singletonEntry(doc);
    if (single) return { document: single, note: null };
    return { document: home, note: NOTES.missingDoc };
  }
  const rawPath = first(q.path);
  if (typeof rawPath === "string" && rawPath) {
    const shown = cleanPath(rawPath) ?? "that address";
    const place = placePath(rawPath);
    if (place?.type === "home") return { document: home, note: null };
    if (place) {
      // the same address livePath gives the row; never a guess across types
      const want = livePath(place.type, { slug: place.slug });
      const row = docs.find((d) => d.type === place.type && d.slug != null && livePath(d.type, { slug: d.slug }) === want);
      if (row) return { document: asEntry(row), note: null };
    }
    const p = cleanPath(rawPath);
    if (p != null) {
      for (const [prefix, id, note] of LAYOUT_ROUTES) {
        const rest = p.startsWith(prefix) ? p.slice(prefix.length) : "";
        if (rest && !rest.includes("/")) return { document: docs.find((d) => d.id === id) ? asEntry(docs.find((d) => d.id === id)) : singletonEntry(id), note: NOTES[note] };
      }
      if (p === "/collections") {
        const row = docs.find((d) => d.id === "doc_collections_index");
        return { document: row ? asEntry(row) : singletonEntry("doc_collections_index"), note: null };
      }
      // a store route with no document of its own. A page, campaign or post
      // that isn't there (/campaigns/<missing>, /policies/a/b) is "nothing";
      // their index pages (/campaigns, /journal) and /about and /contact
      // (the store's own words until a page is made) are not.
      const route = p.split("/")[1];
      const docRoute = ROUTES.some(([prefix]) => prefix === `/${route}/`);
      const neutral = place ? OWN_ROUTE.has(route) : STORE_ROUTES.has(route) && (!docRoute || p === `/${route}`);
      if (neutral) return { document: home, note: NOTES.storeData };
    }
    return { document: home, note: NOTES.unknownPath(shown) };
  }
  return { document: home, note: null };
}
