// What the storefront reads from a version 1, 2 and 3 release (P2-VGATE).
//
//   node scripts/support/legacy-release-outputs.js            prints the JSON
//   node scripts/support/legacy-release-outputs.js <out.json> writes it
//
// Builds one throwaway tenant (file databases in the checkout's root), puts
// three hand-made releases live in turn (v1, v2 and v3), and records what
// getLiveReleaseState(), contentSource() and every resolved* getter return for
// each. It imports the app through relative paths, so running this same file
// inside an older checkout records that checkout's answers.
// scripts/fixtures/legacy-release-outputs.a6d028e.json was recorded this way
// from a6d028e, and test:releases compares today's answers with it.
//
// Plain JSON only: Maps, Dates and undefined are written the way JSON.stringify
// writes them. Nothing here reaches the network.
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);

registerHooks({
  resolve(spec, ctx, next) {
    if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-vgate-legacy-default.db";
process.env.PLATFORM_DB_URL = "file:.test-vgate-legacy-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const DBS = [".test-vgate-legacy-default.db", ".test-vgate-legacy-platform.db", ".test-vgate-legacy-t.db"];
for (const f of DBS) await rm(join(ROOT, f), { force: true });

const C = await import("../../lib/platform/control.js");
const { withTenant } = await import("../../lib/tenant-context.js");
const { libsql } = await import("../../lib/db.js");
const R = await import("../../lib/releases.js");
const Res = await import("../../lib/content/resolve.js");
const { loadMigrations, runMigrations } = await import("../../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({
  id: "vgl",
  name: "Legacy Outputs",
  domains: ["vgl.test"],
  dbUrl: "file:.test-vgate-legacy-t.db",
  config: { site: { name: "Legacy Outputs" } },
  secrets: { order_link_secret: "vgl-link-secret" },
});
const T = await C.getTenant("vgl");
const inT = (fn) => withTenant(T, fn);

const P = (id) => `gid://shopify/Product/${id}`;
const COL = (id) => `gid://shopify/Collection/${id}`;
const NOW = "2026-01-01T00:00:00.000Z";

await inT(async () => {
  await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));
  const run = (sql, args = []) => libsql.execute({ sql, args });
  await run("INSERT INTO collections (id, handle, title, synced_at) VALUES (?, 'whey', 'Whey', ?), (?, 'serums', 'Serums', ?)", [COL(1), NOW, COL(2), NOW]);
  for (const [id, handle, title, price] of [
    [1, "glow-serum", "Glow Serum", 1299],
    [2, "night-cream", "Night Cream", 899],
    [3, "whey-gold", "Whey Gold", 2499],
  ]) {
    await run(
      "INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?)",
      [P(id), handle, title, price, price, NOW],
    );
    await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [
      `gid://shopify/ProductVariant/${id}`,
      P(id),
      price,
    ]);
  }
  await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0), (?, ?, 1), (?, ?, 0)", [COL(2), P(1), COL(2), P(2), COL(1), P(3)]);
  // The live tables a v1 release falls back to. v2 and v3 freeze their own.
  await run("INSERT INTO product_overrides (product_id, modules, badge) VALUES (?, ?, 'TABLE')", [P(1), JSON.stringify([{ title: "From the table", html: "<p>table</p>" }])]);
  await run("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(2), JSON.stringify([P(2)])]);
  await run(
    "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position) VALUES ('pl_tbl_pairs', 'pdp_pairs', ?, ?, 'Table pairs', 1, 0), ('pl_tbl_cart', 'cart_upsell', NULL, ?, 'Table upsell', 1, 0)",
    [P(1), JSON.stringify([P(3)]), JSON.stringify([P(2)])],
  );
  await run("INSERT INTO page_redirects (from_slug, to_slug, created_at) VALUES ('old-post', 'table-post', ?)", [NOW]);
});

// ---- the three envelopes ---------------------------------------------------------

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

const FIXTURES = {
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
    pages: [
      ...pagesV1.slice(1),
      { slug: "about", title: "About", description: "", sections: [{ id: "sec_cc33", kind: "text", heading: "Story", body: ["v3"] }], enabled: true },
    ],
    brand: null,
    theme,
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  },
};

async function putLive(id, content) {
  await inT(async () => {
    await libsql.execute({
      sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)",
      args: [id, R.stableStringify(content), `hash_${id}`, `note ${id}`, NOW, NOW],
    });
    await libsql.execute({ sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", args: [id, NOW] });
  });
}

const settle = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { threw: String(e?.code || e?.name || "Error"), message: String(e?.message || e) };
  }
};

// Every getter, with arguments that reach each branch the fixtures can reach.
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

const out = { recordedFrom: "scripts/support/legacy-release-outputs.js", fixtures: {} };
for (const [name, content] of Object.entries(FIXTURES)) {
  await putLive(`rel_fixture_${name}`, content);
  const rec = {};
  rec.getLiveReleaseState = await inT(() => settle(() => R.getLiveReleaseState()));
  rec.contentSource = await inT(() => settle(() => Res.contentSource()));
  for (const [fn, args] of GETTERS) rec[`${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`] = await inT(() => settle(() => Res[fn](...args)));
  out.fixtures[name] = JSON.parse(JSON.stringify(rec));
}

for (const f of DBS) await rm(join(ROOT, f), { force: true });
const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json);
else process.stdout.write(json);
process.exit(0);
