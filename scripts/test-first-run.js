// P6-GEN suite (GEN-01, US-01, US-04, PUB-06): the first-run generator and
// its triggers, on real tenant databases built by the P6-FIXTURE fixture
// (documents mode, a real catalog sync), with no AI and no network.
//   1. the planner (lib/first-run/plan.js) on every catalog shape: the
//      generated home and design validate in publish mode (validateDocument
//      and the publish service's referenceChecks), no rail on a sold-out or
//      unknown collection, no claims, every word's provenance;
//   2. publishing the generated set: not lime, the automatic header and
//      footer list the catalog's collections;
//   3. no AI: no key, a spent budget, a fetch spy, a static import scan;
//   4. eligibility and refusals (sync none, partial, failed, legacy, migrating,
//      live, read-only, a founder's home), idempotence, refills;
//   5. the triggers: the worker's catalog_sync handler, the console route, the
//      editor page (compiled with Next's SWC, its data stubbed).
//   pnpm test:first-run
import "./support/request-cache.js";
import { readFile, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

// next/headers answers for one simulated request at a time (as in
// test-design-doc); outside one it throws, as the real module does.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__frRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() {
  const r = req();
  return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) };
}
export async function cookies() {
  const r = req();
  return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) };
}
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;
// No AI, ever: the key is gone (one test puts a dummy one back with a spent budget)
delete process.env.ANTHROPIC_API_KEY;
// Typesense is never reached: no host, no key
for (const k of Object.keys(process.env)) if (/^TYPESENSE/.test(k)) delete process.env[k];
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-first-run-default.db";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.PLATFORM_SECRET = "test-platform-secret";

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
const platform = await F.makePlatform({ name: "first-run" });
const C = platform.control;
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const Plan = await import("../lib/first-run/plan.js");
const Gen = await import("../lib/first-run/generate.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const Checks = await import("../lib/documents/checks.js");
const R = await import("../lib/registry/index.js");
const Res = await import("../lib/content/resolve.js");
const Pal = await import("../lib/themes/palettes.js");
const B = await import("../lib/brand.js");
const K = await import("../lib/themes/kits.js");
const Repo = await import("../lib/repo.js");
const Sync = await import("../lib/sync.js");
const W = await import("../lib/platform/worker.js");
const J = await import("../lib/platform/jobs.js");
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/sessions.js");
const Billing = await import("../lib/platform/billing.js");
const Defaults = await import("../lib/cms/defaults.js");
const { scanText, scanDocumentText, documentTexts } = await import("./support/banned-copy.js");
const { runRequest } = await import("./support/request-cache.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 4).join("\n   ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
// the generator logs JSON lines; keep the suite's output readable
async function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = log;
  }
}

// ---- stores ---------------------------------------------------------------------------
const SITE = "Night stars candle co";
const made = [];
async function store(name, opts = {}) {
  const fx = await F.makeTenant({ name: `fr-${name}`, id: `fr${name.replace(/[^a-z0-9]/g, "")}`, mode: "documents", sync: "complete", config: { site: { name: SITE } }, ...opts });
  made.push(fx);
  return fx;
}
const rowsOf = (fx, sql, args = []) => fx.run(async () => (await libsql.execute({ sql, args })).rows.map((r) => ({ ...r })));
const docRows = (fx) => rowsOf(fx, "SELECT id, type, revision, draft, draft_hash, updated_by, published_version_id FROM documents ORDER BY id");
const dump = async (fx) => JSON.stringify([await docRows(fx), await rowsOf(fx, "SELECT id, document_id, kind FROM document_versions ORDER BY id")]);
const bodyOf = async (fx, id) => {
  const r = (await rowsOf(fx, "SELECT draft FROM documents WHERE id = ?", [id]))[0];
  return r ? JSON.parse(r.draft) : null;
};
const OWNER = { kind: "merchant", id: "u_fr_owner", role: "owner" };
const STAFF = { kind: "merchant", id: "u_fr_staff", role: "staff" };
const SUPPORT = { kind: "operator-support", id: "op_fr", role: "support" };
const gen = (fx, trigger = "console", actor = OWNER) => fx.run(() => quiet(() => Gen.generateFirstStore({ trigger, actor }))).then((r) => r.value);
const catalogWords = (fx) =>
  fx.run(async () => {
    const c = await Gen.readFirstRunCatalog();
    return [SITE, ...c.products.flatMap((p) => [p.title, p.featured_image_alt]), ...c.collections.map((x) => x.title)].filter(Boolean);
  });
const errorsOf = (issues) => (issues || []).filter((i) => i.severity === "error");
// one simulated storefront request on a store's host
async function asRequest(fx, fn) {
  globalThis.__frRequest = { host: `${fx.id}.test`, cookies: {} };
  try {
    return await runRequest(() => fx.run(fn));
  } finally {
    globalThis.__frRequest = null;
  }
}
async function publishSet(fx, ids, actor = OWNER) {
  return fx.run(async () => {
    const items = [];
    for (const id of ids) {
      const d = await Docs.getDocument(id);
      items.push({ id: d.id, revision: d.revision, draftHash: d.draftHash });
    }
    return (await quiet(() => Pub.publish({ ids: items, actor }))).value;
  });
}

// =====================================================================================
console.log("— 1. the planner on every catalog shape (GEN-01)");
// =====================================================================================
const SHAPES = {};
for (const shape of F.CATALOG_SHAPES) SHAPES[shape] = await store(shape.replace(/_/g, "-"), { catalogShape: shape });

for (const shape of F.CATALOG_SHAPES) {
  await t(`${shape}: the generated doc_home and doc_design validate in publish mode with 0 errors (validateDocument + referenceChecks); no COLLECTION_EMPTY; hero title <= 60; no rail on a collection with 0 available`, async () => {
    const fx = SHAPES[shape];
    const r = await gen(fx);
    eq([r.ran, r.written, r.created], [true, true, ["doc_home", "doc_design"]], "made:");
    const home = await bodyOf(fx, "doc_home");
    const design = await bodyOf(fx, "doc_design");
    for (const [id, body] of [["doc_home", home], ["doc_design", design]]) {
      const v = R.validateDocument(body, { mode: "publish", documentId: id });
      eq(errorsOf(v.issues).map((i) => i.code), [], `${id} validateDocument errors:`);
    }
    const refs = await fx.run(() =>
      Checks.referenceChecks({
        items: [
          { doc: { id: "doc_home", type: "home" }, body: home },
          { doc: { id: "doc_design", type: "design" }, body: design },
        ],
        list: { pages: [], redirects: [] },
      }),
    );
    eq(errorsOf(refs.issues).map((i) => i.code), [], "referenceChecks errors:");
    ok(!refs.issues.some((i) => i.code === Checks.COLLECTION_EMPTY), `COLLECTION_EMPTY: ${JSON.stringify(refs.issues.map((i) => i.code))}`);
    const hero = home.sections[0];
    eq(hero.kind, "hero", "the hero first:");
    ok(hero.settings.title.length <= 60 && hero.settings.title.length > 0, `hero title: ${hero.settings.title}`);
    eq([hero.settings.highlight, hero.settings.badge, hero.settings.secondary], ["", "", null], "no highlight, badge or second button:");
    // every rail binds a collection with products in stock
    const stock = new Map((await rowsOf(fx, "SELECT c.handle AS h, (SELECT count(*) FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id = c.id AND p.available = 1) AS n FROM collections c")).map((x) => [x.h, Number(x.n)]));
    const rails = home.sections.filter((s) => s.kind === "product_rail");
    ok(rails.length <= 2, "at most two rails");
    for (const s of rails) {
      ok((stock.get(s.settings.collection.handle) ?? 0) > 0, `a rail on ${s.settings.collection.handle} (${stock.get(s.settings.collection.handle)} in stock)`);
      ok(s.settings.title.length <= 50, `rail title: ${s.settings.title}`);
    }
    // the design: the slate palette, never lime, nothing else
    eq(design.settings, { brand: Pal.designBodyFor("slate").brand, theme: { kit: "pulse", version: 1 }, logo: null }, "the design:");
    ok(!Pal.isLimeAccent(design.settings.brand.accent), "lime accent");
    // header and footer are not made (automatic menus)
    eq((await docRows(fx)).map((d) => d.id), ["doc_design", "doc_home"], "only the home and the design:");
    // the shape's own sections
    const kinds = home.sections.map((s) => s.kind);
    const want = {
      one: ["hero", "product_rail", "new"],
      few: ["hero", "collections", "product_rail", "product_rail", "new"],
      many: ["hero", "collections", "product_rail", "product_rail", "new"],
      all_sold_out: ["hero", "new"],
      no_images: ["hero", "product_rail", "new"],
      long_titles: ["hero", "product_rail", "new"],
      empty: ["hero"],
      no_collections: ["hero", "new"],
    }[shape];
    eq(kinds, want, `${shape} sections:`);
    const cta = hero.settings.primary?.link?.href ?? null;
    const ctas = { all_sold_out: "#new", no_collections: "#new", empty: null };
    eq(cta, Object.hasOwn(ctas, shape) ? ctas[shape] : "/collections", "the button:");
    eq(Boolean(hero.settings.image), ["one", "few", "many", "no_collections"].includes(shape), "a hero image:");
    if (hero.settings.image) ok(hero.settings.image.media.startsWith("https://") && hero.settings.image.media.length <= 500 && hero.settings.image.alt, "a usable image");
  });
}

await t("banned copy: scanDocumentText over every generated text returns no BANNED or CLAIMS hit (the founder's catalog words and store name left out); the empty-catalog hero has no 'opening soon' text", async () => {
  for (const shape of F.CATALOG_SHAPES) {
    const fx = SHAPES[shape];
    const words = await catalogWords(fx);
    for (const id of ["doc_home", "doc_design"]) {
      const body = await bodyOf(fx, id);
      eq(scanDocumentText(body, { catalogWords: words }), [], `${shape} ${id}:`);
    }
  }
  const empty = await bodyOf(SHAPES.empty, "doc_home");
  const all = documentTexts(empty).map((x) => x.text).join(" | ");
  ok(!/opening soon/i.test(all) && !all.includes(Defaults.EMPTY_STORE_HERO_SUBTITLE), `empty hero: ${all}`);
  eq(empty.sections[0].settings.subtitle, "", "the empty hero's subtitle:");
  // the fixed words themselves are clean, shopper rules included
  for (const w of [...Object.values(Plan.WORDS), ...Plan.SUBTITLES.map((s) => s.text), Defaults.DEFAULT_HERO_SUBTITLE]) eq(scanText(w, { shopper: true }), [], `"${w}":`);
});

await t("provenance: every text value is a fixed template, the store name, or a catalog title or alt (cut to fit)", async () => {
  const fixed = new Set([...Object.values(Plan.WORDS), Defaults.DEFAULT_HERO_SUBTITLE, ""]);
  const isCutOf = (text, src) => typeof src === "string" && text.length > 0 && src.replace(/\s+/g, " ").trim().startsWith(text);
  for (const shape of F.CATALOG_SHAPES) {
    const fx = SHAPES[shape];
    const c = await fx.run(() => Gen.readFirstRunCatalog());
    const catalog = [SITE, ...c.products.flatMap((p) => [p.title, p.featured_image_alt]), ...c.collections.map((x) => x.title)].filter(Boolean);
    const filled = new Set();
    for (const a of c.collections) {
      filled.add(Plan.SUBTITLES[1].text.replace("{a}", a.title));
      for (const b of c.collections) filled.add(Plan.SUBTITLES[0].text.replace("{a}", a.title).replace("{b}", b.title));
    }
    for (const { path, text } of documentTexts(await bodyOf(fx, "doc_home"))) {
      ok(fixed.has(text) || filled.has(text) || catalog.some((src) => isCutOf(text, src)), `${shape} ${path}: "${text}" has no source`);
    }
  }
});

// =====================================================================================
console.log("— 2. publishing the generated set");
// =====================================================================================
const BUILD = await (async () => {
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  return swc;
})();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const compile = async (file, source) =>
  (
    await BUILD.transform(source ?? (await readFile(file, "utf8")), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
// As test-editor-routes' loader: each file compiled to CommonJS, stubs by
// module id, and a record of every file it compiled.
function world(stubs) {
  const cache = new Map();
  const loaded = [];
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    loaded.push(file);
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
  load.loaded = loaded;
  return load;
}
const linkStub = { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) };
const chromeWorld = world({ "next/link": linkStub, "./SearchBox": { __esModule: true, default: () => null }, "./cart/CartButton": { __esModule: true, default: () => null } });
const Header = (await chromeWorld(join(ROOT, "components/Header.js"))).default;
const Footer = (await chromeWorld(join(ROOT, "components/Footer.js"))).default;
// the chrome a shopper gets, the way the storefront layout builds it
async function chrome(fx) {
  return asRequest(fx, async () => {
    const [collections, navHeader, navFooter, brand, theme] = await Promise.all([Repo.getAllCollections(), Res.resolvedNav("header"), Res.resolvedNav("footer"), Res.resolvedBrand(), Res.resolvedTheme()]);
    const css = B.brandCssVars(brand ? B.resolveBrand(brand) : null, { kit: K.kitAttr(theme) });
    return {
      collections,
      navHeader,
      navFooter,
      brand,
      css,
      header: renderToStaticMarkup(React.createElement(Header, { collections, nav: navHeader })),
      footer: renderToStaticMarkup(React.createElement(Footer, { collections, nav: navFooter })),
    };
  });
}

await t("publish of the generated set (the publish service, no checkOpening) succeeds; the live brand's accent is not lime and no brand colour in the CSS is lime-family (the fixed --sf-success status colours apart)", async () => {
  const fx = SHAPES.few;
  const out = await publishSet(fx, ["doc_home", "doc_design"]);
  ok(out?.release?.id && out.published.length === 2, `published: ${JSON.stringify(out).slice(0, 200)}`);
  const c = await chrome(fx);
  eq(c.brand.accent, Pal.designBodyFor("slate").brand.accent, "the live accent:");
  ok(!Pal.isLimeAccent(c.brand.accent), "a lime accent");
  // every colour variable the brand CSS sets, by name. The platform's status
  // colours (--sf-success*, lib/brand.js STATUS roles: lime-700/800/50/100)
  // are the same fixed values for every brand, so they are listed apart: none
  // of them comes from the store's brand, and no other variable may be lime.
  const vars = (css) => [...String(css).matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]);
  const STATUS = /^--sf-success/;
  const set = vars(c.css);
  ok(set.length > 10, `brand CSS: ${String(c.css).slice(0, 120)}`);
  eq(set.filter(([k, h]) => Pal.isLimeAccent(h) && !STATUS.test(k)).map(([k]) => k), [], "lime-family colours from the brand:");
  ok(set.some(([k]) => /^--accent-|^--sf-accent/.test(k)), "the accent variables are set");
  // the same check catches the platform's lime default
  const lime = vars(B.brandCssVars(B.resolveBrand(B.DEFAULT_BRAND), { kit: K.kitAttr(null) }));
  ok(lime.filter(([k, h]) => Pal.isLimeAccent(h) && !STATUS.test(k)).length >= 5, "the check would see the lime default");
  // and the status colours are fixed: the same for every curated palette
  const statusOf = (id) => vars(B.brandCssVars(B.resolveBrand(Pal.designBodyFor(id).brand), { kit: "pulse-1" })).filter(([k]) => STATUS.test(k));
  for (const p of Pal.PALETTES) eq(statusOf(p.id), set.filter(([k]) => STATUS.test(k)), `${p.id} status colours:`);
});

await t("after that publish the header (auto mode) lists the catalog's collections and the footer renders; an empty header made through createDocument (mode 'auto') and published keeps the catalog menu", async () => {
  const fx = SHAPES.few;
  const before = await chrome(fx);
  eq([before.navHeader, before.navFooter], [null, null], "automatic menus:");
  ok(before.collections.length === 2, `collections: ${before.collections.length}`);
  for (const col of before.collections) {
    ok(before.header.includes(`href="/collections/${col.handle}"`) && before.header.includes(col.title), `the header lists ${col.handle}`);
    ok(before.footer.includes(`href="/collections/${col.handle}"`), `the footer lists ${col.handle}`);
  }
  ok(before.footer.includes("<footer"), "the footer renders");
  const header = await fx.run(() => Docs.createDocument({ type: "header", body: R.emptyBody("header"), actor: OWNER }));
  eq(header.body?.settings?.mode ?? JSON.parse((await rowsOf(fx, "SELECT draft FROM documents WHERE id = 'doc_header'"))[0].draft).settings.mode, "auto", "the empty header's mode:");
  await publishSet(fx, ["doc_header"]);
  const after = await chrome(fx);
  eq(after.navHeader, null, "still automatic:");
  eq(after.header, before.header, "the header menu is unchanged:");
});

await t("no_collections publishes valid with its '#new' button", async () => {
  const fx = SHAPES.no_collections;
  const out = await publishSet(fx, ["doc_home", "doc_design"]);
  ok(out?.release?.id && out.published.length === 2, `published: ${JSON.stringify(out).slice(0, 200)}`);
  const live = await asRequest(fx, () => Res.resolvedHomeSections());
  ok(live.some((s) => s.kind === "new"), `the new section is live: ${JSON.stringify(live.map((s) => s.kind))}`);
  const home = await bodyOf(fx, "doc_home");
  eq(home.sections[0].settings.primary, { label: Plan.WORDS.seeNew, link: { type: "url", href: "#new" } }, "its button:");
});

// =====================================================================================
console.log("— 3. no AI");
// =====================================================================================
function fetchSpy() {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, ...rest) => {
    seen.push(String(url?.url ?? url));
    return real(url, ...rest);
  };
  return { seen, restore: () => (globalThis.fetch = real) };
}

await t("with ANTHROPIC_API_KEY deleted, generation succeeds and a fetch spy records 0 requests to api.anthropic.com", async () => {
  ok(!process.env.ANTHROPIC_API_KEY, "the key is gone");
  const fx = await store("noai", { catalogShape: "few" });
  const spy = fetchSpy();
  let r;
  try {
    r = await gen(fx);
  } finally {
    spy.restore();
  }
  eq([r.ran, r.written], [true, true], "made:");
  eq(spy.seen.filter((u) => u.includes("anthropic")), [], "AI requests:");
});

await t("with the AI budget spent (ai_budget_tokens 100, 200 tokens on the ledger) and a dummy key, generation succeeds and makes 0 requests to api.anthropic.com", async () => {
  const fx = await store("budget", { catalogShape: "few" });
  const t0 = await C.getTenant(fx.id, { fresh: true });
  await C.patchTenant(fx.id, { config: { ...t0.config, ai_budget_tokens: 100 } });
  await Billing.recordUsage(fx.id, "ai_tokens", 200, `fr-budget-${Date.now()}`);
  const fresh = await C.getTenant(fx.id, { fresh: true });
  const AI = await import("../lib/ai/insights.js"); // the suite's own check of the budget, not the generator's
  const b = await withTenant(fresh, () => AI.aiBudget());
  eq([b.metered, b.remaining], [true, 0], "the budget is spent:");
  process.env.ANTHROPIC_API_KEY = "dummy-not-a-key";
  const spy = fetchSpy();
  let r;
  try {
    r = await withTenant(fresh, () => quiet(() => Gen.generateFirstStore({ trigger: "console", actor: OWNER }))).then((x) => x.value);
  } finally {
    spy.restore();
    delete process.env.ANTHROPIC_API_KEY;
  }
  eq([r.ran, r.written], [true, true], "made:");
  eq(spy.seen.filter((u) => u.includes("anthropic")), [], "AI requests:");
});

// every module reachable from a file through static, re-export and dynamic imports
async function importGraph(entry) {
  const seen = new Set();
  const specs = [];
  const walk = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await readFile(file, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const found = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'`])([^"'`]+)\1/g)].map((m) => m[2]);
    for (const s of found) {
      specs.push({ file, spec: s });
      const target = s.startsWith("@/") ? join(ROOT, s.slice(2)) : s.startsWith(".") ? resolve(dirname(file), s) : null;
      if (!target) continue;
      const withExt = existsSync(target) && !target.endsWith("/") && /\.\w+$/.test(target) ? target : existsSync(`${target}.js`) ? `${target}.js` : join(target, "index.js");
      if (existsSync(withExt)) await walk(withExt);
    }
  };
  await walk(entry);
  return { files: [...seen], specs };
}

await t("static scan: plan.js and generate.js (and the worker hook) have no import path to lib/ai; plan.js imports nothing Node-only", async () => {
  for (const f of ["lib/first-run/plan.js", "lib/first-run/generate.js", "lib/platform/worker.js"]) {
    const g = await importGraph(join(ROOT, f));
    ok(g.files.length > 1, `${f}: graph`);
    const ai = g.files.filter((x) => /\/lib\/ai(\/|\.js$)/.test(x));
    eq(ai.map((x) => x.slice(ROOT.length + 1)), [], `${f} reaches lib/ai:`);
    ok(!g.specs.some((s) => /(^|\/)ai(\.js)?$|\/ai\//.test(s.spec) && !s.spec.includes("node_modules")), `${f}: an ai import`);
  }
  const plan = await importGraph(join(ROOT, "lib/first-run/plan.js"));
  const nodeOnly = plan.specs.filter((s) => s.spec.startsWith("node:") || ["fs", "path", "crypto", "child_process"].includes(s.spec));
  eq(nodeOnly, [], "plan.js's graph imports Node-only modules:");
  for (const f of plan.files) ok(!/\bprocess\.(env|cwd)|\brequire\(/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")), `${f.slice(ROOT.length + 1)} uses process or require`);
});

// =====================================================================================
console.log("— 4. eligibility, refusals and refills");
// =====================================================================================
await t("it refuses, writing nothing, for sync none, partial and failed, a legacy store, a migrating store, a live store and a read-only actor (console and editor triggers)", async () => {
  const cases = [
    ["sync none", await store("snone", { catalogShape: "few", sync: "none" }), "console", OWNER, "catalog_not_confirmed"],
    ["sync partial", await store("spart", { catalogShape: "few", sync: "partial" }), "console", OWNER, "catalog_not_confirmed"],
    ["sync failed", await store("sfail", { catalogShape: "few", sync: "failed" }), "console", OWNER, "catalog_not_confirmed"],
    ["legacy", await store("legacy", { catalogShape: "few", mode: "legacy" }), "console", OWNER, "legacy"],
  ];
  const mig = await store("mig", { catalogShape: "few" });
  await rowsOf(mig, "UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  cases.push(["migrating", mig, "console", OWNER, "migrating"]);
  const live = await store("live", { catalogShape: "few" });
  await rowsOf(live, "UPDATE release_state SET live_release_id = 'rel_fr_live' WHERE id = 1");
  cases.push(["live", live, "console", OWNER, "live"]);
  const ro = await store("ro", { catalogShape: "few" });
  cases.push(["read-only, console", ro, "console", SUPPORT, "cannot_edit"], ["read-only, editor", ro, "editor", SUPPORT, "cannot_edit"], ["no actor, console", ro, "console", null, "cannot_edit"]);
  for (const [label, fx, trigger, actor, reason] of cases) {
    const before = await dump(fx);
    const r = await gen(fx, trigger, actor);
    eq([r.ran, r.reason], [false, reason], `${label}:`);
    ok(typeof r.message === "string" && r.message.length > 10 && !/[A-Z]{2,}_[A-Z_]+/.test(r.message), `${label} words: ${r.message}`);
    eq(scanText(r.message, { claims: false }), [], `${label} words are clean:`);
    eq(await dump(fx), before, `${label}: storage changed:`);
    eq((await docRows(fx)).length, 0, `${label}: documents:`);
  }
  // a live store's writer answers written:false when nothing needs writing;
  // the generator never gets that far, and never calls it 'generated'
  const r = await gen(live);
  eq([r.ran, "written" in r], [false, false], "a live store is never 'generated':");
  // and the console's describe agrees
  const d = await live.run(() => Gen.describeFirstStore({ actor: OWNER }));
  eq([d.eligible, d.reason, d.generated], [false, "live", false], "describe on a live store:");
});

await t("a founder-written doc_home gives reason 'founder_started' and no doc_design is created", async () => {
  const fx = await store("founder", { catalogShape: "few" });
  await fx.run(() => Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [{ ...R.newSection("text"), settings: { title: "My shop", body: ["My words."] } }] }, actor: OWNER }));
  const before = await dump(fx);
  const r = await gen(fx);
  eq([r.ran, r.reason], [false, "founder_started"], "refused:");
  eq(await dump(fx), before, "nothing written:");
  eq((await docRows(fx)).map((d) => d.id), ["doc_home"], "no design:");
  const d = await fx.run(() => Gen.describeFirstStore({ actor: OWNER }));
  eq([d.eligible, d.reason, d.generated, d.kept, d.byGenerator, d.summary], [false, "founder_started", true, ["doc_home"], [], null], "describe:");
});

await t("running twice with the same catalog writes nothing the second time (unchanged, no revision bump)", async () => {
  const fx = await store("twice", { catalogShape: "few" });
  const a = await gen(fx);
  eq(a.created, ["doc_home", "doc_design"], "first:");
  const before = await dump(fx);
  const b = await gen(fx);
  eq([b.ran, b.written, b.created, b.refilled, b.unchanged], [true, false, [], [], ["doc_home", "doc_design"]], "second:");
  eq(await dump(fx), before, "nothing written:");
  const d = await fx.run(() => Gen.describeFirstStore({ actor: OWNER }));
  eq([d.eligible, d.generated, d.byGenerator, d.kept, d.empty, d.noCollections], [true, true, ["doc_home", "doc_design"], [], false, false], "describe:");
  eq(d.summary, a.summary, "the summary re-derived from the drafts:");
  eq(d.summary.paletteId, "slate", "palette:");
});

await t("an empty catalog generates a hero-only home; after a second confirmed sync with products the untouched generated home is refilled with sections", async () => {
  const fx = await store("grow", { catalogShape: "empty" });
  const a = await gen(fx, "sync", null);
  eq([a.ran, a.created], [true, ["doc_home", "doc_design"]], "made on the sync trigger:");
  eq((await bodyOf(fx, "doc_home")).sections.map((s) => s.kind), ["hero"], "hero only:");
  const d0 = await fx.run(() => Gen.describeFirstStore({ actor: OWNER }));
  eq([d0.empty, d0.noCollections], [true, true], "describe empty:");
  const { products, collections } = F.catalogFor("few");
  await fx.run(() => Sync.runCatalogSync({ fetchers: { products: async () => products, collections: async () => collections }, indexer: async () => ({ indexed: 0 }) }));
  const b = await gen(fx, "sync", null);
  eq([b.ran, b.written, b.refilled], [true, true, ["doc_home"]], "refilled (the design unchanged):");
  eq(b.unchanged, ["doc_design"], "design unchanged:");
  eq((await bodyOf(fx, "doc_home")).sections.map((s) => s.kind), ["hero", "collections", "product_rail", "product_rail", "new"], "now with sections:");
  eq((await docRows(fx)).find((x) => x.id === "doc_home").revision, 2, "revision:");
});

await t("a revision-1 empty doc_home made by the editor is refilled by the console trigger but not by the sync trigger (which writes nothing, not even the design)", async () => {
  const fx = await store("emptyhome", { catalogShape: "few" });
  await fx.run(() => Docs.createDocument({ type: "home", body: R.emptyBody("home"), actor: OWNER }));
  const before = await dump(fx);
  const s = await gen(fx, "sync", null);
  eq([s.ran, s.reason], [false, "home_left_for_founder"], "the sync trigger:");
  eq(await dump(fx), before, "the sync trigger wrote nothing:");
  const c = await gen(fx, "console", OWNER);
  eq([c.ran, c.written, c.refilled, c.created], [true, true, ["doc_home"], ["doc_design"]], "the console trigger:");
  const row = (await docRows(fx)).find((x) => x.id === "doc_home");
  eq([row.revision, row.updated_by], [2, "system:first-run"], "refilled:");
});

await t("staff (who can edit) may generate; the store's recorded starting palette is used", async () => {
  const fx = await store("staff", { catalogShape: "one", config: { site: { name: SITE }, onboarding: { brand_step: { paletteId: "forest", skipped: true } } } });
  const r = await gen(fx, "console", STAFF);
  eq([r.ran, r.written, r.summary.paletteId], [true, true, "forest"], "staff, forest:");
});

// =====================================================================================
console.log("— 5. the triggers");
// =====================================================================================
const enqueueSync = async (fx, key) => (await J.enqueueJob({ type: "catalog_sync", tenantId: fx.id, payload: { runId: fx.syncResult.run.id }, idempotencyKey: `fr-${key}-${Date.now()}` })).id;
const jobRow = async (fx, id) => (await J.listJobs({ tenant: fx.id })).find((j) => j.id === id);

await t("worker: the catalog_sync handler on a completed run calls the generator (the store is made, the job result carries a firstRun summary)", async () => {
  const fx = await store("worker", { catalogShape: "few" });
  const id = await enqueueSync(fx, "done");
  const { value: ran } = await quiet(() => W.runJobById(id, { budgetMs: 45_000 }));
  eq([ran.ok, ran.requeued ?? false, ran.result.status], [true, false, "complete"], "the job:");
  eq(ran.result.firstRun, { ran: true, written: true, created: ["doc_home", "doc_design"], refilled: [] }, "firstRun:");
  eq((await docRows(fx)).map((d) => [d.id, d.updated_by]), [["doc_design", "system:first-run"], ["doc_home", "system:first-run"]], "made by the sync:");
  eq((await jobRow(fx, id)).status, "done", "the job is done:");
});

await t("worker: a thrown generator error does not fail or requeue the job (it is only logged)", async () => {
  const fx = await store("workerboom", { catalogShape: "few" });
  const id = await enqueueSync(fx, "boom");
  const real = W.workerFirstRun.generate;
  W.workerFirstRun.generate = async () => {
    throw new Error("the generator broke");
  };
  let out;
  try {
    out = await quiet(() => W.runJobById(id, { budgetMs: 45_000 }));
  } finally {
    W.workerFirstRun.generate = real;
  }
  eq([out.value.ok, out.value.requeued ?? false, out.value.result.status, out.value.result.firstRun], [true, false, "complete", { ran: false, error: true }], "the job:");
  ok(out.lines.some((l) => l.includes('"first_run_failed"') && l.includes("the generator broke")), "logged");
  eq((await jobRow(fx, id)).status, "done", "the job is done, not failed:");
  eq((await docRows(fx)).length, 0, "nothing made:");
});

await t("worker: with under 5 s of the slice left it skips the generator and logs first_run_deferred", async () => {
  const fx = await store("workerlate", { catalogShape: "few" });
  const id = await enqueueSync(fx, "late");
  let called = 0;
  const real = W.workerFirstRun.generate;
  W.workerFirstRun.generate = async (o) => {
    called++;
    return real(o);
  };
  let out;
  try {
    out = await quiet(() => W.runJobById(id, { budgetMs: 3_000 }));
  } finally {
    W.workerFirstRun.generate = real;
  }
  eq(called, 0, "generator calls:");
  eq([out.value.ok, out.value.result.firstRun], [true, { deferred: true }], "the job:");
  ok(out.lines.some((l) => l.includes('"first_run_deferred"')), `logged: ${out.lines.join(" / ").slice(0, 200)}`);
  eq((await docRows(fx)).length, 0, "nothing made:");
  eq(W.FIRST_RUN_MIN_LEFT_MS, 5000, "the margin:");
});

// ---- the console route ----------------------------------------------------------------
const Route = await import("../app/api/admin/first-run/route.js");
const ownerU = await I.createUser({ email: "owner@fr.test", name: "Asha Rao", password: "owner-pass-first-run" });
const supportU = await I.createUser({ email: "look@fr.test", name: "Looker", password: "support-pass-first-run" });
const tokenOf = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const routeReq = (fx, cookie, { method = "GET", origin = null } = {}) => ({
  method,
  url: `http://${fx.id}.test/api/admin/first-run`,
  cookies: { get: (n) => (n === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test`, ...(origin ? { origin } : {}) })[k.toLowerCase()] ?? null },
  json: async () => ({}),
});
const callRoute = async (verb, fx, cookie, opts) => {
  const { value: res } = await quiet(() => Route[verb](routeReq(fx, cookie, { method: verb, ...opts })));
  return { status: res.status, body: await res.json() };
};

await t("route: GET describes the store and the sync's progress (storefront.read); POST makes it (storefront.write); a read-only member gets 403 in plain words and nothing is written", async () => {
  const fx = await store("route", { catalogShape: "few" });
  await I.addMembership(ownerU.id, fx.id, "owner");
  await I.addMembership(supportU.id, fx.id, "support");
  const owner = await tokenOf(ownerU);
  const looker = await tokenOf(supportU);
  const g = await callRoute("GET", fx, looker);
  eq([g.status, g.body.ok, g.body.firstRun.generated, g.body.firstRun.eligible, g.body.firstRun.reason], [200, true, false, false, "cannot_edit"], "GET as support:");
  ok(g.body.sync && typeof g.body.sync === "object", "the sync view");
  const go = await callRoute("GET", fx, owner);
  eq([go.body.firstRun.eligible, go.body.firstRun.reason], [true, null], "GET as the owner:");
  const before = await dump(fx);
  const p = await callRoute("POST", fx, looker);
  eq([p.status, p.body.reason], [403, "cannot_edit"], "POST as support:");
  eq(p.body.error, Gen.FIRST_RUN_WORDS.cannot_edit, "plain words:");
  eq(await dump(fx), before, "nothing written:");
  const cross = await callRoute("POST", fx, owner, { origin: "https://elsewhere.example" });
  eq(cross.status, 403, "a cross-origin POST:");
  eq(await dump(fx), before, "nothing written:");
  const made = await callRoute("POST", fx, owner);
  eq([made.status, made.body.ran, made.body.generated, made.body.created], [200, true, true, ["doc_home", "doc_design"]], "POST as the owner:");
  const again = await callRoute("POST", fx, owner);
  eq([again.body.ran, again.body.generated, again.body.unchanged], [true, false, ["doc_home", "doc_design"]], "again: nothing new is 'generated':");
  await rowsOf(fx, "UPDATE release_state SET live_release_id = 'rel_fr_route' WHERE id = 1");
  const live = await callRoute("POST", fx, owner);
  eq([live.status, live.body.ran, live.body.generated, live.body.reason], [200, false, false, "live"], "a live store:");
  eq(live.body.message, Gen.FIRST_RUN_WORDS.live, "its words:");
});

// ---- the editor page ------------------------------------------------------------------
const PAGE = join(ROOT, "app/(console)/admin/(authed)/editor/page.js");
const P = { actor: OWNER, fx: null, modeReads: 0, docsReads: 0, genCalls: 0, genLoads: 0, genThrows: false };
class Redirect extends Error {}
const Mode = await import("../lib/cms-mode.js");
const EntityEntry = await import("../lib/admin/entity-entry.js");
const EditorEntry = await import("../lib/admin/editor-entry.js");
const Authz = await import("../lib/platform/authz.js");
const Log = await import("../lib/log.js");
const marker = (name) => (props) => React.createElement("div", { "data-stub": name, "data-doc": props?.document?.id ?? "" });
const pageStubs = {
  "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
  "next/navigation": {
    redirect: (to) => {
      throw new Redirect(to);
    },
  },
  "next/link": linkStub,
  "@/lib/admin-auth": { adminActor: async () => P.actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
  "@/lib/console-request": { tfetch: (fn) => P.fx.run(fn) },
  "@/lib/cms-mode": {
    getCmsMode: async () => {
      P.modeReads++;
      return Mode.getCmsMode();
    },
  },
  "@/lib/documents/service": {
    listDocuments: async (...a) => {
      P.docsReads++;
      return Docs.listDocuments(...a);
    },
  },
  "@/lib/admin/editor-entry": EditorEntry,
  "@/lib/admin/entity-entry": EntityEntry,
  "@/lib/platform/authz": Authz,
  "@/lib/bundles": { bundleCurrency: async () => "INR" },
  "@/lib/log": Log,
  "@/components/console/PageHeader": { PageHeader: marker("PageHeader") },
  "@/components/console/Banner": { Banner: marker("Banner") },
  "@/components/admin/editor/DocumentEditor": { __esModule: true, default: marker("DocumentEditor") },
};
// the page's dynamic import of the generator: counted, so a render that
// never needs it can be seen not to load it
Object.defineProperty(pageStubs, "@/lib/first-run/generate", {
  enumerable: true,
  get() {
    P.genLoads++;
    return {
      generateFirstStore: async (o) => {
        P.genCalls++;
        if (P.genThrows) throw new Error("generator down");
        return Gen.generateFirstStore(o);
      },
    };
  },
});
const pageWorld = world(pageStubs);
const EditorPage = (await pageWorld(PAGE)).default;
async function openEditor(fx, actor, query = {}) {
  Object.assign(P, { fx, actor, modeReads: 0, docsReads: 0, genCalls: 0, genLoads: 0 });
  const { value: el } = await quiet(() => EditorPage({ searchParams: Promise.resolve(query) }));
  return { html: renderToStaticMarkup(el), modeReads: P.modeReads, docsReads: P.docsReads, genCalls: P.genCalls, genLoads: P.genLoads };
}

await t("editor page: compiled alone (every app module stubbed), it doesn't load the generator chain; on a store that has doc_home it reads once each and never imports the generator", async () => {
  eq(pageWorld.loaded.map((f) => f.slice(ROOT.length + 1)), ["app/(console)/admin/(authed)/editor/page.js"], "compiled files:");
  const src = await readFile(PAGE, "utf8");
  ok(!/from "@\/lib\/first-run/.test(src) && src.includes("await import(`@/lib/first-run/generate`)"), "the generator is a dynamic import only");
  const fx = SHAPES.many; // generated in part 1: it has doc_home
  const r = await openEditor(fx, OWNER);
  eq([r.modeReads, r.docsReads, r.genLoads, r.genCalls], [1, 1, 0, 0], "reads and generator loads:");
  ok(r.html.includes('data-stub="DocumentEditor"') && r.html.includes('data-doc="doc_home"'), `the editor opens the home page: ${r.html.slice(0, 200)}`);
});

await t("editor page: a documents store with no doc_home and an editing actor generates before render (one more documents read); a read-only actor renders without generating", async () => {
  const fx = await store("editor", { catalogShape: "few" });
  const before = await dump(fx);
  const ro = await openEditor(fx, SUPPORT);
  eq([ro.modeReads, ro.docsReads, ro.genLoads, ro.genCalls], [1, 1, 0, 0], "read-only:");
  eq(await dump(fx), before, "read-only wrote nothing:");
  const r = await openEditor(fx, OWNER);
  eq([r.modeReads, r.docsReads, r.genCalls], [1, 2, 1], "the owner:");
  ok(r.html.includes('data-doc="doc_home"'), "the editor opens the generated home");
  eq((await docRows(fx)).map((d) => [d.id, d.updated_by]), [["doc_design", "system:first-run"], ["doc_home", "system:first-run"]], "made before render:");
  const again = await openEditor(fx, OWNER);
  eq([again.docsReads, again.genLoads], [1, 0], "next time the home exists:");
});

await t("editor page: a generator failure, or a store that isn't eligible, never fails the page (one documents read when nothing was written)", async () => {
  const fx = await store("editorfail", { catalogShape: "few" });
  P.genThrows = true;
  let r;
  try {
    r = await openEditor(fx, OWNER);
  } finally {
    P.genThrows = false;
  }
  eq([r.genCalls, r.docsReads], [1, 1], "a failure:");
  ok(r.html.includes('data-stub="DocumentEditor"'), "the editor still opens");
  eq((await docRows(fx)).length, 0, "nothing made:");
  const none = await store("editornone", { catalogShape: "few", sync: "none" });
  const n = await openEditor(none, OWNER);
  eq([n.genCalls, n.docsReads], [1, 1], "not eligible:");
  ok(n.html.includes('data-stub="DocumentEditor"'), "the editor opens");
  const legacy = await store("editorlegacy", { catalogShape: "few", mode: "legacy" });
  const l = await openEditor(legacy, OWNER);
  eq([l.modeReads, l.docsReads, l.genLoads], [1, 0, 0], "legacy: no documents read, no generator:");
});

// ---- cleanup --------------------------------------------------------------------------
for (const fx of made) await fx.cleanup();
await platform.cleanup();
for (const f of [".test-first-run-default.db"]) for (const s of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `${f}${s}`), { force: true });
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
