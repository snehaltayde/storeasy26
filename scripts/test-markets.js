// Phase 8 line 4 suite: a founder sells in more than one currency and country.
//
// Everything runs through the real routes (/api/cart, /api/checkout, /api/market,
// the Razorpay webhook) against a real control plane and tenant databases (no
// browser, no network, no payment: Razorpay is a local stub that records what it
// was asked to mint, Shopify a fake GraphQL transport).
//   1. Brute force (PLAYBOOK money lesson): 1,000 random carts of real seeded
//      variants, with live offers, × USD (2 decimals), JPY (0) and AED × every
//      rounding rule. For each: the PDP unit price × quantity equals the cart
//      line; the drawer total equals the route's charged total equals the
//      stubbed Razorpay `amount` in that currency's minor units; every nudge,
//      completed in whole units with real products, makes the presentment engine
//      apply it; the base run equals the stubbed Shopify draft total. All money
//      compares are toMinor integers.
//   2. The rules: a cookie market that differs from the address country is a
//      409 in the new currency; COD outside the base market is refused; a
//      non-allowlisted currency or a missing Razorpay tick is refused at save; a
//      disabled market is never served; store B's markets never apply on A;
//      reports sum base amounts; PRICE_CHANGED_MESSAGE matches every allowlisted
//      format; INR formatMoney and HTML are byte-identical; the webhook compares
//      in the order's currency.
//   pnpm test:markets
import { readFile, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-mk-default.db";
process.env.PLATFORM_DB_URL = "file:.test-mk-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
delete process.env.SMS_PROVIDER;
delete process.env.CHECKOUT_MODE;
process.env.NODE_ENV = "test";

const dbs = [".test-mk-default.db", ".test-mk-platform.db", ".test-mk-a.db", ".test-mk-b.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

globalThis.__mkAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__mkAfter.push(fn); };`);
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
const { createCart, addItem, CART_COOKIE } = await import("../lib/cart.js");
const { upsertOffer } = await import("../lib/offers/store.js");
const { toMinor, RAZORPAY_CURRENCIES, currencyExponent } = await import("../lib/money.js");
const { formatMoney } = await import("../lib/format.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const M = await import("../lib/markets.js");
const SET = await import("../lib/admin/settings.js");
const P = await import("../lib/shopify-push.js");
const Rep = await import("../lib/reporting.js");
const { PRICE_CHANGED_MESSAGE, priceMismatch } = await import("../lib/checkout-price.js");
const { isCodSentence, COD_OUTSIDE_BASE } = await import("../lib/checkout/payment-terms.js");
const { roleAllows } = await import("../lib/platform/authz.js");
const { SETTINGS_SECTIONS } = await import("../lib/admin/settings-sections.js");
const { NextRequest } = require("next/server.js");
const checkout = await import("../app/api/checkout/route.js");
const cartRoute = await import("../app/api/cart/route.js");
const marketRoute = await import("../app/api/market/route.js");
const webhook = await import("../app/api/razorpay/webhook/route.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.stack?.split("\n").slice(0, 4).join("\n    ") || e.message}`);
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

// ---- fixtures ------------------------------------------------------------------------
const HOST_A = "mk-a.test";
const HOST_B = "mk-b.test";
const WEBHOOK_SECRET = "mk-webhook-secret";
const BASE_SHIPPING = { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null, zones: [] };
const RATES = { USD: 84.2, JPY: 0.56, AED: 22.93 };
const FLAT = { USD: 9.5, JPY: 1500, AED: 35 };
const FREE = { USD: 60, JPY: 9000, AED: 220 };
const market = (currency, rounding, extra = {}) => ({
  id: { USD: "US", JPY: "JP", AED: "AE" }[currency],
  countries: [{ USD: "US", JPY: "JP", AED: "AE" }[currency]],
  currency,
  rate: RATES[currency],
  rateSetAt: new Date().toISOString(),
  rounding,
  flatRate: FLAT[currency],
  freeThreshold: FREE[currency],
  enabled: true,
  international: true,
  ...extra,
});
const tenantA = (markets) => ({
  id: "mka",
  name: "Markets A",
  domains: [HOST_A],
  dbUrl: "file:.test-mk-a.db",
  secrets: { order_link_secret: "mk-link-secret", razorpay_key_secret: "mk-key-secret", razorpay_webhook_secret: WEBHOOK_SECRET },
  config: { country: "IN", currency: "INR", shipping_config: BASE_SHIPPING, payment_config: null, razorpay_key_id: "rzp_test_mk", markets },
});
const saveA = (markets) => C.upsertTenant(tenantA(markets));
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await saveA([]);
// store B sells in the US; store A (in some tests) sells nowhere else
await C.upsertTenant({ id: "mkb", name: "Markets B", domains: [HOST_B], dbUrl: "file:.test-mk-b.db", secrets: { order_link_secret: "b" }, config: { country: "IN", currency: "INR", shipping_config: BASE_SHIPPING, markets: [market("USD", "x.99")] } });
const inA = async (fn) => withTenant(await C.getTenant("mka"), fn);
const inB = async (fn) => withTenant(await C.getTenant("mkb"), fn);

const VARIANTS = [
  ["1001", 349],
  ["1002", 1299],
  ["1003", 89.5],
  ["1004", 2499],
  ["1005", 4999],
  ["1006", 15],
  ["1007", 777.77],
];
const price = Object.fromEntries(VARIANTS);
async function seedStore(inT) {
  await inT(async () => {
    await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
    await runMigrations(libsql, await loadMigrations("tenant"));
    for (const [v, p] of VARIANTS) {
      await db.insertInto("products").values({ id: `gid://shopify/Product/${v}`, handle: `p-${v}`, title: `Product ${v}`, price_min: p, price_max: p, currency: "INR", available: 1, tags: "[]" }).execute();
      await db.insertInto("variants").values({ id: `gid://shopify/ProductVariant/${v}`, product_id: `gid://shopify/Product/${v}`, title: "One", price: p, currency: "INR", available: 1 }).execute();
    }
    const now = new Date().toISOString();
    const { emptyList } = await import("../lib/content/documents-reader.js");
    await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), now, now] });
    await libsql.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [now] });
  });
}
await seedStore(inA);
await seedStore(inB);
// live offers with every money field convertOffer converts: a line percent, a
// BXGY, a bundle set price, a gift threshold, a percent and a fixed coupon with a minimum
await inA(async () => {
  await upsertOffer({ offer: { id: "tier-v2", type: "TIERED_QTY", scope: "line", priority: 10, title: "Two serums", target: { kind: "variantId", value: "gid://shopify/ProductVariant/1002" }, tiers: [{ minQty: 2, percent: 13 }] }, enabled: true });
  await upsertOffer({ offer: { id: "bxgy-v3", type: "BXGY", scope: "line", priority: 20, title: "Buy 2 get 1", target: { kind: "variantId", value: "gid://shopify/ProductVariant/1003" }, buy: 2, free: 1 }, enabled: true });
  await upsertOffer({ offer: { id: "bundle-17", type: "BUNDLE", scope: "line", priority: 5, title: "Duo", items: [{ variantId: "gid://shopify/ProductVariant/1001", quantity: 1 }, { variantId: "gid://shopify/ProductVariant/1007", quantity: 1 }], price: 999 }, enabled: true });
  await upsertOffer({ offer: { id: "gift-shaker", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Free shaker", threshold: 2999, gift: { variantId: "gid://shopify/ProductVariant/1006", productId: "gid://shopify/Product/1006", handle: "p-1006", title: "Shaker", value: 15 } }, enabled: true });
  await upsertOffer({ offer: { id: "save-seven", type: "COUPON", scope: "order", priority: 50, title: "SAVE7", code: "SAVE7", discount: { kind: "percent", value: 7 }, combinable: true }, enabled: true });
  await upsertOffer({ offer: { id: "flat-300", type: "COUPON", scope: "order", priority: 50, title: "FLAT300", code: "FLAT300", discount: { kind: "fixed", value: 300 }, minSubtotal: 2000, combinable: true }, enabled: true });
});

let carts = 0;
async function freshCart(inT, lines, coupon = null) {
  const id = `mk-cart-${++carts}`;
  await inT(async () => {
    await createCart(id);
    for (const [v, q] of lines) await addItem(id, `gid://shopify/ProductVariant/${v}`, q);
    if (coupon) await db.updateTable("carts").set({ coupon_code: coupon }).where("id", "=", id).execute();
  });
  return id;
}
const addTo = (inT, cartId, v, q) => inT(() => addItem(cartId, `gid://shopify/ProductVariant/${v}`, q));

const CONTACT = { email: "snehal@mediastic.in", phone: "9876543210", name: "Markets Test" };
const ADDR = {
  IN: { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", country_code: "IN" },
  US: { line1: "1 Main St", line2: "", city: "Austin", state: "TX", pincode: "78701", country: "United States", country_code: "US" },
  JP: { line1: "1-1 Chiyoda", line2: "", city: "Tokyo", state: "Tokyo", pincode: "100-0001", country: "Japan", country_code: "JP" },
  AE: { line1: "1 Sheikh Zayed Rd", line2: "", city: "Dubai", state: "Dubai", pincode: "00000", country: "United Arab Emirates", country_code: "AE" },
};
let keys = 0;
const key = () => `mk-key-${++keys}`;
const cookieHeader = (cartId, country) => [cartId ? `${CART_COOKIE}=${cartId}` : null, country ? `${M.MARKET_COOKIE}=${country}` : null].filter(Boolean).join("; ");

async function postCheckout(cartId, body, { country = null, address = ADDR.IN, host = HOST_A } = {}) {
  const headers = { host, "content-type": "application/json", "x-forwarded-for": "10.0.0.9" };
  const cookie = cookieHeader(cartId, country);
  if (cookie) headers.cookie = cookie;
  const req = new NextRequest(`https://${host}/api/checkout`, { method: "POST", headers, body: JSON.stringify({ contact: CONTACT, address, ...body }) });
  const res = await checkout.POST(req);
  globalThis.__mkAfter = [];
  return { status: res.status, body: await res.json(), setCookie: res.headers.get("set-cookie") || "" };
}
async function getCartRoute(cartId, { country = null, host = HOST_A } = {}) {
  const headers = { host };
  const cookie = cookieHeader(cartId, country);
  if (cookie) headers.cookie = cookie;
  const res = await cartRoute.GET(new NextRequest(`https://${host}/api/cart`, { method: "GET", headers }));
  return res.json();
}

const razorpayCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.razorpay.com/")) {
    const sent = JSON.parse(init.body);
    razorpayCalls.push(sent);
    return new Response(JSON.stringify({ id: `order_mk${razorpayCalls.length}`, amount: sent.amount, currency: sent.currency }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// A fake Shopify: lines at its catalog price (the base price), the draft's
// discounts and shipping; its total is what reconciliation compares.
function fakeShopify() {
  const drafts = [];
  const gql = async (query, vars) => {
    if (query.includes("draftOrderCreate")) {
      drafts.push(vars.input);
      return { draftOrderCreate: { draftOrder: { id: `gid://shopify/DraftOrder/${drafts.length}`, name: `#D${drafts.length}` }, userErrors: [] } };
    }
    if (query.includes("draftOrderComplete")) {
      const input = drafts[drafts.length - 1];
      return { draftOrderComplete: { draftOrder: { id: "d", status: "COMPLETED", order: { id: `gid://shopify/Order/${drafts.length}`, name: `#${drafts.length}`, displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: String(shopifyTotal(input)) } }, lineItems: { nodes: [] } } }, userErrors: [] } };
    }
    return { orders: { nodes: [] }, draftOrders: { nodes: [] } };
  };
  return { gql, drafts };
}
function shopifyTotal(input) {
  let minor = 0;
  for (const li of input.lineItems) {
    const unit = toMinor(price[li.variantId.split("/").pop()], "INR");
    const pct = li.appliedDiscount?.valueType === "PERCENTAGE" ? li.appliedDiscount.value : 0;
    minor += Math.round(unit * li.quantity * (1 - pct / 100));
  }
  minor -= toMinor(input.appliedDiscount?.value || 0, "INR");
  minor += toMinor(Number(input.shippingLine?.price || 0), "INR");
  return minor / 100;
}

// a seeded, reproducible random
let seed = 20261126;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// Completes a spend nudge the way a shopper would: whole units of real
// products until the added value (in the market's prices) covers it.
function unitsToCover(remaining, m) {
  const options = VARIANTS.filter(([v]) => v !== "1003" && v !== "1002" && v !== "1001" && v !== "1007"); // products no line offer touches
  const [v] = pick(options);
  const unit = M.convertPrice(price[v], m);
  return [v, Math.max(1, Math.ceil(toMinor(remaining, m.currency) / toMinor(unit, m.currency)))];
}

// ---- 1. brute force ---------------------------------------------------------------
console.log("— brute force: card = cart line, drawer = charged = minted, nudges hold, base = Shopify");

await t("1,000 random carts × USD, JPY, AED × exact, whole, x.99", async () => {
  const COMBOS = ["USD", "JPY", "AED"].flatMap((c) => M.ROUNDING_RULES.map((r) => [c, r]));
  let nudgesChecked = 0;
  let pushed = 0;
  const shop = fakeShopify();
  for (let i = 0; i < 1000; i++) {
    const [currency, rounding] = COMBOS[i % COMBOS.length];
    if (i < COMBOS.length || i % 50 === 0) await saveA([market("USD", currency === "USD" ? rounding : "x.99"), market("JPY", currency === "JPY" ? rounding : "whole"), market("AED", currency === "AED" ? rounding : "exact")]);
    const m = (await C.getTenant("mka")).config.markets.find((x) => x.currency === currency);
    const country = m.countries[0];
    const lines = Array.from({ length: int(1, 4) }, () => [pick(VARIANTS)[0], int(1, 4)]);
    const coupon = pick([null, null, "SAVE7", "FLAT300"]);
    const cartId = await freshCart(inA, lines, coupon);
    const where = `cart ${i} ${currency}/${rounding} ${JSON.stringify(lines)} ${coupon || ""}`;
    const drawer = await getCartRoute(cartId, { country });
    ok(drawer.currency === currency && drawer.market === m.id, `${where}: drawer currency ${drawer.currency}`);
    ok(!("base" in drawer), `${where}: the base run reached the browser`);
    // PDP unit price × quantity = cart line (integer minor units)
    for (const it of drawer.items) {
      const pdp = M.convertPrice(price[it.variantId.split("/").pop()], m);
      eq(toMinor(it.price, currency), toMinor(pdp, currency), `${where}: unit price`);
      eq(toMinor(it.lineTotal, currency), toMinor(pdp, currency) * it.quantity, `${where}: line`);
      ok(Number.isInteger(toMinor(it.lineTotal, currency)) && Math.abs(it.lineTotal * 10 ** currencyExponent(currency) - toMinor(it.lineTotal, currency)) < 1e-6, `${where}: float drift in a line`);
    }
    const linesMinor = drawer.items.reduce((s, it) => s + toMinor(it.lineTotal, currency), 0);
    eq(toMinor(drawer.subtotal, currency), linesMinor, `${where}: subtotal = Σ lines`);
    eq(toMinor(drawer.grandTotal, currency), toMinor(drawer.total, currency) + toMinor(drawer.shipping.total, currency), `${where}: grand total`);

    // the route's charged total = the drawer total = the stubbed Razorpay amount
    const q = (await postCheckout(cartId, { action: "quote" }, { country, address: ADDR[country] })).body.quote;
    ok(q && !q.cod.available && q.cod.reason === COD_OUTSIDE_BASE, `${where}: COD offered outside the base market`);
    eq(toMinor(q.prepaid.total, currency), toMinor(drawer.grandTotal, currency), `${where}: quote vs drawer`);
    const before = razorpayCalls.length;
    const placed = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { country, address: ADDR[country] });
    ok(placed.status === 200 && placed.body.ok, `${where}: razorpay_create ${placed.status} ${JSON.stringify(placed.body).slice(0, 200)}`);
    const minted = razorpayCalls[before];
    ok(minted && razorpayCalls.length === before + 1, `${where}: no Razorpay order minted`);
    eq(minted.currency, currency, `${where}: minted currency`);
    eq(minted.amount, toMinor(drawer.grandTotal, currency), `${where}: minted amount`);
    eq(placed.body.amount, minted.amount, `${where}: modal amount`);
    eq(placed.body.currency, currency, `${where}: modal currency`);

    // the order: presentment money + base run; base = the Shopify draft total
    const order = await inA(() => db.selectFrom("orders").selectAll().where("id", "=", placed.body.orderId).executeTakeFirst());
    eq(order.currency, currency, `${where}: order currency`);
    eq(toMinor(order.total, currency), minted.amount, `${where}: order total`);
    eq(order.market, m.id, `${where}: order market`);
    eq(order.base_currency, "INR", `${where}: base currency`);
    eq(order.fx_rate, m.rate, `${where}: rate`);
    const snap = JSON.parse(order.snapshot);
    eq(toMinor(order.base_total, "INR"), toMinor(snap.base.total, "INR"), `${where}: base_total column vs snapshot`);
    eq(toMinor(order.base_shipping_total, "INR"), toMinor(order.shipping_total * m.rate, "INR"), `${where}: base shipping`);
    const input = P.buildDraftOrderInput({ ...order, snapshot: snap });
    eq(toMinor(shopifyTotal(input), "INR"), toMinor(order.base_total, "INR"), `${where}: Shopify draft total vs base run`);
    const attrs = Object.fromEntries(input.customAttributes.map((a) => [a.key, a.value]));
    eq(attrs.charged_currency, currency, `${where}: charged_currency`);
    eq(attrs.charged_total, String(order.total), `${where}: charged_total`);
    // the gifts the shopper got are the gifts Shopify gets
    eq(snap.gifts.map((g) => g.variantId), drawer.gifts.map((g) => g.variantId), `${where}: gifts`);
    if (i % 40 === 0) {
      // a full push with the fake Shopify reconciles on the base total
      await inA(() => db.updateTable("orders").set({ status: "paid", payment_status: "paid", paid_at: new Date().toISOString() }).where("id", "=", order.id).execute());
      const r = await inA(() => P.pushOrderToShopify(order.id, { gql: shop.gql }));
      ok(r.ok && !r.mismatch, `${where}: push ${JSON.stringify(r)}`);
      pushed++;
    }

    // every nudge, completed in whole units with real products, is applied
    for (const n of drawer.progress?.nudges || []) {
      const cart2 = await freshCart(inA, lines, coupon);
      if (n.kind === "tier") await addTo(inA, cart2, n.variantId.split("/").pop(), n.add);
      else {
        const [v, qty] = unitsToCover(n.remaining, m);
        await addTo(inA, cart2, v, qty);
      }
      const after = await getCartRoute(cart2, { country });
      const nw = `${where}: nudge ${n.kind}/${n.id} "${n.text}"`;
      if (n.kind === "tier") ok(after.appliedOffers.some((a) => a.id === n.id && after.items.find((x) => x.variantId === n.variantId)?.discount > 0), `${nw} not applied`);
      else if (n.kind === "coupon") ok(after.couponStatus?.valid && after.couponStatus.applied > 0, `${nw} not applied`);
      else if (n.id === "shipping") ok(after.shipping.free, `${nw}: shipping not free`);
      else ok(after.gifts.some((g) => g.offerId === n.id), `${nw}: gift not given`);
      ok(!/₹/.test(n.text), `${nw}: rupee sign in a ${currency} nudge`);
      nudgesChecked++;
    }
  }
  ok(nudgesChecked > 50, `only ${nudgesChecked} nudges were checked`);
  ok(pushed >= 20, `only ${pushed} pushes`);
  console.log(`    (${nudgesChecked} nudges completed, ${pushed} Shopify pushes reconciled)`);
});

// ---- 2. the rules -----------------------------------------------------------------
console.log("— the rules");
await saveA([market("USD", "x.99"), market("JPY", "whole"), market("AED", "exact", { enabled: false })]);

await t("a cookie market that differs from the address country → 409 in the new currency, cookie moved", async () => {
  const cartId = await freshCart(inA, [["1002", 1]]);
  // cookie US, address India → INR
  const r = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: 18.99, expectedShipping: 9.5 }, { country: "US", address: ADDR.IN });
  eq(r.status, 409, "status:");
  eq([r.body.code, r.body.marketChanged, r.body.currency, r.body.cart.currency], ["PRICE_CHANGED", true, "INR", "INR"], "body:");
  ok(PRICE_CHANGED_MESSAGE.test(r.body.error) && r.body.error.includes("₹"), `message: ${r.body.error}`);
  ok(/_market=IN/.test(r.setCookie), `cookie: ${r.setCookie}`);
  // no cookie (India), address US → USD; nothing minted, no order
  const before = razorpayCalls.length;
  const u = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: 1378, expectedShipping: 79 }, { address: ADDR.US });
  eq([u.status, u.body.currency, u.body.cart.currency], [409, "USD", "USD"], "to USD:");
  ok(u.body.error.includes("$"), u.body.error);
  eq(razorpayCalls.length, before, "minted on a mismatch:");
  eq((await inA(() => db.selectFrom("orders").select("id").where("cart_id", "=", cartId).execute())).length, 0, "orders on a mismatch:");
  // the quote moves the market (200) and the cookie
  const qq = await postCheckout(cartId, { action: "quote" }, { address: ADDR.JP });
  eq([qq.status, qq.body.marketChanged, qq.body.currency], [200, true, "JPY"], "quote:");
  ok(/_market=JP/.test(qq.setCookie), "quote cookie");
});

await t("cash on delivery outside the base market is refused; in the base market it works", async () => {
  const cartId = await freshCart(inA, [["1002", 1]]);
  const q = (await postCheckout(cartId, { action: "quote" }, { country: "US", address: ADDR.US })).body.quote;
  ok(!q.cod.available && isCodSentence(q.cod.reason), `quote: ${JSON.stringify(q.cod)}`);
  const r = await postCheckout(cartId, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, { country: "US", address: ADDR.US });
  eq([r.status, r.body.code], [409, "COD_UNAVAILABLE"], "cod:");
  const inr = (await postCheckout(cartId, { action: "quote" }, { address: ADDR.IN })).body.quote;
  ok(inr.cod.available && inr.currency === "INR", "base COD");
  const placed = await postCheckout(cartId, { action: "cod", idempotencyKey: key(), expectedTotal: inr.cod.total, expectedShipping: inr.cod.shipping }, { address: ADDR.IN });
  ok(placed.status === 200 && placed.body.ok, JSON.stringify(placed.body));
  const o = await inA(() => db.selectFrom("orders").selectAll().where("id", "=", placed.body.orderId).executeTakeFirst());
  eq([o.currency, o.market, o.base_total, o.country], ["INR", null, null, "India"], "a base order:");
});

await t("postal codes: 6 digits for India, 3–10 alphanumerics elsewhere", async () => {
  ok(M.postalCodeValid("411001", "IN") && !M.postalCodeValid("41100", "IN") && !M.postalCodeValid("SW1A1AA", "IN"), "IN");
  ok(M.postalCodeValid("78701", "US") && M.postalCodeValid("SW1A 1AA", "GB") && M.postalCodeValid("100-0001", "JP") && !M.postalCodeValid("12", "US") && !M.postalCodeValid("12345678901", "US") && !M.postalCodeValid("94<1>", "US"), "elsewhere");
  const cartId = await freshCart(inA, [["1002", 1]]);
  const r = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: 1, expectedShipping: 0 }, { country: "US", address: { ...ADDR.US, pincode: "1" } });
  eq([r.status, r.body.code], [400, "POSTAL_INVALID"], "route:");
});

await t("a non-allowlisted currency, a missing Razorpay tick, the store's own country, a bad rate are refused at save", async () => {
  const cfg = tenantA([]).config;
  const good = market("USD", "x.99");
  ok(SET.buildSettingsPatch({ markets: [good] }, cfg).ok, "a good market");
  const bad = (m, re) => {
    const r = SET.buildSettingsPatch({ markets: [m] }, cfg);
    ok(!r.ok && r.errors.some((e) => re.test(e)), `${JSON.stringify(m)} → ${r.errors}`);
  };
  bad({ ...good, currency: "CHF" }, /Razorpay can charge/);
  bad({ ...good, currency: "INR" }, /Razorpay can charge/);
  bad({ ...good, international: false }, /International payments/);
  bad({ ...good, countries: ["IN"] }, /own country/);
  bad({ ...good, countries: ["ZZ"] }, /isn't a country/);
  bad({ ...good, rate: 0 }, /rate/);
  bad({ ...good, rounding: "up" }, /round/);
  const two = SET.buildSettingsPatch({ markets: [good, { ...good, id: "x" }] }, cfg);
  ok(!two.ok && two.errors.some((e) => /two markets/.test(e)), "a country in two markets");
  // a rate keeps its date unless it changed
  const old = { ...good, rateSetAt: "2026-01-01T00:00:00.000Z" };
  eq(M.validateMarkets([good], { previous: [old] }).value[0].rateSetAt, old.rateSetAt, "unchanged rate:");
  ok(M.validateMarkets([{ ...good, rate: 85 }], { previous: [old] }).value[0].rateSetAt !== old.rateSetAt, "changed rate gets a new date");
  ok(M.rateIsStale(old) && !M.rateIsStale({ rateSetAt: new Date().toISOString() }), "the 30-day warning");
  eq(M.rateChanges([old], [{ ...good, rate: 85 }]), ["US: 84.2 → 85"], "audit rate changes:");
  ok(RAZORPAY_CURRENCIES.every((c) => c === "INR" || SET.buildSettingsPatch({ markets: [{ ...good, currency: c }] }, cfg).ok), "every allowlisted currency saves");
});

await t("Markets settings: admin and owner only (support and staff get no access)", async () => {
  const s = SETTINGS_SECTIONS.find((x) => x.id === "markets");
  eq(s?.action, "settings.write", "section action:");
  eq(["owner", "admin", "staff", "support"].map((r) => roleAllows(r, "settings.write")), [true, true, false, false], "roles:");
  const page = await readFile(join(ROOT, "app/(console)/admin/(authed)/settings/markets/page.js"), "utf8");
  ok(/roleAllows\(actor\.role, "settings\.write"\)\) return <NoAccess/.test(page), "the page gates on settings.write before reading markets");
  const view = SET.settingsView({ id: "mka", config: tenantA([market("USD", "x.99")]).config });
  ok(!("markets" in view), "settings.read's view carries no markets");
});

await t("a disabled market is never served (cart, checkout, the picker, the market route)", async () => {
  const cartId = await freshCart(inA, [["1002", 1]]);
  const c = await getCartRoute(cartId, { country: "AE" });
  eq([c.currency, c.market], ["INR", undefined], "cart with a disabled market's cookie:");
  const r = await postCheckout(cartId, { action: "quote" }, { country: "AE", address: ADDR.AE });
  eq([r.status, r.body.code], [400, "COUNTRY_UNAVAILABLE"], "checkout:");
  const cfg = (await C.getTenant("mka")).config;
  ok(!M.countryOptions(cfg).some((o) => o.country === "AE"), "picker lists it");
  eq(M.resolveMarket({ ipCountry: "AE", config: cfg }).market, null, "ip suggestion:");
  const res = await marketRoute.GET(new NextRequest(`https://${HOST_A}/api/market?country=AE&return=/products/p-1002`, { headers: { host: HOST_A } }));
  ok(/_market=IN/.test(res.headers.get("set-cookie") || ""), `market route stored ${res.headers.get("set-cookie")}`);
  eq(res.headers.get("location"), "/products/p-1002", "return:");
  const evil = await marketRoute.GET(new NextRequest(`https://${HOST_A}/api/market?country=US&return=//evil.example/x`, { headers: { host: HOST_A } }));
  eq(evil.headers.get("location"), "/", "an off-site return:");
  ok(/_market=US/.test(evil.headers.get("set-cookie") || ""), "an enabled market is stored");
});

await t("the hosting's country suggestion applies only on a first visit, and only for an enabled market", async () => {
  const cfg = (await C.getTenant("mka")).config;
  eq(M.resolveMarket({ ipCountry: "US", config: cfg }).market?.id, "US", "first visit:");
  eq(M.resolveMarket({ cookie: "IN", ipCountry: "US", config: cfg }).market, null, "a cookie wins:");
  eq(M.resolveMarket({ ipCountry: "FR", config: cfg }).market, null, "not a market:");
});

await t("store B's markets never apply on store A", async () => {
  await saveA([]);
  const cartA = await freshCart(inA, [["1002", 1]]);
  const a = await getCartRoute(cartA, { country: "US" });
  eq(a.currency, "INR", "A with a US cookie:");
  const r = await postCheckout(cartA, { action: "quote" }, { country: "US", address: ADDR.US });
  eq([r.status, r.body.code], [400, "COUNTRY_UNAVAILABLE"], "A's checkout:");
  const cartB = await freshCart(inB, [["1002", 1]]);
  const b = await getCartRoute(cartB, { country: "US", host: HOST_B });
  eq(b.currency, "USD", "B with a US cookie:");
  await saveA([market("USD", "x.99"), market("JPY", "whole")]);
});

await t("the webhook compares in the order's own currency and minor units", async () => {
  const cartId = await freshCart(inA, [["1005", 1]]);
  const q = (await postCheckout(cartId, { action: "quote" }, { country: "JP", address: ADDR.JP })).body.quote;
  const placed = await postCheckout(cartId, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping }, { country: "JP", address: ADDR.JP });
  ok(placed.body.ok && placed.body.currency === "JPY" && Number.isInteger(placed.body.amount), JSON.stringify(placed.body));
  eq(placed.body.amount, toMinor(q.prepaid.total, "JPY"), "JPY minor units are whole yen:");
  const send = async (amount, currency, n) => {
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_mk${n}`, order_id: placed.body.razorpayOrderId, amount, currency } } } });
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const res = await webhook.POST(new NextRequest(`https://${HOST_A}/api/razorpay/webhook`, { method: "POST", headers: { host: HOST_A, "x-razorpay-signature": sig, "content-type": "application/json" }, body: raw }));
    globalThis.__mkAfter = [];
    return res.json();
  };
  eq((await send(placed.body.amount * 100, "JPY", 1)).flagged, "amount_mismatch", "paise-style JPY amount:");
  eq((await send(placed.body.amount, "INR", 2)).flagged, "amount_mismatch", "right amount, wrong currency:");
  const good = await send(placed.body.amount, "JPY", 3);
  ok(!good.flagged && good.ok, JSON.stringify(good));
  const o = await inA(() => db.selectFrom("orders").select(["status"]).where("id", "=", placed.body.orderId).executeTakeFirst());
  eq(o.status, "paid", "order:");
});

await t("reports sum COALESCE(base_total, total)", async () => {
  const now = new Date().toISOString();
  await inA(async () => {
    await db.deleteFrom("orders").execute();
    await db.insertInto("orders").values({ id: "R-1", idempotency_key: "r1", total: 1000, currency: "INR", status: "paid", payment_method: "razorpay", payment_status: "paid", sync_attempts: 0, created_at: now, updated_at: now, snapshot: "{}", applied_offers: "[]", subtotal: 1000, discount_total: 0, shipping_total: 0 }).execute();
    await db.insertInto("orders").values({ id: "R-2", idempotency_key: "r2", total: 20, currency: "USD", market: "US", base_currency: "INR", fx_rate: 84.2, base_total: 1684, status: "paid", payment_method: "razorpay", payment_status: "paid", sync_attempts: 0, created_at: now, updated_at: now, snapshot: "{}", applied_offers: "[]", subtotal: 20, discount_total: 0, shipping_total: 0 }).execute();
  });
  const r = await inA(() => Rep.salesRollup({ days: 30 }));
  eq(r.totals?.gross ?? r.gross, 2684, "gross in base money:");
  const src = await readFile(join(ROOT, "lib/reporting.js"), "utf8");
  ok(/hasColumns\("orders", \["base_total"\]\)/.test(src), "the base column is read through hasColumns");
});

await t("PRICE_CHANGED_MESSAGE and the COD sentences match every allowlisted currency's format", async () => {
  for (const c of RAZORPAY_CURRENCIES)
    for (const amount of [0, 1, 17.99, 999, 1234.5, 98765.43, 1500000]) {
      const m = priceMismatch({ expectedTotal: -1, goodsTotal: amount, currency: c });
      ok(PRICE_CHANGED_MESSAGE.test(m.message), `${c} ${amount}: ${m.message}`);
      ok(PRICE_CHANGED_MESSAGE.test(`Your country changed — your new total is ${formatMoney(amount, c)}. Review and place order.`), `${c} country`);
      ok(isCodSentence(`Cash on delivery isn't available for orders over ${formatMoney(amount, c)}`), `${c} cod`);
    }
  ok(!PRICE_CHANGED_MESSAGE.test("Your total changed — your new total is call us. Review and place order."), "free text");
});

await t("INR: formatMoney and the price HTML are byte-identical to before", async () => {
  // the formatMoney of Phase 8 line 3, verbatim
  const before = (amount, currency = "INR") => {
    if (amount == null || amount === "" || Number.isNaN(Number(amount))) return "";
    const n = Number(amount);
    try {
      return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
    } catch {
      return `${currency} ${n.toFixed(2)}`;
    }
  };
  for (let i = 0; i < 2000; i++) {
    const a = pick([Math.round(rnd() * 1e6) / 100, int(0, 200000), -int(1, 999), "", null, "12.5", 0.005, 1e9]);
    eq(formatMoney(a, "INR"), before(a, "INR"), `formatMoney(${a}):`);
    eq(formatMoney(a), before(a), `formatMoney(${a}) default:`);
  }
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MarketProvider } = await import("../components/MarketContext.js");
  const Price = (await import("../components/Price.js")).default;
  const { BundleFigure } = await import("../components/Price.js");
  const h = React.createElement;
  for (const a of [1499, 89.5, 15, 0, 777.77]) {
    eq(renderToStaticMarkup(h(MarketProvider, { market: null }, h("span", null, h(Price, { amount: a, currency: "INR" })))), renderToStaticMarkup(h("span", null, before(a, "INR"))), `Price ${a}:`);
    eq(renderToStaticMarkup(h(MarketProvider, { market: null }, h("span", null, h(Price, { amount: a, quantity: 3, currency: "INR" })))), renderToStaticMarkup(h("span", null, before(a * 3, "INR"))), `Price ×3 ${a}:`);
  }
  const b = { bundle_price: 999, componentsSum: 1126.77, saving: 127.77, currency: undefined, components: [{ price: 349, quantity: 1 }, { price: 777.77, quantity: 1 }] };
  eq(renderToStaticMarkup(h("p", null, h(BundleFigure, { bundle: b, kind: "saving", prefix: "You save " }))), renderToStaticMarkup(h("p", null, `You save ${before(127.77)}`)), "bundle saving:");
  eq(renderToStaticMarkup(h("p", null, "Save ", h(BundleFigure, { bundle: b, kind: "saving" }))), renderToStaticMarkup(h("p", null, "Save ", before(127.77))), "bundle page saving:");
  // the same cart, no market: no market key, no base, the same figures
  await saveA([]);
  const cartId = await freshCart(inA, [["1002", 2], ["1003", 3]], "SAVE7");
  const c = await getCartRoute(cartId);
  ok(!("market" in c) && !("base" in c) && c.currency === "INR", "a base cart's shape");
  eq(c.shipping.label.includes("₹") || c.shipping.total === 0 || c.shipping.label === "Standard shipping", true, "base label");
  // in a market the same Price converts with the cart's function
  const usd = market("USD", "x.99");
  eq(renderToStaticMarkup(h(MarketProvider, { market: M.publicMarket(usd) }, h(Price, { amount: 1499 }))), formatMoney(M.convertPrice(1499, usd), "USD"), "market Price:");
});

await t("conversion and rounding: exact, whole and x.99 in 2- and 0-decimal currencies", async () => {
  const usd = (r) => ({ currency: "USD", rate: 84.2, rounding: r });
  eq([M.convertPrice(1499, usd("exact")), M.convertPrice(1499, usd("whole")), M.convertPrice(1499, usd("x.99"))], [17.8, 18, 17.99], "USD:");
  eq(M.convertPrice(1515.6, usd("x.99")), 18.99, "x.99 of an exact 18.00 goes to 18.99:");
  const jpy = (r) => ({ currency: "JPY", rate: 0.56, rounding: r });
  eq([M.convertPrice(1499, jpy("exact")), M.convertPrice(1499, jpy("whole")), M.convertPrice(1499, jpy("x.99"))], [2677, 2677, 2677], "JPY:");
  eq(M.convertPrice(0, usd("x.99")), 0, "free stays free:");
  eq(M.boundToBase(18, usd("x.99"), "max"), 1516, "a max bound back to base:");
  const offer = M.convertOffer({ type: "COUPON", discount: { kind: "fixed", value: 300 }, minSubtotal: 2000 }, usd("x.99"));
  eq([offer.discount.value, offer.minSubtotal], [3.56, 23.75], "a fixed coupon and its minimum convert exactly:");
});

await t("a market order needs migration 0039 (refused, not stored wrong)", async () => {
  const src = await readFile(join(ROOT, "lib/orders.js"), "utf8");
  ok(/hasColumns\("orders", ORDER_MARKET_COLUMNS\)/.test(src) && /MARKET_UNAVAILABLE/.test(src), "createOrder probes 0039");
  const sql = await readFile(join(ROOT, "migrations/tenant/0039_order_markets.sql"), "utf8");
  for (const c of ["market", "base_currency", "fx_rate", "base_subtotal", "base_discount_total", "base_shipping_total", "base_total"]) ok(new RegExp(`ADD COLUMN ${c}\\b`).test(sql), c);
});

globalThis.fetch = realFetch;
for (const f of dbs) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
