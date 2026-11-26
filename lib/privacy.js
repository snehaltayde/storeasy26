// Privacy lifecycle (Session 33 / BE18): Shopify's mandatory compliance
// webhooks (customers/data_request, customers/redact, shop/redact) land here
// via the durable inbox, each recorded as a privacy_requests row.
//
//   data_request    → recorded + operator alert (export fulfilment is manual
//                     until MC25/W4 — the alert carries what to pull).
//   customers/redact→ recorded + EXECUTED: order PII scrubbed (money rows and
//                     ids retained — documented retention exception for
//                     financial records), matching event rows deleted
//                     (ip/ua/identity), snapshot contact/address removed.
//                     Idempotent: replays find nothing left to scrub.
//   shop/redact     → recorded + CRITICAL alert; disposing of a whole tenant's
//                     data is a deliberate operator action (BE29 offboarding),
//                     never an automatic delete.
import { sql } from "kysely";
import { db } from "./db.js";
import { newId } from "./platform/sessions.js";
import { sendAlert } from "./alerts.js";
import { audit } from "./platform/audit.js";
import { slog } from "./log.js";
import { e164 } from "./checkout/phone.js";
import { anonymizeSubscriptionsOf } from "./subscriptions/store.js";

const nowIso = () => new Date().toISOString();

async function recordRequest({ kind, email = null, phone = null, customerId = null, shopDomain = null, status = "pending", notes = null }) {
  const id = newId("pr");
  await db
    .insertInto("privacy_requests")
    .values({
      id,
      kind,
      email: email ? String(email).toLowerCase() : null,
      phone,
      customer_id: customerId != null ? String(customerId) : null,
      shop_domain: shopDomain,
      status,
      notes,
      created_at: nowIso(),
    })
    .execute();
  return id;
}

async function completeRequest(id, notes) {
  await db
    .updateTable("privacy_requests")
    .set({ status: "done", notes, completed_at: nowIso() })
    .where("id", "=", id)
    .execute();
}

// Scrub a snapshot JSON of contact/address data, keep the commercial record.
function scrubSnapshot(snapshotJson) {
  try {
    const s = JSON.parse(snapshotJson || "{}");
    delete s.contact;
    delete s.address;
    return JSON.stringify(s);
  } catch {
    return null;
  }
}

// A table this store's schema doesn't have yet is skipped; anything else throws.
const noTable = (err) => {
  if (!/no such table/i.test(String(err?.message || err) + String(err?.cause?.message || ""))) throw err;
};

// Redact one customer's PII across orders + events. Matching is by email
// and/or phone (our orders are guest checkouts — no Shopify customer ids).
// Money/order/sync fields stay; redacted_at marks the rows.
export async function redactCustomer({ email = null, phone = null }) {
  const e = email ? String(email).trim().toLowerCase() : null;
  const p = phone ? String(phone).replace(/\D/g, "").slice(-10) : null;
  if (!e && !p) return { orders: 0, events: 0, skipped: "no identifiers" };

  const rows = await db
    .selectFrom("orders")
    .select(["id", "cart_id", "email", "phone", "snapshot"])
    .where("redacted_at", "is", null)
    .execute();
  const matches = rows.filter((r) => {
    const rp = String(r.phone || "").replace(/\D/g, "").slice(-10);
    return (e && String(r.email || "").toLowerCase() === e) || (p && rp && rp === p);
  });

  let events = 0;
  for (const o of matches) {
    await db
      .updateTable("orders")
      .set({
        email: null,
        phone: null,
        name: null,
        address_line1: null,
        address_line2: null,
        city: null,
        state: null,
        pincode: null,
        country: null,
        snapshot: scrubSnapshot(o.snapshot),
        redacted_at: nowIso(),
        updated_at: nowIso(),
      })
      .where("id", "=", o.id)
      .execute();
    // events carry ip/ua/client identity (+ hashed PII in user_data) — delete
    const byOrder = await db.deleteFrom("events").where("order_id", "=", o.id).execute();
    events += Number(byOrder?.[0]?.numDeletedRows ?? byOrder?.numDeletedRows ?? 0);
    if (o.cart_id) {
      const byCart = await db.deleteFrom("events").where("cart_id", "=", o.cart_id).execute();
      events += Number(byCart?.[0]?.numDeletedRows ?? byCart?.numDeletedRows ?? 0);
    }
  }
  // P8-C: messages sent to this person (order emails, COD codes by email or
  // SMS, any type) keep no address or text. The row stays: the store's send
  // history (and the COD send caps' counts for other people) is unchanged.
  let notifications = 0;
  const to = [e, e164(phone) || (p ? e164(p) : "")].filter(Boolean);
  try {
    const res = await db
      .updateTable("notifications")
      .set({ recipient: "redacted", body: "(removed at the customer's request)" })
      .where(sql`lower(trim(recipient))`, "in", to)
      .execute();
    notifications = Number(res?.[0]?.numUpdatedRows ?? 0);
  } catch (err) {
    noTable(err); // pre-0009 schema
  }
  // S45 (BE30): customer ACCOUNTS for this identity go too — account row,
  // sessions and pending sign-in codes (pre-S45 tenants: tables absent → 0).
  // Only a missing table is skipped; any other error stops here, before the
  // account row goes, so nothing is left behind without its owner.
  let accounts = 0;
  let subscriptions = 0;
  if (e) {
    try {
      const custs = await db.selectFrom("customers").select(["id"]).where("email", "=", e).execute();
      for (const c of custs) {
        await db.deleteFrom("customer_sessions").where("customer_id", "=", c.id).execute();
        // S49 (SF22): the merged wishlist is account data — it goes too
        await db.deleteFrom("customer_wishlists").where("customer_id", "=", c.id).execute().catch(noTable);
        // Phase 8 line 3: saved addresses are account data — a real delete (pre-0037: no table)
        await db.deleteFrom("customer_addresses").where("customer_id", "=", c.id).execute().catch(noTable);
        // Phase 9 line 2 (decision 7): subscriptions are cancelled and keep no link to the person
        subscriptions += await anonymizeSubscriptionsOf(c.id);
        await db.deleteFrom("customers").where("id", "=", c.id).execute();
        accounts += 1;
      }
      await db.deleteFrom("customer_otps").where("email", "=", e).execute();
    } catch (err) {
      noTable(err); // pre-customer-accounts schema
    }
  }
  return { orders: matches.length, events, accounts, notifications, subscriptions };
}

// Router target for the compliance topics (runs inside the tenant context via
// the webhook_apply job, like every other webhook).
export async function handlePrivacyWebhook(topic, payload) {
  const customer = payload?.customer || {};
  const shopDomain = payload?.shop_domain || null;

  if (topic === "customers/data_request") {
    const id = await recordRequest({
      kind: "data_request",
      email: customer.email,
      phone: customer.phone,
      customerId: customer.id,
      shopDomain,
      status: "manual",
      notes: `orders_requested: ${JSON.stringify(payload?.orders_requested || [])}`,
    });
    await sendAlert(
      "Privacy DATA REQUEST received — compile and send this customer's data (manual until the MC25 console lands)",
      { request: id, runbook: "orders + events rows for the identifiers on the privacy_requests row, plus the account's customers, customer_wishlists and customer_addresses rows" },
      { severity: "warn" },
    );
    slog("privacy_data_request", { request: id });
    return { recorded: id, manual: true };
  }

  if (topic === "customers/redact") {
    const id = await recordRequest({
      kind: "customer_redact",
      email: customer.email,
      phone: customer.phone,
      customerId: customer.id,
      shopDomain,
    });
    const result = await redactCustomer({ email: customer.email, phone: customer.phone });
    await completeRequest(id, `redacted orders: ${result.orders}, events deleted: ${result.events}`);
    await audit({
      actor: { kind: "system", id: "shopify-webhook" },
      action: "privacy.customer_redact",
      resource: `privacy:${id}`,
      diff: { orders: result.orders, events: result.events },
    });
    slog("privacy_customer_redacted", { request: id, ...result });
    return { recorded: id, ...result };
  }

  if (topic === "shop/redact") {
    const id = await recordRequest({ kind: "shop_redact", shopDomain, status: "manual" });
    await sendAlert(
      `Privacy SHOP REDACT received for ${shopDomain} — tenant data disposal is a deliberate operator action (offboarding runbook), not automatic`,
      { request: id },
      { severity: "critical" },
    );
    slog("privacy_shop_redact", { request: id, shop: shopDomain });
    return { recorded: id, manual: true };
  }

  return { unhandled: topic };
}

export async function listPrivacyRequests({ limit = 50 } = {}) {
  const rows = await db
    .selectFrom("privacy_requests")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(Math.min(Number(limit) || 50, 200))
    .execute();
  return rows.map((r) => ({ ...r }));
}
