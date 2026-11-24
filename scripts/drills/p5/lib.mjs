// P5-DRILLS: shared helpers for the phase 5 drills (TREE-01, COM-01, COM-02):
// the bundle card and grid, the bundle picker and inline create, the publish
// warnings. Desktop Chrome on the design harness; not a test:* suite (drills
// need a harness and Chrome). Run with pnpm drill:p5 (a throwaway worktree,
// scripts/drills/run-isolated.mjs).
//
//   node scripts/drills/p5/lib.mjs --check     the helpers' own checks (no harness)
//
// Everything the phase 3 and phase 4 helpers give (scripts/drills/p4/lib.mjs,
// imported and re-exported), plus:
//
//   DRILL_ID, OUT                    "P5-DRILLS" and its results folder
//   docStore(drill)                  the documents-mode store: the phase 3 seed
//                                    (seed-design-documents.js --p3: the design
//                                    store seeded straight into documents mode,
//                                    a new documents-mode tenant, not a moved
//                                    store), harness started. Returns the seed.
//   inStore(fn)                      fn({ libsql }) inside withTenant(design) in
//                                    THIS process, against the running
//                                    harness's local databases only
//                                    (withHarnessStore, write: false)
//   pickVariants(n, opts)            n in-stock, priced variants of n different
//                                    products (catalog order, so the same on
//                                    every seed)
//   makeBundle({ title, variants, price, enable })
//                                    lib/bundles.js createBundle (turned on:
//                                    mustPass too), in this process
//   bundleEnabled(id, on), bundleGone(id)
//                                    lib/bundles.js setBundleEnabled / deleteBundle
//   productShape(libsql, id)         a product as the sync writer takes it (the
//                                    Storefront shape lib/sync.js writeProduct
//                                    reads), rebuilt from its rows
//   syncProduct(id, change)          that shape, changed (stock or price), written
//                                    through lib/sync.js writeProduct: the sync
//                                    writer, never a raw catalog UPDATE
//   soldOut(shape), priced(shape, f) the changes syncProduct is given
//   bundleRows(), offerRows()        the bundles and bundle offers, by SQL (read)
//   openEditor(page, query)          /admin/editor, waited for
//   addSection(page, kind)           Add a section, then the kind; the new id
//   inspectorOf(page), frameText(page), frameHtml(page)
//   waitPreview(page, fn, ms)        until fn(frame text) holds
//   pickBundleIn(page, words, id)    type into the inspector's bundle search,
//                                    pick the option
//   publishAndRead(page)             publishHere, then the panel's phase,
//                                    message text and every issue with its
//                                    buttons
//   actOn(page, issueText, button)   click a warning's action button (the
//                                    editor's own Remove and publish)
//   liveHome(drill, base, opts)      the live home in a fresh browser (no
//                                    console cookie, a fixed experiment unit):
//                                    { cards, grids, html, text }
//   saveHome(page, mutate)           the home draft changed through the
//                                    documents writer API (the editor's own
//                                    writer), from a signed-in page
//   noShopifyOrPayment(drill, ctx)   the store's row and the harness env hold
//                                    no Shopify domain or token and no payment
//                                    secret (before any test order)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../../design-harness.js";
import { DrillError, assertLocal, docsApi, noThanks, publishHere, reseed, selfCheck as p4SelfCheck, settle, sleep, sqlAt, storeSql, waitFor } from "../p4/lib.mjs";

export * from "../p4/lib.mjs";

export const DRILL_ID = "P5-DRILLS";
export const OUT = join(ROOT, "docs", "cms-reviews", "drills", DRILL_ID);
export const TEST_ORDER_EMAIL = "snehal@mediastic.in";
// the experiment unit every shopper page of this drill sends
export const UNIT = "p5-drills";

// ---------- the documents-mode store ----------

export async function docStore(drill) {
  const { seed } = await reseed(drill, { start: true });
  const mode = (await storeSql("tenant", ["SELECT mode FROM cms_state WHERE id = 1"]))[0].rows[0]?.mode;
  if (mode !== "documents") throw new DrillError(`the --p3 store is in ${mode} mode, not documents`);
  drill.note("store: the phase 3 seed (seed-design-documents.js --p3): the design store seeded straight into documents mode (a new documents-mode tenant, not a moved store)");
  return seed;
}

// In this process, inside withTenant(design), against the running harness.
export async function inStore(fn) {
  const { withHarnessStore } = await import("../../seed-design-documents.js");
  return withHarnessStore(async ({ libsql, urls }) => {
    for (const u of Object.values(urls)) assertLocal(u);
    return fn({ libsql });
  }, { write: false });
}

const rowsOf = (r) => r.rows.map((x) => ({ ...x }));

// n in-stock variants with a price, each of a different in-stock product.
export async function pickVariants(n, { skip = 0, maxPrice = Infinity } = {}) {
  const r = await storeSql("tenant", [
    `SELECT v.id, v.price, v.product_id, p.title AS product_title, p.handle FROM variants v JOIN products p ON p.id = v.product_id
     WHERE v.available = 1 AND p.available = 1 AND v.price > 0 AND v.id LIKE 'gid://shopify/ProductVariant/%' AND v.position = 0
     ORDER BY p.id`,
  ]);
  // never a product an existing bundle (the perf seed's four) already uses, so
  // the drill's bundles overlap nothing unless a stage means them to
  const used = new Set();
  for (const b of rowsOf((await storeSql("tenant", ["SELECT items FROM bundles"]))[0])) for (const it of JSON.parse(b.items || "[]")) used.add(it.variantId);
  const usedProducts = new Set(rowsOf(r[0]).filter((v) => used.has(v.id)).map((v) => v.product_id));
  const out = rowsOf(r[0])
    .filter((v) => !used.has(v.id) && !usedProducts.has(v.product_id))
    .filter((v) => Number(v.price) <= maxPrice)
    .slice(skip, skip + n)
    .map((v) => ({ ...v, price: Number(v.price) }));
  if (out.length < n) throw new DrillError(`the store has only ${out.length} in-stock variants to build bundles from (asked for ${n})`);
  return out;
}

export async function makeBundle({ title, variants, price, enable = true, quantities = [] }) {
  return inStore(async () => {
    const B = await import("../../../lib/bundles.js");
    const items = variants.map((v, i) => ({ variantId: v.id, quantity: quantities[i] ?? 1 }));
    return B.createBundle({ title, items, bundle_price: price, enable, mustPass: enable });
  });
}
export const bundleEnabled = (id, on) =>
  inStore(async () => {
    const B = await import("../../../lib/bundles.js");
    return B.setBundleEnabled(id, on);
  });
export const bundleGone = (id) =>
  inStore(async () => {
    const B = await import("../../../lib/bundles.js");
    return B.deleteBundle(id);
  });
export const readBundles = (ids) =>
  inStore(async () => {
    const R = await import("../../../lib/commerce/bundle-read.js");
    return R.bundlesByIds(ids);
  });

export const bundleRows = async () => rowsOf((await storeSql("tenant", ["SELECT id, slug, title, enabled, bundle_price, items FROM bundles ORDER BY created_at, id"]))[0]);
export const offerRows = async () => rowsOf((await storeSql("tenant", ["SELECT id, enabled, config FROM offers WHERE id LIKE 'bundle-%' ORDER BY id"]))[0]);

// ---------- the sync writer ----------

const num = (v) => (v == null ? null : String(v));
export async function productShape(libsql, id) {
  const p = (await libsql.execute({ sql: "SELECT * FROM products WHERE id = ?", args: [id] })).rows[0];
  if (!p) throw new DrillError(`no product ${id}`);
  const vs = rowsOf(await libsql.execute({ sql: "SELECT * FROM variants WHERE product_id = ? ORDER BY position", args: [id] }));
  const imgs = rowsOf(await libsql.execute({ sql: "SELECT * FROM product_images WHERE product_id = ? ORDER BY position", args: [id] }));
  const money = (amount) => ({ amount: num(amount), currencyCode: p.currency });
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    descriptionHtml: p.description_html,
    productType: p.product_type,
    vendor: p.vendor,
    tags: JSON.parse(p.tags || "[]"),
    priceRange: { minVariantPrice: money(p.price_min), maxVariantPrice: money(p.price_max) },
    compareAtPriceRange: p.compare_at_min ? { minVariantPrice: money(p.compare_at_min) } : null,
    availableForSale: Number(p.available) === 1,
    totalInventory: p.total_inventory,
    featuredImage: p.featured_image ? { url: p.featured_image, altText: p.featured_image_alt } : null,
    options: JSON.parse(p.options || "[]"),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    images: { nodes: imgs.map((i) => ({ url: i.url, altText: i.alt, width: i.width, height: i.height })) },
    variants: {
      nodes: vs.map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        price: { amount: num(v.price), currencyCode: v.currency },
        compareAtPrice: v.compare_at_price ? { amount: num(v.compare_at_price), currencyCode: v.currency } : null,
        availableForSale: Number(v.available) === 1,
        selectedOptions: JSON.parse(v.selected_options || "[]"),
        image: v.image_url ? { url: v.image_url } : null,
      })),
    },
  };
}

export const soldOut = (p) => ({ ...p, availableForSale: false, totalInventory: 0, variants: { nodes: p.variants.nodes.map((v) => ({ ...v, availableForSale: false })) } });
export const inStock = (p) => ({ ...p, availableForSale: true, variants: { nodes: p.variants.nodes.map((v) => ({ ...v, availableForSale: true })) } });
// every variant's price times f (whole amounts), and the price range with it
export const priced = (p, f) => {
  const nodes = p.variants.nodes.map((v) => ({ ...v, price: { ...v.price, amount: String(Math.max(1, Math.round(Number(v.price.amount) * f))) } }));
  const prices = nodes.map((v) => Number(v.price.amount));
  return { ...p, variants: { nodes }, priceRange: { minVariantPrice: { ...p.priceRange.minVariantPrice, amount: String(Math.min(...prices)) }, maxVariantPrice: { ...p.priceRange.maxVariantPrice, amount: String(Math.max(...prices)) } } };
};

// The product rows that the sync writer owns, without synced_at.
const SYNC_ROWS = async (libsql, id) => {
  const strip = (rows) => rows.map(({ synced_at, sync_generation, ...rest }) => rest);
  return {
    product: strip(rowsOf(await libsql.execute({ sql: "SELECT * FROM products WHERE id = ?", args: [id] }))),
    variants: strip(rowsOf(await libsql.execute({ sql: "SELECT * FROM variants WHERE product_id = ? ORDER BY position", args: [id] }))),
    images: strip(rowsOf(await libsql.execute({ sql: "SELECT * FROM product_images WHERE product_id = ? ORDER BY position", args: [id] }))),
  };
};

// change(shape) -> the shape to write. Returns { before, after, roundTrip }:
// roundTrip is true when writing the unchanged shape first left every row as
// it was (so the only change is the one asked for).
export async function syncProduct(id, change) {
  return inStore(async ({ libsql }) => {
    const { writeProduct } = await import("../../../lib/sync.js");
    const before = await SYNC_ROWS(libsql, id);
    const shape = await productShape(libsql, id);
    await writeProduct(shape, new Date().toISOString(), null);
    const same = await SYNC_ROWS(libsql, id);
    const roundTrip = JSON.stringify(same) === JSON.stringify(before);
    await writeProduct(change(shape), new Date().toISOString(), null);
    const after = await SYNC_ROWS(libsql, id);
    return { before, after, roundTrip };
  });
}

// ---------- the editor ----------

export async function openEditor(page, query = "") {
  await page.goto(`/admin/editor${query}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.waitForSelector("[data-section-tree], [data-inspector]", { timeout: 90_000 });
}

export const inspectorOf = (page) => page.locator("[data-inspector]").first();
export const frameText = (page) => page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.body?.innerText || "").catch(() => "");
export const frameHtml = (page) => page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.body?.innerHTML || "").catch(() => "");
export const previewLabel = (page) => page.locator("[data-preview-pane]").first().getAttribute("data-preview-label").catch(() => null);
export const waitPreview = (page, fn, ms = 60_000) => waitFor(async () => fn(await frameText(page)), ms, 400);

export async function getDoc(page, id = "doc_home") {
  const r = await docsApi(page, { getDocument: id });
  if (r.status !== 200) throw new DrillError(`getDocument ${id} answered ${r.status}`);
  return r.body.document;
}

// Add a section of `kind` through the tree's own picker. Returns its id.
export async function addSection(page, kind) {
  const before = await getDoc(page);
  await page.locator("[data-tree-add]").first().click();
  await page.locator(`[data-tree-picker] button[data-kind="${kind}"]`).click();
  const doc = await waitFor(async () => {
    const d = await getDoc(page);
    return d.body.sections.length === before.body.sections.length + 1 ? d : false;
  }, 30_000, 300);
  if (!doc) throw new DrillError(`adding a ${kind} section saved nothing`);
  return doc.body.sections.find((s) => !before.body.sections.some((b) => b.id === s.id))?.id;
}

export async function selectSection(page, id) {
  await page.locator(`[data-section-row="${id}"] button`).first().click();
  await inspectorOf(page).waitFor({ timeout: 30_000 });
}

// Type words into the inspector's bundle search and pick the option `id`.
export async function pickBundleIn(page, words, id) {
  const ins = inspectorOf(page);
  const search = ins.locator('input[type="search"]').first();
  await search.fill(words);
  const opt = ins.locator(`button[data-bundle-option="${id}"]`);
  await opt.waitFor({ timeout: 30_000 });
  await opt.click();
}

const PHASES = '[data-publish][data-phase="done"], [data-publish][data-phase="blocked"], [data-publish][data-phase="refused"], [data-publish][data-phase="error"]';

// What the publish panel shows now: its phase, its whole text, and every
// issue (message and button words).
export async function readPanel(page) {
  const panel = page.locator("[data-publish]").first();
  const phase = await panel.getAttribute("data-phase").catch(() => null);
  const text = (await panel.innerText().catch(() => "")).trim();
  const issues = [];
  for (const li of await panel.locator("[data-issue]").all()) {
    issues.push({ text: (await li.innerText()).trim(), buttons: (await li.locator("button").allInnerTexts()).map((t) => t.trim()) });
  }
  return { phase, text, issues };
}

export async function publishAndRead(page) {
  const phase = await publishHere(page);
  await sleep(500);
  return { ...(await readPanel(page)), phase };
}

// Click the action `button` on the issue whose text holds `issueText`, then
// wait for the panel to finish again.
export async function actOn(page, issueText, button) {
  const li = page.locator("[data-publish] [data-issue]").filter({ hasText: issueText }).first();
  await li.getByRole("button", { name: button, exact: true }).click();
  await sleep(800);
  await waitFor(async () => (await page.locator(PHASES).count()) > 0 && !(await page.locator("[data-publish] button[disabled]", { hasText: /Publishing/ }).count()), 60_000, 300);
  await sleep(800);
  return readPanel(page);
}

export async function closePanel(page) {
  const close = page.locator("[data-publish]").getByRole("button", { name: "Close", exact: true });
  if (await close.count()) await close.first().click();
}

// The home draft changed through the documents writer API (the editor's own
// writer) from a signed-in page. mutate(body) -> body.
export async function saveHome(page, mutate) {
  const d = await getDoc(page);
  const body = mutate(structuredClone(d.body));
  const r = await docsApi(page, { saveDraft: { id: d.id, body }, revision: d.revision });
  if (r.status !== 200) throw new DrillError(`saving the home draft answered ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
}

// A bundle section body, as the editor makes it (lib/registry newSection).
export async function bundleSection(kind, id, settings) {
  const Reg = await import("../../../lib/registry/index.js");
  const s = Reg.newSection(kind, { id });
  s.settings = { ...s.settings, ...settings };
  return s;
}
// put sections right after the hero (the hero stays first)
export const afterHero = (body, sections) => {
  const at = body.sections.findIndex((s) => s.kind === "hero") + 1;
  body.sections = [...body.sections.slice(0, at), ...sections, ...body.sections.slice(at)];
  return body;
};

// ---------- the shopper ----------

export async function shopper(drill, { width = 1440 } = {}) {
  const ctx = await drill.context({ width });
  await ctx.addCookies([{ name: "_unit", value: UNIT, url: drill.baseUrl }]);
  return ctx;
}

// The live home in a fresh browser. cards: each bundle card's bundle id,
// state, button and text; grids: each grid's cells in order.
export async function liveHome(drill, base, { shot = null, width = 1440 } = {}) {
  assertLocal(base);
  const ctx = await shopper(drill, { width });
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/`, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    await noThanks(page);
    const seen = await page.evaluate(() => {
      const box = (el) => {
        const b = el.querySelector("[data-bundle]") || el;
        const btn = b.querySelector("button");
        return { id: b.getAttribute("data-bundle"), state: b.getAttribute("data-bundle-state"), button: btn ? { text: btn.innerText.trim(), disabled: btn.disabled } : null, items: [...b.querySelectorAll("[data-bundle-item]")].map((i) => [i.getAttribute("data-bundle-item"), i.innerText.replace(/\s+/g, " ").trim()]), text: b.innerText.replace(/\s+/g, " ").trim() };
      };
      return {
        cards: [...document.querySelectorAll('[data-section-kind="bundle_card"]')].map((s) => ({ section: s.getAttribute("data-section-id"), ...box(s) })),
        grids: [...document.querySelectorAll('[data-section-kind="bundle_grid"]')].map((s) => ({ section: s.getAttribute("data-section-id"), cells: [...s.querySelectorAll("[data-bundle]")].map((c) => box(c)) })),
        notes: document.querySelectorAll("[data-founder-note]").length,
        text: (document.querySelector("main")?.innerText || document.body.innerText).replace(/\s+/g, " ").trim(),
      };
    });
    if (shot) await drill.screenshot(page, shot);
    return seen;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// The raw live home, as a shopper fetch gets it (the fixed unit cookie).
export async function liveHomeHtml(base) {
  assertLocal(base);
  const r = await fetch(`${base}/`, { headers: { accept: "text/html", cookie: `_unit=${UNIT}` }, redirect: "manual" });
  return { status: r.status, html: await r.text() };
}

// ---------- the test order guard ----------

export async function noShopifyOrPayment(drill, ctx) {
  const row = (await sqlAt(ctx.urls.platform, [{ sql: "SELECT * FROM tenants WHERE id = ?", args: [ctx.store] }]))[0].rows[0] || {};
  const text = JSON.stringify(row);
  const found = [...text.matchAll(/"((?:shopify|razorpay)_[a-z_]*(?:domain|token|secret|key)[a-z_]*)\\?"\s*:\s*\\?"([^"\\]+)/gi)].map((m) => m[1]);
  const envNames = ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_STOREFRONT_TOKEN", "SHOPIFY_ADMIN_TOKEN", "NEXT_PUBLIC_SHOPIFY_DOMAIN", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "PLATFORM_RAZORPAY_KEY_SECRET"];
  const env = envNames.filter((k) => ctx.env[k]);
  drill.check(found.length === 0 && env.length === 0, "before the test order: the store's row and the harness env hold no Shopify domain or token and no payment secret (nothing can reach Shopify or a payment)", { found, env });
  if (found.length || env.length) throw new DrillError("refusing to place a test order: the harness store names a Shopify store or a payment secret");
}

// ---------- the helpers' own checks ----------

export function selfCheck() {
  const out = p4SelfCheck();
  const shape = priced({ variants: { nodes: [{ price: { amount: "100" } }, { price: { amount: "250" } }] }, priceRange: { minVariantPrice: { amount: "100" }, maxVariantPrice: { amount: "250" } } }, 0.5);
  out.push({ ok: shape.priceRange.minVariantPrice.amount === "50" && shape.priceRange.maxVariantPrice.amount === "125", label: "priced() changes every variant's price and the price range with it", detail: shape.priceRange });
  const so = soldOut({ availableForSale: true, variants: { nodes: [{ availableForSale: true }] } });
  out.push({ ok: so.availableForSale === false && so.variants.nodes.every((v) => v.availableForSale === false), label: "soldOut() marks the product and every variant unavailable", detail: so });
  return out;
}

export function ensureOut() {
  mkdirSync(OUT, { recursive: true });
  return OUT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--check")) {
  const res = selfCheck();
  for (const c of res) console.log(`${c.ok ? "✓" : "✗"} ${c.label}`);
  process.exit(res.every((c) => c.ok) ? 0 : 1);
}
