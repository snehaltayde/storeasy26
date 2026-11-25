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

// P4-LIVEROW: the live product and collection content and the search outbox
// are the store's own (migration 0024); the operator's cutover and reversal
// records are not in this format.
await t("P4-LIVEROW: export includes product_content_live, collection_content_live and search_outbox rows, not the operator's run tables", async () => {
  const at = new Date().toISOString();
  await inB(async () => {
    await libsql.execute({ sql: "INSERT INTO product_content_live (product_id, document_id, version_id, title, badge, published_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["gid://shopify/Product/7", "doc_prod_0000000000000007", "ver_7", "Renamed", "NEW", at] });
    await libsql.execute({ sql: "INSERT INTO collection_content_live (collection_id, document_id, version_id, pinned, layout_template, published_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["gid://shopify/Collection/3", "doc_coll_0000000000000003", "ver_3", JSON.stringify(["gid://shopify/Product/7"]), "sidebar", at] });
    await libsql.execute({ sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) VALUES (?, ?, 'publish', ?, NULL)", args: ["gid://shopify/Product/7", "seven", at] });
    await libsql.execute({ sql: "INSERT INTO cms_migration_runs (id, kind, step, started_at) VALUES ('run_1', 'cutover', 'lock', ?)", args: [at] });
  });
  const exp = await X.buildTenantExport("tb");
  eq(exp.manifest.tables.product_content_live, 1, "product_content_live count:");
  eq(exp.manifest.tables.collection_content_live, 1, "collection_content_live count:");
  eq(exp.manifest.tables.search_outbox, 1, "search_outbox count:");
  eq(exp.data.product_content_live[0].title, "Renamed", "the live title:");
  eq(exp.data.product_content_live[0].badge, "NEW", "the live badge:");
  eq(exp.data.collection_content_live[0].layout_template, "sidebar", "the collection layout:");
  eq(exp.data.collection_content_live[0].pinned, JSON.stringify(["gid://shopify/Product/7"]), "the pins:");
  eq(exp.data.search_outbox[0].handle, "seven", "the outbox handle:");
  ok(!("cms_migration_runs" in exp.manifest.tables) && !("content_live_reversed" in exp.manifest.tables), "operator run tables are not in the export");
  // tenant A has none of B's rows
  const a = await X.buildTenantExport("ta");
  eq(a.manifest.tables.product_content_live, 0, "tenant A live rows:");
});

await t("export tokens: expiring + tenant-bound + tamper-proof", async () => {
  const tok = await X.mintExportToken("ta");
  eq(await X.verifyExportToken("ta", tok), true);
  eq(await X.verifyExportToken("tb", tok), false, "cross-tenant rejected:");
  const flipped = tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0"); // deterministic flip
  eq(await X.verifyExportToken("ta", flipped), false, "tampered rejected:");
  const old = await X.mintExportToken("ta", { now: Date.now() - 2 * 60 * 60 * 1000 });
  eq(await X.verifyExportToken("ta", old), false, "expired rejected:");
});

await t("P3-A export links: migration 0018 is additive; a link is spent once, never by another store, and names its operator", async () => {
  const src = await readFile(join(here, "../migrations/platform/0018_export_links.sql"), "utf8");
  ok(!/\b(DROP|DELETE|UPDATE|ALTER)\b/i.test(src.replace(/--.*$/gm, "")), "nothing destructive");
  const tok = await X.mintExportToken("ta", { operator: { kind: "operator", id: "u_ops" } });
  ok(Math.abs(Number(tok.split(".")[1]) * 1000 - Date.now() - X.EXPORT_LINK_TTL_MS) < 2000, "15 minutes");
  eq(await X.spendExportToken("tb", tok), null, "another store:");
  eq(JSON.stringify(await X.spendExportToken("ta", tok)), JSON.stringify({ operator: { kind: "operator", id: "u_ops" } }), "first use:");
  eq(await X.spendExportToken("ta", tok), null, "second use:");
  eq(await X.verifyExportToken("ta", tok), true, "the signature alone still checks");
});

await t("P3-A export links: rows a day past their end are pruned (on mint and by pruneQueues); newer ones stay", async () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const put = (jti, expires) => C.platformDb().execute({ sql: "INSERT INTO export_links (jti, tenant_id, created_at, expires_at) VALUES (?, 'ta', ?, ?)", args: [jti, expires, expires] });
  const has = async (jti) => (await C.platformDb().execute({ sql: "SELECT 1 FROM export_links WHERE jti = ?", args: [jti] })).rows.length === 1;
  await put("old-mint", ago(25 * 3600_000));
  await put("recent", ago(3600_000));
  await X.mintExportToken("ta");
  eq(await has("old-mint"), false, "a day-old row, after a mint:");
  eq(await has("recent"), true, "an hour-old row stays:");
  await put("old-tick", ago(48 * 3600_000));
  const J = await import("../lib/platform/jobs.js");
  await J.pruneQueues();
  eq(await has("old-tick"), false, "a two-day-old row, after pruneQueues:");
  eq(await has("recent"), true, "an hour-old row stays after pruneQueues:");
  // the query plan on a throwaway connection (an EXPLAIN left open on the shared one blocks later commits)
  const { createClient } = await import("@libsql/client");
  const probe = createClient({ url: process.env.PLATFORM_DB_URL });
  try {
    const plan = (await probe.execute({ sql: "EXPLAIN QUERY PLAN DELETE FROM export_links WHERE expires_at < ?", args: [ago(0)] })).rows.map((r) => String(r.detail)).join(" ");
    ok(/idx_export_links_expires/.test(plan), `the prune uses the index: ${plan}`);
  } finally {
    probe.close();
  }
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
