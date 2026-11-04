// Section composition suite (S54 / audit slice 2): durable instance ids and
// per-instance data resolution — the proof that duplicate sections are
// INDEPENDENT (the audit's "repeated home sections overwrite each other's
// data" finding) and that identical queries still batch.
//   pnpm test:sections
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-sections.db";

for (const f of [".test-sections.db"]) await rm(join(here, "..", f), { force: true });

const { libsql } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
await runMigrations(libsql, await loadMigrations("tenant"));

const { resolveHomeSectionData } = await import("../lib/cms/section-data.js");
const { ensureSectionIds, SECTION_ID_RE, legacySectionId, HOME_SECTION_KINDS, PAGE_SECTION_KINDS, componentFor } = await import("../lib/cms/registry.js");
const { validateBlock } = await import("../lib/cms/validate.js");
const S = await import("../lib/cms/store.js");
const { upgradeBlock, PAGE_SCHEMA } = await import("../lib/cms/schemas.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(label || "expected truthy");
};

// --- registry ---------------------------------------------------------------
await t("registry: families enumerate the real kinds; every component has defaults + settings", () => {
  eq(JSON.stringify(HOME_SECTION_KINDS.sort()), JSON.stringify(["banner", "collections", "image_with_text", "new", "product_rail", "rich_text"]));
  eq(JSON.stringify(PAGE_SECTION_KINDS.sort()), JSON.stringify(["faq", "image", "rich", "text"]));
  for (const kind of [...HOME_SECTION_KINDS, ...PAGE_SECTION_KINDS]) {
    const c = componentFor(kind);
    ok(c.defaults && Array.isArray(c.settings) && c.version >= 2, kind);
  }
});

await t("ids: ensureSectionIds keeps valid unique ids, mints for missing and DUPLICATES", () => {
  const out = ensureSectionIds([{ id: "sec_aaaa1111", kind: "new" }, { id: "sec_aaaa1111", kind: "new" }, { kind: "banner" }]);
  eq(out[0].id, "sec_aaaa1111", "first keeps");
  ok(out[1].id !== "sec_aaaa1111" && SECTION_ID_RE.test(out[1].id), "duplicate re-minted");
  ok(SECTION_ID_RE.test(out[2].id), "missing minted");
  eq(new Set(out.map((s) => s.id)).size, 3, "all unique");
});

await t("validate home_sections: stamps ids; round-trip preserves them", () => {
  const first = validateBlock("home_sections", [{ kind: "new", title: "A", limit: 4 }, { kind: "banner", title: "B", href: "/collections" }]);
  eq(first.ok, true);
  ok(first.value.every((s) => SECTION_ID_RE.test(s.id)), "stamped");
  const again = validateBlock("home_sections", first.value);
  eq(JSON.stringify(again.value.map((s) => s.id)), JSON.stringify(first.value.map((s) => s.id)), "ids stable across saves");
});

// --- lazy legacy upgrade is DETERMINISTIC -----------------------------------
await t("legacy id-less content upgrades with DETERMINISTIC index ids (read twice = identical)", async () => {
  await libsql.execute({
    sql: "INSERT INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES ('home_sections', ?, '2026-01-01', 1, 1)",
    args: [JSON.stringify([{ kind: "collections", title: "Old", limit: 6, enabled: true }, { kind: "new", title: "Older", limit: 8, enabled: true }])],
  });
  const a = await S.getBlockRow("home_sections");
  const b = await S.getBlockRow("home_sections");
  eq(a.value[0].id, legacySectionId(0), "index-derived");
  eq(JSON.stringify(a.value.map((s) => s.id)), JSON.stringify(b.value.map((s) => s.id)), "stable across reads");
  // page sections too (PAGE_SCHEMA v3)
  const migrated = PAGE_SCHEMA.migrate({ sections: [{ heading: "H", body: ["x"] }] });
  eq(migrated.sections[0].kind, "text", "v1 kind heal kept");
  eq(migrated.sections[0].id, legacySectionId(0), "page section id");
  ok(upgradeBlock("home_sections", [{ kind: "new" }], 1)[0].id, "upgradeBlock path stamps");
});

// --- per-instance data -------------------------------------------------------
const counts = { featured: 0, byHandles: 0, newest: 0 };
const repo = {
  getFeaturedCollections: async (limit) => {
    counts.featured++;
    return Array.from({ length: limit }, (_, i) => ({ handle: `c${i}` }));
  },
  getCollectionsByHandles: async (handles) => {
    counts.byHandles++;
    return handles.map((h) => ({ handle: h }));
  },
  getNewestProducts: async (limit) => {
    counts.newest++;
    return Array.from({ length: limit }, (_, i) => ({ id: `p${i}` }));
  },
};

await t("duplicate sections resolve INDEPENDENTLY — each instance keeps its own limit", async () => {
  const sections = [
    { id: "sec_newa0001", kind: "new", limit: 4, enabled: true },
    { id: "sec_newb0002", kind: "new", limit: 9, enabled: true },
  ];
  const data = await resolveHomeSectionData(sections, { repo });
  eq(data.get("sec_newa0001").products.length, 4, "first instance");
  eq(data.get("sec_newb0002").products.length, 9, "second instance — the old shared slot made this 4");
});

await t("identical queries batch; curated collections fetch ONCE and slice per instance", async () => {
  Object.keys(counts).forEach((k) => (counts[k] = 0));
  const sections = [
    { id: "sec_n1", kind: "new", limit: 6, enabled: true },
    { id: "sec_n2", kind: "new", limit: 6, enabled: true }, // identical → batched
    { id: "sec_c1", kind: "collections", limit: 2, enabled: true },
    { id: "sec_c2", kind: "collections", limit: 5, enabled: true },
  ];
  const data = await resolveHomeSectionData(sections, { index: { featured: ["a", "b", "c", "d", "e", "f"] }, repo });
  eq(counts.newest, 1, "identical newest queries batched");
  eq(counts.byHandles, 1, "curated fetched once");
  eq(counts.featured, 0, "no fallback when curated");
  eq(data.get("sec_c1").collections.length, 2, "sliced per instance");
  eq(data.get("sec_c2").collections.length, 5, "sliced per instance");
  eq(data.get("sec_n1").products, data.get("sec_n2").products, "batch shares the resolved array");
});

// --- S55 (slice 4): the broader library ---------------------------------------
await t("image_with_text + product_rail validate (and reject bad input) through the registry", () => {
  const good = validateBlock("home_sections", [
    { kind: "image_with_text", image: "/api/media/med1", image_alt: "Serum on linen", image_side: "right", title: "Why it works", text: "t", label: "Read", href: "/journal" },
    { kind: "product_rail", title: "Bestsellers", collection: "serums", limit: 4 },
  ]);
  eq(good.ok, true, good.errors.join("; "));
  eq(good.value[0].image_side, "right");
  eq(good.value[1].collection, "serums");
  const bad = validateBlock("home_sections", [
    { kind: "image_with_text", image: "javascript:x", image_alt: "" },
    { kind: "product_rail", collection: "NOT A HANDLE!" },
  ]);
  eq(bad.ok, false);
  ok(bad.errors.some((e) => /image must be/.test(e)) && bad.errors.some((e) => /alt text/.test(e)) && bad.errors.some((e) => /pick a collection/.test(e)), bad.errors.join("; "));
});

await t("product_rail binds to ITS collection per instance; same (collection,limit) batches", async () => {
  const calls = [];
  const railRepo = {
    ...repo,
    getProductsInCollection: async (handle, { limit }) => {
      calls.push(`${handle}:${limit}`);
      return { products: Array.from({ length: limit }, (_, i) => ({ id: `${handle}-${i}` })) };
    },
  };
  const sections = [
    { id: "sec_r1", kind: "product_rail", collection: "serums", limit: 3, enabled: true },
    { id: "sec_r2", kind: "product_rail", collection: "masks", limit: 5, enabled: true },
    { id: "sec_r3", kind: "product_rail", collection: "serums", limit: 3, enabled: true }, // identical → batched
  ];
  const data = await resolveHomeSectionData(sections, { repo: railRepo });
  eq(data.get("sec_r1").products.length, 3);
  eq(data.get("sec_r2").products.length, 5);
  eq(data.get("sec_r2").products[0].id, "masks-0", "bound to its own collection");
  eq(calls.length, 2, "identical rails batched");
});

await t("renderer-side filters include the new kinds (registry-driven, nothing dropped)", async () => {
  const saved = validateBlock("home_sections", [{ kind: "product_rail", collection: "serums", limit: 4 }]);
  await S.setBlock("home_sections", saved.value);
  const rendered = await S.getHomeSections();
  eq(rendered.length, 1, "product_rail survives the render filter");
  eq(rendered[0].kind, "product_rail");
  await S.deleteBlock("home_sections");
});

await t("id-less legacy sections key by index (old live snapshots keep rendering)", async () => {
  const data = await resolveHomeSectionData([{ kind: "new", limit: 3, enabled: true }], { repo });
  eq(data.get("i-0").products.length, 3);
});

// --- S56: per-surface templates ------------------------------------------------
await t("surface_templates: choices validate, defaults merge, null = platform defaults", async () => {
  eq(validateBlock("surface_templates", null).ok, true, "null ok");
  const bad = validateBlock("surface_templates", { pdp: "brutalist" });
  eq(bad.ok, false);
  const good = validateBlock("surface_templates", { pdp: "editorial" });
  eq(good.ok, true);
  eq(good.value.pdp, "editorial");
  eq(good.value.collection, undefined, "unset surface stays unset in storage");
  // default-only picks normalize back to null (nothing customized)
  eq(validateBlock("surface_templates", {}).value, null);
  await S.setBlock("surface_templates", { pdp: "editorial" });
  const eff = await S.getSurfaceTemplates();
  eq(eff.pdp, "editorial", "stored pick wins");
  eq(eff.collection, "standard", "unset surface keeps the platform default");
  await S.deleteBlock("surface_templates");
  const back = await S.getSurfaceTemplates();
  eq(back.pdp, "classic", "reset restores defaults");
  // S61: global chrome variants ride the same block (family-level only)
  eq(back.header, "standard", "chrome defaults present");
  eq(back.footer, "columns");
  const chrome = validateBlock("surface_templates", { header: "centered", footer: "minimal" });
  eq(chrome.ok, true, chrome.errors.join("; "));
  eq(chrome.value.header, "centered");
  eq(validateBlock("surface_templates", { header: "mega" }).ok, false, "unknown chrome variant rejected");
});

// --- S57: explicit per-entity assignment --------------------------------------
await t("surface_templates: entity exception maps validate; bad picks and shapes rejected", () => {
  const good = validateBlock("surface_templates", { pdp: "editorial", products: { "gid://p/1": "classic" }, collections: { "gid://c/2": "sidebar" } });
  eq(good.ok, true, good.errors.join("; "));
  eq(good.value.products["gid://p/1"], "classic", "explicit pin kept even though family differs");
  eq(good.value.collections["gid://c/2"], "sidebar");
  const badPick = validateBlock("surface_templates", { products: { "gid://p/1": "sidebar" } }); // collection tpl on a product
  eq(badPick.ok, false);
  const badShape = validateBlock("surface_templates", { products: ["gid://p/1"] });
  eq(badShape.ok, false);
  // empty maps normalize away; all-default+empty → null
  eq(validateBlock("surface_templates", { products: {} }).value, null);
});

await t("effectiveSurfaceTemplate: entity → family → platform precedence; junk ignored", async () => {
  const { effectiveSurfaceTemplate } = await import("../lib/cms/defaults.js");
  const value = { pdp: "editorial", products: { "gid://p/1": "classic" } };
  eq(effectiveSurfaceTemplate(value, "pdp", "gid://p/1").template, "classic", "explicit assignment wins");
  eq(effectiveSurfaceTemplate(value, "pdp", "gid://p/1").source, "entity");
  eq(effectiveSurfaceTemplate(value, "pdp", "gid://p/9").template, "editorial", "unassigned entity → family default");
  eq(effectiveSurfaceTemplate(value, "pdp", "gid://p/9").source, "family");
  eq(effectiveSurfaceTemplate(null, "pdp", "gid://p/1").template, "classic", "no block → platform default");
  eq(effectiveSurfaceTemplate(null, "pdp", "gid://p/1").source, "platform");
  eq(effectiveSurfaceTemplate({ products: { "gid://p/1": "nope" } }, "pdp", "gid://p/1").source, "platform", "invalid stored pick ignored");
  eq(effectiveSurfaceTemplate({ collection: "sidebar" }, "collection", null).template, "sidebar", "entityId null → family path");
});

// --- S57: handle→id reference migration (rename-proof curation) ----------------
await t("validate: product_rail keeps collection_id; empty id drops; collections_index ids filter to present handles", () => {
  const rail = validateBlock("home_sections", [{ kind: "product_rail", collection: "serums", collection_id: "gid://c/9", limit: 4 }]);
  eq(rail.ok, true, rail.errors.join("; "));
  eq(rail.value[0].collection_id, "gid://c/9");
  const cleared = validateBlock("home_sections", [{ kind: "product_rail", collection: "serums", collection_id: "", limit: 4 }]);
  eq("collection_id" in cleared.value[0], false, "hand-typed handle carries no id");
  const ci = validateBlock("collections_index", {
    featured: ["serums"],
    order: [],
    hide: ["masks"],
    ids: { serums: "gid://c/9", masks: "gid://c/8", gone: "gid://c/7", "": "gid://c/6" },
  });
  eq(ci.ok, true, ci.errors.join("; "));
  eq(JSON.stringify(ci.value.ids), JSON.stringify({ serums: "gid://c/9", masks: "gid://c/8" }), "only listed handles keep ids");
});

await t("rename heals: rail + collections_index follow the id to the CURRENT handle; editors keep the stored value", async () => {
  await libsql.execute({ sql: "INSERT INTO collections (id, handle, title) VALUES (?, ?, ?)", args: ["gid://c/9", "serums", "Serums"] });
  const rail = validateBlock("home_sections", [{ kind: "product_rail", collection: "serums", collection_id: "gid://c/9", limit: 4 }]);
  await S.setBlock("home_sections", rail.value);
  const ci = validateBlock("collections_index", { featured: ["serums"], order: [], hide: [], ids: { serums: "gid://c/9" } });
  await S.setBlock("collections_index", ci.value);

  // Shopify rename: serums → face-serums (same id)
  await libsql.execute({ sql: "UPDATE collections SET handle = 'face-serums' WHERE id = 'gid://c/9'", args: [] });
  const sections = await S.getHomeSections();
  eq(sections[0].collection, "face-serums", "rail healed to the current handle");
  const healed = await S.getCollectionsIndex();
  eq(JSON.stringify(healed.featured), JSON.stringify(["face-serums"]), "index healed");
  eq("ids" in healed, false, "ids sidecar never reaches renderers");
  const raw = await S.getCollectionsIndexRaw();
  eq(raw.featured[0], "serums", "editor raw view keeps the STORED handle");
  eq(raw.ids.serums, "gid://c/9", "and the ids sidecar");

  // deleted collection: id lookup misses → stored handle is the fallback
  await libsql.execute({ sql: "DELETE FROM collections WHERE id = 'gid://c/9'", args: [] });
  const after = await S.getHomeSections();
  eq(after[0].collection, "serums", "missing id falls back to the stored handle");
  await S.deleteBlock("home_sections");
  await S.deleteBlock("collections_index");
});

// --- P5-SOURCES (TREE-01): the source table -------------------------------------
const Reg = await import("../lib/registry/index.js");
const Src = await import("../lib/registry/sources.js");
const same = (got, want, label = "") => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`);
};
async function logsOf(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines: lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
  } finally {
    console.log = log;
  }
}
const regSec = (kind, id, settings = {}) => ({ id, kind, v: 1, enabled: true, settings });
const tableNames = () => Object.keys(Src.SOURCES).sort();
const BUILT_IN_SOURCES = ["bundle_by_id", "bundles_by_ids", "collection_products", "featured_collections", "newest_products", "route_product"];

await t("P5-SOURCES: the table holds the six built-in sources, each with a resolve function", () => {
  same(tableNames(), BUILT_IN_SOURCES, "names:");
  for (const n of BUILT_IN_SOURCES) {
    ok(typeof Src.SOURCES[n].resolve === "function" && Array.isArray(Src.SOURCES[n].args), n);
    eq(Src.getSource(n), Src.SOURCES[n], `getSource(${n})`);
  }
  eq(Src.getSource("every_product"), null, "unknown:");
  eq(Src.SOURCES.bundle_by_id.prefetch, Src.SOURCES.bundles_by_ids.prefetch, "the two bundle sources share one prefetch:");
});

await t("P5-SOURCES: a throwaway source (defineSource) plus a throwaway kind resolves through resolveHomeSectionData; removeSource restores the table", async () => {
  const before = tableNames();
  const seen = [];
  Src.defineSource({ name: "p5_echo", args: ["word"], resolve: (r, args) => (seen.push(args), Promise.resolve(`echo:${args.word}:${args.limit}`)) });
  Reg.defineSection({ kind: "p5_echo_kind", label: "Echo", documentTypes: ["home"], settings: [{ key: "word", kind: "text", label: "Word", max: 20, default: "hi" }], bindings: { said: { sources: ["p5_echo"], args: ["word"] } } });
  try {
    const data = await resolveHomeSectionData([regSec("p5_echo_kind", "sec_echo1", { word: "hello" }), regSec("p5_echo_kind", "sec_echo2", {})], { repo: {} });
    eq(data.get("sec_echo1").said, "echo:hello:8", "own setting, default limit:");
    eq(data.get("sec_echo2").said, "echo:hi:8", "declared default:");
    eq(seen.length, 2, "one call per distinct args");
    same(Reg.checkRegistry(), [], "the registry is clean with the source present:");
  } finally {
    Reg.removeSection("p5_echo_kind");
    eq(Src.removeSource("p5_echo"), true, "removed");
  }
  same(tableNames(), before, "the table is back as it was:");
  eq("p5_echo" in Src.SOURCES, false, "gone from SOURCES");
});

await t("P5-SOURCES: defineSection refuses a source not in the table, and a malformed binding; a singular source is read as sources", () => {
  let err = null;
  try {
    Reg.defineSection({ kind: "p5_bad_src", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { products: { sources: ["every_product"], args: ["limit"] } } });
  } catch (e) {
    err = e;
  }
  ok(err && /every_product/.test(err.message) && /source table/.test(err.message), `refused: ${err?.message}`);
  eq(Reg.sectionType("p5_bad_src"), null, "not registered");
  for (const bindings of [{ x: { sources: [], args: [] } }, { x: { sources: [""], args: [] } }, { x: { sources: ["newest_products"], args: ["nope"] } }, { x: "newest_products" }]) {
    let threw = false;
    try {
      Reg.defineSection({ kind: "p5_bad_shape", documentTypes: ["home"], settings: [], bindings });
    } catch {
      threw = true;
    }
    ok(threw, `refused ${JSON.stringify(bindings)}`);
    eq(Reg.sectionType("p5_bad_shape"), null);
  }
  const d = Reg.defineSection({ kind: "p5_singular", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { products: { source: "newest_products", args: ["limit"] } } });
  try {
    same(d.bindings, { products: { sources: ["newest_products"], args: ["limit"] } }, "normalised:");
  } finally {
    Reg.removeSection("p5_singular");
  }
  // every real kind declares the normalised shape
  for (const kind of Reg.sectionKinds()) for (const b of Object.values(Reg.sectionType(kind).bindings)) ok(Array.isArray(b.sources) && b.sources.every((x) => x in Src.SOURCES), kind);
});

await t("P5-SOURCES: checkRegistry names the kind and the source when the source is removed after registration", () => {
  Src.defineSource({ name: "p5_gone", args: ["limit"], resolve: () => Promise.resolve([]) });
  Reg.defineSection({ kind: "p5_gone_kind", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { products: { sources: ["p5_gone"], args: ["limit"] } } });
  try {
    same(Reg.checkRegistry(), [], "clean while the source is there:");
    Src.removeSource("p5_gone");
    const problems = Reg.checkRegistry();
    ok(problems.length === 1 && /p5_gone_kind/.test(problems[0]) && /"p5_gone"/.test(problems[0]), `reported: ${JSON.stringify(problems)}`);
  } finally {
    Reg.removeSection("p5_gone_kind");
    Src.removeSource("p5_gone");
  }
  same(Reg.checkRegistry(), [], "clean again:");
});

await t("P5-SOURCES runtime: a source removed after registration fails that binding (bindingFailed, cause source_unknown), logs once, reads nothing, never throws", async () => {
  Src.defineSource({ name: "p5_late", args: ["limit"], resolve: () => Promise.resolve(["should not be read"]) });
  Reg.defineSection({ kind: "p5_late_kind", label: "Late", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { collections: { sources: ["p5_late"], args: ["limit"] } } });
  Src.removeSource("p5_late");
  const calls = { featured: 0, byHandles: 0 };
  const watch = {
    ...repo,
    getFeaturedCollections: async (n) => (calls.featured++, repo.getFeaturedCollections(n)),
    getCollectionsByHandles: async (h) => (calls.byHandles++, repo.getCollectionsByHandles(h)),
  };
  try {
    const { result: data, lines } = await logsOf(() => resolveHomeSectionData([regSec("p5_late_kind", "sec_late1", { limit: 2 }), regSec("new", "sec_ok1", { limit: 2 })], { repo: watch }));
    const d = data.get("sec_late1");
    same(d.bindingFailed, ["collections"], "bindingFailed:");
    same(d.bindingFailedCause, { collections: "source_unknown" }, "cause:");
    eq(d.collections, undefined, "no collections");
    same(d, { bindingFailed: ["collections"] }, "the data's JSON is unchanged in shape (the cause is not enumerable):");
    eq(data.get("sec_ok1").products.length, 2, "the other section resolves");
    const failed = lines.filter((l) => l.evt === "section_binding_failed");
    same(failed.map((l) => [l.sectionId, l.kind, l.field, l.source, l.cause]), [["sec_late1", "p5_late_kind", "collections", "p5_late", "source_unknown"]], "one log line:");
    eq(calls.featured + calls.byHandles, 0, "no collections read");
  } finally {
    Reg.removeSection("p5_late_kind");
  }
});

await t("P5-SOURCES: registry-shaped sections ({ id, kind, settings }): collections at 3 and 6 and two new instances resolve independently, identical queries once", async () => {
  const calls = { newest: [], byHandles: 0, featured: 0 };
  const r = {
    getFeaturedCollections: async (n) => (calls.featured++, repo.getFeaturedCollections(n)),
    getCollectionsByHandles: async (h) => (calls.byHandles++, h.map((handle) => ({ handle }))),
    getNewestProducts: async (n) => (calls.newest.push(n), Array.from({ length: n }, (_, i) => ({ id: `p${i}` }))),
  };
  const sections = [regSec("collections", "sec_rc3", { title: "A", limit: 3 }), regSec("collections", "sec_rc6", { title: "B", limit: 6 }), regSec("new", "sec_rn1", { title: "N", limit: 5 }), regSec("new", "sec_rn2", { title: "M", limit: 5 })];
  const data = await resolveHomeSectionData(sections, { index: { featured: ["a", "b", "c", "d", "e", "f", "g"] }, repo: r });
  eq(data.get("sec_rc3").collections.length, 3, "limit 3:");
  eq(data.get("sec_rc6").collections.length, 6, "limit 6:");
  eq(data.get("sec_rn1").products.length, 5);
  eq(data.get("sec_rn2").products.length, 5);
  eq(calls.byHandles, 1, "getCollectionsByHandles once:");
  eq(calls.featured, 0, "no featured fallback:");
  same(calls.newest, [5], "getNewestProducts once:");
  // a default limit when the setting is left out
  const d = await resolveHomeSectionData([regSec("new", "sec_rnd", {})], { repo: r });
  eq(d.get("sec_rnd").products.length, 8, "the declared default limit:");
});

await t("P5-SOURCES: a product rail's registry { handle, id } setting gives its source the handle (the collection argOf)", async () => {
  const asked = [];
  const r = { ...repo, getProductsInCollection: async (h, { limit }) => (asked.push(`${h}:${limit}`), { products: [{ id: "x" }] }) };
  const data = await resolveHomeSectionData([regSec("product_rail", "sec_rr1", { collection: { handle: "serums", id: "gid://c/1" }, limit: 4 }), regSec("product_rail", "sec_rr2", { collection: { id: "gid://c/2" } })], { repo: r, documents: true });
  same(asked, ["serums:4"], "only the rail with a handle reads:");
  eq(data.get("sec_rr1").handPicked, false);
  same(data.get("sec_rr2"), { products: [], handPicked: false }, "no handle, no products:");
});

const bundleRepo = (calls, { fail = false } = {}) => ({
  bundlesByIds: async (ids) => {
    calls.push([...ids]);
    if (fail) throw new Error("SQLITE_BUSY: database is locked");
    return ids.filter((id) => id !== "bun-gone").map((id) => ({ id, state: "available", title: `T ${id}` }));
  },
});
const bundleSections = () => [
  regSec("p5_card", "sec_bc1", { bundle: { id: "bun-a" } }),
  regSec("p5_card", "sec_bc2", { bundle: { id: "bun-b" } }),
  regSec("p5_grid", "sec_bg1", { bundles: [{ id: "bun-c" }, { id: "bun-a" }, { id: "bun-gone" }, { id: "bun-d" }] }),
];
function withBundleKinds(fn) {
  // throwaway kinds: the bundle setting kinds arrive with P5-SETTING, so the
  // settings are declared as text here; the resolver reads the stored values
  Reg.defineSection({ kind: "p5_card", label: "Card", documentTypes: ["home"], settings: [{ key: "bundle", kind: "text", label: "Bundle", max: 80, default: "" }], bindings: { bundle: { sources: ["bundle_by_id"], args: ["bundle"] } } });
  Reg.defineSection({ kind: "p5_grid", label: "Grid", documentTypes: ["home"], settings: [{ key: "bundles", kind: "text", label: "Bundles", max: 80, default: "" }], bindings: { bundles: { sources: ["bundles_by_ids"], args: ["bundles"] } } });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Reg.removeSection("p5_card");
      Reg.removeSection("p5_grid");
    });
}

await t("P5-SOURCES: 2 bundle_by_id and 1 bundles_by_ids (of 4) make ONE repo.bundlesByIds call with the deduped ids, keep the picked order, and mark an absent id missing", async () => {
  await withBundleKinds(async () => {
    const calls = [];
    const { result: data, lines } = await logsOf(() => resolveHomeSectionData(bundleSections(), { repo: bundleRepo(calls) }));
    eq(calls.length, 1, "one read:");
    same(calls[0], ["bun-a", "bun-b", "bun-c", "bun-gone", "bun-d"], "deduped ids, first-seen order:");
    eq(data.get("sec_bc1").bundle.id, "bun-a");
    eq(data.get("sec_bc2").bundle.id, "bun-b");
    same(data.get("sec_bg1").bundles.map((b) => [b.id, b.state]), [["bun-c", "available"], ["bun-a", "available"], ["bun-gone", "missing"], ["bun-d", "available"]], "picked order, none skipped:");
    eq(lines.filter((l) => l.evt === "section_binding_failed").length, 0, "no failure logged");
    // a card whose bundle the read has not got: no data (the component treats it as missing)
    const one = await resolveHomeSectionData([regSec("p5_card", "sec_bc9", { bundle: { id: "bun-gone" } })], { repo: bundleRepo([]) });
    same(one.get("sec_bc9"), {}, "absent bundle: no data:");
    // no bundle picked: no read at all
    const none = [];
    await resolveHomeSectionData([regSec("p5_card", "sec_bc8", { bundle: null }), regSec("p5_grid", "sec_bg8", { bundles: [] })], { repo: bundleRepo(none) });
    eq(none.length, 0, "nothing picked, nothing read:");
  });
});

await t("P5-SOURCES: a bundle read that rejects fails every bundle instance (bindingFailed, cause fault), logs each, never throws", async () => {
  await withBundleKinds(async () => {
    const calls = [];
    const { result: data, lines } = await logsOf(() => resolveHomeSectionData([...bundleSections(), regSec("new", "sec_bn1", { limit: 2 })], { repo: { ...bundleRepo(calls, { fail: true }), getNewestProducts: repo.getNewestProducts } }));
    eq(calls.length, 1, "still one read:");
    for (const [id, field] of [["sec_bc1", "bundle"], ["sec_bc2", "bundle"], ["sec_bg1", "bundles"]]) {
      same(data.get(id).bindingFailed, [field], `${id} failed:`);
      same(data.get(id).bindingFailedCause, { [field]: "fault" }, `${id} cause:`);
    }
    eq(data.get("sec_bn1").products.length, 2, "other sections unaffected");
    same(lines.filter((l) => l.evt === "section_binding_failed").map((l) => [l.sectionId, l.cause]), [["sec_bc1", "fault"], ["sec_bc2", "fault"], ["sec_bg1", "fault"]], "log lines:");
  });
});

await t("P5-SOURCES: the bundle argOf turns { id } into the id and [{ id }] into the ids in order", () => {
  eq(Src.SOURCES.bundle_by_id.argOf({ id: "bun-1" }), "bun-1");
  eq(Src.SOURCES.bundle_by_id.argOf(null), null);
  eq(Src.SOURCES.bundle_by_id.argOf({}), undefined);
  same(Src.SOURCES.bundles_by_ids.argOf([{ id: "b2" }, { id: "b1" }, {}, null]), ["b2", "b1"]);
  eq(Src.SOURCES.collection_products.argOf({ handle: "h", id: "gid://c/1" }), "h");
  eq(Src.SOURCES.collection_products.argOf({ id: "gid://c/1" }), undefined);
});

// ---- P5-BLOCKS (COM-02, TREE-01) ----------------------------------------------------
const KINDS_NOW = ["hero", "collections", "new", "banner", "rich_text", "image_with_text", "product_rail", "text", "faq", "bundle_card", "bundle_grid", "product_main"];

await t("P5-BLOCKS: the registry's section kinds, exactly; bundle_card and bundle_grid are home-only registry kinds with their bindings, and never legacy kinds", async () => {
  same(Reg.sectionKinds(), KINDS_NOW, "kinds:");
  same(Reg.sectionType("bundle_card").bindings, { bundle: { sources: ["bundle_by_id"], args: ["bundle"] } }, "card binding:");
  same(Reg.sectionType("bundle_grid").bindings, { bundles: { sources: ["bundles_by_ids"], args: ["bundles"] } }, "grid binding:");
  for (const k of ["bundle_card", "bundle_grid"]) {
    same(Reg.sectionType(k).documentTypes, ["home"], `${k} types:`);
    ok(Reg.sectionType(k).startsIncomplete && Reg.sectionType(k).placeholder, `${k} starts incomplete, with a placeholder`);
    ok(!HOME_SECTION_KINDS.includes(k) && !PAGE_SECTION_KINDS.includes(k), `${k} in a legacy family`);
    eq(componentFor(k) ?? null, null, `${k} legacy componentFor:`);
  }
  for (const f of ["lib/cms/registry.js", "lib/content/documents-reader.js"]) ok(!/bundle_card|bundle_grid/.test(await readFile(join(here, "..", f), "utf8")), `${f} names a bundle kind`);
});

await t("P5-BLOCKS (P5-SOURCES review): the bundle sources read their declared argument ('bundle', 'bundles'), whatever the key order; a binding that does not pass it is refused", async () => {
  same(Src.SOURCES.bundle_by_id.args, ["bundle"], "card source args:");
  same(Src.SOURCES.bundles_by_ids.args, ["bundles"], "grid source args:");
  const byId = new Map([["bun-a", { id: "bun-a", state: "available" }], ["bun-x", { id: "bun-x", state: "available" }]]);
  const ctx = { prefetched: () => Promise.resolve(byId) };
  // another argument first: the old "first argument other than limit" read bun-x
  eq((await Src.SOURCES.bundle_by_id.resolve({}, { other: "bun-x", bundle: "bun-a", limit: 8 }, ctx))?.id, "bun-a", "card reads 'bundle':");
  same((await Src.SOURCES.bundles_by_ids.resolve({}, { other: ["bun-x"], bundles: ["bun-a", "bun-z"], limit: 8 }, ctx)).map((b) => [b.id, b.state]), [["bun-a", "available"], ["bun-z", "missing"]], "grid reads 'bundles':");
  eq(await Src.SOURCES.bundle_by_id.resolve({}, { other: "bun-x", limit: 8 }, ctx), undefined, "no 'bundle' argument: nothing");
  const asked = [];
  await Src.SOURCES.bundle_by_id.prefetch([{ other: "bun-x", bundle: "bun-a", limit: 8 }, { zz: ["bun-y"], bundles: ["bun-b", "bun-a"], limit: 8 }], { bundlesByIds: async (ids) => (asked.push(ids), new Map()) });
  same(asked, [["bun-a", "bun-b"]], "the prefetch reads only the declared names:");
  let msg = "";
  try {
    Reg.defineSection({ kind: "p5_wrong_arg", documentTypes: ["home"], settings: [{ key: "pick", kind: "bundle", label: "Bundle", default: null }], bindings: { bundle: { sources: ["bundle_by_id"], args: ["pick"] } } });
  } catch (e) {
    msg = e.message;
  }
  eq(Reg.sectionType("p5_wrong_arg"), null, "registered anyway:");
  ok(msg.includes('the source "bundle_by_id" reads "bundle"'), `refused with: ${msg}`);
});

await t("P5-BLOCKS (P5-SOURCES review): a binding that gives both source and sources is refused; either one alone still works", () => {
  let msg = "";
  try {
    Reg.defineSection({ kind: "p5_both", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { products: { source: "newest_products", sources: ["newest_products"], args: ["limit"] } } });
  } catch (e) {
    msg = e.message;
  }
  eq(Reg.sectionType("p5_both"), null, "registered anyway:");
  ok(/gives both source and sources/.test(msg), `refused with: ${msg}`);
  for (const b of [{ source: "newest_products", args: ["limit"] }, { sources: ["newest_products"], args: ["limit"] }]) {
    const d = Reg.defineSection({ kind: "p5_one", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { products: b } });
    try {
      same(d.bindings.products, { sources: ["newest_products"], args: ["limit"] }, JSON.stringify(b));
    } finally {
      Reg.removeSection("p5_one");
    }
  }
});

await t("P5-SOURCES: route_product resolves to no data and no log", async () => {
  Reg.defineSection({ kind: "p5_route", documentTypes: ["home"], settings: [], bindings: { product: { sources: ["route_product"], args: [] } } });
  try {
    const { result: data, lines } = await logsOf(() => resolveHomeSectionData([regSec("p5_route", "sec_rp1", {})], { repo: {} }));
    same(data.get("sec_rp1"), {}, "no data:");
    eq(data.get("sec_rp1").bindingFailedCause, undefined, "no cause");
    eq(lines.length, 0, `no log: ${JSON.stringify(lines)}`);
  } finally {
    Reg.removeSection("p5_route");
  }
});

await t("P5-SOURCES: the existing body-binding case (source 'every_product') is BINDING_INVALID with the new words and blocks publish; a declared source removed from the table is too", async () => {
  const body = { ...Reg.emptyBody("home"), sections: [{ ...Reg.newSection("collections", { id: "sec_c1" }), bindings: { collections: { source: "every_product" } } }] };
  const issue = Reg.validateDocument(body, { mode: "draft" }).issues.find((i) => i.code === "BINDING_INVALID");
  ok(issue, "reported");
  eq(issue.message, "This collections grid section is set up in a way the editor can't fix. Remove it and add it again.", "words:");
  eq(issue.field, "bindings.collections");
  const { __publishInternals } = await import("../lib/documents/publish.js");
  ok(__publishInternals.STRUCTURE_CODES.has("BINDING_INVALID"), "in publish.js STRUCTURE_CODES");
  ok(__publishInternals.alwaysBlocks(issue), "and so it always blocks publish");
  // a declared source that has left the table
  Src.defineSource({ name: "p5_body_src", args: [], resolve: () => undefined });
  Reg.defineSection({ kind: "p5_body_kind", label: "Body kind", documentTypes: ["home"], settings: [], bindings: { things: { sources: ["p5_body_src"], args: [] } } });
  try {
    const b2 = { ...Reg.emptyBody("home"), sections: [{ id: "sec_bk1", kind: "p5_body_kind", v: 1, enabled: true, settings: {}, bindings: { things: { source: "p5_body_src" } } }] };
    eq(Reg.validateDocument(b2, { mode: "draft" }).issues.filter((i) => i.code === "BINDING_INVALID").length, 0, "fine while in the table");
    Src.removeSource("p5_body_src");
    eq(Reg.validateDocument(b2, { mode: "draft" }).issues.filter((i) => i.code === "BINDING_INVALID").length, 1, "BINDING_INVALID once removed");
  } finally {
    Reg.removeSection("p5_body_kind");
    Src.removeSource("p5_body_src");
  }
});

await t("P5-SOURCES: lib/registry/sources.js imports only pure lib/registry modules (no db, repo, catalog, commerce, offers, cms, next, node:)", async () => {
  const src = await readFile(join(here, "../lib/registry/sources.js"), "utf8");
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] || m[2] || m[3]);
  for (const s of specs) {
    ok(/^\.\/[\w-]+\.js$/.test(s), `only ./<file>.js inside lib/registry: ${s}`);
    ok(!/node:|next\/|\/db|\/repo|\/catalog|\/commerce|\/offers|\/cms/.test(s), `forbidden import: ${s}`);
  }
  ok(!/\bnode:|from\s+["'](?:fs|path|crypto)["']/.test(src), "no node built-ins");
  ok(!/process\.env/.test(src), "no environment reads");
});

await t("P5-SOURCES: no section setting value (registry defaults, empty() checks, starter sections, worst-case settings) holds a price or stock key", async () => {
  const BANNED = new Set(["price", "compare_at_price", "bundle_price", "inventory", "total_inventory", "available", "sold_out", "soldOut"]);
  const found = [];
  const scan = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (BANNED.has(k)) found.push(`${path}.${k}`);
      scan(x, `${path}.${k}`);
    }
  };
  const { starterSection } = await import("../lib/registry/starter.js");
  const { worstCase } = await import("../lib/registry/fixtures.js");
  for (const kind of Reg.sectionKinds()) {
    const d = Reg.sectionType(kind);
    for (const s of d.settings) scan(s.default, `${kind}.${s.key}.default`);
    scan(starterSection(kind, { id: "sec_scan1" }), `starter(${kind})`);
    scan(starterSection(kind, { id: "sec_scan2", collections: [{ handle: "serums", id: "gid://c/1", available_count: 5 }] }), `starter(${kind}, collections)`);
    for (const c of worstCase(kind).cases) scan(c.section.settings, `worstCase(${kind}).${c.name}.settings`);
  }
  for (const type of Reg.documentTypeNames()) {
    const t0 = Reg.documentType(type);
    for (const s of t0.settings) scan(s.default, `${type}.${s.key}.default`);
    scan(Reg.emptyBody(type), `emptyBody(${type})`);
  }
  // the empty() check of each setting kind: what it looks for is never a price or stock key
  for (const [kind, k] of Object.entries(Reg.SETTING_KINDS)) {
    const text = String(k.empty);
    for (const key of BANNED) if (new RegExp(`\\.${key}\\b|\\["${key}"\\]`).test(text)) found.push(`SETTING_KINDS.${kind}.empty reads .${key}`);
  }
  same(found, [], "price or stock keys:");
  // the scan does see such a key (the worst-case render DATA carries soldOut on purpose)
  const before = found.length;
  scan(worstCase("new").cases[0].data, "data");
  ok(found.length > before, "the scan finds soldOut in render data");
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of [".test-sections.db"]) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
