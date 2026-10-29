// Route-level CMS API suite (S53 / A1): real dispatch through the extracted
// handler (lib/admin/cms-api.js = exactly what app/api/admin/storefront
// serves), real requireAdmin, real storage. Proves the A1 property: a mixed
// payload can NEVER mutate, read-only actors stay read-only, and denied
// requests leave storage unchanged — by re-reading rows, not by grepping
// source.
//   pnpm test:cms-api
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-cmsapi-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cmsapi-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-cmsapi-default.db", ".test-cmsapi-platform.db", ".test-cmsapi-tenant.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { parseStorefrontOperation, handleStorefrontGet, handleStorefrontPut } = await import("../lib/admin/cms-api.js");

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
await C.upsertTenant({ id: "zc", name: "CMS API", domains: ["zc.test"], dbUrl: "file:.test-cmsapi-tenant.db", config: {}, secrets: {} });
const ZC = await C.getTenant("zc");
const tdb = createClient({ url: "file:.test-cmsapi-tenant.db" });
await tdb.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
await runMigrations(tdb, await loadMigrations("tenant"));

const ownerU = await I.createUser({ email: "owner@zc.test", password: "owner-pass-53" });
const staffU = await I.createUser({ email: "staff@zc.test", password: "staff-pass-53" });
const supportU = await I.createUser({ email: "support@zc.test", password: "support-pass-53" });
await I.addMembership(ownerU.id, "zc", "owner");
await I.addMembership(staffU.id, "zc", "staff");
await I.addMembership(supportU.id, "zc", "support");
const mkSession = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 60_000 })).token;
const ownerTok = await mkSession(ownerU);
const staffTok = await mkSession(staffU);
const supportTok = await mkSession(supportU);

// request double: what the handler + requireAdmin + sameOrigin actually read
const req = (cookie, body, headers = {}) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: "zc.test", ...headers })[k.toLowerCase()] ?? null },
  json: async () => body,
});

const inT = (fn) => withTenant(ZC, fn);
const blockRow = (key) => inT(() => db.selectFrom("cms_blocks").selectAll().where("key", "=", key).executeTakeFirst());

// --- parseStorefrontOperation ------------------------------------------------
await t("parse: each single operation parses; modifiers are not operations", () => {
  eq(parseStorefrontOperation({ block: "hero", value: {} }).op.kind, "saveBlock");
  eq(parseStorefrontOperation({ block: "hero", reset: true }).op.kind, "resetBlock");
  eq(parseStorefrontOperation({ page: { slug: "x" } }).op.kind, "savePage");
  eq(parseStorefrontOperation({ deletePage: "x" }).op.kind, "deletePage");
  eq(parseStorefrontOperation({ getPage: "x" }).op.kind, "getPage");
  eq(parseStorefrontOperation({ block: "hero", value: {}, revision: 3 }).op.revision, 3, "revision modifier");
});

await t("parse: empty, junk and mixed payloads are rejected", () => {
  eq(parseStorefrontOperation({}).code, "NO_OPERATION");
  eq(parseStorefrontOperation(null).code, "NO_OPERATION");
  eq(parseStorefrontOperation({ reset: true }).code, "NO_OPERATION", "reset alone");
  eq(parseStorefrontOperation({ getPage: "x", block: "hero", value: {} }).code, "AMBIGUOUS_OPERATION");
  eq(parseStorefrontOperation({ page: { slug: "x" }, deletePage: "y" }).code, "AMBIGUOUS_OPERATION");
});

// --- the A1 escalation: mixed payloads can never mutate ----------------------
await t("A1: support + {getPage, block, value} → 400, storage untouched (was a silent mutation)", async () => {
  const r = await inT(() => handleStorefrontPut(req(supportTok, { getPage: "shipping", block: "announcement", value: { enabled: true, text: "pwned", href: "" } })));
  eq(r.status, 400, "status");
  eq(r.body.code, "AMBIGUOUS_OPERATION", "code");
  eq(await blockRow("announcement"), undefined, "no row written");
});

await t("A1: ambiguity is unconditional — even an owner gets 400 on a mixed payload", async () => {
  const r = await inT(() => handleStorefrontPut(req(ownerTok, { getPage: "shipping", deletePage: "shipping" })));
  eq(r.status, 400);
  eq(r.body.code, "AMBIGUOUS_OPERATION");
});

// --- role gating against real storage ---------------------------------------
await t("support: valid read ops work (GET view, getPage)", async () => {
  const g = await inT(() => handleStorefrontGet(req(supportTok, null)));
  eq(g.status, 200, "GET");
  ok(g.body.blocks, "view shape");
  const p = await inT(() => handleStorefrontPut(req(supportTok, { getPage: "nope" })));
  eq(p.status, 200, "getPage");
  eq(p.body.page, null, "unknown page → null");
});

await t("support: every mutation op → 403, storage unchanged", async () => {
  for (const body of [
    { block: "announcement", value: { enabled: true, text: "x", href: "" } },
    { block: "announcement", reset: true },
    { page: { slug: "p1", title: "P1", sections: [] } },
    { deletePage: "p1" },
  ]) {
    const r = await inT(() => handleStorefrontPut(req(supportTok, body)));
    eq(r.status, 403, JSON.stringify(body));
  }
  eq(await blockRow("announcement"), undefined, "no block row");
  eq((await inT(() => db.selectFrom("cms_pages").selectAll().execute())).length, 0, "no page rows");
});

await t("staff: valid write works (storefront.write) and the view returns", async () => {
  const r = await inT(() => handleStorefrontPut(req(staffTok, { block: "announcement", value: { enabled: true, text: "Hello", href: "" }, revision: null })));
  eq(r.status, 200);
  eq(r.body.ok, true);
  eq((await blockRow("announcement")) != null, true, "row created");
});

await t("cross-origin write → 403 and unchanged; same-origin passes; reads skip the check", async () => {
  const evil = { origin: "https://evil.test" };
  const r = await inT(() => handleStorefrontPut(req(ownerTok, { block: "announcement", reset: true }, evil)));
  eq(r.status, 403, "cross-origin write");
  eq((await blockRow("announcement")) != null, true, "row survived");
  const read = await inT(() => handleStorefrontPut(req(supportTok, { getPage: "nope" }, evil)));
  eq(read.status, 200, "cross-origin read still allowed");
  const good = await inT(() => handleStorefrontPut(req(ownerTok, { block: "announcement", reset: true }, { origin: "https://zc.test" })));
  eq(good.status, 200, "same-origin write");
  eq(await blockRow("announcement"), undefined, "reset applied");
});

await t("no cookie → 401; junk body → 400 before auth", async () => {
  const r = await inT(() => handleStorefrontPut(req(null, { block: "hero", value: { title: "x" } })));
  eq(r.status, 401);
  const j = await inT(() => handleStorefrontPut(req(null, {})));
  eq(j.status, 400, "empty body is a parse error, not an auth probe");
});

// --- revision/conflict behavior preserved ------------------------------------
await t("CAS preserved: stale revision → 409 CMS_CONFLICT with the server's current row", async () => {
  const a = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", value: { title: "First" }, revision: null })));
  eq(a.status, 200, "create");
  const stale = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", value: { title: "Second" }, revision: null })));
  eq(stale.status, 409, "stale save");
  eq(stale.body.code, "CMS_CONFLICT");
  ok(stale.body.current?.revision >= 1, "current rides along");
  const row = await blockRow("hero");
  ok(String(row.value).includes("First"), "server kept the first value");
});

// --- S53 (0B-1): revision-required writes + explicit force ------------------
await t("REVISION_REQUIRED: a save that omits the revision (and force) is a 428, storage unchanged", async () => {
  const before = await blockRow("hero");
  const r = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", value: { title: "Sneaky" } })));
  eq(r.status, 428);
  eq(r.body.code, "REVISION_REQUIRED");
  const after = await blockRow("hero");
  eq(after.revision, before.revision, "revision untouched");
  ok(String(after.value).includes("First"), "value untouched");
  const p = await inT(() => handleStorefrontPut(req(staffTok, { page: { slug: "p9", title: "P9", sections: [] } })));
  eq(p.status, 428, "pages too");
});

await t("force:true is the explicit overwrite path and is audited through", async () => {
  const r = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", value: { title: "Forced over" }, force: true })));
  eq(r.status, 200);
  ok(String((await blockRow("hero")).value).includes("Forced over"), "overwrote");
});

await t("reset with a stale revision conflicts; with the current revision it applies", async () => {
  const current = (await blockRow("hero")).revision;
  const stale = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", reset: true, revision: current - 1 })));
  eq(stale.status, 409, "stale reset");
  ok((await blockRow("hero")) != null, "row survived");
  const okReset = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", reset: true, revision: current })));
  eq(okReset.status, 200, "current reset");
  eq(await blockRow("hero"), undefined, "row gone");
});

await t("deletePage with a stale revision conflicts; with the current one it deletes", async () => {
  const mk = await inT(() => handleStorefrontPut(req(staffTok, { page: { slug: "del-me", title: "Del", sections: [] }, revision: null })));
  eq(mk.status, 200, "create");
  const rev = mk.body.pageRevisions["del-me"];
  const stale = await inT(() => handleStorefrontPut(req(staffTok, { deletePage: "del-me", revision: rev + 5 })));
  eq(stale.status, 409, "stale delete");
  const good = await inT(() => handleStorefrontPut(req(staffTok, { deletePage: "del-me", revision: rev })));
  eq(good.status, 200, "current delete");
  eq((await inT(() => db.selectFrom("cms_pages").selectAll().where("slug", "=", "del-me").execute())).length, 0, "row gone");
});

await t("validation errors still 422 with the errors list", async () => {
  const r = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", value: { title: "" }, revision: 1 })));
  eq(r.status, 422);
  ok(Array.isArray(r.body.errors), "errors list");
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
