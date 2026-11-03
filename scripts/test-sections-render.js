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
//   5. Edge safety of the files this item touches.
// Everything is rendered with Next's own SWC and react-dom/server; no browser.
//   pnpm test:sections-render
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
const S = await import("../lib/cms/store.js");
const X = await import("../lib/experiments.js");
const Reg = await import("../lib/registry/index.js");
const Svc = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const { resolveHomeSectionData } = await import("../lib/cms/section-data.js");
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
const html = (el) => renderToStaticMarkup(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, el));
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
    ok(r.release?.id, `the home page did not publish: ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  });
}
const heroOf = (h) => h.match(/<section[^>]*data-sec="hero"[\s\S]*?<\/section>/)?.[0] || "";
const imgs = (h) => [...h.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

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
console.log("— 2. legacy stores render exactly as at a6d028e");
// =====================================================================================
const then = JSON.parse(await readFile(join(here, "fixtures/home-render-outputs.a6d028e.json"), "utf8"));
const run = spawnSync(process.execPath, [join(here, "support/home-render-outputs.js"), join(ROOT, OUTPUTS)], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 90_000,
  env: { ...process.env, HOME_RENDER_DB_PREFIX: ".test-sr-rec" },
});
const now = run.status === 0 ? JSON.parse(await readFile(join(ROOT, OUTPUTS), "utf8")) : null;

await t("the recorder ran in this checkout", () => {
  ok(now, `home-render-outputs.js failed: ${run.stderr?.slice(-800)}`);
  same(Object.keys(now.states), ["drafts", "exp_b", "exp_control", "exp_founder", "exp_preview", "candidate", "v1", "v2", "v3", "empty"], "states:");
});

const LABEL = {
  drafts: "legacy drafts",
  exp_b: "a running hero experiment, a visitor in variant b",
  exp_control: "a running hero experiment, a visitor in control",
  exp_founder: "a running hero experiment, a browser signed in to the console",
  exp_preview: "a running hero experiment, the founder's preview",
  candidate: "an S59 preview candidate",
  v1: "a v1 release",
  v2: "a v2 release",
  v3: "a v3 release",
  empty: "an empty store",
};
for (const [state, label] of Object.entries(LABEL)) {
  await t(`${label}: the home page and every content page equal a6d028e's HTML (data-section-* taken out)`, () => {
    ok(now, "no output");
    const a = then.states[state];
    const b = now.states[state];
    ok(a && b, `state ${state} missing`);
    const cmp = (old, cur, what) => {
      const n = normalize(cur);
      if (n === old) return;
      let i = 0;
      while (i < old.length && old[i] === n[i]) i++;
      throw new Error(`${what} differs at ${i}:\n      a6d028e: ${old.slice(Math.max(0, i - 120), i + 160)}\n      now:     ${n.slice(Math.max(0, i - 120), i + 160)}`);
    };
    cmp(a.home, b.home, "home");
    same(Object.keys(b.pages), Object.keys(a.pages), "pages:");
    for (const slug of Object.keys(a.pages)) cmp(a.pages[slug], b.pages[slug], `page ${slug}`);
    if (state !== "empty") ok(/data-section-id="sec_hero" data-section-kind="hero"/.test(b.home), "the hero has no section attributes");
  });
}

await t("the fixtures are what they claim: in stock, rails above minItems, the variant and the candidate visible", () => {
  const d = then.states;
  ok(!/Sold out/.test(Object.values(d).map((s) => s.home).join("")), "a fixture shows a sold-out product");
  ok(/Glow, <span class="text-sf-hero-accent">simply<\/span>/.test(d.exp_b.home), "variant b's title is not in exp_b");
  ok(!/simply/.test(d.exp_control.home) && !/simply/.test(d.exp_founder.home) && !/simply/.test(d.exp_preview.home), "the variant leaked");
  ok(/A test is running on this section/.test(d.exp_preview.home), "the preview note is missing");
  ok(/data-exp-ping|Candidate/.test(d.candidate.home) && /Candidate banner/.test(d.candidate.home), "the candidate is not shown");
  ok(/data-sec="i-0"/.test(d.v1.home), "v1's id-less sections should key by index");
  for (const s of ["drafts", "v1", "v2", "v3"]) ok(/data-sec="sec_rail01"|data-sec="i-5"/.test(d[s].home), `${s}: a rail is missing`);
});

// =====================================================================================
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

await t("a v4 home's rails never read collection_overrides (plan decision 9); a legacy store's rails still do and follow the pin", async () => {
  await publishHome([sec("hero", "sec_hero", HERO_SETTINGS), sec("product_rail", "sec_rail1", { title: "Serums", collection: { handle: "serums", id: COL(1) }, limit: 3 })]);
  const v4 = await inV4(() => watch(() => renderHome("srv.test")));
  same(v4.statements.filter((q) => /collection_overrides/i.test(q)), [], "v4 statements on collection_overrides:");
  const v4Rail = v4.result.match(/data-section-id="sec_rail1"[\s\S]*?<\/section>/)?.[0] || "";
  same([...v4Rail.matchAll(/href="\/products\/([^"]+)"/g)].map((m) => m[1]), ["glow-serum", "night-cream", "dew-drops"], "v4 rail order (the collection's own):");

  await inLeg(async () => {
    await S.setBlock("hero", { title: "Legacy hero" });
    await S.setBlock("home_sections", [{ id: "sec_rail1", kind: "product_rail", title: "Serums", collection: "serums", collection_id: COL(1), limit: 3 }]);
  });
  const leg = await inLeg(() => watch(() => renderHome("srl.test")));
  eq(leg.statements.filter((q) => /collection_overrides/i.test(q)).length, 1, "legacy statements on collection_overrides:");
  const legRail = leg.result.match(/data-section-id="sec_rail1"[\s\S]*?<\/section>/)?.[0] || "";
  same([...legRail.matchAll(/href="\/products\/([^"]+)"/g)].map((m) => m[1]), ["dew-drops", "glow-serum", "night-cream"], "legacy rail order (the pin first):");
});

await t("section-data: documents: true never asks for pins; a legacy call does, and says the order is hand-picked", async () => {
  const calls = [];
  const repo = {
    getNewestProducts: async () => [],
    getFeaturedCollections: async () => [],
    getCollectionsByHandles: async () => [],
    collectionPinsByHandle: async (h) => (calls.push(`pins:${h}`), ["p2"]),
    getProductsInCollection: async (h, o) => (calls.push(`products:${h}:${JSON.stringify(o.pins ?? null)}`), { products: [{ handle: "a" }, { handle: "b" }, { handle: "c" }] }),
  };
  const rail = sec("product_rail", "sec_r1", { collection: { handle: "serums", id: COL(1) }, limit: 3 });
  const v4 = await resolveHomeSectionData([rail], { repo, documents: true });
  same(calls, ["products:serums:[]"], "v4 calls:");
  eq(v4.get("sec_r1").handPicked, false, "v4 handPicked:");
  calls.length = 0;
  const leg = await resolveHomeSectionData([rail], { repo });
  same(calls, ["pins:serums", 'products:serums:["p2"]'], "legacy calls:");
  eq(leg.get("sec_r1").handPicked, true, "legacy handPicked:");
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
  ];
  const nodeImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url)["']/;
  for (const f of files) ok(!nodeImport.test(await readFile(join(ROOT, f), "utf8")), `${f} imports a Node module`);
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
