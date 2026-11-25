// Phase 8 line 1 (decision 8): the `offline` pincode provider. Reads the
// bundled India Post dataset, data/in-pincodes.json, built by
// scripts/build-pincodes.js:
//   { source, license, attribution, districts: [name], states: [name],
//     pins: { "560001": [districtIdx, stateIdx] } }
// Node only (node:fs): imported by app/api/pincode/route.js and nothing the
// storefront renders. With no data file every pin is "not found", and the
// shopper types city and state as before.
//
// PINCODE_DATA_FILE points at another file (the test fixture
// scripts/fixtures/pincodes-sample.json) and is read only outside production.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DATA_FILE = join(process.cwd(), "data", "in-pincodes.json");

export function dataFile(env = process.env) {
  return env.NODE_ENV !== "production" && env.PINCODE_DATA_FILE ? env.PINCODE_DATA_FILE : DATA_FILE;
}

const loaded = new Map(); // path → Promise<dataset | null>

async function load(path) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data.pins !== "object" || !Array.isArray(data.districts) || !Array.isArray(data.states)) return null;
    return data;
  } catch {
    return null; // no file (the owner hasn't built it yet) or a broken one
  }
}

export function offlineProvider({ path = dataFile() } = {}) {
  return {
    name: "offline",
    async lookup(pin) {
      if (!loaded.has(path)) loaded.set(path, load(path));
      const data = await loaded.get(path);
      const row = data && Object.hasOwn(data.pins, pin) ? data.pins[pin] : null;
      if (!Array.isArray(row)) return null;
      const city = data.districts[row[0]];
      const state = data.states[row[1]];
      return city && state ? { city, state } : null;
    },
  };
}
