// Identity suite (Session 26 / BE02+MC01+OP01): scrypt, revocable sessions,
// memberships, bootstrap/legacy fallbacks, TOTP, invitations, resets, the
// distributed login throttle, and the origin guard.
//   pnpm test:identity
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// --- env BEFORE imports ------------------------------------------------------
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-identity-default.db";
const GOOD_PLATFORM_URL = "file:.test-identity-platform.db";
process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.ADMIN_PASSWORD = "legacy-env-pass";
process.env.PLATFORM_ADMIN_PASSWORD = "legacy-op-pass";

const dbs = [".test-identity-default.db", ".test-identity-platform.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { verifyAdminToken, adminSessionToken, adminBootstrapMode } = await import("../lib/admin-auth.js");
const { verifyPlatformToken, platformSessionToken } = await import("../lib/platform/admin-auth.js");
const { sameOrigin, requestOrigin } = await import("../lib/origin-check.js");

// --- harness -----------------------------------------------------------------
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixtures ----------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "ia", name: "Store A", domains: ["ia.test"], dbUrl: "file:.test-identity-default.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "ib", name: "Store B", domains: ["ib.test"], dbUrl: "file:.test-identity-default.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "ig", name: "Store G (bootstrap)", domains: [], dbUrl: "file:.test-identity-default.db", config: {}, secrets: { admin_password: "gamma-boot-pass1" } });
const TA = await C.getTenant("ia");
const TG = await C.getTenant("ig");

// --- passwords ---------------------------------------------------------------
await t("scrypt: hash/verify roundtrip, wrong password, distinct salts", async () => {
  const h1 = await I.hashPassword("correct horse battery");
  const h2 = await I.hashPassword("correct horse battery");
  ok(h1.startsWith("scrypt:16384:8:1:"), "format");
  ok(h1 !== h2, "distinct salts");
  eq(await I.verifyPassword("correct horse battery", h1), true, "verify");
  eq(await I.verifyPassword("wrong", h1), false, "wrong pw");
  eq(await I.verifyPassword("x", "garbage"), false, "garbage hash");
});

await t("hashPassword rejects short passwords", async () => {
  let threw = false;
  try {
    await I.hashPassword("short");
  } catch {
    threw = true;
  }
  eq(threw, true);
});

// --- users -------------------------------------------------------------------
let alice;
await t("createUser lowercases email; duplicate email rejected", async () => {
  alice = await I.createUser({ email: "  Alice@Example.COM ", name: "Alice", password: "alice-pass-1" });
  eq(alice.email, "alice@example.com", "lowercased");
  let threw = false;
  try {
    await I.createUser({ email: "alice@example.com", password: "whatever-123" });
  } catch {
    threw = true;
  }
  eq(threw, true, "duplicate");
});

// --- sessions ----------------------------------------------------------------
let aliceToken;
await t("session create/verify; wrong kind and bad token fail", async () => {
  const s = await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: 60_000 });
  aliceToken = s.token;
  const v = await S.verifySession(aliceToken, "merchant");
  eq(v?.userId, alice.id, "verify");
  eq(await S.verifySession(aliceToken, "operator"), null, "wrong kind");
  eq(await S.verifySession("0".repeat(64), "merchant"), null, "bad token");
  eq(await S.verifySession("", "merchant"), null, "empty token");
});

await t("expired session fails", async () => {
  const s = await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: -1000 });
  eq(await S.verifySession(s.token, "merchant"), null);
});

await t("revokeSessionByToken: next lookup fails (revocation is server-side)", async () => {
  const s = await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: 60_000 });
  ok(await S.verifySession(s.token, "merchant"), "live first");
  await S.revokeSessionByToken(s.token);
  eq(await S.verifySession(s.token, "merchant"), null, "dead after revoke");
});

await t("revokeUserSessions kills every session of the user", async () => {
  const s1 = await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: 60_000 });
  const s2 = await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: 60_000 });
  await S.revokeUserSessions(alice.id);
  eq(await S.verifySession(s1.token, "merchant"), null, "s1");
  eq(await S.verifySession(s2.token, "merchant"), null, "s2");
  aliceToken = (await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: 60_000 })).token;
});

await t("disabled user's sessions stop verifying", async () => {
  const bob = await I.createUser({ email: "bob@example.com", password: "bob-pass-123" });
  const s = await S.createSession({ userId: bob.id, kind: "merchant", ttlMs: 60_000 });
  await I.setUserStatus(bob.id, "disabled");
  eq(await S.verifySession(s.token, "merchant"), null);
});

// --- memberships + verifyAdminToken ------------------------------------------
await t("membership: role on A, none on B; tenantHasMembers flips", async () => {
  eq(await S.tenantHasMembers("ia"), false, "before");
  await I.addMembership(alice.id, "ia", "owner");
  eq(await S.membershipRole(alice.id, "ia"), "owner", "role on A");
  eq(await S.membershipRole(alice.id, "ib"), null, "no role on B");
  eq(await S.tenantHasMembers("ia"), true, "after");
});

await t("verifyAdminToken: session+membership on tenant A; same cookie rejected on tenant B", async () => {
  eq(await withTenant(TA, () => verifyAdminToken(aliceToken)), true, "tenant A");
  const TB = await C.getTenant("ib");
  eq(await withTenant(TB, () => verifyAdminToken(aliceToken)), false, "tenant B (no membership)");
});

await t("bootstrap: tenant w/o members accepts the legacy token; first member disables it", async () => {
  const legacy = await withTenant(TG, () => adminSessionToken());
  eq(await withTenant(TG, () => verifyAdminToken(legacy)), true, "bootstrap accepts");
  eq(await withTenant(TG, () => adminBootstrapMode()), true, "bootstrap mode");
  await I.addMembership(alice.id, "ig", "owner");
  eq(await withTenant(TG, () => verifyAdminToken(legacy)), false, "legacy dead after first member");
  eq(await withTenant(TG, () => adminBootstrapMode()), false, "account mode");
  eq(await withTenant(TG, () => verifyAdminToken(aliceToken)), true, "session works instead");
});

await t("legacy single-tenant mode (no PLATFORM_DB_URL): env-password token still works", async () => {
  process.env.PLATFORM_DB_URL = "";
  const legacy = await withTenant(null, () => adminSessionToken());
  eq(await withTenant(null, () => verifyAdminToken(legacy)), true);
  process.env.PLATFORM_DB_URL = GOOD_PLATFORM_URL;
  C.__resetPlatformClient();
});

// --- operator auth -------------------------------------------------------------
await t("operator bootstrap: legacy platform token works only while no operators exist", async () => {
  const legacy = await platformSessionToken();
  eq(await verifyPlatformToken(legacy), true, "bootstrap accepts");
  await I.createOperator({ email: "op@example.com", name: "Op", password: "op-pass-1234" });
  eq(await verifyPlatformToken(legacy), false, "legacy dead after first operator");
});

await t("operator sessions pass; merchant sessions NEVER pass operator routes", async () => {
  const op = await I.findUserByEmail("op@example.com");
  const s = await S.createSession({ userId: op.id, kind: "operator", ttlMs: 60_000 });
  eq(await verifyPlatformToken(s.token), true, "operator session");
  eq(await verifyPlatformToken(aliceToken), false, "merchant session rejected");
  // and a non-operator user can't mint a passing operator session
  const s2 = await S.createSession({ userId: alice.id, kind: "operator", ttlMs: 60_000 });
  eq(await verifyPlatformToken(s2.token), false, "non-operator user rejected");
});

// --- TOTP ----------------------------------------------------------------------
await t("TOTP matches the RFC 6238 SHA-1 vector (T=59s → 94287082)", async () => {
  const secret = I.base32Encode(Buffer.from("12345678901234567890", "ascii"));
  eq(I.totpCode(secret, { t: 59_000, digits: 8 }), "94287082", "vector");
  eq(I.verifyTotp(secret, "94287082", { t: 59_000, digits: 8, window: 0 }), true, "verify exact");
  eq(I.verifyTotp(secret, "94287082", { t: 89_000, digits: 8, window: 1 }), true, "adjacent window");
  eq(I.verifyTotp(secret, "00000000", { t: 59_000, digits: 8 }), false, "wrong code");
  eq(I.verifyTotp(secret, "9428", { t: 59_000, digits: 8 }), false, "short code");
});

await t("ensureTotpSecret persists encrypted + stable; confirmTotp flips the flag", async () => {
  const op = await I.findUserByEmail("op@example.com");
  const s1 = await I.ensureTotpSecret(op.id);
  const s2 = await I.ensureTotpSecret(op.id);
  eq(s1, s2, "stable secret");
  const raw = await I.getUser(op.id);
  ok(raw.totp_enc && !String(raw.totp_enc).includes(s1), "encrypted at rest");
  eq(Number(raw.totp_confirmed), 0, "unconfirmed");
  await I.confirmTotp(op.id);
  eq(Number((await I.getUser(op.id)).totp_confirmed), 1, "confirmed");
});

// --- invitations & resets -------------------------------------------------------
await t("invite: accept creates user+membership; token is single-use", async () => {
  const { token } = await I.createInvite({ email: "carol@example.com", tenantId: "ib", role: "staff" });
  const user = await I.acceptInvite({ token, name: "Carol", password: "carol-pass-1", tenantId: "ib" });
  ok(user, "accepted");
  eq(await S.membershipRole(user.id, "ib"), "staff", "membership");
  eq(await I.acceptInvite({ token, name: "x", password: "xxxxxxxxx", tenantId: "ib" }), null, "single use");
});

await t("invite: wrong-tenant attempt rejected WITHOUT burning the token; expired rejected", async () => {
  const { token } = await I.createInvite({ email: "dave@example.com", tenantId: "ia", role: "staff" });
  eq(await I.acceptInvite({ token, name: "D", password: "dave-pass-12", tenantId: "ib" }), null, "wrong tenant");
  const user = await I.acceptInvite({ token, name: "D", password: "dave-pass-12", tenantId: "ia" });
  ok(user, "still valid on the RIGHT tenant after a wrong-host probe");
  const expired = await I.createInvite({ email: "erin@example.com", tenantId: "ia", ttlMs: -1 });
  eq(await I.acceptInvite({ token: expired.token, name: "E", password: "erin-pass-12", tenantId: "ia" }), null, "expired");
});

await t("reset: sets the new password and revokes every session; single-use", async () => {
  const live = await S.createSession({ userId: alice.id, kind: "merchant", ttlMs: 60_000 });
  const { token } = await I.createInvite({ email: alice.email, tenantId: "ia", kind: "reset", ttlMs: 60_000 });
  const user = await I.acceptReset({ token, password: "alice-new-pass-9" });
  eq(user?.id, alice.id, "right user");
  eq(await S.verifySession(live.token, "merchant"), null, "old session revoked");
  eq(await I.verifyPassword("alice-pass-1", (await I.getUser(alice.id)).password_hash), false, "old pw dead");
  eq(await I.verifyPassword("alice-new-pass-9", (await I.getUser(alice.id)).password_hash), true, "new pw works");
  eq(await I.acceptReset({ token, password: "another-pass-9" }), null, "single use");
});

// --- throttle --------------------------------------------------------------------
await t("login throttle: blocks past the limit, clear unblocks, window resets", async () => {
  for (let i = 0; i < 3; i++) {
    eq((await I.loginThrottle("t:k1", { limit: 3, windowMs: 60_000 })).blocked, false, `attempt ${i + 1}`);
  }
  eq((await I.loginThrottle("t:k1", { limit: 3, windowMs: 60_000 })).blocked, true, "4th blocked");
  await I.clearThrottle("t:k1");
  eq((await I.loginThrottle("t:k1", { limit: 3, windowMs: 60_000 })).blocked, false, "cleared");
  await I.loginThrottle("t:k2", { limit: 1, windowMs: 50 });
  eq((await I.loginThrottle("t:k2", { limit: 1, windowMs: 50 })).blocked, true, "over tiny limit");
  await sleep(80);
  eq((await I.loginThrottle("t:k2", { limit: 1, windowMs: 50 })).blocked, false, "window reset");
});

// --- origin guard -------------------------------------------------------------------
await t("sameOrigin: no header passes, match passes, mismatch/null fail", async () => {
  const req = (headers) => ({ headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  eq(sameOrigin(req({ host: "shop.test" })), true, "no origin");
  eq(sameOrigin(req({ host: "shop.test", origin: "https://shop.test" })), true, "match");
  eq(sameOrigin(req({ host: "Shop.Test", origin: "https://shop.test" })), true, "case-insensitive");
  eq(sameOrigin(req({ host: "shop.test", origin: "https://evil.test" })), false, "mismatch");
  eq(sameOrigin(req({ host: "shop.test", origin: "null" })), false, "opaque origin");
});

await t("requestOrigin: Host header wins over the server bind address (tenant-host redirects stay same-origin)", async () => {
  const req = (headers, url = "http://localhost:3007/api/preview") => ({
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    url,
    nextUrl: new URL(url),
  });
  // The pavos Designer bug: browser on pavos.localhost:3007, server bound to
  // localhost:3007 — the redirect must stay on the browser's origin.
  eq(requestOrigin(req({ host: "pavos.localhost:3007" })), "http://pavos.localhost:3007", "dev tenant host");
  eq(requestOrigin(req({ host: "pavos.in", "x-forwarded-proto": "https" })), "https://pavos.in", "proxied custom domain");
  eq(requestOrigin(req({ "x-forwarded-host": "pavos.in", host: "storeasy26.vercel.app", "x-forwarded-proto": "https" })), "https://pavos.in", "x-forwarded-host wins");
  eq(requestOrigin(req({})), "http://localhost:3007", "no host header → request URL origin");
});

// --- summary --------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
