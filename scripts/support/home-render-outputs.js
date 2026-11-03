// What the home page and content pages render on a legacy store (P2-SECTIONS).
//
//   node scripts/support/home-render-outputs.js            prints the JSON
//   node scripts/support/home-render-outputs.js <out.json> writes it
//
// Builds throwaway legacy tenants (file databases in the checkout's root) and
// renders, to HTML, with Next's SWC and react-dom/server:
//   · app/(storefront)/page.js, the real home page, and
//   · components/ContentPage.js for a set of pages,
// in each of these states (every product in stock, every rail above its
// minimum):
//   drafts          no release: the legacy drafts
//   exp_b, exp_control, exp_founder, exp_preview
//                   a running hero experiment: a visitor in variant b, one
//                   in control, a browser signed in to the console, and the
//                   founder's preview (the PV-08 note)
//   candidate       an S59 preview with unsaved hero and sections
//   v1, v2, v3      a version 1, 2 and 3 release live
//   empty           a store with no products yet (GEN-03)
// It imports the app through relative paths, so running this same file inside
// an older checkout records that checkout's output.
// scripts/fixtures/home-render-outputs.a6d028e.json was recorded this way from
// a6d028e, and test:sections-render compares today's output with it (after
// taking out the data-section-id and data-section-kind attributes P2-SECTIONS
// adds). Nothing here reaches the network.
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);

// next/headers answers for one simulated request at a time.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__homeRenderRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() { const r = req(); return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) }; }
export async function cookies() { const r = req(); return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) }; }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

const PREFIX = process.env.HOME_RENDER_DB_PREFIX || ".test-home-render";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = `file:${PREFIX}-default.db`;
process.env.PLATFORM_DB_URL = `file:${PREFIX}-platform.db`;
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const DBS = [`${PREFIX}-default.db`, `${PREFIX}-platform.db`, `${PREFIX}-hr.db`, `${PREFIX}-hre.db`];
for (const f of DBS) await rm(join(ROOT, f), { force: true });

const C = await import("../../lib/platform/control.js");
const { withTenant } = await import("../../lib/tenant-context.js");
const { libsql } = await import("../../lib/db.js");
const R = await import("../../lib/releases.js");
const S = await import("../../lib/cms/store.js");
const X = await import("../../lib/experiments.js");
const Res = await import("../../lib/content/resolve.js");
const { setPreviewCandidate } = await import("../../lib/cms/candidates.js");
const { loadMigrations, runMigrations } = await import("../../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
for (const [id, name] of [
  ["hr", "Glow Works"],
  ["hre", "Empty Works"],
]) {
  await C.upsertTenant({ id, name, domains: [`${id}.test`], dbUrl: `file:${PREFIX}-${id}.db`, config: { site: { name } }, secrets: { order_link_secret: `${id}-link-secret` } });
}
const T = await C.getTenant("hr");
const TE = await C.getTenant("hre");
const inT = (fn, tenant = T) => withTenant(tenant, fn);

const P = (id) => `gid://shopify/Product/${id}`;
const COL = (id) => `gid://shopify/Collection/${id}`;
const NOW = "2026-01-01T00:00:00.000Z";
const SHOP_IMG = (n) => `https://cdn.shopify.com/s/files/1/0001/products/p${n}.jpg`;
const LIB_IMG = "/api/media/med_ae5f4af4b10aec0b01";

const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
for (const tenant of [T, TE]) {
  await inT(async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, migrations);
  }, tenant);
}

// The catalog: three collections of three products each, all in stock.
await inT(async () => {
  const run = (sql, args = []) => libsql.execute({ sql, args });
  await run("INSERT INTO collections (id, handle, title, image, image_alt, synced_at) VALUES (?, 'serums', 'Serums', ?, 'Serum bottles', ?), (?, 'whey', 'Whey', NULL, NULL, ?), (?, 'gifts', 'Gifts', ?, '', ?)", [
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
    await run(
      "INSERT INTO products (id, handle, title, product_type, price_min, price_max, compare_at_min, currency, available, featured_image, featured_image_alt, created_at, synced_at) VALUES (?, ?, ?, 'Care', ?, ?, ?, 'INR', 1, ?, ?, ?, ?)",
      [P(n), handle, title, price, price, n === 4 ? 2999 : null, img, img ? `${title} photo` : null, `2025-0${1 + (n % 9)}-01T00:00:00.000Z`, NOW],
    );
    await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${n}`, P(n), price]);
    await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)", [COL(col), P(n), n % 3]);
  }
  // the founder's pinned order for one collection
  await run("INSERT INTO collection_overrides (collection_id, pinned) VALUES (?, ?)", [COL(2), JSON.stringify([P(6)])]);
});

// ---- the content ---------------------------------------------------------------

const HERO = {
  title: "Glow from within",
  highlight: "Glow",
  subtitle: "Clean skincare, made in small batches.",
  primary: { label: "Shop serums", href: "/collections/serums" },
  secondary: { label: "What’s new", href: "#new" },
  badge: "",
};
const SECTIONS = [
  { id: "sec_coll01", kind: "collections", title: "Shop by collection", limit: 3 },
  { id: "sec_new001", kind: "new", title: "New arrivals", limit: 4 },
  { id: "sec_bann01", kind: "banner", title: "Free shipping", text: "On every order this week.", label: "Shop now", href: "/collections/gifts" },
  { id: "sec_rich01", kind: "rich_text", title: "Our story", html: "<p>Made <strong>by hand</strong>.</p>" },
  { id: "sec_img001", kind: "image_with_text", image: LIB_IMG, image_alt: "A jar on linen", image_side: "right", title: "Why it works", text: "Three oils.", label: "Read", href: "/about" },
  { id: "sec_rail01", kind: "product_rail", title: "Serums", collection: "serums", collection_id: COL(1), limit: 3 },
  { id: "sec_rail02", kind: "product_rail", title: "Whey", collection: "whey", collection_id: COL(2), limit: 4 },
  { id: "sec_new002", kind: "new", title: "More new", limit: 2 },
];
const PAGES = [
  { slug: "about", title: "About us", description: "Who we are", sections: [{ heading: "Story", body: ["We began in a kitchen.", "Now we ship everywhere."] }, { kind: "text", heading: "", body: ["No heading here."] }] },
  { slug: "shipping", title: "Shipping", effective_at: "2026-01-01", sections: [{ kind: "rich", heading: "Times", html: "<p>Two <em>days</em>.</p>" }, { kind: "text", heading: "Costs", body: ["Free over ₹999."] }] },
  { slug: "faq", title: "Questions", sections: [{ kind: "faq", heading: "Orders", items: [{ q: "How long does delivery take?", a: "<p>Two days.</p>" }, { q: "Can I return?", a: "<p>Yes, in 7 days.</p>" }] }] },
  { slug: "gallery", title: "Gallery", sections: [{ kind: "image", src: LIB_IMG, alt: "The workshop", caption: "Where we make it" }, { kind: "image", src: SHOP_IMG(1), alt: "A serum", caption: "" }] },
];

await inT(async () => {
  await S.setBlock("hero", HERO);
  await S.setBlock("home_sections", SECTIONS);
  await S.setBlock("collections_index", { featured: ["serums", "gifts"], order: [], hide: [] });
  for (const p of PAGES) await S.upsertContentPage(p);
});

const blocksOf = (over = {}) => ({
  hero: HERO,
  announcement: { enabled: false, text: "", href: "" },
  nav_header: null,
  nav_footer: null,
  home_sections: SECTIONS,
  collections_index: { featured: ["serums", "gifts"], order: [], hide: [] },
  pdp_extras: [],
  ...over,
});
const livePages = (tag) => PAGES.map((p) => ({ description: "", enabled: true, family: "page", effective_at: null, ...p, title: `${p.title} ${tag}` }));
const RELEASES = {
  // v1: id-less home sections, as releases from before S54 hold them
  v1: { v: 1, blocks: blocksOf({ hero: { ...HERO, title: "Glow live v1" }, home_sections: SECTIONS.map(({ id, ...s }) => s) }), pages: livePages("v1"), brand: null, theme: null },
  v2: {
    v: 2,
    blocks: blocksOf({ hero: { ...HERO, title: "Glow live v2", badge: "New season" }, home_sections: SECTIONS.slice(0, 6).map(({ id, ...s }, i) => (i % 2 ? { id, ...s } : s)) }),
    pages: livePages("v2"),
    brand: null,
    theme: null,
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  },
  v3: {
    v: 3,
    blocks: blocksOf({ hero: { ...HERO, title: "Glow live v3", secondary: null }, home_sections: [...SECTIONS].reverse() }),
    pages: livePages("v3"),
    brand: null,
    theme: null,
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

// ---- rendering --------------------------------------------------------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
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
const exists = async (f) => readFile(f).then(
  () => true,
  () => false,
);
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/components/site/MarketingHome": { __esModule: true, default: () => null },
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
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"))).default;
const ContentPage = (await loadJsx(join(ROOT, "components/ContentPage.js"))).default;

const html = (el) => renderToStaticMarkup(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, el));
async function asRequest(host, cookies, fn) {
  globalThis.__homeRenderRequest = { host, cookies };
  try {
    return await fn();
  } finally {
    globalThis.__homeRenderRequest = null;
  }
}
const UNIT = "unit-home-render-plain";
async function record(cookies = { _unit: UNIT }, host = "hr.test") {
  const home = await asRequest(host, cookies, async () => html(await Home()));
  const pages = {};
  if (host === "hr.test") {
    for (const { slug } of PAGES) {
      pages[slug] = await asRequest(host, cookies, async () => {
        const page = await inT(() => Res.resolvedContentPage(slug));
        return html(React.createElement(ContentPage, { page, legalName: "Glow Works Pvt Ltd" }));
      });
    }
  }
  return { home, pages };
}

const out = { recordedFrom: "scripts/support/home-render-outputs.js", states: {} };
out.states.drafts = await record();

// a running hero experiment
await inT(async () => {
  await X.upsertExperiment({
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
  await X.startExperiment("hero-words");
});
const EXP = await inT(() => X.runningExperimentFor("hero"));
const unitIn = (key) => {
  for (let i = 0; ; i++) if (X.assignVariant(EXP, `unit-home-render-${i}`) === key) return `unit-home-render-${i}`;
};
out.states.exp_b = await record({ _unit: unitIn("b") });
out.states.exp_control = await record({ _unit: unitIn("control") });
out.states.exp_founder = await record({ _unit: unitIn("b"), _admin: "signed-in" });
const token = await inT(() => R.previewToken());
out.states.exp_preview = await record({ _unit: unitIn("b"), [Res.PREVIEW_COOKIE]: token });
await inT(() => libsql.execute("UPDATE experiments SET status = 'completed'"));

// an S59 preview: unsaved hero words and sections
await inT(() =>
  setPreviewCandidate(token, {
    hero: { ...HERO, title: "Candidate glow", subtitle: "Typed, not saved." },
    home_sections: [SECTIONS[5], { ...SECTIONS[2], title: "Candidate banner" }, SECTIONS[1]],
  }),
);
out.states.candidate = await record({ _unit: UNIT, [Res.PREVIEW_COOKIE]: token });

for (const [name, content] of Object.entries(RELEASES)) {
  await putLive(`rel_home_${name}`, content);
  out.states[name] = await record();
}

out.states.empty = await record({ _unit: UNIT }, "hre.test");

for (const f of DBS) await rm(join(ROOT, f), { force: true });
const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json);
else process.stdout.write(json);
process.exit(0);
