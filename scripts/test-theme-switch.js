// Phase 5 line 3 (docs/plans/phase-5.md "Line 3"): an admin switches between
// installed themes, with a preview before publishing.
//   pnpm test:theme-switch
// A role store (scripts/support/route-harness.js: store A with every role,
// store B a canary) on throwaway file databases. The real routes are called
// as each caller; the real storefront layout (app/(storefront)/layout.js,
// compiled with Next's SWC as test-theme-render does) is rendered as the
// anonymous shopper and through a preview session:
//   · roles: apply (storefront.write) owner/admin/staff 200, support and the
//     operator 403, signed out and store B's owner 401; publish
//     (storefront.publish) staff and support 403
//   · apply writes drafts only: the anonymous HTML is byte-identical; the
//     preview session (showDesign on) shows the theme; badges and state
//   · publish (documents publishSet): release, publish_log and audit; the
//     control-plane theme_pin carries package, slug and version; the theme's
//     templates take effect; the operator view lists the uploaded theme
//   · a built-in look clears package and the theme's layouts; revision 409;
//     home layout needs a confirm; colours on by default; audit themes.apply
//   · an archived package blocks publish in plain words; rollback (undo)
//     renders the older package; the kill switch refuses apply
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
process.env.DATABASE_URL = "file:.test-theme-switch-default.db";
process.env.PLATFORM_SECRET = "test-theme-switch-platform-secret";
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

const store = await H.makeRoleStore({ name: "thswitch" });
const { a, b, call } = store;
const { roleAllows } = await import("../lib/platform/authz.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { getTenant } = await import("../lib/platform/control.js");
const FLAGS = await import("../lib/platform/flags.js");
const LP = await import("../lib/themes/live-package.js");
const Kits = await import("../lib/themes/kits.js");
const Res = await import("../lib/content/resolve.js");
const Docs = await import("../lib/documents/service.js");
const R = await import("../lib/registry/index.js");

const AURORA_TEXT = await readFile(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8");
const AURORA = JSON.parse(AURORA_TEXT);
const BOREAL = { ...AURORA, id: "boreal", name: "Boreal", version: "2.0.0", templates: { ...AURORA.templates, header: "standard", footer: "columns" } };
const PKG = "thm_5a5a5a5a5a5a5a5a";
const PKG2 = "thm_5b5b5b5b5b5b5b5b";
const PKG_GONE = "thm_5c5c5c5c5c5c5c5c";
const B_PKG = "thm_5d5d5d5d5d5d5d5d";

async function insertPackage(tn, { id, pkg = AURORA, status = "installed" }) {
  const c = tn.client();
  try {
    const text = JSON.stringify(pkg);
    await c.execute({
      sql: "INSERT INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, pkg.id, pkg.version, pkg.name, "Storeasy Studio", "", pkg.base, text, "0".repeat(64), text.length, status, "merchant:test", new Date().toISOString()],
    });
  } finally {
    c.close();
  }
}
const sql = async (tn, s, args = []) => {
  const c = tn.client();
  try {
    return (await c.execute({ sql: s, args })).rows;
  } finally {
    c.close();
  }
};
await insertPackage(a, { id: PKG });
await insertPackage(a, { id: PKG2, pkg: BOREAL });
await insertPackage(a, { id: PKG_GONE, pkg: { ...AURORA, id: "gone", version: "0.1.0" } });
await insertPackage(b, { id: B_PKG, pkg: { ...AURORA, id: "bramble" } });

// store A opens with Pulse: a published design and home page
await a.run(async () => {
  const ACTOR = { kind: "merchant", id: store.users.owner.id };
  const hb = R.emptyBody("home");
  const sec = R.newSection("text", { id: "sec_thswitch1" });
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

// =====================================================================================
console.log("— roles");
// =====================================================================================
await t("matrix: apply is storefront.write (owner, admin, staff), publish is storefront.publish (owner, admin)", () => {
  eq(["owner", "admin", "staff", "support"].filter((r) => roleAllows(r, "storefront.write")).join(","), "owner,admin,staff", "write:");
  eq(["owner", "admin", "staff", "support"].filter((r) => roleAllows(r, "storefront.publish")).join(","), "owner,admin", "publish:");
});

let liveBefore = "";
await t("support and the operator get 403 on apply; signed out and store B's owner get 401; nothing is written", async () => {
  liveBefore = await storeHtml(a);
  const before = (await design()).revision;
  for (const [caller, status] of [["support", 403], ["operator-support", 403], ["operator-support-entry", 403], ["signed-out", 401], ["owner-b", 401]]) {
    eq((await apply(caller, PKG)).status, status, `${caller}:`);
  }
  eq((await design()).revision, before, "design revision:");
});

await t("a malformed apply is 400 before anything is read; an unknown or other store's theme is 404", async () => {
  eq((await apply("owner", PKG, { withBrand: "yes" })).status, 400, "bad flag:");
  const noRev = await apply("owner", PKG, { revision: undefined });
  eq(noRev.status, 400, "no revision while a design exists:");
  eq(noRev.body.code, "REVISION_REQUIRED", "code:");
  eq((await call("owner", "themes/[id]", "POST", { params: { id: PKG }, body: { apply: {}, archive: true } })).status, 400, "two ops:");
  eq((await apply("owner", "thm_0000000000000000")).status, 404, "unknown:");
  eq((await apply("owner", B_PKG)).status, 404, "store B's package:");
});

// =====================================================================================
console.log("— apply writes drafts only; preview shows them");
// =====================================================================================
await t("staff applies Aurora: a doc_design draft names the package, colours on by default, the theme's layouts in the surface drafts; audit themes.apply", async () => {
  const r = await apply("staff", PKG, { revision: (await design()).revision });
  eq(r.status, 200, `staff apply: ${JSON.stringify(r.body)}`);
  const d = await design();
  eq(d.body.settings.theme.package, PKG, "package:");
  eq(d.body.settings.theme.kit, "pulse", "kit:");
  eq(d.body.settings.theme.version, 1, "version:");
  ok(typeof d.body.settings.theme.applied_at === "string", "applied_at");
  eq(d.body.settings.brand.accent, AURORA.tokens.accent, "brand from tokens:");
  const layouts = await a.run(async () => Object.fromEntries(await Promise.all(["doc_header", "doc_footer", "doc_product_layout", "doc_collection_layout"].map(async (id) => [id, (await Docs.getDocument(id)).body.settings.template]))));
  eq(JSON.stringify(layouts), JSON.stringify({ doc_header: "centered", doc_footer: "minimal", doc_product_layout: "editorial", doc_collection_layout: "sidebar" }), "layout drafts:");
  const row = (await auditRows()).find((x) => x.action === "themes.apply");
  ok(row, "audit row");
  const diff = typeof row.diff === "string" ? JSON.parse(row.diff) : row.diff;
  eq(JSON.stringify([diff.package, diff.withBrand, diff.withHome]), JSON.stringify([PKG, true, false]), "audit diff:");
});

await t("apply leaves the anonymous live HTML unchanged (byte-identical)", async () => {
  eq(themeAttr(liveBefore), null, "Pulse live: no data-theme:");
  const after = await storeHtml(a);
  eq(after, liveBefore, "anonymous HTML:");
});

await t("the preview session (create, then showDesign on) shows the theme; the anonymous shopper still doesn't", async () => {
  const s = await call("owner", "preview-session", "POST", { body: { create: true } });
  eq(s.status, 200, "create:");
  const cookies = { [Res.PREVIEW_COOKIE]: s.body.token };
  eq((await call("owner", "preview-session", "POST", { body: { showDesign: { sid: s.body.sid, on: true } } })).status, 200, "showDesign:");
  const html = await storeHtml(a, cookies);
  eq(themeAttr(html), "aurora", "preview data-theme:");
  ok(html.includes("grid-cols-[1fr_auto_1fr]"), "the theme's centered header in the preview");
  eq(themeAttr(await storeHtml(a)), null, "anonymous:");
});

await t("state and badges: Aurora is 'In your draft', Pulse is live; the publish set is the design and the layout drafts", async () => {
  const r = await call("support", "themes", "GET");
  eq(r.status, 200, "support reads:");
  eq(JSON.stringify(r.body.state.live), JSON.stringify({ kit: "pulse", package: null }), "live:");
  eq(JSON.stringify(r.body.state.draft), JSON.stringify({ kit: "pulse", package: PKG }), "draft:");
  eq(r.body.packages.find((p) => p.id === PKG).inUse, "draft", "badge:");
  eq(r.body.state.publishSet.map((d) => d.id).sort().join(","), "doc_collection_layout,doc_design,doc_footer,doc_header,doc_product_layout", "publish set:");
  ok(r.body.state.publishSet.every((d) => d.suggested === true), "every layout draft only changed its template: suggested");
  eq(r.body.state.liveArchived, false, "liveArchived:");
});

await t("revision concurrency: a stale revision is 409 'Someone else changed your design just now'", async () => {
  const r = await apply("owner", PKG, { revision: (await design()).revision - 1 });
  eq(r.status, 409, "stale:");
  eq(r.body.code, "DESIGN_CHANGED", "code:");
  ok(/Someone else changed your design just now/.test(r.body.error), r.body.error);
});

// =====================================================================================
console.log("— publish");
// =====================================================================================
await t("staff and support get 403 on publish; nothing goes live", async () => {
  for (const caller of ["staff", "support"]) eq((await publishSet(caller)).status, 403, `${caller}:`);
  eq(themeAttr(await storeHtml(a)), null, "still Pulse:");
});

let auroraLog = null;
await t("owner publishes: the shopper sees Aurora with its layouts; release, publish_log and audit; theme_pin carries package, slug and version", async () => {
  const r = await publishSet("owner");
  eq(r.status, 200, `publish: ${JSON.stringify(r.body).slice(0, 300)}`);
  const html = await storeHtml(a);
  eq(themeAttr(html), "aurora", "anonymous data-theme:");
  ok(html.includes("grid-cols-[1fr_auto_1fr]"), "the centered header");
  const logs = await sql(a, "SELECT id, release_id, created_at, actor FROM publish_log WHERE document_id = 'doc_design' AND action = 'publish' ORDER BY rowid DESC LIMIT 1");
  auroraLog = String(logs[0].id);
  ok(logs[0].release_id, "publish_log names the release");
  eq((await sql(a, "SELECT COUNT(*) AS n FROM releases WHERE id = ?", [logs[0].release_id]))[0].n, 1, "the release:");
  ok((await auditRows()).some((x) => /publish/.test(String(x.action))), "a publish audit row");
  const pin = (await getTenant(a.id, { fresh: true })).config.theme_pin;
  eq(JSON.stringify([pin.kit, pin.version, pin.package, pin.slug, pin.package_version, pin.package_name]), JSON.stringify(["pulse", 1, PKG, "aurora", "1.2.0", "Aurora"]), "pin:");
  eq(Kits.themePinOf((await getTenant(a.id)).config).package, PKG, "kits.themePinOf:");
});

await t("the Live badge; the operator's themes view shows the uploaded theme per store", async () => {
  eq((await call("owner", "themes", "GET")).body.packages.find((p) => p.id === PKG).inUse, "live", "badge:");
  const route = await import("../app/api/platform/themes/route.js");
  const { NextRequest } = await import("./support/next-server-stub.js");
  const res = await route.GET(new NextRequest("https://operator.console.test/api/platform/themes", { headers: { cookie: `_platform=${store.cookies["operator-support"]._platform}` } }));
  eq(res.status, 200, "operator GET:");
  const row = (await res.json()).tenants.find((x) => x.id === a.id);
  eq(JSON.stringify(row.package), JSON.stringify({ id: PKG, slug: "aurora", version: "1.2.0", name: "Aurora" }), "operator row:");
  const src = await readFile(join(ROOT, "components/platform/operations/Themes.js"), "utf8");
  ok(src.includes('header: "Uploaded theme"') && src.includes("data-ops-theme-package"), "the operator column");
});

await t("DesignForm: a package design reads 'Theme: Aurora 1.2.0 (uploaded). Change it on Themes', read-only", async () => {
  const src = await readFile(join(ROOT, "components/admin/editor/fields/DesignForm.js"), "utf8");
  ok(/Theme: \$\{name\}.*\(uploaded\)\. Change it on Themes/.test(src), "the words");
  ok(/if \(isObj\(value\) && typeof value\.package === "string"\) return <PackageLook/.test(src), "read-only for packages");
  const words = (name, version) => `Theme: ${name}${version ? ` ${version}` : ""} (uploaded). Change it on Themes`;
  eq(words("Aurora", "1.2.0"), "Theme: Aurora 1.2.0 (uploaded). Change it on Themes", "words:");
});

// =====================================================================================
console.log("— switching back, home layout, archived, rollback, kill switch");
// =====================================================================================
await t("home layout: off by default; on needs a confirm (409), then replaces the home draft with the theme's sections", async () => {
  const homeBefore = await a.run(() => Docs.getDocument("doc_home"));
  const no = await apply("owner", PKG2, { withHome: true });
  eq(no.status, 409, "no confirm:");
  eq(no.body.code, "HOME_CONFIRM_NEEDED", "code:");
  eq((await a.run(() => Docs.getDocument("doc_home"))).revision, homeBefore.revision, "home untouched:");
  const yes = await apply("owner", PKG2, { withHome: true, confirmHome: true, withBrand: false });
  eq(yes.status, 200, `confirm: ${JSON.stringify(yes.body)}`);
  const home = await a.run(() => Docs.getDocument("doc_home"));
  eq(home.body.sections.map((s) => s.kind).join(","), BOREAL.templates.home.sections.map((s) => s.kind).join(","), "home sections:");
  eq((await design()).body.settings.brand.accent, AURORA.tokens.accent, "withBrand false keeps the brand:");
});

await t("choosing a built-in look (POST /api/admin/theme) clears package and the theme's layouts", async () => {
  const r = await call("staff", "theme", "POST", { body: { action: "apply", kit: "glow", withPresets: false, revision: (await design()).revision } });
  eq(r.status, 200, `apply glow: ${JSON.stringify(r.body).slice(0, 200)}`);
  const d = await design();
  eq(d.body.settings.theme.kit, "glow", "kit:");
  eq(d.body.settings.theme.package, undefined, "package cleared:");
  const layouts = await a.run(async () => Promise.all(["doc_header", "doc_footer", "doc_product_layout", "doc_collection_layout"].map(async (id) => (await Docs.getDocument(id)).body.settings.template ?? null)));
  eq(JSON.stringify(layouts), JSON.stringify([null, null, null, null]), "layouts cleared:");
  eq((await stateOf()).draft.package, null, "state:");
});

await t("the stale-home case: Boreal with its home layout, then Glow, then Boreal without it: the home draft is not suggested", async () => {
  eq((await apply("owner", PKG2, { withHome: false })).status, 200, "Boreal without home:");
  const home = (await stateOf()).publishSet.find((d) => d.id === "doc_home");
  ok(home, "the stale home draft is pending");
  eq(home.suggested, false, "not suggested:");
});

await t("an unrelated home edit made in the editor is not published by default; the layouts the theme wrote are", async () => {
  await a.run(async () => {
    const h = await Docs.getDocument("doc_home");
    const sec = R.newSection("text", { id: "sec_thswitch9" });
    await Docs.saveDraft({ id: "doc_home", revision: h.revision, body: { ...h.body, sections: [{ ...sec, settings: { ...sec.settings, title: "Editor edit", body: ["Not the theme's."] } }] }, actor: { kind: "merchant", id: store.users.owner.id } });
  });
  eq((await apply("owner", PKG, { withHome: false })).status, 200, "Aurora without home:");
  const homeBefore = await a.run(() => Docs.getDocument("doc_home"));
  const s = await stateOf();
  eq(s.publishSet.find((d) => d.id === "doc_home")?.suggested, false, "home not suggested:");
  const r = await publishSet("owner");
  eq(r.status, 200, `publish: ${JSON.stringify(r.body).slice(0, 200)}`);
  const homeAfter = await a.run(() => Docs.getDocument("doc_home"));
  eq(homeAfter.publishedVersionId, homeBefore.publishedVersionId, "home stayed as it was live:");
  ok(homeAfter.draftHash !== homeAfter.publishedHash, "the editor's home edit is still a draft");
  eq((await stateOf()).publishSet.length, 0, "nothing else pending with the design:");
});

await t("a half-finished apply (a layout document made by someone else meanwhile) is audited partial and answers the conflict words", async () => {
  const { applyPackage, ThemeError } = await import("../lib/themes/packages.js");
  const { DocumentError } = await import("../lib/documents/service.js");
  const documents = { ...Docs, saveDraft: (args) => (args.id === "doc_header" ? Promise.reject(new DocumentError(409, "DOCUMENT_EXISTS", "exists")) : Docs.saveDraft(args)) };
  let err = null;
  await a.run(async () => {
    try {
      await applyPackage(PKG2, { actor: { kind: "merchant", id: store.users.owner.id }, revision: (await Docs.getDocument("doc_design")).revision, documents });
    } catch (e) {
      err = e;
    }
  });
  ok(err instanceof ThemeError && err.status === 409, `refused: ${err}`);
  ok(/Someone else changed your design just now/.test(err.message), err.message);
  const row = (await auditRows()).find((x) => x.action === "themes.apply");
  const diff = typeof row.diff === "string" ? JSON.parse(row.diff) : row.diff;
  eq(JSON.stringify([diff.package, diff.partial]), JSON.stringify([PKG2, true]), "partial audit:");
  eq((await apply("owner", PKG, { withHome: false })).status, 200, "back to Aurora in the draft:");
});

await t("an archived package blocks publish: 409 'This theme was archived. Choose another before publishing.' and nothing goes live", async () => {
  eq((await apply("owner", PKG_GONE, { withHome: false })).status, 200, "apply:");
  await sql(a, "UPDATE theme_packages SET status = 'archived', archived_at = ?, archived_by = 'test' WHERE id = ?", [new Date().toISOString(), PKG_GONE]);
  const problems = await a.run(async () => Kits.publishBlockers((await Docs.getDocument("doc_design")).body, "doc_design"));
  ok(problems.includes(Kits.PACKAGE_ARCHIVED_WORDS), `publishBlockers: ${problems}`);
  const r = await publishSet("owner");
  eq(r.status, 409, "publish:");
  ok(String(r.body.error).includes("This theme was archived. Choose another before publishing."), r.body.error);
  eq(themeAttr(await storeHtml(a)), "aurora", "Aurora stays live:");
  eq((await apply("owner", PKG_GONE)).status, 409, "an archived theme can't be applied:");
});

await t("publishBlockers runs checkBrand with the package surfaces: a hand-edited row with unreadable header colours is refused", async () => {
  const PKG_LOW = "thm_5e5e5e5e5e5e5e5e";
  await insertPackage(a, { id: PKG_LOW, pkg: { ...AURORA, id: "lowcontrast", version: "0.0.1", surfaces: { ...AURORA.surfaces, header: { bg: "#ffffff", fg: "#f4f4f4", muted: "#f0f0f0" } } } });
  const body = { ...(await design()).body };
  body.settings = { ...body.settings, theme: { kit: "pulse", version: 1, package: PKG_LOW }, brand: { ...AURORA.tokens } };
  const problems = await a.run(() => Kits.themePackageBlockers(body));
  ok(problems.length > 0 && problems.some((p) => /contrast/.test(p)), `surface problems: ${problems}`);
  body.settings.theme = { kit: "pulse", version: 1, package: PKG };
  eq((await a.run(() => Kits.themePackageBlockers(body))).length, 0, "Aurora's own surfaces:");
});

const CENTRED = "grid-cols-[1fr_auto_1fr]";
const publishBoreal = async () => {
  eq((await apply("owner", PKG2, { withHome: false })).status, 200, "apply Boreal:");
  const r = await publishSet("owner");
  eq(r.status, 200, `publish Boreal: ${JSON.stringify(r.body).slice(0, 300)}`);
  const html = await storeHtml(a);
  eq(themeAttr(html), "boreal", "Boreal live:");
  ok(!html.includes(CENTRED), "Boreal's standard header is live");
  eq((await getTenant(a.id, { fresh: true })).config.theme_pin.package, PKG2, "pin Boreal:");
  return r;
};
const auroraBack = async (label) => {
  const html = await storeHtml(a);
  eq(themeAttr(html), "aurora", `${label}: Aurora:`);
  ok(html.includes(CENTRED), `${label}: Aurora's centred header is back`);
  eq((await getTenant(a.id, { fresh: true })).config.theme_pin.package, PKG, `${label}: pin Aurora:`);
};

await t("rollback, the design row's Undo: it undoes the theme's layouts with it, so Aurora and its centred header come back", async () => {
  const r = await publishBoreal();
  const undo = r.body.published.find((p) => p.id === "doc_design").undo;
  const u = await call("owner", "documents", "PUT", { body: { undo: { id: undo.id, logId: undo.logId }, revision: undo.revision } });
  await H.drainAfter();
  eq(u.status, 200, `undo: ${JSON.stringify(u.body).slice(0, 300)}`);
  ok(u.body.document?.id === "doc_design", "the answer still names the design");
  await auroraBack("design Undo");
  ok(auroraLog, "the earlier Aurora publish");
});

await t("rollback, the whole publish's Undo (undoSet): Aurora and its centred header come back", async () => {
  const r = await publishBoreal();
  const setId = String((await sql(a, "SELECT set_id FROM publish_log WHERE id = ?", [r.body.published.find((p) => p.id === "doc_design").undo.logId]))[0].set_id);
  const members = r.body.published.map((p) => ({ id: p.undo.id, logId: p.undo.logId }));
  const u = await call("owner", "documents", "PUT", { body: { undoSet: { setId, members } } });
  await H.drainAfter();
  eq(u.status, 200, `undoSet: ${JSON.stringify(u.body).slice(0, 300)}`);
  await auroraBack("whole-publish Undo");
});

await t("the Themes page says so when the live theme was archived", async () => {
  await sql(a, "UPDATE theme_packages SET status = 'archived' WHERE id = ?", [PKG]);
  eq((await stateOf()).liveArchived, true, "liveArchived:");
  await sql(a, "UPDATE theme_packages SET status = 'installed' WHERE id = ?", [PKG]);
  const src = await readFile(join(ROOT, "components/admin/themes/ThemeLibrary.js"), "utf8");
  const words = await readFile(join(ROOT, "components/admin/themes/theme-words.js"), "utf8");
  ok(src.includes("state?.liveArchived") && words.includes("Your live theme was archived. Choose another before you publish design changes."), "the line");
});

await t("the kill switch ff_theme-packages refuses apply in plain words", async () => {
  await FLAGS.setFlag({ key: LP.THEMES_KILL_FLAG, description: "Uploaded themes", default_on: true, create: true, actor: "operator" });
  await FLAGS.setFlagOverride({ key: LP.THEMES_KILL_FLAG, tenant: a.id, on: false, actor: "operator" });
  const r = await apply("owner", PKG);
  eq(r.status, 409, "killed:");
  ok(r.body.error.startsWith(LP.THEMES_OFF_WORDS), r.body.error);
  await FLAGS.setFlagOverride({ key: LP.THEMES_KILL_FLAG, tenant: a.id, on: true, actor: "operator" });
});

await t("store B is untouched: no design names a package, no pin", async () => {
  const d = await b.run(() => Docs.getDocument("doc_design").catch(() => null));
  ok(!d?.body?.settings?.theme?.package, "B's design");
  ok(!(await getTenant(b.id, { fresh: true })).config.theme_pin?.package, "B's pin");
  eq(network.calls?.length ?? 0, 0, "no network:");
});

await store.cleanup().catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
