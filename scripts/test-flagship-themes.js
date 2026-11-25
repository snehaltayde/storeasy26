// Phase 7 line 1: Storeasy's five flagship themes (docs/plans/phase-7.md "Line 1").
//   pnpm test:flagship-themes
// The five packages pass parseThemePackage, checkBrand (their own tokens and
// all six palettes, on their own surfaces) and validateStyles; ensureFlagship
// is idempotent with the deterministic id; flagships never count toward the
// 30-upload limit; an upload may not take a flagship id; flagships can't be
// archived; the kill switch ff_theme-packages keeps a live flagship rendering
// and stops an upload; "Use this theme" writes drafts only (anonymous HTML
// byte-identical) and Publish writes publish_log, audit and theme_pin.source;
// the heading_font token (absent: byte-identical CSS; serif: Fraunces; comic:
// refused); the storefront layout's import walk has no node:*; the role
// matrix; support's list carries no apply; another store's package is 404;
// the onboarding Brand step with a theme writes drafts only and Skip writes
// none; an older flagship version in use offers "Update to …".
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import React from "react";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-flagship-themes-default.db";
process.env.PLATFORM_SECRET = "test-flagship-themes-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
const network = H.blockNetwork();

// next/headers answers for one simulated storefront request at a time
// (registered after the route harness, so it runs first)
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__readRequest;
  if (!r) throw new Error("no request scope");
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
    if (spec === "next/navigation") return next("next/navigation.js", ctx);
    return next(spec, ctx);
  },
});

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
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};
const eq = (got, want, m = "") => {
  if (got !== want) throw new Error(`${m} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const FS = await import("../lib/themes/flagships.js");
const FL = await import("../lib/themes/flagship-look.js");
const V = await import("../lib/themes/package-validate.js");
const ST = await import("../lib/themes/styles.js");
const F = await import("../lib/themes/package-format.js");
const B = await import("../lib/brand.js");
const PAL = await import("../lib/themes/palettes.js");

// =====================================================================================
console.log("— the five packages");
// =====================================================================================
await t("five flagships: Volt, Bloom, Loom, Harvest, Haven with their verticals, bases and heading fonts", () => {
  eq(FS.FLAGSHIP_SLUGS.join(","), "volt,bloom,loom,harvest,haven", "slugs:");
  const want = { volt: ["pulse", "sans"], bloom: ["glow", "serif"], loom: ["glow", "serif"], harvest: ["pulse", "serif"], haven: ["glow", "sans"] };
  for (const p of FS.latestFlagships()) {
    eq(`${p.base} ${p.tokens.heading_font}`, want[p.id].join(" "), `${p.id}:`);
    ok(FS.flagshipCard(p).vertical, `${p.id} vertical`);
  }
  eq(new Set(FS.latestFlagships().map((p) => p.tokens.accent)).size, 5, "five distinct accents:");
});

await t("each passes parseThemePackage, validateStyles (8 to 14 rules), has a home layout and no pictures or files", () => {
  for (const p of FS.FLAGSHIPS) {
    const r = V.parseThemePackage(JSON.stringify(p));
    ok(r.pkg, `${p.id}: ${JSON.stringify(r.issues)}`);
    eq(ST.validateStyles(p.styles).length, 0, `${p.id} styles:`);
    ok(p.styles.length >= 8 && p.styles.length <= 14, `${p.id} has ${p.styles.length} rules`);
    ok(r.pkg.templates.home.sections.length >= 3, `${p.id} home sections`);
    for (const k of ["pdp", "collection", "header", "footer"]) ok(r.pkg.templates[k], `${p.id} ${k} layout`);
    ok(!JSON.stringify(p).includes('"med_') && !/"image":\s*\{/.test(JSON.stringify(p)), `${p.id}: no assets`);
    eq(r.pkg.tokens.heading_font, p.tokens.heading_font, `${p.id} keeps heading_font:`);
  }
});

await t("checkBrand has no errors on each theme's own surfaces: its own tokens and all six palettes", () => {
  for (const p of FS.FLAGSHIPS) {
    const kit = FL.flagshipKit(p);
    for (const pal of [null, ...PAL.PALETTES.map((x) => x.id)]) {
      const brand = FL.flagshipBrand(p.id, pal);
      const errs = B.checkBrand(brand, { kit, surfaces: p.surfaces }).issues.filter((i) => i.severity === "error");
      eq(errs.length, 0, `${p.id} + ${pal ?? "own"}: ${errs.map((e) => e.message).join(" | ")}`);
    }
  }
});

await t("flagshipPackageId is thm_ + the first 16 hex of sha256('storeasy:<slug>@<version>')", async () => {
  const { createHash } = await import("node:crypto");
  for (const p of FS.FLAGSHIPS) {
    const want = `thm_${createHash("sha256").update(`storeasy:${p.id}@${p.version}`).digest("hex").slice(0, 16)}`;
    eq(await FS.flagshipPackageId(p.id, p.version), want, `${p.id}:`);
    ok(F.PACKAGE_ID_RE.test(want), "a package id");
  }
});

// =====================================================================================
console.log("— the heading_font token");
// =====================================================================================
await t("absent heading_font: byte-identical CSS for an old brand; serif emits Fraunces under :root[data-kit]; comic is refused", () => {
  const old = { accent: "#166534", background: "#fffbf7", foreground: "#1c1917", radius: "md", type_scale: "regular" };
  const before = B.brandCssVars(old, { kit: "glow-1" });
  ok(!before.includes("--display-font"), "no display font without the token");
  eq(B.brandCssVars(B.resolveBrand(old), { kit: "glow-1" }), before, "resolved, same CSS:");
  const serif = B.brandCssVars({ ...old, heading_font: "serif" }, { kit: "pulse-1" });
  ok(serif.startsWith(before.replace(/\}$/, "").slice(0, 20)), "the same :root block first");
  ok(serif.includes(":root[data-kit]{--display-font:var(--font-fraunces), Georgia, serif;}"), serif);
  ok(B.brandCssVars({ ...old, heading_font: "sans" }, { kit: "glow-1" }).includes(":root[data-kit]{--display-font:var(--font-geist-sans)"), "sans");
  const bad = B.validateBrand({ ...old, heading_font: "comic" });
  ok(!bad.ok && bad.errors.some((e) => e.startsWith("heading_font")), JSON.stringify(bad.errors));
  ok(!("heading_font" in B.validateBrand(old).value), "validateBrand sets it only when given");
  ok(V.parseThemePackage(JSON.stringify({ ...FS.FLAGSHIPS[0], id: "x-comic", tokens: { ...FS.FLAGSHIPS[0].tokens, heading_font: "comic" } })).issues?.some((i) => i.path === "tokens.heading_font"), "a package with comic is refused");
});

await t("the registry takes heading_font on doc_design's brand and refuses comic in plain words", async () => {
  const R = await import("../lib/registry/index.js");
  const body = (hf) => ({ ...R.emptyBody("design"), settings: { ...R.emptyBody("design").settings, brand: { accent: "#166534", background: "#ffffff", foreground: "#0a0a0b", heading_font: hf } } });
  ok(R.validateDocument(body("serif"), { mode: "publish", documentId: "doc_design" }).issues.every((i) => i.severity !== "error"), "serif ok");
  const bad = R.validateDocument(body("comic"), { mode: "publish", documentId: "doc_design" }).issues.filter((i) => i.severity === "error");
  ok(bad.some((i) => /heading font/i.test(i.message)), JSON.stringify(bad.map((i) => i.message)));
});

await t("the storefront layout's import walk reaches flagships.js and flagship-look.js and finds no node:* module (tenant-context's async_hooks, which the edge runtime has, is the only one)", async () => {
  const seen = new Set();
  const bad = [];
  const walk = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try {
      src = await readFile(file, "utf8");
    } catch {
      return;
    }
    for (const [, id] of src.matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!id) continue;
      if (id.startsWith("node:")) bad.push(`${relative(ROOT, file)} → ${id}`);
      if (!id.startsWith(".") && !id.startsWith("@/")) continue;
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolvePath(dirname(file), id);
      if (!/\.(m?js|ts)$/.test(target)) target = existsSync(`${target}.js`) ? `${target}.js` : existsSync(`${target}.ts`) ? `${target}.ts` : join(target, "index.js");
      await walk(target);
    }
  };
  await walk(join(ROOT, "app/(storefront)/layout.js"));
  for (const f of ["lib/themes/flagships.js", "lib/themes/flagship-look.js", "lib/themes/live-package.js"]) ok(seen.has(join(ROOT, f)), `${f} is reached`);
  eq(bad.join(", "), "lib/tenant-context.js → node:async_hooks", "node: imports:");
});

// =====================================================================================
// two stores: A opens with Pulse (a published design and home page)
// =====================================================================================
const store = await H.makeRoleStore({ name: "flagship" });
const { a, b, call } = store;
const { roleAllows } = await import("../lib/platform/authz.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { getTenant } = await import("../lib/platform/control.js");
const FLAGS = await import("../lib/platform/flags.js");
const LP = await import("../lib/themes/live-package.js");
const P = await import("../lib/themes/packages.js");
const Docs = await import("../lib/documents/service.js");
const R = await import("../lib/registry/index.js");
const Res = await import("../lib/content/resolve.js");
const hostB = () => b.tenant.domains[0];
const MERCHANT = ["owner", "admin", "staff", "support"];
const OPS = ["operator-support", "operator-support-entry"];
const sql = async (tn, s, args = []) => {
  const c = tn.client();
  try {
    return (await c.execute({ sql: s, args })).rows;
  } finally {
    c.close();
  }
};
const AURORA = JSON.parse(await readFile(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8"));
await a.run(async () => {
  const ACTOR = { kind: "merchant", id: store.users.owner.id };
  const hb = R.emptyBody("home");
  const sec = R.newSection("text", { id: "sec_flagship1" });
  hb.sections = [{ ...sec, settings: { ...sec.settings, title: "Hello", body: ["Words."] } }];
  await Docs.createDocument({ type: "home", body: hb, actor: ACTOR });
  const db = R.emptyBody("design");
  await Docs.createDocument({ type: "design", body: { ...db, settings: { ...(db.settings || {}), theme: { kit: "pulse", version: 1 } } }, actor: ACTOR });
  const Pub = await import("../lib/documents/publish.js");
  const ids = await Promise.all(["doc_design", "doc_home"].map(async (id) => {
    const d = await Docs.getDocument(id);
    return { id, revision: d.revision, draftHash: d.draftHash };
  }));
  await Pub.publish({ ids, actor: ACTOR });
});
await H.drainAfter();


// ---- the storefront renderer (as test-theme-render) -----------------------------------
const { prerenderToNodeStream } = require("react-dom/static");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const { fontModule } = await import("./support/font-stub.js");
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
// the page on the store's host: the anonymous shopper (no cookies) or a preview browser
async function storeHtml(tn, cookies = {}) {
  globalThis.__readRequest = { host: tn.tenant.domains[0], cookies };
  try {
    const el = await Layout({ children: React.createElement("main", null, "page") });
    const { prelude } = await prerenderToNodeStream(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, el));
    let out = "";
    for await (const chunk of prelude) out += chunk;
    return out;
  } finally {
    globalThis.__readRequest = null;
  }
}
const themeAttr = (h) => (h.match(/<html\b[^>]*>/)?.[0] ?? "").match(/\sdata-theme="([^"]*)"/)?.[1] ?? null;
const inStore = async (tn, fn, cookies = {}) => {
  globalThis.__readRequest = { host: tn.tenant.domains[0], cookies };
  try {
    return await tn.run(fn);
  } finally {
    globalThis.__readRequest = null;
  }
};

const design = () => a.run(() => Docs.getDocument("doc_design"));
const OWNER = { kind: "merchant", id: store.users.owner.id };
const header = () => a.run(() => Docs.getDocument("doc_header"));
const toggleHeaderMenu = () =>
  a.run(async () => {
    const h = await Docs.getDocument("doc_header");
    await Docs.saveDraft({ id: "doc_header", revision: h.revision, body: { ...h.body, settings: { ...h.body.settings, mode: h.body.settings.mode === "custom" ? "auto" : "custom" } }, actor: OWNER });
  });
// apply names the design revision it saw unless the test passes its own
const apply = async (caller, id, args = {}) => call(caller, "themes/[id]", "POST", { params: { id }, body: { apply: Object.hasOwn(args, "revision") ? args : { revision: (await design()).revision, ...args } } });
const stateOf = async () => (await call("owner", "themes", "GET")).body.state;
// what the Themes page's Publish confirm sends by default: the design and the suggested drafts
const publishSet = async (caller = "owner", pick = (d) => d.suggested) => {
  const s = await stateOf();
  const r = await call(caller, "documents", "PUT", { body: { publishSet: s.publishSet.filter((d) => d.id === "doc_design" || pick(d)).map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) } });
  await H.drainAfter();
  return r;
};
const auditRows = async () => listAudit({ tenantId: a.id, limit: 200 });

const BLOOM_ID = await FS.flagshipPackageId("bloom", "1.0.0");
const HARVEST_ID = await FS.flagshipPackageId("harvest", "1.0.0");
const htmlOf = (h) => (h.match(/<html\b[^>]*>/)?.[0] ?? "");

// =====================================================================================
console.log("— roles");
// =====================================================================================
await t("matrix: list and detail are storefront.read (every role), use is storefront.write (owner, admin, staff), publish is storefront.publish (owner, admin)", () => {
  eq(MERCHANT.filter((r) => roleAllows(r, "storefront.read")).join(","), "owner,admin,staff,support", "read:");
  eq(MERCHANT.filter((r) => roleAllows(r, "storefront.write")).join(","), "owner,admin,staff", "write:");
  eq(MERCHANT.filter((r) => roleAllows(r, "storefront.publish")).join(","), "owner,admin", "publish:");
});

await t("every role reads the five Storeasy themes and a flagship's details; signed out and store B's owner get 401", async () => {
  for (const caller of [...MERCHANT, ...OPS]) {
    const r = await call(caller, "themes", "GET");
    eq(r.status, 200, `${caller}:`);
    eq(r.body.flagships.map((f) => f.slug).join(","), "volt,bloom,loom,harvest,haven", `${caller} flagships:`);
    ok(r.body.flagships.every((f) => f.source === "storeasy" && f.uploadedByName === "Storeasy" && f.vertical && f.description && f.swatch.length === 3), `${caller} cards`);
    const d = await call(caller, "themes/[id]", "GET", { params: { id: "loom" } });
    eq(d.status, 200, `${caller} detail:`);
    eq(`${d.body.package.name} ${d.body.package.version} ${d.body.content.tokens.heading_font}`, "Loom 1.0.0 serif", `${caller} detail:`);
    const file = await call(caller, "themes/[id]", "GET", { params: { id: "loom" }, query: "download=1" });
    eq(file.status, 200, `${caller} download:`);
    ok(V.parseThemePackage(file.text).pkg, "the download is a package");
  }
  for (const caller of ["signed-out", "owner-b"]) {
    eq((await call(caller, "themes", "GET")).status, 401, `${caller} GET:`);
    eq((await call(caller, "themes/[id]", "POST", { params: { id: "bloom" }, body: { apply: {} } })).status, 401, `${caller} apply:`);
  }
  eq((await sql(a, "SELECT COUNT(*) AS n FROM theme_packages"))[0].n, 0, "reading installs nothing:");
});

await t("support and operator support: no apply, update or font controls; 403 on apply; nothing written", async () => {
  const before = (await design()).revision;
  for (const caller of ["support", ...OPS]) eq((await apply(caller, "bloom")).status, 403, `${caller}:`);
  eq((await design()).revision, before, "design revision:");
  eq((await sql(a, "SELECT COUNT(*) AS n FROM theme_packages"))[0].n, 0, "nothing installed:");
  const src = await readFile(join(ROOT, "components/admin/themes/ApplyThemeDialog.js"), "utf8");
  ok(/<RoleGate role=\{role\} action="storefront\.write" reason=\{NO_WRITE\} mode="hide">/.test(src), "Use and Update hide without storefront.write");
  const cards = await readFile(join(ROOT, "components/admin/themes/FlagshipCards.js"), "utf8");
  ok(!/onClick=\{\(\) => postTheme/.test(cards) && cards.includes("ApplyThemeDialog"), "the cards' writes go through ApplyThemeDialog only");
  const rail = await readFile(join(ROOT, "components/admin/editor/fields/DesignForm.js"), "utf8");
  ok(/HeadingFontSelect[\s\S]*disabled=\{readOnly\}/.test(rail), "the font control is disabled read-only");
});

// =====================================================================================
console.log("— install, limits, reserved ids, archive");
// =====================================================================================
await t("ensureFlagship twice gives one row with the deterministic id, source storeasy, by Storeasy", async () => {
  const first = await a.run(() => P.ensureFlagship("haven"));
  const again = await a.run(() => P.ensureFlagship("haven"));
  eq(first.id, await FS.flagshipPackageId("haven", "1.0.0"), "id:");
  eq(`${first.installed} ${again.installed} ${again.id}`, `true false ${first.id}`, "idempotent:");
  const rows = await sql(a, "SELECT id, source, status, uploaded_by FROM theme_packages WHERE slug = 'haven'");
  eq(rows.length, 1, "one row:");
  eq(`${rows[0].source} ${rows[0].status} ${rows[0].uploaded_by}`, "storeasy installed system:storeasy", "row:");
});

await t("29 uploads plus the five flagships still allow an upload; the 31st upload is refused", async () => {
  await Promise.all(FS.FLAGSHIP_SLUGS.map((slug) => a.run(() => P.ensureFlagship(slug))));
  const c = a.client();
  try {
    for (let i = 0; i < 29; i++) {
      const text = JSON.stringify({ ...AURORA, id: `fill-${i}` });
      await c.execute({ sql: "INSERT INTO theme_packages (id, slug, version, name, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, '1.0.0', 'Fill', 'pulse', ?, ?, ?, 'installed', 'merchant:test', ?)", args: [`thm_f${String(i).padStart(15, "0")}`, `fill-${i}`, text, "0".repeat(64), text.length, new Date().toISOString()] });
    }
  } finally {
    c.close();
  }
  const ok30 = await call("owner", "themes", "POST", { body: AURORA });
  eq(ok30.status, 200, ok30.text.slice(0, 200));
  const no31 = await call("owner", "themes", "POST", { body: { ...AURORA, version: "9.0.0" } });
  eq(`${no31.status} ${no31.body.code}`, "409 TOO_MANY", "31st:");
  await sql(a, "UPDATE theme_packages SET status = 'archived', archived_by = 'merchant:test', archived_at = ? WHERE slug LIKE 'fill-%'", [new Date().toISOString()]);
});

await t("an upload with a flagship's id (volt) is refused in plain words; nothing stored", async () => {
  const r = await call("owner", "themes", "POST", { body: { ...AURORA, id: "volt" } });
  eq(r.status, 422, r.text.slice(0, 200));
  eq(r.body.error, "That id belongs to a Storeasy theme. Choose another id.", "words:");
  eq((await sql(a, "SELECT COUNT(*) AS n FROM theme_packages WHERE slug = 'volt' AND source = 'upload'"))[0].n, 0, "none:");
});

await t("archiving a flagship is refused, by slug and by row id", async () => {
  for (const id of ["bloom", BLOOM_ID]) {
    const r = await call("owner", "themes/[id]", "POST", { params: { id }, body: { archive: true } });
    eq(`${r.status} ${r.body.code}`, "409 STOREASY_THEME", `${id}:`);
  }
  eq((await sql(a, "SELECT status FROM theme_packages WHERE id = ?", [BLOOM_ID]))[0].status, "installed", "still installed:");
});

// =====================================================================================
console.log("— use, preview, publish");
// =====================================================================================
let liveBefore = "";
await t("staff uses Bloom: drafts only (design names the package, brand with serif headings, the layouts); audit themes.apply with flagship; anonymous HTML byte-identical", async () => {
  liveBefore = await storeHtml(a);
  const r = await apply("staff", "bloom");
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const d = await design();
  eq(d.body.settings.theme.package, BLOOM_ID, "package:");
  eq(`${d.body.settings.theme.kit} ${d.body.settings.brand.accent} ${d.body.settings.brand.heading_font}`, "glow #be185d serif", "design:");
  const header = await a.run(() => Docs.getDocument("doc_header"));
  eq(header.body.settings.template, "centered", "header layout draft:");
  const row = (await listAudit({ tenantId: a.id, limit: 50 })).find((x) => x.action === "themes.apply");
  const diff = typeof row.diff === "string" ? JSON.parse(row.diff) : row.diff;
  eq(JSON.stringify([diff.package, diff.flagship, diff.installed, diff.withBrand, diff.withHome]), JSON.stringify([BLOOM_ID, "bloom", false, true, false]), "audit:");
  eq(await storeHtml(a), liveBefore, "anonymous HTML:");
  eq((await call("owner", "themes", "GET")).body.flagships.find((f) => f.slug === "bloom").inUse, "draft", "In your draft:");
});

await t("the preview shows Bloom (data-theme, serif heading CSS); the anonymous shopper doesn't", async () => {
  const s = await call("owner", "preview-session", "POST", { body: { create: true } });
  eq(s.status, 200, s.text.slice(0, 200));
  eq((await call("owner", "preview-session", "POST", { body: { showDesign: { sid: s.body.sid, on: true } } })).status, 200, "showDesign:");
  const pv = await storeHtml(a, { [Res.PREVIEW_COOKIE]: s.body.token });
  eq(themeAttr(pv), "bloom", "preview data-theme:");
  ok(pv.includes(":root[data-kit]{--display-font:var(--font-fraunces), Georgia, serif;}"), "the serif heading in the preview");
  eq(themeAttr(await storeHtml(a)), null, "anonymous:");
});

await t("staff can't publish; the owner publishes: anonymous sees Bloom; publish_log, audit and theme_pin.source storeasy", async () => {
  eq((await publishSet("staff")).status, 403, "staff:");
  const r = await publishSet("owner");
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const html = await storeHtml(a);
  eq(themeAttr(html), "bloom", "anonymous data-theme:");
  ok(html.includes("--display-font:var(--font-fraunces)"), "serif headings live");
  const logs = await sql(a, "SELECT release_id FROM publish_log WHERE document_id = 'doc_design' AND action = 'publish' ORDER BY rowid DESC LIMIT 1");
  ok(logs[0]?.release_id, "publish_log");
  ok((await listAudit({ tenantId: a.id, limit: 50 })).some((x) => /publish/.test(String(x.action))), "publish audit");
  const pin = (await getTenant(a.id, { fresh: true })).config.theme_pin;
  eq(JSON.stringify([pin.package, pin.slug, pin.package_version, pin.package_name, pin.source]), JSON.stringify([BLOOM_ID, "bloom", "1.0.0", "Bloom", "storeasy"]), "pin:");
  eq((await call("owner", "themes", "GET")).body.flagships.find((f) => f.slug === "bloom").inUse, "live", "Live badge:");
});

await t("operator Themes names Bloom 1.0.0 (Storeasy)", async () => {
  const route = await import("../app/api/platform/themes/route.js");
  const { NextRequest } = await import("./support/next-server-stub.js");
  const res = await route.GET(new NextRequest("https://operator.console.test/api/platform/themes", { headers: { cookie: `_platform=${store.cookies["operator-support"]._platform}` } }));
  const row = (await res.json()).tenants.find((x) => x.id === a.id);
  eq(JSON.stringify(row.package), JSON.stringify({ id: BLOOM_ID, slug: "bloom", version: "1.0.0", name: "Bloom", source: "storeasy" }), "operator row:");
  const src = await readFile(join(ROOT, "components/platform/operations/Themes.js"), "utf8");
  ok(src.includes('"Storeasy" : "uploaded"'), "the words");
});

await t("kill switch ff_theme-packages: the live flagship keeps rendering and can be used; an upload doesn't render and can't be used", async () => {
  const uploadId = String((await sql(a, "SELECT id FROM theme_packages WHERE slug = 'aurora'"))[0].id);
  await FLAGS.setFlag({ key: P.KILL_FLAG, description: "Uploaded themes", default_on: true, create: true, actor: "operator" });
  await FLAGS.setFlagOverride({ key: P.KILL_FLAG, tenant: a.id, on: false, actor: "operator" });
  FLAGS.__resetFlagCache();
  try {
    eq(themeAttr(await storeHtml(a)), "bloom", "live flagship:");
    const up = await inStore(a, () => LP.packageFor({ kit: "pulse", version: 1, package: uploadId }));
    eq(up, null, "an upload is off:");
    const fl = await inStore(a, () => LP.packageFor({ kit: "pulse", version: 1, package: HARVEST_ID }));
    eq(fl?.slug, "harvest", "a flagship is on:");
    const refused = await apply("owner", uploadId);
    eq(`${refused.status} ${refused.body.code}`, "409 TURNED_OFF_BY_STOREASY", "upload apply:");
    eq((await apply("owner", "volt")).status, 200, "flagship apply:");
  } finally {
    await FLAGS.setFlagOverride({ key: P.KILL_FLAG, tenant: a.id, on: true, actor: "operator" });
    FLAGS.__resetFlagCache();
  }
});

await t("another store: A's flagship row id is 404 on B (B never installed it); B is untouched", async () => {
  eq((await call("owner-b", "themes/[id]", "GET", { host: hostB(), params: { id: BLOOM_ID } })).status, 404, "B GET:");
  eq((await call("owner-b", "themes/[id]", "POST", { host: hostB(), params: { id: BLOOM_ID }, body: { apply: {} } })).status, 404, "B apply by id:");
  eq((await sql(b, "SELECT COUNT(*) AS n FROM theme_packages"))[0].n, 0, "B installed nothing:");
  ok(!(await getTenant(b.id, { fresh: true })).config.theme_pin?.package, "B's pin");
});

await t("an older flagship version in use offers 'Update to Volt 1.0.0'; the update applies the new row as a draft", async () => {
  const oldId = await FS.flagshipPackageId("volt", "0.9.0");
  const old = { ...FS.latestFlagship("volt"), version: "0.9.0" };
  const text = JSON.stringify(V.parseThemePackage(JSON.stringify(old)).pkg);
  await sql(a, "INSERT INTO theme_packages (id, slug, version, name, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at, source) VALUES (?, 'volt', '0.9.0', 'Volt', 'pulse', ?, ?, ?, 'installed', 'system:storeasy', ?, 'storeasy')", [oldId, text, "0".repeat(64), text.length, new Date().toISOString()]);
  eq((await apply("owner", oldId)).status, 200, "the old version into the draft:");
  const card = (await call("owner", "themes", "GET")).body.flagships.find((f) => f.slug === "volt");
  eq(JSON.stringify(card.update), JSON.stringify({ from: "0.9.0", to: "1.0.0", words: "Update to Volt 1.0.0" }), "update:");
  eq((await apply("owner", "volt")).status, 200, "update:");
  eq((await design()).body.settings.theme.package, await FS.flagshipPackageId("volt", "1.0.0"), "the new row in the draft:");
  eq((await call("owner", "themes", "GET")).body.flagships.find((f) => f.slug === "volt").update, null, "no update now:");
});

// =====================================================================================
console.log("— onboarding Brand step");
// =====================================================================================
await t("Brand step GET lists the five themes; a theme pick (Harvest + Forest) writes drafts only; Skip writes none", async () => {
  const g = await call("owner", "brand-step", "GET");
  eq(g.status, 200, g.text.slice(0, 200));
  eq(g.body.themes.map((x) => x.slug).join(","), "volt,bloom,loom,harvest,haven", "themes:");
  const live = await storeHtml(a);
  const rev = (await design()).revision;
  const r = await call("staff", "brand-step", "POST", { body: { themeId: "harvest", paletteId: "forest", revision: rev } });
  eq(r.status, 200, r.text.slice(0, 300));
  const d = await design();
  eq(d.body.settings.theme.package, HARVEST_ID, "package:");
  const forest = PAL.paletteById("forest").brand;
  eq(`${d.body.settings.brand.accent} ${d.body.settings.brand.background} ${d.body.settings.brand.heading_font} ${d.body.settings.brand.button_shape}`, `${forest.accent} ${forest.background} serif rounded`, "Forest colours on Harvest's shapes and serif:");
  ok(r.body.layouts.includes("doc_collection_layout"), `layout drafts: ${r.body.layouts}`);
  eq(r.body.brandStep.themeId, "harvest", "recorded:");
  eq(await storeHtml(a), live, "nothing live:");
  const again = await call("owner", "brand-step", "GET");
  eq(`${again.body.current.themeId} ${again.body.current.paletteId}`, "harvest forest", "current:");
  ok(again.body.themeLayouts.includes("doc_collection_layout"), "Open Store lists the layout drafts");
  const before = (await design()).revision;
  const sk = await call("owner", "brand-step", "POST", { body: { skip: true } });
  eq(sk.status, 200, sk.text.slice(0, 200));
  eq((await design()).revision, before, "Skip writes no document:");
  eq((await call("support", "brand-step", "POST", { body: { themeId: "bloom", paletteId: null } })).status, 403, "support:");
  eq((await call("owner", "brand-step", "POST", { body: { themeId: "comic", paletteId: null } })).status, 400, "unknown theme:");
});

await t("Theme's colours: paletteId null with a theme keeps the theme's own colours; Keep the simple look takes the package off", async () => {
  const r = await call("owner", "brand-step", "POST", { body: { themeId: "haven", paletteId: null, revision: (await design()).revision } });
  eq(r.status, 200, r.text.slice(0, 300));
  eq((await design()).body.settings.brand.accent, FS.latestFlagship("haven").tokens.accent, "theme's accent:");
  const s = await call("owner", "brand-step", "POST", { body: { themeId: null, paletteId: "slate", revision: (await design()).revision } });
  eq(s.status, 200, s.text.slice(0, 300));
  ok(!(await design()).body.settings.theme.package, "no package:");
  eq((await call("owner", "brand-step", "POST", { body: { paletteId: null } })).status, 400, "no palette and no theme:");
});

await t("no network", () => eq(network.calls?.length ?? 0, 0, "no network:"));

await store.cleanup().catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
