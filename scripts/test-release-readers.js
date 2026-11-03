// P2-READ suite: the version 4 shopper reader next to the frozen legacy one.
//   1. A v4 release (built with lib/documents/commit.js and registry bodies)
//      through all 17 resolved* getters, resolvedJournalEntries,
//      resolvedHomePage and contentSource, and the route handlers.
//   2. v1, v2 and v3 read exactly as at a6d028e, the legacy sitemap and
//      /journal listing included (outputs recorded inside an a6d028e checkout).
//   3. Fail closed: a listed version missing after one re-read, a v5 row, a
//      body from newer code, a required singleton missing from the list.
//   4. The manifest: a later singleton reads as the code default on an older
//      list; emptyList plus one policy page renders every getter at its default.
//   5. No release: legacy serves drafts, documents mode is DOCUMENTS_UNPUBLISHED,
//      no cms_state table is legacy, a cms_state read error fails closed.
//   6. Statement counts (request-cache stub): the real layout plus the real
//      home page, checkout, a policy page, the sitemap and /journal.
//   7. Edge safety: no node: import in lib/content/* or lib/cms-mode.js.
//   pnpm test:release-readers
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { readFile, readdir, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// next/headers answers for one simulated request at a time; outside one,
// headers() and cookies() throw, as Next's own do.
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

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rr-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rr-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const TENANTS = ["dv", "dz", "lg", "pre", "brk", "dm", "p0", "p1k", "sm", "lag", "bg"];
const dbs = [".test-rr-default.db", ".test-rr-platform.db", ".test-rr-legacy-outputs.json", ".test-rr-journal-outputs.json", ...TENANTS.map((t) => `.test-rr-${t}.db`)];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, currentDatabase } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const Res = await import("../lib/content/resolve.js");
const Docs = await import("../lib/content/documents-reader.js");
const L = await import("../lib/documents/release-list.js");
const ids = await import("../lib/documents/ids.js");
const { commitPublishBatch } = await import("../lib/documents/commit.js");
const Reg = await import("../lib/registry/index.js");
const { setPreviewCandidate } = await import("../lib/cms/candidates.js");
const { DEFAULT_ANNOUNCEMENT, defaultHero, DEFAULT_HOME_SECTIONS } = await import("../lib/cms/defaults.js");
const { runRequest } = await import("./support/request-cache.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");
// P2-READ's own pin: the last migration before 0021 (documents, cms_state).
const BEFORE_DOCUMENTS = "0020_sync_runs_resumable";

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
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const same = (got, want, m = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${m}\n      expected ${canon(want).slice(0, 600)}\n      got      ${canon(got).slice(0, 600)}`);
};
const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));
const unavailable = async (p, code, m = "") => {
  const r = await settle(p);
  if (!r.e) throw new Error(`${m} expected ContentUnavailableError ${code}, got ${JSON.stringify(r.v)?.slice(0, 200)}`);
  if (!Res.isContentUnavailable(r.e)) throw new Error(`${m} expected ContentUnavailableError, got ${r.e.message}`);
  if (code && r.e.detail?.code !== code) throw new Error(`${m} expected code ${code}, got ${JSON.stringify(r.e.detail)}`);
  return r.e;
};

// ---- tenants ---------------------------------------------------------------------

const P = (n) => `gid://shopify/Product/${n}`;
const COL = (n) => `gid://shopify/Collection/${n}`;
const NOW = "2026-11-04T10:00:00.000Z";

async function tenant(id, { upTo = null, config = {} } = {}) {
  await C.upsertTenant({
    id,
    name: `RR ${id}`,
    domains: [`${id}.test`],
    dbUrl: `file:.test-rr-${id}.db`,
    config: { site: { name: `RR ${id} Store` }, site_url: `https://${id}.test`, ...config },
    secrets: { order_link_secret: `${id}-secret` },
  });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, upTo ? MIGRATIONS.filter((m) => m.id <= upTo) : MIGRATIONS);
    const run = (sql, args = []) => libsql.execute({ sql, args });
    await run("INSERT INTO collections (id, handle, title, synced_at, updated_at) VALUES (?, 'whey', 'Whey', ?, ?), (?, 'serums', 'Serums', ?, ?)", [COL(1), NOW, NOW, COL(2), NOW, NOW]);
    for (const [n, handle, title, price] of [
      [1, "glow-serum", "Glow Serum", 1299],
      [2, "night-cream", "Night Cream", 899],
      [3, "whey-gold", "Whey Gold", 2499],
    ]) {
      await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at, updated_at) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?, ?)", [P(n), handle, title, price, price, NOW, NOW]);
      await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${n}`, P(n), price]);
    }
    await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0), (?, ?, 1), (?, ?, 0)", [COL(2), P(1), COL(2), P(2), COL(1), P(3)]);
    // legacy presentation tables a v4 store must never read
    await run("INSERT INTO product_overrides (product_id, modules, badge) VALUES (?, ?, 'TABLE')", [P(1), JSON.stringify([{ title: "From the table", html: "<p>table</p>" }])]);
    await run("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(2), JSON.stringify([P(2)])]);
    await run(
      "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position) VALUES ('pl_t_pairs', 'pdp_pairs', ?, ?, 'Table pairs', 1, 0), ('pl_t_cart', 'cart_upsell', NULL, ?, 'Table upsell', 1, 0)",
      [P(1), JSON.stringify([P(3)]), JSON.stringify([P(2)])],
    );
    await run("INSERT INTO page_redirects (from_slug, to_slug, created_at) VALUES ('old-about', 'table-target', ?)", [NOW]);
  });
  return T;
}

const setMode = (T, mode) => withTenant(T, () => libsql.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] }));

// ---- v4 fixtures, through the real commit --------------------------------------------

const body = (type, { settings, sections, meta } = {}) => {
  const b = Reg.emptyBody(type);
  if (settings) b.settings = { ...(b.settings || {}), ...settings };
  if (sections) b.sections = sections;
  if (meta) b.meta = { ...b.meta, ...meta };
  return b;
};
const sec = (kind, id, settings = {}, extra = {}) => {
  const s = Reg.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings }, ...extra };
};
const pageRow = (b) => ({ slug: b.meta.slug, type: b.type, title: b.meta.title, description: b.meta.description, enabled: b.meta.enabled, effective_at: b.meta.effective_at, window_start: b.meta.window_start, window_end: b.meta.window_end });

async function pointerOf() {
  const r = await libsql.execute("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const row = r.rows[0] || {};
  return { pointer: row.live ?? null, list: row.content ? JSON.parse(String(row.content)) : null };
}

async function ensureDocument(id, type, slug = null) {
  await libsql.execute({
    sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, 1, 1, ?, ?) ON CONFLICT(id) DO NOTHING",
    args: [id, type, slug, id, `dh_${id}`, NOW, NOW],
  });
  return Number((await libsql.execute({ sql: "SELECT revision FROM documents WHERE id = ?", args: [id] })).rows[0].revision);
}

async function versionOf(id, b, { schemaVersion = 1 } = {}) {
  const canonical = R.stableStringify(b);
  return { id: ids.verId(), document_id: id, kind: "published", body: canonical, body_hash: await R.sha256Hex(canonical), schema_version: schemaVersion, created_at: NOW };
}

// One publish through commitPublishBatch. items: [{ id, body | null, slug?,
// pages?, redirects? }], journal: posts for a new journal index (or undefined).
async function publish(T, items, { journal, m, from } = {}) {
  return withTenant(T, async () => {
    const live = await pointerOf();
    const prevList = from || (L.isV4List(live.list) ? live.list : L.emptyList(1, Reg.singletonTypes()));
    const build = { releaseId: ids.relId(), setId: ids.setId(), pointer: live.pointer, versions: [], documents: [], log: [], actor: "test", now: NOW };
    const changes = [];
    for (const it of items) {
      const type = it.body?.type ?? it.type;
      const revision = await ensureDocument(it.id, type, it.slug ?? (it.body?.meta?.slug || null));
      if (it.body === null) {
        build.documents.push({ id: it.id, revision, published_version_id: null, published_hash: null });
        changes.push({ document: it.id, entry: null });
        continue;
      }
      if (it.check !== false) {
        const { ok: valid, issues } = Reg.validateDocument(it.body, { mode: "publish" });
        if (!valid) throw new Error(`fixture ${it.id} does not validate: ${JSON.stringify(issues.filter((i) => i.severity !== "warning")).slice(0, 400)}`);
      }
      const v = await versionOf(it.id, it.body, it);
      build.versions.push(v);
      build.documents.push({ id: it.id, revision, published_version_id: v.id, published_hash: v.body_hash });
      build.log.push({ id: ids.logId(), document_id: it.id, action: "publish", to_version_id: v.id });
      const route = Reg.documentType(type)?.route && type !== "journal";
      changes.push({ document: it.id, entry: { version: v.id, hash: v.body_hash }, pages: route ? [pageRow(it.body)] : [], redirects: it.redirects || [] });
    }
    if (journal) {
      const revision = await ensureDocument("doc_journal_index", "journal_index");
      const v = await versionOf("doc_journal_index", L.journalIndexBody(journal));
      build.versions.push(v);
      build.documents.push({ id: "doc_journal_index", revision, published_version_id: v.id, published_hash: v.body_hash });
      changes.push({ index: "journal", entry: { version: v.id, hash: v.body_hash } });
    }
    build.list = L.setEntries(prevList, changes, m ? { m } : {});
    const r = await commitPublishBatch(build);
    if (r.outcome !== "ok") throw new Error(`publish: ${JSON.stringify(r).slice(0, 300)}`);
    return build;
  });
}

// Journal posts: documents and published versions written straight in (one
// batch), returning index entries for journalIndexBody.
async function journalPosts(T, posts) {
  return withTenant(T, async () => {
    const stmts = [];
    const entries = [];
    for (const p of posts) {
      const id = `doc_j${p.slug.replace(/[^a-z0-9]/g, "")}`;
      const b = body("journal", { meta: { slug: p.slug, title: p.title, description: p.description ?? "", enabled: p.enabled !== false, window_start: p.window_start ?? null, window_end: p.window_end ?? null }, sections: [sec("text", "sec_jt", { title: p.title, body: [`Body of ${p.slug}`] })] });
      const v = await versionOf(id, b);
      stmts.push({ sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES (?, 'journal', ?, ?, '{}', 'dh', 1, 1, ?, ?)", args: [id, p.slug, id, NOW, NOW] });
      stmts.push({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES (?, ?, 'published', ?, ?, 1, ?)", args: [v.id, id, v.body, v.body_hash, NOW] });
      entries.push({ document: id, version: v.id, slug: p.slug, title: p.title, description: p.description ?? "", enabled: p.enabled !== false, family: "journal", effective_at: null, window_start: p.window_start ?? null, window_end: p.window_end ?? null });
    }
    if (stmts.length) await libsql.batch(stmts, "write");
    return entries;
  });
}

// The full v4 store: every singleton, pages of each family, a redirect, a
// journal index with a shown, a scheduled and a switched-off post.
function fullStore() {
  return [
    {
      id: "doc_header",
      body: body("header", {
        settings: {
          mode: "custom",
          template: "centered",
          items: [
            { label: "Serums", link: { type: "collection", handle: "serums" } },
            { label: "About", link: { type: "url", href: "/about" }, children: [{ label: "Contact", link: { type: "url", href: "/contact" } }] },
          ],
        },
      }),
    },
    { id: "doc_footer", body: body("footer", { settings: { mode: "custom", template: "minimal", items: [{ label: "Whey", link: { type: "url", href: "/collections/whey" } }] } }) },
    { id: "doc_announcement", body: body("announcement", { settings: { enabled: true, text: "Docs bar", link: { type: "url", href: "/collections/serums" } } }) },
    { id: "doc_design", body: body("design", { settings: { brand: { accent: "#0d9488" }, theme: { kit: "glow", version: 1 } } }) },
    {
      id: "doc_home",
      body: body("home", {
        sections: [
          sec("hero", "sec_hero", { title: "Docs hero", highlight: "Docs", subtitle: "Fresh words", primary: { label: "Shop whey", link: { type: "collection", handle: "whey" } }, secondary: null, badge: "", image: { media: "/api/media/hero.jpg", alt: "A jar" } }),
          sec("new", "sec_new1", { title: "New in", limit: 4 }),
          sec("product_rail", "sec_rail1", { title: "Serums", collection: { handle: "old-handle", id: COL(2) }, limit: 4 }),
          sec("banner", "sec_hidden", { title: "Hidden banner", text: "x" }, { enabled: false }),
          sec("faq", "sec_faq1", { title: "Questions", items: [{ q: "Ship?", a: "<p>Yes</p>" }] }),
        ],
      }),
    },
    { id: "doc_collections_index", body: body("collections_index", { settings: { featured: [{ handle: "old-whey", id: COL(1) }], order: [{ handle: "serums" }], hide: [] } }) },
    {
      id: "doc_product_layout",
      body: body("product_layout", { settings: { template: "editorial" }, sections: [sec("product_main", "sec_main"), sec("rich_text", "sec_howto", { title: "How to use", html: "<p>Twice daily</p>" })] }),
    },
    { id: "doc_collection_layout", body: body("collection_layout", { settings: { template: "sidebar" }, sections: [] }) },
    { id: "doc_cart", body: body("cart", { settings: { title: "Add these", products: [{ handle: "whey-gold" }] } }) },
    {
      id: "doc_about",
      body: body("page", { meta: { slug: "about", title: "About Docs", description: "Who we are" }, sections: [sec("text", "sec_story", { title: "Story", body: ["We began."] })] }),
      redirects: [{ from_slug: "old-about", to_slug: "about" }],
    },
    { id: "doc_shipping", body: body("page", { meta: { slug: "shipping", title: "Shipping", effective_at: "2026-01-01" }, sections: [sec("rich_text", "sec_ship", { title: "Times", html: "<p>Two days</p>" })] }) },
    { id: "doc_hiddenpage", body: body("page", { meta: { slug: "hidden-page", title: "Hidden", enabled: false }, sections: [sec("text", "sec_hp", { title: "x" })] }) },
    {
      id: "doc_spring",
      body: body("campaign", { meta: { slug: "spring", title: "Spring sale", window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" }, sections: [sec("text", "sec_sp", { title: "Sale" })] }),
    },
  ];
}
const POSTS = [
  { slug: "first-post", title: "First post", description: "Hello", window_start: "2025-05-01T00:00:00.000Z" },
  { slug: "future-post", title: "Not yet", window_start: "2099-01-01T00:00:00.000Z" },
  { slug: "off-post", title: "Switched off", enabled: false },
];

// Every getter, with arguments.
const GETTERS = [
  ["resolvedAnnouncement", []],
  ["resolvedHero", []],
  ["resolvedHomeSections", []],
  ["resolvedNav", ["header"]],
  ["resolvedNav", ["footer"]],
  ["resolvedCollectionsIndex", []],
  ["resolvedPdpExtras", []],
  ["resolvedContentPage", ["about"]],
  ["resolvedContentPage", ["hidden-page"]],
  ["resolvedContentPage", ["spring"]],
  ["resolvedContentPage", ["first-post"]],
  ["resolvedContentPage", ["no-such-page"]],
  ["resolvedContentPageList", []],
  ["resolvedBrand", []],
  ["resolvedTheme", []],
  ["resolvedSurfaceTemplates", []],
  ["resolvedSurfaceTemplateFor", ["pdp", P(1)]],
  ["resolvedSurfaceTemplateFor", ["collection", COL(2)]],
  ["resolvedProductOverride", [P(1)]],
  ["resolvedCollectionPins", ["serums"]],
  ["resolvedPdpPairs", [P(1)]],
  ["resolvedCartUpsell", [[]]],
  ["resolvedSlugRedirect", ["old-about"]],
  ["resolvedSlugRedirect", ["about"]],
];
const RESOLVED = Object.keys(Res).filter((k) => /^resolved[A-Z]/.test(k) && k !== "resolvedJournalEntries" && k !== "resolvedHomePage");

// Statements a tenant's client runs while fn runs, with their arguments and
// the bytes of what came back. Wraps execute and batch of the current tenant's
// client (one watcher at a time).
async function watch(fn, { filter } = {}) {
  const client = currentDatabase().libsql;
  const execute = client.execute;
  const statements = [];
  client.execute = async (stmt, ...rest) => {
    const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
    const args = typeof stmt === "string" ? [] : stmt?.args || [];
    let r = await execute.call(client, stmt, ...rest);
    if (filter) r = filter(sql, args, r);
    const rows = (r.rows || []).map((row) => (r.columns || []).map((_, i) => (row[i] == null ? null : String(row[i]))));
    statements.push({ sql, args: [...args], bytes: JSON.stringify(rows).length });
    return r;
  };
  try {
    return { result: await fn(), statements };
  } finally {
    delete client.execute;
  }
}
// Content statements: the release, documents and CMS tables. Catalog reads
// (products, collections, variants) are not content and are not counted.
// collection_overrides is left out here on purpose and checked on its own:
// the home page's product rails read it straight from lib/cms/section-data.js
// on every store, outside the release (a known limit, P2-READ.md).
const CONTENT_SQL = /\b(release_state|releases|document_versions|documents|cms_state|cms_blocks|cms_pages|page_redirects|placements|product_overrides|cms_preview_candidates)\b/i;
const contentOnly = (st) => st.filter((s) => CONTENT_SQL.test(s.sql));
const versionReads = (st) => st.filter((s) => /document_versions/i.test(s.sql));

// One simulated request: next/headers answers for this host and cookies, and
// the request-cache stub memoizes per request.
async function asRequest(host, fn, cookies = {}) {
  globalThis.__readRequest = { host, cookies };
  try {
    return await runRequest(fn);
  } finally {
    globalThis.__readRequest = null;
  }
}

// ---- the real pages, compiled with Next's SWC (as test-releases does) -----------------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
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
const toFile = (from, id) => {
  const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
  return p.endsWith(".js") ? p : `${p}.js`;
};
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
async function loadJsx(file, stubs = {}, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs || deps.has(id)) continue;
    if (id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      const target = toFile(file, id);
      deps.set(id, isJsx(target) ? await loadJsx(target, stubs, seen) : await import(pathToFileURL(target).href));
    } else if (id === "next/headers") deps.set(id, await import("next/headers"));
    else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
const nothing = { __esModule: true, default: () => null };
const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
const font = () => ({ variable: "" });
const STUBS = {
  "next/font/google": { Geist: font, Geist_Mono: font, Fraunces: font },
  "../globals.css": {},
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "./SearchBox": nothing,
  "./cart/CartButton": nothing,
  "@/components/cart/CartContext": { CartProvider: passthrough },
  "@/components/cart/CartDrawer": nothing,
  "@/components/ServiceWorkerRegister": nothing,
  "@/components/analytics/ConsentBanner": nothing,
  "@/components/analytics/Pixels": nothing,
  "@/components/analytics/ErrorReporter": nothing,
  "@/components/site/SiteNav": nothing,
  "@/components/preview/PreviewBridge": nothing,
  // the home page's own components: the page's reads are what is counted
  "@/components/EmptyCatalog": nothing,
  "@/components/ExperimentPing": nothing,
  "@/components/site/MarketingHome": nothing,
  "@/components/sections/HomeSections": nothing,
  "@/components/preview/ExperimentNote": nothing,
  "@/components/checkout/CheckoutFlow": { __esModule: true, default: ({ policies }) => React.createElement("ul", { id: "policies" }, (policies || []).map((p) => React.createElement("li", { key: p.href }, p.href))) },
};
const Layout = (await loadJsx(join(ROOT, "app/(storefront)/layout.js"), STUBS)).default;
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"), STUBS)).default;
const Checkout = (await loadJsx(join(ROOT, "app/(storefront)/checkout/page.js"), STUBS)).default;
const Journal = (await loadJsx(join(ROOT, "app/(storefront)/journal/page.js"), STUBS)).default;
const sitemap = (await import(pathToFileURL(join(ROOT, "app/sitemap.js")).href)).default;
// a cart with one line, so the checkout page reaches its form (and its policy links)
const { createCart, addItem, CART_COOKIE } = await import("../lib/cart.js");
async function cartCookie(T) {
  await withTenant(T, async () => {
    await createCart("cart_rr");
    await addItem("cart_rr", "gid://shopify/ProductVariant/1", 1);
  });
  return { [CART_COOKIE]: "cart_rr" };
}
const renderLayout = async () => renderToStaticMarkup(await Layout({ children: React.createElement("p", { id: "page" }, "page body") }));

// =====================================================================================
console.log("— 1. a v4 release through every getter");
// =====================================================================================
const DV = await tenant("dv", { config: { brand: { accent: "#e11d48" }, theme: { kit: "pulse", version: 1 } } });
await setMode(DV, "documents");
const posts = await journalPosts(DV, POSTS);
const dvBuild = await publish(DV, fullStore(), { journal: posts });
const inDv = (fn) => withTenant(DV, fn);

const EXPECTED = {
  'resolvedAnnouncement()': { enabled: true, text: "Docs bar", href: "/collections/serums" },
  'resolvedHero()': { title: "Docs hero", highlight: "Docs", subtitle: "Fresh words", primary: { label: "Shop whey", href: "/collections/whey" }, secondary: null, badge: "" },
  'resolvedHomeSections()': [
    { id: "sec_new1", kind: "new", enabled: true, title: "New in", limit: 4 },
    { id: "sec_rail1", kind: "product_rail", enabled: true, title: "Serums", limit: 4, collection: "serums", collection_id: COL(2) },
  ],
  'resolvedNav("header")': [
    { label: "Serums", href: "/collections/serums" },
    { label: "About", href: "/about", children: [{ label: "Contact", href: "/contact" }] },
  ],
  'resolvedNav("footer")': [{ label: "Whey", href: "/collections/whey" }],
  'resolvedCollectionsIndex()': { featured: ["whey"], order: ["serums"], hide: [] },
  'resolvedPdpExtras()': [{ title: "How to use", html: "<p>Twice daily</p>" }],
  'resolvedContentPage("about")': {
    slug: "about",
    title: "About Docs",
    description: "Who we are",
    sections: [{ id: "sec_story", kind: "text", heading: "Story", body: ["We began."] }],
    effective_at: null,
    family: "page",
    window_start: null,
    window_end: null,
  },
  'resolvedContentPage("hidden-page")': null,
  'resolvedContentPage("spring")': {
    slug: "spring",
    title: "Spring sale",
    description: "",
    sections: [{ id: "sec_sp", kind: "text", heading: "Sale", body: [] }],
    effective_at: null,
    family: "campaign",
    window_start: "2020-03-01T00:00:00.000Z",
    window_end: "2099-03-31T00:00:00.000Z",
  },
  'resolvedContentPage("first-post")': {
    slug: "first-post",
    title: "First post",
    description: "Hello",
    sections: [{ id: "sec_jt", kind: "text", heading: "First post", body: ["Body of first-post"] }],
    effective_at: null,
    family: "journal",
    window_start: "2025-05-01T00:00:00.000Z",
    window_end: null,
  },
  'resolvedContentPage("no-such-page")': null,
  'resolvedContentPageList()': [
    { slug: "about", title: "About Docs", enabled: true, source: "custom", family: "page" },
    { slug: "hidden-page", title: "Hidden", enabled: false, source: "custom", family: "page" },
    { slug: "shipping", title: "Shipping", enabled: true, source: "custom", family: "page" },
    { slug: "spring", title: "Spring sale", enabled: true, source: "custom", family: "campaign" },
  ],
  'resolvedBrand()': { accent: "#0d9488" },
  'resolvedTheme()': { kit: "glow", version: 1 },
  'resolvedSurfaceTemplates()': { header: "centered", footer: "minimal" },
  [`resolvedSurfaceTemplateFor("pdp","${P(1)}")`]: { template: "editorial", source: "family" },
  [`resolvedSurfaceTemplateFor("collection","${COL(2)}")`]: { template: "sidebar", source: "family" },
  [`resolvedProductOverride("${P(1)}")`]: { modules: [], badge: "" },
  'resolvedCollectionPins("serums")': [],
  'resolvedSlugRedirect("old-about")': "about",
  'resolvedSlugRedirect("about")': null,
};
const keyOf = (fn, args) => `${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`;

await t("a v4 release built with commit.js: all 17 resolved* getters, resolvedJournalEntries, resolvedHomePage and contentSource return the published content", async () => {
  same(RESOLVED.sort(), [...new Set(GETTERS.map(([fn]) => fn))].sort(), "the getters this suite calls (resolve.js changed: update GETTERS)");
  eq(RESOLVED.length, 17, "resolved* getters:");
  const src = await inDv(() => Res.contentSource());
  eq(src.mode, "live", "mode:");
  eq(src.v, 4, "v:");
  eq(src.releaseId, dvBuild.releaseId, "releaseId:");
  eq(src.preview, false, "preview:");
  same(src.list.documents, dvBuild.list.documents, "list documents:");
  for (const [fn, args] of GETTERS) {
    const got = await inDv(() => Res[fn](...args));
    const k = keyOf(fn, args);
    if (k in EXPECTED) same(got, EXPECTED[k], `${k}:`);
  }
  // the catalog-backed ones
  const pairs = await inDv(() => Res.resolvedPdpPairs(P(1)));
  eq(pairs.source, "auto", "pairs source (no hand-picked pairs on v4):");
  same(pairs.products.map((p) => p.handle), ["night-cream"], "pairs:");
  const upsell = await inDv(() => Res.resolvedCartUpsell([]));
  eq(upsell.title, "Add these", "upsell title (doc_cart):");
  same(upsell.products.map((p) => p.handle), ["whey-gold"], "upsell products (doc_cart, not the placements table):");
  // the journal: the shown post only
  same(await inDv(() => Res.resolvedJournalEntries()), [{ slug: "first-post", title: "First post", description: "Hello", family: "journal", effective_at: null, window_start: "2025-05-01T00:00:00.000Z", window_end: null }], "journal entries:");
  eq(await inDv(() => Res.resolvedContentPage("future-post").then((p) => p && S.campaignVisible(p))), false, "a scheduled post is not visible:");
  eq(await inDv(() => Res.resolvedContentPage("off-post")), null, "a switched-off post:");
  // the home page as registry sections: hero (with its image) first, hidden ones out
  const homePage = await inDv(() => Res.resolvedHomePage());
  same(homePage.map((s) => s.id), ["sec_hero", "sec_new1", "sec_rail1", "sec_faq1"], "home page sections:");
  same(homePage[0].settings.image, { media: "/api/media/hero.jpg", alt: "A jar" }, "the hero's image (DOC-07):");
  eq(homePage[2].settings.collection.handle, "serums", "the rail's renamed collection heals:");
});

await t("the tenant's own config brand and theme, the placements and overrides tables and page_redirects are never what a v4 store shows", async () => {
  const brand = await inDv(() => Res.resolvedBrand());
  ok(brand.accent !== "#e11d48", "the config brand leaked");
  const { statements } = await inDv(() =>
    watch(async () => {
      for (const [fn, args] of GETTERS) await Res[fn](...args);
      await Res.resolvedJournalEntries();
    }),
  );
  const legacy = statements.filter((s) => /\b(cms_blocks|cms_pages|page_redirects|placements|product_overrides|collection_overrides)\b/i.test(s.sql));
  same(legacy.map((s) => s.sql), [], "legacy table reads on v4:");
});

await t("product overrides, collection pins and PDP pairs on v4 are neutral empties and never query product_overrides, collection_overrides or placements", async () => {
  const { result, statements } = await inDv(() => watch(async () => [await Res.resolvedProductOverride(P(1)), await Res.resolvedCollectionPins("serums"), await Res.resolvedPdpPairs(P(1))]));
  same(result[0], { modules: [], badge: "" }, "override:");
  same(result[1], [], "pins:");
  eq(result[2].source, "auto", "pairs:");
  const hits = statements.filter((s) => /\b(product_overrides|collection_overrides|placements)\b/i.test(s.sql));
  same(hits.map((s) => s.sql), [], "statements on the legacy presentation tables:");
});

await t("route handlers on v4: /api/upsell answers from doc_cart, the manifest and the offline page use doc_design's brand", async () => {
  const req = (url) => ({ headers: { get: (k) => (k.toLowerCase() === "host" ? "dv.test" : null) }, nextUrl: new URL(url), url });
  const upsell = await (await import("../app/api/upsell/route.js")).GET(req("https://dv.test/api/upsell?exclude="));
  eq(upsell.status, 200, "upsell status:");
  const u = await upsell.json();
  eq(u.title, "Add these", "upsell title:");
  same(u.products.map((p) => p.handle), ["whey-gold"], "upsell products:");
  const man = await (await import("../app/manifest.webmanifest/route.js")).GET(req("https://dv.test/manifest.webmanifest"));
  eq(man.status, 200, "manifest status:");
  const { resolveBrand, accentShades } = await import("../lib/brand.js");
  eq((await man.json()).theme_color, accentShades(resolveBrand({ accent: "#0d9488" }).accent)[900], "manifest theme colour (doc_design):");
  const off = await (await import("../app/(storefront)/offline/route.js")).GET(req("https://dv.test/offline"));
  eq(off.status, 200, "offline status:");
  ok((await off.text()).includes(accentShades(resolveBrand({ accent: "#0d9488" }).accent)[400]), "offline page colour is not doc_design's");
});

await t("rendered on v4: the real layout shows doc_header, doc_footer, the announcement and doc_design; checkout links the published policy", async () => {
  const html = await asRequest("dv.test", () => renderLayout());
  ok(html.includes("Docs bar"), "announcement missing");
  ok(/href="\/collections\/serums"[^>]*>Serums</.test(html) || html.includes(">Serums<"), "header item missing");
  ok(/py-10 text-center/.test(html), "the footer is not doc_footer's minimal layout");
  ok(/data-kit="glow-1"/.test(html), "kit is not doc_design's");
  ok(html.includes("/policies/shipping"), "footer policy link missing");
  ok(!html.includes("/policies/hidden-page"), "a switched-off page is linked");
  const co = await asRequest("dv.test", async () => renderToStaticMarkup(await Checkout()), await cartCookie(DV));
  ok(co.includes("/policies/shipping"), `checkout policy link missing: ${co.slice(0, 300)}`);
});

// =====================================================================================
console.log("— 2. v1, v2 and v3 read as at a6d028e");
// =====================================================================================
await t("v1, v2 and v3 fixtures: getLiveReleaseState, contentSource and every resolved* getter answer as a6d028e did, after the move to legacy-release.js", async () => {
  const out = join(ROOT, ".test-rr-legacy-outputs.json");
  const r = spawnSync(process.execPath, [join(here, "support/legacy-release-outputs.js"), out], { cwd: ROOT, encoding: "utf8", timeout: 90_000 });
  if (r.status !== 0) throw new Error(`recorder failed: ${r.stderr || r.stdout}`);
  const now = JSON.parse(await readFile(out, "utf8"));
  const then = JSON.parse(await readFile(join(here, "fixtures/legacy-release-outputs.a6d028e.json"), "utf8"));
  eq(Object.keys(now.fixtures).join(), "v1,v2,v3", "fixtures:");
  for (const [name, rec] of Object.entries(now.fixtures)) {
    const rel = rec.getLiveReleaseState?.ok?.release;
    if (!rel) throw new Error(`${name}: not live`);
    eq(rel.v, Number(name.slice(1)), `${name} release.v (the one P2-VGATE addition):`);
    delete rel.v;
    const want = then.fixtures[name];
    eq(Object.keys(rec).length, Object.keys(want).length, `${name} outputs:`);
    for (const k of Object.keys(want)) if (JSON.stringify(rec[k]) !== JSON.stringify(want[k])) throw new Error(`${name} ${k} differs from a6d028e:\n now  ${JSON.stringify(rec[k]).slice(0, 300)}\n then ${JSON.stringify(want[k]).slice(0, 300)}`);
  }
  await rm(out, { force: true });
});

await t("the legacy sitemap and /journal listing (drafts, and a v3 release) equal a6d028e's output", async () => {
  const out = join(ROOT, ".test-rr-journal-outputs.json");
  const r = spawnSync(process.execPath, [join(here, "support/legacy-journal-outputs.js"), out], { cwd: ROOT, encoding: "utf8", timeout: 90_000 });
  if (r.status !== 0) throw new Error(`recorder failed: ${r.stderr || r.stdout}`);
  const now = JSON.parse(await readFile(out, "utf8"));
  const then = JSON.parse(await readFile(join(here, "fixtures/legacy-journal-outputs.a6d028e.json"), "utf8"));
  eq(Object.keys(now.states).join(), "drafts,v3", "states:");
  for (const state of ["drafts", "v3"]) {
    same(now.states[state].sitemap, then.states[state].sitemap, `${state} sitemap:`);
    eq(now.states[state].journal, then.states[state].journal, `${state} /journal HTML:`);
  }
  ok(then.states.v3.journal.includes("First post (live)") && then.states.v3.journal.includes("live-only-post"), "the fixture does not cover the release's own posts");
  await rm(out, { force: true });
});

await t("lib/content/presentation.js still exports the four helpers, now the legacy reader's own", async () => {
  const Pm = await import("../lib/content/presentation.js");
  const Lr = await import("../lib/content/legacy-release.js");
  for (const k of ["presentationProductOverride", "presentationCollectionPins", "presentationPlacements", "presentationSlugRedirect"]) eq(Pm[k], Lr[k], `${k}:`);
});

// =====================================================================================
console.log("— 3. fail closed");
// =====================================================================================
const DZ = await tenant("dz");
await setMode(DZ, "documents");
const inDz = (fn) => withTenant(DZ, fn);
const putLive = (T, content, id = ids.relId()) =>
  withTenant(T, async () => {
    await libsql.execute({
      sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, '', NULL, ?, NULL, ?)",
      args: [id, typeof content === "string" ? content : R.stableStringify(content), `h_${id}`, NOW, NOW],
    });
    await libsql.execute({ sql: "UPDATE release_state SET live_release_id = ? WHERE id = 1", args: [id] });
    return id;
  });

await t("a listed version missing on the first read but present on the re-read renders (one re-read, replica lag)", async () => {
  const b = await publish(DZ, [{ id: "doc_announcement", body: body("announcement", { settings: { enabled: true, text: "Lagging bar", link: null } }) }], { from: L.emptyList(1, Reg.singletonTypes()) });
  const lagging = b.versions[0].id;
  let reads = 0;
  const hide = (sql, args, r) => {
    if (!/document_versions/i.test(sql)) return r;
    reads++;
    if (reads > 1) return r;
    return { ...r, rows: r.rows.filter((row) => String(row.id) !== lagging) };
  };
  const { result, statements } = await inDz(() => runRequest(() => watch(() => Res.resolvedAnnouncement(), { filter: hide })));
  eq(result.text, "Lagging bar", "rendered after the re-read:");
  eq(versionReads(statements).length, 2, "version reads (first, then one re-read):");
  same(versionReads(statements)[1].args, [lagging], "the re-read asks only for what was missing:");
});

await t("a listed version still missing after one re-read throws ContentUnavailableError (MISSING_VERSION), never a draft or a default", async () => {
  const live = await inDz(() => pointerOf());
  const gone = live.list.documents.doc_announcement.version;
  const hideAlways = (sql, args, r) => (/document_versions/i.test(sql) ? { ...r, rows: r.rows.filter((row) => String(row.id) !== gone) } : r);
  // a draft that must never show
  await inDz(() => S.setBlock("announcement", { enabled: true, text: "DRAFT BAR" }));
  const res = await inDz(() => runRequest(() => watch(() => settle(Res.resolvedAnnouncement()), { filter: hideAlways })));
  if (!res.result.e) throw new Error(`answered ${JSON.stringify(res.result.v)}`);
  eq(res.result.e.detail?.code, "MISSING_VERSION", "code:");
  eq(versionReads(res.statements).length, 2, "exactly one re-read:");
  // and a list naming a version that was never written
  const list = { ...live.list, documents: { ...live.list.documents, doc_announcement: { version: "ver_0000000000000000", hash: "x" } } };
  await putLive(DZ, list);
  await unavailable(inDz(() => Res.resolvedAnnouncement()), "MISSING_VERSION", "a version that does not exist:");
  await unavailable(inDz(() => Res.resolvedNav("header")), "MISSING_VERSION", "the chrome set fails together:");
});

await t("a v5 row is an error; a version body written by newer code (schema 2) is an error; a version that belongs to another document is an error", async () => {
  const live = await inDz(() => pointerOf());
  await putLive(DZ, { ...live.list, v: 5 });
  eq((await inDz(() => R.getLiveReleaseState())).state, "error", "v5 state:");
  await unavailable(inDz(() => Res.contentSource()), null, "v5:");
  await unavailable(inDz(() => Res.resolvedHero()), null, "v5 hero:");
  // schema 2
  const b2 = await publish(DZ, [{ id: "doc_announcement", body: { ...body("announcement", { settings: { enabled: false, text: "", link: null } }), schema: 2 }, check: false }], { from: L.emptyList(1, Reg.singletonTypes()) });
  void b2;
  await unavailable(inDz(() => Res.resolvedAnnouncement()), "UNKNOWN_SCHEMA", "schema 2:");
  // a list that names doc_footer's version under doc_header
  const b3 = await publish(DZ, [{ id: "doc_footer", body: body("footer") }], { from: L.emptyList(1, Reg.singletonTypes()) });
  const swapped = { ...b3.list, documents: { ...b3.list.documents, doc_header: b3.list.documents.doc_footer } };
  await putLive(DZ, swapped);
  await unavailable(inDz(() => Res.resolvedNav("header")), "VERSION_MISMATCH", "another document's version:");
});

await t("a listed version whose row belongs to another document is an error, for a singleton of the same type and for a page", async () => {
  // a header body stored under another document id, listed as doc_header's
  const stray = await inDz(async () => {
    const v = await versionOf("doc_header_old", body("header", { settings: { mode: "custom", items: [{ label: "Stray", link: { type: "url", href: "/collections" } }] } }));
    await ensureDocument("doc_header_old", "header");
    await libsql.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES (?, ?, 'published', ?, ?, 1, ?)", args: [v.id, v.document_id, v.body, v.body_hash, NOW] });
    return v;
  });
  const base = L.emptyList(1, Reg.singletonTypes());
  await putLive(DZ, { ...base, documents: { ...base.documents, doc_header: { version: stray.id, hash: stray.body_hash } } });
  await unavailable(inDz(() => Res.resolvedNav("header")), "VERSION_MISMATCH", "a header version of another document:");
  // a page row whose document points at another page's version
  const b = await publish(DZ, [{ id: "doc_pa", body: body("page", { meta: { slug: "page-a", title: "A" }, sections: [sec("text", "sec_pa", { title: "A" })] }) }, { id: "doc_pb", body: body("page", { meta: { slug: "page-b", title: "B" }, sections: [sec("text", "sec_pb", { title: "B" })] }) }], { from: base });
  await putLive(DZ, { ...b.list, documents: { ...b.list.documents, doc_pa: b.list.documents.doc_pb } });
  await unavailable(inDz(() => Res.resolvedContentPage("page-a")), "VERSION_MISMATCH", "a page listed at another page's version:");
});

await t("a page beats a redirect at the same slug (list.redirects, never page_redirects)", async () => {
  const b = await publish(DZ, [{ id: "doc_pc", body: body("page", { meta: { slug: "page-c", title: "C" }, sections: [sec("text", "sec_pc", { title: "C" })] }), redirects: [{ from_slug: "page-c", to_slug: "elsewhere" }, { from_slug: "gone", to_slug: "page-c" }] }], { from: L.emptyList(1, Reg.singletonTypes()) });
  void b;
  eq(await inDz(() => Res.resolvedSlugRedirect("page-c")), null, "a page at the slug:");
  eq(await inDz(() => Res.resolvedSlugRedirect("gone")), "page-c", "a redirect with no page:");
  eq(await inDz(() => Res.resolvedSlugRedirect("old-about")), null, "the page_redirects table is not read:");
});

await t("a list that is not a v4 list, or whose m is not a whole number, fails closed (BAD_LIST)", async () => {
  await putLive(DZ, { v: 4, list: { doc_header: "dv_1" } });
  await unavailable(inDz(() => Res.contentSource()), "BAD_LIST", "no documents:");
  await putLive(DZ, { ...L.emptyList(1, Reg.singletonTypes()), m: 0 });
  await unavailable(inDz(() => Res.contentSource()), "BAD_LIST", "m 0:");
  await putLive(DZ, { ...L.emptyList(1, Reg.singletonTypes()), documents: { ...L.emptyList(1, Reg.singletonTypes()).documents, doc_home: { version: "dv_1", hash: "x" } } });
  await unavailable(inDz(() => Res.contentSource()), "BAD_LIST", "a bad entry:");
});

// P2-DOCFIX (6): review gaps on P2-READ, each pinned by its own test.
await t("a custom menu with zero items renders an empty menu on v4, never the automatic catalog menu", async () => {
  await publish(DZ, [{ id: "doc_header", body: body("header", { settings: { mode: "custom", items: [] } }), check: false }, { id: "doc_footer", body: body("footer", { settings: { mode: "custom", items: [] } }), check: false }], { from: L.emptyList(1, Reg.singletonTypes()) });
  same(await inDz(() => Res.resolvedNav("header")), [], "header:");
  same(await inDz(() => Res.resolvedNav("footer")), [], "footer:");
  // and "auto" is still the catalog menu (null)
  await publish(DZ, [{ id: "doc_header", body: body("header", { settings: { mode: "auto", items: [] } }) }], { from: L.emptyList(1, Reg.singletonTypes()) });
  eq(await inDz(() => Res.resolvedNav("header")), null, "auto:");
});

await t("hidden page sections and hidden PDP accordion sections never render on v4", async () => {
  await publish(
    DZ,
    [
      { id: "doc_hide", body: body("page", { meta: { slug: "hide-some", title: "Hide some" }, sections: [sec("text", "sec_show", { title: "Shown words", body: ["Visible."] }), sec("text", "sec_hid", { title: "HIDDEN WORDS", body: ["Secret."] }, { enabled: false }), sec("faq", "sec_hfaq", { title: "HIDDEN FAQ", items: [{ q: "Q?", a: "<p>A</p>" }] }, { enabled: false })] }) },
      { id: "doc_product_layout", body: body("product_layout", { sections: [sec("product_main", "sec_main"), sec("rich_text", "sec_vis", { title: "How to use", html: "<p>Daily</p>" }), sec("rich_text", "sec_hacc", { title: "HIDDEN ACCORDION", html: "<p>Secret</p>" }, { enabled: false }), sec("text", "sec_htxt", { title: "HIDDEN TEXT", body: ["Secret."] }, { enabled: false }), sec("faq", "sec_hq", { title: "x", items: [{ q: "HIDDEN QUESTION", a: "<p>Secret</p>" }] }, { enabled: false })] }) },
    ],
    { from: L.emptyList(1, Reg.singletonTypes()) },
  );
  const page = await inDz(() => Res.resolvedContentPage("hide-some"));
  same(page.sections.map((x) => x.id), ["sec_show"], "page sections:");
  ok(!JSON.stringify(page).includes("HIDDEN"), `no hidden words on the page: ${JSON.stringify(page).slice(0, 300)}`);
  const pdp = await inDz(() => Res.resolvedPdpExtras());
  same(pdp, [{ title: "How to use", html: "<p>Daily</p>" }], "PDP accordions:");
});

await t("a listed page whose documents entry is null throws MISSING_PAGE_VERSION, never the code default page", async () => {
  const b = await publish(DZ, [{ id: "doc_privacy2", body: body("page", { meta: { slug: "privacy-two", title: "Our privacy" }, sections: [sec("text", "sec_p2", { title: "Data" })] }) }], { from: L.emptyList(1, Reg.singletonTypes()) });
  eq((await inDz(() => Res.resolvedContentPage("privacy-two"))).title, "Our privacy", "listed and present:");
  await putLive(DZ, { ...b.list, documents: { ...b.list.documents, doc_privacy2: null } });
  const e = await unavailable(inDz(() => Res.resolvedContentPage("privacy-two")), "MISSING_PAGE_VERSION", "entry null:");
  same([e.detail.document, e.detail.slug], ["doc_privacy2", "privacy-two"], "names the page:");
});

await t("on v4 a journal post beats a redirect at the same slug", async () => {
  const entries = await journalPosts(DZ, [{ slug: "jp-wins", title: "Journal wins", window_start: "2025-01-01T00:00:00.000Z" }]);
  await publish(DZ, [{ id: "doc_pd", body: body("page", { meta: { slug: "page-d", title: "D" }, sections: [sec("text", "sec_pd", { title: "D" })] }), redirects: [{ from_slug: "jp-wins", to_slug: "page-d" }, { from_slug: "no-post", to_slug: "page-d" }] }], { journal: entries, from: L.emptyList(1, Reg.singletonTypes()) });
  eq((await inDz(() => Res.resolvedContentPage("jp-wins")))?.title, "Journal wins", "the post renders:");
  eq(await inDz(() => Res.resolvedSlugRedirect("jp-wins")), null, "the post wins:");
  eq(await inDz(() => Res.resolvedSlugRedirect("no-post")), "page-d", "a redirect with no post still applies:");
});

await t("a version row whose schema_version column is newer than this code is an error (UNKNOWN_SCHEMA), even when its body says schema 1", async () => {
  await publish(DZ, [{ id: "doc_announcement", body: body("announcement", { settings: { enabled: true, text: "NEWER CODE BAR", link: null } }), schemaVersion: Reg.SCHEMA_VERSION + 1 }], { from: L.emptyList(1, Reg.singletonTypes()) });
  const row = (await inDz(() => libsql.execute("SELECT v.body, v.schema_version FROM document_versions v JOIN releases r ON instr(r.content, v.id) > 0 JOIN release_state s ON s.live_release_id = r.id WHERE v.document_id = 'doc_announcement'"))).rows[0];
  same([JSON.parse(String(row.body)).schema, Number(row.schema_version)], [1, Reg.SCHEMA_VERSION + 1], "the stored row:");
  await unavailable(inDz(() => Res.resolvedAnnouncement()), "UNKNOWN_SCHEMA", "schema_version column:");
  // leave a readable list for the tests after this one
  await publish(DZ, [{ id: "doc_announcement", body: body("announcement", { settings: { enabled: false, text: "", link: null } }) }], { from: L.emptyList(1, Reg.singletonTypes()) });
});

await t("cms_state.mode 'bogus' with no release fails closed (UNKNOWN_CMS_MODE), never legacy drafts", async () => {
  const BG = await tenant("bg");
  await withTenant(BG, () => S.setBlock("hero", { title: "BOGUS DRAFT HERO" }));
  await setMode(BG, "bogus");
  const e = await unavailable(withTenant(BG, () => Res.contentSource()), "UNKNOWN_CMS_MODE", "contentSource:");
  eq(e.detail.mode, "bogus", "names the mode:");
  for (const [fn, args] of GETTERS) {
    const r = await settle(withTenant(BG, () => Res[fn](...args)));
    if (!r.e || !Res.isContentUnavailable(r.e)) throw new Error(`${keyOf(fn, args)}: ${r.e ? r.e.message : JSON.stringify(r.v).slice(0, 120)}`);
  }
});

// =====================================================================================
console.log("— 4. code defaults and the manifest");
// =====================================================================================
await t("a list made by emptyList plus one policy page renders every getter at its code default with no error", async () => {
  const policy = body("page", { meta: { slug: "privacy", title: "Privacy" }, sections: [sec("text", "sec_pv", { title: "Data", body: ["We keep little."] })] });
  await publish(DZ, [{ id: "doc_privacy", body: policy }], { from: L.emptyList(1, Reg.singletonTypes()) });
  const live = await inDz(() => pointerOf());
  same(Object.values(live.list.documents).filter((e) => e === null).length, Reg.singletonTypes().length, "every singleton is an explicit null:");
  const name = "RR dz Store";
  const want = {
    'resolvedAnnouncement()': DEFAULT_ANNOUNCEMENT,
    'resolvedHero()': defaultHero(name),
    'resolvedHomeSections()': DEFAULT_HOME_SECTIONS,
    'resolvedNav("header")': null,
    'resolvedNav("footer")': null,
    'resolvedCollectionsIndex()': null,
    'resolvedPdpExtras()': [],
    'resolvedContentPage("about")': null,
    'resolvedContentPageList()': [{ slug: "privacy", title: "Privacy", enabled: true, source: "custom", family: "page" }],
    'resolvedBrand()': null,
    'resolvedTheme()': null,
    'resolvedSurfaceTemplates()': { header: "standard", footer: "columns" },
    [`resolvedSurfaceTemplateFor("pdp","${P(1)}")`]: { template: "classic", source: "platform" },
    [`resolvedSurfaceTemplateFor("collection","${COL(2)}")`]: { template: "standard", source: "platform" },
    [`resolvedProductOverride("${P(1)}")`]: { modules: [], badge: "" },
    'resolvedCollectionPins("serums")': [],
    'resolvedSlugRedirect("old-about")': null,
  };
  for (const [fn, args] of GETTERS) {
    const r = await settle(inDz(() => Res[fn](...args)));
    if (r.e) throw new Error(`${keyOf(fn, args)} threw ${r.e.message} ${JSON.stringify(r.e.detail || "")}`);
    const k = keyOf(fn, args);
    if (k in want) same(r.v, want[k], `${k}:`);
  }
  same((await inDz(() => Res.resolvedCartUpsell([]))).products, [], "no cart upsell (the placements table is not read):");
  same((await inDz(() => Res.resolvedContentPage("privacy"))).sections, [{ id: "sec_pv", kind: "text", heading: "Data", body: ["We keep little."] }], "the policy page:");
  same(await inDz(() => Res.resolvedJournalEntries()), [], "no journal:");
  same((await inDz(() => Res.resolvedHomePage())).map((s) => s.kind), ["hero", "collections", "new"], "home page defaults:");
});

await t("doc_home published with zero shown sections besides the hero renders none, never DEFAULT_HOME_SECTIONS (DOC-07)", async () => {
  await publish(DZ, [{ id: "doc_home", body: body("home", { sections: [sec("hero", "sec_hero", { title: "Only a hero" }), sec("new", "sec_off", {}, { enabled: false })] }) }]);
  same(await inDz(() => Res.resolvedHomeSections()), [], "home sections:");
  eq((await inDz(() => Res.resolvedHero())).title, "Only a hero", "hero:");
  same((await inDz(() => Res.resolvedHomePage())).map((s) => s.id), ["sec_hero"], "home page:");
  // a home with its hero hidden: no hero (the page renders none)
  await publish(DZ, [{ id: "doc_home", body: body("home", { sections: [sec("hero", "sec_hero", { title: "Hidden hero" }, { enabled: false }), sec("new", "sec_nn")] }) }]);
  eq(await inDz(() => Res.resolvedHero()), null, "a hidden hero:");
  same((await inDz(() => Res.resolvedHomePage())).map((s) => s.id), ["sec_nn"], "home page with the hero hidden:");
});

await t("a required singleton (sinceManifest <= m) missing from the list is an error; an explicit null is the code default", async () => {
  const live = await inDz(() => pointerOf());
  const { doc_header: _gone, ...rest } = live.list.documents;
  await putLive(DZ, { ...live.list, documents: rest });
  const e = await unavailable(inDz(() => Res.contentSource()), "MISSING_SINGLETON", "missing doc_header:");
  eq(e.detail.document, "doc_header", "names the document:");
  await putLive(DZ, { ...live.list, documents: { ...rest, doc_header: null } });
  eq(await inDz(() => Res.resolvedNav("header")), null, "explicit null (the catalog-derived menu):");
});

// =====================================================================================
console.log("— 5. no release yet: legacy drafts, documents unpublished, no table, a broken table");
// =====================================================================================
await t("documents mode with no release throws DOCUMENTS_UNPUBLISHED (drafts never serve)", async () => {
  const DM = await tenant("dm");
  await setMode(DM, "documents");
  await withTenant(DM, () => S.setBlock("hero", { title: "DRAFT HERO" }));
  await unavailable(withTenant(DM, () => Res.contentSource()), "DOCUMENTS_UNPUBLISHED", "contentSource:");
  await unavailable(withTenant(DM, () => Res.resolvedHero()), "DOCUMENTS_UNPUBLISHED", "hero:");
  // 'migrating' with no release keeps today's draft path (spec 8.7)
  await setMode(DM, "migrating");
  eq((await withTenant(DM, () => Res.resolvedHero())).title, "DRAFT HERO", "migrating:");
});

await t("legacy with no release serves drafts as today; a tenant at 0020 (no cms_state table) behaves as legacy", async () => {
  const LG = await tenant("lg");
  await withTenant(LG, () => S.setBlock("hero", { title: "Legacy draft hero" }));
  eq((await withTenant(LG, () => Res.contentSource())).mode, "draft", "legacy mode:");
  eq((await withTenant(LG, () => Res.resolvedHero())).title, "Legacy draft hero", "legacy hero:");
  const PRE = await tenant("pre", { upTo: BEFORE_DOCUMENTS });
  ok(MIGRATIONS.some((m) => m.id > BEFORE_DOCUMENTS), `nothing after ${BEFORE_DOCUMENTS}: move the pin`);
  eq((await withTenant(PRE, () => libsql.execute("SELECT name FROM sqlite_master WHERE name = 'cms_state'"))).rows.length, 0, "cms_state at 0020:");
  await withTenant(PRE, () => S.setBlock("hero", { title: "Pre-0021 draft hero" }));
  eq((await withTenant(PRE, () => Res.contentSource())).mode, "draft", "0020 mode:");
  eq((await withTenant(PRE, () => Res.resolvedHero())).title, "Pre-0021 draft hero", "0020 hero:");
});

await t("a cms_state read error (a broken view) throws ContentUnavailableError and never serves legacy drafts", async () => {
  const BRK = await tenant("brk");
  await withTenant(BRK, async () => {
    await S.setBlock("hero", { title: "MUST NOT SHOW" });
    await libsql.execute("DROP TABLE cms_state");
    await libsql.execute("CREATE TABLE cms_state_src (id INTEGER, mode TEXT)");
    await libsql.execute("CREATE VIEW cms_state AS SELECT id, mode FROM cms_state_src");
    await libsql.execute("DROP TABLE cms_state_src");
  });
  const e = await unavailable(withTenant(BRK, () => Res.contentSource()), "CMS_MODE_UNAVAILABLE", "contentSource:");
  ok(!JSON.stringify(e.detail).includes("MUST NOT SHOW"), "detail carries content");
  for (const [fn, args] of GETTERS) {
    const r = await settle(withTenant(BRK, () => Res[fn](...args)));
    if (!r.e || !Res.isContentUnavailable(r.e)) throw new Error(`${keyOf(fn, args)}: ${r.e ? r.e.message : JSON.stringify(r.v).slice(0, 120)}`);
  }
});

// =====================================================================================
console.log("— 6. statement counts (request-cache stub)");
// =====================================================================================
// Two stores the same but for the journal: none, and 1,000 posts.
const P0 = await tenant("p0");
const P1K = await tenant("p1k");
const MANY = Array.from({ length: 1000 }, (_, i) => ({ slug: `post-${String(i).padStart(4, "0")}`, title: `Post ${i}`, description: "d", window_start: "2025-01-01T00:00:00.000Z" }));
await publish(P0, fullStore(), { journal: [] });
await publish(P1K, fullStore(), { journal: await journalPosts(P1K, MANY) });
const versionsOf = async (T) => (await withTenant(T, () => pointerOf())).list;

async function homeRequest(host) {
  return asRequest(host, async () => {
    const tenantT = await C.getTenant(host.split(".")[0]);
    return withTenant(tenantT, () =>
      watch(async () => {
        const layout = await renderLayout();
        const home = renderToStaticMarkup(await Home());
        return { layout, home };
      }),
    );
  });
}

await t("the REAL layout plus the home page issue at most 3 content statements per request, with the same count and identical byte totals at 0 and 1,000 journal documents", async () => {
  const a = await homeRequest("p0.test");
  const b = await homeRequest("p1k.test");
  ok(a.result.layout.includes("Docs bar") && /Docs<\/span> hero/.test(a.result.home), `the pages did not render the published content: ${a.result.home.slice(0, 400)}`);
  const ca = contentOnly(a.statements);
  const cb = contentOnly(b.statements);
  ok(ca.length <= 3, `content statements at 0 posts: ${ca.length}\n      ${ca.map((s) => s.sql.slice(0, 120)).join(" | ")}`);
  eq(cb.length, ca.length, "content statements at 1,000 posts:");
  const bytes = (st) => st.reduce((n, s) => n + s.bytes, 0);
  // the known limit: the rails' pins, read by lib/cms/section-data.js, not by a getter
  const pinReads = a.statements.filter((s) => /collection_overrides/i.test(s.sql));
  eq(pinReads.length, 1, "home rail pin reads (section-data.js, one rail):");
  eq(bytes(cb), bytes(ca), "bytes read at 1,000 posts vs 0:");
  // what they are: the pointer and list, the chrome set, the home set
  const listA = await versionsOf(P0);
  const asSet = (lists) => lists.map((l) => [...l].sort().join(",")).sort();
  same(
    asSet(versionReads(ca).map((s) => s.args)),
    asSet([Docs.CHROME_DOCUMENTS.map((d) => listA.documents[d].version), Docs.HOME_DOCUMENTS.map((d) => listA.documents[d].version)]),
    "version reads (the chrome set and the home set, once each):",
  );
});

await t("chromeData (the real layout) and the real checkout policyLinks read no version body for pages and never the journal index", async () => {
  const list = await versionsOf(P1K);
  const chromeIds = new Set(Docs.CHROME_DOCUMENTS.map((d) => list.documents[d].version));
  const lay = await asRequest("p1k.test", () => withTenant(P1K, () => watch(() => renderLayout())));
  for (const s of versionReads(lay.statements)) for (const a of s.args) ok(chromeIds.has(a), `the layout read a version outside the chrome set: ${a}`);
  eq(versionReads(lay.statements).length, 1, "the layout's version reads:");
  ok(lay.result.includes("/policies/shipping"), "footer policy link missing");
  const cookie = await cartCookie(P1K);
  const co = await asRequest("p1k.test", () => withTenant(P1K, () => watch(async () => renderToStaticMarkup(await Checkout()))), cookie);
  ok(co.result.includes("/policies/shipping"), `checkout policy link missing: ${co.result.slice(0, 400)}`);
  eq(versionReads(co.statements).length, 0, "checkout version reads:");
  const indexVersion = list.indexes.journal.version;
  ok(![...lay.statements, ...co.statements].some((s) => s.args.includes(indexVersion)), "the journal index was read");
});

await t("a policy page reads only its own version", async () => {
  const list = await versionsOf(P1K);
  const r = await asRequest("p1k.test", () => withTenant(P1K, () => watch(() => Res.resolvedContentPage("shipping"))));
  eq(r.result.title, "Shipping", "page:");
  same(versionReads(r.statements).map((s) => s.args), [[list.documents.doc_shipping.version]], "version reads:");
  eq(contentOnly(r.statements).length, 2, "content statements (pointer, its version):");
});

await t("the sitemap with 200 published posts reads the journal index once and issues no per-post read; /journal likewise", async () => {
  const SM = await tenant("sm");
  const many = Array.from({ length: 200 }, (_, i) => ({ slug: `entry-${String(i).padStart(3, "0")}`, title: `Entry ${i}`, description: "", window_start: i === 7 ? "2099-01-01T00:00:00.000Z" : "2025-01-01T00:00:00.000Z" }));
  await publish(SM, fullStore(), { journal: await journalPosts(SM, many) });
  const list = await versionsOf(SM);
  const map = await asRequest("sm.test", () => withTenant(SM, () => watch(() => sitemap())));
  const journalUrls = map.result.filter((e) => e.url.includes("/journal/"));
  eq(journalUrls.length, 199, "journal urls (one is scheduled):");
  ok(map.result.some((e) => e.url === "https://sm.test/journal"), "/journal is listed");
  ok(map.result.some((e) => e.url === "https://sm.test/policies/shipping") && !map.result.some((e) => e.url.includes("spring")), "pages listed, campaigns not");
  same(versionReads(map.statements).map((s) => s.args), [[list.indexes.journal.version]], "sitemap version reads:");
  eq(contentOnly(map.statements).length, 2, "sitemap content statements (pointer, index):");
  const j = await asRequest("sm.test", () => withTenant(SM, () => watch(async () => renderToStaticMarkup(await Journal()))));
  eq((j.result.match(/href="\/journal\//g) || []).length, 199, "/journal posts:");
  same(versionReads(j.statements).map((s) => s.args), [[list.indexes.journal.version]], "/journal version reads:");
});

// =====================================================================================
console.log("— 7. resolvedHomePage on a legacy store, and the S59 preview candidate");
// =====================================================================================
await t("resolvedHomePage on a legacy tenant matches resolvedHero plus resolvedHomeSections (drafts, a v3 release, and an S59 preview candidate)", async () => {
  const LAG = await tenant("lag");
  const inLag = (fn) => withTenant(LAG, fn);
  const { legacyHeroToSection, legacyHomeSectionsToSections } = Reg;
  const compose = async () => [legacyHeroToSection(await Res.resolvedHero()), ...legacyHomeSectionsToSections(await Res.resolvedHomeSections())];
  await inLag(async () => {
    await S.setBlock("hero", { title: "Draft hero", primary: { label: "Go", href: "/collections/whey" } });
    await S.setBlock("home_sections", [
      { id: "sec_r1", kind: "product_rail", title: "Rail", collection: "old", collection_id: COL(2), limit: 4 },
      { id: "sec_b1", kind: "banner", title: "B", text: "t", label: "L", href: "/collections" },
      { id: "sec_off", kind: "new", enabled: false },
    ]);
  });
  const drafts = await inLag(() => Res.resolvedHomePage());
  same(drafts, await inLag(compose), "drafts:");
  same(drafts.map((s) => s.id), ["sec_hero", "sec_r1", "sec_b1"], "draft ids:");
  eq(drafts[0].settings.title, "Draft hero", "draft hero:");
  eq(drafts[1].settings.collection.handle, "serums", "healed rail:");
  same(drafts[2].settings.button, { label: "L", link: { type: "url", href: "/collections" } }, "banner button:");
  // a v3 release
  await putLive(LAG, { v: 3, blocks: { hero: { title: "Live hero" }, home_sections: [{ id: "sec_n1", kind: "new", title: "N", limit: 2 }] }, pages: [], brand: null, theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] });
  const live = await inLag(() => Res.resolvedHomePage());
  same(live, await inLag(compose), "v3:");
  same(live.map((s) => [s.id, s.settings.title]), [["sec_hero", "Live hero"], ["sec_n1", "N"]], "v3 content:");
  // the S59 candidate: this preview's unsaved hero and sections
  const token = await inLag(() => R.previewToken());
  await inLag(() => setPreviewCandidate(token, { hero: { title: "Candidate hero" }, home_sections: [{ id: "sec_c1", kind: "product_rail", title: "C", collection: "old", collection_id: COL(1), limit: 3 }] }));
  const cookies = { [Res.PREVIEW_COOKIE]: token };
  const cand = await asRequest("lag.test", () => inLag(() => Res.resolvedHomePage()), cookies);
  const want = await asRequest("lag.test", () => inLag(compose), cookies);
  same(cand, want, "candidate:");
  same(cand.map((s) => [s.id, s.settings.title]), [["sec_hero", "Candidate hero"], ["sec_c1", "C"]], "candidate content:");
  eq(cand[1].settings.collection.handle, "whey", "candidate rail heals:");
});

// =====================================================================================
console.log("— 8. edge safety");
// =====================================================================================
await t("no node:* import in lib/content/* or lib/cms-mode.js, nor in anything the two readers import", async () => {
  const files = [...(await readdir(join(ROOT, "lib/content"))).filter((f) => f.endsWith(".js")).map((f) => join(ROOT, "lib/content", f)), join(ROOT, "lib/cms-mode.js")];
  // node:async_hooks is the one node: module Next's edge runtime provides
  // (AsyncLocalStorage, used by lib/tenant-context.js on every edge route).
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:(?!async_hooks["'])[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks)["']/;
  for (const f of files) {
    const src = await readFile(f, "utf8");
    const hit = src.match(nodeImport);
    if (hit) throw new Error(`${relative(ROOT, f)} imports ${hit[1]}`);
  }
  // the readers' own import graph
  const seen = new Set();
  const walk = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = await readFile(f, "utf8");
    const hit = src.match(nodeImport);
    if (hit) throw new Error(`${relative(ROOT, f)} (imported by the readers) imports ${hit[1]}`);
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) await walk(resolve(dirname(f), spec.endsWith(".js") ? spec : `${spec}.js`));
  };
  await walk(join(ROOT, "lib/content/documents-reader.js"));
  await walk(join(ROOT, "lib/content/legacy-release.js"));
  ok(seen.size > 5, "the walk found nothing");
});

// =====================================================================================
console.log("— 9. a singleton that ships after the list (registered here, last: it stays registered)");
// =====================================================================================
await t("a singleton with sinceManifest m+1 missing from an older v4 row reads as the code default; with m at its sinceManifest, missing is an error", async () => {
  const old = await publish(DZ, [{ id: "doc_announcement", body: body("announcement", { settings: { enabled: true, text: "Before the new singleton", link: null } }) }], { from: L.emptyList(1, Reg.singletonTypes()) });
  Reg.defineDocumentType({ type: "promo_strip", label: "Promo strip", singleton: true, sinceManifest: 2, settings: [{ key: "text", kind: "text", label: "Text", max: 80, default: "" }] });
  ok(Reg.singletonTypes().includes("promo_strip"), "not registered");
  ok(!Object.hasOwn(old.list.documents, "doc_promo_strip"), "the older list already has it");
  const src = await inDz(() => Res.contentSource());
  eq(src.list.documents.doc_promo_strip, null, "the later singleton is the code default:");
  eq(Docs.entryOf(src.list, "doc_promo_strip"), null, "entryOf:");
  eq((await inDz(() => Res.resolvedAnnouncement())).text, "Before the new singleton", "the older row still renders:");
  // a list at m 2 must carry it
  const { doc_promo_strip: _x, ...docs } = L.emptyList(2, Reg.singletonTypes()).documents;
  await putLive(DZ, { ...old.list, m: 2, documents: { ...old.list.documents, ...docs } });
  const e = await unavailable(inDz(() => Res.contentSource()), "MISSING_SINGLETON", "m 2 without it:");
  eq(e.detail.document, "doc_promo_strip", "names it:");
  await putLive(DZ, { ...old.list, m: 2, documents: { ...old.list.documents, ...docs, doc_promo_strip: null } });
  eq((await inDz(() => Res.contentSource())).list.documents.doc_promo_strip, null, "m 2 with an explicit null:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
