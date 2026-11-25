// A signed-in shopper's saved addresses (Phase 8 line 3, docs/plans/phase-8.md
// decisions 2 and 7). SERVER-ONLY, tenant-scoped. Shopper data with no console
// read: only app/api/account/route.js and the account page read these, and
// scripts/test-addresses.js fails if any admin, operator or app route reaches a
// reader here. Every single-row query is `WHERE customer_id = ? AND id = ?`, so
// another shopper's id is simply not found (the same answer as a missing one).
// Delete is a real delete; order snapshots keep their own copy.
import { db, libsql } from "./db.js";
import { slog } from "./log.js";
import { ShopperError } from "./shopper-errors.js";

export const MAX_ADDRESSES = 10;
export const LABEL_MAX = 30;

const FIELDS = { name: 120, phone: 20, line1: 200, line2: 200, city: 100, state: 100, pincode: 12 };
const REQUIRED = ["name", "line1", "city", "state", "pincode"];
const COLUMNS = ["id", "label", "name", "phone", "line1", "line2", "city", "state", "pincode", "country_code", "is_default", "last_used_at", "created_at"];

const nowIso = () => new Date().toISOString();
const rid = () => `adr_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

const shape = (r) => ({
  id: r.id,
  label: r.label || "",
  name: r.name,
  phone: r.phone,
  line1: r.line1,
  line2: r.line2 || "",
  city: r.city,
  state: r.state,
  pincode: r.pincode,
  country_code: r.country_code,
  is_default: Boolean(r.is_default),
  last_used_at: r.last_used_at || null,
  created_at: r.created_at,
});

// Same rules as checkout (components/checkout/checkoutModel.js addressValid):
// name, line 1, city, state and PIN code filled, a phone of 7 or more characters.
export function validateAddress(input) {
  const a = {};
  for (const [k, max] of Object.entries(FIELDS)) a[k] = clean(input?.[k], max);
  if (REQUIRED.some((k) => !a[k]) || a.phone.length < 7) throw new ShopperError("Fill in your name, phone, address, city, state and PIN code.");
  const label = String(input?.label ?? "").trim();
  if (label.length > LABEL_MAX) throw new ShopperError(`Keep the label to ${LABEL_MAX} characters or fewer.`);
  a.label = label || null;
  const cc = String(input?.country_code || "IN").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new ShopperError("That country doesn't look right.");
  a.country_code = cc;
  return a;
}

// Two addresses are the same when every field but the label matches, ignoring
// case and outer spaces. The same string as 0037's copy builds: SQLite's
// lower() and trim() change only ASCII letters and spaces, so this does too.
const KEY_FIELDS = ["name", "phone", "line1", "line2", "city", "state", "pincode", "country_code"];
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const addressKey = (a) => KEY_FIELDS.map((k) => asciiLower(String(a[k] ?? "").replace(/^ +| +$/g, ""))).join("|");
const isUnique = (e) => /UNIQUE constraint failed/i.test(String(e?.message || e) + String(e?.cause?.message || ""));
const DUPLICATE_EDIT = "You already have this address saved.";

// Default first, then last used, then newest, then insertion order.
export async function listAddresses(customerId) {
  const rows = await db
    .selectFrom("customer_addresses")
    .select(COLUMNS)
    .where("customer_id", "=", customerId)
    .orderBy("is_default", "desc")
    .orderBy((eb) => eb.fn("coalesce", ["last_used_at", eb.val("")]), "desc")
    .orderBy("created_at", "desc")
    .orderBy((eb) => eb.ref("rowid"), "desc")
    .execute();
  return rows.map(shape);
}

async function ownRow(customerId, id) {
  if (!id) return null;
  const r = await db.selectFrom("customer_addresses").select(COLUMNS).where("customer_id", "=", customerId).where("id", "=", String(id)).executeTakeFirst();
  return r || null;
}

// The one default: clear the others and set this one in one batch.
const defaultStatements = (customerId, id, ts) => [
  { sql: "UPDATE customer_addresses SET is_default = 0, updated_at = ? WHERE customer_id = ? AND id <> ? AND is_default = 1", args: [ts, customerId, id] },
  { sql: "UPDATE customer_addresses SET is_default = 1, updated_at = ? WHERE customer_id = ? AND id = ?", args: [ts, customerId, id] },
];

// When the shopper has no default, the first in list order becomes it. One
// statement, so it can't promote a row a parallel delete just removed.
const promoteStatement = (customerId, ts) => ({
  sql: `UPDATE customer_addresses SET is_default = 1, updated_at = ?
        WHERE customer_id = ? AND NOT EXISTS (SELECT 1 FROM customer_addresses WHERE customer_id = ? AND is_default = 1)
          AND id = (SELECT id FROM customer_addresses WHERE customer_id = ? ORDER BY COALESCE(last_used_at, '') DESC, created_at DESC, rowid DESC LIMIT 1)`,
  args: [ts, customerId, customerId, customerId],
});

const COLS = ["id", "customer_id", "label", "name", "phone", "line1", "line2", "city", "state", "pincode", "country_code", "is_default", "last_used_at", "created_at", "updated_at", "address_key"];

// Add (no id) or edit (id). Returns { address, created, duplicate } or null when
// the id isn't this shopper's. An address identical to one already saved is not
// added again: that one comes back (an edit into one is refused). The first
// address becomes the default. The cap and the duplicate check are part of the
// one INSERT, so parallel saves can't pass them together; the unique
// (customer_id, address_key) index backs the duplicate check.
export async function saveAddress(customerId, input) {
  const a = validateAddress(input);
  const k = addressKey(a);
  const ts = nowIso();
  if (input?.id) {
    const row = await ownRow(customerId, input.id);
    if (!row) return null;
    let res;
    try {
      res = await db
        .updateTable("customer_addresses")
        .set({ ...a, address_key: k, updated_at: ts })
        .where("customer_id", "=", customerId)
        .where("id", "=", row.id)
        .executeTakeFirst();
    } catch (e) {
      if (isUnique(e)) throw new ShopperError(DUPLICATE_EDIT);
      throw e;
    }
    if (!Number(res?.numUpdatedRows ?? 0)) return null;
    if (input.makeDefault) await libsql.batch(defaultStatements(customerId, row.id, ts), "write");
    slog("address_saved", { created: false });
    return { address: shape(await ownRow(customerId, row.id)), created: false, duplicate: false };
  }
  const id = rid();
  const values = [id, customerId, a.label, a.name, a.phone, a.line1, a.line2 || null, a.city, a.state, a.pincode, a.country_code, null, ts, ts, k];
  let inserted = 0;
  try {
    const r = await libsql.execute({
      sql: `INSERT INTO customer_addresses (${COLS.join(", ")})
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN EXISTS (SELECT 1 FROM customer_addresses WHERE customer_id = ? AND is_default = 1) THEN 0 ELSE 1 END,
              ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM customer_addresses WHERE customer_id = ?) < ?
              AND NOT EXISTS (SELECT 1 FROM customer_addresses WHERE customer_id = ? AND address_key = ?)`,
      args: [...values.slice(0, 11), customerId, ...values.slice(11), customerId, MAX_ADDRESSES, customerId, k],
    });
    inserted = Number(r.rowsAffected || 0);
  } catch (e) {
    if (!isUnique(e)) throw e;
  }
  if (!inserted) {
    const same = await db.selectFrom("customer_addresses").select(COLUMNS).where("customer_id", "=", customerId).where("address_key", "=", k).executeTakeFirst();
    if (!same) throw new ShopperError(`You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`);
    if (input?.makeDefault && !same.is_default) await libsql.batch(defaultStatements(customerId, same.id, ts), "write");
    return { address: shape(await ownRow(customerId, same.id)), created: false, duplicate: true };
  }
  if (input?.makeDefault) await libsql.batch(defaultStatements(customerId, id, ts), "write");
  slog("address_saved", { created: true });
  return { address: shape(await ownRow(customerId, id)), created: true, duplicate: false };
}

// Returns false when the id isn't this shopper's.
export async function setDefaultAddress(customerId, id) {
  const row = await ownRow(customerId, id);
  if (!row) return false;
  await libsql.batch(defaultStatements(customerId, row.id, nowIso()), "write");
  return true;
}

// A real delete. When the default goes, the next one in list order takes over
// (the delete and the promotion are one batch).
export async function deleteAddress(customerId, id) {
  const row = await ownRow(customerId, id);
  if (!row) return false;
  const [del] = await libsql.batch([{ sql: "DELETE FROM customer_addresses WHERE customer_id = ? AND id = ?", args: [customerId, row.id] }, promoteStatement(customerId, nowIso())], "write");
  return Number(del?.rowsAffected || 0) > 0;
}

// Write-only: stamps last_used_at on this shopper's saved address that matches
// the order's address. Returns nothing.
export async function markAddressUsed(customerId, contact, address) {
  if (!customerId || !address) return;
  // the order carries a country name, not a code: compare every other field
  const want = addressKey({ ...address, name: contact?.name, phone: contact?.phone, country_code: "" });
  const rows = await db.selectFrom("customer_addresses").select(COLUMNS).where("customer_id", "=", customerId).execute();
  const hit = rows.find((r) => addressKey({ ...r, country_code: "" }) === want);
  if (!hit) return;
  await db.updateTable("customer_addresses").set({ last_used_at: nowIso() }).where("customer_id", "=", customerId).where("id", "=", hit.id).execute();
}

// The order hook (lib/orders.js createOrder, new orders only): the signed-in
// shopper comes from the request's _customer cookie, never from the order.
// Outside a request, signed out, or before 0037, it does nothing; it never
// fails an order. `readToken` is for tests.
export async function markOrderAddressUsed(contact, address, { readToken } = {}) {
  try {
    const { customerFromToken, CUSTOMER_COOKIE } = await import("./customers.js");
    let token;
    if (readToken) token = await readToken();
    else {
      const { cookies } = await import("next/headers");
      token = (await cookies()).get(CUSTOMER_COOKIE)?.value;
    }
    const customer = token ? await customerFromToken(token) : null;
    if (customer) await markAddressUsed(customer.id, contact, address);
  } catch {
    // outside a request, or a store before 0037
  }
}
