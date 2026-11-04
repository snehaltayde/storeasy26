// Commerce adapter + offers suite (Session 32 / BE06+BE07+SF06+MC14+MC22):
// checkout capability gate, TZ-safe schedule round-trips, lifecycle status,
// deterministic simulator, cart change acknowledgement, duplicate-mutation
// idempotency, gift eligibility, settings validation.
// P3-CLOSED (PUB-06): checkout, contact, leads and quiz on a closed store
// (documents mode, never published): anonymous and forged-console-cookie
// requests are refused; a valid preview session may place a COD test order.
//   pnpm test:commerce
import { rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire, registerHooks } from "node:module";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

// The routes, in plain Node (as test-rates does): the "@/" alias, next/server
// with after() collected instead of run (it throws outside Next's request
// scope), and next/headers answering for one simulated request
// (globalThis.__comRequest: its cookies), empty outside one.
globalThis.__comAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__comAfter.push(fn); };`);
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const jar = () => globalThis.__comRequest?.cookies || {};
export async function cookies() { const c = jar(); return { get: (n) => (Object.hasOwn(c, n) ? { name: n, value: c[n] } : undefined) }; }
export async function headers() { return { get: () => null }; }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: SERVER_STUB, shortCircuit: true, format: "module" };
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (spec === "next/navigation") return next("next/navigation.js", ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
process.env.PLATFORM_SITE_HOSTS = "storeasy.test";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-com-default.db";
process.env.PLATFORM_DB_URL = "file:.test-com-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
delete process.env.CHECKOUT_MODE;

const dbs = [".test-com-default.db", ".test-com-platform.db", ".test-com-t1.db", ".test-com-cc.db", ".test-com-cl.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const A = await import("../lib/commerce/adapter.js");
const SCH = await import("../lib/admin/schedule.js");
const SIM = await import("../lib/offers/simulate.js");
const SET = await import("../lib/admin/settings.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { createCart, addItem, setItemQty, removeItem, getCart } = await import("../lib/cart.js");
const { upsertOffer, deleteOffer } = await import("../lib/offers/store.js");
const { applyTenantSchema } = await import("../lib/platform/provision.js");
const { readFile } = await import("node:fs/promises");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- fixtures -------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "cm", name: "Commerce", domains: [], dbUrl: "file:.test-com-t1.db", config: {}, secrets: {} });
await applyTenantSchema(createClient({ url: "file:.test-com-t1.db" }));
const CM = await C.getTenant("cm");
const inT = (fn) => withTenant(CM, fn);

// catalog rows for the cart tests
await inT(async () => {
  await db.insertInto("products").values({ id: "gid://t/P1", handle: "tee", title: "Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("products").values({ id: "gid://t/P2", handle: "cap", title: "Cap", price_min: 1200, price_max: 1200, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "M", price: 500, currency: "INR", available: 1 }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V2", product_id: "gid://t/P2", title: "OS", price: 1200, currency: "INR", available: 1 }).execute();
  await db.insertInto("products").values({ id: "gid://t/PG", handle: "gift", title: "Gift Sticker", price_min: 99, price_max: 99, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("variants").values({ id: "gid://t/VG", product_id: "gid://t/PG", title: "OS", price: 99, currency: "INR", available: 1 }).execute();
  // drop the seeded default offers so engine results are OURS alone
  await db.deleteFrom("offers").execute();
});

// --- BE06: capability gate --------------------------------------------------------
await t("checkoutCapability: default direct; disabled + unknown + reserved modes fail closed", async () => {
  eq(await inT(() => A.checkoutMode()), "direct", "default");
  eq((await inT(() => A.checkoutCapability())).available, true, "available by default");
  const disabled = { ...CM, config: { ...CM.config, checkout_mode: "disabled" } };
  const d = await withTenant(disabled, () => A.checkoutCapability());
  eq(d.available, false, "disabled unavailable");
  ok(d.reason, "has a reason");
  const weird = { ...CM, config: { ...CM.config, checkout_mode: "paypal??" } };
  eq(await withTenant(weird, () => A.checkoutMode()), "disabled", "unknown mode fails closed");
  const shopify = { ...CM, config: { ...CM.config, checkout_mode: "shopify" } };
  const sh = await withTenant(shopify, () => A.checkoutCapability());
  eq(sh.available, false, "reserved shopify mode stays off");
  ok(/not implemented/.test(sh.reason), "honest reason");
});

await t("checkoutCapability: razorpay flag needs the tenant's OWN keys (S24 scoping)", async () => {
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_env";
  process.env.RAZORPAY_KEY_SECRET = "env-secret";
  const bare = await inT(() => A.checkoutCapability());
  eq(bare.razorpay, false, "resolved tenant w/o keys → no env fallback");
  eq(bare.cod, true, "COD always offered in direct mode");
  const keyed = { ...CM, config: { ...CM.config, razorpay_key_id: "rzp_test_own" }, secrets: { razorpay_key_secret: "own" } };
  eq((await withTenant(keyed, () => A.checkoutCapability())).razorpay, true, "own keys → prepaid on");
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
});

// --- BE07/MC14: schedules ----------------------------------------------------------
await t("schedule round-trip preserves the INSTANT (the UTC-drift quirk is dead)", () => {
  const instant = "2026-11-01T18:30:00.000Z";
  const local = SCH.isoToLocalInput(instant);
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local), "datetime-local shape");
  eq(SCH.localInputToIso(local), instant, "roundtrip identity");
  // the OLD buggy path for contrast: slice(0,16) re-parsed as local shifts
  // unless the environment runs UTC
  const buggy = new Date(new Date(instant).toISOString().slice(0, 16)).toISOString();
  if (new Date().getTimezoneOffset() !== 0) ok(buggy !== instant, "old path really did drift here");
  eq(SCH.isoToLocalInput(null), "", "empty in");
  eq(SCH.localInputToIso(""), null, "empty out");
  eq(SCH.localInputToIso("garbage"), null, "garbage out");
});

await t("offerScheduleStatus lifecycle matrix", () => {
  const at = "2026-10-28T12:00:00.000Z";
  eq(SCH.offerScheduleStatus({ enabled: false }, at), "draft", "draft");
  eq(SCH.offerScheduleStatus({ enabled: false, starts_at: "2026-10-01T00:00:00Z" }, at), "paused", "paused");
  eq(SCH.offerScheduleStatus({ enabled: true, starts_at: "2026-11-01T00:00:00Z" }, at), "scheduled", "scheduled");
  eq(SCH.offerScheduleStatus({ enabled: true }, at), "active", "active (no window)");
  eq(SCH.offerScheduleStatus({ enabled: true, starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-10-20T00:00:00Z" }, at), "expired", "expired");
  eq(SCH.offerScheduleStatus({ enabled: false, ends_at: "2026-10-20T00:00:00Z" }, at), "expired", "expired wins over paused");
});

// --- BE07: simulator ----------------------------------------------------------------
const COUPON = { id: "sim-c10", type: "COUPON", scope: "order", priority: 50, title: "SIM10", code: "SIM10", discount: { kind: "percent", value: 10 }, combinable: true };

// COM-03: the example carts come from this store's own catalog (Tee, Cap, Gift
// Sticker above), not fixed sample baskets; scripts/test-offer-form.js covers
// the examples in depth.
await t("simulator: deterministic, explains not-applying, coupon applies with its code", async () => {
  const a = await inT(() => SIM.simulateOffer({ offer: COUPON }));
  const b = await inT(() => SIM.simulateOffer({ offer: COUPON }));
  eq(JSON.stringify(a), JSON.stringify(b), "deterministic");
  eq(a.ok, true, "ok");
  eq(a.applied.alone, true, "coupon auto-simulated with its code");
  eq(a.cart.items.map((i) => i.title).join(), "Gift Sticker — OS", "the store's cheapest product, by its variant");
  eq(a.alone.discountTotal, 10, "10% of the ₹99 cart (engine's own rounding, as test-offers proves)");
  const gift = { id: "sim-gift", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Gift over 5k", threshold: 5000, gift: { variantId: "gid://shopify/ProductVariant/900001", productId: "gid://shopify/Product/900001", handle: "gift", title: "Gift Sticker", value: 99 } };
  const g = await inT(() => SIM.simulateOffer({ offer: gift }));
  eq(g.applied.alone, true, "the example cart crosses the threshold");
  eq(g.alone.gifts.length, 1, "gift present");
  eq(g.nearMiss.appliedAlone, false, "the closest cart under it gets no gift");
  ok(/must be over/.test(g.nearMiss.text), "explains why not");
});

await t("simulator: combination preview vs ACTIVE offers + one-coupon note; invalid offer → errors", async () => {
  await inT(() => upsertOffer({ offer: { ...COUPON, id: "live-c20", code: "LIVE20", title: "LIVE20", discount: { kind: "percent", value: 20 } }, enabled: true }));
  const r = await inT(() => SIM.simulateOffer({ offer: COUPON }));
  eq(r.activeOfferCount, 1, "sees the live offer");
  ok(r.notes.some((n) => /one code per order/.test(n)), "one-coupon-per-cart note");
  const bad = await inT(() => SIM.simulateOffer({ offer: { id: "x", type: "COUPON" } }));
  eq(bad.ok, false, "invalid offer refused");
  ok(bad.errors.length > 0, "named errors");
  await inT(() => deleteOffer("live-c20"));
});

// --- SF06: cart behavior ---------------------------------------------------------------
await t("cart: price change is ACKNOWLEDGED (notice) while totals use the current price", async () => {
  await inT(async () => {
    await createCart("c1");
    await addItem("c1", "gid://t/V1", 2);
    let cart = await getCart("c1");
    eq(cart.changes.length, 0, "no changes at add time");
    eq(cart.subtotal, 1000, "subtotal at add price");
    await db.updateTable("variants").set({ price: 450 }).where("id", "=", "gid://t/V1").execute();
    cart = await getCart("c1");
    eq(cart.subtotal, 900, "totals follow the CURRENT price");
    eq(cart.changes.length, 1, "one change notice");
    eq(cart.changes[0].kind, "price_changed", "kind");
    eq(cart.changes[0].from, 500, "from");
    eq(cart.changes[0].to, 450, "to");
  });
});

await t("cart: unavailable line surfaces a notice; duplicate setQty is idempotent", async () => {
  await inT(async () => {
    await db.updateTable("variants").set({ available: 0 }).where("id", "=", "gid://t/V1").execute();
    let cart = await getCart("c1");
    ok(cart.changes.some((c) => c.kind === "unavailable"), "unavailable notice");
    await db.updateTable("variants").set({ available: 1, price: 500 }).where("id", "=", "gid://t/V1").execute();
    await setItemQty("c1", "gid://t/V1", 3);
    await setItemQty("c1", "gid://t/V1", 3); // duplicate submit
    cart = await getCart("c1");
    eq(cart.items[0].quantity, 3, "one final state");
    eq(cart.count, 3, "count agrees");
  });
});

await t("cart: removing the gift-qualifying item removes the gift (eligibility recomputed)", async () => {
  await inT(async () => {
    await upsertOffer({
      offer: { id: "g1k", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Gift over 1k", threshold: 1000, gift: { variantId: "gid://shopify/ProductVariant/900001", productId: "gid://shopify/Product/900001", handle: "gift", title: "Gift Sticker", value: 99 } },
      enabled: true,
    });
    await addItem("c1", "gid://t/V2", 1); // subtotal 500*3 + 1200 = 2700 → gift
    let cart = await getCart("c1");
    eq(cart.gifts.length, 1, "gift present above threshold");
    await removeItem("c1", "gid://t/V2");
    await setItemQty("c1", "gid://t/V1", 1); // 500 → below threshold
    cart = await getCart("c1");
    eq(cart.gifts.length, 0, "gift gone below threshold");
    await deleteOffer("g1k");
  });
});

// --- MC22: settings validation ------------------------------------------------------------
await t("buildSettingsPatch commerce: valid accepted, invalid named", () => {
  const good = SET.buildSettingsPatch({ commerce: { checkout_mode: "disabled", timezone: "Asia/Kolkata" } }, {});
  eq(good.ok, true, "valid passes");
  eq(good.patch.config.checkout_mode, "disabled", "mode in patch");
  eq(good.patch.config.timezone, "Asia/Kolkata", "tz in patch");
  const bad = SET.buildSettingsPatch({ commerce: { checkout_mode: "shopify", timezone: "notatz" } }, {});
  eq(bad.ok, false, "invalid refused");
  ok(bad.errors.some((e) => /Checkout mode/.test(e)), "mode rejected (shopify not selectable yet)");
  ok(bad.errors.some((e) => /Timezone/.test(e)), "tz rejected");
});

// --- P3-CLOSED (PUB-06): a closed store's checkout and forms -----------------------------
console.log("— a closed store (documents mode, never published)");
const { NextRequest } = require("next/server.js");
const Res = await import("../lib/content/resolve.js");
const PS = await import("../lib/preview-sessions.js");
const { libsql } = await import("../lib/db.js");
const checkoutRoute = await import("../app/api/checkout/route.js");
const contactRoute = await import("../app/api/contact/route.js");
const leadsRoute = await import("../app/api/leads/route.js");
const quizRoute = await import("../app/api/quiz/[slug]/route.js");
{
  // the marketing host's leads table is a platform migration
  const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
}

async function store(id, mode) {
  await C.upsertTenant({ id, name: `Closed ${id}`, domains: [`${id}.test`], dbUrl: `file:.test-com-${id}.db`, config: { site: { name: `Store ${id}` } }, secrets: { order_link_secret: `${id}-link-secret`, razorpay_key_secret: `${id}-rzp-secret` } });
  await applyTenantSchema(createClient({ url: `file:.test-com-${id}.db` }));
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] });
    await db.insertInto("products").values({ id: "gid://t/P1", handle: "tee", title: "Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute();
    await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "M", price: 500, currency: "INR", available: 1 }).execute();
    await db.deleteFrom("offers").execute();
    await libsql.execute({ sql: "INSERT INTO quizzes (slug, title, intro, questions, enabled, updated_at) VALUES ('fit', 'Fit quiz', '', '[]', 1, ?)", args: [new Date().toISOString()] });
  });
  return T;
}
const CC = await store("cc", "documents"); // closed: documents mode, no release
const CL = await store("cl", "legacy"); // legacy, no release: today's store
const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Closed Test" };
const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
let n = 0;
async function cartOn(T) {
  const id = `closed-cart-${++n}`;
  await withTenant(T, async () => {
    await createCart(id);
    await addItem(id, "gid://t/V1", 1);
  });
  return id;
}
// One request to a route: cookies go both on the request and to next/headers
// (resolve.js reads the preview cookie through cookies(), as in Next).
async function call(route, url, { body = {}, cookies = {}, host } = {}) {
  const u = new URL(url);
  const req = new NextRequest(url, {
    method: "POST",
    headers: { host: host || u.host, "content-type": "application/json", ...(Object.keys(cookies).length ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } : {}) },
    body: JSON.stringify(body),
  });
  globalThis.__comRequest = { cookies };
  try {
    const res = await route(req, { params: Promise.resolve({ slug: u.pathname.split("/").pop() }) });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  } finally {
    globalThis.__comRequest = null;
  }
}
const ordersOn = (T, cartId) => withTenant(T, () => db.selectFrom("orders").select(["id", "payment_method", "email"]).where("cart_id", "=", cartId).execute());
const checkoutTotal = async (T, cartId, method) => {
  const cart = await withTenant(T, () => getCart(cartId));
  const { computeShipping } = await import("../lib/shipping.js");
  const shipping = computeShipping({ subtotal: cart.subtotal || 0, discountTotal: cart.discountTotal || 0, paymentMethod: method, pincode: ADDRESS.pincode, config: undefined });
  return { expectedTotal: (cart.total || 0) + shipping.total, expectedShipping: shipping.total };
};
const checkout = async (T, cartId, action, cookies = {}) =>
  call(checkoutRoute.POST, `https://${T.id}.test/api/checkout`, {
    body: { action, contact: CONTACT, address: ADDRESS, idempotencyKey: `k-${T.id}-${++n}`, ...(await checkoutTotal(T, cartId, action === "cod" ? "cod" : "prepaid")) },
    cookies: { [CART_COOKIE]: cartId, ...cookies },
  });
const FORGED = [{}, { _admin: "x" }, { _platform: "x" }, { _mx: "x" }, { _admin: "x", _platform: "x", _mx: "x" }];
const previewCookie = async (T) => {
  const s = await withTenant(T, () => PS.createPreviewSession({ actor: { kind: "merchant", id: "u_com" } }));
  return { [Res.PREVIEW_COOKIE]: s.token, sid: s.sid };
};
const { CART_COOKIE } = await import("../lib/cart.js");

await t("PUB-06 checkout: anonymous COD and card on a closed store are 403 STORE_CLOSED, also with forged _admin, _platform and _mx cookies; no order is stored", async () => {
  for (const cookies of FORGED) {
    for (const action of ["cod", "razorpay_create", "razorpay_verify"]) {
      const cart = await cartOn(CC);
      const r = await checkout(CC, cart, action, cookies);
      eq(r.status, 403, `${action} ${JSON.stringify(cookies)} status:`);
      eq(r.body.code, "STORE_CLOSED", "code:");
      eq(r.body.error, "This store isn't open yet.", "words:");
      eq((await ordersOn(CC, cart)).length, 0, "orders stored:");
    }
  }
});

await t("PUB-06 checkout: with a valid documents preview session a COD order passes the gate and is placed (the normal flow, Shopify push queued after the response); card and UPI are refused in plain words", async () => {
  const { sid, ...pv } = await previewCookie(CC);
  const cart = await cartOn(CC);
  globalThis.__comAfter.length = 0;
  const r = await checkout(CC, cart, "cod", pv);
  eq(r.status, 200, `COD status (${JSON.stringify(r.body)}):`);
  ok(r.body.ok && r.body.orderId && r.body.confirmationPath, "COD answer");
  const stored = await ordersOn(CC, cart);
  eq(stored.length, 1, "orders stored:");
  eq(stored[0].payment_method, "cod", "method:");
  eq(stored[0].email, "snehal@mediastic.in", "the test-order address:");
  eq(globalThis.__comAfter.length, 1, "the after-response work (Shopify push, purchase event) is queued as for any order:");
  globalThis.__comAfter.length = 0;
  for (const action of ["razorpay_create", "razorpay_verify"]) {
    const c2 = await cartOn(CC);
    const rz = await checkout(CC, c2, action, pv);
    eq(rz.status, 403, `${action} status:`);
    eq(rz.body.code, "STORE_CLOSED", `${action} code:`);
    eq(rz.body.error, "Card and UPI payments open when your store does. Use cash on delivery for a test order.", `${action} words:`);
    eq((await ordersOn(CC, c2)).length, 0, `${action} orders:`);
  }
  // a revoked session is no longer proof
  await withTenant(CC, () => PS.revokePreviewSession({ sid }));
  const c3 = await cartOn(CC);
  eq((await checkout(CC, c3, "cod", pv)).status, 403, "revoked session:");
});

await t("PUB-06 checkout: a legacy store with no release is unaffected (COD placed, card reaches its own checks), also with console cookies", async () => {
  for (const cookies of [{}, { _admin: "x" }]) {
    const cart = await cartOn(CL);
    const r = await checkout(CL, cart, "cod", cookies);
    eq(r.status, 200, `legacy COD ${JSON.stringify(cookies)} (${JSON.stringify(r.body)}):`);
    eq((await ordersOn(CL, cart)).length, 1, "legacy order stored:");
    const rz = await checkout(CL, await cartOn(CL), "razorpay_create", cookies);
    ok(rz.body?.code !== "STORE_CLOSED", `legacy card refused as closed: ${JSON.stringify(rz.body)}`);
  }
  globalThis.__comAfter.length = 0;
});

await t("PUB-06: checkoutCapability's signature is unchanged (synchronous, no arguments, same answer shape)", async () => {
  eq(A.checkoutCapability.length, 0, "arguments:");
  eq(A.checkoutCapability.constructor.name, "Function", "a plain (not async) function:");
  const cap = await withTenant(CC, () => A.checkoutCapability());
  ok(!(cap instanceof Promise) && typeof cap.available === "boolean", `answer: ${JSON.stringify(cap)}`);
  eq(cap.available, true, "a closed store's capability is still its configured one (the closed check lives in the routes):");
});

await t("PUB-06 forms: contact, leads and quiz POST on a closed store are 403 STORE_CLOSED for anonymous and forged-cookie requests, and pass with a valid preview session; legacy stores are unaffected", async () => {
  const forms = [
    ["contact", contactRoute.POST, (T) => `https://${T.id}.test/api/contact`, { name: "Closed Test", email: "snehal@mediastic.in", message: "A test message from the closed store suite." }, (r) => r.status === 200 && r.body.received === true],
    ["quiz", quizRoute.POST, (T) => `https://${T.id}.test/api/quiz/fit`, { answers: {} }, (r) => r.status === 200 && r.body.ok === true],
    // leads: store hosts never take leads (marketing hosts only): past the gate it is today's 404
    ["leads", leadsRoute.POST, (T) => `https://${T.id}.test/api/leads`, { name: "x", email: "snehal@mediastic.in" }, (r) => r.status === 404 && r.body.error === "Not found"],
  ];
  const pv = await previewCookie(CC);
  delete pv.sid;
  for (const [name, route, url, body, passed] of forms) {
    for (const cookies of FORGED) {
      const r = await call(route, url(CC), { body, cookies });
      eq(r.status, 403, `${name} ${JSON.stringify(cookies)} status:`);
      eq(r.body.code, "STORE_CLOSED", `${name} code:`);
      eq(r.body.error, "This store isn't open yet.", `${name} words:`);
    }
    const ok1 = await call(route, url(CC), { body, cookies: pv });
    ok(passed(ok1), `${name} with a preview session: ${ok1.status} ${JSON.stringify(ok1.body)}`);
    for (const cookies of [{}, { _admin: "x" }]) {
      const lg = await call(route, url(CL), { body, cookies });
      ok(passed(lg), `${name} on a legacy store: ${lg.status} ${JSON.stringify(lg.body)}`);
    }
  }
  // the marketing host still takes leads
  const mk = await call(leadsRoute.POST, "https://storeasy.test/api/leads", { body: { name: "Lead", email: "snehal@mediastic.in" } });
  eq(mk.status, 200, `marketing host lead (${JSON.stringify(mk.body)}):`);
  // nothing was stored by the refused contact posts
  const msgs = await withTenant(CC, () => libsql.execute("SELECT count(*) AS n FROM contact_messages"));
  eq(Number(msgs.rows[0].n), 1, "contact messages on the closed store (the preview one only):");
  globalThis.__comAfter.length = 0;
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
