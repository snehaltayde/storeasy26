// Shopper customer accounts (Session 45 / BE30 + SF10–12). SERVER-ONLY,
// tenant-scoped (every row lives in the tenant's own DB — same-email
// accounts on two stores are different people by construction).
//
// Model: passwordless email OTP. Codes and session tokens are HASHED at
// rest (domain-separated from order proofs). Orders bind to an account ONLY
// at OTP verification of the matching email ("claiming") — a typed-in email
// at checkout proves nothing, so it binds nothing; guest purchase stays
// exactly as it was. Claiming re-runs at every login, which also picks up
// orders placed while logged in (checkout's money path stays untouched).
import { db } from "./db.js";
import { tenantOwnSecret, tenantId } from "./tenant-context.js";
import { slog } from "./log.js";

export const CUSTOMER_COOKIE = "_customer";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_ACTIVE = 3; // unconsumed codes per email per hour
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const nowIso = () => new Date().toISOString();
const rid = (p, n = 9) => `${p}_${Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const normEmail = (e) => String(e || "").trim().toLowerCase();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

function secret() {
  const base = tenantOwnSecret("order_link_secret", "ORDER_LINK_SECRET") || "dev-only-secret";
  return `${base}|customer`;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const timingEq = (a, b) => {
  const A = String(a);
  const B = String(b);
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= (A.charCodeAt(i % A.length) || 0) ^ (B.charCodeAt(i % B.length) || 0);
  return diff === 0;
};

// Safe return paths for post-login redirects (SF10): same-origin path only.
export function safeReturnPath(p, fallback = "/account") {
  const s = String(p || "");
  return /^\/(?!\/)/.test(s) && !s.includes("://") && !s.startsWith("/api/") ? s : fallback;
}

export function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(e));
}

// ---- OTP flow ----------------------------------------------------------------

// Create + queue a sign-in code. The code itself goes ONLY into the email
// (BE23 notification); we return the intent id, never the code.
export async function requestOtp(emailRaw) {
  const email = normEmail(emailRaw);
  if (!validEmail(email)) throw new Error("That email doesn't look right.");
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const active = await db
    .selectFrom("customer_otps")
    .select(({ fn }) => fn.countAll().as("n"))
    .where("email", "=", email)
    .where("created_at", ">", hourAgo)
    .where("consumed_at", "is", null)
    .executeTakeFirst();
  if (Number(active?.n ?? 0) >= OTP_MAX_ACTIVE) {
    throw new Error("Too many codes requested — use the latest one or try again in an hour.");
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const row = {
    id: rid("otp"),
    email,
    code_hash: await sha256(`${code}|${secret()}`),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: 0,
    created_at: nowIso(),
  };
  await db.insertInto("customer_otps").values(row).execute();

  const { notify } = await import("./notifications.js");
  await notify({
    type: "customer_otp",
    to: email,
    subject: `Your sign-in code: ${code}`,
    text: `Your sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email — nothing happens without the code.`,
    idempotencyKey: `otp_${row.id}`,
  });
  slog("customer_otp_requested", { otp: row.id });
  return { id: row.id };
}

// Verify a code → upsert the customer, CLAIM their orders, mint a session.
export async function verifyOtp(emailRaw, code) {
  const email = normEmail(emailRaw);
  const row = await db
    .selectFrom("customer_otps")
    .selectAll()
    .where("email", "=", email)
    .where("consumed_at", "is", null)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!row) throw new Error("No active code — request a new one.");
  if (row.expires_at < nowIso()) throw new Error("That code expired — request a new one.");
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new Error("Too many wrong attempts — request a new code.");
  await db.updateTable("customer_otps").set({ attempts: row.attempts + 1 }).where("id", "=", row.id).execute();
  const ok = timingEq(await sha256(`${String(code || "").trim()}|${secret()}`), row.code_hash);
  if (!ok) throw new Error("That code isn't right — check the email and try again.");
  await db.updateTable("customer_otps").set({ consumed_at: nowIso() }).where("id", "=", row.id).execute();

  let customer = await db.selectFrom("customers").selectAll().where("email", "=", email).executeTakeFirst();
  if (!customer) {
    customer = { id: rid("cus"), email, name: null, phone: null, default_address: null, created_at: nowIso(), last_login_at: nowIso() };
    await db.insertInto("customers").values(customer).execute();
  } else {
    await db.updateTable("customers").set({ last_login_at: nowIso() }).where("id", "=", customer.id).execute();
  }

  // subject binding: the email is VERIFIED now — claim its unclaimed orders
  // (re-runs each login, so orders placed meanwhile get picked up too)
  const claimed = await db
    .updateTable("orders")
    .set({ customer_id: customer.id })
    .where("customer_id", "is", null)
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", email))
    .executeTakeFirst();

  const token = rid("ct", 32);
  await db
    .insertInto("customer_sessions")
    .values({ token_hash: await sha256(`${token}|${secret()}`), customer_id: customer.id, created_at: nowIso(), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() })
    .execute();
  slog("customer_login", { customer: customer.id, claimed: Number(claimed?.numUpdatedRows ?? 0) });
  return { token, customer: shapeCustomer(customer), claimedOrders: Number(claimed?.numUpdatedRows ?? 0) };
}

const shapeCustomer = (c) => ({ id: c.id, email: c.email, name: c.name || "", phone: c.phone || "", address: parse(c.default_address, null) });

export async function customerFromToken(token) {
  if (!token) return null;
  try {
    const s = await db.selectFrom("customer_sessions").selectAll().where("token_hash", "=", await sha256(`${token}|${secret()}`)).executeTakeFirst();
    if (!s || s.revoked_at || s.expires_at < nowIso()) return null;
    const c = await db.selectFrom("customers").selectAll().where("id", "=", s.customer_id).executeTakeFirst();
    return c ? shapeCustomer(c) : null;
  } catch {
    return null; // pre-migration tenant
  }
}

export async function revokeCustomerSession(token) {
  if (!token) return;
  await db.updateTable("customer_sessions").set({ revoked_at: nowIso() }).where("token_hash", "=", await sha256(`${token}|${secret()}`)).execute();
}

export async function updateCustomerProfile(customerId, { name, phone, address }) {
  const patch = {};
  if (name !== undefined) patch.name = String(name || "").trim().slice(0, 120) || null;
  if (phone !== undefined) patch.phone = String(phone || "").trim().slice(0, 20) || null;
  if (address !== undefined) {
    if (address === null) patch.default_address = null;
    else {
      const a = {};
      for (const k of ["line1", "line2", "city", "state", "pincode", "country"]) a[k] = String(address?.[k] || "").trim().slice(0, 200);
      if (!a.line1 || !a.city || !a.pincode) throw new Error("An address needs at least line 1, city and pincode.");
      patch.default_address = JSON.stringify(a);
    }
  }
  await db.updateTable("customers").set(patch).where("id", "=", customerId).execute();
  const c = await db.selectFrom("customers").selectAll().where("id", "=", customerId).executeTakeFirst();
  return shapeCustomer(c);
}

// ---- orders (SF11) -----------------------------------------------------------

export async function customerOrders(customerId, { limit = 25 } = {}) {
  const rows = await db
    .selectFrom("orders")
    .select(["id", "total", "currency", "status", "payment_method", "created_at", "snapshot", "fulfillment_status"])
    .where("customer_id", "=", customerId)
    .orderBy("created_at", "desc")
    .limit(Math.min(limit, 100))
    .execute();
  return rows.map((r) => ({
    id: r.id,
    total: r.total,
    currency: r.currency || "INR",
    status: r.status,
    fulfillment: r.fulfillment_status || null,
    payment_method: r.payment_method,
    created_at: r.created_at,
    items: (parse(r.snapshot, {})?.items || []).map((i) => ({ title: i.title, quantity: i.quantity })),
  }));
}

export async function customerOrder(customerId, orderId) {
  const r = await db.selectFrom("orders").selectAll().where("id", "=", orderId).where("customer_id", "=", customerId).executeTakeFirst();
  return r || null; // ownership enforced in the WHERE — someone else's id is simply not found
}

// ---- reorder with live revalidation (SF12) -----------------------------------

// Rebuild an old order against TODAY's catalog — every line says honestly
// whether it can be re-added as-is, changed price, or is gone.
export async function buildReorder(customerId, orderId) {
  const order = await customerOrder(customerId, orderId);
  if (!order) return null;
  const items = parse(order.snapshot, {})?.items || [];
  const lines = [];
  for (const it of items) {
    const variant = it.variantId
      ? await db.selectFrom("variants").selectAll().where("id", "=", it.variantId).executeTakeFirst()
      : null;
    if (!variant) {
      lines.push({ title: it.title, quantity: it.quantity, state: "missing", note: "no longer in the catalog" });
      continue;
    }
    const product = await db.selectFrom("products").select(["handle", "available"]).where("id", "=", variant.product_id).executeTakeFirst();
    if (!variant.available || !product?.available) {
      lines.push({ title: it.title, variantId: variant.id, quantity: it.quantity, state: "unavailable", note: "currently sold out" });
      continue;
    }
    const then = Number(it.price ?? 0);
    const now = Number(variant.price ?? 0);
    lines.push({
      title: it.title,
      variantId: variant.id,
      handle: product.handle,
      quantity: it.quantity,
      state: then && now !== then ? "price_changed" : "ok",
      price_then: then || null,
      price_now: now,
      ...(then && now !== then ? { note: `was ₹${then}, now ₹${now}` } : {}),
    });
  }
  return {
    order: order.id,
    currency: order.currency || "INR",
    lines,
    addable: lines.filter((l) => l.state === "ok" || l.state === "price_changed").length,
  };
}
