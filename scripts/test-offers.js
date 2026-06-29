// Deterministic unit test for the pure offer engine. No DB, no env.
//   node scripts/test-offers.js
import { evaluateOffers } from "../lib/offers/engine.js";

const BCAA = {
  variantId: "v-bcaa",
  productId: "p-bcaa",
  handle: "beast-recovery-bcaa-mango-120g",
  tags: ["BCAA"],
  productType: null,
  price: 499,
};
const whey = (id, price = 3499) => ({
  variantId: "v-" + id,
  productId: "p-" + id,
  handle: "whey-" + id,
  tags: ["Whey", "Protein"],
  productType: null,
  price,
});
const OTHER = {
  variantId: "v-x",
  productId: "p-x",
  handle: "shaker",
  tags: ["Accessories"],
  price: 499,
};
const item = (base, quantity) => ({ ...base, quantity });

const cases = [
  ["BCAA ×2 → no free", [item(BCAA, 2)], 0],
  ["BCAA ×3 → 1 free", [item(BCAA, 3)], 499],
  ["BCAA ×6 → 2 free", [item(BCAA, 6)], 998],
  ["BCAA ×7 → 2 free (floor)", [item(BCAA, 7)], 998],
  ["Whey ×1 → below tier", [item(whey("a"), 1)], 0],
  ["Whey ×2 (2 lines) → 5%", [item(whey("a"), 1), item(whey("b"), 1)], 350],
  ["Whey ×2 (1 line) → 5%", [item(whey("a"), 2)], 350],
  ["Whey ×3 → 10%", [item(whey("a"), 1), item(whey("b"), 1), item(whey("c"), 1)], 1050],
  ["Stack: BCAA ×3 + Whey ×2", [item(BCAA, 3), item(whey("a"), 2)], 499 + 350],
  ["Non-qualifying → 0", [item(OTHER, 5)], 0],
  ["Determinism: same input twice", [item(BCAA, 3)], 499],
];

let pass = 0;
let fail = 0;
for (const [name, items, expected] of cases) {
  const r = evaluateOffers(items);
  // re-run to assert determinism
  const r2 = evaluateOffers(items);
  const deterministic = JSON.stringify(r) === JSON.stringify(r2);
  const ok = r.discountTotal === expected && deterministic;
  console.log(
    `${ok ? "✓" : "✗"} ${name}  → ${r.discountTotal} (expected ${expected})` +
      (deterministic ? "" : " [NON-DETERMINISTIC]") +
      (ok ? "" : `  offers=${JSON.stringify(r.appliedOffers)}`),
  );
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
