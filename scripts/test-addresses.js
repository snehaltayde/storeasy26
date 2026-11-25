// Saved addresses suite (Phase 8 line 3, docs/plans/phase-8.md "Line 3").
//   1. 0037 on a fresh database, and on one with customers.default_address
//      rows (copied once into a default row; bad or empty JSON is skipped).
//   2. /api/account as anonymous (401, no data), shopper A (owner) and shopper
//      B holding A's ids (404, the same body as a missing id; A's row unchanged).
//   3. The rules: at most 10, one default at a time, the checkout's validation,
//      a label of 30 or fewer, no duplicates, a real delete that leaves the
//      order's own copy, write limits, last_used_at on an order.
//   4. redactCustomer deletes the addresses.
//   5. No admin, operator or app route reaches an address reader (the route
//      tables, by import graph); the new copy passes the banned-copy scan.
// Every database is a throwaway file; outside services are blanked.
//   pnpm test:addresses
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
H.blockNetwork();
process.env.DATABASE_URL = "file:.test-adr-default.db";
process.env.TURSO_DB_URL = "";
process.env.PLATFORM_SECRET = "test-platform-secret";

let pass = 0;
let fail = 0;
const realLog = console.log;
const realErr = console.error;
async function t(name, fn) {
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
    console.log = realLog;
    console.error = realErr;
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    console.log = realLog;
    console.error = realErr;
    fail++;
    console.error(`✗ ${name}\n    ${e?.stack?.split("\n").slice(0, 3).join("\n    ") || e}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg);
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const same = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);

const F = await import("./support/tenant-fixture.js");
await F.makePlatform({ name: "adr" });
const LINK = "adr-link-secret";
const sA = await F.makeTenant({ name: "adr-a", products: 1, secrets: { order_link_secret: LINK } });
const sOld = await F.makeTenant({ name: "adr-old", stage: "0034", secrets: { order_link_secret: LINK } });
const sFresh = await F.makeTenant({ name: "adr-fresh", stage: "latest" });
for (const s of [sA, sOld, sFresh]) F.assertLocalDbUrl(s.tenant.dbUrl);
const HOST = sA.tenant.domains[0];

const q = async (s, sql, args = []) => {
  const c = s.client();
  try {
    return (await c.execute({ sql, args })).rows;
  } finally {
    c.close();
  }
};

// ---------------------------------------------------------------------------
// 1. Migration 0037
// ---------------------------------------------------------------------------
console.log("— 1. migration 0037");
const MIGRATION = await readFile(join(ROOT, "migrations/tenant/0037_customer_addresses.sql"), "utf8");

await t("0037 on a fresh database: customer_addresses with the plan's columns and index, and no rows", async () => {
  const cols = (await q(sFresh, "PRAGMA table_info(customer_addresses)")).map((r) => r.name);
  same(cols, ["id", "customer_id", "label", "name", "phone", "line1", "line2", "city", "state", "pincode", "country_code", "is_default", "last_used_at", "created_at", "updated_at", "address_key"], "columns");
  const idx = await q(sFresh, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customer_addresses'");
  ok(idx.some((r) => r.name === "idx_customer_addresses_customer"), "index");
  ok(idx.some((r) => r.name === "idx_customer_addresses_key"), "unique key index");
  eq((await q(sFresh, "SELECT COUNT(*) AS n FROM customer_addresses"))[0].n, 0, "rows");
  const ledger = await q(sFresh, "SELECT id FROM schema_migrations WHERE id = '0037_customer_addresses'");
  eq(ledger.length, 1, "0037 in the ledger");
});

await t("0037 on a store with default_address: each valid one becomes one default row; bad, empty or line-less JSON is skipped; a rerun copies nothing", async () => {
  const now = "2026-01-02T03:04:05.000Z";
  const rows = [
    ["cus_full", "full@x.test", "Full Name", "9000000001", JSON.stringify({ line1: "1 Full St", line2: "Flat 9", city: "Pune", state: "MH", pincode: "411001", country: "India" })],
    ["cus_named", "named@x.test", "Profile Name", "9000000002", JSON.stringify({ name: "Address Name", phone: "9000000099", line1: "2 Named St", line2: "", city: "Mumbai", state: "MH", pincode: "400001" })],
    ["cus_bad", "bad@x.test", "Bad", null, "{not json"],
    ["cus_none", "none@x.test", "None", null, null],
    ["cus_noline", "noline@x.test", "No Line", null, JSON.stringify({ city: "Pune", state: "MH", pincode: "411001" })],
    // review fix 1: incomplete ones are skipped, not a NOT NULL failure
    ["cus_nocity", "nocity@x.test", "No City", null, JSON.stringify({ line1: "1 St", pincode: "411001" })],
    ["cus_nostate", "nostate@x.test", "No State", null, JSON.stringify({ line1: "1 St", city: "Pune", state: "", pincode: "411001" })],
    ["cus_nopin", "nopin@x.test", "No Pin", null, JSON.stringify({ line1: "1 St", city: "Pune", state: "MH" })],
  ];
  for (const [id, email, name, phone, addr] of rows) {
    await q(sOld, "INSERT INTO customers (id, email, name, phone, default_address, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, email, name, phone, addr, now, now]);
  }
  ok(!(await q(sOld, "SELECT name FROM sqlite_master WHERE name = 'customer_addresses'")).length, "no table before 0037");
  await sOld.migrateTo("latest");
  const got = await q(sOld, "SELECT * FROM customer_addresses ORDER BY customer_id");
  same(got.map((r) => r.customer_id), ["cus_full", "cus_named"], "only the valid ones");
  const full = got.find((r) => r.customer_id === "cus_full");
  same([full.name, full.phone, full.line1, full.line2, full.city, full.state, full.pincode, full.country_code, full.is_default, full.created_at, full.updated_at, full.last_used_at, full.label], ["Full Name", "9000000001", "1 Full St", "Flat 9", "Pune", "MH", "411001", "IN", 1, now, now, null, null], "the copy falls back to the account's name and phone");
  const named = got.find((r) => r.customer_id === "cus_named");
  same([named.name, named.phone, named.line1], ["Address Name", "9000000099", "2 Named St"], "the address's own name and phone win");
  ok(/^adr_[0-9a-f]{16}$/.test(full.id), `prefixed id: ${full.id}`);
  eq((await q(sOld, "SELECT id FROM schema_migrations WHERE id = '0037_customer_addresses'")).length, 1, "0037 recorded");
  const { addressKey } = await import("../lib/addresses.js");
  eq(full.address_key, addressKey({ ...full, country_code: "IN" }), "the copy's key is the one saves build");
  const c = sOld.client();
  await c.executeMultiple(MIGRATION);
  c.close();
  eq((await q(sOld, "SELECT COUNT(*) AS n FROM customer_addresses"))[0].n, 2, "a rerun copies nothing");
  // the old column stays, and the shopper reads the copied row
  ok((await q(sOld, "PRAGMA table_info(customers)")).some((r) => r.name === "default_address"), "default_address stays");
  const { listAddresses } = await import("../lib/addresses.js");
  const list = await sOld.run(() => listAddresses("cus_full"));
  same(list.map((a) => [a.line1, a.is_default]), [["1 Full St", true]], "listAddresses reads it");
});

// ---------------------------------------------------------------------------
// 2. /api/account
// ---------------------------------------------------------------------------
console.log("— 2. /api/account");
const { NextRequest } = await import("./support/next-server-stub.js");
const account = await import("../app/api/account/route.js");
const O = await import("../lib/orders.js");
const Adr = await import("../lib/addresses.js");
let ip = 1;
const nextIp = () => `10.0.0.${ip++}`;
let IP = nextIp();

async function call(method, { cookies = {}, body, query = "", xff = IP } = {}) {
  const headers = { host: HOST, "x-forwarded-for": xff };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers.origin = `http://${HOST}`;
  }
  const jar = Object.entries(cookies).filter(([, v]) => v != null);
  if (jar.length) headers.cookie = jar.map(([k, v]) => `${k}=${v}`).join("; ");
  const req = new NextRequest(`http://${HOST}/api/account${query ? `?${query}` : ""}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const res = await account[method](req, { params: Promise.resolve({}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text, setCookie: res.headers.getSetCookie() };
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function signIn(email) {
  await q(sA, "INSERT INTO customer_otps (id, email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)", [`otp_${Math.random().toString(16).slice(2)}`, email, sha(`424242|${LINK}|customer`), new Date(Date.now() + 600000).toISOString(), new Date(Date.now() - 1000).toISOString()]);
  const r = await call("POST", { body: { action: "verify", email, code: "424242" } });
  eq(r.status, 200, `verify ${email}`);
  return { token: r.setCookie.map((c) => c.match(/^_customer=([^;]*)/)?.[1]).find(Boolean), id: r.body.customer.id };
}

const A = await signIn("adra@shopper.test");
const B = await signIn("adrb@shopper.test");
const asA = { cookies: { _customer: A.token } };
const asB = { cookies: { _customer: B.token } };
const HOME = { label: "Home", name: "Asha A", phone: "9811100001", line1: "cnyadrline1", line2: "Flat 1", city: "Pune", state: "Maharashtra", pincode: "411001" };
const WORK = { label: "Work", name: "Asha A", phone: "9811100001", line1: "cnyadrline2", line2: "", city: "Mumbai", state: "Maharashtra", pincode: "400001" };
const rowOf = async (id) => (await q(sA, "SELECT * FROM customer_addresses WHERE id = ?", [id]))[0] ?? null;

await t("anonymous: GET view=addresses and every address action answer 401 with no data", async () => {
  const forged = { _customer: `ct_${"ab".repeat(32)}` };
  for (const cookies of [{}, forged]) {
    const g = await call("GET", { cookies, query: "view=addresses" });
    same([g.status, g.body], [401, { error: "sign in first" }], "GET");
    for (const action of ["address_save", "address_delete", "address_default"]) {
      const r = await call("POST", { cookies, body: { action, id: "adr_x", address: HOME } });
      same([r.status, r.body], [401, { error: "sign in first" }], action);
    }
  }
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses"))[0].n, 0, "nothing written");
});

await t("A saves two: the first is the default, the list is default first; the profile keeps name and phone only", async () => {
  const one = await call("POST", { ...asA, body: { action: "address_save", address: HOME } });
  eq(one.status, 200, `save 1 ${one.text.slice(0, 160)}`);
  ok(one.body.created && one.body.address.is_default && /^adr_/.test(one.body.address.id), "first is default");
  A.home = one.body.address.id;
  const two = await call("POST", { ...asA, body: { action: "address_save", address: WORK } });
  A.work = two.body.address.id;
  ok(!two.body.address.is_default, "second is not");
  const list = await call("GET", { ...asA, query: "view=addresses" });
  same(list.body.addresses.map((a) => a.id), [A.home, A.work], "default first");
  eq(list.body.email, "adra@shopper.test", "the shopper's own email");
  const me = await call("GET", { ...asA, query: "view=me" });
  same(Object.keys(me.body.customer).sort(), ["email", "id", "name", "phone"], "no address on the profile");
  const prof = await call("POST", { ...asA, body: { action: "profile", name: "Asha", phone: "9811100001", address: HOME } });
  eq(prof.status, 200, "profile");
  eq((await q(sA, "SELECT default_address FROM customers WHERE id = ?", [A.id]))[0].default_address, null, "profile no longer writes default_address");
});

await t("one default at a time: address_default moves it, the list follows", async () => {
  const r = await call("POST", { ...asA, body: { action: "address_default", id: A.work } });
  eq(r.status, 200, "default");
  same(r.body.addresses.map((a) => [a.id, a.is_default]), [[A.work, true], [A.home, false]], "list");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ? AND is_default = 1", [A.id]))[0].n, 1, "one default");
  const back = await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, id: A.home }, makeDefault: true } });
  eq(back.status, 200, "edit with makeDefault");
  const rows = await q(sA, "SELECT id FROM customer_addresses WHERE customer_id = ? AND is_default = 1", [A.id]);
  same(rows.map((x) => x.id), [A.home], "home is the default again");
});

await t("B with A's address id: 404 for edit, delete and default, the same body as a missing id; A's row unchanged; B's list is empty", async () => {
  const before = await rowOf(A.home);
  for (const [action, extra] of [["address_save", (id) => ({ address: { ...WORK, line1: "cnybtakeover", id } })], ["address_delete", (id) => ({ id })], ["address_default", (id) => ({ id })]]) {
    const theirs = await call("POST", { ...asB, body: { action, ...extra(A.home) } });
    const none = await call("POST", { ...asB, body: { action, ...extra("adr_0000000000000000") } });
    same([theirs.status, theirs.text], [404, none.text], `${action}: A's id vs a missing one`);
    eq(theirs.status, 404, action);
  }
  same(await rowOf(A.home), before, "A's row unchanged");
  const list = await call("GET", { ...asB, query: "view=addresses" });
  same(list.body.addresses, [], "B sees none of A's");
  ok(!list.text.includes("cnyadrline"), "no canary");
  // the library itself: every single-row query is scoped to the shopper
  ok(!(await sA.run(() => Adr.deleteAddress(B.id, A.home))), "deleteAddress as B");
  ok(!(await sA.run(() => Adr.setDefaultAddress(B.id, A.home))), "setDefaultAddress as B");
  eq(await sA.run(() => Adr.saveAddress(B.id, { ...WORK, id: A.home })), null, "saveAddress as B");
  same(await rowOf(A.home), before, "still unchanged");
});

await t("validation: the checkout's required fields, a phone of 7+, a label of 30 or fewer; nothing written on a refusal", async () => {
  const before = (await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses"))[0].n;
  for (const [why, patch] of [["no city", { city: "" }], ["no state", { state: " " }], ["no name", { name: "" }], ["no pincode", { pincode: "" }], ["short phone", { phone: "12345" }], ["long label", { label: "x".repeat(31) }]]) {
    const r = await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, line1: `new ${why}`, ...patch } } });
    eq(r.status, 422, why);
    ok(typeof r.body.error === "string" && !/address_|sql|undefined/i.test(r.body.error), `${why}: ${r.body.error}`);
  }
  const lbl = await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, line1: "label thirty", label: "y".repeat(30) } } });
  eq(lbl.status, 200, "a 30-character label is fine");
  await call("POST", { ...asA, body: { action: "address_delete", id: lbl.body.address.id } });
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses"))[0].n, before, "count unchanged");
});

await t("an identical address is not saved twice (case and spacing ignored); the label doesn't make it different", async () => {
  const r = await call("POST", { ...asA, body: { action: "address_save", address: { ...WORK, label: "Office", line1: "  CNYADRLINE2 ", city: "mumbai" } } });
  eq(r.status, 200, "save");
  ok(r.body.duplicate && !r.body.created && r.body.address.id === A.work, JSON.stringify(r.body).slice(0, 200));
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?", [A.id]))[0].n, 2, "still two");
});

await t("parallel saves: 12 different addresses at once leave 10 rows and one default; 3 identical at once leave one", async () => {
  const C = await signIn("adrrace@shopper.test");
  const base = { name: "Race", phone: "9811100009", city: "Pune", state: "MH", pincode: "411001" };
  const r = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => sA.run(() => Adr.saveAddress(C.id, { ...base, line1: `race ${i}` }))));
  eq(r.filter((x) => x.status === "fulfilled").length, 10, "ten saved");
  ok(r.filter((x) => x.status === "rejected").every((x) => /up to 10/.test(x.reason?.message)), "the rest are refused with the cap's reason");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?", [C.id]))[0].n, 10, "rows");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ? AND is_default = 1", [C.id]))[0].n, 1, "one default");
  await q(sA, "DELETE FROM customer_addresses WHERE customer_id = ?", [C.id]);
  const ident = await Promise.allSettled(Array.from({ length: 3 }, () => sA.run(() => Adr.saveAddress(C.id, { ...base, line1: "same" }))));
  ok(ident.every((x) => x.status === "fulfilled"), "all answer");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?", [C.id]))[0].n, 1, "one row");
  eq(new Set(ident.map((x) => x.value.address.id)).size, 1, "every answer is that row");
  // a parallel delete of the default and the other never leaves none-default rows
  const two = await sA.run(() => Adr.saveAddress(C.id, { ...base, line1: "other" }));
  const three = await sA.run(() => Adr.saveAddress(C.id, { ...base, line1: "third" }));
  const def = (await q(sA, "SELECT id FROM customer_addresses WHERE customer_id = ? AND is_default = 1", [C.id]))[0].id;
  await Promise.all([sA.run(() => Adr.deleteAddress(C.id, def)), sA.run(() => Adr.deleteAddress(C.id, two.address.id))]);
  {
    const left = await q(sA, "SELECT id, is_default FROM customer_addresses WHERE customer_id = ?", [C.id]);
    same(left.map((x) => [x.id, x.is_default]), [[three.address.id, 1]], "the one left is the default");
  }
  await q(sA, "DELETE FROM customer_addresses WHERE customer_id = ?", [C.id]);
});

await t("an edit into an address already saved is refused (422) and changes nothing", async () => {
  const before = await rowOf(A.work);
  const r = await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, id: A.work, label: "Copy" } } });
  eq(r.status, 422, "edit into home");
  eq(r.body.error, "You already have this address saved.", "message");
  same(await rowOf(A.work), before, "unchanged");
});

await t("at most 10: the 11th is refused with a reason, and nothing is written", async () => {
  IP = nextIp();
  for (let i = 3; i <= 10; i++) {
    const r = await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, label: "", line1: `extra ${i}` } } });
    eq(r.status, 200, `address ${i}`);
  }
  const eleventh = await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, line1: "extra 11" } } });
  eq(eleventh.status, 422, "11th");
  ok(/up to 10/.test(eleventh.body.error), eleventh.body.error);
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?", [A.id]))[0].n, 10, "ten");
  // an edit at the cap still works
  const edit = await call("POST", { ...asA, body: { action: "address_save", address: { ...WORK, id: A.work, label: "Desk" } } });
  eq(edit.status, 200, "edit at the cap");
  for (const a of (await call("GET", { ...asA, query: "view=addresses" })).body.addresses.filter((x) => /^extra/.test(x.line1))) {
    eq((await call("POST", { ...asA, body: { action: "address_delete", id: a.id } })).status, 200, "clean up");
  }
});

await t("write limits: the 31st address write from one client in 10 minutes gets 429 and changes nothing", async () => {
  delete process.env.RATE_LIMIT_DISABLED; // the harness turns limits off; this test needs them
  IP = nextIp();
  for (let i = 0; i < 30; i++) {
    const r = await call("POST", { ...asA, body: { action: "address_default", id: A.home } });
    eq(r.status, 200, `write ${i + 1}`);
  }
  const over = await call("POST", { ...asA, body: { action: "address_delete", id: A.work } });
  eq(over.status, 429, "31st");
  ok(await rowOf(A.work), "not deleted");
  process.env.RATE_LIMIT_DISABLED = "1";
  IP = nextIp();
});

let orderId;
await t("last_used_at on an order: the signed-in shopper's matching address only; signed out or outside a request, nothing; the list puts it after the default", async () => {
  const cart = { items: [{ variantId: "gid://v/1", productId: "gid://p/1", title: "Thing", variantTitle: "Default", image: null, price: 100, quantity: 1, lineTotal: 100, discount: 0 }], gifts: [], appliedOffers: [], subtotal: 100, discountTotal: 0, total: 100, currency: "INR" };
  const contact = { email: "adra@shopper.test", phone: WORK.phone, name: WORK.name };
  const address = { line1: WORK.line1, line2: WORK.line2, city: WORK.city, state: WORK.state, pincode: WORK.pincode, country: "India" };
  // createOrder outside a request (no cookies): the order is placed, nothing stamped
  const o = await sA.run(() => O.createOrder({ cartId: "cart-adr-1", cart, contact, address, paymentMethod: "cod", idempotencyKey: "adr-key-1" }));
  ok(o.id && !o.deduped, "order placed");
  orderId = o.id;
  eq((await rowOf(A.work)).last_used_at, null, "no stamp without a session");
  // signed out / B's token: nothing
  await sA.run(() => Adr.markOrderAddressUsed(contact, address, { readToken: () => null }));
  await sA.run(() => Adr.markOrderAddressUsed(contact, address, { readToken: () => B.token }));
  eq((await rowOf(A.work)).last_used_at, null, "nobody else stamps A's row");
  const r = await sA.run(() => Adr.markOrderAddressUsed(contact, address, { readToken: () => A.token }));
  eq(r, undefined, "write-only: returns nothing");
  ok((await rowOf(A.work)).last_used_at, "A's matching row stamped");
  eq((await rowOf(A.home)).last_used_at, null, "the other row untouched");
  await call("POST", { ...asA, body: { action: "address_save", address: { ...HOME, label: "", line1: "cnyadrline3" } } });
  const list = (await call("GET", { ...asA, query: "view=addresses" })).body.addresses;
  same(list.map((a) => a.line1), ["cnyadrline1", "cnyadrline2", "cnyadrline3"], "default, then last used, then newest");
  // the hook sits on the new-order path of createOrder
  const src = await readFile(join(ROOT, "lib/orders.js"), "utf8");
  eq((src.match(/markOrderAddressUsed\(/g) || []).length, 1, "one call in lib/orders.js");
});

await t("the order hook on a store without 0037: the order is placed and nothing throws", async () => {
  const pre = await F.makeTenant({ name: "adr-pre", stage: "0034", products: 1, secrets: { order_link_secret: LINK } });
  const cart = { items: [{ variantId: "gid://v/1", productId: "gid://p/1", title: "Thing", variantTitle: "Default", image: null, price: 100, quantity: 1, lineTotal: 100, discount: 0 }], gifts: [], appliedOffers: [], subtotal: 100, discountTotal: 0, total: 100, currency: "INR" };
  const now = new Date().toISOString();
  await q(pre, "INSERT INTO customers (id, email, created_at) VALUES ('cus_pre', 'pre@x.test', ?)", [now]);
  await q(pre, "INSERT INTO customer_sessions (token_hash, customer_id, created_at, expires_at) VALUES (?, 'cus_pre', ?, ?)", [sha(`ct_pre|${LINK}|customer`), now, new Date(Date.now() + 3600000).toISOString()]);
  const o = await pre.run(() => O.createOrder({ cartId: "cart-pre", cart, contact: { email: "pre@x.test", phone: "9811100001", name: "Pre" }, address: { line1: "1 St", city: "Pune", state: "MH", pincode: "411001" }, paymentMethod: "cod", idempotencyKey: "pre-key" }));
  ok(o.id && !o.deduped, "order placed");
  eq(await pre.run(() => Adr.markOrderAddressUsed({ name: "Pre", phone: "9811100001" }, { line1: "1 St" }, { readToken: () => "ct_pre" })), undefined, "a signed-in shopper on a store without the table: nothing");
  ok(!(await q(pre, "SELECT name FROM sqlite_master WHERE name = 'customer_addresses'")).length, "still no table");
});

await t("delete is a real delete; the order keeps its own copy; deleting the default promotes the next", async () => {
  const del = await call("POST", { ...asA, body: { action: "address_delete", id: A.work } });
  eq(del.status, 200, "delete");
  eq(await rowOf(A.work), null, "row gone");
  const order = (await q(sA, "SELECT address_line1, snapshot FROM orders WHERE id = ?", [orderId]))[0];
  eq(order.address_line1, "cnyadrline2", "order column kept");
  eq(JSON.parse(order.snapshot).address.line1, "cnyadrline2", "order snapshot kept");
  const again = await call("POST", { ...asA, body: { action: "address_delete", id: A.work } });
  eq(again.status, 404, "a second delete finds nothing");
  await call("POST", { ...asA, body: { action: "address_delete", id: A.home } });
  const left = (await call("GET", { ...asA, query: "view=addresses" })).body.addresses;
  same(left.map((a) => [a.line1, a.is_default]), [["cnyadrline3", true]], "next one is the default");
});

await t("redactCustomer deletes the shopper's addresses (and only theirs)", async () => {
  await call("POST", { ...asB, body: { action: "address_save", address: { ...HOME, name: "Bea", line1: "b line" } } });
  const { redactCustomer } = await import("../lib/privacy.js");
  await sA.run(() => redactCustomer({ email: "adra@shopper.test" }));
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?", [A.id]))[0].n, 0, "A's gone");
  eq((await q(sA, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?", [B.id]))[0].n, 1, "B's kept");
});

// ---------------------------------------------------------------------------
// 3. No console or app route reaches an address
// ---------------------------------------------------------------------------
console.log("— 3. route tables and copy");
const { ADMIN_ROUTES } = await import("./support/admin-routes.js");
const { PLATFORM_ROUTES } = await import("./support/platform-routes.js");
const { SHOPPER_ROUTES } = await import("./support/shopper-routes.js");

// Every file a module can load: static imports, re-exports and dynamic imports.
const SPEC = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(from), spec);
  else return null;
  for (const p of [base, `${base}.js`, `${base}.ts`, join(base, "index.js")]) if (existsSync(p) && !p.endsWith("/") && /\.(js|ts|mjs)$/.test(p)) return p;
  return null;
}
const graphCache = new Map();
async function importers(entry) {
  // file -> the files in this graph that import it
  const seen = new Map([[entry, new Set()]]);
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    let specs = graphCache.get(f);
    if (!specs) {
      const src = await readFile(f, "utf8");
      specs = [...src.matchAll(SPEC)].map((m) => m[1] || m[2] || m[3]);
      graphCache.set(f, specs);
    }
    for (const s of specs) {
      const r = resolve(f, s);
      if (!r) continue;
      if (!seen.has(r)) {
        seen.set(r, new Set());
        todo.push(r);
      }
      seen.get(r).add(f);
    }
  }
  return seen;
}
const ADDRESSES = join(ROOT, "lib/addresses.js");
const rel = (p) => relative(ROOT, p);
async function routeFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await routeFiles(p)));
    else if (e.name === "route.js") out.push(p);
  }
  return out;
}

await t("no admin, operator, app or other non-account route reaches an address reader (the route tables, by import graph)", async () => {
  const entries = new Set();
  for (const r of ADMIN_ROUTES) {
    entries.add(join(ROOT, "app/api/admin", r.path, "route.js"));
    if (r.via) entries.add(join(ROOT, r.via));
  }
  for (const r of PLATFORM_ROUTES) entries.add(join(ROOT, "app/api/platform", r.path, "route.js"));
  for (const r of SHOPPER_ROUTES) if (r.path !== "account") entries.add(join(ROOT, "app/api", r.path, "route.js"));
  for (const f of await routeFiles(join(ROOT, "app/api/apps"))) entries.add(f);
  ok(entries.size > 80, `route entries: ${entries.size}`);
  const reached = [];
  for (const e of entries) {
    ok(existsSync(e), `route file ${rel(e)}`);
    const g = await importers(e);
    if (!g.has(ADDRESSES)) continue;
    const via = [...g.get(ADDRESSES)].map(rel);
    // the one allowed path: lib/orders.js's write-only order hook
    same(via, ["lib/orders.js"], `${rel(e)} reaches lib/addresses.js through`);
    reached.push(rel(e));
  }
  const orders = await readFile(join(ROOT, "lib/orders.js"), "utf8");
  same([...orders.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/addresses\.js["']/g)].map((m) => m[1].trim()), ["markOrderAddressUsed"], "lib/orders.js imports only the write-only hook");
  ok(reached.length > 0, "the scan sees the order hook (it walks real graphs)");
});

await t("only lib/addresses.js and lib/privacy.js name the table; only the account route and page import the readers", async () => {
  const hits = [];
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", ".next", ".git"].includes(e.name)) await scan(p);
      } else if (/\.(js|ts|mjs)$/.test(e.name)) {
        const src = await readFile(p, "utf8");
        if (src.includes("customer_addresses")) hits.push(["table", rel(p)]);
        if (/from\s*["'](@\/lib|\.\.?(\/\.\.)*\/?(lib)?)\/?addresses(\.js)?["']/.test(src)) hits.push(["import", rel(p)]);
      }
    }
  }
  for (const d of ["app", "lib", "components"]) await scan(join(ROOT, d));
  same(
    hits.sort(),
    [["import", "app/(storefront)/account/page.js"], ["import", "app/api/account/route.js"], ["import", "lib/orders.js"], ["table", "lib/addresses.js"], ["table", "lib/privacy.js"]].sort(),
    "files",
  );
});

await t("the address copy passes the banned-copy scan (shopper rules)", async () => {
  const { scanText } = await import("./support/banned-copy.js");
  for (const f of ["components/account/AddressBook.js", "components/account/AddressForm.js", "components/checkout/SavedAddressPicker.js"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    const text = [...src.matchAll(/>([^<>{}]+)</g), ...src.matchAll(/"([^"]{4,})"/g)].map((m) => m[1]).join("\n");
    same(scanText(text, { shopper: true, claims: false }), [], f);
  }
  // the confirm line the plan names
  ok((await readFile(join(ROOT, "components/account/AddressBook.js"), "utf8")).includes("Delete this address? Past orders keep their copy."), "confirm copy");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
