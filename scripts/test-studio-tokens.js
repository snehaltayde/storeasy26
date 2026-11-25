// Phase 6 line 2 (docs/plans/phase-6.md "Line 2"): the studio's Design tab.
//   1. tokensModel: only validateBrand's values are set and posted
//   2. the frame's storeasy:tokens handler draws validateBrand's output only:
//      a bad hex, extra keys, a sender that isn't the parent and ok:false do
//      nothing; the CSS equals the layout's brandCssVars (same kit, surfaces)
//   3. Reset targets: an uploaded theme's tokens (getPackage `tokens`, what
//      an apply writes), a built-in look's starting brand
//   4. readability: founder colours and package surfaces block, each with
//      its "Use <colour>" fix where there is one
//   5. undo: model.onStep hands doc_design's steps to the Design tab's store
//   6. roles: support and operator support get no enabled input, no Reset,
//      no fix; staff draft
//   7. the anonymous shopper's live HTML is unchanged by a draft token save,
//      and themeState gives the live brand the check compares with
//   8. no node:* import reachable from app/(storefront)/layout.js
// Run: node scripts/test-studio-tokens.js
import { fontModule } from "./support/font-stub.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

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
process.env.DATABASE_URL = "file:.test-sttokens-default.db";
process.env.PLATFORM_SECRET = "test-sttokens-platform-secret";
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
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${m} expected ${w}, got ${g}`);
};

const T = await import("../components/admin/studio/tokensModel.js");
const M = await import("../components/admin/studio/studioModel.js");
const Bridge = await import("../components/preview/bridge-core.js");
const { tokensCss } = await import("../components/preview/tokens-css.js");
const B = await import("../lib/brand.js");
const { KITS } = await import("../lib/themes/kits.js");
const { paletteById, DEFAULT_PALETTE_ID } = await import("../lib/themes/palettes.js");
const AURORA = JSON.parse(await readFile(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8"));
const GOOD = { accent: "#4f46e5", background: "#ffffff", foreground: "#111111", radius: "lg", type_scale: "large", button_shape: "square", section_spacing: "airy" };
const PKG_THEME = { kit: AURORA.base, version: 1, package: "thm_a1a1a1a1a1a1a1a1" };

// ---- 1. tokensModel ------------------------------------------------------------------
console.log("— tokensModel");
await t("setToken takes only validateBrand's choices: a step outside its options, an unknown key, a non-string colour leave the brand as it was; accent_label follows the accent", () => {
  const b = T.setToken(GOOD, "accent", "#1D4ED8");
  eq(b.accent, "#1d4ed8", "lower-cased:");
  eq(b.accent_label, B.validateBrand(b).value.accent_label, "accent_label worked out:");
  for (const [k, v] of [["radius", "huge"], ["type_scale", "tiny"], ["section_spacing", "0px"], ["button_shape", "blob"], ["css", "body{}"], ["accent", 7]]) eq(T.setToken(GOOD, k, v), GOOD, `${k}=${v}:`);
  eq(T.setToken(GOOD, "type_scale", "compact").type_scale, "compact");
  eq(T.setToken(GOOD, "section_spacing", "compact").section_spacing, "compact");
  // a store with no brand starts from its starting brand, never the lime default
  const start = paletteById("ocean")?.brand || paletteById(DEFAULT_PALETTE_ID).brand;
  const first = T.setToken(null, "radius", "sm", start);
  eq(first.accent, start.accent, "first edit starts from the starting brand:");
  eq(T.setToken(null, "radius", "sm").accent, paletteById(DEFAULT_PALETTE_ID).brand.accent, "no starting brand: slate:");
});

await t("tokensMessage posts validateBrand's value only: extra keys dropped, a half-typed or hostile colour is no message", () => {
  const m = T.tokensMessage({ ...GOOD, evil: "}body{display:none" });
  eq(m.type, "storeasy:tokens");
  eq(m.brand, B.validateBrand(GOOD).value, "validated value:");
  ok(!("evil" in m.brand), "extra key dropped");
  for (const bad of [{ accent: "red;}body{" }, { ...GOOD, accent: "#12" }, { ...GOOD, radius: "huge" }, null, "x", ["#ffffff"]]) eq(T.tokensMessage(bad), null, `${JSON.stringify(bad)}:`);
});

// ---- 2. the frame's handler --------------------------------------------------------------
console.log("— the frame");
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.text = null;
    this.classList = { add() {}, remove() {}, contains: () => false };
  }
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
  }
  getAttribute(n) {
    return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null;
  }
  get textContent() {
    return this.text ?? "";
  }
  set textContent(v) {
    this.text = String(v);
  }
  insertAdjacentElement(_where, el) {
    const kids = this.parentElement.children;
    el.parentElement = this.parentElement;
    kids.splice(kids.indexOf(this) + 1, 0, el);
    return el;
  }
}
function frame({ ok: okay = true, look = { kit: "pulse-1", surfaces: null } } = {}) {
  const head = new El("head");
  const vars = head.appendChild(new El("style", { id: "brand-vars" }));
  vars.textContent = ":root{--accent-500:#334155;}";
  const body = new El("body");
  const html = new El("html");
  const all = () => [...head.children, ...body.children];
  const document = {
    head,
    body,
    documentElement: html,
    createElement: (tag) => new El(tag),
    getElementById: (id) => all().find((e) => e.attrs.id === id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const toParent = [];
  const parent = { postMessage: (msg) => toParent.push(msg) };
  const stranger = { postMessage() {} };
  let onMessage = null;
  const window = {
    parent,
    location: { origin: "http://roles.localhost:3018", pathname: "/" },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: (type, fn) => type === "message" && (onMessage = fn),
    removeEventListener() {},
  };
  const stop = Bridge.createBridge({ window, document, state: null, ok: okay, css: "x", tokensCss: (b) => tokensCss(b, look) });
  const send = (data, source = parent, origin = window.location.origin) => onMessage?.({ data, source, origin });
  send({ type: "storeasy:editor:hello", v: 2 });
  const draft = () => document.getElementById(Bridge.DRAFT_STYLE_ID)?.textContent ?? null;
  return { send, draft, stranger, stop, vars, toParent };
}

await t("tokens handler: draws only validateBrand's output; ignores \"accent\":\"red;}body{\", extra keys, a sender that isn't the parent and ok:false", () => {
  const look = { kit: AURORA.kit || "pulse-1", surfaces: AURORA.surfaces };
  const f = frame({ look });
  f.send(T.tokensMessage(GOOD));
  const drawn = f.draft();
  eq(drawn, B.brandCssVars(B.resolveBrand(GOOD), { kit: look.kit, surfaces: look.surfaces }), "the layout's CSS:");
  f.send({ type: "storeasy:tokens", brand: { accent: "red;}body{" } });
  eq(f.draft(), drawn, "hostile accent ignored:");
  f.send({ type: "storeasy:tokens", brand: { ...GOOD, accent: "#1d4ed8", evil: "}body{display:none" } });
  ok(f.draft() !== drawn && !f.draft().includes("display:none") && !f.draft().includes("evil"), "extra key dropped, the rest drawn");
  const kept = f.draft();
  f.send({ type: "storeasy:tokens", brand: { ...GOOD, accent: "#e11d48" } }, f.stranger);
  eq(f.draft(), kept, "not the parent:");
  f.send({ type: "storeasy:tokens", brand: { ...GOOD, accent: "#e11d48" } }, undefined, "http://evil.test");
  eq(f.draft(), kept, "another origin:");
  f.send({ type: "storeasy:tokens", brand: null });
  eq(f.draft(), null, "null clears:");
  eq(f.vars.textContent, ":root{--accent-500:#334155;}", "#brand-vars untouched:");
  f.stop();
  const shut = frame({ ok: false });
  shut.send(T.tokensMessage(GOOD));
  eq(shut.draft(), null, "ok:false draws nothing:");
  shut.stop();
});

await t("the posted CSS equals the layout's brandCssVars for the same brand, kit and surfaces (Aurora's surfaces and the built-in looks); the layout hands the frame that kit and surfaces", async () => {
  for (const look of [{ kit: "pulse-1", surfaces: AURORA.surfaces }, { kit: "pulse-1", surfaces: null }, { kit: "glow-1", surfaces: null }]) {
    for (const brand of [GOOD, T.setToken(GOOD, "foreground", "#222222"), AURORA.tokens]) {
      eq(tokensCss(T.tokensMessage(brand).brand, look), B.brandCssVars(B.resolveBrand(brand), look), `${look.kit} ${look.surfaces ? "with" : "without"} surfaces:`);
    }
  }
  // every token is a CSS variable, so the instant path covers all of them
  const css = tokensCss(T.tokensMessage(GOOD).brand, { kit: "pulse-1" });
  for (const v of ["--accent-500:", "--background:", "--foreground:", "--brand-radius:1rem", "--type-scale:1.08", "--btn-radius:0.25rem", "--section-pad-y:5rem"]) ok(css.includes(v), v);
  const layout = await readFile(join(ROOT, "app/(storefront)/layout.js"), "utf8");
  ok(layout.includes("look: { kit, surfaces: pkg?.surfaces ?? null }") && layout.includes("look={chrome.look ?? null}"), "the layout hands the bridge look = {kit, surfaces} (the same it draws #brand-vars with)");
});

// ---- 3. Reset targets -----------------------------------------------------------------------
console.log("— Reset");
await t("Reset: an uploaded theme goes back to its tokens (the base kit's under the package's, what an apply with its brand writes); a built-in look to the starting brand, else slate", () => {
  const pkgTokens = { ...KITS[AURORA.base].brand, ...AURORA.tokens };
  eq(T.resetTarget({ theme: PKG_THEME, packageTokens: pkgTokens, startingBrand: GOOD }), pkgTokens, "package:");
  eq(T.resetTarget({ theme: { kit: "pulse", version: 1 }, packageTokens: pkgTokens, startingBrand: GOOD }), GOOD, "built-in look: the starting brand:");
  eq(T.resetTarget({ theme: null, startingBrand: null }), paletteById(DEFAULT_PALETTE_ID).brand, "no starting brand: slate:");
  eq(T.resetTarget({ theme: PKG_THEME, packageTokens: { accent: "nope" }, startingBrand: GOOD }), GOOD, "unreadable package tokens: the starting brand:");
  eq(T.resetWords({ packageName: "Aurora" }), "Reset to the theme's");
  eq(T.resetWords({}), "Go back to your starting colours");
  eq(T.themeWords("Aurora", "1.2.0"), "Theme: Aurora 1.2.0. Your colours, type and spacing go on top of it.");
  ok(T.sameTokens(pkgTokens, { ...pkgTokens, accent_label: "#ffffff" }), "accent_label isn't a choice");
  ok(!T.sameTokens(pkgTokens, { ...pkgTokens, radius: "sm" }), "a changed token is not the same");
});

// ---- 4. readability ----------------------------------------------------------------------------
console.log("— readability");
await t("checkBrand in the rail: a low-contrast text colour blocks with a \"Use <colour>\" fix that makes it readable; a package's surfaces block on their own (no fix: the theme's look); the live store's own pair only warns", () => {
  const low = { ...GOOD, foreground: "#dddddd" };
  const r = T.readability(low, { theme: { kit: "pulse", version: 1 } });
  ok(r.blocking, "blocks");
  const item = r.items.find((i) => i.severity === "error");
  ok(item && /contrast/.test(item.message), "plain words");
  eq(item.fix?.token, "foreground");
  eq(item.fix.words, `Use ${item.fix.value}`);
  const fixed = T.applyFix(low, item.fix);
  ok(!T.readability(fixed, { theme: { kit: "pulse", version: 1 } }).blocking, "the fix makes it readable");
  // the same colours already live: a warning, not a blocker
  const live = T.readability(low, { theme: { kit: "pulse", version: 1 }, live: low, liveTheme: { kit: "pulse", version: 1 } });
  ok(!live.blocking && live.items.some((i) => i.severity === "warning"), "live already shows it: warning");
  // an uploaded theme's header surface that can't be read blocks only with its surfaces
  const bad = { ...AURORA.surfaces, header: { bg: "#ffffff", fg: "#f1f5f9", muted: "#e2e8f0" } };
  const withPkg = T.readability(GOOD, { theme: PKG_THEME, surfaces: bad });
  ok(withPkg.blocking, "package surfaces block");
  ok(withPkg.items.some((i) => i.severity === "error" && i.fix === null), "no colour fix for the theme's own surface");
  ok(!T.readability(GOOD, { theme: { kit: "pulse", version: 1 }, surfaces: bad }).blocking, "surfaces only count for a design naming a package");
  ok(!T.readability(GOOD, { theme: PKG_THEME, surfaces: AURORA.surfaces }).blocking, "Aurora with a good brand is readable");
  eq(T.readability({ accent: "nope" }).checked, false, "a malformed brand isn't checked here (its field says so)");
});

// ---- 5. undo --------------------------------------------------------------------------------------
console.log("— undo");
await t("undo/redo: model.onStep hands doc_design's steps to its own store's applier (undo writes before, redo after); other documents' steps don't reach it", () => {
  const model = M.createStudioModel();
  const seen = [];
  const off = model.onStep(T.DESIGN_DOC, (step, dir) => seen.push([dir, T.brandOf(dir === "undo" ? step.before : step.after)?.accent]));
  const b0 = T.withBrand({ type: "design", settings: { theme: null } }, GOOD);
  const b1 = T.withBrand(b0, T.setToken(GOOD, "accent", "#e11d48"));
  ok(model.record({ docId: T.DESIGN_DOC, before: b0, after: b1 }), "recorded");
  ok(model.isTouched(T.DESIGN_DOC), "touched (Publish pre-ticks it; showDesign on)");
  model.record({ docId: "doc_home", before: { a: 1 }, after: { a: 2 } });
  eq(model.undo().docId, "doc_home", "home step:");
  eq(seen, [], "not handed to the design:");
  eq(model.undo().docId, T.DESIGN_DOC);
  eq(seen, [["undo", GOOD.accent]], "undo:");
  model.redo();
  eq(seen.at(-1), ["redo", "#e11d48"], "redo:");
  off();
  model.undo();
  eq(seen.length, 2, "unsubscribed:");
  eq(M.restoreOps(b1, b0), [{ path: "settings", value: b0.settings }], "the applier's restore ops:");
});

await t("source: a token change posts storeasy:tokens before the store saves, then records the undo step; Studio turns showDesign on when doc_design is touched", async () => {
  const src = await readFile(join(ROOT, "components/admin/studio/DesignRail.js"), "utf8");
  const studio = await readFile(join(ROOT, "components/admin/studio/Studio.js"), "utf8");
  const write = src.slice(src.indexOf("export function writeBrand("));
  ok(write.indexOf("s.studio.post(msg)") < write.indexOf('s.store.setField("settings.brand"') && write.indexOf('s.store.setField("settings.brand"') < write.indexOf("s.model.record"), "post, save, record");
  ok(studio.includes("if (model.handles(st.docId)) return;"), "Studio.js never writes a doc_design step itself");
  ok(src.includes("BrandColourInput") && src.includes("BrandStepSelect"), "the editor's own controls");
  ok(studio.includes('showDesign={history.touched.includes("doc_design")}'), "showDesign");
  const pane = await readFile(join(ROOT, "components/admin/editor/PreviewPane.js"), "utf8");
  ok(pane.includes("if (!showDesign || designRef.current) return;"), "PreviewPane turns it on once, without a reload");
});

await t("stepOps: an undo writes back only the keys its step changed (settings.brand), never the whole body, so a theme or logo changed since stays", () => {
  const b0 = { type: "design", settings: { brand: GOOD, theme: { kit: "pulse", version: 1 }, logo: null } };
  const b1 = T.withBrand(b0, T.setToken(GOOD, "accent", "#e11d48"));
  eq(T.stepOps({ before: b0, after: b1 }, "undo"), [{ path: "settings.brand", value: GOOD }]);
  eq(T.stepOps({ before: b0, after: b1 }, "redo"), [{ path: "settings.brand", value: b1.settings.brand }]);
  eq(T.stepOps({ before: { a: 1 }, after: { a: 2 } }, "undo"), [{ path: "a", value: 1 }], "a top-level key:");
  eq(T.stepOps({ before: b0, after: b0 }, "undo"), [], "no change:");
});

// ---- 6. roles ---------------------------------------------------------------------------------------
console.log("— roles");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (await swc.transform(await readFile(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
const nothingC = { __esModule: true, default: () => null };
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "next/navigation": { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/" },
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
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
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
const Rail = await loadJsx(join(ROOT, "components/admin/studio/DesignRail.js"));
const { roleAllows } = await import("../lib/platform/authz.js");
// what the studio page hands down (can.write = storefront.write); operator support is role support
const studioOf = (role) => {
  const write = roleAllows(role, "storefront.write");
  return { role, can: { write, publish: write && roleAllows(role, "storefront.publish") }, readOnly: !write };
};
const controls = (html) => [...html.matchAll(/<(input|select|button)\b[^>]*>/g)].map((m) => m[0]);
const railHtml = (studio, { body, look = null } = {}) =>
  renderToStaticMarkup(
    React.createElement(Rail.DesignRailView, {
      status: "ready",
      state: { id: T.DESIGN_DOC, body: body ?? T.withBrand({ type: "design", settings: { theme: { kit: "pulse", version: 1 } } }, { ...GOOD, foreground: "#dddddd" }), issues: [] },
      look,
      readOnly: Rail.designReadOnly(studio),
      startingBrand: GOOD,
    }),
  );

await t("roles: support and operator support see every value with no enabled token input, no Reset and no fix button; owner, admin and staff (who drafts) get enabled inputs, the fix and Reset", () => {
  for (const [name, studio] of [
    ["support", studioOf("support")],
    ["operator support", { ...studioOf("support"), role: "support" }],
    ["inconsistent can", { role: "support", can: { write: true }, readOnly: true }],
  ]) {
    const html = railHtml(studio);
    const c = controls(html);
    ok(c.filter((x) => /^<(input|select)/.test(x)).length >= 7, `${name}: the token inputs are there`);
    for (const x of c.filter((x) => /^<(input|select)/.test(x))) ok(/\sdisabled=""/.test(x), `${name}: enabled input ${x}`);
    ok(!html.includes("data-design-reset") && !html.includes("data-design-fix"), `${name}: no Reset, no fix`);
    ok(html.includes("#dddddd") && html.includes("data-design-readonly"), `${name}: the values and the read-only mark`);
  }
  for (const role of ["owner", "admin", "staff"]) {
    const html = railHtml(studioOf(role));
    const inputs = controls(html).filter((x) => /^<(input|select)/.test(x));
    ok(inputs.length >= 7 && inputs.every((x) => !/\sdisabled=""/.test(x)), `${role}: enabled inputs`);
    ok(html.includes('data-design-fix="foreground"') && html.includes('data-design-reset="start"') && html.includes('data-design-check="blocking"'), `${role}: fix, Reset, blocker`);
  }
  // an uploaded theme: its words, and Reset to the theme's once its tokens are read
  const body = T.withBrand({ type: "design", settings: { theme: PKG_THEME } }, GOOD);
  const look = { packageId: PKG_THEME.package, name: "Aurora", version: "1.2.0", surfaces: AURORA.surfaces, tokens: { ...KITS.pulse.brand, ...AURORA.tokens } };
  const pkg = railHtml(studioOf("owner"), { body, look });
  ok(pkg.includes("Theme: Aurora 1.2.0. Your colours, type and spacing go on top of it."), "theme words");
  ok(pkg.includes('data-design-reset="theme"') && pkg.includes("Reset to the theme&#x27;s"), "Reset to the theme's");
  ok(!railHtml(studioOf("owner"), { body, look: { ...look, tokens: null } }).includes("data-design-reset"), "no Reset before the theme's tokens are read");
  ok(!railHtml(studioOf("support"), { body, look }).includes("data-design-reset"), "support: no Reset");
});

// ---- 6b. one doc_design store, its 409, the reload race ------------------------------
console.log("— the design store");
const St = await import("../components/admin/editor/store.js");
const designDoc = (brand = GOOD, revision = 1) => ({ id: T.DESIGN_DOC, type: "design", label: "Design", body: { type: "design", settings: { brand, theme: { kit: "pulse", version: 1 }, logo: null } }, revision, draftHash: `h_${revision}` });
function fakeApi({ conflict = false } = {}) {
  const calls = [];
  let doc = designDoc();
  return {
    calls,
    async call(op, args, extra) {
      calls.push([op, args, extra]);
      if (op === "getDocument") return args === T.DESIGN_DOC ? { ok: true, data: { document: doc } } : { ok: true, data: { document: { id: args, type: "home", body: { type: "home", sections: [] }, revision: 1, draftHash: "h" } } };
      if (op === "saveDraft") {
        if (conflict) return { conflict: true, code: "DOCUMENT_CHANGED", message: "changed", current: { ...doc, revision: doc.revision + 5, draftHash: "h_other", updatedByName: "Asha" } };
        doc = { ...doc, body: args.body, revision: doc.revision + 1, draftHash: `h_${doc.revision + 1}` };
        return { ok: true, data: { document: doc } };
      }
      return { ok: true, data: {} };
    },
    sendKeepalive: () => false,
  };
}
const storeOf = (api, document) => St.createDocumentStore({ api, document, tenant: "t", storage: null, readOnly: false });
const writer = (api, extra = {}) => ({ api, model: M.createStudioModel(), can: { write: true, publish: true }, readOnly: false, role: "owner", store: null, state: null, post: () => true, ...extra });
const noFetch = async () => null;

await t("one store: opening ?doc=doc_design before the studio has loaded waits, then shares the studio's store (no second getDocument); an own store is dropped when the studio opens doc_design", async () => {
  const api = fakeApi();
  const studio = writer(api);
  const s = Rail.sessionFor(studio, { fetchJson: noFetch });
  eq(Rail.syncDesign(s, studio), undefined);
  eq(api.calls.length, 0, "nothing asked before the studio loads:");
  eq(s.store, null);
  const shared = storeOf(api, designDoc());
  const loaded = { ...studio, store: shared, state: shared.getState() };
  Rail.sessionFor(loaded);
  Rail.syncDesign(s, loaded);
  ok(s.store === shared && s.shared, "the studio's store is shared");
  eq(api.calls.filter((c) => c[0] === "getDocument").length, 0, "no second doc_design store:");
  ok(Rail.writeBrand(s, T.setToken(GOOD, "accent", "#e11d48")), "written");
  eq(T.brandOf(shared.getState().body).accent, "#e11d48", "on the shared store:");
  Rail.closeSession(s);
  shared.dispose();

  // the other way round: an own store first, then the studio opens doc_design
  const api2 = fakeApi();
  const home = storeOf(api2, { id: "doc_home", type: "home", body: { type: "home", sections: [] }, revision: 1, draftHash: "h" });
  const st2 = writer(api2, { store: home, state: home.getState() });
  const s2 = Rail.sessionFor(st2, { fetchJson: noFetch });
  await Rail.syncDesign(s2, st2);
  const own = s2.store;
  ok(own && !s2.shared, "an own store while the studio shows home");
  let disposed = false;
  const dispose = own.dispose;
  own.dispose = () => ((disposed = true), dispose());
  const shared2 = storeOf(api2, designDoc());
  const st3 = { ...st2, store: shared2, state: shared2.getState() };
  Rail.sessionFor(st3);
  Rail.syncDesign(s2, st3);
  ok(s2.store === shared2 && s2.shared, "switched to the studio's store");
  await new Promise((r) => setTimeout(r, 0));
  ok(disposed, "the own store was flushed and disposed");
  Rail.closeSession(s2);
  home.dispose();
  shared2.dispose();
});

await t("a disposed shared store is never edited: once the studio moves on, a write is refused until an own store is open, and undo doesn't reach the old one", async () => {
  const api = fakeApi();
  const shared = storeOf(api, designDoc());
  const studio = writer(api, { store: shared, state: shared.getState() });
  const s = Rail.sessionFor(studio, { fetchJson: noFetch });
  Rail.syncDesign(s, studio);
  ok(Rail.writeBrand(s, T.setToken(GOOD, "accent", "#e11d48")), "first write on the shared store");
  // the studio opens home: it disposes the design store and has a new one
  shared.dispose();
  let edits = 0;
  const setField = shared.setField;
  shared.setField = (...a) => (edits++, setField(...a));
  const home = storeOf(api, { id: "doc_home", type: "home", body: { type: "home", sections: [] }, revision: 1, draftHash: "h" });
  const moved = { ...studio, store: home, state: home.getState() };
  Rail.sessionFor(moved); // render: the session sees the new studio store
  eq(Rail.writeBrand(s, T.setToken(GOOD, "accent", "#16a34a")), false, "refused before the sync:");
  studio.model.undo();
  eq(edits, 0, "neither the write nor the undo touched the disposed store:");
  await Rail.syncDesign(s, moved);
  ok(s.store && s.store !== shared && !s.shared, "an own store now");
  ok(Rail.writeBrand(s, T.setToken(GOOD, "accent", "#16a34a")), "writes go to it");
  eq(edits, 0, "still none on the old one:");
  // the studio closes: the applier goes and the own store is disposed
  const own = s.store;
  let gone = false;
  const dispose = own.dispose;
  own.dispose = () => ((gone = true), dispose());
  studio.model.close();
  ok(!studio.model.handles(T.DESIGN_DOC) && s.store === null, "closed: no applier, no store");
  await new Promise((r) => setTimeout(r, 0));
  ok(gone, "the own store was flushed, then disposed");
  home.dispose();
});

await t("a 409 on the design store shows in the rail (Load theirs / Keep mine)", async () => {
  const api = fakeApi({ conflict: true });
  const home = storeOf(api, { id: "doc_home", type: "home", body: { type: "home", sections: [] }, revision: 1, draftHash: "h" });
  const studio = writer(api, { store: home, state: home.getState() });
  const s = Rail.sessionFor(studio, { fetchJson: noFetch });
  await Rail.syncDesign(s, studio);
  Rail.writeBrand(s, T.setToken(GOOD, "accent", "#e11d48"));
  await s.store.flush();
  ok(s.store.getState().conflict, "the store is in conflict");
  const html = renderToStaticMarkup(React.createElement(Rail.default, { studio }));
  ok(html.includes("data-design-save") && html.includes("data-conflict-banner"), "the conflict banner is in the rail");
  ok(/Keep mine/.test(html), "Keep mine offered");
  Rail.closeSession(s);
  home.dispose();
});

await t("reload race: a section save reloads the frame within 700 ms of an accent change, before the design save; the new frame's ready gets the accent again, so it is still drawn", async () => {
  const api = fakeApi();
  const home = storeOf(api, { id: "doc_home", type: "home", body: { type: "home", sections: [] }, revision: 1, draftHash: "h" });
  let current = frame();
  const studio = writer(api, { store: home, state: home.getState(), post: (msg) => (current.send(msg), true) });
  const s = Rail.sessionFor(studio, { fetchJson: noFetch });
  await Rail.syncDesign(s, studio);
  const accent = T.setToken(GOOD, "accent", "#e11d48");
  Rail.writeBrand(s, accent);
  const want = tokensCss(T.tokensMessage(accent).brand, { kit: "pulse-1", surfaces: null });
  eq(current.draft(), want, "drawn at once:");
  eq(api.calls.filter((c) => c[0] === "saveDraft").length, 0, "the design save hasn't gone (700 ms pause):");
  // the home save's ack reloads the frame: a fresh page, no draft style
  current.stop();
  current = frame();
  eq(current.draft(), null, "the reloaded frame has no draft yet:");
  const ready = current.toParent.find((m) => m?.type === "storeasy:ready" && m.v === 2);
  ok(ready, "the reloaded frame says ready (v2)");
  ok(Rail.frameMessage(s, ready), "the rail posts the tokens again");
  eq(current.draft(), want, "still drawn:");
  eq(Rail.frameMessage(s, { type: "storeasy:ready", v: 2, ok: false }), false, "a frame that isn't ok gets nothing:");
  current.stop();
  Rail.closeSession(s);
  home.dispose();
});

// ---- 7. the store: getPackage tokens, themeState's live brand, the shopper's HTML -------------------
console.log("— the store");
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("sttokens");
await F.makePlatform({ name: "sttokens" });
const tn = await F.makeTenant({ name: "sttokens-a", mode: "documents", products: 1 });
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const R = await import("../lib/registry/index.js");
const Pk = await import("../lib/themes/packages.js");
const { runRequest } = await import("./support/request-cache.js");
const { prerenderToNodeStream } = require("react-dom/static");
const ACTOR = { kind: "merchant", id: "usr_sttokens" };
{
  const c = tn.client();
  const text = JSON.stringify(AURORA);
  await c.execute({
    sql: "INSERT INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?)",
    args: [PKG_THEME.package, AURORA.id, AURORA.version, AURORA.name, "Storeasy Studio", "", AURORA.base, text, "0".repeat(64), text.length, ACTOR.id, new Date().toISOString()],
  });
  c.close();
}
const LIVE = { ...GOOD };
await tn.run(async () => {
  const body = R.emptyBody("design");
  body.settings = { ...(body.settings || {}), theme: { kit: "pulse", version: 1 }, brand: LIVE };
  await Docs.createDocument({ type: "design", body, actor: ACTOR });
  const hb = R.emptyBody("home");
  const sec = R.newSection("text", { id: "sec_sttokens" });
  hb.sections = [{ ...sec, settings: { ...sec.settings, title: "Hello", body: ["Words."] } }];
  await Docs.createDocument({ type: "home", body: hb, actor: ACTOR });
  const d = await Docs.getDocument("doc_design");
  const h = await Docs.getDocument("doc_home");
  await Pub.publish({ ids: [d, h].map((x) => ({ id: x.id, revision: x.revision, draftHash: x.draftHash })), actor: ACTOR });
});
const Layout = (await loadJsx(join(ROOT, "app/(storefront)/layout.js"))).default;
async function shopperHtml() {
  globalThis.__readRequest = { host: tn.tenant.domains[0], cookies: {} };
  try {
    return await runRequest(async () => {
      const el = await Layout({ children: React.createElement("main", null, "page") });
      const { prelude } = await prerenderToNodeStream(el);
      let out = "";
      for await (const chunk of prelude) out += chunk;
      return out;
    });
  } finally {
    globalThis.__readRequest = null;
  }
}

await t("getPackage answers the theme's Reset tokens (base kit's under the package's, as applyPackage writes them); themeState gives the live brand and theme", async () => {
  const got = await tn.run(() => Pk.getPackage(PKG_THEME.package));
  eq(got.tokens, { ...KITS[AURORA.base].brand, ...AURORA.tokens }, "tokens:");
  eq(got.package.name, "Aurora");
  const st = await tn.run(() => Pk.themeState());
  ok(T.sameTokens(st.liveBrand, LIVE), "live brand:");
  eq(st.liveTheme, { kit: "pulse", version: 1 }, "live theme:");
});

await t("the anonymous shopper's live HTML is the same after a draft token save (accent, type, spacing)", async () => {
  const before = await shopperHtml();
  ok(before.includes(B.accentShades(LIVE.accent)[500]), "the live accent is drawn");
  await tn.run(async () => {
    const d = await Docs.getDocument("doc_design");
    const brand = T.setToken(T.setToken(T.setToken(T.brandOf(d.body), "accent", "#e11d48"), "type_scale", "compact"), "section_spacing", "compact");
    await Docs.saveDraft({ id: "doc_design", revision: d.revision, body: T.withBrand(d.body, brand), actor: ACTOR });
    eq(T.brandOf((await Docs.getDocument("doc_design")).body).accent, "#e11d48", "the draft holds the change:");
  });
  const after = await shopperHtml();
  eq(after, before, "same HTML:");
  ok(!after.includes(B.accentShades("#e11d48")[500]), "the draft accent isn't drawn");
});

// ---- 8. edge safety ---------------------------------------------------------------------------------
console.log("— edge");
await t("no node:* import reachable from app/(storefront)/layout.js (tenant-context's async_hooks, which the edge runtime has, is the only Node module); tokens-css.js is reached", async () => {
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
  ok(reached.has("components/preview/tokens-css.js"), "tokens-css.js reached");
  eq([...hits], ["lib/tenant-context.js: node:async_hooks"], "node imports reached:");
});

// ---- Phase 7 line 1: the heading font -------------------------------------------------
await t("heading font: Sans / Serif / Theme's in the Type group; serif posts a tokens message whose CSS sets Fraunces; Theme's takes the key away; support's control is disabled", () => {
  const serif = T.setToken(GOOD, "heading_font", "serif", GOOD);
  eq(serif.heading_font, "serif", "serif:");
  const msg = T.tokensMessage(serif);
  eq(msg.brand.heading_font, "serif", "posted:");
  ok(tokensCss(msg.brand, { kit: "pulse-1" }).includes(":root[data-kit]{--display-font:var(--font-fraunces), Georgia, serif;}"), "the frame's CSS");
  ok(!("heading_font" in T.setToken(serif, "heading_font", "theme", GOOD)), "Theme's: the key is gone");
  eq(T.setToken(serif, "heading_font", "comic", GOOD), serif, "comic: unchanged");
  ok(!tokensCss(GOOD, { kit: "pulse-1" }).includes("--display-font"), "no token, no heading CSS");
  ok(T.TOKEN_GROUPS.find((g) => g.id === "type").keys.includes("heading_font"), "in the Type group");
  ok(!T.sameTokens(serif, GOOD), "a font change is a change (Reset shows)");
  const html = railHtml(studioOf("owner"), { body: T.withBrand({ type: "design", settings: { theme: { kit: "pulse", version: 1 } } }, serif) });
  ok(/<select[^>]*id="studio-design-heading_font"/.test(html) && html.includes(">Theme&#x27;s</option>") && html.includes(">Serif</option>"), "the control");
  ok(/<option value="serif" selected="">/.test(html), "serif selected");
  const ro = railHtml(studioOf("support"));
  ok(/<select[^>]*id="studio-design-heading_font"[^>]*disabled=""|<select[^>]*disabled=""[^>]*id="studio-design-heading_font"/.test(ro), "support: disabled");
});

await t("heading font Reset: a flagship's Reset goes back to the theme's heading font", () => {
  const tokens = { ...KITS.pulse.brand, ...AURORA.tokens, heading_font: "serif" };
  const target = T.resetTarget({ theme: PKG_THEME, packageTokens: tokens, startingBrand: GOOD });
  eq(target.heading_font, "serif", "reset target:");
});

await F.removeFixtureFiles("sttokens");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
