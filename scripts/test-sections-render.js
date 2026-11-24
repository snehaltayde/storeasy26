// P2-SECTIONS suite (DOC-03, DOC-07): sections render through one renderer map.
//   1. The contract: every registered section kind has exactly one component
//      in components/sections/index.js, and a fake kind registered here
//      renders through the map with data-section-id and data-section-kind.
//   2. Legacy equivalence: the real home page (app/(storefront)/page.js) and
//      components/ContentPage.js render exactly what a6d028e rendered, for v1,
//      v2 and v3 releases, legacy drafts, an S59 preview candidate and a
//      running hero experiment (scripts/support/home-render-outputs.js, run
//      here and inside an a6d028e checkout; data-section-* taken out).
//   3. A documents store (v4, published through the real service): the hero
//      image through StoreImage, a hidden hero, an experiment variant merged
//      with heroVariantSettings, and rails that never read collection_overrides.
//   4. The DOC-03 shopper state table, rendered: sold out, below minItems, an
//      empty collection, a missing image, a hero button to a sold-out product,
//      a page with no sections.
//   3b. P3-VALIDATE (PV-02, AU-04): a section whose own render or data
//      binding fails is left out live and shown as a note in the preview; a
//      hero holding a broken draft value previews as its note; every kind's
//      starter section saves, previews and renders.
//   5. Edge safety of the files this item touches.
//   6. P5-HIDDEN (COM-01): a section that hides itself gives the founder a
//      reason in a documents preview (a component's hiddenReason), never
//      live; the binding-failed note names its cause. Live renders of every
//      kind's worst-case fixtures are byte-equal to the base (b09f342).
// Everything is rendered with Next's own SWC and react-dom/server; no browser.
//   pnpm test:sections-render
//   SR_RECORD=1 node scripts/test-sections-render.js   prints the live digests (section 6)
// request-cache must load before any app module that imports react (P5-HIDDEN:
// a real documents preview notes its request scope through React's cache()).
import "./support/request-cache.js";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__sectionsRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() { const r = req(); return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) }; }
export async function cookies() { const r = req(); return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) }; }
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
process.env.DATABASE_URL = "file:.test-sr-default.db";
process.env.PLATFORM_DB_URL = "file:.test-sr-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const TENANTS = ["srv", "srl"];
const OUTPUTS = ".test-sr-home-outputs.json";
const dbs = [".test-sr-default.db", ".test-sr-platform.db", OUTPUTS, ...TENANTS.map((t) => `.test-sr-${t}.db`)];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, currentDatabase } = await import("../lib/db.js");
const X = await import("../lib/experiments.js");
const Reg = await import("../lib/registry/index.js");
const Svc = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const { resolveHomeSectionData } = await import("../lib/cms/section-data.js");
const { createPreviewSession } = await import("../lib/preview-sessions.js");
const { PREVIEW_COOKIE } = await import("../lib/preview-sessions.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ") || e.message}`);
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
  if (a !== b) throw new Error(`${m}\n      expected ${b.slice(0, 600)}\n      got      ${a.slice(0, 600)}`);
};
// The attributes this item adds, taken out for comparing with a6d028e.
const normalize = (h) => h.replace(/ data-section-(?:id|kind)="[^"]*"/g, "");

// ---- the JSX loader (Next's SWC, as test-releases and test-images do) -------------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
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
const exists = (f) => readFile(f).then(
  () => true,
  () => false,
);
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/components/site/MarketingHome": { __esModule: true, default: () => null },
  // the exposure ping renders a marker, so a render shows whether it would ping
  "@/components/ExperimentPing": { __esModule: true, default: ({ slug }) => React.createElement("i", { "data-exp-ping": slug }) },
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
      if (!target.endsWith(".js")) target = (await exists(`${target}.js`)) ? `${target}.js` : join(target, "index.js");
      deps.set(id, isJsx(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
    } else if (id === "next/headers") deps.set(id, await import("next/headers"));
    else deps.set(id, require(id));
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
const Map_ = await loadJsx(join(ROOT, "components/sections/index.js"));
const { SectionView, checkSectionComponents, registerSectionComponent, sectionComponentKinds } = Map_;
const HomeSections = (await loadJsx(join(ROOT, "components/sections/HomeSections.js"))).default;
const ContentPageMod = await loadJsx(join(ROOT, "components/ContentPage.js"));
const ContentPage = ContentPageMod.default;
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"))).default;
// P5-BLOCKS: the storefront layout wraps every page in CartProvider; the bundle
// blocks' add button (components/BundleAddButton.js, useCart) needs it. It
// renders no markup of its own, and server rendering runs no effects.
const { CartProvider } = await loadJsx(join(ROOT, "components/cart/CartContext.js"));
const html = (el) => renderToStaticMarkup(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, React.createElement(CartProvider, null, el)));
const view = (section, data = {}, ctx = { surface: "home", secKey: section.id }) => html(React.createElement(SectionView, { section, data, ctx }));
const home = (sections, dataById = new Map(), emptyNote = false) => html(React.createElement(HomeSections, { sections, dataById, emptyNote }));

async function asRequest(host, cookies, fn) {
  globalThis.__sectionsRequest = { host, cookies };
  try {
    return await fn();
  } finally {
    globalThis.__sectionsRequest = null;
  }
}
const renderHome = (host, cookies = { _unit: "unit-sections-plain" }) => asRequest(host, cookies, async () => html(await Home()));

// Statements the current tenant's client runs while fn runs.
async function watch(fn) {
  const client = currentDatabase().libsql;
  const execute = client.execute;
  const statements = [];
  client.execute = async (stmt, ...rest) => {
    statements.push(typeof stmt === "string" ? stmt : String(stmt?.sql ?? ""));
    return execute.call(client, stmt, ...rest);
  };
  try {
    return { result: await fn(), statements };
  } finally {
    delete client.execute;
  }
}

// ---- tenants --------------------------------------------------------------------
const P = (n) => `gid://shopify/Product/${n}`;
const COL = (n) => `gid://shopify/Collection/${n}`;
const NOW = "2026-11-04T10:00:00.000Z";
const LIB_IMG = "/api/media/med_ae5f4af4b10aec0b01";

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");

async function tenant(id) {
  await C.upsertTenant({ id, name: `SR ${id}`, domains: [`${id}.test`], dbUrl: `file:.test-sr-${id}.db`, config: { site: { name: `SR ${id} Store` } }, secrets: { order_link_secret: `${id}-secret` } });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, MIGRATIONS);
    const run = (sql, args = []) => libsql.execute({ sql, args });
    await run("INSERT INTO collections (id, handle, title, synced_at) VALUES (?, 'serums', 'Serums', ?), (?, 'whey', 'Whey', ?), (?, 'empty-shelf', 'Empty shelf', ?)", [COL(1), NOW, COL(2), NOW, COL(3), NOW]);
    for (const [n, handle, title, col, pos] of [
      [1, "glow-serum", "Glow Serum", 1, 0],
      [2, "night-cream", "Night Cream", 1, 1],
      [3, "dew-drops", "Dew Drops", 1, 2],
      [4, "whey-gold", "Whey Gold", 2, 0],
      [5, "whey-isolate", "Whey Isolate", 2, 1],
      [6, "whey-vanilla", "Whey Vanilla", 2, 2],
    ]) {
      await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, created_at, synced_at) VALUES (?, ?, ?, 999, 999, 'INR', 1, ?, ?)", [P(n), handle, title, `2025-0${n}-01T00:00:00.000Z`, NOW]);
      await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)", [COL(col), P(n), pos]);
    }
    // a legacy pin on serums: a legacy store's rail follows it; a v4 store must never read it
    await run("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(1), JSON.stringify([P(3)])]);
  });
  return T;
}
const V4 = await tenant("srv");
const LEG = await tenant("srl");
const inV4 = (fn) => withTenant(V4, fn);
const inLeg = (fn) => withTenant(LEG, fn);
await inV4(() => libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1"));

const sec = (kind, id, settings = {}, extra = {}) => {
  const s = Reg.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings }, ...extra };
};
const HERO_SETTINGS = {
  title: "Glow from within",
  highlight: "Glow",
  subtitle: "Clean skincare, made in small batches.",
  primary: { label: "Shop serums", link: { type: "url", href: "/collections/serums" } },
  secondary: { label: "What’s new", link: { type: "url", href: "#new" } },
  badge: "",
};
const homeBody = (sections) => ({ ...Reg.emptyBody("home"), sections });
// Publish doc_home through the real service (create or save, then publish).
async function publishHome(sections) {
  return inV4(async () => {
    let d;
    try {
      const cur = await Svc.getDocument("doc_home");
      d = (await Svc.saveDraft({ id: cur.id, revision: cur.revision, body: homeBody(sections) })).document;
    } catch (e) {
      if (e?.status !== 404 && !/no longer exists/.test(e?.message || "")) throw e;
      d = (await Svc.createDocument({ type: "home", body: homeBody(sections) })).document;
    }
    const r = await Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }] });
    // the same content as live is skipped: nothing to publish, live is already it
    if (r.skipped?.includes(d.id) && d.draftHash === d.publishedHash) return r;
    ok(r.release?.id, `the home page did not publish: ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  });
}
const heroOf = (h) => h.match(/<section[^>]*data-sec="hero"[\s\S]*?<\/section>/)?.[0] || "";
const imgs = (h) => [...h.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

// ---- P5-HIDDEN: live renders of every kind's worst-case fixtures ------------------
//
// For each registered kind, every worst-case fixture (lib/registry/fixtures.js)
// rendered live four ways: SectionView on the home page and on a content page
// with the fixture's data, and HomeSections with that data and with none (the
// hidden state, where P5-HIDDEN's note goes in a preview). No request, so no
// preview scope: what a shopper gets. One sha256 per kind.
const sha = (v) => createHash("sha256").update(v).digest("hex");
const { worstCase, worstBundle } = await import("../lib/registry/fixtures.js");
function liveWorstCaseDigests() {
  const out = {};
  for (const kind of Reg.sectionKinds()) {
    const parts = [];
    for (const c of worstCase(kind).cases) {
      const extra = kind === "product_main" ? { productMain: React.createElement("p", null, "buy") } : {};
      parts.push(`${c.name}/home-view`, view(c.section, c.data, { surface: "home", secKey: c.section.id, ...extra }));
      parts.push(`${c.name}/page-view`, view(c.section, c.data, { surface: "page", ...extra }));
      parts.push(`${c.name}/home`, home([c.section], new Map([[c.section.id, c.data]])));
      parts.push(`${c.name}/home-nodata`, home([c.section], new Map()));
      parts.push(`${c.name}/home-nodata-empty-note`, home([c.section], new Map(), true));
    }
    out[kind] = sha(parts.join("\n\u0000"));
  }
  return out;
}
if (process.env.SR_RECORD === "1") {
  console.log(JSON.stringify(liveWorstCaseDigests(), null, 2));
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
  process.exit(0);
}

// =====================================================================================
console.log("— 1. the renderer map and the registry");
// =====================================================================================
await t("every registered section kind has exactly one component in the map, and the map has no other", () => {
  same(checkSectionComponents(Reg.sectionKinds()), [], "contract problems:");
  same([...sectionComponentKinds()].sort(), [...Reg.sectionKinds()].sort(), "map kinds vs registry kinds:");
  for (const kind of Reg.sectionKinds()) eq(typeof Map_.sectionComponent(kind), "function", `${kind}:`);
});

await t("NEGATIVE: a kind registered with no component fails the contract check; a component with no registered kind fails it too", () => {
  Reg.defineSection({ kind: "fake_quote", version: 1, label: "Quote", documentTypes: ["home", "page"], settings: [{ key: "title", kind: "text", label: "Quote", max: 200, default: "Less, but better." }] });
  try {
    const problems = checkSectionComponents(Reg.sectionKinds());
    ok(problems.some((p) => p.includes(`"fake_quote" is registered but has no component`)), `not reported: ${JSON.stringify(problems)}`);
    const drop = registerSectionComponent("orphan_kind", () => null);
    try {
      ok(checkSectionComponents(Reg.sectionKinds()).some((p) => p.includes(`"orphan_kind", which isn't a registered section kind`)), "an orphan component was not reported");
    } finally {
      drop();
    }
  } finally {
    Reg.removeSection("fake_quote");
  }
});

await t("a fake kind registered here renders through the map, on the home page and on a content page, with data-section-id and data-section-kind", () => {
  Reg.defineSection({ kind: "fake_quote", version: 1, label: "Quote", documentTypes: ["home", "page"], settings: [{ key: "title", kind: "text", label: "Quote", max: 200, default: "Less, but better." }] });
  const Quote = ({ section, attrs }) => React.createElement("blockquote", { ...attrs, className: "quote" }, section.settings.title);
  const drop = registerSectionComponent("fake_quote", Quote);
  try {
    same(checkSectionComponents(Reg.sectionKinds()), [], "with its component:");
    const q = Reg.newSection("fake_quote", { id: "sec_quote1" });
    const h = home([q, sec("banner", "sec_bn1", { title: "Hi" })]);
    ok(h.includes('<blockquote data-section-id="sec_quote1" data-section-kind="fake_quote" class="quote">Less, but better.</blockquote>'), `home: ${h}`);
    ok(h.indexOf("fake_quote") < h.indexOf('data-section-id="sec_bn1"'), "order kept");
    // a content page renders registry kinds through the same map
    const viaPage = view(q, {}, { surface: "page" });
    eq(viaPage, '<blockquote data-section-id="sec_quote1" data-section-kind="fake_quote" class="quote">Less, but better.</blockquote>', "page:");
  } finally {
    drop();
    Reg.removeSection("fake_quote");
  }
  eq(view({ id: "sec_x", kind: "fake_quote", settings: {} }), "", "a kind with no component renders nothing:");
});

await t("every registered kind's root element carries data-section-id and data-section-kind", () => {
  const data = {
    collections: { collections: [{ handle: "serums", title: "Serums", product_count: 3 }] },
    new: { products: [1, 2, 3].map((n) => ({ handle: `p${n}`, title: `P${n}`, price_min: 1, price_max: 1, currency: "INR", available: true })) },
    product_rail: { products: [1, 2, 3].map((n) => ({ handle: `p${n}`, title: `P${n}`, price_min: 1, price_max: 1, currency: "INR", available: true })) },
    // P5-BLOCKS: a bundle that shows
    bundle_card: { bundle: worstBundle("bun-root", "available") },
    bundle_grid: { bundles: [worstBundle("bun-root", "available")] },
  };
  const ctxFor = (kind) => ({ surface: "home", secKey: `sec_${kind}`, ...(kind === "product_main" ? { productMain: React.createElement("p", null, "buy") } : {}) });
  for (const kind of Reg.sectionKinds()) {
    const s = sec(kind, `sec_${kind}`, kind === "product_rail" ? { collection: { handle: "serums" } } : kind === "banner" ? { title: "B" } : {});
    for (const surface of ["home", "page"]) {
      const h = view(s, data[kind] || {}, { ...ctxFor(kind), surface });
      const root = h.match(/^<[a-z]+\b[^>]*>/)?.[0] || "";
      ok(attr(root, "data-section-id") === s.id && attr(root, "data-section-kind") === kind, `${kind} on ${surface}: root is ${root || h.slice(0, 120)}`);
    }
  }
});

// =====================================================================================
// (Section 2 legacy a6d028e HTML parity removed — Legacy CMS retired)
const then = JSON.parse(await readFile(join(here, "fixtures/home-render-outputs.a6d028e.json"), "utf8"));

console.log("— 3. a documents store (v4)");
// =====================================================================================
await t("a v4 home with a hero image renders the image and its alt through StoreImage (a library photo stays its own url)", async () => {
  await publishHome([sec("hero", "sec_hero", { ...HERO_SETTINGS, image: { media: LIB_IMG, alt: "A jar on linen" } }), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
  const h = await renderHome("srv.test");
  const hero = heroOf(h);
  ok(hero, `no hero: ${h.slice(0, 300)}`);
  const [img] = imgs(hero);
  ok(img, `no image in the hero: ${hero}`);
  eq(attr(img, "src"), LIB_IMG, "src (not /_next/image):");
  eq(attr(img, "alt"), "A jar on linen", "alt:");
  ok(!/srcset=/.test(img), "a library photo got a srcset to the optimizer");
  ok(/data-hero-image=""/.test(hero), "the image frame is missing");
  // a Shopify photo still goes through the optimizer
  const shop = view(sec("hero", "sec_h2", { ...HERO_SETTINGS, image: { media: "https://cdn.shopify.com/s/files/1/0001/hero.jpg", alt: "Shop photo" } }), {}, { surface: "home" });
  ok(attr(imgs(shop)[0], "src").startsWith("/_next/image?url=https%3A%2F%2Fcdn.shopify.com"), `shopify src: ${imgs(shop)[0]}`);
});

await t("without an image, the hero's markup equals the legacy hero's (a6d028e drafts, same words and counts)", () => {
  const legacyHero = heroOf(then.states.drafts.home);
  ok(legacyHero, "no hero in the fixture");
  for (const image of [null, { media: "", alt: "" }, undefined]) {
    const settings = { ...HERO_SETTINGS };
    if (image !== undefined) settings.image = image;
    const s = { ...sec("hero", "sec_hero", settings) };
    if (image === undefined) delete s.settings.image;
    const h = view(s, {}, { surface: "home", empty: false, stats: { products: 9, collections: 3 }, notice: null });
    eq(normalize(h), legacyHero, `image ${JSON.stringify(image)}:`);
  }
});

await t("a v4 home whose hero is hidden renders without a hero, with no error, and its sections still show", async () => {
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS, { enabled: false }), sec("new", "sec_new1", { title: "New in", limit: 3 }), sec("banner", "sec_bn1", { title: "Hello there", text: "x" })]);
  const h = await renderHome("srv.test");
  eq(heroOf(h), "", "a hero rendered:");
  ok(!/<h1/.test(h), "an h1 rendered");
  ok(/data-section-id="sec_new1"/.test(h) && /Hello there/.test(h), `the sections are missing: ${h.slice(0, 400)}`);
  ok(!/data-exp-ping/.test(h), "a hidden hero pinged an experiment");
});

await t("a v4 home's rails never read collection_overrides (plan decision 9)", async () => {
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("product_rail", "sec_rail1", { title: "Serums", collection: { handle: "serums", id: COL(1) }, limit: 3 })]);
  const v4 = await inV4(() => watch(() => renderHome("srv.test")));
  same(v4.statements.filter((q) => /collection_overrides/i.test(q)), [], "v4 statements on collection_overrides:");
  const v4Rail = v4.result.match(/data-section-id="sec_rail1"[\s\S]*?<\/section>/)?.[0] || "";
  same([...v4Rail.matchAll(/href="\/products\/([^"]+)"/g)].map((m) => m[1]), ["glow-serum", "night-cream", "dew-drops"], "v4 rail order (the collection's own):");
});

await t("section-data: never asks for legacy pins (a repo with the old per-rail read is never called)", async () => {
  const calls = [];
  const repo = {
    getNewestProducts: async () => [],
    getFeaturedCollections: async () => [],
    getCollectionsByHandles: async () => [],
    collectionPinsByHandle: async (h) => (calls.push(`pins:${h}`), ["p2"]),
    getProductsInCollection: async (h, o) => (calls.push(`products:${h}:${JSON.stringify(o.pins ?? null)}`), { products: [{ handle: "a" }, { handle: "b" }, { handle: "c" }] }),
  };
  const rail = sec("product_rail", "sec_r1", { collection: { handle: "serums", id: COL(1) }, limit: 3 });
  const v4 = await resolveHomeSectionData([rail], { repo });
  same(calls, ["products:serums:[]"], "v4 calls:");
  eq(v4.get("sec_r1").handPicked, false, "v4 handPicked:");
});

await t("an experiment variant merged with heroVariantSettings changes only the variant's fields (v4: the image, badge and other button stay)", async () => {
  const base = { ...HERO_SETTINGS, badge: "New season", image: { media: LIB_IMG, alt: "A jar" } };
  // a variant names title, highlight and subtitle (cleanVariantPayload always
  // carries the three) and maybe a button
  const payload = { title: "Glow, simply", highlight: "simply", subtitle: "Fewer words.", primary: { label: "Try it", href: "/collections/whey" } };
  const merged = X.heroVariantSettings(base, payload);
  const changed = Object.keys(merged).filter((k) => JSON.stringify(merged[k]) !== JSON.stringify(base[k])).sort();
  same(changed, ["highlight", "primary", "subtitle", "title"], "changed settings:");
  same(merged.primary, { label: "Try it", link: { type: "url", href: "/collections/whey" } }, "the variant's button, as a typed link:");

  // rendered, on a published v4 home with a running test
  await publishHome([sec("hero", "sec_hero", base), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
  await inV4(async () => {
    await X.upsertExperiment({ slug: "hero-v4", name: "Hero v4", hypothesis: "h", target_kind: "hero", variants: [{ key: "control", weight: 50, payload: null }, { key: "b", weight: 50, payload }], min_sample: 200 });
    await X.startExperiment("hero-v4");
  });
  try {
    const exp = await inV4(() => X.runningExperimentFor("hero"));
    const unit = (key) => {
      for (let i = 0; ; i++) if (X.assignVariant(exp, `unit-sr-${i}`) === key) return `unit-sr-${i}`;
    };
    const b = heroOf(await renderHome("srv.test", { _unit: unit("b") }));
    const c = heroOf(await renderHome("srv.test", { _unit: unit("control") }));
    ok(/Glow, <span class="text-sf-hero-accent">simply<\/span>/.test(b) && /href="\/collections\/whey"[^>]*>Try it</.test(b) && b.includes("Fewer words."), `variant b not applied: ${b.slice(0, 600)}`);
    ok(c.includes("Clean skincare, made in small batches.") && !c.includes("Fewer words."), "control lost its subtitle");
    for (const [name, h] of [
      ["b", b],
      ["control", c],
    ]) {
      eq(attr(imgs(h)[0] || "", "src"), LIB_IMG, `${name}: the image:`);
      ok(h.includes("New season"), `${name}: the badge is gone`);
      ok(/href="#new"[^>]*>What’s new</.test(h), `${name}: the other button is gone`);
    }
    ok(/<span class="text-sf-hero-accent">Glow<\/span> from within/.test(c), "control changed");
    const withPing = await renderHome("srv.test", { _unit: unit("b") });
    ok(/data-exp-ping="hero-v4"/.test(withPing), "a visitor in the test isn't counted");
  } finally {
    await inV4(() => libsql.execute("UPDATE experiments SET status = 'completed'"));
  }
});

await t("a hero image off the Shopify CDN (any https photo, or a '/' path) publishes and renders as its own url, never through /_next/image", async () => {
  const OTHER = "https://images.example.com/jar.jpg";
  // the registry accepts it, so the publish succeeds: the page must then show it
  const issues = Reg.validateDocument(homeBody([sec("hero", "sec_hero", { ...HERO_SETTINGS, image: { media: OTHER, alt: "A jar" } })]), { mode: "publish" });
  ok(issues.ok === true && issues.issues.length === 0, `the validator refused it: ${JSON.stringify(issues.issues)}`);
  await publishHome([sec("hero", "sec_hero", { ...HERO_SETTINGS, image: { media: OTHER, alt: "A jar" } }), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production"; // the optimizer's url, as a shopper's browser gets it
  try {
    for (const [media, h] of [
      [OTHER, heroOf(await renderHome("srv.test"))],
      ["/uploads/x.jpg", view(sec("hero", "sec_h3", { ...HERO_SETTINGS, image: { media: "/uploads/x.jpg", alt: "" } }), {}, { surface: "home" })],
    ]) {
      const [img] = imgs(h);
      ok(img, `${media}: no image in the hero: ${h.slice(0, 300)}`);
      eq(attr(img, "src"), media, `${media}: src:`);
      ok(!/_next\/image/.test(img), `${media}: sent to the optimizer, which refuses it: ${img}`);
    }
    // the Shopify CDN still goes through the optimizer
    const shop = view(sec("hero", "sec_h2", { ...HERO_SETTINGS, image: { media: "https://cdn.shopify.com/s/files/1/0001/hero.jpg", alt: "" } }), {}, { surface: "home" });
    ok(attr(imgs(shop)[0], "src").startsWith("/_next/image?url=https%3A%2F%2Fcdn.shopify.com"), `shopify src: ${imgs(shop)[0]}`);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
  }
});

await t("DOC-05 through page.js: in the founder's preview an unfinished banner and rail show the 'not finished yet' note with their placeholder; shoppers never see it", async () => {
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
  const { token } = await inV4(async () => {
    const cur = await Svc.getDocument("doc_home");
    const r = await Svc.saveDraft({
      id: cur.id,
      revision: cur.revision,
      body: homeBody([
        sec("hero", "sec_hero", HERO_SETTINGS),
        sec("banner", "sec_bn", { title: "", text: "" }),
        sec("product_rail", "sec_rail", { title: "Picks", collection: null }),
        sec("new", "sec_new1", { title: "Draft new", limit: 3 }),
      ]),
    });
    for (const id of ["sec_bn", "sec_rail"]) ok(r.issues.some((i) => i.sectionId === id && i.severity !== "warning"), `${id} is not incomplete: ${JSON.stringify(r.issues)}`);
    return createPreviewSession({ actor: { kind: "merchant", id: 1 } });
  });
  const h = await renderHome("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
  ok(h.includes("Draft new"), `not the preview: ${h.slice(0, 400)}`);
  for (const [id, kind, label, placeholder] of [
    ["sec_bn", "banner", "Banner", "Write a short message, with an optional button"],
    ["sec_rail", "product_rail", "Product rail", "Pick a collection to show its products"],
  ]) {
    const root = h.match(new RegExp(`<section[^>]*data-section-id="${id}"[^>]*>[\\s\\S]*?</section>`))?.[0] || "";
    ok(root, `${id}: nothing rendered: ${h.slice(0, 600)}`);
    eq(attr(root, "data-section-kind"), kind, `${id} kind:`);
    eq(attr(root, "data-sec"), id, `${id} data-sec (the preview's click target):`);
    ok(root.includes(`${label}: not finished yet`), `${id}: no title: ${root}`);
    ok(root.includes(`${placeholder}. Only you can see this in your preview. Finish this section to publish this page.`), `${id}: no note: ${root}`);
    ok(/data-unfinished=""/.test(root), `${id}: no data-unfinished`);
  }
  const live = await renderHome("srv.test");
  ok(!/not finished yet|Only you can see this|data-unfinished/.test(live) && !live.includes("Draft new"), "a shopper saw the draft or the note");
  // the renderer itself: an unfinished banner is the note, not an empty box
  const one = view(sec("banner", "sec_bn", { title: "", text: "" }, { unfinished: { label: "Banner", placeholder: "Write a short message, with an optional button" } }));
  ok(one.includes("Banner: not finished yet") && !/bg-sf-accent-soft/.test(one), `banner: ${one}`);
});

// =====================================================================================
console.log("— 3b. P3-VALIDATE: one broken section never blocks the rest (PV-02), added sections start good (AU-04)");
// =====================================================================================
// react-dom/server's prerender waits for async components (a section that
// failed asks the request whether it is a preview), where renderToStaticMarkup
// can't. Both are compared only with themselves.
const { prerenderToNodeStream } = require("react-dom/static");
const htmlAsync = async (el) => {
  const { prelude } = await prerenderToNodeStream(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, React.createElement(CartProvider, null, el)));
  let out = "";
  for await (const chunk of prelude) out += chunk;
  return out;
};
const renderHomeAsync = (host, cookies = { _unit: "unit-sections-plain" }) => asRequest(host, cookies, async () => htmlAsync(await Home()));
// console.log lines a function writes (slog), parsed
async function logsOf(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => {
    lines.push(a.join(" "));
  };
  try {
    return { result: await fn(), lines: lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
  } finally {
    console.log = log;
  }
}
const sectionHtml = (h, id) => h.match(new RegExp(`<section[^>]*data-section-id="${id}"[^>]*>[\\s\\S]*?</section>`))?.[0] || "";
const NOTE = "This section couldn&#x27;t be shown";
const previewToken = () => inV4(async () => (await createPreviewSession({ actor: { kind: "merchant", id: 1 } })).token);

await t("a server section whose own render throws: in the founder's preview it shows 'This section couldn't be shown' while the others render; live, the healthy sections render exactly as without it, with no note, and a log line names it", async () => {
  Reg.defineSection({ kind: "fake_boom", version: 1, label: "Countdown", documentTypes: ["home"], settings: [{ key: "title", kind: "text", label: "Title", max: 80, default: "Ends soon" }] });
  Reg.defineSection({ kind: "fake_boom_async", version: 1, label: "Reviews", documentTypes: ["home"], settings: [{ key: "title", kind: "text", label: "Title", max: 80, default: "Reviews" }] });
  const dropA = registerSectionComponent("fake_boom", () => {
    throw new Error("render exploded");
  });
  const dropB = registerSectionComponent("fake_boom_async", async () => {
    await new Promise((r) => setTimeout(r, 2));
    throw new Error("async render exploded");
  });
  try {
    const healthy = [sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 }), sec("banner", "sec_bn1", { title: "Hello there", text: "x" })];
    await publishHome(healthy);
    const without = await renderHomeAsync("srv.test");
    ok(/data-section-id="sec_bn1"/.test(without) && /data-section-id="sec_new1"/.test(without), "the healthy page renders");
    // the same page, through renderToStaticMarkup, still renders: healthy sections stay synchronous
    eq(normalize(await renderHome("srv.test")).length > 0, true);

    await publishHome([healthy[0], healthy[1], sec("fake_boom", "sec_boom1"), healthy[2], sec("fake_boom_async", "sec_boom2")]);
    const live = await logsOf(() => renderHomeAsync("srv.test"));
    eq(live.result, without, "live output with a failing section equals the page without it:");
    ok(!/couldn.t be shown|data-section-failed|sec_boom/.test(live.result), "a shopper sees a note or a trace");
    const failedLines = live.lines.filter((l) => l.evt === "section_render_failed");
    same(failedLines.map((l) => [l.sectionId, l.kind, l.cause]).sort(), [["sec_boom1", "fake_boom", "render"], ["sec_boom2", "fake_boom_async", "render"]], "log lines:");
    ok(failedLines.every((l) => /exploded/.test(l.error)), "the log line carries the error");

    const token = await previewToken();
    const pv = await renderHomeAsync("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
    for (const [id, label] of [["sec_boom1", "countdown"], ["sec_boom2", "reviews"]]) {
      const root = sectionHtml(pv, id);
      ok(root, `${id}: no note in the preview: ${pv.slice(pv.indexOf("sec_new1") - 100)}`);
      ok(root.includes(NOTE), `${id}: the note's title: ${root}`);
      ok(root.includes(`Something went wrong while showing this ${label} section. Only you can see this note in your preview`), `${id}: the note's words: ${root}`);
      ok(/data-unfinished=""/.test(root) && /data-section-failed=""/.test(root), `${id}: marked`);
    }
    ok(/data-section-id="sec_bn1"/.test(pv) && pv.includes("Hello there") && /data-section-id="sec_new1"/.test(pv) && heroOf(pv), "the other sections render in the preview");

    // the renderer alone, with ctx.preview given (no request needed)
    const boom = sec("fake_boom", "sec_boom1");
    ok(view(boom, {}, { surface: "home", preview: true }).includes(NOTE), "ctx.preview true: the note");
    eq(view(boom, {}, { surface: "home", preview: false }), "", "ctx.preview false: nothing");
    eq(await htmlAsync(React.createElement(SectionView, { section: sec("fake_boom_async", "sec_boom2"), ctx: { surface: "page", preview: false } })), "", "async, live: nothing");
    ok((await htmlAsync(React.createElement(SectionView, { section: sec("fake_boom_async", "sec_boom2"), ctx: { surface: "page", preview: true } }))).includes(NOTE), "async, preview: the note");
  } finally {
    dropA();
    dropB();
    Reg.removeSection("fake_boom");
    Reg.removeSection("fake_boom_async");
  }
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

await t("one failing data binding does not blank the page: the resolver settles per binding, the failing section is left out live and shows the note in the preview", async () => {
  const p3 = [1, 2, 3].map((n) => ({ handle: `p${n}`, title: `P${n}`, price_min: 1, price_max: 1, currency: "INR", available: true }));
  const repo = {
    getNewestProducts: async () => {
      throw new Error("SQLITE_BUSY: database is locked");
    },
    getFeaturedCollections: async () => [{ handle: "serums", title: "Serums", product_count: 3 }],
    getCollectionsByHandles: async () => [],
    getProductsInCollection: async () => ({ products: p3 }),
  };
  const sections = [sec("new", "sec_new1", { title: "New in", limit: 3 }), sec("product_rail", "sec_rail1", { title: "Serums rail", collection: { handle: "serums" }, limit: 3 }), sec("collections", "sec_c1", { title: "Shop by collection" })];
  const { result: data, lines } = await logsOf(() => resolveHomeSectionData(sections, { repo }));
  same(data.get("sec_new1"), { bindingFailed: ["products"] }, "the failing section's data:");
  eq(data.get("sec_rail1").products.length, 3, "the rail still has its products:");
  eq(data.get("sec_c1").collections.length, 1, "the grid still has its collections:");
  same(lines.filter((l) => l.evt === "section_binding_failed").map((l) => [l.sectionId, l.field, l.source]), [["sec_new1", "products", "newest_products"]], "log line:");
  // a curated read and a pins read that fail are never replaced by a guess
  const pinsDown = { ...repo, getNewestProducts: async () => p3, livePinsByHandles: async () => { throw new Error("pins down"); } };
  const downed = await logsOf(() => resolveHomeSectionData(sections, { repo: pinsDown, index: { featured: ["serums"] } }));
  same(downed.result.get("sec_rail1"), { bindingFailed: ["products"] }, "a rail whose pins can't be read fails, never shows the unpinned order:");
  eq(downed.result.get("sec_new1").products.length, 3, "the newest products are fine");
  const curatedDown = { ...repo, getNewestProducts: async () => p3, getCollectionsByHandles: async () => { throw new Error("curated down"); } };
  same((await logsOf(() => resolveHomeSectionData(sections, { repo: curatedDown, index: { featured: ["serums"] }}))).result.get("sec_c1"), { bindingFailed: ["collections"] }, "a grid whose curated list can't be read fails, never shows the uncurated list:");

  // rendered: live leaves the section out and keeps the rest; the preview shows the note
  const live = await inV4(() => asRequest("srv.test", {}, () => htmlAsync(React.createElement(HomeSections, { sections, dataById: data }))));
  ok(!/sec_new1|couldn.t be shown/.test(live), "a shopper sees the failing section or a note");
  ok(/data-section-id="sec_rail1"/.test(live) && /Serums rail/.test(live) && /data-section-id="sec_c1"/.test(live), `the rest of the page is there: ${live.slice(0, 300)}`);
  const token = await previewToken();
  const pv = await inV4(() => asRequest("srv.test", { [PREVIEW_COOKIE]: token }, () => htmlAsync(React.createElement(HomeSections, { sections, dataById: data }))));
  ok(sectionHtml(pv, "sec_new1").includes(NOTE) && sectionHtml(pv, "sec_new1").includes("newest products section"), `the preview note: ${pv.slice(0, 400)}`);
  ok(/data-section-id="sec_rail1"/.test(pv), "the preview keeps the rest");
  // before P3-VALIDATE the whole resolver rejected
  let rejected = false;
  await resolveHomeSectionData(sections, { repo }).catch(() => (rejected = true));
  eq(rejected, false, "the resolver itself never rejects for one binding:");
});

await t("PV-02: a hero draft holding a broken value (a link that isn't a page of the store) previews as its note, never with the link; a hero only missing words still shows its placeholder", async () => {
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
  const save = (sections) =>
    inV4(async () => {
      const cur = await Svc.getDocument("doc_home");
      return Svc.saveDraft({ id: cur.id, revision: cur.revision, body: homeBody(sections) });
    });
  const r = await save([sec("hero", "sec_hero", { ...HERO_SETTINGS, title: "Draft hero", primary: { label: "Go", link: { type: "url", href: "https://evil.example/x" } } }), sec("new", "sec_new1", { title: "Draft new", limit: 3 })]);
  ok(r.issues.some((i) => i.sectionId === "sec_hero" && i.code === "LINK_NOT_STOREFRONT" && i.severity === "incomplete"), `saved as incomplete: ${JSON.stringify(r.issues)}`);
  const token = await previewToken();
  const pv = await renderHome("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
  ok(pv.includes("Draft new"), "the preview shows the draft");
  ok(!pv.includes("evil.example"), "the broken link reached the preview");
  ok(/data-section-id="sec_hero"[^>]*data-unfinished=""/.test(pv) && pv.includes("Hero: not finished yet"), `the hero's note: ${pv.slice(0, 600)}`);
  const live = await renderHome("srv.test");
  ok(!/evil\.example|not finished yet|Draft/.test(live), "a shopper sees the draft");
  // the net under a draft link the preview still shows as typed (a menu item's
  // link, which has no section note): React blocks a script address outright
  ok(/React has blocked a javascript: URL/.test(html(React.createElement("a", { href: "javascript:alert(1)" }, "x"))), "react-dom renders a javascript: link as typed");
  // a hero with no title only: the placeholder where the title goes, as before
  await save([sec("hero", "sec_hero", { ...HERO_SETTINGS, title: "", highlight: "" }), sec("new", "sec_new1", { title: "Draft new", limit: 3 })]);
  const pv2 = await renderHome("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
  ok(heroOf(pv2).includes("Write the first thing shoppers read"), `the hero placeholder: ${heroOf(pv2).slice(0, 400)}`);
  ok(!pv2.includes("Hero: not finished yet"), "a hero only missing words is not the note");
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

await t("AU-04: every registered kind's starterSection, saved by saveDraft in draft mode, is 200, and previewDraftBody plus a render does not throw; a starter rail on a store with collections publishes clean", async () => {
  const { previewDraftBody } = await import("../lib/content/documents-reader.js");
  const collections = await inV4(async () =>
    (await libsql.execute("SELECT c.id, c.handle, count(cp.product_id) AS product_count, sum(p.available) AS available_count FROM collections c LEFT JOIN collection_products cp ON cp.collection_id = c.id LEFT JOIN products p ON p.id = cp.product_id GROUP BY c.id ORDER BY c.handle")).rows.map((r) => ({ id: String(r.id), handle: String(r.handle), product_count: Number(r.product_count), available_count: Number(r.available_count || 0) })),
  );
  eq(collections.length, 3, "the fixture's collections:");
  const rail = Reg.starterSection("product_rail", { collections, id: "sec_strail" });
  ok(rail.settings.collection?.handle === "serums" || rail.settings.collection?.handle === "whey", `the rail picked a real collection: ${JSON.stringify(rail.settings.collection)}`);
  same(Reg.validateDocument(homeBody([rail]), { mode: "publish" }).issues, [], "the starter rail publishes clean:");
  same({ ...Reg.starterSection("product_rail", { collections: [], id: "sec_x1" }) }, Reg.newSection("product_rail", { id: "sec_x1" }), "no collections:");

  for (const kind of Reg.sectionKinds()) {
    const d = Reg.sectionType(kind);
    const type = d.documentTypes[0];
    const starter = Reg.starterSection(kind, { collections, id: `sec_st${kind.replace(/_/g, "").slice(0, 10)}` });
    const body = Reg.fixtureDocument(type, [starter]);
    const row = await inV4(async () => {
      let doc;
      if (Reg.documentType(type).singleton) {
        try {
          doc = await Svc.getDocument(`doc_${type}`);
        } catch {
          doc = (await Svc.createDocument({ type })).document;
        }
      } else doc = (await Svc.createDocument({ type, meta: { slug: `starter-${kind.replace(/_/g, "-")}`, title: `Starter ${d.label}` } })).document;
      const r = await Svc.saveDraft({ id: doc.id, revision: doc.revision, body: { ...body, meta: doc.body.meta ?? body.meta } });
      ok(r.document, `${kind}: saveDraft refused`);
      return (await libsql.execute({ sql: "SELECT id, type, draft FROM documents WHERE id = ?", args: [doc.id] })).rows[0];
    });
    const preview = previewDraftBody({ id: String(row.id), type: String(row.type), draft: String(row.draft) });
    ok(preview && Array.isArray(preview.sections), `${kind}: previewDraftBody`);
    const shown = preview.sections.find((s) => s.id === starter.id);
    ok(shown, `${kind}: the starter is in the preview body`);
    if (d.startsIncomplete && kind !== "product_rail") ok(shown.unfinished, `${kind}: a starter that starts incomplete previews as its note`);
    const data = await inV4(() => resolveHomeSectionData([shown]));
    const out = view(shown, data.get(shown.id) || {}, { surface: type === "home" ? "home" : "page", secKey: shown.id, preview: true, ...(kind === "product_main" ? { productMain: React.createElement("p", null, "buy") } : {}) });
    ok(!out.includes("couldn&#x27;t be shown"), `${kind}: the starter failed to render`);
    if (kind === "product_rail") ok(/href="\/products\//.test(out), `the starter rail shows real products: ${out.slice(0, 300)}`);
    else if (shown.unfinished && kind !== "hero") ok(out.includes("not finished yet"), `${kind}: the note: ${out.slice(0, 200)}`);
  }
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

// =====================================================================================
console.log("— 4. the DOC-03 shopper state table");
// =====================================================================================
const product = (n, available = true) => ({ handle: `p${n}`, title: `Product ${n}`, price_min: 100, price_max: 100, currency: "INR", available });
const order = (h) => [...h.matchAll(/href="\/products\/(p\d+)"/g)].map((m) => m[1]);
const rail = (settings = {}) => sec("product_rail", "sec_rail1", { title: "Rail", collection: { handle: "serums" }, limit: 8, ...settings });

await t("a rail with some products sold out labels them and puts them last; all sold out: the rail stays, all labelled", () => {
  const h = view(rail(), { products: [product(1, false), product(2), product(3, false), product(4)] });
  same(order(h), ["p2", "p4", "p1", "p3"], "order:");
  eq((h.match(/Sold out/g) || []).length, 2, "labels:");
  const all = view(rail(), { products: [product(1, false), product(2, false), product(3, false)] });
  same(order(all), ["p1", "p2", "p3"], "all sold out order:");
  eq((all.match(/Sold out/g) || []).length, 3, "all labelled:");
});

await t("a hand-picked rail keeps its order, sold out or not (still labelled)", () => {
  const h = view(rail(), { products: [product(1, false), product(2), product(3)], handPicked: true });
  same(order(h), ["p1", "p2", "p3"], "order:");
  eq((h.match(/Sold out/g) || []).length, 1, "label:");
});

await t("a rail below minItems renders nothing (no empty slots); a founder's own smaller limit still shows what they chose", () => {
  eq(Reg.sectionType("product_rail").minItems, 3, "registry minItems:");
  eq(view(rail(), { products: [product(1), product(2)] }), "", "2 of 8:");
  const page = home([rail(), sec("banner", "sec_bn1", { title: "After" })], new Map([["sec_rail1", { products: [product(1), product(2)] }]]));
  ok(!/sec_rail1/.test(page) && !/href="\/products\//.test(page), `the rail left a trace: ${page}`);
  ok(/After/.test(page), "the next section is gone");
  eq(order(view(rail({ limit: 2 }), { products: [product(1), product(2)] })).length, 2, "limit 2, 2 products:");
});

await t("a rail bound to an empty collection, or to no collection, renders nothing", async () => {
  eq(view(rail({ collection: { handle: "empty-shelf" } }), { products: [] }), "", "empty:");
  // through the real data path, on a legacy store
  const data = await inLeg(() => resolveHomeSectionData([rail({ collection: { handle: "empty-shelf", id: COL(3) } }), rail({ collection: null })].map((s, i) => ({ ...s, id: `sec_e${i}` }))));
  same(data.get("sec_e0").products, [], "empty collection data:");
  same(data.get("sec_e1").products, [], "no collection data:");
  eq(home([{ ...rail(), id: "sec_e0" }, { ...rail({ collection: null }), id: "sec_e1" }], data), "", "rendered:");
});

await t("a missing image renders the token-coloured fallback, never a broken image (image with text, a page image, a collection with no photo, a product with no photo)", () => {
  const iwt = sec("image_with_text", "sec_iwt", { image: null, title: "Why it works", text: "Three oils." });
  const h = view(iwt);
  ok(/data-media-fallback=""[^>]*class="[^"]*from-sf-media-from to-sf-media-to/.test(h), `home: ${h}`);
  ok(!/<img/.test(h) && /Why it works/.test(h), "home: a broken image, or the words are gone");
  const withAlt = view(sec("image_with_text", "sec_iwt2", { image: { media: "", alt: "A jar" }, title: "T" }));
  ok(/role="img" aria-label="A jar"/.test(withAlt), `alt kept: ${withAlt}`);
  const pageHtml = html(React.createElement(ContentPage, { page: { title: "Gallery", sections: [{ kind: "image", src: "", alt: "The workshop", caption: "Where we make it" }] } }));
  ok(/<figure[^>]*><div data-media-fallback=""/.test(pageHtml) && !/<img/.test(pageHtml) && /Where we make it/.test(pageHtml), `page: ${pageHtml}`);
  const grid = view(sec("collections", "sec_c1"), { collections: [{ handle: "serums", title: "Serums", image: null, product_count: 3 }] });
  ok(/from-sf-media-from to-sf-media-to/.test(grid) && !/<img/.test(grid), `collections grid: ${grid}`);
  const card = view(sec("new", "sec_n1"), { products: [{ ...product(1), featured_image: null }] });
  ok(/bg-sf-surface-sunken/.test(card) && /No image/.test(card) && !/<img/.test(card), `product card: ${card}`);
});

await t("a hero button linked to a sold-out product: the hero stays as it is and the button opens the product page", async () => {
  await inV4(() => libsql.execute({ sql: "UPDATE products SET available = 0 WHERE handle = 'glow-serum'" }));
  try {
    await publishHome([sec("hero", "sec_hero", { ...HERO_SETTINGS, primary: { label: "Get the serum", link: { type: "product", handle: "glow-serum" } } }), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
    const h = heroOf(await renderHome("srv.test"));
    ok(/<a href="\/products\/glow-serum"[^>]*>Get the serum<\/a>/.test(h), `the button: ${h}`);
    ok(/Glow<\/span> from within/.test(h) && h.includes("Clean skincare") && !/Sold out/i.test(h), "the hero changed");
  } finally {
    await inV4(() => libsql.execute({ sql: "UPDATE products SET available = 1 WHERE handle = 'glow-serum'" }));
  }
});

await t("a content page with no sections shows the neutral message and a link to collections; a page with sections, or with its own form below, does not", () => {
  const h = html(React.createElement(ContentPage, { page: { title: "Spring sale", sections: [] } }));
  ok(/data-empty-page=""/.test(h) && h.includes("There’s nothing on this page yet.") && /<a href="\/collections"[^>]*>Browse our collections<\/a>/.test(h), `empty page: ${h}`);
  ok(!/shopify|sync|error/i.test(h.replace(/<[^>]+>/g, " ")), "the message talks about setup");
  const withForm = html(React.createElement(ContentPage, { page: { title: "Contact", sections: [] } }, React.createElement("form", null)));
  ok(!/data-empty-page/.test(withForm), "the contact page (a form below) got the message");
  const withText = html(React.createElement(ContentPage, { page: { title: "About", sections: [{ heading: "Story", body: ["x"] }] } }));
  ok(!/data-empty-page/.test(withText), "a page with a section got the message");
  // a home page with no hero and nothing that shows gets the same message
  ok(/data-empty-page=""/.test(home([rail()], new Map(), true)), "home with nothing to show");
  eq(home([rail()], new Map(), false), "", "a home page with a hero gets no message:");
});

// =====================================================================================
console.log("— 5. edge safety");
// =====================================================================================
await t("no node: import in the files this item touches (the storefront is edge runtime)", async () => {
  const files = [
    ...(await readdir(join(ROOT, "components/sections"))).filter((f) => f.endsWith(".js")).map((f) => `components/sections/${f}`),
    "components/ContentPage.js",
    "components/FaqSection.js",
    "app/(storefront)/page.js",
    "lib/cms/section-data.js",
    "lib/content/resolve.js",
    "lib/content/unfinished.js",
    "lib/content/documents-reader.js",
    "lib/image-src.js",
    // P5-BLOCKS: what the bundle blocks bring into the storefront
    "components/BundleAddButton.js",
    "components/cart/CartContext.js",
    "lib/registry/sources.js",
    "lib/commerce/bundle-read.js",
    "lib/commerce/bundle-compat.js",
    "lib/commerce/bundle-words.js",
    "lib/format.js",
  ];
  const nodeImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url)["']/;
  for (const f of files) ok(!nodeImport.test(await readFile(join(ROOT, f), "utf8")), `${f} imports a Node module`);
});

// =====================================================================================
console.log("— 6. P5-HIDDEN (COM-01): why a section is hidden, for the founder only");
// =====================================================================================
const { runRequest } = await import("./support/request-cache.js");
const { tfetch } = await import("../lib/tenant-request.js");
const { contentSource } = await import("../lib/content/resolve.js");
const { previewToken: legacyPreviewToken } = await import("../lib/releases.js");
const { hiddenNote, isFounderPreview, FounderNote } = Map_;

// The base's live digests (SR_RECORD=1 on b09f342, before this item): see
// liveWorstCaseDigests above. A kind registered after b09f342 has no base
// here; the item that adds it records its own.
const BASE_LIVE = {
  hero: "460ff6d7dac4ce7ef450fecd88eafc1476c05a6739f6322fda7a634cce5f799f",
  collections: "c5651e5cf8141d25351e0b48a836f83c2ea863472d4360ba6f1b6298ec77d1bb",
  new: "ad91ac1d8ff1c7af35b673ee2cb222b3f80ab67dafee8f47bf2a60bbd0b2d0a8",
  banner: "c960f87e7903e54441f03a7b73d779089fbc3f5e7022bc40069eefc055f8b4b7",
  rich_text: "2339e77e7fa507c716375e3f14cd97dc610b6ee0965a4595e67ce2ee8a036f17",
  image_with_text: "41233de7e28e9539bec3eb4bc974e8ab93516bba0036580579ef87b57a570b13",
  product_rail: "e8a26a88771d1ff0b2c87331aa699ff16744b068599d8f59e8c6e190be922948",
  text: "0bf6413f32708ee1915a055545b673849f63d92fb17cad5b46cdccc23800533d",
  faq: "03721e0455a5805f63e8343142ce364e01285fda10ba5b2b93b14ec7726c956a",
  product_main: "f42c0b20c417a38f4fb1865c663e22957a89f485cdef19a9b7b3adbee399c81a",
  // P5-BLOCKS: recorded with SR_RECORD=1 when the two kinds were added (their
  // worst cases: lib/registry/fixtures.js worstBundle; the grid's max_items
  // holds 12 cells in every state, so the live markup drops its no_saving,
  // disabled and missing cells and holds no founder note)
  bundle_card: "ba00c0b13358ea0c69564a12ab42354bc21a11ee3cfae90fc621ba7b86875171",
  bundle_grid: "ab49b941dd7ab1c985825912d3fb6a9f345f2f9343d529fefe905ee576e640fb",
};

// One request through the real preview path: contentSource (lib/content/resolve.js)
// reads the cookie and notes the request scope, exactly as the home page's own
// call does; fn then renders inside the same request (one React cache memo).
const inRequest = (host, cookies, fn) =>
  asRequest(host, cookies, () =>
    runRequest(async () => {
      const src = await tfetch(() => contentSource());
      return fn(src);
    }),
  );
const renderHomeIn = (host, cookies) => asRequest(host, cookies, () => runRequest(async () => htmlAsync(await Home())));
const HIDDEN_WHY = "This bundle is turned off, so shoppers don't see it. Turn it on in Catalog > Bundles, or remove it.";
// the note's words go through escapeHtml into rich text (an apostrophe stays as typed)
const HIDDEN_WHY_HTML = HIDDEN_WHY.replace(/>/g, "&gt;");
// a throwaway kind that never shows; with or without the hook
function hiddenKinds() {
  Reg.defineSection({ kind: "fake_hidden", version: 1, label: "Offer box", documentTypes: ["home"], settings: [{ key: "title", kind: "text", label: "Title", max: 80, default: "Deal" }] });
  Reg.defineSection({ kind: "fake_hidden_plain", version: 1, label: "Plain box", documentTypes: ["home"], settings: [{ key: "title", kind: "text", label: "Title", max: 80, default: "Plain" }] });
  const Hidden = ({ section, attrs }) => (Hidden.shows(section) ? React.createElement("div", attrs, "shown") : null);
  Hidden.shows = () => false;
  Hidden.hiddenReason = (section, data) => (data?.why === "" ? "" : data?.why === "throw" ? (() => { throw new Error("boom"); })() : HIDDEN_WHY);
  const Plain = ({ section, attrs }) => (Plain.shows(section) ? React.createElement("div", attrs, "shown") : null);
  Plain.shows = () => false;
  const drops = [registerSectionComponent("fake_hidden", Hidden), registerSectionComponent("fake_hidden_plain", Plain)];
  return () => {
    for (const d of drops) d();
    Reg.removeSection("fake_hidden");
    Reg.removeSection("fake_hidden_plain");
  };
}
const tagOf = (h, id) => h.match(new RegExp(`<section[^>]*data-section-id="${id}"[^>]*>`))?.[0] || "";

await t("a throwaway kind whose shows() is false and whose hiddenReason returns a sentence: in a documents preview (the real preview path) the home page shows that sentence with data-sec, data-section-id and data-hidden-reason; live it renders nothing", async () => {
  const drop = hiddenKinds();
  try {
    await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("fake_hidden", "sec_hid1"), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
    const token = await previewToken();
    const pv = await renderHomeIn("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
    const root = tagOf(pv, "sec_hid1");
    ok(root, `no note in the preview: ${pv.slice(0, 600)}`);
    eq(attr(root, "data-sec"), "sec_hid1", "data-sec (the click target):");
    eq(attr(root, "data-section-kind"), "fake_hidden", "data-section-kind:");
    eq(attr(root, "data-hidden-reason"), "", "data-hidden-reason:");
    ok(!/data-unfinished/.test(root), "a hidden section is not marked unfinished");
    const note = sectionHtml(pv, "sec_hid1");
    ok(note.includes("Offer box: hidden from shoppers"), `the note's title: ${note}`);
    ok(note.includes(`${HIDDEN_WHY_HTML} Only you can see this note in your preview.`), `the note's words: ${note}`);
    // the #new anchor still lands on the newest products, after the note
    ok(/data-section-id="sec_new1"[^>]*id="new"/.test(pv), "the #new anchor moved");
    // live: no trace, and the page equals the page without the hidden section
    const live = await renderHomeIn("srv.test", { _unit: "unit-sections-plain" });
    ok(!/sec_hid1|hidden from shoppers|data-hidden-reason|turned off/.test(live), "a shopper sees the note");
    await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
    eq(live, await renderHomeIn("srv.test", { _unit: "unit-sections-plain" }), "live with the hidden section = live without it:");
    // the renderer alone: live (no request) is an empty string
    const hid = sec("fake_hidden", "sec_hid1");
    eq(home([hid]), "", "HomeSections live:");
    eq(view(hid), "", "SectionView live:");
    eq(html(hiddenNote(hid, {}, { surface: "home", secKey: "sec_hid1" })) , "", "hiddenNote live:");
    eq(html(hiddenNote(hid, {}, { surface: "home", secKey: "sec_hid1", preview: false })), "", "hiddenNote, ctx.preview false:");
    ok(html(hiddenNote(hid, {}, { surface: "home", secKey: "sec_hid1", preview: true })).includes(HIDDEN_WHY_HTML), "hiddenNote, ctx.preview true:");
    // no sentence, or a hook that throws: nothing, even in a preview
    eq(html(hiddenNote(hid, { why: "" }, { surface: "home", preview: true })), "", "an empty reason:");
    eq(html(hiddenNote(hid, { why: "throw" }, { surface: "home", preview: true })), "", "a throwing hook:");
  } finally {
    drop();
  }
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

await t("a kind without hiddenReason renders nothing in a documents preview and live; in a preview a hidden note counts as shown for the empty-page message, live it never does", async () => {
  const drop = hiddenKinds();
  try {
    const token = await previewToken();
    const plain = sec("fake_hidden_plain", "sec_pl1");
    const hid = sec("fake_hidden", "sec_hid1");
    const pv = await inRequest("srv.test", { [PREVIEW_COOKIE]: token }, async (src) => {
      ok(src.preview === true && src.v === 4, `not a documents preview: ${JSON.stringify({ preview: src.preview, v: src.v })}`);
      ok(isFounderPreview({}), "the request scope says documents preview");
      return { plain: home([plain]), plainEmpty: home([plain], new Map(), true), hidEmpty: home([hid], new Map(), true) };
    });
    eq(pv.plain, "", "no hook, preview:");
    ok(/data-empty-page/.test(pv.plainEmpty), "no hook: the empty-page message as before");
    ok(pv.hidEmpty.includes(HIDDEN_WHY_HTML) && !/data-empty-page/.test(pv.hidEmpty), `with the hook, preview: the note and no empty-page message: ${pv.hidEmpty}`);
    eq(home([plain]), "", "no hook, live:");
    ok(/data-empty-page/.test(home([hid], new Map(), true)) && !home([hid], new Map(), true).includes("turned off"), "live: the empty-page message, no note");
    // through the page: publish the plain kind and preview it
    await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), plain, sec("new", "sec_new1", { title: "New in", limit: 3 })]);
    const page = await renderHomeIn("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
    ok(page.includes("New in") && !/sec_pl1|data-hidden-reason/.test(page), "the plain kind left a trace in the preview");
  } finally {
    drop();
  }
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

await t("product_rail bound to an empty collection still renders nothing, in a documents preview and live (PV-09 unchanged)", async () => {
  const r = { ...rail({ collection: { handle: "empty-shelf" } }), id: "sec_e0" };
  const data = await inV4(() => resolveHomeSectionData([r]));
  same(data.get("sec_e0").products, [], "empty collection data:");
  const token = await previewToken();
  const pv = await inRequest("srv.test", { [PREVIEW_COOKIE]: token }, async () => ({ home: home([r], data), view: view(r, data.get("sec_e0"), { surface: "home", secKey: "sec_e0", preview: true }) }));
  eq(pv.home, "", "preview, HomeSections:");
  eq(pv.view, "", "preview, SectionView:");
  eq(home([r], data), "", "live:");
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), r, sec("new", "sec_new1", { title: "New in", limit: 3 })]);
  const page = await renderHomeIn("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
  ok(page.includes("New in") && !/sec_e0|data-hidden-reason/.test(page), "the empty rail left a trace in the preview page");
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

await t("a binding that failed: cause source_unknown says 'Remove it and add it again' in the preview, cause fault and no cause say reload; live renders nothing for both", async () => {
  const s = sec("new", "sec_new1", { title: "New in", limit: 3 });
  const unknown = { bindingFailed: ["products"], bindingFailedCause: { products: "source_unknown" } };
  const fault = { bindingFailed: ["products"], bindingFailedCause: { products: "fault" } };
  const bare = { bindingFailed: ["products"] };
  const REMOVE = "This newest products section is set up in a way the editor can't fix. Remove it and add it again.";
  const RELOAD = "Reload the preview to try again.";
  // ctx.preview given
  const u = view(s, unknown, { surface: "home", secKey: "sec_new1", preview: true });
  ok(u.includes(REMOVE) && !u.includes(RELOAD), `source_unknown: ${u}`);
  ok(/data-section-failed=""/.test(u) && attr(tagOf(u, "sec_new1"), "data-sec") === "sec_new1", "the failed note's marks");
  for (const [name, d] of [["fault", fault], ["no cause", bare]]) {
    const h = view(s, d, { surface: "home", secKey: "sec_new1", preview: true });
    ok(h.includes(RELOAD) && !h.includes("Remove it and add it again"), `${name}: ${h}`);
    ok(h.includes("Something went wrong while showing this newest products section."), `${name}: today's words`);
  }
  // a cause on a field that did not fail does not count
  ok(view(s, { bindingFailed: ["products"], bindingFailedCause: { other: "source_unknown", products: "fault" } }, { surface: "home", preview: true }).includes(RELOAD), "another field's cause");
  for (const d of [unknown, fault, bare]) eq(view(s, d, { surface: "home", preview: false }), "", "ctx.preview false:");
  // through HomeSections, in the real request: preview and live
  const token = await previewToken();
  const pv = await inRequest("srv.test", { [PREVIEW_COOKIE]: token }, async () => ({
    unknown: await htmlAsync(React.createElement(HomeSections, { sections: [s], dataById: new Map([["sec_new1", unknown]]) })),
    fault: await htmlAsync(React.createElement(HomeSections, { sections: [s], dataById: new Map([["sec_new1", fault]]) })),
  }));
  ok(pv.unknown.includes(REMOVE), `preview, source_unknown: ${pv.unknown}`);
  ok(pv.fault.includes(RELOAD) && !pv.fault.includes("Remove it"), `preview, fault: ${pv.fault}`);
  for (const d of [unknown, fault]) {
    const live = await inRequest("srv.test", {}, async () => htmlAsync(React.createElement(HomeSections, { sections: [s], dataById: new Map([["sec_new1", d]]) })));
    eq(live, "", "live:");
  }
});

await t("a documents preview shows the hidden note for a hidden section", async () => {
  const drop = hiddenKinds();
  try {
    const hid = sec("fake_hidden", "sec_hid1");
    const docs = await inRequest("srv.test", { [PREVIEW_COOKIE]: await previewToken() }, async () => home([hid]));
    ok(docs.includes(HIDDEN_WHY_HTML), `documents preview: ${docs}`);
  } finally {
    drop();
  }
});

await t("FounderNote (a per-cell note): only in a documents preview, with its attributes and the founder-only words; nothing live, nothing for ctx.preview false", async () => {
  const el = (ctx) => html(React.createElement(FounderNote, { ctx, title: "Gym kit", text: "This bundle was deleted, so shoppers don't see it.", attrs: { "data-cell": "2" } }));
  const on = el({ preview: true });
  ok(/^<div data-founder-note="" data-cell="2" class="[^"]*border-dashed/.test(on), `the note: ${on}`);
  ok(on.includes("Gym kit") && on.includes("shoppers don&#x27;t see it. Only you can see this note in your preview."), `the words: ${on}`);
  eq(el({ preview: false }), "", "ctx.preview false:");
  eq(el({}), "", "no request (live):");
  eq(html(React.createElement(FounderNote, { ctx: { preview: true }, text: " " })), "", "no words:");
  const token = await previewToken();
  ok((await inRequest("srv.test", { [PREVIEW_COOKIE]: token }, async () => el({}))).includes("data-founder-note"), "a documents preview request (no ctx.preview)");
  eq(await inRequest("srv.test", {}, async () => el({})), "", "a live request:");
});

await t("live renders of every registered kind's worst-case fixtures (SectionView on home and page, HomeSections with and without data, with the empty-page message) are byte-equal to the base (b09f342)", () => {
  const now = liveWorstCaseDigests();
  const missing = Object.keys(BASE_LIVE).filter((k) => !Object.hasOwn(now, k));
  same(missing, [], "base kinds no longer registered:");
  const differ = Object.keys(BASE_LIVE).filter((k) => now[k] !== BASE_LIVE[k]);
  same(differ, [], "kinds whose live markup differs from the base:");
});

// P5-BLOCKS (after the P5-SOURCES and P5-HIDDEN reviews): the real path, end to
// end. data.bindingFailedCause is not enumerable, so only the data object
// section-data made carries it; this proves the home page hands that very
// object to HomeSections and SectionView (no spread, no JSON copy on the way).
await t("P5-BLOCKS: a source removed after publish fails its section end to end (section-data source_unknown, the home page, HomeSections): the documents preview shows 'Remove it and add it again', live shows nothing", async () => {
  const Src = await import("../lib/registry/sources.js");
  Src.defineSource({ name: "p5_e2e_src", args: ["limit"], resolve: () => Promise.resolve(["one", "two"]) });
  Reg.defineSection({ kind: "p5_e2e_kind", label: "Echo block", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { items: { sources: ["p5_e2e_src"], args: ["limit"] } } });
  const Echo = ({ data, attrs }) => React.createElement("div", { ...attrs, "data-echo": "" }, (data.items || []).join(","));
  const drop = registerSectionComponent("p5_e2e_kind", Echo);
  let removed = false;
  try {
    await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("p5_e2e_kind", "sec_e2e1"), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
    const token = await previewToken();
    const before = await renderHomeIn("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token });
    ok(before.includes(">one,two</div>"), "with its source, the section renders its data");
    Src.removeSource("p5_e2e_src");
    removed = true;
    const { result: pv, lines } = await logsOf(() => renderHomeIn("srv.test", { _unit: "unit-sections-plain", [PREVIEW_COOKIE]: token }));
    ok(pv.includes("This echo block section is set up in a way the editor can&#x27;t fix. Remove it and add it again.") || pv.includes("This echo block section is set up in a way the editor can't fix. Remove it and add it again."), `preview: the remove-and-add-again words: ${pv.match(/data-section-kind="p5_e2e_kind"[\s\S]{0,600}/)?.[0] || pv.slice(0, 400)}`);
    ok(!pv.includes("Reload the preview to try again"), "preview: not the reload words");
    ok(pv.includes("New in"), "the other sections still render");
    ok(lines.some((l) => l.evt === "section_binding_failed" && l.sectionId === "sec_e2e1" && l.cause === "source_unknown"), `logged with cause source_unknown: ${JSON.stringify(lines)}`);
    const live = await renderHomeIn("srv.test", { _unit: "unit-sections-plain" });
    ok(!/sec_e2e1|p5_e2e_kind|Remove it and add it again/.test(live) && live.includes("New in"), "live: no trace of the section");
  } finally {
    if (!removed) Src.removeSource("p5_e2e_src");
    drop();
    Reg.removeSection("p5_e2e_kind");
  }
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("new", "sec_new1", { title: "New in", limit: 3 })]);
});

await t("live renders inside a real live request (documents store, no preview cookie) equal the renders with no request", async () => {
  const inside = await inRequest("srv.test", { _unit: "unit-sections-plain" }, async (src) => {
    ok(src.preview === false, "a live request");
    return liveWorstCaseDigests();
  });
  same(inside, liveWorstCaseDigests(), "digests inside a live request:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
