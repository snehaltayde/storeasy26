// P2-DRILLS: a documents-mode store on the design harness, for the phase 2
// browser drills (scripts/drills/p2/run.mjs). Local only: it writes to this
// checkout's own harness databases (local sqld over http://127.0.0.1) and
// refuses any other database URL. Nothing here talks to Shopify, and no real
// store is touched.
//
// It reuses the P2-PERF documents fixture (scripts/perf-docs-fixture.js): the
// perf store's content as registry documents, created through the write
// service and published through lib/documents/publish.js. So the harness must
// be seeded with the perf fixture first, which brings the catalog and the
// library photos those documents point at:
//   DESIGN_PORT=… DESIGN_SQLD_PORT=… node scripts/dev-design.js seed --fixture perf
//
// Then, with the harness stopped:
//   node scripts/seed-design-documents.js [--posts N] [--drafts-only] [--worst-case]
//     --posts N       journal posts in the fixture (default 3)
//     --drafts-only   create the documents as drafts and publish nothing: a
//                     documents store before its first publish
//     --worst-case    also add the worst-case catalog the section drill uses:
//                     products and collections named after the registry's
//                     worstCase() fixtures (lib/registry/fixtures.js), with
//                     long names, a wide, a tall and no photo, one sold out,
//                     and two library photos standing in for the fixtures'
//                     /api/media/worst-case-*.jpg
//   node scripts/seed-design-documents.js check
//     prints what the store holds (mode, live release, documents); writes
//     nothing, and works with the harness running too
//
// The store is moved to documents mode with its seeded v3 pointer cleared, as
// perf-docs-fixture's publish does. Documents are only ever written through
// lib/documents (the write guards in test-documents and test-writers), so this
// never deletes any: to start again, seed the harness fresh. The drill runner
// (scripts/drills/p2/run.mjs) does that before every part that changes the store.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// the worst-case catalog (pure)
// ---------------------------------------------------------------------------

export const WORST_MEDIA = {
  wide: { id: `med_${createHash("sha256").update("p2-drills:worst-case-wide").digest("hex").slice(0, 18)}`, width: 2400, height: 1200, filename: "worst-case-wide.jpg", alt: "A wide worst-case photo" },
  tall: { id: `med_${createHash("sha256").update("p2-drills:worst-case-tall").digest("hex").slice(0, 18)}`, width: 600, height: 2400, filename: "worst-case-tall.jpg", alt: "A tall worst-case photo" },
};
export const WORST_PRODUCTS = 24;
export const WORST_COLLECTIONS = 24;
export const RAIL_PRODUCTS = 12;

// The fixtures' image paths, mapped to the library photos this seed adds.
export function worstCaseMediaMap() {
  return { "/api/media/worst-case-wide.jpg": `/api/media/${WORST_MEDIA.wide.id}`, "/api/media/worst-case-tall.jpg": `/api/media/${WORST_MEDIA.tall.id}` };
}

// Swap the fixtures' placeholder image paths for the seeded ones, anywhere in a value.
export function withSeededMedia(value, map = worstCaseMediaMap()) {
  if (typeof value === "string") return map[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => withSeededMedia(v, map));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withSeededMedia(v, map)]));
  return value;
}

export async function worstCaseCatalog() {
  const { longText } = await import("../lib/registry/fixtures.js");
  const LONG_HANDLE = "worst-case-collection-with-a-really-long-handle";
  const wide = `/api/media/${WORST_MEDIA.wide.id}`;
  const tall = `/api/media/${WORST_MEDIA.tall.id}`;
  // As the fixtures' catalog(): every third product has no photo, every third
  // a tall one; the last one is sold out. Created "in the future", so they
  // are the store's newest products.
  const products = Array.from({ length: WORST_PRODUCTS }, (_, j) => ({
    id: `gid://shopify/Product/99${String(j).padStart(5, "0")}`,
    variantId: `gid://shopify/ProductVariant/99${String(j).padStart(5, "0")}`,
    handle: `worst-case-product-${j}`,
    title: longText(150),
    price: 1249999,
    compareAt: 1599999,
    image: j % 3 === 2 ? null : j % 3 === 1 ? tall : wide,
    available: j === WORST_PRODUCTS - 1 ? 0 : 1,
    createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, WORST_PRODUCTS - j)).toISOString(),
  }));
  const collections = [
    // the product rail's collection: its first RAIL_PRODUCTS products
    { id: "gid://shopify/Collection/1", handle: LONG_HANDLE, title: longText(90), image: wide, productIds: products.slice(0, RAIL_PRODUCTS).map((p) => p.id) },
    // the collections grid: long names, every other one with no photo
    ...Array.from({ length: WORST_COLLECTIONS }, (_, j) => ({ id: `gid://shopify/Collection/99${String(j).padStart(5, "0")}`, handle: `${LONG_HANDLE}-${j}`, title: longText(90), image: j % 2 ? null : wide, productIds: null })),
  ];
  return { LONG_HANDLE, products, collections };
}

// ---------------------------------------------------------------------------
// database work (inside withTenant)
// ---------------------------------------------------------------------------

async function photo(w, h, label) {
  const sharp = (await import("sharp")).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d9488"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" font-family="Helvetica" font-size="${Math.round(Math.min(w, h) / 8)}" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
}

export async function seedWorstCaseCatalog({ libsql }) {
  const cat = await worstCaseCatalog();
  const now = new Date().toISOString();
  const stmts = [
    { sql: "DELETE FROM collection_products WHERE collection_id IN (SELECT id FROM collections WHERE handle LIKE 'worst-case-%')", args: [] },
    { sql: "DELETE FROM collections WHERE handle LIKE 'worst-case-%'", args: [] },
    { sql: "DELETE FROM variants WHERE product_id IN (SELECT id FROM products WHERE handle LIKE 'worst-case-%')", args: [] },
    { sql: "DELETE FROM products WHERE handle LIKE 'worst-case-%'", args: [] },
    { sql: "DELETE FROM media WHERE id IN (?, ?)", args: [WORST_MEDIA.wide.id, WORST_MEDIA.tall.id] },
  ];
  for (const m of Object.values(WORST_MEDIA)) {
    const bytes = await photo(m.width, m.height, m.width > m.height ? "wide" : "tall");
    stmts.push({
      sql: "INSERT INTO media (id, filename, mime, size, width, height, alt, variant, parent_id, sha256, data, created_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)",
      args: [m.id, m.filename, "image/jpeg", bytes.length, m.width, m.height, m.alt, createHash("sha256").update(bytes).digest("hex"), bytes, now],
    });
  }
  for (const p of cat.products) {
    stmts.push({
      sql: "INSERT INTO products (id, handle, title, description, product_type, vendor, tags, price_min, price_max, compare_at_min, currency, available, total_inventory, featured_image, featured_image_alt, options, created_at, updated_at, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [p.id, p.handle, p.title, `${p.title}.`, "Worst case", "Worst case", "[]", p.price, p.price, p.compareAt, "INR", p.available, p.available ? 5 : 0, p.image, p.image ? p.title : null, "[]", p.createdAt, now, now],
    });
    stmts.push({ sql: "INSERT INTO variants (id, product_id, title, price, compare_at_price, currency, available, position) VALUES (?,?,?,?,?,?,?,0)", args: [p.variantId, p.id, "Default", p.price, p.compareAt, "INR", p.available] });
  }
  // The grid's collections hold every product in the store plus one, so the
  // store's "biggest collections first" grid lists them before the perf
  // store's own collections.
  const all = (await libsql.execute("SELECT id FROM products ORDER BY id")).rows.map((r) => r.id);
  for (const c of cat.collections) {
    stmts.push({ sql: "INSERT INTO collections (id, handle, title, description, image, image_alt, updated_at, synced_at) VALUES (?,?,?,?,?,?,?,?)", args: [c.id, c.handle, c.title, `${c.title}.`, c.image, c.image ? c.title : null, now, now] });
    (c.productIds || all).forEach((pid, position) => stmts.push({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?,?,?)", args: [c.id, pid, position] }));
  }
  for (let i = 0; i < stmts.length; i += 250) await libsql.batch(stmts.slice(i, i + 250), "write");
  return { products: cat.products.length, collections: cat.collections.length, media: Object.keys(WORST_MEDIA).length };
}

// The fresh perf seed's store, moved to documents mode with no live release
// (perf-docs-fixture's takeover). A store that already holds documents was
// seeded by an earlier run: documents are only ever written through the
// write service, so this seed never deletes them; seed the harness again.
export async function takeOver({ libsql }) {
  const n = Number((await libsql.execute("SELECT count(*) AS n FROM documents")).rows[0]?.n || 0);
  if (n > 0) {
    const H = await import("./design-harness.js");
    throw new H.HarnessError(`The harness store already holds ${n} documents from an earlier run. Seed it fresh first: node scripts/dev-design.js seed --fixture perf, then run this again.`);
  }
  const { takeOverHarnessStore } = await import("./perf-docs-fixture.js");
  await takeOverHarnessStore({ libsql });
}

export async function draftDocumentsFixture(fixture) {
  const { createDocument } = await import("../lib/documents/service.js");
  const ids = [];
  for (const d of fixture.documents) {
    const { document } = await createDocument({ type: d.type, body: d.body, actor: "seed:design-documents" });
    ids.push(document.id);
  }
  return { documents: ids.length };
}

export async function storeState({ libsql }) {
  const one = async (sql) => (await libsql.execute(sql)).rows[0] || {};
  const mode = (await one("SELECT mode FROM cms_state WHERE id = 1")).mode ?? null;
  const live = await one("SELECT s.live_release_id AS id, json_extract(r.content, '$.v') AS v FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const docs = await one("SELECT count(*) AS n, sum(CASE WHEN published_version_id IS NULL THEN 0 ELSE 1 END) AS published, sum(CASE WHEN draft_hash IS NOT published_hash THEN 1 ELSE 0 END) AS dirty FROM documents");
  return { mode, liveRelease: live.id ?? null, liveVersion: live.v ?? null, documents: Number(docs.n || 0), published: Number(docs.published || 0), dirty: Number(docs.dirty || 0) };
}

// ---------------------------------------------------------------------------
// the harness store: running (its sqld are used) or stopped (sqld started here)
// ---------------------------------------------------------------------------

export async function withHarnessStore(fn, { env = process.env, write = true } = {}) {
  const H = await import("./design-harness.js");
  const dataDir = join(H.ROOT, H.DATA_DIR_NAME);
  const seeded = H.readSeeded(dataDir);
  if (seeded?.fixture !== "perf") {
    throw new H.HarnessError("The harness data isn't the perf fixture, and the documents fixture points at its catalog and photos. Seed it first: node scripts/dev-design.js seed --fixture perf (with the harness stopped).");
  }
  const running = H.runningHarness(dataDir);
  if (running && write) throw new H.HarnessError(`The design harness is running in this checkout (pid ${running.launcher.pid}). Stop it first: the seed starts from a fresh perf seed (node scripts/dev-design.js seed --fixture perf), which needs it stopped.`);
  let ports;
  let servers = [];
  if (running) {
    ports = { next: running.ports?.next, sqld: running.ports?.sqld || {} };
    if (!ports.sqld.platform || !ports.sqld.tenant) throw new H.HarnessError("The running harness's pid file doesn't name its database ports. Restart the harness.");
  } else {
    ports = H.harnessPorts(env);
    await H.stopLeftovers(dataDir, console.log);
    for (const key of ["platform", "tenant"]) if (await H.isPortBusy(ports.sqld[key])) throw new H.HarnessError(`Port ${ports.sqld[key]} is already in use.`);
    const sqld = H.findSqld({ env });
    servers = ["platform", "tenant"].map((key) => H.startSqld({ bin: sqld.bin, key, port: ports.sqld[key], dataDir }));
  }
  try {
    for (const s of servers) await H.waitForHealth(s.url, s.child, { logFile: s.logFile, label: s.key });
    const urls = H.harnessUrls(ports);
    // refuse anything but this checkout's local databases, before any app module opens a client
    H.assertLocalDbUrl("the harness platform database", urls.platform);
    H.assertLocalDbUrl("the harness store database", urls.tenant);
    if (!running) await H.pointTenantAtThisRun({ platform: urls.platform, tenant: urls.tenant });
    const hEnv = H.harnessEnv(env, H.ensureCredentials(H.ROOT), ports);
    for (const k of ["DATABASE_URL", "PLATFORM_DB_URL", "PLATFORM_DB_TOKEN", "PLATFORM_SECRET"]) process.env[k] = hEnv[k];
    process.env.TURSO_DB_URL = "";
    H.assertLocalDbUrl("PLATFORM_DB_URL", process.env.PLATFORM_DB_URL);
    H.assertLocalDbUrl("DATABASE_URL", process.env.DATABASE_URL);
    const C = await import("../lib/platform/control.js");
    const { withTenant } = await import("../lib/tenant-context.js");
    const { libsql } = await import("../lib/db.js");
    const tenant = await C.getTenant(H.TENANT_ID);
    if (!tenant) throw new H.HarnessError("The harness has no design store. Seed it again.");
    H.assertLocalDbUrl("the design store's database", tenant.dbUrl || tenant.db_url);
    return await withTenant(tenant, () => fn({ libsql, running: !!running }));
  } finally {
    await Promise.all(servers.map((s) => H.stopChild(s.child)));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { cmd: "seed", posts: 3, draftsOnly: false, worstCase: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "check" && i === 0) out.cmd = "check";
    else if (a === "--drafts-only") out.draftsOnly = true;
    else if (a === "--worst-case") out.worstCase = true;
    else if (a === "--posts") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0 || v > 1000) throw new Error("--posts needs a whole number from 0 to 1000");
      out.posts = v;
    } else throw new Error(`Unknown option "${a}". Use: node scripts/seed-design-documents.js [check] [--posts N] [--drafts-only] [--worst-case]`);
  }
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === "check") {
    const state = await withHarnessStore(({ libsql }) => storeState({ libsql }), { write: false });
    console.log(JSON.stringify(state));
    return 0;
  }
  const { buildDocumentsFixture, publishDocumentsFixture } = await import("./perf-docs-fixture.js");
  const fx = await buildDocumentsFixture({ posts: opts.posts });
  const started = Date.now();
  const out = await withHarnessStore(async ({ libsql, running }) => {
    await takeOver({ libsql });
    const catalog = opts.worstCase ? await seedWorstCaseCatalog({ libsql }) : null;
    const done = opts.draftsOnly ? await draftDocumentsFixture(fx) : await publishDocumentsFixture(fx);
    return { running, catalog, done, state: await storeState({ libsql }) };
  });
  console.log(
    `✓ the harness store is in documents mode: ${out.state.documents} documents, ${opts.draftsOnly ? "none published (before the first publish)" : `live release ${out.state.liveRelease}`}${out.catalog ? `, worst-case catalog (${out.catalog.products} products, ${out.catalog.collections} collections, ${out.catalog.media} photos)` : ""}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  return 0;
}

// fileURLToPath, not a "file://" string compare: the owner's checkout path has
// a space (".../Projects 2026/..."), which import.meta.url writes as %20.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
