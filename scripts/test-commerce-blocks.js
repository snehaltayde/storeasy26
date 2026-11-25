// P5-BLOCKS suite (COM-01, COM-02, TREE-01): the bundle card and bundle grid
// sections, from the real bundle read to the markup a shopper and the founder
// get.
//   1. On a tenant-fixture file database: bundles in every state (available,
//      sold out, no saving, not ready, turned off, deleted), read through the
//      real lib/cms/section-data.js resolveHomeSectionData with its DEFAULT
//      repo (lib/commerce/bundle-read.js bundlesByIds).
//   2. Rendered with Next's own SWC and react-dom/server, as
//      test-sections-render does, through HomeSections (the home page's
//      renderer), live and in a documents preview. The preview is the request
//      scope lib/content/resolve.js sets for a founder's documents preview
//      (Symbol.for("storeasy.requestScope")); this suite sets it directly.
//      Everything renders inside CartProvider (components/cart/CartContext.js),
//      as the storefront layout does; server rendering runs no effects.
//   3. The cart: lib/cart.js addItem with the props the block gives
//      BundleAddButton (recorded through the loader, the real button still
//      renders) and with getBundle(slug).components, as the bundle page does.
// Money is in USD here, so a "no rupee sign" check means something
// (formatMoney prints ₹ for INR).
//   pnpm test:commerce-blocks
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// next/headers outside a request: the failed-section note's isPreviewRequest
// (lib/cms/section-data.js) then answers false, the shoppers' rule
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
export async function headers() { throw new Error("next/headers outside a request"); }
export async function cookies() { throw new Error("next/headers outside a request"); }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-cblk-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cblk-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
const dbs = [".test-cblk-default.db", ".test-cblk-platform.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

// The request scope a documents preview sets (lib/content/resolve.js
// noteRequestScope). Set before any module reads it; resolve.js keeps an
// existing one (??=).
const SCOPE_KEY = Symbol.for("storeasy.requestScope");
const LIVE_SCOPE = { storeId: null, documentsPreview: false };
let scope = LIVE_SCOPE;
globalThis[SCOPE_KEY] = () => scope;

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e?.stack?.split("\n").slice(0, 4).join("\n    ") || e}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (got, want, m = "") => {
  if (got !== want) throw new Error(`${m} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const same = (got, want, m = "") => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${m}\n      expected ${b.slice(0, 900)}\n      got      ${a.slice(0, 900)}`);
};

// ---- the JSX loader (Next's SWC), as test-sections-render ----------------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { prerenderToNodeStream } = require("react-dom/static");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
// every BundleAddButton render, with the props it was given
const addCalls = [];
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
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
    if (id.startsWith("@/") || id.startsWith(".")) {
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
      if (!target.endsWith(".js")) target = existsSync(`${target}.js`) ? `${target}.js` : join(target, "index.js");
      deps.set(id, isJsx(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
    } else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id in STUBS) return STUBS[id];
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
// The real add button, recorded: what the block hands it is what a shopper's tap adds.
const RealAdd = (await loadJsx(join(ROOT, "components/BundleAddButton.js"))).default;
STUBS["@/components/BundleAddButton"] = {
  __esModule: true,
  default: (props) => {
    addCalls.push(props);
    return React.createElement(RealAdd, props);
  },
};
const { CartProvider } = await loadJsx(join(ROOT, "components/cart/CartContext.js"));
const Map_ = await loadJsx(join(ROOT, "components/sections/index.js"));
const HomeSections = (await loadJsx(join(ROOT, "components/sections/HomeSections.js"))).default;

// Rendered as a whole (async: a failed section's live note asks the request).
async function html(el) {
  const { prelude } = await prerenderToNodeStream(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, React.createElement(CartProvider, null, el)));
  let out = "";
  for await (const chunk of prelude) out += chunk;
  return out;
}
// React and the rich-text note escape differently; compare words, not entities.
const words = (h) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
async function render(sections, dataById, { preview = false } = {}) {
  scope = preview ? { storeId: "cblk", documentsPreview: true } : LIVE_SCOPE;
  try {
    return await html(React.createElement(HomeSections, { sections, dataById }));
  } finally {
    scope = LIVE_SCOPE;
  }
}
const both = async (sections, dataById) => ({ live: await render(sections, dataById), preview: await render(sections, dataById, { preview: true }) });

async function logsOf(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const result = await fn();
    return { result, lines: lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
  } finally {
    console.log = log;
  }
}

// ---- the store ---------------------------------------------------------------------
const TF = await import("./support/tenant-fixture.js");
const { watchStatements } = await import("./support/request-cache.js");
const { currentDatabase } = await import("../lib/db.js");
const Reg = await import("../lib/registry/index.js");
const { resolveHomeSectionData } = await import("../lib/cms/section-data.js");
const B = await import("../lib/bundles.js");
const BR = await import("../lib/commerce/bundle-read.js");
const BW = await import("../lib/commerce/bundle-words.js");
const Cart = await import("../lib/cart.js");
const { formatMoney } = await import("../lib/format.js");

// 16 products, one variant each: V(n) priced 100 * n, in stock
const tn = await TF.makeTenant({ name: "cblk", id: "cblk", products: 16 });
const inT = (fn) => tn.run(fn);
const V = (n) => `gid://shopify/ProductVariant/${9100 + n}1`;
const items = (...ns) => ns.map((n) => ({ variantId: V(n), quantity: 1 }));
const rawClient = tn.client();
const raw = (sql, args = []) => rawClient.execute({ sql, args });
const USD = (n) => formatMoney(n, "USD");

const K = {};
await inT(async () => {
  K.avail = (await B.upsertBundle({ slug: "gym-kit", title: "Gym kit", items: items(1, 2), bundle_price: 250, enable: true })).id; // 300 -> 250
  K.sold = (await B.upsertBundle({ slug: "night-set", title: "Night set", items: items(3, 4), bundle_price: 600, enable: true })).id; // 700 -> 600
  K.nosave = (await B.upsertBundle({ slug: "dear-set", title: "Dear set", items: items(5, 6), bundle_price: 1000, enable: true })).id;
  K.notready = (await B.upsertBundle({ slug: "half-set", title: "Half set", items: items(2, 4), bundle_price: 550, enable: true })).id;
  K.off = (await B.upsertBundle({ slug: "off-set", title: "Off set", items: items(1, 2), bundle_price: 250, enable: false })).id;
  // the overlap pair (plan C1-2): A = {v7, v8} at 180, B = {v7, v8, v9} at 200, both on
  K.ovA = (await B.upsertBundle({ slug: "pair-a", title: "Pair A", items: items(7, 8), bundle_price: 180, enable: true })).id;
  K.ovB = (await B.upsertBundle({ slug: "pair-b", title: "Pair B", items: items(7, 8, 9), bundle_price: 200, enable: true })).id;
  // fix round 1: a bundle that saves nothing AND has a sold-out product, and one
  // that saves nothing AND is not ready (OQ-B: both hidden from shoppers)
  K.soldNosave = (await B.upsertBundle({ slug: "dear-sold", title: "Dear sold", items: items(10, 11), bundle_price: 2000, enable: true })).id; // 2100 -> 2000
  K.notreadyNosave = (await B.upsertBundle({ slug: "dear-half", title: "Dear half", items: items(12, 13), bundle_price: 2400, enable: true })).id; // 2500 -> 2400
});
K.missing = "bun-deleted0";
// the catalog moves under them: every price in USD; v3 sells out; v5 gets
// cheap (5 + 6: 100 + 600 = 700 < 1000); half-set's offer row disappears
await raw("UPDATE variants SET currency = 'USD'");
await raw("UPDATE products SET currency = 'USD'");
await raw("UPDATE variants SET available = 0 WHERE id = ?", [V(3)]);
await raw("UPDATE variants SET price = 100 WHERE id = ?", [V(5)]);
await raw("DELETE FROM offers WHERE id = ?", [`bundle-${K.notready}`]);
// dear-sold: v10 sells out and v11 gets cheap (1000 + 100 = 1100 < 2000);
// dear-half: its offer row disappears and v13 gets cheap (1200 + 100 = 1300 < 2400)
await raw("UPDATE variants SET available = 0 WHERE id = ?", [V(10)]);
await raw("UPDATE variants SET price = 100 WHERE id = ?", [V(11)]);
await raw("UPDATE variants SET price = 100 WHERE id = ?", [V(13)]);
await raw("DELETE FROM offers WHERE id = ?", [`bundle-${K.notreadyNosave}`]);

const card = (id, bundleId, title = "") => ({ id, kind: "bundle_card", v: 1, enabled: true, settings: { title, bundle: bundleId ? { id: bundleId } : null }, blocks: [] });
const grid = (id, ids, title = "Our bundles") => ({ id, kind: "bundle_grid", v: 1, enabled: true, settings: { title, bundles: ids.map((x) => ({ id: x })) }, blocks: [] });
const dataOf = (sections, opts = {}) => inT(() => resolveHomeSectionData(sections, opts));
const sectionOf = (h, id) => h.match(new RegExp(`<section[^>]*data-section-id="${id}"[^>]*>[\\s\\S]*?</section>`))?.[0] || "";
const buttonOf = (h) => h.match(/<button[^>]*>[^<]*<\/button>/g) || [];
const NOTE_ONLY = "Only you can see this note in your preview.";

// =====================================================================================
console.log("— the states, read for real");
// =====================================================================================
await t("the fixture bundles read in the states this suite needs (the real bundlesByIds through DEFAULT_REPO)", async () => {
  const ids = [K.avail, K.sold, K.nosave, K.notready, K.off, K.missing];
  const data = await dataOf([grid("sec_g0", ids)]);
  same(data.get("sec_g0").bundles.map((b) => b.state), ["available", "sold_out", "no_saving", "not_ready", "disabled", "missing"], "states:");
  eq(data.get("sec_g0").bundles[0].currency, "USD", "currency:");
});

// =====================================================================================
console.log("— the bundle card");
// =====================================================================================
await t("an available card renders its heading, the bundle title, each product, the price, 'You save' in the bundle's currency, a link to /bundles/<slug> and an enabled add button, live and in preview", async () => {
  const s = card("sec_c1", K.avail, "Our pick");
  const data = await dataOf([s]);
  const r = await both([s], data);
  for (const [mode, h] of Object.entries(r)) {
    const sec = sectionOf(h, "sec_c1");
    ok(sec, `${mode}: no section: ${h.slice(0, 300)}`);
    for (const w of ["Our pick", "Gym kit", "Fixture product 1", "Fixture product 2", USD(250), USD(300), `You save ${USD(50)}`, 'href="/bundles/gym-kit"', "Add the set to cart"]) ok(sec.includes(w), `${mode}: missing ${JSON.stringify(w)} in ${sec.slice(0, 1500)}`);
    ok(USD(50).startsWith("$"), `USD formats with $: ${USD(50)}`);
    ok(!/₹|INR/.test(sec), `${mode}: a rupee sign or INR`);
    const btns = buttonOf(sec);
    eq(btns.length, 1, `${mode} buttons:`);
    ok(!/ disabled=""/.test(btns[0]), `${mode}: the add button is off: ${btns[0]}`);
    ok(!/Currently unavailable|Sold out|data-founder-note|hidden from shoppers/.test(sec), `${mode}: an unavailable mark or note on an available card`);
  }
  eq(r.live.replace(/ data-field="title"/g, ""), r.preview.replace(/ data-field="title"/g, ""), "preview = live (only the editor's field mark added):");
});

await t("a card with a sold-out product marks it 'Sold out', says 'Currently unavailable' and disables add, live and in preview; not_ready does the same", async () => {
  for (const [id, bundle, marked] of [["sec_c2", K.sold, "Fixture product 3"], ["sec_c3", K.notready, null]]) {
    const s = card(id, bundle);
    const data = await dataOf([s]);
    const r = await both([s], data);
    for (const [mode, h] of Object.entries(r)) {
      const sec = sectionOf(h, id);
      ok(sec, `${id} ${mode}: hidden`);
      const btns = buttonOf(sec);
      eq(btns.length, 1, `${id} ${mode} buttons:`);
      ok(/disabled=""/.test(btns[0]) && btns[0].includes("Currently unavailable"), `${id} ${mode}: ${btns[0]}`);
      ok(!sec.includes("Add the set to cart"), `${id} ${mode}: an add button`);
      if (marked) {
        const li = sec.match(new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*${marked}(?:(?!</li>)[\\s\\S])*</li>`))?.[0] || "";
        ok(/>Sold out</.test(li), `${mode}: the sold-out product is not marked: ${li}`);
        const other = sec.match(/<li[^>]*>(?:(?!<\/li>)[\s\S])*Fixture product 4(?:(?!<\/li>)[\s\S])*<\/li>/)?.[0] || "";
        ok(other && !/Sold out/.test(other), `${mode}: the in-stock product is marked`);
      } else ok(!/Sold out|No longer available/.test(sec), `not_ready ${mode}: a product marked though every one is in stock`);
      ok(!/data-founder-note|hidden from shoppers/.test(sec), `${id} ${mode}: a hidden note on a shown card`);
    }
  }
});

await t("a no_saving card (OQ-B, owner 2026-11-05) renders nothing live and, in preview, a note with the reason naming the sum", async () => {
  const s = card("sec_c4", K.nosave);
  const data = await dataOf([s]);
  const r = await both([s], data);
  eq(r.live, "", "live:");
  const why = BW.stateLine("no_saving", data.get("sec_c4").bundle.reasons, { currency: "USD" });
  eq(why, `The price no longer saves anything (the products add up to ${USD(700)}), so shoppers don't see it. Lower the price in Bundles.`, "the words:");
  ok(words(r.preview).includes(why) && r.preview.includes("Bundle card: hidden from shoppers") && r.preview.includes('data-hidden-reason=""'), `preview: ${r.preview.slice(0, 800)}`);
  ok(!r.preview.includes("Add the set to cart") && !r.preview.includes("Currently unavailable"), "preview: the card itself");
});

await t("disabled and missing cards render nothing live and the bundle-words reason in preview, without throwing (an absent entry counts as missing)", async () => {
  const cases = [
    ["sec_c5", K.off, BW.stateLine("disabled")],
    ["sec_c6", K.missing, BW.stateLine("missing")],
  ];
  for (const [id, bundle, why] of cases) {
    const s = card(id, bundle);
    const data = await dataOf([s]);
    const r = await both([s], data);
    eq(r.live, "", `${id} live:`);
    ok(words(r.preview).includes(why) && r.preview.includes(`data-section-id="${id}"`), `${id} preview: ${r.preview.slice(0, 600)}`);
  }
  eq(BW.stateLine("disabled"), "This bundle is turned off, so shoppers don't see it. Turn it on in Bundles, or remove it.", "turned off words:");
  eq(BW.stateLine("missing"), "This bundle was deleted, so shoppers don't see it. Pick another or remove it.", "deleted words:");
  // no entry at all (bundle_by_id resolves undefined for an id the read lacks)
  const bare = card("sec_c7", "bun-never");
  const r = await both([bare], new Map([["sec_c7", {}]]));
  eq(r.live, "", "no entry, live:");
  ok(words(r.preview).includes(BW.stateLine("missing")), "no entry, preview: the deleted words");
});

// =====================================================================================
console.log("— the bundle grid");
// =====================================================================================
await t("a grid whose bundles are all hidden (turned off, deleted, no saving) renders nothing live and, in preview, the no-results reason and each bundle's reason", async () => {
  const s = grid("sec_g1", [K.off, K.missing, K.nosave]);
  const data = await dataOf([s]);
  const r = await both([s], data);
  eq(r.live, "", "live:");
  const p = words(r.preview);
  ok(p.includes("Bundle grid: hidden from shoppers") && p.includes(BW.gridEmptyLine()), `preview: ${p.slice(0, 900)}`);
  eq(BW.gridEmptyLine(), "None of the bundles in this grid can be shown, so shoppers don't see it.", "the words:");
  for (const w of [`Off set: ${BW.stateLine("disabled")}`, `Bundle 2: ${BW.stateLine("missing")}`, "Dear set: The price no longer saves anything"]) ok(p.includes(w), `preview lacks ${JSON.stringify(w)}`);
});

await t("a mixed grid (available, sold out, turned off, deleted, no saving) shows only the available and sold-out cells live, in picked order, the sold-out one 'Currently unavailable' with add off; in preview each dropped cell is a note with its reason; live markup has no note", async () => {
  const picked = [K.off, K.sold, K.missing, K.avail, K.nosave];
  const s = grid("sec_g2", picked);
  const data = await dataOf([s]);
  const r = await both([s], data);
  const live = sectionOf(r.live, "sec_g2");
  ok(live, `live: no grid: ${r.live.slice(0, 300)}`);
  same([...live.matchAll(/data-bundle="([^"]+)" data-bundle-state="([^"]+)"/g)].map((m) => [m[1], m[2]]), [[K.sold, "sold_out"], [K.avail, "available"]], "live cells, picked order:");
  ok(!/data-founder-note|Only you can see|turned off|was deleted|no longer saves|Off set|Dear set/.test(live), `live: a dropped cell left a trace: ${live}`);
  const cellOf = (h, id) => h.match(new RegExp(`<div data-bundle="${id}"[\\s\\S]*?(?=<div data-bundle=|<div data-founder-note|</div></section>)`))?.[0] || "";
  const soldCell = cellOf(live, K.sold);
  ok(soldCell.includes("Currently unavailable") && /<button[^>]*disabled=""[^>]*>Currently unavailable/.test(soldCell), `sold cell: ${soldCell}`);
  ok(/>Sold out</.test(soldCell), "sold cell marks its product");
  ok(cellOf(live, K.avail).includes("Add the set to cart") && cellOf(live, K.avail).includes(`You save ${USD(50)}`), "available cell");
  const pv = words(sectionOf(r.preview, "sec_g2"));
  const notes = [...pv.matchAll(/<div data-founder-note="" data-bundle-cell="(\d+)" data-hidden-reason=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => [Number(m[1]), m[2]]);
  same(notes.map((n) => n[0]), [0, 2, 4], "preview: a note in place of each dropped cell:");
  ok(notes[0][1].includes("Off set: hidden from shoppers") && notes[0][1].includes(BW.stateLine("disabled")) && notes[0][1].includes(NOTE_ONLY), `turned-off note: ${notes[0][1]}`);
  ok(notes[1][1].includes("Bundle 3: hidden from shoppers") && notes[1][1].includes(BW.stateLine("missing")), `deleted note: ${notes[1][1]}`);
  ok(notes[2][1].includes(`(the products add up to ${USD(700)}), so shoppers don't see it`), `no-saving note: ${notes[2][1]}`);
  // the order in preview: note, sold, note, available, note
  const order = [...pv.matchAll(/data-bundle="([^"]+)"|data-bundle-cell="(\d+)"/g)].map((m) => m[1] || `note${m[2]}`);
  same(order, ["note0", K.sold, "note2", K.avail, "note4"], "preview order:");
});

await t("fix round 1 (OQ-B): a bundle that saves nothing is hidden even when it is also sold out or not ready, as a card and as a grid cell, live and in preview, with the no-saving words", async () => {
  const data0 = await dataOf([grid("sec_x0", [K.soldNosave, K.notreadyNosave])]);
  const [so, nr] = data0.get("sec_x0").bundles;
  eq(so.state, "sold_out", "dear-sold state:");
  same(so.reasons.map((r) => r.kind), ["sold_out", "no_saving"], "dear-sold reasons:");
  eq(nr.state, "not_ready", "dear-half state:");
  ok(nr.reasons.some((r) => r.kind === "not_synced") && nr.reasons.some((r) => r.kind === "no_saving"), `dear-half reasons: ${JSON.stringify(nr.reasons)}`);
  const cases = [
    ["sec_x1", K.soldNosave, "Dear sold", USD(1100)],
    ["sec_x2", K.notreadyNosave, "Dear half", USD(1300)],
  ];
  for (const [id, bundle, title, sum] of cases) {
    const s = card(id, bundle);
    const data = await dataOf([s]);
    const r = await both([s], data);
    eq(r.live, "", `${title} card live:`);
    const why = `The price no longer saves anything (the products add up to ${sum}), so shoppers don't see it. Lower the price in Bundles.`;
    eq(BW.stateLine("no_saving", data.get(id).bundle.reasons, { currency: "USD" }), why, `${title} words:`);
    const p = words(r.preview);
    ok(p.includes(why) && p.includes("Bundle card: hidden from shoppers") && p.includes('data-hidden-reason=""'), `${title} card preview: ${p.slice(0, 800)}`);
    ok(!/Currently unavailable|Add the set to cart|data-bundle-state/.test(r.preview), `${title} card preview shows the card`);
  }
  // as grid cells, beside an available bundle (so the grid shows)
  const s = grid("sec_x3", [K.soldNosave, K.avail, K.notreadyNosave]);
  const data = await dataOf([s]);
  const r = await both([s], data);
  const live = sectionOf(r.live, "sec_x3");
  ok(live, "live: the grid shows (its available cell)");
  same([...live.matchAll(/data-bundle="([^"]+)" data-bundle-state="([^"]+)"/g)].map((m) => [m[1], m[2]]), [[K.avail, "available"]], "live cells:");
  ok(!/Dear sold|Dear half|Currently unavailable|data-founder-note|no longer saves/.test(live), `live: a hidden cell left a trace: ${live}`);
  const pv = words(sectionOf(r.preview, "sec_x3"));
  const notes = [...pv.matchAll(/<div data-founder-note="" data-bundle-cell="(\d+)" data-hidden-reason=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => [Number(m[1]), m[2]]);
  same(notes.map((n) => n[0]), [0, 2], "preview: a note for each no-saving cell:");
  ok(notes[0][1].includes("Dear sold: hidden from shoppers") && notes[0][1].includes(`(the products add up to ${USD(1100)}), so shoppers don't see it`), `dear-sold note: ${notes[0][1]}`);
  ok(notes[1][1].includes("Dear half: hidden from shoppers") && notes[1][1].includes(`(the products add up to ${USD(1300)}), so shoppers don't see it`), `dear-half note: ${notes[1][1]}`);
  ok(!/Currently unavailable/.test(pv.replace(/<div data-bundle="[^"]*" data-bundle-state="available"[\s\S]*/, "")), "preview: a no-saving cell rendered as a card");
  // a grid of only these two is hidden, with the no-results words
  const s2 = grid("sec_x4", [K.soldNosave, K.notreadyNosave]);
  const r2 = await both([s2], await dataOf([s2]));
  eq(r2.live, "", "all-hidden grid live:");
  const p2 = words(r2.preview);
  ok(p2.includes(BW.gridEmptyLine()) && p2.includes("Dear sold: The price no longer saves anything") && p2.includes("Dear half: The price no longer saves anything"), `all-hidden grid preview: ${p2.slice(0, 900)}`);
});

// =====================================================================================
console.log("— a fault, and the bounded read");
// =====================================================================================
await t("when bundlesByIds rejects, every bundle section gets bindingFailed and logs section_binding_failed (cause fault): hidden live, the failed note in preview", async () => {
  const sections = [card("sec_f1", K.avail), card("sec_f2", K.sold), grid("sec_f3", [K.avail, K.off])];
  const { result: data, lines } = await logsOf(() => dataOf(sections, { repo: { bundlesByIds: () => Promise.reject(new Error("database down")) } }));
  for (const [id, field] of [["sec_f1", "bundle"], ["sec_f2", "bundle"], ["sec_f3", "bundles"]]) {
    same(data.get(id).bindingFailed, [field], `${id}:`);
    eq(data.get(id).bindingFailedCause?.[field], "fault", `${id} cause:`);
    ok(lines.some((l) => l.evt === "section_binding_failed" && l.sectionId === id && l.field === field && l.cause === "fault"), `${id}: not logged: ${JSON.stringify(lines)}`);
  }
  const { result: live } = await logsOf(() => render(sections, data));
  eq(live, "", "live:");
  const { result: pv } = await logsOf(() => render(sections, data, { preview: true }));
  for (const id of ["sec_f1", "sec_f2", "sec_f3"]) ok(new RegExp(`data-section-id="${id}"[^>]*data-unfinished=""[^>]*data-section-failed=""`).test(pv), `${id}: no failed note in preview`);
  ok(words(pv).includes("Reload the preview to try again."), "the reload words");
});

await t("a home with 2 bundle cards and 1 grid of 4 calls bundlesByIds once (deduped ids) and costs at most 3 statements after a warm-up, through DEFAULT_REPO", async () => {
  const sections = [card("sec_b1", K.avail), card("sec_b2", K.sold), grid("sec_b3", [K.nosave, K.avail, K.off, K.notready])];
  const calls = [];
  const spy = { bundlesByIds: (ids) => (calls.push(ids), BR.bundlesByIds(ids)) };
  const viaSpy = await dataOf(sections, { repo: spy });
  same(calls, [[K.avail, K.sold, K.nosave, K.off, K.notready]], "one call, deduped, first-seen order:");
  // the real DEFAULT_REPO: same data, and the statement count
  const counted = await inT(async () => {
    await resolveHomeSectionData(sections); // warm the schema probe
    return watchStatements(currentDatabase().libsql, () => resolveHomeSectionData(sections));
  });
  ok(counted.statements.length <= 3, `at most 3 statements, got ${counted.statements.length}: ${counted.statements.join(" | ")}`);
  eq(counted.statements.length, 3, "bundles+offers, variants, products:");
  same(JSON.stringify([...counted.result.entries()]), JSON.stringify([...viaSpy.entries()]), "DEFAULT_REPO gives what the spy gives:");
  same(counted.result.get("sec_b3").bundles.map((b) => b.state), ["no_saving", "available", "disabled", "not_ready"], "grid states:");
});

// =====================================================================================
console.log("— edge safety, the cart, overlap, payloads");
// =====================================================================================
await t("the transitive import scan from BundleCardSection, BundleGridSection, lib/registry/sources.js and lib/commerce/bundle-read.js finds no lib/offers/ module and no node: import (tenant-context's async_hooks, which the edge runtime has, is the only Node module reached)", async () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
  const local = (f, spec) => {
    let r = spec.startsWith("@/") ? spec.slice(2) : join(dirname(f), spec);
    if (!r.endsWith(".js")) r = existsSync(join(ROOT, `${r}.js`)) ? `${r}.js` : join(r, "index.js");
    return existsSync(join(ROOT, r)) ? r : null;
  };
  const scan = async (start) => {
    const reached = new Set();
    const queue = [start];
    const hits = [];
    while (queue.length) {
      const f = queue.shift();
      if (reached.has(f)) continue;
      reached.add(f);
      const src = strip(await readFile(join(ROOT, f), "utf8"));
      for (const m of src.matchAll(nodeImport)) hits.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)["']((?:\.|@\/)[^"']+)["']/gm)) {
        const r = local(f, m[1]);
        if (r) queue.push(r);
      }
    }
    return { reached, hits };
  };
  const all = { reached: new Set(), hits: new Set() };
  for (const start of ["components/sections/BundleCardSection.js", "components/sections/BundleGridSection.js", "lib/registry/sources.js", "lib/commerce/bundle-read.js"]) {
    const r = await scan(start);
    for (const f of r.reached) all.reached.add(f);
    for (const h of r.hits) all.hits.add(h);
  }
  for (const f of ["components/BundleAddButton.js", "components/cart/CartContext.js", "lib/commerce/bundle-words.js", "lib/format.js", "components/sections/parts.js", "lib/db.js", "lib/catalog/effective.js"]) ok(all.reached.has(f), `${f} not reached (the scan does not follow): ${[...all.reached].join(", ")}`);
  same([...all.reached].filter((f) => f.startsWith("lib/offers/")), [], "lib/offers reached:");
  same([...all.hits], ["lib/tenant-context.js: node:async_hooks"], "node imports reached:");
});

await t("the cart from the block's add props equals the cart from getBundle(slug).components, as the bundle page adds them (lines and appliedOffers, the BUNDLE saving included)", async () => {
  const s = card("sec_k1", K.avail);
  const data = await dataOf([s]);
  addCalls.length = 0;
  await render([s], data);
  eq(addCalls.length, 1, "one add button:");
  const props = addCalls[0];
  same(Object.keys(props).sort(), ["components", "disabled"], "props:");
  eq(props.disabled, false, "disabled:");
  for (const c of props.components) same(Object.keys(c).sort(), ["available", "quantity", "variantId"], "per product, only variantId, quantity and available:");
  const page = await inT(() => B.getBundle("gym-kit"));
  ok(page && page.available, "the bundle page shows it");
  // BundleAddButton's addAll: every available product, through the normal cart API
  const addAll = async (cartId, components) => {
    await Cart.createCart(cartId);
    for (const c of components) if (c.available) await Cart.addItem(cartId, c.variantId, c.quantity);
    return Cart.getCart(cartId);
  };
  const [fromBlock, fromPage] = await inT(async () => [await addAll("cblk-block", props.components), await addAll("cblk-page", page.components)]);
  const lines = (c) => c.items.map((i) => [i.variantId, i.quantity, i.price]);
  same(lines(fromBlock), lines(fromPage), "lines:");
  same(fromBlock.appliedOffers.map((o) => [o.id, o.amount]), fromPage.appliedOffers.map((o) => [o.id, o.amount]), "appliedOffers:");
  const bundleLine = fromBlock.appliedOffers.find((o) => o.id === `bundle-${K.avail}`);
  eq(bundleLine?.amount, data.get("sec_k1").bundle.saving, "the BUNDLE saving the block shows is what the cart gives:");
  eq(fromBlock.total, fromPage.total, "total:");
});

await t("overlap fixture: A = {v7, v8} at 180 and B = {v7, v8, v9} at 200, both on: B's entry lists A in overlapsWith (and A lists B)", async () => {
  const data = await dataOf([card("sec_o1", K.ovB), grid("sec_o2", [K.ovA])]);
  same(data.get("sec_o1").bundle.overlapsWith, [{ id: K.ovA, title: "Pair A" }], "B lists A:");
  same(data.get("sec_o2").bundles[0].overlapsWith, [{ id: K.ovB, title: "Pair B" }], "A lists B:");
  // the card still shows: overlap is the founder's warning (P5-CHECKS, P5-EDITOR), not a shopper state
  ok(sectionOf(await render([card("sec_o1", K.ovB)], data), "sec_o1").includes("Pair B"), "the overlapping card shows");
});

await t("no rendered or serialised block payload holds catalog_title, sku or a SKU value", async () => {
  const sections = [card("sec_p1", K.avail), card("sec_p2", K.sold), grid("sec_p3", [K.avail, K.sold, K.off, K.missing, K.nosave, K.notready])];
  const data = await dataOf(sections);
  addCalls.length = 0;
  const r = await both(sections, data);
  const blobs = [JSON.stringify([...data.entries()]), JSON.stringify(addCalls), r.live, r.preview];
  for (const b of blobs) ok(!/catalog_title|"sku"|\bsku\b|FX-\d/i.test(b), `a payload holds a catalog title or SKU: ${b.match(/.{0,80}(catalog_title|sku|FX-\d).{0,80}/i)?.[0]}`);
  ok(addCalls.length >= 3, "the add props were recorded");
});

await t("worst cases: every lib/registry/fixtures.js case of both kinds renders live with no founder note and no rupee sign; the grid's 12 mixed cells keep only the shown states", async () => {
  for (const kind of ["bundle_card", "bundle_grid"]) {
    for (const c of Reg.worstCase(kind).cases) {
      const r = await both([c.section], new Map([[c.section.id, c.data]]));
      ok(!/data-founder-note|data-hidden-reason|₹|INR/.test(r.live), `${kind}/${c.name} live: ${r.live.slice(0, 300)}`);
      ok(r.live.length > 0, `${kind}/${c.name}: hidden live`);
      if (kind === "bundle_grid" && c.name === "max_items") {
        eq(c.data.bundles.length, 12, "12 cells:");
        const shown = [...r.live.matchAll(/data-bundle-state="([^"]+)"/g)].map((m) => m[1]);
        same(shown, c.data.bundles.filter((b) => ["available", "sold_out", "not_ready"].includes(b.state)).map((b) => b.state), "live cells:");
        eq((r.preview.match(/data-founder-note=""/g) || []).length, 12 - shown.length, "a preview note per dropped cell:");
      }
      if (kind === "bundle_card") {
        ok(c.data.bundle.title.length === 120 && c.data.bundle.components.length === 6 && c.data.bundle.components.some((x) => x.image == null) && c.data.bundle.currency, "the card worst case");
        ok(r.live.includes("data-media-fallback"), "the missing photo shows the token fallback");
      }
    }
  }
});

// =====================================================================================
console.log("— P5-FIX1: a deleted product, and a quantity that is not whole");
// =====================================================================================
// A product of a turned-on bundle leaves the catalog (its variant row goes, as
// a sync that drops it would). 1400 + 1500 = 2900 at 2800; what is left adds
// up to 1400, below the price, so before P5-FIX1 the bundle also read
// "saves nothing" and was hidden, with a note telling the founder to lower
// the price on a false sum.
async function withDeletedProduct(fn) {
  const id = await inT(async () => (await B.upsertBundle({ slug: "gone-part", title: "Gone part", items: items(14, 15), bundle_price: 2800, enable: true })).id);
  const saved = (await raw("SELECT * FROM variants WHERE id = ?", [V(15)])).rows[0];
  const cols = Object.keys(saved);
  await raw("DELETE FROM variants WHERE id = ?", [V(15)]);
  try {
    return await fn(id);
  } finally {
    await raw(`INSERT INTO variants (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((k) => saved[k]));
    await inT(() => B.deleteBundle(id));
  }
}

await t("P5-FIX1: a card whose bundle lost a product to the catalog is shown 'Currently unavailable' with that product marked 'No longer available'; in preview only, a note says to replace the product, never to lower the price", async () => {
  await withDeletedProduct(async (id) => {
    const s = card("sec_x1", id);
    const data = await dataOf([s]);
    const b = data.get("sec_x1").bundle;
    same([b.state, b.reasons.map((r) => r.kind)], ["sold_out", ["missing"]], "the read:");
    const why = BW.stateLine("sold_out", b.reasons, { currency: "USD" });
    eq(why, "A product in this bundle is no longer in your catalog: shoppers see Currently unavailable and can't add it. Replace it with another product in Bundles.", "the words:");
    const r = await both([s], data);
    for (const [mode, h] of Object.entries(r)) {
      const sec = sectionOf(h, "sec_x1");
      ok(sec, `${mode}: hidden`);
      const btns = buttonOf(sec);
      ok(btns.length === 1 && /disabled=""/.test(btns[0]) && btns[0].includes("Currently unavailable"), `${mode}: ${btns}`);
      ok(/>No longer available</.test(sec), `${mode}: the deleted product is not marked`);
      ok(!/Lower the price|add up to|hidden from shoppers/.test(words(sec)), `${mode}: no-saving words: ${sec.slice(0, 600)}`);
    }
    ok(!/data-founder-note|Replace it/.test(r.live), "live: a founder note");
    const note = r.preview.match(/<div data-founder-note=""[^>]*data-bundle-note="missing-product"[^>]*>[\s\S]*?<\/div>/)?.[0] || "";
    ok(words(note).includes(why) && note.includes(NOTE_ONLY), `preview note: ${note || r.preview.slice(0, 900)}`);
  });
});

await t("P5-FIX1: in a grid, the bundle that lost a product keeps its cell live (Currently unavailable), and in preview the cell carries the replace-the-product note, not a 'hidden from shoppers' note", async () => {
  await withDeletedProduct(async (id) => {
    const s = grid("sec_x2", [K.avail, id]);
    const data = await dataOf([s]);
    const r = await both([s], data);
    same([...r.live.matchAll(/data-bundle-state="([^"]+)"/g)].map((m) => m[1]), ["available", "sold_out"], "live cells:");
    ok(!/data-founder-note/.test(r.live), "live: no note");
    same([...r.preview.matchAll(/data-bundle-state="([^"]+)"/g)].map((m) => m[1]), ["available", "sold_out"], "preview cells:");
    ok(!/hidden from shoppers|data-bundle-cell/.test(r.preview), "preview: the cell is not dropped");
    const cell = r.preview.match(/<div data-bundle="[^"]+" data-bundle-state="sold_out"[\s\S]*$/)?.[0] || "";
    ok(/data-bundle-note="missing-product"/.test(cell) && words(cell).includes("Replace it with another product in Bundles."), `preview: the note in the cell: ${cell.slice(0, 900)}`);
  });
});

// The real bundle page (app/(storefront)/bundles/[slug]/page.js), rendered in
// this store. Its tenant lookup (tfetch) and closed-store gate need a real
// request; here tfetch runs the read in the store this suite is in, and the
// store is open.
STUBS["@/lib/tenant-request"] = { __esModule: true, tfetch: (fn) => fn() };
STUBS["@/lib/storefront-request"] = { __esModule: true, tfetch: (fn) => fn() };
STUBS["@/lib/content/resolve"] = { __esModule: true, closedStoreGate: async () => null };
const BundlePage = (await loadJsx(join(ROOT, "app/(storefront)/bundles/[slug]/page.js"))).default;
const renderPage = (slug) => inT(async () => html(await BundlePage({ params: Promise.resolve({ slug }) })));

await t("P5-FIX1: a turned-on bundle stored with a quantity of 1.5 is not_ready on the home card AND on the real bundle page, which says 'This bundle isn't available right now.', never 'A component is out of stock'; a sold-out bundle's page still says out of stock", async () => {
  const id = await inT(async () => (await B.upsertBundle({ slug: "half-qty", title: "Half qty", items: items(14, 16), bundle_price: 2900, enable: true })).id);
  // as a pre-P5 write could have left it: the row and its offer agree on 1.5
  const half = [{ variantId: V(14), quantity: 1.5 }, { variantId: V(16), quantity: 1 }];
  await raw("UPDATE bundles SET items = ? WHERE id = ?", [JSON.stringify(half), id]);
  await raw("UPDATE offers SET config = json_set(config, '$.items', json(?)) WHERE id = ?", [JSON.stringify(half), `bundle-${id}`]);
  try {
    const s = card("sec_x3", id);
    const data = await dataOf([s]);
    const b = data.get("sec_x3").bundle;
    same([b.state, b.reasons.map((r) => r.kind)], ["not_ready", ["bad_quantity"]], "the home read:");
    const live = sectionOf(await render([s], data), "sec_x3");
    ok(live && buttonOf(live).some((x) => /disabled=""/.test(x) && x.includes("Currently unavailable")), `the home card: ${live.slice(0, 400)}`);
    const page = await inT(() => B.getBundle("half-qty"));
    same([page.available, page.state], [false, "not_ready"], "getBundle:");
    const h = words(await renderPage("half-qty"));
    ok(h.includes("Half qty") && h.includes("This bundle isn't available right now."), `the page: ${h.slice(0, 600)}`);
    ok(!h.includes("A component is out of stock"), "the page says out of stock");
    ok(/<button[^>]*disabled=""[^>]*>Currently unavailable<\/button>/.test(h), "the page's add button is off");
    const sold = words(await renderPage("night-set"));
    ok(sold.includes("A component is out of stock — the set comes back when it does.") && !sold.includes("This bundle isn't available right now."), "a sold-out bundle's page");
    const fine = words(await renderPage("gym-kit"));
    ok(!/out of stock|isn't available right now/.test(fine), "an available bundle's page says neither");
  } finally {
    await inT(() => B.deleteBundle(id));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
rawClient.close();
await tn.cleanup();
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
