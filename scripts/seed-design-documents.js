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
//   node scripts/seed-design-documents.js --p3 [--posts N] [--worst-case]
//     P3-HARNESS: the phase 3 drill store. Starts from a fresh perf seed by
//     itself, so it needs no step before it and re-running it resets
//     everything. Adds an owner and a staff login, the drill content and a
//     second, closed store (see "P3-HARNESS" below). Logins and ids go to
//     .design-data/p3-seed.json, never to the screen.
//   node scripts/seed-design-documents.js --p4
//     P4-HARNESS: the phase 4 drill store. A LEGACY store live on a version 3
//     release made with createRelease (no takeOver): the fresh perf seed plus
//     the phase 4 content (see "P4-HARNESS" below). Re-running it resets
//     everything. Logins and ids go to .design-data/p4-seed.json.
//   node scripts/seed-design-documents.js check [--p3 | --p4]
//     prints what the store holds (mode, live release, documents); writes
//     nothing, and works with the harness running too. --p3 adds row counts,
//     the document_refs check, the logins and the closed store; --p4 counts
//     every line of the phase 4 seed list (P4_SEED_LIST) and what the live
//     release froze
//
// The store is moved to documents mode with its seeded v3 pointer cleared, as
// perf-docs-fixture's publish does. Documents are only ever written through
// lib/documents (the write guards in test-documents and test-writers), so this
// never deletes any: to start again, seed the harness fresh. The drill runner
// (scripts/drills/p2/run.mjs) does that before every part that changes the store.
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
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

// databases: which of the harness's local servers to start when it is stopped.
// The P3 seed (--p3) also needs "default", which holds the closed store.
export async function withHarnessStore(fn, { env = process.env, write = true, databases = ["platform", "tenant"] } = {}) {
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
    for (const key of databases) if (await H.isPortBusy(ports.sqld[key])) throw new H.HarnessError(`Port ${ports.sqld[key]} is already in use.`);
    const sqld = H.findSqld({ env });
    servers = databases.map((key) => H.startSqld({ bin: sqld.bin, key, port: ports.sqld[key], dataDir }));
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
    return await withTenant(tenant, () => fn({ libsql, running: !!running, urls, adminPassword: hEnv.DESIGN_ADMIN_PASSWORD }));
  } finally {
    await Promise.all(servers.map((s) => H.stopChild(s.child)));
  }
}

// ---------------------------------------------------------------------------
// P3-HARNESS: the phase 3 drill store (--p3)
// ---------------------------------------------------------------------------
//
// On top of the documents store above:
//   - two logins on the design store: an owner and a staff member (staff can
//     edit and preview, never publish). Their passwords are made fresh on
//     every seed and written only to .design-data/p3-seed.json (mode 600,
//     gitignored with the rest of .design-data). Nothing prints them. Once a
//     store has members, its shared setup password no longer signs in, so
//     the P3 drills sign in by email (scripts/drills/p3/lib.mjs login()).
//   - drill content, every publish through lib/documents/publish.js as the
//     owner, so publish_log, document_refs (0023) and the live addresses are
//     all there:
//       a campaign that is never published (P3_SLUGS.unpublishedCampaign)
//       a page, live, whose draft links to that campaign (P3_SLUGS.guide)
//       a live campaign linked from the home page's banner, which a drill can
//         take offline (P3_SLUGS.liveCampaign; published on its own first,
//         so its Undo is "take offline")
//       a journal post (the fixture's first) and the home page's product rail
//         (its collection has products)
//       last, one three-document publish set (P3_SET), for whole-set Undo
//   - a second documents store, "design-closed" on closed.localhost, in state
//     none: documents mode, no release, a few drafts. Shoppers there see
//     "Opening soon". Its database is the harness's third local server (the
//     env default one, DESIGN_SQLD_PORT + 2), which no request otherwise
//     uses: an unknown host never falls back to it (lib/tenant-request.js).
//     The harness has three database servers and scripts/design-harness.js
//     isn't this item's, so the closed store borrows that one.
//
// --p3 starts from a fresh perf seed itself (node scripts/dev-design.js seed
// --fixture perf, the same call), so running it again resets everything:
// the same rows, the same counts, new ids and passwords.

export const P3_SEED_FILE = "p3-seed.json";
export const CLOSED_STORE = Object.freeze({ id: "design-closed", host: "closed.localhost", name: "Closed Demo Co" });
export const P3_LOGINS = Object.freeze({
  owner: { email: "founder@design.test", name: "Asha Founder", role: "owner" },
  staff: { email: "staff@design.test", name: "Ravi Staff", role: "staff" },
});
export const P3_SLUGS = Object.freeze({ unpublishedCampaign: "p3-spring-edit", liveCampaign: "p3-weekend-offer", guide: "p3-spring-guide" });
// the three documents of the last publish set: two pages and the announcement
export const P3_SET = Object.freeze({ pages: ["faq", "size-guide"], singleton: "announcement" });
export const P3_SET_TITLE = "Updated in the spring set";
const CLOSED_DRAFT_TITLE = "Closed draft: not for shoppers yet";

const p3Actor = (owner) => ({ kind: "merchant", id: owner.id, role: "owner" });
const sec = (id, kind, settings) => ({ id, kind, v: 1, enabled: true, settings, blocks: [] });
const pageLink = (family, doc) => ({ type: "page", family, slug: doc.slug, document: doc.id });

// A route document body: the registry's empty body with this meta and these sections.
async function routeDoc(type, { slug, title, description = "" }, sections) {
  const Reg = await import("../lib/registry/index.js");
  const b = Reg.emptyBody(type);
  b.meta = { ...b.meta, slug, title, description };
  b.sections = sections;
  return b;
}

// The owner and staff logins on the design store. Passwords: fresh, local, random.
export async function seedP3Logins({ tenantId = "design" } = {}) {
  const { randomBytes } = await import("node:crypto");
  const { createUser, addMembership } = await import("../lib/platform/identity.js");
  const out = {};
  for (const [role, who] of Object.entries(P3_LOGINS)) {
    const password = `${role}-${randomBytes(9).toString("hex")}`;
    const user = await createUser({ email: who.email, name: who.name, password });
    await addMembership(user.id, tenantId, who.role);
    out[role] = { id: user.id, email: who.email, name: who.name, role: who.role, password };
  }
  return out;
}

// Inside withTenant(design), after publishDocumentsFixture.
export async function seedP3Content({ libsql, owner }) {
  const Docs = await import("../lib/documents/service.js");
  const { publish } = await import("../lib/documents/publish.js");
  const { livePath, liveExitUrl } = await import("../lib/documents/paths.js");
  const actor = p3Actor(owner);
  const pin = (d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash });
  const pub = async (docs, what) => {
    const r = await publish({ ids: docs.map(pin), actor });
    if (r.published.length !== docs.length) throw new Error(`seedP3Content: ${what} published ${r.published.length} of ${docs.length}`);
    const log = await libsql.execute({ sql: "SELECT id, document_id FROM publish_log WHERE set_id = ? ORDER BY document_id", args: [r.setId] });
    return { setId: r.setId, releaseId: r.release?.id ?? null, logIds: Object.fromEntries(log.rows.map((x) => [x.document_id, x.id])) };
  };
  const edit = async (id, mutate) => {
    const d = await Docs.getDocument(id);
    const body = mutate(structuredClone(d.body));
    return (await Docs.saveDraft({ id, revision: d.revision, body, actor })).document;
  };
  const create = async (type, meta, sections) => (await Docs.createDocument({ type, body: await routeDoc(type, meta, sections), actor })).document;

  // 1. a campaign that is never published
  const soon = await create("campaign", { slug: P3_SLUGS.unpublishedCampaign, title: "The spring edit", description: "Coming soon." }, [
    sec("sec_p3soon", "text", { title: "The spring edit is on its way", body: ["New routines for warmer days. This page is still a draft."] }),
  ]);

  // 2. a page, live without the link, whose draft then links to that campaign
  let guide = await create("page", { slug: P3_SLUGS.guide, title: "Spring guide", description: "How to change your routine for spring." }, [
    sec("sec_p3guide", "text", { title: "Changing your routine for spring", body: ["Lighter layers, more SPF, and a gentler cleanser."] }),
  ]);
  const guideLive = await pub([guide], "the spring guide");
  guide = await edit(guide.id, (b) => {
    b.sections.push(sec("sec_p3guidebn", "banner", { title: "The spring edit", text: "See what's coming.", button: { label: "Take a look", link: pageLink("campaign", soon) } }));
    return b;
  });

  // 3. a live campaign, published on its own (its first publish), then linked from home
  const offer = await create("campaign", { slug: P3_SLUGS.liveCampaign, title: "Weekend offer", description: "This weekend only." }, [
    sec("sec_p3offer", "text", { title: "This weekend only", body: ["Free shipping on every order until Sunday night."] }),
  ]);
  const offerLive = await pub([offer], "the weekend offer");
  const home = await edit("doc_home", (b) => {
    const at = b.sections.findIndex((s) => s.kind === "hero") + 1;
    b.sections.splice(at, 0, sec("sec_p3camp", "banner", { title: "This weekend only", text: "Free shipping on every order.", button: { label: "See the offer", link: pageLink("campaign", offer) } }));
    return b;
  });
  const homeLive = await pub([home], "the home page");

  // 4. the journal post and the home page's product rail (from the fixture)
  const post = (await libsql.execute("SELECT id FROM documents WHERE type = 'journal' AND published_version_id IS NOT NULL ORDER BY slug LIMIT 1")).rows[0];
  const homeBody = (await Docs.getDocument("doc_home")).body;
  const rail = homeBody.sections.find((s) => s.kind === "product_rail" && s.enabled !== false);
  const railProducts = rail
    ? Number((await libsql.execute({ sql: "SELECT count(*) AS n FROM collection_products cp JOIN collections c ON c.id = cp.collection_id WHERE c.handle = ?", args: [rail.settings.collection.handle] })).rows[0].n)
    : 0;
  if (!post || !rail || railProducts < 1) throw new Error(`seedP3Content: the fixture has no live journal post or no product rail with products (post ${!!post}, rail ${!!rail}, products ${railProducts})`);

  // 5. last: one publish set of three documents, for whole-set Undo
  const pageIds = [];
  for (const slug of P3_SET.pages) {
    const row = (await libsql.execute({ sql: "SELECT id FROM documents WHERE type = 'page' AND slug = ?", args: [slug] })).rows[0];
    if (!row) throw new Error(`seedP3Content: the fixture has no page "${slug}"`);
    pageIds.push(row.id);
  }
  const setDocs = [];
  for (const id of pageIds) {
    setDocs.push(
      await edit(id, (b) => {
        const s = b.sections.find((x) => typeof x.settings?.title === "string");
        if (s) s.settings.title = P3_SET_TITLE;
        else b.sections.push(sec("sec_p3set", "text", { title: P3_SET_TITLE, body: ["Added in the spring set."] }));
        return b;
      }),
    );
  }
  setDocs.push(
    await edit(`doc_${P3_SET.singleton}`, (b) => {
      b.settings.text = "New: the spring edit is coming soon";
      return b;
    }),
  );
  const setLive = await pub(setDocs, "the three-document set");

  // what the drills need, with each document's live address
  const describe = async (id, extra = {}) => {
    const d = await Docs.getDocument(id);
    const path = livePath(d.type, d.body?.meta);
    return { id: d.id, type: d.type, slug: d.slug ?? null, label: d.label, path, liveUrl: d.publishedVersionId ? liveExitUrl(path) : null, publishedVersionId: d.publishedVersionId ?? null, ...extra };
  };
  return {
    documents: {
      home: await describe("doc_home", { logId: homeLive.logIds.doc_home, bannerSectionId: "sec_p3camp", productRail: { sectionId: rail.id, collection: rail.settings.collection.handle, products: railProducts } }),
      liveCampaign: await describe(offer.id, { logId: offerLive.logIds[offer.id], linkedFrom: ["doc_home"] }),
      unpublishedCampaign: await describe(soon.id, { linkedFromDraftOf: [guide.id] }),
      guide: await describe(guide.id, { logId: guideLive.logIds[guide.id], draftLinksTo: soon.id }),
      journalPost: await describe(post.id),
    },
    publishSet: { setId: setLive.setId, releaseId: setLive.releaseId, members: await Promise.all(setDocs.map(async (d) => ({ ...(await describe(d.id)), logId: setLive.logIds[d.id] }))) },
  };
}

// The second store: documents mode, no release (state none), a few drafts.
export async function seedClosedStore({ urls, adminPassword }) {
  const { readFile } = await import("node:fs/promises");
  const H = await import("./design-harness.js");
  H.assertLocalDbUrl("the closed store's database", urls.default);
  const C = await import("../lib/platform/control.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  const { libsql } = await import("../lib/db.js");
  const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
  await C.upsertTenant({
    id: CLOSED_STORE.id,
    name: CLOSED_STORE.name,
    domains: [CLOSED_STORE.host],
    dbUrl: urls.default,
    config: { currency: "INR", merchant_timezone: "Asia/Kolkata", site: { name: CLOSED_STORE.name, title: CLOSED_STORE.name, tagline: "A store before its first publish", support_email: "support@closed.test" } },
    secrets: { admin_password: adminPassword, order_link_secret: "design-closed-order-secret" },
  });
  const tenant = await C.getTenant(CLOSED_STORE.id);
  return withTenant(tenant, async () => {
    await libsql.executeMultiple(await readFile(join(H.ROOT, "lib", "schema.sql"), "utf8"));
    await runMigrations(libsql, await loadMigrations("tenant"));
    const { takeOverHarnessStore } = await import("./perf-docs-fixture.js");
    await takeOverHarnessStore({ libsql });
    const Reg = await import("../lib/registry/index.js");
    const { createDocument } = await import("../lib/documents/service.js");
    const home = Reg.emptyBody("home");
    home.sections = [sec("sec_closedhero", "hero", { title: CLOSED_DRAFT_TITLE, highlight: "", subtitle: "Drafts never reach shoppers before the first publish.", primary: { label: "Shop all", link: { type: "url", href: "/collections" } }, secondary: null, badge: "", image: null })];
    const ids = [(await createDocument({ type: "home", body: home, actor: "seed:design-documents" })).document.id];
    ids.push((await createDocument({ type: "page", body: await routeDoc("page", { slug: "about", title: "About us" }, [sec("sec_closedabout", "text", { title: "About the closed store", body: ["This page is a draft."] })]), actor: "seed:design-documents" })).document.id);
    return { id: CLOSED_STORE.id, host: CLOSED_STORE.host, drafts: ids, draftTitle: CLOSED_DRAFT_TITLE };
  });
}

// P3-FIX2: the closed store's tenant row records the env default database's
// address at seed time. A harness started later on other ports would leave it
// pointing at the old port (another checkout's sqld, perhaps), so the P3 drill
// helpers point it at this run's third server when they start the harness
// (scripts/drills/p3/lib.mjs startOwned). Local addresses only. Returns the
// rows changed (0 when the store isn't seeded or already points there).
export async function pointClosedStoreAt({ platform, default: defaultUrl }) {
  const H = await import("./design-harness.js");
  H.assertLocalDbUrl("the platform database", platform);
  H.assertLocalDbUrl("the closed store's database", defaultUrl);
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: platform });
  try {
    const r = await client.execute({ sql: "UPDATE tenants SET db_url = ? WHERE id = ? AND db_url <> ?", args: [defaultUrl, CLOSED_STORE.id, defaultUrl] });
    return r.rowsAffected;
  } finally {
    client.close();
  }
}

// The harness seed config: logins (with their passwords), stores and drill
// content. Owner-only file mode; never printed.
export function writeP3Seed(dataDir, config) {
  const file = join(dataDir, P3_SEED_FILE);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// The phase 3 drill store's facts, read only (check --p3). Inside withTenant(design).
export async function p3State({ libsql }) {
  const C = await import("../lib/platform/control.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  const { refRows } = await import("../lib/documents/refs.js");
  const n = async (db, sql, args = []) => Number((await db.execute({ sql, args })).rows[0]?.n || 0);
  const tables = ["documents", "document_versions", "publish_log", "document_refs", "releases", "products", "collections", "collection_products", "media"];
  const rows = {};
  for (const t of tables) rows[t] = await n(libsql, `SELECT count(*) AS n FROM ${t}`);
  rows.publish_sets = await n(libsql, "SELECT count(DISTINCT set_id) AS n FROM publish_log");
  // refs: every published version holds exactly the rows refRows makes from its body
  const versions = (await libsql.execute("SELECT v.id, v.body FROM document_versions v WHERE v.kind = 'published'")).rows;
  const stored = new Map();
  for (const r of (await libsql.execute("SELECT version_id, ref_type, ref_id FROM document_refs")).rows) {
    if (!stored.has(r.version_id)) stored.set(r.version_id, new Set());
    stored.get(r.version_id).add(`${r.ref_type}:${r.ref_id}`);
  }
  let withRefs = 0;
  const mismatched = [];
  for (const v of versions) {
    const want = new Set(refRows(v.id, JSON.parse(v.body)).map((r) => `${r.ref_type}:${r.ref_id}`));
    const got = stored.get(v.id) || new Set();
    if (want.size) withRefs++;
    if (want.size !== got.size || [...want].some((k) => !got.has(k))) mismatched.push(v.id);
  }
  const versionIds = new Set(versions.map((v) => v.id));
  const orphanRefs = [...stored.keys()].filter((id) => !versionIds.has(id)).length;
  const live = (await libsql.execute("SELECT live_release_id AS id FROM release_state WHERE id = 1")).rows[0]?.id ?? null;
  const pdb = C.platformDb();
  const members = Object.fromEntries((await pdb.execute({ sql: "SELECT role, count(*) AS n FROM memberships WHERE tenant_id = ? GROUP BY role ORDER BY role", args: ["design"] })).rows.map((r) => [r.role, Number(r.n)]));
  const platform = { tenants: await n(pdb, "SELECT count(*) AS n FROM tenants"), users: await n(pdb, "SELECT count(*) AS n FROM users"), memberships: await n(pdb, "SELECT count(*) AS n FROM memberships") };
  const closedTenant = await C.getTenant(CLOSED_STORE.id);
  let closed = null;
  if (closedTenant) {
    const { libsql: db } = await import("../lib/db.js");
    closed = await withTenant(closedTenant, async () => ({
      mode: (await db.execute("SELECT mode FROM cms_state WHERE id = 1")).rows[0]?.mode ?? null,
      liveRelease: (await db.execute("SELECT live_release_id AS id FROM release_state WHERE id = 1")).rows[0]?.id ?? null,
      releases: await n(db, "SELECT count(*) AS n FROM releases"),
      documents: await n(db, "SELECT count(*) AS n FROM documents"),
      published: await n(db, "SELECT count(*) AS n FROM documents WHERE published_version_id IS NOT NULL"),
      publishLog: await n(db, "SELECT count(*) AS n FROM publish_log"),
      domains: closedTenant.domains,
    }));
  }
  return { liveRelease: live, rows, refs: { publishedVersions: versions.length, versionsWithRefs: withRefs, mismatched, orphanRefs }, members, platform, closed };
}

// ---------------------------------------------------------------------------
// P4-HARNESS: the phase 4 drill store (--p4)
// ---------------------------------------------------------------------------
//
// A LEGACY store, live on a version 3 release that createRelease made (no
// takeOver, no documents): the store phase 4's cutover moves. It starts from
// a fresh perf seed (which is already legacy and live on v3), changes it
// through the same legacy writers the old consoles use, then publishes one
// more release with createRelease. What it holds (P4_SEED_LIST; check --p4
// counts each of these):
//   24 product overrides, one of them (the chosen product) with 6 modules
//   40 product pairs: one with its own title (the chosen product's), one
//     switched off, and one source product with two placements; plus the
//     cart upsell placement
//   5 collections with pinned products
//   one per-product template exception (the chosen product: editorial) and
//     one per-collection one (the first pinned collection: sidebar)
//   32 library photos, one of them used only inside the chosen product's
//     module HTML (no product photo, page or block points at it)
//   a running hero experiment (the demo seed's own, or P4_EXPERIMENT when
//     there is none), one page redirect (a renamed journal post),
//     two saved templates (page and journal)
//   the P3 logins (owner and staff, fresh passwords in the seed config)
// Facts the drills need go to .design-data/p4-seed.json (mode 600). A copy of
// the stores and logins also goes to p3-seed.json, so the phase 3 helpers'
// login() works on this store too (there is no closed store in --p4).

export const P4_SEED_FILE = "p4-seed.json";
export const P4_PAIRS_TITLE = "Goes well with your routine";
export const P4_SECOND_PAIRS_TITLE = "More to try";
export const P4_EXPERIMENT = Object.freeze({
  slug: "p4-hero-words",
  name: "Hero words (phase 4 drill)",
  hypothesis: "Shorter hero words get more clicks",
  target_kind: "hero",
  variants: [
    { key: "control", weight: 50, payload: null },
    { key: "b", weight: 50, payload: { title: "Train, simply", highlight: "simply", primary: { label: "Shop all", href: "/collections/shop-all" } } },
  ],
  min_sample: 200,
});
export const P4_TEMPLATES = Object.freeze([
  { name: "Plain page (saved)", family: "page", sections: [{ kind: "text", heading: "Intro", body: ["Start here."] }] },
  { name: "Journal post (saved)", family: "journal", sections: [{ kind: "text", heading: "The short version", body: ["Write here."] }] },
]);
// What check --p4 must count after a --p4 seed (the "seed list").
export const P4_SEED_LIST = Object.freeze({
  mode: "legacy",
  liveVersion: 3,
  productOverrides: 24,
  overridesWithSixModules: 1,
  pdpPairs: 40,
  pdpPairsDisabled: 1,
  pdpPairsCustomTitle: 1,
  sourcesWithTwoPairs: 1,
  cartUpsell: 1,
  pinnedCollections: 5,
  productTemplateExceptions: 1,
  collectionTemplateExceptions: 1,
  media: 32,
  moduleOnlyPhotos: 1,
  runningHeroExperiments: 1,
  pageRedirects: 1,
  cmsTemplates: 2,
  documents: 0,
  owners: 1,
  staff: 1,
});

// The perf fixture's own facts (pure): which product, collection and photos
// the --p4 changes land on. Same answer every seed.
export async function p4Plan() {
  const { buildPerfFixture, mediaIdFor } = await import("./perf-fixture.js");
  const fx = buildPerfFixture();
  const chosen = fx.products.find((p) => p.handle === fx.measured.productHandle);
  const byId = (id) => fx.placements.find((p) => p.id === id);
  const pairs = fx.placements.filter((p) => p.kind === "pdp_pairs");
  if (!chosen || pairs.length !== 40 || byId("pp-perf-1")?.sourceProductId !== chosen.id) throw new Error("p4Plan: the perf fixture no longer has the shape the --p4 seed expects (40 pairs, the first on the measured product)");
  const pinned = fx.pins[0];
  const pinnedCol = fx.collections.find((c) => c.id === pinned.collectionId);
  const post = fx.posts[0];
  return {
    chosen: { id: chosen.id, handle: chosen.handle, title: chosen.title },
    customPairs: byId("pp-perf-1"),
    disabledPairs: byId("pp-perf-2"),
    // the last fixture pairs placement moves onto pp-perf-3's source, after it
    secondPairs: { ...byId("pp-perf-40"), sourceProductId: byId("pp-perf-3").sourceProductId, position: 1, title: P4_SECOND_PAIRS_TITLE },
    pinned: { id: pinned.collectionId, handle: pinnedCol.handle, title: pinnedCol.title, first: pinned.productIds },
    // product-photo-24 becomes the module-only photo; its catalog uses move to product-photo-23
    moduleOnlyPhoto: mediaIdFor("product-23"),
    standInPhoto: mediaIdFor("product-22"),
    renamedPost: { from: post.slug, to: `${post.slug}-updated` },
  };
}

// The writes themselves (seedP4Content: the legacy block, page, pairs,
// override, template and experiment writers, then createRelease) live in
// scripts/drills/p4/seed-p4.mjs: the writer guard in test-writers allows the
// old block and page writers only in fixture and drill code.

// The phase 4 drill store's facts, read only (check --p4). Inside withTenant(design).
export async function p4State({ libsql }) {
  const plan = await p4Plan();
  const n = async (sql, args = []) => Number((await libsql.execute({ sql, args })).rows[0]?.n || 0);
  const one = async (sql, args = []) => (await libsql.execute({ sql, args })).rows[0] || {};
  const C = await import("../lib/platform/control.js");
  const live = await one("SELECT s.live_release_id AS id, json_extract(r.content, '$.v') AS v, r.content AS content, r.note AS note, r.published_at AS published_at FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const content = live.content ? JSON.parse(live.content) : null;
  const st = JSON.parse((await one("SELECT value FROM cms_blocks WHERE key = 'surface_templates'")).value || "null") || {};
  // where the module-only photo is used: only in product_overrides.modules
  const like = `%${plan.moduleOnlyPhoto}%`;
  const photoUses = {
    products: await n("SELECT count(*) AS n FROM products WHERE featured_image LIKE ?", [like]),
    product_images: await n("SELECT count(*) AS n FROM product_images WHERE url LIKE ?", [like]),
    variants: await n("SELECT count(*) AS n FROM variants WHERE image_url LIKE ?", [like]),
    collections: await n("SELECT count(*) AS n FROM collections WHERE image LIKE ?", [like]),
    cms_blocks: await n("SELECT count(*) AS n FROM cms_blocks WHERE value LIKE ?", [like]),
    cms_pages: await n("SELECT count(*) AS n FROM cms_pages WHERE sections LIKE ?", [like]),
    product_overrides: await n("SELECT count(*) AS n FROM product_overrides WHERE modules LIKE ?", [like]),
  };
  const moduleOnly = photoUses.product_overrides === 1 && Object.entries(photoUses).every(([k, v]) => k === "product_overrides" || v === 0);
  const pdb = C.platformDb();
  const members = Object.fromEntries((await pdb.execute({ sql: "SELECT role, count(*) AS n FROM memberships WHERE tenant_id = ? GROUP BY role", args: ["design"] })).rows.map((r) => [r.role, Number(r.n)]));
  const counts = {
    mode: (await one("SELECT mode FROM cms_state WHERE id = 1")).mode ?? null,
    liveVersion: live.v ?? null,
    productOverrides: await n("SELECT count(*) AS n FROM product_overrides"),
    overridesWithSixModules: await n("SELECT count(*) AS n FROM product_overrides WHERE json_array_length(modules) = 6"),
    pdpPairs: await n("SELECT count(*) AS n FROM placements WHERE kind = 'pdp_pairs'"),
    pdpPairsDisabled: await n("SELECT count(*) AS n FROM placements WHERE kind = 'pdp_pairs' AND enabled = 0"),
    pdpPairsCustomTitle: await n("SELECT count(*) AS n FROM placements WHERE kind = 'pdp_pairs' AND title = ?", [P4_PAIRS_TITLE]),
    sourcesWithTwoPairs: await n("SELECT count(*) AS n FROM (SELECT source_product_id FROM placements WHERE kind = 'pdp_pairs' GROUP BY source_product_id HAVING count(*) = 2)"),
    cartUpsell: await n("SELECT count(*) AS n FROM placements WHERE kind = 'cart_upsell'"),
    pinnedCollections: await n("SELECT count(*) AS n FROM collection_overrides WHERE json_array_length(pinned) > 0"),
    productTemplateExceptions: Object.keys(st.products || {}).length,
    collectionTemplateExceptions: Object.keys(st.collections || {}).length,
    media: await n("SELECT count(*) AS n FROM media"),
    moduleOnlyPhotos: moduleOnly ? 1 : 0,
    runningHeroExperiments: await n("SELECT count(*) AS n FROM experiments WHERE status = 'running' AND target_kind = 'hero'"),
    pageRedirects: await n("SELECT count(*) AS n FROM page_redirects"),
    cmsTemplates: await n("SELECT count(*) AS n FROM cms_templates"),
    documents: await n("SELECT count(*) AS n FROM documents"),
    owners: members.owner || 0,
    staff: members.staff || 0,
  };
  // the live release froze the same entity rows (v3 reads its own arrays)
  const frozen = content
    ? {
        productOverrides: (content.product_overrides || []).length,
        sixModules: (content.product_overrides || []).filter((o) => (o.modules || []).length === 6).length,
        pdpPairs: (content.placements || []).filter((p) => p.kind === "pdp_pairs").length,
        pdpPairsDisabled: (content.placements || []).filter((p) => p.kind === "pdp_pairs" && (p.enabled === false || p.enabled === 0)).length,
        cartUpsell: (content.placements || []).filter((p) => p.kind === "cart_upsell").length,
        pinnedCollections: (content.collection_pins || []).length,
        redirects: (content.redirects || []).length,
        templates: content.blocks?.surface_templates ?? null,
      }
    : null;
  const mismatched = Object.entries(P4_SEED_LIST).filter(([k, v]) => counts[k] !== v).map(([k, v]) => ({ what: k, want: v, got: counts[k] }));
  return { liveRelease: live.id ?? null, liveNote: live.note ?? null, livePublishedAt: live.published_at ?? null, releases: await n("SELECT count(*) AS n FROM releases"), counts, frozen, photoUses, mismatched, plan };
}

export function writeSeedFile(dataDir, name, config) {
  const file = join(dataDir, name);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { cmd: "seed", posts: 3, draftsOnly: false, worstCase: false, p3: false, p4: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "check" && i === 0) out.cmd = "check";
    else if (a === "--drafts-only") out.draftsOnly = true;
    else if (a === "--worst-case") out.worstCase = true;
    else if (a === "--p3") out.p3 = true;
    else if (a === "--p4") out.p4 = true;
    else if (a === "--posts") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0 || v > 1000) throw new Error("--posts needs a whole number from 0 to 1000");
      out.posts = v;
    } else throw new Error(`Unknown option "${a}". Use: node scripts/seed-design-documents.js [check] [--posts N] [--drafts-only] [--worst-case] [--p3 | --p4]`);
  }
  if (out.p3 && out.draftsOnly) throw new Error("--p3 publishes its drill content, so it can't be used with --drafts-only");
  if (out.p4 && out.p3) throw new Error("--p3 makes a documents store and --p4 a legacy one: use one of them");
  if (out.p4 && (out.draftsOnly || out.worstCase || out.posts !== 3)) throw new Error("--p4 is the perf store as it is, live on the old releases: it takes no --drafts-only, --worst-case or --posts");
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === "check" && opts.p4) {
    const state = await withHarnessStore(async ({ libsql }) => ({ ...(await storeState({ libsql })), p4: await p4State({ libsql }) }), { write: false });
    console.log(JSON.stringify(state));
    return 0;
  }
  if (opts.p4) return seedP4();
  if (opts.cmd === "check") {
    const state = await withHarnessStore(async ({ libsql }) => ({ ...(await storeState({ libsql })), ...(opts.p3 ? { p3: await p3State({ libsql }) } : {}) }), { write: false, databases: opts.p3 ? ALL_DATABASES : undefined });
    console.log(JSON.stringify(state));
    return 0;
  }
  const { buildDocumentsFixture, publishDocumentsFixture } = await import("./perf-docs-fixture.js");
  const fx = await buildDocumentsFixture({ posts: opts.posts });
  const started = Date.now();
  if (opts.p3) return seedP3(opts, fx, started);
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

const ALL_DATABASES = ["platform", "tenant", "default"];

// --p3: a fresh perf seed, the documents store, then the phase 3 drill store.
async function seedP3(opts, fx, started) {
  const H = await import("./design-harness.js");
  const { publishDocumentsFixture } = await import("./perf-docs-fixture.js");
  await H.runHarness({ mode: "seed", fixture: "perf", log: (line) => console.log(line) });
  const dataDir = join(H.ROOT, H.DATA_DIR_NAME);
  const out = await withHarnessStore(
    async ({ libsql, urls, adminPassword }) => {
      await takeOver({ libsql });
      const catalog = opts.worstCase ? await seedWorstCaseCatalog({ libsql }) : null;
      await publishDocumentsFixture(fx);
      const logins = await seedP3Logins();
      const content = await seedP3Content({ libsql, owner: logins.owner });
      const closed = await seedClosedStore({ urls, adminPassword });
      const config = {
        seededAt: new Date().toISOString(),
        stores: { live: { id: H.TENANT_ID, host: "localhost" }, closed },
        logins: { owner: logins.owner, staff: logins.staff },
        ...content,
      };
      writeP3Seed(dataDir, config);
      return { catalog, state: await storeState({ libsql }), p3: await p3State({ libsql }) };
    },
    { databases: ALL_DATABASES },
  );
  const r = out.p3;
  console.log(
    `✓ the harness store is in documents mode with the phase 3 drill content: ${out.state.documents} documents, live release ${out.state.liveRelease}, ${r.rows.publish_log} publish_log rows, ${r.rows.document_refs} document_refs rows, an owner and a staff login, and the closed store on ${CLOSED_STORE.host} (no release)${out.catalog ? ", worst-case catalog" : ""}. Logins and ids: ${H.DATA_DIR_NAME}/${P3_SEED_FILE}. ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  return 0;
}

// --p4: a fresh perf seed (legacy, live on v3), then the phase 4 changes
// through the legacy writers and one more createRelease. No takeOver.
async function seedP4() {
  const started = Date.now();
  const H = await import("./design-harness.js");
  await H.runHarness({ mode: "seed", fixture: "perf", log: (line) => console.log(line) });
  const dataDir = join(H.ROOT, H.DATA_DIR_NAME);
  const out = await withHarnessStore(async ({ libsql }) => {
    const { seedP4Content } = await import("./drills/p4/seed-p4.mjs");
    const content = await seedP4Content({ libsql, plan: await p4Plan(), P4_EXPERIMENT, P4_PAIRS_TITLE, P4_TEMPLATES });
    const logins = await seedP3Logins();
    const state = await storeState({ libsql });
    const p4 = await p4State({ libsql });
    const stores = { live: { id: H.TENANT_ID, host: "localhost" } };
    const config = {
      seededAt: new Date().toISOString(),
      seed: "p4",
      stores,
      logins: { owner: logins.owner, staff: logins.staff },
      liveRelease: content.release,
      chosenProduct: { ...content.plan.chosen, path: `/products/${content.plan.chosen.handle}`, badge: "Bestseller", pairsTitle: P4_PAIRS_TITLE, template: "editorial", modules: 6 },
      pinnedCollection: { ...content.plan.pinned, path: `/collections/${content.plan.pinned.handle}`, template: "sidebar" },
      disabledPairs: { id: content.plan.disabledPairs.id, sourceProductId: content.plan.disabledPairs.sourceProductId },
      secondPairs: { id: content.plan.secondPairs.id, sourceProductId: content.plan.secondPairs.sourceProductId, title: P4_SECOND_PAIRS_TITLE },
      moduleOnlyPhoto: content.plan.moduleOnlyPhoto,
      redirect: content.plan.renamedPost,
      experiment: content.experiment,
      templates: content.templates,
      seedList: P4_SEED_LIST,
    };
    writeSeedFile(dataDir, P4_SEED_FILE, config);
    // the phase 3 helpers read their logins from p3-seed.json (no closed store here)
    writeSeedFile(dataDir, P3_SEED_FILE, { seededAt: config.seededAt, seed: "p4", stores, logins: config.logins });
    return { state, p4 };
  });
  const c = out.p4.counts;
  if (out.p4.mismatched.length) throw new Error(`the --p4 store doesn't match its seed list: ${out.p4.mismatched.map((m) => `${m.what} ${m.got} (want ${m.want})`).join(", ")}`);
  console.log(
    `✓ the harness store is a legacy store live on a version ${c.liveVersion} release (${out.p4.liveRelease}): ${c.productOverrides} product overrides, ${c.pdpPairs} pairs (${c.pdpPairsDisabled} switched off), ${c.pinnedCollections} pinned collections, ${c.media} photos, a running hero experiment, ${c.pageRedirects} redirect, ${c.cmsTemplates} saved templates, an owner and a staff login. Logins and ids: ${H.DATA_DIR_NAME}/${P4_SEED_FILE}. ${((Date.now() - started) / 1000).toFixed(1)}s`,
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
