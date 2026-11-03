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

// --- S54: tenant templates through the one-op API ---------------------------
await t("templates: save (write-gated) → list (read) → instantiate twice = fresh independent ids", async () => {
  const sections = [{ kind: "text", heading: "About us", body: ["hello"] }, { kind: "faq", heading: "FAQ", items: [{ q: "Q1", a: "<p>A1</p>" }] }];
  const denied = await inT(() => handleStorefrontPut(req(supportTok, { saveTemplate: { name: "Nope", sections } })));
  eq(denied.status, 403, "support cannot save templates");
  const saved = await inT(() => handleStorefrontPut(req(staffTok, { saveTemplate: { name: "Standard about", family: "page", sections } })));
  eq(saved.status, 200, "staff saves");
  const tplId = saved.body.template.id;
  const listed = await inT(() => handleStorefrontPut(req(supportTok, { listTemplates: true })));
  eq(listed.status, 200, "support can LIST (read)");
  eq(listed.body.templates.length, 1);
  const a = await inT(() => handleStorefrontPut(req(supportTok, { useTemplate: tplId })));
  const b = await inT(() => handleStorefrontPut(req(supportTok, { useTemplate: tplId })));
  eq(a.status, 200);
  ok(a.body.template.sections.every((s) => /^sec_/.test(s.id)), "instantiation carries ids");
  ok(a.body.template.sections[0].id !== b.body.template.sections[0].id, "each instantiation is an INDEPENDENT copy");
  const ambiguous = await inT(() => handleStorefrontPut(req(staffTok, { saveTemplate: { name: "x", sections }, deletePage: "y" })));
  eq(ambiguous.status, 400, "template ops obey one-operation parsing");
  eq(ambiguous.body.code, "AMBIGUOUS_OPERATION");
  const gone = await inT(() => handleStorefrontPut(req(staffTok, { deleteTemplate: tplId })));
  eq(gone.status, 200);
  eq(gone.body.templates.length, 0, "deleted");
});

// --- S55: draft revision history --------------------------------------------
await t("history: console saves trail into cms_history, newest first, readable by support, capped", async () => {
  const { appendHistory, listHistory, HISTORY_KEEP } = await import("../lib/cms/history.js");
  const a = await inT(() => handleStorefrontPut(req(staffTok, { block: "announcement", value: { enabled: true, text: "First", href: "" }, revision: null })));
  eq(a.status, 200, "save 1");
  const rev = a.body.revisions.announcement;
  const b = await inT(() => handleStorefrontPut(req(staffTok, { block: "announcement", value: { enabled: true, text: "Second", href: "" }, revision: rev })));
  eq(b.status, 200, "save 2");
  const h = await inT(() => handleStorefrontPut(req(supportTok, { history: { kind: "block", key: "announcement" } })));
  eq(h.status, 200, "support reads history");
  ok(h.body.history.length >= 2, "two entries");
  ok(String(h.body.history[0].value.text) === "Second" && String(h.body.history[1].value.text) === "First", "newest first");
  ok(/merchant:/.test(h.body.history[0].actor || ""), "actor recorded");
  // cap at the lib level
  await inT(async () => {
    for (let i = 0; i < HISTORY_KEEP + 7; i++) await appendHistory({ kind: "block", key: "cap-probe", value: { i } });
  });
  const capped = await inT(() => listHistory("block", "cap-probe"));
  eq(capped.length, HISTORY_KEEP, "pruned to the cap");
  eq(capped[0].value.i, HISTORY_KEEP + 6, "newest kept");
  // Saves in the same millisecond, every time: with the clock held still, only the
  // order they were saved in can tell them apart. Their ids are random.
  const realToISOString = Date.prototype.toISOString;
  Date.prototype.toISOString = () => "2030-01-01T00:00:00.000Z";
  try {
    await inT(async () => {
      for (let i = 0; i < HISTORY_KEEP + 7; i++) await appendHistory({ kind: "block", key: "same-ms-probe", value: { i } });
    });
  } finally {
    Date.prototype.toISOString = realToISOString;
  }
  const sameMs = await inT(() => listHistory("block", "same-ms-probe"));
  eq(JSON.stringify(sameMs.map((h) => h.value.i)), JSON.stringify(Array.from({ length: HISTORY_KEEP }, (_, n) => HISTORY_KEEP + 6 - n)), "same millisecond, newest first and newest kept");
});

await t("validation errors still 422 with the errors list", async () => {
  const r = await inT(() => handleStorefrontPut(req(staffTok, { block: "hero", value: { title: "" }, revision: 1 })));
  eq(r.status, 422);
  ok(Array.isArray(r.body.errors), "errors list");
});

// --- S59: live unsaved-edit preview candidates --------------------------------
const reqC = (adminTok, previewTok, body) => ({
  cookies: {
    get: (name) => {
      if (name === "_admin" && adminTok) return { value: adminTok };
      if (name === "_preview" && previewTok) return { value: previewTok };
      return undefined;
    },
  },
  headers: { get: (k) => ({ host: "zc.test" })[k.toLowerCase()] ?? null },
  json: async () => body,
});

await t("candidate: no preview session → 409 NO_PREVIEW; support (read-only) → 403", async () => {
  const r = await inT(() => handleStorefrontPut(reqC(staffTok, null, { previewCandidate: { hero: { title: "x" } } })));
  eq(r.status, 409);
  eq(r.body.code, "NO_PREVIEW");
  const s = await inT(() => handleStorefrontPut(reqC(supportTok, "whatever", { previewCandidate: { hero: { title: "x" } } })));
  eq(s.status, 403, "write-gated before the token check");
});

await t("candidate: valid push stores VALIDATED blocks keyed by token hash; overlay reads them; null clears", async () => {
  const { previewToken } = await import("../lib/releases.js");
  const { getPreviewCandidate } = await import("../lib/cms/candidates.js");
  const ptok = await inT(() => previewToken());
  const r = await inT(() =>
    handleStorefrontPut(reqC(staffTok, ptok, { previewCandidate: { hero: { title: "Live-typed title", highlight: "Live", subtitle: "s" } } })),
  );
  eq(r.status, 200, JSON.stringify(r.body));
  const cand = await inT(() => getPreviewCandidate(ptok));
  eq(cand.hero.title, "Live-typed title", "validated value readable by the resolver");
  const raw = await inT(() => db.selectFrom("cms_preview_candidates").selectAll().execute());
  eq(raw.length, 1);
  ok(raw[0].token_hash !== ptok && /^[0-9a-f]{64}$/.test(raw[0].token_hash), "raw token never stored");
  // another preview session sees nothing
  const other = await inT(() => previewToken({ now: Date.now() + 1000 }));
  eq(await inT(() => getPreviewCandidate(other)), null, "sessions are isolated");
  // clear
  const c = await inT(() => handleStorefrontPut(reqC(staffTok, ptok, { previewCandidate: null })));
  eq(c.status, 200);
  eq(await inT(() => getPreviewCandidate(ptok)), null, "cleared");
});

await t("candidate: unknown block → 400; invalid value → 422; publishing NEVER sees candidates", async () => {
  const { previewToken, snapshotContent } = await import("../lib/releases.js");
  const ptok = await inT(() => previewToken());
  const u = await inT(() => handleStorefrontPut(reqC(staffTok, ptok, { previewCandidate: { surface_templates: { pdp: "editorial" } } })));
  eq(u.status, 400, "unknown candidate key");
  const v = await inT(() => handleStorefrontPut(reqC(staffTok, ptok, { previewCandidate: { hero: { title: "" } } })));
  eq(v.status, 422, "invalid value");
  const before = await inT(() => snapshotContent());
  await inT(() => handleStorefrontPut(reqC(staffTok, ptok, { previewCandidate: { hero: { title: "Candidate only", highlight: "", subtitle: "" } } })));
  const after = await inT(() => snapshotContent());
  eq(after.hash, before.hash, "snapshot hash untouched by a candidate");
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
