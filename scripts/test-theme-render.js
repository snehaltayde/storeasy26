// Phase 5 line 2 (docs/plans/phase-5.md "Line 2"): a shopper sees a store
// rendered by its uploaded theme package; the buy box, cart and checkout stay
// Storeasy's own.
//   pnpm test:theme-render
// Two documents stores on file databases (tenant-fixture), each with its own
// theme_packages table. A package row is written straight into the store's
// database (line 1's upload is not needed for a render) and the store's
// doc_design names it through the real documents service and publish. The
// real storefront layout (app/(storefront)/layout.js) is compiled with Next's
// own SWC and rendered with react-dom/static inside a simulated request on
// the store's host, as the anonymous shopper (no cookies):
//   1. store A's live package: data-theme, its surfaces and compiled styles,
//      the theme's header/footer/pdp templates as defaults; store B (no
//      package, and B naming A's package id) renders none of it
//   2. a package named only in a draft design is absent
//   3. buy box, cart drawer and checkout markup are byte-identical with and
//      without the theme; no data-part inside data-protected (rendered and
//      a static scan of their source)
//   4. a hand-tampered row cannot inject CSS or markup
//   5. the kill flag ff_theme-packages and a missing package fall back to
//      the base kit, with their slog lines
//   6. no node:* import reachable from layout.js; the added latency measured
import "./support/request-cache.js";
import { fontModule } from "./support/font-stub.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import React from "react";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// next/headers answers for one simulated request at a time (test-design-doc's pattern)
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__readRequest;
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
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.TYPESENSE_HOST = "";
process.env.DATABASE_URL = "file:.test-threnders-default.db";
process.env.PLATFORM_SECRET = "test-threnders-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e?.stack?.split("\n").slice(0, 5).join("\n    ") || e}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (got, want, m = "") => {
  if (got !== want) throw new Error(`${m} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

// ---- the stores ------------------------------------------------------------------------
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("threnders");
await F.makePlatform({ name: "threnders" });
const a = await F.makeTenant({ name: "threnders-a", mode: "documents", products: 2 });
const b = await F.makeTenant({ name: "threnders-b", mode: "documents", products: 2 });

const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const R = await import("../lib/registry/index.js");
const FLAGS = await import("../lib/platform/flags.js");
const LP = await import("../lib/themes/live-package.js");
const { compileStyles } = await import("../lib/themes/styles.js");
const { effectiveSurfaceTemplate } = await import("../lib/cms/defaults.js");
const Res = await import("../lib/content/resolve.js");
const { brandCssVars, kitSurfaces } = await import("../lib/brand.js");
const { runRequest } = await import("./support/request-cache.js");

const ACTOR = { kind: "merchant", id: "usr_threnders" };
const AURORA_TEXT = await readFile(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8");
const AURORA = JSON.parse(AURORA_TEXT);
const PKG_A = "thm_a1a1a1a1a1a1a1a1";
const PKG_TAMPERED = "thm_7a7a7a7a7a7a7a7a";
const PKG_BADSLUG = "thm_badbadbadbadbad0";
const PKG_NONE = "thm_0000000000000000";

// a package row, written straight into the store's own database (fixture helper)
async function insertPackage(tn, { id, slug = AURORA.id, version = AURORA.version, base = AURORA.base, pkg = AURORA, status = "installed" }) {
  const c = tn.client();
  try {
    const text = typeof pkg === "string" ? pkg : JSON.stringify(pkg);
    await c.execute({
      sql: "INSERT INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, slug, version, "Aurora", "Storeasy Studio", "", base, text, "0".repeat(64), text.length, status, ACTOR.id, new Date().toISOString()],
    });
  } finally {
    c.close();
  }
}
// doc_design with this theme, saved as a draft and (by default) published
async function setDesign(tn, theme, { publish = true } = {}) {
  return tn.run(async () => {
    let d = await Docs.getDocument("doc_design").catch(() => null);
    if (!d) {
      const body = R.emptyBody("design");
      body.settings = { ...(body.settings || {}), theme };
      await Docs.createDocument({ type: "design", body, actor: ACTOR });
    } else {
      await Docs.saveDraft({ id: "doc_design", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, theme } }, actor: ACTOR });
    }
    if (!publish) return;
    // a store's first publish opens it with its home page, so the first one takes a home along
    let home = await Docs.getDocument("doc_home").catch(() => null);
    if (!home) {
      const hb = R.emptyBody("home");
      const sec = R.newSection("text", { id: "sec_threnders" });
      hb.sections = [{ ...sec, settings: { ...sec.settings, title: "Hello", body: ["Words."] } }];
      await Docs.createDocument({ type: "home", body: hb, actor: ACTOR });
      home = await Docs.getDocument("doc_home");
    }
    d = await Docs.getDocument("doc_design");
    const ids = [{ id: d.id, revision: d.revision, draftHash: d.draftHash }];
    if (!home.publishedVersionId) ids.push({ id: home.id, revision: home.revision, draftHash: home.draftHash });
    await publishPast(tn, theme?.package, () => Pub.publish({ ids, actor: ACTOR }));
  });
}
// Line 3's publish gate refuses a design naming a missing, archived or
// unreadable package. A missing or tampered row is what a store can meet AFTER
// a publish (a row lost or hand-edited later), so such a design is published
// over a clean stand-in row that is then put back as it was.
async function publishPast(tn, id, publish) {
  const c = tn.client();
  try {
    const was = id ? (await c.execute({ sql: "SELECT * FROM theme_packages WHERE id = ?", args: [id] })).rows[0] ?? null : null;
    const clean = !id || (was && String(was.status) === "installed" && LP.renderablePackage({ id: String(was.id), slug: String(was.slug), base_kit: String(was.base_kit), package: String(was.package) }));
    if (clean) return await publish();
    const text = JSON.stringify(AURORA);
    await c.execute({ sql: "DELETE FROM theme_packages WHERE id = ?", args: [id] });
    await c.execute({
      sql: "INSERT INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?)",
      args: [id, `standin-${id.slice(-6)}`, "0.0.0", "Stand-in", null, "", "pulse", text, "0".repeat(64), text.length, ACTOR.id, new Date().toISOString()],
    });
    try {
      return await publish();
    } finally {
      await c.execute({ sql: "DELETE FROM theme_packages WHERE id = ?", args: [id] });
      if (was) {
        const cols = Object.keys(was);
        await c.execute({ sql: `INSERT INTO theme_packages (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((k) => was[k]) });
      }
    }
  } finally {
    c.close();
  }
}
const THEME = (pkg) => ({ kit: "pulse", version: 1, ...(pkg ? { package: pkg } : {}) });

await insertPackage(a, { id: PKG_A });
// store B gets a package of its own with a different slug, never named by its design
await insertPackage(b, { id: "thm_b2b2b2b2b2b2b2b2", slug: "bramble", pkg: { ...AURORA, id: "bramble" } });
await setDesign(a, THEME(PKG_A));
await setDesign(b, THEME(null));

// ---- the storefront renderer (Next's SWC, as test-design-doc / test-plugin-slots) --------
const { prerenderToNodeStream } = require("react-dom/static");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (await swc.transform(await readFile(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
const nothingC = { __esModule: true, default: () => null };
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "next/font/local": fontModule,
  "@/app/fonts/fonts": fontModule,
  "../globals.css": {},
  "@/components/ServiceWorkerRegister": nothingC,
  "@/components/analytics/ConsentBanner": nothingC,
  "@/components/analytics/Pixels": nothingC,
  "@/components/analytics/ErrorReporter": nothingC,
  "@/components/site/SiteNav": nothingC,
  "@/components/preview/PreviewBridge": nothingC,
  "@/components/preview/EditThisPage": nothingC,
  // the header's client widgets need Next's app router
  "./SearchBox": nothingC,
  "./cart/CartButton": nothingC,
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
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolvePath(dirname(file), id);
      if (!target.endsWith(".js")) target = existsSync(`${target}.js`) ? `${target}.js` : join(target, "index.js");
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
const Layout = (await loadJsx(join(ROOT, "app/(storefront)/layout.js"))).default;
const Pdp = await loadJsx(join(ROOT, "components/pdp/PdpLayouts.js"));
const CheckoutFlow = (await loadJsx(join(ROOT, "components/checkout/CheckoutFlow.js"))).default;
const { emptyCart } = await import("../lib/cart.js");
const shippingConfig = await a.run(async () => (await import("../lib/tenant-context.js")).tenantShippingConfig());
const { db } = await import("../lib/db.js");
const productOf = (tn) => tn.run(async () => (await import("../lib/repo.js")).getProductByHandle((await db.selectFrom("products").select("handle").orderBy("handle").limit(1).executeTakeFirst()).handle));
const productA = await productOf(a);

// the page a shopper gets on the store's host, no cookies: the layout around
// both PDP buy boxes and the checkout flow (the cart drawer is the layout's own)
const page = (product) =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement(Pdp.PdpClassic, { product, override: null, extras: [], pairs: null }),
    React.createElement(Pdp.PdpEditorial, { product, override: null, extras: [], pairs: null }),
    React.createElement(CheckoutFlow, { cart: emptyCart(), razorpayEnabled: false, storeName: "Store", policies: [], shippingConfig }),
  );
async function shopperHtml(tn, { product = productA, logs = null } = {}) {
  globalThis.__readRequest = { host: tn.tenant.domains[0], cookies: {} };
  const orig = console.log;
  if (logs) console.log = (line) => (String(line).startsWith("{") ? logs.push(String(line)) : orig(line));
  try {
    return await runRequest(async () => {
      const el = await Layout({ children: page(product) });
      const { prelude } = await prerenderToNodeStream(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, el));
      let out = "";
      for await (const chunk of prelude) out += chunk;
      return out;
    });
  } finally {
    console.log = orig;
    globalThis.__readRequest = null;
  }
}
const htmlTag = (h) => h.match(/<html\b[^>]*>/)?.[0] ?? "";
const attr = (tag, n) => tag.match(new RegExp(`\\s${n}="([^"]*)"`))?.[1] ?? null;
const styleOf = (h) => h.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
// each data-protected element's outer HTML (balanced on its own tag name)
function protectedParts(h) {
  const out = [];
  for (const m of h.matchAll(/<(\w+)\b[^>]*\sdata-protected="([^"]+)"[^>]*>/g)) {
    const tag = m[1];
    let depth = 0;
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
    re.lastIndex = m.index;
    let end = h.length;
    for (let x; (x = re.exec(h)); ) {
      depth += x[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = re.lastIndex;
        break;
      }
    }
    out.push({ kind: m[2], html: h.slice(m.index, end) });
  }
  return out;
}
let flagMade = false;
const setKill = async (off) => {
  await FLAGS.setFlag({ key: LP.THEMES_KILL_FLAG, description: "Uploaded themes (Phase 5)", default_on: !off, create: !flagMade, actor: "test" });
  flagMade = true;
};

// =====================================================================================
console.log("— 1. the live package, store A; store B a canary");
// =====================================================================================
let themedA = "";
await t("store A (anonymous shopper): data-theme=aurora beside data-kit, the package's surfaces and compiled styles in the brand <style>", async () => {
  themedA = await shopperHtml(a);
  const tag = htmlTag(themedA);
  eq(attr(tag, "data-theme"), "aurora", "data-theme:");
  eq(attr(tag, "data-kit"), "pulse-1", "data-kit:");
  const css = styleOf(themedA);
  ok(css.includes(`--header-bg:${AURORA.surfaces.header.bg}`) && css.includes(`--hero-bg:${AURORA.surfaces.hero.bg}`), `surfaces: ${css.slice(0, 400)}`);
  const compiled = compileStyles(AURORA.styles, "aurora");
  ok(compiled.length > 0 && css.includes(compiled), "the compiled styles are in the <style>");
  ok(css.includes(':where([data-theme="aurora"]) [data-part="hero-title"]{'), "a part rule");
});

await t("store A: the theme's templates are the defaults under the founder's own (header centered, footer minimal, pdp editorial; entity → family → theme → platform)", async () => {
  ok(themedA.includes("grid-cols-[1fr_auto_1fr]"), "the centered header");
  const t2 = await a.run(async () => [await Res.resolvedSurfaceTemplates(), await Res.resolvedSurfaceTemplateFor("pdp", null)]);
  // a documents store with no published doc_header / doc_footer: the theme decides
  eq(JSON.stringify(t2[0]), JSON.stringify({ header: AURORA.templates.header, footer: AURORA.templates.footer }), "chrome:");
  eq(`${t2[1].template}/${t2[1].source}`, "editorial/theme", "pdp:");
  const th = AURORA.templates;
  eq(effectiveSurfaceTemplate({ pdp: "classic", products: { 7: "editorial" } }, "pdp", 7, th).source, "entity", "entity first:");
  eq(effectiveSurfaceTemplate({ pdp: "classic" }, "pdp", 7, th).template, "classic", "the founder's family choice beats the theme:");
  eq(effectiveSurfaceTemplate(null, "pdp", null, th).source, "theme", "then the theme:");
  eq(effectiveSurfaceTemplate(null, "pdp", null, { pdp: "fancy" }).source, "platform", "an unknown template: the platform's:");
  eq(effectiveSurfaceTemplate(null, "pdp", null).template, "classic", "no theme: today's default:");
});

await t("review fix: a published doc_header and doc_product_layout made with default settings (template null) still render the theme's templates; a founder's explicit choice wins", async () => {
  eq(R.emptyBody("header").settings.template, null, "header default:");
  eq(R.emptyBody("footer").settings.template, null, "footer default:");
  eq(R.emptyBody("product_layout").settings.template, null, "product layout default:");
  eq(R.emptyBody("collection_layout").settings.template, null, "collection layout default:");
  const publishDocs = (ids) =>
    a.run(async () => {
      const items = [];
      for (const id of ids) {
        const d = await Docs.getDocument(id);
        items.push({ id: d.id, revision: d.revision, draftHash: d.draftHash });
      }
      await Pub.publish({ ids: items, actor: ACTOR });
    });
  await a.run(async () => {
    await Docs.createDocument({ type: "header", body: null, actor: ACTOR });
    await Docs.createDocument({ type: "product_layout", body: null, actor: ACTOR });
  });
  await publishDocs(["doc_header", "doc_product_layout"]);
  const live = await a.run(async () => [await Docs.getDocument("doc_header"), await Res.resolvedSurfaceTemplateFor("pdp", null)]);
  ok(live[0].publishedVersionId != null && live[0].body.settings.template === null, `doc_header is live with no template: ${JSON.stringify(live[0].body?.settings)}`);
  eq(`${live[1].template}/${live[1].source}`, "editorial/theme", "pdp with a live default layout document:");
  ok((await shopperHtml(a)).includes("grid-cols-[1fr_auto_1fr]"), "the theme's centered header with a live default doc_header");
  // the founder picks standard: their choice beats the theme
  await a.run(async () => {
    const d = await Docs.getDocument("doc_header");
    await Docs.saveDraft({ id: "doc_header", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, template: "standard" } }, actor: ACTOR });
  });
  await publishDocs(["doc_header"]);
  ok(!(await shopperHtml(a)).includes("grid-cols-[1fr_auto_1fr]"), "the founder's standard header");
  await a.run(async () => {
    const d = await Docs.getDocument("doc_header");
    await Docs.saveDraft({ id: "doc_header", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, template: null } }, actor: ACTOR });
  });
  await publishDocs(["doc_header"]);
  ok((await shopperHtml(a)).includes("grid-cols-[1fr_auto_1fr]"), "back to unchosen: the theme's again");
});

await t("store B (anonymous shopper): no data-theme, no theme CSS and no package surface; B naming A's package id (a row only A holds) renders its base kit", async () => {
  const h = await shopperHtml(b);
  eq(attr(htmlTag(h), "data-theme"), null, "B data-theme:");
  for (const leak of ["data-theme", "aurora", "bramble", AURORA.surfaces.header.bg, AURORA.surfaces.hero.bg]) ok(!h.includes(leak), `B shows ${leak}`);
  await setDesign(b, THEME(PKG_A));
  const logs = [];
  const h2 = await shopperHtml(b, { logs });
  eq(attr(htmlTag(h2), "data-theme"), null, "B naming A's id:");
  ok(!h2.includes("aurora") && !h2.includes(AURORA.surfaces.hero.bg), "nothing of A's package");
  ok(logs.some((l) => l.includes('"evt":"theme_package_missing"') && l.includes(PKG_A)), `logged: ${logs.join(" | ").slice(0, 300)}`);
  await setDesign(b, THEME(null));
});

// =====================================================================================
console.log("— 2. a draft-only package");
// =====================================================================================
await t("a package named only in B's draft design is absent from the anonymous shopper's page", async () => {
  await setDesign(b, THEME("thm_b2b2b2b2b2b2b2b2"), { publish: false });
  const h = await shopperHtml(b);
  eq(attr(htmlTag(h), "data-theme"), null, "draft only:");
  ok(!h.includes("bramble"), "no bramble");
  // published, it shows (the same row): the draft was the only thing missing
  await setDesign(b, THEME("thm_b2b2b2b2b2b2b2b2"));
  eq(attr(htmlTag(await shopperHtml(b)), "data-theme"), "bramble", "once published:");
  await setDesign(b, THEME(null));
});

// =====================================================================================
console.log("— 3. protected parts");
// =====================================================================================
await t("buy box (both PDP layouts), cart drawer and checkout: byte-identical with and without the theme, and no data-part inside any", async () => {
  await setKill(true);
  const base = await shopperHtml(a);
  await setKill(false);
  eq(attr(htmlTag(base), "data-theme"), null, "killed: base kit:");
  const p1 = protectedParts(themedA);
  const p0 = protectedParts(base);
  eq(p1.map((p) => p.kind).join(","), "buy-box,buy-box,checkout,cart", "the protected parts rendered:");
  eq(p0.length, p1.length, "same parts:");
  for (let i = 0; i < p1.length; i++) {
    eq(p1[i].html, p0[i].html, `${p1[i].kind} #${i} markup:`);
    ok(!p1[i].html.includes("data-part="), `${p1[i].kind}: a data-part inside`);
  }
  // and the theme's colours reach them only through token variables: no hex of the package inside
  for (const p of p1) for (const hex of Object.values(AURORA.surfaces).flatMap((s) => Object.values(s))) ok(!p.html.includes(hex), `${p.kind} holds ${hex}`);
});

await t("static scan: no data-part in the protected components or anything they import from components/, and every one of the 15 PARTS has a hook in the storefront", async () => {
  const { PARTS } = await import("../lib/themes/package-format.js");
  const reached = new Set();
  const queue = ["components/ProductPurchase.js", "components/cart/CartDrawer.js", "components/checkout/CheckoutFlow.js"];
  while (queue.length) {
    const f = queue.shift();
    if (reached.has(f)) continue;
    reached.add(f);
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!/data-part=/.test(src), `${f} has a data-part`);
    for (const m of src.matchAll(/from\s+["']((?:\.|@\/)[^"']+)["']/g)) {
      let r = m[1].startsWith("@/") ? m[1].slice(2) : relative(ROOT, resolvePath(dirname(join(ROOT, f)), m[1]));
      if (!r.endsWith(".js")) r = existsSync(join(ROOT, `${r}.js`)) ? `${r}.js` : join(r, "index.js");
      if (r.startsWith("components/") && existsSync(join(ROOT, r))) queue.push(r);
    }
  }
  ok(reached.size > 3, `reached: ${[...reached].join(", ")}`);
  // the hooks themselves
  const files = ["components/Header.js", "components/Footer.js", "components/ProductCard.js", "components/CollectionCard.js", "components/sections/HeroSection.js", "components/sections/RichTextSection.js"];
  const all = (await Promise.all(files.map((f) => readFile(join(ROOT, f), "utf8")))).join("\n");
  for (const p of PARTS) ok(all.includes(`data-part="${p}"`), `no hook for ${p}`);
  // the chrome's own parts render on every page (the rest are page content: home sections and cards)
  for (const p of ["header", "header-link", "footer", "footer-link"]) ok(themedA.includes(`data-part="${p}"`), `${p} not rendered in the chrome`);
});

// =====================================================================================
console.log("— 4. a hand-tampered row");
// =====================================================================================
await t("a tampered package row (hostile parts, values, surfaces) compiles to no url(, @, < or extra }; a tampered slug renders the base kit", async () => {
  const hostile = {
    ...AURORA,
    surfaces: { header: { bg: "#000;}body{background:url(//x.test/a)}", fg: "red</style><script>alert(1)</script>", muted: "#cbd5e1" }, hero: AURORA.surfaces.hero },
    styles: [
      { part: "hero-title</style><script>alert(1)</script>", set: { color: "#fff" } },
      { part: "hero", set: { "background-image": "url(//x.test/a.png)" } },
      { part: "hero", set: { color: "red;}@import url(//x.test/a.css);a{" } },
      { part: "hero", set: { color: "role:accent}</style><img src=x onerror=alert(1)>" } },
      { part: "badge", set: { "border-radius": "4px;behavior:url(x)" } },
      { part: "badge", set: { "letter-spacing": "expression(alert(1))" } },
      { part: "section", set: { "padding-block": "2rem" } },
    ],
  };
  await insertPackage(a, { id: PKG_TAMPERED, version: "9.9.9", pkg: hostile });
  await setDesign(a, THEME(PKG_TAMPERED));
  const h = await shopperHtml(a);
  eq(attr(htmlTag(h), "data-theme"), "aurora", "the row still renders:");
  const css = styleOf(h);
  for (const bad of ["url(", "@import", "<script", "<img", "</style", "expression(", "behavior", "onerror", "x.test"]) ok(!css.includes(bad), `the CSS holds ${bad}: ${css.slice(0, 600)}`);
  const themeCss = compileStyles(hostile.styles, "aurora");
  eq(themeCss.split("\n").length, 1, "only the one good rule compiles:");
  eq((themeCss.match(/}/g) || []).length, 1, "one closing brace:");
  ok(!/[<@]/.test(themeCss), "no < or @");
  // surfaces: the hostile ones keep the kit's value
  eq(kitSurfaces("pulse-1", hostile.surfaces).header.bg, "#09090b", "header bg:");
  ok(!brandCssVars(null, { kit: "pulse-1", surfaces: hostile.surfaces }).includes("url("), "brandCssVars");
  // a slug that isn't a theme id, a base that isn't a kit, a package that isn't JSON: base kit
  await insertPackage(a, { id: PKG_BADSLUG, slug: 'aurora"]{}', version: "9.9.8" });
  eq(LP.renderablePackage({ id: PKG_BADSLUG, slug: 'aurora"]{}', base_kit: "pulse", package: "{}" }), null, "bad slug:");
  eq(LP.renderablePackage({ id: PKG_A, slug: "aurora", base_kit: "neon", package: "{}" }), null, "bad base:");
  eq(LP.renderablePackage({ id: PKG_A, slug: "aurora", base_kit: "pulse", package: "{not json" }), null, "not json:");
  await setDesign(a, THEME(PKG_BADSLUG));
  const logs = [];
  const h2 = await shopperHtml(a, { logs });
  eq(attr(htmlTag(h2), "data-theme"), null, "bad slug renders the base kit:");
  ok(!h2.includes('aurora"'), "the slug never reaches the page");
  ok(logs.some((l) => l.includes('"evt":"theme_package_missing"') && l.includes('"reason":"corrupt"')), "logged corrupt");
  await setDesign(a, THEME(PKG_A));
});

// =====================================================================================
console.log("— 5. kill switch and missing package");
// =====================================================================================
await t("ff_theme-packages off: store A renders its base kit (no data-theme, no package CSS), logged theme_packages_killed; on again, the theme is back", async () => {
  await setKill(true);
  const logs = [];
  const h = await shopperHtml(a, { logs });
  eq(attr(htmlTag(h), "data-theme"), null, "killed:");
  eq(attr(htmlTag(h), "data-kit"), "pulse-1", "base kit:");
  ok(!styleOf(h).includes("data-theme") && !h.includes(AURORA.surfaces.hero.bg), "no package CSS");
  eq(logs.filter((l) => l.includes('"evt":"theme_packages_killed"')).length, 1, "logged once a request:");
  eq(await a.run(() => LP.themePackagesOff()), true, "themePackagesOff:");
  eq(LP.THEMES_OFF_WORDS, "Uploaded themes are turned off by Storeasy right now.", "the words line 1's upload refuses with:");
  await setKill(false);
  eq(attr(htmlTag(await shopperHtml(a)), "data-theme"), "aurora", "on again:");
});

await t("a design naming a package with no row renders the base kit, logged theme_package_missing (not_found); an id that isn't one too (invalid_id)", async () => {
  await setDesign(a, THEME(PKG_NONE));
  const logs = [];
  const h = await shopperHtml(a, { logs });
  eq(attr(htmlTag(h), "data-theme"), null, "missing:");
  eq(logs.filter((l) => l.includes('"evt":"theme_package_missing"') && l.includes('"reason":"not_found"')).length, 1, `logged once a request: ${logs.join(" | ").slice(0, 300)}`);
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try {
    eq(await a.run(() => LP.packageFor({ kit: "pulse", version: 1, package: "thm_<script>" })), null, "invalid id:");
  } finally {
    console.log = orig;
  }
  ok(lines.some((l) => l.includes('"reason":"invalid_id"')), "logged invalid_id");
  eq(await a.run(() => LP.packageFor({ kit: "pulse", version: 1 })), null, "no package named:");
  await setDesign(a, THEME(PKG_A));
});

// =====================================================================================
console.log("— 6. edge safety and cost");
// =====================================================================================
await t("the transitive import scan from app/(storefront)/layout.js reaches lib/themes/live-package.js and styles.js and finds no node: import (tenant-context's async_hooks, which the edge runtime has, is the only Node module reached)", async () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
  const local = (f, spec) => {
    let r = spec.startsWith("@/") ? spec.slice(2) : join(dirname(f), spec);
    if (!r.endsWith(".js")) r = existsSync(join(ROOT, `${r}.js`)) ? `${r}.js` : join(r, "index.js");
    return existsSync(join(ROOT, r)) ? r : null;
  };
  const reached = new Set();
  const hits = new Set();
  const queue = ["app/(storefront)/layout.js"];
  while (queue.length) {
    const f = queue.shift();
    if (reached.has(f)) continue;
    reached.add(f);
    const src = strip(await readFile(join(ROOT, f), "utf8"));
    for (const m of src.matchAll(nodeImport)) hits.add(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)["']((?:\.|@\/)[^"']+)["']/gm)) {
      const r = local(f, m[1]);
      if (r) queue.push(r);
    }
  }
  for (const f of ["lib/themes/live-package.js", "lib/themes/styles.js", "lib/themes/package-format.js", "lib/brand.js", "lib/platform/flags.js"]) ok(reached.has(f), `${f} not reached`);
  eq(JSON.stringify([...hits]), JSON.stringify(["lib/tenant-context.js: node:async_hooks"]), "node imports reached:");
});

await t("cost: the layout's render time with the live package and without one (same store), median of 15", async () => {
  const median = async (fn, n = 15) => {
    for (let i = 0; i < 2; i++) await fn();
    const ms = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await fn();
      ms.push(performance.now() - t0);
    }
    ms.sort((x, y) => x - y);
    return ms[Math.floor(n / 2)];
  };
  const withPkg = await median(() => shopperHtml(a));
  await setDesign(a, THEME(null));
  const without = await median(() => shopperHtml(a));
  await setDesign(a, THEME(PKG_A));
  console.log(`    layout render: ${withPkg.toFixed(1)} ms with the package, ${without.toFixed(1)} ms without (+${(withPkg - without).toFixed(1)} ms)`);
  ok(withPkg - without < 50, `the package adds ${(withPkg - without).toFixed(1)} ms`);
});

for (const tn of [a, b]) await tn.cleanup().catch(() => {});
await F.removeFixtureFiles("threnders");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
