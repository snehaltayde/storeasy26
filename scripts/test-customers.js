// Customer-accounts suite (Session 45 / BE30 + SF10–12): OTP lifecycle
// (hashing, expiry, attempt caps, resend caps), verified-email order
// claiming, revocable sessions, cross-store same-email ISOLATION, profile
// validation, ownership-scoped order reads, reorder revalidation matrix,
// safe return paths, and privacy-redaction of accounts.
//   pnpm test:customers
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.RESEND_API_KEY = ""; // OTP mail = labeled dev mock
process.env.DATABASE_URL = "file:.test-cust-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cust-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-cust-default.db", ".test-cust-platform.db", ".test-cust-a.db", ".test-cust-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const K = await import("../lib/customers.js");
const { redactCustomer } = await import("../lib/privacy.js");
const { runDueJobs } = await import("../lib/platform/worker.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
for (const [id, file] of [["ca", ".test-cust-a.db"], ["cb", ".test-cust-b.db"]]) {
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-secret` } });
}
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const id of ["ca", "cb"]) {
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inA = async (fn) => withTenant(await C.getTenant("ca"), fn);
const inB = async (fn) => withTenant(await C.getTenant("cb"), fn);

// guest orders in both tenants with the SAME email + catalog rows for reorder
const EMAIL = "pat@shopper.test";
for (const [run, tag, total] of [[inA, "A", 1500], [inB, "B", 900]]) {
  await run(async () => {
    await libsql.execute({
      sql: "INSERT INTO products (id, handle, title, available, currency, price_min) VALUES ('gid://p/1','whey','Whey',1,'INR',1000)",
      args: [],
    });
    await libsql.execute("INSERT INTO variants (id, product_id, title, price, available, position) VALUES ('gid://v/1','gid://p/1','1kg', 1000, 1, 0)");
    await libsql.execute("INSERT INTO variants (id, product_id, title, price, available, position) VALUES ('gid://v/2','gid://p/1','2kg', 1800, 0, 1)");
    const snap = JSON.stringify({ items: [
      { variantId: "gid://v/1", title: "Whey 1kg", quantity: 2, price: 900, lineTotal: 1800 },
      { variantId: "gid://v/2", title: "Whey 2kg", quantity: 1, price: 1700, lineTotal: 1700 },
      { variantId: "gid://v/gone", title: "Discontinued", quantity: 1, price: 500, lineTotal: 500 },
    ] });
    await libsql.execute({
      sql: `INSERT INTO orders (id, email, total, currency, status, snapshot, created_at, updated_at, sync_attempts, refunded_total)
            VALUES (?, ?, ?, 'INR', 'synced', ?, ?, ?, 0, 0)`,
      args: [`O-${tag}`, EMAIL, total, snap, new Date().toISOString(), new Date().toISOString()],
    });
  });
}

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};
const throws = async (fn, re, label = "") => {
  try {
    await fn();
  } catch (e) {
    if (!re.test(e.message)) throw new Error(`${label} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${label} expected a throw`);
};

// read the plaintext code from the queued OTP notification (dev mock)
async function latestCode(run) {
  await runDueJobs({ limit: 10 }).catch(() => {});
  const row = await run(() => db.selectFrom("notifications").select(["subject"]).where("type", "=", "customer_otp").orderBy("created_at", "desc").executeTakeFirst());
  return /(\d{6})/.exec(row.subject)[1];
}

console.log("— OTP lifecycle (BE30)");

let tokenA;

await t("request → verify: code hashed at rest, session minted, orders CLAIMED on verified email", async () => {
  await inA(() => K.requestOtp(EMAIL));
  const otpRow = await inA(() => db.selectFrom("customer_otps").selectAll().executeTakeFirst());
  ok(!/^\d{6}$/.test(otpRow.code_hash), "code not stored in plaintext");
  const code = await latestCode(inA);
  const r = await inA(() => K.verifyOtp(EMAIL, code));
  tokenA = r.token;
  eq(r.customer.email, EMAIL);
  eq(r.claimedOrders, 1, "guest order claimed after verification:");
  const o = await inA(() => db.selectFrom("orders").select(["customer_id"]).where("id", "=", "O-A").executeTakeFirst());
  eq(o.customer_id, r.customer.id, "subject bound:");
});

await t("wrong code burns attempts and locks at 5; a consumed code can't be replayed", async () => {
  await inA(() => K.requestOtp(EMAIL));
  for (let i = 0; i < 5; i++) await throws(() => inA(() => K.verifyOtp(EMAIL, "000000")), /isn't right|Too many/);
  const realCode = await latestCode(inA);
  await throws(() => inA(() => K.verifyOtp(EMAIL, realCode)), /Too many wrong attempts/, "locked:");
});

await t("expired codes refuse; resend capped at 3 active per hour", async () => {
  await inA(() => db.updateTable("customer_otps").set({ consumed_at: new Date().toISOString() }).execute()); // clear actives
  await inA(() => K.requestOtp(EMAIL));
  await inA(() => db.updateTable("customer_otps").set({ expires_at: "2020-01-01T00:00:00Z" }).where("consumed_at", "is", null).execute());
  await throws(() => inA(() => K.verifyOtp(EMAIL, "123456")), /expired/);
  await inA(() => K.requestOtp(EMAIL));
  await inA(() => K.requestOtp(EMAIL));
  // Phase 0 line 3 (finding 5): over the cap answers like a sent code, sends nothing
  const before = (await inA(() => db.selectFrom("customer_otps").selectAll().execute())).length;
  const capped = await inA(() => K.requestOtp(EMAIL));
  eq(capped.capped, true, "resend cap:");
  eq((await inA(() => db.selectFrom("customer_otps").selectAll().execute())).length, before, "no code minted over the cap:");
});

console.log("— sessions + isolation");

await t("session resolves its customer; logout revokes it server-side", async () => {
  const c = await inA(() => K.customerFromToken(tokenA));
  eq(c.email, EMAIL);
  await inA(() => K.revokeCustomerSession(tokenA));
  eq(await inA(() => K.customerFromToken(tokenA)), null, "revoked immediately:");
});

await t("CROSS-STORE same-email isolation: separate accounts, sessions never cross", async () => {
  await inA(() => db.updateTable("customer_otps").set({ consumed_at: new Date().toISOString() }).execute());
  await inA(() => K.requestOtp(EMAIL));
  const codeA2 = await latestCode(inA);
  const rA = await inA(() => K.verifyOtp(EMAIL, codeA2));
  await inB(() => K.requestOtp(EMAIL));
  const codeB = await latestCode(inB);
  const rB = await inB(() => K.verifyOtp(EMAIL, codeB));
  ok(rA.customer.id !== rB.customer.id, "different customer identities per store");
  eq(await inB(() => K.customerFromToken(rA.token)), null, "store A session is NOBODY in store B:");
  eq(await inA(() => K.customerFromToken(rB.token)), null, "and vice versa:");
  eq(rB.claimedOrders, 1, "store B claimed only ITS order:");
  const ordersB = await inB(() => K.customerOrders(rB.customer.id));
  eq(ordersB.length, 1);
  eq(ordersB[0].id, "O-B", "no cross-store order visibility:");
  tokenA = rA.token;
});

console.log("— profile + orders (SF11)");

await t("profile updates validate; order reads are ownership-scoped", async () => {
  const cA = await inA(() => K.customerFromToken(tokenA));
  const updated = await inA(() => K.updateCustomerProfile(cA.id, { name: "Pat S", address: { line1: "12 Lake Rd", city: "Mumbai", pincode: "400001", state: "MH", country: "India" } }));
  eq(updated.name, "Pat S");
  eq(updated.address.city, "Mumbai");
  await throws(() => inA(() => K.updateCustomerProfile(cA.id, { address: { line1: "", city: "", pincode: "" } })), /at least/);
  eq(await inA(() => K.customerOrder(cA.id, "O-B")), null, "someone else's order id = not found:");
  ok(await inA(() => K.customerOrder(cA.id, "O-A")), "own order found");
});

console.log("— reorder with live revalidation (SF12)");

await t("reorder matrix: ok / price_changed / unavailable / missing — all honest", async () => {
  const cA = await inA(() => K.customerFromToken(tokenA));
  const r = await inA(() => K.buildReorder(cA.id, "O-A"));
  const by = Object.fromEntries(r.lines.map((l) => [l.title, l]));
  eq(by["Whey 1kg"].state, "price_changed", "900 → 1000 flagged:");
  eq(by["Whey 1kg"].price_now, 1000);
  eq(by["Whey 2kg"].state, "unavailable", "sold-out variant:");
  eq(by["Discontinued"].state, "missing", "gone from catalog:");
  eq(r.addable, 1, "only the live line is addable:");
  eq(await inA(() => K.buildReorder(cA.id, "O-B")), null, "ownership enforced:");
});

console.log("— safe return paths + redaction");

await t("safe return paths: same-origin storefront paths only", async () => {
  eq(K.safeReturnPath("/account/orders/O-1"), "/account/orders/O-1");
  eq(K.safeReturnPath("//evil.example"), "/account");
  eq(K.safeReturnPath("https://evil.example"), "/account");
  eq(K.safeReturnPath("/api/admin/login"), "/account", "api paths refused:");
  eq(K.safeReturnPath(null), "/account");
});

await t("privacy redaction removes the account, its sessions and codes", async () => {
  const r = await inA(() => redactCustomer({ email: EMAIL }));
  eq(r.accounts, 1, "account scrubbed:");
  eq(await inA(() => K.customerFromToken(tokenA)), null, "session dead with it:");
  eq(Number((await inA(() => db.selectFrom("customer_otps").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst())).n), 0, "codes purged:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
