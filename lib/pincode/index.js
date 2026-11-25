// Phase 8 line 1 (decision 8): what a shopper's PIN code tells the store.
//   pincodeAnswer(pin, { config, now, timeZone, provider })
//     → { ok: false, error }                       not six digits
//     → { ok: true, found, city, state, estimate, cod, freeThreshold, timeZone }
// city/state come from the provider (null when not found); estimate, cod and
// freeThreshold come only from THIS store's shipping config (lib/shipping.js),
// so another store's zones never shape the answer. Node only: the provider
// reads a file. The storefront reaches it through /api/pincode, never by import.
import { computeShipping } from "../shipping.js";
import { DEFAULT_TIME_ZONE } from "../delivery-estimate.js";
import { offlineProvider } from "./offline.js";
import { PIN_RE, BAD_PIN } from "./client.js";

export { PIN_RE };

let injected = null;
// Tests swap the provider (never in production).
export function setPincodeProvider(p) {
  if (process.env.NODE_ENV === "production") throw new Error("setPincodeProvider: not in production");
  injected = p;
}
const provider = () => injected || offlineProvider();

export async function pincodeAnswer(pin, { config, timeZone = DEFAULT_TIME_ZONE, provider: p = provider() } = {}) {
  const value = String(pin ?? "").trim();
  if (!PIN_RE.test(value)) return { ok: false, error: BAD_PIN };
  let place = null;
  try {
    place = await p.lookup(value);
  } catch {
    place = null; // a provider failure is "not found": the shopper types city and state
  }
  const ship = computeShipping({ subtotal: 0, pincode: value, config });
  return {
    ok: true,
    found: Boolean(place),
    city: place?.city ?? null,
    state: place?.state ?? null,
    estimate: ship.estimate ?? null,
    cod: ship.zoneCod !== false,
    freeThreshold: ship.freeThreshold,
    timeZone,
  };
}
