// P2-PERF suite (PERF-01): what the version 4 read path costs per request,
// with the perf fixture as documents-mode content (scripts/perf-docs-fixture.js)
// published through the real publish service (lib/documents/publish.js), at
// 0, 200 and 1,000 journal posts. Counts are per simulated request, under the
// request-cache stub (scripts/support/request-cache.js), with the REAL layout,
// home, policy, checkout and journal page modules and the real sitemap.
//   1. The builder is deterministic (same hash in two processes and in-process).
//   2. Home and a policy page: at most 3 content statements, at every post
//      count; which bytes change with the post count, and why.
//   3. The footer (layout) and the checkout policy links read no page bodies.
//   4. The sitemap and /journal read the journal index once, no per-post read.
//   5. Reported costs (plan sections 2 and 6): the cms_state read a legacy
//      store with no release pays, the journal-index read of an unlisted slug
//      on v4, and the route handlers (/api/upsell, offline, manifest), whose
//      cache() is a no-op.
//   pnpm test:perf-docs
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// next/headers answers for one simulated request at a time (as in
// test-release-readers).
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__perfRequest;
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
process.env.DATABASE_URL = "file:.test-pd-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pd-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const COUNTS = [0, 200, 1000];
const TENANTS = ["d0", "d200", "d1000", "lr", "ln"];
const dbs = [".test-pd-default.db", ".test-pd-platform.db", ...TENANTS.map((t) => `.test-pd-${t}.db`)];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, currentDatabase } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const Res = await import("../lib/content/resolve.js");
const Docs = await import("../lib/content/documents-reader.js");
const F = await import("./perf-docs-fixture.js");
const { runRequest } = await import("./support/request-cache.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");

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
  const c = (v) => JSON.stringify(v);
  if (c(got) !== c(want)) throw new Error(`${m}\n      expected ${c(want).slice(0, 600)}\n      got      ${c(got).slice(0, 600)}`);
};
// What this suite measured, printed at the end for docs/cms-reviews/P2-PERF.md.
const facts = {};

// ---- stores --------------------------------------------------------------------------

const NOW = "2026-11-04T10:00:00.000Z";
async function tenant(id) {
  await C.upsertTenant({
    id,
    name: `PD ${id}`,
    domains: [`${id}.test`],
    dbUrl: `file:.test-pd-${id}.db`,
    config: { site: { name: `PD ${id} Store` }, site_url: `https://${id}.test` },
    secrets: { order_link_secret: `${id}-secret` },
  });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, MIGRATIONS);
    // a small catalog: one collection the fixture's rails and menus name, so
    // the pages reach every code path; the catalog is not what is measured
    const run = (sql, args = []) => libsql.execute({ sql, args });
    await run("INSERT INTO collections (id, handle, title, synced_at, updated_at) VALUES ('gid://shopify/Collection/7000001', 'protein', 'Protein', ?, ?)", [NOW, NOW]);
    await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at, updated_at) VALUES ('gid://shopify/Product/1', 'whey-1', 'Whey 1', 1499, 1499, 'INR', 1, ?, ?)", [NOW, NOW]);
    await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES ('gid://shopify/ProductVariant/1', 'gid://shopify/Product/1', 'Default', 1499, 'INR', 1, 0)");
    await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://shopify/Collection/7000001', 'gid://shopify/Product/1', 0)");
  });
  return T;
}
const host = (id) => `${id}.test`;

// publish.js logs every published id on success; at 1,000 posts that is noise
async function quietly(fn) {
  const log = console.log;
  console.log = (...a) => (typeof a[0] === "string" && a[0].startsWith('{"ts"') ? undefined : log(...a));
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

// documents stores: the fixture at each post count, through publish.js
const FX = {};
const DOC = {};
const LIVE = {};
const started = Date.now();
for (const n of COUNTS) {
  FX[n] = await F.buildDocumentsFixture({ posts: n });
  const T = await tenant(`d${n}`);
  await withTenant(T, async () => {
    await libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
    const pub = await quietly(() => F.publishDocumentsFixture(FX[n]));
    // the documents as created: route ids come from the write service
    LIVE[n] = FX[n].documents.map((d, i) => ({ ...d, id: pub.ids[i] }));
  });
  DOC[n] = T;
}
facts.publishSeconds = Math.round((Date.now() - started) / 100) / 10;
// legacy stores: one with a live v3 release, one before its first publish
const LR = await tenant("lr");
const LN = await tenant("ln");
for (const T of [LR, LN]) {
  await withTenant(T, async () => {
    await S.setBlock("announcement", { enabled: true, text: "Legacy bar", href: "/collections" });
    await S.upsertContentPage({ slug: "refund-policy", title: "Refund policy", family: "page", sections: [{ kind: "text", heading: "Refunds", body: ["Within 14 days."] }] });
  });
}
await withTenant(LR, async () => {
  const rel = await R.createRelease({ note: "perf", actor: "test" });
  await R.publishReleaseById(rel.id);
});

async function liveList(T) {
  return withTenant(T, async () => {
    const r = await libsql.execute("SELECT r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
    return JSON.parse(String(r.rows[0].content));
  });
}

// ---- watching statements -------------------------------------------------------------

// Every statement the tenant's client runs while fn runs, with its arguments
// and the bytes of what came back (rows as JSON).
async function watch(fn) {
  const client = currentDatabase().libsql;
  const execute = client.execute;
  const statements = [];
  client.execute = async (stmt, ...rest) => {
    const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
    const args = typeof stmt === "string" ? [] : stmt?.args || [];
    const r = await execute.call(client, stmt, ...rest);
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
// Content statements, as P2-READ counts them: the release, documents and CMS
// tables. Catalog reads are not content. collection_overrides (the home rails'
// pins, read by lib/cms/section-data.js outside the release) is counted apart.
const CONTENT_SQL = /\b(release_state|releases|document_versions|documents|cms_state|cms_blocks|cms_pages|page_redirects|placements|product_overrides|cms_preview_candidates)\b/i;
const contentOnly = (st) => st.filter((s) => CONTENT_SQL.test(s.sql));
const versionReads = (st) => st.filter((s) => /\bdocument_versions\b/i.test(s.sql));
const pointerReads = (st) => st.filter((s) => /\brelease_state\b/i.test(s.sql));
const cmsStateReads = (st) => st.filter((s) => /\bcms_state\b/i.test(s.sql));
const bytes = (st) => st.reduce((n, s) => n + s.bytes, 0);

// One simulated request on a store.
async function asRequest(T, fn, cookies = {}) {
  globalThis.__perfRequest = { host: host(T.id), cookies };
  try {
    return await runRequest(() => withTenant(T, () => watch(fn)));
  } finally {
    globalThis.__perfRequest = null;
  }
}

// ---- the real pages, compiled with Next's SWC (as test-release-readers does) ------------
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
const NOT_FOUND = "NEXT_NOT_FOUND";
const STUBS = {
  "next/font/google": { Geist: font, Geist_Mono: font, Fraunces: font },
  "../globals.css": {},
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "next/navigation": {
    notFound: () => {
      throw new Error(NOT_FOUND);
    },
  },
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
  // the pages' own components: the pages' reads are what is counted
  "@/components/EmptyCatalog": nothing,
  "@/components/ExperimentPing": nothing,
  "@/components/site/MarketingHome": nothing,
  "@/components/sections/HomeSections": nothing,
  "@/components/preview/ExperimentNote": nothing,
  "@/components/ContentPage": { __esModule: true, default: ({ page }) => React.createElement("h1", { id: "page-title" }, page.title) },
  "@/components/checkout/CheckoutFlow": { __esModule: true, default: ({ policies }) => React.createElement("ul", { id: "policies" }, (policies || []).map((p) => React.createElement("li", { key: p.href }, p.href))) },
};
const Layout = await loadJsx(join(ROOT, "app/(storefront)/layout.js"), STUBS);
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"), STUBS)).default;
const Policy = await loadJsx(join(ROOT, "app/(storefront)/policies/[slug]/page.js"), STUBS);
const Checkout = (await loadJsx(join(ROOT, "app/(storefront)/checkout/page.js"), STUBS)).default;
const Journal = (await loadJsx(join(ROOT, "app/(storefront)/journal/page.js"), STUBS)).default;
const sitemap = (await import(pathToFileURL(join(ROOT, "app/sitemap.js")).href)).default;
const { createCart, addItem, CART_COOKIE } = await import("../lib/cart.js");

// What Next does for one page request: the layout's metadata and the page's,
// then the layout and the page, all in one request (one cache() scope).
const renderLayout = async () => {
  await Layout.generateMetadata();
  return renderToStaticMarkup(await Layout.default({ children: React.createElement("p", { id: "page" }, "page body") }));
};
const homeRequest = (T) => asRequest(T, async () => ({ layout: await renderLayout(), page: renderToStaticMarkup(await Home()) }));
const policyRequest = (T, slug) =>
  asRequest(T, async () => {
    const params = Promise.resolve({ slug });
    const meta = await Policy.generateMetadata({ params });
    let page;
    try {
      page = renderToStaticMarkup(await Policy.default({ params }));
    } catch (e) {
      if (e.message !== NOT_FOUND) throw e;
      page = NOT_FOUND;
    }
    return { meta, layout: await renderLayout(), page };
  });

const policySlug = FX[0].measured.policySlug; // refund-policy, a listed page
const policyTitle = FX[0].measured.policyTitle;

// =====================================================================================
console.log("— 1. the documents fixture builder");
// =====================================================================================
await t("the documents fixture builder is deterministic: the same hash in-process and in two separate processes, and every body publishes", async () => {
  const again = await F.buildDocumentsFixture({ posts: 200 });
  eq(again.hash, FX[200].hash, "in-process, second build:");
  same(again.documents.map((d) => [d.type, d.id, d.slug]), FX[200].documents.map((d) => [d.type, d.id, d.slug]), "types, singleton ids and slugs:");
  const run = () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/perf-docs-fixture.js"), "hash", "--posts", "200"], { cwd: ROOT, encoding: "utf8" });
    eq(r.status, 0, `hash command exit (${r.stderr})`);
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  };
  const a = run();
  const b = run();
  eq(a.hash, b.hash, "two processes:");
  eq(a.hash, FX[200].hash, "a process and this one:");
  same(FX[200].counts, { singletons: 8, pages: 21, campaigns: 4, posts: 200 }, "counts:");
  same(FX[1000].counts, { singletons: 8, pages: 21, campaigns: 4, posts: 1000 }, "counts at 1,000:");
  ok(FX[0].hash !== FX[200].hash && FX[200].hash !== FX[1000].hash, "the post count changes the hash");
  // the 1,000-post store holds the 200-post store's documents (the same posts first)
  const slugs200 = new Set(FX[200].documents.map((d) => d.slug));
  ok(FX[1000].documents.filter((d) => d.type !== "journal" || slugs200.has(d.slug)).length === FX[200].documents.length, "the 200-post documents are a subset of the 1,000-post ones");
});

await t("the fixture was published through publish.js: every document live, 25 listed pages, and a journal index holding every post", async () => {
  for (const n of COUNTS) {
    const list = await liveList(DOC[n]);
    eq(list.pages.length, 25, `listed pages at ${n} posts:`);
    for (const d of LIVE[n].filter((x) => x.type !== "journal")) ok(list.documents[d.id]?.version, `${d.id} live at ${n} posts`);
    if (n === 0) eq(list.indexes.journal, null, "no journal index without posts:");
    else {
      const entries = await withTenant(DOC[n], () => Res.resolvedJournalEntries());
      eq(entries.length, n, `journal entries at ${n}:`);
    }
    const published = await withTenant(DOC[n], async () => Number((await libsql.execute("SELECT count(*) n FROM documents WHERE published_version_id IS NOT NULL")).rows[0].n));
    eq(published, FX[n].documents.length, `documents with a published version at ${n}:`);
  }
});

// =====================================================================================
console.log("— 2. home and a policy page, per request, at 0, 200 and 1,000 posts");
// =====================================================================================
const homeAt = {};
const policyAt = {};
for (const n of COUNTS) {
  homeAt[n] = await homeRequest(DOC[n]);
  policyAt[n] = await policyRequest(DOC[n], policySlug);
}
// The list's own size: what a pointer read returns grows with every entry in
// list.documents. publish.js lists each journal post there (see the test below).
const listBytes = {};
for (const n of COUNTS) listBytes[n] = JSON.stringify(await liveList(DOC[n])).length;
facts.listBytes = listBytes;

await t("home (the REAL layout, its metadata and the home page) issues at most 3 content statements per request at 0, 200 and 1,000 posts, and reads the same versions", async () => {
  const shape = (n) => contentOnly(homeAt[n].statements).map((s) => s.sql.replace(/\?(, \?)*/g, "?").slice(0, 60));
  for (const n of COUNTS) {
    ok(homeAt[n].result.page.includes("Skin first"), `the home page did not render the fixture hero at ${n}: ${homeAt[n].result.page.slice(0, 300)}`);
    ok(homeAt[n].result.layout.includes("Festive sale"), `the layout did not render the fixture bar at ${n}`);
    const c = contentOnly(homeAt[n].statements);
    ok(c.length <= 3, `content statements at ${n} posts: ${c.length}: ${shape(n).join(" | ")}`);
    eq(pointerReads(c).length, 1, `pointer reads at ${n}:`);
    eq(versionReads(c).length, 2, `version reads at ${n} (the chrome set, the home set):`);
    eq(cmsStateReads(c).length, 0, `cms_state reads at ${n}:`);
  }
  same(shape(200), shape(0), "same statements at 200 as at 0:");
  same(shape(1000), shape(0), "same statements at 1,000 as at 0:");
  facts.home = Object.fromEntries(COUNTS.map((n) => [n, { content: contentOnly(homeAt[n].statements).length, all: homeAt[n].statements.length, contentBytes: bytes(contentOnly(homeAt[n].statements)), versionBytes: bytes(versionReads(homeAt[n].statements)), pointerBytes: bytes(pointerReads(homeAt[n].statements)), pinReads: homeAt[n].statements.filter((s) => /collection_overrides/i.test(s.sql)).length }]));
});

await t("a policy page (the REAL layout plus the policy page module, metadata included) issues at most 3 content statements at 0, 200 and 1,000 posts, and reads only its own page version", async () => {
  for (const n of COUNTS) {
    ok(policyAt[n].result.page.includes(policyTitle), `the policy page did not render at ${n}: ${policyAt[n].result.page.slice(0, 200)}`);
    eq(policyAt[n].result.meta.title, policyTitle, `metadata title at ${n}:`);
    const c = contentOnly(policyAt[n].statements);
    ok(c.length <= 3, `content statements at ${n} posts: ${c.length}: ${c.map((s) => s.sql.slice(0, 60)).join(" | ")}`);
    const list = await liveList(DOC[n]);
    const pageDoc = list.pages.find((p) => p.slug === policySlug).document;
    const chrome = Docs.CHROME_DOCUMENTS.map((d) => list.documents[d]?.version).filter(Boolean).sort();
    const sets = versionReads(c).map((s) => [...s.args].sort());
    same(sets.sort((a, b) => a.length - b.length), [[list.documents[pageDoc].version], chrome], `version reads at ${n} (its own version, then the chrome set):`);
    ok(!c.some((s) => list.indexes.journal && s.args.includes(list.indexes.journal.version)), `the journal index was read at ${n}`);
  }
  facts.policy = Object.fromEntries(COUNTS.map((n) => [n, { content: contentOnly(policyAt[n].statements).length, all: policyAt[n].statements.length, contentBytes: bytes(contentOnly(policyAt[n].statements)), versionBytes: bytes(versionReads(policyAt[n].statements)), pointerBytes: bytes(pointerReads(policyAt[n].statements)) }]));
});

await t("home and policy: every version body read is byte-identical at 0, 200 and 1,000 posts (no post, index or page body rides along)", async () => {
  for (const n of [200, 1000]) {
    eq(bytes(versionReads(homeAt[n].statements)), bytes(versionReads(homeAt[0].statements)), `home version bytes at ${n} vs 0:`);
    eq(bytes(versionReads(policyAt[n].statements)), bytes(versionReads(policyAt[0].statements)), `policy version bytes at ${n} vs 0:`);
    const nonPointer = (st) => bytes(contentOnly(st).filter((s) => !/\brelease_state\b/i.test(s.sql)));
    eq(nonPointer(homeAt[n].statements), nonPointer(homeAt[0].statements), `home content bytes outside the pointer read at ${n}:`);
    eq(nonPointer(policyAt[n].statements), nonPointer(policyAt[0].statements), `policy content bytes outside the pointer read at ${n}:`);
  }
});

// KNOWN DEFECT, measured (P2-PERF.md, finding 1): the pointer read returns the
// whole release list, and publish.js puts every published journal post into
// list.documents (makeBuild: a documents entry for every document in the set,
// posts included). So the pointer read, and with it every storefront request,
// grows by one list entry per post. This test pins the cause and the size, so
// a fix (posts only in indexes.journal) shows up here as a failure to update.
await t("MEASURED, not a pass of the PERF-01 byte claim: the pointer read grows with the post count only by the journal posts' list.documents entries", async () => {
  for (const n of [200, 1000]) {
    const list = await liveList(DOC[n]);
    const postIds = LIVE[n].filter((d) => d.type === "journal").map((d) => d.id);
    const inDocuments = postIds.filter((id) => Object.hasOwn(list.documents, id));
    eq(inDocuments.length, n, `posts listed in list.documents at ${n}:`);
    // the list without those entries is the 0-post list's size, give or take the ids
    const trimmed = { ...list, documents: Object.fromEntries(Object.entries(list.documents).filter(([id]) => !postIds.includes(id))) };
    const base = await liveList(DOC[0]);
    eq(Object.keys(trimmed.documents).length, Object.keys(base.documents).length, `documents outside the posts at ${n}:`);
    const growth = bytes(pointerReads(homeAt[n].statements)) - bytes(pointerReads(homeAt[0].statements));
    ok(growth > 0, `the pointer read grows at ${n}`);
    facts[`pointerGrowth${n}`] = { bytes: growth, perPost: Math.round(growth / n) };
    eq(bytes(pointerReads(policyAt[n].statements)) - bytes(pointerReads(policyAt[0].statements)), growth, `policy pays the same growth at ${n}:`);
  }
});

// =====================================================================================
console.log("— 3. footer links and checkout policy links read no page bodies");
// =====================================================================================
await t("the footer (the REAL layout's chromeData) reads only the chrome set, and the REAL checkout's policyLinks reads no version at all, at 0, 200 and 1,000 posts", async () => {
  for (const n of COUNTS) {
    const T = DOC[n];
    const list = await liveList(T);
    const chrome = new Set(Docs.CHROME_DOCUMENTS.map((d) => list.documents[d]?.version).filter(Boolean));
    const lay = await asRequest(T, () => renderLayout());
    eq(versionReads(lay.statements).length, 1, `layout version reads at ${n}:`);
    for (const a of versionReads(lay.statements)[0].args) ok(chrome.has(a), `the layout read a version outside the chrome set at ${n}: ${a}`);
    ok(lay.result.includes(`/policies/${policySlug}`), `footer policy link missing at ${n}`);
    const cartId = `cart_pd_${n}`;
    await withTenant(T, async () => {
      await createCart(cartId);
      await addItem(cartId, "gid://shopify/ProductVariant/1", 1);
    });
    const co = await asRequest(T, async () => renderToStaticMarkup(await Checkout()), { [CART_COOKIE]: cartId });
    ok(co.result.includes(`/policies/${policySlug}`) || co.result.includes("/policies/"), `checkout policy links missing at ${n}: ${co.result.slice(0, 300)}`);
    eq(versionReads(co.statements).length, 0, `checkout version reads at ${n}:`);
    if (list.indexes.journal) ok(![...lay.statements, ...co.statements].some((s) => s.args.includes(list.indexes.journal.version)), `the journal index was read at ${n}`);
    // no page or post body anywhere: every version read is a chrome version
    const pageVersions = new Set(list.pages.map((p) => list.documents[p.document]?.version));
    ok(![...lay.statements, ...co.statements].some((s) => s.args.some((a) => pageVersions.has(a))), `a page body was read at ${n}`);
  }
});

// =====================================================================================
console.log("— 4. the sitemap and /journal read the journal index once");
// =====================================================================================
await t("the REAL sitemap.xml and /journal read the journal index once at 200 and 1,000 posts, with no per-post read", async () => {
  facts.journal = {};
  for (const n of [200, 1000]) {
    const T = DOC[n];
    const list = await liveList(T);
    const idx = list.indexes.journal.version;
    const map = await asRequest(T, () => sitemap());
    eq(map.result.filter((e) => e.url.includes("/journal/")).length, n, `sitemap posts at ${n}:`);
    same(versionReads(map.statements).map((s) => s.args), [[idx]], `sitemap version reads at ${n}:`);
    eq(contentOnly(map.statements).length, 2, `sitemap content statements at ${n} (pointer, index):`);
    const j = await asRequest(T, async () => renderToStaticMarkup(await Journal()));
    eq((j.result.match(/href="\/journal\//g) || []).length, n, `/journal posts at ${n}:`);
    same(versionReads(j.statements).map((s) => s.args), [[idx]], `/journal version reads at ${n}:`);
    eq(contentOnly(j.statements).length, 2, `/journal content statements at ${n}:`);
    facts.journal[n] = { sitemapIndexBytes: bytes(versionReads(map.statements)), journalIndexBytes: bytes(versionReads(j.statements)) };
  }
});

// =====================================================================================
console.log("— 5. reported costs (plan sections 2 and 6)");
// =====================================================================================
await t("REPORTED: a legacy store with no release pays one cms_state statement per request; with a live release it pays none", async () => {
  const lnHome = await homeRequest(LN);
  const lrHome = await homeRequest(LR);
  ok(lnHome.result.layout.includes("Legacy bar") && lrHome.result.layout.includes("Legacy bar"), "both legacy stores render their bar");
  eq(cmsStateReads(lnHome.statements).length, 1, "cms_state statements, no release (layout plus home):");
  eq(cmsStateReads(lrHome.statements).length, 0, "cms_state statements, live v3 release:");
  const lnPolicy = await policyRequest(LN, "refund-policy");
  eq(cmsStateReads(lnPolicy.statements).length, 1, "cms_state statements, no release (policy):");
  eq(lnPolicy.result.meta.title, "Refund policy", "the draft page serves:");
  facts.legacyNoRelease = { homeContent: contentOnly(lnHome.statements).length, homeContentWithRelease: contentOnly(lrHome.statements).length, cmsStateBytes: bytes(cmsStateReads(lnHome.statements)) };
});

await t("REPORTED: on v4, a slug that is not a listed page (a default page such as /about, or a 404) reads the journal index once, and that read grows with the post count", async () => {
  facts.unlisted = {};
  for (const n of COUNTS) {
    const T = DOC[n];
    const list = await liveList(T);
    const about = await asRequest(T, () => Res.resolvedContentPage("about"));
    // the code default pages are the brand tenant's only; here /about is a 404
    ok(about.result === null || about.result.slug === "about", `/about at ${n}: ${JSON.stringify(about.result).slice(0, 120)}`);
    const missing = await policyRequest(T, "no-such-page");
    eq(missing.result.page, NOT_FOUND, `a 404 at ${n}:`);
    const idx = list.indexes.journal?.version;
    for (const [what, r] of [["about", about], ["404", missing]]) {
      const reads = versionReads(r.statements).filter((s) => idx && s.args.includes(idx));
      eq(reads.length, n === 0 ? 0 : 1, `${what} journal index reads at ${n}:`);
    }
    facts.unlisted[n] = { indexBytes: idx ? bytes(versionReads(about.statements).filter((s) => s.args.includes(idx))) : 0, aboutContent: contentOnly(about.statements).length, notFoundContent: contentOnly(missing.statements).length };
  }
  ok(facts.unlisted[1000].indexBytes > facts.unlisted[200].indexBytes, "the index read grows with the posts");
});

await t("REPORTED: route handlers (/api/upsell, offline, manifest) run outside cache(): each call pays its own pointer read, and a legacy store with no release pays cms_state on every call", async () => {
  const upsell = (await import("../app/api/upsell/route.js")).GET;
  const offline = (await import("../app/(storefront)/offline/route.js")).GET;
  const manifest = (await import("../app/manifest.webmanifest/route.js")).GET;
  const req = (T, path) => ({ headers: { get: (k) => (k.toLowerCase() === "host" ? host(T.id) : null) }, nextUrl: new URL(`https://${host(T.id)}${path}`), url: `https://${host(T.id)}${path}` });
  facts.handlers = {};
  for (const [label, T] of [["v4, 1,000 posts", DOC[1000]], ["legacy, no release", LN], ["legacy, live v3", LR]]) {
    const row = {};
    for (const [name, fn, path] of [["/api/upsell", upsell, "/api/upsell?exclude="], ["/offline", offline, "/offline"], ["/manifest.webmanifest", manifest, "/manifest.webmanifest"]]) {
      // two calls in a row: no cache() between them, so each pays in full
      const r = await withTenant(T, () => watch(async () => [await fn(req(T, path)), await fn(req(T, path))]));
      eq(r.result[0].status, 200, `${name} on ${label}:`);
      const c = contentOnly(r.statements);
      row[name] = { contentPerCall: c.length / 2, pointerPerCall: pointerReads(c).length / 2, cmsStatePerCall: cmsStateReads(c).length / 2, versionReadsPerCall: versionReads(c).length / 2 };
      eq(pointerReads(c).length, 2, `${name} on ${label}: a pointer read per call:`);
      eq(cmsStateReads(c).length, label === "legacy, no release" ? 2 : 0, `${name} on ${label}: cms_state reads over two calls:`);
    }
    facts.handlers[label] = row;
  }
});

console.log(`\nmeasured: ${JSON.stringify(facts)}`);
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
