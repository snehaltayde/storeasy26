// W6 suite (Session 49 / SF22 + MC28): local-first wishlist — explicit merge
// dedupe, cross-store isolation, honest availability states, redaction; and
// bounded automations — validation, conditions, CONSENT on shopper emails,
// frequency caps, quiet hours (merchant-local, wrap-midnight), event
// deduplication on replay, disable-all (incl. no subsequent action), dry
// runs that send nothing, and failed-run retry.
//   pnpm test:w6
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.RESEND_API_KEY = ""; // notifications = labeled dev mock
process.env.DATABASE_URL = "file:.test-w6-default.db";
process.env.PLATFORM_DB_URL = "file:.test-w6-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-w6-default.db", ".test-w6-platform.db", ".test-w6-a.db", ".test-w6-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const W = await import("../lib/wishlist.js");
const M = await import("../lib/automations.js");
const { redactCustomer } = await import("../lib/privacy.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const [id, file] of [["wa", ".test-w6-a.db"], ["wb", ".test-w6-b.db"]]) {
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: { merchant_timezone: "Asia/Kolkata", site: { support_email: "store@wa.test" } }, secrets: { order_link_secret: `${id}-secret` } });
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
    // overlapping handles, DIFFERENT availability per tenant
    await libsql.execute(`INSERT INTO products (id, handle, title, available, currency, price_min) VALUES
      ('gid://p/1','whey','Whey ${id.toUpperCase()}',${id === "wa" ? 1 : 0},'INR',1000),
      ('gid://p/2','shaker','Shaker ${id.toUpperCase()}',1,'INR',300)`);
    await libsql.execute("INSERT INTO customers (id, email, created_at) VALUES ('cus_w','pat@shopper.test',datetime('now'))");
  });
}
const inA = async (fn) => withTenant(await C.getTenant("wa"), fn);
const inB = async (fn) => withTenant(await C.getTenant("wb"), fn);

const CONSENT_YES = JSON.stringify({ v: 2, a: 1, m: 1, at: "2026-10-28T00:00:00Z" });
const CONSENT_NO = JSON.stringify({ v: 2, a: 1, m: 0, at: "2026-10-28T00:00:00Z" });
const mkOrder = (id, { total = 1000, method = "cod", consent = null, email = "pat@shopper.test" } = {}) =>
  libsql.execute({
    sql: "INSERT INTO orders (id, email, total, currency, status, payment_method, snapshot, created_at, updated_at, sync_attempts, refunded_total) VALUES (?,?,?,?,'paid',?,?,datetime('now'),datetime('now'),0,0)",
    args: [id, email, total, "INR", method, JSON.stringify({ consent, items: [] })],
  });
const getOrder = (id) => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirst();

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
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};
const throws = async (fn, part, m = "") => {
  try {
    await fn();
  } catch (e) {
    if (!String(e.message).toLowerCase().includes(part.toLowerCase())) throw new Error(`${m} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${m} expected it to throw "${part}"`);
};

console.log("— wishlist (SF22): local-first, explicit merge, honest states");

await t("input hygiene: junk handles dropped, list capped", async () => {
  const clean = W.cleanWishlistItems([{ handle: "whey" }, { handle: "../etc" }, { handle: "UPPER" }, { handle: "" }, null]);
  eq(clean.length, 2, "whey + lowercased UPPER survive:");
  eq(W.cleanWishlistItems(Array.from({ length: 300 }, (_, i) => ({ handle: `p-${i}` }))).length, 100, "capped at 100:");
});

await t("resolution states: ok, unavailable, gone — nothing hidden", async () => {
  await inB(async () => {
    const r = await W.resolveWishlist([{ handle: "whey" }, { handle: "shaker" }, { handle: "vanished" }]);
    eq(r.find((x) => x.handle === "whey").state, "unavailable", "wb's whey is sold out:");
    eq(r.find((x) => x.handle === "shaker").state, "ok");
    eq(r.find((x) => x.handle === "vanished").state, "gone");
  });
});

await t("explicit merge dedupes by product identity; re-merge adds nothing", async () => {
  await inA(async () => {
    const r1 = await W.mergeWishlist("cus_w", [{ handle: "whey" }, { handle: "whey", variantId: "v2" }, { handle: "shaker" }]);
    eq(r1.added, 2, "whey deduped within the batch:");
    const r2 = await W.mergeWishlist("cus_w", [{ handle: "whey" }]);
    eq(r2.added, 0, "already saved:");
    eq((await W.accountWishlist("cus_w")).length, 2);
  });
});

await t("CROSS-STORE ISOLATION: the same email's lists never meet across tenants", async () => {
  // same email, same handle vocabulary — wb's account list must stay empty
  eq((await inB(() => W.accountWishlist("cus_w"))).length, 0, "wb untouched by wa's merge:");
  await inB(() => W.mergeWishlist("cus_w", [{ handle: "shaker" }]));
  eq((await inA(() => W.accountWishlist("cus_w"))).length, 2, "wa unchanged by wb's merge:");
  eq((await inB(() => W.accountWishlist("cus_w"))).length, 1);
});

await t("remove + clear + redaction (account wishlist is account data)", async () => {
  await inA(async () => {
    await W.removeWishlistItem("cus_w", "shaker");
    eq((await W.accountWishlist("cus_w")).length, 1);
    await redactCustomer({ email: "pat@shopper.test" });
    const n = await db.selectFrom("customer_wishlists").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    eq(Number(n.n), 0, "redaction removed the wishlist:");
  });
});

console.log("— automations (MC28): bounded, consent-checked, capped, deduped");

await t("validation: unknown trigger/action, consent-impossible combo, bad quiet hours", async () => {
  eq(M.validateAutomation({ name: "x", trigger: "price_drop", action: { kind: "notify_merchant", text: "t" } }).ok, false, "unknown trigger:");
  eq(M.validateAutomation({ name: "x", trigger: "order_placed", action: { kind: "run_script", text: "t" } }).ok, false, "unknown action:");
  eq(M.validateAutomation({ name: "x", trigger: "return_requested", action: { kind: "email_customer", text: "t" } }).ok, false, "shopper email needs the order's consent:");
  eq(M.validateAutomation({ name: "x", trigger: "order_placed", action: { kind: "notify_merchant", text: "t" }, quiet_start: "22:00" }).ok, false, "half a quiet window:");
  eq(M.validateAutomation({ name: "x", trigger: "order_placed", action: { kind: "notify_merchant", text: "t" }, quiet_start: "22:00", quiet_end: "08:00" }).ok, true);
});

await t("quiet-hour math: inside, outside, wrap-midnight", async () => {
  ok(M.inQuietHours("23:30", "22:00", "08:00"), "late night inside");
  ok(M.inQuietHours("03:00", "22:00", "08:00"), "early morning inside");
  ok(!M.inQuietHours("12:00", "22:00", "08:00"), "noon outside");
  ok(M.inQuietHours("10:00", "09:00", "11:00"), "simple window inside");
  ok(!M.inQuietHours("11:00", "09:00", "11:00"), "end exclusive");
});

let notifyRule = null;
await t("conditions gate: under-min and wrong-method orders are skipped with reasons", async () => {
  await inA(async () => {
    await M.setAutomationsDisabled(false);
    notifyRule = await M.upsertAutomation({ name: "Big order ping", trigger: "order_placed", conditions: { min_total: 5000, payment_method: "cod" }, action: { kind: "notify_merchant", text: "Big one in" }, cap_per_day: 10 }, { enabled: true });
    await mkOrder("W-SMALL", { total: 100 });
    const r1 = await M.runOne(notifyRule, { key: "order_placed:W-SMALL", order: await getOrder("W-SMALL") });
    eq(r1.status, "skipped");
    ok(r1.reason.includes("under min"), r1.reason);
    await mkOrder("W-RZP", { total: 9000, method: "razorpay" });
    const r2 = await M.runOne(notifyRule, { key: "order_placed:W-RZP", order: await getOrder("W-RZP") });
    ok(r2.reason.includes("payment"), r2.reason);
    await mkOrder("W-BIG", { total: 9000 });
    const r3 = await M.runOne(notifyRule, { key: "order_placed:W-BIG", order: await getOrder("W-BIG") });
    eq(r3.status, "done", r3.reason);
  });
});

await t("DEDUPE: replaying the same event never acts twice", async () => {
  await inA(async () => {
    const r = await M.runOne(notifyRule, { key: "order_placed:W-BIG", order: await getOrder("W-BIG") });
    eq(r.status, "skipped");
    ok(r.deduped, "flagged as duplicate");
    const sent = await db.selectFrom("notifications").select(({ fn }) => fn.countAll().as("n")).where("type", "=", "automation_notify_merchant").executeTakeFirst();
    eq(Number(sent.n), 1, "exactly one notification:");
  });
});

await t("CONSENT: shopper emails send only with marketing consent on THAT order", async () => {
  await inA(async () => {
    const rule = await M.upsertAutomation({ name: "Thanks note", trigger: "order_placed", action: { kind: "email_customer", subject: "Thank you", text: "Thanks for ordering!" }, cap_per_day: 10 }, { enabled: true });
    await mkOrder("W-NOCONSENT", { consent: CONSENT_NO });
    const r1 = await M.runOne(rule, { key: "order_placed:W-NOCONSENT", order: await getOrder("W-NOCONSENT") });
    eq(r1.status, "skipped");
    ok(r1.reason.includes("consent"), r1.reason);
    await mkOrder("W-CONSENT", { consent: CONSENT_YES });
    const r2 = await M.runOne(rule, { key: "order_placed:W-CONSENT", order: await getOrder("W-CONSENT") });
    eq(r2.status, "done", r2.reason);
    const row = await db.selectFrom("notifications").selectAll().where("type", "=", "automation_email_customer").executeTakeFirst();
    eq(row.consent_class, "marketing", "classed as marketing:");
    ok(String(row.consent_ref || "").includes("W-CONSENT"), "consent ref names the order");
  });
});

await t("FREQUENCY CAP: the (cap+1)th send in 24h is skipped", async () => {
  await inA(async () => {
    const rule = await M.upsertAutomation({ name: "Capped ping", trigger: "order_placed", action: { kind: "notify_merchant", text: "ping" }, cap_per_day: 1 }, { enabled: true });
    await mkOrder("W-CAP1");
    await mkOrder("W-CAP2");
    eq((await M.runOne(rule, { key: "order_placed:W-CAP1", order: await getOrder("W-CAP1") })).status, "done");
    const r = await M.runOne(rule, { key: "order_placed:W-CAP2", order: await getOrder("W-CAP2") });
    eq(r.status, "skipped");
    ok(r.reason.includes("cap"), r.reason);
  });
});

await t("QUIET HOURS: events inside the merchant-local window are skipped, stated", async () => {
  await inA(async () => {
    const rule = await M.upsertAutomation({ name: "Daytime only", trigger: "order_placed", action: { kind: "notify_merchant", text: "ping" }, cap_per_day: 10, quiet_start: "00:00", quiet_end: "23:59" }, { enabled: true });
    await mkOrder("W-QUIET");
    const r = await M.runOne(rule, { key: "order_placed:W-QUIET", order: await getOrder("W-QUIET") });
    eq(r.status, "skipped");
    ok(r.reason.includes("quiet hours"), r.reason);
  });
});

await t("DISABLE-ALL: nothing runs, and the event can't fire later either", async () => {
  await inA(async () => {
    await M.setAutomationsDisabled(true);
    await mkOrder("W-KILLED", { total: 9000 });
    const r = await M.runOne(notifyRule, { key: "order_placed:W-KILLED", order: await getOrder("W-KILLED") });
    eq(r.status, "skipped");
    ok(r.reason.includes("disable-all"), r.reason);
    // re-enable: the same event stays consumed — no late surprise send
    await M.setAutomationsDisabled(false);
    const r2 = await M.runOne(notifyRule, { key: "order_placed:W-KILLED", order: await getOrder("W-KILLED") });
    ok(r2.deduped, "no subsequent prohibited action after re-enable");
  });
});

await t("per-rule pause skips; runAutomationsFor only fires enabled rules", async () => {
  await inA(async () => {
    await M.setAutomationEnabled(notifyRule.id, false);
    await mkOrder("W-PAUSED", { total: 9000 });
    const out = await M.runAutomationsFor("order_placed", { key: "order_placed:W-PAUSED", order: await getOrder("W-PAUSED") });
    ok(!out.some((o) => o.rule === notifyRule.id && o.status === "done"), "paused rule did nothing");
    await M.setAutomationEnabled(notifyRule.id, true);
  });
});

await t("DRY RUN: sends nothing, consumes nothing — the real run still works", async () => {
  await inA(async () => {
    await mkOrder("W-DRY", { total: 9000 });
    const before = Number((await db.selectFrom("notifications").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst()).n);
    const d = await M.runOne(notifyRule, { key: "order_placed:W-DRY", order: await getOrder("W-DRY") }, { dryRun: true });
    eq(d.status, "dry_run");
    ok(d.reason.includes("WOULD send"), d.reason);
    const after = Number((await db.selectFrom("notifications").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst()).n);
    eq(after, before, "nothing sent:");
    const real = await M.runOne(notifyRule, { key: "order_placed:W-DRY", order: await getOrder("W-DRY") });
    eq(real.status, "done", "dry run didn't consume the event:");
  });
});

await t("retry diagnostics: a failed run re-executes exactly once", async () => {
  await inA(async () => {
    await mkOrder("W-RETRY", { total: 9000 });
    await db.insertInto("automation_runs").values({ id: "run-failed-1", automation_id: notifyRule.id, event_key: "order_placed:W-RETRY", status: "failed", reason: "simulated provider outage", created_at: new Date().toISOString() }).execute();
    const r = await M.retryRun("run-failed-1");
    eq(r.status, "done", r.reason);
    await throws(() => M.retryRun("run-failed-1"), "not found", "the failed row was replaced:");
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
