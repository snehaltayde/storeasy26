// OVL-06 suite: orders can be matched in Shopify, and reports stay whole.
//   1. The cart carries Shopify's title (catalog_title) and the SKU next to the
//      title the shopper sees; an order freezes both on its lines (migration
//      0018) and in its snapshot, and a later rename never rewrites them.
//   2. The console order page, compiled with Next's SWC and rendered with
//      react-dom/server on a real tenant database, shows "Shopify title: X,
//      SKU: Y" only when the shopper saw another title. Old orders render
//      exactly as before.
//   3. Top products and AI insights count one product as one row, by product
//      id, under its current title.
//   4. Neither value reaches Shopify through the real push.
// P4-EFFECTIVE: "the shopper saw another title" is now a real published title,
// a product_content_live row (what a publish writes), read through
// lib/catalog/effective.js. Before OVL-03 it was faked by editing the cart's
// `title` by hand.
//   pnpm test:order-catalog
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-ocat-default.db";
process.env.PLATFORM_DB_URL = "file:.test-ocat-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-ocat-default.db", ".test-ocat-platform.db", ".test-ocat-t.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db, libsql } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "oc", name: "Order Catalog", domains: ["oc.test"], dbUrl: "file:.test-ocat-t.db", config: {}, secrets: { order_link_secret: "oc-secret" } });
const inT = async (fn) => withTenant(await C.getTenant("oc"), fn);
const TENANT_MIGRATIONS = await loadMigrations("tenant");
await inT(() => runMigrations(libsql, TENANT_MIGRATIONS));

const { createCart, addItem, getCart } = await import("../lib/cart.js");
const O = await import("../lib/orders.js");
const { writeProduct, deleteProductByGid } = await import("../lib/sync.js");
const Rep = await import("../lib/reporting.js");
const AI = await import("../lib/ai/insights.js");
const P = await import("../lib/shopify-push.js");
const view = await import("../lib/admin/order-view.js");

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
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const same = (a, b, m = "") => {
  const A1 = JSON.stringify(a);
  const B1 = JSON.stringify(b);
  if (A1 !== B1) throw new Error(`${m}\n      got: ${A1.slice(0, 500)}\n   wanted: ${B1.slice(0, 500)}`);
};

// ---- catalog, written through the real sync writer ----------------------------
const P1 = "gid://shopify/Product/201";
const V1 = "gid://shopify/ProductVariant/2011";
const P2 = "gid://shopify/Product/202";
const V2 = "gid://shopify/ProductVariant/2021";
const P3 = "gid://shopify/Product/203";
const V3 = "gid://shopify/ProductVariant/2031";
const shopifyProduct = (id, handle, title, variantId, sku, price) => ({
  id,
  handle,
  title,
  description: `${title} description`,
  descriptionHtml: `<p>${title}</p>`,
  productType: "Protein",
  vendor: "Test Labs",
  tags: ["protein"],
  priceRange: { minVariantPrice: { amount: String(price), currencyCode: "INR" }, maxVariantPrice: { amount: String(price), currencyCode: "INR" } },
  availableForSale: true,
  featuredImage: { url: `https://cdn.shopify.com/${handle}.png`, altText: title },
  images: { nodes: [{ url: `https://cdn.shopify.com/${handle}.png`, altText: title }] },
  options: [],
  variants: { nodes: [{ id: variantId, title: "Default Title", sku, price: { amount: String(price), currencyCode: "INR" }, availableForSale: true, selectedOptions: [], image: null }] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
await inT(async () => {
  await writeProduct(shopifyProduct(P1, "whey-gold", "Whey Gold", V1, "WG-1KG", 1000));
  await writeProduct(shopifyProduct(P2, "steel-shaker", "Steel Shaker", V2, "SH-750", 200));
  await writeProduct(shopifyProduct(P3, "plain-scoop", "Plain Scoop", V3, null, 50));
});

const CONTACT = { email: "matcher@example.test", phone: "9000000002", name: "Order Matcher" };
const ADDRESS = { line1: "2 Match St", city: "Pune", state: "MH", pincode: "411001", country: "India" };
let seq = 0;
async function cartWith(lines) {
  const id = `ocat-cart-${++seq}`;
  await createCart(id);
  for (const [variantId, qty] of lines) await addItem(id, variantId, qty);
  return id;
}
// `retitle`: a published title (a live row) for these products while the order
// is placed, removed again after, so the shopper saw another title than Shopify's.
const publishTitle = (productId, title) =>
  db.insertInto("product_content_live").values({ product_id: productId, document_id: "doc_prod_ocat", version_id: "ver_ocat", title, published_at: "2026-11-04T00:00:00.000Z" }).onConflict((oc) => oc.column("product_id").doUpdateSet({ title })).execute();
async function placeOrder(lines, { retitle = {}, method = "cod" } = {}) {
  return inT(async () => {
    for (const [pid, title] of Object.entries(retitle)) await publishTitle(pid, title);
    try {
      const cartId = await cartWith(lines);
      const cart = await getCart(cartId);
      const o = await O.createOrder({ cartId, cart, contact: CONTACT, address: ADDRESS, paymentMethod: method, idempotencyKey: `ocat-${seq}`, razorpayOrderId: method === "razorpay" ? `order_oc${seq}` : null });
      if (method === "razorpay") await O.markOrderPaid(o.id, { razorpayPaymentId: `pay_oc${seq}` });
      return o.id;
    } finally {
      await db.deleteFrom("product_content_live").execute();
    }
  });
}
const rawLines = (orderId) => inT(async () => (await libsql.execute({ sql: "SELECT * FROM order_items WHERE order_id = ? ORDER BY position", args: [orderId] })).rows.map((r) => ({ ...r })));
const rawSnapshot = (orderId) => inT(async () => (await libsql.execute({ sql: "SELECT snapshot FROM orders WHERE id = ?", args: [orderId] })).rows[0].snapshot);

// =============================================================================
console.log("— 1. frozen at order time");

await t("cart lines carry Shopify's title and the SKU next to the title the shopper sees", async () => {
  const cart = await inT(async () => getCart(await cartWith([[V1, 2], [V3, 1]])));
  const whey = cart.items.find((i) => i.variantId === V1);
  same({ title: whey.title, catalog_title: whey.catalog_title, sku: whey.sku }, { title: "Whey Gold", catalog_title: "Whey Gold", sku: "WG-1KG" }, "whey line");
  eq(cart.items.find((i) => i.variantId === V3).sku, null, "a variant with no SKU:");
});

// P1-FIX-C (MIG-05/OVL-06 review) asked for proof that catalog_title is the
// raw catalog column and never the line's title; until OVL-03 the two were
// always equal, so it was a source check. P4-EFFECTIVE: it is now behaviour (a
// published title differs from Shopify's), plus the updated source pin: the
// cart takes catalog_title from effective.js cartRows, where it is p.title.
await t("the cart's catalog_title is Shopify's raw title, never the line's (published) title", async () => {
  const cart = await inT(async () => {
    await publishTitle(P1, "Morning Whey");
    try {
      return await getCart(await cartWith([[V1, 1]]));
    } finally {
      await db.deleteFrom("product_content_live").execute();
    }
  });
  same([cart.items[0].title, cart.items[0].catalog_title], ["Morning Whey", "Whey Gold"], "title, catalog_title");
  const src = (await readFile(join(ROOT, "lib/cart.js"), "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const assigned = [...src.matchAll(/\bcatalog_title:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  same(assigned, ["r.catalog_title", "i.catalog_title", "null", "r.catalog_title ?? null"], "every catalog_title in lib/cart.js (lines, the response, a gift not in the catalog, a gift)");
  const eff = await readFile(join(ROOT, "lib/catalog/effective.js"), "utf8");
  ok(/\n\s*catalog_title: \["p\.title", "p\.title"\],/.test(eff), "effective.js catalog_title is no longer the products table's own title column, live or raw");
  ok(/cols\(live, \["title", "catalog_title", "featured_image", "logic_tags", "logic_type"\]\)/.test(eff), "cartRows no longer selects catalog_title");
});

let firstOrder;
await t("an order freezes catalog_title and sku on its lines and in its snapshot", async () => {
  firstOrder = await placeOrder([[V1, 1], [V2, 1]], { retitle: { [P1]: "Morning Whey" } });
  const lines = await rawLines(firstOrder);
  same(
    lines.map((l) => [l.title, l.catalog_title, l.sku]),
    [
      ["Morning Whey", "Whey Gold", "WG-1KG"],
      ["Steel Shaker", "Steel Shaker", "SH-750"],
    ],
    "order_items",
  );
  const snap = JSON.parse(await rawSnapshot(firstOrder));
  same(
    snap.items.map((i) => [i.title, i.catalog_title, i.sku]),
    [
      ["Morning Whey", "Whey Gold", "WG-1KG"],
      ["Steel Shaker", "Steel Shaker", "SH-750"],
    ],
    "snapshot items",
  );
});

await t("negative: a rename and new SKU in Shopify (through the real sync writer) rewrite no past order", async () => {
  const before = { lines: await rawLines(firstOrder), snapshot: await rawSnapshot(firstOrder) };
  await inT(() => writeProduct(shopifyProduct(P1, "whey-gold", "Whey Gold Isolate", V1, "WGI-1KG", 1000)));
  same(await rawLines(firstOrder), before.lines, "order_items changed");
  eq(await rawSnapshot(firstOrder), before.snapshot, "snapshot changed:");
  // new carts see the new values
  const cart = await inT(async () => getCart(await cartWith([[V1, 1]])));
  same([cart.items[0].catalog_title, cart.items[0].sku], ["Whey Gold Isolate", "WGI-1KG"], "a new cart");
});

// =============================================================================
console.log("— 2. the console order page (rendered)");

const compile = async (src) =>
  (
    await swc.transform(src, {
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const JSX_RUNTIME = require("react/jsx-runtime");
async function loadComponent(src, stubs) {
  const code = await compile(src);
  const mod = { exports: {} };
  const req = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "react/jsx-runtime") return JSX_RUNTIME;
    if (id === "react") return React;
    throw new Error(`unstubbed import "${id}"`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  return mod.exports;
}
const h = React.createElement;
const nothing = { __esModule: true, default: () => null };
const PAGE = "app/(console)/admin/(authed)/orders/[id]/page.js";
// Phase 2 line 2: the lines (and the OVL-06 line under them) moved from the
// page into components/admin/orders/OrderLines.js, rendered here for real;
// the page's other parts are stand-ins.
const LINES = "components/admin/orders/OrderLines.js";
const pageSrc = await readFile(join(ROOT, PAGE), "utf8");
const linesSrc = await readFile(join(ROOT, LINES), "utf8");
const authz = await import("../lib/platform/authz.js");
const projection = await import("../lib/order-projection.js");
const push = await import("../lib/shopify-push.js");
const adminUrl = await import("../lib/admin/shopify-admin-url.js");
const reporting = await import("../lib/reporting.js");
const format = await import("../lib/format.js");
const box = (tag) => ({ children }) => h(tag, null, children);
const UI_STUBS = {
  "@/components/ui/card": { Card: box("section"), CardHeader: box("header"), CardTitle: box("h2"), CardContent: box("div"), CardDescription: box("p") },
  "@/components/ui/badge": { Badge: box("span") },
};
async function renderOrderPage(orderId, { role = "owner", src = linesSrc } = {}) {
  const lines = await loadComponent(src, { ...UI_STUBS, "@/lib/format": format, "@/lib/admin/order-view": view });
  const page = await loadComponent(pageSrc, {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "session" }) }) },
    "next/navigation": {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: () => {
        throw new Error("redirect");
      },
    },
    "@/lib/admin-auth": { adminActor: async () => ({ role }), ADMIN_COOKIE: "admin", PLATFORM_COOKIE: "platform" },
    // Everything that reads the order is real, on the real tenant database.
    "@/lib/orders": O,
    "@/lib/shopify-push": push,
    "@/lib/platform/authz": authz,
    "@/lib/order-projection": projection,
    // Phase 8 line 2: the COD check label (no COD code on these orders)
    "@/lib/checkout/cod-otp": { codCheckChannel: async () => null, codCheckWords: () => null },
    "@/lib/admin/order-view": view,
    "@/lib/admin/shopify-admin-url": adminUrl,
    "@/lib/reporting": reporting,
    // console pages read the store through lib/console-request.js (P1-FIX-C)
    "@/lib/console-request": { tfetch: inT },
    ...UI_STUBS,
    // icons render nothing here (the design pass's EyeOff and any later one)
    "lucide-react": new Proxy({ __esModule: true }, { get: (t, k) => (k in t ? t[k] : () => null) }),
    "@/components/admin/orders/OrderHeader": { OrderHeader: ({ order }) => h("header", null, order.id) },
    "@/components/admin/orders/OrderActions": { OrderActions: () => null },
    "@/components/admin/orders/OrderLines": lines,
    "@/components/admin/orders/OrderTimeline": { OrderTimeline: () => null },
    "@/components/admin/orders/LatePaymentBanner": { LatePaymentBanner: () => null }, // Phase 9 line 2
    "@/components/admin/settings/NoAccess": { NoAccess: () => null },
  });
  return renderToStaticMarkup(await page.default({ params: Promise.resolve({ id: orderId }) }));
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
// Each line's row, as plain text.
const rows = (html) => [...html.matchAll(/<li data-order-line="true"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));

// The lines as they were before OVL-06: the new line taken out. P4-SEARCH: the
// line's class is lib/admin/order-view.js SHOPIFY_LINE_CLASS (the muted text
// colour, 4.5:1 or better), no longer the subtle one.
const NEW_LINE = /\n\s*\{shopifyLines\[i\] && <p className=\{SHOPIFY_LINE_CLASS\}>\{shopifyLines\[i\]\}<\/p>\}/g;
const pageWithoutNewLine = () => {
  const n = (linesSrc.match(NEW_LINE) || []).length;
  eq(n, 1, "the new line, found in OrderLines' source:");
  return linesSrc.replace(NEW_LINE, "");
};

await t("an order for a retitled product shows both titles: the shopper's, then Shopify title and SKU", async () => {
  const id = await placeOrder([[V1, 1], [V2, 1]], { retitle: { [P1]: "Morning Whey" } });
  const r = rows(await renderOrderPage(id));
  eq(r.length, 2, "lines:");
  ok(r[0].startsWith("Morning Whey"), `first line: ${r[0]}`);
  ok(r[0].includes("Shopify title: Whey Gold Isolate, SKU: WGI-1KG"), `first line: ${r[0]}`);
  ok(!r[1].includes("Shopify title"), `a line with one title shows only one: ${r[1]}`);
});

await t("an order whose titles match shows no extra line", async () => {
  const id = await placeOrder([[V1, 1], [V2, 1]]);
  const html = await renderOrderPage(id);
  ok(!html.includes("Shopify title"), text(html));
  eq(html, await renderOrderPage(id, { src: pageWithoutNewLine() }), "differs from the page without the new line:");
});

await t("an old order with no Shopify title renders exactly as before this change", async () => {
  const id = "OC-OLD-1";
  await inT(async () => {
    const ts = "2026-02-01T00:00:00.000Z";
    await db.insertInto("orders").values({ id, idempotency_key: "ocat-old-1", status: "synced", payment_method: "cod", payment_status: "cod", total: 1000, subtotal: 1000, discount_total: 0, currency: "INR", snapshot: JSON.stringify({ v: 1, items: [{ variantId: V1, productId: P1, title: "Whey Gold Classic", quantity: 1, lineTotal: 1000 }] }), sync_attempts: 1, created_at: ts, updated_at: ts }).execute();
    await db.insertInto("order_items").values({ order_id: id, variant_id: V1, product_id: P1, title: "Whey Gold Classic", unit_price: 1000, quantity: 1, line_total: 1000, line_discount: 0, is_gift: 0, position: 0 }).execute();
  });
  const html = await renderOrderPage(id);
  ok(!html.includes("Shopify title"), text(html));
  eq(html, await renderOrderPage(id, { src: pageWithoutNewLine() }), "differs from the page without the new line:");
});

await t("an order placed before its tenant was migrated still shows the line, from the snapshot", async () => {
  const id = "OC-GAP-1";
  await inT(async () => {
    const ts = "2026-02-02T00:00:00.000Z";
    const snap = { v: 1, items: [{ variantId: V2, productId: P2, title: "Shaker Pro", catalog_title: "Steel Shaker", sku: "SH-750", quantity: 1, lineTotal: 200 }] };
    await db.insertInto("orders").values({ id, idempotency_key: "ocat-gap-1", status: "cod_pending", payment_method: "cod", payment_status: "cod", total: 200, subtotal: 200, discount_total: 0, currency: "INR", snapshot: JSON.stringify(snap), sync_attempts: 0, created_at: ts, updated_at: ts }).execute();
    await db.insertInto("order_items").values({ order_id: id, variant_id: V2, product_id: P2, title: "Shaker Pro", unit_price: 200, quantity: 1, line_total: 200, line_discount: 0, is_gift: 0, position: 0 }).execute();
  });
  const r = rows(await renderOrderPage(id));
  ok(r[0].includes("Shopify title: Steel Shaker, SKU: SH-750"), r[0]);
});

// P1-FIX-C (MIG-05/OVL-06 review): every gap-window order above has one line,
// so taking the snapshot's FIRST item for every line passed. Two lines, each
// retitled, and the snapshot listing them in the other order: each line must
// find its own item by variant.
await t("an order placed before migrating, with two lines: each line shows its own Shopify title and SKU", async () => {
  const id = "OC-GAP-2";
  await inT(async () => {
    const ts = "2026-02-03T00:00:00.000Z";
    const snap = {
      v: 1,
      items: [
        { variantId: V2, productId: P2, title: "Shaker Pro", catalog_title: "Steel Shaker", sku: "SH-750", quantity: 1, lineTotal: 200 },
        { variantId: V1, productId: P1, title: "Morning Whey", catalog_title: "Whey Gold Isolate", sku: "WGI-1KG", quantity: 1, lineTotal: 1000 },
      ],
    };
    await db.insertInto("orders").values({ id, idempotency_key: "ocat-gap-2", status: "cod_pending", payment_method: "cod", payment_status: "cod", total: 1200, subtotal: 1200, discount_total: 0, currency: "INR", snapshot: JSON.stringify(snap), sync_attempts: 0, created_at: ts, updated_at: ts }).execute();
    await db.insertInto("order_items").values({ order_id: id, variant_id: V1, product_id: P1, title: "Morning Whey", unit_price: 1000, quantity: 1, line_total: 1000, line_discount: 0, is_gift: 0, position: 0 }).execute();
    await db.insertInto("order_items").values({ order_id: id, variant_id: V2, product_id: P2, title: "Shaker Pro", unit_price: 200, quantity: 1, line_total: 200, line_discount: 0, is_gift: 0, position: 1 }).execute();
  });
  const r = rows(await renderOrderPage(id));
  eq(r.length, 2, "lines:");
  ok(r[0].startsWith("Morning Whey") && r[0].includes("Shopify title: Whey Gold Isolate, SKU: WGI-1KG"), `first line (whey): ${r[0]}`);
  ok(r[1].startsWith("Shaker Pro") && r[1].includes("Shopify title: Steel Shaker, SKU: SH-750"), `second line (shaker): ${r[1]}`);
  ok(!r[0].includes("Steel Shaker") && !r[1].includes("Whey Gold"), "a line shows another line's Shopify title");
});

await t("the support role sees the Shopify line, and still no customer details", async () => {
  const id = await placeOrder([[V2, 1]], { retitle: { [P2]: "Shaker Pro" } });
  const html = await renderOrderPage(id, { role: "support" });
  ok(rows(html)[0].includes("Shopify title: Steel Shaker, SKU: SH-750"), rows(html)[0]);
  ok(!html.includes(CONTACT.email) && !html.includes(ADDRESS.line1), "customer details shown to support");
  // support's order has its snapshot hidden, so the line must come from the unredacted items
  const gap = await renderOrderPage("OC-GAP-1", { role: "support" });
  ok(rows(gap)[0].includes("Shopify title: Steel Shaker, SKU: SH-750"), `support, order placed before migrating: ${rows(gap)[0]}`);
});

await t("the line's wording: no SKU, gifts, and missing values", async () => {
  eq(view.shopifyMatchLine({ title: "Scoop Max", catalog_title: "Plain Scoop", sku: null }), "Shopify title: Plain Scoop", "no SKU:");
  eq(view.shopifyMatchLine({ title: "Whey", catalog_title: "Whey", sku: "W-1" }), null, "same title:");
  eq(view.shopifyMatchLine({ title: "Whey", catalog_title: null, sku: "W-1" }), null, "no Shopify title:");
  eq(view.shopifyMatchLine(null), null, "no line:");
  // a gift line never borrows a paid line's snapshot values
  eq(view.shopifyMatchLine({ title: "Free Shaker", is_gift: true, variant_id: V2 }, [{ variantId: V2, title: "x", catalog_title: "Steel Shaker" }]), null, "gift:");
});

// =============================================================================
console.log("— 3. reports: one product, one row, current title");

// A fresh product so only these orders count. It is sold under two titles, then
// renamed a third time, so the report's title can only come from the catalog.
const P9 = "gid://shopify/Product/209";
const V9 = "gid://shopify/ProductVariant/2091";
await inT(() => writeProduct(shopifyProduct(P9, "creatine", "Creatine 250g", V9, "CR-250", 500)));
await placeOrder([[V9, 2]]);
await inT(() => writeProduct(shopifyProduct(P9, "creatine", "Creatine Pure 250g", V9, "CR-250", 500)));
await placeOrder([[V9, 1]]);
await inT(() => writeProduct(shopifyProduct(P9, "creatine", "Creatine Monohydrate 250g", V9, "CR-250", 500)));
const tp = await inT(() => Rep.topProducts({ days: 30, limit: 50 }));

await t("renaming a product keeps one row in top products, under its current title", async () => {
  const rowsFor = tp.products.filter((p) => p.product_id === P9 || /creatine/i.test(p.title));
  eq(rowsFor.length, 1, `rows: ${JSON.stringify(rowsFor)}`);
  same(rowsFor[0], { product_id: P9, title: "Creatine Monohydrate 250g", qty: 3, revenue: 1500 }, "row");
});

await t("a product no longer in the catalog keeps the newest title its orders saw", async () => {
  const P8 = "gid://shopify/Product/208";
  const V8 = "gid://shopify/ProductVariant/2081";
  await inT(() => writeProduct(shopifyProduct(P8, "old-bar", "Protein Bar", V8, "PB-1", 100)));
  await placeOrder([[V8, 1]]);
  await inT(() => writeProduct(shopifyProduct(P8, "old-bar", "Protein Bar Choco", V8, "PB-1", 100)));
  await placeOrder([[V8, 1]]);
  await inT(() => deleteProductByGid(P8));
  const r = (await inT(() => Rep.topProducts({ days: 30, limit: 50 }))).products.filter((p) => p.product_id === P8);
  same(r, [{ product_id: P8, title: "Protein Bar Choco", qty: 2, revenue: 200 }], "row");
});

await t("snapshot lines with no product id still group by title, as before", async () => {
  await inT(async () => {
    const ts = new Date().toISOString();
    for (const n of [1, 2]) {
      await db.insertInto("orders").values({ id: `OC-LEGACY-${n}`, idempotency_key: `ocat-legacy-${n}`, status: "synced", payment_method: "cod", total: 300, currency: "INR", snapshot: JSON.stringify({ items: [{ title: "Legacy Tee", quantity: 1, lineTotal: 300 }] }), sync_attempts: 1, created_at: ts, updated_at: ts }).execute();
    }
  });
  const r = (await inT(() => Rep.topProducts({ days: 30, limit: 50 }))).products.filter((p) => p.title === "Legacy Tee");
  same(r, [{ product_id: null, title: "Legacy Tee", qty: 2, revenue: 600 }], "row");
});

await t("AI insights count a renamed product once, under its current title", async () => {
  const facts = await inT(() => AI.gatherTenantFacts());
  const sales = facts.find((f) => f.kind === "sales")?.text || "";
  ok(sales.includes("Creatine Monohydrate 250g ×3"), sales);
  ok(!sales.includes("Creatine 250g ×") && !sales.includes("Creatine Pure 250g ×"), `an old title has its own entry: ${sales}`);
});

// =============================================================================
console.log("— 4. the Shopify push");

await t("negative: the Shopify push sends neither the frozen Shopify title nor the SKU", async () => {
  await inT(() => writeProduct(shopifyProduct("gid://shopify/Product/250", "sentinel", "CATALOG-TITLE-OC-SENTINEL", "gid://shopify/ProductVariant/2501", "SKU-OC-SENTINEL", 700)));
  const id = await placeOrder([["gid://shopify/ProductVariant/2501", 1]], { method: "razorpay", retitle: { "gid://shopify/Product/250": "SHOPPER-TITLE-OC-SENTINEL" } });
  const lines = await rawLines(id);
  same([lines[0].catalog_title, lines[0].sku], ["CATALOG-TITLE-OC-SENTINEL", "SKU-OC-SENTINEL"], "stored on the line");
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("draftOrderCreate")) return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/9", name: "#D9" }, userErrors: [] } };
    if (query.includes("draftOrderComplete"))
      return { draftOrderComplete: { draftOrder: { id: variables.id, status: "COMPLETED", order: { id: "gid://shopify/Order/9", name: "#T9", displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: "700" } } } }, userErrors: [] } };
    return { orders: { nodes: [] }, draftOrders: { nodes: [] } };
  };
  const r = await inT(() => P.pushOrderToShopify(id, { gql }));
  ok(r.ok, `push: ${JSON.stringify(r)}`);
  const wire = JSON.stringify(calls);
  for (const s of ["CATALOG-TITLE-OC-SENTINEL", "SKU-OC-SENTINEL", "SHOPPER-TITLE-OC-SENTINEL"]) ok(!wire.includes(s), `${s} reached Shopify`);
  const create = calls.find((c) => c.query.includes("draftOrderCreate"));
  same(create.variables.input.lineItems.map((l) => Object.keys(l).sort()), [["quantity", "variantId"]], "line item keys");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
