// A shopper reads only their own cart, orders and account (Phase 0 line 3).
//   pnpm test:shopper-reads
// A shopper is proved only by the _customer cookie (lib/customers.js
// customerFromToken), the cart cookie, or a signed order link
// (verifyOrderStatusToken). This suite:
//   1. guards the map: every route outside app/api/admin/ and every storefront
//      page/layout has a row in scripts/support/shopper-routes.js, and no
//      shopper route takes a cart or customer id from the body or the query;
//   2. calls the real account, cart, checkout and public routes, and runs the
//      shopper pages (scripts/support/page-harness.js), as: anonymous, shopper A
//      (the owner, positive control), shopper B with A's ids, B with a forged,
//      revoked or expired _customer, and A's cookies on store B's host. Every
//      answer to a non-owner is searched for A's canaries;
//   3. pins the line's findings: an idempotency key alone never returns
//      another cart's order (a genuine retry from the same cart still does),
//      no public "dev-only-secret" in production, no raw checkout errors, OTP
//      attempts counted atomically, and no "too many codes" oracle.
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const fetchCalls = H.blockNetwork();
process.env.DATABASE_URL = "file:.test-shop-default.db";
process.env.TURSO_DB_URL = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let pass = 0;
let fail = 0;
const realLog = console.log;
const realErr = console.error;
const quiet = () => {
  console.log = () => {};
  console.error = () => {};
};
const loud = () => {
  console.log = realLog;
  console.error = realErr;
};
async function t(name, fn) {
  quiet();
  try {
    await fn();
    loud();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    loud();
    fail++;
    console.error(`✗ ${name}\n    ${e?.stack?.split("\n").slice(0, 3).join("\n    ") || e}`);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg);
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);

// ---------------------------------------------------------------------------
// 1. The map
// ---------------------------------------------------------------------------
const { SHOPPER_ROUTES, ROUTE_CLASSES, STOREFRONT_PAGES, APP_ENTRIES } = await import("./support/shopper-routes.js");
const { pathToFileURL } = await import("node:url");

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// Every entry file Next serves from app/, outside the consoles and the admin API.
const ENTRY_RE = /(^|\/)(route|page|layout)\.(js|jsx|ts|tsx|mjs)$/;
const METADATA_RE = /(^|\/)(sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(js|jsx|ts|tsx|mjs)$/;
const APP_FILES = (await walk(join(ROOT, "app")))
  .map((f) => relative(join(ROOT, "app"), f))
  .filter((f) => !f.startsWith("(console)/") && !f.startsWith("api/admin/"))
  .filter((f) => ENTRY_RE.test(f) || METADATA_RE.test(f));
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const SEGMENT_CONFIG = ["runtime", "dynamic", "revalidate", "fetchCache", "dynamicParams", "preferredRegion", "maxDuration"];
const PAGE_EXPORTS = ["default", "metadata", "generateMetadata", "viewport", "generateViewport", "generateStaticParams", ...SEGMENT_CONFIG];
const isRoute = (f) => /(^|\/)route\.\w+$/.test(f);

// The page harness compiles pages, layouts and metadata files (JSX) with Next's
// SWC; route files are plain modules. Either way the module's real exports.
const { makePageHarness } = await import("./support/page-harness.js");
let pageStore = null;
const P = await makePageHarness({ tenant: async () => pageStore.tenant });
async function exportsOf(f) {
  const mod = isRoute(f) ? await import(pathToFileURL(join(ROOT, "app", f)).href) : await P.load(`app/${f}`);
  return Object.keys(mod).filter((k) => k !== "__esModule");
}

console.log("— 1. every non-admin entry file has a row");

await t("every entry file under app/ (outside the consoles and the admin API) has exactly one row", async () => {
  const rowFor = (f) => {
    const api = f.match(/^api\/(.+)\/route\.\w+$/);
    if (api) return SHOPPER_ROUTES.find((r) => r.path === api[1]);
    const sf = f.match(/^\(storefront\)\/(?:(.*)\/)?(page|layout)\.\w+$/);
    if (sf) return STOREFRONT_PAGES.find((p) => p.page === (sf[2] === "layout" && !sf[1] ? "layout.js" : sf[2] === "page" ? sf[1] ?? "" : `${sf[1]}/layout.js`));
    return APP_ENTRIES.find((e) => e.file === f);
  };
  const missing = APP_FILES.filter((f) => !rowFor(f));
  const rowFiles = new Set(APP_FILES.map(rowFor).filter(Boolean));
  const extra = [...SHOPPER_ROUTES, ...STOREFRONT_PAGES, ...APP_ENTRIES].filter((r) => !rowFiles.has(r)).map((r) => r.path ?? r.page ?? r.file);
  same([missing, extra], [[], []], "[file without a row, row without a file]");
  eq(new Set(SHOPPER_ROUTES.map((r) => r.path)).size, SHOPPER_ROUTES.length, "duplicate route rows");
  eq(new Set(STOREFRONT_PAGES.map((r) => r.page)).size, STOREFRONT_PAGES.length, "duplicate page rows");
  for (const r of SHOPPER_ROUTES) ok(ROUTE_CLASSES.includes(r.class), `${r.path}: unknown class ${r.class}`);
  for (const p of [...STOREFRONT_PAGES, ...APP_ENTRIES]) ok(["shopper", "public"].includes(p.class), `${p.page ?? p.file}: class ${p.class}`);
  // the guard sees the same route files git tracks (an untracked route fails test:security)
  const tracked = execFileSync("git", ["ls-files", "app"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && APP_FILES.includes(f.slice(4)));
  eq(tracked.length, APP_FILES.length, "tracked entry files");
});

await t("every entry file's exports are known: a route's handlers match its row, nothing unclassified", async () => {
  const problems = [];
  for (const f of APP_FILES) {
    const keys = await exportsOf(f);
    if (isRoute(f)) {
      const methods = keys.filter((k) => HTTP_METHODS.includes(k)).sort();
      const row = SHOPPER_ROUTES.find((r) => `api/${r.path}/route.js` === f) ?? APP_ENTRIES.find((e) => e.file === f);
      if (row && JSON.stringify(methods) !== JSON.stringify([...row.methods].sort())) problems.push(`${f}: exports ${methods}, row says ${row.methods}`);
      for (const k of keys) if (!HTTP_METHODS.includes(k) && !SEGMENT_CONFIG.includes(k)) problems.push(`${f}: unclassified export ${k}`);
    } else {
      if (!keys.includes("default")) problems.push(`${f}: no default export`);
      for (const k of keys) if (!PAGE_EXPORTS.includes(k)) problems.push(`${f}: unclassified export ${k}`);
    }
  }
  same(problems, [], "export problems");
});

// Reading an id from the request is how a shopper reaches someone else's cart.
const BODY_ID = "cartId|customerId|cart_id|customer_id";
const BODY_ID_RES = [
  new RegExp(`\\b(body|searchParams|sp|query)\\??\\.(${BODY_ID})\\b`),
  new RegExp(`\\b(body|searchParams|sp|query)\\??\\.?\\[\\s*["'\`](${BODY_ID})["'\`]\\s*\\]`),
  new RegExp(`\\{[^{}]*\\b(${BODY_ID})\\b[^{}]*\\}\\s*=\\s*(await\\s+)?(body|searchParams|sp|query|request\\.json\\(\\)|req\\.json\\(\\))`),
  new RegExp(`searchParams\\.get\\(\\s*["'\`](id|cart|${BODY_ID}|customer)["'\`]\\s*\\)`),
];
const readsBodyId = (src) => BODY_ID_RES.map((re) => src.match(re)?.[0]).filter(Boolean);

await t("the body-id guard catches every shape it is meant to", async () => {
  for (const bad of [
    "const x = body.cartId;",
    "const x = body?.customer_id;",
    'const x = body["cartId"];',
    "const x = body?.['customer_id'];",
    "const { action, cartId } = body;",
    "const { customerId: who } = await request.json();",
    "const { cart_id } = await searchParams;",
    'const c = url.searchParams.get("id");',
    "const c = request.nextUrl.searchParams.get('cartId');",
  ]) ok(readsBodyId(bad).length, `missed: ${bad}`);
  for (const fine of ["const { action, contact } = body;", 'url.searchParams.get("order")', "customer.id", "const cartId = cartIdFrom(request);"]) same(readsBodyId(fine), [], `flagged: ${fine}`);
});

await t("no shopper-class file reads a cart or customer id from the body or the query", async () => {
  const files = [
    ...SHOPPER_ROUTES.filter((r) => r.class === "shopper").map((r) => `app/api/${r.path}/route.js`),
    ...STOREFRONT_PAGES.filter((p) => p.class === "shopper").map((p) => `app/(storefront)/${p.page === "layout.js" ? "layout.js" : `${p.page}/page.js`}`),
    ...APP_ENTRIES.filter((e) => e.class === "shopper").map((e) => `app/${e.file}`),
  ];
  ok(files.length >= 9, `shopper files: ${files.length}`);
  for (const f of files) same(readsBodyId(await readFile(join(ROOT, f), "utf8")), [], f);
});

await t("the storefront layout's initialCart reads only the cart cookie", async () => {
  const src = await readFile(join(ROOT, "app/(storefront)/layout.js"), "utf8");
  const fn = src.slice(src.indexOf("async function initialCart()"), src.indexOf("export default async function RootLayout"));
  ok(/\(await cookies\(\)\)\.get\(CART_COOKIE\)\?\.value/.test(fn) && /shopperCart\(await tfetch\(\(\) => getCart\(id\)\)\)/.test(fn), fn.slice(0, 300));
  ok(!/searchParams|params|body/.test(fn), "initialCart takes nothing else");
});

// ---------------------------------------------------------------------------
// 2. Fixture: store A (shoppers A and B), store B, store C (no secrets)
// ---------------------------------------------------------------------------
const F = await import("./support/tenant-fixture.js");
const platform = await F.makePlatform({ name: "shop" });
const RZ_KEY_SECRET = "cnyrzpsec0";
const A_LINK_SECRET = "cnyalinksec0";
const sA = await F.makeTenant({ name: "shop-a", mode: "documents", products: 2, secrets: { order_link_secret: A_LINK_SECRET, razorpay_key_secret: RZ_KEY_SECRET }, config: { razorpay_key_id: "rzp_test_shopa" } });
const sB = await F.makeTenant({ name: "shop-b", mode: "documents", products: 1, secrets: { order_link_secret: "cnyblinksec0" } });
const sC = await F.makeTenant({ name: "shop-c", mode: "documents", products: 1, secrets: { order_link_secret: "" } });
for (const s of [sA, sB, sC]) F.assertLocalDbUrl(s.tenant.dbUrl);
const HOST_A = sA.tenant.domains[0];
const HOST_B = sB.tenant.domains[0];

// open each store (a store that never published takes no orders)
for (const s of [sA, sB, sC]) {
  const c = s.client();
  const now = new Date().toISOString();
  const { emptyList } = await import("../lib/documents/release-list.js");
  const Reg = await import("../lib/registry/index.js");
  const types = Reg.singletonTypes();
  const list = emptyList(Math.max(1, ...types.map((x) => Reg.documentType(x).sinceManifest || 1)), types);
  await c.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(list), now, now] });
  await c.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [now] });
  c.close();
}

const { NextRequest } = await import("./support/next-server-stub.js");
const { CART_COOKIE } = await import("../lib/cart.js");
const O = await import("../lib/orders.js");
const Cust = await import("../lib/customers.js");
const ROUTES = {
  account: await import("../app/api/account/route.js"),
  cart: await import("../app/api/cart/route.js"),
  checkout: await import("../app/api/checkout/route.js"),
  search: await import("../app/api/search/route.js"),
  upsell: await import("../app/api/upsell/route.js"),
  wishlist: await import("../app/api/wishlist/route.js"),
  media: await import("../app/api/media/[id]/route.js"),
};

// One call to a real route. cookies: { name: value }.
async function call(name, method, { host = HOST_A, cookies = {}, body, query = "", params } = {}) {
  const headers = { host };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers.origin = `http://${host}`;
  }
  const jar = Object.entries(cookies).filter(([, v]) => v != null);
  if (jar.length) headers.cookie = jar.map(([k, v]) => `${k}=${v}`).join("; ");
  const req = new NextRequest(`http://${host}/api/${name}${query ? `?${query}` : ""}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const res = await ROUTES[name.split("/")[0]][method](req, { params: Promise.resolve(params ?? {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text, setCookie: res.headers.getSetCookie() };
}
const cookieFrom = (r, name) => r.setCookie.map((c) => c.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find((v) => v != null) ?? null;

const variant = (s, i = 0) => s.products[i].variants.nodes[0].id;
async function cartWith(host, s, cookie = null, qty = 1) {
  const r = await call("cart", "POST", { host, cookies: { [CART_COOKIE]: cookie }, body: { action: "add", variantId: variant(s), quantity: qty } });
  eq(r.status, 200, `cart add (${r.text.slice(0, 120)})`);
  return cookie || cookieFrom(r, CART_COOKIE);
}

// Place an order as a shopper: the first try learns the server's total.
async function checkout(action, { host = HOST_A, cartId, key, contact, address, customer }) {
  const body = { action, idempotencyKey: key, contact, address };
  const cookies = { [CART_COOKIE]: cartId, _customer: customer };
  let r = await call("checkout", "POST", { host, cookies, body });
  if (r.status === 409 && r.body?.code === "PRICE_CHANGED") r = await call("checkout", "POST", { host, cookies, body: { ...body, expectedTotal: r.body.total, expectedShipping: r.body.shippingTotal } });
  return r;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
// sign in through the real verify route with a code we planted
async function signIn(email, { host = HOST_A, linkSecret = A_LINK_SECRET, store = sA } = {}) {
  const c = store.client();
  await c.execute({ sql: "INSERT INTO customer_otps (id, email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)", args: [`otp_${Math.random().toString(16).slice(2)}`, email, sha(`424242|${linkSecret}|customer`), new Date(Date.now() + 600000).toISOString(), new Date(Date.now() - 1000).toISOString()] });
  c.close();
  const r = await call("account", "POST", { host, body: { action: "verify", email, code: "424242" } });
  eq(r.status, 200, `verify ${email} (${r.text.slice(0, 160)})`);
  return { token: cookieFrom(r, "_customer"), body: r.body };
}
const q = async (s, sql, args = []) => {
  const c = s.client();
  try {
    return (await c.execute({ sql, args })).rows;
  } finally {
    c.close();
  }
};

// Canaries: short lowercase ASCII so no casing or encoding hides one.
const CNY = {
  aEmail: "cnyamail0@example.test",
  aPhone: "9811100001",
  aName: "cnyaname0",
  aLine1: "cnyaline0",
  aRzPay: "pay_cnyapay0",
  aRzOrder: "order_cnyarz0",
  aCoupon: "cnyacoupon0",
  aReturn: "cnyareturn0 please take it back",
  aWish: "cnyawish0",
  aKey: "cnyakey0",
  bEmail: "cnybmail0@example.test",
  bPhone: "9822200002",
  bName: "cnybname0",
  bLine1: "cnybline0",
  sbEmail: "cnysbmail0@example.test",
  sbName: "cnysbname0",
  sbLine1: "cnysbline0",
};
const contactOf = (p) => ({ email: CNY[`${p}Email`], phone: CNY[`${p}Phone`] || "9833300003", name: CNY[`${p}Name`] });
const addressOf = (p) => ({ line1: CNY[`${p}Line1`], city: "Pune", state: "MH", pincode: "411001" });

let A = {};
let B = {};
const fixture = { ok: false };
await t("fixture: shoppers A and B place orders and sign in on store A; store B has its own shopper", async () => {
  // A: a COD order from cart A
  A.cart = await cartWith(HOST_A, sA);
  const placed = await checkout("cod", { cartId: A.cart, key: CNY.aKey, contact: contactOf("a"), address: addressOf("a") });
  eq(placed.status, 200, `A's order (${placed.text.slice(0, 200)})`);
  A.order = placed.body.orderId;
  A.confirmationPath = placed.body.confirmationPath;
  // A: a paid Razorpay order and a pending one, through the order model
  await sA.run(async () => {
    const cart = { items: [{ variantId: variant(sA), productId: sA.products[0].id, title: "Fixture", variantTitle: "Default", image: null, price: 100, quantity: 1, lineTotal: 100, discount: 0 }], gifts: [], appliedOffers: [], subtotal: 100, discountTotal: 0, total: 100, currency: "INR" };
    A.rzCart = "cart-a-rz-cnyrz";
    const paid = await O.createOrder({ cartId: A.rzCart, cart, contact: contactOf("a"), address: addressOf("a"), paymentMethod: "razorpay", idempotencyKey: "cnyakeyrz1", razorpayOrderId: CNY.aRzOrder });
    await O.markOrderPaid(paid.id, { razorpayPaymentId: CNY.aRzPay, source: "test" });
    A.rzPaid = paid.id;
    const pending = await O.createOrder({ cartId: "cart-a-rz-pending", cart, contact: contactOf("a"), address: addressOf("a"), paymentMethod: "razorpay", idempotencyKey: "cnyakeyrz2", razorpayOrderId: "order_cnyarzpend0" });
    A.rzPending = pending.id;
    const b = await O.createOrder({ cartId: "cart-b-rz", cart, contact: contactOf("b"), address: addressOf("b"), paymentMethod: "razorpay", idempotencyKey: "cnybkeyrz1", razorpayOrderId: "order_cnybrz0" });
    B.rzPending = b.id;
  });
  await q(sA, "UPDATE orders SET coupon_code = ? WHERE id = ?", [CNY.aCoupon, A.order]);
  // B: same item, same quantity: the same total as A's order
  B.cart = await cartWith(HOST_A, sA);
  const bPlaced = await checkout("cod", { cartId: B.cart, key: "cnybkey0", contact: contactOf("b"), address: addressOf("b") });
  eq(bPlaced.status, 200, `B's order (${bPlaced.text.slice(0, 200)})`);
  B.order = bPlaced.body.orderId;
  // sign in (claims each one's orders by verified email)
  const a = await signIn(CNY.aEmail);
  A.token = a.token;
  A.id = a.body.customer.id;
  eq(a.body.claimedOrders, 3, "A claimed A's orders");
  const b2 = await signIn(CNY.bEmail);
  B.token = b2.token;
  B.id = b2.body.customer.id;
  // A: a return with a canary reason, a wishlist item, a profile
  const ret = await call("account", "POST", { cookies: { _customer: A.token }, body: { action: "request_return", orderId: A.order, reason: CNY.aReturn } });
  eq(ret.status, 200, `A's return (${ret.text.slice(0, 160)})`);
  const wish = await call("account", "POST", { cookies: { _customer: A.token }, body: { action: "wishlist_merge", items: [{ handle: CNY.aWish }] } });
  eq(wish.status, 200, "A's wishlist");
  const prof = await call("account", "POST", { cookies: { _customer: A.token }, body: { action: "profile", name: CNY.aName, phone: CNY.aPhone, address: addressOf("a") } });
  eq(prof.status, 200, "A's profile");
  // B: a revoked session (signed in, then logged out) and an expired one
  B.revoked = (await signIn(CNY.bEmail)).token;
  eq((await call("account", "POST", { cookies: { _customer: B.revoked }, body: { action: "logout" } })).status, 200, "logout");
  B.expired = (await signIn(CNY.bEmail)).token;
  await q(sA, "UPDATE customer_sessions SET expires_at = ? WHERE token_hash = ?", ["2020-01-01T00:00:00.000Z", sha(`${B.expired}|${A_LINK_SECRET}|customer`)]);
  // store B: its own shopper (with A's email too: a different person there)
  const sbCart = await cartWith(HOST_B, sB);
  const sbPlaced = await checkout("cod", { host: HOST_B, cartId: sbCart, key: "cnysbkey0", contact: { email: CNY.sbEmail, phone: "9844400004", name: CNY.sbName }, address: { line1: CNY.sbLine1, city: "Pune", state: "MH", pincode: "411001" } });
  eq(sbPlaced.status, 200, `store B's order (${sbPlaced.text.slice(0, 200)})`);
  await signIn(CNY.sbEmail, { host: HOST_B, linkSecret: "cnyblinksec0", store: sB });
  A.cartCanary = A.cart;
  fixture.ok = true;
});
if (!fixture.ok) {
  console.error("fixture failed; stopping");
  process.exit(1);
}

// A's canaries: everything a non-owner must never see
const A_CANARIES = () => [CNY.aEmail, CNY.aPhone, CNY.aName, CNY.aLine1, CNY.aRzPay, CNY.aRzOrder, CNY.aCoupon, "cnyareturn0", CNY.aWish, CNY.aKey, A.order, A.rzPaid, A.rzPending, A.cart, A.id, A.token];
const SB_CANARIES = [CNY.sbEmail, CNY.sbName, CNY.sbLine1];
function leaks(text, canaries) {
  const hay = [String(text), String(text).toLowerCase(), decodeURIComponent(String(text).replace(/%(?![0-9a-f]{2})/gi, "%25"))].join("\n").toLowerCase();
  return canaries.filter((c) => c && hay.includes(String(c).toLowerCase()));
}
const noLeak = (r, label, canaries = A_CANARIES()) => {
  const l = leaks(r.text ?? r, canaries);
  ok(!l.length, `${label}: leaks ${l.join(", ")} in ${String(r.text ?? r).slice(0, 240)}`);
};

// The callers. A's cookies on store B's host is a caller too.
const CALLERS = () => ({
  anonymous: { host: HOST_A, cookies: {} },
  "B (own session)": { host: HOST_A, cookies: { _customer: B.token, [CART_COOKIE]: B.cart } },
  "B forged session": { host: HOST_A, cookies: { _customer: `ct_${"ab".repeat(32)}` } },
  "B revoked session": { host: HOST_A, cookies: { _customer: B.revoked } },
  "B expired session": { host: HOST_A, cookies: { _customer: B.expired } },
  "A's cookies on store B": { host: HOST_B, cookies: { _customer: A.token, [CART_COOKIE]: A.cart } },
});
const UNAUTHED = ["anonymous", "B forged session", "B revoked session", "B expired session", "A's cookies on store B"];

// ---------------------------------------------------------------------------
// 3. /api/account
// ---------------------------------------------------------------------------
console.log("— 2. /api/account");

await t("GET view=me|orders|wishlist: A sees A's data (positive control)", async () => {
  const me = await call("account", "GET", { cookies: { _customer: A.token }, query: "view=me" });
  ok(leaks(me.text, [CNY.aEmail, CNY.aName]).length === 2, `me: ${me.text.slice(0, 200)}`);
  const orders = await call("account", "GET", { cookies: { _customer: A.token }, query: "view=orders" });
  ok(leaks(orders.text, [A.order, A.rzPaid]).length === 2, `orders: ${orders.text.slice(0, 200)}`);
  ok(!leaks(orders.text, [B.order]).length, "A's orders hold no B order");
  const wl = await call("account", "GET", { cookies: { _customer: A.token }, query: "view=wishlist" });
  ok(wl.text.includes(CNY.aWish), `wishlist: ${wl.text.slice(0, 200)}`);
});

await t("GET view=me|orders|wishlist: every other caller gets B's own data or exactly {ok, authenticated:false}", async () => {
  for (const [who, c] of Object.entries(CALLERS())) {
    for (const view of ["me", "orders", "wishlist"]) {
      const r = await call("account", "GET", { ...c, query: `view=${view}` });
      eq(r.status, 200, `${who} ${view}`);
      noLeak(r, `${who} ${view}`);
      if (who === "A's cookies on store B") noLeak(r, `${who} ${view} (store B's shopper)`, SB_CANARIES);
      if (UNAUTHED.includes(who)) same(r.body, { ok: true, authenticated: false }, `${who} ${view}`);
    }
  }
});

await t("GET view=reorder&order=<A's>: B gets 404 with the same body as an order that does not exist", async () => {
  const theirs = await call("account", "GET", { cookies: { _customer: B.token }, query: `view=reorder&order=${A.order}` });
  const none = await call("account", "GET", { cookies: { _customer: B.token }, query: "view=reorder&order=PAV-NOPE0000" });
  same([theirs.status, theirs.text], [404, none.text], "B on A's order vs a missing order");
  const own = await call("account", "GET", { cookies: { _customer: A.token }, query: `view=reorder&order=${A.order}` });
  eq(own.status, 200, "A's own reorder");
  for (const [who, c] of Object.entries(CALLERS())) {
    const r = await call("account", "GET", { ...c, query: `view=reorder&order=${A.order}` });
    noLeak(r, `${who} reorder`);
  }
});

await t("POST request_return on A's order as B: 422 with the same text as an unknown order, no return row", async () => {
  // A's own order already has a return; use A's paid Razorpay order (eligible)
  const before = await q(sA, "SELECT COUNT(*) AS n FROM return_requests");
  const theirs = await call("account", "POST", { cookies: { _customer: B.token }, body: { action: "request_return", orderId: A.rzPaid, reason: "this is not my order at all" } });
  const none = await call("account", "POST", { cookies: { _customer: B.token }, body: { action: "request_return", orderId: "PAV-NOPE0000", reason: "this is not my order at all" } });
  same([theirs.status, theirs.text], [422, none.text], "B on A's order vs an unknown order");
  same(await q(sA, "SELECT COUNT(*) AS n FROM return_requests"), before, "no return row written");
  for (const who of UNAUTHED) {
    const r = await call("account", "POST", { ...CALLERS()[who], body: { action: "request_return", orderId: A.rzPaid, reason: "this is not my order at all" } });
    eq(r.status, 401, `${who}`);
    noLeak(r, who);
  }
});

await t("POST profile, wishlist_merge, wishlist_remove: anonymous 401; B changes only B's rows", async () => {
  for (const action of ["profile", "wishlist_merge", "wishlist_remove"]) {
    for (const who of UNAUTHED) {
      const r = await call("account", "POST", { ...CALLERS()[who], body: { action, name: "cnyevil0", items: [{ handle: "cnyevil0" }], handle: CNY.aWish } });
      eq(r.status, 401, `${who} ${action}`);
    }
  }
  const aBefore = await q(sA, "SELECT * FROM customers WHERE id = ?", [A.id]);
  const wishBefore = await q(sA, "SELECT handle FROM customer_wishlists WHERE customer_id = ?", [A.id]);
  const asB = (body) => call("account", "POST", { cookies: { _customer: B.token }, body: { customerId: A.id, ...body } });
  const p = await asB({ action: "profile", name: "cnybnew0" });
  eq(p.status, 200, "B's profile");
  noLeak(p, "B's profile answer");
  eq((await q(sA, "SELECT name FROM customers WHERE id = ?", [B.id]))[0].name, "cnybnew0", "B's own name changed");
  const m = await asB({ action: "wishlist_merge", items: [{ handle: "cnybwish0" }] });
  noLeak(m, "B's wishlist merge");
  const rm = await asB({ action: "wishlist_remove", handle: CNY.aWish });
  noLeak(rm, "B's wishlist remove");
  same(await q(sA, "SELECT * FROM customers WHERE id = ?", [A.id]), aBefore, "A's customer row unchanged");
  same(await q(sA, "SELECT handle FROM customer_wishlists WHERE customer_id = ?", [A.id]), wishBefore, "A's wishlist unchanged");
});

await t("POST verify with A's email and a wrong code: no cookie, no claimedOrders, no customer data", async () => {
  await q(sA, "INSERT INTO customer_otps (id, email, code_hash, expires_at, attempts, created_at) VALUES ('otp_wrongcode', ?, ?, ?, 0, ?)", [CNY.aEmail, sha(`111111|${A_LINK_SECRET}|customer`), new Date(Date.now() + 600000).toISOString(), new Date().toISOString()]);
  const r = await call("account", "POST", { body: { action: "verify", email: CNY.aEmail, code: "222222" } });
  eq(r.status, 422, "wrong code");
  eq(cookieFrom(r, "_customer"), null, "no _customer cookie");
  ok(!("claimedOrders" in (r.body || {})) && !("customer" in (r.body || {})), r.text);
  noLeak(r, "wrong code", A_CANARIES().filter((c) => c !== CNY.aEmail));
  await q(sA, "UPDATE customer_otps SET consumed_at = ? WHERE id = 'otp_wrongcode'", [new Date().toISOString()]);
});

// Finding 5: the over-cap answer was an oracle ("Too many codes requested")
await t("POST request_otp: the same body for an existing, an unknown and an over-cap email; over cap sends nothing", async () => {
  const capped = "cnycapped0@example.test";
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) await q(sA, "INSERT INTO customer_otps (id, email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, 'x', ?, 0, ?)", [`otp_cap${i}`, capped, new Date(Date.now() + 600000).toISOString(), now]);
  const notesBefore = (await q(sA, "SELECT COUNT(*) AS n FROM notifications"))[0].n;
  const otpsBefore = (await q(sA, "SELECT COUNT(*) AS n FROM customer_otps WHERE email = ?", [capped]))[0].n;
  const answers = [];
  for (const email of [CNY.bEmail, "cnynobody0@example.test", capped]) {
    const r = await call("account", "POST", { body: { action: "request_otp", email } });
    answers.push([r.status, r.text]);
  }
  same(answers.map((a) => a.join(" ")), Array(3).fill(answers[0].join(" ")), "the three answers");
  same(answers[0], [200, JSON.stringify({ ok: true, sent: true })], "the answer");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_otps WHERE email = ?", [capped]))[0].n, otpsBefore, "no new code for the capped email");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM notifications"))[0].n, notesBefore + 2, "two codes queued (existing and unknown), none for the capped email");
});

// Finding 4: attempts were read, then written; parallel guesses all counted as one
await t("verifyOtp: parallel wrong guesses at attempt 4 get one try between them (attempts counted atomically)", async () => {
  const email = "cnyrace0@example.test";
  await q(sA, "INSERT INTO customer_otps (id, email, code_hash, expires_at, attempts, created_at) VALUES ('otp_race', ?, ?, ?, 4, ?)", [email, sha(`333333|${A_LINK_SECRET}|customer`), new Date(Date.now() + 600000).toISOString(), new Date().toISOString()]);
  const results = await sA.run(() => Promise.all(Array.from({ length: 6 }, (_, i) => Cust.verifyOtp(email, String(100000 + i)).then(() => "ok", (e) => e.message))));
  const tried = results.filter((m) => /isn't right/.test(m)).length;
  eq(tried, 1, `guesses checked (${JSON.stringify(results)})`);
  eq((await q(sA, "SELECT attempts FROM customer_otps WHERE id = 'otp_race'"))[0].attempts, 5, "attempts");
  // the right code after the cap is refused too
  await sA.run(async () => {
    let msg = null;
    await Cust.verifyOtp(email, "333333").catch((e) => (msg = e.message));
    ok(/Too many wrong attempts/.test(msg || ""), `right code after the cap: ${msg}`);
  });
});

// ---------------------------------------------------------------------------
// 4. /api/cart
// ---------------------------------------------------------------------------
console.log("— 3. /api/cart");

await t("GET /api/cart: own cart only; a forged or another store's cookie reads the empty cart", async () => {
  const { emptyCart } = await import("../lib/cart.js");
  const empty = JSON.parse(JSON.stringify(emptyCart()));
  A.liveCart = await cartWith(HOST_A, sA, A.cart, 1); // A shops again after the first order
  const own = await call("cart", "GET", { cookies: { [CART_COOKIE]: A.cart } });
  eq(own.body.items.length, 1, "A's cart has A's item");
  for (const [who, c] of [
    ["forged cookie", { host: HOST_A, cookies: { [CART_COOKIE]: crypto.randomUUID() } }],
    ["A's cart cookie on store B", { host: HOST_B, cookies: { [CART_COOKIE]: A.cart } }],
    ["anonymous", { host: HOST_A, cookies: {} }],
  ]) {
    const r = await call("cart", "GET", c);
    same(r.body, empty, who);
  }
  const b = await call("cart", "GET", { cookies: { [CART_COOKIE]: B.cart } });
  noLeak(b, "B's cart");
});

await t("POST /api/cart: a cartId or id in the body never touches A's cart", async () => {
  const before = (await call("cart", "GET", { cookies: { [CART_COOKIE]: A.cart } })).body;
  for (const action of ["clear", "remove", "setQty", "add", "setCoupon"]) {
    const r = await call("cart", "POST", { cookies: { [CART_COOKIE]: B.cart }, body: { action, cartId: A.cart, id: A.cart, variantId: variant(sA), quantity: 5, coupon: "cnyevil0" } });
    noLeak(r, `B ${action}`);
    const anon = await call("cart", "POST", { body: { action, cartId: A.cart, id: A.cart, variantId: variant(sA), quantity: 5 } });
    noLeak(anon, `anonymous ${action}`);
  }
  same((await call("cart", "GET", { cookies: { [CART_COOKIE]: A.cart } })).body, before, "A's cart unchanged");
});

// ---------------------------------------------------------------------------
// 5. /api/checkout (finding 1)
// ---------------------------------------------------------------------------
console.log("— 4. /api/checkout");
const ORDER_FIELDS = ["orderId", "confirmationPath", "razorpayOrderId", "amount", "status"];
const noOrderFields = (r, label) => {
  for (const k of ORDER_FIELDS) ok(!(k in (r.body || {})), `${label}: has ${k}: ${r.text.slice(0, 240)}`);
  noLeak(r, label);
};

await t("cod with A's idempotency key: B (same total), anonymous, forged and other-store callers get no order fields", async () => {
  const aCartBefore = (await call("cart", "GET", { cookies: { [CART_COOKIE]: A.cart } })).body;
  const bCart = await cartWith(HOST_A, sA, B.cart, 1); // B's cart: the same total as A's order
  const callers = { ...CALLERS(), "B (own session)": { host: HOST_A, cookies: { _customer: B.token, [CART_COOKIE]: bCart } } };
  for (const [who, c] of Object.entries(callers)) {
    const r = await checkout("cod", { host: c.host, cartId: c.cookies[CART_COOKIE], customer: c.cookies._customer, key: CNY.aKey, contact: contactOf("b"), address: addressOf("b") });
    ok(r.status >= 400, `${who}: ${r.status} ${r.text.slice(0, 200)}`);
    noOrderFields(r, who);
    if (who === "B (own session)") same([r.status, r.body.code], [409, "IDEMPOTENCY_CONFLICT"], `${who}`);
  }
  same((await call("cart", "GET", { cookies: { [CART_COOKIE]: A.cart } })).body, aCartBefore, "A's cart not cleared");
  ok((await call("cart", "GET", { cookies: { [CART_COOKIE]: B.cart } })).body.items.length > 0, "B's cart not cleared either");
});

await t("razorpay_create with A's key: B, anonymous and other-store callers get no razorpayOrderId, amount or link", async () => {
  for (const [who, c] of Object.entries(CALLERS())) {
    const r = await checkout("razorpay_create", { host: c.host, cartId: c.cookies[CART_COOKIE], customer: c.cookies._customer, key: "cnyakeyrz1", contact: contactOf("b"), address: addressOf("b") });
    ok(r.status >= 400, `${who}: ${r.status} ${r.text.slice(0, 200)}`);
    noOrderFields(r, who);
  }
  eq(fetchCalls.length, 0, `no Razorpay call was made (${fetchCalls})`);
});

await t("a genuine retry from the same cart cookie returns the same order (cod, after the cart was cleared on success)", async () => {
  const cart = await cartWith(HOST_A, sA);
  const contact = contactOf("a");
  const first = await checkout("cod", { cartId: cart, key: "cnyaretry0", contact, address: addressOf("a") });
  eq(first.status, 200, `first (${first.text.slice(0, 200)})`);
  eq((await call("cart", "GET", { cookies: { [CART_COOKIE]: cart } })).body.items.length, 0, "the cart was cleared on success");
  // the response was lost; the browser resends the same intent from the same cart
  const retry = await call("checkout", "POST", { cookies: { [CART_COOKIE]: cart }, body: { action: "cod", idempotencyKey: "cnyaretry0", contact, address: addressOf("a") } });
  same([retry.status, retry.body.orderId, retry.body.deduped], [200, first.body.orderId, true], `retry (${retry.text.slice(0, 200)})`);
  ok(retry.body.confirmationPath?.startsWith(`/checkout/confirmation/${first.body.orderId}?t=2.`), "retry gets the signed link");
  // a double submit before the clear lands (cart still full) dedups too
  const cart2 = await cartWith(HOST_A, sA);
  const [x, y] = await Promise.all([
    checkout("cod", { cartId: cart2, key: "cnyaretry1", contact, address: addressOf("a") }),
    checkout("cod", { cartId: cart2, key: "cnyaretry1", contact, address: addressOf("a") }),
  ]);
  same([x.status, y.status, x.body.orderId], [200, 200, y.body.orderId], `double submit (${x.text.slice(0, 120)} | ${y.text.slice(0, 120)})`);
  eq((await q(sA, "SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = 'cnyaretry1'"))[0].n, 1, "one order");
});

await t("a genuine razorpay_create retry from the same cart reopens the same Razorpay order (no new one minted)", async () => {
  // A's paid Razorpay order came from cart A.rzCart: a retry from that cart answers alreadyPaid
  const r = await call("checkout", "POST", { cookies: { [CART_COOKIE]: A.rzCart }, body: { action: "razorpay_create", idempotencyKey: "cnyakeyrz1", contact: contactOf("a"), address: addressOf("a") } });
  same([r.status, r.body.orderId, r.body.alreadyPaid], [200, A.rzPaid, true], r.text.slice(0, 200));
  const p = await call("checkout", "POST", { cookies: { [CART_COOKIE]: "cart-a-rz-pending" }, body: { action: "razorpay_create", idempotencyKey: "cnyakeyrz2", contact: contactOf("a"), address: addressOf("a") } });
  same([p.status, p.body.orderId, p.body.razorpayOrderId, p.body.deduped], [200, A.rzPending, "order_cnyarzpend0", true], p.text.slice(0, 200));
  eq(fetchCalls.length, 0, "no Razorpay call");
});

await t("createOrder: the same key from another cart is a conflict, never the other cart's order", async () => {
  await sA.run(async () => {
    const cart = { items: [{ variantId: variant(sA), productId: sA.products[0].id, title: "F", variantTitle: "D", image: null, price: 100, quantity: 1, lineTotal: 100, discount: 0 }], gifts: [], appliedOffers: [], subtotal: 100, discountTotal: 0, total: 100, currency: "INR" };
    let err = null;
    const r = await O.createOrder({ cartId: "cart-someone-else", cart, contact: contactOf("b"), address: addressOf("b"), paymentMethod: "razorpay", idempotencyKey: "cnyakeyrz1", razorpayOrderId: "order_x" }).catch((e) => (err = e));
    ok(err?.code === "IDEMPOTENCY_CONFLICT", `got ${JSON.stringify(r)}`);
    eq(await O.findOrderByIdempotencyKey("cnyakeyrz1", A.rzCart).then((o) => o.id), A.rzPaid, "the owning cart finds it");
    let e2 = null;
    await O.findOrderByIdempotencyKey("cnyakeyrz1", "cart-someone-else").catch((e) => (e2 = e));
    eq(e2?.code, "IDEMPOTENCY_CONFLICT", "another cart");
  });
});

await t("razorpay_verify on A's order: a bad signature, or B's valid signature, gets 400 and no link", async () => {
  const sign = (rz, pay) => createHmac("sha256", RZ_KEY_SECRET).update(`${rz}|${pay}`).digest("hex");
  const bad = await call("checkout", "POST", { cookies: { _customer: B.token, [CART_COOKIE]: B.cart }, body: { action: "razorpay_verify", orderId: A.rzPending, razorpay_order_id: "order_cnyarzpend0", razorpay_payment_id: "pay_x", razorpay_signature: "0".repeat(64) } });
  eq(bad.status, 400, "bad signature");
  noOrderFields(bad, "bad signature");
  const bSigned = await call("checkout", "POST", { cookies: { _customer: B.token, [CART_COOKIE]: B.cart }, body: { action: "razorpay_verify", orderId: A.rzPending, razorpay_order_id: "order_cnybrz0", razorpay_payment_id: "pay_cnyb0", razorpay_signature: sign("order_cnybrz0", "pay_cnyb0") } });
  eq(bSigned.status, 400, `B's signature on A's order (${bSigned.text})`);
  noOrderFields(bSigned, "B's signature");
  eq((await q(sA, "SELECT status FROM orders WHERE id = ?", [A.rzPending]))[0].status, "pending_payment", "A's order unpaid");
});

// Finding 3: the catch-all returned the raw error text
await t("a checkout failure answers with shopper text, never the raw error (the code is kept)", async () => {
  const cart = await cartWith(HOST_A, sA);
  // Razorpay refuses the order: its raw answer must not reach the shopper.
  // Nothing leaves the process: this fetch answers locally and records the call.
  const blocked = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ error: { description: "cnyrzpraw0 Authentication failed" } }), { status: 401 });
  };
  let r;
  try {
    r = await checkout("razorpay_create", { cartId: cart, key: "cnyaraw0", contact: contactOf("a"), address: addressOf("a") });
  } finally {
    globalThis.fetch = blocked;
  }
  same(asked, ["https://api.razorpay.com/v1/orders"], "the one (local) Razorpay call");
  eq(r.status, 400, r.text);
  ok(!/cnyrzpraw0|Razorpay order create failed|Authentication/i.test(r.text), `raw text: ${r.text}`);
  eq(r.body.error, "Could not continue — your cart is untouched, please retry.", "the message");
  const src = await readFile(join(ROOT, "app/api/checkout/route.js"), "utf8");
  ok(!/NextResponse\.json\(\s*\{\s*error:\s*String\(e/.test(src), "no raw e.message in a response");
});

// ---------------------------------------------------------------------------
// 6. Order links and secrets (finding 2)
// ---------------------------------------------------------------------------
console.log("— 5. order links and secrets");
const hmac20 = (msg, secret) => createHmac("sha256", secret).update(msg).digest("hex").slice(0, 20);
const v2 = (id, secret, exp = Math.floor(Date.now() / 1000) + 3600) => `2.${exp}.${hmac20(`${id}|${exp}`, secret)}`;

await t("order links: valid works; tampered, expired, another order's, store B's, missing and post-cutoff v1 tokens fail", async () => {
  const good = await sA.run(() => O.orderStatusToken(A.order));
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, good)), true, "valid");
  const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, tampered)), false, "tampered");
  const expired = await sA.run(() => O.orderStatusToken(A.order, { now: Date.now() - 31 * 86400000 }));
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, expired)), false, "expired");
  eq(await sA.run(() => O.verifyOrderStatusToken(A.rzPaid, good)), false, "A's token on another order");
  const byB = await sB.run(() => O.orderStatusToken(A.order));
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, byB)), false, "signed by store B");
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, undefined)), false, "missing");
  const legacy = sha(`${A.order}|${A_LINK_SECRET}`).slice(0, 20);
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, legacy, { now: Date.parse("2027-01-30T00:00:00Z") })), true, "v1 before the cutoff");
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, legacy, { now: Date.parse("2027-01-31T00:00:01Z") })), false, "v1 after the cutoff");
});

await t("production, no tenant secret: a link forged with \"dev-only-secret\" fails and minting throws", async () => {
  const cOrder = "SHO-CNYC0000";
  await q(sC, "INSERT INTO orders (id, idempotency_key, email, total, currency, status, payment_method, payment_status, created_at, updated_at) VALUES (?, 'cnyckey0', 'cnycmail0@example.test', 100, 'INR', 'cod_pending', 'cod', 'cod', ?, ?)", [cOrder, new Date().toISOString(), new Date().toISOString()]);
  process.env.NODE_ENV = "production";
  eq(await sC.run(() => O.verifyOrderStatusToken(cOrder, v2(cOrder, "dev-only-secret"))), false, "forged with the public fallback");
  let threw = null;
  await sC.run(() => O.orderStatusToken(cOrder)).catch((e) => (threw = e));
  ok(threw, "minting a link without a secret throws in production");
  // the customer hashes too: a session hashed with the public fallback is no session
  const token = "ct_cnycforged0";
  await q(sC, "INSERT INTO customers (id, email, created_at) VALUES ('cus_cnyc0', 'cnycmail0@example.test', ?)", [new Date().toISOString()]);
  await q(sC, "INSERT INTO customer_sessions (token_hash, customer_id, created_at, expires_at) VALUES (?, 'cus_cnyc0', ?, ?)", [sha(`${token}|dev-only-secret|customer`), new Date().toISOString(), new Date(Date.now() + 86400000).toISOString()]);
  eq(await sC.run(() => Cust.customerFromToken(token)), null, "a session hashed with the public fallback");
  let otp = null;
  await sC.run(() => Cust.requestOtp("cnycmail0@example.test")).catch((e) => (otp = e));
  ok(otp, "no sign-in code is minted without a secret in production");
  // outside production the dev fallback still works (local harness)
  process.env.NODE_ENV = "development";
  const dev = await sC.run(() => O.orderStatusToken(cOrder));
  eq(await sC.run(() => O.verifyOrderStatusToken(cOrder, dev)), true, "dev fallback outside production");
  // a store with its own secret is unaffected in production
  process.env.NODE_ENV = "production";
  const tok = await sA.run(() => O.orderStatusToken(A.order));
  eq(await sA.run(() => O.verifyOrderStatusToken(A.order, tok)), true, "store A in production");
});

await t("production, no store secret: checkout refuses with CHECKOUT_DISABLED before any order, cart clear or job", async () => {
  const HOST_C = sC.tenant.domains[0];
  const cart = await cartWith(HOST_C, sC);
  const { createClient } = await import("@libsql/client");
  const pc = createClient({ url: platform.url });
  const jobs = async () => Number((await pc.execute("SELECT COUNT(*) AS n FROM jobs")).rows[0].n);
  const orders = async () => Number((await q(sC, "SELECT COUNT(*) AS n FROM orders"))[0].n);
  const cartBefore = (await call("cart", "GET", { host: HOST_C, cookies: { [CART_COOKIE]: cart } })).body;
  const [o0, j0, a0] = [await orders(), await jobs(), (globalThis.__afterQueue || []).length];
  process.env.NODE_ENV = "production";
  try {
    for (const action of ["cod", "razorpay_create"]) {
      const r = await checkout(action, { host: HOST_C, cartId: cart, key: `cnyckey-${action}`, contact: contactOf("a"), address: addressOf("a") });
      same([r.status, r.body?.code], [503, "CHECKOUT_DISABLED"], `${action} (${r.text.slice(0, 200)})`);
      ok(!/secret|link/i.test(r.body.error), `${action}: plain words (${r.body.error})`);
      noOrderFields(r, action);
    }
    same([await orders(), await jobs(), (globalThis.__afterQueue || []).length], [o0, j0, a0], "[orders, jobs, after() work] unchanged");
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    same((await call("cart", "GET", { host: HOST_C, cookies: { [CART_COOKIE]: cart } })).body, cartBefore, "cart untouched");
    // request_otp: the capped and uncapped answers are the same here too
    process.env.NODE_ENV = "production";
    const capped = "cnyccapped0@example.test";
    for (let i = 0; i < 3; i++) await q(sC, "INSERT INTO customer_otps (id, email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, 'x', ?, 0, ?)", [`otp_ccap${i}`, capped, new Date(Date.now() + 600000).toISOString(), new Date().toISOString()]);
    const answers = [];
    for (const email of [capped, "cnycfree0@example.test"]) {
      const r = await call("account", "POST", { host: HOST_C, body: { action: "request_otp", email } });
      answers.push(`${r.status} ${r.text}`);
    }
    eq(answers[0], answers[1], "capped vs uncapped");
  } finally {
    pc.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Pages
// ---------------------------------------------------------------------------
console.log("— 6. shopper pages (page harness)");
pageStore = sA;
const SF = (p) => `app/(storefront)/${p}/page.js`;
async function page(rel, { store = sA, cookies = {}, params = {}, searchParams = {} } = {}) {
  pageStore = store;
  const r = await P.run(SF(rel), { cookies, params, searchParams });
  ok(!r.unresolved.length, `${rel}: ${r.unresolved.join("; ")}`);
  ok(!r.error, `${rel}: ${r.error?.stack?.split("\n").slice(0, 3).join(" | ")}`);
  return r;
}
const pageCallers = () =>
  Object.entries(CALLERS()).map(([who, c]) => [who, { store: c.host === HOST_B ? sB : sA, cookies: c.cookies }]);

await t("/account: A sees A's orders; every other caller sees none of A's data", async () => {
  const own = await page("account", { cookies: { _customer: A.token } });
  ok(leaks(own.text, [CNY.aEmail, A.order]).length === 2, `A: ${own.text.slice(0, 300)}`);
  for (const [who, c] of pageCallers()) noLeak(await page("account", c), `/account ${who}`);
});

await t("/account/orders/[orderId]: A sees it; B gets notFound; anonymous is redirected to sign in", async () => {
  const own = await page("account/orders/[orderId]", { cookies: { _customer: A.token }, params: { orderId: A.order } });
  ok(!own.notFound && own.text.includes(A.order), `A: ${own.text.slice(0, 300)}`);
  const b = await page("account/orders/[orderId]", { cookies: { _customer: B.token }, params: { orderId: A.order } });
  ok(b.notFound, "B notFound");
  const anon = await page("account/orders/[orderId]", { params: { orderId: A.order } });
  ok(anon.redirect && anon.redirect.startsWith("/account"), `anonymous: ${anon.redirect}`);
  for (const [who, c] of pageCallers()) noLeak(await page("account/orders/[orderId]", { ...c, params: { orderId: A.order } }), who);
});

for (const rel of ["orders/[orderId]", "checkout/confirmation/[orderId]"]) {
  await t(`/${rel}: the valid link works; tampered, expired, other order's, store B's, forged and missing links are notFound`, async () => {
    const good = await sA.run(() => O.orderStatusToken(A.order));
    const own = await page(rel, { params: { orderId: A.order }, searchParams: { t: good } });
    ok(!own.notFound && own.text.includes(A.order), `valid link: ${own.text.slice(0, 300)}`);
    const exp = Math.floor(Date.now() / 1000) - 60;
    const cases = {
      tampered: good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"),
      expired: `2.${exp}.${hmac20(`${A.order}|${exp}`, A_LINK_SECRET)}`,
      "another order's": await sA.run(() => O.orderStatusToken(A.rzPaid)),
      "store B's": await sB.run(() => O.orderStatusToken(A.order)),
      "forged with dev-only-secret": v2(A.order, "dev-only-secret"),
      missing: undefined,
    };
    for (const [label, tok] of Object.entries(cases)) {
      const r = await page(rel, { params: { orderId: A.order }, searchParams: tok ? { t: tok } : {} });
      ok(r.notFound, `${label}: not notFound`);
      noLeak(r.text, label);
    }
    // A's valid link on store B's host
    const other = await page(rel, { store: sB, params: { orderId: A.order }, searchParams: { t: good } });
    ok(other.notFound, "A's link on store B");
  });
}

await t("/checkout and the storefront layout's initialCart: A sees A's cart; every other caller none of A's data", async () => {
  const layout = async (c) => {
    pageStore = c.store ?? sA;
    const r = await P.run("app/(storefront)/layout.js", { cookies: c.cookies ?? {} });
    ok(!r.unresolved.length, `layout: ${r.unresolved.join("; ")}`);
    ok(!r.error, `layout: ${r.error?.stack?.split("\n").slice(0, 3).join(" | ")}`);
    const provider = r.props.find((p) => /CartProvider/.test(p.component));
    ok(provider, `layout: no CartProvider (${r.props.map((p) => p.component).slice(0, 12).join(", ")})`);
    return { ...r, cart: provider.props.initialCart };
  };
  const ownPage = await page("checkout", { cookies: { [CART_COOKIE]: A.cart } });
  ok(ownPage.text.includes(A.cart), `A's checkout holds A's cart: ${ownPage.text.slice(0, 300)}`);
  const ownLayout = await layout({ cookies: { [CART_COOKIE]: A.cart } });
  eq(ownLayout.cart.id, A.cart, "A's layout cart");
  ok(ownLayout.cart.items.length > 0, "A's layout cart has A's items");
  const callers = [...pageCallers(), ["forged cart cookie", { store: sA, cookies: { [CART_COOKIE]: crypto.randomUUID() } }]];
  for (const [who, c] of callers) {
    noLeak(await page("checkout", c), `/checkout ${who}`);
    const l = await layout(c);
    noLeak(l, `layout ${who}`);
    noLeak(JSON.stringify(l.cart), `layout initialCart ${who}`);
    if (who !== "B (own session)") eq(l.cart.items.length, 0, `layout initialCart ${who} is empty`);
  }
});

// ---------------------------------------------------------------------------
// 8. Public reads
// ---------------------------------------------------------------------------
console.log("— 7. public reads, anonymous, with A's canaries in the database");

await t("search, upsell, wishlist and media answer anonymous callers with none of A's data", async () => {
  const probes = [
    ["search", "GET", { query: `q=${encodeURIComponent(CNY.aName)}` }],
    ["search", "GET", { query: "q=fixture" }],
    ["upsell", "GET", { query: "exclude=" }],
    ["wishlist", "POST", { body: { items: [{ handle: "fixture-product-1" }, { handle: "fixture-product-2" }] } }],
    ["media/[id]", "GET", { params: { id: "med_000000000000000000" } }],
  ];
  for (const [name, method, opts] of probes) {
    for (const host of [HOST_A, HOST_B]) {
      const r = await call(name, method, { host, ...opts });
      ok(r.status < 500, `${name} ${host}: ${r.status} ${r.text.slice(0, 160)}`);
      noLeak(r, `${name} ${host}`, A_CANARIES().filter((c) => c !== CNY.aName || name !== "search"));
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Job routes and /api/health (Phase 0 audit, gaps A and B)
// ---------------------------------------------------------------------------
console.log("— 8. job routes and health, anonymous");

const JOBS = {
  "health": await import("../app/api/health/route.js"),
  "jobs/tick": await import("../app/api/jobs/tick/route.js"),
  "jobs/forward-events": await import("../app/api/jobs/forward-events/route.js"),
  "jobs/sync-catalog": await import("../app/api/jobs/sync-catalog/route.js"),
  "jobs/sync-shopify": await import("../app/api/jobs/sync-shopify/route.js"),
  "connect/shopify/start": await import("../app/api/connect/shopify/start/route.js"),
};
async function job(name, method, { host = HOST_A, query = "", auth = null } = {}) {
  const headers = { host };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers.origin = `http://${host}`;
  }
  const req = new NextRequest(`http://${host}/api/${name}${query ? `?${query}` : ""}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify({ orderId: "ord_missing", tenant: sA.tenant.id }) });
  const res = await JOBS[name][method](req, { params: Promise.resolve({}) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text };
}

await t("production, no CRON_SECRET: every job route, the health rollup and the Shopify connect start answer anonymous 401 (gap B)", async () => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "";
  process.env.NODE_ENV = "production";
  try {
    const bad = [];
    for (const [name, mod] of Object.entries(JOBS)) {
      for (const method of ["GET", "POST"].filter((m) => typeof mod[m] === "function")) {
        const query = name === "health" ? "all=1" : name === "connect/shopify/start" ? `tenant=${sA.tenant.id}` : "";
        const r = await job(name, method, { query });
        if (r.status !== 401) bad.push(`${method} /api/${name}${query ? `?${query}` : ""} → ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    eq(bad.join("\n"), "", "open job routes");
  } finally {
    process.env.CRON_SECRET = saved ?? "";
  }
});

await t("anonymous /api/health gets only {status, at}: no queue depths, error counts or integration flags (gap A); the job secret gets the full body", async () => {
  const saved = process.env.CRON_SECRET;
  try {
    for (const env of ["production", "development"]) {
      process.env.NODE_ENV = env;
      process.env.CRON_SECRET = "cnycronsec0";
      const anon = await job("health", "GET");
      ok(anon.status === 200 || anon.status === 503, `${env} anonymous status ${anon.status}`);
      same(Object.keys(anon.body ?? {}).sort(), ["at", "status"], `${env} anonymous keys`);
      const wrong = await job("health", "GET", { auth: "nope" });
      same(Object.keys(wrong.body ?? {}).sort(), ["at", "status"], `${env} wrong secret keys`);
      const full = await job("health", "GET", { auth: "cnycronsec0" });
      ok(full.body?.checks && full.body?.configured, `${env} the job secret gets checks and configured`);
    }
    // production with no secret at all: still only the status
    process.env.NODE_ENV = "production";
    process.env.CRON_SECRET = "";
    same(Object.keys((await job("health", "GET")).body ?? {}).sort(), ["at", "status"], "production, no secret");
    // local development with no secret keeps the full body (the harness reads it)
    process.env.NODE_ENV = "development";
    ok((await job("health", "GET")).body?.checks, "development, no secret: full body");
  } finally {
    process.env.CRON_SECRET = saved ?? "";
  }
});

await t("no network: nothing reached fetch()", async () => {
  eq(fetchCalls.length, 0, `fetch calls: ${fetchCalls.join(", ")}`);
});

await platform.cleanup();
for (const s of [sA, sB, sC]) await s.cleanup();
await F.removeFixtureFiles("shop");
const { rm } = await import("node:fs/promises");
for (const f of await readdir(ROOT)) if (f.startsWith(".test-shop-default.db")) await rm(join(ROOT, f), { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
