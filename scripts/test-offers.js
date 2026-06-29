// Deterministic unit tests for the pure offer + stacking engine. No DB, no env.
//   node scripts/test-offers.js
import { evaluateOffers } from "../lib/offers/engine.js";

const BCAA = { variantId: "v-bcaa", productId: "p-bcaa", handle: "beast-recovery-bcaa-mango-120g", tags: ["BCAA"], price: 499 };
const whey = (id, price = 3499) => ({ variantId: "v-" + id, productId: "p-" + id, handle: "whey-" + id, tags: ["Whey"], price });
const plain = (id, price) => ({ variantId: "v-" + id, productId: "p-" + id, handle: "plain-" + id, tags: [], price });
const item = (b, q) => ({ ...b, quantity: q });

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log("✓ " + name);
  } else {
    fail++;
    console.log("✗ " + name + (detail ? "  — " + detail : ""));
  }
};

// ---- BXGY + TIERED (Session 3 regression) ----
let r = evaluateOffers([item(BCAA, 3)]);
check("BXGY ×3 → −499", r.appliedOffers.find((o) => o.type === "BXGY")?.amount === 499);
check("BXGY ×3 → no gift (subtotal 1497 < 1499)", r.gifts.length === 0, "gifts=" + r.gifts.length);

// ---- FREE_GIFT threshold + the line-counting trap ----
r = evaluateOffers([item(plain("a", 1400), 1)]);
check("subtotal 1400 → NO gift (gift's ₹315 is NOT self-counted = trap avoided)", r.gifts.length === 0, "gifts=" + r.gifts.length);
r = evaluateOffers([item(plain("a", 1500), 1)]);
check("subtotal 1500 → free gift", r.gifts.length === 1);
check("gift adds 0 to discountTotal", r.discountTotal === 0, "discountTotal=" + r.discountTotal);
check("gift listed with amount 0", !!r.appliedOffers.find((o) => o.type === "FREE_GIFT" && o.amount === 0));

// ---- COUPON validation ----
r = evaluateOffers([item(whey("a"), 1)], { coupon: "BOGUS" });
check("invalid code → couponStatus.valid false", r.couponStatus?.valid === false);
check("invalid code → no discount", r.discountTotal === 0);
r = evaluateOffers([item(plain("a", 500), 1)], { coupon: "FLAT200" });
check("FLAT200 below min (500<999) → invalid", r.couponStatus?.valid === false);
r = evaluateOffers([item(plain("a", 1200), 1)], { coupon: "FLAT200" });
check("FLAT200 ok → −200", r.discountTotal === 200 && r.couponStatus?.valid === true, "discountTotal=" + r.discountTotal);

// ---- No double-dip: TIERED + BEAST10 (coupon on the NET subtotal) ----
r = evaluateOffers([item(whey("a", 3499), 1), item(whey("b", 3499), 1), item(whey("c", 3499), 1)], { coupon: "BEAST10" });
// subtotal 10497 → TIERED 10% = 1050 → net 9447 → BEAST10 10% = 945
check("TIERED+BEAST10 stack on net", r.discountTotal === 1050 + 945, "got " + r.discountTotal);
check("BEAST10 = 945 (10% of net 9447, NOT 1050 of full)", r.appliedOffers.find((o) => o.type === "COUPON")?.amount === 945, "got " + r.appliedOffers.find((o) => o.type === "COUPON")?.amount);

// ---- Exclusive coupon suppresses other offers ----
r = evaluateOffers([item(whey("a", 3499), 1), item(whey("b", 3949), 1), item(whey("c", 3949), 1)], { coupon: "SOLO25" });
// subtotal 11397 → SOLO25 25% of FULL = 2849, no TIERED, no gift
check("SOLO25 exclusive → only the coupon applies", r.appliedOffers.length === 1 && r.appliedOffers[0].type === "COUPON", JSON.stringify(r.appliedOffers.map((o) => o.type)));
check("SOLO25 on full subtotal → 2849", r.discountTotal === 2849, "got " + r.discountTotal);
check("SOLO25 suppresses the gift too", r.gifts.length === 0);

// ---- THE MONEY SHOT: BXGY + TIERED + COUPON(net) + FREE_GIFT ----
r = evaluateOffers([item(BCAA, 3), item(whey("a", 3499), 1), item(whey("b", 3949), 1), item(whey("c", 3949), 1)], { coupon: "BEAST10" });
check("money shot subtotal = 12894", r.subtotal === 12894, "got " + r.subtotal);
check("money shot discount = 2765 (499+1140+1126)", r.discountTotal === 2765, "got " + r.discountTotal + " " + JSON.stringify(r.appliedOffers.map((o) => [o.type, o.amount])));
check("money shot total = 10129", r.total === 10129, "got " + r.total);
check("money shot includes the free gift", r.gifts.length === 1);
check("money shot = 3 discounts + 1 gift", r.appliedOffers.filter((o) => o.amount > 0).length === 3 && r.appliedOffers.filter((o) => o.gift).length === 1);

// ---- determinism ----
const sig = () => JSON.stringify(evaluateOffers([item(BCAA, 3), item(whey("a"), 2)], { coupon: "BEAST10" }));
check("deterministic (same input twice)", sig() === sig());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
