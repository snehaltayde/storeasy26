// Phase 8 line 1: PIN code lookup and delivery estimates.
//   node scripts/test-pincode.js          (pnpm test:pincode)
// 1. the dataset: the fixture's pins, unknown and bad pins, no data file → every
//    pin "not found", PINCODE_DATA_FILE ignored in production, the CSV builder;
// 2. the estimate: a brute force over every zone/default configuration × pins ×
//    times around IST midnight equals the configured rule; no settings → null;
// 3. the checkout's fill rule (typed city and state are never overwritten);
// 4. the real route on two stores: B's zones never shape A's answer, the 31st
//    request in a minute is a 429, the log line has no pin;
// 5. the storefront's import walk never reaches data/, lib/pincode's server
//    side or a node: module; an existing store's shipping JSON is unchanged.
// Outside services are blanked and fetch() is blocked; databases are throwaway files.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/fixtures/pincodes-sample.json");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const fetchCalls = H.blockNetwork();

const { offlineProvider, dataFile, DATA_FILE, UNAVAILABLE } = await import("../lib/pincode/offline.js");
const { pincodeAnswer, setPincodeProvider } = await import("../lib/pincode/index.js");
const { estimateDays, deliveryWindow, deliveryLine, expectedLine, expectedPassed, dayLabel } = await import("../lib/delivery-estimate.js");
const { computeShipping } = await import("../lib/shipping.js");
const { validateShippingConfig, shippingExample } = await import("../lib/admin/settings.js");
const { pincodePatch, applyAddress, emptyForm } = await import("../components/checkout/checkoutModel.js");
const { buildPincodes, ATTRIBUTION } = await import("./build-pincodes.js");

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
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (v, label) => {
  if (!v) throw new Error(label);
};

const fixture = offlineProvider({ path: FIXTURE });
const nowhere = offlineProvider({ path: join(ROOT, "scripts/fixtures/no-such-pincodes.json") });

// ---- 1. dataset -------------------------------------------------------------------
console.log("— dataset");

await t("fixture pins give the right district and state", async () => {
  eq(await fixture.lookup("560001"), { city: "Bengaluru", state: "Karnataka" });
  eq(await fixture.lookup("411001"), { city: "Pune", state: "Maharashtra" });
  eq(await fixture.lookup("110001"), { city: "New Delhi", state: "Delhi" });
  eq(await fixture.lookup("194101"), { city: "Leh", state: "Ladakh" });
  eq(await fixture.lookup("500001"), { city: "Hyderabad", state: "Telangana" });
});

await t("unknown and bad pins", async () => {
  const a = await pincodeAnswer("999999", { provider: fixture });
  eq([a.ok, a.found, a.city, a.state], [true, false, null, null], "unknown:");
  for (const bad of ["", "56000", "5600011", "056001", "56 001", "abcdef", null, "560001; drop"]) {
    const r = await pincodeAnswer(bad, { provider: fixture });
    eq([r.ok, r.error], [false, "Enter a 6-digit PIN code."], `${JSON.stringify(bad)}:`);
  }
  eq((await pincodeAnswer(" 560001 ", { provider: fixture })).city, "Bengaluru", "trimmed:");
});

await t("file present: a pin it lacks is found: false (the not-found message shows)", async () => {
  eq(await fixture.lookup("999999"), null);
  const a = await pincodeAnswer("999999", { provider: fixture });
  eq([a.found, a.city, a.state], [false, null, null]);
});

await t("file missing: every pin is found: null (unknown, so no not-found message)", async () => {
  ok(!existsSync(DATA_FILE), "data/in-pincodes.json is committed; this check expects the owner step not done yet — update the test");
  for (const pin of ["560001", "411001", "999999"]) {
    eq(await nowhere.lookup(pin), UNAVAILABLE, `${pin}:`);
    eq(await offlineProvider({ path: DATA_FILE }).lookup(pin), UNAVAILABLE, `${pin} (default path):`);
    const a = await pincodeAnswer(pin, { provider: nowhere });
    eq([a.ok, a.found, a.city, a.state], [true, null, null, null], `${pin} answer:`);
  }
  const broken = { lookup: async () => { throw new Error("boom"); } };
  eq((await pincodeAnswer("560001", { provider: broken })).found, null, "a provider that throws is unknown:");
});

await t("PINCODE_DATA_FILE is read only outside production", () => {
  eq(dataFile({ NODE_ENV: "development", PINCODE_DATA_FILE: FIXTURE }), FIXTURE);
  eq(dataFile({ NODE_ENV: "production", PINCODE_DATA_FILE: FIXTURE }), DATA_FILE);
  eq(dataFile({ NODE_ENV: "test" }), DATA_FILE);
  eq(DATA_FILE, join(process.cwd(), "data", "in-pincodes.json"));
});

await t("the fixture has the compact shape scripts/build-pincodes.js writes", async () => {
  const d = JSON.parse(await readFile(FIXTURE, "utf8"));
  for (const [pin, row] of Object.entries(d.pins)) {
    ok(/^[1-9]\d{5}$/.test(pin), `bad pin ${pin}`);
    ok(Array.isArray(row) && row.length === 2 && d.districts[row[0]] && d.states[row[1]], `bad row for ${pin}`);
  }
});

await t("build-pincodes: title case, today's states, the most common district, attribution in the header", () => {
  const csv = [
    "circlename,regionname,divisionname,officename,pincode,officetype,delivery,district,statename",
    "Karnataka Circle,Bangalore HQ,Bangalore GPO,Bangalore G.P.O.,560001,H.O,Delivery,BENGALURU,KARNATAKA",
    'Karnataka Circle,Bangalore HQ,Bangalore GPO,"Vidhana Soudha, S.O",560001,S.O,Delivery,BENGALURU,KARNATAKA',
    "Karnataka Circle,Bangalore HQ,Bangalore East,Other,560001,B.O,Delivery,BENGALURU RURAL,KARNATAKA",
    "J&K Circle,Leh,Leh,Leh H.O,194101,H.O,Delivery,LEH,JAMMU & KASHMIR",
    "AP Circle,Hyderabad,Hyderabad City,Hyderabad GPO,500001,H.O,Delivery,HYDERABAD,ANDHRA PRADESH",
    "AP Circle,Vijayawada,Vijayawada,Vijayawada H.O,520001,H.O,Delivery,KRISHNA,ANDHRA PRADESH",
    "Odisha Circle,Bhubaneswar,Cuttack,Cuttack GPO,753001,H.O,Delivery,CUTTACK,ORISSA",
    "Bad,Bad,Bad,Bad,05600,H.O,Delivery,NOWHERE,NOWHERE",
    "",
  ].join("\r\n");
  const d = buildPincodes(`﻿${csv}`, { built: "2026-11-26T00:00:00.000Z" });
  const at = (pin) => [d.districts[d.pins[pin][0]], d.states[d.pins[pin][1]]];
  eq(at("560001"), ["Bengaluru", "Karnataka"], "most common district:");
  eq(at("194101"), ["Leh", "Ladakh"], "Ladakh:");
  eq(at("500001"), ["Hyderabad", "Telangana"], "Telangana:");
  eq(at("520001"), ["Krishna", "Andhra Pradesh"], "still Andhra Pradesh:");
  eq(at("753001"), ["Cuttack", "Odisha"], "Odisha:");
  eq(d.count, 5, "the bad pin is skipped:");
  eq(d.attribution, ATTRIBUTION);
  ok(/GODL/.test(d.license) && /India Post/.test(d.source), "licence and source in the header");
  let threw = false;
  try {
    buildPincodes("a,b,c\n1,2,3\n");
  } catch {
    threw = true;
  }
  ok(threw, "a CSV without the columns is refused");
});

// ---- 2. estimate ------------------------------------------------------------------
console.log("— estimate");

// The rule, written out independently: IST is UTC+5:30 with no DST, so the
// store's calendar day is the UTC day of (instant + 330 minutes).
const IST = 330 * 60_000;
const refDay = (ms, add) => new Date(Math.floor((ms + IST) / 86_400_000) * 86_400_000 + add * 86_400_000).toISOString().slice(0, 10);
function refRule(config, pin) {
  const zone = (config.zones || []).find((z) => z.prefixes.some((p) => pin.startsWith(p)));
  const d = zone?.deliveryDays ?? config.deliveryDays;
  if (!d) return null;
  const dispatch = config.dispatchDays ?? 0;
  return { minDays: dispatch + d.min, maxDays: dispatch + d.max };
}

await t("brute force: every zone/default configuration × pins × times around IST midnight equals the rule", () => {
  const base = { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null };
  const dispatches = [undefined, 0, 1, 10];
  const defaults = [undefined, { min: 1, max: 1 }, { min: 2, max: 5 }, { min: 30, max: 30 }];
  const zoneDays = [undefined, { min: 1, max: 2 }, { min: 7, max: 12 }];
  const pins = ["110001", "122001", "194101", "560001", "560034", "999999"];
  // 18:29:59Z is 23:59:59 IST, 18:30Z is midnight IST
  const times = [];
  for (const day of ["2026-11-30", "2026-12-31", "2027-02-28", "2028-02-28"]) {
    for (const hms of ["18:29:59.999", "18:30:00.000", "18:30:00.001", "00:00:00.000", "12:00:00.000", "23:59:59.999"]) times.push(Date.parse(`${day}T${hms}Z`));
  }
  let n = 0;
  for (const dispatchDays of dispatches)
    for (const deliveryDays of defaults)
      for (const north of zoneDays)
        for (const south of zoneDays) {
          const cfg = { ...base, zones: [] };
          if (dispatchDays !== undefined) cfg.dispatchDays = dispatchDays;
          if (deliveryDays) cfg.deliveryDays = deliveryDays;
          cfg.zones.push({ label: "North", prefixes: ["11", "12"], ...(north ? { deliveryDays: north } : {}) });
          cfg.zones.push({ label: "South", prefixes: ["56"], cod: false, ...(south ? { deliveryDays: south } : {}) });
          const valid = validateShippingConfig(cfg);
          ok(valid.ok, valid.errors.join("; "));
          for (const pin of pins) {
            const want = refRule(valid.value, pin);
            const got = computeShipping({ subtotal: 500, pincode: pin, config: valid.value }).estimate ?? null;
            eq(got, want, `${JSON.stringify(cfg)} ${pin}:`);
            for (const ms of times) {
              const w = deliveryWindow(got, { from: new Date(ms), timeZone: "Asia/Kolkata" });
              eq(w, want && { from: refDay(ms, want.minDays), to: refDay(ms, want.maxDays) }, `${pin} at ${new Date(ms).toISOString()}:`);
              n++;
            }
          }
        }
  ok(n > 20_000, `only ${n} cases`);
});

// America/New_York, written out from the US rule (EDT −4 from the second
// Sunday of March 02:00 local to the first Sunday of November 02:00 local, else EST −5).
function nyOffsetMin(ms) {
  const y = new Date(ms).getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7); // 02:00 EST = 07:00Z
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6); // 02:00 EDT = 06:00Z
  return ms >= start && ms < end ? -240 : -300;
}
const nyDay = (ms, add) => {
  const local = ms + nyOffsetMin(ms) * 60_000;
  return new Date(Math.floor(local / 86_400_000) * 86_400_000 + add * 86_400_000).toISOString().slice(0, 10);
};

await t("brute force, America/New_York: estimates × times around its midnight (EST and EDT, both DST switches) equal the rule", () => {
  const estimates = [{ minDays: 1, maxDays: 1 }, { minDays: 3, maxDays: 5 }, { minDays: 0, maxDays: 40 }];
  const days = ["2026-01-15", "2026-03-07", "2026-03-08", "2026-03-09", "2026-07-04", "2026-10-31", "2026-11-01", "2026-11-02", "2026-12-31", "2028-02-29"];
  let n = 0;
  for (const day of days) {
    const base = Date.parse(`${day}T00:00:00Z`);
    for (let m = -6 * 60; m <= 36 * 60; m += 15) {
      for (const jitter of [-1, 0, 1]) {
        const ms = base + m * 60_000 + jitter;
        for (const est of estimates) {
          eq(deliveryWindow(est, { from: new Date(ms), timeZone: "America/New_York" }), { from: nyDay(ms, est.minDays), to: nyDay(ms, est.maxDays) }, `${new Date(ms).toISOString()}:`);
          n++;
        }
      }
    }
  }
  ok(n > 10_000, `only ${n} cases`);
});

await t("no settings → estimate null, and no line anywhere", async () => {
  const plain = computeShipping({ subtotal: 500, pincode: "560001" });
  ok(!("estimate" in plain) && !("zoneCod" in plain), "a store without the settings keeps the old shape");
  eq(estimateDays({ dispatchDays: 2 }), null, "dispatch alone is no estimate:");
  eq(deliveryLine(null), null);
  eq(expectedLine(undefined), null);
  eq((await pincodeAnswer("560001", { provider: fixture, config: undefined })).estimate, null, "pincode answer:");
});

await t("lines: a range, one day, and 'Expected by' the last day; a bad time zone falls back to IST", () => {
  const from = new Date("2026-11-27T18:30:00Z"); // Sat 28 Nov in IST, Fri 27 Nov in UTC
  eq(deliveryLine({ minDays: 3, maxDays: 5 }, { from, timeZone: "Asia/Kolkata" }), "Delivery by Tue 1 Dec – Thu 3 Dec");
  eq(deliveryLine({ minDays: 3, maxDays: 3 }, { from, timeZone: "Asia/Kolkata" }), "Delivery by Tue 1 Dec");
  eq(expectedLine({ minDays: 3, maxDays: 5 }, { from, timeZone: "Asia/Kolkata" }), "Expected by Thu 3 Dec");
  eq(deliveryLine({ minDays: 3, maxDays: 5 }, { from, timeZone: "UTC" }), "Delivery by Mon 30 Nov – Wed 2 Dec", "the store's zone decides:");
  eq(deliveryLine({ minDays: 3, maxDays: 5 }, { from, timeZone: "Not/AZone" }), "Delivery by Tue 1 Dec – Thu 3 Dec");
  eq(dayLabel("2028-02-29"), "Tue 29 Feb");
});

await t("expectedPassed: false through the last expected day, true the day after (store's zone)", () => {
  const from = "2026-11-27T18:30:00Z"; // Sat 28 Nov IST; 3–5 days → by Thu 3 Dec
  const est = { minDays: 3, maxDays: 5 };
  const at = (iso) => expectedPassed(est, { from, timeZone: "Asia/Kolkata", now: new Date(iso) });
  eq(at("2026-12-03T18:29:59Z"), false, "23:59 IST on Thu 3 Dec:");
  eq(at("2026-12-03T18:30:00Z"), true, "00:00 IST on Fri 4 Dec:");
  eq(expectedPassed(null, { from, now: new Date("2030-01-01T00:00:00Z") }), false, "no estimate:");
});

await t("computeShipping: the zone's COD flag, and the money unchanged by the new fields", () => {
  const cfg = validateShippingConfig({ flatRate: 79, freeThreshold: 999, codFee: 49, zones: [{ label: "Remote", prefixes: "19", flatRate: 149, cod: false, deliveryDays: { min: 5, max: 8 } }], dispatchDays: 1, deliveryDays: { min: 2, max: 4 } }).value;
  const remote = computeShipping({ subtotal: 500, paymentMethod: "cod", pincode: "194101", config: cfg });
  eq([remote.zoneCod, remote.estimate, remote.total], [false, { minDays: 6, maxDays: 9 }, 198]);
  const plain = computeShipping({ subtotal: 500, pincode: "560001", config: cfg });
  eq([plain.zoneCod, plain.estimate, plain.total], [undefined, { minDays: 3, maxDays: 5 }, 79]);
});

await t("shippingExample: the estimate in words when days are set, nothing new when not", () => {
  const now = new Date("2026-11-27T18:30:00Z");
  const lines = shippingExample({ flatRate: 79, freeThreshold: 999, codFee: 0, dispatchDays: 1, deliveryDays: { min: 2, max: 4 } }, { now, timeZone: "Asia/Kolkata" });
  eq(lines.at(-1), 'An order placed today arrives in 3–5 days: shoppers see "Delivery by Tue 1 Dec – Thu 3 Dec".');
  eq(shippingExample({ flatRate: 79, freeThreshold: "", codFee: 0 }, { now }), ["An order of ₹999 paid online pays ₹79 for shipping."]);
});

await t("settings: dispatch 0–10 and delivery 1–30 are the limits", () => {
  const base = { flatRate: 79, freeThreshold: 999, codFee: 0 };
  ok(validateShippingConfig({ ...base, dispatchDays: 10, deliveryDays: { min: 1, max: 30 } }).ok, "edges refused");
  for (const extra of [{ dispatchDays: 11 }, { deliveryDays: { min: 0, max: 3 } }, { deliveryDays: { min: 2, max: 31 } }, { zones: [{ prefixes: "11", deliveryDays: { min: 0, max: 1 } }] }]) {
    ok(!validateShippingConfig({ ...base, ...extra }).ok, `${JSON.stringify(extra)} passed`);
  }
});

// ---- 3. checkout fill rule --------------------------------------------------------
console.log("— checkout fill rule");

await t("pincodePatch: fills empty or still-auto-filled city and state, never typed ones", () => {
  const place = { city: "Bengaluru", state: "Karnataka" };
  eq(pincodePatch(emptyForm(), place), place, "empty:");
  const typed = applyAddress(emptyForm(), { city: "Bangalore" }, "typed");
  eq(pincodePatch(typed, place), { state: "Karnataka" }, "typed city kept:");
  // the lookup filled them; a new PIN replaces its own values
  let f = applyAddress(emptyForm(), place, "pincode");
  eq(pincodePatch(f, { city: "Pune", state: "Maharashtra" }, place), { city: "Pune", state: "Maharashtra" }, "auto-filled replaced:");
  // the shopper then edits the city: the next PIN leaves it alone
  f = applyAddress(f, { city: "Bangalore Urban" }, "typed");
  eq(pincodePatch(f, { city: "Pune", state: "Maharashtra" }, place), { state: "Maharashtra" }, "edited city kept:");
  eq(pincodePatch(emptyForm(), null), {}, "not found:");
});

// ---- 4. the route on two stores ---------------------------------------------------
console.log("— /api/pincode");

const F = await import("./support/tenant-fixture.js");
const platform = await F.makePlatform({ name: "pincode" });
const SHIP_A = { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null, zones: [], dispatchDays: 1, deliveryDays: { min: 2, max: 4 } };
const SHIP_B = { currency: "INR", basis: "net", freeThreshold: 4999, flatRate: 99, codFee: 0, codFeeWaivedAt: null, zones: [{ label: "South", prefixes: ["56"], cod: false, freeThreshold: 7777, deliveryDays: { min: 9, max: 14 } }], dispatchDays: 3, deliveryDays: { min: 5, max: 6 } };
const sA = await F.makeTenant({ name: "pin-a", mode: "documents", products: 1, config: { shipping_config: SHIP_A, timezone: "Asia/Kolkata" } });
const sB = await F.makeTenant({ name: "pin-b", mode: "documents", products: 1, config: { shipping_config: SHIP_B, timezone: "Asia/Kolkata" } });
const sC = await F.makeTenant({ name: "pin-c", mode: "documents", products: 1 });
for (const s of [sA, sB, sC]) F.assertLocalDbUrl(s.tenant.dbUrl);
const { NextRequest } = await import("./support/next-server-stub.js");
const route = await import("../app/api/pincode/route.js");
setPincodeProvider(fixture);

async function get(host, pin, ip = "10.0.0.1") {
  const req = new NextRequest(`http://${host}/api/pincode?pin=${encodeURIComponent(pin)}`, { method: "GET", headers: { host, "x-forwarded-for": ip } });
  const res = await route.GET(req, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

await t("route: runtime nodejs, and only this store's rates shape the answer", async () => {
  eq(route.runtime, "nodejs");
  const a = await get(sA.tenant.domains[0], "560001");
  eq(a.status, 200, JSON.stringify(a.body));
  eq(a.body, { found: true, city: "Bengaluru", state: "Karnataka", estimate: { minDays: 3, maxDays: 5 }, cod: true, freeThreshold: 999, timeZone: "Asia/Kolkata" }, "store A:");
  const b = await get(sB.tenant.domains[0], "560001");
  eq(b.body, { found: true, city: "Bengaluru", state: "Karnataka", estimate: { minDays: 12, maxDays: 17 }, cod: false, freeThreshold: 7777, timeZone: "Asia/Kolkata" }, "store B:");
  const c = await get(sC.tenant.domains[0], "560001");
  eq([c.body.estimate, c.body.cod], [null, true], "a store with no delivery days shows no estimate:");
  // and A again after B, so nothing B set lingers
  eq((await get(sA.tenant.domains[0], "560001")).body, a.body, "A after B:");
  eq((await get(sA.tenant.domains[0], "999999")).body.found, false, "unknown pin on A:");
  eq((await get(sA.tenant.domains[0], "56000")).status, 400, "bad pin:");
});

await t("route: with no dataset file the answer is found: null, and the store's estimate still comes", async () => {
  setPincodeProvider(nowhere);
  try {
    const r = await get(sA.tenant.domains[0], "560001");
    eq([r.status, r.body.found, r.body.city, r.body.estimate], [200, null, null, { minDays: 3, maxDays: 5 }]);
  } finally {
    setPincodeProvider(fixture);
  }
});

await t("route: the log line says found or not, never the pin", async () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await get(sA.tenant.domains[0], "411001");
    await get(sA.tenant.domains[0], "999999");
  } finally {
    console.log = log;
  }
  const mine = lines.filter((l) => l.includes("pincode_lookup"));
  eq(mine.length, 2, `lines: ${lines.join(" | ")}`);
  for (const l of mine) ok(!/411001|999999/.test(l), `a pin was logged: ${l}`);
  eq(mine.map((l) => JSON.parse(l).found), [true, false]);
});

await t("route: the 31st request in a minute from one IP is a 429", async () => {
  delete process.env.RATE_LIMIT_DISABLED;
  try {
    const host = sA.tenant.domains[0];
    for (let i = 0; i < 30; i++) eq((await get(host, "560001", "10.9.9.9")).status, 200, `request ${i + 1}:`);
    eq((await get(host, "560001", "10.9.9.9")).status, 429, "31st:");
    eq((await get(host, "560001", "10.9.9.10")).status, 200, "another IP:");
  } finally {
    process.env.RATE_LIMIT_DISABLED = "1";
  }
});

// ---- 5. import walk and stored JSON -----------------------------------------------
console.log("— boundaries");

// The Edge runtime's own node: APIs (lib/tenant-context.js's AsyncLocalStorage);
// anything else (fs, path, crypto …) fails.
const EDGE_NODE = new Set(["node:async_hooks", "node:buffer"]);
// Follows relative and "@/" imports (static and dynamic) from the storefront's
// entry files; packages are not followed, but a node: one is a failure.
async function walk(file, seen = new Map(), from = null) {
  if (seen.has(file)) return seen;
  seen.set(file, from);
  const text = await readFile(file, "utf8");
  for (const [, spec] of text.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)) {
    ok(!spec.startsWith("node:") || EDGE_NODE.has(spec), `${relative(ROOT, file)} imports ${spec}`);
    let base;
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(file), spec);
    else continue;
    const hit = [base, `${base}.js`, `${base}.ts`, `${base}.tsx`, join(base, "index.js")].find((p) => existsSync(p) && !p.endsWith("/"));
    if (!hit || hit.endsWith(".json") || hit.endsWith(".css")) {
      ok(!/[/\\]data[/\\]/.test(base), `${relative(ROOT, file)} imports ${spec}`);
      continue;
    }
    await walk(hit, seen, file);
  }
  return seen;
}

await t("the storefront layout, product and checkout pages never reach data/, the pincode server side or node:*", async () => {
  const entries = ["app/(storefront)/layout.js", "app/(storefront)/checkout/page.js", "app/(storefront)/products/[handle]/page.js", "app/(storefront)/checkout/confirmation/[orderId]/page.js"];
  const seen = new Map();
  for (const e of entries) await walk(join(ROOT, e), seen);
  const files = [...seen.keys()].map((f) => relative(ROOT, f));
  for (const must of ["components/checkout/PincodeField.js", "components/pdp/DeliveryCheck.js", "lib/delivery-estimate.js", "lib/pincode/client.js"]) ok(files.includes(must), `the walk never reached ${must} (${files.length} files)`);
  for (const f of files) {
    ok(!f.startsWith("data/"), `${f} is in data/`);
    ok(!["lib/pincode/index.js", "lib/pincode/offline.js"].includes(f), `${f} reached from ${relative(ROOT, seen.get(join(ROOT, f)) || "")}`);
  }
});

await t("an existing store's shipping JSON is unchanged by the form's new blank fields", () => {
  const stored = [
    { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null, zones: [] },
    { currency: "INR", basis: "gross", freeThreshold: null, flatRate: 0, codFee: 0, codFeeWaivedAt: 1500, zones: [{ label: "Remote", prefixes: ["19", "18"], flatRate: 149, freeThreshold: 1999 }] },
  ];
  for (const cfg of stored) {
    // what ShippingForm's toState sends back for a store that never set the new fields
    const form = {
      ...cfg,
      dispatchDays: "",
      deliveryDays: { min: "", max: "" },
      zones: cfg.zones.map((z) => ({ label: z.label, prefixes: z.prefixes.join(", "), flatRate: String(z.flatRate ?? ""), freeThreshold: String(z.freeThreshold ?? ""), deliveryDays: { min: "", max: "" }, cod: "" })),
    };
    const res = validateShippingConfig(form);
    ok(res.ok, res.errors.join("; "));
    eq(res.value, cfg, "stored JSON changed:");
  }
});

await t("no outside call was made", () => eq(fetchCalls, []));

await platform.cleanup();
for (const s of [sA, sB, sC]) await s.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
