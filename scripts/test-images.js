// Library photos through next/image (P1-IMAGES). Three layers:
//   1. unit: lib/image-src.js says which srcs are library photos;
//   2. source: every next/image in app/, components/ and lib/ goes through
//      components/StoreImage.js, and the media route still picks the store
//      from the request's host;
//   3. rendered: the real StoreImage, ProductGallery, ProductCard and
//      CollectionCard, compiled with Next's own SWC and rendered with
//      react-dom/server and the real next/image. A library photo must come out
//      as its own /api/media url, never as /_next/image?url=/api/media/…
//      (which answers 400: the optimizer's request has no Host). A Shopify
//      photo goes to Shopify's CDN with ?width= (shopifyLoader), not /_next/image.
// None of this is a browser. The browser proof is in docs/cms-reviews/P1-IMAGES.md.
//   pnpm test:images
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};

const LIB = "/api/media/med_ae5f4af4b10aec0b01";
const LIB2 = "/api/media/med_194a107989db40261d";
const SHOP = "https://cdn.shopify.com/s/files/1/0001/products/whey.jpg";
const OPTIMIZED_LIB = /\/_next\/image\?url=%2Fapi%2Fmedia/;

// ---- 1. unit ------------------------------------------------------------------
let isLibraryMedia = () => {
  throw new Error("lib/image-src.js is missing");
};
try {
  ({ isLibraryMedia } = await import("../lib/image-src.js"));
} catch {
  /* reported by the tests below */
}

await t("a library photo (/api/media/<id>) is library media, in every shape next/image takes", () => {
  ok(isLibraryMedia(LIB), LIB);
  ok(isLibraryMedia(`${LIB}?v=2`), "with a query");
  ok(isLibraryMedia({ src: LIB, width: 10, height: 10 }), "static-import shape");
});

await t("NEGATIVE: nothing else is library media (Shopify, public files, look-alikes, empty values)", () => {
  for (const s of [
    SHOP,
    "https://shop.example/api/media/med_ae5f4af4b10aec0b01", // absolute: not ours to fetch raw
    "//evil.example/api/media/med_x",
    "/api/mediax/med_x",
    "/api/media",
    "/icons/icon-192.png",
    "api/media/med_x",
    "",
    null,
    undefined,
    42,
    {},
  ]) {
    ok(!isLibraryMedia(s), `${JSON.stringify(s)} should not be library media`);
  }
});

// ---- 2. source ----------------------------------------------------------------
async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(m?js|jsx|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...(await sourceFiles("app")), ...(await sourceFiles("components")), ...(await sourceFiles("lib"))];

await t("every next/image in app/, components/ and lib/ goes through components/StoreImage.js", async () => {
  const offenders = [];
  let wrapper = false;
  for (const f of files) {
    const src = await readFile(join(ROOT, f), "utf8");
    const uses = /from\s+["']next\/(legacy\/)?image["']|require\(\s*["']next\/(legacy\/)?image["']\s*\)|import\(\s*["']next\/(legacy\/)?image["']\s*\)/.test(src);
    if (!uses) continue;
    if (f === join("components", "StoreImage.js")) wrapper = true;
    else offenders.push(f);
  }
  ok(wrapper, "components/StoreImage.js doesn't exist or doesn't use next/image");
  ok(!offenders.length, `these import next/image directly, so a library photo there goes to the optimizer and 400s: ${offenders.join(", ")}`);
});

await t("the components that show photos use StoreImage (directly or through FadeImage)", async () => {
  const want = {
    "components/FadeImage.js": "@/components/StoreImage",
    "components/ProductGallery.js": "@/components/StoreImage",
    "components/CollectionCard.js": "@/components/StoreImage",
    "components/cart/CartDrawer.js": "@/components/StoreImage",
    "components/checkout/CheckoutFlow.js": "@/components/StoreImage",
    "components/SearchBox.js": "@/components/StoreImage",
    "components/QuizRunner.js": "@/components/StoreImage",
    "app/(storefront)/bundles/[slug]/page.js": "@/components/StoreImage",
    "app/(storefront)/orders/[orderId]/page.js": "@/components/StoreImage",
    "app/(storefront)/checkout/confirmation/[orderId]/page.js": "@/components/StoreImage",
  };
  for (const [f, mod] of Object.entries(want)) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(src.includes(`from "${mod}"`), `${f} should import ${mod}`);
  }
});

await t("NEGATIVE: the media route still answers only for the store whose host asked", async () => {
  const src = await readFile(join(ROOT, "app/api/media/[id]/route.js"), "utf8");
  ok(/export const GET = tenantHandler\(/.test(src), "GET must be wrapped in tenantHandler");
  ok(!/allowUnresolved/.test(src), "the media route must not serve a request whose host resolves to no store");
  const cfg = await readFile(join(ROOT, "next.config.mjs"), "utf8");
  ok(!/dangerouslyAllowSVG/.test(cfg), "library SVGs must not go through the optimizer");
  ok(!/loaderFile|loader\s*:/.test(cfg), "a global image loader would change every image; this fix doesn't use one");
});

// ---- 3. rendered --------------------------------------------------------------
// next/image takes its config from the build (__NEXT_IMAGE_OPTS) or, failing
// that, from ImageConfigContext. Give it the app's real images config through
// the context, so the Shopify host is allowed the same way it is in the app.
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const appImages = (await import("../next.config.mjs")).default.images || {};
const imageConfig = { ...imageConfigDefault, ...appImages };

const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const stubs = {
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
};
const cache = new Map();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  const code = await compile(file);
  const local = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs) continue;
    const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
    if (target) local.set(id, await load(target.endsWith(".js") ? target : `${target}.js`));
  }
  new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const comp = async (f) => {
  try {
    return (await load(join(ROOT, f))).default;
  } catch (e) {
    return () => {
      throw new Error(`${relative(ROOT, join(ROOT, f))} didn't load: ${e.message}`);
    };
  }
};
const html = (C, props) =>
  renderToStaticMarkup(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, React.createElement(C, props)));
const srcs = (h) => [...h.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

const StoreImage = await comp("components/StoreImage.js");
const ProductGallery = await comp("components/ProductGallery.js");
const ProductCard = await comp("components/ProductCard.js");
const CollectionCard = await comp("components/CollectionCard.js");

await t("StoreImage: a library photo is its own url, with no srcset to the optimizer", () => {
  const h = html(StoreImage, { src: LIB, alt: "", fill: true, sizes: "48px" });
  ok(srcs(h)[0] === LIB, `src was ${srcs(h)[0]}`);
  ok(!OPTIMIZED_LIB.test(h), `rendered ${h}`);
  ok(!/srcset=/i.test(h), "no srcset for an unoptimized photo");
});

await t("StoreImage: a Shopify photo is resized by Shopify's CDN (?width=), never /_next/image", () => {
  const h = html(StoreImage, { src: SHOP, alt: "", fill: true, sizes: "48px" });
  ok(srcs(h)[0].startsWith(`${SHOP}?width=`), `src was ${srcs(h)[0]}`);
  ok(!/_next\/image/.test(h), `rendered ${h}`);
  ok(/srcset=/i.test(h) && /width=\d+ \d+w/.test(h.replace(/&amp;/g, "&")), "srcset with Shopify widths kept");
});

await t("StoreImage: an explicit unoptimized still wins", () => {
  const h = html(StoreImage, { src: SHOP, alt: "", width: 10, height: 10, unoptimized: true });
  ok(srcs(h)[0] === SHOP, `src was ${srcs(h)[0]}`);
});

await t("product page gallery: library photos (main and thumbnails) render as /api/media urls", () => {
  const h = html(ProductGallery, { title: "Creatine", images: [{ url: LIB, alt: "a" }, { url: LIB2, alt: "b" }] });
  const s = srcs(h);
  ok(s.length >= 3, `expected the main photo and 2 thumbnails, got ${s.length}`);
  ok(!OPTIMIZED_LIB.test(h), `a library photo went to the optimizer: ${s.join(" | ")}`);
  ok(s.includes(LIB) && s.includes(LIB2), `srcs ${s.join(" | ")}`);
});

await t("product page gallery: Shopify photos are resized by Shopify's CDN", () => {
  const h = html(ProductGallery, { title: "Whey", images: [{ url: SHOP, alt: "" }] });
  ok(srcs(h).every((s) => s.startsWith(`${SHOP}?width=`)), srcs(h).join(" | "));
});

await t("product card and collection card: library photos render as /api/media urls", () => {
  const card = html(ProductCard, { product: { handle: "c", title: "Creatine", featured_image: LIB, price_min: 100, price_max: 100, currency: "INR" } });
  ok(!OPTIMIZED_LIB.test(card) && srcs(card).includes(LIB), `product card: ${srcs(card).join(" | ")}`);
  const coll = html(CollectionCard, { collection: { handle: "p", title: "Protein", image: LIB2, product_count: 3 } });
  ok(!OPTIMIZED_LIB.test(coll) && srcs(coll).includes(LIB2), `collection card: ${srcs(coll).join(" | ")}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
