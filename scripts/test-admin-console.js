// Session 22 — merchant console + platform operator tests: settings
// validation/patch building (shipping rules included), secret hygiene of the
// settings view, control-plane patch roundtrip, order list queries, operator
// auth, and the password-rotation token helper. Throwaway file DBs.
//   node scripts/test-admin-console.js      (pnpm test:admin-console)
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-console-default.db";
process.env.PLATFORM_DB_URL = "file:.test-console-platform.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_ADMIN_PASSWORD = "operator-secret-pw";

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-console-default.db", ".test-console-platform.db", ".test-console-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { db, libsql } = await import("../lib/db.js");
const { withTenant } = await import("../lib/tenant-context.js");
const C = await import("../lib/platform/control.js");
const { settingsView, buildSettingsPatch, validateShippingConfig } = await import("../lib/admin/settings.js");
const { listOrders, orderStatusCounts } = await import("../lib/admin/orders.js");
const { computeShipping } = await import("../lib/shipping.js");
const P = await import("../lib/platform/admin-auth.js");
const { adminSessionToken, adminSessionTokenFor } = await import("../lib/admin-auth.js");

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const platformSchema = await readFile(join(here, "../lib/platform/schema.sql"), "utf8");
await C.migratePlatform(platformSchema);
await libsql.executeMultiple(schema);

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

// --- shipping validation --------------------------------------------------------
await t("validateShippingConfig: coerces strings, keeps nullables, zones work end-to-end", async () => {
  const res = validateShippingConfig({
    basis: "net",
    flatRate: "79",
    freeThreshold: "999",
    codFee: "49",
    codFeeWaivedAt: "",
    zones: [{ label: "North East", prefixes: "79, 78", flatRate: "149", freeThreshold: "1999" }],
  });
  ok(res.ok, `expected ok, errors: ${res.errors.join("; ")}`);
  eq(res.value.flatRate, 79, "flatRate coerced");
  eq(res.value.codFeeWaivedAt, null, "blank → null");
  eq(res.value.zones[0].prefixes.join(","), "79,78", "prefixes split + trimmed");
  const zoned = computeShipping({ subtotal: 1500, pincode: "790001", config: res.value });
  eq(zoned.total, 149, "zone rate applies under zone threshold");
  const normal = computeShipping({ subtotal: 1500, pincode: "110001", config: res.value });
  eq(normal.total, 0, "non-zone free over 999");
});

await t("validateShippingConfig: rejects bad basis, negative rate, junk zone prefixes", async () => {
  ok(!validateShippingConfig({ basis: "weird", flatRate: 10, codFee: 0 }).ok, "bad basis");
  ok(!validateShippingConfig({ flatRate: -5, codFee: 0 }).ok, "negative rate");
  ok(!validateShippingConfig({ flatRate: 10, codFee: 0, zones: [{ prefixes: "ab" }] }).ok, "alpha prefix");
  ok(!validateShippingConfig({ flatRate: 10, codFee: 0, zones: [{ prefixes: "" }] }).ok, "empty prefix");
});

// --- settings patch building -----------------------------------------------------
await t("buildSettingsPatch: identity merges over current site, validates email/url/name", async () => {
  const current = { site: { name: "Old", support_email: "old@x.in", logo: "keep-me.png" } };
  const good = buildSettingsPatch({ identity: { name: "New Store", support_email: "care@new.in", support_phone: "+91-1", site_url: "https://new.in/" } }, current);
  ok(good.ok, good.errors.join("; "));
  eq(good.patch.config.site.name, "New Store");
  eq(good.patch.config.site.logo, "keep-me.png", "unknown site keys preserved");
  eq(good.patch.config.site_url, "https://new.in", "trailing slash stripped");
  ok(!buildSettingsPatch({ identity: { name: "X", support_email: "not-an-email" } }, {}).ok, "bad email rejected");
  ok(!buildSettingsPatch({ identity: { name: "" } }, {}).ok, "empty name rejected");
  ok(!buildSettingsPatch({ identity: { name: "X", site_url: "ftp://x" } }, {}).ok, "non-http url rejected");
});

await t("buildSettingsPatch: secrets are write-only (blank = keep), password min length", async () => {
  const p = buildSettingsPatch(
    { payments: { razorpay_key_id: "rzp_test_abc", razorpay_key_secret: "", razorpay_webhook_secret: "whs" }, tracking: { ga4_measurement_id: "G-ABC1234", ga4_api_secret: "s3cr3t", meta_pixel_id: "1234567890", meta_capi_token: "" } },
    {},
  );
  ok(p.ok, p.errors.join("; "));
  ok(!("razorpay_key_secret" in p.patch.secrets), "blank secret not written");
  eq(p.patch.secrets.razorpay_webhook_secret, "whs", "provided secret written");
  eq(p.patch.secrets.ga4_api_secret, "s3cr3t");
  ok(!("meta_capi_token" in p.patch.secrets), "blank capi token skipped");
  ok(!buildSettingsPatch({ payments: { razorpay_key_id: "pk_nope" } }, {}).ok, "non-rzp key id rejected");
  ok(!buildSettingsPatch({ tracking: { ga4_measurement_id: "UA-1" } }, {}).ok, "UA- id rejected");
  ok(!buildSettingsPatch({ tracking: { meta_pixel_id: "pix" } }, {}).ok, "non-numeric pixel rejected");
  ok(!buildSettingsPatch({ admin_password: "short" }, {}).ok, "short password rejected");
  eq(buildSettingsPatch({ admin_password: "long-enough-pw" }, {}).patch.secrets.admin_password, "long-enough-pw");
  const empty = buildSettingsPatch({}, {});
  ok(empty.ok && Object.keys(empty.patch.config).length === 0 && Object.keys(empty.patch.secrets).length === 0, "empty input → empty patch");
});

await t("settingsView: presence flags only — serialized view NEVER contains secret values", async () => {
  const tenant = {
    id: "t1",
    domains: ["t1.example"],
    config: { site: { name: "T1" }, razorpay_key_id: "rzp_test_abc", shipping_config: { flatRate: 50 } },
    secrets: { razorpay_key_secret: "SUPER-SECRET-VALUE", ga4_api_secret: "ANOTHER-SECRET", shopify_admin_token: "shpat_HIDDEN", admin_password: "pw-HIDDEN" },
  };
  const view = settingsView(tenant, { counts: { products: 3, collections: 1, lastSyncedAt: null } });
  const json = JSON.stringify(view);
  for (const leak of ["SUPER-SECRET-VALUE", "ANOTHER-SECRET", "shpat_HIDDEN", "pw-HIDDEN"]) {
    ok(!json.includes(leak), `leaked ${leak}`);
  }
  eq(view.payments.has_key_secret, true);
  eq(view.payments.has_webhook_secret, false);
  eq(view.shopify.connected, true);
  eq(view.shipping.flatRate, 50, "tenant shipping overrides default");
  eq(view.shipping.codFee, 49, "defaults fill the rest");
  eq(view.readOnly, false);
  eq(settingsView(null).readOnly, true, "null tenant → read-only");
});

// --- control-plane roundtrip -----------------------------------------------------
await t("settings patch → patchTenant persists config AND keeps untouched secrets", async () => {
  await C.upsertTenant({
    id: "t1",
    name: "T1",
    domains: ["t1.example"],
    dbUrl: "file:.test-console-t1.db",
    config: { site: { name: "T1" }, shopify_store_domain: "t1.myshopify.com" },
    secrets: { shopify_admin_token: "shpat_keep", admin_password: "old-password" },
  });
  const { patch } = buildSettingsPatch(
    { identity: { name: "T1 Renamed", support_email: "care@t1.in" }, shipping: { flatRate: 99, codFee: 0, freeThreshold: "" }, admin_password: "new-password-9" },
    (await C.getTenant("t1")).config,
  );
  await C.patchTenant("t1", patch);
  C.__resetPlatformClient();
  const t1 = await C.getTenant("t1");
  eq(t1.config.site.name, "T1 Renamed");
  eq(t1.config.shopify_store_domain, "t1.myshopify.com", "untouched config kept");
  eq(t1.config.shipping_config.flatRate, 99);
  eq(t1.config.shipping_config.freeThreshold, null, "blank threshold → null (never free)");
  eq(t1.secrets.shopify_admin_token, "shpat_keep", "untouched secret kept");
  eq(t1.secrets.admin_password, "new-password-9", "password rotated");
});

await t("adminSessionTokenFor matches in-context adminSessionToken (rotation re-issue)", async () => {
  const t1 = await C.getTenant("t1");
  const inCtx = await withTenant(t1, () => adminSessionToken());
  eq(await adminSessionTokenFor("t1", "new-password-9"), inCtx, "explicit == contextual");
  ok((await adminSessionTokenFor("t2", "new-password-9")) !== inCtx, "tenant-bound");
});

// --- orders list -----------------------------------------------------------------
await t("listOrders: status filter, search, keyset pagination, counts", async () => {
  const mk = (i, status, email, created) => ({
    id: `BL-TEST${String(i).padStart(2, "0")}`,
    status,
    payment_method: i % 2 ? "cod" : "razorpay",
    total: 100 + i,
    currency: "INR",
    email,
    phone: `99999${i}`,
    name: `Cust ${i}`,
    created_at: created,
    updated_at: created,
  });
  const rows = [
    mk(1, "paid", "a@x.in", "2026-10-01T10:00:00Z"),
    mk(2, "synced", "b@x.in", "2026-10-02T10:00:00Z"),
    mk(3, "sync_failed", "findme@zz.in", "2026-10-03T10:00:00Z"),
    mk(4, "paid", "c@x.in", "2026-10-04T10:00:00Z"),
    mk(5, "cancelled", "d@x.in", "2026-10-05T10:00:00Z"),
  ];
  for (const r of rows) await db.insertInto("orders").values(r).execute();

  const all = await listOrders({});
  eq(all.orders.length, 5, "all rows");
  eq(all.orders[0].id, "BL-TEST05", "desc order");

  const paid = await listOrders({ status: "paid" });
  eq(paid.orders.map((o) => o.id).join(","), "BL-TEST04,BL-TEST01", "status filter");

  const found = await listOrders({ q: "findme" });
  eq(found.orders.length, 1, "email search");
  eq(found.orders[0].id, "BL-TEST03");
  eq((await listOrders({ q: "BL-TEST02" })).orders.length, 1, "id search");

  const page1 = await listOrders({ limit: 2 });
  eq(page1.orders.length, 2, "page size");
  ok(page1.nextBefore, "cursor present");
  const page2 = await listOrders({ limit: 2, before: page1.nextBefore });
  eq(page2.orders[0].id, "BL-TEST03", "keyset continues");

  const bogus = await listOrders({ status: "drop table" });
  eq(bogus.orders.length, 5, "unknown status ignored (whitelist)");

  const counts = await orderStatusCounts();
  eq(counts.paid, 2);
  eq(counts.all, 5);
});

// --- operator auth ---------------------------------------------------------------
await t("platform operator auth: configured check, token verify, wrong password", async () => {
  ok(P.platformAdminConfigured(), "configured via env");
  ok(await P.checkPlatformPassword("operator-secret-pw"), "right password");
  ok(!(await P.checkPlatformPassword("nope")), "wrong password");
  ok(!(await P.checkPlatformPassword(null)), "null password");
  const token = await P.platformSessionToken();
  ok(await P.verifyPlatformToken(token), "token verifies");
  ok(!(await P.verifyPlatformToken(token + "x")), "tampered token rejected");
  ok(!token.includes("operator-secret-pw"), "token never embeds the password");
  const was = process.env.PLATFORM_ADMIN_PASSWORD;
  process.env.PLATFORM_ADMIN_PASSWORD = "";
  ok(!P.platformAdminConfigured(), "unset → unconfigured");
  ok(!(await P.verifyPlatformToken(token)), "unconfigured verifies nothing");
  process.env.PLATFORM_ADMIN_PASSWORD = was;
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
