// Provisioning & onboarding suite (Session 41: BE26 resumable idempotent
// steps + compensation + neutral seeds, MC02 derived checklist + gated
// launch, MC03 verified-membership switcher data).
// P4-PROVISION (MIG-03, PUB-06, GEN-02, TOK-03, ED-05; owner answer OQ-4): a
// store is on the new editor (documents mode, the only one; content_mode only
// reads it) and stays closed until its first publish; the onboarding
// checklist works for a new documents store. File databases and a file control plane only: nothing here creates
// a hosted database or reaches Shopify.
//   pnpm test:provision
import { readFile, rm, access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire, registerHooks } from "node:module";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

// The routes in plain Node (as test-commerce does): the "@/" alias, next/server
// with after() collected instead of run (no Shopify push in tests), and
// next/headers answering for one simulated request (globalThis.__provRequest:
// its host and cookies), empty outside one.
globalThis.__provAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__provAfter.push(fn); };`);
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const cur = () => globalThis.__provRequest || { host: null, cookies: {} };
export async function cookies() { const c = cur().cookies || {}; return { get: (n) => (Object.hasOwn(c, n) ? { name: n, value: c[n] } : undefined) }; }
export async function headers() { return { get: (n) => (String(n).toLowerCase() === "host" ? cur().host : null) }; }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: SERVER_STUB, shortCircuit: true, format: "module" };
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (spec === "next/navigation") return next("next/navigation.js", ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
process.env.PLATFORM_SITE_HOSTS = "";
delete process.env.CHECKOUT_MODE;
// No Typesense, Shopify or AI keys from the shell: the publish's search
// reindex finds no client and leaves its rows pending.
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "SHOPIFY_STORE_DOMAIN", "ANTHROPIC_API_KEY"]) delete process.env[k];

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-prov-default.db";
process.env.PLATFORM_DB_URL = "file:.test-prov-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const P4_DBS = ["fresh", "keep", "live", "liveorders", "liveprod", "adoptrel", "adoptblk", "adoptdoc", "earlier", "badmode", "stalemode", "sharea", "sharec", "shared", "onb", "onbui", "onbx", "onbopen", "onbm4", "onbfail", ...Array.from({ length: 8 }, (_, i) => `fa${i}`)].map((n) => `.test-prov-${n}.db`);
const dbs = [".test-prov-default.db", ".test-prov-platform.db", ".test-prov-t1.db", ".test-prov-beta.db", ...P4_DBS];
const removeDbs = async () => {
  for (const f of dbs) for (const ext of ["", "-wal", "-shm", "-journal"]) await rm(join(here, "..", f + ext), { force: true });
};
await removeDbs();

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const P = await import("../lib/platform/provision.js");
const B = await import("../lib/platform/billing.js");
const { onboardingFor, markTestOrder } = await import("../lib/onboarding/service.js");
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

// The BE26 / MC02 tenant (documents, the only mode since Phase 1's legacy removal)
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
  // P4-FIX6: on a database of its own (acme's would now stop the run at
  // create_db: another registered store uses it)
  const p2 = { id: "beta", name: "Beta", shopDomain: "beta.myshopify.com", dbUrl: "file:.test-prov-beta.db" };
  const r = await P.runProvision(p2, { failAt: "record_onboarding" });
  eq(r.run.status, "failed");
  ok(await C.getTenant("beta"), "beta registered");
  ok(await B.subscriptionFor("beta"), "beta subscription created");
  const comp = await P.compensateProvision(r.run.id);
  eq(comp.run.status, "compensated");
  eq(await C.getTenant("beta"), null, "tenant row deregistered:");
  eq(await B.subscriptionFor("beta"), null, "free subscription removed:");
  ok(!comp.notes.some((n) => /deleted/.test(n) && /database/.test(n)), "no database deletion");
  // the adopted db file itself is left in place, and other tenants are untouched
  ok(await access(join(here, "..", ".test-prov-beta.db")).then(() => true, () => false), "the database is left in place");
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

console.log("— MC02 / Phase 1 line 3: onboarding steps");

await t("the onboarding steps derive from real state and resume honestly (nothing stored)", async () => {
  const acme = await C.getTenant("acme");
  let m = await withTenant(acme, () => onboardingFor({ role: "owner" }));
  const get = (id) => m.steps.find((i) => i.id === id);
  eq(get("connect").state, "in_progress", "a shop domain recorded, no shopify token yet (an operator finishes it):");
  eq(get("import").state, "blocked", "import waits for connect:");
  eq(JSON.stringify([get("open").state === "done", m.open]), "[false,false]", "not open before the first publish:");
  eq(m.current, "connect", "resumes at connect:");
  // state lands → the steps flip, no stored flags involved
  await C.patchTenant("acme", { secrets: { shopify_admin_token: "shpat_test" } });
  await withTenant(await C.getTenant("acme"), async () => {
    await libsql.execute("INSERT INTO products (id, handle, title, available) VALUES ('gid://p/1','x','X',1)");
  });
  m = await withTenant(await C.getTenant("acme"), () => onboardingFor({ role: "owner" }));
  for (const id of ["connect", "import"]) eq(m.steps.find((i) => i.id === id).state, "done", `${id} derived:`);
  eq(m.current, "brand", "resumes at brand:");
});

await t("the test-order check-off records cleanly and is the only stored one (preview and launch check-offs are not read)", async () => {
  await C.patchTenant("acme", { config: { onboarding: { ...((await C.getTenant("acme", { fresh: true })).config.onboarding || {}), manual: { preview: "2026-01-01T00:00:00.000Z", launch: "2026-01-01T00:00:00.000Z" } } } });
  let m = await withTenant(await C.getTenant("acme", { fresh: true }), () => onboardingFor({ role: "owner" }));
  eq(JSON.stringify([m.open, m.steps.find((i) => i.id === "open").state === "done", m.steps.find((i) => i.id === "open").facts.testOrderMarked]), "[false,false,false]", "old check-offs open nothing:");
  const r = await withTenant(await C.getTenant("acme", { fresh: true }), () => markTestOrder(true));
  eq(JSON.stringify([r.step, r.done]), '["test_order",true]', "marked:");
  m = await withTenant(await C.getTenant("acme", { fresh: true }), () => onboardingFor({ role: "owner" }));
  eq(m.steps.find((i) => i.id === "open").facts.testOrderMarked, true, "read back:");
  const manual = (await C.getTenant("acme", { fresh: true })).config.onboarding.manual;
  ok(manual.test_order && manual.preview && manual.launch, `old values left in place: ${JSON.stringify(manual)}`);
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

// =====================================================================================
console.log("— P4-PROVISION: new stores start on the new editor (MIG-03, OQ-4)");

const { NextRequest } = require("next/server.js");
const Res = await import("../lib/content/resolve.js");
const PS = await import("../lib/preview-sessions.js");
const Docs = await import("../lib/documents/service.js");
const R = await import("../lib/registry/index.js");
const After = await import("../lib/documents/after-commit.js");
const K = await import("../lib/themes/kits.js");
const S = await import("../lib/platform/sessions.js");
const { getCmsMode, DOCUMENTS_MESSAGE } = await import("../lib/cms-mode.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const ON = await import("../lib/onboarding/service.js");
const OS = await import("../lib/onboarding/steps.js");
const E = await import("../lib/admin/editor-entry.js");
const { createCart, addItem, getCart, CART_COOKIE } = await import("../lib/cart.js");
const checkoutRoute = await import("../app/api/checkout/route.js");
const sitemap = (await import(pathToFileURL(join(ROOT, "app/sitemap.js")).href)).default;
const { loadMigrations: loadMigs } = await import("../lib/platform/migrate.js");

const same = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const raw = (file) => createClient({ url: `file:${file}` });
async function rawSql(file, q, args = []) {
  const c = raw(file);
  try {
    return (await c.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
  } finally {
    c.close();
  }
}
const cfgOf = async (id) => JSON.parse(String((await C.platformDb().execute({ sql: "SELECT config FROM tenants WHERE id = ?", args: [id] })).rows[0].config));
const runRowOf = async (runId) => P.getProvisionRun(runId);

// The brief's list of content tables, which CONTENT_TABLES must cover.
const BRIEF_TABLES = ["releases", "documents", "cms_blocks", "cms_pages", "cms_templates", "placements", "product_overrides", "collection_overrides", "page_redirects"];

// What a store's database holds, for comparing runs: its editor, live pointer,
// every content table's row count and its offers.
async function storeState(file) {
  const mode = (await rawSql(file, "SELECT mode FROM cms_state WHERE id = 1"))[0]?.mode ?? null;
  const live = (await rawSql(file, "SELECT live_release_id AS live FROM release_state WHERE id = 1"))[0]?.live ?? null;
  const counts = {};
  for (const tname of P.CONTENT_TABLES) counts[tname] = Number((await rawSql(file, `SELECT count(*) AS n FROM ${tname}`))[0].n);
  const offers = Number((await rawSql(file, "SELECT count(*) AS n FROM offers"))[0].n);
  return { mode, live, counts, offers };
}
const zeroCounts = () => Object.fromEntries(P.CONTENT_TABLES.map((tname) => [tname, 0]));
const FRESH_STATE = () => ({ mode: "documents", live: null, counts: zeroCounts(), offers: 0 });
const params = (id, over = {}) => ({ id, name: `Store ${id}`, shopDomain: `${id}.myshopify.com`, domains: [`${id}.test`], dbUrl: `file:.test-prov-${id}.db`, ...over });

// the acme tenant before anything below runs, to prove it is left alone
const acmeBefore = { state: await storeState(".test-prov-t1.db"), row: (await rawSql(".test-prov-t1.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0] };

let freshRun;
await t("unit: a freshly provisioned tenant is a documents store with no live release, no releases, documents or legacy content rows and no theme_pin; the run records content_mode (after apply_schema, before seed_defaults) with contentMode 'documents'", async () => {
  const r = await P.runProvision(params("fresh", { name: "Fresh Store" }));
  eq(r.run.status, "done", `status (${r.error}):`);
  freshRun = r.run;
  const names = r.run.steps.map((x) => x.name);
  same(names, ["create_db", "apply_schema", "content_mode", "seed_defaults", "register_tenant", "init_billing", "record_onboarding"], "steps:");
  eq(r.run.steps.find((x) => x.name === "content_mode").status, "done", "content_mode step:");
  eq(r.run.refs.contentMode, "documents", "refs.contentMode:");
  ok(r.run.refs.contentModeReason === P.CONTENT_MODE_REASONS.fresh || r.run.refs.contentModeReason === P.CONTENT_MODE_REASONS.already, `reason: ${r.run.refs.contentModeReason}`);
  eq(r.run.params.contentMode, "documents", "params.contentMode (the default, recorded):");
  same(await storeState(".test-prov-fresh.db"), FRESH_STATE(), "the store:");
  eq(await withTenant(await C.getTenant("fresh"), () => getCmsMode()), "documents", "getCmsMode in the tenant:");
  const cfg = await cfgOf("fresh");
  ok(!Object.hasOwn(cfg, "theme_pin") && !Object.hasOwn(cfg, "theme") && !Object.hasOwn(cfg, "brand"), `no theme_pin, theme or brand: ${JSON.stringify(cfg)}`);
  eq(K.themePinOf(cfg), null, "themePinOf (never published):");
  const summary = P.editorSummary(r.run.refs);
  ok(/new editor/.test(summary), summary);
});

await t("unit: CONTENT_TABLES covers the brief's list and every content table in migrations/tenant (a new content table must be added to it)", async () => {
  for (const tname of BRIEF_TABLES) ok(P.CONTENT_TABLES.includes(tname), `missing ${tname}`);
  const migs = await loadMigs("tenant");
  const created = new Set(migs.flatMap((m) => [...String(m.sql || "").matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)].map((x) => x[1])));
  ok(created.size > 20, `tables read from the migrations: ${created.size}`);
  const contentish = [...created].filter((n) => /^(cms_|document|release|publish_|placements$|page_redirects$|.*_overrides$|.*_content_live$|content_live)/.test(n));
  const notState = contentish.filter((n) => !["cms_state", "release_state"].includes(n));
  same(notState.filter((n) => !P.CONTENT_TABLES.includes(n)), [], "content tables not in CONTENT_TABLES:");
  for (const tname of P.CONTENT_TABLES) ok(created.has(tname), `${tname} is not a tenant table`);
});

await t("unit: a failure injected before every step (failAt) and resumed ends in the same state as an uninterrupted run", async () => {
  const stepNames = freshRun.steps.map((x) => x.name);
  for (const [i, step] of stepNames.entries()) {
    const id = `fa${i}`;
    const r = await P.runProvision(params(id), { failAt: step });
    eq(r.failedStep, step, `${step} failed:`);
    // the stored run keeps no database address (redacted settings), so an
    // adopted run is resumed with its address again
    const after = await P.runProvision({ dbUrl: `file:.test-prov-${id}.db` }, { resumeRunId: r.run.id });
    eq(after.run.status, "done", `${step} resumed (${after.error}):`);
    eq(after.run.refs.contentMode, "documents", `${step} contentMode:`);
    eq(after.run.steps.filter((x) => x.status === "done").length, stepNames.length, `${step} every step done:`);
    same(await storeState(`.test-prov-${id}.db`), FRESH_STATE(), `${step} the store:`);
    const cfg = await cfgOf(id);
    ok(!Object.hasOwn(cfg, "theme_pin"), `${step}: no theme_pin`);
    ok(await B.subscriptionFor(id), `${step}: billing`);
  }
});

await t("unit: resuming a run that adopted a database without its address is refused in plain words at create_db (it never creates a new database in its place)", async () => {
  const r = await P.runProvision(params("noaddr"), { failAt: "create_db" });
  eq(r.failedStep, "create_db");
  const again = await P.runProvision({}, { resumeRunId: r.run.id });
  eq(again.failedStep, "create_db", "refused:");
  eq(again.error, "This run uses an existing database. Resume it with that database's address.", "words:");
  eq(await C.getTenant("noaddr"), null, "nothing registered:");
});

await t("unit: content_mode re-reads cms_state, so a resume after its change landed (but before the step was recorded) records 'documents' and writes nothing again", async () => {
  const r = await P.runProvision(params("fa7"), { failAt: "seed_defaults" });
  eq(r.failedStep, "seed_defaults");
  const at = (await rawSql(".test-prov-fa7.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
  eq(at.mode, "documents", "after content_mode:");
  // as if the process died after the UPDATE and before the step was saved
  const row = await runRowOf(r.run.id);
  row.steps.find((x) => x.name === "content_mode").status = "pending";
  delete row.refs.contentMode;
  await C.platformDb().execute({ sql: "UPDATE provision_runs SET steps = ?, refs = ? WHERE id = ?", args: [JSON.stringify(row.steps), JSON.stringify(row.refs), r.run.id] });
  const done = await P.runProvision({}, { resumeRunId: r.run.id });
  eq(done.run.status, "done");
  eq(done.run.refs.contentMode, "documents", "recorded:");
  // the step only reads now: the database still holds no content, so "fresh"
  eq(done.run.refs.contentModeReason, P.CONTENT_MODE_REASONS.fresh, "reason:");
  same((await rawSql(".test-prov-fa7.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], at, "no second write:");
});

// (Legacy CMS adoption/escape tests removed — all stores now use Documents CMS via migration 0026)
await t("unit: a database whose stored mode isn't documents (a stale 'legacy') stops the run at content_mode in plain words; nothing is registered", async () => {
  const r = await P.runProvision(params("stalemode"), { failAt: "content_mode" });
  eq(r.failedStep, "content_mode");
  await rawSql(".test-prov-stalemode.db", "UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
  const again = await P.runProvision({}, { resumeRunId: r.run.id });
  eq(again.failedStep, "content_mode", "stopped:");
  ok(/no longer runs/.test(again.error || "") && /Contact support/.test(again.error || ""), `words: ${again.error}`);
  eq(await C.getTenant("stalemode"), null, "nothing registered:");
  eq((await rawSql(".test-prov-stalemode.db", "SELECT mode FROM cms_state WHERE id = 1"))[0].mode, "legacy", "cms_state untouched:");
});

await t("unit: an unknown contentMode is refused", async () => {
  let refused = null;
  try {
    await P.runProvision(params("badmode", { contentMode: "documentz" }));
  } catch (e) {
    refused = e.message;
  }
  ok(/contentMode must be one of documents$/.test(refused || ""), `refused: ${refused}`);
  eq(await C.getTenant("badmode"), null, "nothing registered:");
});

await t("unit: an existing tenant is untouched by provisioning others", async () => {
  eq(acmeBefore.row.mode, "documents", "acme is documents:");
  same(await storeState(".test-prov-t1.db"), acmeBefore.state, "acme's store:");
  same((await rawSql(".test-prov-t1.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], acmeBefore.row, "acme's cms_state row:");
});

// ---- the new store, closed until its first publish (PUB-06) --------------------------------
const FRESH = async () => C.getTenant("fresh");
const inF = async (fn) => withTenant(await FRESH(), fn);
async function asRequest(fn, cookies = {}) {
  globalThis.__provRequest = { host: "fresh.test", cookies };
  try {
    return await fn();
  } finally {
    globalThis.__provRequest = null;
  }
}
const ownerU = await createUser({ email: "owner@fresh.test", name: "Fresh Owner", password: "fresh-owner-pass-1" });
await addMembership(ownerU.id, "fresh", "owner");
const OWNER = (await S.createSession({ userId: ownerU.id, kind: "merchant", ttlMs: 600_000 })).token;
const ACTOR = { kind: "merchant", id: ownerU.id };
const reqFor = (body, path = "/api/admin/x") => {
  const url = new URL(`http://fresh.test${path}`);
  return {
    url: url.href,
    nextUrl: url,
    cookies: { get: (n) => (n === "_admin" ? { name: n, value: OWNER } : undefined) },
    headers: { get: (k) => ({ host: "fresh.test" })[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
};
async function adminRoute(path, method, body) {
  const mod = await import(`../app/api/${path}/route.js`);
  const res = await mod[method](reqFor(body, `/api/${path}`), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}
const api = (body) => inF(() => handleDocumentsPut(reqFor(body, "/api/admin/documents")));
const doc = (id) => inF(() => Docs.getDocument(id));
async function publishOne(id) {
  const d = await doc(id);
  return api({ publish: { id, draftHash: d.draftHash }, revision: d.revision });
}
const sec = (kind, id, settings = {}) => {
  const x = R.newSection(kind, { id });
  return { ...x, settings: { ...x.settings, ...settings } };
};
const routeBody = (type, slug, title, sections) => {
  const b = R.emptyBody(type);
  return { ...b, meta: { ...b.meta, slug, title }, sections };
};
async function makeAndPublish(type, slug, title) {
  const made = await api({ createDocument: { type, body: routeBody(type, slug, title, [sec("text", `sec_${slug.replace(/-/g, "_")}`, { title, body: [`${title} words`] })]) } });
  eq(made.status, 200, `create ${type} ${slug}: ${JSON.stringify(made.body).slice(0, 300)}`);
  const id = made.body.document.id;
  const p = await publishOne(id);
  eq(p.status, 200, `publish ${type} ${slug}: ${JSON.stringify(p.body).slice(0, 300)}`);
  return id;
}

// a product to buy (a catalog row; not store content)
await inF(async () => {
  await db.insertInto("products").values({ id: "gid://t/P1", handle: "tee", title: "Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute();
  await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "M", price: 500, currency: "INR", available: 1 }).execute();
});

const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Provision Test" };
const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
let cartN = 0;
async function cartOnFresh() {
  const id = `prov-cart-${++cartN}`;
  await inF(async () => {
    await createCart(id);
    await addItem(id, "gid://t/V1", 1);
  });
  return id;
}
async function checkout(cartId, action, cookies = {}) {
  const cart = await inF(() => getCart(cartId));
  const { computeShipping } = await import("../lib/shipping.js");
  const shipping = computeShipping({ subtotal: cart.subtotal || 0, discountTotal: cart.discountTotal || 0, paymentMethod: action === "cod" ? "cod" : "prepaid", pincode: ADDRESS.pincode, config: undefined });
  const jar = { [CART_COOKIE]: cartId, ...cookies };
  const req = new NextRequest("https://fresh.test/api/checkout", {
    method: "POST",
    headers: { host: "fresh.test", "content-type": "application/json", cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") },
    body: JSON.stringify({ action, contact: CONTACT, address: ADDRESS, idempotencyKey: `prov-k-${++cartN}`, expectedTotal: (cart.total || 0) + shipping.total, expectedShipping: shipping.total }),
  });
  globalThis.__provRequest = { host: "fresh.test", cookies: jar };
  try {
    const res = await checkoutRoute.POST(req, { params: Promise.resolve({}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    globalThis.__provRequest = null;
  }
}
const ordersOf = (cartId) => inF(() => db.selectFrom("orders").select(["id", "payment_method", "email"]).where("cart_id", "=", cartId).execute());

await t("unit: the new tenant is closed before its first publish: isStoreClosed() is true, contentSource().mode is 'closed', the home getters are neutral and the sitemap lists only '/'", async () => {
  eq((await storeState(".test-prov-fresh.db")).mode, "documents", "a catalog row leaves the store on documents:");
  eq(await asRequest(() => inF(() => Res.isStoreClosed())), true, "isStoreClosed:");
  const src = await asRequest(() => inF(() => Res.contentSource()));
  eq(src.mode, "closed", "contentSource().mode:");
  same(await asRequest(() => inF(() => Res.resolvedHomePage())), [], "resolvedHomePage:");
  same(await asRequest(() => inF(() => Res.resolvedHomeSections())), [], "resolvedHomeSections:");
  eq(await asRequest(() => inF(() => Res.resolvedHero())), null, "resolvedHero:");
  same(await asRequest(() => inF(() => Res.resolvedAnnouncement())), { enabled: false, text: "", href: "" }, "resolvedAnnouncement:");
  same(await asRequest(() => inF(() => Res.resolvedContentPageList())), [], "page list:");
  const map = await asRequest(() => inF(() => sitemap()));
  same(map.map((e) => e.url), ["https://fresh.test/"], "sitemap:");
});

await t("unit: on the closed new store an anonymous checkout is refused (403 STORE_CLOSED, no order) and the founder's preview session places a COD test order (snehal@mediastic.in, cancelled after)", async () => {
  for (const action of ["cod", "razorpay_create"]) {
    const cart = await cartOnFresh();
    const r = await checkout(cart, action, { _admin: OWNER });
    eq(r.status, 403, `anonymous ${action} (a console cookie is no proof):`);
    eq(r.body.code, "STORE_CLOSED", "code:");
    eq((await ordersOf(cart)).length, 0, "no order:");
  }
  const s = await inF(() => PS.createPreviewSession({ actor: ACTOR }));
  const cart = await cartOnFresh();
  globalThis.__provAfter.length = 0;
  const r = await checkout(cart, "cod", { [Res.PREVIEW_COOKIE]: s.token });
  eq(r.status, 200, `preview COD (${JSON.stringify(r.body)}):`);
  const stored = await ordersOf(cart);
  eq(stored.length, 1, "one order:");
  same([stored[0].payment_method, stored[0].email], ["cod", "snehal@mediastic.in"], "the test order:");
  // the after-response work (the Shopify push) is collected, never run here;
  // the test order is cancelled after, as every test order is
  globalThis.__provAfter.length = 0;
  await inF(() => db.updateTable("orders").set({ status: "cancelled" }).where("id", "=", stored[0].id).execute());
  await inF(() => PS.revokePreviewSession({ sid: s.sid }));
});

const FORBIDDEN_HREF = (h) => /^\/admin\/(theme|catalog|home|upsells)(?:[/?#]|$)/.test(h) || /^\/admin\/storefront(?:[?#]|$)/.test(h);
const CONSOLE_PAGES = { "/admin/integrations": "integrations", "/admin/settings": "settings", "/admin/billing": "billing", "/admin/onboarding": "onboarding", ...Object.fromEntries(["checkout", "shipping", "domains", "tracking", "sync", "privacy", "audit", "help"].map((t) => [`/admin/settings/${t}`, `settings/${t}`])) }; // the settings tabs (Phase 2 line 7)
async function hrefWorks(h) {
  if (h === "/admin/editor" || h.startsWith("/admin/editor?")) return access(join(ROOT, "app/(console)/admin/(authed)/editor/page.js")).then(() => true, () => false);
  const path = h.split(/[?#]/)[0];
  if (!CONSOLE_PAGES[path]) return false;
  return access(join(ROOT, `app/(console)/admin/(authed)/${CONSOLE_PAGES[path]}/page.js`)).then(() => true, () => false);
}
const onboarding = () => inF(() => ON.onboardingFor({ role: "owner" }));
const stepOf = (m, id) => m.steps.find((i) => i.id === id);

await t("unit (ED05 review, pinned; Phase 1 line 3): a closed documents store's onboarding has the four steps; every link in the Open step (the opening report's items) is an editor or working console destination, never /admin/theme, /admin/catalog, /admin/home, /admin/upsells or a bare /admin/storefront; the test order goes through the preview; a check-off can't open the store", async () => {
  const m = await onboarding();
  eq(m.supported, true);
  same(m.steps.map((i) => i.id), OS.STEP_IDS, "steps:");
  const open = stepOf(m, "open");
  ok(open.facts.items.length > 0, "the opening report's items");
  for (const i of open.facts.items) {
    if (!i.href) continue;
    ok(!FORBIDDEN_HREF(i.href), `${i.id} links to ${i.href}`);
    ok(await hrefWorks(i.href), `${i.id}: ${i.href} is not an editor or working console destination`);
  }
  eq(stepOf(m, "brand").state === "done", false, "no home page or brand yet:");
  eq(stepOf(m, "import").state, "done", "the import step reads products as on any store:");
  // the preview COD test order above was placed while the store was closed, so the item is ok;
  // before it, the item sent the founder to the preview (TEST_ORDER_CLOSED_HINT, test-open-checks)
  const order = open.facts.items.find((i) => i.id === "test_order");
  same([order.level, order.href], ["ok", null], "the closed-store test order counts:");
  same([open.state === "done", m.open], [false, false], "not open before the first publish:");
  ok(/Before your store can open/.test(open.words) || open.state === "ready", open.words);
  // a check-off can't claim the store is open: only the test order is stored, and it opens nothing
  await inF(() => ON.markTestOrder(true));
  const after = await withTenant(await C.getTenant("fresh", { fresh: true }), () => ON.onboardingFor({ role: "owner" }));
  same([after.open, stepOf(after, "open").facts.testOrderMarked, stepOf(after, "open").facts.items.find((i) => i.id === "test_order").level], [false, true, "ok"], "test order checked off, store still closed:");
});

await t("unit: theme apply saves only the doc_design draft; saving doc_design through the documents API works", async () => {
  const cfg0 = await cfgOf("fresh");
  // the theme screen on a documents store saves the design DRAFT (P3-DESIGN), never the config
  const th = await adminRoute("admin/theme", "POST", { action: "apply", kit: "glow", withPresets: false });
  eq(th.status, 200, `theme apply: ${JSON.stringify(th.body).slice(0, 300)}`);
  same(await cfgOf("fresh"), cfg0, "the control-plane config is unchanged (no brand, theme or pin):");
  eq((await storeState(".test-prov-fresh.db")).counts.cms_blocks, 0, "no old block:");
  const d = await doc("doc_design");
  same([d.body.settings.theme.kit, d.publishedVersionId ?? null], ["glow", null], "the design draft, not published:");
  // the founder's own design save through the documents API
  const next = structuredClone(d.body);
  next.settings.brand = { ...(next.settings.brand || {}), accent: "#0f766e" };
  const saved = await api({ saveDraft: { id: "doc_design", body: next }, revision: d.revision });
  eq(saved.status, 200, `saveDraft doc_design: ${JSON.stringify(saved.body).slice(0, 300)}`);
  eq((await doc("doc_design")).body.settings.brand.accent, "#0f766e", "saved:");
  eq(await asRequest(() => inF(() => Res.isStoreClosed())), true, "saving opens nothing:");
});

await t("unit: the founder publishes a first home page (open doc_home, save a section, publish): the store opens, resolvedHomePage shows the section from a live content.v 4 release, and onboarding reads every step done from the live state", async () => {
  const made = await api({ createDocument: { type: "home" } });
  eq(made.status, 200, `create home: ${JSON.stringify(made.body).slice(0, 300)}`);
  const home = await doc("doc_home");
  const body = { ...home.body, sections: [sec("text", "sec_first", { title: "Our first words", body: ["Hello, shoppers."] })] };
  const saved = await api({ saveDraft: { id: "doc_home", body }, revision: home.revision });
  eq(saved.status, 200, `save home: ${JSON.stringify(saved.body).slice(0, 300)}`);
  eq(await asRequest(() => inF(() => Res.isStoreClosed())), true, "a saved draft is still private:");
  // P6-OPEN rule b: the founder saved a design draft above, so publishing the
  // home page alone is refused and offers the design with it (never a lime
  // first open). Publishing the offer opens the store.
  const alone = await publishOne("doc_home");
  same([alone.status, alone.body.code], [409, "OPENING_NEEDS_DESIGN"], `home alone: ${JSON.stringify(alone.body).slice(0, 300)}`);
  same(alone.body.offer.publishSet.map((x) => x.id), ["doc_home", "doc_design"], "the offer adds the design:");
  eq(await asRequest(() => inF(() => Res.isStoreClosed())), true, "the refusal opens nothing:");
  const pins = [];
  After.setThemePinWriter(async (tenantId, pin) => {
    pins.push([tenantId, pin]);
  });
  let p;
  try {
    p = await api({ publishSet: alone.body.offer.publishSet });
  } finally {
    After.setThemePinWriter(null);
  }
  eq(p.status, 200, `publish: ${JSON.stringify(p.body).slice(0, 300)}`);
  eq(pins.length, 1, "the design went live with it (one pin write):");
  eq(await asRequest(() => inF(() => Res.isStoreClosed())), false, "isStoreClosed after the first publish:");
  const src = await asRequest(() => inF(() => Res.contentSource()));
  same([src.mode, src.v], ["live", 4], "contentSource:");
  const rel = await rawSql(".test-prov-fresh.db", "SELECT r.content FROM releases r JOIN release_state s ON s.live_release_id = r.id WHERE s.id = 1");
  eq(JSON.parse(String(rel[0].content)).v, 4, "the live release is content.v 4:");
  const page = await asRequest(() => inF(() => Res.resolvedHomePage()));
  ok(JSON.stringify(page).includes("Our first words") && JSON.stringify(page).includes("sec_first"), `resolvedHomePage: ${JSON.stringify(page).slice(0, 300)}`);
  const map = await asRequest(() => inF(() => sitemap()));
  ok(map.length > 1, "the sitemap lists more than the front door once open:");
  const m = await onboarding();
  same([m.open, m.current, m.doneCount, m.steps.map((s) => s.state)], [true, "open", 4, ["done", "done", "done", "done"]], "every step done from the live state:");
  same([stepOf(m, "open").words, stepOf(m, "open").facts.items], [OS.WORDS.open.done, []], "an open store has nothing left to open:");
  eq(stepOf(m, "brand").state, "done", "the design opened with the store:");
});

await t("unit: a later doc_design publish writes theme_pin (setThemePinWriter spy); the Brand step stays done", async () => {
  // the design went live with the first publish (P6-OPEN rule b); the founder
  // changes it again and publishes that on the open store
  const d = await doc("doc_design");
  const next = structuredClone(d.body);
  next.settings.brand = { ...(next.settings.brand || {}), accent: "#1d4ed8" };
  const saved = await api({ saveDraft: { id: "doc_design", body: next }, revision: d.revision });
  eq(saved.status, 200, `saveDraft doc_design: ${JSON.stringify(saved.body).slice(0, 300)}`);
  const calls = [];
  After.setThemePinWriter(async (tenantId, pin) => {
    calls.push([tenantId, pin]);
  });
  let p;
  try {
    p = await publishOne("doc_design");
  } finally {
    After.setThemePinWriter(null);
  }
  eq(p.status, 200, `publish design: ${JSON.stringify(p.body).slice(0, 300)}`);
  eq(calls.length, 1, "one pin write:");
  eq(calls[0][0], "fresh", "for this store:");
  eq(calls[0][1]?.kit, "glow", `the published look: ${JSON.stringify(calls[0][1])}`);
  ok(calls[0][1]?.release, "the pin names the live release:");
  // Phase 1 line 3: an open store's Brand step is done and still offers its controls (the logo is changed there)
  const step = stepOf(await onboarding(), "brand");
  same([step.state, step.words], ["done", OS.WORDS.brand.done], "brand step:");
  ok(step.actions.some((a) => a.id === "brand_save" && a.allowed), "the brand controls stay for the owner");
  ok(!/then publish it/.test(step.words), step.words);
});

await t("unit (ED05 review, pinned; Phase 1 line 3): the published page list holds campaigns (only the family filter keeps them out); an open store's onboarding stays all done whatever legal pages come and go (opening is checked before the first publish only)", async () => {
  await makeAndPublish("campaign", "privacy-week", "Privacy week sale");
  await makeAndPublish("campaign", "terms-and-returns-week", "Returns week");
  await makeAndPublish("journal", "terms-explained", "Terms explained");
  const listed = await asRequest(() => inF(() => Res.resolvedContentPageList()));
  same(listed.map((p) => [p.slug, p.family, p.enabled]), [["privacy-week", "campaign", true], ["terms-and-returns-week", "campaign", true]], "the published list holds both campaigns (only the family filter keeps them out; journal posts are not in the list):");
  const allDone = async (label) => same((await onboarding()).steps.map((s) => s.state), ["done", "done", "done", "done"], label);
  await allDone("campaigns and a journal post:");
  const priv = await api({ createDocument: { type: "page", body: routeBody("page", "privacy", "Privacy", [sec("text", "sec_priv", { title: "Privacy", body: ["We keep little."] })]) } });
  eq(priv.status, 200);
  await allDone("a draft privacy page:");
  eq((await publishOne(priv.body.document.id)).status, 200, "publish privacy:");
  await makeAndPublish("page", "terms", "Terms");
  await allDone("privacy and terms published:");
});

await t("unit: a --force re-provision of the published documents store keeps it on the new editor with its live release", async () => {
  const before = await storeState(".test-prov-fresh.db");
  ok(before.live, "live release:");
  const r = await P.runProvision(params("fresh", { force: true }));
  eq(r.run.status, "done", `force (${r.error}):`);
  same([r.run.refs.contentMode, r.run.refs.contentModeReason], ["documents", P.CONTENT_MODE_REASONS.already], "kept:");
  same(await storeState(".test-prov-fresh.db"), before, "untouched:");
});

// (Legacy tenant checklist test removed — all tenants use Documents CMS)

// ---- P6-ONBOARD: the first-run checklist on a documents store ------------------------------
// GEN-04, PUB-12, US-01, US-41. A closed documents store with an empty
// catalog ("onb"), its brand step, its policy starters, and the same rule as
// "Before you open your store" (policyStatus), read as onboarding's Brand and
// Open steps (Phase 1 line 3; the SetupAdmin screen is retired, the page's
// rendered tests come with WP-B).
console.log("— P6-ONBOARD: the Brand step and the legal pages (Open step) on a documents store");
const PS6 = await import("../lib/first-run/policy-start.js");
const BS6 = await import("../lib/first-run/brand-step.js");
const PP6 = await import("../lib/documents/policy-pages.js");
const OP6 = await import("../lib/documents/opening.js");
const PAL6 = await import("../lib/themes/palettes.js");
const onbRun = await P.runProvision(params("onb"));
const inO = async (fn) => withTenant(await C.getTenant("onb"), fn);
const onbU = await createUser({ email: "owner@onb.test", name: "Onb Owner", password: "onb-owner-pass-1" });
await addMembership(onbU.id, "onb", "owner");
const OACT = { kind: "merchant", id: onbU.id, role: "owner" };
const olist = () => inO(() => ON.onboardingFor({ role: "owner" }));
// no step's words on a documents store may send the founder to add or publish a page "in the editor"
const EDITOR_PAGE_HINT = (h) => /in the editor/i.test(h) || /\b(add|publish)\b[^.]*\bpages?\b[^.]*\beditor\b/i.test(h);
async function checkHintsAndLinks(m, label) {
  for (const s of m.steps) ok(!EDITOR_PAGE_HINT(s.words), `${label}: ${s.id} words send the founder to the editor for a page: ${s.words}`);
  // line 7: the links are the items' fixes
  for (const i of stepOf(m, "open").facts.items) for (const f of i.fixes || []) for (const href of [f.href, f.editHref].filter(Boolean)) ok(await hrefWorks(href), `${label}: ${i.id}: ${href} is not a console page`);
}
// PUB-12 and onboarding agree: each kind counts exactly when the opening
// report does not block on it, and the Open step is blocked by exactly the
// report's block items (Phase 1 line 3: the report IS the Open step's facts)
async function agreesWithOpening(step) {
  const rep = await inO(() => OP6.openingReport());
  eq(rep.opening, true, "the store is closed:");
  const st = await inO(async () => PP6.policyStatus(await PP6.readPolicyRows()));
  const level = (k) => rep.items.find((i) => i.id === k).level;
  for (const k of PP6.POLICY_KINDS) eq(PP6.policyCounts(st[k].state), level(k) !== "block", `${k}: policyStatus ${st[k].state} vs opening ${level(k)}:`);
  // line 7: the home page line comes first, then the report's items, each with its fixes
  eq(step.facts.items[0]?.id, "home", "the home line first:");
  const home = step.facts.items[0].level === "block" ? ["home"] : [];
  const blocks = [...home, ...rep.items.filter((i) => i.level === "block").map((i) => i.id)];
  eq(step.state, blocks.length ? "blocked" : "ready", "onboarding state vs opening:");
  same((step.facts.blocking || []).map((b) => b.id), blocks, "the same blocking items:");
  same(step.facts.items.slice(1).map((i) => [i.id, i.level, i.title]), rep.items.map((i) => [i.id, i.level, i.title]), "the step shows the report's items:");
}
const policyOf = (step, kind) => step.facts.items.find((i) => i.id === kind);

await t("unit (P6-ONBOARD; Phase 1 line 3): the Brand step on a closed documents store: ready with nothing; in progress once the brand step is recorded (skip) with no home page; done once doc_home exists too", async () => {
  same([onbRun.run.status, onbRun.run.refs.contentMode], ["done", "documents"], `onb (${onbRun.error}):`);
  let m = await olist();
  same([stepOf(m, "brand").state, stepOf(m, "brand").words], ["ready", OS.WORDS.brand.ready], "nothing yet:");
  ok(await hrefWorks("/admin/onboarding?step=brand"), "/admin/onboarding is a console page");
  await inO(() => BS6.saveBrandStep({ skip: true }, OACT));
  m = await olist();
  same([stepOf(m, "brand").state, stepOf(m, "brand").facts], ["in_progress", { brandRecorded: true, hasHome: false }], "the brand step skipped, no home page:");
  await inO(() => db.insertInto("products").values({ id: "gid://t/ONB1", handle: "onb-tee", title: "Onb Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute());
  eq(stepOf(await olist(), "brand").state, "in_progress", "products, no home page:");
  await inO(() => Docs.createDocument({ type: "home", actor: OACT }));
  m = await olist();
  same([stepOf(m, "brand").state, stepOf(m, "brand").words], ["done", OS.WORDS.brand.done], "doc_home exists:");
  await checkHintsAndLinks(m, "onb");
});

await t("unit (P6-ONBOARD; Phase 1 line 3): a brand-step save with nothing live records the Brand step (in progress until the home page exists), and its words never say 'then publish it'", async () => {
  const r = await P.runProvision(params("onbui"));
  eq(r.run.status, "done", `onbui (${r.error}):`);
  const inU = async (fn) => withTenant(await C.getTenant("onbui", { fresh: true }), fn);
  const before = stepOf(await inU(() => ON.onboardingFor({ role: "owner" })), "brand");
  same([before.state, before.facts.brandRecorded], ["ready", false], "before:");
  const saved = await inU(() => BS6.saveBrandStep({ paletteId: PAL6.DEFAULT_PALETTE_ID }, OACT));
  same([saved.ok, saved.skipped], [true, false], `saved: ${JSON.stringify(saved).slice(0, 200)}`);
  eq(await asRequest(() => inU(() => Res.isStoreClosed())), true, "nothing live:");
  const after = stepOf(await inU(() => ON.onboardingFor({ role: "owner" })), "brand");
  same([after.state, after.facts.brandRecorded, after.words], ["in_progress", true, OS.WORDS.brand.in_progress], "after a save:");
  ok(!/then publish it/.test(after.words), after.words);
  // the skipped store (test above) is done: it has its home page
  eq(stepOf(await olist(), "brand").state, "done", "after a skip and a home page:");
});

let starterPrivacy = null;
await t("unit (P6-ONBOARD, PUB-12 review rule; Phase 1 line 3): on a closed documents store the Open step is blocked by the privacy and returns pages with two start buttons; a starter draft still blocks and offers 'Read it' and 'I've read it'; I've read it (body unchanged) counts it; a founder-saved terms draft unblocks; opening and onboarding agree at every stage", async () => {
  let step = stepOf(await olist(), "open");
  eq(step.state, "blocked", "no pages:");
  same(step.facts.blocking.map((b) => b.id), ["privacy", "returns"], "blocked by both pages:");
  ok(step.words.startsWith(OS.WORDS.open.blocked), step.words);
  same(["privacy", "returns"].map((k) => policyOf(step, k).fixes), [
    [{ kind: "policy_start", policyKind: "privacy", label: "Start a privacy page", allowed: true }],
    [{ kind: "policy_start", policyKind: "returns", label: "Start a returns page", allowed: true }],
  ], "two start buttons:");
  same(step.actions.filter((a) => ["policy_start", "policy_read"].includes(a.id)).map((a) => [a.id, a.allowed]), [["policy_start", true], ["policy_read", true]], "the owner may press them:");
  await agreesWithOpening(step);
  // a starter privacy draft, written by the policy starter
  const made = await inO(() => Docs.createDocument({ type: "page", body: PS6.starterBody("privacy"), actor: PP6.POLICY_STARTER_ACTOR }));
  starterPrivacy = made.document;
  step = stepOf(await olist(), "open");
  eq(policyOf(step, "privacy").level, "block", "a starter draft does not count:");
  same(policyOf(step, "privacy").fixes, [{ kind: "policy_read", label: "Read it", docId: starterPrivacy.id, revision: starterPrivacy.revision, editHref: `/admin/editor?doc=${starterPrivacy.id}`, allowed: true, markRead: { label: "I've read it", allowed: true } }], "the privacy start button is replaced (line 7: 'Read it' opens the reader, 'I've read it' at its end):");
  same(policyOf(step, "returns").fixes, [{ kind: "policy_start", policyKind: "returns", label: "Start a returns page", allowed: true }], "the returns one stays:");
  await agreesWithOpening(step);
  // the returns starter through the real op: both are starters now
  const ret = await inO(() => PS6.startPolicyPage({ kind: "returns", actor: OACT }));
  eq(ret.status, 200, `returns starter: ${JSON.stringify(ret.body).slice(0, 200)}`);
  step = stepOf(await olist(), "open");
  same(step.facts.blocking.map((b) => b.id), ["privacy", "returns"], "two starters still block:");
  await agreesWithOpening(step);
  // I've read it on the privacy starter: body unchanged, it now counts as saved
  const hashBefore = (await inO(() => Docs.getDocument(starterPrivacy.id))).draftHash;
  const mark = policyOf(step, "privacy").fixes.find((a) => a.kind === "policy_read");
  const read = await inO(() => PS6.markPolicyRead({ id: mark.docId, revision: mark.revision, actor: OACT }));
  eq(read.status, 200, `marked: ${JSON.stringify(read.body).slice(0, 200)}`);
  eq((await inO(() => Docs.getDocument(starterPrivacy.id))).draftHash, hashBefore, "the body is unchanged:");
  eq((await inO(async () => PP6.policyStatus(await PP6.readPolicyRows()))).privacy.state, "saved", "privacy counts as saved:");
  step = stepOf(await olist(), "open");
  same(step.facts.blocking.map((b) => b.id), ["returns"], "returns is still a starter:");
  await agreesWithOpening(step);
  // a merchant saveDraft of the privacy page, and the founder saves the terms page (an edit)
  const p = await inO(() => Docs.getDocument(starterPrivacy.id));
  await inO(() => Docs.saveDraft({ id: p.id, revision: p.revision, body: { ...p.body, meta: { ...p.body.meta, title: "Our privacy" } }, actor: OACT }));
  const terms = await inO(() => Docs.getDocument(ret.body.document.id));
  eq(terms.slug, "terms", "the returns starter is the terms page:");
  await inO(() => Docs.saveDraft({ id: terms.id, revision: terms.revision, body: { ...terms.body, meta: { ...terms.body.meta, title: "Our terms" } }, actor: OACT }));
  const m = await olist();
  step = stepOf(m, "open");
  same([step.state, step.words, step.facts.blocking], ["ready", OS.WORDS.open.ready, undefined], "both founder-saved:");
  await agreesWithOpening(step);
  eq(await asRequest(() => inO(() => Res.isStoreClosed())), true, "nothing was published:");
  await checkHintsAndLinks(m, "onb, pages ready");
});

// ---- P6-FIX3: the batch 3 review's onboarding test gaps ----------------------------------
console.log("— P6-FIX3: the onboarding checklist's untested paths");
const Pub6 = await import("../lib/documents/publish.js");
const { currentDatabase } = await import("../lib/db.js");
const { scanText } = await import("./support/banned-copy.js");
// one statement made to fail (by pattern) on one store's client, as
// test-console-fresh's sqlFails does; restored after
async function withFailingSql(tenantId, pattern, fn) {
  const client = await withTenant(await C.getTenant(tenantId), () => currentDatabase().libsql);
  const real = client.execute;
  client.execute = (stmt, ...rest) => {
    const sql = typeof stmt === "string" ? stmt : stmt?.sql || "";
    if (pattern.test(sql)) return Promise.reject(Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" }));
    return real(stmt, ...rest);
  };
  try {
    return await fn();
  } finally {
    // the patch is an own property of the store's client: removing it brings back its own execute
    delete client.execute;
  }
}

await t("unit (P6-FIX3; Phase 1 line 3): an OPEN documents store is all done in onboarding whatever its legal pages are (missing, a starter draft, a saved draft)", async () => {
  const r = await P.runProvision(params("onbopen"));
  eq(r.run.status, "done", `onbopen (${r.error}):`);
  const inOp = async (fn) => withTenant(await C.getTenant("onbopen"), fn);
  const opened = await inOp(async () => {
    const home = await Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [sec("text", "sec_onbopen", { title: "Open words", body: ["Hello."] })] }, actor: OACT });
    return Pub6.publish({ ids: [{ id: home.document.id, revision: home.document.revision, draftHash: home.document.draftHash }], actor: OACT });
  });
  ok(opened?.release?.id, `published: ${JSON.stringify(opened).slice(0, 200)}`);
  const ol = () => inOp(() => ON.onboardingFor({ role: "owner" }));
  const allDone = async (label) => {
    const m = await ol();
    same([m.open, m.doneCount, m.steps.map((s) => s.state), stepOf(m, "open").facts.items], [true, 4, ["done", "done", "done", "done"], []], label);
  };
  await allDone("no pages:");
  await inOp(() => Docs.createDocument({ type: "page", body: PS6.starterBody("privacy"), actor: PP6.POLICY_STARTER_ACTOR }));
  await allDone("a starter:");
  await inOp(() => Docs.createDocument({ type: "page", body: routeBody("page", "terms", "Terms", [sec("text", "sec_onbopen_terms", { title: "Terms", body: ["Our terms."] })]), actor: OACT }));
  await allDone("a saved draft:");
});

await t("unit (P6-FIX3, M4; Phase 1 line 3): the brand step counts as recorded only with its `at`: a brand_step object without `at` leaves the Brand step not recorded", async () => {
  const r = await P.runProvision(params("onbm4"));
  eq(r.run.status, "done", `onbm4 (${r.error}):`);
  const t4 = async () => C.getTenant("onbm4");
  const steps = async () => {
    const m = await withTenant(await t4(), () => ON.onboardingFor({ role: "owner" }));
    return [stepOf(m, "brand").facts.brandRecorded, stepOf(m, "brand").state];
  };
  same(await steps(), [false, "ready"], "nothing recorded:");
  const ob = (await t4()).config?.onboarding || {};
  await C.patchTenant("onbm4", { config: { onboarding: { ...ob, brand_step: { skipped: true, paletteId: "slate" } } } });
  same(await steps(), [false, "ready"], "a brand_step with no `at` (M4):");
  await C.patchTenant("onbm4", { config: { onboarding: { ...ob, brand_step: ["at"] } } });
  same(await steps(), [false, "ready"], "a list is not a record:");
  await C.patchTenant("onbm4", { config: { onboarding: { ...ob, brand_step: { skipped: true, paletteId: "slate", at: new Date().toISOString() } } } });
  same(await steps(), [true, "in_progress"], "with `at` (no home page yet):");
});

await t("unit (P6-FIX3, M8 and the policy read; Phase 1 line 3): a failed doc_home read leaves the Brand step not done; a failed policy read leaves the Open step not blocked-on-a-guess and not done ('We couldn't check this just now'), with no Open button; both come back after", async () => {
  const r = await P.runProvision(params("onbfail"));
  eq(r.run.status, "done", `onbfail (${r.error}):`);
  const inFl = async (fn) => withTenant(await C.getTenant("onbfail"), fn);
  await inFl(() => db.insertInto("products").values({ id: "gid://t/FL1", handle: "fl-tee", title: "Fl Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute());
  await inFl(() => Docs.createDocument({ type: "home", actor: OACT }));
  await C.patchTenant("onbfail", { config: { onboarding: { brand_step: { at: new Date().toISOString(), skipped: true } } } });
  const m = () => inFl(() => ON.onboardingFor({ role: "owner" }));
  eq(stepOf(await m(), "brand").state, "done", "the home exists and the step is recorded:");
  // M8: the doc_home read fails: the step is not done
  const failedHome = await withFailingSql("onbfail", /FROM documents WHERE id = 'doc_home'/, m);
  same([stepOf(failedHome, "brand").state, stepOf(failedHome, "brand").problem], ["in_progress", OS.UNREADABLE], "a failed home read (M8):");
  // readPolicyRows fails: the opening report can't be read, so the Open step says so
  const failedPol = await withFailingSql("onbfail", /WHERE type = 'page' AND archived_at IS NULL AND slug IS NOT NULL/, m);
  const open = stepOf(failedPol, "open");
  same([open.state, open.problem, open.facts.items], ["ready", OS.UNREADABLE, []], "a failed policy read:");
  ok(!open.actions.some((a) => a.id === "open_store"), "no Open button on a guess");
  eq(OS.UNREADABLE, "We couldn't check this just now. Reload this page to try again.", "the words:");
  eq(scanText(OS.UNREADABLE, { claims: false }).length, 0, "no banned words");
  // and the read works again afterwards: the start buttons are back
  const back = stepOf(await m(), "open");
  same([back.state, back.facts.blocking.map((b) => b.id)], ["blocked", ["privacy", "returns"]], "after:");
});

// ---- P4-FIX5: the P4-PROVISION review findings -------------------------------------
console.log("— P4-FIX5 / P4-FIX6: a database another store uses, and the turso CLI's database list");

await t("unit (P4-FIX5, P4-FIX6): provisioning on a database another registered store already uses stops with plain words before anything touches it (same address, another spelling, a relative or absolute file path, another ?authToken): no second store is registered, and the other store's editor and cms_state stay as they were", async () => {
  const a = await P.runProvision(params("sharea"));
  eq(a.run.status, "done", `A (${a.error}):`);
  const row = (await rawSql(".test-prov-sharea.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
  eq(row.mode, "documents", "A is documents:");
  const before = await storeState(".test-prov-sharea.db");
  const ledger = await rawSql(".test-prov-sharea.db", "SELECT id, applied_at FROM schema_migrations ORDER BY id");
  const abs = join(process.cwd(), ".test-prov-sharea.db");
  for (const [id, dbUrl] of [
    ["shareb", "file:.test-prov-sharea.db"],
    ["sharebb", "file:./.test-prov-sharea.db"],
    ["sharebc", `file:${abs}`],
    ["sharebd", `file://${abs}`],
    ["sharebe", "file:.test-prov-sharea.db?authToken=another-dummy-token"],
  ]) {
    const r = await P.runProvision(params(id, { dbUrl }));
    eq(r.run.status, "failed", `${id} stops (${dbUrl}):`);
    eq(r.failedStep, "create_db", `${id} stops before the schema step:`);
    eq(r.error, 'Another registered store ("sharea") already uses this database, so this store was not set up on it and the other store was left as it is. Give this store a database of its own.', `${id} words:`);
    ok(!/[a-z]+_[a-z_]+\b|SQLITE/.test(r.error), `plain words: ${r.error}`);
    eq(await C.getTenant(id), null, `${id}: no second store registered:`);
    same((await rawSql(".test-prov-sharea.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], row, `${id}: cms_state untouched:`);
    same(await storeState(".test-prov-sharea.db"), before, `${id}: A's store:`);
  }
  same(await rawSql(".test-prov-sharea.db", "SELECT id, applied_at FROM schema_migrations ORDER BY id"), ledger, "A's schema ledger untouched:");
  // the wrapper the CLI and the wizard use throws the same words
  const thrown = await P.provisionTenant({ id: "sharebf", name: "B", shopDomain: "sharebf.myshopify.com", dbUrl: "file:./.test-prov-sharea.db" }).then(() => null, (e) => e);
  ok(thrown && /Another registered store \("sharea"\) already uses this database/.test(thrown.message), String(thrown?.message));
  eq(await C.getTenant("sharebf"), null, "the wrapper registered nothing either:");
  // a database no other store uses still starts on the new editor (the check is not blanket)
  const c = await P.runProvision(params("sharec"));
  same([c.run.status, c.run.refs.contentMode], ["done", "documents"], `a database of its own (${c.error}):`);
  // the comparison: addresses of one database match, other databases don't
  for (const [x, y, want] of [
    ["file:.test-prov-sharea.db", "file:./.test-prov-sharea.db", true],
    ["file:.test-prov-sharea.db", `file:${abs}`, true],
    ["file:./.test-prov-sharea.db", `file://${abs}`, true],
    ["libsql://Storeasy-T-Shop-org.turso.io/", "libsql://storeasy-t-shop-org.turso.io", true],
    [" libsql://storeasy-t-shop-org.turso.io ", "libsql://storeasy-t-shop-org.turso.io", true],
    ["libsql://storeasy-t-shop-org.turso.io", "https://storeasy-t-shop-org.turso.io", true],
    ["https://storeasy-t-shop-org.turso.io:443/", "libsql://storeasy-t-shop-org.turso.io", true],
    ["libsql://storeasy-t-shop-org.turso.io?authToken=one", "libsql://storeasy-t-shop-org.turso.io?authToken=two", true],
    ["libsql://storeasy-t-shop-org.turso.io?authToken=one", "https://storeasy-t-shop-org.turso.io", true],
    ["http://127.0.0.1:7120", "libsql://127.0.0.1:7120", true],
    ["http://127.0.0.1:7120", "http://127.0.0.1:7121", false],
    ["libsql://storeasy-t-shop-org.turso.io", "libsql://storeasy-t-shop2-org.turso.io", false],
    ["file:.test-prov-sharea.db", "file:.test-prov-sharec.db", false],
    ["file:.test-prov-sharea.db", "file:sub/.test-prov-sharea.db", false],
    ["", "", false],
    [null, null, false],
  ]) eq(P.sameDbAddress(x, y), want, `${JSON.stringify(x)} vs ${JSON.stringify(y)}:`);
});

await t("unit (P4-FIX6): a run that resumes after another store was registered on its database stops at content_mode with the same words, leaves the database's editor as it was and registers nothing", async () => {
  const first = await P.runProvision(params("shared", { dbUrl: "file:.test-prov-shared.db" }), { failAt: "content_mode" });
  eq(first.failedStep, "content_mode", `stopped by the test hook (${first.error}):`);
  const row = (await rawSql(".test-prov-shared.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
  eq(row.mode, "documents", "cms_state initialized:");
  // meanwhile another store is registered on that database (another spelling)
  await C.upsertTenant({ id: "sharedother", name: "Other", domains: ["sharedother.test"], dbUrl: "file:./.test-prov-shared.db", config: {}, secrets: {} });
  const again = await P.runProvision({}, { resumeRunId: first.run.id });
  eq(again.failedStep, "content_mode", `the resume stops (${again.error}):`);
  eq(again.error, 'Another registered store ("sharedother") already uses this database, so this store was not set up on it and the other store was left as it is. Give this store a database of its own.', "words:");
  same((await rawSql(".test-prov-shared.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], row, "the editor setting untouched:");
  eq(await C.getTenant("shared"), null, "nothing registered:");
});

await t("unit (P4-FIX5): createTenantDatabase through a stubbed turso CLI matches the database name exactly: 'shop' is created when only 'shop2' is listed, and an existing 'shop' is adopted, never created again", async () => {
  // P4-FIX6: the seam is test-only: no setter is exported from the shipped module
  eq(typeof P.setTursoRunnerForTest, "undefined", "no exported setter:");
  ok(typeof P.TURSO_TEST_RUNNER === "symbol", "the seam's symbol");
  const saved = { token: process.env.TURSO_API_TOKEN, org: process.env.TURSO_ORG };
  delete process.env.TURSO_API_TOKEN;
  delete process.env.TURSO_ORG;
  const calls = [];
  let listed = "";
  globalThis[P.TURSO_TEST_RUNNER] = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "db" && args[1] === "list") return listed;
    if (args[0] === "db" && args[1] === "show") return `libsql://${args[2]}-org.turso.io`;
    if (args[0] === "db" && args[1] === "tokens") return "stub-token-not-a-secret";
    if (args[0] === "db" && args[1] === "create") return `Created database ${args[2]}`;
    throw new Error(`unexpected turso call: ${args.join(" ")}`);
  };
  try {
    const HEADER = "NAME                 GROUP      URL";
    listed = `${HEADER}\nstoreasy-t-shop2     default    libsql://storeasy-t-shop2-org.turso.io\nstoreasy-t-myshop   default    libsql://storeasy-t-myshop-org.turso.io\n`;
    const made = await P.createTenantDatabase("shop");
    same(calls, ["db list", "db create storeasy-t-shop", "db show storeasy-t-shop --url", "db tokens create storeasy-t-shop"], "'shop' is created beside 'shop2' and 'myshop':");
    same([made.created, made.dbUrl], [true, "libsql://storeasy-t-shop-org.turso.io"], "created:");
    calls.length = 0;
    listed = `${HEADER}\nstoreasy-t-shop2     default    libsql://storeasy-t-shop2-org.turso.io\nstoreasy-t-shop      default    libsql://storeasy-t-shop-org.turso.io\n`;
    const again = await P.createTenantDatabase("shop");
    same(calls, ["db list", "db show storeasy-t-shop --url", "db tokens create storeasy-t-shop"], "an existing 'shop' is adopted, not created:");
    eq(again.created, false, "not created:");
    // the list parser: first column, header skipped, no substring match
    same([...P.listedDbNames(listed)], ["storeasy-t-shop2", "storeasy-t-shop"], "names:");
    eq(P.listedDbNames(`${HEADER}\nstoreasy-t-shop2  default  x`).has("storeasy-t-shop"), false, "'shop' is not in a list with only 'shop2':");
    eq(P.listedDbNames("").size, 0, "an empty list:");
  } finally {
    delete globalThis[P.TURSO_TEST_RUNNER];
    if (saved.token !== undefined) process.env.TURSO_API_TOKEN = saved.token;
    if (saved.org !== undefined) process.env.TURSO_ORG = saved.org;
  }
});

// Phase 1 line 2 (docs/plans/phase-1.md, Fit): two token bugs in the step ledger.
// The database is served by the local Turso fake, whose Hrana server refuses a
// request without a token it minted; the `turso` CLI is the stub seam.
async function withTokenCheckedDb(name, fn) {
  const { startFakeTursoApi } = await import("./support/fake-turso-api.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "storeasy-prov-tok-"));
  const fake = await startFakeTursoApi({ token: "prov-fake-api", org: "o", dataDir: dir, backend: "file" });
  const saved = { token: process.env.TURSO_API_TOKEN, org: process.env.TURSO_ORG };
  delete process.env.TURSO_API_TOKEN;
  delete process.env.TURSO_ORG;
  const d = await fake.addDatabase(`storeasy-t-${name}`);
  const mint = async () => (await (await fetch(`${fake.url}/v1/organizations/o/databases/storeasy-t-${name}/auth/tokens?expiration=never`, { method: "POST", headers: { Authorization: "Bearer prov-fake-api" } })).json()).jwt;
  globalThis[P.TURSO_TEST_RUNNER] = async (args) => {
    if (args[1] === "list") return `NAME  GROUP  URL\nstoreasy-t-${name}  default  ${d.localUrl}\n`;
    if (args[1] === "show") return d.localUrl;
    if (args[1] === "tokens") return mint();
    throw new Error(`unexpected turso ${args.join(" ")}`);
  };
  try {
    await fn();
  } finally {
    delete globalThis[P.TURSO_TEST_RUNNER];
    if (saved.token !== undefined) process.env.TURSO_API_TOKEN = saved.token;
    if (saved.org !== undefined) process.env.TURSO_ORG = saved.org;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await t("line 2 bug 1: a run resuming at apply_schema (create_db already done) gets a database token, so the schema step works", async () => {
  await withTokenCheckedDb("tokres", async () => {
    const r1 = await P.runProvision({ id: "tokres", shopDomain: "tokres.myshopify.com" }, { failAt: "apply_schema" });
    eq(r1.failedStep, "apply_schema", "stopped before the schema");
    const r2 = await P.runProvision({}, { resumeRunId: r1.run.id });
    eq(r2.run.status, "done", `resumed run: ${r2.error}`);
  });
});

await t("line 2 bug 2: a run resuming at register_tenant on an http:// database registers a working token (not only libsql://)", async () => {
  await withTokenCheckedDb("tokreg", async () => {
    const r1 = await P.runProvision({ id: "tokreg", shopDomain: "tokreg.myshopify.com" }, { failAt: "register_tenant" });
    eq(r1.failedStep, "register_tenant", "stopped before registering");
    const r2 = await P.runProvision({}, { resumeRunId: r1.run.id });
    eq(r2.run.status, "done", `resumed run: ${r2.error}`);
    const tn = await C.getTenant("tokreg", { fresh: true });
    ok(tn.dbUrl.startsWith("http://127.0.0.1:"), tn.dbUrl);
    ok(tn.dbToken, "a token was registered");
    const c = createClient({ url: tn.dbUrl, authToken: tn.dbToken });
    ok((await c.execute("SELECT 1 AS one")).rows.length === 1, "the registered token opens the database");
    c.close();
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
await removeDbs();
process.exit(fail ? 1 : 0);
