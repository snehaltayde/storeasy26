// Phase 8 line 2 suite: the prepaid nudge and the cash-on-delivery code.
//
// Everything runs through the real POST /api/checkout handler against a real
// control plane and tenant database (no browser, no network, no payment; the
// Razorpay API is a local stub that records the amount it was asked to mint).
//   1. Brute force (PLAYBOOK money lesson): 1,000 random carts of real seeded
//      variants with live offers, under random shipping and payment rules. Each
//      nudge is completed the way a shopper would: the quote, then "Pay online
//      instead" (razorpay_create) and Cash on Delivery, each with the quote's
//      own numbers. nudge.save = COD charged − Razorpay minted; the online order
//      is the quoted prepaid total; COD hidden in the quote ⇔ the route refuses.
//      Junk prepaidDiscount / nudge / payment_discount in every body is ignored.
//   2. The COD code: no plaintext, expiry, attempts, cooldown and caps, binding
//      to cart, key, phone and amount, no replay, identical answers whatever
//      the phone, the SMS stub never in production, a dedup retry needs no code.
//   3. Settings, the order view, the Shopify draft and the permission matrix.
//   pnpm test:cod-checkout
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-cod-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cod-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
delete process.env.SMS_PROVIDER;
delete process.env.CHECKOUT_MODE;
process.env.NODE_ENV = "test";

const dbs = [".test-cod-default.db", ".test-cod-platform.db", ".test-cod-t.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

globalThis.__codAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__codAfter.push(fn); };`);
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
const { computeShipping } = await import("../lib/shipping.js");
const { upsertOffer } = await import("../lib/offers/store.js");
const { toMinor } = await import("../lib/money.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const PT = await import("../lib/checkout/payment-terms.js");
const OTP = await import("../lib/checkout/cod-otp.js");
const SMS = await import("../lib/messaging/sms.js");
const SET = await import("../lib/admin/settings.js");
const { roleAllows } = await import("../lib/platform/authz.js");
const { redactOrderForRole } = await import("../lib/admin/order-view.js");
const P = await import("../lib/shopify-push.js");
const { friendlyCheckoutError } = await import("../lib/shopper-errors.js");
const { scanText } = await import("./support/banned-copy.js");
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
    console.error(`✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ") || e.message}`);
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
const HOST = "cod.test";
const TENANT = { id: "cod", name: "COD", domains: [HOST], dbUrl: "file:.test-cod-t.db", secrets: { order_link_secret: "cod-link-secret", razorpay_key_secret: "cod-key-secret" } };
const BASE_SHIPPING = { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null, zones: [] };
const saveConfig = (shipping, payment) => C.upsertTenant({ ...TENANT, config: { shipping_config: shipping, payment_config: payment, razorpay_key_id: "rzp_test_cod" } });
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await saveConfig(BASE_SHIPPING, null);
const inT = async (fn) => withTenant(await C.getTenant("cod"), fn);

const VARIANTS = [
  ["V1", 349],
  ["V2", 1299],
  ["V3", 89.5],
  ["V4", 2499],
  ["V5", 4999],
  ["V6", 15],
];
await inT(async () => {
  await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));
  for (const [v, price] of VARIANTS) {
    await db.insertInto("products").values({ id: `gid://t/P${v}`, handle: `p-${v}`, title: `Product ${v}`, price_min: price, price_max: price, currency: "INR", available: 1, tags: "[]" }).execute();
    await db.insertInto("variants").values({ id: `gid://t/${v}`, product_id: `gid://t/P${v}`, title: "One", price, currency: "INR", available: 1 }).execute();
  }
  // live offers: an odd line percent and a coupon, so totals carry paise
  await upsertOffer({ offer: { id: "tier-v2", type: "TIERED_QTY", scope: "line", priority: 10, title: "Two serums", target: { kind: "variantId", value: "gid://t/V2" }, tiers: [{ minQty: 2, percent: 13 }] }, enabled: true });
  await upsertOffer({ offer: { id: "save-seven", type: "COUPON", scope: "order", priority: 50, title: "SAVE7", code: "SAVE7", discount: { kind: "percent", value: 7 }, combinable: true }, enabled: true });
  const { emptyList } = await import("../lib/content/documents-reader.js");
  const now = new Date().toISOString();
  await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), now, now] });
  await libsql.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [now] });
});

let carts = 0;
async function freshCart(lines = [["V2", 1]], coupon = null) {
  const id = `cod-cart-${++carts}`;
  await inT(async () => {
    await createCart(id);
    for (const [v, q] of lines) await addItem(id, `gid://t/${v}`, q);
    if (coupon) await db.updateTable("carts").set({ coupon_code: coupon }).where("id", "=", id).execute();
  });
  return id;
}
const CONTACT = { email: "snehal@mediastic.in", phone: "9876543210", name: "COD Test" };
const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
let keys = 0;
const key = () => `cod-key-${++keys}`;

async function post(cartId, body, { ip = "10.0.0.1", contact = CONTACT, address = ADDRESS } = {}) {
  const headers = { host: HOST, "content-type": "application/json", "x-forwarded-for": ip };
  if (cartId) headers.cookie = `${CART_COOKIE}=${cartId}`;
  const req = new NextRequest(`https://${HOST}/api/checkout`, { method: "POST", headers, body: JSON.stringify({ contact, address, ...body }) });
  const res = await route.POST(req);
  return { status: res.status, body: await res.json() };
}
const quoteOf = async (cartId, opts) => (await post(cartId, { action: "quote" }, opts)).body.quote;
const ordersFor = (cartId) => inT(() => db.selectFrom("orders").selectAll().where("cart_id", "=", cartId).orderBy("created_at").execute());

const razorpayCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.razorpay.com/")) {
    const sent = JSON.parse(init.body);
    razorpayCalls.push(sent);
    return new Response(JSON.stringify({ id: `order_cod${razorpayCalls.length}`, amount: sent.amount, currency: sent.currency }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// a seeded, reproducible random
let seed = 20261126;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

function randomShipping() {
  const zones = rnd() < 0.6 ? [{ label: "North East", prefixes: ["78", "79"], ...(rnd() < 0.5 ? { flatRate: pick([0, 99, 149]) } : {}), ...(rnd() < 0.7 ? { cod: rnd() < 0.5 ? false : true } : {}) }] : [];
  return {
    currency: "INR",
    basis: pick(["net", "gross"]),
    freeThreshold: pick([null, 499, 999, 2500]),
    flatRate: pick([0, 49, 79, 120.5]),
    codFee: pick([0, 29, 49, 75]),
    codFeeWaivedAt: pick([null, null, 1500, 3000]),
    zones,
  };
}
function randomPayment() {
  const prepaid = pick([
    null,
    { kind: "percent", value: pick([2.5, 5, 10, 20]) },
    { kind: "percent", value: pick([5, 15]), max: pick([50, 100, 333]) },
    { kind: "fixed", value: pick([25, 50, 99.5, 400]) },
  ]);
  const cod = { otp: "off", ...(rnd() < 0.5 ? { maxTotal: pick([500, 2000, 5000]) } : {}) };
  const v = SET.validatePaymentConfig({ prepaid, cod });
  if (!v.ok) throw new Error(`fixture config invalid: ${v.errors}`);
  return v.value;
}
const JUNK = { prepaidDiscount: 5000, nudge: { save: 9999, parts: [] }, payment_discount: 7777 };

// ---- 1. brute force ---------------------------------------------------------------

console.log("— brute force: the quote is what is charged");

await t("1,000 random carts × random rules: the nudge equals COD charged − Razorpay minted; paying online charges the quoted prepaid total; COD hidden ⇔ refused", async () => {
  const CARTS = 1000;
  const PER_CONFIG = 25;
  let codPlaced = 0;
  let codRefused = 0;
  let nudged = 0;
  for (let i = 0; i < CARTS; i++) {
    if (i % PER_CONFIG === 0) await saveConfig(randomShipping(), randomPayment());
    const lines = Array.from({ length: int(1, 4) }, () => [pick(VARIANTS)[0], int(1, 3)]);
    const cart = await freshCart(lines, rnd() < 0.3 ? "SAVE7" : null);
    const address = { ...ADDRESS, pincode: pick(["411001", "781001", "790045", "110001"]) };
    const contact = { ...CONTACT, phone: `98${String(int(10000000, 99999999))}` };
    const opts = { address, contact };
    const q = await quoteOf(cart, opts);
    ok(q, `cart ${i}: no quote`);
    const where = `cart ${i} (${JSON.stringify(lines)}, pin ${address.pincode})`;

    // "Pay online instead": the quote's prepaid numbers
    const before = razorpayCalls.length;
    const online = await post(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: q.prepaid.total, expectedShipping: q.prepaid.shipping, ...JUNK }, opts);
    eq(online.status, 200, `${where} online: ${JSON.stringify(online.body)}`);
    eq(razorpayCalls.length, before + 1, `${where} one Razorpay order:`);
    const minted = razorpayCalls.at(-1).amount;
    eq(minted, toMinor(q.prepaid.total), `${where} Razorpay minted:`);
    eq(online.body.amount, minted, `${where} the modal opens for:`);
    const [rzRow] = await ordersFor(cart);
    eq(toMinor(rzRow.total), minted, `${where} stored online total:`);
    eq(toMinor(rzRow.payment_discount), toMinor(q.prepaid.discount), `${where} stored prepaid discount:`);
    eq(toMinor(rzRow.total), toMinor(rzRow.subtotal - rzRow.discount_total - rzRow.payment_discount + rzRow.shipping_total), `${where} total = subtotal − discounts − prepaid + shipping:`);

    // Cash on delivery: the quote's COD numbers
    const cod = await post(cart, { action: "cod", idempotencyKey: key(), expectedTotal: q.cod.total, expectedShipping: q.cod.shipping, ...JUNK }, opts);
    const rows = await ordersFor(cart);
    if (q.cod.available) {
      eq(cod.status, 200, `${where} COD: ${JSON.stringify(cod.body)}`);
      const codRow = rows.find((r) => r.payment_method === "cod");
      eq(toMinor(codRow.total), toMinor(q.cod.total), `${where} COD charged:`);
      eq(Number(codRow.payment_discount), 0, `${where} COD has no prepaid discount:`);
      eq(toMinor(q.nudge.save), toMinor(codRow.total) - minted, `${where} nudge.save = COD charged − Razorpay minted:`);
      if (q.nudge.save > 0) nudged++;
      codPlaced++;
    } else {
      eq([cod.status, cod.body.code, cod.body.error], [409, "COD_UNAVAILABLE", q.cod.reason], `${where} COD hidden, so refused:`);
      eq(rows.filter((r) => r.payment_method === "cod").length, 0, `${where} no COD order:`);
      eq(q.nudge.save, 0, `${where} no nudge without COD:`);
      codRefused++;
    }
  }
  ok(codPlaced > 300 && codRefused > 50 && nudged > 200, `the random rules did not cover the cases: placed ${codPlaced}, refused ${codRefused}, nudged ${nudged}`);
  console.log(`    (${codPlaced} COD placed, ${codRefused} COD refused, ${nudged} with a nudge)`);
});

await t("a tampered expectedTotal is refused for both methods, and body discounts change nothing", async () => {
  await saveConfig(BASE_SHIPPING, { prepaid: { kind: "percent", value: 5 }, cod: { otp: "off" } });
  const cart = await freshCart([["V2", 1]]);
  const q = await quoteOf(cart);
  eq([q.prepaid.total, q.cod.total, q.nudge.save], [1299 - 64 + 0, 1299 + 49, 113], "quote (₹1,299: 5% = ₹64.95 rounds down to ₹64; free shipping; COD fee ₹49):");
  for (const action of ["razorpay_create", "cod"]) {
    const shown = action === "cod" ? q.cod.total : q.prepaid.total;
    const r = await post(cart, { action, idempotencyKey: key(), expectedTotal: shown - 1, ...JUNK });
    eq([r.status, r.body.code, r.body.total], [409, "PRICE_CHANGED", shown], `${action} tampered:`);
    ok(r.body.quote?.prepaid?.total === q.prepaid.total, `${action}: the refusal carries the fresh quote`);
  }
  eq((await ordersFor(cart)).length, 0, "nothing stored:");
  // claiming a bigger prepaid discount in the body charges the quote anyway
  const r = await post(cart, { action: "razorpay_create", idempotencyKey: key(), expectedTotal: 1299 - 5000, ...JUNK });
  eq(r.status, 409, "a total built from the body's discount:");
});

// ---- 2. the COD code ---------------------------------------------------------------

console.log("— the COD code");

const OTP_ALWAYS = { cod: { otp: "always", otpChannel: "sms" } };
const lastSms = () => inT(() => db.selectFrom("notifications").selectAll().where("type", "=", "cod_otp").orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst());
const codeIn = (row) => row.body.match(/^(\d{6}) /)[1];
const otpRows = (cartId) => inT(() => db.selectFrom("cod_otps").selectAll().where("cart_id", "=", cartId).execute());
// lets the next send past the 30 s cooldown, as if time passed
const ageSends = (cartId, ms = 31_000) => inT(() => db.updateTable("cod_otps").set({ last_sent_at: new Date(Date.now() - ms).toISOString() }).where("cart_id", "=", cartId).execute());
// as if an hour passed: earlier tests' sends no longer count toward the phone cap
const anHourLater = () => inT(() => db.updateTable("cod_otps").set({ last_sent_at: new Date(Date.now() - 2 * 3600_000).toISOString() }).execute());
async function sendFor(cartId, k, opts = {}) {
  const q = await quoteOf(cartId, opts);
  return post(cartId, { action: "cod_otp_send", idempotencyKey: k, expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, opts);
}
async function placeCod(cartId, k, challengeId, opts = {}) {
  const q = await quoteOf(cartId, opts);
  return post(cartId, { action: "cod", idempotencyKey: k, challengeId, expectedTotal: q.cod.total, expectedShipping: q.cod.shipping }, opts);
}
const verify = (cartId, k, challengeId, code, opts = {}) => post(cartId, { action: "cod_otp_verify", idempotencyKey: k, challengeId, code }, opts);

await t("the quote says a code is needed; COD without a verified code is refused, with no order", async () => {
  await saveConfig(BASE_SHIPPING, OTP_ALWAYS);
  const cart = await freshCart();
  const q = await quoteOf(cart);
  eq([q.cod.otpRequired, q.cod.otpChannel], [true, "sms"], "quote:");
  const r = await placeCod(cart, key(), undefined);
  eq([r.status, r.body.code, r.body.error], [409, "COD_OTP_REQUIRED", PT.COD_OTP_MESSAGES.required], "refused:");
  eq(friendlyCheckoutError(r.body), PT.COD_OTP_MESSAGES.required, "the shopper reads:");
  eq((await ordersFor(cart)).length, 0, "no order:");
});

await t("send → verify → place: the stub SMS carries the code, cod_otps holds no plaintext, the order records the check", async () => {
  await anHourLater();
  const cart = await freshCart();
  const k = key();
  const sent = await sendFor(cart, k);
  eq(sent.status, 200, `send: ${JSON.stringify(sent.body)}`);
  eq([sent.body.required, sent.body.channel, sent.body.sentTo, sent.body.resendIn, sent.body.expiresIn], [true, "sms", "+91 ••••••3210", 30, 300], "send answer:");
  const sms = await lastSms();
  eq([sms.recipient, sms.provider_id, sms.status], ["+919876543210", "sms-stub", "sent"], "stub SMS row:");
  const code = codeIn(sms);
  const [row] = await otpRows(cart);
  for (const [col, v] of Object.entries(row)) ok(!String(v ?? "").includes(code), `cod_otps.${col} holds the code`);
  ok(!String(row.phone_hash).includes("9876543210") && row.phone_hash.length === 64, "the phone is stored only as a hash");
  ok(Date.parse(row.expires_at) - Date.parse(row.last_sent_at) === 5 * 60_000, "expires in 5 minutes");
  const wrong = await verify(cart, k, sent.body.challengeId, code === "000000" ? "111111" : "000000");
  eq([wrong.status, wrong.body.code, wrong.body.error], [409, "COD_OTP_WRONG", PT.COD_OTP_MESSAGES.wrong], "wrong code:");
  const right = await verify(cart, k, sent.body.challengeId, code);
  eq([right.status, right.body.verified], [200, true], "right code:");
  const placed = await placeCod(cart, k, sent.body.challengeId);
  eq(placed.status, 200, `placed: ${JSON.stringify(placed.body)}`);
  const [order] = await ordersFor(cart);
  ok(order.cod_verified_at, "the order records when the phone was confirmed");
  eq((await otpRows(cart))[0].order_id, order.id, "the challenge is consumed by the order:");
  // a dedup retry (same key, cart now cleared) never needs a second code
  const retry = await post(cart, { action: "cod", idempotencyKey: k });
  eq([retry.status, retry.body.orderId, retry.body.deduped], [200, order.id, true], "retry:");
  // no replay: the same challenge with a new key, on a refilled cart
  await inT(() => addItem(cart, "gid://t/V2", 1));
  const replay = await placeCod(cart, key(), sent.body.challengeId);
  eq([replay.status, replay.body.code], [409, "COD_OTP_REQUIRED"], "replay:");
  const replayVerify = await verify(cart, k, sent.body.challengeId, code);
  eq([replayVerify.status, replayVerify.body.code], [409, "COD_OTP_STALE"], "a used challenge can't be verified again:");
});

await t("expired after 5 minutes; the 6th try is locked even with the right code", async () => {
  await anHourLater();
  const cart = await freshCart();
  const k = key();
  const sent = await sendFor(cart, k);
  const code = codeIn(await lastSms());
  await inT(() => db.updateTable("cod_otps").set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where("id", "=", sent.body.challengeId).execute());
  const late = await verify(cart, k, sent.body.challengeId, code);
  eq([late.status, late.body.code, late.body.error], [409, "COD_OTP_EXPIRED", PT.COD_OTP_MESSAGES.expired], "expired:");

  await ageSends(cart);
  const again = await sendFor(cart, k);
  eq(again.body.challengeId, sent.body.challengeId, "a resend for the same binding reuses the challenge:");
  const fresh = codeIn(await lastSms());
  const bad = fresh === "000000" ? "111111" : "000000";
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await verify(cart, k, sent.body.challengeId, bad)).body.code);
  eq(answers, ["COD_OTP_WRONG", "COD_OTP_WRONG", "COD_OTP_WRONG", "COD_OTP_WRONG", "COD_OTP_LOCKED"], "five wrong tries:");
  const sixth = await verify(cart, k, sent.body.challengeId, fresh);
  eq([sixth.status, sixth.body.code, sixth.body.error], [409, "COD_OTP_LOCKED", PT.COD_OTP_MESSAGES.locked], "6th, right code:");
  eq((await otpRows(cart))[0].attempts, 5, "tries counted:");
});

await t("cooldown 30 s; 3 sends per cart per 30 minutes; each with its own sentence", async () => {
  await anHourLater();
  const cart = await freshCart();
  const k = key();
  eq((await sendFor(cart, k)).status, 200, "first send:");
  const soon = await sendFor(cart, k);
  eq([soon.status, soon.body.code, soon.body.error], [429, "COD_OTP_COOLDOWN", PT.COD_OTP_MESSAGES.cooldown], "at once:");
  ok(soon.body.retryIn > 0 && soon.body.retryIn <= 30, `retryIn ${soon.body.retryIn}`);
  await ageSends(cart);
  eq((await sendFor(cart, k)).status, 200, "second:");
  await ageSends(cart);
  eq((await sendFor(cart, k)).status, 200, "third:");
  await ageSends(cart);
  const fourth = await sendFor(cart, k);
  eq([fourth.status, fourth.body.code, fourth.body.error], [429, "COD_OTP_CART_CAP", PT.COD_OTP_MESSAGES.cartCap], "fourth:");
  eq(friendlyCheckoutError(fourth.body), PT.COD_OTP_MESSAGES.cartCap, "the shopper reads:");
  await ageSends(cart, 31 * 60_000);
  eq((await sendFor(cart, k)).status, 200, "after 30 minutes:");
});

await t("5 sends per phone per hour: the 6th answers exactly like a fresh phone, and sends nothing", async () => {
  const phone = "9000011111";
  const opts = { contact: { ...CONTACT, phone } };
  for (let i = 0; i < 5; i++) eq((await sendFor(await freshCart(), key(), opts)).status, 200, `send ${i + 1}:`);
  const smsBefore = (await inT(() => db.selectFrom("notifications").select("id").where("recipient", "=", "+919000011111").execute())).length;
  const capped = await sendFor(await freshCart(), key(), opts);
  const smsAfter = (await inT(() => db.selectFrom("notifications").select("id").where("recipient", "=", "+919000011111").execute())).length;
  eq(smsAfter, smsBefore, "no message for a capped phone:");
  const freshOpts = { contact: { ...CONTACT, phone: "9000021111" } };
  const fresh = await sendFor(await freshCart(), key(), freshOpts);
  const shape = (r) => ({ status: r.status, ...r.body, challengeId: typeof r.body.challengeId, sentTo: r.body.sentTo.replace(/\d{4}$/, "####") });
  eq(shape(capped), shape(fresh), "capped phone vs fresh phone:");
  ok(/^otp_[0-9a-f]{24}$/.test(capped.body.challengeId) && /^otp_[0-9a-f]{24}$/.test(fresh.body.challengeId), "both challenge ids look the same");
  // the capped challenge can never be verified: its hash is no code's
  const row = await inT(() => db.selectFrom("cod_otps").selectAll().where("id", "=", capped.body.challengeId).executeTakeFirst());
  ok(/^capped:/.test(row.code_hash) && !/^[0-9a-f]{64}$/.test(row.code_hash), `a capped challenge holds a matchable hash: ${row.code_hash}`);
});

await t("a capped phone's challenge can't be verified with any code; resends never reset tries; 10 tries per phone per hour across challenges", async () => {
  await anHourLater();
  await saveConfig(BASE_SHIPPING, OTP_ALWAYS);
  const phone = "9000033333";
  const opts = { contact: { ...CONTACT, phone } };
  // resend keeps the tries
  const cart1 = await freshCart();
  const k1 = key();
  const s1 = await sendFor(cart1, k1, opts);
  const c1 = codeIn(await lastSms());
  const bad = (c) => (c === "000000" ? "111111" : "000000");
  for (let i = 0; i < 2; i++) eq((await verify(cart1, k1, s1.body.challengeId, bad(c1), opts)).body.code, "COD_OTP_WRONG", `try ${i + 1}:`);
  await ageSends(cart1);
  const again = await sendFor(cart1, k1, opts);
  eq(again.body.challengeId, s1.body.challengeId, "same challenge:");
  eq((await otpRows(cart1))[0].attempts, 2, "tries kept across the resend:");
  // across challenges (new carts), every guess counted; past 10 the right code is locked too
  const answers = [];
  const right = [];
  for (let n = 0; n < 3; n++) {
    const cart = await freshCart();
    const k = key();
    const sent = await sendFor(cart, k, opts);
    const code = codeIn(await lastSms());
    for (let i = 0; i < 4; i++) answers.push((await verify(cart, k, sent.body.challengeId, bad(code), opts)).body.code);
    right.push({ cart, k, id: sent.body.challengeId, code });
  }
  const guessed = 2 + answers.filter((a) => a === "COD_OTP_WRONG").length;
  ok(guessed <= OTP.PHONE_TRIES.limit, `${guessed} guesses were checked for one phone in an hour`);
  eq(answers.at(-1), "COD_OTP_LOCKED", "past the cap:");
  const last = right.at(-1);
  const locked = await verify(last.cart, last.k, last.id, last.code, opts);
  eq([locked.body.code, locked.body.error], ["COD_OTP_LOCKED", PT.COD_OTP_MESSAGES.locked], "the right code past the cap:");
  // and a capped phone (sends over 5) never verifies, whatever the code
  await anHourLater(); // a new hour: 5 sends reach the phone, the 6th is capped
  let lastCode = null;
  for (let n = 0; n < 5; n++) {
    await sendFor(await freshCart(), key(), opts);
    lastCode = codeIn(await lastSms()); // a real code this phone just received
  }
  const capCart = await freshCart();
  const capKey = key();
  const capped = await sendFor(capCart, capKey, opts);
  for (const guess of [lastCode, "000000", "123456"]) {
    const r = await verify(capCart, capKey, capped.body.challengeId, guess, opts);
    ok(r.body.code === "COD_OTP_WRONG" || r.body.code === "COD_OTP_LOCKED", `a capped challenge verified with ${guess}`);
  }
});

await t("10 sends per IP per 15 minutes, its own sentence", async () => {
  delete process.env.RATE_LIMIT_DISABLED;
  try {
    const ip = "203.0.113.77";
    for (let i = 0; i < 10; i++) eq((await sendFor(await freshCart(), key(), { ip, contact: { ...CONTACT, phone: `91000${String(i).padStart(5, "0")}` } })).status, 200, `send ${i + 1}:`);
    const r = await sendFor(await freshCart(), key(), { ip, contact: { ...CONTACT, phone: "9100099999" } });
    eq([r.status, r.body.code, r.body.error], [429, "COD_OTP_IP_CAP", PT.COD_OTP_MESSAGES.ipCap], "11th:");
    eq((await sendFor(await freshCart(), key(), { ip: "203.0.113.78", contact: { ...CONTACT, phone: "9100099998" } })).status, 200, "another IP:");
  } finally {
    process.env.RATE_LIMIT_DISABLED = "1";
  }
});

await t("bound to cart, key, phone and amount: another cart's challenge, a changed phone or a changed cart needs a new code", async () => {
  await anHourLater();
  const cartA = await freshCart();
  const kA = key();
  const sent = await sendFor(cartA, kA);
  const code = codeIn(await lastSms());
  // cart B's cookie with cart A's challenge
  const cartB = await freshCart();
  const crossVerify = await verify(cartB, kA, sent.body.challengeId, code);
  eq([crossVerify.status, crossVerify.body.code], [409, "COD_OTP_STALE"], "verify from cart B:");
  eq((await verify(cartA, kA, sent.body.challengeId, code)).status, 200, "verify from cart A:");
  // the same amount with other lines is not the cart the code was sent for
  let other = null;
  await inT(() => OTP.requireVerified({ challengeId: sent.body.challengeId, cartId: cartA, key: kA, phone: CONTACT.phone, amount: 1348, currency: "INR", cart: { items: [{ variantId: "gid://t/V9", quantity: 1 }] } })).catch((e) => (other = e));
  eq(other?.code, "COD_OTP_REQUIRED", "same amount, other lines:");
  const same = await inT(() => OTP.requireVerified({ challengeId: sent.body.challengeId, cartId: cartA, key: kA, phone: CONTACT.phone, amount: 1348, currency: "INR", cart: { items: [{ variantId: "gid://t/V2", quantity: 1 }] } }));
  eq(same.id, sent.body.challengeId, "the same lines:");
  const crossPlace = await placeCod(cartB, kA, sent.body.challengeId);
  eq([crossPlace.status, crossPlace.body.code], [409, "COD_OTP_REQUIRED"], "place from cart B:");
  eq((await ordersFor(cartB)).length, 0, "no order on cart B:");
  // a changed phone
  const otherPhone = await placeCod(cartA, kA, sent.body.challengeId, { contact: { ...CONTACT, phone: "9123456789" } });
  eq([otherPhone.status, otherPhone.body.code], [409, "COD_OTP_REQUIRED"], "changed phone:");
  // another key
  const otherKey = await placeCod(cartA, key(), sent.body.challengeId);
  eq([otherKey.status, otherKey.body.code], [409, "COD_OTP_REQUIRED"], "another key:");
  // the cart changed after sending
  await inT(() => addItem(cartA, "gid://t/V1", 1));
  const changed = await placeCod(cartA, kA, sent.body.challengeId);
  eq([changed.status, changed.body.code], [409, "COD_OTP_REQUIRED"], "changed cart:");
  eq((await ordersFor(cartA)).length, 0, "no order on cart A:");
  // and a fresh code for the new amount places it
  await ageSends(cartA);
  const again = await sendFor(cartA, kA);
  ok(again.body.challengeId !== sent.body.challengeId, "a new challenge for the new amount");
  eq((await verify(cartA, kA, again.body.challengeId, codeIn(await lastSms()))).status, 200, "verify new:");
  eq((await placeCod(cartA, kA, again.body.challengeId)).status, 200, "placed:");
});

await t("the answer to a send never depends on the phone; unknown challenges read like stale ones", async () => {
  const a = await sendFor(await freshCart(), key(), { contact: { ...CONTACT, phone: "9333300001" } });
  const b = await sendFor(await freshCart(), key(), { contact: { ...CONTACT, phone: "+91 93333 00002" } });
  eq(Object.keys(a.body).sort(), Object.keys(b.body).sort(), "same fields:");
  eq([a.status, a.body.resendIn, a.body.expiresIn], [b.status, b.body.resendIn, b.body.expiresIn], "same values:");
  const cart = await freshCart();
  const unknown = await verify(cart, key(), "otp_000000000000000000000000", "123456");
  const notString = await verify(cart, key(), { $ne: null }, "123456");
  eq([unknown.status, unknown.body], [409, { ok: false, code: "COD_OTP_STALE", error: PT.COD_OTP_MESSAGES.stale }], "unknown challenge:");
  eq(notString.body.code, "COD_OTP_STALE", "a non-string id:");
});

await t("timing-safe compare: the code and phone hashes are compared in constant time, never with ===", async () => {
  ok(OTP.timingSafeEqual("ab12", "ab12") && !OTP.timingSafeEqual("ab12", "ab13") && !OTP.timingSafeEqual("ab12", "ab1"), "timingSafeEqual");
  const src = await readFile(join(ROOT, "lib/checkout/cod-otp.js"), "utf8");
  ok(!/code_hash\s*[!=]==|[!=]==\s*row\.code_hash|phone_hash\s*[!=]==/.test(src), "a hash is compared with === in cod-otp.js");
  ok(/timingSafeEqual\(await codeHash\(code, row\.id\), row\.code_hash\)/.test(src), "the code check is not timingSafeEqual");
});

await t("email channel: the code goes by notify to the order's email", async () => {
  await anHourLater();
  await saveConfig(BASE_SHIPPING, { cod: { otp: "always", otpChannel: "email" } });
  const sent = await sendFor(await freshCart(), key());
  eq([sent.status, sent.body.channel, sent.body.sentTo], [200, "email", "s•••@mediastic.in"], "send:");
  const row = await lastSms();
  eq([row.recipient, row.type], ["snehal@mediastic.in", "cod_otp"], "notification:");
  ok(/^\d{6} is your code/.test(row.body), "the email carries the code");
});

await t("an email code places the order as 'Email confirmed by code', never as a phone check", async () => {
  await anHourLater();
  await saveConfig(BASE_SHIPPING, { cod: { otp: "always", otpChannel: "email" } });
  const cart = await freshCart();
  const k = key();
  const sent = await sendFor(cart, k);
  eq((await verify(cart, k, sent.body.challengeId, codeIn(await lastSms()))).status, 200, "verified:");
  eq((await placeCod(cart, k, sent.body.challengeId)).status, 200, "placed:");
  const [order] = await ordersFor(cart);
  eq(await inT(() => OTP.codCheckChannel(order.id)), "email", "channel:");
  eq(OTP.codCheckWords(await inT(() => OTP.codCheckChannel(order.id))), "Email confirmed by code", "label:");
});

await t("SMS chosen with no provider: the send is refused with its sentence, no code is made or sent", async () => {
  await anHourLater();
  await saveConfig(BASE_SHIPPING, OTP_ALWAYS);
  const cart = await freshCart();
  const was = process.env.NODE_ENV;
  const before = (await inT(() => db.selectFrom("notifications").select("id").execute())).length;
  process.env.NODE_ENV = "production";
  let r;
  try {
    r = await sendFor(cart, key());
  } finally {
    process.env.NODE_ENV = was;
  }
  eq([r.status, r.body.code, r.body.error], [503, "COD_OTP_UNAVAILABLE", PT.COD_OTP_MESSAGES.cantSend], "refused:");
  eq(friendlyCheckoutError(r.body), PT.COD_OTP_MESSAGES.cantSend, "the shopper reads:");
  eq((await otpRows(cart)).length, 0, "no challenge:");
  eq((await inT(() => db.selectFrom("notifications").select("id").execute())).length, before, "no message:");
});

await t("a sent code leaves the notifications row: the body is redacted on the next send or check", async () => {
  await anHourLater();
  await saveConfig(BASE_SHIPPING, OTP_ALWAYS);
  const cart = await freshCart();
  const k = key();
  const sent = await sendFor(cart, k);
  const row = await lastSms();
  const code = codeIn(row);
  await verify(cart, k, sent.body.challengeId, code);
  const after = await inT(() => db.selectFrom("notifications").select(["body"]).where("id", "=", row.id).executeTakeFirst());
  ok(!after.body.includes(code) && !/\d{6}/.test(after.body), `the code is still in the row: ${after.body}`);
  // an unsent one (the email queue) keeps its text until the code expires, then loses it too
  await inT(() => db.updateTable("notifications").set({ created_at: new Date(Date.now() - 6 * 60_000).toISOString() }).where("type", "=", "cod_otp").where("status", "!=", "sent").execute());
  await verify(cart, k, sent.body.challengeId, code);
  const left = await inT(() => db.selectFrom("notifications").select(["body", "status"]).where("type", "=", "cod_otp").execute());
  ok(left.length > 0 && left.every((n) => !/\d{6}/.test(n.body)), `a code is still stored: ${JSON.stringify(left.find((n) => /\d{6}/.test(n.body)))}`);
});

await t("OTP above an amount: below it no code, above it a code", async () => {
  await anHourLater();
  await saveConfig(BASE_SHIPPING, { cod: { otp: "above", otpAbove: 2000, otpChannel: "sms" } });
  const small = await freshCart([["V2", 1]]);
  eq((await quoteOf(small)).cod.otpRequired, false, "₹1,348:");
  eq((await sendFor(small, key())).body.required, false, "send says no code is needed:");
  eq((await placeCod(small, key(), undefined)).status, 200, "placed without a code:");
  const big = await freshCart([["V4", 1]]);
  eq((await quoteOf(big)).cod.otpRequired, true, "₹2,548:");
  eq((await placeCod(big, key(), undefined)).body.code, "COD_OTP_REQUIRED", "refused without a code:");
});

await t("the SMS stub never runs in production; settings refuse SMS there", async () => {
  ok(SMS.smsAvailable(), "outside production the stub is available");
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    eq(SMS.smsProvider(), null, "provider:");
    eq(SMS.smsAvailable(), false, "available:");
    process.env.SMS_PROVIDER = "stub";
    eq(SMS.smsProvider(), null, "named stub in production:");
    let threw = null;
    await SMS.stub.send({ to: "+919999999999", text: "x" }).catch((e) => (threw = e));
    ok(threw && /never runs in production/.test(threw.message), "the stub refuses in production");
    await SMS.sendSms({ to: "+919999999999", text: "x" }).catch((e) => (threw = e));
    ok(/No SMS provider/.test(threw.message), "sendSms refuses");
    let refused = null;
    try {
      OTP.otpChannelFor("sms");
    } catch (e) {
      refused = e;
    }
    eq([refused?.code, refused?.message], ["COD_OTP_UNAVAILABLE", PT.COD_OTP_MESSAGES.cantSend], "SMS is refused, never sent by email instead:");
    eq(OTP.otpChannelFor("email"), "email", "email stays email:");
    const r = SET.buildSettingsPatch({ payment_config: { cod: { otp: "always", otpChannel: "sms" } } }, {}, { smsAvailable: SMS.smsAvailable() });
    eq([r.ok, r.errors], [false, [SET.SMS_UNAVAILABLE]], "settings:");
  } finally {
    process.env.NODE_ENV = was;
    delete process.env.SMS_PROVIDER;
  }
});

// ---- 3. rules, settings, order view, Shopify, permissions ----------------------------

console.log("— rules, settings and the order");

await t("COD hidden with its reason: a zone with cod: false, and a total over the COD limit; the reasons pass to the shopper", async () => {
  await saveConfig({ ...BASE_SHIPPING, zones: [{ label: "Islands", prefixes: ["744"], cod: false }] }, { cod: { otp: "off", maxTotal: 5000 } });
  const cart = await freshCart([["V2", 1]]);
  const island = await quoteOf(cart, { address: { ...ADDRESS, pincode: "744101" } });
  eq([island.cod.available, island.cod.reason], [false, "Cash on delivery isn't available for this PIN code"], "zone:");
  const big = await freshCart([["V5", 2]]);
  const q = await quoteOf(big);
  eq([q.cod.available, q.cod.reason], [false, "Cash on delivery isn't available for orders over ₹5,000"], "limit:");
  for (const reason of [island.cod.reason, q.cod.reason]) eq(friendlyCheckoutError({ code: "COD_UNAVAILABLE", error: reason }), reason, "shopper reads:");
  const send = await post(big, { action: "cod_otp_send", idempotencyKey: key() });
  eq([send.status, send.body.code], [409, "COD_UNAVAILABLE"], "no code is sent for a hidden COD:");
});

await t("paymentTerms: percent capped at 20 and rounded down, cap applied, fixed never above goods, free shipping unchanged, zones agree with the engine", () => {
  const cart = (total) => ({ subtotal: total, discountTotal: 0, total, currency: "INR" });
  eq(PT.prepaidDiscountFor(999, { kind: "percent", value: 5 }), 49, "5% of ₹999:");
  eq(PT.prepaidDiscountFor(1000, { kind: "percent", value: 35 }), 200, "a stored 35% acts as 20%:");
  eq(PT.prepaidDiscountFor(5000, { kind: "percent", value: 10, max: 300 }), 300, "cap:");
  eq(PT.prepaidDiscountFor(80, { kind: "fixed", value: 100 }), 80, "fixed above goods:");
  const t1 = PT.paymentTerms({ cart: cart(1000), shippingConfig: BASE_SHIPPING, paymentConfig: { prepaid: { kind: "percent", value: 10 } } });
  eq([t1.prepaid.shipping, t1.prepaid.total], [0, 900], "₹1,000 stays free-shipping though the discount takes it under ₹999:");
  eq(PT.nudgeSentence(t1.nudge, "INR"), "Pay online and save ₹149: no ₹49 COD fee and 10% off", "sentence:");
  const capped = PT.paymentTerms({ cart: cart(5000), shippingConfig: BASE_SHIPPING, paymentConfig: { prepaid: { kind: "percent", value: 10, max: 300 } } });
  eq(PT.nudgeSentence(capped.nudge, "INR"), "Pay online and save ₹349: no ₹49 COD fee and ₹300 off", "a capped percent says the amount:");
  const noRzp = PT.paymentTerms({ cart: cart(1000), shippingConfig: BASE_SHIPPING, paymentConfig: { prepaid: { kind: "percent", value: 10 } }, prepaidAvailable: false });
  eq([noRzp.prepaid.discount, noRzp.nudge.save], [0, 0], "no online payment, no nudge:");
  const zoned = { ...BASE_SHIPPING, zones: [{ label: "A", prefixes: ["11"], cod: false }, { label: "B", prefixes: ["1"] }] };
  for (const pin of ["110001", "120001", "411001", ""]) {
    const engine = computeShipping({ subtotal: 500, pincode: pin, config: zoned }).zone;
    const t2 = PT.paymentTerms({ cart: cart(500), shippingConfig: zoned, pincode: pin });
    eq(t2.cod.available, engine !== "A", `pin ${pin} (engine zone ${engine}):`);
  }
});

await t("settings: payment_config is validated, saved under its key, and the worked example comes from paymentTerms", () => {
  const good = SET.buildSettingsPatch({ payment_config: { prepaid: { kind: "percent", value: "5", max: "" }, cod: { maxTotal: "5000", otp: "above", otpAbove: "2000", otpChannel: "email" } } }, {}, { smsAvailable: false });
  eq(good.ok, true, `valid: ${good.errors}`);
  eq(good.patch.config.payment_config, { prepaid: { kind: "percent", value: 5 }, cod: { otp: "above", maxTotal: 5000, otpAbove: 2000, otpChannel: "email" } }, "stored:");
  const bad = SET.buildSettingsPatch({ payment_config: { prepaid: { kind: "percent", value: 25 } } }, {});
  eq(bad.ok, false, "25% refused:");
  ok(!("payment_config" in SET.buildSettingsPatch({ identity: { name: "X" } }, {}).patch.config), "an unrelated save leaves payment_config alone");
  eq(SET.buildSettingsPatch({ payment_config: { cod: { otp: "always", otpChannel: "sms" } } }, {}, { smsAvailable: true }).ok, true, "SMS where a provider is set:");
  const example = PT.paymentExample(good.patch.config.payment_config, BASE_SHIPPING);
  eq(example, [
    "A ₹1,000 order costs ₹1,049 by cash on delivery and ₹950 paid online, so paying online saves ₹99.",
    "Cash on delivery is offered up to ₹5,000.",
    "Cash-on-delivery orders over ₹2,000 ask for a code sent by email, which confirms the email address, not the phone.",
  ], "example:");
  const t1 = PT.paymentTerms({ cart: { subtotal: 1000, discountTotal: 0, total: 1000 }, shippingConfig: BASE_SHIPPING, paymentConfig: good.patch.config.payment_config });
  eq([t1.cod.total, t1.prepaid.total, t1.nudge.save], [1049, 950, 99], "the example's numbers are the checkout's:");
});

await t("copy: the nudge, the reasons and the code answers pass the banned-copy scan and use no pressure words", () => {
  const texts = [...Object.values(PT.COD_OTP_MESSAGES), "Pay online and save ₹128: no ₹49 COD fee and 5% off", "Pay online instead", "Cash on delivery isn't available for this PIN code", ...PT.paymentExample({ prepaid: { kind: "fixed", value: 50 }, cod: { otp: "always", otpChannel: "sms", maxTotal: 3000 } }, BASE_SHIPPING)];
  for (const s of texts) {
    eq(scanText(s, { shopper: true }).map((f) => f.label), [], `"${s}":`);
    ok(!/hurry|only today|last chance|don't miss|limited time|act now/i.test(s), `pressure words: ${s}`);
  }
});

await t("order view: 'Phone confirmed by code' shows for support (a time, not PII), the prepaid discount is on the order", async () => {
  const [order] = await inT(() => db.selectFrom("orders").selectAll().where("cod_verified_at", "is not", null).limit(1).execute());
  ok(order, "a verified COD order exists");
  const support = redactOrderForRole(order, "support");
  ok(support.pii_redacted && support.phone === null, "support's view is redacted");
  eq(support.cod_verified_at, order.cod_verified_at, "support sees the check:");
  for (const role of ["staff", "admin", "owner"]) eq(redactOrderForRole(order, role).cod_verified_at, order.cod_verified_at, `${role}:`);
  eq([OTP.codCheckWords("sms"), OTP.codCheckWords("email"), OTP.codCheckWords(null)], ["Phone confirmed by code", "Email confirmed by code", null], "the label says what the code proved:");
  eq(await inT(() => OTP.codCheckChannel(order.id)), "sms", "this order's code went by SMS:");
  const src = await readFile(join(ROOT, "components/admin/orders/OrderTimeline.js"), "utf8");
  ok(src.includes("{codCheck}") && !/>\s*Phone confirmed by code/.test(src), "the timeline shows the channel's words, never a fixed phone claim");
  const page = await readFile(join(ROOT, "app/(console)/admin/(authed)/orders/[id]/page.js"), "utf8");
  ok(/codCheck=\{codCheckWords\(codChannel\)\}/.test(page) && /codVerifiedAt=\{order\.cod_verified_at/.test(page) && /payment_discount: order\.payment_discount/.test(page), "the order page passes the check, its words and the prepaid discount");
});

await t("Shopify draft: the prepaid discount rides in the order-level discount as 'Prepaid discount'", () => {
  const base = { id: "COD-1", email: "a@b.test", total: 1185, shipping_total: 0, razorpay_payment_id: "pay_1", snapshot: { items: [{ variantId: "gid://t/V2", quantity: 1 }], gifts: [], appliedOffers: [{ id: "o", label: "Launch", amount: 50 }], totals: { discountTotal: 50, shippingTotal: 0 }, shipping: { label: "Free shipping" }, contact: {}, address: {} } };
  const withPrepaid = P.buildDraftOrderInput({ ...base, payment_discount: 64 });
  eq([withPrepaid.appliedDiscount.value, withPrepaid.appliedDiscount.description], [114, "Launch + Prepaid discount"], "offers + prepaid:");
  const only = P.buildDraftOrderInput({ ...base, payment_discount: 64, snapshot: { ...base.snapshot, appliedOffers: [], totals: { discountTotal: 0, shippingTotal: 0 } } });
  eq([only.appliedDiscount.value, only.appliedDiscount.description], [64, "Prepaid discount"], "prepaid only:");
  eq(P.buildDraftOrderInput({ ...base, payment_discount: 0 }).appliedDiscount.value, 50, "no prepaid:");
});

await t("matrix: payment settings are admin and owner only; quote, code and place are the cart cookie's own", async () => {
  for (const role of ["support", "staff"]) ok(!roleAllows(role, "settings.read") && !roleAllows(role, "settings.write"), `${role} must get NoAccess`);
  for (const role of ["admin", "owner"]) ok(roleAllows(role, "settings.read") && roleAllows(role, "settings.write"), `${role} must read and write`);
  const page = await readFile(join(ROOT, "app/(console)/admin/(authed)/settings/checkout/page.js"), "utf8");
  ok(/roleAllows\(actor\.role, "settings\.read"\)\) return <NoAccess/.test(page), "the checkout settings page is not gated");
  const api = await readFile(join(ROOT, "app/api/admin/settings/route.js"), "utf8");
  ok(/requireAdmin\(request, "settings\.write"\)/.test(api), "the settings write is not gated");
  // anonymous shopper, no cart cookie: an empty quote, and nothing else
  await saveConfig(BASE_SHIPPING, OTP_ALWAYS);
  const none = await post(null, { action: "quote" });
  eq(Object.keys(none.body).sort(), ["ok", "quote"], "the quote answer's fields:");
  eq([none.body.quote.prepaid.total, none.body.quote.cod.total], [79, 128], "an empty cart's quote:");
  eq((await post(null, { action: "cod_otp_send", idempotencyKey: key() })).status, 400, "no cart, no code:");
  // one shopper's cookie quotes only its own cart
  const a = await freshCart([["V4", 1]]);
  const b = await freshCart([["V6", 1]]);
  eq([(await quoteOf(a)).prepaid.total, (await quoteOf(b)).prepaid.total], [2499, 94], "each cookie its own cart:");
});

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
