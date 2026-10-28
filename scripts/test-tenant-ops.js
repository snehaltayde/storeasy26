// Tenant-ops suite (Session 43: BE29 export/offboarding, OP12 maintenance +
// incidents, MC21 domain verification, MC23 team flow, MC25/OP11 privacy,
// quirk #9 robots). Two tenants prove other-tenants-untouched.
//   pnpm test:tenant-ops
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-tops-default.db";
process.env.PLATFORM_DB_URL = "file:.test-tops-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-tops-default.db", ".test-tops-platform.db", ".test-tops-a.db", ".test-tops-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const X = await import("../lib/platform/export.js");
const B = await import("../lib/platform/billing.js");
const D = await import("../lib/platform/domains.js");
const I = await import("../lib/platform/identity.js");
const { openIncidentsFor } = await import("../lib/platform/incidents.js");
const { checkoutCapability } = await import("../lib/commerce/adapter.js");
const { redactCustomer, listPrivacyRequests } = await import("../lib/privacy.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
for (const [id, file] of [["ta", ".test-tops-a.db"], ["tb", ".test-tops-b.db"]]) {
  await C.upsertTenant({ id, name: id.toUpperCase(), domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-secret`, admin_password: `${id}-pass`, shopify_admin_token: `${id}-shpat` } });
}
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const id of ["ta", "tb"]) {
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inA = async (fn) => withTenant(await C.getTenant("ta"), fn);
const inB = async (fn) => withTenant(await C.getTenant("tb"), fn);

// fixtures: an order + an offer in each tenant
for (const [run, tag] of [[inA, "A"], [inB, "B"]]) {
  await run(() =>
    libsql.execute({
      sql: "INSERT INTO orders (id, email, phone, name, total, status, snapshot, created_at, updated_at, sync_attempts, refunded_total) VALUES (?,?,?,?, 999, 'synced', '{}', ?, ?, 0, 0)",
      args: [`O-${tag}`, `shopper-${tag}@x.test`, "+91 98765 4321" + (tag === "A" ? "0" : "1"), `Shopper ${tag}`, new Date().toISOString(), new Date().toISOString()],
    }),
  );
  await run(() => libsql.execute({ sql: "INSERT INTO offers (id, type, label, enabled, config, created_at, updated_at) VALUES (?, 'coupon', 'X', 1, '{}', ?, ?)", args: [`of-${tag}`, new Date().toISOString(), new Date().toISOString()] }));
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

console.log("— BE29: export");

await t("export: versioned manifest, real counts, media metadata only, no secrets", async () => {
  const exp = await X.buildTenantExport("ta");
  eq(exp.manifest.export_version, 1);
  eq(exp.manifest.tenant.id, "ta");
  eq(exp.manifest.tables.orders, 1);
  eq(exp.manifest.tables.offers, 1);
  eq(exp.manifest.tables.media_metadata, 0, "media metadata table present:");
  ok(exp.manifest.notes.some((n) => /blobs are NOT/.test(n)), "blob exclusion noted");
  const json = JSON.stringify(exp);
  ok(!json.includes("ta-secret") && !json.includes("ta-pass") && !json.includes("ta-shpat"), "no secrets in the export");
  eq(exp.data.orders[0].email, "shopper-A@x.test", "the tenant's own data IS there (their export)");
  ok(!json.includes("shopper-B@x.test"), "other tenant's data CANNOT appear (separate DB)");
});

await t("export tokens: expiring + tenant-bound + tamper-proof", async () => {
  const tok = await X.mintExportToken("ta");
  eq(await X.verifyExportToken("ta", tok), true);
  eq(await X.verifyExportToken("tb", tok), false, "cross-tenant rejected:");
  eq(await X.verifyExportToken("ta", tok.replace(/.$/, "0")), false, "tampered rejected:");
  const old = await X.mintExportToken("ta", { now: Date.now() - 2 * 60 * 60 * 1000 });
  eq(await X.verifyExportToken("ta", old), false, "expired rejected:");
});

console.log("— BE29: offboarding");

await t("offboard: suspend + key revocation + billing cancel + platform purge; DB and row kept", async () => {
  await B.ensureDefaultPlans();
  await B.startSubscription("ta", "free");
  const { enqueueJob } = await import("../lib/platform/jobs.js");
  await enqueueJob({ type: "noop", tenantId: "ta", payload: {}, idempotencyKey: "ta-j1" });
  await B.recordUsage("ta", "x_per_month", 1, "ta-u1");
  const before = await C.getTenant("ta");

  const r = await X.offboardTenant("ta");
  const after = await C.getTenant("ta");
  eq(after.status, "suspended");
  ok(after.secrets.order_link_secret !== before.secrets.order_link_secret, "order-link secret rotated");
  ok(after.secrets.admin_password !== before.secrets.admin_password, "console password rotated");
  eq(after.secrets.shopify_admin_token, "ta-shpat", "unrelated secrets RETAINED (merge, not wipe)");
  eq((await B.subscriptionFor("ta")).status, "cancelled", "local billing cancelled:");
  const jobs = await C.platformDb().execute({ sql: "SELECT count(*) n FROM jobs WHERE tenant_id = 'ta'", args: [] });
  eq(Number(jobs.rows[0].n), 0, "platform jobs purged:");
  const usage = await C.platformDb().execute("SELECT count(*) n FROM usage_events WHERE tenant_id = 'ta'");
  eq(Number(usage.rows[0].n), 0, "usage purged:");
  ok(r.kept.some((k) => /tenant database/.test(k)), "db kept (export remains possible)");
  // export still works after offboarding
  eq((await X.buildTenantExport("ta")).manifest.tables.orders, 1);
});

await t("other tenants untouched by the offboard", async () => {
  const tb = await C.getTenant("tb");
  eq(tb.status, "active");
  eq(tb.secrets.order_link_secret, "tb-secret", "tb secrets intact:");
  eq((await inB(() => libsql.execute("SELECT count(*) n FROM orders"))).rows[0].n, 1);
});

console.log("— OP12: maintenance + incidents");

await t("maintenance closes checkout with honest copy; off restores it", async () => {
  await C.patchTenant("tb", { config: { maintenance: { enabled: true, message: "Back by 6pm IST" } } });
  const cap = await inB(() => checkoutCapability());
  eq(cap.available, false);
  eq(cap.maintenance, true);
  ok(/nothing was charged/i.test(cap.reason), cap.reason);
  await C.patchTenant("tb", { config: { maintenance: null } });
  eq((await inB(() => checkoutCapability())).available, true, "restored:");
});

await t("incidents: tenant-scoped visibility, public message only, resolved disappears", async () => {
  const db2 = C.platformDb();
  const now = new Date().toISOString();
  await db2.execute({ sql: "INSERT INTO incidents (id, tenant_id, title, internal_note, public_message, status, created_at) VALUES ('inc1', NULL, 'Platform upgrade', 'SECRET-NOTE', 'Brief platform maintenance tonight', 'open', ?)", args: [now] });
  await db2.execute({ sql: "INSERT INTO incidents (id, tenant_id, title, public_message, status, created_at) VALUES ('inc2', 'tb', 'Sync delay', 'Catalog sync is delayed for your store', 'open', ?)", args: [now] });
  await db2.execute({ sql: "INSERT INTO incidents (id, tenant_id, title, public_message, status, created_at) VALUES ('inc3', 'ta', 'Other store issue', 'x', 'open', ?)", args: [now] });
  const forB = await openIncidentsFor("tb");
  eq(forB.length, 2, "platform-wide + own:");
  ok(!forB.some((i) => i.id === "inc3"), "another tenant's incident invisible");
  ok(!JSON.stringify(forB).includes("SECRET-NOTE"), "internal note never serialized");
  await db2.execute("UPDATE incidents SET status = 'resolved' WHERE id = 'inc1'");
  eq((await openIncidentsFor("tb")).length, 1, "resolved disappears:");
});

console.log("— MC21: domains");

await t("merchant verify path: TXT mismatch fails, match verifies; challenge survives re-claim", async () => {
  const claim = await D.claimDomain({ host: "shop.tb.in", tenantId: "tb" });
  ok(claim.txtRecord.value.startsWith("storeasy-verify="), "challenge issued");
  const bad = await D.verifyDomain({ host: "shop.tb.in", lookupTxt: async () => ["storeasy-verify=WRONG"] });
  eq(bad.ok, false, "wrong TXT refused:");
  const again = await D.claimDomain({ host: "shop.tb.in", tenantId: "tb" });
  eq(again.challenge, claim.challenge, "pending challenge stable across re-claim:");
  const good = await D.verifyDomain({ host: "shop.tb.in", lookupTxt: async () => [claim.challenge] });
  eq(good.ok, true);
  const mine = await D.listDomains({ tenantId: "tb" });
  ok(mine.some((d) => d.host === "shop.tb.in" && d.verified_at), "listed verified");
});

console.log("— MC23: team flow");

await t("invite → accept → member listed; role change; last-owner guard", async () => {
  const inv = await I.createInvite({ email: "owner@tb.in", tenantId: "tb", role: "owner", invitedBy: "test" });
  const user = await I.acceptInvite({ token: inv.token, name: "Owner", password: "pw-test-9876", tenantId: "tb" });
  ok(user, "invite accepted");
  const members = await C.platformDb().execute({ sql: "SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = 'tb'", args: [] });
  eq(members.rows[0].role, "owner");
  // sole owner cannot be demoted or removed (identity-layer guard, MC23 surfaces it)
  const uid = (await I.findUserByEmail("owner@tb.in")).id;
  for (const op of [() => I.addMembership(uid, "tb", "staff"), () => I.removeMembership(uid, "tb")]) {
    try {
      await op();
      throw new Error("expected last-owner guard");
    } catch (e) {
      ok(/last owner/.test(e.message), e.message);
    }
  }
  // a second owner unlocks the demotion
  const inv2 = await I.createInvite({ email: "co@tb.in", tenantId: "tb", role: "owner", invitedBy: "test" });
  await I.acceptInvite({ token: inv2.token, name: "Co", password: "pw-test-5432", tenantId: "tb" });
  await I.addMembership(uid, "tb", "admin");
  eq((await C.platformDb().execute({ sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = 'tb'", args: [uid] })).rows[0].role, "admin");
});

console.log("— MC25/OP11: privacy");

await t("manual privacy request → operator-style redact → tracked done, money retained", async () => {
  await inB(() =>
    libsql.execute({
      sql: "INSERT INTO privacy_requests (id, kind, email, status, created_at) VALUES ('pr1', 'customer_redact', 'shopper-B@x.test', 'manual', ?)",
      args: [new Date().toISOString()],
    }),
  );
  const r = await inB(() => redactCustomer({ email: "shopper-B@x.test" }));
  eq(r.orders, 1, "one order redacted:");
  const o = await inB(() => db.selectFrom("orders").selectAll().where("id", "=", "O-B").executeTakeFirst());
  ok(o.redacted_at, "stamped");
  ok(!String(o.email || "").includes("shopper-B"), "email scrubbed");
  eq(Number(o.total), 999, "money row RETAINED:");
  await inB(() => db.updateTable("privacy_requests").set({ status: "done", completed_at: new Date().toISOString() }).where("id", "=", "pr1").execute());
  eq((await inB(() => listPrivacyRequests()))[0].status, "done", "tracked:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
