// Resource-reference read model suite (S53 / B1): the handler behind
// GET /api/admin/refs, against real file DBs — pagination past the old
// 30-product cap, a 60-variant product, LIKE search incl. SKU, selected-ID
// hydration with explicit missing markers, tenant isolation, authorization.
//   pnpm test:refs
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-refs-default.db";
process.env.PLATFORM_DB_URL = "file:.test-refs-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-refs-default.db", ".test-refs-platform.db", ".test-refs-t1.db", ".test-refs-t2.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { handleRefsGet } = await import("../lib/admin/refs.js");

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
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- fixtures ----------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const [id, file] of [["rf1", ".test-refs-t1.db"], ["rf2", ".test-refs-t2.db"]]) {
  const tdb = createClient({ url: `file:${file}` });
  await tdb.executeMultiple(schema);
  await C.upsertTenant({ id, name: id, domains: [], dbUrl: `file:${file}`, config: {}, secrets: {} });
}
const T1 = await C.getTenant("rf1");
const T2 = await C.getTenant("rf2");

// 60 products + 3 collections in T1; product P001 carries 60 variants
const t1db = createClient({ url: "file:.test-refs-t1.db" });
for (let i = 1; i <= 60; i++) {
  const n = String(i).padStart(3, "0");
  await t1db.execute({
    sql: "INSERT INTO products (id, handle, title, available, currency, price_min, featured_image, synced_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [`gid://p/${n}`, `prod-${n}`, `Product ${n}`, i % 7 === 0 ? 0 : 1, "INR", 100 + i, `https://img/${n}.jpg`, "2026-10-29T00:00:00Z"],
  });
}
for (let v = 1; v <= 60; v++) {
  await t1db.execute({
    sql: "INSERT INTO variants (id, product_id, title, sku, price, currency, available, selected_options, position) VALUES (?,?,?,?,?,?,?,?,?)",
    args: [`gid://v/001-${v}`, "gid://p/001", `Size ${v}`, `SKU-ALPHA-${v}`, 100 + v, "INR", 1, JSON.stringify([{ name: "Size", value: String(v) }]), v],
  });
}
await t1db.execute({ sql: "INSERT INTO collections (id, handle, title, image) VALUES (?,?,?,?)", args: ["gid://c/1", "serums", "Serums", null] });
await t1db.execute({ sql: "INSERT INTO collections (id, handle, title, image) VALUES (?,?,?,?)", args: ["gid://c/2", "masks", "Masks", null] });
for (const p of ["gid://p/001", "gid://p/002", "gid://p/003"]) {
  await t1db.execute({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?,?,0)", args: ["gid://c/1", p] });
}
// T2: one product with an OVERLAPPING handle (isolation probe)
const t2db = createClient({ url: "file:.test-refs-t2.db" });
await t2db.execute({
  sql: "INSERT INTO products (id, handle, title, available, currency, price_min) VALUES (?,?,?,?,?,?)",
  args: ["gid://p/zz", "prod-001", "Other tenant product", 1, "INR", 10],
});

const staffU = await I.createUser({ email: "staff@rf.test", password: "staff-pass-53" });
await I.addMembership(staffU.id, "rf1", "staff");
const staffTok = (await S.createSession({ userId: staffU.id, kind: "merchant", ttlMs: 60_000 })).token;

const req = (cookie, qs) => ({
  url: `http://rf1.test/api/admin/refs?${qs}`,
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: "rf1.test" })[k.toLowerCase()] ?? null },
});
const get = (qs) => withTenant(T1, () => handleRefsGet(req(staffTok, qs)));

// --- tests -------------------------------------------------------------------
await t("auth: no cookie → 401; signed-in staff reads fine", async () => {
  const anon = await withTenant(T1, () => handleRefsGet(req(null, "type=product")));
  eq(anon.status, 401);
  const okRes = await get("type=product");
  eq(okRes.status, 200);
});

await t("pagination reaches item 60 (past the old 30 cap), stable order, no dupes", async () => {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await get(`type=product&limit=25${cursor ? `&cursor=${cursor}` : ""}`);
    eq(r.status, 200, "page");
    seen.push(...r.body.items.map((i) => i.id));
    cursor = r.body.nextCursor;
    pages++;
    if (pages > 10) throw new Error("cursor loop");
  } while (cursor);
  eq(seen.length, 60, "all reachable");
  eq(new Set(seen).size, 60, "no duplicates");
});

await t("search matches title, handle and variant SKU", async () => {
  const byTitle = await get(`type=product&q=${encodeURIComponent("Product 042")}`);
  eq(byTitle.body.items.length, 1, "title");
  const byHandle = await get("type=product&q=prod-013");
  eq(byHandle.body.items.length, 1, "handle");
  const bySku = await get("type=product&q=SKU-ALPHA-37");
  eq(bySku.body.items.length, 1, "sku");
  eq(bySku.body.items[0].id, "gid://p/001", "sku resolves to the parent product");
  const none = await get("type=product&q=zzzz-nope");
  eq(none.body.items.length, 0, "no matches");
});

await t("hydration returns selected ids in order, with explicit missing markers", async () => {
  const r = await get(`type=product&ids=${encodeURIComponent("gid://p/050,gid://p/gone,gid://p/002")}`);
  eq(r.status, 200);
  eq(r.body.items.length, 3);
  eq(r.body.items[0].id, "gid://p/050", "order kept");
  eq(r.body.items[1].missing, true, "missing marked, not dropped");
  eq(r.body.items[2].id, "gid://p/002");
  ok(r.body.syncedAt, "freshness included");
});

await t("variants: all 60 of a product are listed, in position order, with options + sku", async () => {
  const r = await get(`type=variant&product=${encodeURIComponent("gid://p/001")}`);
  eq(r.status, 200);
  eq(r.body.items.length, 60, "no 50-variant cap");
  eq(r.body.items[0].sku, "SKU-ALPHA-1", "position order");
  eq(r.body.items[59].options[0].value, "60", "options parsed");
});

await t("collections list carries product counts; member filter narrows products", async () => {
  const r = await get("type=collection");
  eq(r.status, 200);
  const serums = r.body.items.find((c) => c.handle === "serums");
  eq(serums.product_count, 3, "count");
  const members = await get(`type=product&collection=${encodeURIComponent("gid://c/1")}`);
  eq(members.body.items.length, 3, "member filter");
});

await t("tenant isolation: T2 sees only its own catalog despite the overlapping handle", async () => {
  const r = await withTenant(T2, () =>
    handleRefsGet({
      url: "http://rf2.test/api/admin/refs?type=product&q=prod-001",
      cookies: { get: () => undefined },
      headers: { get: (k) => ({ host: "rf2.test" })[k.toLowerCase()] ?? null },
    }),
  );
  eq(r.status, 401, "no cross-tenant session"); // rf1 staff has no rf2 membership; anonymous denied
  // and with a bootstrap-style read on T2's own context, the data is T2's:
  await C.patchTenant("rf2", { secrets: { admin_password: "rf2-boot" } });
  const T2b = await C.getTenant("rf2");
  const { adminSessionToken } = await import("../lib/admin-auth.js");
  const boot = await withTenant(T2b, () => adminSessionToken());
  const r2 = await withTenant(T2b, () =>
    handleRefsGet({
      url: "http://rf2.test/api/admin/refs?type=product&q=prod-001",
      cookies: { get: (name) => (name === "_admin" ? { value: boot } : undefined) },
      headers: { get: (k) => ({ host: "rf2.test" })[k.toLowerCase()] ?? null },
    }),
  );
  eq(r2.status, 200);
  eq(r2.body.items.length, 1);
  eq(r2.body.items[0].id, "gid://p/zz", "T2's own product, never T1's");
});

await t("bad inputs: unknown type, bad cursor, variant without product → 400", async () => {
  eq((await get("type=nope")).status, 400);
  eq((await get("type=product&cursor=%%%%")).status, 400);
  eq((await get("type=variant")).status, 400);
});

// --- P4-SEARCH (OVL-05, OVL-06): the published name ----------------------------
// rf3: a store with the live table (every tenant migration), 61 products, a
// third of them renamed by a published live row (some to the same name, some
// to names that sort before or after Shopify's), one with a draft-only name.
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const t3file = ".test-refs-t3.db";
dbs.push(t3file);
await rm(join(here, "..", t3file), { force: true });
const t3db = createClient({ url: `file:${t3file}` });
await runMigrations(t3db, await loadMigrations("tenant"));
await t3db.executeMultiple(schema);
await C.upsertTenant({ id: "rf3", name: "rf3", domains: [], dbUrl: `file:${t3file}`, config: {}, secrets: {} });
const T3 = await C.getTenant("rf3");
await I.addMembership(staffU.id, "rf3", "staff");
const shopifyName = (i) => `Item ${String(i).padStart(3, "0")}`;
const liveName = (i) => (i % 9 === 0 ? "Same Name" : i % 3 === 0 ? `Aaa renamed ${String(i).padStart(3, "0")}` : i % 3 === 1 && i % 6 === 1 ? null : i % 5 === 0 ? `Zzz renamed ${String(i).padStart(3, "0")}` : null);
for (let i = 1; i <= 61; i++) {
  const n = String(i).padStart(3, "0");
  await t3db.execute({ sql: "INSERT INTO products (id, handle, title, available, currency, price_min, featured_image, synced_at) VALUES (?,?,?,?,?,?,?,?)", args: [`gid://p3/${n}`, `item-${n}`, shopifyName(i), 1, "INR", 10 + i, `https://img/${n}.jpg`, "2026-10-29T00:00:00Z"] });
  if (liveName(i)) await t3db.execute({ sql: "INSERT INTO product_content_live (product_id, document_id, version_id, title, published_at) VALUES (?, ?, ?, ?, ?)", args: [`gid://p3/${n}`, `doc_prod_${n}`, `ver_${n}`, liveName(i), "2026-11-01T00:00:00Z"] });
}
// a draft-only name: a document whose draft names product 2 "Secret draft name"
await t3db.execute({
  sql: "INSERT INTO documents (id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_prod_draft', 'product_content', NULL, 'gid://p3/002', 'Item 002', ?, 'h', 1, 1, '2026-11-01', '2026-11-01')",
  args: [JSON.stringify({ schema: 1, type: "product_content", settings: { title: { value: "Secret draft name", base_hash: "x", base_value: "Item 002" } }, sections: [] })],
});
const get3 = (qs) => withTenant(T3, () => handleRefsGet(req(staffTok, qs)));
const effective3 = (i) => liveName(i) || shopifyName(i);

await t("P4-SEARCH: the product picker finds a renamed product by its published name, shows Shopify's name as secondary text, and never a draft name", async () => {
  const r = await get3(`type=product&q=${encodeURIComponent("Aaa renamed 012")}`);
  eq(r.status, 200);
  eq(r.body.items.length, 1, "found by the new name");
  eq(r.body.items[0].title, "Aaa renamed 012", "the published name");
  eq(r.body.items[0].shopify_title, "Item 012", "Shopify's name beside it");
  const byOld = await get3(`type=product&q=${encodeURIComponent("Item 012")}`);
  eq(byOld.body.items[0]?.title, "Aaa renamed 012", "Shopify's name finds it too, shown by its published name");
  eq((await get3(`type=product&q=${encodeURIComponent("Secret draft")}`)).body.items.length, 0, "a draft name finds nothing");
  const two = (await get3(`type=product&ids=${encodeURIComponent("gid://p3/002,gid://p3/012")}`)).body.items;
  eq(two[0].title, "Item 002", "the draft is never shown");
  eq("shopify_title" in two[0], false, "no secondary name when they agree");
  eq(two[1].shopify_title, "Item 012", "hydrated with Shopify's name");
});

await t("P4-SEARCH: cursor paging over 61 products with mixed overrides has no duplicates or gaps, in the order of the published name (then id)", async () => {
  for (const limit of [7, 25, 50]) {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await get3(`type=product&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
      eq(r.status, 200, "page");
      seen.push(...r.body.items.map((i) => [i.id, i.title]));
      cursor = r.body.nextCursor;
      if (++pages > 20) throw new Error("cursor loop");
    } while (cursor);
    const want = Array.from({ length: 61 }, (_, k) => [`gid://p3/${String(k + 1).padStart(3, "0")}`, effective3(k + 1)]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
    eq(JSON.stringify(seen), JSON.stringify(want), `limit ${limit}: every product once, in order`);
  }
  // paging a search too: "renamed" matches only published names
  const hits = [];
  let cursor = null;
  do {
    const r = await get3(`type=product&limit=4&q=renamed${cursor ? `&cursor=${cursor}` : ""}`);
    hits.push(...r.body.items.map((i) => i.id));
    cursor = r.body.nextCursor;
  } while (cursor);
  const wantHits = Array.from({ length: 61 }, (_, k) => k + 1).filter((i) => /renamed/.test(liveName(i) || ""));
  eq(hits.length, wantHits.length, "every renamed product once");
  eq(new Set(hits).size, hits.length, "no duplicates");
});

await t("P4-SEARCH: a store with no live rows answers exactly as before (no secondary name key)", async () => {
  const r = await get("type=product&limit=3");
  eq(JSON.stringify(Object.keys(r.body.items[0]).sort()), JSON.stringify(["currency", "handle", "id", "price_min", "status", "thumb", "title"]), "keys");
  eq(r.body.items[0].title, "Product 001", "Shopify's name");
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
