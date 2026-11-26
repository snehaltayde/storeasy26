// Phase 9 line 4: the Shiprocket stand-in. Node only, never in production
// (every call throws there, and lib/couriers/shiprocket.js never picks it).
// It answers from the recorded fixtures in scripts/fixtures/shiprocket/:
//   login          → login.json
//   serviceability → serviceability.json; serviceability-none.json for the
//                    PINs stub-pins.json lists as unserviceable; the "slow"
//                    PINs answer after 5 s (past the shopper timeout)
//   track(awb)     → track-in-transit.json, unless the stub folder holds
//                    <awb>.json naming another fixture ({ "fixture": "track-delivered" }),
//                    which is how drill:plugins moves a parcel along.
// The stub folder is SHIPROCKET_STUB_DIR, else <tmp>/storeasy-shiprocket-stub.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AWB_RE } from "./normalize.js";

const prod = () => process.env.NODE_ENV === "production";
const FIXTURES = join(process.cwd(), "scripts", "fixtures", "shiprocket");
export const stubDir = () => (process.env.SHIPROCKET_STUB_DIR || "").trim() || join(tmpdir(), "storeasy-shiprocket-stub");

async function fixture(name, awb = "") {
  const text = await readFile(join(FIXTURES, `${name}.json`), "utf8");
  return JSON.parse(awb ? text.replaceAll("__AWB__", awb) : text);
}
const refuse = () => {
  if (prod()) throw new Error("The Shiprocket stub never runs in production");
};
const ok = (json) => ({ ok: true, status: 200, json });

export const stub = {
  name: "stub",
  async login({ email, password } = {}) {
    refuse();
    if (!email || !password) return { ok: false, status: 400, json: { message: "email and password are required" } };
    return ok(await fixture("login"));
  },
  async serviceability({ pin } = {}) {
    refuse();
    const pins = await fixture("stub-pins");
    if (pins.slow.includes(pin)) await new Promise((r) => setTimeout(r, 5000));
    return ok(await fixture(pins.unserviceable.includes(pin) ? "serviceability-none" : "serviceability"));
  },
  async track({ awb } = {}) {
    refuse();
    if (!AWB_RE.test(String(awb))) return { ok: false, status: 404, json: null };
    let name = "track-in-transit";
    try {
      const pick = JSON.parse(await readFile(join(stubDir(), `${awb}.json`), "utf8"));
      if (/^track-[a-z-]+$/.test(String(pick?.fixture))) name = pick.fixture;
    } catch {
      // no overlay: the default fixture
    }
    return ok(await fixture(name, awb));
  },
};
