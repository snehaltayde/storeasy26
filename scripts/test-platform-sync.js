// Session 21 — onboarding + webhook-driven sync tests: OAuth state + callback
// HMAC, webhook HMAC verify + topic routing, shop-domain tenant fan-out,
// patchTenant merge semantics, single-entity sync with an injected GraphQL
// client, and tenant-DB bootstrap. Fully isolated (throwaway file DBs).
//   node scripts/test-platform-sync.js      (pnpm test:platform-sync)
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-psync-default.db";
process.env.PLATFORM_DB_URL = "file:.test-psync-platform.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-psync-default.db", ".test-psync-platform.db", ".test-psync-t1.db", ".test-psync-prov.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { createClient } = await import("@libsql/client");
const { db, libsql } = await import("../lib/db.js");
const { withTenant } = await import("../lib/tenant-context.js");
const C = await import("../lib/platform/control.js");
const O = await import("../lib/platform/oauth.js");
const W = await import("../lib/platform/shopify-webhooks.js");
const S = await import("../lib/sync.js");
const { applyTenantSchema } = await import("../lib/platform/provision.js");

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

// --- OAuth state --------------------------------------------------------------
await t("oauth state: sign/verify roundtrip, tamper + expiry + garbage rejected", async () => {
  const state = O.signState("demo");
  eq(O.verifyState(state)?.tenantId, "demo", "roundtrip");
  ok(!O.verifyState(state + "x"), "tampered sig rejected");
  const [p] = state.split(".");
  ok(!O.verifyState(`${p}.AAAA`), "wrong sig rejected");
  ok(!O.verifyState(state, Date.now() + 11 * 60 * 1000), "expired rejected");
  ok(!O.verifyState("not-a-state"), "garbage rejected");
  ok(!O.verifyState(null), "null rejected");
});

await t("oauth callback hmac: valid accepted, tampered rejected", async () => {
  const secret = "app-client-secret";
  const params = new URLSearchParams({ code: "abc", shop: "x.myshopify.com", state: "s", timestamp: "123" });
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
  const hmac = crypto.createHmac("sha256", secret).update(message).digest("hex");
  params.set("hmac", hmac);
  ok(O.verifyOAuthCallbackHmac(params.toString(), secret), "valid hmac accepted");
  params.set("code", "EVIL");
  ok(!O.verifyOAuthCallbackHmac(params.toString(), secret), "tampered params rejected");
  ok(!O.verifyOAuthCallbackHmac(params.toString(), "wrong-secret"), "wrong secret rejected");
});

await t("oauth authorize url carries client id, redirect, state and scopes", async () => {
  const url = O.buildAuthorizeUrl({ shopDomain: "x.myshopify.com", clientId: "cid", redirectUri: "https://p.app/cb", state: "st" });
  ok(url.startsWith("https://x.myshopify.com/admin/oauth/authorize?"), "authorize endpoint");
  ok(url.includes("client_id=cid") && url.includes("state=st"), "params present");
  ok(url.includes(encodeURIComponent("https://p.app/cb")), "redirect encoded");
  ok(url.includes(encodeURIComponent("write_draft_orders")), "scopes present");
});

// --- webhook HMAC + gid builders -----------------------------------------------
await t("webhook hmac: base64 raw-body signature verify", async () => {
  const secret = "whsec";
  const raw = JSON.stringify({ id: 42, title: "ZMA" });
  const sig = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  ok(W.verifyWebhookHmac(raw, sig, secret), "valid accepted");
  ok(!W.verifyWebhookHmac(raw + " ", sig, secret), "body tamper rejected");
  ok(!W.verifyWebhookHmac(raw, sig, "other"), "wrong secret rejected");
  ok(!W.verifyWebhookHmac(raw, null, secret), "missing header rejected");
  ok(!W.verifyWebhookHmac(raw, sig, null), "missing secret rejected");
});

await t("gid builders: admin_graphql_api_id preferred, numeric id fallback", async () => {
  eq(W.productGid({ admin_graphql_api_id: "gid://shopify/Product/9" }), "gid://shopify/Product/9");
  eq(W.productGid({ id: 7 }), "gid://shopify/Product/7");
  eq(W.collectionGid({ id: 3 }), "gid://shopify/Collection/3");
});

// --- control plane: fan-out + patch --------------------------------------------
const mkTenant = (id, shop, status = "active", extra = {}) =>
  C.upsertTenant({
    id,
    name: id,
    status,
    domains: [`${id}.example`],
    dbUrl: `file:.test-psync-${id === "alpha" || id === "alpha-staging" ? "t1" : id}.db`,
    config: { shopify_store_domain: shop, ...extra },
    secrets: { shopify_client_secret: `secret-${id}` },
  });

await t("getTenantsByShopDomain: all ACTIVE tenants on the shop, others excluded", async () => {
  await mkTenant("alpha", "shared.myshopify.com");
  await mkTenant("alpha-staging", "SHARED.myshopify.com"); // case-insensitive
  await mkTenant("bravo", "other.myshopify.com");
  await mkTenant("zombie", "shared.myshopify.com", "suspended");
  const hits = await C.getTenantsByShopDomain("shared.myshopify.com");
  eq(hits.map((t) => t.id).sort().join(","), "alpha,alpha-staging", "fan-out set");
  eq((await C.getTenantsByShopDomain("nobody.myshopify.com")).length, 0, "unknown shop");
  eq((await C.getTenantsByShopDomain(null)).length, 0, "null shop");
});

await t("patchTenant merges config/secrets and keeps everything else", async () => {
  await C.patchTenant("alpha", {
    config: { shopify_connected_at: "2026-10-27T00:00:00Z" },
    secrets: { shopify_admin_token: "shpat_new" },
  });
  C.__resetPlatformClient(); // defeat cache — read what was PERSISTED
  const t2 = await C.getTenant("alpha");
  eq(t2.config.shopify_store_domain, "shared.myshopify.com", "existing config kept");
  eq(t2.config.shopify_connected_at, "2026-10-27T00:00:00Z", "new config merged");
  eq(t2.secrets.shopify_client_secret, "secret-alpha", "existing secret kept");
  eq(t2.secrets.shopify_admin_token, "shpat_new", "new secret merged");
  eq(t2.domains[0], "alpha.example", "domains kept");
  let threw = false;
  try {
    await C.patchTenant("missing", { config: {} });
  } catch {
    threw = true;
  }
  ok(threw, "patching unknown tenant throws");
});

// --- single-entity sync with injected gql ---------------------------------------
const T1 = { id: "t1", name: "T1", status: "active", dbUrl: "file:.test-psync-t1.db", dbToken: null, config: {}, secrets: {} };
await withTenant(T1, () => libsql.executeMultiple(schema));

const productNode = (over = {}) => ({
  id: "gid://shopify/Product/1",
  handle: "zma",
  title: "ZMA",
  description: "sleep",
  descriptionHtml: "<p>sleep</p>",
  productType: "Supplement",
  vendor: "BeastLife",
  tags: ["sleep"],
  status: "ACTIVE",
  totalInventory: 5,
  createdAt: "2026-01-01",
  updatedAt: "2026-10-27",
  priceRangeV2: { minVariantPrice: { amount: "444", currencyCode: "INR" }, maxVariantPrice: { amount: "444", currencyCode: "INR" } },
  featuredImage: { url: "https://img/1.jpg", altText: "zma" },
  images: { nodes: [{ url: "https://img/1.jpg", altText: "zma", width: 10, height: 10 }] },
  options: [{ name: "Size", optionValues: [{ name: "60ct" }] }],
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "60ct", sku: "ZMA60", price: "444", compareAtPrice: "599", availableForSale: true, inventoryQuantity: 5, selectedOptions: [{ name: "Size", value: "60ct" }], image: null }] },
  ...over,
});

await t("syncProductByGid: refetch → upsert product + variants + images", async () => {
  const gql = async () => ({ node: productNode() });
  const res = await withTenant(T1, () => S.syncProductByGid("gid://shopify/Product/1", { gql }));
  eq(res.synced, "gid://shopify/Product/1", "synced marker");
  const row = await withTenant(T1, () => db.selectFrom("products").selectAll().where("id", "=", "gid://shopify/Product/1").executeTakeFirst());
  eq(row.handle, "zma", "product written");
  eq(row.price_min, 444, "price");
  eq(row.compare_at_min, 599, "compare-at");
  const variants = await withTenant(T1, () => db.selectFrom("variants").selectAll().where("product_id", "=", "gid://shopify/Product/1").execute());
  eq(variants.length, 1, "variant count");
  eq(variants[0].sku, "ZMA60", "variant sku");
});

await t("syncProductByGid: second call REPLACES variants/images (no dupes)", async () => {
  const gql = async () => ({ node: productNode({ title: "ZMA v2" }) });
  await withTenant(T1, () => S.syncProductByGid("gid://shopify/Product/1", { gql }));
  const row = await withTenant(T1, () => db.selectFrom("products").select("title").where("id", "=", "gid://shopify/Product/1").executeTakeFirst());
  eq(row.title, "ZMA v2", "updated title");
  const imgs = await withTenant(T1, () => db.selectFrom("product_images").selectAll().where("product_id", "=", "gid://shopify/Product/1").execute());
  eq(imgs.length, 1, "images replaced, not appended");
});

await t("syncProductByGid: DRAFT/archived or missing product is DELETED locally", async () => {
  const gql = async () => ({ node: productNode({ status: "DRAFT" }) });
  const res = await withTenant(T1, () => S.syncProductByGid("gid://shopify/Product/1", { gql }));
  eq(res.deleted, "gid://shopify/Product/1", "delete marker");
  const left = await withTenant(T1, () =>
    Promise.all([
      db.selectFrom("products").selectAll().where("id", "=", "gid://shopify/Product/1").execute(),
      db.selectFrom("variants").selectAll().where("product_id", "=", "gid://shopify/Product/1").execute(),
      db.selectFrom("product_images").selectAll().where("product_id", "=", "gid://shopify/Product/1").execute(),
    ]),
  );
  eq(left.flat().length, 0, "product + variants + images gone");
  const gql404 = async () => ({ node: null });
  const res2 = await withTenant(T1, () => S.syncProductByGid("gid://shopify/Product/404", { gql: gql404 }));
  eq(res2.deleted, "gid://shopify/Product/404", "missing → delete path");
});

await t("syncCollectionByGid: writes collection + membership of EXISTING products only", async () => {
  const gqlP = async () => ({ node: productNode() });
  await withTenant(T1, () => S.syncProductByGid("gid://shopify/Product/1", { gql: gqlP }));
  const gqlC = async () => ({
    node: {
      id: "gid://shopify/Collection/5",
      handle: "sleep",
      title: "Sleep",
      description: "",
      updatedAt: "2026-10-27",
      image: null,
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/999" }] },
    },
  });
  const res = await withTenant(T1, () => S.syncCollectionByGid("gid://shopify/Collection/5", { gql: gqlC }));
  eq(res.synced, "gid://shopify/Collection/5", "synced");
  const members = await withTenant(T1, () => db.selectFrom("collection_products").selectAll().where("collection_id", "=", "gid://shopify/Collection/5").execute());
  eq(members.length, 1, "unknown product filtered out");
  eq(members[0].product_id, "gid://shopify/Product/1", "member");
});

await t("applyWebhook routes topics; unknown topics are declared unhandled", async () => {
  const gql = async (q) => (q.includes("Collection") ? { node: null } : { node: null });
  const del = await withTenant(T1, () => W.applyWebhook("collections/delete", { id: 5 }, { gql }));
  eq(del.deleted, "gid://shopify/Collection/5", "collections/delete routed");
  const rows = await withTenant(T1, () => db.selectFrom("collections").selectAll().where("id", "=", "gid://shopify/Collection/5").execute());
  eq(rows.length, 0, "collection removed");
  const un = await withTenant(T1, () => W.applyWebhook("orders/create", {}, { gql }));
  eq(un.unhandled, "orders/create", "unhandled surfaced");
});

// --- provisioning bootstrap -----------------------------------------------------
await t("applyTenantSchema: commerce tables + offers seeded, idempotent", async () => {
  const client = createClient({ url: "file:.test-psync-prov.db" });
  const first = await applyTenantSchema(client);
  ok(first.seededOffers > 0, "offers seeded on fresh DB");
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(tables.rows.map((r) => r.name));
  for (const want of ["products", "variants", "collections", "collection_products", "orders", "offers", "events"]) {
    ok(names.has(want), `table ${want} exists`);
  }
  const again = await applyTenantSchema(client);
  eq(again.seededOffers, 0, "second run seeds nothing (INSERT OR IGNORE)");
  client.close?.();
});

// --- summary --------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
