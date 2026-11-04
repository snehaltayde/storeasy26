// Route-level CMS API suite (S53 / A1): real dispatch through the extracted
// handler (lib/admin/cms-api.js = exactly what app/api/admin/storefront
// serves), real requireAdmin, real storage. Proves the A1 property: a mixed
// payload can NEVER mutate, read-only actors stay read-only, and denied
// requests leave storage unchanged — by re-reading rows, not by grepping
// source.
// P2-GUARD adds the side-by-side guard: with cms_state 'documents' every old
// content writer (this API, catalog, upsells, brand, theme) answers 409
// STORE_USES_DOCUMENTS and the
// rows are unchanged (P2-WRITERS moved experiment adopt, insight apply and
// agency kit apply to lib/content-writes.js; scripts/test-writers.js covers
// them); /api/admin/releases refuses every action and its GET is
// the documents marker; a cms_state that can't be read is a 5xx, never a
// go-ahead.
//   pnpm test:cms-api
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// The real route files use the app's "@/…" alias and next/server, which plain
// Node can't resolve on its own (the P2-GUARD route checks below call them).
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-cmsapi-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cmsapi-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-cmsapi-default.db", ".test-cmsapi-platform.db", ".test-cmsapi-tenant.db", ".test-cmsapi-docs.db", ".test-cmsapi-badmode.db"];
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

// --- P2-GUARD: old writers next to documents --------------------------------
{
  const { runMigrations: runM, loadMigrations: loadM } = await import("../lib/platform/migrate.js");
  await runM(C.platformDb(), await loadM("platform"), {});
  const A = await import("../lib/platform/agency.js");
  const { previewToken } = await import("../lib/releases.js");
  const { handleReleasesGet, handleReleasesPost } = await import("../lib/admin/releases-api.js");
  const M = await import("../lib/cms-mode.js");

  // "zd": a store whose content the new editor owns (cms_state 'documents')
  await C.upsertTenant({ id: "zd", name: "Docs store", domains: ["zd.test"], dbUrl: "file:.test-cmsapi-docs.db", config: { brand: { accent: "#7c3aed" } }, secrets: { order_link_secret: "zd-secret" } });
  const ZD = await C.getTenant("zd");
  const zdb = createClient({ url: "file:.test-cmsapi-docs.db" });
  await zdb.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
  await runMigrations(zdb, await loadMigrations("tenant"));
  await I.addMembership(ownerU.id, "zd", "owner");
  const inD = (fn) => withTenant(ZD, fn);
  const reqD = (body, { cookies = {}, path = "/api/admin/x" } = {}) => {
    const url = new URL(`http://zd.test${path}`);
    const jar = { _admin: ownerTok, ...cookies };
    return {
      url: url.href,
      nextUrl: url,
      cookies: { get: (n) => (jar[n] != null ? { name: n, value: jar[n] } : undefined) },
      headers: { get: (k) => ({ host: "zd.test" })[k.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  const route = async (path, method, body, { params, cookies } = {}) => {
    const mod = await import(`../app/api/${path}/route.js`);
    const res = await mod[method](reqD(body, { cookies, path: `/api/${path}` }), { params: Promise.resolve(params || {}) });
    return { status: res.status, body: await res.json() };
  };
  const setMode = (mode) => zdb.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] });

  // fixtures, written while the store is still on legacy
  const NOW = "2026-11-01T00:00:00.000Z";
  await zdb.executeMultiple(`
    INSERT INTO products (id, handle, title, available) VALUES ('gid://shopify/Product/9', 'tee', 'Tee', 1);
    INSERT INTO collections (id, handle, title, synced_at) VALUES ('gid://shopify/Collection/9', 'all', 'All', '${NOW}');
    INSERT INTO placements (id, kind, target_product_ids, title, enabled, position, updated_at) VALUES ('pl-1', 'cart_upsell', '["gid://shopify/Product/9"]', 'Pairs well', 1, 0, '${NOW}');
    INSERT INTO experiments (id, slug, name, target_kind, variants, status, created_at, updated_at) VALUES ('exp-1', 'hero-test', 'Hero test', 'hero', '[{"key":"control","weight":50,"payload":null},{"key":"b","weight":50,"payload":{"title":"Variant B"}}]', 'completed', '${NOW}', '${NOW}');
    INSERT INTO ai_insights (id, status, proposals, facts, created_at, updated_at) VALUES ('ins-1', 'proposed', '[{"component":"hero","draft":{"title":"AI hero"}}]', '{}', '${NOW}', '${NOW}');
  `);
  const heroSave = await inD(() => handleStorefrontPut(reqD({ block: "hero", value: { title: "Legacy hero" }, revision: null })));
  eq(heroSave.status, 200, "fixture hero:");
  const pageSave = await inD(() => handleStorefrontPut(reqD({ page: { slug: "about-zd", title: "About", sections: [] }, revision: null })));
  eq(pageSave.status, 200, "fixture page:");
  const tplSave = await inD(() => handleStorefrontPut(reqD({ saveTemplate: { name: "Kept", family: "page", sections: [{ kind: "text", heading: "H", body: ["x"] }] } })));
  eq(tplSave.status, 200, "fixture template:");
  const tplId = tplSave.body.template.id;
  const heroRev = heroSave.body.revisions.hero;
  const pageRev = pageSave.body.pageRevisions["about-zd"];
  const ptok = await inD(() => previewToken());
  const pub = await inD(() => handleReleasesPost(reqD({ action: "publish", note: "legacy release" })));
  eq(pub.status, 200, `fixture release: ${JSON.stringify(pub.body).slice(0, 200)}`);
  const relId = pub.body.published.id;
  // an agency with a staff grant on zd and a kit
  const agency = await A.createAgency({ name: "Guard Studio" });
  const agent = await I.createUser({ email: "agent@studio.test", password: "agent-pass-53" });
  await A.addAgencyMember(agency.id, agent.id, "owner");
  const agentTok = (await S.createSession({ userId: agent.id, kind: "agency", ttlMs: 60_000 })).token;
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@zc.test", role: "staff" });
  ok(await A.acceptGrant(inv.token, { tenantId: "zd", actorEmail: "owner@zc.test" }), "grant accepted");
  await C.platformDb().execute({
    sql: "INSERT INTO agency_kits (id, agency_id, name, source_note, payload, created_at) VALUES ('akit_guard', ?, 'Guard kit', 'x', ?, ?)",
    args: [agency.id, JSON.stringify({ hero: { title: "Kit hero" }, announcement: { enabled: true, text: "Kit announcement" } }), NOW],
  });

  // every row an old writer could touch, plus the store's brand and theme
  const TABLES = ["cms_blocks", "cms_pages", "cms_templates", "cms_preview_candidates", "cms_history", "product_overrides", "collection_overrides", "placements", "experiments", "ai_insights", "releases", "release_state"];
  const dump = async () => {
    const out = {};
    for (const tb of TABLES) out[tb] = (await zdb.execute(`SELECT * FROM ${tb} ORDER BY 1`)).rows.map((r) => JSON.stringify(r));
    out.config = (await C.platformDb().execute("SELECT config FROM tenants WHERE id = 'zd'")).rows[0].config;
    return JSON.stringify(out);
  };

  const WRITES = [
    ["saveBlock", () => inD(() => handleStorefrontPut(reqD({ block: "hero", value: { title: "Overwrite" }, revision: heroRev })))],
    ["saveBlock (force)", () => inD(() => handleStorefrontPut(reqD({ block: "announcement", value: { enabled: true, text: "Forced", href: "" }, force: true })))],
    ["savePage", () => inD(() => handleStorefrontPut(reqD({ page: { slug: "about-zd", title: "Changed", sections: [] }, revision: pageRev })))],
    ["resetBlock", () => inD(() => handleStorefrontPut(reqD({ block: "hero", reset: true, revision: heroRev })))],
    ["resetBlock (no revision)", () => inD(() => handleStorefrontPut(reqD({ block: "hero", reset: true })))],
    ["deletePage", () => inD(() => handleStorefrontPut(reqD({ deletePage: "about-zd", revision: pageRev })))],
    ["saveTemplate", () => inD(() => handleStorefrontPut(reqD({ saveTemplate: { name: "New", family: "page", sections: [] } })))],
    ["deleteTemplate", () => inD(() => handleStorefrontPut(reqD({ deleteTemplate: tplId })))],
    ["previewCandidate", () => inD(() => handleStorefrontPut(reqD({ previewCandidate: { hero: { title: "Candidate" } } }, { cookies: { _preview: ptok } })))],
    ["catalog POST (product)", () => route("admin/catalog", "POST", { product: { handle: "tee", modules: [], badge: "New" } })],
    ["catalog POST (collection pins)", () => route("admin/catalog", "POST", { collection: { handle: "all", pinnedHandles: ["tee"] } })],
    ["upsells POST", () => route("admin/upsells", "POST", { kind: "cart_upsell", targetHandles: ["tee"], title: "Another" })],
    ["upsells/[id] PUT", () => route("admin/upsells/[id]", "PUT", { enabled: false }, { params: { id: "pl-1" } })],
    ["upsells/[id] DELETE", () => route("admin/upsells/[id]", "DELETE", {}, { params: { id: "pl-1" } })],
    ["brand PUT", () => route("admin/brand", "PUT", { brand: { accent: "#0f766e" } })],
    ["brand reset", () => route("admin/brand", "PUT", { reset: true })],
  ];
  // P3-DESIGN (TOK-03): theme POST (applyKit) left this list too. In documents
  // mode it saves a doc_design draft through the documents service
  // (scripts/test-design-doc.js); in 'migrating' it still refuses (below).
  // P2-WRITERS: experiment adopt, insight apply and agency kit apply left this
  // list. They no longer refuse in documents mode: lib/content-writes.js saves
  // a doc_home or doc_announcement draft instead (scripts/test-writers.js).
  // In 'migrating' they still refuse; that is checked there too.

  await t("P2-GUARD: with cms_state 'documents', every old content writer answers 409 STORE_USES_DOCUMENTS and the re-read rows are unchanged", async () => {
    await setMode("documents");
    const before = await dump();
    const wrong = [];
    for (const [name, run] of WRITES) {
      const r = await run();
      if (r.status !== 409 || r.body.code !== "STORE_USES_DOCUMENTS") wrong.push(`${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      else if (!/new editor/.test(r.body.error) || /SQLITE|cms_state/i.test(r.body.error)) wrong.push(`${name}: not plain words: ${r.body.error}`);
    }
    eq(wrong.join("\n"), "", "answers:");
    eq(await dump(), before, "rows after the refused writes:");
  });

  await t("P2-GUARD: reads are unchanged in documents mode (view, getPage, templates, history, brand preview)", async () => {
    eq((await inD(() => handleStorefrontGet(reqD(null)))).status, 200, "GET view:");
    eq((await inD(() => handleStorefrontPut(reqD({ getPage: "about-zd" })))).body.page?.title, "About", "getPage:");
    eq((await inD(() => handleStorefrontPut(reqD({ listTemplates: true })))).body.templates.length, 1, "listTemplates:");
    eq((await inD(() => handleStorefrontPut(reqD({ history: { kind: "block", key: "hero" } })))).status, 200, "history:");
    eq((await route("admin/brand", "PUT", { preview: { accent: "#0f766e" } })).status, 200, "brand preview (stores nothing):");
    eq((await route("admin/catalog", "GET", null)).status, 200, "catalog GET:");
  });

  await t("P2-GUARD: 'migrating' refuses the same way, with its own plain words", async () => {
    await setMode("migrating");
    const before = await dump();
    const r = await inD(() => handleStorefrontPut(reqD({ block: "hero", value: { title: "Mid-move" }, revision: heroRev })));
    eq(r.status, 409, "status:");
    eq(r.body.code, "STORE_USES_DOCUMENTS", "code:");
    ok(/moving to the new editor/.test(r.body.error), `words: ${r.body.error}`);
    eq((await route("admin/theme", "POST", { action: "apply", kit: "glow" })).status, 409, "theme:");
    eq(await dump(), before, "rows:");
  });

  await t("P2-GUARD: in documents mode /api/admin/releases refuses publish, schedule, rollback, cancel, preview and approve (409), and GET is the documents marker", async () => {
    await setMode("documents");
    const before = await dump();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const wrong = [];
    for (const body of [
      { action: "publish", note: "x" },
      { action: "schedule", note: "x", at },
      { action: "rollback", id: relId },
      { action: "cancel", id: relId },
      { action: "preview", to: "/" },
      { action: "approve", note: "x" },
    ]) {
      const r = await inD(() => handleReleasesPost(reqD(body)));
      if (r.status !== 409 || r.body.code !== "STORE_USES_DOCUMENTS" || !/new editor/.test(r.body.error)) wrong.push(`${body.action}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      if (r.body.url) wrong.push(`${body.action}: minted a preview URL`);
    }
    eq(wrong.join("\n"), "", "answers:");
    eq(await dump(), before, "rows:");
    const g = await inD(() => handleReleasesGet(reqD(null)));
    eq(g.status, 200, "GET:");
    eq(JSON.stringify([g.body.documents, g.body.mode, g.body.live]), JSON.stringify([true, "documents", relId]), "marker:");
    ok(/This store publishes with the new editor/.test(g.body.message), `message: ${g.body.message}`);
    ok(!("diff" in g.body) && !("validation" in g.body) && !("draftHash" in g.body), `no legacy diff: ${Object.keys(g.body)}`);
  });

  await t("P2-GUARD: back on legacy, the same writers work again (the guard keys on the mode, read fresh)", async () => {
    await setMode("legacy");
    const a = await route("admin/experiments", "POST", { adopt: { slug: "hero-test", variant: "b" } });
    eq(a.status, 200, `adopt: ${JSON.stringify(a.body)}`);
    eq(JSON.parse((await zdb.execute("SELECT value FROM cms_blocks WHERE key = 'hero'")).rows[0].value).title, "Variant B", "hero draft:");
    const g = await inD(() => handleReleasesGet(reqD(null)));
    eq(JSON.stringify([g.status, g.body.documents ?? null, typeof g.body.diff]), JSON.stringify([200, null, "object"]), "legacy GET:");
  });

  // "zx": a store whose cms_state can't be read (a view over a table that's gone)
  await C.upsertTenant({ id: "zx", name: "Bad mode", domains: ["zx.test"], dbUrl: "file:.test-cmsapi-badmode.db", config: {}, secrets: {} });
  const ZX = await C.getTenant("zx");
  const xdb = createClient({ url: "file:.test-cmsapi-badmode.db" });
  await xdb.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
  await runMigrations(xdb, await loadMigrations("tenant"));
  await xdb.executeMultiple("ALTER TABLE cms_state RENAME TO cms_state_data; CREATE VIEW cms_state AS SELECT * FROM cms_state_gone;");
  await I.addMembership(ownerU.id, "zx", "owner");

  await t("P2-GUARD: a cms_state read error other than a missing table is infrastructure (5xx), never a go-ahead", async () => {
    const thrown = await withTenant(ZX, () => M.assertLegacyContentWrites().then(() => null, (e) => e));
    ok(thrown instanceof M.CmsModeUnavailableError, `assert: ${thrown ? thrown.message : "allowed the write"}`);
    const reqX = (body) => ({ cookies: { get: (n) => (n === "_admin" ? { value: ownerTok } : undefined) }, headers: { get: (k) => ({ host: "zx.test" })[k.toLowerCase()] ?? null }, json: async () => body });
    const r = await withTenant(ZX, () => handleStorefrontPut(reqX({ block: "hero", value: { title: "Should not land" }, revision: null })));
    ok(r.status >= 500, `save answered ${r.status} ${JSON.stringify(r.body)}`);
    ok(!/cms_state|SQLITE/i.test(r.body.error), `plain words: ${r.body.error}`);
    eq((await xdb.execute("SELECT count(*) AS n FROM cms_blocks")).rows[0].n, 0, "nothing written:");
    const mod = await import("../app/api/admin/catalog/route.js");
    const res = await mod.POST({ url: "http://zx.test/api/admin/catalog", nextUrl: new URL("http://zx.test/api/admin/catalog"), ...reqX({ product: { handle: "nope", modules: [], badge: "" } }) });
    ok(res.status >= 500, `catalog answered ${res.status}`);
    const pub = await withTenant(ZX, () => handleReleasesPost(reqX({ action: "publish" })));
    ok(pub.status >= 500, `publish answered ${pub.status}`);
    eq((await xdb.execute("SELECT count(*) AS n FROM releases")).rows[0].n, 0, "no release:");
  });

  await t("P2-GUARD: a store with no cms_state table (before 0021), or a table with no row, reads as legacy", async () => {
    await withTenant(ZX, async () => {
      await xdb.executeMultiple("DROP VIEW cms_state;");
      eq(await M.getCmsMode(), "legacy", "no table:");
      await xdb.executeMultiple("ALTER TABLE cms_state_data RENAME TO cms_state; DELETE FROM cms_state;");
      eq(await M.getCmsMode(), "legacy", "no row:");
      await xdb.execute("INSERT INTO cms_state (id, mode, updated_at) VALUES (1, 'Documents', 'x')");
      eq((await M.assertLegacyContentWrites().then(() => "allowed", (e) => e.code)), "STORE_USES_DOCUMENTS", "an unknown mode is not legacy:");
    });
  });
  zdb.close();
  xdb.close();
}

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
