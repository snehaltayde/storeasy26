// Session 13 — shipping engine tests (pure; no DB, no network).
//   node scripts/test-shipping.js          (pnpm test:shipping)
import { computeShipping, SHIPPING_CONFIG } from "../lib/shipping.js";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
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

// defaults: net basis, free ≥999, flat 79, COD fee 49, no zones
t("below threshold → flat ₹79", () => {
  const s = computeShipping({ subtotal: 500, discountTotal: 0 });
  eq(s.total, 79, "total");
  eq(s.base, 79, "base");
  eq(s.method, "standard", "method");
  eq(s.label, "Standard shipping", "label");
  eq(s.free, false, "free");
});

t("at the threshold exactly → free", () => {
  const s = computeShipping({ subtotal: 999, discountTotal: 0 });
  eq(s.total, 0, "total");
  eq(s.free, true, "free");
  eq(s.method, "free", "method");
  eq(s.label, "Free shipping (₹999+)", "label");
});

t("above threshold → free", () => {
  eq(computeShipping({ subtotal: 5947, discountTotal: 0 }).total, 0, "total");
});

t("net basis: discounts can pull an order back under the threshold", () => {
  // 1200 gross − 300 discount = 900 net < 999 → charged
  const s = computeShipping({ subtotal: 1200, discountTotal: 300 });
  eq(s.total, 79, "total");
  eq(s.remainingForFree, 99, "remaining nudge = 999 − 900");
});

t("gross basis config keeps it free", () => {
  const config = { ...SHIPPING_CONFIG, basis: "gross" };
  eq(computeShipping({ subtotal: 1200, discountTotal: 300, config }).total, 0, "total");
});

t("COD adds the fee below threshold", () => {
  const s = computeShipping({ subtotal: 500, paymentMethod: "cod" });
  eq(s.total, 128, "79 + 49");
  eq(s.codFee, 49, "codFee");
  eq(s.label, "Standard shipping + COD fee ₹49", "label");
});

t("COD fee still applies when base shipping is free", () => {
  const s = computeShipping({ subtotal: 2000, paymentMethod: "cod" });
  eq(s.base, 0, "base free");
  eq(s.codFee, 49, "codFee");
  eq(s.total, 49, "total");
  eq(s.method, "standard", "not fully free");
  eq(s.label, "Free shipping (₹999+) + COD fee ₹49", "label");
});

t("codFeeWaivedAt waives the fee above its threshold", () => {
  const config = { ...SHIPPING_CONFIG, codFeeWaivedAt: 1500 };
  eq(computeShipping({ subtotal: 2000, paymentMethod: "cod", config }).total, 0, "waived");
  eq(computeShipping({ subtotal: 1200, paymentMethod: "cod", config }).codFee, 49, "kept below");
});

t("prepaid never pays the COD fee", () => {
  eq(computeShipping({ subtotal: 500, paymentMethod: "prepaid" }).codFee, 0, "codFee");
});

t("zone override: rate + threshold by pincode prefix", () => {
  const config = {
    ...SHIPPING_CONFIG,
    zones: [{ prefixes: ["19", "18"], label: "Remote zone", flatRate: 149, freeThreshold: 1999 }],
  };
  const remote = computeShipping({ subtotal: 1200, pincode: "190001", config });
  eq(remote.total, 149, "zone rate");
  eq(remote.zone, "Remote zone", "zone matched");
  eq(remote.label, "Remote zone shipping", "zone label");
  eq(remote.remainingForFree, 799, "zone threshold 1999 − 1200");
  const metro = computeShipping({ subtotal: 1200, pincode: "411001", config });
  eq(metro.total, 0, "non-zone pincode uses base rules");
});

t("free-shipping nudge reports the remaining amount", () => {
  eq(computeShipping({ subtotal: 700 }).remainingForFree, 299, "999 − 700");
  eq(computeShipping({ subtotal: 999 }).remainingForFree, 0, "0 once free");
});

t("empty cart still computes (flat rate, full nudge)", () => {
  const s = computeShipping({ subtotal: 0 });
  eq(s.total, 79, "total");
  eq(s.remainingForFree, 999, "remaining");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
