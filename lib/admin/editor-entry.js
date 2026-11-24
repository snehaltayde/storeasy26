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
//
// P4-SCAFFOLD (plan section 4, the URL contract): the only builder and parser
// of the editor's product and collection addresses.
//   entityEditorHref({ product })     "/admin/editor?product=<gid>" (encoded)
//   entityEditorHref({ collection })  "/admin/editor?collection=<gid>"
//     anything else (none, both, a value that is not a Shopify id of that
//     kind) gives "/admin/editor"
//   parseEditorTarget(searchParams)   { doc } | { product } | { collection } | {}
//     searchParams: a URLSearchParams or Next's plain searchParams object
//     (string or string[] values). The first key present wins, in the order
//     doc, product, collection; when its value is bad the answer is {}, never
//     a fall-through to the next key.
//
// /admin/catalog (Phase 1 line 10: the only old console address left):
//   catalogHref(query)    ?product= / ?collection= -> that entity, else the
//                         editor's Products list (PRODUCTS_LIST_HREF)
//   EDITOR_LISTS, PRODUCTS_LIST_HREF, EDITOR_PUBLISH_HREF  the editor
//                         destinations the catalog and onboarding pages use
import { livePath } from "../documents/paths.js";
import { documentType } from "../registry/index.js";

export const EDITOR_PATH = "/admin/editor";
export const HOME_ID = "doc_home";

export const editorHref = (docId) => (typeof docId === "string" && docId ? `${EDITOR_PATH}?doc=${encodeURIComponent(docId)}` : EDITOR_PATH);

// A Shopify gid of one kind. Real ids are numeric; tests and fixtures also use
// short words ("gid://shopify/Product/orphan"), so the last part is any run of
// URL-safe characters. Spaces, slashes, "?", "#" and long values are junk.
const GID_TAIL = "[A-Za-z0-9._~-]{1,64}";
const PRODUCT_GID = new RegExp(`^gid://shopify/Product/${GID_TAIL}$`);
const COLLECTION_GID = new RegExp(`^gid://shopify/Collection/${GID_TAIL}$`);
// Document ids: doc_<type>, doc_<16 base32>, doc_p_/doc_prod_/doc_coll_<16 hex>.
const DOC_ID = /^doc_[a-z0-9_]{1,80}$/;

export const isProductGid = (v) => typeof v === "string" && PRODUCT_GID.test(v);
export const isCollectionGid = (v) => typeof v === "string" && COLLECTION_GID.test(v);

export function entityEditorHref(target) {
  const tgt = target !== null && typeof target === "object" && !Array.isArray(target) ? target : {};
  const hasP = tgt.product != null;
  const hasC = tgt.collection != null;
  if (hasP && !hasC && isProductGid(tgt.product)) return `${EDITOR_PATH}?product=${encodeURIComponent(tgt.product)}`;
  if (hasC && !hasP && isCollectionGid(tgt.collection)) return `${EDITOR_PATH}?collection=${encodeURIComponent(tgt.collection)}`;
  return EDITOR_PATH;
}

const TARGET_KEYS = [
  ["doc", (v) => DOC_ID.test(v)],
  ["product", isProductGid],
  ["collection", isCollectionGid],
];

function paramOf(sp, key) {
  if (sp == null || typeof sp !== "object") return undefined;
  if (typeof sp.has === "function" && typeof sp.get === "function") return sp.has(key) ? sp.get(key) : undefined;
  if (!Object.prototype.hasOwnProperty.call(sp, key)) return undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parseEditorTarget(searchParams) {
  for (const [key, valid] of TARGET_KEYS) {
    const v = paramOf(searchParams, key);
    if (v === undefined) continue;
    return typeof v === "string" && valid(v) ? { [key]: v } : {};
  }
  return {};
}

// The editor's lists. The switcher (P4-EDITOR) holds a Products and a Pages
// section; `list` names the one to show. An editor that doesn't read `list`
// opens on home with its switcher, which lists both: never a dead end.
export const EDITOR_LISTS = Object.freeze({ products: `${EDITOR_PATH}?list=products`, pages: `${EDITOR_PATH}?list=pages` });
export const PRODUCTS_LIST_HREF = EDITOR_LISTS.products;
// Publish lives in the editor, on each document; the launch step opens home.
export const EDITOR_PUBLISH_HREF = editorHref(HOME_ID);

const one = (q, key) => {
  if (q == null || typeof q !== "object") return undefined;
  if (typeof q.get === "function") return q.get(key) ?? undefined;
  return Object.prototype.hasOwnProperty.call(q, key) ? first(q[key]) : undefined;
};

// /admin/catalog. ?product=<gid> (and ?collection=<gid>) open that product
// (collection) in the editor; anything else is the editor's Products list. A junk id is the Products list, never an error.
export function catalogHref(query) {
  const product = one(query, "product");
  if (isProductGid(product)) return entityEditorHref({ product });
  const collection = one(query, "collection");
  if (isCollectionGid(collection)) return entityEditorHref({ collection });
  return PRODUCTS_LIST_HREF;
}

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
