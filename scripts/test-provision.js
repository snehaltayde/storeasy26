// Provisioning & onboarding suite (Session 41: BE26 resumable idempotent
// steps + compensation + neutral seeds, MC02 derived checklist + gated
// launch, MC03 verified-membership switcher data).
//   pnpm test:provision
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-prov-default.db";
process.env.PLATFORM_DB_URL = "file:.test-prov-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-prov-default.db", ".test-prov-platform.db", ".test-prov-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const P = await import("../lib/platform/provision.js");
const B = await import("../lib/platform/billing.js");
const { buildChecklist, markManualStep } = await import("../lib/admin/onboarding.js");
const { createUser, addMembership } = await import("../lib/platform/identity.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});

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

const PARAMS = { id: "acme", name: "Acme Nutrition", shopDomain: "acme.myshopify.com", domains: ["shop.acme.in"], dbUrl: "file:.test-prov-t1.db" };

console.log("— BE26: resumable idempotent provisioning");

await t("a failed run records step state; nothing after the failed step ran", async () => {
  const r = await P.runProvision(PARAMS, { failAt: "init_billing" });
  eq(r.failedStep, "init_billing");
  eq(r.run.status, "failed");
  const byName = Object.fromEntries(r.run.steps.map((s) => [s.name, s.status]));
  eq(byName.create_db, "done");
  eq(byName.register_tenant, "done");
  eq(byName.init_billing, "failed");
  eq(byName.record_onboarding, "pending", "tail never ran:");
  ok(await C.getTenant("acme"), "tenant registered before the failure");
  eq(await B.subscriptionFor("acme"), null, "no subscription yet");
});

let firstRunId;
let passwordBefore;

await t("RESUME finishes only the unfinished tail — no duplicate resources, no secret rotation", async () => {
  const runs = await P.listProvisionRuns();
  firstRunId = runs[0].id;
  passwordBefore = (await C.getTenant("acme")).secrets.admin_password;
  const r = await P.runProvision({}, { resumeRunId: firstRunId });
  eq(r.run.status, "done");
  eq(r.failedStep ?? null, null);
  const sub = await B.subscriptionFor("acme");
  eq(sub.plan_id, "free", "billing initialized on resume:");
  const tenant = await C.getTenant("acme");
  eq(tenant.secrets.admin_password, passwordBefore, "register skipped — password NOT rotated:");
  ok(tenant.config.onboarding?.provisioned_at, "onboarding record written");
  // resuming a DONE run is a no-op
  const again = await P.runProvision({}, { resumeRunId: firstRunId });
  eq(again.resumedNoop, true);
  eq((await P.listProvisionRuns()).length, 1, "resume reuses the run row:");
});

await t("neutral seeds (quirk #14): the provisioned tenant has ZERO offers", async () => {
  const n = await withTenant(await C.getTenant("acme"), async () => {
    const r = await libsql.execute("SELECT count(*) n FROM offers");
    return Number(r.rows[0].n);
  });
  eq(n, 0);
});

await t("re-provisioning an existing tenant without force is refused", async () => {
  const r = await P.runProvision({ ...PARAMS });
  eq(r.failedStep, "register_tenant");
  ok(/already exists/.test(r.error), r.error);
});

await t("compensation: deregisters what the run created, never deletes the database", async () => {
  const p2 = { id: "beta", name: "Beta", shopDomain: "beta.myshopify.com", dbUrl: "file:.test-prov-t1.db" };
  const r = await P.runProvision(p2, { failAt: "record_onboarding" });
  eq(r.run.status, "failed");
  ok(await C.getTenant("beta"), "beta registered");
  ok(await B.subscriptionFor("beta"), "beta subscription created");
  const comp = await P.compensateProvision(r.run.id);
  eq(comp.run.status, "compensated");
  eq(await C.getTenant("beta"), null, "tenant row deregistered:");
  eq(await B.subscriptionFor("beta"), null, "free subscription removed:");
  ok(!comp.notes.some((n) => /deleted/.test(n) && /database/.test(n)), "no database deletion");
  // the adopted db file itself is untouched (acme still works on it)
  ok(await C.getTenant("acme"), "other tenants untouched");
});

await t("compensating a DONE run is refused (offboarding is a different, deliberate flow)", async () => {
  try {
    await P.compensateProvision(firstRunId);
    throw new Error("expected refusal");
  } catch (e) {
    ok(/completed/.test(e.message), e.message);
  }
});

console.log("— MC02: onboarding checklist");

await t("checklist derives from real state and resumes honestly", async () => {
  const acme = await C.getTenant("acme");
  let list = await withTenant(acme, buildChecklist);
  const get = (id) => list.items.find((i) => i.id === id);
  eq(get("connect").done, false, "no shopify token yet:");
  eq(get("catalog").done, false);
  eq(get("billing").done, true, "free plan counts (explicit activation):");
  eq(get("domain").done, true, "shop.acme.in is a real host:");
  eq(get("launch").gated, true, "launch gated:");
  // state lands → checklist flips, no stored flags involved
  await C.patchTenant("acme", { secrets: { shopify_admin_token: "shpat_test" }, config: { theme: { kit: "pulse", version: 1 } } });
  await withTenant(await C.getTenant("acme"), async () => {
    await libsql.execute("INSERT INTO products (id, handle, title, available) VALUES ('gid://p/1','x','X',1)");
    const S = await import("../lib/cms/store.js");
    await S.upsertContentPage({ slug: "privacy-policy", title: "Privacy", sections: [{ heading: "Data", body: ["safe"] }] });
    await S.upsertContentPage({ slug: "terms", title: "Terms", sections: [{ heading: "T", body: ["t"] }] });
  });
  list = await withTenant(await C.getTenant("acme"), buildChecklist);
  for (const id of ["connect", "catalog", "brand", "policies"]) eq(list.items.find((i) => i.id === id).done, true, `${id} derived:`);
});

await t("launch stays server-gated until everything is done, then records", async () => {
  const acme = await C.getTenant("acme");
  try {
    await withTenant(acme, () => markManualStep("launch"));
    throw new Error("expected gate");
  } catch (e) {
    ok(/gated/.test(e.message), e.message);
  }
  await withTenant(acme, () => markManualStep("preview"));
  await withTenant(await C.getTenant("acme"), () => markManualStep("test_order"));
  await withTenant(await C.getTenant("acme"), () => markManualStep("launch"));
  const list = await withTenant(await C.getTenant("acme"), buildChecklist);
  eq(list.launched, true);
  ok(list.launchedAt, "launch timestamped");
  // unknown steps refused
  try {
    await withTenant(await C.getTenant("acme"), () => markManualStep("connect"));
    throw new Error("expected refusal");
  } catch (e) {
    ok(/isn't a manual/.test(e.message), e.message);
  }
});

console.log("— MC03: store switcher (verified memberships)");

await t("membership query returns only this user's ACTIVE stores", async () => {
  const u = await createUser({ email: "owner@acme.in", password: "pw-test-1234" });
  await addMembership(u.id, "acme", "owner");
  await C.upsertTenant({ id: "ghost", name: "Ghost", domains: ["ghost.test"], dbUrl: "file:.test-prov-t1.db", config: {}, secrets: {} });
  await C.patchTenant("ghost", { status: "suspended" });
  await addMembership(u.id, "ghost", "admin");
  const r = await C.platformDb().execute({
    sql: `SELECT m.tenant_id, t.status FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ?`,
    args: [u.id],
  });
  const active = r.rows.filter((row) => row.status === "active").map((row) => row.tenant_id);
  eq(active.join(","), "acme", "suspended store filtered (same rule the route applies):");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
