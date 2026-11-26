// Phase 9 line 4: the courier caches in the store's database (migration 0041),
// cleared when what they were made from changes. Database only, so the
// console's install code can call it without loading any courier call.
//   forgetToken()   the cached Shiprocket API token (credentials saved, uninstall)
//   forgetPins()    the serviceability answers (pickup PIN changed, uninstall)
import { db } from "../db.js";

export async function forgetToken() {
  await db.deleteFrom("courier_auth").where("provider", "=", "shiprocket").execute().catch(() => {});
}

export async function forgetPins() {
  await db.deleteFrom("courier_pin_cache").execute().catch(() => {});
}

// installs.js calls this after a Shiprocket settings save or uninstall
export async function afterShiprocketChange({ uninstalled = false, before = {}, after = {} } = {}) {
  await forgetToken();
  if (uninstalled || String(before.pickup_pin ?? "") !== String(after.pickup_pin ?? "")) await forgetPins();
}
