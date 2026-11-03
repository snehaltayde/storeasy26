// Commerce adapter + offers suite (Session 32 / BE06+BE07+SF06+MC14+MC22):
// checkout capability gate, TZ-safe schedule round-trips, lifecycle status,
// deterministic simulator, cart change acknowledgement, duplicate-mutation
// idempotency, gift eligibility, settings validation.
//   pnpm test:commerce
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-com-default.db";
process.env.PLATFORM_DB_URL = "file:.test-com-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
delete process.env.CHECKOUT_MODE;

const dbs = [".test-com-default.db", ".test-com-platform.db", ".test-com-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const A = await import("../lib/commerce/adapter.js");
const SCH = await import("../lib/admin/schedule.js");
const SIM = await import("../lib/offers/simulate.js");
const SET = await import("../lib/admin/settings.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { createCart, addItem, setItemQty, removeItem, getCart } = await import("../lib/cart.js");
const { upsertOffer, deleteOffer } = await import("../lib/offers/store.js");
const { applyTenantSchema } = await import("../lib/platform/provision.js");
const { readFile } = await import("node:fs/promises");

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

// --- fixtures -------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "cm", name: "Commerce", domains: [], dbUrl: "file:.test-com-t1.db", config: {}, secrets: {} });
await applyTenantSchema(createClient({ url: "file:.test-com-t1.db" }));
const CM = await C.getTenant("cm");
const inT = (fn) => withTenant(CM, fn);

// catalog rows for the cart tests
await inT(async () => {
  await db.insertInto("products").values({ id: "gid://t/P1", handle: "tee", title: "Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("products").values({ id: "gid://t/P2", handle: "cap", title: "Cap", price_min: 1200, price_max: 1200, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "M", price: 500, currency: "INR", available: 1 }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V2", product_id: "gid://t/P2", title: "OS", price: 1200, currency: "INR", available: 1 }).execute();
  await db.insertInto("products").values({ id: "gid://t/PG", handle: "gift", title: "Gift Sticker", price_min: 99, price_max: 99, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("variants").values({ id: "gid://t/VG", product_id: "gid://t/PG", title: "OS", price: 99, currency: "INR", available: 1 }).execute();
  // drop the seeded default offers so engine results are OURS alone
  await db.deleteFrom("offers").execute();
});

// --- BE06: capability gate --------------------------------------------------------
await t("checkoutCapability: default direct; disabled + unknown + reserved modes fail closed", async () => {
  eq(await inT(() => A.checkoutMode()), "direct", "default");
  eq((await inT(() => A.checkoutCapability())).available, true, "available by default");
  const disabled = { ...CM, config: { ...CM.config, checkout_mode: "disabled" } };
  const d = await withTenant(disabled, () => A.checkoutCapability());
  eq(d.available, false, "disabled unavailable");
  ok(d.reason, "has a reason");
  const weird = { ...CM, config: { ...CM.config, checkout_mode: "paypal??" } };
  eq(await withTenant(weird, () => A.checkoutMode()), "disabled", "unknown mode fails closed");
  const shopify = { ...CM, config: { ...CM.config, checkout_mode: "shopify" } };
  const sh = await withTenant(shopify, () => A.checkoutCapability());
  eq(sh.available, false, "reserved shopify mode stays off");
  ok(/not implemented/.test(sh.reason), "honest reason");
});

await t("checkoutCapability: razorpay flag needs the tenant's OWN keys (S24 scoping)", async () => {
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_env";
  process.env.RAZORPAY_KEY_SECRET = "env-secret";
  const bare = await inT(() => A.checkoutCapability());
  eq(bare.razorpay, false, "resolved tenant w/o keys → no env fallback");
  eq(bare.cod, true, "COD always offered in direct mode");
  const keyed = { ...CM, config: { ...CM.config, razorpay_key_id: "rzp_test_own" }, secrets: { razorpay_key_secret: "own" } };
  eq((await withTenant(keyed, () => A.checkoutCapability())).razorpay, true, "own keys → prepaid on");
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
});

// --- BE07/MC14: schedules ----------------------------------------------------------
await t("schedule round-trip preserves the INSTANT (the UTC-drift quirk is dead)", () => {
  const instant = "2026-11-01T18:30:00.000Z";
  const local = SCH.isoToLocalInput(instant);
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local), "datetime-local shape");
  eq(SCH.localInputToIso(local), instant, "roundtrip identity");
  // the OLD buggy path for contrast: slice(0,16) re-parsed as local shifts
  // unless the environment runs UTC
  const buggy = new Date(new Date(instant).toISOString().slice(0, 16)).toISOString();
  if (new Date().getTimezoneOffset() !== 0) ok(buggy !== instant, "old path really did drift here");
  eq(SCH.isoToLocalInput(null), "", "empty in");
  eq(SCH.localInputToIso(""), null, "empty out");
  eq(SCH.localInputToIso("garbage"), null, "garbage out");
});

await t("offerScheduleStatus lifecycle matrix", () => {
  const at = "2026-10-28T12:00:00.000Z";
  eq(SCH.offerScheduleStatus({ enabled: false }, at), "draft", "draft");
  eq(SCH.offerScheduleStatus({ enabled: false, starts_at: "2026-10-01T00:00:00Z" }, at), "paused", "paused");
  eq(SCH.offerScheduleStatus({ enabled: true, starts_at: "2026-11-01T00:00:00Z" }, at), "scheduled", "scheduled");
  eq(SCH.offerScheduleStatus({ enabled: true }, at), "active", "active (no window)");
  eq(SCH.offerScheduleStatus({ enabled: true, starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-10-20T00:00:00Z" }, at), "expired", "expired");
  eq(SCH.offerScheduleStatus({ enabled: false, ends_at: "2026-10-20T00:00:00Z" }, at), "expired", "expired wins over paused");
});

// --- BE07: simulator ----------------------------------------------------------------
const COUPON = { id: "sim-c10", type: "COUPON", scope: "order", priority: 50, title: "SIM10", code: "SIM10", discount: { kind: "percent", value: 10 }, combinable: true };

// COM-03: the example carts come from this store's own catalog (Tee, Cap, Gift
// Sticker above), not fixed sample baskets; scripts/test-offer-form.js covers
// the examples in depth.
await t("simulator: deterministic, explains not-applying, coupon applies with its code", async () => {
  const a = await inT(() => SIM.simulateOffer({ offer: COUPON }));
  const b = await inT(() => SIM.simulateOffer({ offer: COUPON }));
  eq(JSON.stringify(a), JSON.stringify(b), "deterministic");
  eq(a.ok, true, "ok");
  eq(a.applied.alone, true, "coupon auto-simulated with its code");
  eq(a.cart.items.map((i) => i.title).join(), "Gift Sticker — OS", "the store's cheapest product, by its variant");
  eq(a.alone.discountTotal, 10, "10% of the ₹99 cart (engine's own rounding, as test-offers proves)");
  const gift = { id: "sim-gift", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Gift over 5k", threshold: 5000, gift: { variantId: "gid://shopify/ProductVariant/900001", productId: "gid://shopify/Product/900001", handle: "gift", title: "Gift Sticker", value: 99 } };
  const g = await inT(() => SIM.simulateOffer({ offer: gift }));
  eq(g.applied.alone, true, "the example cart crosses the threshold");
  eq(g.alone.gifts.length, 1, "gift present");
  eq(g.nearMiss.appliedAlone, false, "the closest cart under it gets no gift");
  ok(/must be over/.test(g.nearMiss.text), "explains why not");
});

await t("simulator: combination preview vs ACTIVE offers + one-coupon note; invalid offer → errors", async () => {
  await inT(() => upsertOffer({ offer: { ...COUPON, id: "live-c20", code: "LIVE20", title: "LIVE20", discount: { kind: "percent", value: 20 } }, enabled: true }));
  const r = await inT(() => SIM.simulateOffer({ offer: COUPON }));
  eq(r.activeOfferCount, 1, "sees the live offer");
  ok(r.notes.some((n) => /one code per order/.test(n)), "one-coupon-per-cart note");
  const bad = await inT(() => SIM.simulateOffer({ offer: { id: "x", type: "COUPON" } }));
  eq(bad.ok, false, "invalid offer refused");
  ok(bad.errors.length > 0, "named errors");
  await inT(() => deleteOffer("live-c20"));
});

// --- SF06: cart behavior ---------------------------------------------------------------
await t("cart: price change is ACKNOWLEDGED (notice) while totals use the current price", async () => {
  await inT(async () => {
    await createCart("c1");
    await addItem("c1", "gid://t/V1", 2);
    let cart = await getCart("c1");
    eq(cart.changes.length, 0, "no changes at add time");
    eq(cart.subtotal, 1000, "subtotal at add price");
    await db.updateTable("variants").set({ price: 450 }).where("id", "=", "gid://t/V1").execute();
    cart = await getCart("c1");
    eq(cart.subtotal, 900, "totals follow the CURRENT price");
    eq(cart.changes.length, 1, "one change notice");
    eq(cart.changes[0].kind, "price_changed", "kind");
    eq(cart.changes[0].from, 500, "from");
    eq(cart.changes[0].to, 450, "to");
  });
});

await t("cart: unavailable line surfaces a notice; duplicate setQty is idempotent", async () => {
  await inT(async () => {
    await db.updateTable("variants").set({ available: 0 }).where("id", "=", "gid://t/V1").execute();
    let cart = await getCart("c1");
    ok(cart.changes.some((c) => c.kind === "unavailable"), "unavailable notice");
    await db.updateTable("variants").set({ available: 1, price: 500 }).where("id", "=", "gid://t/V1").execute();
    await setItemQty("c1", "gid://t/V1", 3);
    await setItemQty("c1", "gid://t/V1", 3); // duplicate submit
    cart = await getCart("c1");
    eq(cart.items[0].quantity, 3, "one final state");
    eq(cart.count, 3, "count agrees");
  });
});

await t("cart: removing the gift-qualifying item removes the gift (eligibility recomputed)", async () => {
  await inT(async () => {
    await upsertOffer({
      offer: { id: "g1k", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Gift over 1k", threshold: 1000, gift: { variantId: "gid://shopify/ProductVariant/900001", productId: "gid://shopify/Product/900001", handle: "gift", title: "Gift Sticker", value: 99 } },
      enabled: true,
    });
    await addItem("c1", "gid://t/V2", 1); // subtotal 500*3 + 1200 = 2700 → gift
    let cart = await getCart("c1");
    eq(cart.gifts.length, 1, "gift present above threshold");
    await removeItem("c1", "gid://t/V2");
    await setItemQty("c1", "gid://t/V1", 1); // 500 → below threshold
    cart = await getCart("c1");
    eq(cart.gifts.length, 0, "gift gone below threshold");
    await deleteOffer("g1k");
  });
});

// --- MC22: settings validation ------------------------------------------------------------
await t("buildSettingsPatch commerce: valid accepted, invalid named", () => {
  const good = SET.buildSettingsPatch({ commerce: { checkout_mode: "disabled", timezone: "Asia/Kolkata" } }, {});
  eq(good.ok, true, "valid passes");
  eq(good.patch.config.checkout_mode, "disabled", "mode in patch");
  eq(good.patch.config.timezone, "Asia/Kolkata", "tz in patch");
  const bad = SET.buildSettingsPatch({ commerce: { checkout_mode: "shopify", timezone: "notatz" } }, {});
  eq(bad.ok, false, "invalid refused");
  ok(bad.errors.some((e) => /Checkout mode/.test(e)), "mode rejected (shopify not selectable yet)");
  ok(bad.errors.some((e) => /Timezone/.test(e)), "tz rejected");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
