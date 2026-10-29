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

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
