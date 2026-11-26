// Phase 9 step 0: where a delivery estimate comes from. Pure and Edge-safe.
//   estimateFor({ pin, storeEstimate }) → { minDays, maxDays } | null
// Today it is always the store's own estimate (lib/shipping.js computeShipping,
// the store's dispatch and delivery days), unchanged. Phase 9 line 4
// (Shiprocket) owns this file and may answer from the courier instead, only
// when the store chose it. Callers: /api/pincode and /api/checkout.
export async function estimateFor({ pin = null, storeEstimate = null } = {}) {
  void pin;
  return storeEstimate ?? null;
}
