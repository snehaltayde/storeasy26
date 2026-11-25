// Phase 7 line 3: the phone buy bar and the cart drawer's nudges, without a browser.
//   1. the bar's markup per state (add, adding, view, sold out, choose): its
//      words, data-protected="buy-bar", no data-part, no plugin slot, inert
//      while hidden, below lg only, the safe-area inset, no slide with reduced
//      motion; the product page renders it hidden with the chosen variant;
//   2. the cart: POST /api/cart ignores a `progress` or `discount` body field,
//      a cart id nobody holds reads as an empty cart, and no payload carries
//      tags or productType (lines or progress);
//   3. the drawer total equals checkout's server total, and a tampered
//      checkout body (a lower total, a discount, a progress) still gets the
//      confirm-the-total 409. The Razorpay API is a local stub; nothing pays.
//   node scripts/test-mobile-buy.js
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import React from "react";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-mobile-buy-default.db";
process.env.PLATFORM_DB_URL = "file:.test-mobile-buy-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
delete process.env.CHECKOUT_MODE;
const dbs = [".test-mobile-buy-default.db", ".test-mobile-buy-platform.db", ".test-mobile-buy-t.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

globalThis.__mbAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__mbAfter.push(fn); };`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: SERVER_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m} expected ${B}, got ${A}`);
};

// ---- the components, compiled by Next's SWC (test-theme-render's loader, trimmed) ----------
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (await swc.transform(await readFile(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
const STUBS = {
  "@/components/StoreImage": { __esModule: true, default: ({ src, alt }) => React.createElement("img", { src, alt }) },
};
const seen = new Map();
async function loadJsx(file) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in STUBS || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolvePath(dirname(file), id);
    if (!target.endsWith(".js")) target = existsSync(`${target}.js`) ? `${target}.js` : join(target, "index.js");
    deps.set(id, /^(components)\//.test(relative(ROOT, target)) ? await loadJsx(target) : await import(pathToFileURL(target).href));
  }
  const req = (id) => (id in STUBS ? STUBS[id] : id === "react" ? React : id === "react/jsx-runtime" ? require("react/jsx-runtime") : deps.get(id));
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
const Bar = await loadJsx(join(ROOT, "components/pdp/StickyBuyBar.js"));
const ProductPurchase = (await loadJsx(join(ROOT, "components/ProductPurchase.js"))).default;
const { CartProvider } = await loadJsx(join(ROOT, "components/cart/CartContext.js"));

const barHtml = (props) => renderToStaticMarkup(React.createElement(Bar.default, { visible: true, title: "Whey 1kg", image: "https://cdn.shopify.com/x.png", variantLabel: "M · Red", price: 1299, compareAt: 1599, currency: "INR", state: "add", ...props }));
const buttonOf = (h) => h.match(/<button\b[^>]*>([^<]*)<\/button>/);

console.log("— 1. the buy bar");
await t("each state's words: Add to cart, Adding…, View cart, Sold out, Choose size", async () => {
  const words = {};
  for (const state of ["add", "adding", "view", "soldout", "choose"]) words[state] = buttonOf(barHtml({ state, chooseLabel: "Choose size" }))?.[1];
  eq(words, { add: "Add to cart", adding: "Adding…", view: "View cart", soldout: "Sold out", choose: "Choose size" }, "labels:");
  ok(/\sdisabled=""/.test(buttonOf(barHtml({ state: "soldout" }))[0]), "sold out is disabled");
  ok(/aria-busy="true"/.test(buttonOf(barHtml({ state: "adding" }))[0]), "adding is busy (and has no action: no double tap)");
  ok(!/\sdisabled=""/.test(buttonOf(barHtml({ state: "add" }))[0]), "add is enabled");
});
await t("the bar shows the title, the chosen variant, the price and compare-at, and a thumbnail", async () => {
  const h = barHtml({});
  for (const s of ["Whey 1kg", "M · Red", "₹1,299", "₹1,599", "<img"]) ok(h.includes(s), `missing ${s}`);
  ok(!barHtml({ compareAt: 1299 }).includes("line-through"), "no compare-at when it isn't higher");
});
await t('data-protected="buy-bar", no data-part, no plugin slot; below lg; safe-area inset; no slide with reduced motion', async () => {
  const h = barHtml({}).replace(/^<link[^>]*>/, ""); // React hoists the thumbnail's preload
  ok(h.startsWith('<div data-protected="buy-bar"'), h.slice(0, 80));
  ok(!h.includes("data-part") && !h.includes("data-plugin"), "a theme hook or plugin slot inside");
  for (const c of ["lg:hidden", "env(safe-area-inset-bottom)", "motion-reduce:transition-none", "z-30"]) ok(h.includes(c), `missing ${c}`);
});
await t("hidden: inert and aria-hidden, off screen; shown: neither", async () => {
  const hidden = barHtml({ visible: false });
  ok(/\sinert=""/.test(hidden) && /aria-hidden="true"/.test(hidden) && hidden.includes("translate-y-full"), hidden.slice(0, 300));
  const shown = barHtml({ visible: true });
  ok(!/\sinert=""/.test(shown) && !/aria-hidden="true"/.test(shown.slice(0, 200)), shown.slice(0, 300));
});
const variant = (id, size, colour, available = true, price = 400) => ({ id, price, compare_at_price: null, available, image_url: null, selectedOptions: [{ name: "Size", value: size }, { name: "Colour", value: colour }] });
const PRODUCT = {
  title: "Sized Tee",
  handle: "sized-tee",
  featured_image: "https://cdn.shopify.com/tee.png",
  currency: "INR",
  available: true,
  price_min: 400,
  options: [{ name: "Size", values: ["S", "M"] }, { name: "Colour", values: ["Red", "Blue"] }],
  variants: [variant("v-s-red", "S", "Red", false), variant("v-m-red", "M", "Red"), variant("v-m-blue", "M", "Blue")],
};
const pdpHtml = (product) => renderToStaticMarkup(React.createElement(CartProvider, { initialCart: null }, React.createElement(ProductPurchase, { product })));
await t("the product page renders the bar hidden (until the Add button scrolls away) with the first in-stock variant chosen", async () => {
  const h = pdpHtml(PRODUCT);
  const bar = h.slice(h.indexOf('data-protected="buy-bar"') - 5);
  ok(/data-state="add"/.test(bar) && /\sinert=""/.test(bar), bar.slice(0, 200));
  ok(bar.includes("M · Red"), "the chosen variant's words");
  ok(h.includes('data-option-group="Size"') && h.includes('role="group"'), "the option groups carry their hook for Choose");
});
await t("a sold-out product's bar says Sold out", async () => {
  const h = pdpHtml({ ...PRODUCT, available: false, variants: PRODUCT.variants.map((v) => ({ ...v, available: false })) });
  ok(/data-state="soldout"/.test(h) && h.includes(">Sold out</button>"), "sold out state");
});

// ---- 2 and 3: a real store ------------------------------------------------------------------
const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const { createCart, addItem, getCart, shopperCart, CART_COOKIE } = await import("../lib/cart.js");
const { SHIPPING_CONFIG } = await import("../lib/shipping.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { NextRequest } = require("next/server.js");
const cartRoute = await import("../app/api/cart/route.js");
const checkoutRoute = await import("../app/api/checkout/route.js");

const HOST = "mb.test";
const TENANT = { id: "mb", name: "Mobile Buy", domains: [HOST], dbUrl: "file:.test-mobile-buy-t.db", secrets: { order_link_secret: "mb-link-secret", razorpay_key_secret: "mb-test-key-secret" } };
const RATES = { ...SHIPPING_CONFIG, flatRate: 79, freeThreshold: 1499, codFee: 49 };
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ ...TENANT, config: { shipping_config: RATES, razorpay_key_id: "rzp_test_mobile" } });
const inT = async (fn) => withTenant(await C.getTenant("mb"), fn);
const OFFERS = [
  { id: "tier-tee", type: "TIERED_QTY", label: "Tee tiers", config: { scope: "line", priority: 30, title: "Tee Tiers", target: { kind: "tag", value: "internal-tee-tag" }, tiers: [{ minQty: 2, percent: 10 }] } },
  { id: "gift-cap", type: "FREE_GIFT", label: "Free cap", config: { scope: "gift", priority: 40, title: "Free cap over ₹999", threshold: 999, gift: { variantId: "gid://t/VCAP", title: "Cap", value: 199 } } },
];
await inT(async () => {
  await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));
  await db.insertInto("products").values({ id: "gid://t/P1", handle: "sized-tee", title: "Sized Tee", product_type: "Secret Type", price_min: 400, price_max: 400, currency: "INR", available: 1, tags: JSON.stringify(["internal-tee-tag"]) }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "M / Blue", price: 400, currency: "INR", available: 1 }).execute();
  const now = new Date().toISOString();
  for (const o of OFFERS) await db.insertInto("offers").values({ id: o.id, type: o.type, label: o.label, enabled: 1, config: JSON.stringify(o.config), created_at: now, updated_at: now }).execute();
  await db.insertInto("offers").values({ id: "gift-off", type: "FREE_GIFT", label: "Off", enabled: 0, config: JSON.stringify({ scope: "gift", priority: 1, title: "Off", threshold: 100, gift: { variantId: "gid://t/VX", title: "Hidden gift" } }), created_at: now, updated_at: now }).execute();
  const { emptyList } = await import("../lib/content/documents-reader.js");
  await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), now, now] });
  await libsql.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [now] });
});

async function cartPost(cartId, body) {
  const req = new NextRequest(`https://${HOST}/api/cart`, { method: "POST", headers: { host: HOST, "content-type": "application/json", ...(cartId ? { cookie: `${CART_COOKIE}=${cartId}` } : {}) }, body: JSON.stringify(body) });
  const res = await cartRoute.POST(req);
  return { status: res.status, body: await res.json() };
}
async function cartGet(cartId) {
  const res = await cartRoute.GET(new NextRequest(`https://${HOST}/api/cart`, { headers: { host: HOST, cookie: `${CART_COOKIE}=${cartId}` } }));
  return res.json();
}
const noLogic = (cart) => {
  const s = JSON.stringify(cart);
  return !/"tags"|"productType"|internal-tee-tag|Secret Type/.test(s);
};

console.log("— 2. the cart");
const CART = "mb-cart-1";
await inT(() => createCart(CART));
await t("POST /api/cart ignores a progress or discount field: the server's numbers and nudges come back", async () => {
  const r = await cartPost(CART, { action: "add", variantId: "gid://t/V1", quantity: 1, progress: { nudges: [{ kind: "spend", text: "Free everything", remaining: 0 }] }, discount: 400, discountTotal: 400, total: 0 });
  eq(r.status, 200, "status:");
  eq([r.body.subtotal, r.body.discountTotal, r.body.total], [400, 0, 400], "subtotal, discount, total:");
  eq(r.body.progress.nudges.map((n) => n.text), ["Add ₹600 more for a free Cap", "Add 1 more for 10% off · Tee Tiers"], "nudges:");
  ok(!JSON.stringify(r.body).includes("Free everything") && !JSON.stringify(r.body).includes("Hidden gift"), "a posted or inactive nudge came back");
  const bad = await cartPost(CART, { action: "setProgress", progress: {} });
  eq(bad.status, 400, "an unknown action:");
});
await t("the tier nudge, done (Add 1 more), makes the offer line appear and the spend bar move", async () => {
  const before = await cartGet(CART);
  const tier = before.progress.nudges.find((n) => n.kind === "tier");
  const r = await cartPost(CART, { action: "setQty", variantId: tier.variantId, quantity: 1 + tier.add });
  ok(r.body.appliedOffers.some((o) => o.id === "tier-tee" && o.amount === 80), JSON.stringify(r.body.appliedOffers));
  const spend = (c) => c.progress.nudges.find((n) => n.kind === "spend");
  ok(spend(r.body).percent > spend(before).percent, `${spend(before).percent} → ${spend(r.body).percent}`);
  eq(spend(r.body).text, "Add ₹200 more for a free Cap", "spend words:");
});
await t("no cart payload carries tags or productType (lines or progress), nor a target value", async () => {
  ok(noLogic(await cartGet(CART)), JSON.stringify(await cartGet(CART)).slice(0, 400));
  ok(noLogic((await cartPost(CART, { action: "setCoupon", coupon: null })).body), "POST answer");
});
await t("a cart id nobody holds reads as an empty cart (another shopper's cart is never guessed into)", async () => {
  const c = await cartGet("mb-not-a-cart");
  eq([c.items.length, c.subtotal, c.progress.nudges.length], [0, 0, 0], "empty:");
});

console.log("— 3. checkout");
const razorpayCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.razorpay.com/")) {
    const sent = JSON.parse(init.body);
    razorpayCalls.push(sent);
    return new Response(JSON.stringify({ id: `order_mb${razorpayCalls.length}`, amount: sent.amount, currency: sent.currency }), { status: 200 });
  }
  if (realFetch) return realFetch(url, init);
  throw new Error(`unexpected fetch ${url}`);
};
const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Mobile Buy Test" };
const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
let keys = 0;
async function checkout(cartId, body) {
  const req = new NextRequest(`https://${HOST}/api/checkout`, { method: "POST", headers: { host: HOST, "content-type": "application/json", cookie: `${CART_COOKIE}=${cartId}` }, body: JSON.stringify({ contact: CONTACT, address: ADDRESS, idempotencyKey: `mb-key-${++keys}`, ...body }) });
  const res = await checkoutRoute.POST(req);
  return { status: res.status, body: await res.json() };
}
await t("a tampered checkout body (lower total, a discount, a progress) still gets the confirm-the-total 409 with the drawer's total", async () => {
  const drawer = await cartGet(CART);
  const r = await checkout(CART, { action: "razorpay_create", expectedTotal: drawer.grandTotal - 80, expectedShipping: drawer.shipping.total, discount: 9999, discountTotal: 9999, progress: { nudges: [] } });
  eq(r.status, 409, "status:");
  eq(r.body.code, "PRICE_CHANGED", "code:");
  eq(r.body.total, drawer.grandTotal, "the server's total is the drawer's:");
  eq(razorpayCalls.length, 0, "no payment order was made:");
});
await t("the drawer's total is the amount checkout asks for (prepaid): the payment order is minted for it", async () => {
  const drawer = await cartGet(CART);
  const r = await checkout(CART, { action: "razorpay_create", expectedTotal: drawer.grandTotal, expectedShipping: drawer.shipping.total });
  eq(r.status, 200, `status (${JSON.stringify(r.body).slice(0, 200)}):`);
  eq(razorpayCalls.at(-1)?.amount, Math.round(drawer.grandTotal * 100), "Razorpay amount (paise):");
  const full = await inT(() => getCart(CART));
  eq(shopperCart(full).grandTotal, drawer.grandTotal, "same read:");
});

for (const f of dbs) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
