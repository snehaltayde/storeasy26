// Security gate suite (Session 34 / BE34 + OP10): static secret-exposure
// gates over the repo, SSRF/host-parsing rejections, webhook HMAC abuse,
// OAuth state tamper/expiry, and support-grant lifecycle (time-limited,
// reasoned, read-only). Runs as a release gate — any failure blocks a commit.
//   pnpm test:security
import { rm, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-sec-default.db";
process.env.PLATFORM_DB_URL = "file:.test-sec-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-sec-default.db", ".test-sec-platform.db"];
for (const f of dbs) await rm(join(root, f), { force: true });

const C = await import("../lib/platform/control.js");
const { normalizeHost } = await import("../lib/platform/domains.js");
const { verifyWebhookHmac } = await import("../lib/platform/shopify-webhooks.js");
const { signState, verifyState } = await import("../lib/platform/oauth.js");
const S = await import("../lib/platform/support.js");
const { roleAllows } = await import("../lib/platform/authz.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

// control plane: baseline + full ledger (support_grants arrives in 0004)
await C.migratePlatform(await readFile(join(root, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "sec1", name: "Sec One", domains: ["sec1.test"], dbUrl: "file:.test-sec-default.db" });

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
const eq = (a, b, msg = "") => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const throws = async (fn, re) => {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`threw wrong error: ${e.message}`);
    return;
  }
  throw new Error("expected a throw");
};

// ---------- static repo gates ----------
console.log("— static secret-exposure gates");

const tracked = execSync("git ls-files", { cwd: root }).toString().trim().split("\n");

await t("no live credential literals in any tracked file", async () => {
  const sourceish = tracked.filter((f) => /\.(js|jsx|json|sql|md|yml|yaml|css)$/.test(f));
  const bad = [];
  // rzp_live = Razorpay live key, shpat_/shpss_ = Shopify admin token/app secret,
  // AKIA = AWS access key, sk_live = generic live secret key prefix
  const re = /rzp_live_[A-Za-z0-9]|shpat_[a-f0-9]{8}|shpss_[a-f0-9]{8}|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]/;
  for (const f of sourceish) {
    const body = await readFile(join(root, f), "utf8").catch(() => "");
    if (re.test(body)) bad.push(f);
  }
  eq(bad.join(","), "", "live-looking credentials found in:");
});

await t(".env files and *.db files are gitignored (and none tracked)", async () => {
  const gi = await readFile(join(root, ".gitignore"), "utf8");
  if (!/\.env/.test(gi)) throw new Error(".env missing from .gitignore");
  if (!/\*\.db/.test(gi)) throw new Error("*.db missing from .gitignore");
  const leaked = tracked.filter((f) => (/(^|\/)\.env/.test(f) && f !== ".env.example") || f.endsWith(".db"));
  eq(leaked.join(","), "", "tracked env/db files:");
});

await t("no client component imports a server secret accessor", async () => {
  // server-only modules whose import would pull DB clients/secrets into the bundle
  const serverOnly = /from\s+["'][^"']*(lib\/db|lib\/platform\/control|lib\/platform\/identity|lib\/admin\/orders|lib\/secrets|node:crypto)(\.js)?["']/;
  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith(".js")) out.push(p);
    }
    return out;
  };
  const files = [...(await walk("components")), ...(await walk("app"))];
  const bad = [];
  for (const f of files) {
    const body = await readFile(join(root, f), "utf8");
    if (/^\s*["']use client["']/m.test(body) && serverOnly.test(body)) bad.push(f);
  }
  eq(bad.join(","), "", "client components importing server modules:");
});

await t("admin/platform API routes under app/api never read raw process.env secrets into responses", async () => {
  // spot gate: no route returns an env var value directly (JSON.stringify of process.env etc.)
  const bad = [];
  for (const f of tracked.filter((x) => x.startsWith("app/api/") && x.endsWith("route.js"))) {
    const body = await readFile(join(root, f), "utf8");
    if (/JSON\.stringify\(\s*process\.env/.test(body) || /NextResponse\.json\(\s*process\.env/.test(body)) bad.push(f);
  }
  eq(bad.join(","), "", "routes serializing process.env:");
});

// ---------- SSRF / host parsing ----------
console.log("— host parsing (SSRF-shaped inputs rejected)");

await t("normalizeHost rejects path, whitespace, credentials and backslash smuggling", async () => {
  for (const evil of ["evil.com/path", "a b.com", "user@internal", "host\\..evil", "", null]) {
    await throws(() => normalizeHost(evil), /invalid host/);
  }
  eq(normalizeHost("  Shop.Example.COM  "), "shop.example.com", "lowercase+trim:");
});

// ---------- webhook HMAC abuse ----------
console.log("— webhook HMAC");

const secret = "whsec-test";
const body = JSON.stringify({ id: 1, admin_graphql_api_id: "gid://shopify/Product/1" });
const goodMac = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

await t("valid HMAC passes; wrong secret, tampered body, missing header all fail", async () => {
  eq(verifyWebhookHmac(body, goodMac, secret), true, "valid:");
  eq(verifyWebhookHmac(body, goodMac, "other-secret"), false, "wrong secret:");
  eq(verifyWebhookHmac(body + " ", goodMac, secret), false, "tampered body:");
  eq(verifyWebhookHmac(body, null, secret), false, "missing header:");
  eq(verifyWebhookHmac(body, "", secret), false, "empty header:");
  eq(verifyWebhookHmac(body, goodMac, null), false, "missing secret:");
});

await t("length-mismatched forged HMAC fails without throwing (timingSafeEqual guarded)", async () => {
  eq(verifyWebhookHmac(body, "short", secret), false);
  eq(verifyWebhookHmac(body, goodMac + "AAAA", secret), false);
});

// ---------- OAuth state tamper/expiry ----------
console.log("— OAuth state");

await t("state round-trips; tampered signature and payload are rejected", async () => {
  const state = signState("sec1");
  eq(verifyState(state)?.tenantId, "sec1", "round-trip:");
  const [p, sig] = state.split(".");
  eq(verifyState(`${p}.${sig.slice(0, -2)}xx`), null, "tampered sig:");
  const forged = Buffer.from(`other|deadbeef|${Date.now() + 60000}`).toString("base64url");
  eq(verifyState(`${forged}.${sig}`), null, "tampered payload:");
  eq(verifyState("garbage"), null, "garbage:");
  eq(verifyState(""), null, "empty:");
});

await t("expired state is rejected; a different signing secret never verifies", async () => {
  const state = signState("sec1");
  eq(verifyState(state, Date.now() + 11 * 60 * 1000), null, "expired:");
  const old = process.env.PLATFORM_SECRET;
  process.env.PLATFORM_SECRET = "a-completely-different-secret";
  eq(verifyState(state), null, "cross-secret:");
  process.env.PLATFORM_SECRET = old;
});

// ---------- support grants (OP10) ----------
console.log("— support grants");

await t("grant requires a real reason and clamps TTL to 1–72h", async () => {
  await throws(() => S.createSupportGrant({ tenantId: "sec1", reason: "ok" }), /min 5 chars/);
  await throws(() => S.createSupportGrant({ reason: "valid reason" }), /tenantId required/);
  const g = await S.createSupportGrant({ tenantId: "sec1", reason: "debugging sync", hours: 9999, operator: "op-test" });
  const hrs = (new Date(g.expiresAt) - Date.now()) / 3600000;
  if (hrs > 72.1 || hrs < 71.5) throw new Error(`TTL not clamped to 72h (got ${hrs.toFixed(1)}h)`);
  await S.revokeSupportGrant(g.id, { operator: "op-test" });
});

await t("activeSupportGrant: fresh lookup honors expiry and revocation immediately", async () => {
  const g = await S.createSupportGrant({ tenantId: "sec1", reason: "live check", hours: 1, operator: "op-test" });
  eq((await S.activeSupportGrant("sec1"))?.id, g.id, "active:");
  eq(await S.activeSupportGrant("other-tenant"), null, "tenant-scoped:");
  await S.revokeSupportGrant(g.id, { operator: "op-test" });
  eq(await S.activeSupportGrant("sec1"), null, "revoked → gone on next lookup:");
  // force-expire a fresh grant in the DB → also gone (no cache to serve it)
  const g2 = await S.createSupportGrant({ tenantId: "sec1", reason: "expiry check", hours: 1, operator: "op-test" });
  await C.platformDb().execute({
    sql: "UPDATE support_grants SET expires_at = ? WHERE id = ?",
    args: [new Date(Date.now() - 1000).toISOString(), g2.id],
  });
  eq(await S.activeSupportGrant("sec1"), null, "expired → gone:");
});

await t("support role is read-only: every write action denied, reads allowed", async () => {
  for (const action of ["settings.write", "offers.write", "storefront.write", "upsells.write", "orders.push", "sync.run", "settings.read", "team.manage"]) {
    eq(roleAllows("support", action), false, `${action}:`);
  }
  eq(roleAllows("support", "orders.read"), true, "orders.read:");
  eq(roleAllows("support", "offers.read"), true, "offers.read:");
});

await t("grant creation and revocation are audited", async () => {
  const g = await S.createSupportGrant({ tenantId: "sec1", reason: "audit trail check", operator: "op-test" });
  await S.revokeSupportGrant(g.id, { operator: "op-test" });
  const res = await C.platformDb().execute({
    sql: "SELECT action FROM audit_log WHERE resource = ? ORDER BY at",
    args: [`grant:${g.id}`],
  });
  const actions = res.rows.map((r) => r.action).join(",");
  eq(actions, "support.grant_created,support.grant_revoked");
});

console.log(`\nSecurity gate: ${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(root, f), { force: true });
process.exit(fail ? 1 : 0);
