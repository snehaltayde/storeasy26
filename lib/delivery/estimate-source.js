// Phase 9: where a delivery estimate comes from. Server-only (Node routes).
//   estimateFor({ pin, storeEstimate }) → { minDays, maxDays } | { …, serviceable: false } | null
// The store's own estimate (lib/shipping.js computeShipping, the store's
// dispatch and delivery days) is the answer, returned as given, unless the
// founder chose Shiprocket's courier estimate and the Shiprocket plugin is
// enabled and not turned off by Storeasy (line 4). Then:
//   couriers reach the PIN   → { minDays, maxDays } from Shiprocket
//   couriers don't reach it  → the store's estimate plus serviceable: false
//                              ("Couriers don't reach this PIN code yet";
//                              ordering is not blocked)
//   no answer in ESTIMATE_TIMEOUT_MS, a failure, or nothing usable
//                            → the store's estimate, unchanged
// Fees and cash on delivery are never decided here. Callers: /api/pincode
// and /api/checkout. The courier code is loaded only when a store asks.
import { slog } from "../log.js";

export const ESTIMATE_TIMEOUT_MS = 1500;
// a test seam: where the courier's answer comes from
export const estimateDeps = {
  courier: async (pin, opts) => (await import("../plugins/first-party/shiprocket/sweep.js")).courierEstimate(pin, opts),
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function estimateFor({ pin = null, storeEstimate = null } = {}) {
  const store = storeEstimate ?? null;
  if (pin == null || !/^[1-9]\d{5}$/.test(String(pin).trim())) return store;
  let courier;
  try {
    courier = await withTimeout(estimateDeps.courier(String(pin).trim(), { timeoutMs: ESTIMATE_TIMEOUT_MS }), ESTIMATE_TIMEOUT_MS);
  } catch (e) {
    slog(e?.name === "TimeoutError" ? "courier_timeout" : "courier_estimate_failed", { error: String(e?.name || "Error") });
    return store;
  }
  if (!courier) return store;
  if (courier.serviceable === false) return { ...(store ?? {}), serviceable: false };
  if (Number.isInteger(courier.minDays) && Number.isInteger(courier.maxDays) && courier.minDays <= courier.maxDays) return { minDays: courier.minDays, maxDays: courier.maxDays };
  return store;
}
