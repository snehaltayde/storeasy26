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

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of [".test-sections.db"]) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
