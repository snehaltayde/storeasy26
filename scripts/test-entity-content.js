// P4-OVL07 suite (OVL-07, OVL-02, ED-12, MIG-02): product and collection
// content on the documents side, and the entity half of the MIG-02 data check.
// File databases only (.test-entc-*.db at the checkout's root, removed at the
// end); no network, no sqld, no Typesense, no Shopify.
//   1. Mapping then reading through candidateSource gives what shoppers see
//      today, for every entity fixture on a v1, v2 and v3 release and on a
//      store open with no release: the product page's accordions (the
//      product's modules in order, then the shared ones), badge, pairs (title
//      and products), product template, and each collection's pins and
//      template. The data check finds no entity difference.
//   2. What the mapping does with the hard cases: a switched-off placement
//      (never published), two placements on one product (the first by
//      position; the other reported), 6 modules (all kept, in order), a
//      10,000-character module (kept exactly), and module HTML today's
//      sanitizer rewrites (the check reports exactly that difference).
//   3. The live rows are liveRowFor's (title, description and image columns
//      stay null); ids reuse an existing (type, entity id) row; mapping
//      twice gives the same output; every mapped body validates.
//   4. The data check after a backfill (no entityRows: it reads
//      product_content_live and collection_content_live back), with no flip,
//      finds a planted mismatch; shoppers of the legacy store still see none
//      of those rows.
//   5. The dry run's verdict no longer refuses a store for its entity content.
//   pnpm test:entity-content
import { COL, P, ENTITY_FIXTURES, ROOT, buildPhase3Leftovers, installHooks, makeLegacyTenant, openWorld } from "./support/legacy-tenants.js";

const started = Date.now();
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg = "") => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b, msg = "") => {
  const x = JSON.stringify(canon(a));
  const y = JSON.stringify(canon(b));
  if (x !== y) throw new Error(`${msg}\n      expected ${y?.slice(0, 700)}\n      got      ${x?.slice(0, 700)}`);
};

installHooks({ headers: "real" });
const world = await openWorld({ prefix: ".test-entc" });
const Res = await import("../lib/content/resolve.js");
const Reg = await import("../lib/registry/index.js");
const M = await import("../lib/migrate/map.js");
const C = await import("../lib/migrate/check.js");
const E = await import("../lib/migrate/map-entities.js");
const Rep = await import("../lib/migrate/report.js");
const LiveRows = await import("../lib/documents/live-rows.js");
const Ids = await import("../lib/documents/ids.js");
const { libsql } = await import("../lib/db.js");

let seq = 0;
async function tenant({ id, state = "live_v3", entities = [], set = "vgate" } = {}) {
  const { db, manifest } = await makeLegacyTenant(world, { id, file: `t${++seq}`, state, entities, set });
  return { db, manifest };
}
const STORE_OPEN = { no_release_open: true };
const mapIt = (db, state) => db.run(() => M.mapTenant({ storeOpen: STORE_OPEN[state], platform: world.control.platformDb() }));
const exec = (db, sql, args = []) => db.run(() => libsql.execute({ sql, args }));

// Every entity fixture whose content shows to shoppers as stored (the
// re-sanitized one has its own case).
const CLEAN = [
  "product_override_modules_badge",
  "product_override_six_modules",
  "product_override_long_module",
  "pdp_pairs_custom_title",
  "pdp_pairs_default_title",
  "pdp_pairs_disabled",
  "pdp_pairs_two_on_one_source",
  "collection_pins",
  "surface_templates_products",
  "surface_templates_collections",
];
// The products and collections those fixtures bring (scripts/support/legacy-tenants.js).
const PRODUCTS = [201, 202, 203, 210, 213, 215, 217, 240].map(P);
const COLLECTIONS = [
  [COL(230), "pinned-col"],
  [COL(241), "sidebar-col"],
];

// What the product page shows (app/(storefront)/products/[handle]/page.js and
// components/pdp/PdpLayouts.js): the accordions are the product's modules,
// then the shared ones; the badge; the pairs strip; the template.
async function productView(G, id) {
  const [o, x, p, p12, tpl] = await Promise.all([G.resolvedProductOverride(id), G.resolvedPdpExtras(), G.resolvedPdpPairs(id), G.resolvedPdpPairs(id, { limit: 12 }), G.resolvedSurfaceTemplateFor("pdp", id)]);
  return {
    accordions: [...(o?.modules || []), ...(x || [])].map((m) => [m.title, m.html]),
    badge: o?.badge || "",
    pairs: { title: p.title, source: p.source, products: p.products.map((q) => q.handle) },
    pairsAll: p12.products.map((q) => q.handle),
    template: tpl.template,
  };
}
// What the collection page shows: the pins it orders by, and the template.
async function collectionView(G, id, handle) {
  const [pins, tpl] = await Promise.all([G.resolvedCollectionPins(handle), G.resolvedSurfaceTemplateFor("collection", id)]);
  return { pins, template: tpl.template };
}
// Both sides, in the tenant's context: the legacy store as a shopper reads it,
// and the mapped candidate (its versions in memory, its live rows handed in).
async function views(db, mapped, { entityRows = C.entityRowsOf(mapped.liveRows) } = {}) {
  return db.run(async () => {
    const legacy = Res.contentGettersFor(await Res.contentSource());
    const cand = Res.contentGettersFor(Res.candidateSource({ list: mapped.list, bodies: mapped.bodies, releaseId: mapped.releaseId, entityRows }));
    const out = { legacy: {}, candidate: {} };
    for (const id of PRODUCTS) {
      out.legacy[id] = await productView(legacy, id);
      out.candidate[id] = await productView(cand, id);
    }
    for (const [id, handle] of COLLECTIONS) {
      out.legacy[id] = await collectionView(legacy, id, handle);
      out.candidate[id] = await collectionView(cand, id, handle);
    }
    return out;
  });
}
const entityDiffs = (check) => check.differences.filter((d) => C.isEntityRoute([d.fn, d.args]));
const docFor = (mapped, entityId) => mapped.documents.find((d) => d.entityId === entityId);
const rowFor = (mapped, entityId) => [...mapped.liveRows.product, ...mapped.liveRows.collection].find((r) => (r.product_id ?? r.collection_id) === entityId);

// =====================================================================================
console.log("— 1. mapped then read through candidateSource: what shoppers see today");
// =====================================================================================
const BUILT = {};
for (const state of ["live_v1", "live_v2", "live_v3", "no_release_open"]) {
  await t(`${state}: every entity fixture reads the same through the candidate (accordions in order, badge, pairs, templates, pins), and the data check finds no entity difference`, async () => {
    const { db } = await tenant({ state, entities: CLEAN });
    const mapped = await mapIt(db, state);
    BUILT[state] = { db, mapped };
    ok(mapped.list, "a candidate list");
    eq(mapped.entities.built, true, "the entity mapper is built:");
    const v = await views(db, mapped);
    for (const id of [...PRODUCTS, ...COLLECTIONS.map(([c]) => c)]) same(v.candidate[id], v.legacy[id], `${state} ${id}:`);
    // the views are not empty: they show the fixtures' content
    same(v.legacy[P(201)].accordions.slice(0, 2), [["How to use", "<p>Twice a day.</p>"], ["Ingredients", "<p>Oils.</p>"]], "the modules first, in order:");
    eq(v.legacy[P(201)].badge, "Lab tested", "badge:");
    same(v.legacy[P(210)].pairs, { title: "Pairs well with", source: "manual", products: ["fixture-211", "fixture-212"] }, "custom pairs:");
    eq(v.legacy[P(240)].template, "editorial", "the product's own template:");
    same(v.legacy[COL(230)], { pins: [P(232), P(230)], template: "standard" }, "pins:");
    eq(v.legacy[COL(241)].template, "sidebar", "the collection's own template:");
    // the in-process data check (the dry run's), entity routes included
    const check = await db.run(() => C.dataCheck(mapped, { routes: C.routesFor(mapped.source) }));
    eq(check.ran, true, "ran:");
    same(entityDiffs(check), [], `${state} entity differences:`);
    ok(check.entityRoutes >= PRODUCTS.length * 4 + COLLECTIONS.length * 2, `entity routes compared: ${check.entityRoutes}`);
    eq(check.skipped, 0, "nothing skipped:");
  });
}

await t("the data check asks for every product and collection with content, on either side (the legacy tables, the release's arrays, the mapped rows)", async () => {
  const { db, mapped } = BUILT.live_v3;
  const routes = await db.run(() => C.entityRoutesFor(mapped));
  const keys = new Set(routes.map(([fn, args]) => `${fn}:${JSON.stringify(args)}`));
  for (const id of PRODUCTS) {
    for (const r of [["resolvedProductOverride", [id]], ["resolvedPdpPairs", [id]], ["resolvedPdpPairs", [id, { limit: 12 }]], ["resolvedSurfaceTemplateFor", ["pdp", id]]]) ok(keys.has(`${r[0]}:${JSON.stringify(r[1])}`), `no route ${r[0]} for ${id}`);
  }
  ok(keys.has(`resolvedCollectionPins:${JSON.stringify(["pinned-col"])}`) && keys.has(`resolvedSurfaceTemplateFor:${JSON.stringify(["collection", COL(241)])}`), "collection routes");
  // the vgate set's own legacy-table content (product 1, collection 2) is asked for too
  ok(keys.has(`resolvedProductOverride:${JSON.stringify([P(1)])}`) && keys.has(`resolvedCollectionPins:${JSON.stringify(["serums"])}`), "the legacy tables' own ids");
});

// =====================================================================================
console.log("— 2. the hard cases");
// =====================================================================================
await t("a switched-off placement is never published; two placements on one product publish the first by position and report the other", async () => {
  for (const state of ["live_v1", "live_v3"]) {
    const { mapped } = BUILT[state];
    // 215 has only a switched-off placement: no document, no row, no pairs
    eq(docFor(mapped, P(215)), undefined, `${state}: a document for the switched-off placement:`);
    eq(rowFor(mapped, P(215)), undefined, `${state}: a live row for it:`);
    // 217: the position-0 placement, never the position-1 one
    const doc = docFor(mapped, P(217));
    same(doc.published.body.settings.pairs, { title: "First pairs", products: [P(218)] }, `${state}: the published pairs:`);
    same([rowFor(mapped, P(217)).pairs, rowFor(mapped, P(217)).pairs_title], [JSON.stringify([P(218)]), "First pairs"], `${state}: the live row:`);
    const notes = await E.mapEntities(mapped.source, { published: state === "live_v1" ? "release+tables" : "release", release: mapped.source.state.live.release.content, existing: new Map() });
    ok(notes.notes.some((n) => n.side === "published" && n.what === "pairs" && n.reason === "switched_off" && n.placement === "pl_fx_pairs_off"), `${state}: the switched-off placement is reported`);
    ok(notes.notes.some((n) => n.side === "published" && n.what === "pairs" && n.reason === "never_shown" && n.placement === "pl_fx_pairs_b"), `${state}: the second placement is reported`);
    ok(mapped.entities.holds.pairsNotShown >= 2, `${state}: counted in the report's holdings: ${JSON.stringify(mapped.entities.holds)}`);
  }
});

await t("6 modules are all kept in order, a 10,000-character module is kept exactly, and over-limit content would be carried, never cut", async () => {
  const { mapped } = BUILT.live_v2;
  const six = docFor(mapped, P(202)).published.body;
  same(six.sections.map((s) => [s.id, s.kind, s.settings.title]), Array.from({ length: 6 }, (_, i) => [`sec_m${i}`, "rich_text", `Module ${i + 1}`]), "six modules:");
  eq(JSON.parse(rowFor(mapped, P(202)).modules).length, 6, "six in the live row:");
  const long = docFor(mapped, P(203)).published.body.sections[0].settings.html;
  eq(long.length, 10000, "the long module's length:");
  // over the old limits (a 7th module, a long title, long text): carried, with the editor's inherited notes
  const body = E.productBody({ modules: [...Array.from({ length: 7 }, (_, i) => ({ title: `M${i}`, html: `<p>${i}</p>` })), { title: "T".repeat(95), html: `<p>${"x".repeat(12000)}</p>` }], badge: null, pairs: null, template: null });
  eq(body.sections.length, 8, "nothing cut:");
  eq(body.sections[7].settings.title.length, 95, "the long title kept:");
  same([...new Set(E.entityIssues(body).notes)].sort(), ["MODULES_OVER_LIMIT", "MODULE_OVER_LIMIT"], "the inherited notes:");
  const row = LiveRows.liveRowFor("product_content", body, { documentId: "doc_prod_x", versionId: "ver_x", publishedAt: null, entityId: P(299) });
  eq(JSON.parse(row.modules).length, 8, "all eight go live:");
});

await t("module HTML today's sanitizer rewrites: the mapped module is sanitized, and the data check reports exactly that difference (the badge and everything else equal)", async () => {
  const { db } = await tenant({ state: "live_v3", entities: ["product_override_unsanitized_html"] });
  const mapped = await mapIt(db, "live_v3");
  const raw = '<p onclick="steal()">Hi <script>alert(1)</script><a href="javascript:alert(2)">there</a></p><img src=x onerror="alert(3)">';
  const html = docFor(mapped, P(204)).published.body.sections[0].settings.html;
  eq(html, Reg.sanitize(raw), "the mapped html is today's sanitizer's:");
  ok(html !== raw && !/onclick|<script|javascript:|onerror/i.test(html), `still unsafe: ${html}`);
  ok(mapped.entities.holds.modulesResanitized >= 1, "counted");
  const check = await db.run(() => C.dataCheck(mapped, { routes: C.routesFor(mapped.source) }));
  const diffs = entityDiffs(check);
  same(diffs.map((d) => [d.fn, d.args]), [["resolvedProductOverride", [P(204)]]], "the one entity difference:");
  same(diffs[0].legacy.ok.modules, [{ title: "Old paste", html: raw }], "legacy shows the stored html:");
  same(diffs[0].candidate.ok, { modules: [{ title: "Old paste", html }], badge: "Old badge" }, "the candidate shows it sanitized:");
  eq(diffs[0].legacy.ok.badge, "Old badge", "same badge:");
});

// =====================================================================================
console.log("— 3. live rows, ids, determinism, validity");
// =====================================================================================
await t("live rows are liveRowFor's own: modules, badge, pairs and template set; title, description, image and seo columns null", async () => {
  const { mapped } = BUILT.live_v3;
  ok(mapped.liveRows.product.length >= 6 && mapped.liveRows.collection.length === 2, `rows: ${mapped.liveRows.product.length} product, ${mapped.liveRows.collection.length} collection`);
  for (const row of mapped.liveRows.product) {
    const d = docFor(mapped, row.product_id);
    same(row, LiveRows.liveRowFor("product_content", d.published.body, { documentId: d.id, versionId: d.published.versionId, publishedAt: row.published_at, entityId: row.product_id }), `${row.product_id}:`);
    for (const c of ["title", "description", "description_html", "featured_image", "featured_image_alt", "gallery", "seo_title", "seo_description", "og_image", "display_vendor", "display_type"]) eq(row[c], null, `${row.product_id} ${c}:`);
    eq(row.version_id, d.published.versionId, "the row names its version:");
    ok(mapped.bodies.has(row.version_id), "the version body is held for the check");
  }
  same(JSON.parse(rowFor(mapped, P(201)).modules), [{ title: "How to use", html: "<p>Twice a day.</p>" }, { title: "Ingredients", html: "<p>Oils.</p>" }], "modules:");
  eq(rowFor(mapped, P(201)).badge, "Lab tested", "badge:");
  eq(rowFor(mapped, P(240)).layout_template, "editorial", "template:");
  same([rowFor(mapped, COL(230)).pinned, rowFor(mapped, COL(241)).layout_template], [JSON.stringify([P(232), P(230)]), "sidebar"], "collections:");
  eq(rowFor(mapped, P(201)).published_at, mapped.source.raw.live_release[0].published_at, "published at the release's time:");
});

await t("ids: the deterministic id, or the existing (type, entity) row's id (a phase-3 random id is reused, never duplicated)", async () => {
  const { mapped } = BUILT.live_v3;
  eq(docFor(mapped, P(201)).id, await Ids.productDocumentId(P(201)), "deterministic product id:");
  eq(docFor(mapped, COL(230)).id, await Ids.collectionDocumentId(COL(230)), "deterministic collection id:");
  const { db } = await tenant({ state: "live_v3", entities: ["product_override_modules_badge"] });
  const left = await buildPhase3Leftovers(db, { productId: P(201) });
  const again = await mapIt(db, "live_v3");
  const d = docFor(again, P(201));
  eq(d.id, left.productDocumentId, "the phase-3 row's id:");
  eq(d.reused, true, "marked reused:");
  eq(again.documents.filter((x) => x.entityId === P(201)).length, 1, "one document for the product:");
  eq(rowFor(again, P(201)).document_id, left.productDocumentId, "the live row's document:");
});

await t("mapping twice gives the same documents, versions and live rows; drafts that equal what is live are not dirty, an unpublished table edit is", async () => {
  const { db, mapped } = BUILT.live_v1;
  const again = await mapIt(db, "live_v1");
  const pick = (m) => ({ docs: m.documents.filter((d) => d.entityId), rows: m.liveRows, refs: m.refs });
  same(pick(again), pick(mapped), "a second mapping:");
  // v1 reads the tables live: drafts and published are the same
  same(mapped.documents.filter((d) => d.entityId && d.dirty).map((d) => d.entityId), [], "v1 dirty entity documents:");
  // v3 froze the arrays: the vgate set's table rows for product 1 and collection 2 are unpublished drafts
  const v3 = BUILT.live_v3.mapped;
  const p1 = docFor(v3, P(1));
  ok(p1 && p1.dirty && !p1.published, "product 1's table override is a never-published draft on v3");
  eq(p1.draft.settings.badge, "TABLE", "its draft:");
});

await t("every mapped body is a valid product or collection content body (publish mode), with merged, registered section kinds", async () => {
  for (const { mapped } of Object.values(BUILT)) {
    for (const d of mapped.documents.filter((x) => x.entityId)) {
      for (const b of [d.draft, d.published?.body].filter(Boolean)) {
        same(E.entityIssues(b).errors, [], `${d.type} ${d.entityId}:`);
        for (const s of b.sections || []) ok(Reg.SECTION_ID_RE.test(s.id) && Reg.isAllowedOn(s.kind, b.type), `${d.entityId} section ${s.id} ${s.kind}`);
      }
    }
  }
});

// =====================================================================================
console.log("— 4. after a backfill, before the flip: read back from the live tables");
// =====================================================================================
await t("the entity data check reads product_content_live back when the candidate has no rows of its own, and finds a planted mismatch; legacy shoppers see none of those rows", async () => {
  const { db } = await tenant({ state: "live_v3", entities: CLEAN });
  const mapped = await mapIt(db, "live_v3");
  // write the mapped rows as a backfill would (no flip: the store stays legacy, v3 live)
  await db.run(async () => {
    const stmts = [
      ...mapped.liveRows.product.map((row) => LiveRows.liveRowStatement({ type: "product_content", entityId: row.product_id, row })),
      ...mapped.liveRows.collection.map((row) => LiveRows.liveRowStatement({ type: "collection_content", entityId: row.collection_id, row })),
    ];
    await libsql.batch(stmts, "write");
  });
  const mode = await db.run(async () => String((await libsql.execute("SELECT mode FROM cms_state WHERE id = 1")).rows[0].mode));
  eq(mode, "legacy", "no flip:");
  const run = (entities) => db.run(() => C.dataCheck(mapped, { routes: C.routesFor(mapped.source), entities }));
  const clean = await run("live");
  eq(clean.entities, "live", "read back:");
  same(entityDiffs(clean), [], "read back, no planted change:");
  // plant a mismatch in the tables
  await exec(db, "UPDATE product_content_live SET badge = 'Planted badge' WHERE product_id = ?", [P(201)]);
  await exec(db, "UPDATE collection_content_live SET pinned = ? WHERE collection_id = ?", [JSON.stringify([P(231)]), COL(230)]);
  const planted = await run("live");
  same(entityDiffs(planted).map((d) => [d.fn, d.args]).sort(), [["resolvedCollectionPins", ["pinned-col"]], ["resolvedProductOverride", [P(201)]]].sort(), "the planted differences:");
  eq(entityDiffs(planted).find((d) => d.fn === "resolvedProductOverride").candidate.ok.badge, "Planted badge", "read from the table:");
  // the dry run's mapped rows do not see the table
  same(entityDiffs(await run("mapped")), [], "mapped rows ignore the table:");
  // a row in the table for a product the mapping has nothing for is asked for too
  await exec(db, "INSERT INTO product_content_live (product_id, document_id, version_id, badge, published_at) VALUES (?, 'doc_prod_stray', 'ver_stray', 'Stray', '2026-01-01')", [P(2)]);
  const withSource = { ...mapped, source: await db.run(() => M.readLegacySource({ platform: world.control.platformDb() })) };
  const stray = await db.run(() => C.dataCheck(withSource, { routes: C.routesFor(withSource.source), entities: "live" }));
  ok(entityDiffs(stray).some((d) => d.fn === "resolvedProductOverride" && d.args[0] === P(2) && d.candidate.ok.badge === "Stray"), "a stray row is found");
  // shoppers of the legacy store see the frozen v3 answers, none of the rows
  const shopper = await db.run(async () => [await Res.resolvedProductOverride(P(201)), await Res.resolvedCollectionPins("pinned-col"), await Res.resolvedSurfaceTemplateFor("pdp", P(240))]);
  same([shopper[0].badge, shopper[1], shopper[2].template], ["Lab tested", [P(232), P(230)], "editorial"], "the legacy store's shoppers:");
});

// =====================================================================================
console.log("— 5. the dry run's report");
// =====================================================================================
await t("a store whose only extras are product and collection content is no longer refused for them; the report's facts carry the entity counts", async () => {
  const { db } = await tenant({ id: "jle", set: "journal", state: "live_v3", entities: CLEAN });
  const mapped = await mapIt(db, "live_v3");
  ok(!mapped.report.refusals.some((r) => r.code === "ENTITY_CONTENT_NOT_MOVABLE"), `refusals: ${JSON.stringify(mapped.report.refusals.map((r) => r.code))}`);
  eq(mapped.report.entities.built, true, "built:");
  ok(mapped.report.entities.holds.products > 0 && Number.isInteger(mapped.report.entities.holds.pairsNotShown), JSON.stringify(mapped.report.entities.holds));
  const check = await db.run(() => C.dataCheck(mapped, { routes: C.routesFor(mapped.source) }));
  same(check.differences, [], "no difference at all:");
  const report = Rep.buildReport({ ...mapped }, check);
  ok(!report.verdict.fixes.some((f) => f.code === "ENTITY_CONTENT_NOT_MOVABLE"), `fixes: ${JSON.stringify(report.verdict.fixes)}`);
  same(report.shopperChanges, [], "nothing shoppers would see change:");
});

for (const name of CLEAN) ok(ENTITY_FIXTURES[name], `unknown fixture ${name}`);
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
await world.cleanup();
process.exit(fail ? 1 : 0);
