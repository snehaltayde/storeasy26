// P4-SEAM suite (MIG-02, MIG-01): every resolved* getter against a given
// content source.
//   1. Parity: for each state the a6d028e fixtures record (legacy drafts, the
//      S59 candidate preview, a v1, v2 and v3 release) and for the documents
//      states (a v4 release, a v4 preview, the closed store),
//      contentGettersFor(<the source contentSource() built>) answers exactly
//      as the exported getters do in the same request; for v1, v2 and v3 it
//      also answers exactly as a6d028e recorded.
//   2. A candidate v4 list whose versions exist only in memory (the bodies
//      map) resolves every non-entity getter, with no document_versions read;
//      the answers equal those of the same list really published elsewhere.
//      A mixed map reads only the versions it lacks; a held body is checked
//      like a stored one.
//   3. Edge safety and no held source: no node: import reachable from
//      resolve.js (only lib/tenant-context.js's node:async_hooks, which the
//      edge runtime provides, as before); no module-level variable in
//      resolve.js or documents-reader.js holds a source.
//   4. A shopper request never sees a candidate's bodies or entity rows: two
//      candidate runs in sequence, then the request-shaped call, in the same
//      request and in a fresh one.
//   pnpm test:content-seam
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// next/headers answers for one simulated request at a time; outside one,
// headers() and cookies() throw, as Next's own do.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__seamRequest;
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
process.env.DATABASE_URL = "file:.test-seam-default.db";
process.env.PLATFORM_DB_URL = "file:.test-seam-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const TENANTS = ["vgl", "dv", "dm"];
const dbs = [".test-seam-default.db", ".test-seam-platform.db", ...TENANTS.map((t) => `.test-seam-${t}.db`)];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, currentDatabase } = await import("../lib/db.js");
const R = await import("../lib/releases.js");
const Res = await import("../lib/content/resolve.js");
const L = await import("../lib/documents/release-list.js");
const ids = await import("../lib/documents/ids.js");
const { commitPublishBatch } = await import("../lib/documents/commit.js");
const Reg = await import("../lib/registry/index.js");
const PS = await import("../lib/preview-sessions.js");
const { setPreviewCandidate } = await import("../lib/cms/candidates.js");
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
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const same = (got, want, m = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${m}\n      expected ${canon(want).slice(0, 600)}\n      got      ${canon(got).slice(0, 600)}`);
};
// The a6d028e recorder's shape: { ok: value } or { threw, message }.
const settle = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { threw: String(e?.code || e?.name || "Error"), message: String(e?.message || e) };
  }
};

// ---- tenants: the a6d028e recorder's catalog and tables (scripts/support/legacy-release-outputs.js) ----

const P = (n) => `gid://shopify/Product/${n}`;
const COL = (n) => `gid://shopify/Collection/${n}`;
const NOW = "2026-01-01T00:00:00.000Z";

async function tenant(id, name) {
  await C.upsertTenant({
    id,
    name,
    domains: [`${id}.test`],
    dbUrl: `file:.test-seam-${id}.db`,
    config: { site: { name } },
    secrets: { order_link_secret: `${id}-link-secret` },
  });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, MIGRATIONS);
    const run = (sql, args = []) => libsql.execute({ sql, args });
    await run("INSERT INTO collections (id, handle, title, synced_at) VALUES (?, 'whey', 'Whey', ?), (?, 'serums', 'Serums', ?)", [COL(1), NOW, COL(2), NOW]);
    for (const [n, handle, title, price] of [
      [1, "glow-serum", "Glow Serum", 1299],
      [2, "night-cream", "Night Cream", 899],
      [3, "whey-gold", "Whey Gold", 2499],
    ]) {
      await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?)", [P(n), handle, title, price, price, NOW]);
      await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${n}`, P(n), price]);
    }
    await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0), (?, ?, 1), (?, ?, 0)", [COL(2), P(1), COL(2), P(2), COL(1), P(3)]);
    await run("INSERT INTO product_overrides (product_id, modules, badge) VALUES (?, ?, 'TABLE')", [P(1), JSON.stringify([{ title: "From the table", html: "<p>table</p>" }])]);
    await run("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(2), JSON.stringify([P(2)])]);
    await run(
      "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position) VALUES ('pl_tbl_pairs', 'pdp_pairs', ?, ?, 'Table pairs', 1, 0), ('pl_tbl_cart', 'cart_upsell', NULL, ?, 'Table upsell', 1, 0)",
      [P(1), JSON.stringify([P(3)]), JSON.stringify([P(2)])],
    );
    await run("INSERT INTO page_redirects (from_slug, to_slug, created_at) VALUES ('old-post', 'table-post', ?)", [NOW]);
  });
  return T;
}

// vgl: the a6d028e recorder's own tenant (same id, name and rows), legacy mode.
const VGL = await tenant("vgl", "Legacy Outputs");
// dv: a documents store with a v4 release. Same catalog and site name, so a
// candidate on vgl and the real release on dv must answer alike.
const DV = await tenant("dv", "Legacy Outputs");
// dm: a documents store that never published (closed).
const DM = await tenant("dm", "Legacy Outputs");
const setMode = (T, mode) => withTenant(T, () => libsql.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] }));
await setMode(DV, "documents");
await setMode(DM, "documents");

// One simulated request: next/headers answers for this host and cookies, and
// the request-cache stub memoizes per request.
async function asRequest(T, fn, cookies = {}) {
  globalThis.__seamRequest = { host: `${T.id}.test`, cookies };
  try {
    return await runRequest(() => withTenant(T, fn));
  } finally {
    globalThis.__seamRequest = null;
  }
}

async function putLive(T, id, content) {
  await withTenant(T, async () => {
    await libsql.execute({
      sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)",
      args: [id, R.stableStringify(content), `hash_${id}`, `note ${id}`, NOW, NOW],
    });
    await libsql.execute({ sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", args: [id, NOW] });
  });
}
const clearLive = (T) => withTenant(T, () => libsql.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1"));

// Statements the current tenant's client runs while fn runs, with arguments.
async function watch(fn) {
  const client = currentDatabase().libsql;
  const execute = client.execute;
  const statements = [];
  client.execute = async (stmt, ...rest) => {
    statements.push({ sql: typeof stmt === "string" ? stmt : String(stmt?.sql ?? ""), args: typeof stmt === "string" ? [] : [...(stmt?.args || [])] });
    return execute.call(client, stmt, ...rest);
  };
  try {
    return { result: await fn(), statements };
  } finally {
    delete client.execute;
  }
}
const versionReads = (st) => st.filter((s) => /document_versions/i.test(s.sql));

// ---- the legacy envelopes: exactly scripts/support/legacy-release-outputs.js's ---------

const blocksV1 = {
  hero: { title: "Live hero v1", subtitle: "Frozen words", primary: { label: "Shop", href: "/collections/whey" } },
  announcement: { enabled: true, text: "Free shipping this week", href: "/collections/serums" },
  nav_header: [
    { label: "Serums", href: "/collections/serums" },
    { label: "", href: "/no-label" },
    { label: "About", href: "/about", children: [{ label: "Contact", href: "/contact" }] },
  ],
  nav_footer: [{ label: "Whey", href: "/collections/whey" }],
  home_sections: [
    { kind: "new", title: "New in", limit: 4 },
    { kind: "product_rail", title: "Serums", collection: "serums", collection_id: COL(2), limit: 4 },
    { kind: "not-a-kind", title: "Dropped" },
    { kind: "new", title: "Disabled", enabled: false },
  ],
  collections_index: { featured: ["serums"], order: ["whey", "serums"] },
  pdp_extras: [
    { title: "How to use", html: "<p>Twice daily</p>" },
    { title: "Hidden", html: "<p>x</p>", enabled: false },
    { title: "", html: "<p>no title</p>" },
  ],
};
const pagesV1 = [
  { slug: "about", title: "About us", description: "Who we are", sections: [{ heading: "Story", body: ["We began."] }], enabled: true },
  { slug: "shipping", title: "Shipping", description: "", sections: [{ kind: "text", heading: "Times", body: ["Two days"] }], enabled: true, effective_at: "2026-01-01" },
  { slug: "hidden-page", title: "Hidden", description: "", sections: [], enabled: false },
  { slug: "spring", title: "Spring sale", description: "", sections: [], enabled: true, family: "campaign", window_start: "2026-03-01", window_end: "2026-03-31" },
];
const brand = { accent: "#0d9488" };
const theme = { kit: "glow", version: 1 };
const LEGACY = {
  v1: { v: 1, blocks: blocksV1, pages: pagesV1, brand, theme: null },
  v2: {
    v: 2,
    blocks: { ...blocksV1, hero: { ...blocksV1.hero, title: "Live hero v2" }, surface_templates: { product: "editorial" } },
    pages: pagesV1,
    brand,
    theme,
    product_overrides: [{ product_id: P(1), modules: [{ title: "Frozen module", html: "<p>frozen</p>" }], badge: "FROZEN" }],
    collection_pins: [{ collection_id: COL(2), pinned: [P(1)] }],
    placements: [
      { id: "pl_frz_pairs", kind: "pdp_pairs", source_product_id: P(1), target_product_ids: [P(2)], title: "Frozen pairs", enabled: true, position: 0 },
      { id: "pl_frz_cart", kind: "cart_upsell", source_product_id: null, target_product_ids: [P(3)], title: "Frozen upsell", enabled: true, position: 0 },
    ],
    redirects: [{ from_slug: "old-post", to_slug: "frozen-post" }],
  },
  v3: {
    v: 3,
    blocks: {
      ...blocksV1,
      hero: { ...blocksV1.hero, title: "Live hero v3" },
      home_sections: [
        { id: "sec_aa11", kind: "new", title: "New in", limit: 4 },
        { id: "sec_bb22", kind: "product_rail", title: "Serums", collection: "old-handle", collection_id: COL(2), limit: 4 },
      ],
      collections_index: { featured: ["old-whey"], order: ["serums"], ids: { "old-whey": COL(1) } },
      surface_templates: { product: "editorial", header: "centered", footer: "minimal" },
    },
    pages: [...pagesV1.slice(1), { slug: "about", title: "About", description: "", sections: [{ id: "sec_cc33", kind: "text", heading: "Story", body: ["v3"] }], enabled: true }],
    brand: null,
    theme,
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  },
};

// The recorder's getter calls (the a6d028e JSON's keys), plus the getters it
// did not record and the v4 arguments.
const RECORDED = [
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
  ["resolvedContentPage", ["no-such-page"]],
  ["resolvedContentPageList", []],
  ["resolvedBrand", []],
  ["resolvedTheme", []],
  ["resolvedSurfaceTemplates", []],
  ["resolvedSurfaceTemplateFor", ["product", P(1)]],
  ["resolvedProductOverride", [P(1)]],
  ["resolvedProductOverride", [P(2)]],
  ["resolvedCollectionPins", ["serums"]],
  ["resolvedCollectionPins", ["no-such-collection"]],
  ["resolvedPdpPairs", [P(1)]],
  ["resolvedCartUpsell", [[]]],
  ["resolvedSlugRedirect", ["old-post"]],
];
const CALLS = [
  ...RECORDED,
  ["resolvedHomePage", []],
  ["resolvedJournalEntries", []],
  ["resolvedContentPage", ["first-post"]],
  ["resolvedContentPage", ["shipping"]],
  ["resolvedSurfaceTemplateFor", ["pdp", P(1)]],
  ["resolvedSurfaceTemplateFor", ["collection", COL(2)]],
  ["resolvedSurfaceTemplateFor", ["header", null]],
  ["resolvedPdpPairs", [P(1), { limit: 2 }]],
  ["resolvedCartUpsell", [[P(3)], { limit: 1 }]],
  ["resolvedSlugRedirect", ["old-about"]],
  ["resolvedSlugRedirect", ["about"]],
];
const key = (fn, args) => `${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`;
const RESOLVED = Object.keys(Res).filter((k) => /^resolved[A-Z]/.test(k)).sort();
// The getters that do not read product or collection content (OVL07 makes
// those read src.entityRows): every one but these three.
const ENTITY = ["resolvedProductOverride", "resolvedCollectionPins", "resolvedPdpPairs"];

// Every call, through the exported getters and through contentGettersFor(src)
// for the src contentSource() built, in one request.
async function both(T, cookies = {}, calls = CALLS) {
  return asRequest(
    T,
    async () => {
      const src = await Res.contentSource();
      const G = Res.contentGettersFor(src);
      const seam = {};
      const real = {};
      for (const [fn, args] of calls) {
        const k = key(fn, args);
        seam[k] = JSON.parse(JSON.stringify(await settle(() => G[fn](...args))));
        real[k] = JSON.parse(JSON.stringify(await settle(() => Res[fn](...args))));
      }
      return { src, seam, real };
    },
    cookies,
  );
}
const sameAll = (a, b, label) => {
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) throw new Error(`${label} ${k}:\n      seam ${JSON.stringify(a[k]).slice(0, 400)}\n      real ${JSON.stringify(b[k]).slice(0, 400)}`);
};

// ---- v4 fixtures, through the real commit (as test-release-readers builds them) ---------

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

async function versionOf(id, b) {
  const canonical = R.stableStringify(b);
  return { id: ids.verId(), document_id: id, kind: "published", body: canonical, body_hash: await R.sha256Hex(canonical), schema_version: 1, created_at: NOW };
}
async function ensureDocument(id, type, slug = null) {
  await libsql.execute({
    sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, 1, 1, ?, ?) ON CONFLICT(id) DO NOTHING",
    args: [id, type, slug, id, `dh_${id}`, NOW, NOW],
  });
  return Number((await libsql.execute({ sql: "SELECT revision FROM documents WHERE id = ?", args: [id] })).rows[0].revision);
}

// The v4 list and its versions (never written): what a dry run holds.
async function buildList(items, posts) {
  const versions = [];
  const changes = [];
  for (const it of items) {
    const { ok: valid, issues } = Reg.validateDocument(it.body, { mode: "publish" });
    if (!valid) throw new Error(`fixture ${it.id} does not validate: ${JSON.stringify(issues.filter((i) => i.severity !== "warning")).slice(0, 400)}`);
    const v = await versionOf(it.id, it.body);
    versions.push({ ...v, type: it.body.type, slug: it.body.meta?.slug || null });
    const route = Reg.documentType(it.body.type)?.route && it.body.type !== "journal";
    changes.push({ document: it.id, entry: { version: v.id, hash: v.body_hash }, pages: route ? [pageRow(it.body)] : [], redirects: it.redirects || [] });
  }
  const entries = [];
  for (const p of posts) {
    const id = `doc_j${p.slug.replace(/[^a-z0-9]/g, "")}`;
    const b = body("journal", { meta: { slug: p.slug, title: p.title, description: p.description ?? "", enabled: p.enabled !== false, window_start: p.window_start ?? null, window_end: p.window_end ?? null }, sections: [sec("text", "sec_jt", { title: p.title, body: [`Body of ${p.slug}`] })] });
    const v = await versionOf(id, b);
    versions.push({ ...v, type: "journal", slug: p.slug });
    entries.push({ document: id, version: v.id, slug: p.slug, title: p.title, description: p.description ?? "", enabled: p.enabled !== false, family: "journal", effective_at: null, window_start: p.window_start ?? null, window_end: p.window_end ?? null });
  }
  const ji = await versionOf("doc_journal_index", L.journalIndexBody(entries));
  versions.push({ ...ji, type: "journal_index", slug: null });
  changes.push({ index: "journal", entry: { version: ji.id, hash: ji.body_hash } });
  const list = L.setEntries(L.emptyList(1, Reg.singletonTypes()), changes);
  return { list, versions };
}

// Write those versions and put the list live through commitPublishBatch.
async function publishBuilt(T, { list, versions }) {
  return withTenant(T, async () => {
    const live = (await libsql.execute("SELECT live_release_id AS live FROM release_state WHERE id = 1")).rows[0]?.live ?? null;
    const build = { releaseId: ids.relId(), setId: ids.setId(), pointer: live, versions: [], documents: [], log: [], actor: "test", now: NOW, list };
    for (const v of versions) {
      const revision = await ensureDocument(v.document_id, v.type, v.slug);
      const { type: _t, slug: _s, ...row } = v;
      build.versions.push(row);
      build.documents.push({ id: v.document_id, revision, published_version_id: v.id, published_hash: v.body_hash });
      if (v.type !== "journal_index") build.log.push({ id: ids.logId(), document_id: v.document_id, action: "publish", to_version_id: v.id });
    }
    const r = await commitPublishBatch(build);
    if (r.outcome !== "ok") throw new Error(`publish: ${JSON.stringify(r).slice(0, 300)}`);
    return build;
  });
}

const bodiesOf = (versions) => new Map(versions.map((v) => [v.id, { document_id: v.document_id, body: JSON.parse(v.body) }]));

function fullStore(tag = "Docs") {
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
    { id: "doc_announcement", body: body("announcement", { settings: { enabled: true, text: `${tag} bar`, link: { type: "url", href: "/collections/serums" } } }) },
    { id: "doc_design", body: body("design", { settings: { brand: { accent: "#0d9488" }, theme: { kit: "glow", version: 1 } } }) },
    {
      id: "doc_home",
      body: body("home", {
        sections: [
          sec("hero", "sec_hero", { title: `${tag} hero`, highlight: "Docs", subtitle: "Fresh words", primary: { label: "Shop whey", link: { type: "collection", handle: "whey" } }, secondary: null, badge: "", image: { media: "/api/media/hero.jpg", alt: "A jar" } }),
          sec("new", "sec_new1", { title: "New in", limit: 4 }),
          sec("product_rail", "sec_rail1", { title: "Serums", collection: { handle: "old-handle", id: COL(2) }, limit: 4 }),
          sec("banner", "sec_hidden", { title: "Hidden banner", text: "x" }, { enabled: false }),
          sec("faq", "sec_faq1", { title: "Questions", items: [{ q: "Ship?", a: "<p>Yes</p>" }] }),
        ],
      }),
    },
    { id: "doc_collections_index", body: body("collections_index", { settings: { featured: [{ handle: "old-whey", id: COL(1) }], order: [{ handle: "serums" }], hide: [] } }) },
    { id: "doc_product_layout", body: body("product_layout", { settings: { template: "editorial" }, sections: [sec("product_main", "sec_main"), sec("rich_text", "sec_howto", { title: "How to use", html: "<p>Twice daily</p>" })] }) },
    { id: "doc_collection_layout", body: body("collection_layout", { settings: { template: "sidebar" }, sections: [] }) },
    { id: "doc_cart", body: body("cart", { settings: { title: "Add these", products: [{ handle: "whey-gold" }] } }) },
    {
      id: "doc_about",
      body: body("page", { meta: { slug: "about", title: `About ${tag}`, description: "Who we are" }, sections: [sec("text", "sec_story", { title: "Story", body: ["We began."] })] }),
      redirects: [{ from_slug: "old-about", to_slug: "about" }],
    },
    { id: "doc_shipping", body: body("page", { meta: { slug: "shipping", title: "Shipping", effective_at: "2026-01-01" }, sections: [sec("rich_text", "sec_ship", { title: "Times", html: "<p>Two days</p>" })] }) },
    { id: "doc_hiddenpage", body: body("page", { meta: { slug: "hidden-page", title: "Hidden", enabled: false }, sections: [sec("text", "sec_hp", { title: "x" })] }) },
    { id: "doc_spring", body: body("campaign", { meta: { slug: "spring", title: "Spring sale", window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" }, sections: [sec("text", "sec_sp", { title: "Sale" })] }) },
  ];
}
const POSTS = [
  { slug: "first-post", title: "First post", description: "Hello", window_start: "2025-05-01T00:00:00.000Z" },
  { slug: "future-post", title: "Not yet", window_start: "2099-01-01T00:00:00.000Z" },
  { slug: "off-post", title: "Switched off", enabled: false },
];

const DV_BUILT = await buildList(fullStore("Docs"), POSTS);
await publishBuilt(DV, DV_BUILT);
const A6 = JSON.parse(await readFile(join(here, "fixtures/legacy-release-outputs.a6d028e.json"), "utf8"));

// =====================================================================================
console.log("— 1. contentGettersFor(the source contentSource() built) answers as the getters do");
// =====================================================================================
await t("contentGettersFor binds every exported resolved* getter, by the same name", async () => {
  const G = Res.contentGettersFor({ mode: "draft", content: null, preview: false });
  same(Object.keys(G).sort(), RESOLVED, "bound getters:");
  ok(RESOLVED.length >= 19, `only ${RESOLVED.length} getters`);
  ok(Object.isFrozen(G), "the bound set is frozen");
  let threw = false;
  try {
    Res.contentGettersFor(null);
  } catch {
    threw = true;
  }
  ok(threw, "no source is refused");
});

await t("legacy drafts (no release, the a6d028e drafts state): every call equal", async () => {
  await clearLive(VGL);
  const { src, seam, real } = await both(VGL);
  eq(src.mode, "draft", "mode:");
  sameAll(seam, real, "drafts");
});

await t("legacy preview with the S59 candidate (a6d028e candidate state): every call equal, the candidate shows", async () => {
  await clearLive(VGL);
  const token = await withTenant(VGL, () => R.previewToken());
  await withTenant(VGL, () => setPreviewCandidate(token, { hero: { title: "Candidate hero" }, announcement: { text: "Candidate bar" }, home_sections: [{ id: "sec_c1", kind: "product_rail", title: "C", collection: "old", collection_id: COL(1), limit: 3 }] }));
  const { src, seam, real } = await both(VGL, { [Res.PREVIEW_COOKIE]: token });
  eq(src.preview, true, "preview:");
  ok(src.candidate, "the candidate is on the source");
  sameAll(seam, real, "candidate");
  eq(seam["resolvedHero()"].ok.title, "Candidate hero", "the candidate hero:");
});

for (const name of ["v1", "v2", "v3"]) {
  await t(`${name} release: every call equal, and the recorded calls equal a6d028e's answers`, async () => {
    await putLive(VGL, `rel_fixture_${name}`, LEGACY[name]);
    const { src, seam, real } = await both(VGL);
    eq(src.mode, "live", "mode:");
    sameAll(seam, real, name);
    const want = A6.fixtures[name];
    for (const [fn, args] of RECORDED) {
      const k = key(fn, args);
      ok(Object.hasOwn(want, k), `a6d028e has no ${k}`);
      if (JSON.stringify(seam[k]) !== JSON.stringify(want[k])) throw new Error(`${name} ${k} differs from a6d028e:\n now  ${JSON.stringify(seam[k]).slice(0, 300)}\n then ${JSON.stringify(want[k]).slice(0, 300)}`);
    }
  });
}

await t("a v4 release: every call equal (contentSource carries no bodies and no entity rows)", async () => {
  const { src, seam, real } = await both(DV);
  eq(src.v, 4, "v:");
  eq(src.preview, false, "preview:");
  ok(!("bodies" in src) && !("entityRows" in src), "a live source carries no bodies or entity rows");
  sameAll(seam, real, "v4");
  eq(seam["resolvedAnnouncement()"].ok.text, "Docs bar", "the release's bar:");
  eq(seam['resolvedContentPage("first-post")'].ok.title, "First post", "a journal post:");
});

await t("a v4 documents preview (a valid session, a draft laid over): every call equal", async () => {
  await withTenant(DV, () =>
    libsql.execute({ sql: "UPDATE documents SET draft = ?, draft_hash = 'dh_preview' WHERE id = 'doc_announcement'", args: [JSON.stringify(body("announcement", { settings: { enabled: true, text: "Draft bar", link: null } }))] }),
  );
  const s = await withTenant(DV, () => PS.createPreviewSession({ actor: { kind: "merchant", id: "u_seam" } }));
  const { src, seam, real } = await both(DV, { [Res.PREVIEW_COOKIE]: s.token });
  eq(src.preview, true, "preview:");
  sameAll(seam, real, "v4 preview");
  eq(seam["resolvedAnnouncement()"].ok.text, "Draft bar", "the draft shows:");
  await withTenant(DV, () => PS.revokePreviewSession({ sid: s.sid }));
});

await t("the closed store (documents mode, never published): every call equal", async () => {
  const { src, seam, real } = await both(DM);
  eq(src.mode, "closed", "mode:");
  sameAll(seam, real, "closed");
});

// =====================================================================================
console.log("— 2. a candidate list whose versions exist only in memory");
// =====================================================================================
// vgl is a legacy store with a v3 release live: what the cutover's data check
// will run on. The candidate is DV's very list and versions, never written to vgl.
await t("candidateSource builds the documented shape, checks the list, and freezes it", async () => {
  const src = Res.candidateSource({ list: DV_BUILT.list, releaseId: "rel_candidate", bodies: bodiesOf(DV_BUILT.versions) });
  same(
    { mode: src.mode, v: src.v, releaseId: src.releaseId, content: src.content, preview: src.preview },
    { mode: "live", v: 4, releaseId: "rel_candidate", content: null, preview: false },
    "shape:",
  );
  ok(src.bodies instanceof Map && src.bodies.size === DV_BUILT.versions.length, "bodies carried");
  ok(src.entityRows.product instanceof Map && src.entityRows.collection instanceof Map, "empty entity rows by default");
  ok(Object.isFrozen(src), "frozen");
  same(src.list.documents.doc_home, DV_BUILT.list.documents.doc_home, "list entry:");
  let code = null;
  try {
    Res.candidateSource({ list: { v: 4, nonsense: true } });
  } catch (e) {
    code = e?.detail?.code;
  }
  eq(code, "BAD_LIST", "a bad list fails closed as a live one does:");
});

await t("every non-entity getter resolves from the bodies map on a store where none of those versions exist, with no document_versions read; answers equal the same list published on dv", async () => {
  await putLive(VGL, "rel_fixture_v3b", LEGACY.v3);
  const calls = CALLS.filter(([fn]) => !ENTITY.includes(fn));
  for (const fn of RESOLVED.filter((f) => !ENTITY.includes(f))) ok(calls.some(([c]) => c === fn), `no call for ${fn}`);
  const written = await withTenant(VGL, async () => Number((await libsql.execute({ sql: `SELECT count(*) AS n FROM document_versions WHERE id IN (${DV_BUILT.versions.map(() => "?").join(",")})`, args: DV_BUILT.versions.map((v) => v.id) })).rows[0].n));
  eq(written, 0, "versions on vgl:");
  const { result: cand, statements } = await asRequest(VGL, () =>
    watch(async () => {
      const G = Res.contentGettersFor(Res.candidateSource({ list: DV_BUILT.list, releaseId: "rel_candidate", bodies: bodiesOf(DV_BUILT.versions) }));
      const out = {};
      for (const [fn, args] of calls) out[key(fn, args)] = JSON.parse(JSON.stringify(await settle(() => G[fn](...args))));
      return out;
    }),
  );
  same(versionReads(statements), [], "document_versions reads:");
  for (const [k, v] of Object.entries(cand)) ok(!v.threw, `${k} threw ${v.threw}: ${v.message}`);
  // the same list, published for real on dv (its draft announcement is not live)
  const real = await asRequest(DV, async () => {
    const out = {};
    for (const [fn, args] of calls) out[key(fn, args)] = JSON.parse(JSON.stringify(await settle(() => Res[fn](...args))));
    return out;
  });
  sameAll(cand, real, "candidate vs published");
  eq(cand["resolvedHero()"].ok.title, "Docs hero", "hero:");
  eq(cand['resolvedContentPage("about")'].ok.title, "About Docs", "a page:");
  same(cand["resolvedJournalEntries()"].ok.map((e) => e.slug), ["first-post"], "journal (from the in-memory index):");
  // and the shopper on vgl still gets its v3 release, in another request
  eq((await asRequest(VGL, () => Res.resolvedHero())).title, "Live hero v3", "vgl's shopper hero:");
});

await t("a mixed map reads only the versions it lacks; held ids are never asked for", async () => {
  const live = await asRequest(DV, () => Res.contentSource());
  const chromeIds = ["doc_header", "doc_footer", "doc_announcement", "doc_design"].map((d) => live.list.documents[d].version);
  const held = new Map(DV_BUILT.versions.filter((v) => chromeIds.includes(v.id)).map((v) => [v.id, { document_id: v.document_id, body: v.body }])); // JSON text works too
  eq(held.size, 4, "held:");
  const { result, statements } = await asRequest(DV, () =>
    watch(async () => {
      const G = Res.contentGettersFor(Res.candidateSource({ list: DV_BUILT.list, bodies: held }));
      return { bar: await G.resolvedAnnouncement(), page: await G.resolvedHomePage() };
    }),
  );
  eq(result.bar.text, "Docs bar", "bar:");
  ok(result.page.length > 1, "home page");
  const reads = versionReads(statements);
  ok(reads.length >= 1, "the home versions are read from the database");
  for (const r of reads) for (const a of r.args) ok(!chromeIds.includes(a), `held version ${a} was read`);
});

await t("a held body is checked like a stored one: wrong document, newer schema, unreadable text all fail closed", async () => {
  const v = DV_BUILT.versions.find((x) => x.document_id === "doc_announcement");
  // every chrome version held, the announcement's replaced by `entry`
  const tryWith = async (entry, { alone = false } = {}) => {
    const map = alone ? new Map() : bodiesOf(DV_BUILT.versions);
    map.set(v.id, entry);
    try {
      await asRequest(VGL, () => Res.contentGettersFor(Res.candidateSource({ list: DV_BUILT.list, bodies: map })).resolvedAnnouncement());
      return null;
    } catch (e) {
      ok(Res.isContentUnavailable(e), `not ContentUnavailableError: ${e.message}`);
      return e.detail.code;
    }
  };
  eq(await tryWith({ document_id: "doc_header", body: JSON.parse(v.body) }), "VERSION_MISMATCH", "wrong document:");
  eq(await tryWith({ document_id: "doc_announcement", body: { ...JSON.parse(v.body), schema: 999 } }), "UNKNOWN_SCHEMA", "newer schema:");
  eq(await tryWith({ document_id: "doc_announcement", body: "{not json" }), "BAD_VERSION", "unreadable:");
  eq(await tryWith({ body: JSON.parse(v.body) }), "BAD_VERSION", "no document id:");
  // and a version neither held nor stored is MISSING_VERSION, as on a live list
  eq(await tryWith({ document_id: "doc_announcement", body: JSON.parse(v.body) }), null, "the right body reads:");
  eq(await tryWith({ document_id: "doc_announcement", body: JSON.parse(v.body) }, { alone: true }), "MISSING_VERSION", "the other chrome versions are not on vgl:");
});

// =====================================================================================
console.log("— 3. edge safety, and no source kept between calls");
// =====================================================================================
const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
await t("no node: import reachable from resolve.js (lib/tenant-context.js's node:async_hooks, which the edge runtime provides, is the only one, as before)", async () => {
  const seen = new Set();
  const hits = [];
  const walk = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = await readFile(f, "utf8");
    for (const m of src.matchAll(nodeImport)) hits.push(`${relative(ROOT, f)}: ${m[1]}`);
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["']((?:\.{1,2}|@)\/[^"']+)["']/g)) {
      const p = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : resolve(dirname(f), spec);
      await walk(p.endsWith(".js") ? p : `${p}.js`);
    }
  };
  await walk(join(ROOT, "lib/content/resolve.js"));
  ok(seen.size > 20, `the walk found only ${seen.size} files`);
  ok(seen.has(join(ROOT, "lib/content/documents-reader.js")), "documents-reader.js not reached");
  same(hits, ["lib/tenant-context.js: node:async_hooks"], "node imports reachable from resolve.js:");
});

await t("no module-level variable in resolve.js or documents-reader.js holds a source, and neither uses AsyncLocalStorage", async () => {
  for (const f of ["lib/content/resolve.js", "lib/content/documents-reader.js"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!/AsyncLocalStorage|async_hooks/.test(src), `${f} uses AsyncLocalStorage`);
    const top = src.split("\n").filter((l) => /^(?:export\s+)?(?:let|var|const)\s/.test(l));
    for (const l of top) ok(!/^(?:export\s+)?(?:let|var)\s/.test(l), `${f}: module-level mutable binding: ${l.trim()}`);
    // module-level const bindings that are not functions, and whose name
    // speaks of a source: none (contentSource is cache(async () => ...), a
    // function; bodiesOf and docBodies are arrow functions over a given src)
    const isFn = (l) => /=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|=\s*cache\(|=\s*function\b/.test(l);
    const named = top.filter((l) => !isFn(l)).map((l) => l.match(/^(?:export\s+)?const\s+(\w+)/)?.[1]).filter((n) => n && /source|src|bodies|entityRows|candidate/i.test(n));
    same(named, [], `${f} source-named module-level values:`);
    // nothing stores a source on globalThis (the request-scope holder keeps a store id and a flag)
    ok(!/globalThis\.[\w$]+\s*=(?!=)|globalThis\[[^\]]+\]\s*=(?!=)(?!\s*cache)/.test(src.replace(/\(globalThis\[REQUEST_SCOPE_KEY\] \?\?= cache\(/g, "")), `${f} writes to globalThis`);
  }
  // contentSource is still React cache over readContentSource (the only shopper source)
  const resolveSrc = await readFile(join(ROOT, "lib/content/resolve.js"), "utf8");
  ok(/export const contentSource = cache\(async \(\) => \{\n  const src = await readContentSource\(\);/.test(resolveSrc), "contentSource changed");
  // every exported resolved* getter is the thin wrapper
  for (const fn of RESOLVED) {
    const m = resolveSrc.match(new RegExp(`export async function ${fn}\\(([^)]*)\\) \\{\\n  return (\\w+)\\(await contentSource\\(\\)(, \\.\\.\\.args)?\\);\\n\\}`));
    ok(m, `${fn} is not a thin wrapper over contentSource()`);
  }
});

// =====================================================================================
console.log("— 4. a shopper request never sees a candidate's bodies or entity rows");
// =====================================================================================
// The candidates hold DIFFERENT bodies under dv's live version ids (the worst
// case: same key, other content) and entity rows. dv's shopper must still get
// what the database holds.
const altered = (tag) =>
  new Map(
    DV_BUILT.versions.map((v) => {
      const b = JSON.parse(v.body);
      if (v.document_id === "doc_announcement") b.settings.text = `${tag} bar`;
      if (v.document_id === "doc_home") b.sections[0].settings.title = `${tag} hero`;
      if (v.document_id === "doc_about") b.meta.title = `About ${tag}`;
      return [v.id, { document_id: v.document_id, body: b }];
    }),
  );
const rowsFor = (tag) => ({ product: new Map([[P(1), { title: `${tag} product` }]]), collection: new Map([[COL(2), { title: `${tag} collection` }]]) });
const shopperView = async () => {
  const src = await Res.contentSource();
  return { src, bar: (await Res.resolvedAnnouncement()).text, hero: (await Res.resolvedHero()).title, about: (await Res.resolvedContentPage("about")).title };
};
const candidateView = async (tag) => {
  const G = Res.contentGettersFor(Res.candidateSource({ list: DV_BUILT.list, releaseId: `rel_${tag}`, bodies: altered(tag), entityRows: rowsFor(tag) }));
  return { bar: (await G.resolvedAnnouncement()).text, hero: (await G.resolvedHero()).title, about: (await G.resolvedContentPage("about")).title };
};

await t("two candidate runs, then the request-shaped call, in ONE request: each candidate sees its own bodies, the shopper sees the database", async () => {
  const r = await asRequest(DV, async () => ({ one: await candidateView("ONE"), two: await candidateView("TWO"), shopper: await shopperView() }));
  same(r.one, { bar: "ONE bar", hero: "ONE hero", about: "About ONE" }, "first candidate:");
  same(r.two, { bar: "TWO bar", hero: "TWO hero", about: "About TWO" }, "second candidate:");
  same({ bar: r.shopper.bar, hero: r.shopper.hero, about: r.shopper.about }, { bar: "Docs bar", hero: "Docs hero", about: "About Docs" }, "shopper:");
  ok(!("bodies" in r.shopper.src) && !("entityRows" in r.shopper.src), "the shopper's source carries no bodies or entity rows");
});

await t("the shopper first, then a candidate, in one request: the candidate still reads its map before the request's cached versions", async () => {
  const r = await asRequest(DV, async () => ({ shopper: await shopperView(), one: await candidateView("ONE"), again: await shopperView() }));
  eq(r.shopper.bar, "Docs bar", "shopper:");
  same(r.one, { bar: "ONE bar", hero: "ONE hero", about: "About ONE" }, "candidate:");
  same({ bar: r.again.bar, hero: r.again.hero, about: r.again.about }, { bar: "Docs bar", hero: "Docs hero", about: "About Docs" }, "shopper again:");
  ok(r.shopper.src === r.again.src, "one source per request (contentSource is still cached)");
});

await t("two candidate requests, then a fresh shopper request: the shopper source is the live one, with nothing left over", async () => {
  await asRequest(DV, () => candidateView("ONE"));
  await asRequest(DV, () => candidateView("TWO"));
  const s = await asRequest(DV, shopperView);
  same({ bar: s.bar, hero: s.hero, about: s.about }, { bar: "Docs bar", hero: "Docs hero", about: "About Docs" }, "shopper:");
  same(Object.keys(s.src).sort(), ["content", "list", "mode", "preview", "releaseId", "v"], "the live source's keys:");
  // and outside any request (a script), the same
  const plain = await withTenant(DV, shopperView);
  eq(plain.bar, "Docs bar", "outside a request:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
