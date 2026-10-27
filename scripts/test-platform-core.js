// W1-core suite (Session 28 / BE13+BE17+BE12): key-versioned secret envelopes
// with dual-read rotation, the checksummed migration ledger, and the domain
// registry (challenge, takeover block, re-proof, activation into resolution).
//   pnpm test:platform-core
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-core-default.db";
process.env.PLATFORM_DB_URL = "file:.test-core-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "key-one";
delete process.env.PLATFORM_SECRET_NEXT;
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-core-default.db", ".test-core-platform.db", ".test-core-mig-a.db", ".test-core-mig-b.db", ".test-core-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const CR = await import("../lib/platform/crypto.js");
const C = await import("../lib/platform/control.js");
const M = await import("../lib/platform/migrate.js");
const D = await import("../lib/platform/domains.js");
const R = await import("../lib/platform/rotate.js");
const I = await import("../lib/platform/identity.js");
const O = await import("../lib/platform/oauth.js");

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

// control plane via the versioned runner (adoption path exercised below too)
await M.runMigrations(C.platformDb(), await M.loadMigrations("platform"));

// --- BE13: envelopes + rotation -------------------------------------------------
await t("k1 envelope: roundtrip, fingerprint prefix, null passthrough", async () => {
  const ct = await CR.encryptSecret("hello-secret");
  ok(/^k1:[0-9a-f]{8}:/.test(ct), `format (${ct.slice(0, 16)}…)`);
  eq(await CR.decryptSecret(ct), "hello-secret", "roundtrip");
  eq(await CR.encryptSecret(null), null, "null in");
  eq(await CR.decryptSecret(null), null, "null out");
});

await t("legacy (pre-S28, bare base64) blobs still decrypt", async () => {
  // craft a legacy blob exactly as the old code did: base64(iv || ct), key = sha256(secret)
  const te = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", te.encode("key-one"));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode("old-blob"));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  const legacy = btoa(String.fromCharCode(...out));
  eq(await CR.decryptSecret(legacy), "old-blob", "legacy read");
});

await t("dual-read: NEXT writes, both keys read; swap without rotate strands (by design)", async () => {
  const underOld = await CR.encryptSecret("v-old");
  process.env.PLATFORM_SECRET_NEXT = "key-two";
  const underNext = await CR.encryptSecret("v-next");
  ok(underNext.split(":")[1] !== underOld.split(":")[1], "write key switched");
  eq(await CR.decryptSecret(underOld), "v-old", "old key still read (dual)");
  eq(await CR.decryptSecret(underNext), "v-next", "next key read");
  // premature swap WITHOUT running the rotate step: old blobs fail → this is
  // exactly why the CLI exists
  process.env.PLATFORM_SECRET = "key-two";
  delete process.env.PLATFORM_SECRET_NEXT;
  let threw = false;
  try {
    await CR.decryptSecret(underOld);
  } catch {
    threw = true;
  }
  eq(threw, true, "stranded without rotation");
  process.env.PLATFORM_SECRET = "key-one"; // restore
  eq(await CR.decryptSecret(underOld), "v-old", "restored");
});

await t("rotateStoredSecrets: full rotation — swap keys and everything still decrypts", async () => {
  await C.upsertTenant({
    id: "rt",
    name: "Rotate Tenant",
    domains: [],
    dbUrl: "file:.test-core-t1.db",
    dbToken: "tenant-db-token",
    config: {},
    secrets: { razorpay_key_secret: "rzp-secret-value" },
  });
  const user = await I.createUser({ email: "rot@x.test", password: "rotate-pass-1" });
  await I.ensureTotpSecret(user.id);
  // open rotation → rotate → close rotation
  process.env.PLATFORM_SECRET_NEXT = "key-two";
  const s = await R.rotateStoredSecrets();
  ok(s.tenants >= 1, `tenant rows rotated (${s.tenants})`);
  ok(s.users >= 1, `user rows rotated (${s.users})`);
  eq(s.failures.length, 0, "no failures");
  process.env.PLATFORM_SECRET = "key-two";
  delete process.env.PLATFORM_SECRET_NEXT;
  C.__resetPlatformClient(); // drop decrypted tenant cache
  const t2 = await C.getTenant("rt");
  eq(t2.secrets.razorpay_key_secret, "rzp-secret-value", "tenant secrets readable under new key");
  eq(t2.dbToken, "tenant-db-token", "db token readable");
  eq(await I.ensureTotpSecret(user.id), await I.ensureTotpSecret(user.id), "totp secret stable + readable");
  const again = await R.rotateStoredSecrets();
  eq(again.tenants + again.users, 0, "re-run is a no-op");
});

await t("oauth state survives a rotation window (dual-key verify)", async () => {
  // signed under the current key…
  const st1 = O.signState("rt");
  process.env.PLATFORM_SECRET_NEXT = "key-three";
  ok(O.verifyState(st1), "old-key state verifies during rotation");
  const st2 = O.signState("rt"); // signed under NEXT
  ok(O.verifyState(st2), "next-key state verifies");
  delete process.env.PLATFORM_SECRET_NEXT;
  ok(O.verifyState(st1), "old-key state verifies after close");
});

// --- BE17: migration ledger -------------------------------------------------------
await t("runMigrations: baseline + numbered apply once, recorded with checksums", async () => {
  const client = createClient({ url: "file:.test-core-mig-a.db" });
  const migs = await M.loadMigrations("platform");
  ok(migs[0].id === "0001_baseline" && migs.some((m) => m.id === "0002_domains"), "list shape");
  const r1 = await M.runMigrations(client, migs);
  ok(r1.applied.includes("0001_baseline") && r1.applied.includes("0002_domains"), "applied");
  const r2 = await M.runMigrations(client, migs);
  eq(r2.applied.length, 0, "second run applies nothing");
  eq(r2.skipped, migs.length, "all recorded");
  const rows = await client.execute("SELECT id, checksum FROM schema_migrations ORDER BY id");
  ok(rows.rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum)), "checksums recorded");
});

await t("runMigrations: editing an applied migration is a hard error", async () => {
  const client = createClient({ url: "file:.test-core-mig-a.db" });
  const migs = await M.loadMigrations("platform");
  const tampered = migs.map((m) => (m.id === "0002_domains" ? { ...m, sql: m.sql + "\n-- edited", checksum: "f".repeat(64) } : m));
  let threw = null;
  try {
    await M.runMigrations(client, tampered);
  } catch (e) {
    threw = e;
  }
  ok(threw && /was edited after being applied/.test(threw.message), "clear error");
});

await t("runMigrations: a failing file is NOT recorded; the fixed file retries clean", async () => {
  const client = createClient({ url: "file:.test-core-mig-b.db" });
  const base = [{ id: "0001_baseline", sql: "CREATE TABLE IF NOT EXISTS t1 (id TEXT PRIMARY KEY);", checksum: "a".repeat(64) }];
  const bad = [...base, { id: "0002_bad", sql: "CREATE TABLE t2 (id TEXT PRIMARY KEY);\nTHIS IS NOT SQL;", checksum: "b".repeat(64) }];
  let threw = false;
  try {
    await M.runMigrations(client, bad);
  } catch {
    threw = true;
  }
  eq(threw, true, "bad file throws");
  const ledger = await client.execute("SELECT id FROM schema_migrations");
  eq(ledger.rows.some((r) => r.id === "0002_bad"), false, "failure not recorded");
  // fix the file idempotently (t2 may exist from the partial run) and retry
  const fixed = [...base, { id: "0002_bad", sql: "CREATE TABLE IF NOT EXISTS t2 (id TEXT PRIMARY KEY);", checksum: "c".repeat(64) }];
  const r = await M.runMigrations(client, fixed);
  ok(r.applied.includes("0002_bad"), "retry applied");
});

await t("adoption: a pre-ledger database records the baseline as a no-op re-run", async () => {
  const client = createClient({ url: "file:.test-core-t1.db" });
  const migs = await M.loadMigrations("tenant");
  await client.executeMultiple(migs[0].sql); // simulate a pre-S28 DB (raw schema, no ledger)
  const r = await M.runMigrations(client, migs);
  ok(r.applied.includes("0001_baseline"), "baseline adopted");
  const products = await client.execute("SELECT name FROM sqlite_master WHERE name='products'");
  eq(products.rows.length, 1, "schema intact");
});

// --- BE12: domain registry -----------------------------------------------------
await C.upsertTenant({ id: "da", name: "Domain A", domains: ["da.test"], dbUrl: "file:.test-core-t1.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "db2", name: "Domain B", domains: [], dbUrl: "file:.test-core-t1.db", config: {}, secrets: {} });

let firstChallenge;
await t("claim: challenge minted; duplicate claim returns the SAME pending challenge", async () => {
  const r = await D.claimDomain({ host: "Shop.Example.COM", tenantId: "da" });
  eq(r.host, "shop.example.com", "normalized");
  ok(/^storeasy-verify=[0-9a-f]{32}$/.test(r.challenge), "challenge shape");
  eq(r.txtRecord.name, "_storeasy-challenge.shop.example.com", "txt name");
  firstChallenge = r.challenge;
  const again = await D.claimDomain({ host: "shop.example.com", tenantId: "da" });
  eq(again.challenge, firstChallenge, "stable pending challenge");
});

await t("takeover block: another tenant cannot claim a registered host (even unverified)", async () => {
  let threw = null;
  try {
    await D.claimDomain({ host: "shop.example.com", tenantId: "db2" });
  } catch (e) {
    threw = e;
  }
  ok(threw && /registered to tenant "da"/.test(threw.message), "blocked");
});

await t("verify: wrong TXT refused; right TXT verifies + ACTIVATES into host resolution", async () => {
  const wrong = await D.verifyDomain({ host: "shop.example.com", lookupTxt: async () => ["storeasy-verify=nope"] });
  eq(wrong.ok, false, "wrong TXT");
  const right = await D.verifyDomain({ host: "shop.example.com", lookupTxt: async () => ["other-record", firstChallenge] });
  eq(right.ok, true, "verified");
  C.__resetPlatformClient();
  const res = await C.resolveHost("shop.example.com");
  eq(res.outcome, "resolved", "resolves");
  eq(res.tenant?.id, "da", "to the right tenant");
});

await t("primary: flag + config.primary_host (requires verified)", async () => {
  let threw = false;
  try {
    await D.setPrimaryDomain({ host: "unclaimed.example.com" });
  } catch {
    threw = true;
  }
  eq(threw, true, "unclaimed refused");
  await D.setPrimaryDomain({ host: "shop.example.com" });
  C.__resetPlatformClient();
  eq((await C.getTenant("da")).config.primary_host, "shop.example.com", "config mirror");
  const rows = await D.listDomains({ tenantId: "da" });
  eq(Number(rows.find((r) => r.host === "shop.example.com").is_primary), 1, "flag");
});

await t("remove deactivates; re-claim (other tenant) mints a FRESH challenge — no inherited proof", async () => {
  eq(await D.removeDomain({ host: "shop.example.com" }), true, "removed");
  C.__resetPlatformClient();
  eq((await C.resolveHost("shop.example.com")).outcome, "unknown", "no longer resolves");
  const reclaim = await D.claimDomain({ host: "shop.example.com", tenantId: "db2" });
  eq(reclaim.verified, false, "NOT verified");
  ok(reclaim.challenge && reclaim.challenge !== firstChallenge, "fresh challenge");
  await D.removeDomain({ host: "shop.example.com" });
});

await t("preVerified claim (operator-asserted dev host) activates immediately", async () => {
  const r = await D.claimDomain({ host: "db2.localhost:3007", tenantId: "db2", preVerified: true });
  eq(r.verified, true, "verified at claim");
  C.__resetPlatformClient();
  eq((await C.resolveHost("db2.localhost:3007")).tenant?.id, "db2", "resolves");
  await D.removeDomain({ host: "db2.localhost:3007" });
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
