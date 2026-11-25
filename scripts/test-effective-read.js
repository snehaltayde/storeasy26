// P4-EFFECTIVE (OVL-03, OVL-05, OVL-06, SHOP-02): the one effective read of
// product content, lib/catalog/effective.js, and every shopper reader on it.
//   pnpm test:effective-read
//
// Local file databases only (scripts/support/tenant-fixture.js). No network,
// no Typesense, nothing sent to Shopify.
//
//   1. The guard: on a shopper path only effective.js selects product content
//      columns from products or product_images; the allowlist is exactly five
//      statements, each with its reason; planted reads fail it.
//   2. A store with no published content reads exactly as before this change
//      (a snapshot recorded at 17a08b7), on the newest schema and at 0023.
//   3. A published title 'New' shows everywhere a shopper sees a title.
//   4. A published description_html feeds the page, the meta and JSON-LD.
//   5. A display type or vendor shows, and never changes offers or filters.
//   6. Orders freeze the effective title and Shopify's title, gifts included.
//   7. No cart reaching a browser carries Shopify's title or the SKU.
//   8. A draft never reaches the cart, search, the sitemap or an email.
//   9. Images and alt, empty strings, and indexRows.
//  10. Edge safety and statement counts.
import { MARKET_STUBS } from "./support/market-stubs.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { createRequire, registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
process.chdir(ROOT);
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-effr-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
process.env.TYPESENSE_HOST = "";
process.env.TYPESENSE_ADMIN_API_KEY = "";
delete process.env.CHECKOUT_MODE;

// Plain Node can't resolve "@/…" or next/headers; after() only collects; the
// request headers and cookies come from one global, one simulated request at a time.
globalThis.__effAfter = [];
globalThis.__effRequest = { host: "effr.test", cookies: {} };
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const stubModule = (code) => "data:text/javascript," + encodeURIComponent(code);
const SERVER_STUB = stubModule(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__effAfter.push(fn); };`);
const HEADERS_STUB = stubModule(`const r = () => globalThis.__effRequest || { host: null, cookies: {} };
export async function headers() { return { get: (n) => (String(n).toLowerCase() === "host" ? r().host : null) }; }
export async function cookies() { const c = r().cookies || {}; return { get: (n) => (Object.hasOwn(c, n) ? { name: n, value: c[n] } : undefined) }; }`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: SERVER_STUB, shortCircuit: true, format: "module" };
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (spec === "next/navigation") return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();

const F = await import("./support/tenant-fixture.js");
for (const n of ["effr", "effl", "eff23"]) await F.removeFixtureFiles(n);
const platform = await F.makePlatform({ name: "effr" });

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.stack || e).split("\n").slice(0, 4).join("\n    ")}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
// key order never matters
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b, m = "") => {
  const A = JSON.stringify(canon(a));
  const B = JSON.stringify(canon(b));
  if (A !== B) throw new Error(`${m}\n      got: ${A.slice(0, 900)}\n   wanted: ${B.slice(0, 900)}`);
};
const plain = (x) => JSON.parse(JSON.stringify(x));
const hasKeyDeep = (v, keys) => {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, keys));
  if (v && typeof v === "object") return Object.keys(v).some((k) => keys.includes(k) || hasKeyDeep(v[k], keys));
  return false;
};

// ---- the fixture (the same as the one the base snapshot below was recorded on) ----
const PID = (n) => `gid://shopify/Product/70${n}`;
const VID = (n) => `gid://shopify/ProductVariant/70${n}1`;
const img = (h, i, alt) => ({ url: `https://cdn.shopify.com/fx/${h}-${i}.png`, altText: alt, width: 800, height: 800 });
const prod = (n, handle, title, type, tags, price, created, extra = {}) => ({
  id: PID(n),
  handle,
  title,
  description: `${title} from Shopify`,
  descriptionHtml: `<p>${title} from <b>Shopify</b></p>`,
  productType: type,
  vendor: "Shopify Labs",
  tags,
  priceRange: { minVariantPrice: { amount: String(price), currencyCode: "INR" }, maxVariantPrice: { amount: String(price), currencyCode: "INR" } },
  availableForSale: true,
  totalInventory: 10,
  featuredImage: img(handle, 1, `${title} front`),
  images: { nodes: [img(handle, 1, `${title} front`), img(handle, 2, `${title} back`)] },
  options: [],
  variants: { nodes: [{ id: VID(n), title: "Default Title", sku: `SKU-${n}`, price: { amount: String(price), currencyCode: "INR" }, availableForSale: true, selectedOptions: [], image: null }] },
  createdAt: created,
  updatedAt: created,
  ...extra,
});
const PRODUCTS = [
  prod(1, "whey", "Old Whey", "Protein", ["protein", "shop"], 1000, "2026-01-04T00:00:00Z"),
  prod(2, "shaker", "Steel Shaker", "Gear", ["gear", "shop"], 200, "2026-01-03T00:00:00Z"),
  prod(3, "bar", "Zeta Bar", "Snacks", ["snack", "shop", "protein"], 100, "2026-01-02T00:00:00Z"),
  prod(4, "creatine", "Alpha Creatine", "Protein", ["protein", "shop"], 500, "2026-01-01T00:00:00Z"),
];
const COLLECTIONS = [
  { id: "gid://shopify/Collection/71", handle: "all", title: "All", members: [1, 2, 3, 4] },
  { id: "gid://shopify/Collection/72", handle: "stack", title: "Stack", members: [1, 4, 3] },
];
const GIFT_OFFER = { id: "gift-shaker", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Free shaker over 500", threshold: 500, gift: { variantId: VID(2), productId: PID(2), handle: "shaker", title: "Stored Shaker Name", image: "https://cdn.shopify.com/fx/stored.png", value: 200 } };

const { db, libsql, currentDatabase } = await import("../lib/db.js");
async function seedCatalog(tn) {
  await tn.run(async () => {
    for (const c of COLLECTIONS) {
      await db.insertInto("collections").values({ id: c.id, handle: c.handle, title: c.title, updated_at: "2026-01-01T00:00:00Z" }).execute();
      for (const [i, n] of c.members.entries()) await db.insertInto("collection_products").values({ collection_id: c.id, product_id: PID(n), position: i }).execute();
    }
  });
}

// Three tenants: effr (newest schema; published content is written here),
// effl (newest schema, never any published content) and eff23 (stage 0023,
// no live table at all).
const T = await F.makeTenant({ name: "effr", stage: "latest", products: PRODUCTS });
const TL = await F.makeTenant({ name: "effl", stage: "latest", products: PRODUCTS });
const T23 = await F.makeTenant({ name: "eff23", stage: "0023", products: PRODUCTS });
const { emptyList: emptyReleaseList } = await import("../lib/documents/release-list.js");
const { singletonTypes: regSingletons } = await import("../lib/registry/index.js");
for (const tn of [T, TL, T23]) {
  await seedCatalog(tn);
  await tn.run(async () => {
    await libsql.execute({ sql: "INSERT OR REPLACE INTO releases (id, content, content_hash, created_at) VALUES ('rel_open', ?, 'h', '2026-01-01T00:00:00Z')", args: [JSON.stringify(emptyReleaseList(1, regSingletons()))] });
    await libsql.execute("UPDATE release_state SET live_release_id = 'rel_open' WHERE id = 1");
  });
}
const inT = (fn) => T.run(fn);

const E = await import("../lib/catalog/effective.js");
const repo = await import("../lib/repo.js");
const Cart = await import("../lib/cart.js");
const O = await import("../lib/orders.js");
const { getPdpPairs } = await import("../lib/catalog/upsells.js");
const { resolveWishlist } = await import("../lib/wishlist.js");
const Quiz = await import("../lib/quiz.js");
const B = await import("../lib/bundles.js");
const { upsertOffer, deleteOffer } = await import("../lib/offers/store.js");
const { watchStatements } = await import("./support/request-cache.js");
const { NextRequest } = await import("next/server");

// A published product content row: what P4-LIVEROW's publish writes.
const NOW = "2026-11-04T00:00:00.000Z";
async function setLive(tn, n, fields) {
  await tn.run(async () => {
    await db.deleteFrom("product_content_live").where("product_id", "=", PID(n)).execute();
    await db.insertInto("product_content_live").values({ product_id: PID(n), document_id: `doc_prod_test${n}`, version_id: `ver_test${n}`, published_at: NOW, ...fields }).execute();
  });
}
const clearLive = (tn) => tn.run(() => db.deleteFrom("product_content_live").execute());
const clearLiveFor = (n) => T.run(() => db.deleteFrom("product_content_live").where("product_id", "=", PID(n)).execute());

// ---- rendering real components with Next's SWC --------------------------------------
const JSX_RUNTIME = require("react/jsx-runtime");
const h = React.createElement;
const compile = async (src) =>
  (await swc.transform(src, { jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
async function loadComponent(rel, stubs, { append = "", fallback = null } = {}) {
  const code = (await compile(await readFile(join(ROOT, rel), "utf8"))) + append;
  const mod = { exports: {} };
  const req = (id) => {
    if (id in stubs) return stubs[id];
    if (id in MARKET_STUBS) return MARKET_STUBS[id]; // Phase 8 line 4: the store's own market
    if (id === "react/jsx-runtime") return JSX_RUNTIME;
    if (id === "react") return React;
    if (fallback) return fallback(id);
    throw new Error(`${rel}: unstubbed import "${id}"`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  return mod.exports;
}
const Link = { __esModule: true, default: ({ href, children, ...p }) => h("a", { href, className: p.className }, children) };
const nav = { notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } };
const sanitize = await import("../lib/sanitize.js");
const format = await import("../lib/format.js");
const ids = await import("../lib/ids.js");
const nothing = { __esModule: true, default: () => null };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const ProductCard = await loadComponent("components/ProductCard.js", {
  "next/link": Link,
  "./FadeImage": { __esModule: true, default: ({ src, alt }) => h("img", { src, alt }) },
  "@/lib/format": format,
  // Phase 8 line 4: with no market, Price renders formatMoney's text exactly
  "@/components/Price": { __esModule: true, default: ({ amount, currency }) => format.formatMoney(amount, currency) },
});
const renderCard = (product) => renderToStaticMarkup(h(ProductCard.default, { product }));

let tracked = [];
let template = "classic";
let checkoutPage = null;
let quizRoute = null;
async function productPageModule(tn) {
  const Pdp = await loadComponent("components/pdp/PdpLayouts.js", {
    "next/link": Link,
    "@/components/ProductGallery": { __esModule: true, default: ({ images, title }) => h("div", { "data-gallery": "" }, images.map((i) => h("img", { key: i.url, src: i.url, alt: i.alt || title }))) },
    "@/components/ProductPurchase": nothing,
    "@/components/WishlistButton": nothing,
    "@/components/plugins/PluginSlot": nothing, // Phase 4 line 2: an async server component
    "@/components/ProductCard": ProductCard,
    "@/lib/sanitize": sanitize,
  });
  return loadComponent("app/(storefront)/products/[handle]/page.js", {
    "next/link": Link,
    "next/navigation": nav,
    "@/components/analytics/TrackEvent": { __esModule: true, default: (p) => (tracked.push(plain(p)), null) },
    "@/components/pdp/PdpLayouts": Pdp,
    "@/lib/repo": repo,
    "@/lib/content/resolve": {
      resolvedPdpPairs: (id, o) => getPdpPairs(id, o),
      resolvedPdpExtras: async () => [],
      resolvedProductOverride: async () => null,
      resolvedSurfaceTemplateFor: async () => ({ template }),
      // P4-OVL07: no documents preview here (shoppers)
      previewEntityRow: async () => null,
      productPreviewView: async () => {
        throw new Error("no preview view without a draft");
      },
    },
    "@/lib/catalog/effective": E,
    "@/lib/ids": ids,
    "@/lib/site": { abs: (p) => `https://${tn.id}.test${p}`, siteName: () => "Fixture Store" },
    "@/lib/tenant-request": { tfetch: (fn) => tn.run(fn) },
    "@/lib/storefront-request": { tfetch: (fn) => tn.run(fn) },
  });
}
const pageMods = new Map();
async function renderProduct(tn, handle) {
  if (!pageMods.has(tn.id)) pageMods.set(tn.id, await productPageModule(tn));
  const page = pageMods.get(tn.id);
  tracked = [];
  const html = renderToStaticMarkup(await page.default({ params: Promise.resolve({ handle }) }));
  const meta = await page.generateMetadata({ params: Promise.resolve({ handle }) });
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const crumbs = text(/<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1]);
  const h1 = text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1]);
  return { html, meta, ld, crumbs, h1, tracked: tracked.slice() };
}

// =============================================================================
// 1. The guard
// =============================================================================
console.log("— 1. only effective.js reads product content on a shopper path");

// Columns that are product content (spec OVL-01): titles, descriptions,
// images, vendor and the type label. id, handle, prices, availability, tags
// and dates are not.
const CONTENT = { products: new Set(["title", "description", "description_html", "product_type", "vendor", "featured_image", "featured_image_alt"]), product_images: new Set(["url", "alt"]) };
const TABLES = Object.keys(CONTENT);
const EFFECTIVE = "lib/catalog/effective.js";

// The allowlist: statements outside effective.js that may read products, with
// the columns each may read and why. Exactly these five.
const ALLOWLIST = [
  { file: "app/sitemap.js", fn: "buildSitemap", columns: ["handle", "updated_at"], reason: "lists product addresses only; no content" },
  { file: "lib/customers.js", fn: "buildReorder", columns: ["id", "handle", "available"], reason: "reorder checks a product still exists and is in stock; no content" },
  { file: "lib/repo.js", fn: "getCollectionTypeFacets", columns: ["id", "product_type"], reason: "the collection filter's facets: Shopify's RAW product type by design (filters are logic, OVL-01)" },
  { file: "lib/content/resolve.js", fn: "cartPlacementRows", columns: ["id", "handle"], reason: "the cart slot's handles to ids (the plan's resolve.js:669); no content" },
];

// Comments out, strings kept.
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      out += src.slice(i, end < 0 ? n : end + 2).replace(/[^\n]/g, " ");
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (c === "`" && depth && src[j] === "}") {
          depth--;
          j++;
          continue;
        }
        if (src[j] === c && !depth) break;
        if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

// Top-level declarations of a (prettier-formatted) module: name -> [start, end).
const DECL = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm;
function topLevel(src) {
  const decls = [];
  for (const m of src.matchAll(DECL)) decls.push({ name: m[1] || m[2], start: m.index });
  for (let i = 0; i < decls.length; i++) decls[i].end = i + 1 < decls.length ? decls[i + 1].start : src.length;
  return decls;
}
function enclosingFn(src, idx) {
  let name = "(module)";
  for (const d of topLevel(src)) if (d.start <= idx && idx < d.end) name = d.name;
  return name;
}
function constants(src) {
  const out = new Map();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]/g)) {
    out.set(m[1], { strings: [...m[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]), spreads: [...m[2].matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map((x) => x[1]) });
  }
  return out;
}
function expand(consts, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const c = consts.get(name);
  if (!c) return null;
  const list = [...c.strings];
  for (const s of c.spreads) {
    const more = expand(consts, s, seen);
    if (more == null) return null;
    list.push(...more);
  }
  return list;
}
const TRIGGER = /\b(selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*["'`](products|product_images)(?:\s+as\s+([A-Za-z_]\w*))?["'`]|\b(?:from|join)\s+"?(products|product_images)"?(?:\s+(?:as\s+)?(?!where|on|order|group|limit|left|inner|join|using)([A-Za-z_]\w*))?/gi;
const NOISE = new Set(["products", "product_images", "variants", "collections", "collection_products", "in", "is", "not", "like", "asc", "desc", "and", "or"]);
const SQL_WORDS = /\b(select|from|join|where|order\s+by)\b/i;
const LIT = /^\s*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)(?:\s+as\s+\w+)?\s*$/i;

// P4-OVL07 (from the P4-EFFECTIVE review): a table name held in a variable
// in the same file, `const TB = "products"` (or "products as p"), then
// db.selectFrom(TB), .innerJoin(TB, ...), or `FROM ${TB}` in SQL text, reads
// the table as if it were written there. Each such use is replaced by the
// quoted name before the scan, so the statement is seen. A name that comes
// from another module, a function argument or an expression is not followed
// (see the packet's Known limits).
const TABLE_VAR = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:products|product_images)(?:\s+as\s+[A-Za-z_]\w*)?)\2/g;
function tableNamesInline(src) {
  const vars = new Map();
  for (const m of src.matchAll(TABLE_VAR)) vars.set(m[1], m[3]);
  let out = src;
  for (const [name, table] of vars) {
    const id = name.replace(/\$/g, "\\$");
    out = out.replace(new RegExp(`\\b(selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\\(\\s*${id}(?![\\w$])`, "g"), (_, fn) => `${fn}("${table}"`);
    out = out.replace(new RegExp(`\\$\\{\\s*${id}\\s*\\}`, "g"), table);
  }
  return out;
}

// Every statement in a file that reads products or product_images: the columns
// it names, and why it reads content (selectAll, a content column, or a column
// list this scan cannot read). Column-aware: a read of id and handle is not
// content; a select of everything or of a list it cannot see is.
function scanSource(file, rawSrc) {
  const src = tableNamesInline(stripComments(rawSrc));
  const consts = constants(src);
  const found = [];
  const seenStart = new Set();
  for (const m of src.matchAll(new RegExp(TRIGGER.source, "gi"))) {
    const start = Math.max(src.lastIndexOf(";", m.index) + 1, m.index - 2000, 0);
    let end = src.indexOf(";", m.index);
    if (end < 0 || end - m.index > 4000) end = Math.min(src.length, m.index + 4000);
    if (seenStart.has(start)) continue;
    seenStart.add(start);
    const w = src.slice(start, end);
    const aliases = new Map();
    const bare = new Set();
    for (const x of w.matchAll(new RegExp(TRIGGER.source, "gi"))) {
      const table = (x[2] || x[4]).toLowerCase();
      const alias = x[3] || x[5];
      if (alias) aliases.set(alias, table);
      else bare.add(table);
    }
    const columns = new Set();
    const reasons = [];
    const note = (table, col, via) => {
      columns.add(col);
      if (CONTENT[table].has(col)) reasons.push(`${table}.${col} (${via})`);
    };
    const classify = (q, col, via) => {
      if (q) {
        const table = aliases.get(q) || (TABLES.includes(q) ? q : null);
        if (table) note(table, col, via);
        return;
      }
      for (const table of bare) note(table, col, via);
    };
    for (const s of w.matchAll(/\.selectAll\(\s*(?:["'`](\w+)["'`])?\s*\)/g)) {
      const tables = s[1] ? [aliases.get(s[1]) || (TABLES.includes(s[1]) ? s[1] : null)].filter(Boolean) : [...bare, ...(!bare.size ? aliases.values() : [])];
      for (const tb of tables) {
        columns.add("*");
        reasons.push(`${tb}.* (selectAll)`);
      }
    }
    for (const s of w.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const lit = LIT.exec(s[2]);
      if (lit && !lit[1] && NOISE.has(lit[2].toLowerCase())) continue;
      if (lit) {
        classify(lit[1], lit[2].toLowerCase(), "column");
        continue;
      }
      if (SQL_WORDS.test(s[2])) {
        for (const q of s[2].matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)) classify(q[1], q[2].toLowerCase(), "sql");
        if (bare.size)
          for (const word of s[2].replace(/\$\{[^}]*\}/g, " ").matchAll(/(?<![.\w])([A-Za-z_]\w*)(?![.\w])/g))
            for (const table of bare) if (CONTENT[table].has(word[1].toLowerCase())) note(table, word[1].toLowerCase(), "sql");
      }
    }
    for (const id of w.matchAll(/(?:\.\.\.\s*|(?<![\w$.]))([A-Z][A-Z0-9_]{2,})(?![\w$])/g)) {
      const list = expand(consts, id[1]);
      if (list == null) {
        if (new RegExp(`(?:select\\(\\s*\\[?[^)]*|\\.\\.\\.)\\b${id[1]}\\b`).test(w)) reasons.push(`${id[1]} (a column list this scan cannot read)`);
        continue;
      }
      const prefixed = new RegExp(`\\b${id[1]}\\.map\\(\\s*\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*\`(\\w+)\\.\\$\\{\\1\\}\``).exec(w);
      for (const str of list) {
        const lit = LIT.exec(str);
        if (!lit) continue;
        const q = lit[1] || (prefixed ? prefixed[2] : null) || (!bare.size && aliases.size === 1 ? [...aliases.keys()][0] : null);
        classify(q, lit[2].toLowerCase(), `via ${id[1]}`);
      }
    }
    for (const s of w.matchAll(/\.select\(\s*\[?\s*(?:\.\.\.)?\s*([a-z_$][\w$]*)\s*[\],)]/g)) {
      if (["eb", "qb"].includes(s[1]) || consts.has(s[1])) continue;
      reasons.push(`${s[1]} (a column list this scan cannot read)`);
    }
    found.push({ file, line: lineOf(src, m.index), fn: enclosingFn(src, m.index), columns: [...columns].sort(), reasons: [...new Set(reasons)].sort() });
  }
  return found;
}

// ---- which code a shopper path runs ----
// Entries: every storefront page and layout, the sitemap and robots, and the
// shopper API routes. From them, imports are followed function by function: a
// module's top-level declarations count when imported by name (and whatever
// they use in the same file); a namespace or bare dynamic import counts all.
const SHOPPER_API = ["account", "cart", "checkout", "contact", "errors", "exp", "leads", "media", "quiz", "razorpay", "search", "track", "upsell", "wishlist"];
// Not shopper reads, though a shopper route can start them: the job runner
// does queued work (catalog sync, Shopify pushes, emails) after the response.
// Its catalog reads are the sync's own and the Typesense builder's, which
// P4-SEARCH moves onto effective.js indexRows.
const BOUNDARY = new Map([["lib/platform/worker.js", "the job runner: queued work after the response, not a shopper read"]]);

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (/\.(m?js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}
async function entryFiles() {
  const files = [...(await walk(join(ROOT, "app/(storefront)"))), join(ROOT, "app/sitemap.js"), join(ROOT, "app/robots.js")];
  for (const d of SHOPPER_API) files.push(...(await walk(join(ROOT, "app/api", d))));
  return files.map((f) => relative(ROOT, f));
}
const isFile = async (p) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};
async function resolveSpec(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = join(ROOT, dirname(fromRel), spec);
  else return null;
  for (const cand of [base, `${base}.js`, `${base}.mjs`, join(base, "index.js")]) if (await isFile(cand)) return relative(ROOT, cand);
  return null;
}
function importsOf(src) {
  const out = [];
  const names = (list) => new Set(list.split(",").map((p) => p.trim().split(/\s+as\s+|\s*:\s*/)[0].trim()).filter(Boolean));
  for (const m of src.matchAll(/\bimport\s+([^"'();]*?)\s+from\s*["']([^"']+)["']/g)) {
    const braces = /\{([^}]*)\}/.exec(m[1]);
    const set = braces ? names(braces[1]) : new Set();
    const head = m[1].replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    if (/\*\s+as\s+/.test(head)) out.push({ spec: m[2], names: "*" });
    else {
      if (head) set.add("default");
      out.push({ spec: m[2], names: set });
    }
  }
  for (const m of src.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push({ spec: m[1], names: new Set() });
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) out.push({ spec: m[2], names: names(m[1]), reexport: true });
  for (const m of src.matchAll(/\bexport\s*\*\s*from\s*["']([^"']+)["']/g)) out.push({ spec: m[1], names: "*", reexport: true });
  for (const m of src.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[2], names: names(m[1]) });
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (/(?:const|let)\s*\{[^}]*\}\s*=\s*await\s+$/.test(src.slice(Math.max(0, m.index - 200), m.index))) continue;
    out.push({ spec: m[1], names: "*" });
  }
  return out;
}
async function reachableUse(entries, read) {
  const used = new Map();
  const live = new Map();
  const srcs = new Map();
  const getSrc = async (rel) => {
    if (!srcs.has(rel)) srcs.set(rel, stripComments(await read(rel)));
    return srcs.get(rel);
  };
  const queue = entries.map((e) => [e, "*"]);
  while (queue.length) {
    const [rel, names] = queue.shift();
    if (BOUNDARY.has(rel)) {
      used.set(rel, new Set());
      continue;
    }
    const prev = used.get(rel);
    if (prev === "*") continue;
    let next;
    if (names === "*") next = "*";
    else {
      next = new Set(prev || []);
      const before = next.size;
      for (const n of names) next.add(n);
      if (prev && next.size === before) continue;
    }
    used.set(rel, next);
    const src = await getSrc(rel);
    const decls = topLevel(src);
    const declNames = new Set(decls.map((d) => d.name));
    let liveSet;
    if (next === "*") liveSet = new Set(declNames);
    else {
      const defaultName = /export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(src)?.[1];
      liveSet = new Set([...next].map((n) => (n === "default" && defaultName ? defaultName : n)));
      let grew = true;
      while (grew) {
        grew = false;
        for (const d of decls) {
          if (!liveSet.has(d.name)) continue;
          const body = src.slice(d.start, d.end);
          for (const other of declNames)
            if (!liveSet.has(other) && new RegExp(`(?<![\\w$.])${other.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) {
              liveSet.add(other);
              grew = true;
            }
        }
      }
    }
    live.set(rel, liveSet);
    const moduleLevel = decls.length ? src.slice(0, decls[0].start) : src;
    const liveText = moduleLevel + "\n" + decls.filter((d) => liveSet.has(d.name)).map((d) => src.slice(d.start, d.end)).join("\n");
    for (const imp of importsOf(liveText)) {
      const r = await resolveSpec(rel, imp.spec);
      if (r && /^(app|lib|components)\//.test(r)) queue.push([r, imp.names]);
    }
    for (const imp of importsOf(src).filter((i) => i.reexport)) {
      const r = await resolveSpec(rel, imp.spec);
      if (!r || !/^(app|lib|components)\//.test(r)) continue;
      const wanted = next === "*" ? imp.names : imp.names === "*" ? next : new Set([...imp.names].filter((n) => next.has(n)));
      if (wanted === "*" || wanted.size) queue.push([r, wanted]);
    }
  }
  return live;
}
const readReal = (rel) => readFile(join(ROOT, rel), "utf8");

// The guard: statements on a shopper path, outside effective.js, that read
// product content and are not covered by the allowlist.
async function guard({ read = readReal, allowlist = ALLOWLIST } = {}) {
  const live = await reachableUse(await entryFiles(), read);
  const statements = [];
  for (const [rel, names] of live) {
    if (BOUNDARY.has(rel)) continue;
    for (const s of scanSource(rel, await read(rel))) if (s.fn === "(module)" || names.has(s.fn)) statements.push(s);
  }
  const violations = [];
  for (const s of statements) {
    if (s.file === EFFECTIVE || !s.reasons.length) continue;
    const entry = allowlist.find((a) => a.file === s.file && a.fn === s.fn);
    if (entry && !s.columns.includes("*") && s.columns.every((c) => entry.columns.includes(c))) continue;
    violations.push(`${s.file}:${s.line} ${s.fn}: ${s.reasons.join(", ")}`);
  }
  return { statements, violations, files: [...live.keys()] };
}

const real = await guard();

await t("the guard passes on this tree with exactly the listed allowlist (four statements, each with its reason)", async () => {
  eq(real.violations.length, 0, `content reads outside effective.js:${real.violations.map((v) => `\n      ${v}`).join("")}\n    count:`);
  same(ALLOWLIST.map((a) => `${a.file} ${a.fn}`), ["app/sitemap.js buildSitemap", "lib/customers.js buildReorder", "lib/repo.js getCollectionTypeFacets", "lib/content/resolve.js cartPlacementRows"], "the allowlist");
  ok(ALLOWLIST.every((a) => a.reason && a.columns.length), "every entry has its reason and columns");
  ok(real.files.includes("lib/repo.js") && real.files.includes("lib/cart.js") && real.files.includes("lib/content/resolve.js") && real.files.includes(EFFECTIVE), "the scan reached the shopper modules");
  ok(real.statements.some((s) => s.file === EFFECTIVE && s.reasons.length), "effective.js itself reads content (the scan sees it)");
});

await t("every allowlist entry is a real statement that reads only its stated columns, never everything", async () => {
  for (const a of ALLOWLIST) {
    const hits = scanSource(a.file, await readReal(a.file)).filter((s) => s.fn === a.fn);
    ok(hits.length >= 1, `${a.file} ${a.fn}: no products read found`);
    for (const s of hits) {
      ok(!s.columns.includes("*"), `${a.file}:${s.line} reads every column`);
      ok(s.columns.every((c) => a.columns.includes(c)), `${a.file}:${s.line} reads ${s.columns} beyond ${a.columns}`);
    }
  }
});

// A planted change, read through the same scan: `edit(src)` on one file.
const plant = (file, edit) => (rel) => (rel === file ? readReal(rel).then(edit) : readReal(rel));
const replaceOnce = (from, to) => (src) => {
  ok(src.includes(from), `plant: "${from.slice(0, 50)}" not found`);
  return src.replace(from, to);
};

await t("a planted selectAll() from products in a storefront lib file fails the guard", async () => {
  const r = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const rows = await db.selectFrom("products").selectAll().where("handle", "in", handles).execute();')) });
  ok(r.violations.some((v) => v.startsWith("lib/wishlist.js") && v.includes("products.* (selectAll)")), r.violations.join(" | ") || "no violation");
});

await t("a spread column constant, an unreadable column list and raw SQL are caught too", async () => {
  const spread = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const COLS = ["handle", "title"];\n  const rows = await db.selectFrom("products").select([...COLS]).execute();')) });
  ok(spread.violations.some((v) => v.includes("products.title (via COLS)")), spread.violations.join(" | ") || "spread: no violation");
  const mapped = await guard({ read: plant("lib/repo.js", replaceOnce("export async function getCatalogStats() {", 'const LIST = ["title", "handle"];\nexport async function getCatalogStats() {\n  await db.selectFrom("products as p").select(LIST.map((c) => `p.${c}`)).execute();')) });
  ok(mapped.violations.some((v) => v.startsWith("lib/repo.js") && v.includes("products.title (via LIST)")), mapped.violations.join(" | ") || "mapped: no violation");
  const unknown = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const rows = await db.selectFrom("products").select(columnsFromSomewhere).execute();')) });
  ok(unknown.violations.some((v) => v.includes("columnsFromSomewhere (a column list this scan cannot read)")), unknown.violations.join(" | ") || "unknown: no violation");
  const raw = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const rows = (await libsql.execute("SELECT handle, title FROM products")).rows;')) });
  ok(raw.violations.some((v) => v.includes("products.title (sql)")), raw.violations.join(" | ") || "raw: no violation");
  const imgs = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const rows = await db.selectFrom("product_images as i").select(["i.url", "i.product_id"]).execute();')) });
  ok(imgs.violations.some((v) => v.includes("product_images.url")), imgs.violations.join(" | ") || "images: no violation");
});

await t("a table name held in a variable is caught: selectFrom(TB) with selectAll, a join, and FROM ${TB} in SQL text", async () => {
  const held = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const TB = "products";\n  const rows = await db.selectFrom(TB).selectAll().where("handle", "in", handles).execute();')) });
  ok(held.violations.some((v) => v.startsWith("lib/wishlist.js") && v.includes("products.* (selectAll)")), held.violations.join(" | ") || "selectFrom(TB): no violation");
  const aliased = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const PRODUCTS = "products as p";\n  const rows = await db.selectFrom("variants as v").innerJoin(PRODUCTS, "p.id", "v.product_id").select(["v.id", "p.title"]).execute();')) });
  ok(aliased.violations.some((v) => v.includes("products.title")), aliased.violations.join(" | ") || "innerJoin(PRODUCTS): no violation");
  const text = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const T_IMG = "product_images";\n  const rows = (await libsql.execute(`SELECT url, alt FROM ${T_IMG}`)).rows;')) });
  ok(text.violations.some((v) => v.includes("product_images.url")), text.violations.join(" | ") || "FROM ${T_IMG}: no violation");
  // the same names, held in a variable that names another table, are no read of products
  const other = await guard({ read: plant("lib/wishlist.js", replaceOnce("const rows = await cardRows({ handles });", 'const TB = "variants";\n  const extra = await db.selectFrom(TB).selectAll().execute();\n  const rows = await cardRows({ handles });')) });
  eq(other.violations.length, 0, `another table flagged: ${other.violations}`);
});

await t("the allowlist is narrow: a content column added to an allowed statement, or a content read elsewhere in that file, fails", async () => {
  const facets = await guard({ read: plant("lib/repo.js", replaceOnce('.select(["p.product_type"])', '.select(["p.product_type", "p.title"])')) });
  ok(facets.violations.some((v) => v.includes("getCollectionTypeFacets") && v.includes("products.title")), facets.violations.join(" | ") || "facets: no violation");
  const sitemap = await guard({ read: plant("app/sitemap.js", replaceOnce('.select(["handle", "updated_at"])', '.select(["handle", "updated_at", "title"])')) });
  ok(sitemap.violations.some((v) => v.startsWith("app/sitemap.js")), sitemap.violations.join(" | ") || "sitemap: no violation");
  const other = await guard({ read: plant("lib/repo.js", replaceOnce('from "products") as "products"', 'from "products") as "products", (select title from products limit 1) as "t"')) });
  ok(other.violations.some((v) => v.includes("getCatalogStats") && v.includes("products.title (sql)")), other.violations.join(" | ") || "getCatalogStats: no violation");
});

await t("scope: code no shopper path imports is not a shopper read", async () => {
  // planting a content read in an exported function that no shopper path imports
  const r = await guard({ read: plant("lib/repo.js", (src) => src + '\nexport async function consoleOnlyTitles() {\n  return db.selectFrom("products").select(["id", "title"]).execute();\n}\n') });
  eq(r.violations.length, 0, `unused export flagged: ${r.violations}`);
  same([...BOUNDARY.keys()], ["lib/platform/worker.js"], "the one scope boundary");
});

// =============================================================================
// 2. A store with no published content reads as before
// =============================================================================
console.log("— 2. no published content: the same answers as before (snapshot at 17a08b7)");

// Recorded at 17a08b7 (before this change) on the fixture above, at stage
// 0023, by the same calls as record() below. synced_at is left out (the sync's
// clock). The only differences this change makes on purpose are applied by
// today() below.
const BASE = JSON.parse(String.raw`{"newest":[{"handle":"whey","title":"Old Whey","product_type":"Protein","price_min":1000,"price_max":1000,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/whey-1.png","featured_image_alt":"Old Whey front","tags":[],"options":[]},{"handle":"shaker","title":"Steel Shaker","product_type":"Gear","price_min":200,"price_max":200,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/shaker-1.png","featured_image_alt":"Steel Shaker front","tags":[],"options":[]},{"handle":"bar","title":"Zeta Bar","product_type":"Snacks","price_min":100,"price_max":100,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/bar-1.png","featured_image_alt":"Zeta Bar front","tags":[],"options":[]},{"handle":"creatine","title":"Alpha Creatine","product_type":"Protein","price_min":500,"price_max":500,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/creatine-1.png","featured_image_alt":"Alpha Creatine front","tags":[],"options":[]}],"pdp":{"id":"gid://shopify/Product/701","handle":"whey","title":"Old Whey","description":"Old Whey from Shopify","description_html":"<p>Old Whey from <b>Shopify</b></p>","product_type":"Protein","vendor":"Shopify Labs","tags":["protein","shop"],"price_min":1000,"price_max":1000,"compare_at_min":null,"currency":"INR","available":true,"total_inventory":10,"featured_image":"https://cdn.shopify.com/fx/whey-1.png","featured_image_alt":"Old Whey front","options":[],"created_at":"2026-01-04T00:00:00Z","updated_at":"2026-01-04T00:00:00Z","sync_generation":null,"images":[{"id":"gid://shopify/Product/701::img::0","product_id":"gid://shopify/Product/701","url":"https://cdn.shopify.com/fx/whey-1.png","alt":"Old Whey front","width":800,"height":800,"position":0},{"id":"gid://shopify/Product/701::img::1","product_id":"gid://shopify/Product/701","url":"https://cdn.shopify.com/fx/whey-2.png","alt":"Old Whey back","width":800,"height":800,"position":1}],"variants":[{"id":"gid://shopify/ProductVariant/7011","product_id":"gid://shopify/Product/701","title":"Default Title","sku":"SKU-1","price":1000,"compare_at_price":null,"currency":"INR","available":true,"selected_options":"[]","image_url":null,"position":0,"selectedOptions":[]}]},"collection":{"products":[{"handle":"whey","title":"Old Whey","product_type":"Protein","price_min":1000,"price_max":1000,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/whey-1.png","featured_image_alt":"Old Whey front","tags":[],"options":[]},{"handle":"shaker","title":"Steel Shaker","product_type":"Gear","price_min":200,"price_max":200,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/shaker-1.png","featured_image_alt":"Steel Shaker front","tags":[],"options":[]},{"handle":"bar","title":"Zeta Bar","product_type":"Snacks","price_min":100,"price_max":100,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/bar-1.png","featured_image_alt":"Zeta Bar front","tags":[],"options":[]},{"handle":"creatine","title":"Alpha Creatine","product_type":"Protein","price_min":500,"price_max":500,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/creatine-1.png","featured_image_alt":"Alpha Creatine front","tags":[],"options":[]}],"total":4},"collectionTyped":{"products":[{"handle":"creatine","title":"Alpha Creatine","product_type":"Protein","price_min":500,"price_max":500,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/creatine-1.png","featured_image_alt":"Alpha Creatine front","tags":[],"options":[]},{"handle":"whey","title":"Old Whey","product_type":"Protein","price_min":1000,"price_max":1000,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/whey-1.png","featured_image_alt":"Old Whey front","tags":[],"options":[]}],"total":2},"facets":[{"type":"Protein","count":2},{"type":"Gear","count":1},{"type":"Snacks","count":1}],"searchShop":{"source":"database","found":4,"hits":[{"handle":"creatine","title":"Alpha Creatine","image":"https://cdn.shopify.com/fx/creatine-1.png","price":500,"currency":"INR","product_type":"Protein","available":true},{"handle":"whey","title":"Old Whey","image":"https://cdn.shopify.com/fx/whey-1.png","price":1000,"currency":"INR","product_type":"Protein","available":true},{"handle":"shaker","title":"Steel Shaker","image":"https://cdn.shopify.com/fx/shaker-1.png","price":200,"currency":"INR","product_type":"Gear","available":true},{"handle":"bar","title":"Zeta Bar","image":"https://cdn.shopify.com/fx/bar-1.png","price":100,"currency":"INR","product_type":"Snacks","available":true}]},"searchProtein":{"source":"database","found":1,"hits":[{"handle":"bar","title":"Zeta Bar","image":"https://cdn.shopify.com/fx/bar-1.png","price":100,"currency":"INR","product_type":"Snacks","available":true}]},"pairs":{"title":"Pairs well with","products":[{"id":"gid://shopify/Product/701","handle":"whey","title":"Old Whey","price_min":1000,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/whey-1.png","featured_image_alt":"Old Whey front","shared":2},{"id":"gid://shopify/Product/703","handle":"bar","title":"Zeta Bar","price_min":100,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/bar-1.png","featured_image_alt":"Zeta Bar front","shared":2},{"id":"gid://shopify/Product/702","handle":"shaker","title":"Steel Shaker","price_min":200,"compare_at_min":null,"currency":"INR","available":true,"featured_image":"https://cdn.shopify.com/fx/shaker-1.png","featured_image_alt":"Steel Shaker front","shared":1}],"source":"auto"},"wishlist":[{"handle":"whey","state":"ok","title":"Old Whey","image":"https://cdn.shopify.com/fx/whey-1.png","price":1000,"currency":"INR"},{"handle":"gone","state":"gone","title":null}],"quiz":[{"handle":"creatine","title":"Alpha Creatine","product_type":"Protein","image":"https://cdn.shopify.com/fx/creatine-1.png","price":500,"currency":"INR","matches":1},{"handle":"whey","title":"Old Whey","product_type":"Protein","image":"https://cdn.shopify.com/fx/whey-1.png","price":1000,"currency":"INR","matches":1},{"handle":"bar","title":"Zeta Bar","product_type":"Snacks","image":"https://cdn.shopify.com/fx/bar-1.png","price":100,"currency":"INR","matches":1}],"bundle":{"slug":"stack","title":"Stack","description":"","bundle_price":1200,"components":[{"variantId":"gid://shopify/ProductVariant/7011","quantity":1,"title":"Old Whey","variant_title":"Default Title","handle":"whey","image":"https://cdn.shopify.com/fx/whey-1.png","price":1000,"available":true},{"variantId":"gid://shopify/ProductVariant/7041","quantity":1,"title":"Alpha Creatine","variant_title":"Default Title","handle":"creatine","image":"https://cdn.shopify.com/fx/creatine-1.png","price":500,"available":true}],"componentsSum":1500,"saving":300,"available":true,"problems":[]},"cart":{"id":"snap-cart","coupon":null,"items":[{"variantId":"gid://shopify/ProductVariant/7011","productId":"gid://shopify/Product/701","variantNumericId":"7011","handle":"whey","title":"Old Whey","catalog_title":"Old Whey","sku":"SKU-1","variantTitle":"Default Title","image":"https://cdn.shopify.com/fx/whey-1.png","price":1000,"currency":"INR","quantity":2,"lineTotal":2000,"available":true,"discount":0},{"variantId":"gid://shopify/ProductVariant/7031","productId":"gid://shopify/Product/703","variantNumericId":"7031","handle":"bar","title":"Zeta Bar","catalog_title":"Zeta Bar","sku":"SKU-3","variantTitle":"Default Title","image":"https://cdn.shopify.com/fx/bar-1.png","price":100,"currency":"INR","quantity":1,"lineTotal":100,"available":true,"discount":0}],"changes":[],"subtotal":2100,"count":3,"currency":"INR","appliedOffers":[{"id":"gift-shaker","type":"FREE_GIFT","label":"Free shaker over 500","amount":0,"gift":true,"giftValue":200}],"gifts":[{"variantId":"gid://shopify/ProductVariant/7021","productId":"gid://shopify/Product/702","handle":"shaker","title":"Stored Shaker Name","image":"https://cdn.shopify.com/fx/stored.png","value":200,"offerId":"gift-shaker"}],"discountTotal":0,"total":2100,"shipping":{"method":"free","label":"Free shipping (₹999+)","base":0,"codFee":0,"total":0,"free":true,"freeThreshold":999,"remainingForFree":0,"zone":null},"shippingRatesSet":false,"grandTotal":2100,"couponStatus":null},"orderLines":[{"title":"Old Whey","catalog_title":"Old Whey","sku":"SKU-1","is_gift":0,"variant_id":"gid://shopify/ProductVariant/7011"},{"title":"Zeta Bar","catalog_title":"Zeta Bar","sku":"SKU-3","is_gift":0,"variant_id":"gid://shopify/ProductVariant/7031"},{"title":"Stored Shaker Name","catalog_title":null,"sku":null,"is_gift":1,"variant_id":"gid://shopify/ProductVariant/7021"}],"orderSnapshot":{"items":[{"variantId":"gid://shopify/ProductVariant/7011","productId":"gid://shopify/Product/701","variantNumericId":"7011","handle":"whey","title":"Old Whey","catalog_title":"Old Whey","sku":"SKU-1","variantTitle":"Default Title","image":"https://cdn.shopify.com/fx/whey-1.png","price":1000,"currency":"INR","quantity":2,"lineTotal":2000,"available":true,"discount":0},{"variantId":"gid://shopify/ProductVariant/7031","productId":"gid://shopify/Product/703","variantNumericId":"7031","handle":"bar","title":"Zeta Bar","catalog_title":"Zeta Bar","sku":"SKU-3","variantTitle":"Default Title","image":"https://cdn.shopify.com/fx/bar-1.png","price":100,"currency":"INR","quantity":1,"lineTotal":100,"available":true,"discount":0}],"gifts":[{"variantId":"gid://shopify/ProductVariant/7021","productId":"gid://shopify/Product/702","handle":"shaker","title":"Stored Shaker Name","image":"https://cdn.shopify.com/fx/stored.png","value":200,"offerId":"gift-shaker"}],"totals":{"subtotal":2100,"discountTotal":0,"shippingTotal":0,"total":2100,"currency":"INR"}}}`);

// What the same calls answer now, by design:
//   · cards and search hits say display_type instead of product_type, and
//     cards no longer carry the always-empty tags and options keys;
//   · the product page says display_type, display_vendor and logic_tags /
//     logic_type instead of product_type, vendor and tags, adds seo_title,
//     seo_description and og_image (null), and no longer carries the sync's
//     own sync_generation column;
//   · quiz results say display_type;
//   · a gift line carries Shopify's title and the SKU (OVL-06), which the
//     order freezes; the browser never sees them (shopperCart);
//   · the cart carries `progress`, the drawer's nudges (Phase 7 line 3).
const rename = (o, from, to) => {
  if (!o || !(from in o)) return o;
  const { [from]: v, ...rest } = o;
  return { ...rest, [to]: v };
};
const cardNow = (c) => {
  const { tags, options, ...rest } = rename(c, "product_type", "display_type");
  return rest;
};
function today(base) {
  const b = structuredClone(base);
  b.newest = b.newest.map(cardNow);
  b.collection.products = b.collection.products.map(cardNow);
  b.collectionTyped.products = b.collectionTyped.products.map(cardNow);
  for (const k of ["searchShop", "searchProtein"]) b[k].hits = b[k].hits.map((x) => rename(x, "product_type", "display_type"));
  b.quiz = b.quiz.map((x) => rename(x, "product_type", "display_type"));
  const { product_type, vendor, tags, sync_generation, ...pdp } = b.pdp;
  b.pdp = { ...pdp, display_type: product_type, logic_type: product_type, display_vendor: vendor, logic_tags: tags, seo_title: null, seo_description: null, og_image: null };
  const giftNow = (g) => ({ ...g, catalog_title: "Steel Shaker", sku: "SKU-2" });
  b.cart.gifts = b.cart.gifts.map(giftNow);
  b.orderSnapshot.gifts = b.orderSnapshot.gifts.map(giftNow);
  b.orderLines = b.orderLines.map((l) => (l.is_gift ? { ...l, catalog_title: "Steel Shaker", sku: "SKU-2" } : l));
  // Phase 7 line 3: the drawer's nudges; the applied gift is named by its line's title
  b.cart.progress = { nudges: [], unlocked: [{ id: "gift-shaker", label: "Free Stored Shaker Name" }] };
  return b;
}
async function record(tn) {
  return tn.run(async () => {
    const r = {};
    r.newest = await repo.getNewestProducts(10);
    const pdp = await repo.getProductByHandle("whey");
    delete pdp.synced_at;
    r.pdp = pdp;
    r.collection = await repo.getProductsInCollection("all", {});
    r.collectionTyped = await repo.getProductsInCollection("all", { sort: "price-asc", type: "Protein" });
    r.facets = await repo.getCollectionTypeFacets("all");
    r.searchShop = await repo.searchProductsInDb("shop", 10);
    r.searchProtein = await repo.searchProductsInDb("protein bar", 10);
    r.pairs = await getPdpPairs(PID(4), { limit: 4 });
    r.wishlist = await resolveWishlist([{ handle: "whey" }, { handle: "gone" }]);
    r.quiz = await Quiz.recommendProducts(["protein"]);
    await B.upsertBundle({ slug: "stack", title: "Stack", items: [{ variantId: VID(1) }, { variantId: VID(4) }], bundle_price: 1200, enable: true });
    const bundle = await B.getBundle("stack");
    delete bundle.id;
    r.bundle = bundle;
    await upsertOffer({ offer: GIFT_OFFER });
    await Cart.createCart("snap-cart");
    await Cart.addItem("snap-cart", VID(1), 2);
    await Cart.addItem("snap-cart", VID(3), 1);
    r.cart = await Cart.getCart("snap-cart");
    const o = await O.createOrder({ cartId: "snap-cart", contact: { email: "snap@example.test", phone: "9000000000", name: "Snap" }, address: { line1: "1 St", city: "Pune", state: "MH", pincode: "411001" }, paymentMethod: "cod", idempotencyKey: "snap-1" });
    r.orderLines = (await libsql.execute({ sql: "SELECT title, catalog_title, sku, is_gift, variant_id FROM order_items WHERE order_id = ? ORDER BY position", args: [o.id] })).rows.map((x) => ({ ...x }));
    const snap = JSON.parse((await libsql.execute({ sql: "SELECT snapshot FROM orders WHERE id = ?", args: [o.id] })).rows[0].snapshot);
    r.orderSnapshot = { items: snap.items, gifts: snap.gifts, totals: snap.totals };
    return plain(r);
  });
}
const nowLatest = await record(TL);
const now23 = await record(T23);
const expected = today(BASE);

for (const [label, got] of [["the newest schema, no published content", nowLatest], ["a tenant at 0023 (no live table: the raw fallback)", now23]]) {
  await t(`${label}: cards, product page, collection, facets, search, pairs, wishlist, quiz, bundle, cart and order equal the snapshot`, async () => {
    for (const k of Object.keys(expected)) same(got[k], expected[k], `${k}:`);
  });
}

await t("the 0023 tenant really has no live table, and the newest one has it", async () => {
  eq(await T23.run(() => E.liveTableReady()), false, "0023:");
  eq(await TL.run(() => E.liveTableReady()), true, "latest:");
  eq(T23.migrations.at(-1), "0023_document_refs", "0023 ledger:");
});

// =============================================================================
// 3. A published title shows everywhere
// =============================================================================
console.log("— 3. a published title 'New' shows on every shopper surface");

await upsertOfferIn(T, GIFT_OFFER);
async function upsertOfferIn(tn, offer) {
  await tn.run(() => upsertOffer({ offer }));
}
await setLive(T, 1, { title: "New" });
let cartSeq = 0;
async function cartIn(tn, lines) {
  const id = `eff-cart-${++cartSeq}`;
  await tn.run(async () => {
    await Cart.createCart(id);
    for (const [v, q] of lines) await Cart.addItem(id, v, q);
  });
  return id;
}

await t("card: the newest products, a collection page and the rendered card show 'New'", async () => {
  const newest = await inT(() => repo.getNewestProducts(10));
  eq(newest.find((p) => p.handle === "whey").title, "New", "newest:");
  const coll = await inT(() => repo.getProductsInCollection("all", {}));
  eq(coll.products.find((p) => p.handle === "whey").title, "New", "collection:");
  const html = renderCard(newest.find((p) => p.handle === "whey"));
  ok(html.includes(">New<") && !text(html).includes("Old Whey"), html);
});

await t("product page: the heading, meta title, Open Graph title, JSON-LD name, breadcrumb and the view event's name are 'New'", async () => {
  const r = await renderProduct(T, "whey");
  eq(r.h1, "New", "h1:");
  eq(r.meta.title, "New", "meta title:");
  eq(r.meta.openGraph.title, "New", "og title:");
  eq(r.ld[0].name, "New", "JSON-LD name:");
  eq(r.ld[1].itemListElement[2].name, "New", "JSON-LD breadcrumb:");
  ok(r.crumbs.endsWith("/ New"), `breadcrumb: ${r.crumbs}`);
  eq(r.tracked.find((x) => x.name === "view_item").data.items[0].name, "New", "TrackEvent name:");
  // Shopify's own description still names the old title; nothing else does
  ok(!text(r.html).replace("Old Whey from Shopify", "").includes("Old Whey"), "the old title shows on the page");
});

await t("cart and checkout page props: the line says 'New'; the server-side cart also has Shopify's title", async () => {
  const id = await cartIn(T, [[VID(1), 1]]);
  const cart = await inT(() => Cart.getCart(id));
  same([cart.items[0].title, cart.items[0].catalog_title, cart.items[0].sku], ["New", "Old Whey", "SKU-1"], "server cart line");
  const props = await renderCheckout(T, id);
  eq(props.cart.items[0].title, "New", "checkout prop:");
});

async function renderCheckout(tn, cartId) {
  let captured = null;
  checkoutPage ??= new Map();
  if (!checkoutPage.has(tn.id)) {
    checkoutPage.set(
      tn.id,
      await loadComponent("app/(storefront)/checkout/page.js", {
        "next/link": Link,
        "next/headers": { cookies: async () => ({ get: (n) => (n === Cart.CART_COOKIE && globalThis.__effCheckoutCart ? { value: globalThis.__effCheckoutCart } : undefined) }) },
        "@/lib/cart": Cart,
        "@/lib/tenant-context": await import("../lib/tenant-context.js"),
        "@/lib/delivery-estimate": await import("../lib/delivery-estimate.js"), // Phase 8 line 1
        "@/lib/commerce/adapter": { checkoutCapability: () => ({ available: true }) },
        "@/lib/site": { siteName: () => "Fixture Store", siteLogo: () => null },
        "@/lib/content/resolve": { resolvedContentPageList: async () => [] },
        "@/components/checkout/CheckoutFlow": { __esModule: true, default: (p) => ((globalThis.__effCheckoutProps = plain(p)), null) },
        "@/lib/tenant-request": { tfetch: (fn) => tn.run(fn) },
    "@/lib/storefront-request": { tfetch: (fn) => tn.run(fn) },
      }),
    );
  }
  globalThis.__effCheckoutCart = cartId;
  globalThis.__effCheckoutProps = null;
  renderToStaticMarkup(await checkoutPage.get(tn.id).default());
  captured = globalThis.__effCheckoutProps;
  ok(captured, "CheckoutFlow was not rendered");
  return captured;
}

const CONTACT = { email: "snehal@mediastic.in", phone: "9000000001", name: "Effective Test" };
const ADDRESS = { line1: "1 Effective St", city: "Pune", state: "MH", pincode: "411001", country: "India" };
let orderSeq = 0;
async function placeOrder(tn, lines) {
  const cartId = await cartIn(tn, lines);
  return tn.run(async () => {
    const o = await O.createOrder({ cartId, contact: CONTACT, address: ADDRESS, paymentMethod: "cod", idempotencyKey: `eff-order-${++orderSeq}` });
    return o.id;
  });
}
const orderLines = (tn, id) => tn.run(async () => (await libsql.execute({ sql: "SELECT title, catalog_title, sku, is_gift FROM order_items WHERE order_id = ? ORDER BY position", args: [id] })).rows.map((r) => ({ ...r, is_gift: !!r.is_gift })));

async function renderConfirmation(tn, orderId) {
  const token = await tn.run(() => O.orderStatusToken(orderId));
  const conf = await loadComponent("app/(storefront)/checkout/confirmation/[orderId]/page.js", {
    "next/link": Link,
    "@/components/StoreImage": { __esModule: true, default: ({ alt }) => h("img", { alt }) },
    "next/navigation": nav,
    "@/components/analytics/TrackEvent": { __esModule: true, default: (p) => (tracked.push(plain(p)), null) },
    "@/lib/orders": O,
    "@/lib/format": format,
    "@/lib/ids": ids,
    "@/lib/tenant-request": { tfetch: (fn) => tn.run(fn) },
    "@/lib/storefront-request": { tfetch: (fn) => tn.run(fn) },
    // Phase 8 line 1: the "Expected by" line (no titles in it)
    "@/lib/tenant-context": await import("../lib/tenant-context.js"),
    "@/lib/delivery-estimate": await import("../lib/delivery-estimate.js"),
    "@/components/checkout/DeliveryEstimate": nothing,
  });
  const status = await loadComponent("app/(storefront)/orders/[orderId]/page.js", {
    "next/link": Link,
    "@/components/plugins/PluginSlot": nothing, // Phase 4 line 2: an async server component
    "@/components/StoreImage": { __esModule: true, default: ({ alt }) => h("img", { alt }) },
    "next/navigation": nav,
    "next/server": { after: () => {} },
    "@/lib/orders": O,
    "@/lib/order-projection": await import("../lib/order-projection.js"),
    "@/lib/format": format,
    "@/lib/site": { siteSupport: () => ({ email: null, phone: null }) },
    "@/lib/tenant-request": { tfetch: (fn) => tn.run(fn) },
    "@/lib/storefront-request": { tfetch: (fn) => tn.run(fn) },
  });
  tracked = [];
  const args = { params: Promise.resolve({ orderId }), searchParams: Promise.resolve({ t: token }) };
  return { confirmation: text(renderToStaticMarkup(await conf.default(args))), status: text(renderToStaticMarkup(await status.default(args))), purchase: tracked.find((x) => x.name === "purchase") };
}

let orderNew;
await t("order confirmation and the shopper's order page show 'New' (frozen on the order)", async () => {
  orderNew = await placeOrder(T, [[VID(1), 1]]);
  const r = await renderConfirmation(T, orderNew);
  ok(r.confirmation.includes("New") && !r.confirmation.includes("Old Whey"), `confirmation: ${r.confirmation.slice(0, 300)}`);
  ok(r.status.includes("New") && !r.status.includes("Old Whey"), `order page: ${r.status.slice(0, 300)}`);
  eq(r.purchase.data.items[0].name, "New", "purchase event:");
});

await t("search (SQL) finds 'New' at once, the old title no longer matches, and results sort by the title shown", async () => {
  const hit = await inT(() => repo.searchProductsInDb("New", 10));
  same(hit.hits.map((x) => [x.handle, x.title]), [["whey", "New"]], "search New");
  eq((await inT(() => repo.searchProductsInDb("Old", 10))).found, 0, "the old title still matches:");
  await setLive(T, 3, { title: "Aardvark Bar" });
  const all = await inT(() => repo.searchProductsInDb("shop", 10));
  same(all.hits.map((x) => x.title), ["Aardvark Bar", "Alpha Creatine", "New", "Steel Shaker"], "order by the effective title");
  // prefix rank on the effective title: "aard" ranks the renamed bar first even among protein matches
  same((await inT(() => repo.searchProductsInDb("aard", 10))).hits.map((x) => x.handle), ["bar"], "prefix:");
  await T.run(() => db.deleteFrom("product_content_live").where("product_id", "=", PID(3)).execute());
});

await t("wishlist, quiz results and the quiz email show 'New'; quiz scoring still uses Shopify's tags", async () => {
  const w = await inT(() => resolveWishlist([{ handle: "whey" }]));
  eq(w[0].title, "New", "wishlist:");
  const q = await inT(() => Quiz.recommendProducts(["protein"]));
  same(q.map((x) => x.title), ["Alpha Creatine", "New", "Zeta Bar"], "quiz picks (tag-scored, sorted by the title shown)");
  const email = await quizEmail(T, "New");
  ok(email.body.includes("· New — /products/whey") && !email.body.includes("Old Whey"), email.body);
});

// P4-OVL07 (from the P4-EFFECTIVE review): a display type that collides with
// a quiz tag. Quiz scoring reads Shopify's tags (logic_tags), never the type
// shown: a product whose shown type is "gear" (and has no gear tag) never
// matches the "gear" answer, and a product shown as "protein" whose tags say
// gear still does.
await t("quiz scoring ignores a display type that collides with a quiz tag (it scores on Shopify's tags only)", async () => {
  await setLive(T, 4, { display_type: "gear" }); // creatine: tags protein, shop
  await setLive(T, 2, { display_type: "protein" }); // shaker: tags gear, shop
  try {
    const gear = await inT(() => Quiz.recommendProducts(["gear"]));
    same(gear.map((x) => [x.handle, x.display_type, x.matches]), [["shaker", "protein", 1]], "the gear answer (tag-scored):");
    const protein = await inT(() => Quiz.recommendProducts(["protein"]));
    ok(!protein.some((x) => x.handle === "shaker"), `a shaker shown as protein matched the protein answer: ${JSON.stringify(protein)}`);
    ok(protein.some((x) => x.handle === "creatine" && x.display_type === "gear"), "creatine still matches protein by its tags, shown as gear");
  } finally {
    await clearLiveFor(4);
    await clearLiveFor(2);
  }
});

// P4-OVL07 (from the P4-EFFECTIVE review): the header search box, rendered
// with the hits the search route answers. Its hooks are stubbed to the state
// it holds after the shopper typed and the answer came back (no browser).
async function renderSearchBox(hits, typed) {
  const states = [typed, hits, [], false, true, -1]; // q, results, recent, loading, open, active (in the order the component asks)
  let i = 0;
  const hooks = { __esModule: true, ...React, useState: (init) => [i < states.length ? states[i++] : init, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v ?? null }) };
  const Box = await loadComponent("components/SearchBox.js", {
    react: hooks,
    "next/navigation": { useRouter: () => ({ push: () => {} }) },
    "next/link": Link,
    "@/components/StoreImage": { __esModule: true, default: ({ src, alt }) => h("img", { src, alt }) },
    "@/lib/format": format,
  });
  return renderToStaticMarkup(h(Box.default));
}

await t("the rendered header search box shows each hit's display_type (the type shown), never Shopify's product type", async () => {
  await setLive(T, 1, { title: "New", display_type: "Shakes" });
  const res = await inT(() => repo.searchProductsInDb("New", 8));
  const hit = res.hits.find((x) => x.handle === "whey");
  same([hit.display_type, hit.product_type], ["Shakes", undefined], "the hit:");
  const html = await renderSearchBox(res.hits, "New");
  ok(html.includes('href="/products/whey"') && html.includes(">New<"), `the hit is in the box: ${html.slice(0, 400)}`);
  ok(text(html).includes("Shakes"), `the type shown: ${text(html)}`);
  ok(!text(html).includes("Protein"), "Shopify's product type shows in the box");
  // a Typesense-shaped hit (product_type) shows the same once displayHits maps it
  const mapped = E.displayHits({ hits: [{ handle: "bar", title: "Zeta Bar", product_type: "Snacks", price: 100, currency: "INR" }] }).hits;
  ok(text(await renderSearchBox(mapped, "Zeta")).includes("Snacks"), "a mapped Typesense hit's type");
  await setLive(T, 1, { title: "New" });
});

async function quizEmail(tn, marker) {
  await tn.run(() => Quiz.upsertQuiz({ slug: "finder", title: "Find it", questions: [{ prompt: "Goal?", options: [{ label: "Strength", tags: ["protein"] }, { label: "Gear", tags: ["gear"] }] }] }, { enabled: true }));
  quizRoute ??= await import("../app/api/quiz/[slug]/route.js");
  globalThis.__effAfter = [];
  globalThis.__effRequest = { host: `${tn.id}.test`, cookies: {} };
  const req = new NextRequest(`https://${tn.id}.test/api/quiz/finder`, { method: "POST", headers: { host: `${tn.id}.test`, "content-type": "application/json" }, body: JSON.stringify({ answers: { q1: "q1o1" }, email: "snehal@mediastic.in", consent: true }) });
  const res = await quizRoute.POST(req, { params: Promise.resolve({ slug: "finder" }) });
  eq(res.status, 200, "quiz status:");
  const body = await res.json();
  for (const fn of globalThis.__effAfter.splice(0)) await tn.run(fn);
  const row = await tn.run(async () => (await libsql.execute("SELECT subject, body FROM notifications WHERE type = 'quiz_result' ORDER BY created_at DESC LIMIT 1")).rows[0]);
  ok(row, "no quiz email was queued");
  return { body: String(row.body), products: body.products, marker };
}

await t("bundle components and the pairs strip (manual and automatic) show 'New'; automatic pairs sort by the title shown", async () => {
  await inT(() => B.upsertBundle({ slug: "duo", title: "Duo", items: [{ variantId: VID(1) }, { variantId: VID(4) }], bundle_price: 1200, enable: true }));
  const bundle = await inT(() => B.getBundle("duo"));
  same(bundle.components.map((c) => c.title), ["New", "Alpha Creatine"], "bundle components");
  // automatic: creatine shares two collections with whey and bar, one with shaker
  await setLive(T, 3, { title: "Aardvark Bar" });
  const auto = await inT(() => getPdpPairs(PID(4), { limit: 4 }));
  same(auto.products.map((p) => p.title), ["Aardvark Bar", "New", "Steel Shaker"], "automatic pairs, by shared count then the title shown");
  await T.run(() => db.deleteFrom("product_content_live").where("product_id", "=", PID(3)).execute());
  const pdp = await renderProduct(T, "shaker");
  ok(pdp.html.includes(">New<"), "the pairs strip on the rendered page");
});

// =============================================================================
// 4. description_html
// =============================================================================
console.log("— 4. a published description");

await t("a published description_html renders on the page and feeds the meta description and JSON-LD description", async () => {
  await setLive(T, 1, { title: "New", description_html: "<p>Founder <b>words</b> &amp; more</p><script>alert(1)</script>" });
  const r = await renderProduct(T, "whey");
  ok(r.html.includes("Founder <b>words</b>"), "rendered (sanitized) html");
  ok(!r.html.includes("alert(1)") && !r.html.includes("from <b>Shopify</b>"), "script or Shopify's description shown");
  eq(r.meta.description, "Founder words & more", "meta description (derived plain text):");
  eq(r.meta.openGraph.description, "Founder words & more", "og description:");
  eq(r.ld[0].description, "Founder words & more", "JSON-LD description:");
  // a published plain description wins for the meta; the html stays the page body
  await setLive(T, 1, { title: "New", description_html: "<p>Founder html</p>", description: "Founder plain" });
  const r2 = await renderProduct(T, "whey");
  same([r2.meta.description, r2.ld[0].description, r2.html.includes("<p>Founder html</p>")], ["Founder plain", "Founder plain", true], "plain + html");
  // seo fields, when published, lead (OVL-08 chain)
  await setLive(T, 1, { title: "New", seo_title: "New | best whey", seo_description: "Seo words", og_image: "https://cdn.shopify.com/fx/og.png" });
  const r3 = await renderProduct(T, "whey");
  same([r3.meta.title, r3.meta.description, r3.meta.openGraph.images[0].url, r3.ld[0].name], ["New | best whey", "Seo words", "https://cdn.shopify.com/fx/og.png", "New"], "seo");
  await setLive(T, 1, { title: "New" });
});

// =============================================================================
// 5. display type and vendor
// =============================================================================
console.log("— 5. display type and vendor: shown, never logic");

const PROTEIN_OFFER = { id: "protein-10", type: "TIERED_QTY", scope: "line", priority: 20, title: "Protein 10% off", target: { kind: "productType", value: "Protein" }, tiers: [{ minQty: 1, percent: 10 }] };
const SHAKES_OFFER = { id: "shakes-50", type: "TIERED_QTY", scope: "line", priority: 10, title: "Shakes 50% off", target: { kind: "productType", value: "Shakes" }, tiers: [{ minQty: 1, percent: 50 }] };

await t("a display type and vendor show on the card, search, breadcrumb, vendor line and JSON-LD", async () => {
  await setLive(T, 1, { title: "New", display_type: "Shakes", display_vendor: "Founder Co" });
  const card = (await inT(() => repo.getNewestProducts(10))).find((p) => p.handle === "whey");
  eq(card.display_type, "Shakes", "card row:");
  eq(card.product_type, undefined, "a card has no product_type:");
  ok(renderCard(card).includes(">Shakes<"), "rendered card label");
  const s = await inT(() => repo.searchProductsInDb("Shakes", 10));
  same(s.hits.map((x) => [x.handle, x.display_type]), [["whey", "Shakes"]], "search finds and labels it");
  same((await inT(() => repo.searchProductsInDb("Founder", 10))).hits.map((x) => x.handle), ["whey"], "search by the vendor shown");
  const r = await renderProduct(T, "whey");
  ok(r.crumbs.includes("/ Shakes /"), `breadcrumb: ${r.crumbs}`);
  ok(text(r.html).includes("Founder Co"), "vendor line");
  ok(!text(r.html).includes("Shopify Labs"), "Shopify's vendor still shown");
  eq(r.ld[0].brand.name, "Founder Co", "JSON-LD brand:");
  for (const tpl of ["editorial"]) {
    template = tpl;
    const e = await renderProduct(T, "whey");
    ok(text(e.html).includes("Founder Co") && e.h1 === "New", `${tpl} template`);
    template = "classic";
  }
  const page = await inT(() => repo.getProductByHandle("whey"));
  same([page.display_type, page.logic_type, page.display_vendor, page.product_type, page.vendor, page.tags], ["Shakes", "Protein", "Founder Co", undefined, undefined, undefined], "page row keys");
});

await t("negative: a display type never changes which offers apply, or which type filter or facet a product falls under", async () => {
  await inT(() => upsertOffer({ offer: PROTEIN_OFFER }));
  await inT(() => upsertOffer({ offer: SHAKES_OFFER }));
  const id = await cartIn(T, [[VID(1), 1]]);
  const cart = await inT(() => Cart.getCart(id));
  same(cart.appliedOffers.filter((o) => o.type === "TIERED_QTY").map((o) => o.id), ["protein-10"], "offers on the raw type");
  eq(cart.items[0].discount, 100, "10% of 1000:");
  const protein = await inT(() => repo.getProductsInCollection("all", { type: "Protein" }));
  same([protein.products.map((p) => p.handle).sort(), protein.total], [["creatine", "whey"], 2], "the raw type filter");
  same(await inT(() => repo.getProductsInCollection("all", { type: "Shakes" })), { products: [], total: 0 }, "the display type is no filter");
  same(await inT(() => repo.getCollectionTypeFacets("all")), [{ type: "Protein", count: 2 }, { type: "Gear", count: 1 }, { type: "Snacks", count: 1 }], "facets");
  await inT(() => deleteOffer("protein-10"));
  await inT(() => deleteOffer("shakes-50"));
  await setLive(T, 1, { title: "New" });
});

// =============================================================================
// 6. Orders and gifts
// =============================================================================
console.log("— 6. orders freeze the title shown and Shopify's; gifts too");

await t("a gift line shows the published title in the cart, with Shopify's title and the SKU on the server", async () => {
  const before = await inT(async () => Cart.getCart(await cartIn(T, [[VID(1), 1]])));
  same(before.gifts.map((g) => [g.title, g.catalog_title, g.sku]), [["Stored Shaker Name", "Steel Shaker", "SKU-2"]], "no published title: the offer's stored title");
  await setLive(T, 2, { title: "Gift Shaker" });
  const cart = await inT(async () => Cart.getCart(await cartIn(T, [[VID(1), 1]])));
  same(cart.gifts.map((g) => [g.title, g.catalog_title, g.sku, g.offerId]), [["Gift Shaker", "Steel Shaker", "SKU-2", "gift-shaker"]], "gift line");
  // an empty-string published title is a real value
  await setLive(T, 2, { title: "" });
  eq((await inT(async () => Cart.getCart(await cartIn(T, [[VID(1), 1]])))).gifts[0].title, "", "empty string kept:");
  await setLive(T, 2, { title: "Gift Shaker" });
});

let pastOrder;
await t("an order freezes the effective title and Shopify's title and SKU, for normal and gift lines", async () => {
  pastOrder = await placeOrder(T, [[VID(1), 1], [VID(3), 1]]);
  same(await orderLines(T, pastOrder), [
    { title: "New", catalog_title: "Old Whey", sku: "SKU-1", is_gift: false },
    { title: "Zeta Bar", catalog_title: "Zeta Bar", sku: "SKU-3", is_gift: false },
    { title: "Gift Shaker", catalog_title: "Steel Shaker", sku: "SKU-2", is_gift: true },
  ], "order lines");
  const snap = await T.run(async () => JSON.parse((await libsql.execute({ sql: "SELECT snapshot FROM orders WHERE id = ?", args: [pastOrder] })).rows[0].snapshot));
  same(snap.items.map((i) => [i.title, i.catalog_title, i.sku]), [["New", "Old Whey", "SKU-1"], ["Zeta Bar", "Zeta Bar", "SKU-3"]], "snapshot items");
  same(snap.gifts.map((g) => [g.title, g.catalog_title, g.sku]), [["Gift Shaker", "Steel Shaker", "SKU-2"]], "snapshot gifts");
});

await t("negative: a past order is unchanged after a later title change", async () => {
  const before = { lines: await orderLines(T, pastOrder), snap: await T.run(async () => (await libsql.execute({ sql: "SELECT snapshot FROM orders WHERE id = ?", args: [pastOrder] })).rows[0].snapshot) };
  await setLive(T, 1, { title: "Newer" });
  await setLive(T, 2, { title: "Gift Shaker 2" });
  same(await orderLines(T, pastOrder), before.lines, "order lines changed");
  eq(await T.run(async () => (await libsql.execute({ sql: "SELECT snapshot FROM orders WHERE id = ?", args: [pastOrder] })).rows[0].snapshot), before.snap, "snapshot changed:");
  const r = await renderConfirmation(T, pastOrder);
  ok(r.confirmation.includes("New") && !r.confirmation.includes("Newer"), "the confirmation still shows what was bought");
  await setLive(T, 1, { title: "New" });
  await setLive(T, 2, { title: "Gift Shaker" });
});

// =============================================================================
// 7. What reaches a browser
// =============================================================================
console.log("— 7. no cart reaching a browser carries Shopify's title or the SKU");

const SERVER_ONLY = ["catalog_title", "sku"];
const cartRoute = await import("../app/api/cart/route.js");
const checkoutRoute = await import("../app/api/checkout/route.js");
async function callCart(tn, method, body, cookie) {
  globalThis.__effRequest = { host: `${tn.id}.test`, cookies: {} };
  const req = new NextRequest(`https://${tn.id}.test/api/cart`, { method, headers: { host: `${tn.id}.test`, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await cartRoute[method](req);
  return { status: res.status, body: await res.json(), cookie: res.cookies.get(Cart.CART_COOKIE)?.value };
}

await t("shopperCart strips catalog_title and sku from items and gift lines and keeps everything else", async () => {
  const id = await cartIn(T, [[VID(1), 1]]);
  const full = await inT(() => Cart.getCart(id));
  ok(hasKeyDeep(full.items, SERVER_ONLY) && hasKeyDeep(full.gifts, SERVER_ONLY), "the server cart has them");
  const shown = Cart.shopperCart(full);
  ok(!hasKeyDeep(shown, SERVER_ONLY), JSON.stringify(shown).slice(0, 300));
  const back = structuredClone(full);
  for (const l of [...back.items, ...back.gifts]) for (const k of SERVER_ONLY) delete l[k];
  same(shown, back, "nothing else changed");
  same(Cart.shopperCart(Cart.emptyCart()), Cart.emptyCart(), "empty cart");
});

await t("/api/cart: every answer (add, change, a bad action, read) has no catalog_title or sku, gifts included", async () => {
  const add = await callCart(T, "POST", { action: "add", variantId: VID(1), quantity: 1 });
  eq(add.status, 200, "add:");
  const cookie = `${Cart.CART_COOKIE}=${add.cookie}`;
  const answers = [add, await callCart(T, "POST", { action: "setQty", variantId: VID(1), quantity: 2 }, cookie), await callCart(T, "POST", { action: "nope" }, cookie), await callCart(T, "POST", { action: "add", variantId: "gid://shopify/ProductVariant/0" }, cookie), await callCart(T, "GET", null, cookie)];
  same(answers.map((a) => a.status), [200, 200, 400, 400, 200], "statuses");
  for (const a of answers) ok(!hasKeyDeep(a.body, SERVER_ONLY), JSON.stringify(a.body).slice(0, 300));
  const read = answers.at(-1).body;
  same([read.items[0].title, read.gifts[0].title], ["New", "Gift Shaker"], "titles still there");
});

await t("the storefront layout's initial cart (CartProvider's prop) has no catalog_title or sku", async () => {
  const id = await cartIn(T, [[VID(1), 1]]);
  const anyModule = (idStr) => new Proxy({ __esModule: true }, { get: (o, k) => (k === "__esModule" ? true : k in o ? o[k] : () => ({ variable: "" })) });
  const layout = await loadComponent(
    "app/(storefront)/layout.js",
    {
      "next/headers": { cookies: async () => ({ get: (n) => (n === Cart.CART_COOKIE ? { value: id } : undefined) }), headers: async () => ({ get: () => "effr.test" }) },
      "@/lib/cart": Cart,
      "@/lib/tenant-request": { tfetch: (fn) => T.run(fn), requestResolution: async () => ({ outcome: "resolved" }) },
    },
    { append: "\nmodule.exports.__initialCart = initialCart;", fallback: anyModule },
  );
  const cart = plain(await layout.__initialCart());
  eq(cart.items[0].title, "New", "the layout's cart:");
  ok(!hasKeyDeep(cart, SERVER_ONLY), JSON.stringify(cart).slice(0, 300));
  const src = stripComments(await readReal("app/(storefront)/layout.js"));
  ok(/const \[collections, cart, chrome\] = await Promise\.all\(\[collectionsRead, initialCart\(markets\.market\), chromeRead\]\)/.test(src), "the layout's cart comes from initialCart()");
  eq((src.match(/<CartProvider initialCart=\{cart\}>/g) || []).length, 1, "CartProvider gets that cart:");
});

await t("the checkout page's CheckoutFlow prop has no catalog_title or sku", async () => {
  const props = await renderCheckout(T, await cartIn(T, [[VID(1), 1]]));
  same([props.cart.items[0].title, props.cart.gifts[0].title], ["New", "Gift Shaker"], "titles");
  ok(!hasKeyDeep(props.cart, SERVER_ONLY), JSON.stringify(props.cart).slice(0, 300));
});

async function callCheckout(tn, cartId, body) {
  globalThis.__effAfter = [];
  globalThis.__effRequest = { host: `${tn.id}.test`, cookies: { [Cart.CART_COOKIE]: cartId } };
  const req = new NextRequest(`https://${tn.id}.test/api/checkout`, { method: "POST", headers: { host: `${tn.id}.test`, "content-type": "application/json", cookie: `${Cart.CART_COOKIE}=${cartId}` }, body: JSON.stringify(body) });
  const res = await checkoutRoute.POST(req);
  globalThis.__effAfter = []; // the Shopify push and events are not run here
  return { status: res.status, body: await res.json() };
}

await t("/api/checkout: the price-changed answer's cart has no catalog_title or sku, and the order still freezes them", async () => {
  const cartId = await cartIn(T, [[VID(1), 1]]);
  const refused = await callCheckout(T, cartId, { action: "cod", idempotencyKey: `eff-co-${++orderSeq}`, contact: CONTACT, address: ADDRESS, expectedTotal: 1, expectedShipping: 0 });
  same([refused.status, refused.body.code], [409, "PRICE_CHANGED"], "refused");
  eq(refused.body.cart.items[0].title, "New", "the refusal's cart:");
  ok(!hasKeyDeep(refused.body, SERVER_ONLY), JSON.stringify(refused.body.cart).slice(0, 300));
  // the same cart, at the right amount: the order is made from the FULL cart
  const placed = await callCheckout(T, cartId, { action: "cod", idempotencyKey: `eff-co-${++orderSeq}`, contact: CONTACT, address: ADDRESS, expectedTotal: refused.body.total, expectedShipping: refused.body.shippingTotal });
  eq(placed.status, 200, `placed: ${JSON.stringify(placed.body)}`);
  ok(!hasKeyDeep(placed.body, SERVER_ONLY), "the order answer");
  same(await orderLines(T, placed.body.orderId), [
    { title: "New", catalog_title: "Old Whey", sku: "SKU-1", is_gift: false },
    { title: "Gift Shaker", catalog_title: "Steel Shaker", sku: "SKU-2", is_gift: true },
  ], "createOrder received Shopify's title and the SKU");
});

await t("every getCart reaching app/ is wrapped in shopperCart, except the checkout API's (it feeds createOrder, and its one answer that carries a cart is projected)", async () => {
  const appFiles = (await walk(join(ROOT, "app"))).map((f) => relative(ROOT, f));
  const calls = [];
  for (const f of appFiles) {
    const src = stripComments(await readReal(f));
    for (const m of src.matchAll(/\bgetCart\s*\(/g)) calls.push({ f, wrapped: /shopperCart\(\s*(?:await\s+)?(?:tfetch\(\(\)\s*=>\s*)?$/.test(src.slice(Math.max(0, m.index - 60), m.index)) });
  }
  const unwrapped = calls.filter((c) => !c.wrapped).map((c) => c.f);
  same([...new Set(unwrapped)].sort(), ["app/api/cart/route.js", "app/api/checkout/route.js"], "files with a bare getCart call");
  const cartSrc = stripComments(await readReal("app/api/cart/route.js"));
  ok(/getCart as fullCart/.test(cartSrc) && /const cartFor = \(request\) => async \(id\) => shopperCart\(await fullCart\(id \|\| null, \{ market: requestMarket\(request\)\.market \}\)\);/.test(cartSrc), "the cart route's getCart is the projection");
  const co = stripComments(await readReal("app/api/checkout/route.js"));
  const answers = [...co.matchAll(/NextResponse\.json\(/g)].map((m) => co.slice(m.index, co.indexOf(");", m.index)));
  ok(answers.length > 5, "the checkout API's answers were found");
  same(answers.filter((a) => /[{,]\s*cart\s*[,}]|[{,]\s*cart\s*:(?!\s*shopperCart\()/.test(a)), [], "a checkout answer carries an unprojected cart");
  ok(co.includes("cart: shopperCart(cart)"), "the price-changed answer projects its cart");
});

// =============================================================================
// 8. Drafts never reach shoppers
// =============================================================================
console.log("— 8. a draft-only edit never reaches the cart, search, the sitemap or an email");

await t("a draft (documents.draft, no live row) is read nowhere: cart, search, sitemap, quiz email, order", async () => {
  const draft = { v: 1, type: "product_content", settings: { title: { value: "DRAFT-ONLY-TITLE" }, display_type: { value: "DRAFT-ONLY-TYPE" }, description_html: { value: "<p>DRAFT-ONLY-HTML</p>" } } };
  await T.run(() => db.insertInto("documents").values({ id: "doc_prod_draft_only", type: "product_content", entity_id: PID(4), label: "Alpha Creatine", draft: JSON.stringify(draft), draft_hash: "h", revision: 1, schema_version: 1, created_at: NOW, updated_at: NOW }).execute());
  const id = await cartIn(T, [[VID(4), 1]]);
  const cart = await inT(() => Cart.getCart(id));
  eq(cart.items[0].title, "Alpha Creatine", "cart:");
  eq((await inT(() => repo.searchProductsInDb("DRAFT", 10))).found, 0, "search:");
  ok(!JSON.stringify(await inT(() => E.indexRows({ ids: [PID(4)] }))).includes("DRAFT-ONLY"), "the search index's source");
  globalThis.__effRequest = { host: "effr.test", cookies: {} };
  const sitemap = await import("../app/sitemap.js");
  const map = JSON.stringify(await sitemap.default());
  ok(map.includes("/products/creatine") && !map.includes("DRAFT-ONLY"), "sitemap");
  const email = await quizEmail(T, "draft");
  ok(email.body.includes("Alpha Creatine") && !email.body.includes("DRAFT-ONLY"), email.body);
  const page = await renderProduct(T, "creatine");
  ok(!page.html.includes("DRAFT-ONLY"), "product page");
  const order = await placeOrder(T, [[VID(4), 1]]);
  ok(!JSON.stringify(await orderLines(T, order)).includes("DRAFT-ONLY"), "order");
  await T.run(() => db.deleteFrom("documents").where("id", "=", "doc_prod_draft_only").execute());
});

// =============================================================================
// 9. Images, empty strings and indexRows
// =============================================================================
console.log("— 9. images and alt, empty strings, indexRows");

await t("a published featured image never pairs with Shopify's alt (alt follows its image)", async () => {
  await setLive(T, 4, { featured_image: "https://cdn.shopify.com/fx/founder.png" });
  const card = (await inT(() => repo.getNewestProducts(10))).find((p) => p.handle === "creatine");
  same([card.featured_image, card.featured_image_alt], ["https://cdn.shopify.com/fx/founder.png", null], "card image and alt");
  ok(renderCard(card).includes('alt="Alpha Creatine"'), "the card falls back to the title, never Shopify's alt");
  await setLive(T, 4, { featured_image: "https://cdn.shopify.com/fx/founder.png", featured_image_alt: "Founder alt" });
  same((await inT(() => E.byIds([PID(4)])))[0].featured_image_alt, "Founder alt", "own alt");
  // no published image: Shopify's image and Shopify's alt, together
  await setLive(T, 4, { title: "Creatine X" });
  const raw = (await inT(() => E.byIds([PID(4)])))[0];
  same([raw.featured_image, raw.featured_image_alt], ["https://cdn.shopify.com/fx/creatine-1.png", "Alpha Creatine front"], "Shopify's pair");
  await clearLiveFor(4);
});

await t("a published gallery replaces Shopify's photos on the product page; its first item is the featured image", async () => {
  const gallery = [{ url: "https://cdn.shopify.com/fx/g1.png", alt: "G one" }, { url: "/api/media/m2", alt: null }];
  await setLive(T, 4, { gallery: JSON.stringify(gallery), featured_image: gallery[0].url, featured_image_alt: gallery[0].alt });
  const page = await inT(() => repo.getProductByHandle("creatine"));
  same(page.images.map((i) => [i.url, i.alt, i.position]), [["https://cdn.shopify.com/fx/g1.png", "G one", 0], ["/api/media/m2", null, 1]], "images");
  same([page.featured_image, page.featured_image_alt], ["https://cdn.shopify.com/fx/g1.png", "G one"], "featured");
  const r = await renderProduct(T, "creatine");
  ok(r.html.includes("g1.png") && !r.html.includes("creatine-2.png"), "rendered gallery");
  same(r.ld[0].image, ["https://cdn.shopify.com/fx/g1.png", "/api/media/m2"], "JSON-LD images");
  // a gallery with no featured_image column still leads with its first item
  await setLive(T, 4, { gallery: JSON.stringify(gallery) });
  same((await inT(() => repo.getProductByHandle("creatine"))).featured_image, "https://cdn.shopify.com/fx/g1.png", "lead from the gallery");
  same((await inT(() => E.byIds([PID(4)])))[0].featured_image_alt, null, "card: no Shopify alt with the founder's gallery");
  await clearLiveFor(4);
});

await t("an empty-string published value is respected (COALESCE keeps it)", async () => {
  await setLive(T, 4, { display_type: "", display_vendor: "", description: "", description_html: "" });
  const page = await inT(() => repo.getProductByHandle("creatine"));
  same([page.display_type, page.display_vendor, page.description, page.description_html], ["", "", "", ""], "page");
  const r = await renderProduct(T, "creatine");
  ok(!text(r.html).includes("Shopify Labs") && !r.html.includes("from <b>Shopify</b>"), "Shopify's vendor or description shown");
  ok(r.crumbs.includes("/ Product /"), `an empty label shows the neutral word: ${r.crumbs}`);
  const card = (await inT(() => repo.getNewestProducts(10))).find((p) => p.handle === "creatine");
  eq(card.display_type, "", "card:");
  await clearLiveFor(4);
});

await t("indexRows pages through every product with no gaps or repeats, with effective values and raw logic", async () => {
  await setLive(T, 1, { title: "New", display_type: "Shakes" });
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await inT(() => E.indexRows({ cursor, limit: 3 }));
    seen.push(...page.rows);
    cursor = page.cursor;
    pages++;
    ok(pages < 10, "no end");
  } while (cursor);
  same(seen.map((r) => r.id), PRODUCTS.map((p) => p.id).sort(), "ids, in order, once each");
  eq(pages, 2, "pages of 3 over 4 products:");
  const whey = seen.find((r) => r.id === PID(1));
  same(
    { title: whey.title, display_type: whey.display_type, logic_type: whey.logic_type, logic_tags: whey.logic_tags, display_vendor: whey.display_vendor, handle: whey.handle, price_min: whey.price_min, available: whey.available, collection_ids: whey.collection_ids.sort(), featured_image: whey.featured_image, description: whey.description },
    { title: "New", display_type: "Shakes", logic_type: "Protein", logic_tags: ["protein", "shop"], display_vendor: "Shopify Labs", handle: "whey", price_min: 1000, available: true, collection_ids: ["gid://shopify/Collection/71", "gid://shopify/Collection/72"], featured_image: "https://cdn.shopify.com/fx/whey-1.png", description: "Old Whey from Shopify" },
    "whey's index row",
  );
  // exactly a full last page still ends
  const exact = await inT(() => E.indexRows({ limit: 4 }));
  eq(exact.rows.length, 4, "a page of 4:");
  eq((await inT(() => E.indexRows({ cursor: exact.cursor, limit: 4 }))).rows.length, 0, "then nothing:");
  // and on a tenant with no live table, the same shape
  same((await T23.run(() => E.indexRows({ limit: 10 }))).rows.map((r) => [r.id, r.title, r.display_type]), PRODUCTS.map((p) => [p.id, p.title, p.productType]).sort((a, b) => a[0].localeCompare(b[0])), "0023 rows");
  await setLive(T, 1, { title: "New" });
});

await t("indexRows({ids}) returns exactly those products' effective rows and skips ids that are not products", async () => {
  const r = await inT(() => E.indexRows({ ids: [PID(3), PID(1), "gid://shopify/Product/404", PID(1)] }));
  same(r.rows.map((x) => [x.id, x.title]), [[PID(1), "New"], [PID(3), "Zeta Bar"]], "rows");
  eq(r.cursor, null, "cursor:");
  same(await inT(() => E.indexRows({ ids: [] })), { rows: [], cursor: null }, "no ids");
  same(await inT(() => E.indexRows({ ids: ["gid://shopify/Product/404"] })), { rows: [], cursor: null }, "only a gone id");
});

// =============================================================================
// 10. Edge safety and cost
// =============================================================================
console.log("— 10. edge safety and statement counts");

await t("no node: import is reachable from effective.js (lib/tenant-context.js's node:async_hooks, which the edge runtime provides, is the only one)", async () => {
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
  const seen = new Set();
  const queue = [EFFECTIVE];
  const hits = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = stripComments(await readReal(f));
    for (const m of src.matchAll(nodeImport)) hits.push(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const r = await resolveSpec(f, m[1]);
      if (r) queue.push(r);
    }
  }
  same(hits, ["lib/tenant-context.js: node:async_hooks"], "node imports reachable from effective.js");
  ok(seen.has("lib/db.js") && seen.has("lib/schema-compat.js"), [...seen].join(", "));
});

async function count(tn, fn) {
  return tn.run(async () => {
    await fn(); // warm: the live-table probe and the offer read's own caches
    const { statements } = await watchStatements(currentDatabase().libsql, fn);
    return statements;
  });
}

await t("the effective join adds no statement: getCart and the product page cost the same with and without the live table", async () => {
  await clearLive(T);
  const cartT = await cartIn(T, [[VID(3), 1]]); // under the gift threshold
  const cart23 = await cartIn(T23, [[VID(3), 1]]);
  const a = await count(T, () => Cart.getCart(cartT));
  const b = await count(T23, () => Cart.getCart(cart23));
  eq(a.length, b.length, `getCart: ${a.join(" | ")} vs ${b.join(" | ")}\n   `);
  eq(a.length, 3, "getCart statements (cart, lines, offers), as before:");
  ok(a.some((s) => /product_content_live/.test(s)), "the join rides on the lines read");
  const p = await count(T, () => repo.getProductByHandle("whey"));
  const p23 = await count(T23, () => repo.getProductByHandle("whey"));
  eq(p.length, 3, "product page statements (product, photos, variants), as before:");
  eq(p23.length, 3, "at 0023:");
  await setLive(T, 1, { title: "New", gallery: JSON.stringify([{ url: "https://cdn.shopify.com/fx/g.png", alt: null }]) });
  eq((await count(T, () => repo.getProductByHandle("whey"))).length, 2, "a published gallery skips Shopify's photos:");
  // a gift costs one statement, only when a gift applies
  const gift = await cartIn(T, [[VID(1), 1]]);
  eq((await count(T, () => Cart.getCart(gift))).length, 4, "getCart with a gift:");
  await setLive(T, 1, { title: "New" });
});

await t("the live-table probe runs once per database, and a database without the table is asked again only after a minute", async () => {
  const { __schemaCompat } = await import("../lib/schema-compat.js");
  __schemaCompat.forget();
  const probes = async (tn) => (await tn.run(() => watchStatements(currentDatabase().libsql, async () => {
    for (let i = 0; i < 3; i++) await repo.getNewestProducts(2);
  }))).statements.filter((s) => /FROM product_content_live LIMIT 0/i.test(s)).length;
  eq(await probes(T), 1, "newest schema: one probe, then remembered:");
  eq(await probes(T), 0, "and never again:");
  eq(await probes(T23), 1, "0023: one probe:");
  eq(await probes(T23), 0, "then not inside the minute:");
  __schemaCompat.forget();
  __schemaCompat.setRecheckMs(0);
  eq(await probes(T23), 3, "after the window, asked again (window set to 0 here):");
  __schemaCompat.forget();
});

await t("a joined read that still meets 'no such table' is answered raw, with the same shape", async () => {
  const { __schemaCompat } = await import("../lib/schema-compat.js");
  __schemaCompat.forget();
  E.__effective.forgetRawWindow();
  // the probe sees the table, then it goes away before the read (a race the probe cannot see)
  const tn = await F.makeTenant({ name: "effrace", stage: "latest", products: PRODUCTS.slice(0, 1) });
  await tn.run(() => E.liveTableReady());
  await tn.run(() => libsql.execute("DROP TABLE product_content_live"));
  const row = await tn.run(() => repo.getProductByHandle("whey"));
  same([row.title, row.display_type, row.display_vendor, row.seo_title], ["Old Whey", "Protein", "Shopify Labs", null], "raw read");
  same((await tn.run(() => repo.getNewestProducts(5))).map((p) => p.title), ["Old Whey"], "and the next read, raw at once");
  await tn.cleanup();
  E.__effective.forgetRawWindow();
  __schemaCompat.forget();
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const tn of [T, TL, T23]) await tn.cleanup();
await platform.cleanup();
for (const n of ["effr", "effl", "eff23", "effrace"]) await F.removeFixtureFiles(n);
process.exit(fail ? 1 : 0);
