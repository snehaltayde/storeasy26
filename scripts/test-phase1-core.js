// Phase 1.2 Architecture Core Modernization suite:
//   1. Cloudflare R2 / S3-compatible media storage adapter + SQLite fallback + Edge safety
//   2. Tenant-scoped tagged storefront cache + after-commit invalidation
//   3. Distributed Upstash Redis REST rate limiter + in-memory fallback
//   4. Atomic batch cart add (`addItems` / `action: "add_many"`)
//   5. CSP + security headers in next.config.mjs
// Run: pnpm test:phase1-core
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-p1-default.db";
process.env.PLATFORM_DB_URL = "file:.test-p1-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-p1-secret";

const dbs = [".test-p1-default.db", ".test-p1-platform.db", ".test-p1-t1.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ? msg + " " : ""}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const MS = await import("../lib/media-storage.js");
const Media = await import("../lib/media.js");
const Cache = await import("../lib/cache.js");
const RL = await import("../lib/rate-limit.js");
const Cart = await import("../lib/cart.js");
const AfterCommit = await import("../lib/documents/after-commit.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({
  id: "p1t1",
  name: "Phase1 Store",
  domains: ["p1t1.test"],
  dbUrl: "file:.test-p1-t1.db",
  config: {},
  secrets: { order_link_secret: "p1-secret" },
});
const T1 = await C.getTenant("p1t1");
await withTenant(T1, async () => {
  await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));
});

console.log("— 1. Cloudflare R2 media storage adapter + fallback + Edge safety");

await t("Edge safety: media-storage, cache, and rate-limit import zero node:* modules", async () => {
  for (const rel of ["lib/media-storage.js", "lib/cache.js", "lib/rate-limit.js"]) {
    const src = await readFile(join(ROOT, rel), "utf8");
    ok(!/from\s+["']node:|import\(["']node:/.test(src), `${rel} must be Edge-safe`);
  }
});

await t("objectKey is tenant-prefixed and r2KeyFromStorageUrl parses both r2:// and public HTTPS URLs", () => {
  const key = MS.objectKey({ tenantId: "brand-a", sha256: "abcdef0123456789", mime: "image/webp" });
  eq(key, "tenants/brand-a/abcdef0123456789.webp");
  eq(MS.r2KeyFromStorageUrl(`r2://${key}`), key);
  eq(MS.r2KeyFromStorageUrl(`https://media.storeasy.app/${key}`, { R2_PUBLIC_URL: "https://media.storeasy.app" }), key);
  eq(MS.isR2Configured({}), false);
  eq(
    MS.isR2Configured({
      R2_BUCKET: "assets",
      R2_ACCOUNT_ID: "acct123",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "sk",
    }),
    true,
  );
});

await t("signS3Request produces deterministic AWS SigV4 Authorization headers", async () => {
  const fixedNow = new Date("2026-11-22T00:00:00.000Z");
  const args = {
    method: "PUT",
    url: "https://acct123.r2.cloudflarestorage.com/assets/tenants/p1t1/abc.png",
    headers: { "content-type": "image/png" },
    payloadHash: await MS.sha256Hex("hello"),
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "SECRET_TEST",
    region: "auto",
    now: fixedNow,
  };
  const h1 = await MS.signS3Request(args);
  const h2 = await MS.signS3Request(args);
  eq(h1.authorization, h2.authorization, "deterministic signature:");
  ok(h1.authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIA_TEST/20261122/auto/s3/aws4_request, SignedHeaders="), h1.authorization);
  ok(/Signature=[0-9a-f]{64}$/.test(h1.authorization), "64-hex signature");
});

await t("uploadToR2, getFromR2, and deleteFromR2 execute signed S3 requests cleanly", async () => {
  const env = {
    R2_BUCKET: "assets",
    R2_ACCOUNT_ID: "acct123",
    R2_ACCESS_KEY_ID: "ak",
    R2_SECRET_ACCESS_KEY: "sk",
    R2_PUBLIC_URL: "https://media.storeasy.app",
  };
  const calls = [];
  const store = new Map();
  const fetchImpl = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers?.authorization || "" });
    if (init.method === "PUT") {
      store.set(url, new Uint8Array(init.body));
      return new Response(null, { status: 200 });
    }
    if (init.method === "GET") {
      const b = store.get(url);
      return b ? new Response(b, { status: 200 }) : new Response("Not found", { status: 404 });
    }
    if (init.method === "DELETE") {
      store.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response("bad", { status: 400 });
  };
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const sha = await MS.sha256Hex(bytes);
  const up = await MS.uploadToR2({ tenantId: "p1t1", sha256: sha, mime: "image/png", bytes, env, fetchImpl });
  eq(up.key, `tenants/p1t1/${sha}.png`);
  eq(up.storageUrl, `https://media.storeasy.app/tenants/p1t1/${sha}.png`);
  ok(calls[0].auth.startsWith("AWS4-HMAC-SHA256 "), "PUT signed");
  const got = await MS.getFromR2({ key: up.key, env, fetchImpl });
  eq([...got], [...bytes], "roundtrip bytes:");
  eq(await MS.deleteFromR2({ key: up.key, env, fetchImpl }), true, "deleted:");
  eq(await MS.getFromR2({ key: up.key, env, fetchImpl }), null, "404 after delete:");
});

await t("saveMedia falls back to SQLite BLOB when R2_* env vars are unset, and reads back cleanly", async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  await withTenant(T1, async () => {
    const saved = await Media.saveMedia({ filename: "logo.png", mime: "image/png", bytes: pngBytes });
    ok(saved.id.startsWith("med_"), "media id");
    const file = await Media.getMediaFile(saved.id);
    eq([...file.data], [...pngBytes], "SQLite BLOB fallback bytes:");
    eq(file.storageUrl, null, "storageUrl null without R2:");
  });
});

console.log("— 2. Tenant-scoped tagged storefront cache");

await t("tenantTag scopes strictly by tenant and cachedTenantRead passes through outside Next runtime", async () => {
  eq(Cache.tenantTag("release", "shop-a"), "tenant:shop-a:release");
  eq(Cache.tenantTag("catalog", "shop-b"), "tenant:shop-b:catalog");
  let runs = 0;
  const val = await withTenant(T1, () =>
    Cache.cachedTenantRead("catalog", ["featured"], async () => {
      runs++;
      return { ok: true, count: 4 };
    }),
  );
  eq(val, { ok: true, count: 4 });
  eq(runs, 1);
});

await t("invalidateTenantCache emits tenant-scoped tags and afterCommit includes cache invalidation", async () => {
  const seen = [];
  Cache.__setCacheTestHooks({ onInvalidate: (tag) => seen.push(tag) });
  try {
    await withTenant(T1, () => Cache.invalidateTenantCache(["release", "settings"]));
    eq(seen, ["tenant:p1t1:release", "tenant:p1t1:settings"]);
    ok(
      AfterCommit.afterCommit.some((fn) => fn.name === "invalidateStorefrontCache"),
      "afterCommit registers invalidateStorefrontCache",
    );
  } finally {
    Cache.__setCacheTestHooks({ onInvalidate: null });
  }
});

console.log("— 3. Distributed Upstash Redis REST rate limiter + fallback");

await t("rateLimitAsync uses Upstash pipeline when configured and enforces 429 over budget", async () => {
  const req = { headers: { get: (k) => (k.toLowerCase() === "x-forwarded-for" ? "203.0.113.10" : null) } };
  const env = { UPSTASH_REDIS_REST_URL: "https://redis.upstash.test", UPSTASH_REDIS_REST_TOKEN: "tok_test" };
  let count = 0;
  const fetchImpl = async (url, init) => {
    ok(url === "https://redis.upstash.test/pipeline", url);
    ok(init.headers.Authorization === "Bearer tok_test", "bearer auth");
    count++;
    return new Response(JSON.stringify([{ result: count }, { result: 1 }, { result: 42000 }]), { status: 200 });
  };
  await withTenant(T1, async () => {
    eq(await RL.rateLimitAsync(req, { name: "p1_dist", limit: 2, fetchImpl, env }), null, "req 1 allowed:");
    eq(await RL.rateLimitAsync(req, { name: "p1_dist", limit: 2, fetchImpl, env }), null, "req 2 allowed:");
    const blocked = await RL.rateLimitAsync(req, { name: "p1_dist", limit: 2, fetchImpl, env });
    ok(blocked instanceof Response && blocked.status === 429, "req 3 returns 429");
    eq(blocked.headers.get("Retry-After"), "42");
  });
});

await t("rateLimitAsync falls back transparently to in-memory limiter if Upstash fails", async () => {
  const req = { headers: { get: (k) => (k.toLowerCase() === "x-forwarded-for" ? "203.0.113.22" : null) } };
  const env = { UPSTASH_REDIS_REST_URL: "https://down.upstash.test", UPSTASH_REDIS_REST_TOKEN: "tok_test" };
  const failingFetch = async () => {
    throw new Error("network down");
  };
  await withTenant(T1, async () => {
    eq(await RL.rateLimitAsync(req, { name: "p1_fb", limit: 1, fetchImpl: failingFetch, env }), null, "req 1 allowed via fallback:");
    const blocked = await RL.rateLimitAsync(req, { name: "p1_fb", limit: 1, fetchImpl: failingFetch, env });
    ok(blocked instanceof Response && blocked.status === 429, "req 2 blocked via in-memory fallback");
  });
});

console.log("— 4. Atomic batch cart add (addItems / action: add_many)");

await withTenant(T1, async () => {
  await db.insertInto("products").values([
    { id: "gid://shopify/Product/1", handle: "whey", title: "Whey", price_min: 1999, price_max: 1999, currency: "INR", available: 1, tags: "[]" },
    { id: "gid://shopify/Product/2", handle: "creatine", title: "Creatine", price_min: 799, price_max: 799, currency: "INR", available: 1, tags: "[]" },
    { id: "gid://shopify/Product/3", handle: "soldout", title: "Sold Out", price_min: 499, price_max: 499, currency: "INR", available: 0, tags: "[]" },
  ]).execute();
  await db.insertInto("variants").values([
    { id: "gid://shopify/ProductVariant/11", product_id: "gid://shopify/Product/1", title: "1kg", price: 1999, currency: "INR", available: 1 },
    { id: "gid://shopify/ProductVariant/22", product_id: "gid://shopify/Product/2", title: "250g", price: 799, currency: "INR", available: 1 },
    { id: "gid://shopify/ProductVariant/33", product_id: "gid://shopify/Product/3", title: "Default", price: 499, currency: "INR", available: 0 },
  ]).execute();
});

await t("addItems adds all bundle components atomically and merges duplicate variants", async () => {
  await withTenant(T1, async () => {
    const cartId = "p1-cart-ok";
    await Cart.createCart(cartId);
    await Cart.addItems(cartId, [
      { variantId: "gid://shopify/ProductVariant/11", quantity: 1 },
      { variantId: "gid://shopify/ProductVariant/22", quantity: 2 },
      { variantId: "gid://shopify/ProductVariant/11", quantity: 1 },
    ]);
    const cart = await Cart.getCart(cartId);
    eq(cart.count, 4, "total qty:");
    const q11 = cart.items.find((i) => i.variantId === "gid://shopify/ProductVariant/11")?.quantity;
    const q22 = cart.items.find((i) => i.variantId === "gid://shopify/ProductVariant/22")?.quantity;
    eq([q11, q22], [2, 2], "merged quantities:");
  });
});

await t("addItems is all-or-nothing: a missing or unavailable variant writes ZERO lines to the cart", async () => {
  await withTenant(T1, async () => {
    const cartId = "p1-cart-fail";
    await Cart.createCart(cartId);
    let err1 = null;
    try {
      await Cart.addItems(cartId, [
        { variantId: "gid://shopify/ProductVariant/11", quantity: 1 },
        { variantId: "gid://shopify/ProductVariant/999", quantity: 1 },
      ]);
    } catch (e) {
      err1 = e;
    }
    ok(err1 && /not in catalog/.test(err1.message), `missing variant refused: ${err1?.message}`);
    eq((await Cart.getCart(cartId)).items.length, 0, "zero partial items written on missing variant:");

    let err2 = null;
    try {
      await Cart.addItems(
        cartId,
        [
          { variantId: "gid://shopify/ProductVariant/11", quantity: 1 },
          { variantId: "gid://shopify/ProductVariant/33", quantity: 1 },
        ],
        { requireAvailable: true },
      );
    } catch (e) {
      err2 = e;
    }
    ok(err2 && /unavailable/.test(err2.message), `unavailable variant refused: ${err2?.message}`);
    eq((await Cart.getCart(cartId)).items.length, 0, "zero partial items written on unavailable variant:");
  });
});

console.log("— 5. Security headers (CSP) in next.config.mjs");

await t("next.config.mjs defines CSP, Referrer-Policy, X-Content-Type-Options, and Permissions-Policy without unsafe-eval", async () => {
  const cfg = (await import("../next.config.mjs")).default;
  const rules = await cfg.headers();
  const allHeaders = rules.flatMap((r) => r.headers || []);
  const byKey = Object.fromEntries(allHeaders.map((h) => [h.key, h.value]));
  ok(byKey["Content-Security-Policy"]?.includes("default-src 'self'"), "CSP default-src");
  ok(byKey["Content-Security-Policy"]?.includes("frame-ancestors 'self'"), "CSP frame-ancestors");
  ok(byKey["Content-Security-Policy"]?.includes("https://checkout.razorpay.com"), "CSP allows Razorpay");
  ok(!byKey["Content-Security-Policy"]?.includes("unsafe-eval"), "CSP forbids unsafe-eval");
  eq(byKey["X-Content-Type-Options"], "nosniff");
  eq(byKey["Referrer-Policy"], "strict-origin-when-cross-origin");
  ok(Boolean(byKey["Permissions-Policy"]), "Permissions-Policy present");
});

for (const f of dbs) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
