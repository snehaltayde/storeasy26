// Phase 9 line 2 suite: a shopper subscribes to a product and pauses, skips,
// swaps or cancels from their account; each renewal is an ordinary checkout,
// paid when it is due (nothing is charged automatically).
//
// Everything runs through the real routes (/api/cart, /api/checkout,
// /api/account/subscriptions, /api/admin/subscriptions) against a real control
// plane and tenant databases (no browser, no network: Razorpay is a stub that
// records what it was asked to mint, Shopify's draft is built and totalled
// here). The clock the subscriptions read is pinned (subscriptionClock).
//   1. The engine and the cart: SUBSCRIPTION is built on the server only and
//      claims first (no other line offer stacks, even at 0%), per-unit
//      rounding, coupons on the net, an exclusive code, plugin off / killed /
//      not eligible / outside the base market → one-time.
//   2. Checkout: signed out 401, a market 409, body fields ignored, the "sub:"
//      key reserved; the order's effects create the subscription once.
//   3. The account: own subscriptions only (another shopper's id is a 404 and
//      the row is unchanged; signed out reads nothing); skip, pause/resume,
//      swap, change, cancel, pay; one order per cycle under a race.
//   4. The sweep: due + one reminder, missed, two misses pause; pauses end.
//   5. The console (support redacted, staff cancel audited), privacy erase, export.
//   6. Brute force (mandatory, PLAYBOOK): 1,000 random carts of subscribed and
//      one-time lines with live offers and random percents and shipping/COD
//      configs: PDP price × qty = cart line = quote = Razorpay amount =
//      orders.total = the Shopify draft total; 300 random renewal histories
//      (skip, swap, pause, change, price change): reminder = account figure =
//      that day's checkout total = the order; a price change in between is
//      the existing 409.
//   pnpm test:subscriptions
import { readFile, rm } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-sub-default.db";
process.env.PLATFORM_DB_URL = "file:.test-sub-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
delete process.env.SMS_PROVIDER;
delete process.env.CHECKOUT_MODE;
process.env.NODE_ENV = "test";

const dbs = [".test-sub-default.db", ".test-sub-platform.db", ".test-sub-a.db", ".test-sub-b.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

globalThis.__subAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
import { AsyncLocalStorage } from "node:async_hooks";
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__subAfter.push(AsyncLocalStorage.snapshot().bind(null, fn)); };`);
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
const { evaluateOffers } = await import("../lib/offers/engine.js");
const { upsertOffer } = await import("../lib/offers/store.js");
const { OFFER_TYPES } = await import("../lib/offers/validate.js");
const { toMinor } = await import("../lib/money.js");
const { formatMoney } = await import("../lib/format.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const P = await import("../lib/shopify-push.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { setFlag } = await import("../lib/platform/flags.js");
const { adminSessionTokenFor } = await import("../lib/admin-auth.js");
const { runOrderEffects } = await import("../lib/payment-settle.js");
const { redactCustomer } = await import("../lib/privacy.js");
const PR = await import("../lib/subscriptions/pricing.js");
const ST = await import("../lib/subscriptions/store.js");
const { consoleList, consoleDetail } = await import("../lib/subscriptions/console.js");
const { renewalFigure } = await import("../lib/subscriptions/renewal.js");
const sweep = (await import("../lib/plugins/first-party/subscriptions/sweep.js")).default;
const { sweepFor } = await import("../lib/plugins/sweeps.js");
const { pluginById, checkCatalog } = await import("../lib/plugins/catalog.js");
const { scanText } = await import("./support/banned-copy.js");
const { NextRequest } = require("next/server.js");
const checkout = await import("../app/api/checkout/route.js");
const cartRoute = await import("../app/api/cart/route.js");
const accountSubs = await import("../app/api/account/subscriptions/route.js");
const adminSubs = await import("../app/api/admin/subscriptions/route.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.stack?.split("\n").slice(0, 5).join("\n    ") || e.message}`);
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

// ---- the pinned clock ----------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const START = Date.now();
let NOW = START;
ST.subscriptionClock.now = () => NOW;

// ---- fixtures ------------------------------------------------------------------------
const HOST_A = "sub-a.test";
const HOST_B = "sub-b.test";
const LINK = "sub-link-secret";
const ADMIN_PW = "sub-admin-pass";
const BASE_SHIPPING = { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null, zones: [] };
let SHIPPING = BASE_SHIPPING;
let PAYMENT = null;
const USD = { id: "US", countries: ["US"], currency: "USD", rate: 84.2, rateSetAt: new Date().toISOString(), rounding: "exact", flatRate: 9.5, freeThreshold: 60, enabled: true, international: true };
const tenantA = () => ({
  id: "suba",
  name: "Subs A",
  domains: [HOST_A],
  dbUrl: "file:.test-sub-a.db",
  secrets: { order_link_secret: LINK, razorpay_key_secret: "sub-key-secret", razorpay_webhook_secret: "sub-wh", admin_password: ADMIN_PW },
  config: { country: "IN", currency: "INR", shipping_config: SHIPPING, payment_config: PAYMENT, razorpay_key_id: "rzp_test_sub", markets: [USD] },
});
const saveA = () => C.upsertTenant(tenantA());
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await saveA();
await C.upsertTenant({ id: "subb", name: "Subs B", domains: [HOST_B], dbUrl: "file:.test-sub-b.db", secrets: { order_link_secret: "b" }, config: { country: "IN", currency: "INR", shipping_config: BASE_SHIPPING } });
const inA = async (fn) => withTenant(await C.getTenant("suba"), fn);
const inB = async (fn) => withTenant(await C.getTenant("subb"), fn);

// [numeric id, price, tags]; "subscribe" marks the eligible ones when the store limits by tag
const VARIANTS = [
  ["2001", 349, ["subscribe"]],
  ["2002", 1299, ["subscribe", "serum"]],
  ["2003", 89.5, ["subscribe"]],
  ["2004", 2499, []],
  ["2005", 4999, ["subscribe"]],
  ["2006", 15, []],
  ["2007", 777.77, ["subscribe"]],
  ["2008", 599, ["subscribe"]],
];
const price = Object.fromEntries(VARIANTS.map(([v, p]) => [v, p]));
const tagsOf = Object.fromEntries(VARIANTS.map(([v, , tags]) => [v, tags]));
const vid = (v) => `gid://shopify/ProductVariant/${v}`;
const pid = (v) => `gid://shopify/Product/${v}`;
const num = (gid) => String(gid).split("/").pop();
async function seedStore(inT) {
  await inT(async () => {
    await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
    await runMigrations(libsql, await loadMigrations("tenant"));
    for (const [v, p, tags] of VARIANTS) {
      await db.insertInto("products").values({ id: pid(v), handle: `p-${v}`, title: `Product ${v}`, price_min: p, price_max: p, currency: "INR", available: 1, tags: JSON.stringify(tags) }).execute();
      await db.insertInto("variants").values({ id: vid(v), product_id: pid(v), title: "One", price: p, currency: "INR", available: 1 }).execute();
    }
    // a second variant of 2008, for swaps within a product
    await db.insertInto("variants").values({ id: vid("2018"), product_id: pid("2008"), title: "Large", price: 899, currency: "INR", available: 1 }).execute();
    const now = new Date().toISOString();
    const { emptyList } = await import("../lib/content/documents-reader.js");
    await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), now, now] });
    await libsql.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [now] });
  });
}
await seedStore(inA);
await seedStore(inB);
price["2018"] = 899;
tagsOf["2018"] = ["subscribe"];

const SETTINGS = { discount_percent: 10, every_14: true, every_30: true, every_45: true, every_60: true, every_90: true, eligible: "all", eligible_tag: "", reminder_days: 3, grace_days: 7 };
let settingsNow = { ...SETTINGS };
async function setPlugin(inT, settings, status = "enabled") {
  settingsNow = settings;
  await inT(async () => {
    const ts = new Date().toISOString();
    await libsql.execute({
      sql: `INSERT INTO plugin_installs (id, plugin_id, kind, name, version, status, granted_scopes, settings, installed_by, installed_at, updated_at)
            VALUES ('pin_subs', 'subscriptions', 'first_party', 'Subscriptions', '1.0.0', ?, '[]', ?, 'merchant:test', ?, ?)
            ON CONFLICT (id) DO UPDATE SET status = excluded.status, settings = excluded.settings, updated_at = excluded.updated_at`,
      args: [status, JSON.stringify(settings), ts, ts],
    });
  });
}
await setPlugin(inA, SETTINGS);

await inA(async () => {
  await upsertOffer({ offer: { id: "tier-2002", type: "TIERED_QTY", scope: "line", priority: 10, title: "Two serums", target: { kind: "tag", value: "serum" }, tiers: [{ minQty: 2, percent: 13 }] }, enabled: true });
  await upsertOffer({ offer: { id: "bxgy-2003", type: "BXGY", scope: "line", priority: 20, title: "Buy 2 get 1", target: { kind: "variantId", value: vid("2003") }, buy: 2, free: 1 }, enabled: true });
  await upsertOffer({ offer: { id: "bundle-duo", type: "BUNDLE", scope: "line", priority: 5, title: "Duo", items: [{ variantId: vid("2001"), quantity: 1 }, { variantId: vid("2007"), quantity: 1 }], price: 999 }, enabled: true });
  await upsertOffer({ offer: { id: "gift-2006", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Free sample", threshold: 2999, gift: { variantId: vid("2006"), productId: pid("2006"), handle: "p-2006", title: "Sample", value: 15 } }, enabled: true });
  await upsertOffer({ offer: { id: "save-seven", type: "COUPON", scope: "order", priority: 50, title: "SAVE7", code: "SAVE7", discount: { kind: "percent", value: 7 }, combinable: true }, enabled: true });
  await upsertOffer({ offer: { id: "flat-300", type: "COUPON", scope: "order", priority: 50, title: "FLAT300", code: "FLAT300", discount: { kind: "fixed", value: 300 }, minSubtotal: 2000, combinable: true }, enabled: true });
  await upsertOffer({ offer: { id: "solo-ten", type: "COUPON", scope: "order", priority: 50, title: "SOLO10", code: "SOLO10", discount: { kind: "percent", value: 10 }, combinable: false }, enabled: true });
});

// shoppers: a signed-in session is a customers row + a hashed session token
const sha = (s) => createHash("sha256").update(s).digest("hex");
let shoppers = 0;
async function shopper(inT = inA, email = null) {
  const n = ++shoppers;
  const id = `cus_${String(n).padStart(6, "0")}`;
  const token = `ct_sub_${n}_${Math.random().toString(16).slice(2)}`;
  const ts = new Date().toISOString();
  await inT(async () => {
    await db.insertInto("customers").values({ id, email: email || `sub${n}@shopper.test`, name: `Shopper ${n}`, phone: null, default_address: null, created_at: ts, last_login_at: ts }).execute();
    await db.insertInto("customer_sessions").values({ token_hash: sha(`${token}|${inT === inA ? LINK : "b"}|customer`), customer_id: id, created_at: ts, expires_at: new Date(Date.now() + 30 * DAY).toISOString() }).execute();
  });
  return { id, token, email: email || `sub${n}@shopper.test` };
}

let carts = 0;
async function freshCart(lines, coupon = null, inT = inA) {
  const id = `sub-cart-${++carts}`;
  await inT(async () => {
    await createCart(id);
    for (const [v, q, interval] of lines) await addItem(id, vid(v), q, { subscriptionInterval: interval ?? null });
    if (coupon) await db.updateTable("carts").set({ coupon_code: coupon }).where("id", "=", id).execute();
  });
  return id;
}

const CONTACT = { email: "snehal@mediastic.in", phone: "9876543210", name: "Subs Test" };
const ADDR = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", country_code: "IN" };
let keys = 0;
const key = () => `sub-key-${++keys}`;
const cookieOf = (jar) => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
const jarFor = ({ cartId = null, who = null, country = null } = {}) => ({ [CART_COOKIE]: cartId, _customer: who?.token, _market: country });

async function drainAfter() {
  const q = globalThis.__subAfter;
  globalThis.__subAfter = [];
  for (const fn of q) await Promise.resolve(fn()).catch(() => {});
}
async function postCheckout(cartId, body, { who = null, country = null, address = ADDR, host = HOST_A, contact = CONTACT, drain = false, held = null } = {}) {
  const headers = { host, "content-type": "application/json", "x-forwarded-for": "10.0.0.9" };
  const cookie = cookieOf({ ...jarFor({ cartId, who, country }), cart_held: held });
  if (cookie) headers.cookie = cookie;
  const req = new NextRequest(`https://${host}/api/checkout`, { method: "POST", headers, body: JSON.stringify({ contact, address, ...body }) });
  const res = await checkout.POST(req);
  if (drain) await drainAfter();
  else globalThis.__subAfter = [];
  return { status: res.status, body: await res.json(), setCookie: (res.headers.getSetCookie?.() || []).join("; ") };
}
async function cartGet(cartId, { query = "", host = HOST_A, held = null } = {}) {
  const headers = { host };
  if (cartId) headers.cookie = `${CART_COOKIE}=${cartId}${held ? `; cart_held=${held}` : ""}`;
  const res = await cartRoute.GET(new NextRequest(`https://${host}/api/cart${query}`, { method: "GET", headers }));
  return res.json();
}
async function cartPost(cartId, body, { host = HOST_A } = {}) {
  const headers = { host, "content-type": "application/json" };
  if (cartId) headers.cookie = `${CART_COOKIE}=${cartId}`;
  const res = await cartRoute.POST(new NextRequest(`https://${host}/api/cart`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
async function account(method, { who = null, body, query = "", host = HOST_A, cartCookie = null } = {}) {
  const headers = { host, "content-type": "application/json" };
  const jar = [who ? `_customer=${who.token}` : null, cartCookie ? `${CART_COOKIE}=${cartCookie}` : null].filter(Boolean).join("; ");
  if (jar) headers.cookie = jar;
  const res = await accountSubs[method](new NextRequest(`https://${host}/api/account/subscriptions${query}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) }));
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, body: await res.json(), cartId: setCookie.map((c) => c.match(new RegExp(`^${CART_COOKIE}=([^;]*)`))?.[1]).find(Boolean) || null, held: setCookie.map((c) => c.match(/^cart_held=([^;]*)/)?.[1]).find(Boolean) || null };
}
async function adminCall(method, { body, query = "" } = {}) {
  const tokenValue = await adminSessionTokenFor("suba", ADMIN_PW);
  const headers = { host: HOST_A, "content-type": "application/json", cookie: `_admin=${tokenValue}`, origin: `https://${HOST_A}` };
  const res = await adminSubs[method](new NextRequest(`https://${HOST_A}/api/admin/subscriptions${query}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) }));
  return { status: res.status, body: await res.json() };
}

const razorpayCalls = [];
const rzStatus = new Map(); // Razorpay order id → its status at Razorpay (default "created")
globalThis.fetch = async (url, init) => {
  const read = /^https:\/\/api\.razorpay\.com\/v1\/orders\/([^/?]+)$/.exec(String(url));
  if (read && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ id: decodeURIComponent(read[1]), status: rzStatus.get(decodeURIComponent(read[1])) ?? "created" }), { status: 200 });
  if (String(url).startsWith("https://api.razorpay.com/")) {
    const sent = JSON.parse(init.body);
    razorpayCalls.push(sent);
    return new Response(JSON.stringify({ id: `order_sub${razorpayCalls.length}`, amount: sent.amount, currency: sent.currency }), { status: 200 });
  }
  return new Response("{}", { status: 503 }); // nothing else leaves (effects' pushes fail closed)
};

// Shopify's total for a draft: lines at the catalog price, gifts 100% off,
// the one order-level discount, the shipping line.
function shopifyTotal(input) {
  let minor = 0;
  for (const li of input.lineItems) {
    const unit = toMinor(price[num(li.variantId)], "INR");
    const pct = li.appliedDiscount?.valueType === "PERCENTAGE" ? li.appliedDiscount.value : 0;
    minor += Math.round(unit * li.quantity * (1 - pct / 100));
  }
  minor -= toMinor(input.appliedDiscount?.value || 0, "INR");
  minor += toMinor(Number(input.shippingLine?.price || 0), "INR");
  return minor / 100;
}

let seed = 20261126;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const orderRow = (id) => inA(() => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirst());
const subsOf = (who) => inA(() => db.selectFrom("subscriptions").selectAll().where("customer_id", "=", who.id).orderBy("created_at", "asc").execute());
const subRow = (id) => inA(() => db.selectFrom("subscriptions").selectAll().where("id", "=", id).executeTakeFirst());

// places a COD order when the store offers it, else an online one marked paid, and runs its effects
async function placeAny(cartId, who) {
  const q = (await postCheckout(cartId, { action: "quote" }, { who })).body.quote;
  if (q.cod.available) return placeCod(cartId, who);
  const r = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { who });
  await inA(() => db.updateTable("orders").set({ status: "paid", payment_status: "paid", paid_at: new Date().toISOString() }).where("id", "=", r.body.orderId).execute());
  await inA(() => ST.createSubscriptionsFor(r.body.orderId));
  return r;
}

// places a COD order for a cart as this shopper and runs its effects
async function placeCod(cartId, who, { drain = true } = {}) {
  const q = (await postCheckout(cartId, { action: "quote" }, { who })).body.quote;
  const r = await postCheckout(cartId, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who, drain });
  return { ...r, quote: q };
}

// ---- 1. engine and cart ----------------------------------------------------------------
console.log("— engine and cart");

await t("the catalog: Subscriptions is a first-party plugin with a sweep; the manifest keeps its promises; SUBSCRIPTION is not an offer type a founder can save", () => {
  ok(pluginById("subscriptions"), "not in the catalog");
  eq(checkCatalog(), [], "catalog problems");
  ok(typeof sweepFor("subscriptions") === "function", "no sweep registered");
  ok(!OFFER_TYPES.includes("SUBSCRIPTION"), "the validator accepts SUBSCRIPTION");
  eq(PR.normalizeSettings({ discount_percent: 31, every_30: true, every_7: true, reminder_days: 9, grace_days: 0 }), { percent: 0, intervals: [30], eligible: { kind: "all" }, reminderDays: 3, graceDays: 7 }, "normalize");
});

await t("engine: SUBSCRIPTION claims first, per unit rounding × quantity; a 0% subscription still claims; BXGY/TIERED/BUNDLE never stack on it; coupons take the net", () => {
  const line = (v, q, extra = {}) => ({ variantId: vid(v), productId: pid(v), price: price[v], quantity: q, tags: tagsOf[v], ...extra });
  const offers = [
    { id: "tier", type: "TIERED_QTY", scope: "line", priority: 10, title: "T", target: { kind: "tag", value: "serum" }, tiers: [{ minQty: 2, percent: 13 }] },
    { id: "bxgy", type: "BXGY", scope: "line", priority: 20, title: "B", target: { kind: "variantId", value: vid("2003") }, buy: 2, free: 1 },
    { id: "c7", type: "COUPON", scope: "order", priority: 50, title: "C", code: "C7", discount: { kind: "percent", value: 7 }, combinable: true },
  ];
  const sub = PR.subscriptionOffer({ [vid("2003")]: 13, [vid("2002")]: 0 });
  const r = evaluateOffers([line("2003", 3), line("2002", 2)], { offers: [sub, ...offers], coupon: "C7" });
  eq(r.lineDiscounts[vid("2003")], Math.round((89.5 * 13) / 100) * 3, "per unit × qty");
  eq(r.lineDiscounts[vid("2002")] || 0, 0, "a 0% subscribed line took the tier");
  ok(!r.appliedOffers.some((a) => a.id === "bxgy" || a.id === "tier"), "another line offer stacked");
  eq(r.appliedOffers.find((a) => a.type === "COUPON").amount, Math.round(((r.subtotal - r.lineDiscounts[vid("2003")]) * 7) / 100), "coupon on the net");
  const without = evaluateOffers([line("2003", 3), line("2002", 2)], { offers, coupon: null });
  ok(without.appliedOffers.some((a) => a.id === "bxgy") && without.appliedOffers.some((a) => a.id === "tier"), "control: the offers apply without the subscription");
});

await t("cart: subscribing stores the interval and prices the line; not eligible, an interval not offered, or a market stores one-time; a variant is one or the other", async () => {
  await setPlugin(inA, { ...SETTINGS, eligible: "tag", eligible_tag: "Subscribe", every_45: false });
  const c = await freshCart([["2005", 2, 30], ["2004", 1, 30], ["2008", 1, 45]]);
  const cart = await cartGet(c);
  const it = (v) => cart.items.find((i) => i.variantId === vid(v));
  eq(it("2005").subscription, { interval: 30, percent: 10, active: true, applied: true }, "subscribed line");
  eq(it("2005").discount, Math.round(4999 * 0.1) * 2, "line discount");
  eq(it("2004").subscription ?? null, null, "not eligible → one-time");
  eq(it("2008").subscription ?? null, null, "an interval not offered → one-time");
  ok(cart.hasSubscription, "hasSubscription");
  // the same variant added one-time: one-time
  await inA(() => addItem(c, vid("2005"), 1));
  const again = await cartGet(c);
  eq(again.items.find((i) => i.variantId === vid("2005")).subscription ?? null, null, "latest choice");
  eq(again.items.find((i) => i.variantId === vid("2005")).quantity, 3, "quantity merged");
  // a market cart stores none
  const m = `sub-cart-${++carts}`;
  await inA(async () => {
    await createCart(m);
    await addItem(m, vid("2005"), 1, { subscriptionInterval: 30, market: { id: "US", currency: "USD" } });
  });
  eq((await inA(() => db.selectFrom("cart_items").select("subscription_interval").where("cart_id", "=", m).executeTakeFirst())).subscription_interval, null, "a market add");
  await setPlugin(inA, SETTINGS);
});

await t("cart route: the PDP offer comes from the server (prices per variant), none in a market or when off; the body's discount, percent and subscription id are ignored", async () => {
  const offer = (await cartGet(null, { query: `?subscribe=${encodeURIComponent(pid("2008"))}` })).offer;
  eq(offer.percent, 10, "percent");
  eq(offer.intervals, [14, 30, 45, 60, 90], "intervals");
  eq(offer.prices, { [vid("2008")]: 599 - 60, [vid("2018")]: 899 - 90 }, "prices");
  const r = await cartPost(null, { action: "add", variantId: vid("2008"), quantity: 2, subscriptionInterval: 30, discount: 500, percent: 90, subscription_id: "sub_aaaaaaaaaaaaaaaa", subscriptionPercent: 90 });
  eq(r.status, 200, "add");
  const line = r.body.items.find((i) => i.variantId === vid("2008"));
  eq(line.discount, (599 - offer.prices[vid("2008")]) * 2, "the PDP price × qty is the cart line");
  eq(line.lineTotal - line.discount, offer.prices[vid("2008")] * 2, "line net");
  await setPlugin(inA, SETTINGS, "disabled");
  eq((await cartGet(null, { query: `?subscribe=${encodeURIComponent(pid("2008"))}` })).offer, null, "plugin off");
  await setPlugin(inA, SETTINGS);
});

await t("plugin off or killed → the line is priced one-time and the drawer says so; a stored SUBSCRIPTION offer row is never applied", async () => {
  const c = await freshCart([["2005", 1, 30]]);
  await setPlugin(inA, SETTINGS, "disabled");
  let line = (await cartGet(c)).items[0];
  eq([line.subscription.active, line.discount], [false, 0], "disabled");
  await setPlugin(inA, SETTINGS);
  await setFlag({ key: "ff_plugin-subscriptions", description: "kill", default_on: false, create: true, actor: "test" });
  line = (await cartGet(c)).items[0];
  eq([line.subscription.active, line.discount], [false, 0], "killed");
  await setFlag({ key: "ff_plugin-subscriptions", description: "kill", default_on: true, actor: "test" });
  line = (await cartGet(c)).items[0];
  eq(line.subscription.active, true, "back on");
  // a forged row of type SUBSCRIPTION (the validator would refuse it) is dropped
  await inA(() => libsql.execute({ sql: "INSERT INTO offers (id, type, scope, priority, title, rules, enabled, created_at, updated_at) SELECT 'forged', 'SUBSCRIPTION', 'line', 0, 'Forged', ?, 1, created_at, updated_at FROM offers LIMIT 1", args: [JSON.stringify({ lines: { [vid("2004")]: 90 } })] }).catch(() => null));
  const c2 = await freshCart([["2004", 1]]);
  eq((await cartGet(c2)).items[0].discount, 0, "forged offer applied");
  await inA(() => db.deleteFrom("offers").where("id", "=", "forged").execute());
});

await t("an exclusive code switches the subscriber discount off like a bundle's, and the line says so; the subscription keeps its percent", async () => {
  const c = await freshCart([["2005", 1, 30]], "SOLO10");
  const cart = await cartGet(c);
  eq(cart.items[0].discount, 0, "no line discount");
  eq(cart.items[0].subscription, { interval: 30, percent: 10, active: true, applied: false }, "line state");
  eq(cart.discountTotal, Math.round(4999 * 0.1), "the code on the full subtotal");
});

// ---- 2. checkout ----------------------------------------------------------------------------
console.log("— checkout");

await t("checkout: signed out → 401 Sign in to subscribe (nothing created); a market → 409 plain words; the sub: key is reserved", async () => {
  const c = await freshCart([["2005", 1, 30], ["2004", 1]]);
  const q = (await postCheckout(c, { action: "quote" })).body.quote;
  const before = await inA(() => db.selectFrom("orders").select(db.fn.countAll().as("n")).executeTakeFirst());
  for (const action of ["cod", "razorpay_create"]) {
    const r = await postCheckout(c, { action, idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping });
    eq([r.status, r.body.code, r.body.error], [401, "SIGN_IN_TO_SUBSCRIBE", "Sign in to subscribe"], action);
    ok(r.body.signIn?.startsWith("/account"), "sign-in link");
  }
  eq((await inA(() => db.selectFrom("orders").select(db.fn.countAll().as("n")).executeTakeFirst())).n, before.n, "an order was written");
  const who = await shopper();
  // the shopper's cart in the US: the market cookie matches the address country
  const m = await postCheckout(c, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: 1, expectedShipping: 0, expectedCurrency: "USD" }, { who, country: "US", address: { ...ADDR, pincode: "78701", city: "Austin", state: "TX", country: "United States", country_code: "US" } });
  eq([m.status, m.body.code], [409, "SUBSCRIPTION_BASE_MARKET"], `market ${JSON.stringify(m.body).slice(0, 160)}`);
  ok(/only available for delivery in India/.test(m.body.error), m.body.error);
  const reserved = await postCheckout(c, { action: "cod", idempotencyKey: "sub:sub_0000000000000000:2" }, { who });
  eq(reserved.status, 400, "reserved key");
});

await t("checkout signed in: the order is bound to the shopper; its effects create one subscription per subscribed line, once, at the locked percent", async () => {
  const who = await shopper();
  const c = await freshCart([["2005", 2, 30], ["2008", 1, 60], ["2004", 1]]);
  const r = await placeCod(c, who);
  eq(r.status, 200, `cod ${JSON.stringify(r.body).slice(0, 160)}`);
  const order = await orderRow(r.body.orderId);
  eq(order.customer_id, who.id, "order customer");
  let subs = await subsOf(who);
  eq(subs.map((s) => [num(s.variant_id), s.quantity, s.interval_days, s.discount_percent, s.status, s.cycle]), [["2005", 2, 30, 10, "active", 2], ["2008", 1, 60, 10, "active", 2]].sort(), "subscriptions");
  eq(subs.find((s) => s.interval_days === 30).next_due_at, new Date(Date.parse(order.created_at) + 30 * DAY).toISOString(), "next due");
  // effects again (a replay) create nothing
  await inA(() => runOrderEffects(order.id));
  await inA(() => ST.createSubscriptionsFor(order.id));
  subs = await subsOf(who);
  eq(subs.length, 2, "replay");
  // a pending online order creates nothing until paid
  const c2 = await freshCart([["2007", 1, 30]]);
  const q = (await postCheckout(c2, { action: "quote" }, { who })).body.quote;
  const rz = await postCheckout(c2, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { who });
  eq(rz.status, 200, "razorpay_create");
  eq((await inA(() => ST.createSubscriptionsFor(rz.body.orderId))).created, 0, "pending order");
  await inA(() => db.updateTable("orders").set({ status: "paid", payment_status: "paid", paid_at: new Date().toISOString() }).where("id", "=", rz.body.orderId).execute());
  const dbg = await orderRow(rz.body.orderId);
  eq((await inA(() => ST.createSubscriptionsFor(rz.body.orderId))).created, 1, `paid order ${dbg.status} ${dbg.customer_id} ${JSON.stringify(JSON.parse(dbg.snapshot).items.map((i) => i.subscription))}`);
  eq((await inA(() => ST.createSubscriptionsFor(rz.body.orderId))).created, 0, "paid replay");
});

// ---- 3. account ------------------------------------------------------------------------------
console.log("— account");

let A = null;
let B = null;
let subA = null;
await t("account: signed out → 401 with no data (GET and POST); own subscriptions only; another shopper's id → 404 like a missing one, row unchanged", async () => {
  A = await shopper();
  B = await shopper();
  await placeCod(await freshCart([["2008", 1, 30]]), A);
  await placeCod(await freshCart([["2001", 1, 14]]), B);
  subA = (await subsOf(A))[0];
  const subB = (await subsOf(B))[0];
  for (const [m, body] of [["GET"], ["POST", { action: "cancel", id: subA.id }]]) {
    const r = await account(m, { body });
    eq([r.status, Object.keys(r.body)], [401, ["error"]], `signed out ${m}`);
  }
  const list = await account("GET", { who: A });
  eq(list.status, 200, "GET");
  eq(list.body.subscriptions.map((s) => s.id), [subA.id], "own only");
  const s = list.body.subscriptions[0];
  ok(s.next && s.next.currency === "INR" && s.nextDueAt === subA.next_due_at, "figure and due");
  ok(!JSON.stringify(list.body).includes(subB.id) && !JSON.stringify(list.body).includes(B.email), "another shopper's data");
  const before = await subRow(subB.id);
  for (const action of ["skip", "pause", "resume", "cancel", "swap", "change", "pay"]) {
    const r = await account("POST", { who: A, body: { action, id: subB.id, variantId: vid("2018"), interval: 30, quantity: 2 } });
    eq([r.status, r.body], [404, { error: "subscription not found" }], `${action} on B's`);
    const missing = await account("POST", { who: A, body: { action, id: "sub_ffffffffffffffff", variantId: vid("2018"), interval: 30, quantity: 2 } });
    eq([missing.status, missing.body], [404, { error: "subscription not found" }], `${action} on a missing one`);
  }
  eq(await subRow(subB.id), before, "B's row changed");
  eq((await account("GET", { who: A, query: `?swap=${subB.id}` })).status, 404, "swap options for B's");
  // store B can't see store A's subscription
  const other = await shopper(inB);
  const onB = await account("GET", { who: other, host: HOST_B });
  eq([onB.status, onB.body.subscriptions], [200, []], "store B");
});

await t("account actions: skip moves due one interval; pause until a date / resume; swap changes the variant; change interval and quantity (1–10); cancel keeps the row", async () => {
  let s = await subRow(subA.id);
  const due0 = s.next_due_at;
  let r = await account("POST", { who: A, body: { action: "skip", id: s.id } });
  eq(r.status, 200, "skip");
  s = await subRow(subA.id);
  eq([s.next_due_at, s.cycle], [new Date(Date.parse(due0) + 30 * DAY).toISOString(), 3], "skip moved");
  eq((await inA(() => db.selectFrom("subscription_cycles").selectAll().where("subscription_id", "=", s.id).execute())).map((c) => [c.cycle, c.status]), [[2, "skipped"]], "skipped cycle");
  const until = new Date(NOW + 20 * DAY).toISOString().slice(0, 10);
  r = await account("POST", { who: A, body: { action: "pause", id: s.id, until } });
  eq(r.status, 200, "pause");
  s = await subRow(subA.id);
  eq([s.status, s.paused_until], ["paused", `${until}T00:00:00.000Z`], "paused");
  eq((await account("POST", { who: A, body: { action: "skip", id: s.id } })).status, 409, "skip while paused");
  eq((await account("POST", { who: A, body: { action: "pause", id: s.id } })).status, 409, "pause twice");
  r = await account("POST", { who: A, body: { action: "resume", id: s.id } });
  eq([r.status, (await subRow(subA.id)).status], [200, "active"], "resume");
  eq((await account("POST", { who: A, body: { action: "pause", id: s.id, until: "2001-01-01" } })).status, 422, "a date in the past");
  const opts = (await account("GET", { who: A, query: `?swap=${s.id}` })).body.options;
  ok(opts.some((o) => o.variantId === vid("2018") && o.price === 899 - 90), "the other variant at its subscribed price");
  r = await account("POST", { who: A, body: { action: "swap", id: s.id, variantId: vid("2018") } });
  eq([r.status, num((await subRow(subA.id)).variant_id)], [200, "2018"], "swap");
  eq((await account("POST", { who: A, body: { action: "swap", id: s.id, variantId: "gid://shopify/ProductVariant/9999" } })).status, 422, "swap to nothing");
  r = await account("POST", { who: A, body: { action: "change", id: s.id, interval: 60, quantity: 3 } });
  s = await subRow(subA.id);
  eq([r.status, s.interval_days, s.quantity, s.discount_percent], [200, 60, 3, 10], "change");
  for (const bad of [{ quantity: 11 }, { quantity: 0 }, { quantity: 1.5 }, { interval: 7 }]) eq((await account("POST", { who: A, body: { action: "change", id: s.id, ...bad } })).status, 422, JSON.stringify(bad));
  // put it back to 30 days × 1 for the renewal tests
  await account("POST", { who: A, body: { action: "change", id: s.id, interval: 30, quantity: 1 } });
});

await t("pay for this delivery: not before the reminder window; then a renewal cart → checkout at the account's figure; the cycle gets the order and due moves on, once", async () => {
  let s = await subRow(subA.id);
  eq((await account("POST", { who: A, body: { action: "pay", id: s.id } })).status, 409, "not due yet");
  NOW = Date.parse(s.next_due_at) - 2 * DAY;
  const list = (await account("GET", { who: A })).body.subscriptions[0];
  ok(list.payable, `payable ${JSON.stringify(list)} now ${new Date(NOW).toISOString()}`);
  const pay = await account("POST", { who: A, body: { action: "pay", id: s.id } });
  eq([pay.status, pay.body.redirect], [200, "/checkout"], "pay");
  ok(pay.cartId, "cart cookie");
  const again = await account("POST", { who: A, body: { action: "pay", id: s.id } });
  eq(again.cartId, pay.cartId, "the same renewal cart for the same cycle");
  const cart = await cartGet(pay.cartId);
  eq([cart.renewal, cart.items.length, cart.items[0].subscription.renewal], [{ subscriptionId: s.id, cycle: s.cycle }, 1, true], "renewal cart");
  const q = (await postCheckout(pay.cartId, { action: "quote" }, { who: A })).body.quote;
  eq(q.prepaid.total, list.next.amount, "quote = account figure");
  // another shopper holding this cart cookie is refused
  const stranger = await postCheckout(pay.cartId, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who: B });
  eq([stranger.status, stranger.body.code], [409, "RENEWAL_CHANGED"], "stranger");
  const placed = await postCheckout(pay.cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping, discount: 999, subscription_id: "sub_x" }, { who: A });
  eq(placed.status, 200, `renewal ${JSON.stringify(placed.body).slice(0, 160)}`);
  const order = await orderRow(placed.body.orderId);
  eq([order.idempotency_key, order.total, order.customer_id], [ST.renewalKey(s.id, s.cycle), q.prepaid.total, A.id], "renewal order");
  await inA(() => db.updateTable("orders").set({ status: "paid", payment_status: "paid", paid_at: new Date().toISOString() }).where("id", "=", order.id).execute());
  await inA(() => ST.createSubscriptionsFor(order.id));
  await inA(() => ST.createSubscriptionsFor(order.id));
  const after = await subRow(s.id);
  eq([after.cycle, after.next_due_at], [s.cycle + 1, new Date(Date.parse(s.next_due_at) + 30 * DAY).toISOString()], "moved once");
  const cyc = await inA(() => db.selectFrom("subscription_cycles").selectAll().where("subscription_id", "=", s.id).where("cycle", "=", s.cycle).executeTakeFirst());
  eq([cyc.status, cyc.order_id], ["ordered", order.id], "cycle linked");
  eq((await subsOf(A)).length, 1, "a renewal created a new subscription");
  NOW = START;
});

await t("one order per cycle even when two renewal checkouts race", async () => {
  const who = await shopper();
  await placeCod(await freshCart([["2005", 1, 30]]), who);
  const s = (await subsOf(who))[0];
  NOW = Date.parse(s.next_due_at) - DAY;
  const one = (await account("POST", { who, body: { action: "pay", id: s.id } })).cartId;
  // a second renewal cart for the same cycle (another device)
  const two = "sub-race-two";
  await inA(async () => {
    await libsql.execute({ sql: "INSERT INTO carts (id, coupon_code, created_at, updated_at, subscription_id, subscription_cycle) VALUES (?, NULL, ?, ?, ?, ?)", args: [two, new Date().toISOString(), new Date().toISOString(), s.id, s.cycle] });
    await libsql.execute({ sql: "INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, price_at_add, added_at, subscription_interval, renewal) VALUES (?, ?, ?, 1, 4999, ?, 30, 1)", args: [two, s.variant_id, s.product_id, new Date().toISOString()] });
  });
  const q = (await postCheckout(one, { action: "quote" }, { who })).body.quote;
  const body = () => ({ action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping });
  const [r1, r2] = await Promise.all([postCheckout(one, body(), { who }), postCheckout(two, body(), { who })]);
  eq([r1.status, r2.status].sort(), [200, 409], `race ${JSON.stringify([r1.body, r2.body]).slice(0, 200)}`);
  const orders = await inA(() => db.selectFrom("orders").select(["id"]).where("idempotency_key", "=", ST.renewalKey(s.id, s.cycle)).execute());
  eq(orders.length, 1, "orders for the cycle");
  NOW = START;
});

await t("cancel behind the confirm: kept as cancelled, never deleted; nothing more can change it; the account still lists it, without a figure", async () => {
  const r = await account("POST", { who: A, body: { action: "cancel", id: subA.id } });
  eq(r.status, 200, "cancel");
  const s = await subRow(subA.id);
  eq([s.status, s.cancel_reason, Boolean(s.cancelled_at)], ["cancelled", "customer", true], "cancelled row");
  for (const action of ["skip", "resume", "swap", "change", "cancel"]) eq((await account("POST", { who: A, body: { action, id: s.id, variantId: vid("2008"), interval: 30 } })).status, 409, action);
  const listed = (await account("GET", { who: A })).body.subscriptions[0];
  eq([listed.status, listed.next, listed.payable], ["cancelled", null, false], "listed");
});

// ---- 4. sweep ---------------------------------------------------------------------------------
console.log("— sweep");

const install = () => ({ id: "pin_subs", pluginId: "subscriptions", settings: settingsNow });
const runSweep = (at) => inA(() => sweep({ install: install(), now: at, log: () => {} }));
const notes = (type) => inA(() => db.selectFrom("notifications").selectAll().where("type", "=", type).execute());

await t("sweep: due within the reminder days → the cycle is due and one reminder (amount = the account figure; a link to /account, no pay link; no banned copy); a window run twice sends nothing twice", async () => {
  const who = await shopper();
  await placeCod(await freshCart([["2002", 1, 30]]), who);
  const s = (await subsOf(who))[0];
  const at = Date.parse(s.next_due_at) - 3 * DAY + 60_000;
  NOW = at;
  const figure = (await account("GET", { who })).body.subscriptions[0].next.amount;
  const mineNow = async () => (await notes("subscription_reminder")).filter((n) => n.recipient === who.email);
  await runSweep(Date.parse(s.next_due_at) - 4 * DAY);
  eq((await mineNow()).length, 0, "too early");
  await runSweep(at);
  await runSweep(at + 60_000);
  const mine = (await notes("subscription_reminder")).filter((n) => n.recipient === who.email);
  eq(mine.length, 1, "one reminder");
  ok(mine[0].body.includes(formatMoney(figure, "INR")), `amount ${figure} not in ${mine[0].body}`);
  ok(mine[0].body.includes("Nothing is charged automatically") && /\/account/.test(mine[0].body) && !/\/checkout|razorpay|rzp_/i.test(mine[0].body), "copy");
  eq(scanText(`${mine[0].subject}\n${mine[0].body}`, { shopper: true }).map((f) => f.label), [], "banned copy");
  const cyc = await inA(() => db.selectFrom("subscription_cycles").selectAll().where("subscription_id", "=", s.id).execute());
  eq(cyc.map((c) => [c.cycle, c.status, Boolean(c.reminded_at)]), [[2, "due", true]], "cycle due");
  NOW = START;
});

await t("sweep: not paid within the grace days → missed, the next scheduled; two misses in a row pause with an email; a pause that ran out resumes", async () => {
  const who = await shopper();
  await placeCod(await freshCart([["2007", 1, 14]]), who);
  let s = (await subsOf(who))[0];
  const due1 = s.next_due_at;
  await runSweep(Date.parse(due1) - 2 * DAY); // the reminder: the grace runs from here
  await runSweep(Date.parse(due1) + 4 * DAY); // 6 days after the reminder: not yet
  eq((await subRow(s.id)).missed_in_row, 0, "inside the grace after the reminder");
  await runSweep(Date.parse(due1) + 8 * DAY);
  s = await subRow(s.id);
  eq([s.status, s.cycle, s.missed_in_row, s.next_due_at], ["active", 3, 1, new Date(Date.parse(due1) + 14 * DAY).toISOString()], "first miss");
  await runSweep(Date.parse(due1) + 8 * DAY); // the same window again
  eq((await subRow(s.id)).cycle, 3, "the same window twice");
  await runSweep(Date.parse(s.next_due_at) - 2 * DAY);
  await runSweep(Date.parse(s.next_due_at) + 8 * DAY);
  s = await subRow(s.id);
  eq([s.status, s.missed_in_row, s.paused_until], ["paused", 2, null], "second miss pauses");
  eq((await notes("subscription_paused")).filter((n) => n.recipient === who.email).length, 1, "paused email");
  const cyc = await inA(() => db.selectFrom("subscription_cycles").select(["cycle", "status"]).where("subscription_id", "=", s.id).orderBy("cycle").execute());
  eq(cyc.map((c) => c.status).filter((x) => x === "missed").length, 2, "missed cycles");
  // a dated pause ends by itself
  await inA(() => db.updateTable("subscriptions").set({ paused_until: new Date(NOW + DAY).toISOString() }).where("id", "=", s.id).execute());
  const out = await runSweep(NOW + 2 * DAY);
  ok(out.resumed >= 1 && (await subRow(s.id)).status === "active", "resumed");
});

// ---- 4b. review fixes ------------------------------------------------------------------------
console.log("— review fixes");

const SIGN = (o, p) => createHmac("sha256", "sub-key-secret").update(`${o}|${p}`).digest("hex");
async function dueSub(v = "2005", interval = 30) {
  const who = await shopper();
  await placeCod(await freshCart([[v, 1, interval]]), who);
  const s = (await subsOf(who))[0];
  NOW = Date.parse(s.next_due_at) - DAY;
  return { who, s };
}
const cycleOrders = (s) => inA(() => db.selectFrom("orders").select(["id", "status", "payment_method", "idempotency_key"]).where("idempotency_key", "like", `${ST.renewalKey(s.id, s.cycle)}%`).execute());

await t("an abandoned online payment doesn't lock the delivery: COD afterwards is placed, the unpaid attempt cancelled; never answered as a COD order", async () => {
  const { who, s } = await dueSub();
  const cart = (await account("POST", { who, body: { action: "pay", id: s.id } })).cartId;
  const q = (await postCheckout(cart, { action: "quote" }, { who })).body.quote;
  const rz = await postCheckout(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { who });
  eq(rz.status, 200, "online attempt");
  const cod = await postCheckout(cart, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who, drain: true });
  eq(cod.status, 200, `cod after an abandoned online attempt ${JSON.stringify(cod.body).slice(0, 160)}`);
  ok(cod.body.orderId !== rz.body.orderId, "the COD answer is the online attempt");
  const rows = await cycleOrders(s);
  eq(rows.filter((r) => r.status !== "cancelled").map((r) => [r.payment_method, r.idempotency_key]), [["cod", ST.renewalKey(s.id, s.cycle)]], "one live order for the cycle");
  eq(rows.find((r) => r.id === rz.body.orderId).status, "cancelled", "the unpaid attempt is cancelled");
  eq((await subRow(s.id)).cycle, s.cycle + 1, "the COD renewal moved the subscription on");
  NOW = START;
});

await t("an abandoned online payment, then the price changes: a new online attempt is minted at the new price", async () => {
  const { who, s } = await dueSub("2008");
  const cart = (await account("POST", { who, body: { action: "pay", id: s.id } })).cartId;
  const q = (await postCheckout(cart, { action: "quote" }, { who })).body.quote;
  const rz = await postCheckout(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { who });
  eq(rz.status, 200, "first attempt");
  const v = num(s.variant_id);
  const old = price[v];
  price[v] = old + 250;
  await inA(() => db.updateTable("variants").set({ price: price[v] }).where("id", "=", s.variant_id).execute());
  const q2 = (await postCheckout(cart, { action: "quote" }, { who })).body.quote;
  ok(q2.prepaid.total > q.prepaid.total, "the price moved");
  const before = razorpayCalls.length;
  const rz2 = await postCheckout(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q2.prepaid.total, expectedShipping: q2.prepaid.shipping }, { who });
  eq(rz2.status, 200, `second attempt ${JSON.stringify(rz2.body).slice(0, 160)}`);
  eq(razorpayCalls[before]?.amount, toMinor(q2.prepaid.total, "INR"), "minted at the new price");
  const rows = await cycleOrders(s);
  eq(rows.filter((r) => r.status !== "cancelled").map((r) => r.id), [rz2.body.orderId], "one live order for the cycle");
  // the same attempt again reopens the same payment
  const again = await postCheckout(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q2.prepaid.total, expectedShipping: q2.prepaid.shipping }, { who });
  eq([again.status, again.body.orderId, again.body.deduped], [200, rz2.body.orderId, true], "the same attempt reopens");
  price[v] = old;
  await inA(() => db.updateTable("variants").set({ price: old }).where("id", "=", s.variant_id).execute());
  NOW = START;
});

await t("a renewal paid through Razorpay verify: settled, the cycle linked, the shopper's own cart back", async () => {
  const { who, s } = await dueSub("2001", 14);
  const own = await freshCart([["2004", 2]]);
  const pay = await account("POST", { who, body: { action: "pay", id: s.id }, cartCookie: own });
  ok(pay.held === own, `the own cart is held (${pay.held})`);
  const drawer = await cartGet(pay.cartId, { held: own });
  eq(drawer.heldCart, true, "the drawer says the other items are saved");
  const q = (await postCheckout(pay.cartId, { action: "quote" }, { who })).body.quote;
  const rz = await postCheckout(pay.cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { who });
  eq(rz.status, 200, "minted");
  const rzId = rz.body.razorpayOrderId;
  const v = await postCheckout(pay.cartId, { action: "razorpay_verify", orderId: rz.body.orderId, razorpay_order_id: rzId, razorpay_payment_id: "pay_sub1", razorpay_signature: SIGN(rzId, "pay_sub1") }, { who, held: own, drain: true });
  eq(v.status, 200, `verify ${JSON.stringify(v.body)}`);
  ok(v.setCookie.includes(`${CART_COOKIE}=${own}`), `the own cart comes back: ${v.setCookie}`);
  eq((await orderRow(rz.body.orderId)).status === "pending_payment", false, "paid");
  const after = await subRow(s.id);
  eq(after.cycle, s.cycle + 1, "moved on by the verified payment's effects");
  const cyc = await inA(() => db.selectFrom("subscription_cycles").selectAll().where("subscription_id", "=", s.id).where("cycle", "=", s.cycle).executeTakeFirst());
  eq(cyc.order_id, rz.body.orderId, "the cycle names the order");
  // the own cart is untouched
  eq((await cartGet(own)).items.map((i) => [num(i.variantId), i.quantity]), [["2004", 2]], "own cart");
  NOW = START;
});

await t("COD renewal: the shopper's own cart comes back with the answer; an abandoned (stale) renewal cart gives it back on the next cart read", async () => {
  const { who, s } = await dueSub("2007");
  const own = await freshCart([["2006", 1]]);
  const pay = await account("POST", { who, body: { action: "pay", id: s.id }, cartCookie: own });
  const q = (await postCheckout(pay.cartId, { action: "quote" }, { who })).body.quote;
  const cod = await postCheckout(pay.cartId, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who, held: own, drain: true });
  eq(cod.status, 200, "cod");
  ok(cod.setCookie.includes(`${CART_COOKIE}=${own}`) && /cart_held=;/.test(cod.setCookie), `restored: ${cod.setCookie}`);
  // abandoned: Pay, then Skip in another tab; the next cart read gives the own cart back
  NOW = Date.parse((await subRow(s.id)).next_due_at) - DAY;
  const pay2 = await account("POST", { who, body: { action: "pay", id: s.id }, cartCookie: own });
  await account("POST", { who, body: { action: "skip", id: s.id } });
  const res = await cartRoute.GET(new NextRequest(`https://${HOST_A}/api/cart`, { headers: { host: HOST_A, cookie: `${CART_COOKIE}=${pay2.cartId}; cart_held=${own}` } }));
  const body = await res.json();
  eq(body.id, own, "the own cart answers");
  ok((res.headers.getSetCookie?.() || []).some((c) => c.startsWith(`${CART_COOKIE}=${own}`)), "and is cookied back");
  NOW = START;
});

await t("a renewal cart left open after Skip: the place is refused (409 RENEWAL_CHANGED), the delivery's line goes and the cart is ordinary again; no second subscription", async () => {
  const { who, s } = await dueSub("2002");
  const cart = (await account("POST", { who, body: { action: "pay", id: s.id } })).cartId;
  const q = (await postCheckout(cart, { action: "quote" }, { who })).body.quote;
  eq((await account("POST", { who, body: { action: "skip", id: s.id } })).status, 200, "skip in another tab");
  const r = await postCheckout(cart, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who, drain: true });
  eq([r.status, r.body.code], [409, "RENEWAL_CHANGED"], "place on the stale cart");
  ok(/skipped, paid for, paused or swapped/.test(r.body.error), r.body.error);
  const marker = await inA(() => db.selectFrom("carts").select(["subscription_id", "subscription_cycle"]).where("id", "=", cart).executeTakeFirst());
  eq([marker.subscription_id, marker.subscription_cycle], [null, null], "the marker cleared");
  const c = await cartGet(cart);
  eq([c.items.length, c.renewal ?? null, c.renewalStale ?? false], [0, null, false], "an ordinary, empty cart");
  // Subscribe on the product page into the same cart: a subscription line, and checkout works
  const add = await cartPost(cart, { action: "add", variantId: vid("2008"), quantity: 1, subscriptionInterval: 30 });
  eq(add.body.items.map((i) => [num(i.variantId), i.subscription?.active, i.subscription?.renewal ?? false]), [["2008", true, false]], "subscribed as a sign-up");
  eq(add.body.items[0].discount, Math.round(599 * 0.1), "priced as a subscription");
  const placed = await placeCod(cart, who);
  eq(placed.status, 200, `checkout works ${JSON.stringify(placed.body).slice(0, 140)}`);
  const subs = await subsOf(who);
  eq(subs.map((x) => num(x.variant_id)).sort(), ["2002", "2008"], "the new sign-up only (the skipped delivery made none)");
  NOW = START;
});

await t("never paid twice: an online attempt Razorpay shows as attempted or paid is not replaced (plain words); a capture that still lands on a replaced order is flagged for a refund", async () => {
  const { who, s } = await dueSub("2005");
  const cart = (await account("POST", { who, body: { action: "pay", id: s.id } })).cartId;
  const q = (await postCheckout(cart, { action: "quote" }, { who })).body.quote;
  const rz = await postCheckout(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { who });
  for (const status of ["attempted", "paid"]) {
    rzStatus.set(rz.body.razorpayOrderId, status);
    const cod = await postCheckout(cart, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who });
    eq([cod.status, cod.body.code, cod.body.error], [409, "RENEWAL_PAYMENT_PENDING", "Your online payment for this delivery is still going through. Check back in a few minutes."], status);
    eq((await orderRow(rz.body.orderId)).status, "pending_payment", `${status}: the online attempt stands`);
  }
  // Razorpay still shows it created: COD replaces it; then a capture lands on the cancelled order anyway
  rzStatus.set(rz.body.razorpayOrderId, "created");
  const cod = await postCheckout(cart, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { who, drain: true });
  eq(cod.status, 200, "COD replaces it");
  const { markOrderPaid } = await import("../lib/orders.js");
  let threw = false;
  try {
    await inA(() => markOrderPaid(rz.body.orderId, { razorpayPaymentId: "pay_late1", source: "webhook" }));
  } catch {
    threw = true;
  }
  ok(threw, "a cancelled order is never marked paid");
  await inA(() => markOrderPaid(rz.body.orderId, { razorpayPaymentId: "pay_late1", source: "webhook" })).catch(() => {}); // a redelivery
  const events = (await inA(() => db.selectFrom("order_events").select(["meta"]).where("order_id", "=", rz.body.orderId).execute())).map((e) => JSON.parse(e.meta || "{}")).filter((m) => m.reason === "payment_on_replaced_order");
  eq(events.map((m) => m.late_payment), ["pay_late1"], "one flag, once");
  const mails = (await notes("payment_on_replaced_order")).filter((n) => n.subject.includes(rz.body.orderId));
  eq(mails.length, 1, "one email to the founder");
  ok(mails[0].body.startsWith("A payment arrived for a replaced order; refund it.") && mails[0].body.includes("pay_late1"), mails[0].body);
  const { LatePaymentBanner } = await import("../components/admin/orders/LatePaymentBanner.js").catch(() => ({}));
  if (LatePaymentBanner) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const html = renderToStaticMarkup(createElement(LatePaymentBanner, { events: [{ meta: events[0] }] }));
    ok(html.includes("refund it") && html.includes("pay_late1") && html.includes("Refund"), html);
  }
  NOW = START;
});

await t("swap while a delivery is due applies from the next cycle; the due delivery keeps its variant", async () => {
  await setPlugin(inA, SETTINGS);
  const { who, s } = await dueSub("2008");
  eq((await account("POST", { who, body: { action: "swap", id: s.id, variantId: vid("2018") } })).status, 200, "swap");
  let row = await subRow(s.id);
  eq([num(row.variant_id), num(row.swap_variant_id)], ["2008", "2018"], "pending");
  eq((await account("POST", { who, body: { action: "skip", id: s.id } })).status, 200, "skip the due one");
  row = await subRow(s.id);
  eq([num(row.variant_id), row.swap_variant_id], ["2018", null], "applied from the next cycle");
  NOW = START;
});

await t("the plugin off longer than the grace, then on: the unreminded delivery is skipped forward, not missed; a reminder follows", async () => {
  const who = await shopper();
  await placeCod(await freshCart([["2002", 1, 14]]), who);
  const s = (await subsOf(who))[0];
  const back = Date.parse(s.next_due_at) + 20 * DAY;
  const a = await runSweep(back);
  await runSweep(back + 10 * 60_000);
  const after = await subRow(s.id);
  eq([after.status, after.missed_in_row, after.cycle], ["active", 0, s.cycle + 1], `no miss ${JSON.stringify(a)}`);
  ok(a.skipped >= 1, "skipped forward");
  const cyc = await inA(() => db.selectFrom("subscription_cycles").select(["status"]).where("subscription_id", "=", s.id).where("cycle", "=", s.cycle).executeTakeFirst());
  eq(cyc.status, "skipped_off", "its own status, not the shopper's skip");
  ok((await notes("subscription_reminder")).some((n) => n.recipient === who.email), "reminded for the next one");
});

await t("quantity over 10 never signs up (one-time price, the drawer says why); the console names any subscription, not only the newest 200", async () => {
  const who = await shopper();
  const c = await freshCart([["2005", 25, 30]]);
  const line = (await cartGet(c)).items[0];
  eq([line.subscription.active, line.subscription.limit, line.discount], [false, 10, 0], "over the limit");
  await placeCod(c, who);
  eq((await subsOf(who)).length, 0, "no subscription");
  const oldest = await inA(() => db.selectFrom("subscriptions").select(["id"]).orderBy("created_at", "asc").executeTakeFirst());
  ok(oldest && (await inA(() => consoleDetail(oldest.id, { role: "staff" })))?.id === oldest.id, "detail of the oldest");
});

// ---- 5. console, privacy, export ------------------------------------------------------------
console.log("— console, privacy, export");

await t("console: support reads no customer or reason; staff and up see them; a cancel for a customer needs a reason and is audited", async () => {
  const supportRows = await inA(() => consoleList({ role: "support" }));
  ok(supportRows.length > 3, "rows");
  ok(supportRows.every((r) => r.customer === null && r.cancelReason === null && r.pii_redacted === true), "support sees customer details");
  ok(!JSON.stringify(supportRows).includes("@shopper.test"), "an email reached support");
  const staffRows = await inA(() => consoleList({ role: "staff" }));
  ok(staffRows.some((r) => r.customer?.email?.endsWith("@shopper.test")), "staff sees customers");
  eq((await inA(() => consoleList({ role: "staff", status: "cancelled" }))).every((r) => r.status === "cancelled"), true, "filter");
  const target = staffRows.find((r) => r.status === "active");
  const detail = await inA(() => consoleDetail(target.id, { role: "support" }));
  ok(Array.isArray(detail.history) && detail.customer === null, "detail redacted");
  eq((await adminCall("POST", { body: { action: "cancel", id: target.id, reason: "" } })).status, 422, "no reason");
  const r = await adminCall("POST", { body: { action: "cancel", id: target.id, reason: "Customer asked by phone" } });
  eq([r.status, r.body.status], [200, "cancelled"], "cancel");
  const rows = await listAudit({ tenantId: "suba", action: "subscriptions.cancel" });
  ok(rows.some((a) => a.resource === `subscription:${target.id}`), "audited");
  eq((await subRow(target.id)).cancel_reason, "store: Customer asked by phone", "reason kept");
  eq((await adminCall("GET", { query: "?id=sub_0000000000000000" })).status, 404, "missing");
});

await t("privacy erase cancels and anonymizes the account's subscriptions; export lists both tables", async () => {
  const who = await shopper(inA, "erase.me@shopper.test");
  await placeCod(await freshCart([["2005", 1, 30]]), who, { drain: false });
  const order = await inA(() => db.selectFrom("orders").select(["id"]).where("customer_id", "=", who.id).executeTakeFirst());
  await inA(() => ST.createSubscriptionsFor(order.id));
  const id = (await subsOf(who))[0].id;
  const res = await inA(() => redactCustomer({ email: who.email }));
  ok(res.subscriptions === 1, `redact result ${JSON.stringify(res)}`);
  const s = await subRow(id);
  eq([s.status, s.customer_id, s.cancel_reason], ["cancelled", null, "privacy_erase"], "anonymized");
  const src = await readFile(join(ROOT, "lib/platform/export.js"), "utf8");
  ok(src.includes('"subscriptions"') && src.includes('"subscription_cycles"'), "export tables");
});

await t("migration 0044 is additive and the reads go through hasColumns", async () => {
  const sql = await readFile(join(ROOT, "migrations/tenant/0044_subscriptions.sql"), "utf8");
  ok(!/\b(DROP|DELETE|UPDATE)\b/i.test(sql.replace(/--.*$/gm, "")), "not additive");
  const cart = await readFile(join(ROOT, "lib/cart.js"), "utf8");
  ok(/hasColumns\("cart_items", SUB_LINE_COLUMNS\)/.test(cart) && /hasColumns\("carts", SUB_CART_COLUMNS\)/.test(cart), "cart reads");
});

// ---- 6. brute force ------------------------------------------------------------------------------
console.log("— brute force: PDP × qty = line = quote = minted = order = Shopify; reminder = account = checkout");

const SHIPPINGS = [
  BASE_SHIPPING,
  { ...BASE_SHIPPING, basis: "gross", freeThreshold: 1999, flatRate: 49 },
  { ...BASE_SHIPPING, freeThreshold: null, flatRate: 99, codFee: 0 },
  { ...BASE_SHIPPING, zones: [{ prefixes: ["41"], flatRate: 129, freeThreshold: 2499 }] },
];
const PAYMENTS = [null, { prepaid: { kind: "percent", value: 5, max: 150 } }, { prepaid: { kind: "fixed", value: 40 } }, { cod: { maxTotal: 6000 } }];

await t("1,000 random carts mixing subscribed and one-time lines × live offers × random percents × shipping and COD configs", async () => {
  const buyer = await shopper();
  let subscribedLines = 0;
  let viaRoute = 0;
  let cods = 0;
  let pushes = 0;
  for (let i = 0; i < 1000; i++) {
    if (i % 50 === 0) await setPlugin(inA, { ...SETTINGS, discount_percent: int(0, 30), eligible: i % 100 === 0 ? "tag" : "all", eligible_tag: "subscribe" });
    if (i % 25 === 0) {
      SHIPPING = pick(SHIPPINGS);
      PAYMENT = pick(PAYMENTS);
      await saveA();
    }
    const chosen = [...new Set(Array.from({ length: int(1, 4) }, () => pick(VARIANTS)[0]))];
    const lines = chosen.map((v) => [v, int(1, 4), rnd() < 0.5 ? pick([14, 30, 45, 60, 90]) : null]);
    const coupon = pick([null, null, null, "SAVE7", "FLAT300", "SOLO10"]);
    let cartId;
    if (i % 10 === 3) {
      // the product page's add-to-cart: through /api/cart, the interval the only subscription field sent
      const first = await cartPost(null, { action: "add", variantId: vid(lines[0][0]), quantity: lines[0][1], ...(lines[0][2] ? { subscriptionInterval: lines[0][2] } : {}) });
      cartId = first.body.id;
      for (const [v, q, interval] of lines.slice(1)) await cartPost(cartId, { action: "add", variantId: vid(v), quantity: q, ...(interval ? { subscriptionInterval: interval } : {}) });
      if (coupon) await cartPost(cartId, { action: "setCoupon", coupon });
      viaRoute++;
    } else cartId = await freshCart(lines, coupon);
    const where = `cart ${i} ${JSON.stringify(lines)} ${coupon || ""} ${settingsNow.discount_percent}%`;
    const drawer = await cartGet(cartId);
    for (const it of drawer.items) {
      const v = num(it.variantId);
      const wanted = lines.find((l) => l[0] === v)[2];
      const eligible = settingsNow.eligible === "all" || tagsOf[v].includes("subscribe");
      eq(Boolean(it.subscription?.active), Boolean(wanted && eligible), `${where}: ${v} subscribed`);
      eq(it.lineTotal, price[v] * it.quantity, `${where}: ${v} line`);
      if (it.subscription?.active) {
        subscribedLines++;
        const offer = (await cartGet(null, { query: `?subscribe=${encodeURIComponent(pid(v))}` })).offer;
        if (it.subscription.applied) eq(toMinor(it.lineTotal - it.discount, "INR"), toMinor(offer.prices[it.variantId], "INR") * it.quantity, `${where}: PDP price × qty vs cart line ${v}`);
        else eq(it.discount, 0, `${where}: exclusive code`);
      }
    }
    for (const n of drawer.progress?.nudges || []) if (n.kind === "tier") ok(!drawer.items.find((x) => x.variantId === n.variantId)?.subscription?.active, `${where}: a tier nudge on a subscribed line`);
    eq(toMinor(drawer.grandTotal, "INR"), toMinor(drawer.total, "INR") + toMinor(drawer.shipping.total, "INR"), `${where}: grand total`);
    const q = (await postCheckout(cartId, { action: "quote" }, { who: buyer })).body.quote;
    eq(toMinor(q.prepaid.total, "INR"), toMinor(drawer.grandTotal, "INR") - toMinor(q.prepaid.discount || 0, "INR") + toMinor(q.prepaid.shipping - drawer.shipping.total, "INR"), `${where}: quote vs drawer`);
    const tamper = { discount: 999, subscription_interval: 30, subscription_id: "sub_aaaaaaaaaaaaaaaa", subscriptionPercent: 90 };
    let order;
    if (i % 5 === 0 && q.cod.available) {
      const r = await postCheckout(cartId, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping, ...tamper }, { who: buyer });
      eq(r.status, 200, `${where}: cod ${JSON.stringify(r.body).slice(0, 160)}`);
      order = await orderRow(r.body.orderId);
      eq(toMinor(order.total, "INR"), toMinor(q.cod.total, "INR"), `${where}: COD order total`);
      cods++;
    } else {
      const before = razorpayCalls.length;
      const r = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping, ...tamper }, { who: buyer });
      eq(r.status, 200, `${where}: razorpay_create ${JSON.stringify(r.body).slice(0, 160)}`);
      eq(razorpayCalls.length, before + 1, `${where}: minted`);
      eq(razorpayCalls[before].amount, toMinor(q.prepaid.total, "INR"), `${where}: minted amount`);
      eq(r.body.amount, razorpayCalls[before].amount, `${where}: modal amount`);
      order = await orderRow(r.body.orderId);
      eq(toMinor(order.total, "INR"), razorpayCalls[before].amount, `${where}: order total`);
    }
    const snap = JSON.parse(order.snapshot);
    eq(toMinor(order.discount_total, "INR"), toMinor(drawer.discountTotal, "INR"), `${where}: discount_total`);
    eq(JSON.parse(order.applied_offers).map((a) => a.id), drawer.appliedOffers.map((a) => a.id), `${where}: applied_offers`);
    const input = P.buildDraftOrderInput({ ...order, snapshot: snap });
    eq(toMinor(shopifyTotal(input), "INR"), toMinor(order.total, "INR"), `${where}: Shopify draft total`);
    if (i % 100 === 0) pushes++;
  }
  ok(subscribedLines > 600, `only ${subscribedLines} subscribed lines`);
  ok(cods > 100, `only ${cods} COD orders`);
  ok(viaRoute >= 100, `only ${viaRoute} carts through /api/cart`);
  console.log(`    (${subscribedLines} subscribed lines, ${cods} COD orders)`);
});

await t("300 random renewal histories (skip, swap, pause/resume, change, price change): reminder = account figure = that day's checkout total = the order; a price change in between is the existing 409", async () => {
  await setPlugin(inA, { ...SETTINGS, discount_percent: 12 });
  SHIPPING = BASE_SHIPPING;
  PAYMENT = null;
  await saveA();
  let conflicts = 0;
  let renewed = 0;
  const eligible = VARIANTS.map(([v]) => v).concat(["2018"]);
  for (let h = 0; h < 300; h++) {
    NOW = START;
    if (h % 30 === 0) {
      SHIPPING = pick(SHIPPINGS);
      PAYMENT = pick(PAYMENTS);
      await saveA();
    }
    const who = await shopper();
    const v0 = pick(eligible);
    await placeAny(await freshCart([[v0, int(1, 3), pick([14, 30, 60])]]), who);
    let s = (await subsOf(who))[0];
    ok(s, `history ${h}: no subscription`);
    const where = `history ${h} ${v0}`;
    for (let k = int(0, 4); k > 0; k--) {
      const op = pick(["skip", "swap", "pause", "change", "price"]);
      if (op === "skip") await account("POST", { who, body: { action: "skip", id: s.id } });
      if (op === "swap") await account("POST", { who, body: { action: "swap", id: s.id, variantId: vid(pick(eligible)) } });
      if (op === "pause") {
        await account("POST", { who, body: { action: "pause", id: s.id } });
        await account("POST", { who, body: { action: "resume", id: s.id } });
      }
      if (op === "change") await account("POST", { who, body: { action: "change", id: s.id, quantity: int(1, 10) } });
      if (op === "price") {
        const v = num((await subRow(s.id)).variant_id);
        price[v] = pick([199, 349, 599.5, 1299, 2499]);
        await inA(() => db.updateTable("variants").set({ price: price[v] }).where("id", "=", vid(v)).execute());
      }
    }
    s = await subRow(s.id);
    eq(s.status, "active", `${where}: status`);
    NOW = Date.parse(s.next_due_at) - 3 * DAY + 60_000;
    await runSweep(NOW);
    const reminder = (await notes("subscription_reminder")).find((n) => n.recipient === who.email);
    ok(reminder, `${where}: no reminder`);
    const listed = (await account("GET", { who })).body.subscriptions[0];
    ok(reminder.body.includes(formatMoney(listed.next.amount, "INR")), `${where}: reminder ${reminder.body.slice(0, 120)} vs account ${listed.next.amount}`);
    const figure = await inA(() => renewalFigure(s));
    eq(figure.amount, listed.next.amount, `${where}: figure`);
    const pay = await account("POST", { who, body: { action: "pay", id: s.id } });
    eq(pay.status, 200, `${where}: pay ${JSON.stringify(pay.body)}`);
    const q = (await postCheckout(pay.cartId, { action: "quote" }, { who })).body.quote;
    const method = q.prepaid.available ? "prepaid" : "cod";
    eq(method, figure.method, `${where}: method`);
    eq(toMinor(q[method].total, "INR"), toMinor(listed.next.amount, "INR"), `${where}: checkout total vs account figure`);
    if (h % 7 === 0) {
      // the price moves between the reminder and placing: the existing 409
      const v = num(s.variant_id);
      price[v] = price[v] + 100;
      await inA(() => db.updateTable("variants").set({ price: price[v] }).where("id", "=", vid(v)).execute());
      const r = await postCheckout(pay.cartId, { action: method === "prepaid" ? "razorpay_create" : "cod", idempotencyKey: key(), expectedTotal: q[method].total, expectedShipping: q[method].shipping }, { who });
      eq([r.status, r.body.code], [409, "PRICE_CHANGED"], `${where}: price change`);
      conflicts++;
      // the shopper reads the new total and presses again: the figures follow
      const fresh = (await account("GET", { who })).body.subscriptions[0];
      const q2 = r.body.quote;
      eq(toMinor(q2[method].total, "INR"), toMinor(fresh.next.amount, "INR"), `${where}: the new total is the account's new figure`);
      const r2 = await postCheckout(pay.cartId, { action: method === "prepaid" ? "razorpay_create" : "cod", idempotencyKey: key(), expectedTotal: q2[method].total, expectedShipping: q2[method].shipping }, { who });
      eq(r2.status, 200, `${where}: retry after the 409 ${JSON.stringify(r2.body).slice(0, 160)}`);
      const o2 = await orderRow(r2.body.orderId);
      eq(toMinor(o2.total, "INR"), toMinor(fresh.next.amount, "INR"), `${where}: retried order total`);
      if (method === "prepaid") await inA(() => db.updateTable("orders").set({ status: "paid", payment_status: "paid", paid_at: new Date().toISOString() }).where("id", "=", o2.id).execute());
      await inA(() => ST.createSubscriptionsFor(o2.id));
      eq((await subRow(s.id)).cycle, s.cycle + 1, `${where}: cycle moved after the retry`);
      renewed++;
      continue;
    }
    const before = razorpayCalls.length;
    const r = await postCheckout(pay.cartId, { action: method === "prepaid" ? "razorpay_create" : "cod", idempotencyKey: key(), expectedTotal: q[method].total, expectedShipping: q[method].shipping }, { who });
    eq(r.status, 200, `${where}: place ${JSON.stringify(r.body).slice(0, 160)}`);
    const order = await orderRow(r.body.orderId);
    eq(toMinor(order.total, "INR"), toMinor(listed.next.amount, "INR"), `${where}: order total vs reminder`);
    if (method === "prepaid") {
      eq(razorpayCalls[before].amount, toMinor(listed.next.amount, "INR"), `${where}: minted`);
      await inA(() => db.updateTable("orders").set({ status: "paid", payment_status: "paid", paid_at: new Date().toISOString() }).where("id", "=", order.id).execute());
    }
    eq(toMinor(shopifyTotal(P.buildDraftOrderInput({ ...order, snapshot: JSON.parse(order.snapshot) })), "INR"), toMinor(order.total, "INR"), `${where}: Shopify`);
    await inA(() => ST.createSubscriptionsFor(order.id));
    const after = await subRow(s.id);
    eq(after.cycle, s.cycle + 1, `${where}: cycle moved`);
    renewed++;
  }
  ok(renewed > 200 && conflicts > 30, `renewed ${renewed}, conflicts ${conflicts}`);
  console.log(`    (${renewed} renewals placed, ${conflicts} price-change refusals)`);
  NOW = START;
});

for (const f of dbs) await rm(join(ROOT, f), { force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
