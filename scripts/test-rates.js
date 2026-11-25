// P1-RATES suite: a shopper is never charged an amount different from the one on
// the button they pressed.
//
// The bug (P1-DRILLS-C finding 1): for up to 30 s after a shipping-rate change,
// the checkout page priced with this instance's cached rates and showed
// "Place order · ₹1,348", while POST /api/checkout priced with the new rates and
// stored and charged ₹1,507.
//
// What it proves, each through the real POST /api/checkout handler against a
// real control plane and tenant database (no browser, no network, no payment):
//   1. COD: a total the server no longer agrees with is refused with the new
//      amount in plain words, the server's cart and rates, and no order row.
//      The shown total, when it matches, is the stored total.
//   2. Online: the Razorpay order is created only for the amount the Pay button
//      showed (the Razorpay API is a local stub that records what it was asked).
//   3. Fresh pricing: the route prices with the store's row as saved now, even
//      when this instance cached the old row, and falls back to the cached row
//      when the fresh read fails, so a control-plane blip never closes checkout.
//   4. The words: the message the shopper reads, and only it, passes through
//      friendlyCheckoutError.
//   5. Guard: the checkout UI sends the total its button shows, for both
//      payment methods, and redraws from the server's refusal.
//   pnpm test:rates
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rates-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rates-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
// Long enough that this instance's cached row outlives every test: the stale
// copy is what the bug lived on.
process.env.PLATFORM_CACHE_MS = "600000";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
delete process.env.CHECKOUT_MODE;

const dbs = [".test-rates-default.db", ".test-rates-platform.db", ".test-rates-t.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

// Plain Node can't resolve the app's "@/…" alias or "next/server" (next has no
// exports map). next/server's after() throws outside Next's request scope, so
// the route's post-response work is collected here instead of run.
globalThis.__ratesAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__ratesAfter.push(fn); };`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: SERVER_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const { createCart, addItem, getCart, CART_COOKIE } = await import("../lib/cart.js");
const { SHIPPING_CONFIG } = await import("../lib/shipping.js");
const { friendlyCheckoutError } = await import("../lib/shopper-errors.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { NextRequest } = require("next/server.js");
const route = await import("../app/api/checkout/route.js");

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
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m} expected ${B}, got ${A}`);
};

// ---- fixtures ----------------------------------------------------------------------
// The drill's numbers: one ₹1,299 serum; rates flat ₹79, free over ₹999, COD ₹49,
// then flat ₹149, free over ₹4,999, COD ₹59.
const OLD = { ...SHIPPING_CONFIG, flatRate: 79, freeThreshold: 999, codFee: 49 };
const NEW = { ...SHIPPING_CONFIG, flatRate: 149, freeThreshold: 4999, codFee: 59 };
const SHOWN = { codOld: 1348, codNew: 1507, prepaidOld: 1299, prepaidNew: 1448 };
const HOST = "rt.test";
const TENANT = {
  id: "rt",
  name: "Rates",
  domains: [HOST],
  dbUrl: "file:.test-rates-t.db",
  secrets: { order_link_secret: "rt-link-secret", razorpay_key_secret: "rt-test-key-secret" },
};
const configWith = (shipping) => ({ shipping_config: shipping, razorpay_key_id: "rzp_test_rates" });

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ ...TENANT, config: configWith(OLD) });
const inT = async (fn) => withTenant(await C.getTenant("rt"), fn);
await inT(async () => {
  await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));
  await db.insertInto("products").values({ id: "gid://t/P1", handle: "glow-serum", title: "Radiance Glow Serum", price_min: 1299, price_max: 1299, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "30 ml", price: 1299, currency: "INR", available: 1 }).execute();
  const { emptyList } = await import("../lib/content/documents-reader.js");
  const now = new Date().toISOString();
  await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), now, now] });
  await libsql.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [now] });
});

// A founder's save through the console (this instance's cache is busted too).
const saveRates = (shipping) => C.upsertTenant({ ...TENANT, config: configWith(shipping) });
// The same save made on another instance: the row changes, this instance's
// cached copy does not.
const saveRatesElsewhere = (shipping) =>
  C.platformDb().execute({ sql: "UPDATE tenants SET config = ? WHERE id = ?", args: [JSON.stringify(configWith(shipping)), "rt"] });

let carts = 0;
async function freshCart() {
  const id = `rates-cart-${++carts}`;
  await inT(async () => {
    await createCart(id);
    await addItem(id, "gid://t/V1", 1);
  });
  return id;
}
const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Rates Test" };
const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
let keys = 0;
const key = () => `rates-key-${++keys}`;

async function post(cartId, body) {
  const req = new NextRequest(`https://${HOST}/api/checkout`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json", cookie: `${CART_COOKIE}=${cartId}` },
    body: JSON.stringify({ contact: CONTACT, address: ADDRESS, ...body }),
  });
  const res = await route.POST(req);
  return { status: res.status, body: await res.json() };
}
const ordersFor = (cartId) => inT(() => db.selectFrom("orders").select(["id", "total", "shipping_total", "payment_method", "razorpay_order_id"]).where("cart_id", "=", cartId).execute());
const itemsIn = async (cartId) => (await inT(() => getCart(cartId))).items.length;

// The Razorpay API, stubbed: every order-create call is recorded, nothing leaves.
const razorpayCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.razorpay.com/")) {
    const sent = JSON.parse(init.body);
    razorpayCalls.push(sent);
    return new Response(JSON.stringify({ id: `order_rates${razorpayCalls.length}`, amount: sent.amount, currency: sent.currency }), { status: 200 });
  }
  if (realFetch) return realFetch(url, init);
  throw new Error(`unexpected fetch ${url}`);
};

const MESSAGE_1507 = "Shipping changed — your new total is ₹1,507. Review and place order.";

// ---- 1. Cash on Delivery -------------------------------------------------------------

console.log("— Cash on Delivery");

await t("THE BUG: the page showed ₹1,348 on the old rates, the server prices ₹1,507: refused, nothing stored, the new amount said", async () => {
  await saveRates(NEW);
  const cart = await freshCart();
  const r = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codOld, expectedShipping: 49 });
  const stored = await ordersFor(cart);
  ok(!stored.some((o) => Number(o.total) !== SHOWN.codOld), `an order was stored at ${stored.map((o) => o.total)} while the button said ₹${SHOWN.codOld}`);
  eq(r.status, 409, "status:");
  eq(r.body.code, "PRICE_CHANGED", "code:");
  eq(r.body.error, MESSAGE_1507, "message:");
  eq(r.body.total, SHOWN.codNew, "new total:");
  eq(stored.length, 0, "orders stored:");
  eq(await itemsIn(cart), 1, "cart items kept:");
});

await t("the refusal carries the server's cart and rates, so the page redraws to the amount it will charge", async () => {
  const cart = await freshCart();
  const r = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codOld, expectedShipping: 49 });
  eq(r.body.shippingConfig?.flatRate, 149, "rates flat:");
  eq(r.body.shippingConfig?.codFee, 59, "rates COD fee:");
  eq(r.body.cart?.total, 1299, "cart goods total:");
  eq(r.body.cart?.items?.length, 1, "cart items:");
  eq(r.body.shippingTotal, 208, "shipping:");
  // What the UI computes from them is what it then sends, and that is accepted.
  const { computeShipping } = await import("../lib/shipping.js");
  const redrawn = r.body.cart.total + computeShipping({ subtotal: r.body.cart.subtotal, discountTotal: r.body.cart.discountTotal, paymentMethod: "cod", pincode: ADDRESS.pincode, config: r.body.shippingConfig }).total;
  eq(redrawn, SHOWN.codNew, "redrawn button:");
  const again = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: redrawn, expectedShipping: 208 });
  eq(again.status, 200, `second press: ${JSON.stringify(again.body)}`);
  const stored = await ordersFor(cart);
  eq(stored.map((o) => Number(o.total)), [SHOWN.codNew], "stored total:");
});

await t("REGRESSION: the shown total is the server's: the order is stored at exactly that amount, cart cleared", async () => {
  const cart = await freshCart();
  const r = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codNew, expectedShipping: 208 });
  eq(r.status, 200, `status (${JSON.stringify(r.body)}):`);
  ok(r.body.ok && r.body.orderId && r.body.confirmationPath, "no order id or confirmation path");
  const stored = await ordersFor(cart);
  eq(stored.map((o) => [Number(o.total), Number(o.shipping_total), o.payment_method]), [[SHOWN.codNew, 208, "cod"]], "stored:");
  eq(await itemsIn(cart), 0, "cart items after:");
});

await t("a request that names no total is refused, never charged unseen", async () => {
  const cart = await freshCart();
  for (const shown of [undefined, null, "", "abc", true]) {
    const r = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: shown });
    eq([r.status, r.body.code], [409, "PRICE_CHANGED"], `expectedTotal ${JSON.stringify(shown)}:`);
    eq(r.body.error, "Your total changed — your new total is ₹1,507. Review and place order.", "message:");
  }
  eq((await ordersFor(cart)).length, 0, "orders stored:");
});

await t("amounts compare in paise: ₹1,507.00 and \"1507\" are the shown ₹1,507; ₹1,506.99 is not", async () => {
  const off = await freshCart();
  const r = await post(off, { action: "cod", idempotencyKey: key(), expectedTotal: 1506.99, expectedShipping: 208 });
  eq(r.status, 409, "₹1,506.99:");
  eq(r.body.error, "Your total changed — your new total is ₹1,507. Review and place order.", "shipping unchanged, so 'Your total changed':");
  for (const shown of [1507.0, "1507"]) {
    const cart = await freshCart();
    const ok200 = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: shown });
    eq(ok200.status, 200, `${JSON.stringify(shown)}:`);
  }
});

await t("REGRESSION: a retry with the same key after the order went through returns that order, not a refusal", async () => {
  const cart = await freshCart();
  const k = key();
  const first = await post(cart, { action: "cod", idempotencyKey: k, expectedTotal: SHOWN.codNew });
  eq(first.status, 200, "first:");
  const retry = await post(cart, { action: "cod", idempotencyKey: k, expectedTotal: SHOWN.codNew });
  eq([retry.status, retry.body.orderId, retry.body.deduped], [200, first.body.orderId, true], "retry:");
  eq((await ordersFor(cart)).length, 1, "orders:");
});

// ---- 2. online payment (Razorpay order creation; nothing is paid) ----------------------

console.log("— online payment");

await t("THE BUG, online: Pay ₹1,299 on the old rates is refused before any Razorpay order exists", async () => {
  const cart = await freshCart();
  const before = razorpayCalls.length;
  const r = await post(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: SHOWN.prepaidOld, expectedShipping: 0 });
  const minted = razorpayCalls.slice(before);
  ok(!minted.some((c) => c.amount !== SHOWN.prepaidOld * 100), `a Razorpay order was created for ${minted.map((c) => c.amount)} paise while the button said ₹${SHOWN.prepaidOld}`);
  eq(r.status, 409, "status:");
  eq(r.body.code, "PRICE_CHANGED", "code:");
  eq(r.body.error, "Shipping changed — your new total is ₹1,448. Review and place order.", "message:");
  eq(minted.length, 0, "Razorpay orders created:");
  eq((await ordersFor(cart)).length, 0, "orders stored:");
});

await t("online: the Razorpay order, the stored order and the modal all carry the amount on the Pay button", async () => {
  const cart = await freshCart();
  const before = razorpayCalls.length;
  const r = await post(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: SHOWN.prepaidNew, expectedShipping: 149 });
  eq(r.status, 200, `status (${JSON.stringify(r.body)}):`);
  eq(razorpayCalls.slice(before).map((c) => c.amount), [SHOWN.prepaidNew * 100], "Razorpay amount (paise):");
  eq(r.body.amount, SHOWN.prepaidNew * 100, "modal amount:");
  const stored = await ordersFor(cart);
  eq(stored.map((o) => [Number(o.total), o.payment_method, o.razorpay_order_id]), [[SHOWN.prepaidNew, "razorpay", r.body.razorpayOrderId]], "stored:");
});

await t("online: a request that names no total creates no Razorpay order", async () => {
  const cart = await freshCart();
  const before = razorpayCalls.length;
  const r = await post(cart, { action: "razorpay_create", idempotencyKey: key() });
  eq([r.status, r.body.code], [409, "PRICE_CHANGED"], "refused:");
  eq(razorpayCalls.length - before, 0, "Razorpay orders created:");
});

// ---- 3. which rates the server prices with --------------------------------------------

console.log("— fresh pricing");

await t("a save made on another instance applies to the next order, though this instance cached the old row", async () => {
  await saveRates(OLD);
  await C.getTenant("rt"); // this instance now caches the old rates
  await saveRatesElsewhere(NEW);
  eq((await C.getTenant("rt")).config.shipping_config.flatRate, 79, "setup, this instance's cached copy:");
  const cart = await freshCart();
  const stale = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codOld, expectedShipping: 49 });
  eq([stale.status, stale.body.error], [409, MESSAGE_1507], "old total, priced on the saved row:");
  eq(stale.body.shippingConfig?.flatRate, 149, "rates handed back:");
  const fresh = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codNew, expectedShipping: 208 });
  eq(fresh.status, 200, "new total:");
  eq((await ordersFor(cart)).map((o) => Number(o.total)), [SHOWN.codNew], "stored:");
});

await t("when the fresh read fails, checkout keeps working on the cached row, and still charges only the shown amount", async () => {
  await saveRates(OLD);
  await C.getTenant("rt");
  const cart = await freshCart();
  // the control plane goes away (nothing listens on this port)
  const was = process.env.PLATFORM_DB_URL;
  process.env.PLATFORM_DB_URL = "http://127.0.0.1:18301";
  C.__resetPlatformClient({ preserveCaches: true });
  try {
    const wrong = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codNew });
    eq([wrong.status, wrong.body.code, wrong.body.total], [409, "PRICE_CHANGED", SHOWN.codOld], "a total the cached rates don't make:");
    const right = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: SHOWN.codOld, expectedShipping: 49 });
    eq(right.status, 200, `the cached rates' total (${JSON.stringify(right.body)}):`);
  } finally {
    process.env.PLATFORM_DB_URL = was;
    C.__resetPlatformClient({ preserveCaches: true });
  }
  eq((await ordersFor(cart)).map((o) => Number(o.total)), [SHOWN.codOld], "stored:");
});

// ---- 4. the words ----------------------------------------------------------------------

console.log("— the words");

await t("the shopper reads the server's sentence; anything else under that code reads the safe fallback", async () => {
  eq(friendlyCheckoutError({ code: "PRICE_CHANGED", error: MESSAGE_1507 }), MESSAGE_1507, "shipping:");
  const total = "Your total changed — your new total is ₹12,345.50. Review and place order.";
  eq(friendlyCheckoutError({ code: "PRICE_CHANGED", error: total }), total, "total:");
  eq(friendlyCheckoutError({ code: "PRICE_CHANGED", error: "SQLITE_BUSY: database is locked" }), "Could not continue — your cart is untouched, please retry.", "internals:");
  eq(friendlyCheckoutError({ error: MESSAGE_1507 }), "Could not continue — your cart is untouched, please retry.", "no code:");
});

// ---- 5. guard: the checkout UI -----------------------------------------------------------

console.log("— the checkout UI");

await t("guard: both payment methods send the total the button shows, and a refusal redraws from the server's cart and rates", async () => {
  const src = await readFile(join(ROOT, "components/checkout/CheckoutFlow.js"), "utf8");
  // Phase 8 step 0: the buttons moved into PaymentStep; CheckoutFlow hands it grandTotal
  const step = await readFile(join(ROOT, "components/checkout/PaymentStep.js"), "utf8");
  // Phase 8 line 2: the requests moved into placeOrder; the totals are the quote's
  const place = await readFile(join(ROOT, "components/checkout/placeOrder.js"), "utf8");
  ok(/grandTotal=\{grandTotal\}/.test(src), "CheckoutFlow does not hand the payment step grandTotal");
  ok(/const grandTotal = selected\.total;/.test(src) && /const shipping = \{ total: selected\.shipping,/.test(src), "the button's total is not the chosen method's quote");
  ok(/const shown = \{ expectedTotal: grandTotal, expectedShipping: shipping\.total, expectedCurrency: cart\.currency \|\| "INR" \}/.test(src), "the UI does not send grandTotal as expectedTotal (and, Phase 8 line 4, the currency it shows)");
  for (const action of ["cod", "razorpay_create", "cod_otp_send"]) {
    ok(new RegExp(`action: "${action}",[^}]*\\.\\.\\.shown \\}`).test(place), `the ${action} request does not carry the shown total`);
  }
  ok((place.match(/if \(data\.code === PRICE_CHANGED\) return ctx\.priceChanged\(data\);/g) || []).length === 3, "a refusal is not handled for every placing request");
  ok(/Place order · \$\{formatMoney\(grandTotal, cart\.currency\)\}/.test(step) && /Pay \$\{formatMoney\(grandTotal, cart\.currency\)\}/.test(step), "the buttons no longer show grandTotal");
  ok(/setCart\(data\.cart\)/.test(src) && /setShippingConfig\(data\.shippingConfig \?\? undefined\)/.test(src) && /quote\.replace\(data\.quote/.test(src), "a refusal does not redraw from the server's cart, rates and quote");
});

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
