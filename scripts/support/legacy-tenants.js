// P4-FIXTURES (MIG-01, MIG-02, MIG-04): legacy tenants for phase 4 tests and
// drills. A helper, not a suite: nothing here runs on import, and nothing here
// imports lib/ until a function is called, so the caller can set the process's
// environment (openWorld does) before the app is loaded.
//
// Every database is a local file at the checkout's root. Builders refuse any
// other URL (libsql://, https://, a sqld on http://127.0.0.1) before they
// touch it. Nothing here reaches the network or Shopify.
//
//   installHooks({ headers })        module hooks the app needs outside Next
//                                    ("real" next/headers, or "stub": one
//                                    simulated request at a time, see asRequest)
//   openWorld({ prefix })            env + a migrated control plane in
//                                    <prefix>-platform.db; the env store is
//                                    <prefix>-default.db
//     world.tenant({ id, name, file, domains, config, secrets, stage })
//                                    a registered, migrated tenant database
//                                    <prefix>-<file || id>.db -> a db handle
//     world.defaultStore()           the env store (_default) as a db handle
//     world.cleanup()                removes every file the world made
//   buildLegacyTenant(db, { state, traps, entities, set, drafts })
//                                    fills a db handle (from world.tenant,
//                                    world.defaultStore or tenant-fixture's
//                                    makeTenant) with legacy content
//   makeLegacyTenant(world, { id, ...tenant, state, traps, entities, set })
//   recordOutputs(db, { routes, getters, state })
//                                    what getLiveReleaseState, contentSource and
//                                    the resolved* getters answer, as plain JSON
//   allGetterRoutes()                one or more calls for EVERY exported
//                                    resolved* getter of lib/content/resolve.js
//   buildPhase3Leftovers(db), buildStaleBackfill(db)
//                                    re-run fixtures for CUTOVER and REVERSE
//   STATE_ROWS, MAPPING_TRAPS, ENTITY_FIXTURES, RERUN_FIXTURES
//                                    the named builders, each with a plain
//                                    description (test-legacy-fixtures checks
//                                    that every one the P4 plan names exists)
//
// The db handle: { id, url, run(fn) } (tenant-fixture's makeTenant handle has
// these too). run(fn) runs fn inside the tenant's context.
//
// scripts/support/legacy-release-outputs.js, home-render-outputs.js and
// legacy-journal-outputs.js are thin wrappers over this file; the content sets
// "vgate", "home" and "journal" below are exactly what those recorders built
// before P4-FIXTURES, so their JSON stays byte-identical.
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { assertLocalDbUrl, stageMigrations } from "./tenant-fixture.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NOW = "2026-01-01T00:00:00.000Z";
export const P = (id) => `gid://shopify/Product/${id}`;
export const COL = (id) => `gid://shopify/Collection/${id}`;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- module hooks -------------------------------------------------------------------

// next/headers for one simulated request at a time (asRequest below).
export const REQUEST_GLOBAL = "__legacyFixtureRequest";
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.${REQUEST_GLOBAL};
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() { const r = req(); return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) }; }
export async function cookies() { const r = req(); const c = r.cookies || {}; return { get: (n) => (Object.hasOwn(c, n) ? { name: n, value: c[n] } : undefined) }; }
`);

let hooked = null;
export function installHooks({ headers = "real" } = {}) {
  if (!["real", "stub"].includes(headers)) throw new Error(`legacy-tenants: headers must be "real" or "stub", not ${JSON.stringify(headers)}`);
  if (hooked) {
    if (hooked !== headers) throw new Error(`legacy-tenants: hooks already installed with headers "${hooked}"`);
    return;
  }
  hooked = headers;
  registerHooks({
    resolve(spec, ctx, next) {
      if (headers === "stub" && spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
      if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
      if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
      return next(spec, ctx);
    },
  });
}

export async function asRequest(host, cookies, fn) {
  globalThis[REQUEST_GLOBAL] = { host, cookies: cookies || {} };
  try {
    return await fn();
  } finally {
    globalThis[REQUEST_GLOBAL] = null;
  }
}

// ---- refusing anything but a local file --------------------------------------------

function urlOf(db) {
  if (!db || typeof db !== "object") return null;
  return typeof db.url === "string" ? db.url : typeof db.tenant?.dbUrl === "string" ? db.tenant.dbUrl : null;
}

// Throws unless the handle's database is a local file: URL. Called before any
// statement, so a hosted URL is never opened.
export function assertFileDb(db) {
  const url = urlOf(db);
  assertLocalDbUrl(url);
  if (db?.tenant?.dbUrl != null) assertLocalDbUrl(db.tenant.dbUrl);
  if (typeof db.run !== "function") throw new Error("legacy-tenants: the db handle has no run(fn)");
  return url;
}

// ---- the world: env, control plane, tenants ----------------------------------------

async function removeDbFile(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `${file}${suffix}`), { force: true });
}

const PREFIX_RE = /^\.test-[a-z0-9-]{1,60}$/;

export async function openWorld({ prefix } = {}) {
  if (!PREFIX_RE.test(String(prefix ?? ""))) throw new Error(`legacy-tenants: prefix "${prefix}" must look like .test-<name>`);
  const defaultFile = `${prefix}-default.db`;
  const platformFile = `${prefix}-platform.db`;
  const defaultUrl = assertLocalDbUrl(`file:${defaultFile}`);
  const platformUrl = assertLocalDbUrl(`file:${platformFile}`);
  // file: URLs are relative to the working directory: the checkout's root
  process.chdir(ROOT);
  process.env.TURSO_DB_URL = "";
  process.env.TURSO_DB_AUTH_TOKEN = "";
  process.env.DATABASE_URL = defaultUrl;
  process.env.PLATFORM_DB_URL = platformUrl;
  process.env.PLATFORM_DB_TOKEN = "";
  process.env.PLATFORM_SECRET = "test-platform-secret";
  process.env.PLATFORM_CACHE_MS = "50";
  process.env.PLATFORM_SITE_HOSTS = "";
  const files = new Set([defaultFile, platformFile]);
  for (const f of files) await removeDbFile(f);

  const C = await import("../../lib/platform/control.js");
  const { withTenant } = await import("../../lib/tenant-context.js");
  const { libsql } = await import("../../lib/db.js");
  const { loadMigrations, runMigrations } = await import("../../lib/platform/migrate.js");
  await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
  const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
  const migrations = await loadMigrations("tenant");

  const migrate = (run, stage) =>
    run(async () => {
      await libsql.executeMultiple(schema);
      await runMigrations(libsql, stageMigrations(stage, migrations));
    });

  const world = {
    prefix,
    files,
    control: C,
    async tenant({ id, name, file, domains, config = {}, secrets = {}, stage = "latest" } = {}) {
      stageMigrations(stage, []); // an unknown stage is refused before any file is made
      const dbFile = `${prefix}-${file ?? id}.db`;
      const url = assertLocalDbUrl(`file:${dbFile}`);
      files.add(dbFile);
      await removeDbFile(dbFile);
      await C.upsertTenant({ id, name: name ?? id, domains: domains ?? [`${id}.test`], dbUrl: url, config, secrets });
      const tenant = await C.getTenant(id);
      assertLocalDbUrl(tenant.dbUrl);
      const run = (fn) => withTenant(tenant, fn);
      await migrate(run, stage);
      return { id, url, file: dbFile, tenant, run, world };
    },
    async defaultStore({ stage = "latest" } = {}) {
      const run = (fn) => withTenant(null, fn);
      await migrate(run, stage);
      return { id: "_default", url: defaultUrl, file: defaultFile, tenant: null, run, world };
    },
    async cleanup() {
      for (const f of files) await removeDbFile(f);
    },
  };
  return world;
}

// ---- writing legacy rows ---------------------------------------------------------------

async function lib() {
  const { libsql } = await import("../../lib/db.js");
  const R = await import("../../lib/releases.js");
  return { libsql, R, exec: (sql, args = []) => libsql.execute({ sql, args }) };
}

export async function putLiveRelease(db, id, content) {
  assertFileDb(db);
  const { exec, R } = await lib();
  await db.run(async () => {
    await exec("INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)", [
      id,
      R.stableStringify(content),
      `hash_${id}`,
      `note ${id}`,
      NOW,
      NOW,
    ]);
    await exec("UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", [id, NOW]);
  });
}

async function writeBlockRaw(key, value) {
  const { exec } = await lib();
  if (value === undefined) return exec("DELETE FROM cms_blocks WHERE key = ?", [key]);
  return exec("INSERT INTO cms_blocks (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [key, JSON.stringify(value), NOW]);
}

async function writePageRaw(p) {
  const { exec } = await lib();
  const enabled = p.enabled === false || p.enabled === 0 ? 0 : 1;
  return exec(
    "INSERT INTO cms_pages (slug, title, description, sections, enabled, effective_at, family, window_start, window_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(slug) DO UPDATE SET title = excluded.title, description = excluded.description, sections = excluded.sections, enabled = excluded.enabled, effective_at = excluded.effective_at, family = excluded.family, window_start = excluded.window_start, window_end = excluded.window_end, updated_at = excluded.updated_at",
    [p.slug, p.title, p.description ?? "", JSON.stringify(p.sections ?? []), enabled, p.effective_at ?? null, p.family ?? "page", p.window_start ?? null, p.window_end ?? null, p.updated_at ?? NOW],
  );
}

// ---- content set "vgate": scripts/support/legacy-release-outputs.js (P2-VGATE) --------

const VG_blocksV1 = {
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
const VG_pagesV1 = [
  { slug: "about", title: "About us", description: "Who we are", sections: [{ heading: "Story", body: ["We began."] }], enabled: true },
  { slug: "shipping", title: "Shipping", description: "", sections: [{ kind: "text", heading: "Times", body: ["Two days"] }], enabled: true, effective_at: "2026-01-01" },
  { slug: "hidden-page", title: "Hidden", description: "", sections: [], enabled: false },
  { slug: "spring", title: "Spring sale", description: "", sections: [], enabled: true, family: "campaign", window_start: "2026-03-01", window_end: "2026-03-31" },
];
const VG_brand = { accent: "#0d9488" };
const VG_theme = { kit: "glow", version: 1 };

const VG_RELEASES = {
  v1: { v: 1, blocks: VG_blocksV1, pages: VG_pagesV1, brand: VG_brand, theme: null },
  v2: {
    v: 2,
    blocks: { ...VG_blocksV1, hero: { ...VG_blocksV1.hero, title: "Live hero v2" }, surface_templates: { product: "editorial" } },
    pages: VG_pagesV1,
    brand: VG_brand,
    theme: VG_theme,
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
      ...VG_blocksV1,
      hero: { ...VG_blocksV1.hero, title: "Live hero v3" },
      home_sections: [
        { id: "sec_aa11", kind: "new", title: "New in", limit: 4 },
        { id: "sec_bb22", kind: "product_rail", title: "Serums", collection: "old-handle", collection_id: COL(2), limit: 4 },
      ],
      collections_index: { featured: ["old-whey"], order: ["serums"], ids: { "old-whey": COL(1) } },
      surface_templates: { product: "editorial", header: "centered", footer: "minimal" },
    },
    pages: [
      ...VG_pagesV1.slice(1),
      { slug: "about", title: "About", description: "", sections: [{ id: "sec_cc33", kind: "text", heading: "Story", body: ["v3"] }], enabled: true },
    ],
    brand: null,
    theme: VG_theme,
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  },
};

// Every getter, with arguments that reach each branch the vgate fixtures can
// reach: the list scripts/fixtures/legacy-release-outputs.a6d028e.json holds.
export const LEGACY_RELEASE_ROUTES = Object.freeze([
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
]);

const SET_VGATE = {
  name: "vgate",
  tenant: { id: "vgl", name: "Legacy Outputs", config: { site: { name: "Legacy Outputs" } }, secrets: { order_link_secret: "vgl-link-secret" } },
  products: [P(1), P(2), P(3)],
  async catalog() {
    const { exec } = await lib();
    await exec("INSERT INTO collections (id, handle, title, synced_at) VALUES (?, 'whey', 'Whey', ?), (?, 'serums', 'Serums', ?)", [COL(1), NOW, COL(2), NOW]);
    for (const [id, handle, title, price] of [
      [1, "glow-serum", "Glow Serum", 1299],
      [2, "night-cream", "Night Cream", 899],
      [3, "whey-gold", "Whey Gold", 2499],
    ]) {
      await exec("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?)", [P(id), handle, title, price, price, NOW]);
      await exec("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${id}`, P(id), price]);
    }
    await exec("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0), (?, ?, 1), (?, ?, 0)", [COL(2), P(1), COL(2), P(2), COL(1), P(3)]);
  },
  // The live tables a v1 release falls back to. v2 and v3 freeze their own.
  async liveTables() {
    const { exec } = await lib();
    await exec("INSERT INTO product_overrides (product_id, modules, badge) VALUES (?, ?, 'TABLE')", [P(1), JSON.stringify([{ title: "From the table", html: "<p>table</p>" }])]);
    await exec("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(2), JSON.stringify([P(2)])]);
    await exec(
      "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position) VALUES ('pl_tbl_pairs', 'pdp_pairs', ?, ?, 'Table pairs', 1, 0), ('pl_tbl_cart', 'cart_upsell', NULL, ?, 'Table upsell', 1, 0)",
      [P(1), JSON.stringify([P(3)]), JSON.stringify([P(2)])],
    );
    await exec("INSERT INTO page_redirects (from_slug, to_slug, created_at) VALUES ('old-post', 'table-post', ?)", [NOW]);
  },
  // Drafts that differ from every release: an unpublished change.
  drafts: {
    blocks: { ...VG_blocksV1, hero: { ...VG_blocksV1.hero, title: "Draft hero" } },
    pages: VG_pagesV1.map((p) => (p.slug === "about" ? { ...p, title: "About us (draft)" } : p)),
  },
  releases: VG_RELEASES,
  releaseId: (v) => `rel_fixture_v${v}`,
};

// ---- content set "home": scripts/support/home-render-outputs.js (P2-SECTIONS) ---------

const SHOP_IMG = (n) => `https://cdn.shopify.com/s/files/1/0001/products/p${n}.jpg`;
const LIB_IMG = "/api/media/med_ae5f4af4b10aec0b01";
export const HOME_HERO = {
  title: "Glow from within",
  highlight: "Glow",
  subtitle: "Clean skincare, made in small batches.",
  primary: { label: "Shop serums", href: "/collections/serums" },
  secondary: { label: "What’s new", href: "#new" },
  badge: "",
};
export const HOME_SECTIONS = [
  { id: "sec_coll01", kind: "collections", title: "Shop by collection", limit: 3 },
  { id: "sec_new001", kind: "new", title: "New arrivals", limit: 4 },
  { id: "sec_bann01", kind: "banner", title: "Free shipping", text: "On every order this week.", label: "Shop now", href: "/collections/gifts" },
  { id: "sec_rich01", kind: "rich_text", title: "Our story", html: "<p>Made <strong>by hand</strong>.</p>" },
  { id: "sec_img001", kind: "image_with_text", image: LIB_IMG, image_alt: "A jar on linen", image_side: "right", title: "Why it works", text: "Three oils.", label: "Read", href: "/about" },
  { id: "sec_rail01", kind: "product_rail", title: "Serums", collection: "serums", collection_id: COL(1), limit: 3 },
  { id: "sec_rail02", kind: "product_rail", title: "Whey", collection: "whey", collection_id: COL(2), limit: 4 },
  { id: "sec_new002", kind: "new", title: "More new", limit: 2 },
];
export const HOME_PAGES = [
  { slug: "about", title: "About us", description: "Who we are", sections: [{ heading: "Story", body: ["We began in a kitchen.", "Now we ship everywhere."] }, { kind: "text", heading: "", body: ["No heading here."] }] },
  { slug: "shipping", title: "Shipping", effective_at: "2026-01-01", sections: [{ kind: "rich", heading: "Times", html: "<p>Two <em>days</em>.</p>" }, { kind: "text", heading: "Costs", body: ["Free over ₹999."] }] },
  { slug: "faq", title: "Questions", sections: [{ kind: "faq", heading: "Orders", items: [{ q: "How long does delivery take?", a: "<p>Two days.</p>" }, { q: "Can I return?", a: "<p>Yes, in 7 days.</p>" }] }] },
  { slug: "gallery", title: "Gallery", sections: [{ kind: "image", src: LIB_IMG, alt: "The workshop", caption: "Where we make it" }, { kind: "image", src: SHOP_IMG(1), alt: "A serum", caption: "" }] },
];
const homeBlocksOf = (over = {}) => ({
  hero: HOME_HERO,
  announcement: { enabled: false, text: "", href: "" },
  nav_header: null,
  nav_footer: null,
  home_sections: HOME_SECTIONS,
  collections_index: { featured: ["serums", "gifts"], order: [], hide: [] },
  pdp_extras: [],
  ...over,
});
const homeLivePages = (tag) => HOME_PAGES.map((p) => ({ description: "", enabled: true, family: "page", effective_at: null, ...p, title: `${p.title} ${tag}` }));
const HOME_RELEASES = {
  // v1: id-less home sections, as releases from before S54 hold them
  v1: { v: 1, blocks: homeBlocksOf({ hero: { ...HOME_HERO, title: "Glow live v1" }, home_sections: HOME_SECTIONS.map(({ id, ...s }) => s) }), pages: homeLivePages("v1"), brand: null, theme: null },
  v2: {
    v: 2,
    blocks: homeBlocksOf({ hero: { ...HOME_HERO, title: "Glow live v2", badge: "New season" }, home_sections: HOME_SECTIONS.slice(0, 6).map(({ id, ...s }, i) => (i % 2 ? { id, ...s } : s)) }),
    pages: homeLivePages("v2"),
    brand: null,
    theme: null,
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  },
  v3: {
    v: 3,
    blocks: homeBlocksOf({ hero: { ...HOME_HERO, title: "Glow live v3", secondary: null }, home_sections: [...HOME_SECTIONS].reverse() }),
    pages: homeLivePages("v3"),
    brand: null,
    theme: null,
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  },
};

// The running hero experiment of the home recorder (and the
// hero_experiment_running trap).
export const HERO_EXPERIMENT = Object.freeze({
  slug: "hero-words",
  name: "Hero words",
  hypothesis: "Shorter words sell more",
  target_kind: "hero",
  variants: [
    { key: "control", weight: 50, payload: null },
    { key: "b", weight: 50, payload: { title: "Glow, simply", highlight: "simply", primary: { label: "Try it", href: "/collections/gifts" } } },
  ],
  min_sample: 200,
});

export async function startHeroExperiment(db, experiment = HERO_EXPERIMENT) {
  assertFileDb(db);
  const X = await import("../../lib/experiments.js");
  await db.run(async () => {
    await X.upsertExperiment(clone(experiment));
    await X.startExperiment(experiment.slug);
  });
}

const SET_HOME = {
  name: "home",
  tenant: { id: "hr", name: "Glow Works", config: { site: { name: "Glow Works" } }, secrets: { order_link_secret: "hr-link-secret" } },
  products: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(P),
  // The catalog: three collections of three products each, all in stock.
  async catalog() {
    const { exec } = await lib();
    await exec("INSERT INTO collections (id, handle, title, image, image_alt, synced_at) VALUES (?, 'serums', 'Serums', ?, 'Serum bottles', ?), (?, 'whey', 'Whey', NULL, NULL, ?), (?, 'gifts', 'Gifts', ?, '', ?)", [
      COL(1),
      SHOP_IMG(90),
      NOW,
      COL(2),
      NOW,
      COL(3),
      LIB_IMG,
      NOW,
    ]);
    const products = [
      [1, "glow-serum", "Glow Serum", 1299, SHOP_IMG(1), 1],
      [2, "night-cream", "Night Cream", 899, null, 1],
      [3, "dew-drops", "Dew Drops", 1499, LIB_IMG, 1],
      [4, "whey-gold", "Whey Gold", 2499, SHOP_IMG(4), 2],
      [5, "whey-isolate", "Whey Isolate", 2999, SHOP_IMG(5), 2],
      [6, "whey-vanilla", "Whey Vanilla", 2299, null, 2],
      [7, "gift-box", "Gift Box", 1999, SHOP_IMG(7), 3],
      [8, "gift-card", "Gift Card", 1000, null, 3],
      [9, "gift-mini", "Gift Mini", 599, SHOP_IMG(9), 3],
    ];
    for (const [n, handle, title, price, img, col] of products) {
      await exec(
        "INSERT INTO products (id, handle, title, product_type, price_min, price_max, compare_at_min, currency, available, featured_image, featured_image_alt, created_at, synced_at) VALUES (?, ?, ?, 'Care', ?, ?, ?, 'INR', 1, ?, ?, ?, ?)",
        [P(n), handle, title, price, price, n === 4 ? 2999 : null, img, img ? `${title} photo` : null, `2025-0${1 + (n % 9)}-01T00:00:00.000Z`, NOW],
      );
      await exec("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${n}`, P(n), price]);
      await exec("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)", [COL(col), P(n), n % 3]);
    }
  },
  // the founder's pinned order for one collection
  async liveTables() {
    const { exec } = await lib();
    await exec("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(2), JSON.stringify([P(6)])]);
  },
  drafts: { blocks: { hero: HOME_HERO, home_sections: HOME_SECTIONS, collections_index: { featured: ["serums", "gifts"], order: [], hide: [] } }, pages: HOME_PAGES },
  // Drafts go through the console's own writers, as the recorder always did
  // (validated, home sections keep their ids, page sections get fresh ids).
  async writeDrafts(model) {
    const S = await import("../../lib/cms/store.js");
    for (const [key, value] of Object.entries(model.blocks)) {
      if (model.rawBlocks.has(key)) continue;
      await S.setBlock(key, value);
    }
    for (const p of model.pages) if (!model.rawPages.has(p.slug)) await S.upsertContentPage(p);
  },
  releases: HOME_RELEASES,
  releaseId: (v) => `rel_home_v${v}`,
};

// ---- content set "journal": scripts/support/legacy-journal-outputs.js (P2-READ) -------

// Pages of every family. Windows are far in the past or future, so the output
// does not depend on the day it is recorded.
const JOURNAL_PAGES = [
  { slug: "about", title: "About", family: "page", enabled: 1 },
  { slug: "shipping", title: "Shipping", family: "page", enabled: 1 },
  { slug: "hidden-policy", title: "Hidden", family: "page", enabled: 0 },
  { slug: "spring", title: "Spring sale", family: "campaign", enabled: 1, window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" },
  { slug: "first-post", title: "First post", description: "Hello", family: "journal", enabled: 1, window_start: "2025-05-01T00:00:00.000Z" },
  { slug: "second-post", title: "Second post", description: "", family: "journal", enabled: 1, window_start: "2025-07-01T00:00:00.000Z" },
  { slug: "undated-post", title: "Undated", description: "No date", family: "journal", enabled: 1 },
  { slug: "future-post", title: "Not yet", description: "", family: "journal", enabled: 1, window_start: "2099-01-01T00:00:00.000Z" },
  { slug: "ended-post", title: "Gone", description: "", family: "journal", enabled: 1, window_start: "2020-01-01T00:00:00.000Z", window_end: "2021-01-01T00:00:00.000Z" },
  { slug: "off-post", title: "Switched off", description: "", family: "journal", enabled: 0 },
];
// A v3 release whose pages differ from the drafts: one post renamed, one added.
const JOURNAL_RELEASE_PAGES = JOURNAL_PAGES.map((p) => ({
  slug: p.slug,
  title: p.slug === "first-post" ? "First post (live)" : p.title,
  description: p.description ?? "",
  sections: [],
  enabled: !!p.enabled,
  family: p.family,
  window_start: p.window_start ?? null,
  window_end: p.window_end ?? null,
})).concat([{ slug: "live-only-post", title: "Live only", description: "From the release", sections: [], enabled: true, family: "journal", window_start: "2025-09-01T00:00:00.000Z", window_end: null }]);

const SET_JOURNAL = {
  name: "journal",
  tenant: { id: "jl", name: "Journal Legacy", config: { site: { name: "Journal Legacy" }, site_url: "https://jl.test" }, secrets: { order_link_secret: "jl-link-secret" } },
  products: [P(1)],
  async catalog() {
    const { exec } = await lib();
    await exec("INSERT INTO collections (id, handle, title, synced_at, updated_at) VALUES ('gid://shopify/Collection/1', 'serums', 'Serums', ?, ?)", [NOW, NOW]);
    await exec("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at, updated_at) VALUES ('gid://shopify/Product/1', 'glow-serum', 'Glow Serum', 100, 100, 'INR', 1, ?, ?)", [NOW, NOW]);
  },
  async liveTables() {},
  drafts: {
    blocks: {},
    pages: JOURNAL_PAGES.map((p) => ({
      slug: p.slug,
      title: p.title,
      description: p.description ?? "",
      sections: [{ kind: "text", heading: p.title, body: ["x"] }],
      enabled: p.enabled,
      effective_at: null,
      family: p.family,
      window_start: p.window_start ?? null,
      window_end: p.window_end ?? null,
    })),
  },
  releases: { v3: { v: 3, blocks: {}, pages: JOURNAL_RELEASE_PAGES, brand: null, theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] } },
  releaseId: (v) => `rel_journal_v${v}`,
};

// ---- content set "empty": a store with no products yet (GEN-03) ------------------------

const SET_EMPTY = {
  name: "empty",
  tenant: { id: "hre", name: "Empty Works", config: { site: { name: "Empty Works" } }, secrets: { order_link_secret: "hre-link-secret" } },
  products: [],
  async catalog() {},
  async liveTables() {},
  drafts: { blocks: {}, pages: [] },
  releases: {},
  releaseId: (v) => `rel_empty_v${v}`,
};

export const CONTENT_SETS = Object.freeze({ vgate: SET_VGATE, home: SET_HOME, journal: SET_JOURNAL, empty: SET_EMPTY });

// ---- the model traps and entities patch ---------------------------------------------
//
// model = {
//   set, state, db,
//   blocks     the draft blocks (cms_blocks); a missing key = no row
//   pages      the draft pages (cms_pages)
//   release    the envelope the state puts live, or null
//   rawBlocks, rawPages   what traps changed (written raw, never normalized)
//   after      [async () => …] extra rows, run inside the tenant after drafts
//   notes      what the builder did, in the manifest
// }

const ABSENT = Symbol("absent");

function setBlockBoth(model, key, value) {
  for (const target of [model.blocks, model.release?.blocks]) {
    if (!target) continue;
    if (value === ABSENT) delete target[key];
    else target[key] = clone(value);
  }
  model.rawBlocks.add(key);
}

function upsertPageBoth(model, page, { release = true } = {}) {
  const put = (list) => {
    const i = list.findIndex((p) => p.slug === page.slug);
    if (i >= 0) list[i] = clone(page);
    else list.push(clone(page));
  };
  put(model.pages);
  if (release && Array.isArray(model.release?.pages)) put(model.release.pages);
  model.rawPages.add(page.slug);
}

function removePageBoth(model, slug) {
  model.pages = model.pages.filter((p) => p.slug !== slug);
  if (Array.isArray(model.release?.pages)) model.release.pages = model.release.pages.filter((p) => p.slug !== slug);
  model.rawPages.add(slug);
  model.removedPages.add(slug);
}

// v2 and v3 releases freeze entity rows in their own arrays; v1 reads the live
// tables, so there is nothing to add for it.
const frozen = (model) => (model.release && model.release.v >= 2 ? model.release : null);

async function addProduct(n, { title, handle, price = 500 } = {}) {
  const { exec } = await lib();
  await exec(
    "INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?) ON CONFLICT(id) DO NOTHING",
    [P(n), handle || `fixture-${n}`, title || `Fixture ${n}`, price, price, NOW],
  );
  await exec("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0) ON CONFLICT(id) DO NOTHING", [
    `gid://shopify/ProductVariant/${n}`,
    P(n),
    price,
  ]);
}

async function addCollection(n, { handle, products = [] } = {}) {
  const { exec } = await lib();
  await exec("INSERT INTO collections (id, handle, title, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", [COL(n), handle || `fixture-col-${n}`, `Fixture collection ${n}`, NOW]);
  for (const [i, pn] of products.entries()) await exec("INSERT OR REPLACE INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)", [COL(n), P(pn), i]);
}

async function addOverride(productId, modules, badge) {
  const { exec } = await lib();
  await exec("INSERT OR REPLACE INTO product_overrides (product_id, modules, badge, updated_at) VALUES (?, ?, ?, ?)", [productId, JSON.stringify(modules), badge ?? null, NOW]);
}

async function addPlacement(p) {
  const { exec } = await lib();
  await exec("INSERT OR REPLACE INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    p.id,
    p.kind,
    p.source_product_id ?? null,
    JSON.stringify(p.target_product_ids),
    p.title ?? null,
    p.enabled === false ? 0 : 1,
    p.position ?? 0,
    NOW,
  ]);
}

async function addRedirect(from, to) {
  const { exec } = await lib();
  await exec("INSERT OR REPLACE INTO page_redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?)", [from, to, NOW]);
}

const pushFrozen = (model, key, row) => {
  const r = frozen(model);
  if (r) r[key] = [...(Array.isArray(r[key]) ? r[key] : []), clone(row)];
};

function entityPlacement(placement) {
  return (model) => {
    model.after.push(async () => {
      for (const n of [placement.source_product_id, ...placement.target_product_ids]) if (n) await addProduct(Number(String(n).split("/").pop()));
      await addPlacement(placement);
    });
    pushFrozen(model, "placements", placement);
  };
}

function entityOverride(n, modules, badge, title) {
  return (model) => {
    model.after.push(async () => {
      await addProduct(n, { title });
      await addOverride(P(n), modules, badge);
    });
    pushFrozen(model, "product_overrides", { product_id: P(n), modules, badge: badge ?? null });
  };
}

function entityRedirect(from, to, before) {
  return (model, ctx) => {
    if (before) before(model, ctx);
    model.after.push(() => addRedirect(from, to));
    pushFrozen(model, "redirects", { from_slug: from, to_slug: to });
  };
}

function surfaceMap(key, map) {
  return (model) => {
    const merge = (target) => {
      if (!target) return;
      const cur = isObj(target.surface_templates) ? target.surface_templates : {};
      target.surface_templates = { ...cur, [key]: { ...(isObj(cur[key]) ? cur[key] : {}), ...map } };
    };
    merge(model.blocks);
    merge(model.release?.blocks);
    model.rawBlocks.add("surface_templates");
  };
}

async function platformOf(db, what) {
  const C = db.world?.control;
  if (!C) throw new Error(`legacy-tenants: ${what} needs a tenant registered by openWorld (it writes the control plane)`);
  return C.platformDb();
}

// ---- the named builders ---------------------------------------------------------------
//
// Each entry: { describe, apply(model, ctx) } (traps and entities), or
// { describe, release, flag, ... } (states). ctx = { db, set }.

const MODULE_HTML_SANITIZER_REWRITES = '<p onclick="steal()">Hi <script>alert(1)</script><a href="javascript:alert(2)">there</a></p><img src=x onerror="alert(3)">';
// exactly 10000 characters of module HTML
const LONG_MODULE_HTML = (() => {
  const head = "<p>";
  const tail = "</p>";
  return head + "a".repeat(10000 - head.length - tail.length) + tail;
})();
const SIX_MODULES = Array.from({ length: 6 }, (_, i) => ({ title: `Module ${i + 1}`, html: `<p>Module ${i + 1} body</p>` }));

export const STATE_ROWS = Object.freeze({
  live_v1: {
    describe: "Live on a version 1 release, with live-table overrides, pins, placements and redirects (v1 never froze them)",
    release: 1,
  },
  live_v2: { describe: "Live on a version 2 release (frozen overrides, pins, placements and redirects)", release: 2 },
  live_v3: { describe: "Live on a version 3 release (id-bearing sections, frozen entity arrays)", release: 3 },
  no_release_open: {
    describe: "No release, store open to shoppers: the drafts are what shoppers see (operator flag --store-open)",
    release: null,
    flag: "--store-open",
  },
  no_release_not_launched: {
    describe: "No release, store not launched: drafts only, closed until the first publish (operator flag --not-launched)",
    release: null,
    flag: "--not-launched",
  },
  pending_schedule: {
    describe: "Live on version 3 with a scheduled release still waiting (cutover must refuse)",
    release: 3,
    scheduled: true,
  },
  live_read_error: {
    describe: "The live pointer names a release with no envelope version, so the live read is in error (cutover must refuse)",
    release: null,
    error: true,
  },
});

const NAV = { header: "nav_header", footer: "nav_footer" };
const navTrap = (which, kind) => ({
  describe: `${which} navigation ${kind === "null" ? "stored as null (follow the catalog)" : kind === "empty" ? "stored as an empty list (show nothing)" : "with no stored value at all"}, in the drafts and any live release`,
  apply(model) {
    setBlockBoth(model, NAV[which], kind === "null" ? null : kind === "empty" ? [] : ABSENT);
  },
});

const SAFE_HOME_SECTIONS_NO_IDS = [
  { kind: "new", title: "New in", limit: 4 },
  { kind: "banner", title: "Free shipping", text: "This week only.", label: "Shop", href: "/collections" },
  { kind: "collections", title: "Shop by collection", limit: 3 },
];
const CUSTOM_HOME_SECTIONS = [
  { id: "sec_cust01", kind: "new", title: "Fresh this week", limit: 4 },
  { id: "sec_cust02", kind: "banner", title: "Gift wrap", text: "Free on every order.", label: "Shop gifts", href: "/collections" },
];
const CUSTOM_HERO = { title: "Made for the morning", highlight: "morning", subtitle: "Small batches.", primary: { label: "Shop now", href: "/collections" } };

const homeTrap = (describe, hero, sections) => ({
  describe,
  apply(model) {
    setBlockBoth(model, "hero", hero);
    setBlockBoth(model, "home_sections", sections);
  },
});

function codeDefaultPages(wantId) {
  return {
    describe:
      wantId === "_default"
        ? "The env store (_default): code-default pages (about, contact, policies) keep rendering with no cms_pages row; about is overridden by a row"
        : "A BeastLife tenant: code-default pages keep rendering with no cms_pages row; about is overridden by a row",
    requires: wantId,
    apply(model, { db }) {
      if (db.id !== wantId) throw new Error(`legacy-tenants: this trap needs the ${wantId === "_default" ? "env store (world.defaultStore())" : `tenant id "${wantId}"`}, not "${db.id}"`);
      for (const slug of ["contact", "shipping", "returns", "terms", "privacy"]) removePageBoth(model, slug);
      upsertPageBoth(model, { slug: "about", title: "About (our own words)", description: "", sections: [{ kind: "text", heading: "Ours", body: ["Overrides the default."] }], enabled: true });
    },
  };
}

const POLICY_PAGES = ["shipping", "returns", "terms", "privacy"].map((slug) => ({
  slug,
  title: `${slug[0].toUpperCase()}${slug.slice(1)} policy`,
  description: `Our ${slug} policy`,
  sections: [{ kind: "text", heading: "The short version", body: [`What our ${slug} policy says.`] }],
  enabled: true,
  family: "page",
  effective_at: "2026-01-01",
}));

const JOURNAL_POSTS = [
  { slug: "journal-first", title: "First entry", description: "Hello", family: "journal", enabled: true, window_start: "2025-05-01T00:00:00.000Z", window_end: null },
  { slug: "journal-undated", title: "Undated entry", description: "", family: "journal", enabled: true, window_start: null, window_end: null },
  { slug: "journal-future", title: "Not yet", description: "", family: "journal", enabled: true, window_start: "2099-01-01T00:00:00.000Z", window_end: null },
  { slug: "journal-ended", title: "Gone", description: "", family: "journal", enabled: true, window_start: "2020-01-01T00:00:00.000Z", window_end: "2021-01-01T00:00:00.000Z" },
  { slug: "journal-off", title: "Switched off", description: "", family: "journal", enabled: false, window_start: null, window_end: null },
].map((p) => ({ ...p, sections: [{ kind: "text", heading: p.title, body: ["A post."] }] }));

// The AI proposals and agency kit payloads keep the old shapes (lib/registry
// fixtures.js LEGACY_HERO_FIXTURES), so a mapper can be checked against them.
export const AI_PROPOSALS = Object.freeze([
  {
    title: "Say what the gift is",
    mechanism: "A clearer promise above the fold lifts clicks to the catalog.",
    component: "hero",
    evidence: ["f1"],
    draft: { title: "Gifts they will actually use", highlight: "actually", subtitle: "Twelve picks under one price." },
  },
  { title: "Tell shoppers about free shipping", mechanism: "A known threshold raises basket size.", component: "announcement", evidence: ["f2"], draft: { text: "Free shipping over ₹999", href: "/collections" } },
  { title: "Nothing to draft", mechanism: "Keep watching returns.", component: "none", evidence: [] },
]);
export const AGENCY_KIT_PAYLOAD = Object.freeze({
  hero: {
    title: "Your glow, daily.",
    highlight: "glow",
    subtitle: "Skincare and self-care rituals, picked with love.",
    primary: { label: "Shop the edit", href: "/collections" },
    secondary: { label: "What’s new", href: "#new" },
  },
  announcement: { enabled: false, text: "New season is here", href: "" },
  home_sections: [
    { kind: "new", title: "New in", limit: 8, enabled: true },
    { kind: "collections", title: "Shop by collection", limit: 6, enabled: true },
  ],
  brand: { accent: "#0d9488", radius: "8px" },
});
// What an agency kit applied at a6d028e left in the drafts (setBlock, no ids),
// and then went live in a version 2 release.
const AGENCY_HOME_SECTIONS = AGENCY_KIT_PAYLOAD.home_sections;

async function ensureAgency(db, agencyId) {
  const pdb = await platformOf(db, "an agency fixture");
  await pdb.execute({
    sql: "INSERT INTO agencies (id, name, status, referral_eligible, commission_bps, created_at, updated_at) VALUES (?, 'Fixture Agency', 'verified', 0, 1500, ?, ?) ON CONFLICT(id) DO NOTHING",
    args: [agencyId, NOW, NOW],
  });
  return pdb;
}

export const MAPPING_TRAPS = Object.freeze({
  nav_header_null: navTrap("header", "null"),
  nav_header_empty: navTrap("header", "empty"),
  nav_header_absent: navTrap("header", "absent"),
  nav_footer_null: navTrap("footer", "null"),
  nav_footer_empty: navTrap("footer", "empty"),
  nav_footer_absent: navTrap("footer", "absent"),
  announcement_set: {
    describe: "An announcement bar that is switched on with text and a link",
    apply(model) {
      setBlockBoth(model, "announcement", { enabled: true, text: "Free shipping over ₹999", href: "/collections" });
    },
  },
  announcement_empty: {
    describe: "An announcement row that is stored but empty and switched off (not the same as no row)",
    apply(model) {
      setBlockBoth(model, "announcement", { enabled: false, text: "", href: "" });
    },
  },
  home_sections_empty: {
    describe: "home_sections stored as [] (today that falls back to the default sections)",
    apply(model) {
      setBlockBoth(model, "home_sections", []);
    },
  },
  home_sections_no_ids: {
    describe: "Home sections with no ids (read keys them i-<n>; the mapper must give sec_l<i>)",
    apply(model) {
      setBlockBoth(model, "home_sections", SAFE_HOME_SECTIONS_NO_IDS);
    },
  },
  page_sections_no_ids: {
    describe: "A page whose sections have kinds but no ids",
    apply(model) {
      upsertPageBoth(model, {
        slug: "no-ids",
        title: "No ids",
        description: "",
        sections: [
          { kind: "text", heading: "One", body: ["First."] },
          { kind: "rich", heading: "Two", html: "<p>Second.</p>" },
        ],
        enabled: true,
      });
    },
  },
  page_sections_no_kind: {
    describe: "A page whose sections have no kind (they normalize to text)",
    apply(model) {
      upsertPageBoth(model, { slug: "no-kind", title: "No kind", description: "", sections: [{ heading: "Plain", body: ["Just words."] }, { heading: "", body: ["More words."] }], enabled: true });
    },
  },
  code_default_pages_default: codeDefaultPages("_default"),
  code_default_pages_beastlife: codeDefaultPages("beastlife"),
  policies_as_cms_pages: {
    describe: "The four policies (shipping, returns, terms, privacy) stored as cms_pages rows",
    apply(model) {
      for (const p of POLICY_PAGES) upsertPageBoth(model, p);
    },
  },
  journal_family: {
    describe: "Journal posts (shown, undated, scheduled, ended, switched off) and the /journal index built from them",
    apply(model) {
      for (const p of JOURNAL_POSTS) upsertPageBoth(model, p);
    },
  },
  agency_home_sections_v2: {
    describe: "Agency-written home sections with no ids, as a kit applied at a6d028e left them, stamped into a version 2 release",
    apply(model) {
      if (model.release && model.release.v !== 2) throw new Error("legacy-tenants: agency_home_sections_v2 goes with the live_v2 state (or a state with no release)");
      setBlockBoth(model, "home_sections", AGENCY_HOME_SECTIONS);
    },
  },
  highlight_unmatched: {
    describe: "A hero whose highlight is not in its title (it stays unaccented)",
    apply(model) {
      setBlockBoth(model, "hero", { title: "Glow from within", highlight: "Sparkle", subtitle: "Small batches.", primary: { label: "Shop", href: "/collections" } });
    },
  },
  hero_experiment_running: {
    describe: "A running hero experiment whose variant payload has the old hero shape",
    apply(model, { db }) {
      model.after.push(() => startHeroExperimentInside(db));
    },
  },
  ai_proposal_payload: {
    describe: "Stored AI proposals (hero and announcement drafts) in the old shape",
    apply(model) {
      model.after.push(async () => {
        const { exec } = await lib();
        await exec("INSERT INTO ai_insights (id, status, model, proposals, facts, tokens_in, tokens_out, created_at, updated_at) VALUES ('ins-fixture01', 'proposed', 'fixture-model', ?, ?, 0, 0, ?, ?)", [
          JSON.stringify(AI_PROPOSALS),
          JSON.stringify([{ id: "f1", text: "Visitors leave the home page" }, { id: "f2", text: "Baskets sit just under ₹999" }]),
          NOW,
          NOW,
        ]);
      });
    },
  },
  agency_kit_payload: {
    needsPlatform: true,
    describe: "An agency kit in the control plane, in the old scrubbed shape (hero, id-less home sections, announcement, brand)",
    apply(model, { db }) {
      model.afterPlatform.push(async () => {
        const pdb = await ensureAgency(db, "agc_fixture01");
        await pdb.execute({
          sql: "INSERT INTO agency_kits (id, agency_id, name, source_note, payload, created_at) VALUES ('akit_fixture01', 'agc_fixture01', 'Glow kit', 'Fixture source', ?, ?) ON CONFLICT(id) DO NOTHING",
          args: [JSON.stringify(AGENCY_KIT_PAYLOAD), NOW],
        });
      });
    },
  },
  home_hero_only: homeTrap("doc_home half customized: the hero is stored, home_sections is not (the default sections must be materialized)", CUSTOM_HERO, ABSENT),
  home_sections_only: homeTrap(
    "doc_home half customized: home_sections is stored, the hero is not (the default hero, whose title follows the store name: {store_name})",
    ABSENT,
    CUSTOM_HOME_SECTIONS,
  ),
  home_both_custom: homeTrap("doc_home with both halves stored", CUSTOM_HERO, CUSTOM_HOME_SECTIONS),
  home_both_default: homeTrap("doc_home with neither half stored: the whole home is the code default, the hero title follows the store name", ABSENT, ABSENT),
});

async function startHeroExperimentInside() {
  const X = await import("../../lib/experiments.js");
  await X.upsertExperiment(clone(HERO_EXPERIMENT));
  await X.startExperiment(HERO_EXPERIMENT.slug);
}

export const ENTITY_FIXTURES = Object.freeze({
  product_override_modules_badge: { describe: "A product with two modules and a badge", apply: entityOverride(201, [{ title: "How to use", html: "<p>Twice a day.</p>" }, { title: "Ingredients", html: "<p>Oils.</p>" }], "Lab tested", "Badge Serum") },
  product_override_six_modules: { describe: "A product with 6 modules, the legacy limit", apply: entityOverride(202, SIX_MODULES, null, "Six Modules") },
  product_override_long_module: { describe: "A product whose one module is 10000 characters of HTML", apply: entityOverride(203, [{ title: "Long read", html: LONG_MODULE_HTML }], null, "Long Module") },
  product_override_unsanitized_html: {
    describe: "A product whose module HTML today's sanitizer would rewrite (stored before sanitizing at save)",
    apply: entityOverride(204, [{ title: "Old paste", html: MODULE_HTML_SANITIZER_REWRITES }], "Old badge", "Old Paste"),
  },
  pdp_pairs_custom_title: {
    describe: "Product pairs with a custom title",
    apply: entityPlacement({ id: "pl_fx_pairs_title", kind: "pdp_pairs", source_product_id: P(210), target_product_ids: [P(211), P(212)], title: "Pairs well with", enabled: true, position: 0 }),
  },
  pdp_pairs_default_title: {
    describe: "Product pairs with no title of their own (the default title shows)",
    apply: entityPlacement({ id: "pl_fx_pairs_default", kind: "pdp_pairs", source_product_id: P(213), target_product_ids: [P(214)], title: null, enabled: true, position: 0 }),
  },
  pdp_pairs_disabled: {
    describe: "A switched-off pairs placement",
    apply: entityPlacement({ id: "pl_fx_pairs_off", kind: "pdp_pairs", source_product_id: P(215), target_product_ids: [P(216)], title: "Hidden pairs", enabled: false, position: 0 }),
  },
  pdp_pairs_two_on_one_source: {
    describe: "Two pairs placements on one source product, at different positions",
    apply(model, ctx) {
      entityPlacement({ id: "pl_fx_pairs_a", kind: "pdp_pairs", source_product_id: P(217), target_product_ids: [P(218)], title: "First pairs", enabled: true, position: 0 })(model, ctx);
      entityPlacement({ id: "pl_fx_pairs_b", kind: "pdp_pairs", source_product_id: P(217), target_product_ids: [P(219)], title: "Second pairs", enabled: true, position: 1 })(model, ctx);
    },
  },
  cart_upsell: {
    describe: "A cart upsell placement with a title and a position",
    apply: entityPlacement({ id: "pl_fx_cart", kind: "cart_upsell", source_product_id: null, target_product_ids: [P(220), P(221)], title: "Add to your order", enabled: true, position: 2 }),
  },
  collection_pins: {
    describe: "A collection with pinned products in a chosen order",
    apply(model) {
      const pinned = [P(232), P(230)];
      model.after.push(async () => {
        for (const n of [230, 231, 232]) await addProduct(n);
        await addCollection(230, { handle: "pinned-col", products: [230, 231, 232] });
        const { exec } = await lib();
        await exec("INSERT OR REPLACE INTO collection_overrides (collection_id, pinned, updated_at) VALUES (?, ?, ?)", [COL(230), JSON.stringify(pinned), NOW]);
      });
      pushFrozen(model, "collection_pins", { collection_id: COL(230), pinned });
    },
  },
  surface_templates_products: {
    describe: "A per-product template choice (surface_templates.products)",
    apply(model, ctx) {
      model.after.push(() => addProduct(240, { title: "Editorial Product" }));
      surfaceMap("products", { [P(240)]: "editorial" })(model, ctx);
    },
  },
  surface_templates_collections: {
    describe: "A per-collection template choice (surface_templates.collections)",
    apply(model, ctx) {
      model.after.push(() => addCollection(241, { handle: "sidebar-col" }));
      surfaceMap("collections", { [COL(241)]: "sidebar" })(model, ctx);
    },
  },
  redirect_to_page: {
    describe: "An old address that redirects to a page",
    apply: entityRedirect("old-about", "redirect-page", (model) =>
      upsertPageBoth(model, { slug: "redirect-page", title: "Redirect target", description: "", sections: [{ kind: "text", heading: "Here", body: ["Moved here."] }], enabled: true }),
    ),
  },
  redirect_to_journal_post: {
    describe: "An old address that redirects to a journal post",
    apply: entityRedirect("old-post-address", "redirect-post", (model) =>
      upsertPageBoth(model, { slug: "redirect-post", title: "Redirect post", description: "", sections: [{ kind: "text", heading: "Post", body: ["Moved here."] }], enabled: true, family: "journal", window_start: "2025-01-01T00:00:00.000Z" }),
    ),
  },
  redirect_to_code_default_page: { describe: "An old address that redirects to a code-default page (terms) that has no cms_pages row", apply: entityRedirect("old-terms", "terms") },
  redirect_to_nothing: { describe: "An old address that redirects to a slug nothing serves", apply: entityRedirect("old-gone", "gone-forever") },
  cms_templates_two_families: {
    describe: "Saved templates in two families (page and journal)",
    apply(model) {
      model.after.push(async () => {
        const { exec } = await lib();
        for (const [id, name, family, sections] of [
          ["tpl_fixture_page", "Plain page", "page", [{ kind: "text", heading: "Intro", body: ["Start here."] }]],
          ["tpl_fixture_post", "Journal post", "journal", [{ kind: "rich", heading: "", html: "<p>Write here.</p>" }]],
        ]) {
          await exec("INSERT OR REPLACE INTO cms_templates (id, name, family, sections, version, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)", [id, name, family, JSON.stringify(sections), NOW, NOW]);
        }
      });
    },
  },
  cms_approvals: {
    describe: "Approval rows (the approvals workflow is in use, so cutover must refuse until DOC-13)",
    apply(model) {
      model.after.push(async () => {
        const { exec } = await lib();
        await exec("INSERT INTO cms_approvals (draft_hash, actor, note, created_at) VALUES (?, 'user:fixture-owner', 'Looks good', ?), (?, 'user:fixture-staff', NULL, ?)", ["a".repeat(64), NOW, "b".repeat(64), NOW]);
      });
    },
  },
  agency_grant: {
    needsPlatform: true,
    describe: "An accepted agency grant on this store (cutover must refuse until DOC-13)",
    apply(model, { db }) {
      model.afterPlatform.push(async () => {
        const pdb = await ensureAgency(db, "agc_fixture02");
        await pdb.execute({
          sql: "INSERT INTO agency_grants (id, agency_id, tenant_id, client_email, role, status, token_hash, expires_at, accepted_by, accepted_at, created_at) VALUES (?, 'agc_fixture02', ?, 'owner@fixture.test', 'staff', 'accepted', NULL, '2099-01-01T00:00:00.000Z', 'usr_fixture', ?, ?) ON CONFLICT(id) DO NOTHING",
          args: [`agr_fixture_${db.id.replace(/[^a-z0-9]/g, "")}`, db.id, NOW, NOW],
        });
      });
    },
  },
});

// ---- buildLegacyTenant ---------------------------------------------------------------------

/**
 * Fill a file-database tenant with legacy content.
 *   state     a STATE_ROWS name (default "no_release_open")
 *   traps     MAPPING_TRAPS names, applied in order
 *   entities  ENTITY_FIXTURES names, applied in order
 *   set       a CONTENT_SETS name (default "vgate")
 *   drafts    write the set's drafts (default true; the vgate recorder wrote none)
 * Traps and entities change the drafts AND the live release the state puts
 * live (v2 and v3 releases freeze entity rows in their own arrays; a v1
 * release reads the live tables). Returns a manifest of what was built.
 */
export async function buildLegacyTenant(db, { state = "no_release_open", traps = [], entities = [], set = "vgate", drafts = true } = {}) {
  assertFileDb(db);
  const st = STATE_ROWS[state];
  if (!st) throw new Error(`legacy-tenants: unknown state "${state}" (use ${Object.keys(STATE_ROWS).join(", ")})`);
  const cs = CONTENT_SETS[set];
  if (!cs) throw new Error(`legacy-tenants: unknown content set "${set}"`);
  for (const t of traps) if (!MAPPING_TRAPS[t]) throw new Error(`legacy-tenants: unknown trap "${t}"`);
  for (const e of entities) if (!ENTITY_FIXTURES[e]) throw new Error(`legacy-tenants: unknown entity fixture "${e}"`);
  const platformNeeds = [...traps.filter((t) => MAPPING_TRAPS[t].needsPlatform), ...entities.filter((e) => ENTITY_FIXTURES[e].needsPlatform)];
  if (platformNeeds.length) await platformOf(db, platformNeeds.join(" and "));
  let release = null;
  if (st.release != null) {
    release = clone(cs.releases[`v${st.release}`]);
    if (!release) throw new Error(`legacy-tenants: content set "${set}" has no version ${st.release} release`);
  }
  const model = {
    set,
    state,
    db,
    blocks: drafts ? clone(cs.drafts.blocks) : {},
    pages: drafts ? clone(cs.drafts.pages) : [],
    release,
    rawBlocks: new Set(),
    rawPages: new Set(),
    removedPages: new Set(),
    after: [],
    afterPlatform: [],
  };
  const ctx = { db, set: cs };
  for (const t of traps) MAPPING_TRAPS[t].apply(model, ctx);
  for (const e of entities) ENTITY_FIXTURES[e].apply(model, ctx);

  const { exec, R } = await lib();
  const releases = { live: null, scheduled: null };
  await db.run(async () => {
    await cs.catalog();
    await cs.liveTables();
    if (drafts || model.rawBlocks.size || model.rawPages.size) {
      if (cs.writeDrafts) await cs.writeDrafts(model);
      else {
        for (const [key, value] of Object.entries(model.blocks)) if (!model.rawBlocks.has(key)) await writeBlockRaw(key, value);
        for (const p of model.pages) if (!model.rawPages.has(p.slug)) await writePageRaw(p);
      }
      for (const key of model.rawBlocks) await writeBlockRaw(key, Object.hasOwn(model.blocks, key) ? model.blocks[key] : undefined);
      for (const p of model.pages) if (model.rawPages.has(p.slug)) await writePageRaw(p);
      for (const slug of model.removedPages) await exec("DELETE FROM cms_pages WHERE slug = ?", [slug]);
    }
    for (const fn of model.after) await fn();
  });
  for (const fn of model.afterPlatform) await fn();
  if (release) {
    releases.live = cs.releaseId(st.release);
    await putLiveRelease(db, releases.live, release);
  }
  if (st.scheduled) {
    releases.scheduled = `${cs.releaseId(3)}_scheduled`;
    const content = clone(release || cs.releases.v3 || { v: 3, blocks: {}, pages: [], brand: null, theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] });
    await db.run(() =>
      exec("INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, 'scheduled by the fixture', NULL, ?, '2099-01-01T00:00:00.000Z', NULL)", [
        releases.scheduled,
        R.stableStringify(content),
        `hash_${releases.scheduled}`,
        NOW,
      ]),
    );
  }
  if (st.error) {
    releases.live = `${cs.releaseId(0)}_error`;
    await db.run(async () => {
      await exec("INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, 'no envelope version', NULL, ?, NULL, ?)", [
        releases.live,
        JSON.stringify({ blocks: {}, pages: [] }),
        `hash_${releases.live}`,
        NOW,
        NOW,
      ]);
      await exec("UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", [releases.live, NOW]);
    });
  }
  return { id: db.id, url: urlOf(db), set, state, flag: st.flag ?? null, traps: [...traps], entities: [...entities], drafts, releases, release: release ? clone(release) : null };
}

// A registered tenant from the world, then buildLegacyTenant. The tenant's
// id, name and config default to the content set's.
export async function makeLegacyTenant(world, { id, name, file, config, secrets, stage, state, traps, entities, set = "vgate", drafts } = {}) {
  const cs = CONTENT_SETS[set];
  if (!cs) throw new Error(`legacy-tenants: unknown content set "${set}"`);
  const db = await world.tenant({
    id: id ?? cs.tenant.id,
    name: name ?? cs.tenant.name,
    file,
    config: config ?? cs.tenant.config,
    secrets: secrets ?? cs.tenant.secrets,
    stage,
  });
  const manifest = await buildLegacyTenant(db, { state, traps, entities, set, drafts });
  return { db, manifest };
}

// ---- recordOutputs ------------------------------------------------------------------------

export const settle = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { threw: String(e?.code || e?.name || "Error"), message: String(e?.message || e) };
  }
};

export const routeKey = (fn, args) => `${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`;

// Calls for getters LEGACY_RELEASE_ROUTES does not name, or more calls for
// ones it does; any exported resolved* getter not listed here is called with
// no arguments, so a getter added later is still recorded.
const EXTRA_ROUTES = [
  ["resolvedHomePage", []],
  ["resolvedJournalEntries", []],
  ["resolvedContentPage", ["terms"]],
  ["resolvedSurfaceTemplateFor", ["pdp", P(240)]],
  ["resolvedSurfaceTemplateFor", ["collection", COL(241)]],
  ["resolvedProductOverride", [P(201)]],
  ["resolvedCollectionPins", ["pinned-col"]],
  ["resolvedPdpPairs", [P(217)]],
  ["resolvedSlugRedirect", ["old-terms"]],
];

export async function resolvedGetterNames() {
  const Res = await import("../../lib/content/resolve.js");
  return Object.keys(Res)
    .filter((k) => /^resolved[A-Z]/.test(k) && typeof Res[k] === "function")
    .sort();
}

export async function allGetterRoutes() {
  const names = await resolvedGetterNames();
  const routes = [...LEGACY_RELEASE_ROUTES, ...EXTRA_ROUTES].filter(([fn]) => names.includes(fn)).map(([fn, args]) => [fn, clone(args)]);
  for (const n of names) if (!routes.some(([fn]) => fn === n)) routes.push([n, []]);
  return routes;
}

/**
 * What the store answers, as plain JSON (Maps, Dates and undefined the way
 * JSON.stringify writes them).
 *   routes   [[getterName, args], …]; default allGetterRoutes()
 *   getters  the object to call them on; default lib/content/resolve.js (pass
 *            P4-SEAM's contentGettersFor(src) to record another source)
 *   state    also record getLiveReleaseState() and contentSource() first
 *            (default true)
 * A getter that throws is recorded as { threw, message }.
 */
export async function recordOutputs(db, { routes, getters, state = true } = {}) {
  assertFileDb(db);
  const Res = await import("../../lib/content/resolve.js");
  const R = await import("../../lib/releases.js");
  const list = routes ?? (await allGetterRoutes());
  const on = getters ?? Res;
  for (const [fn] of list) if (typeof on[fn] !== "function") throw new Error(`legacy-tenants: no getter "${fn}" to record`);
  const rec = {};
  if (state) {
    rec.getLiveReleaseState = await db.run(() => settle(() => R.getLiveReleaseState()));
    rec.contentSource = await db.run(() => settle(() => Res.contentSource()));
  }
  for (const [fn, args] of list) rec[routeKey(fn, args)] = await db.run(() => settle(() => on[fn](...args)));
  return JSON.parse(JSON.stringify(rec));
}

// ---- re-run fixtures for CUTOVER and REVERSE ------------------------------------------------

async function bodyFor(type, { meta, sections } = {}) {
  const Reg = await import("../../lib/registry/index.js");
  const { documentHash, ensureIds } = await import("../../lib/registry/body.js");
  let body = Reg.emptyBody(type);
  if (meta) body.meta = { ...body.meta, ...meta };
  if (sections) body.sections = sections;
  const r = Reg.validateDocument(ensureIds(body), { mode: "draft" });
  if (!r.ok) throw new Error(`legacy-tenants: the fixture's ${type} body does not validate: ${JSON.stringify(r.issues).slice(0, 300)}`);
  body = r.body;
  return { body, hash: await documentHash(body), schema: Reg.SCHEMA_VERSION };
}

async function insertDocument({ id, type, slug = null, entityId = null, label, body, hash, schema, at, versionKind = "checkpoint", note = "Created" }) {
  const { exec } = await lib();
  const { bodyHash } = await import("../../lib/documents/versions.js");
  // deterministic, in the ver_<16 hex> shape the service mints
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fixture:${id}:${versionKind}:${hash}`));
  const verId = `ver_${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16)}`;
  await exec(
    "INSERT INTO documents (id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, published_version_id, published_hash, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, NULL)",
    [id, type, slug, entityId, label, JSON.stringify(body), hash, schema, at, at],
  );
  await exec("INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)", [
    verId,
    id,
    versionKind,
    JSON.stringify(body),
    await bodyHash(body),
    schema,
    note,
    at,
  ]);
  return verId;
}

const PHASE3_AT = "2026-02-01T00:00:00.000Z";

/**
 * Leftovers from phase 3 on a legacy tenant (build the tenant first):
 *   · a product_content document with a random (phase-3) id for the set's
 *     first product, which the cutover must reuse, never duplicate;
 *   · a page document with a random id holding the slug "about", which a
 *     legacy page also uses: a slug collision the cutover must refuse.
 */
export async function buildPhase3Leftovers(db, { productId, slug = "about" } = {}) {
  assertFileDb(db);
  const { newRouteId } = await import("../../lib/documents/ids.js");
  const product = productId ?? P(1);
  const productDoc = newRouteId();
  const pageDoc = newRouteId();
  await db.run(async () => {
    const pc = await bodyFor("product_content");
    await insertDocument({ id: productDoc, type: "product_content", entityId: product, label: "Product content", ...pc, at: PHASE3_AT });
    const pg = await bodyFor("page", { meta: { slug, title: "About (made in the new editor)" } });
    await insertDocument({ id: pageDoc, type: "page", slug, label: "About (made in the new editor)", ...pg, at: PHASE3_AT });
  });
  return { productId: product, productDocumentId: productDoc, collidingSlug: slug, collidingDocumentId: pageDoc };
}

const STALE_AT = "2026-03-01T00:00:00.000Z";
const NEWER_AT = "2026-03-02T00:00:00.000Z";

/**
 * A "stale backfill": an earlier cutover run wrote documents and live rows,
 * then was aborted (the store went back to legacy), and the founder kept
 * editing in the old editors. A re-run must take the NEWER legacy content and
 * keep the older differing drafts as kept versions. Build the tenant first
 * (the vgate set: it needs product 1, collection 2 and the about page).
 */
export async function buildStaleBackfill(db) {
  assertFileDb(db);
  const { productDocumentId, collectionDocumentId, backfillRouteId } = await import("../../lib/documents/ids.js");
  const { legacyHeroToSection, legacyHomeSectionsToSections, legacyPageSectionsToSections } = await import("../../lib/registry/legacy.js");
  const { exec } = await lib();
  const product = P(1);
  const collection = COL(2);
  const ids = {
    run: "mrun_stale_fixture",
    home: "doc_home",
    about: await backfillRouteId("page", "about"),
    product: await productDocumentId(product),
    collection: await collectionDocumentId(collection),
  };
  const older = {
    hero: { title: "Older hero", subtitle: "From the aborted run", primary: { label: "Shop", href: "/collections" } },
    aboutTitle: "About (older)",
    badge: "OLDER",
    modules: [{ title: "Older module", html: "<p>older</p>" }],
    pinned: [P(1)],
  };
  const newer = {
    hero: { title: "Newer hero", subtitle: "Edited after the abort", primary: { label: "Shop", href: "/collections" } },
    aboutTitle: "About (newer)",
    badge: "NEWER",
    modules: [{ title: "Newer module", html: "<p>newer</p>" }],
    pinned: [P(2), P(1)],
  };
  const versions = {};
  await db.run(async () => {
    const S = await import("../../lib/cms/store.js");
    const homeSections = (await S.getHomeSections()) || [];
    const home = await bodyFor("home", { sections: [legacyHeroToSection(older.hero), ...legacyHomeSectionsToSections(homeSections.filter((s) => s.kind !== "hero"))] });
    versions.home = await insertDocument({ id: ids.home, type: "home", label: "Home page", ...home, at: STALE_AT, versionKind: "migrated", note: "Backfill (aborted run)" });
    const about = await bodyFor("page", { meta: { slug: "about", title: older.aboutTitle }, sections: legacyPageSectionsToSections([{ heading: "Story", body: ["Older words."] }]) });
    versions.about = await insertDocument({ id: ids.about, type: "page", slug: "about", label: older.aboutTitle, ...about, at: STALE_AT, versionKind: "migrated", note: "Backfill (aborted run)" });
    const pc = await bodyFor("product_content");
    versions.product = await insertDocument({ id: ids.product, type: "product_content", entityId: product, label: "Product content", ...pc, at: STALE_AT, versionKind: "migrated", note: "Backfill (aborted run)" });
    // live rows the aborted run wrote (legacy-derived columns only)
    await exec(
      "INSERT INTO product_content_live (product_id, document_id, version_id, badge, modules, pairs, published_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET badge = excluded.badge, modules = excluded.modules",
      [product, ids.product, versions.product, older.badge, JSON.stringify(older.modules), JSON.stringify([P(3)]), STALE_AT],
    );
    await exec("INSERT INTO collection_content_live (collection_id, document_id, version_id, pinned, published_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(collection_id) DO UPDATE SET pinned = excluded.pinned", [
      collection,
      ids.collection,
      "ver_stalecollection",
      JSON.stringify(older.pinned),
      STALE_AT,
    ]);
    await exec("INSERT INTO cms_migration_runs (id, kind, step, source_hash, dry_run_digest, backup_ref, report, started_at, finished_at, outcome) VALUES (?, 'cutover', 'backfill', 'stale-source-hash', NULL, NULL, ?, ?, ?, 'aborted')", [
      ids.run,
      JSON.stringify({ note: "aborted by the fixture after backfill" }),
      STALE_AT,
      STALE_AT,
    ]);
    await exec("UPDATE cms_state SET mode = 'legacy', cutover_release_id = NULL, updated_at = ? WHERE id = 1", [STALE_AT]);
    // then the founder kept editing in the old editors
    const heroRow = await exec("SELECT value FROM cms_blocks WHERE key = 'hero'");
    const hero = heroRow.rows[0] ? JSON.parse(heroRow.rows[0].value) : {};
    await exec("INSERT INTO cms_blocks (key, value, updated_at) VALUES ('hero', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [JSON.stringify({ ...hero, ...newer.hero }), NEWER_AT]);
    await exec("UPDATE cms_pages SET title = ?, updated_at = ? WHERE slug = 'about'", [newer.aboutTitle, NEWER_AT]);
    await exec("INSERT INTO product_overrides (product_id, modules, badge, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET modules = excluded.modules, badge = excluded.badge, updated_at = excluded.updated_at", [
      product,
      JSON.stringify(newer.modules),
      newer.badge,
      NEWER_AT,
    ]);
    await exec("INSERT INTO collection_overrides (collection_id, pinned, updated_at) VALUES (?, ?, ?) ON CONFLICT(collection_id) DO UPDATE SET pinned = excluded.pinned, updated_at = excluded.updated_at", [
      collection,
      JSON.stringify(newer.pinned),
      NEWER_AT,
    ]);
  });
  return { ids, versions, older, newer, abortedAt: STALE_AT, editedAt: NEWER_AT };
}

export const RERUN_FIXTURES = Object.freeze({
  phase3_leftovers: { describe: "A phase-3 random-id product content row, and a page document holding a slug a legacy page also uses", build: buildPhase3Leftovers },
  stale_backfill: { describe: "Documents and live rows from an earlier aborted run, then newer legacy edits", build: buildStaleBackfill },
});

// ---- rendering with Next's SWC (the home and journal recorders) --------------------------

export async function renderKit() {
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
  const link = { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) };

  // The home recorder's loader: app/ and components/ files are compiled (and
  // their own imports followed); everything else is imported as is.
  function jsxTreeLoader(stubs = {}) {
    const STUBS = { "next/link": link, ...stubs };
    const toFile = (from, id) => {
      const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
      return p.endsWith(".js") ? p : `${p}.js`;
    };
    const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
    const exists = async (f) =>
      readFile(f).then(
        () => true,
        () => false,
      );
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
          let target = toFile(file, id);
          if (!(await exists(target))) target = join(target.slice(0, -3), "index.js"); // a folder import
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
    return loadJsx;
  }

  // The journal recorder's loader: one page compiled, its imports imported.
  async function loadPage(file) {
    const STUBS = { "next/link": link };
    const mod = { exports: {} };
    const code = await compile(file);
    const deps = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in STUBS || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
      if (id.startsWith("@/") || id.startsWith(".")) {
        const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
        deps.set(id, await import(pathToFileURL(p.endsWith(".js") ? p : `${p}.js`).href));
      } else deps.set(id, require(id));
    }
    const req = (id) => (id in STUBS ? STUBS[id] : id === "react" ? React : id === "react/jsx-runtime" ? require("react/jsx-runtime") : deps.get(id));
    new Function("require", "module", "exports", code)(req, mod, mod.exports);
    return mod.exports;
  }

  return { require, React, renderToStaticMarkup, jsxTreeLoader, loadPage };
}
