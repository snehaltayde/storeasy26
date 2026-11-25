// The orders console on the new UI (docs/plans/phase-2.md "Line 2").
//   pnpm test:orders-console
// No browser, no network (fetch is blocked, outside services blanked); every
// database is a throwaway file: database.
//   1. Order ids: <PREFIX>- plus 16 hex (64 bits); errorFingerprint folds old
//      and new ids of any prefix into one row; canPush follows PUSHABLE
//   2. The list query: a stable (created_at, id) cursor over rows that share a
//      timestamp (every order once, in order), the old plain ISO `before`
//      still accepted, a foreign cursor = the first page; ?payment=cod|online;
//      search by id, email, phone and the Shopify order number; counts follow
//      the same filters
//   3. The API for every role (support, the least-trusted, first): support's
//      ?q=<email>, <phone> and <Shopify number> match nothing, its rows carry
//      no customer details; staff and support get 403 on push, reconcile and
//      cancel, staff may decide a return; signed out → 401; push on an unknown
//      order → 404 "We couldn't find that order." with no audit row; a push
//      refusal (no Shopify) is a plain answer, never a 5xx; another store's
//      order id is a 404 everywhere with no detail, no audit row and a
//      not-found page; a push that throws is a 502 whose raw text reaches
//      slog only; a refund id must match rfnd_ plus 8+ letters or digits
//   4. The pages through scripts/support/page-harness.js: support's list and
//      order props hold no customer detail, its customer card says hidden,
//      and no push, reconcile or cancel control is offered; staff the same
//      for the writes but may decide returns; the owner's list still carries
//      the order email (the positive control); unknown id → not found;
//      signed out → /admin/login; the address's filters reach the list
//   5. The components rendered (SWC + react-dom/server, real components/ui and
//      kit): OrderActions shows no write control for staff or support and each
//      one for admin; ReturnsList decisions for staff, none for support;
//      OrdersList masks the customer for support; OrderFilters marks every
//      read with data-read-control and searches with a GET form
//   6. The plain words for every push, reconcile and cancel answer (no codes)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-ordc-default.db";
process.env.PLATFORM_SECRET = "ordc-platform-secret";
const network = H.blockNetwork();

const store = await H.makeRoleStore({ name: "ordc" });
const { a, call, cookies } = store;
const inA = a.run;
const { db } = await import("../lib/db.js");
const O = await import("../lib/orders.js");
const { errorFingerprint } = await import("../lib/errors.js");
const { canPush } = await import("../lib/shopify-push.js");
const L = await import("../lib/admin/orders.js");
const view = await import("../lib/admin/order-view.js");
const { listAudit } = await import("../lib/platform/audit.js");

// customer details: short canaries no casing or encoding can hide
const CNY = { email: "cnyordc0@example.test", phone: "9811122233", name: "cnyordcname0", line1: "cnyordcline0" };
const SHOPIFY_NO = "5550001234";
// P2-A: raw push-failure text; P2-B: a return's free text
const PUSH_CNY = { mail: "cnypushordc0@example.test", token: "SHOPIFY_ADMIN_TOKEN", error: "", meta: "" };
PUSH_CNY.error = `userErrors: [{"field":["email"],"message":"Email ${PUSH_CNY.mail} is invalid"}]`;
PUSH_CNY.meta = `Missing env ${PUSH_CNY.token}=shpat_cny; userErrors: ${PUSH_CNY.mail}`;
const RET_CNY = { phone: "9822233344", email: "cnyretordc0@example.test" };

// 120 orders, three sharing each timestamp; every fourth cash on delivery;
// one pushed (a Shopify number), one carrying the canary customer
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const ids = [];
await inA(async () => {
  for (let i = 0; i < 120; i++) {
    const id = `ORD-${String(i).padStart(4, "0")}AAAA`;
    ids.push(id);
    const ts = new Date(BASE + Math.floor(i / 3) * 60_000).toISOString();
    const cod = i % 4 === 0;
    const pushed = i === 7;
    await db
      .insertInto("orders")
      .values({
        id,
        idempotency_key: `ordc-${i}`,
        status: pushed ? "synced" : cod ? "cod_pending" : "paid",
        payment_method: cod ? "cod" : "razorpay",
        payment_status: cod ? "cod" : "paid",
        total: 100 + i,
        subtotal: 100 + i,
        discount_total: 0,
        currency: "INR",
        email: i === 5 ? CNY.email : `shopper${i}@example.test`,
        phone: i === 5 ? CNY.phone : `90000${String(i).padStart(5, "0")}`,
        name: i === 5 ? CNY.name : `Shopper ${i}`,
        address_line1: i === 5 ? CNY.line1 : "1 Main Road",
        shopify_order_id: pushed ? `gid://shopify/Order/${SHOPIFY_NO}` : null,
        sync_attempts: pushed ? 1 : 0,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
  }
  await db.insertInto("return_requests").values({ id: "ret_ordc1", order_id: ids[7], customer_id: "cus_ordc", reason: "Too small", status: "requested", created_at: new Date(BASE).toISOString(), updated_at: new Date(BASE).toISOString() }).execute();
  // P2-B: the shopper's free text can carry their own details
  await db.insertInto("return_requests").values({ id: "ret_ordc2", order_id: ids[9], customer_id: "cus_ordc", reason: `Call me on ${RET_CNY.phone}`, note: `Mail ${RET_CNY.email}`, status: "requested", created_at: new Date(BASE).toISOString(), updated_at: new Date(BASE).toISOString() }).execute();
  // P2-A: a failed push whose raw text echoes Shopify's userErrors and an env name
  await db.updateTable("orders").set({ status: "sync_failed", sync_attempts: 2, sync_error: PUSH_CNY.error }).where("id", "=", ids[21]).execute();
  await db.insertInto("order_events").values({ order_id: ids[21], from_status: "syncing_shopify", to_status: "sync_failed", meta: JSON.stringify({ error: PUSH_CNY.meta }), created_at: new Date(BASE).toISOString() }).execute();
});
const newestFirst = [...ids].reverse(); // created_at desc, then id desc
const COD_ID = ids[4]; // cod_pending
const CNY_ID = ids[5]; // paid online, the canary customer
const PUSHED_ID = ids[7];
const FAILED_ID = ids[21]; // sync_failed, raw push text carrying canaries

// =============================================================================
console.log("— 1. order ids, fingerprints, canPush");

await t("new order ids are the store's prefix plus 16 upper-case hex characters, and differ", async () => {
  const made = await inA(() => Array.from({ length: 200 }, () => O.orderNumber()));
  for (const id of made) ok(/^[A-Z0-9]{1,4}-[0-9A-F]{16}$/.test(id), `id shape (${id}):`);
  eq(new Set(made).size, made.length, "200 ids, all different:");
  ok(made[0].length <= 40, "fits Shopify's 40-character tag:");
});

await t("errorFingerprint folds order ids of any prefix and either length into one row", () => {
  const fp = (m) => errorFingerprint({ source: "server", name: "Error", message: m, stack: "Error\n    at push (lib/shopify-push.js:1:1)" });
  eq(fp("push failed for BL-1A2B3C4D"), fp("push failed for BL-9F8E7D6C"), "old BL ids:");
  eq(fp("push failed for PAV-1A2B3C4D5E6F7A8B"), fp("push failed for PAV-0000000000000000"), "new ids:");
  eq(fp("push failed for ORD-1A2B3C4D"), fp("push failed for ORD-1A2B3C4D5E6F7A8B"), "old and new lengths, one prefix:");
  ok(fp("push failed for BL-1A2B3C4D") !== fp("push failed for PAV-1A2B3C4D"), "two stores' prefixes stay apart:");
});

await t("canPush is true exactly for paid, cash-on-delivery and failed-push orders", () => {
  const states = Object.values(O.ORDER_STATUS);
  eq(states.filter((status) => canPush({ status })).sort(), ["cod_pending", "paid", "sync_failed"], "pushable:");
  eq(canPush(null), false, "no order:");
});

// =============================================================================
console.log("— 2. the list query");

await t("the (created_at, id) cursor pages through rows sharing a timestamp: every order once, newest first", async () => {
  const seen = [];
  const sizes = [];
  let before = null;
  for (let page = 0; page < 5; page++) {
    const r = await inA(() => L.listOrders({ before }));
    seen.push(...r.orders.map((o) => o.id));
    sizes.push(r.orders.length);
    if (!r.nextBefore) break;
    ok(!/\d{4}-\d{2}-\d{2}T/.test(r.nextBefore), "the cursor is opaque:");
    before = r.nextBefore;
  }
  eq(sizes, [50, 50, 20], "pages of 50, no cursor once the last row is in:");
  eq(seen, newestFirst, "every order once, in order:");
});

await t("the old plain ISO before= is still accepted; a foreign cursor reads as the first page", async () => {
  const iso = new Date(BASE + 10 * 60_000).toISOString();
  const r = await inA(() => L.listOrders({ before: iso }));
  ok(r.orders.length === 30 && r.orders.every((o) => o.created_at < iso), `older than ${iso}: ${r.orders.length}`);
  const junk = await inA(() => L.listOrders({ before: "not-a-cursor" }));
  eq(junk.orders[0].id, newestFirst[0], "junk cursor:");
  eq(L.decodeCursor(L.encodeCursor({ created_at: "2026-11-01T00:00:00.000Z", id: "ORD-1" })), { createdAt: "2026-11-01T00:00:00.000Z", id: "ORD-1" }, "round trip:");
});

await t("?payment=cod|online, search by id, email, phone and Shopify number; counts follow the filters", async () => {
  const cod = await inA(() => L.listOrders({ payment: "cod", limit: 100 }));
  ok(cod.orders.length === 30 && cod.orders.every((o) => o.payment_method === "cod"), `cod rows: ${cod.orders.length}`);
  const online = await inA(() => L.listOrders({ payment: "online", limit: 100 }));
  ok(online.orders.length === 90 && online.orders.every((o) => o.payment_method !== "cod"), `online rows: ${online.orders.length}`);
  eq((await inA(() => L.listOrders({ q: CNY.email }))).orders.map((o) => o.id), [CNY_ID], "by email:");
  eq((await inA(() => L.listOrders({ q: CNY.phone }))).orders.map((o) => o.id), [CNY_ID], "by phone:");
  eq((await inA(() => L.listOrders({ q: CNY_ID.slice(0, 8) }))).orders.map((o) => o.id), [CNY_ID], "by id:");
  eq((await inA(() => L.listOrders({ q: `#${SHOPIFY_NO}` }))).orders.map((o) => o.id), [PUSHED_ID], "by Shopify number:");
  eq((await inA(() => L.listOrders({ q: CNY.email, piiSearch: false }))).orders, [], "id only, email:");
  eq((await inA(() => L.listOrders({ q: SHOPIFY_NO, piiSearch: false }))).orders, [], "id only, Shopify number:");
  const counts = await inA(() => L.orderStatusCounts({ payment: "cod" }));
  eq([counts.all, counts.cod_pending, counts.paid ?? 0], [30, 30, 0], "cod counts:");
  eq((await inA(() => L.orderStatusCounts({}))).all, 120, "all counts:");
});

// =============================================================================
console.log("— 3. the API, every role");

await t("support: ?q=<email>, <phone> and <Shopify number> match nothing; rows carry no customer details", async () => {
  for (const q of [CNY.email, CNY.phone, SHOPIFY_NO]) {
    const r = await call("support", "orders", "GET", { query: `q=${encodeURIComponent(q)}` });
    eq([r.status, r.body?.orders?.length], [200, 0], `support ?q=${q}:`);
    eq(r.body?.counts?.all, 0, `support ?q=${q} counts.all:`);
  }
  const all = await call("support", "orders", "GET", { query: "payment=online" });
  eq(all.status, 200, "support list:");
  for (const c of Object.values(CNY)) ok(!all.text.includes(c), `support list leaks ${c}`);
  ok(all.body.orders.every((o) => o.email === null && o.phone === null && o.name === null), "rows redacted:");
  const one = await call("support", "orders/[id]", "GET", { params: { id: CNY_ID } });
  eq(one.status, 200, "support detail:");
  for (const c of Object.values(CNY)) ok(!one.text.includes(c), `support detail leaks ${c}`);
  const byId = await call("support", "orders", "GET", { query: `q=${CNY_ID}` });
  eq(byId.body?.orders?.map((o) => o.id), [CNY_ID], "support finds it by id:");
});

const PUSH_CANARIES = [PUSH_CNY.mail, PUSH_CNY.token, "userErrors", "shpat_cny"];
await t("P2-A support: GET /api/admin/orders/[id] and the list carry fixed words, never the raw push-failure text", async () => {
  const one = await call("support", "orders/[id]", "GET", { params: { id: FAILED_ID } });
  eq(one.status, 200, "support detail:");
  for (const c of PUSH_CANARIES) ok(!one.text.includes(c), `support detail leaks ${c}`);
  eq(one.body.order.sync_error, view.SUPPORT_PUSH_ERROR, "sync_error words:");
  const ev = one.body.order.events.find((e) => e.to_status === "sync_failed");
  eq(ev?.meta?.error, view.SUPPORT_PUSH_ERROR, "timeline meta.error words:");
  const list = await call("support", "orders", "GET", { query: "status=sync_failed" });
  eq(list.body?.orders?.map((o) => o.id), [FAILED_ID], "support list:");
  for (const c of PUSH_CANARIES) ok(!list.text.includes(c), `support list leaks ${c}`);
  for (const role of ["owner", "admin"]) {
    const r = await call(role, "orders/[id]", "GET", { params: { id: FAILED_ID } });
    eq(r.body?.order?.sync_error, PUSH_CNY.error, `${role} keeps sync_error:`);
    eq(r.body?.order?.events?.find((e) => e.to_status === "sync_failed")?.meta?.error, PUSH_CNY.meta, `${role} keeps meta.error:`);
  }
});

await t("P2-B support: GET /api/admin/returns hides the shopper's reason and note; staff and owner keep them", async () => {
  const r = await call("support", "returns", "GET");
  eq(r.status, 200, "support returns:");
  for (const c of Object.values(RET_CNY)) ok(!r.text.includes(c), `support returns leak ${c}`);
  const row = r.body.returns.find((x) => x.id === "ret_ordc2");
  eq([row?.reason, row?.note, row?.status], [null, null, "requested"], "support row:");
  for (const role of ["staff", "owner"]) {
    const o = await call(role, "returns", "GET");
    for (const c of Object.values(RET_CNY)) ok(o.text.includes(c), `${role} misses ${c}`);
  }
});

await t("signed out: list, detail, push, cancel and returns answer 401", async () => {
  eq((await call("signed-out", "orders", "GET")).status, 401, "list:");
  eq((await call("signed-out", "orders/[id]", "GET", { params: { id: COD_ID } })).status, 401, "detail:");
  for (const action of ["push", "reconcile", "cancel"]) eq((await call("signed-out", "orders/[id]", "POST", { params: { id: COD_ID }, body: { action } })).status, 401, `${action}:`);
  eq((await call("signed-out", "returns", "POST", { body: { id: "ret_ordc1", action: "approve" } })).status, 401, "returns:");
});

await t("staff and support: push, reconcile and cancel are 403; staff may decide a return, support may not", async () => {
  for (const caller of ["support", "staff"]) {
    for (const action of ["push", "reconcile", "cancel"]) {
      eq((await call(caller, "orders/[id]", "POST", { params: { id: COD_ID }, body: { action } })).status, 403, `${caller} ${action}:`);
    }
  }
  eq((await call("support", "returns", "POST", { body: { id: "ret_ordc1", action: "approve" } })).status, 403, "support decides:");
  const staff = await call("staff", "returns", "POST", { body: { id: "ret_ordc1", action: "approve", note: "Send it back" } });
  eq([staff.status, staff.body?.status], [200, "approved"], "staff approves:");
});

await t("push on an unknown order is 404 \"We couldn't find that order.\" with no audit row; so are reconcile and cancel", async () => {
  const before = (await listAudit({ tenantId: a.id, limit: 200 })).filter((r) => String(r.resource).includes("ORD-MISSING")).length;
  for (const action of ["push", "reconcile", "cancel"]) {
    const r = await call("admin", "orders/[id]", "POST", { params: { id: "ORD-MISSING" }, body: { action } });
    eq([r.status, r.body?.error], [404, "We couldn't find that order."], `${action}:`);
  }
  eq((await listAudit({ tenantId: a.id, limit: 200 })).filter((r) => String(r.resource).includes("ORD-MISSING")).length, before, "audit rows for the unknown order:");
});

await t("admin: a push with no Shopify connection is a plain refusal (never a 5xx) and is audited", async () => {
  const r = await call("admin", "orders/[id]", "POST", { params: { id: COD_ID }, body: { action: "push" } });
  ok(r.status < 500, `status ${r.status}: ${r.text.slice(0, 200)}`);
  eq(r.body?.ok, false, "not pushed:");
  const words = view.pushAnswer(r.body, r.status);
  ok(!words.ok && !/[a-z]+_[a-z]+/.test(words.text), `plain words: ${words.text}`);
  ok((await listAudit({ tenantId: a.id, limit: 200 })).some((x) => x.action === "orders.push" && x.resource === `order:${COD_ID}`), "audited:");
});

await t("owner: cancelling a cash-on-delivery order works and reads in plain words", async () => {
  const id = ids[8]; // cod_pending
  const r = await call("owner", "orders/[id]", "POST", { params: { id }, body: { action: "cancel", reason: "Customer asked" } });
  eq([r.status, r.body?.ok], [200, true], `cancel: ${r.text.slice(0, 200)}`);
  eq(view.cancelAnswer(r.body, r.status), { ok: true, text: "Order cancelled." }, "words:");
  const paid = await call("owner", "orders/[id]", "POST", { params: { id: ids[9] }, body: { action: "cancel" } });
  eq([paid.status, paid.body?.code], [409, "REFUND_REQUIRED"], "a captured payment needs a refund id:");
  ok(view.cancelAnswer(paid.body, paid.status).text.includes("Refund it in Razorpay first"), "refund words:");
});

const { makePageHarness } = await import("./support/page-harness.js");
const C = await import("../lib/platform/control.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const LIST = "app/(console)/admin/(authed)/orders/page.js";
const DETAIL = "app/(console)/admin/(authed)/orders/[id]/page.js";

await t("another store's order id: GET, push, reconcile and cancel from store A are 404 with no detail and no audit row", async () => {
  const B_ID = "BSTORE-0000ORDCB";
  const B_MAIL = "cnyordcb0@example.test";
  await store.b.run(() =>
    db.insertInto("orders").values({ id: B_ID, idempotency_key: "ordc-b-1", status: "cod_pending", payment_method: "cod", payment_status: "cod", total: 777, subtotal: 777, discount_total: 0, currency: "INR", email: B_MAIL, name: "cnyordcbname0", sync_attempts: 0, created_at: new Date(BASE).toISOString(), updated_at: new Date(BASE).toISOString() }).execute(),
  );
  const audits = async () => (await Promise.all([a.id, store.b.id].map((tenantId) => listAudit({ tenantId, limit: 200 })))).flat().filter((r) => String(r.resource).includes(B_ID)).length;
  const before = await audits();
  for (const caller of ["owner", "admin"]) {
    const g = await call(caller, "orders/[id]", "GET", { params: { id: B_ID } });
    eq(g.status, 404, `${caller} GET:`);
    eq(Object.keys(g.body ?? {}), ["error"], `${caller} GET body keys:`);
    for (const action of ["push", "reconcile", "cancel"]) {
      const r = await call(caller, "orders/[id]", "POST", { params: { id: B_ID }, body: { action } });
      eq([r.status, r.body], [404, { error: "We couldn't find that order." }], `${caller} ${action}:`);
    }
    for (const r of [g]) ok(!r.text.includes(B_MAIL) && !r.text.includes("777"), `${caller}: no detail of B's order`);
  }
  eq(await audits(), before, "audit rows naming B's order:");
  eq((await store.b.run(() => db.selectFrom("orders").select("status").where("id", "=", B_ID).executeTakeFirst()))?.status, "cod_pending", "B's order untouched:");
  const page = await pages.run(DETAIL, { cookies: cookies.owner, params: { id: B_ID } });
  eq(page.notFound, true, "store A's order page for B's id is not found:");
});

await t("a push that throws is a 502 in plain words; the raw error reaches slog, never the body", async () => {
  const { registerHooks } = await import("node:module");
  const real = new URL("../lib/shopify-push.js", import.meta.url).href;
  const stub = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; export async function pushOrderToShopify() { throw new Error("shopify said x"); }`)}`;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/lib/shopify-push" && context.parentURL?.includes("stub502")) return { url: stub, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  const route = await import(`${new URL("../app/api/admin/orders/[id]/route.js", import.meta.url).href}?stub502`);
  const { NextRequest } = await import("./support/next-server-stub.js");
  const host = a.tenant.domains[0];
  const id = ids[16]; // cod_pending: pushable
  const req = new NextRequest(`http://${host}/api/admin/orders/${id}`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", cookie: `_admin=${cookies.admin._admin}` }, body: JSON.stringify({ action: "push" }) });
  const logged = [];
  const log = console.log;
  console.log = (...args) => {
    logged.push(args.join(" "));
    log(...args);
  };
  let res;
  try {
    res = await route.POST(req, { params: Promise.resolve({ id }) });
  } finally {
    console.log = log;
  }
  const text = await res.text();
  eq(res.status, 502, "status:");
  ok(!text.includes("shopify said x"), `the raw error is in the body: ${text}`);
  ok(/didn't go through/.test(JSON.parse(text).error), `plain words: ${text}`);
  ok(logged.some((l) => l.includes("admin_order_action_failed") && l.includes("shopify said x")), `slog has the raw error: ${logged.join(" | ").slice(0, 300)}`);
});

await t("a refund id must look like Razorpay's: the server refuses another shape in plain words and cancels with a real one", async () => {
  eq(["rfnd_ABCdef12", "rfnd_1234567890"].map((x) => view.REFUND_ID_RE.test(x)), [true, true], "accepted:");
  eq(["rfnd_short", "rfnd_ABC-def12", "pay_ABCdef1234", " rfnd_ABCdef12", "rfnd_"].map((x) => view.REFUND_ID_RE.test(x)), [false, false, false, false, false], "refused:");
  const id = ids[13]; // paid online
  for (const refundId of ["rfnd_bad!", "12345678", "rfnd_abc"]) {
    const r = await call("owner", "orders/[id]", "POST", { params: { id }, body: { action: "cancel", refundId } });
    eq([r.status, r.body?.code], [422, "REFUND_ID_INVALID"], `${refundId}:`);
    eq(view.cancelAnswer(r.body, r.status).text, view.REFUND_ID_WORDS, `${refundId} words:`);
  }
  eq((await inA(() => db.selectFrom("orders").select("status").where("id", "=", id).executeTakeFirst())).status, "paid", "still paid:");
  const good = await call("owner", "orders/[id]", "POST", { params: { id }, body: { action: "cancel", refundId: "rfnd_ABCdef1234" } });
  eq([good.status, good.body?.ok], [200, true], `a real-shaped id cancels: ${good.text.slice(0, 200)}`);
  const dialog = readFileSync(join(ROOT, "components/admin/orders/CancelDialog.js"), "utf8");
  ok(/REFUND_ID_RE\.test\(refundId\.trim\(\)\)/.test(dialog) && /disabled=\{busy \|\| needsRefund\}/.test(dialog) && dialog.includes("{REFUND_ID_WORDS}"), "the dialog checks the same shape, says why and keeps Cancel disabled:");
});

// =============================================================================
console.log("— 4. the pages, every role");

const propsOf = (run, name) => run.props.filter((p) => p.component.endsWith(`#${name}`) || p.component === name).map((p) => p.props);

await t("support's orders list: no customer detail in any prop, id-only search, ?q=<email> lists nothing", async () => {
  const run = await pages.run(LIST, { cookies: cookies.support, searchParams: { payment: "online" } });
  ok(!run.error && !run.redirect, `ran: ${run.error?.message} ${run.redirect}`);
  eq(run.unresolved, [], "imports:");
  for (const c of Object.values(CNY)) ok(!run.text.includes(c), `support list props leak ${c}`);
  const [list] = propsOf(run, "OrdersList");
  ok(list && list.orders.length === 50, `OrdersList rows: ${list?.orders?.length}`);
  eq(list.piiSearch, false, "id-only search:");
  eq(propsOf(run, "OrderFilters")[0]?.piiSearch, false, "the search box says id only:");
  for (const value of [CNY.email, CNY.phone, SHOPIFY_NO]) {
    const q = await pages.run(LIST, { cookies: cookies.support, searchParams: { q: value } });
    eq(propsOf(q, "OrdersList")[0]?.orders, [], `support ?q=${value}:`);
    eq(propsOf(q, "OrderFilters")[0]?.counts?.all, 0, `support ?q=${value} counts.all:`);
    eq(propsOf(q, "OrdersList")[0]?.total, 0, `support ?q=${value} total:`);
  }
});

await t("the owner's orders list carries the order email (the positive control); the address's filters reach the list", async () => {
  const run = await pages.run(LIST, { cookies: cookies.owner, searchParams: { status: "paid", payment: "online", q: CNY.email } });
  ok(!run.error, run.error?.message);
  ok(run.text.includes(CNY.email), "the owner's props carry the order email");
  const [list] = propsOf(run, "OrdersList");
  eq(list.orders.map((o) => o.id), [CNY_ID], "filtered rows:");
  eq(list.filters, { status: "paid", payment: "online", q: CNY.email, view: "orders" }, "filters:");
  eq(list.total, 1, "the footer's total is the tab's count:");
  const junk = await pages.run(LIST, { cookies: cookies.owner, searchParams: { status: "nope", payment: "card" } });
  eq(propsOf(junk, "OrdersList")[0]?.filters, { status: "all", payment: "", q: "", view: "orders" }, "unknown filters drop:");
});

await t("?view=returns: the returns list for staff and support, no orders query; support gets status only", async () => {
  for (const role of ["support", "staff"]) {
    const run = await pages.run(LIST, { cookies: cookies[role], searchParams: { view: "returns" } });
    ok(!run.error, `${role}: ${run.error?.message}`);
    const [r] = propsOf(run, "ReturnsList");
    ok(r && r.returns.some((x) => x.id === "ret_ordc1"), `${role} ReturnsList: ${JSON.stringify(r?.returns)}`);
    eq(r.role, role, `${role} role:`);
    eq(propsOf(run, "OrdersList").length, 0, `${role} no orders list:`);
    for (const c of Object.values(CNY)) ok(!run.text.includes(c), `${role} returns props leak ${c}`);
    const mine = r.returns.find((x) => x.id === "ret_ordc2");
    for (const c of Object.values(RET_CNY)) ok(role === "support" ? !run.text.includes(c) : run.text.includes(c), `${role} returns props and ${c}`);
    if (role === "support") eq([mine?.reason, mine?.note], [null, null], "support's free text:");
  }
});

await t("support's order page: no customer detail, the card says hidden, no push, reconcile or cancel offered", async () => {
  const run = await pages.run(DETAIL, { cookies: cookies.support, params: { id: CNY_ID } });
  ok(!run.error && !run.notFound, `ran: ${run.error?.message}`);
  eq(run.unresolved, [], "imports:");
  for (const c of Object.values(CNY)) ok(!run.text.includes(c), `support order props leak ${c}`);
  ok(run.text.includes("Hidden for support"), "the customer card says hidden:");
  const [actions] = propsOf(run, "OrderActions");
  eq(actions?.can, { push: false, reconcile: false, cancel: false }, "support's actions:");
  const pushed = await pages.run(DETAIL, { cookies: cookies.support, params: { id: PUSHED_ID } });
  eq(propsOf(pushed, "OrderActions")[0]?.can, { push: false, reconcile: false, cancel: false }, "support on a pushed order:");
});

await t("P2-A support's order page: the failed-push banner and timeline say fixed words; the owner's keep the raw text", async () => {
  const run = await pages.run(DETAIL, { cookies: cookies.support, params: { id: FAILED_ID } });
  ok(!run.error && !run.notFound, `ran: ${run.error?.message}`);
  for (const c of PUSH_CANARIES) ok(!run.text.includes(c), `support order page leaks ${c}`);
  ok(run.text.includes(view.SUPPORT_PUSH_ERROR), "the banner says the fixed words:");
  const tl = propsOf(run, "OrderTimeline")[0];
  eq(tl?.events?.find((e) => e.to_status === "sync_failed")?.meta?.error, view.SUPPORT_PUSH_ERROR, "timeline prop:");
  const owner = await pages.run(DETAIL, { cookies: cookies.owner, params: { id: FAILED_ID } });
  ok(owner.text.includes(PUSH_CNY.mail) && owner.text.includes(PUSH_CNY.token), "the owner sees the raw text:");
});

await t("staff's order page: no push, reconcile or cancel; admin and owner get what the state allows", async () => {
  for (const role of ["staff", "admin", "owner"]) {
    const cod = propsOf(await pages.run(DETAIL, { cookies: cookies[role], params: { id: ids[12] } }), "OrderActions")[0];
    const pushed = propsOf(await pages.run(DETAIL, { cookies: cookies[role], params: { id: PUSHED_ID } }), "OrderActions")[0];
    const writes = role !== "staff";
    eq(cod?.can, { push: writes, reconcile: false, cancel: writes }, `${role} on a cash-on-delivery order:`);
    eq(pushed?.can, { push: false, reconcile: writes, cancel: writes }, `${role} on a pushed order:`);
  }
  const owner = await pages.run(DETAIL, { cookies: cookies.owner, params: { id: CNY_ID } });
  ok(owner.text.includes(CNY.email), "the owner's order page shows the customer:");
  ok(propsOf(owner, "OrderActions")[0]?.paymentCaptured === true, "a captured payment asks for a refund id:");
});

await t("an unknown order id is the not-found page; signed out goes to /admin/login", async () => {
  eq((await pages.run(DETAIL, { cookies: cookies.owner, params: { id: "ORD-NOPE" } })).notFound, true, "not found:");
  eq((await pages.run(DETAIL, { cookies: {}, params: { id: CNY_ID } })).redirect, "/admin/login", "detail signed out:");
  eq((await pages.run(LIST, { cookies: {} })).redirect, "/admin/login", "list signed out:");
});

// =============================================================================
console.log("— 5. the components rendered");

const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const h = React.createElement;
const STUBS = {
  "@/components/kit/toast": { useToast: () => ({ success() {}, info() {}, error() {} }) },
  "next/navigation": { useRouter: () => ({ refresh() {}, push() {}, replace() {} }) },
};
const cache = new Map();
const resolveLocal = (id) => {
  const rel = id.slice(2);
  for (const c of [`${rel}.js`, rel]) {
    try {
      readFileSync(join(ROOT, c));
      return c;
    } catch {}
  }
  throw new Error(`cannot resolve ${id}`);
};
async function load(rel) {
  const file = join(ROOT, rel);
  if (cache.has(file)) return cache.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (STUBS[id]) deps.set(id, STUBS[id]);
    else if (/^@\/(components\/(ui|kit|admin\/orders)|lib)\//.test(id)) deps.set(id, await load(resolveLocal(id)));
    else if (id.startsWith("./") && rel.startsWith("components/admin/orders/")) deps.set(id, await load(resolveLocal(`@/components/admin/orders/${id.slice(2)}`)));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(h(TooltipProvider, null, el));
// the opening <a> tags that link to this address
const linksTo = (s, href) => [...s.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(`href="${href}"`));
const markedLink = (s, href) => linksTo(s, href).some((tag) => tag.includes("data-read-control"));
const OA = await load("components/admin/orders/OrderActions.js");
const RL = await load("components/admin/orders/ReturnsList.js");
const OL = await load("components/admin/orders/OrdersList.js");
const OF = await load("components/admin/orders/OrderFilters.js");
const ALL = { push: true, reconcile: true, cancel: true };
const WRITES = [/Push to Shopify/, /Refresh from Shopify/, /Cancel order/];

await t("OrderActions: support and staff see no write control even when told the state allows one; admin and owner see each", () => {
  for (const role of ["support", "staff"]) {
    const s = html(h(OA.OrderActions, { orderId: COD_ID, role, can: ALL, paymentCaptured: false }));
    for (const w of WRITES) ok(!w.test(s), `${role} sees ${w}: ${s}`);
    ok(!/<button/.test(s), `${role} sees a button: ${s}`);
  }
  for (const role of ["admin", "owner"]) {
    const s = html(h(OA.OrderActions, { orderId: COD_ID, role, can: ALL, paymentCaptured: false }));
    for (const w of WRITES) ok(w.test(s), `${role} misses ${w}`);
    const none = html(h(OA.OrderActions, { orderId: COD_ID, role, can: { push: false, reconcile: false, cancel: false } }));
    ok(!/<button/.test(none), `${role}: nothing the state forbids: ${none}`);
  }
});

await t("ReturnsList: staff may approve or reject an open request; support sees its status only", () => {
  const returns = [{ id: "ret_1", order_id: COD_ID, reason: "Too small", status: "requested", note: null, created_at: new Date(BASE).toISOString(), total: 100, currency: "INR", refunded_total: 0 }];
  const staff = html(h(RL.ReturnsList, { returns, role: "staff", timeZone: "Asia/Kolkata" }));
  ok(/>Approve</.test(staff) && />Reject</.test(staff), `staff decisions: ${staff}`);
  const support = html(h(RL.ReturnsList, { returns, role: "support", timeZone: "Asia/Kolkata" }));
  ok(!/>Approve</.test(support) && !/>Reject</.test(support) && !/<button/.test(support), `support decisions: ${support}`);
  ok(/data-status="requested"/.test(support), "support sees the request's status:");
  const hidden = html(h(RL.ReturnsList, { returns: returns.map((x) => view.redactReturnForRole(x, "support")), role: "support", timeZone: "Asia/Kolkata" }));
  ok(!hidden.includes("Too small") && hidden.includes("Reason hidden for support"), `support's row says the reason is hidden: ${hidden}`);
  ok(markedLink(support, `/admin/orders/${COD_ID}`), "the order link is a marked read:");
  ok(/No open return requests/.test(html(h(RL.ReturnsList, { returns: [], role: "staff" }))), "empty:");
});

await t("OrdersList: the customer is masked for support, the row links to the order, totals are MoneyCell", () => {
  const rows = [{ id: CNY_ID, status: "sync_failed", payment_method: "cod", total: 1499, currency: "INR", email: null, phone: null, name: null, created_at: new Date(BASE).toISOString(), shopify_order_id: null, sync_attempts: 2, sync_error: "Variant gone" }];
  const base = { orders: rows, nextBefore: null, total: 1, filters: { status: "all", payment: "", q: "", view: "orders" }, timeZone: "Asia/Kolkata" };
  const s = html(h(OL.OrdersList, { ...base, role: "support", piiSearch: false }));
  ok(s.includes("Hidden for support"), "masked:");
  ok(new RegExp(`href="/admin/orders/${CNY_ID}"`).test(s), "row link:");
  ok(/data-kit="money-cell"[^>]*>₹1,499</.test(s), "money:");
  ok(s.includes("Failed: Variant gone"), "push error:");
  const owner = html(h(OL.OrdersList, { ...base, orders: [{ ...rows[0], name: "Asha", email: "asha@example.test" }], role: "owner", piiSearch: true }));
  ok(owner.includes("Asha"), "owner sees the name:");
  ok(/No orders yet/.test(html(h(OL.OrdersList, { ...base, orders: [], total: 0, role: "owner" }))), "empty:");
  const none = html(h(OL.OrdersList, { ...base, orders: [], total: 0, filters: { ...base.filters, q: "zzz" }, role: "owner" }));
  ok(/No orders match/.test(none) && markedLink(none, "/admin/orders"), `filtered empty with Clear: ${none}`);
});

await t("OrderFilters: tabs with counts, payment and the search are marked reads; search is a GET form", () => {
  const s = html(h(OF.OrderFilters, { filters: { status: "paid", payment: "cod", q: "", view: "orders" }, counts: { all: 9, paid: 4 }, piiSearch: false, openReturns: 2 }));
  for (const [, label] of view.ORDER_TABS) ok(s.includes(label), `tab ${label}:`);
  ok(/<form[^>]*method="get"/.test(s), "GET form:");
  ok(/<input[^>]*name="q"[^>]*data-read-control|<input[^>]*data-read-control[^>]*name="q"/.test(s), "marked search box:");
  ok(/placeholder="Order id"/.test(s), "support searches by id:");
  eq(linksTo(s, "/admin/orders?status=paid&amp;payment=cod").filter((tag) => tag.includes('aria-current="page"')).length, 2, "the current status tab and payment link:");
  const links = [...s.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  ok(links.length >= 10 && links.every((l) => l.includes("data-read-control")), `every link a marked read: ${links.filter((l) => !l.includes("data-read-control"))}`);
  const inputs = [...s.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
  ok(inputs.every((l) => l.includes("data-read-control")), `every input marked: ${inputs}`);
});

// =============================================================================
console.log("— 6. plain words");

await t("every push, reconcile and cancel answer reads in plain words, with no codes", () => {
  const texts = [
    view.pushAnswer({ ok: true }),
    view.pushAnswer({ ok: true, already: true }),
    view.pushAnswer({ ok: false, inFlight: true }),
    view.pushAnswer({ ok: false, skipped: "cancelled" }),
    view.pushAnswer({ ok: false, dead: true, attempts: 8 }),
    view.pushAnswer({ ok: false, failed: "x", dead: false }),
    view.pushAnswer({ ok: false, mismatch: true }),
    view.pushAnswer({ error: "We couldn't find that order." }, 404),
    view.pushAnswer({}, 403),
    view.reconcileAnswer({ ok: true }),
    view.reconcileAnswer({ ok: true, skipped: "not_pushed" }),
    view.reconcileAnswer({ ok: false, skipped: "shopify_order_missing" }, 409),
    view.cancelAnswer({ ok: true, shopifyCancelled: true }),
    view.cancelAnswer({ ok: true, already: true }),
    view.cancelAnswer({ ok: false, code: "INVALID_TRANSITION" }, 409),
    view.cancelAnswer({ ok: false, code: "REFUND_REQUIRED" }, 409),
    view.cancelAnswer({ ok: false, code: "SHOPIFY_CANCEL_FAILED" }, 502),
  ].map((x) => x.text);
  for (const s of texts) ok(/^[A-Z]/.test(s) && !/[a-z]+_[a-z]+|[A-Z]{3,}_|HTTP \d/.test(s), `plain: ${s}`);
  eq(new Set(texts).size, texts.length, "each answer has its own words:");
  ok(view.pushAnswer({ ok: false, skipped: "cancelled" }).text.includes("cancelled"), "skipped names the state in words:");
});

await t("no network call was made", () => eq(network, [], "fetches:"));

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
