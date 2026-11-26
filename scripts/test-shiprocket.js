// Phase 9 line 4 suite: Shiprocket delivery estimates and parcel tracking.
//   normalize: statuses, scans (no names or phone numbers, ≤ 50), RTO, serviceability
//   the provider: stub refuses in production, the token cached encrypted for
//     9 days (a 401 logs in again), the PIN cache for 12 h, courierFetch's
//     URL rules (no network)
//   the estimate source: "store" gives back the Phase 8 estimate itself (same
//     object, same bytes); Shiprocket only when chosen and the plugin is on
//     and not killed; unserviceable says so; a 1.5 s timeout falls back
//   the webhook /api/parcel-updates: missing, wrong, another store's key and an
//     old key past its overlap → 401; > 64 KB → 413; a body claiming
//     "delivered" while Shiprocket says "in transit" stores "in transit";
//     an unknown AWB is ignored; delivered emits order.delivery_updated once
//   the sweep: stale open parcels and new fulfilments, ≤ 50
//   the order page block: only ctx.id's parcel; store B never sees A's
//   the console: parcel-key per role (support reads, staff 403), rotate audited,
//     the key shown once and never read back; the shipment card's data has no PII
//   the import walk: lib/couriers and the plugin's server code are unreachable
//     from app/(storefront) and components/
//   pnpm test:shiprocket
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
H.spyOnRequireAdmin();
process.env.DATABASE_URL = "file:.test-parcel-default.db";
process.env.PLATFORM_SECRET = "test-parcel-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.NODE_ENV = "test";
const STUB_DIR = join(tmpdir(), `storeasy-parcel-test-${process.pid}`);
process.env.SHIPROCKET_STUB_DIR = STUB_DIR;
delete process.env.SHIPROCKET_PROVIDER;
const network = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack && !e.message ? e.stack : e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();
const fx = (name) => JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/shiprocket", `${name}.json`), "utf8"));
const PII = /Ramesh|Kumar|Anita|Desai|Neha|OTP|Consignee|9876|98765|\+91/;
const withAwb = (name, awb) => JSON.parse(JSON.stringify(fx(name)).replaceAll("__AWB__", awb));

const N = await import("../lib/couriers/normalize.js");
const SR = await import("../lib/couriers/shiprocket.js");
const { stub } = await import("../lib/couriers/stub.js");
const { courierFetch } = await import("../lib/couriers/http.js");
const TR = await import("../lib/couriers/tracking.js");
const SH = await import("../lib/shipments.js");
const ES = await import("../lib/delivery/estimate-source.js");
const BLK = await import("../lib/plugins/first-party/shiprocket/block.js");
const SW = await import("../lib/plugins/first-party/shiprocket/sweep.js");
const SWEEPS = await import("../lib/plugins/sweeps.js");
const CAT = await import("../lib/plugins/catalog.js");
const BL = await import("../lib/plugins/blocks.js");
const FLAGS = await import("../lib/platform/flags.js");
const W = await import("../lib/platform/worker.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { getJobByKey } = await import("../lib/platform/jobs.js");
const { decryptSecret } = await import("../lib/platform/crypto.js");

// --- pure: normalize -------------------------------------------------------------
await t("normalize: Shiprocket's labels map to the seven statuses", () => {
  const cases = { "IN TRANSIT": "in_transit", "PICKED UP": "in_transit", "REACHED AT DESTINATION HUB": "in_transit", "OUT FOR DELIVERY": "out_for_delivery", DELIVERED: "delivered", "RTO IN TRANSIT": "returning", "RTO DELIVERED": "returning", CANCELED: "cancelled", UNDELIVERED: "exception", LOST: "exception", "PICKUP SCHEDULED": "placed", "AWB ASSIGNED": "placed", "": "placed" };
  for (const [label, want] of Object.entries(cases)) eq(N.normalizeStatus(label), want, `${label}:`);
  ok(N.STATUSES.length === 7, "seven statuses");
  eq(N.shiprocketTime("2026-11-27 10:15:00"), "2026-11-27T04:45:00.000Z", "India time to UTC:");
});

await t("normalize: tracking keeps time, hub and activity only; names and phone numbers are taken out; oldest first; ≤ 50 scans", () => {
  const p = N.parseTrack(withAwb("track-delivered", "AWBX1001"));
  eq(p.status, "delivered", "status:");
  eq(p.statusLabel, "DELIVERED", "Shiprocket's label kept:");
  eq(p.deliveredAt, "2026-11-30T08:35:00.000Z", "delivered at:");
  eq(p.etd, "2026-12-01T12:30:00.000Z", "etd:");
  eq(p.scans.length, 5, "scans:");
  eq(p.scans.at(-1).activity, "Delivered", "Shiprocket's label, not the courier's words:");
  eq(JSON.stringify(p.scans.map((x) => x.activity)), JSON.stringify(["Picked up", "In transit", "Reached at destination hub", "Out for delivery", "Delivered"]), "every scan is a status label:");
  ok(!PII.test(JSON.stringify(p)), `no name, phone or OTP note: ${JSON.stringify(p.scans)}`);
  // the courier's free text never survives, whatever it says
  const raw = withAwb("track-in-transit", "AWBX1009");
  raw.tracking_data.shipment_track_activities = ["Consignee Ramesh Kumar not available", "Shipment picked up from Anita Desai", "OTP verified by Neha"].map((activity, i) => ({ date: `2026-11-2${i + 1} 10:00:00`, activity, location: "Pune_Hub" }));
  const q = N.parseTrack(raw);
  ok(q.scans.length === 3 && !PII.test(JSON.stringify(q)), `no names from free text: ${JSON.stringify(q.scans)}`);
  ok(p.scans.every((s) => Object.keys(s).join(",") === "at,hub,activity"), "scan keys");
  ok(p.scans[0].at < p.scans.at(-1).at, "oldest first");
  const many = withAwb("track-in-transit", "AWBX1002");
  many.tracking_data.shipment_track_activities = Array.from({ length: 80 }, (_, i) => ({ date: `2026-11-${String(1 + (i % 28)).padStart(2, "0")} ${String(i % 24).padStart(2, "0")}:00:00`, activity: `Scan ${i}`, location: "Hub" }));
  eq(N.parseTrack(many).scans.length, 50, "capped at 50:");
  eq(N.parseTrack({}), null, "unreadable:");
});

await t("normalize: a label outside Shiprocket's vocabulary is never kept (parcel or scan): the status's plain words instead", () => {
  const raw = withAwb("track-delivered", "AWBX1010");
  raw.tracking_data.shipment_track[0].current_status = "DELIVERED TO RAMESH 9876543210";
  raw.tracking_data.shipment_track_activities[0]["sr-status-label"] = "DELIVERED TO RAMESH 9876543210";
  const p = N.parseTrack(raw);
  eq(p.status, "delivered", "status still read:");
  eq(p.statusLabel, "Delivered", "parcel label:");
  eq(p.scans.at(-1).activity, "Delivered", "scan label:");
  ok(!PII.test(JSON.stringify(p)) && !/RAMESH/i.test(JSON.stringify(p)), `no name or phone: ${JSON.stringify(p)}`);
  eq(N.parseTrack(withAwb("track-in-transit", "AWBX1011")).statusLabel, "IN TRANSIT", "a known label is kept:");
});

await t("normalize: the RTO fixture is returning, with its return AWB", () => {
  const p = N.parseTrack(withAwb("track-rto", "AWBX1003"));
  eq(p.status, "returning", "status:");
  eq(p.returnAwb, "RTOAWBX1003", "return AWB:");
  eq(p.deliveredAt, null, "not delivered:");
});

await t("normalize: serviceability gives the fastest and slowest courier days; none is unserviceable", () => {
  eq(JSON.stringify(N.parseServiceability(fx("serviceability"))), JSON.stringify({ serviceable: true, cod: true, minDays: 3, maxDays: 6 }), "serviceable:");
  eq(N.parseServiceability(fx("serviceability-none")).serviceable, false, "none:");
  eq(N.parseServiceability("x"), null, "unreadable:");
});

// --- the provider ----------------------------------------------------------------
await t("provider: the stub outside production by default; never the stub in production; the seam and the stub refuse in production", async () => {
  eq(SR.courierProvider()?.name, "stub", "default here:");
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    eq(SR.courierProvider()?.name, "live", "production default:");
    process.env.SHIPROCKET_PROVIDER = "stub";
    eq(SR.courierProvider(), null, "the stub is never picked in production:");
    let threw = false;
    try {
      await stub.track({ awb: "AWBX1004" });
    } catch {
      threw = true;
    }
    ok(threw, "the stub refuses in production");
    threw = false;
    try {
      SR.setCourierProvider(stub);
    } catch {
      threw = true;
    }
    ok(threw, "the seam refuses in production");
  } finally {
    process.env.NODE_ENV = was;
    delete process.env.SHIPROCKET_PROVIDER;
  }
});

await t("courierFetch: only https to an allowlisted host; a private or other host is refused before any connection", async () => {
  for (const u of ["https://example.com/x", "http://apiv2.shiprocket.in/x", "https://127.0.0.1/x", "https://apiv2.shiprocket.in:8443/x"]) {
    const r = await courierFetch(u, { allowHosts: SR.EGRESS });
    eq(r.error, "refused", `${u}:`);
  }
  eq(JSON.stringify(SR.EGRESS), JSON.stringify(CAT.pluginById("shiprocket").egress), "the manifest's egress is the provider's:");
});

// --- the stores ------------------------------------------------------------------
const store = await H.makeRoleStore({ name: "parcel" });
const { a, b, call } = store;
const { db } = await import("../lib/db.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const inA = (fn) => a.run(fn);
const inB = (fn) => b.run(fn);
const MERCHANT = ["owner", "admin", "staff", "support"];

let orderN = 0;
const BUYER = { email: "parcelbuyer@example.test", phone: "9876512345", name: "Parcelname Buyer", address_line1: "12 Parceladdr Road", city: "Pune", pincode: "411001" };
async function makeOrder(run, { awb = null, estimate = { minDays: 2, maxDays: 4 } } = {}) {
  const id = `BL-PARCEL${String(++orderN).padStart(4, "0")}`;
  const now = "2026-11-26T05:00:00.000Z";
  await run(async () => {
    await db.insertInto("orders").values({ id, ...BUYER, state: "MH", country: "IN", subtotal: 500, discount_total: 0, shipping_total: 0, total: 500, currency: "INR", payment_method: "cod", payment_status: "cod", status: "synced", snapshot: JSON.stringify({ shipping: { estimate } }), created_at: now, updated_at: now }).execute();
    if (awb) await db.insertInto("order_fulfillments").values({ id: `ful_${id}`, order_id: id, status: "SUCCESS", tracking_company: "Delhivery", tracking_number: awb, tracking_url: null, updated_at: now }).execute();
  });
  return id;
}

// install, configure (stub credentials) and enable Shiprocket on a store
async function installShiprocket(caller, host, settings = {}) {
  const r = await call(caller, "apps", "POST", { host, body: { install: { pluginId: "shiprocket", scopes: ["orders.read"] } } });
  ok(r.status === 200, `install: ${r.text.slice(0, 200)}`);
  const id = r.body.install.id;
  const s = await call(caller, "apps/[id]", "POST", { host, params: { id }, body: { settings: { api_email: "api-user@example.test", api_password: "stub-pass-123", pickup_pin: "411001", default_weight_g: 500, estimate_source: "store", ...settings } } });
  ok(s.status === 200, `settings: ${s.text.slice(0, 300)}`);
  return id;
}
const setSettings = (id, settings, host = a.tenant.domains[0], caller = "owner") => call(caller, "apps/[id]", "POST", { host, params: { id }, body: { settings: { api_email: "api-user@example.test", pickup_pin: "411001", default_weight_g: 500, estimate_source: "store", ...settings } } });

const hostA = a.tenant.domains[0];
const hostB = b.tenant.domains[0];
const before = await inA(() => ES.estimateFor({ pin: "560001", storeEstimate: { minDays: 2, maxDays: 4 } }));

await t("estimate source, no install: the store's own estimate, unchanged", () => eq(JSON.stringify(before), '{"minDays":2,"maxDays":4}', "Phase 8:"));

const installId = await installShiprocket("owner", hostA);
const pins = [];
SR.setCourierProvider({
  name: "spy",
  login: async (c, o) => {
    pins.push("login");
    return stub.login(c, o);
  },
  serviceability: async (q, o) => {
    pins.push(q.pin);
    return stub.serviceability(q, o);
  },
  track: (q, o) => stub.track(q, o),
});

await t("estimate source \"store\" (the default): byte-identical to Phase 8 (the same object; null stays null; a bad PIN too)", async () => {
  const est = { minDays: 2, maxDays: 4 };
  await inA(async () => {
    ok((await ES.estimateFor({ pin: "560001", storeEstimate: est })) === est, "the same object");
    eq(await ES.estimateFor({ pin: "560001", storeEstimate: null }), null, "null:");
    eq(await ES.estimateFor({ pin: "560001" }), null, "absent:");
    ok((await ES.estimateFor({ pin: "12", storeEstimate: est })) === est, "a bad PIN");
  });
  eq(pins.length, 0, "Shiprocket was never asked:");
});

await t("settings: weight outside 100 g–30 kg and an unknown source are refused; staff and support can't save (403)", async () => {
  eq((await setSettings(installId, { default_weight_g: 50 })).status, 422, "50 g:");
  eq((await setSettings(installId, { default_weight_g: 30001 })).status, 422, "30.001 kg:");
  eq((await setSettings(installId, { estimate_source: "courier" })).status, 422, "unknown source:");
  for (const caller of ["staff", "support"]) eq((await setSettings(installId, { estimate_source: "shiprocket" }, hostA, caller)).status, 403, `${caller}:`);
});

await t("estimate source \"shiprocket\": courier days from the stub, cached 12 h per PIN; unserviceable says so (store dates kept); the token is cached encrypted", async () => {
  eq((await setSettings(installId, { estimate_source: "shiprocket" })).status, 200, "chosen:");
  pins.length = 0;
  const T0 = Date.parse("2026-11-26T06:00:00.000Z");
  const clock = SR.courierClock.now;
  SR.courierClock.now = () => T0;
  try {
    await inA(async () => {
      eq(JSON.stringify(await ES.estimateFor({ pin: "560001", storeEstimate: { minDays: 2, maxDays: 4 } })), '{"minDays":3,"maxDays":6}', "courier days:");
      eq(JSON.stringify(await ES.estimateFor({ pin: "560001", storeEstimate: { minDays: 2, maxDays: 4 } })), '{"minDays":3,"maxDays":6}', "again:");
      eq(pins.filter((p) => p === "560001").length, 1, "asked once (cached):");
      eq(pins.filter((p) => p === "login").length, 1, "one login:");
      const row = await db.selectFrom("courier_auth").selectAll().executeTakeFirst();
      ok(row && !row.token_enc.includes("stub-token"), "the token is stored encrypted");
      eq(await decryptSecret(row.token_enc), "stub-token-0000", "and decrypts:");
      eq(row.expires_at, new Date(T0 + 9 * 86_400_000).toISOString(), "9 days:");
      SR.courierClock.now = () => T0 + 12 * 3_600_000 + 1;
      await ES.estimateFor({ pin: "560001", storeEstimate: null });
      eq(pins.filter((p) => p === "560001").length, 2, "after 12 h it is asked again:");
      eq(JSON.stringify(await ES.estimateFor({ pin: "799999", storeEstimate: { minDays: 2, maxDays: 4 } })), '{"minDays":2,"maxDays":4,"serviceable":false}', "unserviceable:");
      eq(JSON.stringify(await ES.estimateFor({ pin: "799999", storeEstimate: null })), '{"serviceable":false}', "unserviceable, no store days:");
    });
  } finally {
    SR.courierClock.now = clock;
  }
});

await t("estimate source: a courier that doesn't answer in 1.5 s falls back to the store's estimate", async () => {
  const est = { minDays: 2, maxDays: 4 };
  const t0 = Date.now();
  const r = await inA(() => ES.estimateFor({ pin: "799998", storeEstimate: est }));
  const ms = Date.now() - t0;
  ok(r === est, `the store's own estimate: ${JSON.stringify(r)}`);
  ok(ms >= 1400 && ms < 2500, `after about 1.5 s: ${ms} ms`);
  ok((await inA(() => ES.estimateFor({ pin: "560002", storeEstimate: est }))) !== est, "a quick answer is still the courier's");
  const was = ES.estimateDeps.courier;
  ES.estimateDeps.courier = async () => {
    throw new Error("boom");
  };
  try {
    ok((await inA(() => ES.estimateFor({ pin: "560003", storeEstimate: est }))) === est, "a failure falls back");
  } finally {
    ES.estimateDeps.courier = was;
  }
});

await t("estimate source: a 401 logs in again; turned off or killed → the store's estimate", async () => {
  await inA(async () => {
    const tok = await db.selectFrom("courier_auth").selectAll().executeTakeFirst();
    let n = 0;
    const seen = [];
    SR.setCourierProvider({
      name: "spy401",
      login: async () => ({ ok: true, status: 200, json: { token: `fresh-${++n}` } }),
      serviceability: async (q) => {
        seen.push(q.token);
        return seen.length === 1 ? { ok: false, status: 401, json: null } : stub.serviceability(q);
      },
      track: () => null,
    });
    const r = await SR.serviceability("560010", {}, { settings: { pickup_pin: "411001" }, creds: { email: "x@example.test", api_password: "p" } });
    eq(r?.serviceable, true, "answered after a fresh login:");
    eq(seen.length, 2, "two calls:");
    ok(seen[1] === "fresh-1", `the second with the fresh token: ${seen}`);
    ok(tok, "there was a cached token");
  });
  SR.setCourierProvider(stub);
  const est = { minDays: 2, maxDays: 4 };
  eq((await call("owner", "apps/[id]", "POST", { host: hostA, params: { id: installId }, body: { disable: true } })).status, 200, "turned off:");
  ok((await inA(() => ES.estimateFor({ pin: "560020", storeEstimate: est }))) === est, "off: the store's");
  eq((await call("owner", "apps/[id]", "POST", { host: hostA, params: { id: installId }, body: { enable: true } })).status, 200, "on again:");
  await FLAGS.setFlag({ key: CAT.killFlag("shiprocket"), description: "kill", default_on: false, create: true, actor: { kind: "operator", id: "opr_parcel" } });
  FLAGS.__resetFlagCache();
  try {
    ok((await inA(() => ES.estimateFor({ pin: "560021", storeEstimate: est }))) === est, "killed: the store's");
  } finally {
    await FLAGS.setFlag({ key: CAT.killFlag("shiprocket"), description: "kill", default_on: true, actor: { kind: "operator", id: "opr_parcel" } });
    FLAGS.__resetFlagCache();
  }
  ok((await inA(() => ES.estimateFor({ pin: "560022", storeEstimate: est }))) !== est, "un-killed: the courier's again");
});

// --- the webhook key ---------------------------------------------------------------
await t("parcel-key: every role reads its state (never a key or hash); staff and support can't rotate (403); owner rotates, audited", async () => {
  for (const caller of MERCHANT) {
    const g = await call(caller, "apps/[id]/parcel-key", "GET", { host: hostA, params: { id: installId } });
    eq(g.status, 200, `${caller} GET:`);
    eq(Object.keys(g.body).join(","), "ok,set,rotatedAt,address,addressWarning", `${caller} keys:`);
    eq(g.body.address, `https://${hostA}/api/parcel-updates`, "the address to paste:");
    ok(!/[a-z]*sr|kr/i.test("/api/parcel-updates"), "the path has no sr or kr");
  }
  for (const caller of ["staff", "support"]) eq((await call(caller, "apps/[id]/parcel-key", "POST", { host: hostA, params: { id: installId }, body: { rotate: true } })).status, 403, `${caller} POST:`);
  eq((await call("owner", "apps/[id]/parcel-key", "POST", { host: hostA, params: { id: installId }, body: {} })).status, 400, "no rotate:");
  eq((await call("owner-b", "apps/[id]/parcel-key", "POST", { host: hostB, params: { id: installId }, body: { rotate: true } })).status, 404, "store B can't rotate A's:");
});

let keyA;
let keyOld;
await t("parcel-key: the key shows once; GET afterwards carries neither the key nor its hash", async () => {
  const r1 = await call("owner", "apps/[id]/parcel-key", "POST", { host: hostA, params: { id: installId }, body: { rotate: true } });
  eq(r1.status, 200, "made:");
  keyOld = r1.body.key;
  ok(/^[0-9a-f]{64}$/.test(keyOld), "a 256-bit key");
  const r2 = await call("owner", "apps/[id]/parcel-key", "POST", { host: hostA, params: { id: installId }, body: { rotate: true } });
  keyA = r2.body.key;
  ok(keyA && keyA !== keyOld, "rotated");
  for (const caller of MERCHANT) {
    const g = await call(caller, "apps/[id]/parcel-key", "GET", { host: hostA, params: { id: installId } });
    ok(g.body.set === true && !g.text.includes(keyA) && !g.text.includes(keyOld), `${caller}: no key`);
    const app = await call(caller, "apps/[id]", "GET", { host: hostA, params: { id: installId } });
    ok(!app.text.includes(keyA) && !app.text.includes("__parcel_key") && !/"hash"/.test(app.text), `${caller}: the app view has no key or hash`);
  }
  const rows = await listAudit({ tenantId: a.id, limit: 100 });
  eq(rows.filter((r) => r.action === "apps.shiprocket_token_rotate").length, 2, "two audit rows:");
  ok(!JSON.stringify(rows).includes(keyA), "the audit row has no key");
  // saving settings keeps the key
  eq((await setSettings(installId, { estimate_source: "shiprocket" })).status, 200, "settings saved:");
  ok(await inA(() => TR.checkWebhookKey(keyA)), "the key survives a settings save");
});

await t("webhook key: current works; the old one only inside its 24 h overlap; missing, wrong, too short and store B's key fail", async () => {
  const now = Date.now();
  await inA(async () => {
    ok(await TR.checkWebhookKey(keyA, { now }), "current");
    ok(await TR.checkWebhookKey(keyOld, { now }), "old, inside the overlap");
    ok(!(await TR.checkWebhookKey(keyOld, { now: now + 24 * 3_600_000 + 60_000 })), "old, after the overlap");
    ok(await TR.checkWebhookKey(keyA, { now: now + 30 * 86_400_000 }), "current never expires");
    ok(!(await TR.checkWebhookKey(null)), "missing");
    ok(!(await TR.checkWebhookKey(keyA.replace(/.$/, (c) => (c === "0" ? "1" : "0")))), "wrong");
    ok(!(await TR.checkWebhookKey("short")), "too short");
  });
  const src = readFileSync(join(ROOT, "lib/couriers/tracking.js"), "utf8");
  ok(/d \|= x\.charCodeAt\(i\) \^ y\.charCodeAt\(i\)/.test(src) && !/hash\s*===|===\s*k\.hash/.test(src), "compared in constant time, never with ===");
});

const RE = await import("../app/api/parcel-updates/route.js");
async function hook(body, { key = keyA, host = hostA, raw = null } = {}) {
  const headers = { host, "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) };
  const res = await RE.POST(new NextRequest(`http://${host}/api/parcel-updates`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, text };
}

await t("webhook: missing key, wrong key and store B's key on store A → 401; nothing queued", async () => {
  const awb = "AWBPRC0001";
  const order = await makeOrder(inA, { awb });
  void order;
  const body = withAwb("webhook-delivered", awb);
  eq((await hook(body, { key: null })).status, 401, "missing:");
  eq((await hook(body, { key: "f".repeat(64) })).status, 401, "wrong:");
  // store B installs Shiprocket and makes its own key
  const bId = await installShiprocket("owner-b", hostB);
  const kb = (await call("owner-b", "apps/[id]/parcel-key", "POST", { host: hostB, params: { id: bId }, body: { rotate: true } })).body.key;
  ok(kb, "store B has a key");
  eq((await hook(body, { key: kb, host: hostA })).status, 401, "B's key on A:");
  eq((await hook(body, { key: keyA, host: hostB })).status, 401, "A's key on B:");
  await H.drainAfter();
  eq(await inA(() => SH.trackingForOrder(order)), null, "nothing written:");
});

await t("webhook: a body claiming delivered, while Shiprocket says in transit, stores in transit (the refetch is what's written)", async () => {
  const awb = "AWBPRC0002";
  const order = await makeOrder(inA, { awb });
  const r = await hook(withAwb("webhook-delivered", awb));
  eq(r.status, 200, `answered: ${r.text}`);
  await H.drainAfter();
  const tr = await inA(() => SH.trackingForOrder(order));
  eq(tr?.status, "in_transit", "Shiprocket's own answer:");
  eq(tr.statusLabel, "IN TRANSIT", "label:");
  eq(tr.awb, awb, "awb:");
  const events = await inA(() => db.selectFrom("plugin_events").selectAll().where("topic", "=", "order.delivery_updated").execute());
  eq(events.length, 0, "no delivered event from a body's claim:");
});

await t("webhook: delivered (per Shiprocket) emits order.delivery_updated once, keyed delivery:<awb>:delivered; a repeat hook queues nothing new", async () => {
  const awb = "AWBPRC0003";
  const order = await makeOrder(inA, { awb });
  mkdirSync(STUB_DIR, { recursive: true });
  writeFileSync(join(STUB_DIR, `${awb}.json`), JSON.stringify({ fixture: "track-delivered" }));
  const body = withAwb("webhook-delivered", awb);
  eq((await hook(body)).status, 200, "first:");
  eq((await hook(body)).status, 200, "repeat:");
  await H.drainAfter();
  const tr = await inA(() => SH.trackingForOrder(order));
  eq(tr?.status, "delivered", "delivered:");
  await inA(() => SW.refetchAwb(awb));
  const events = await inA(() => db.selectFrom("plugin_events").selectAll().where("topic", "=", "order.delivery_updated").execute());
  eq(events.length, 1, "one event:");
  eq(events[0].idempotency_key, `delivery:${awb}:delivered`, "key:");
  eq(events[0].resource, `order:${order}`, "resource, as emitOrderEvent:");
  const payload = JSON.parse(events[0].payload);
  eq(payload.order.id, order, "data.order.id (line 3 reads it):");
  eq(JSON.stringify(Object.keys(payload)), '["order","delivery"]', "data keys:");
  eq(JSON.stringify(Object.keys(payload.delivery)), '["awb","status","at"]', "delivery keys:");
  ok(!/Parcel|parcelbuyer|9876512345/.test(events[0].payload), "no PII in the event");
  const job = await getJobByKey(`courier_refetch:${a.id}:${awb}:${(await (await import("../lib/platform/sessions.js")).sha256Hex(`${awb}|DELIVERED|2026-11-30 14:05:00`)).slice(0, 16)}`);
  ok(job, "one courier_refetch job for that update");
});

await t("webhook: an unknown AWB is ignored (200, no job, nothing written); unusable bodies answer 200; over 64 KB → 413", async () => {
  const r = await hook(withAwb("webhook-delivered", "AWBNOTOURS1"));
  eq(r.status, 200, "unknown:");
  await H.drainAfter();
  eq(await inA(() => db.selectFrom("shipment_tracking").select("awb").where("awb", "=", "AWBNOTOURS1").executeTakeFirst()), undefined, "nothing written:");
  eq((await hook(null, { raw: "not json" })).status, 200, "not JSON:");
  eq((await hook({ awb: "../../x" })).status, 200, "a bad AWB:");
  eq((await hook(null, { raw: JSON.stringify({ awb: "AWBPRC0002", pad: "x".repeat(70 * 1024) }) })).status, 413, "too large:");
  eq((await hook(null, { raw: "x".repeat(70 * 1024), key: null })).status, 401, "a wrong key is refused before the body is read:");
});

await t("the worker: courier_refetch is a handler; a turned-off install writes nothing", async () => {
  eq(typeof W.HANDLERS.courier_refetch, "function", "handler:");
  const awb = "AWBPRC0004";
  const order = await makeOrder(inA, { awb });
  eq((await call("owner", "apps/[id]", "POST", { host: hostA, params: { id: installId }, body: { disable: true } })).status, 200, "off:");
  eq(JSON.stringify(await inA(() => SW.refetchAwb(awb))), '{"skipped":"inactive"}', "skipped:");
  eq(await inA(() => SH.trackingForOrder(order)), null, "nothing:");
  eq((await call("owner", "apps/[id]", "POST", { host: hostA, params: { id: installId }, body: { enable: true } })).status, 200, "on:");
  eq((await hook(withAwb("webhook-delivered", awb), { key: null })).status, 401, "still needs the key:");
});

await t("event contract: deliveryEvent is emitOrderEvent's shape (resource order:<id>, data.order.id, data.delivery)", () => {
  const e = TR.deliveryEvent({ orderId: "BL-1", awb: "AWB1234", status: "delivered", at: "2026-11-30T09:00:00.000Z" });
  eq(JSON.stringify(e), JSON.stringify({ resource: "order:BL-1", key: "delivery:AWB1234:delivered", data: { order: { id: "BL-1" }, delivery: { awb: "AWB1234", status: "delivered", at: "2026-11-30T09:00:00.000Z" } } }), "shape:");
});

await t("event retry: the emit fails once after the write; the retry (same status) still emits, once", async () => {
  const awb = "AWBPRC0005";
  const order = await makeOrder(inA, { awb });
  const parsed = N.parseTrack(withAwb("track-delivered", awb));
  await inA(async () => {
    const { sql } = await import("kysely");
    await sql`CREATE TRIGGER parcel_emit_fail BEFORE INSERT ON plugin_events BEGIN SELECT RAISE(FAIL, 'emit down'); END`.execute(db);
    let threw = false;
    try {
      await TR.applyTracking(awb, parsed, {});
    } catch {
      threw = true;
    }
    ok(threw, "the first emit failed");
    eq((await SH.trackingForOrder(order))?.status, "delivered", "the write landed:");
    await sql`DROP TRIGGER parcel_emit_fail`.execute(db);
    await TR.applyTracking(awb, parsed, {});
    await TR.applyTracking(awb, parsed, {});
    const rows = await db.selectFrom("plugin_events").select("id").where("idempotency_key", "=", `delivery:${awb}:delivered`).execute();
    eq(rows.length, 1, "one event after the retry:");
  });
});

// --- the sweep ---------------------------------------------------------------------
await t("sweep: registered at BUILT_IN; polls new fulfilments and parcels not fetched for 4 h (≤ 50), never delivered or fresh ones", async () => {
  eq(SWEEPS.sweepFor("shiprocket"), SW.shiprocketSweep, "built in:");
  const T = Date.parse("2026-11-28T00:00:00.000Z");
  const fresh = await makeOrder(inA, { awb: "AWBPRC0010" });
  const stale = await makeOrder(inA, { awb: "AWBPRC0011" });
  await inA(async () => {
    await TR.applyTracking("AWBPRC0011", N.parseTrack(withAwb("track-in-transit", "AWBPRC0011")), { now: T - 5 * 3_600_000 });
    await TR.applyTracking("AWBPRC0010", N.parseTrack(withAwb("track-in-transit", "AWBPRC0010")), { now: T - 3_600_000 });
    const due = await TR.dueShipments({ now: T });
    const awbs = due.map((d) => d.awb);
    ok(awbs.includes("AWBPRC0011"), "stale is due");
    ok(!awbs.includes("AWBPRC0010"), "fresh is not");
    ok(!awbs.includes("AWBPRC0003"), "delivered is not");
    ok(awbs.includes("AWBPRC0004"), "a fulfilment with no row yet is due");
    eq((await TR.dueShipments({ now: T, limit: 1 })).length, 1, "the limit holds:");
    eq(TR.SWEEP_LIMIT, 50, "50 a run:");
    const row = await db.selectFrom("plugin_installs").selectAll().where("id", "=", installId).executeTakeFirst();
    const { decryptJson } = await import("../lib/platform/crypto.js");
    const settings = JSON.parse(row.settings);
    const r = await SW.shiprocketSweep({ install: { id: installId, pluginId: "shiprocket", settings }, now: T, secrets: async () => decryptJson(row.secrets_enc), log: () => {} });
    ok(r.polled >= 2, `polled: ${JSON.stringify(r)}`);
    eq((await SH.trackingForOrder(stale)).fetchedAt, new Date(T).toISOString(), "stale refetched:");
    eq((await SH.trackingForOrder(fresh)).fetchedAt, new Date(T - 3_600_000).toISOString(), "fresh untouched:");
  });
});

await t("sweep: an AWB Shiprocket doesn't know gets a hidden placeholder and moves out of the due list; a failed login stops the run", async () => {
  const T = Date.parse("2026-12-05T00:00:00.000Z");
  const order = await makeOrder(inA, { awb: "AWBMISS001" });
  const asked = [];
  SR.setCourierProvider({ name: "miss", login: stub.login, serviceability: stub.serviceability, track: async (q) => (asked.push(q.awb), { ok: false, status: 404, json: null }) });
  try {
    await inA(async () => {
      const row = await db.selectFrom("plugin_installs").selectAll().where("id", "=", installId).executeTakeFirst();
      const { decryptJson } = await import("../lib/platform/crypto.js");
      const install = { id: installId, pluginId: "shiprocket", settings: JSON.parse(row.settings) };
      const secrets = async () => decryptJson(row.secrets_enc);
      ok((await TR.dueShipments({ now: T })).some((d) => d.awb === "AWBMISS001"), "due before");
      await SW.shiprocketSweep({ install, now: T, secrets });
      ok(asked.includes("AWBMISS001"), "asked once");
      ok(!(await TR.dueShipments({ now: T + 60_000 })).some((d) => d.awb === "AWBMISS001"), "not due again in the next run");
      ok((await TR.dueShipments({ now: T + 5 * 3_600_000 })).some((d) => d.awb === "AWBMISS001"), "due again after 4 h");
      eq(await SH.trackingForOrder(order), null, "the placeholder is never shown:");
      // a refused login: one login attempt, no parcel asked, the run stops
      let logins = 0;
      SR.setCourierProvider({ name: "nologin", login: async () => (logins++, { ok: false, status: 401, json: null }), serviceability: stub.serviceability, track: async (q) => (asked.push(q.awb), stub.track(q)) });
      await db.deleteFrom("courier_auth").execute();
      asked.length = 0;
      const r = await SW.shiprocketSweep({ install, now: T + 5 * 3_600_000, secrets });
      eq(r.stopped, "login", "stopped:");
      eq(logins, 1, "one login attempt:");
      eq(asked.length, 0, "no parcel asked:");
    });
  } finally {
    SR.setCourierProvider(stub);
  }
});

await t("sweep: an unmatched placeholder stops being polled after 7 days; a fulfilment older than 30 days is never first-polled", async () => {
  const T = Date.parse("2026-12-10T00:00:00.000Z");
  await makeOrder(inA, { awb: "AWBMISS002" });
  const old = await makeOrder(inA);
  await inA(async () => {
    await db.insertInto("order_fulfillments").values({ id: `ful_${old}`, order_id: old, status: "SUCCESS", tracking_company: "Delhivery", tracking_number: "AWBOLD0001", tracking_url: null, updated_at: new Date(T - 31 * 86_400_000).toISOString() }).execute();
    ok(!(await TR.dueShipments({ now: T, limit: 500 })).some((d) => d.awb === "AWBOLD0001"), "a 31-day-old fulfilment is not first-polled");
    await TR.markFetched("AWBMISS002", { orderId: (await TR.orderIdForAwb("AWBMISS002")), now: T });
    ok((await TR.dueShipments({ now: T + 5 * 3_600_000, limit: 500 })).some((d) => d.awb === "AWBMISS002"), "re-polled inside its first 7 days");
    ok(!(await TR.dueShipments({ now: T + 7 * 86_400_000 + 3_600_000, limit: 500 })).some((d) => d.awb === "AWBMISS002"), "not after 7 days");
  });
});

await t("caches: saving settings forgets the API token; a new pickup PIN forgets the PIN answers; uninstall forgets both", async () => {
  const count = (table) => inA(async () => (await db.selectFrom(table).select(db.fn.countAll().as("n")).executeTakeFirst()).n);
  await inA(() => SR.serviceability("560099", {}, { settings: { pickup_pin: "411001" }, creds: { email: "api-user@example.test", api_password: "p" } }));
  ok(Number(await count("courier_auth")) === 1 && Number(await count("courier_pin_cache")) > 0, "both cached");
  eq((await setSettings(installId, { estimate_source: "shiprocket" })).status, 200, "saved, same PIN:");
  eq(Number(await count("courier_auth")), 0, "token forgotten:");
  ok(Number(await count("courier_pin_cache")) > 0, "PIN answers kept (same pickup PIN)");
  eq((await setSettings(installId, { estimate_source: "shiprocket", pickup_pin: "560001" })).status, 200, "new pickup PIN:");
  eq(Number(await count("courier_pin_cache")), 0, "PIN answers forgotten:");
  await inA(() => SR.serviceability("560099", {}, { settings: { pickup_pin: "560001" }, creds: { email: "api-user@example.test", api_password: "p" } }));
  await setSettings(installId, { estimate_source: "shiprocket" }); // back to 411001
});

// --- the order page block ------------------------------------------------------------
await t("block: Tracking (tracking_timeline in storefront.order.status) starts Off; its props pass the primitive's checks, empty included", async () => {
  const m = CAT.pluginById("shiprocket");
  const blk = m.blocks.find((x) => x.id === "tracking");
  eq(blk.primitive, "tracking_timeline", "primitive:");
  eq(JSON.stringify(blk.slots), '["storefront.order.status"]', "slot:");
  const blocks = await call("owner", "apps/[id]/blocks", "GET", { host: hostA, params: { id: installId } });
  ok(blocks.body.blocks.length === 1 && blocks.body.blocks[0].state === "off" && blocks.body.blocks[0].slot === "storefront.order.status", `starts Off: ${blocks.text.slice(0, 300)}`);
  eq(BL.validateBlockProps("tracking_timeline", await inA(() => blk.data({}, {}))).ok, true, "empty (going Live):");
  const order = await makeOrder(inA, { awb: "AWBPRC0020" });
  await inA(() => TR.applyTracking("AWBPRC0020", N.parseTrack(withAwb("track-delivered", "AWBPRC0020")), { now: Date.parse("2026-11-30T09:00:00.000Z") }));
  const props = await inA(() => blk.data({ id: order }, {}));
  const v = BL.validateBlockProps("tracking_timeline", props);
  ok(v.ok, `valid: ${JSON.stringify(v.errors)}`);
  eq(v.props.headline, "Delivered", "headline:");
  eq(v.props.expected, "Delivered Mon 30 Nov", "when:");
  eq(v.props.steps[0].activity, "Delivered", "newest first:");
  eq(v.props.awb, "AWBPRC0020", "awb:");
  ok(!PII.test(JSON.stringify(v.props)) && !/Parcelname/.test(JSON.stringify(v.props)), "no names, phones or OTP notes");
});

await t("block: expected by the courier's ETD once shipped; the order's own estimate before pickup", async () => {
  const shipped = await makeOrder(inA, { awb: "AWBPRC0021" });
  await inA(() => TR.applyTracking("AWBPRC0021", N.parseTrack(withAwb("track-in-transit", "AWBPRC0021")), {}));
  eq((await inA(() => BLK.trackingProps({ id: shipped }))).expected, "Expected by Tue 1 Dec", "ETD:");
  const waiting = await makeOrder(inA, { awb: "AWBPRC0022", estimate: { minDays: 2, maxDays: 4 } });
  await inA(() => TR.applyTracking("AWBPRC0022", { courier: null, status: "placed", statusLabel: "PICKUP SCHEDULED", etd: null, deliveredAt: null, returnAwb: null, scans: [], lastEventAt: null }, {}));
  eq((await inA(() => BLK.trackingProps({ id: waiting }))).expected, "Expected by Mon 30 Nov", "the snapshot's estimate from the order time:");
});

await t("block: order A's context shows only A's parcel; another order shows nothing; store B never sees A's parcels", async () => {
  const withParcel = await makeOrder(inA, { awb: "AWBPRC0030" });
  const without = await makeOrder(inA);
  await inA(() => TR.applyTracking("AWBPRC0030", N.parseTrack(withAwb("track-in-transit", "AWBPRC0030")), {}));
  eq((await inA(() => BLK.trackingProps({ id: withParcel }))).awb, "AWBPRC0030", "A's own:");
  eq(JSON.stringify(await inA(() => BLK.trackingProps({ id: without }))), "{}", "another order: nothing:");
  eq(JSON.stringify(await inA(() => BLK.trackingProps({}))), "{}", "no order: nothing:");
  eq(JSON.stringify(await inB(() => BLK.trackingProps({ id: withParcel }))), "{}", "store B: nothing:");
  eq(await inB(() => TR.orderIdForAwb("AWBPRC0030")), null, "store B doesn't know A's AWB:");
  const page = readFileSync(join(ROOT, "app/(storefront)/orders/[orderId]/page.js"), "utf8");
  ok(page.indexOf("verifyOrderStatusToken") < page.indexOf('<PluginSlot name="storefront.order.status"'), "the slot sits after the order page's token check");
});

await t("console: the shipment card's data (orders.read) carries no customer details; the admin order page reads it", async () => {
  const order = await makeOrder(inA, { awb: "AWBPRC0040" });
  await inA(() => TR.applyTracking("AWBPRC0040", N.parseTrack(withAwb("track-delivered", "AWBPRC0040")), {}));
  const s = await inA(() => SH.trackingForOrder(order));
  ok(!PII.test(JSON.stringify(s)) && !/Parcelname|parcelbuyer|Parceladdr/.test(JSON.stringify(s)), "no PII");
  const page = readFileSync(join(ROOT, "app/(console)/admin/(authed)/orders/[id]/page.js"), "utf8");
  ok(/roleAllows\(actor\.role, "orders\.read"\)/.test(page) && /trackingForOrder\(id\)/.test(page) && /<ShipmentCard /.test(page), "the order view (orders.read) renders it");
});

await t("caches: uninstalling Shiprocket forgets the API token and the PIN answers", async () => {
  const bInstall = (await call("owner-b", "apps", "GET", { host: hostB })).body.installs.find((i) => i.pluginId === "shiprocket");
  await inB(() => SR.serviceability("560098", {}, { settings: { pickup_pin: "411001" }, creds: { email: "api-user@example.test", api_password: "p" } }));
  const n = (table) => inB(async () => Number((await db.selectFrom(table).select(db.fn.countAll().as("n")).executeTakeFirst()).n));
  ok((await n("courier_auth")) === 1 && (await n("courier_pin_cache")) === 1, "store B cached both");
  eq((await call("owner-b", "apps/[id]", "POST", { host: hostB, params: { id: bInstall.id }, body: { uninstall: true } })).status, 200, "uninstalled:");
  eq(await n("courier_auth"), 0, "token gone:");
  eq(await n("courier_pin_cache"), 0, "PIN answers gone:");
});

// --- the import walk -------------------------------------------------------------------
const walk = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
function resolveImport(from, spec) {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(join(ROOT, from)), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.js`, `${base}.mjs`, join(base, "index.js")]) if (existsSync(c) && !c.endsWith("/")) try {
    if (readdirSync(c)) continue;
  } catch {
    return relative(ROOT, c);
  }
  return null;
}
// Entries: every app/(storefront) and components/ file, each walked on its own.
// The one exception is the one test-plugin-webhooks pins for egress.js, for
// the same reason: the platform's own pricing page reaches lib/platform/worker.js
// through its signup flow, and the worker loads the plugin's server code with a
// dynamic import only when a courier_refetch job runs.
const REACH_OK = { "app/(storefront)/pricing/page.js": "signup flow → worker.js (dynamic import per job type)" };
function reachesFrom(entry, targets) {
  const seen = new Set();
  const queue = [entry];
  const hits = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (targets.has(f)) hits.push(f);
    const src = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)["']([^"']+)["']/gm)) {
      const r = resolveImport(f, m[1]);
      if (r) queue.push(r);
    }
  }
  return { hits, seen };
}
await t("import walk: lib/couriers/*, lib/couriers/tracking.js and the plugin's sweep are unreachable from app/(storefront) and components/ (static and dynamic imports); the one known Node page is pinned", () => {
  const targets = new Set(["lib/couriers/shiprocket.js", "lib/couriers/http.js", "lib/couriers/stub.js", "lib/couriers/tracking.js", "lib/plugins/first-party/shiprocket/sweep.js", "lib/plugins/egress.js"]);
  const entries = [...walk("app/(storefront)"), ...walk("components")].filter((f) => /\.(js|mjs|jsx|ts|tsx)$/.test(f));
  ok(entries.length > 50, `entries: ${entries.length}`);
  const bad = [];
  const okSeen = [];
  let blockReached = false;
  for (const e of entries) {
    const { hits, seen } = reachesFrom(e, targets);
    if (seen.has("lib/plugins/first-party/shiprocket/block.js") && seen.has("lib/shipments.js")) blockReached = true;
    if (!hits.length) continue;
    if (REACH_OK[e]) okSeen.push(e);
    else bad.push(`${e} → ${hits.join(", ")}`);
  }
  ok(blockReached, "the walk does reach the block's reads");
  eq(bad.join("\n"), "", "reached:");
  eq(okSeen.join(","), Object.keys(REACH_OK).join(","), "REACH_OK lists only files that really reach them:");
});

await t("no network: nothing reached fetch()", () => eq(network.length, 0, network.join(", ")));

rmSync(STUB_DIR, { recursive: true, force: true });
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
