// Privacy & consent suite (Session 33 / BE18+SF24+BE20+SF08-full): expiring
// order proofs with legacy cutover, URL/PII scrubbing, purpose-granular
// consent, per-destination forwarding gates, customer redaction, and the
// compliance webhook router.
//   pnpm test:privacy
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-priv-default.db";
process.env.PLATFORM_DB_URL = "file:.test-priv-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
delete process.env.ALERT_WEBHOOK_URL;
process.env.GA4_MP_EVENTS = "purchase,view_item";

const dbs = [".test-priv-default.db", ".test-priv-platform.db", ".test-priv-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const N = await import("../lib/track/names.js");
const O = await import("../lib/orders.js");
const E = await import("../lib/events.js");
const P = await import("../lib/privacy.js");
const W = await import("../lib/platform/shopify-webhooks.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
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
const quiet = async (fn) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

// fixtures: tenant with its own link secret + ga4/meta creds (purpose gating)
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({
  id: "pv",
  name: "Privacy",
  domains: [],
  dbUrl: "file:.test-priv-t1.db",
  config: { ga4_measurement_id: "G-TEST", meta_pixel_id: "11111" },
  secrets: { order_link_secret: "pv-link-secret", ga4_api_secret: "ga4s", meta_capi_token: "metat" },
});
await applyTenantSchema(createClient({ url: "file:.test-priv-t1.db" }));
const PV = await C.getTenant("pv");
const inT = (fn) => withTenant(PV, fn);

// --- SF08 full: expiring proof -----------------------------------------------------
await t("token v2: shape, verify, wrong order, tampered sig", async () => {
  const tok = await inT(() => O.orderStatusToken("BL-PRIV1"));
  ok(/^2\.\d+\.[0-9a-f]{20}$/.test(tok), `shape (${tok})`);
  eq(await inT(() => O.verifyOrderStatusToken("BL-PRIV1", tok)), true, "valid");
  eq(await inT(() => O.verifyOrderStatusToken("BL-OTHER9", tok)), false, "wrong order");
  const [v, exp, sig] = tok.split(".");
  eq(await inT(() => O.verifyOrderStatusToken("BL-PRIV1", `${v}.${exp}.${"0".repeat(20)}`)), false, "tampered sig");
  eq(await inT(() => O.verifyOrderStatusToken("BL-PRIV1", `${v}.${Number(exp) + 999}.${sig}`)), false, "tampered exp");
});

await t("token v2 EXPIRES; legacy v1 honored only until the cutover", async () => {
  const past = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const old = await inT(() => O.orderStatusToken("BL-PRIV1", { now: past })); // exp ≈ 10 days ago
  eq(await inT(() => O.verifyOrderStatusToken("BL-PRIV1", old)), false, "expired proof → refused");
  // craft a legacy v1 token exactly as pre-S33 code did
  const legacy = (
    await inT(async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("BL-PRIV1|pv-link-secret"));
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
    })
  );
  eq(await inT(() => O.verifyOrderStatusToken("BL-PRIV1", legacy)), true, "legacy accepted pre-cutover");
  const afterCutoff = Date.parse("2027-02-01T00:00:00Z");
  eq(await inT(() => O.verifyOrderStatusToken("BL-PRIV1", legacy, { now: afterCutoff })), false, "legacy dies at cutover");
});

// --- scrubbing -----------------------------------------------------------------------
await t("scrubTrackingUrl strips proof tokens, keeps everything else", () => {
  eq(
    N.scrubTrackingUrl("https://x.test/orders/BL-1?t=2.123.abc&utm_source=mail"),
    "https://x.test/orders/BL-1?utm_source=mail",
    "t stripped, utm kept",
  );
  eq(N.scrubTrackingUrl("/checkout/confirmation/BL-1?t=abc"), "/checkout/confirmation/BL-1", "relative URL");
  eq(N.scrubTrackingUrl(""), "", "empty passthrough");
});

await t("scrubPiiParams strips email/phone-looking values, keeps benign params", () => {
  const out = N.scrubPiiParams({ coupon: "BEAST10", em: "a@b.com", ph: "call 9876543210 now", qty: 3 });
  eq(out.coupon, "BEAST10", "benign kept");
  eq(out.em, "[pii-stripped]", "email stripped");
  eq(out.ph, "[pii-stripped]", "phone stripped");
  eq(out.qty, 3, "numbers untouched");
});

// --- SF24: consent purposes -----------------------------------------------------------
await t("parseConsent: legacy values, v2 roundtrip, junk", () => {
  eq(N.parseConsent("granted").analytics && N.parseConsent("granted").marketing, true, "legacy granted = both");
  eq(N.parseConsent("denied").analytics || N.parseConsent("denied").marketing, false, "legacy denied = none");
  eq(N.parseConsent(null).known, false, "unset unknown");
  const v2 = N.serializeConsent({ analytics: true, marketing: false });
  const c = N.parseConsent(v2);
  eq(c.version, 2, "v2");
  eq(c.analytics, true, "analytics");
  eq(c.marketing, false, "marketing");
  ok(c.at, "timestamped");
  eq(N.parseConsent("{bad json").known, false, "junk → no consent");
  eq(N.isConsentGranted(v2), true, "any-purpose gate");
  eq(N.isConsentGranted(N.serializeConsent({ analytics: false, marketing: false })), false, "none → not granted");
});

// --- BE20: stamps + per-destination gating ---------------------------------------------
const analyticsOnly = N.serializeConsent({ analytics: true, marketing: false });
const marketingOnly = N.serializeConsent({ analytics: false, marketing: true });

await t("storeEvent stamps contract_version + consent; event_id dedups to one row", async () => {
  await inT(() => E.storeEvent({ eventId: "ev-1", name: "view_item", consent: analyticsOnly, payload: { value: 1 } }));
  await inT(() => E.storeEvent({ eventId: "ev-1", name: "view_item", consent: analyticsOnly, payload: { value: 1 } }));
  const rows = await inT(() => db.selectFrom("events").selectAll().where("event_id", "=", "ev-1").execute());
  eq(rows.length, 1, "deduped");
  eq(Number(rows[0].contract_version), N.CONSENT_VERSION, "contract stamped");
  eq(N.parseConsent(rows[0].consent).analytics, true, "consent stamped");
});

await t("forwardEvent: analytics-only consent → GA4 fires, Meta is consent-blocked (row still completes)", async () => {
  const calls = { ga4: 0, meta: 0 };
  const row = (await inT(() => db.selectFrom("events").selectAll().where("event_id", "=", "ev-1").execute()))[0];
  const r = await inT(() =>
    E.forwardEvent(row, {
      ga4Send: async () => calls.ga4++,
      metaSend: async () => calls.meta++,
    }),
  );
  eq(calls.ga4, 1, "GA4 sent");
  eq(calls.meta, 0, "Meta never called");
  eq(r.ok, true, "forwarded");
  const after = (await inT(() => db.selectFrom("events").selectAll().where("event_id", "=", "ev-1").execute()))[0];
  eq(after.status, "forwarded", "row complete despite the blocked destination");
  ok(after.ga4_sent_at && !after.meta_sent_at, "sent stamps match purposes");
});

await t("forwardEvent: marketing-only consent → Meta fires, GA4 consent-blocked; legacy null consent → both", async () => {
  await inT(() => E.storeEvent({ eventId: "ev-2", name: "view_item", consent: marketingOnly, payload: {} }));
  const calls = { ga4: 0, meta: 0 };
  const row2 = (await inT(() => db.selectFrom("events").selectAll().where("event_id", "=", "ev-2").execute()))[0];
  await inT(() => E.forwardEvent(row2, { ga4Send: async () => calls.ga4++, metaSend: async () => calls.meta++ }));
  eq(calls.ga4, 0, "GA4 blocked");
  eq(calls.meta, 1, "Meta sent");
  await inT(() => E.storeEvent({ eventId: "ev-3", name: "view_item", payload: {} })); // consent null = pre-v2 row
  const row3 = (await inT(() => db.selectFrom("events").selectAll().where("event_id", "=", "ev-3").execute()))[0];
  const calls3 = { ga4: 0, meta: 0 };
  await inT(() => E.forwardEvent(row3, { ga4Send: async () => calls3.ga4++, metaSend: async () => calls3.meta++ }));
  eq(calls3.ga4 + calls3.meta, 2, "legacy rows forward to both (stored under old all-or-nothing grant)");
});

// --- BE18: redaction + compliance webhooks ----------------------------------------------
await t("redactCustomer: PII gone, money kept, snapshot scrubbed, events deleted, idempotent", async () => {
  await inT(async () => {
    await db
      .insertInto("orders")
      .values({
        id: "BL-REDACT1",
        status: "synced",
        payment_method: "razorpay",
        total: 999,
        currency: "INR",
        cart_id: "cart-red-1",
        email: "gone@example.com",
        phone: "+91 98765 43210",
        name: "Redact Me",
        address_line1: "1 Secret St",
        city: "Pune",
        snapshot: JSON.stringify({ contact: { email: "gone@example.com" }, address: { line1: "1 Secret St" }, items: [{ title: "Tee" }] }),
        created_at: new Date().toISOString(),
      })
      .execute();
    await E.storeEvent({ eventId: "ev-red-1", name: "purchase", orderId: "BL-REDACT1", payload: { value: 999 } });
    await E.storeEvent({ eventId: "ev-red-2", name: "add_to_cart", cartId: "cart-red-1", payload: {} });
  });
  const r = await inT(() => P.redactCustomer({ email: "GONE@example.com" }));
  eq(r.orders, 1, "one order matched (case-insensitive)");
  eq(r.events, 2, "events by order + cart deleted");
  const o = await inT(() => db.selectFrom("orders").selectAll().where("id", "=", "BL-REDACT1").executeTakeFirst());
  eq(o.email, null, "email gone");
  eq(o.phone, null, "phone gone");
  eq(o.address_line1, null, "address gone");
  eq(o.total, 999, "money kept");
  ok(o.redacted_at, "marked");
  const snap = JSON.parse(o.snapshot);
  eq(snap.contact, undefined, "snapshot contact gone");
  eq(snap.items[0].title, "Tee", "snapshot commercial record kept");
  const again = await inT(() => P.redactCustomer({ email: "gone@example.com" }));
  eq(again.orders, 0, "idempotent replay");
});

await t("redactCustomer matches by phone digits too", async () => {
  await inT(() =>
    db
      .insertInto("orders")
      .values({ id: "BL-REDACT2", status: "paid", total: 100, phone: "9811122233", email: "other@x.com", created_at: new Date().toISOString() })
      .execute(),
  );
  const r = await inT(() => P.redactCustomer({ phone: "+91-98111-22233" }));
  eq(r.orders, 1, "phone-matched");
});

// Phase 8 line 3: saved addresses are account data; redaction deletes them.
await t("redactCustomer deletes the account's saved addresses (a real delete), and no one else's", async () => {
  const now = new Date().toISOString();
  const addr = (id, cus) => ({ id, customer_id: cus, name: "N", phone: "9811100001", line1: `${id} line`, city: "Pune", state: "MH", pincode: "411001", is_default: 1, created_at: now, updated_at: now, address_key: `${id}-key` });
  await inT(async () => {
    await db.insertInto("customers").values([{ id: "cus_redadr", email: "adr@x.com", created_at: now, last_login_at: now }, { id: "cus_keepadr", email: "keep@x.com", created_at: now, last_login_at: now }]).execute();
    await db.insertInto("customer_addresses").values([addr("adr_red1", "cus_redadr"), addr("adr_red2", "cus_redadr"), addr("adr_keep", "cus_keepadr")]).execute();
  });
  await inT(() => P.redactCustomer({ email: "ADR@x.com" }));
  const left = await inT(() => db.selectFrom("customer_addresses").select(["id"]).orderBy("id").execute());
  eq(JSON.stringify(left.map((r) => r.id)), JSON.stringify(["adr_keep"]), "only the other account's address is left");
});

await t("redactCustomer: a real error deleting addresses stops before the account row goes (only a missing table is skipped)", async () => {
  const now = new Date().toISOString();
  await inT(async () => {
    await db.insertInto("customers").values({ id: "cus_trig", email: "trig@x.com", created_at: now, last_login_at: now }).execute();
    await db.insertInto("customer_addresses").values({ id: "adr_trig", customer_id: "cus_trig", name: "N", phone: "9811100001", line1: "t", city: "Pune", state: "MH", pincode: "411001", is_default: 1, created_at: now, updated_at: now, address_key: "trig" }).execute();
  });
  const raw = createClient({ url: "file:.test-priv-t1.db" });
  await raw.execute("CREATE TRIGGER no_adr_delete BEFORE DELETE ON customer_addresses BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const err = await inT(() => P.redactCustomer({ email: "trig@x.com" })).then(() => null, (e) => e);
  await raw.execute("DROP TRIGGER no_adr_delete");
  ok(err && /disk full/.test(String(err.message) + String(err.cause?.message || "")), `the error surfaces: ${err?.message}`);
  const left = await inT(() => db.selectFrom("customers").select(["id"]).where("id", "=", "cus_trig").execute());
  eq(left.length, 1, "the account row is kept, so the addresses aren't orphaned");
  await inT(() => P.redactCustomer({ email: "trig@x.com" }));
  raw.close();
});

await t("compliance router: data_request → manual+alert; customers/redact executes; shop/redact → critical manual", async () => {
  const dr = await quiet(() => inT(() => W.applyWebhook("customers/data_request", { shop_domain: "s.myshopify.com", customer: { email: "dr@x.com" }, orders_requested: [1] })));
  ok(dr.recorded && dr.manual, "data_request recorded manual");
  await inT(() =>
    db.insertInto("orders").values({ id: "BL-REDACT3", status: "paid", total: 50, email: "wh@x.com", created_at: new Date().toISOString() }).execute(),
  );
  const cr = await quiet(() => inT(() => W.applyWebhook("customers/redact", { shop_domain: "s.myshopify.com", customer: { email: "wh@x.com" } })));
  eq(cr.orders, 1, "redact executed via webhook");
  const sr = await quiet(() => inT(() => W.applyWebhook("shop/redact", { shop_domain: "s.myshopify.com" })));
  ok(sr.recorded && sr.manual, "shop redact recorded manual");
  const reqs = await inT(() => P.listPrivacyRequests());
  eq(reqs.length, 3, "three request rows");
  eq(reqs.find((r) => r.kind === "customer_redact")?.status, "done", "redact completed");
  eq(reqs.find((r) => r.kind === "data_request")?.status, "manual", "data request pending manual");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
