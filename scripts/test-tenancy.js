// Session 20 — tenancy core tests: context isolation, per-tenant DB routing,
// config/secret resolution with env fallback, control-plane host resolution,
// secret crypto. Fully isolated (throwaway file DBs for two fixture tenants +
// a file control plane).
//   node scripts/test-tenancy.js          (pnpm test:tenancy)
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-tenancy-default.db";
process.env.PLATFORM_DB_URL = "file:.test-tenancy-platform.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-tenancy-default.db", ".test-tenancy-platform.db", ".test-tenancy-t1.db", ".test-tenancy-t2.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { db, libsql } = await import("../lib/db.js");
const { withTenant, currentTenant, tenantCfg, tenantSecret, tenantId } = await import("../lib/tenant-context.js");
const { encryptSecret, decryptSecret, encryptJson, decryptJson } = await import("../lib/platform/crypto.js");
const C = await import("../lib/platform/control.js");

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const platformSchema = await readFile(join(here, "../lib/platform/schema.sql"), "utf8");
await C.migratePlatform(platformSchema);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

// fixture runtime tenants (shape of control.js toRuntime output)
const T1 = { id: "t1", name: "Tenant One", status: "active", dbUrl: "file:.test-tenancy-t1.db", dbToken: null, config: { typesense_collection: "products_t1", site_url: "https://t1.example" }, secrets: { admin_password: "pw-t1" } };
const T2 = { id: "t2", name: "Tenant Two", status: "active", dbUrl: "file:.test-tenancy-t2.db", dbToken: null, config: {}, secrets: {} };

// apply the commerce schema inside each tenant's context (proves libsql proxy
// routes DDL too), and to the default env db
await libsql.executeMultiple(schema);
await withTenant(T1, () => libsql.executeMultiple(schema));
await withTenant(T2, () => libsql.executeMultiple(schema));

// --- crypto -----------------------------------------------------------------
await t("crypto: AES-GCM roundtrip + tamper rejection + null passthrough", async () => {
  const enc = await encryptSecret("shpat_super_secret");
  ok(enc && !enc.includes("shpat"), "ciphertext opaque");
  eq(await decryptSecret(enc), "shpat_super_secret", "roundtrip");
  let threw = false;
  try {
    await decryptSecret(enc.slice(0, -4) + "AAAA");
  } catch {
    threw = true;
  }
  ok(threw, "tampered ciphertext rejected");
  eq(await decryptSecret(null), null, "null safe");
  const j = await encryptJson({ a: 1, b: "two" });
  eq((await decryptJson(j)).b, "two", "json roundtrip");
});

// --- context + db routing ---------------------------------------------------
await t("db proxy routes writes to the ACTIVE tenant's database only", async () => {
  const insert = (id, title) =>
    db.insertInto("products").values({ id, handle: title, title, available: 1 }).execute();
  await withTenant(T1, () => insert("gid://shopify/Product/1", "t1-product"));
  await withTenant(T2, () => insert("gid://shopify/Product/2", "t2-product"));
  await insert("gid://shopify/Product/3", "default-product"); // no context → env db

  const titles = (rows) => rows.map((r) => r.title).join(",");
  const t1Rows = await withTenant(T1, () => db.selectFrom("products").selectAll().execute());
  const t2Rows = await withTenant(T2, () => db.selectFrom("products").selectAll().execute());
  const defRows = await db.selectFrom("products").selectAll().execute();
  eq(titles(t1Rows), "t1-product", "t1 sees only its row");
  eq(titles(t2Rows), "t2-product", "t2 sees only its row");
  eq(titles(defRows), "default-product", "default db isolated too");
});

await t("concurrent interleaved contexts never bleed (ALS across awaits)", async () => {
  const read = async (tenant, expect) => {
    await new Promise((r) => setTimeout(r, Math.random() * 20));
    const rows = await withTenant(tenant, async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      return db.selectFrom("products").select("title").execute();
    });
    eq(rows.map((r) => r.title).join(","), expect, `tenant ${tenant?.id}`);
  };
  await Promise.all([
    read(T1, "t1-product"),
    read(T2, "t2-product"),
    read(T1, "t1-product"),
    read(T2, "t2-product"),
  ]);
});

await t("config/secret accessors: tenant wins, env falls back, default id", async () => {
  process.env.TEST_FALLBACK_VALUE = "from-env";
  eq(tenantCfg("typesense_collection", "TEST_FALLBACK_VALUE"), "from-env", "no context → env");
  await withTenant(T1, async () => {
    eq(tenantCfg("typesense_collection", "TEST_FALLBACK_VALUE"), "products_t1", "tenant config wins");
    eq(tenantCfg("missing_key", "TEST_FALLBACK_VALUE"), "from-env", "missing tenant key → env");
    eq(tenantSecret("admin_password", "ADMIN_PASSWORD"), "pw-t1", "tenant secret wins");
    eq(tenantId(), "t1", "tenant id");
    eq(currentTenant().name, "Tenant One", "currentTenant");
  });
  eq(tenantId(), "_default", "no context id");
  delete process.env.TEST_FALLBACK_VALUE;
});

await t("per-tenant admin sessions cannot cross tenants", async () => {
  const { adminSessionToken, verifyAdminToken } = await import("../lib/admin-auth.js");
  const tok1 = await withTenant(T1, () => adminSessionToken());
  ok(await withTenant(T1, () => verifyAdminToken(tok1)), "valid in its own tenant");
  ok(!(await withTenant(T2, () => verifyAdminToken(tok1))), "rejected by another tenant");
});

// --- control plane ----------------------------------------------------------
await t("control plane: upsert → host resolution → decrypted runtime", async () => {
  await C.upsertTenant({
    id: "acme",
    name: "Acme Fit",
    domains: ["acme.storeasy.app", "shop.acme.in"],
    dbUrl: "file:.test-tenancy-t1.db",
    dbToken: "acme-db-token",
    config: { shopify_store_domain: "acme.myshopify.com" },
    secrets: { razorpay_key_secret: "rzp_secret_acme" },
  });
  const byHost = await C.getTenantByHost("shop.acme.in");
  eq(byHost.id, "acme", "custom domain resolves");
  eq(byHost.dbToken, "acme-db-token", "db token decrypted");
  eq(byHost.secrets.razorpay_key_secret, "rzp_secret_acme", "secrets decrypted");
  eq(byHost.config.shopify_store_domain, "acme.myshopify.com", "config");
  eq(await C.getTenantByHost("unknown.example"), null, "unmapped host → null (env fallback)");
  const raw = await (await import("../lib/platform/control.js")).listTenants();
  ok(raw.some((r) => r.id === "acme"), "listed");
});

await t("suspended tenants stop resolving (after cache TTL)", async () => {
  await C.upsertTenant({ id: "acme", name: "Acme Fit", status: "suspended", domains: ["shop.acme.in"], dbUrl: "file:.test-tenancy-t1.db", config: {}, secrets: {} });
  await new Promise((r) => setTimeout(r, 80)); // > PLATFORM_CACHE_MS
  eq(await C.getTenantByHost("shop.acme.in"), null, "suspended → unresolved");
});

await t("host matching handles ports and case", async () => {
  await C.upsertTenant({ id: "porty", name: "Porty", domains: ["localhost:9999", "porty.example"], dbUrl: "file:.test-tenancy-t2.db", config: {}, secrets: {} });
  await new Promise((r) => setTimeout(r, 80));
  eq((await C.getTenantByHost("LOCALHOST:9999"))?.id, "porty", "port + case");
  eq((await C.getTenantByHost("PORTY.example"))?.id, "porty", "bare domain, case");
  eq((await C.getTenantByHost("porty.example:443"))?.id, "porty", "mapped bare matches with port");
});

// --- end-to-end slice: cart math per tenant via the real libs ---------------
await t("getCart computes per-tenant (offers table isolation)", async () => {
  const { getCart } = await import("../lib/cart.js");
  // seed a product+variant+cart in T1 only
  await withTenant(T1, async () => {
    await db.insertInto("variants").values({ id: "gid://shopify/ProductVariant/11", product_id: "gid://shopify/Product/1", title: "V", price: 500, available: 1, position: 0 }).execute();
    await db.insertInto("carts").values({ id: "cart-t1", created_at: new Date().toISOString() }).execute();
    await db.insertInto("cart_items").values({ cart_id: "cart-t1", variant_id: "gid://shopify/ProductVariant/11", product_id: "gid://shopify/Product/1", quantity: 2, added_at: new Date().toISOString() }).execute();
  });
  const c1 = await withTenant(T1, () => getCart("cart-t1"));
  eq(c1.items.length, 1, "t1 cart has its item");
  eq(c1.subtotal, 1000, "t1 subtotal");
  const c2 = await withTenant(T2, () => getCart("cart-t1"));
  eq(c2.items.length, 0, "same cart id in t2 is EMPTY — full isolation");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
