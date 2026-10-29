// Authorization + audit suite (Session 27 / BE03+BE16): role matrix,
// requireAdmin gating (role, origin, spoofed tenant), final-owner protection,
// instant revocation, and the append-only redacted audit log.
//   pnpm test:authz
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-authz-default.db";
process.env.PLATFORM_DB_URL = "file:.test-authz-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.ADMIN_PASSWORD = "legacy-env-pass";

const dbs = [".test-authz-default.db", ".test-authz-platform.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const A = await import("../lib/platform/audit.js");
const AUTHZ = await import("../lib/platform/authz.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { requireAdmin } = await import("../lib/admin-auth.js");

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

// --- fixtures ----------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "za", name: "Authz A", domains: ["za.test"], dbUrl: "file:.test-authz-default.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "zb", name: "Authz B", domains: ["zb.test"], dbUrl: "file:.test-authz-default.db", config: {}, secrets: {} });
const ZA = await C.getTenant("za");
const ZB = await C.getTenant("zb");

const ownerU = await I.createUser({ email: "owner@z.test", password: "owner-pass-27" });
const staffU = await I.createUser({ email: "staff@z.test", password: "staff-pass-27" });
const supportU = await I.createUser({ email: "support@z.test", password: "support-pass-27" });
await I.addMembership(ownerU.id, "za", "owner");
await I.addMembership(staffU.id, "za", "staff");
await I.addMembership(supportU.id, "za", "support");

const mkSession = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 60_000 })).token;
const ownerTok = await mkSession(ownerU);
const staffTok = await mkSession(staffU);
const supportTok = await mkSession(supportU);

// fake NextRequest-ish object (admin-auth has no next imports, so this works)
const req = (cookie, headers = {}) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

// --- role matrix ---------------------------------------------------------------
await t("roleAllows matrix: owner all · admin no team.owner · staff no settings/push · support read-only", () => {
  const { roleAllows } = AUTHZ;
  for (const a of ["offers.write", "settings.write", "orders.push", "orders.cancel", "team.manage", "team.owner", "audit.read"]) {
    eq(roleAllows("owner", a), true, `owner ${a}`);
  }
  eq(roleAllows("admin", "team.owner"), false, "admin team.owner");
  eq(roleAllows("admin", "settings.write"), true, "admin settings");
  eq(roleAllows("staff", "offers.write"), true, "staff offers.write");
  eq(roleAllows("staff", "settings.read"), false, "staff settings.read");
  eq(roleAllows("staff", "orders.push"), false, "staff orders.push");
  eq(roleAllows("staff", "orders.cancel"), false, "staff orders.cancel");
  eq(roleAllows("admin", "orders.cancel"), true, "admin orders.cancel");
  // S55: edit ≠ publish — staff draft, admin+ flips live
  eq(roleAllows("staff", "storefront.write"), true, "staff still edits");
  eq(roleAllows("staff", "storefront.publish"), false, "staff cannot publish");
  eq(roleAllows("admin", "storefront.publish"), true, "admin publishes");
  eq(roleAllows("support", "storefront.publish"), false, "support cannot publish");
  eq(roleAllows("staff", "sync.run"), false, "staff sync.run");
  eq(roleAllows("support", "offers.read"), true, "support offers.read");
  eq(roleAllows("support", "offers.write"), false, "support offers.write");
  eq(roleAllows("support", "storefront.write"), false, "support storefront.write");
  eq(roleAllows("nonsense", "offers.read"), false, "unknown role");
});

// --- requireAdmin gating ---------------------------------------------------------
await t("requireAdmin: owner passes write; support 403 on write but passes read", async () => {
  await withTenant(ZA, async () => {
    const a = await requireAdmin(req(ownerTok), "offers.write");
    eq(a.ok, true, "owner write");
    eq(a.actor.role, "owner", "actor role");
    const b = await requireAdmin(req(supportTok), "offers.write");
    eq(b.ok, false, "support write blocked");
    eq(b.status, 403, "403 not 401");
    const c = await requireAdmin(req(supportTok), "offers.read");
    eq(c.ok, true, "support read ok");
  });
});

await t("requireAdmin: staff blocked from settings/orders.push with 403", async () => {
  await withTenant(ZA, async () => {
    eq((await requireAdmin(req(staffTok), "settings.write")).status, 403, "settings.write");
    eq((await requireAdmin(req(staffTok), "orders.push")).status, 403, "orders.push");
    eq((await requireAdmin(req(staffTok), "storefront.write")).ok, true, "storefront.write ok");
  });
});

await t("requireAdmin: cross-origin write 403, read unaffected; no cookie 401", async () => {
  await withTenant(ZA, async () => {
    const evil = { host: "za.test", origin: "https://evil.test" };
    eq((await requireAdmin(req(ownerTok, evil), "offers.write")).status, 403, "cross-origin write");
    eq((await requireAdmin(req(ownerTok, evil), "offers.read")).ok, true, "cross-origin read ok");
    eq((await requireAdmin(req(null), "offers.read")).status, 401, "no cookie");
  });
});

await t("spoofed tenant: a tenant-A session is 401 on tenant B (host context wins)", async () => {
  await withTenant(ZB, async () => {
    eq((await requireAdmin(req(ownerTok), "offers.read")).status, 401, "owner@A on B");
  });
});

await t("instant revocation: removing the membership kills access mid-session", async () => {
  await withTenant(ZA, async () => {
    eq((await requireAdmin(req(staffTok), "offers.read")).ok, true, "before");
    await I.removeMembership(staffU.id, "za");
    eq((await requireAdmin(req(staffTok), "offers.read")).status, 401, "after removal (same open session)");
    await I.addMembership(staffU.id, "za", "staff"); // restore for later tests
  });
});

// --- final-owner protection ------------------------------------------------------
await t("final-owner protection: last owner can't be demoted or removed; second owner unlocks", async () => {
  let threw = null;
  try {
    await I.addMembership(ownerU.id, "za", "admin");
  } catch (e) {
    threw = e;
  }
  ok(threw && /last owner/.test(threw.message), "demote blocked");
  threw = null;
  try {
    await I.removeMembership(ownerU.id, "za");
  } catch (e) {
    threw = e;
  }
  ok(threw && /last owner/.test(threw.message), "removal blocked");
  await I.addMembership(staffU.id, "za", "owner"); // second owner
  await I.addMembership(ownerU.id, "za", "admin"); // demote now allowed
  eq(await S.membershipRole(ownerU.id, "za"), "admin", "demoted");
  await I.addMembership(ownerU.id, "za", "owner"); // restore
  await I.addMembership(staffU.id, "za", "staff"); // restore
});

// --- audit log --------------------------------------------------------------------
await t("audit: rows append with actor/tenant/action; listAudit is tenant-scoped", async () => {
  await A.audit({ actor: { kind: "merchant", id: ownerU.id, role: "owner" }, action: "offers.write", resource: "offer:test1", tenantId: "za" });
  await A.audit({ actor: { kind: "cli", id: "cli" }, action: "team.role_set", tenantId: "zb" });
  const a = await A.listAudit({ tenantId: "za" });
  const b = await A.listAudit({ tenantId: "zb" });
  ok(a.length >= 1 && a.every((r) => r.tenant_id === "za"), "za scoped");
  ok(b.length >= 1 && b.every((r) => r.tenant_id === "zb"), "zb scoped");
  const row = a.find((r) => r.resource === "offer:test1");
  eq(row?.actor, ownerU.id, "actor id");
  eq(row?.actor_kind, "merchant", "actor kind");
});

await t("audit: tenantId defaults to the active context", async () => {
  await withTenant(ZA, () => A.audit({ actor: { kind: "system", id: "test" }, action: "ctx.default" }));
  const rows = await A.listAudit({ tenantId: "za" });
  ok(rows.some((r) => r.action === "ctx.default"), "row landed under za");
});

await t("audit: secret-ish diff keys are redacted; oversize diffs are capped", async () => {
  await A.audit({
    actor: { kind: "system", id: "test" },
    action: "redact.test",
    tenantId: "za",
    diff: { razorpay_key_secret: "SHOULD-NOT-APPEAR", admin_password: "NOPE", nested: { api_token: "NOPE2", fine: "visible" } },
  });
  const row = (await A.listAudit({ tenantId: "za" })).find((r) => r.action === "redact.test");
  ok(row && !row.diff.includes("SHOULD-NOT-APPEAR") && !row.diff.includes("NOPE"), "values gone");
  ok(row.diff.includes("[redacted]") && row.diff.includes("visible"), "redaction markers + benign kept");
  await A.audit({ actor: { kind: "system", id: "test" }, action: "cap.test", tenantId: "za", diff: { big: "x".repeat(5000) } });
  const cap = (await A.listAudit({ tenantId: "za" })).find((r) => r.action === "cap.test");
  ok(cap.diff.length <= 2100 && cap.diff.includes("truncated"), "size cap");
});

await t("audit: append-only — the module exports no update/delete path", () => {
  const exported = Object.keys(A);
  eq(exported.some((k) => /update|delete|remove|purge/i.test(k)), false, `exports: ${exported.join(",")}`);
});

await t("audit: write failure never throws (broken control plane)", async () => {
  process.env.PLATFORM_DB_URL = "file:/nonexistent-dir-authz/x.db";
  C.__resetPlatformClient();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await A.audit({ actor: { kind: "system", id: "test" }, action: "fail.test", tenantId: "za" });
  } finally {
    console.log = orig;
    process.env.PLATFORM_DB_URL = "file:.test-authz-platform.db";
    C.__resetPlatformClient();
  }
  ok(true, "did not throw");
});

// --- bootstrap actor ---------------------------------------------------------------
await t("bootstrap cookie acts as owner on a user-less tenant", async () => {
  await C.upsertTenant({ id: "zc", name: "Authz C", domains: [], dbUrl: "file:.test-authz-default.db", config: {}, secrets: { admin_password: "zc-boot-pass-1" } });
  const ZC = await C.getTenant("zc");
  const { adminSessionToken } = await import("../lib/admin-auth.js");
  await withTenant(ZC, async () => {
    const legacy = await adminSessionToken();
    const a = await requireAdmin(req(legacy), "settings.write");
    eq(a.ok, true, "bootstrap write ok");
    eq(a.actor.kind, "bootstrap", "actor kind");
    eq(a.actor.role, "owner", "acts as owner");
  });
});

// --- S53 (audit A3): membership-lookup failure can NEVER resurrect bootstrap ----
// Runs LAST: it breaks the memberships table on purpose.
await t("fail closed: a membership lookup failure denies the legacy cookie (no bootstrap resurrection)", async () => {
  const { adminSessionToken, adminBootstrapMode } = await import("../lib/admin-auth.js");
  const ZC = await C.getTenant("zc"); // the user-less bootstrap tenant from the previous test
  await withTenant(ZC, async () => {
    const legacy = await adminSessionToken();
    // sanity: bootstrap works while the lookup SUCCEEDS with zero rows
    eq((await requireAdmin(req(legacy), "settings.write")).ok, true, "bootstrap ok pre-outage");
    // simulate the control-plane lookup failing
    await C.platformDb().execute("ALTER TABLE memberships RENAME TO memberships_broken");
    try {
      const denied = await requireAdmin(req(legacy), "settings.write");
      eq(denied.ok, false, "outage must deny");
      eq(await adminBootstrapMode(), false, "bootstrap mode reports closed during outage");
    } finally {
      await C.platformDb().execute("ALTER TABLE memberships_broken RENAME TO memberships");
    }
    eq((await requireAdmin(req(legacy), "settings.write")).ok, true, "bootstrap recovers after outage");
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
