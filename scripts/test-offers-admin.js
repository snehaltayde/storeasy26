// Session 19 — offer store + validation + admin auth tests.
//   node scripts/test-offers-admin.js          (pnpm test:offers-admin)
// Isolated throwaway DB; the engine is fed straight from the store to prove
// DB-configured offers drive it.
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-offers-admin.db";
process.env.ADMIN_PASSWORD = "test-admin-pw";

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, "../.test-offers-admin.db"), { force: true });

const { libsql } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const S = await import("../lib/offers/store.js");
const { validateOffer } = await import("../lib/offers/validate.js");
const { evaluateOffers } = await import("../lib/offers/engine.js");
const A = await import("../lib/admin-auth.js");

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

const WHEY_ITEM = {
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  handle: "whey-x",
  title: "Whey X",
  price: 1000,
  quantity: 2,
  lineTotal: 2000,
  tags: ["Whey"],
  productType: null,
};

// --- store CRUD + engine drive ---------------------------------------------
await t("upsert + getActiveOffers feeds the engine (DB-configured tier applies)", async () => {
  await S.upsertOffer({
    offer: {
      id: "tier-test",
      type: "TIERED_QTY",
      scope: "line",
      priority: 30,
      title: "Whey tier",
      target: { kind: "tag", value: "Whey" },
      tiers: [{ minQty: 2, percent: 5 }],
    },
  });
  const offers = await S.getActiveOffers();
  eq(offers.length, 1, "one active");
  const res = evaluateOffers([WHEY_ITEM], { offers });
  eq(res.discountTotal, 100, "5% of 2000");
});

await t("edit changes the live engine result (5% → 8%, no deploy)", async () => {
  await S.upsertOffer({
    offer: {
      id: "tier-test",
      type: "TIERED_QTY",
      scope: "line",
      priority: 30,
      title: "Whey tier",
      target: { kind: "tag", value: "Whey" },
      tiers: [{ minQty: 2, percent: 8 }],
    },
  });
  const res = evaluateOffers([WHEY_ITEM], { offers: await S.getActiveOffers() });
  eq(res.discountTotal, 160, "8% of 2000");
});

await t("disable removes it from the active set (engine → 0)", async () => {
  await S.setOfferEnabled("tier-test", false);
  const res = evaluateOffers([WHEY_ITEM], { offers: await S.getActiveOffers() });
  eq(res.discountTotal, 0, "disabled = no discount");
  await S.setOfferEnabled("tier-test", true);
});

await t("schedule window gates activation", async () => {
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();
  await S.upsertOffer({
    offer: { id: "coupon-window", type: "COUPON", scope: "order", priority: 50, title: "WINDOW10 · 10%", code: "WINDOW10", discount: { kind: "percent", value: 10 }, combinable: true },
    startsAt: future,
  });
  ok(!(await S.getActiveOffers()).some((o) => o.id === "coupon-window"), "not yet started");
  await S.upsertOffer({
    offer: { id: "coupon-window", type: "COUPON", scope: "order", priority: 50, title: "WINDOW10 · 10%", code: "WINDOW10", discount: { kind: "percent", value: 10 }, combinable: true },
    startsAt: past,
    endsAt: future,
  });
  ok((await S.getActiveOffers()).some((o) => o.id === "coupon-window"), "inside window");
  const cRes = evaluateOffers([WHEY_ITEM], { offers: await S.getActiveOffers(), coupon: "WINDOW10" });
  ok(cRes.couponStatus?.valid, "scheduled coupon validates in engine");
  await S.upsertOffer({
    offer: { id: "coupon-window", type: "COUPON", scope: "order", priority: 50, title: "WINDOW10 · 10%", code: "WINDOW10", discount: { kind: "percent", value: 10 }, combinable: true },
    startsAt: past,
    endsAt: new Date(Date.now() - 60e3).toISOString(),
  });
  ok(!(await S.getActiveOffers()).some((o) => o.id === "coupon-window"), "expired");
});

await t("delete removes the row", async () => {
  await S.deleteOffer("coupon-window");
  eq(await S.getOfferRow("coupon-window"), null, "gone");
});

// --- validation --------------------------------------------------------------
await t("validation rejects the wrong shapes (typos can't wedge the cart)", async () => {
  ok(validateOffer({ id: "x", type: "COUPON" }).length >= 3, "many errors for empty coupon");
  ok(validateOffer({ id: "ok-slug", type: "TIERED_QTY", scope: "line", title: "Tier test", target: { kind: "tag", value: "Whey" }, tiers: [{ minQty: 0, percent: 200 }] }).length === 2, "tier bounds");
  ok(validateOffer({ id: "UPPER", type: "BXGY", scope: "line", title: "Bxgy test", target: { kind: "handle", value: "x" }, buy: 2, free: 1 }).some((e) => e.startsWith("id:")), "slug enforced");
  eq(validateOffer({ id: "good-coupon", type: "COUPON", scope: "order", title: "GOOD10 · 10%", code: "GOOD10", discount: { kind: "percent", value: 10 }, combinable: true }).length, 0, "valid coupon passes");
  let threw = false;
  try {
    await S.upsertOffer({ offer: { id: "bad", type: "COUPON" } });
  } catch (e) {
    threw = e.code === "OFFER_INVALID";
  }
  ok(threw, "upsert throws OFFER_INVALID");
});

await t("schedule sanity: start must precede end", async () => {
  let threw = false;
  try {
    await S.upsertOffer({
      offer: { id: "coupon-badwin", type: "COUPON", scope: "order", priority: 50, title: "BAD10 · 10%", code: "BAD10", discount: { kind: "percent", value: 10 }, combinable: true },
      startsAt: "2026-08-01T00:00:00Z",
      endsAt: "2026-07-01T00:00:00Z",
    });
  } catch (e) {
    threw = /start must be before end/.test(e.message);
  }
  ok(threw, "rejected");
});

// --- admin auth --------------------------------------------------------------
await t("admin auth: password check + token verify + rotation invalidates", async () => {
  ok(await A.checkAdminPassword("test-admin-pw"), "right password");
  ok(!(await A.checkAdminPassword("wrong")), "wrong password");
  ok(!(await A.checkAdminPassword(null)), "null safe");
  const token = await A.adminSessionToken();
  ok(await A.verifyAdminToken(token), "token verifies");
  ok(!(await A.verifyAdminToken("forged")), "forged rejected");
  process.env.ADMIN_PASSWORD = "rotated";
  ok(!(await A.verifyAdminToken(token)), "rotation invalidates old sessions");
  process.env.ADMIN_PASSWORD = "test-admin-pw";
});

console.log(`\n${pass} passed, ${fail} failed`);
await rm(join(here, "../.test-offers-admin.db"), { force: true });
process.exit(fail ? 1 : 0);
