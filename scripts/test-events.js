// Session 14 — event pipeline tests: store-then-forward, dedup + identity
// merge, outage → replay, dead-letter + alert, purchase identity join.
//   node scripts/test-events.js          (pnpm test:events)
// Isolated: throwaway libSQL file, injectable senders, local alert catcher.
import { rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-events.db";
process.env.EVENTS_MAX_ATTEMPTS = "3";
process.env.EVENTS_BACKOFF_MS = "1";
// both destinations "configured" — senders are injected, nothing leaves the process
process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-TEST";
process.env.GA4_API_SECRET = "test-secret";
process.env.NEXT_PUBLIC_META_PIXEL_ID = "1234567890";
process.env.META_CAPI_TOKEN = "test-token";

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, "../.test-events.db"), { force: true });

const alerts = [];
const catcher = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    alerts.push(JSON.parse(body));
    res.writeHead(200).end("{}");
  });
});
await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${catcher.address().port}/alert`;

const { libsql, db } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const E = await import("../lib/events.js");
const O = await import("../lib/orders.js");
const T = await import("../lib/tracking.js");

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
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

const row = (eventId) =>
  db.selectFrom("events").selectAll().where("event_id", "=", eventId).executeTakeFirst();

// sender factory: records payloads; fails first `failures` calls
function sender({ failures = 0 } = {}) {
  const calls = [];
  let left = failures;
  const fn = async ({ payload }) => {
    if (left > 0) {
      left--;
      throw new Error("simulated destination 503");
    }
    calls.push(payload);
    return { status: 200 };
  };
  fn.calls = calls;
  return fn;
}

let n = 0;
const store = (over = {}) =>
  E.storeEvent({
    eventId: over.eventId || `evt-${++n}`,
    name: "view_item",
    clientId: "111.222",
    fbp: "fb.1.1.99",
    url: "http://x/p/whey",
    payload: { value: 4949, currency: "INR", items: [{ id: "45042167054553", name: "Whey", price: 4949, quantity: 1 }] },
    ...over,
  });

// --- storage + dedup --------------------------------------------------------
await t("store: durable row with identifiers before any forwarding", async () => {
  const r = await store({ eventId: "evt-first", gclid: "GC123" });
  eq(r.stored, true, "stored");
  const e = await row("evt-first");
  eq(e.status, "pending", "pending until forwarded");
  eq(e.client_id, "111.222", "client id");
  eq(e.gclid, "GC123", "gclid");
  eq(JSON.parse(e.payload).value, 4949, "payload");
});

await t("duplicate event_id → dedup, single row", async () => {
  await store({ eventId: "evt-dup" });
  const r = await store({ eventId: "evt-dup" });
  eq(r.deduped, true, "deduped");
  const c = await db.selectFrom("events").select(db.fn.countAll().as("n")).where("event_id", "=", "evt-dup").executeTakeFirst();
  eq(Number(c.n), 1, "one row");
});

await t("purchase copies merge: second copy fills missing identity", async () => {
  await E.storeEvent({
    eventId: "BL-MERGE1",
    name: "purchase",
    clientId: null, // server copy: no cookies…
    payload: { value: 500, currency: "INR", user_data: { em: "emailhash" } }, // …but hashed PII
  });
  const r = await E.storeEvent({
    eventId: "BL-MERGE1",
    name: "purchase",
    clientId: "999.888", // browser copy brings cookies
    fbp: "fb.1.2.33",
    payload: { value: 500, currency: "INR" },
  });
  eq(r.deduped, true, "second copy deduped");
  const e = await row("BL-MERGE1");
  eq(e.client_id, "999.888", "client id merged in");
  eq(e.fbp, "fb.1.2.33", "fbp merged in");
  eq(JSON.parse(e.payload).user_data.em, "emailhash", "hashed PII kept");
});

await t("unknown event names are rejected", async () => {
  let threw = false;
  try {
    await store({ eventId: "evt-bad", name: "not_a_funnel_event" });
  } catch (e) {
    threw = true;
    ok(e.message.includes("Unknown funnel event"), "message");
  }
  ok(threw, "threw");
});

// --- forwarding -------------------------------------------------------------
await t("forward: GA4 + Meta payloads correct, exactly once each, row forwarded", async () => {
  await store({ eventId: "evt-fwd" });
  const ga4 = sender();
  const meta = sender();
  const r = await E.forwardEventById("evt-fwd", { ga4Send: ga4, metaSend: meta });
  ok(r.ok && r.forwarded, JSON.stringify(r));
  eq(ga4.calls.length, 1, "ga4 once");
  eq(meta.calls.length, 1, "meta once");
  eq(ga4.calls[0].client_id, "111.222", "ga4 client id");
  eq(ga4.calls[0].events[0].name, "view_item", "ga4 name");
  eq(meta.calls[0].data[0].event_name, "ViewContent", "meta standard-event mapping");
  eq(meta.calls[0].data[0].event_id, "evt-fwd", "meta dedup id");
  eq(meta.calls[0].data[0].user_data.fbp, "fb.1.1.99", "meta fbp");
  const e = await row("evt-fwd");
  eq(e.status, "forwarded", "forwarded");
  ok(e.ga4_sent_at && e.meta_sent_at, "sent_ats");
});

await t("event-name specifics: purchase transaction_id, search terms, list params", async () => {
  await E.storeEvent({ eventId: "BL-P1", name: "purchase", clientId: "1.2", payload: { value: 999, currency: "INR" } });
  await E.storeEvent({ eventId: "evt-s1", name: "search", clientId: "1.2", payload: { params: { search_term: "whey", results: 12 } } });
  await E.storeEvent({ eventId: "evt-l1", name: "view_item_list", clientId: "1.2", payload: { params: { item_list_id: "bcaa", item_list_name: "BCAA" } } });
  const ga4 = sender();
  const meta = sender();
  for (const id of ["BL-P1", "evt-s1", "evt-l1"]) await E.forwardEventById(id, { ga4Send: ga4, metaSend: meta });
  eq(ga4.calls[0].events[0].params.transaction_id, "BL-P1", "purchase transaction_id");
  eq(ga4.calls[1].events[0].params.search_term, "whey", "ga4 search_term");
  eq(meta.calls[1].data[0].custom_data.search_string, "whey", "meta search_string");
  eq(meta.calls[1].data[0].event_name, "Search", "meta Search");
  eq(ga4.calls[2].events[0].params.item_list_id, "bcaa", "list id");
  eq(meta.calls[2].data[0].event_name, "ViewItemList", "meta custom list event");
});

await t("partial outage: failed destination retries, sent one does NOT re-send", async () => {
  await store({ eventId: "evt-partial" });
  const ga4 = sender();
  const meta = sender({ failures: 1 });
  const r1 = await E.forwardEventById("evt-partial", { ga4Send: ga4, metaSend: meta });
  eq(r1.ok, false, "first pass fails");
  let e = await row("evt-partial");
  eq(e.status, "pending", "still pending");
  ok(e.ga4_sent_at && !e.meta_sent_at, "ga4 done, meta not");
  ok(e.last_error.includes("meta:"), "error names the destination");
  const r2 = await E.forwardEventById("evt-partial", { ga4Send: ga4, metaSend: meta });
  ok(r2.ok && r2.forwarded, "second pass completes");
  eq(ga4.calls.length, 1, "GA4 sent exactly once across retries");
  eq(meta.calls.length, 1, "Meta sent exactly once");
});

// --- outage → replay (the done-when core) -----------------------------------
await t("simulated FULL outage: events survive, then replay on recovery", async () => {
  const ids = ["evt-o1", "evt-o2", "evt-o3"];
  for (const id of ids) await store({ eventId: id });
  const down = sender({ failures: Infinity });
  const s1 = await E.runEventSweep({ ga4Send: down, metaSend: down });
  ok(s1.failed >= 3, `outage sweep failed ${s1.failed}`);
  for (const id of ids) {
    const e = await row(id);
    eq(e.status, "pending", `${id} survives`);
    eq(e.attempts, 1, `${id} attempt counted`);
    ok(JSON.parse(e.payload).value === 4949, `${id} payload intact`);
  }
  await new Promise((r) => setTimeout(r, 10)); // clear 1ms backoff
  const ga4 = sender();
  const meta = sender();
  const s2 = await E.runEventSweep({ ga4Send: ga4, metaSend: meta });
  ok(s2.forwarded >= 3, `recovery forwarded ${s2.forwarded}`);
  for (const id of ids) eq((await row(id)).status, "forwarded", `${id} replayed`);
  eq(ga4.calls.filter((c) => ids.includes(c.events ? c.events[0]?.params?.transaction_id : "")).length, 0, "sanity");
  eq(ga4.calls.length >= 3, true, "each event forwarded once on recovery");
});

await t("backoff gates retries until due", async () => {
  await store({ eventId: "evt-backoff" });
  const down = sender({ failures: Infinity });
  await E.runEventSweep({ ga4Send: down, metaSend: down });
  process.env.EVENTS_BACKOFF_MS = String(10 * 60_000);
  const s = await E.runEventSweep({ ga4Send: sender(), metaSend: sender() });
  ok(s.deferred >= 1, "deferred while backing off");
  eq((await row("evt-backoff")).attempts, 1, "no early retry");
  process.env.EVENTS_BACKOFF_MS = "1";
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await E.runEventSweep({ ga4Send: sender(), metaSend: sender() });
  ok(s2.forwarded >= 1, "forwarded once due");
});

await t("dead-letter after MAX attempts: one aggregated alert, replayable manually", async () => {
  await store({ eventId: "evt-dead" });
  const before = alerts.length;
  const down = sender({ failures: Infinity });
  for (let i = 0; i < 3; i++) {
    await E.runEventSweep({ ga4Send: down, metaSend: down });
    await new Promise((r) => setTimeout(r, 8));
  }
  const e = await row("evt-dead");
  eq(e.status, "dead", "dead");
  eq(e.attempts, 3, "attempts capped");
  await new Promise((r) => setTimeout(r, 50));
  const mine = alerts.slice(before).filter((a) => a.subject.includes("DEAD-LETTER"));
  ok(mine.length >= 1, "alert fired");
  const s = await E.runEventSweep({ ga4Send: sender(), metaSend: sender() });
  ok(s.dead.some((d) => d.event_id === "evt-dead"), "dead reported every sweep");
  // manual replay path still works — nothing is ever lost
  const r = await E.forwardEventById("evt-dead", { ga4Send: sender(), metaSend: sender() });
  ok(r.ok, "manual replay of a dead event succeeds");
});

// --- purchase identity join -------------------------------------------------
await t("enqueuePurchaseEvent: inherits first-party identity via cart_id, hashes PII", async () => {
  // buyer browsed first: a stored event carries their identity + cart
  await E.storeEvent({
    eventId: "evt-browse",
    name: "begin_checkout",
    clientId: "777.111",
    fbp: "fb.1.7.77",
    gclid: "GCLID77",
    cartId: "cart-join-1",
    url: "http://x/checkout",
    payload: { value: 5947, currency: "INR" },
  });
  const o = await O.createOrder({
    cartId: "cart-join-1",
    cart: {
      items: [{ variantId: "gid://shopify/ProductVariant/45042167054553", productId: "gid://shopify/Product/1", title: "Whey", variantTitle: null, image: null, price: 4949, quantity: 1, lineTotal: 4949, discount: 0 }],
      gifts: [{ variantId: "gid://shopify/ProductVariant/48656508289241", productId: "gid://shopify/Product/3", title: "Shaker", image: null }],
      appliedOffers: [],
      couponStatus: null,
      subtotal: 4949,
      discountTotal: 0,
      total: 4949,
      currency: "INR",
    },
    contact: { email: "test@beastlife.in", phone: "9000000014", name: "Event Join" },
    address: { line1: "14 Pipeline St", city: "Pune", state: "MH", pincode: "411001", country: "India" },
    paymentMethod: "cod",
    idempotencyKey: "events-join-1",
  });
  const r = await E.enqueuePurchaseEvent(o.id);
  ok(r.stored, "stored");
  const e = await row(o.id);
  eq(e.name, "purchase", "purchase");
  eq(e.client_id, "777.111", "client id inherited via cart");
  eq(e.fbp, "fb.1.7.77", "fbp inherited");
  eq(e.gclid, "GCLID77", "gclid inherited");
  eq(e.order_id, o.id, "order linked");
  const p = JSON.parse(e.payload);
  eq(p.value, 4949, "value");
  eq(p.items.length, 2, "items incl gift");
  eq(p.items[1].price, 0, "gift at 0");
  eq(p.user_data.em, T.hashEmail("test@beastlife.in"), "email hashed");
  eq(p.user_data.ph, T.hashPhone("9000000014"), "phone hashed");
  ok(!e.payload.includes("test@beastlife.in"), "raw email NOT stored");
  // browser copy arrives later → dedup, not a second row
  const dup = await E.storeEvent({ eventId: o.id, name: "purchase", clientId: "777.111", payload: { value: 4949 } });
  eq(dup.deduped, true, "browser copy deduped");
  // forwarded with transaction_id = order id
  const ga4 = sender();
  const meta = sender();
  await E.forwardEventById(o.id, { ga4Send: ga4, metaSend: meta });
  eq(ga4.calls[0].events[0].params.transaction_id, o.id, "GA4 transaction_id = order id");
  eq(meta.calls[0].data[0].event_id, o.id, "Meta event_id = order id");
});

// --- id extraction ----------------------------------------------------------
await t("extractTrackingIds + fbc format", async () => {
  const ids = T.extractTrackingIds("https://shop.beastlife.in/?fbclid=ABC123&gclid=XYZ789");
  eq(ids.fbclid, "ABC123", "fbclid");
  eq(ids.gclid, "XYZ789", "gclid");
  ok(/^fb\.1\.\d+\.ABC123$/.test(T.fbcFromFbclid("ABC123")), "fbc format");
  eq(T.extractTrackingIds("not a url").fbclid, null, "garbage safe");
});

await t("store-only mode: no destinations configured → forwarded immediately", async () => {
  const saveG = process.env.GA4_API_SECRET;
  const saveM = process.env.META_CAPI_TOKEN;
  process.env.GA4_API_SECRET = "";
  process.env.META_CAPI_TOKEN = "";
  await store({ eventId: "evt-storeonly" });
  const ga4 = sender();
  const meta = sender();
  const r = await E.forwardEventById("evt-storeonly", { ga4Send: ga4, metaSend: meta });
  ok(r.ok && r.forwarded, "forwarded");
  eq(ga4.calls.length, 0, "no ga4 call");
  eq(meta.calls.length, 0, "no meta call");
  ok((await row("evt-storeonly")).last_error.includes("store-only"), "noted");
  process.env.GA4_API_SECRET = saveG;
  process.env.META_CAPI_TOKEN = saveM;
});

console.log(`\n${pass} passed, ${fail} failed`);
catcher.close();
await rm(join(here, "../.test-events.db"), { force: true });
process.exit(fail ? 1 : 0);
