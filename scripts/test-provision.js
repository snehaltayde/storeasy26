// Provisioning & onboarding suite (Session 41: BE26 resumable idempotent
// steps + compensation + neutral seeds, MC02 derived checklist + gated
// launch, MC03 verified-membership switcher data).
// P4-PROVISION (MIG-03, PUB-06, GEN-02, TOK-03, ED-05; owner answer OQ-4): a
// new, empty store starts on the new editor (documents mode) and stays closed
// until its first publish; an adopted or re-provisioned database that holds
// content stays legacy; the onboarding checklist works for a new documents
// store. File databases and a file control plane only: nothing here creates
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

const P4_DBS = ["fresh", "keep", "live", "liveorders", "liveprod", "adoptrel", "adoptblk", "adoptdoc", "earlier", "badmode", "sharea", "sharec", "shared", "onb", "onbui", "onbx", "onbopen", "onbm4", "onbfail", ...Array.from({ length: 8 }, (_, i) => `fa${i}`)].map((n) => `.test-prov-${n}.db`);
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

// The BE26 / MC02 tenant stays on the old editor (P4-PROVISION: the operator's
// escape, contentMode 'legacy'), so its legacy checklist is tested as before.
const PARAMS = { id: "acme", name: "Acme Nutrition", shopDomain: "acme.myshopify.com", domains: ["shop.acme.in"], dbUrl: "file:.test-prov-t1.db", contentMode: "legacy" };

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
  const p2 = { id: "beta", name: "Beta", shopDomain: "beta.myshopify.com", dbUrl: "file:.test-prov-beta.db", contentMode: "legacy" };
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
const ON = await import("../lib/admin/onboarding.js");
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

// the legacy tenant before anything below runs, to prove it is left alone
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
  eq(r.run.refs.contentModeReason, P.CONTENT_MODE_REASONS.fresh, "reason:");
  eq(r.run.params.contentMode, "documents", "params.contentMode (the default, recorded):");
  same(await storeState(".test-prov-fresh.db"), FRESH_STATE(), "the store:");
  eq(await withTenant(await C.getTenant("fresh"), () => getCmsMode()), "documents", "getCmsMode in the tenant:");
  const cfg = await cfgOf("fresh");
  ok(!Object.hasOwn(cfg, "theme_pin") && !Object.hasOwn(cfg, "theme") && !Object.hasOwn(cfg, "brand"), `no theme_pin, theme or brand: ${JSON.stringify(cfg)}`);
  eq(K.themePinOf(cfg), null, "themePinOf (never published):");
  const summary = P.editorSummary(r.run.refs);
  ok(/new editor/.test(summary) && /private/.test(summary) && /first publish/.test(summary), summary);
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
  eq(done.run.refs.contentModeReason, P.CONTENT_MODE_REASONS.already, "reason:");
  same((await rawSql(".test-prov-fa7.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], at, "no second write:");
});

await t("unit: an adopted database that already holds content (a releases row, a cms_blocks row or a documents row) stays legacy with the plain reason recorded, its content untouched", async () => {
  const seeds = {
    adoptrel: async (c) => {
      await c.execute({ sql: "INSERT INTO releases (id, content, content_hash, created_at) VALUES ('rel_adopt', ?, 'h_adopt', ?)", args: [JSON.stringify({ v: 3, blocks: {}, pages: [] }), new Date().toISOString()] });
    },
    adoptblk: async (c) => {
      await c.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at) VALUES ('hero', ?, ?)", args: [JSON.stringify({ title: "Adopted hero" }), new Date().toISOString()] });
    },
    adoptdoc: async (c) => {
      const b = R.emptyBody("home");
      await c.execute({ sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_home', 'home', NULL, 'Home', ?, 'dh', 1, 1, ?, ?)", args: [R.stableStringify(b), new Date().toISOString(), new Date().toISOString()] });
    },
  };
  for (const [id, seed] of Object.entries(seeds)) {
    const file = `.test-prov-${id}.db`;
    const c = raw(file);
    await P.applyTenantSchema(c);
    await seed(c);
    c.close();
    const before = await storeState(file);
    eq(before.mode, "legacy", `${id} before:`);
    const r = await P.runProvision(params(id));
    eq(r.run.status, "done", `${id} (${r.error}):`);
    eq(r.run.params.adoptedDb, true, `${id} adopted:`);
    eq(r.run.refs.contentMode, "legacy", `${id} contentMode:`);
    eq(r.run.refs.contentModeReason, "This database already holds store content, so it keeps the old editor. Move it with the cutover.", `${id} reason:`);
    same(await storeState(file), before, `${id} the store is as it was:`);
    ok(/old editor/.test(P.editorSummary(r.run.refs)) && /cutover/.test(P.editorSummary(r.run.refs)), P.editorSummary(r.run.refs));
  }
});

await t("unit: a --force re-provision of a store that already holds content stays legacy with the plain reason; contentMode 'legacy' keeps a fresh tenant legacy; an unknown contentMode is refused", async () => {
  const r1 = await P.runProvision(params("keep", { contentMode: "legacy" }));
  eq(r1.run.status, "done");
  same([r1.run.refs.contentMode, r1.run.refs.contentModeReason, r1.run.params.contentMode], ["legacy", P.CONTENT_MODE_REASONS.operator, "legacy"], "the operator's escape on a fresh store:");
  same(await storeState(".test-prov-keep.db"), { ...FRESH_STATE(), mode: "legacy" }, "fresh and legacy:");
  // the founder edits on the old editor; then the operator re-provisions
  await withTenant(await C.getTenant("keep"), async () => {
    const St = await import("../lib/cms/store.js");
    await St.setBlock("announcement", { enabled: true, text: "Kept words", href: "/" });
  });
  const before = await storeState(".test-prov-keep.db");
  eq(before.counts.cms_blocks, 1, "the block landed:");
  const r2 = await P.runProvision(params("keep", { force: true }));
  eq(r2.run.status, "done", `force (${r2.error}):`);
  same([r2.run.params.force, r2.run.params.contentMode], [true, "documents"], "a forced run asking for the new editor:");
  eq(r2.run.refs.contentMode, "legacy", "contentMode:");
  // fix 1: a registered store is never moved by a re-provision
  eq(r2.run.refs.contentModeReason, P.CONTENT_MODE_REASONS.registered, "reason:");
  same(await storeState(".test-prov-keep.db"), before, "untouched:");
  // the escape is validated
  let refused = null;
  try {
    await P.runProvision(params("badmode", { contentMode: "documentz" }));
  } catch (e) {
    refused = e.message;
  }
  ok(/contentMode must be one of documents, legacy/.test(refused || ""), `refused: ${refused}`);
  eq(await C.getTenant("badmode"), null, "nothing registered:");
});

// P4-PROVISION fix 1: content_mode runs before register_tenant (where an
// existing tenant is refused), so it must never move a store that is already
// registered, nor a database it did not create that already runs a store.
await t("unit (fix 1): re-provisioning an existing legacy store with no editor content, with the default contentMode and no force, is refused and leaves its editor as it was (cms_state and the run's contentMode stay legacy)", async () => {
  const r0 = await P.runProvision(params("live", { contentMode: "legacy" }));
  eq(r0.run.status, "done", `first (${r0.error}):`);
  const file = ".test-prov-live.db";
  const before = await storeState(file);
  const row = (await rawSql(file, "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
  eq(before.mode, "legacy", "legacy, no editor content:");
  same(before.counts, zeroCounts(), "no content rows:");
  const r = await P.runProvision(params("live"));
  eq(r.failedStep, "register_tenant", "refused at:");
  eq(r.error, 'tenant "live" already exists (use force to re-provision)', "words:");
  eq(r.run.params.contentMode, "documents", "the default was asked for:");
  same([r.run.refs.contentMode, r.run.refs.contentModeReason], ["legacy", P.CONTENT_MODE_REASONS.registered], "the run records:");
  same((await rawSql(file, "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], row, "cms_state untouched:");
  same(await storeState(file), before, "the store:");
  eq(await withTenant(await C.getTenant("live"), () => getCmsMode()), "legacy", "getCmsMode:");
});

await t("unit (fix 1): a --force re-provision of an existing legacy store with no editor content but live orders and products, default contentMode, finishes and keeps the old editor", async () => {
  const file = ".test-prov-live.db";
  const c = raw(file);
  await c.execute("INSERT INTO products (id, handle, title, available) VALUES ('gid://p/live1','live-tee','Live Tee',1)");
  await c.execute("INSERT INTO orders (id, email) VALUES ('ORD-LIVE-1', 'snehal@mediastic.in')");
  c.close();
  const before = await storeState(file);
  const row = (await rawSql(file, "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
  const r = await P.runProvision(params("live", { force: true }));
  eq(r.run.status, "done", `force (${r.error}):`);
  same([r.run.refs.contentMode, r.run.refs.contentModeReason], ["legacy", P.CONTENT_MODE_REASONS.registered], "kept:");
  same((await rawSql(file, "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], row, "cms_state untouched:");
  same(await storeState(file), before, "the store:");
  eq(Number((await rawSql(file, "SELECT count(*) AS n FROM orders"))[0].n), 1, "its order is there:");
  ok(/old editor/.test(P.editorSummary(r.run.refs)), P.editorSummary(r.run.refs));
});

await t("unit (fix 1): an adopted database (a new id) with no editor content that already holds orders or products keeps the old editor with the plain reason; it is not moved", async () => {
  const seeds = {
    liveorders: (c) => c.execute("INSERT INTO orders (id, email) VALUES ('ORD-ADOPT-1', 'snehal@mediastic.in')"),
    liveprod: (c) => c.execute("INSERT INTO products (id, handle, title, available) VALUES ('gid://p/adopt1','adopt-tee','Adopt Tee',1)"),
  };
  for (const [id, seed] of Object.entries(seeds)) {
    const file = `.test-prov-${id}.db`;
    const c = raw(file);
    await P.applyTenantSchema(c);
    await seed(c);
    c.close();
    const before = await storeState(file);
    const row = (await rawSql(file, "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
    const r = await P.runProvision(params(id));
    eq(r.run.status, "done", `${id} (${r.error}):`);
    same([r.run.refs.contentMode, r.run.refs.contentModeReason], ["legacy", P.CONTENT_MODE_REASONS.holdsStoreData], `${id}:`);
    eq(r.run.refs.contentModeReason, "This database already holds products, collections, customers or orders, so it keeps the old editor. Move it with the cutover.", `${id} words:`);
    same((await rawSql(file, "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], row, `${id} cms_state untouched:`);
    same(await storeState(file), before, `${id} the store:`);
  }
});

await t("unit: a run that started before content_mode existed keeps the old editor when resumed (its stored settings have no contentMode)", async () => {
  const r = await P.runProvision(params("earlier"), { failAt: "apply_schema" });
  eq(r.failedStep, "apply_schema");
  // shape the stored run as one written before this item: no step, no setting
  const row = await runRowOf(r.run.id);
  const steps = row.steps.filter((x) => x.name !== "content_mode");
  const { contentMode: _dropped, ...oldParams } = row.params;
  await C.platformDb().execute({ sql: "UPDATE provision_runs SET steps = ?, params = ? WHERE id = ?", args: [JSON.stringify(steps), JSON.stringify(oldParams), r.run.id] });
  const done = await P.runProvision({}, { resumeRunId: r.run.id });
  eq(done.run.status, "done", `resumed (${done.error}):`);
  same(done.run.steps.map((x) => x.name), freshRun.steps.map((x) => x.name), "the step is put back in order:");
  same([done.run.refs.contentMode, done.run.refs.contentModeReason], ["legacy", P.CONTENT_MODE_REASONS.earlierRun], "kept legacy:");
  eq((await storeState(".test-prov-earlier.db")).mode, "legacy", "the store:");
});

await t("unit: an existing legacy tenant is untouched by provisioning others (its editor, its content and its cms_state row)", async () => {
  eq(acmeBefore.row.mode, "legacy", "acme is legacy:");
  same(await storeState(".test-prov-t1.db"), acmeBefore.state, "acme's store:");
  same((await rawSql(".test-prov-t1.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0], acmeBefore.row, "acme's cms_state row:");
  // the run that made acme (the refused re-provision after it records the
  // fix 1 reason, "already registered")
  const acmeRun = (await P.listProvisionRuns({ limit: 100 })).find((r) => r.tenant_id === "acme" && r.status === "done");
  same([acmeRun.refs.contentMode, acmeRun.refs.contentModeReason], ["legacy", P.CONTENT_MODE_REASONS.operator], "acme's run (contentMode 'legacy'):");
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
const CONSOLE_PAGES = { "/admin/integrations": "integrations", "/admin/settings": "settings", "/admin/billing": "billing", "/admin/start": "start" };
async function hrefWorks(h) {
  if (h === "/admin/editor" || h.startsWith("/admin/editor?")) return access(join(ROOT, "app/(console)/admin/(authed)/editor/page.js")).then(() => true, () => false);
  const path = h.split(/[?#]/)[0];
  if (!CONSOLE_PAGES[path]) return false;
  return access(join(ROOT, `app/(console)/admin/(authed)/${CONSOLE_PAGES[path]}/page.js`)).then(() => true, () => false);
}
const checklist = () => inF(() => ON.buildChecklist());
const stepOf = (list, id) => list.items.find((i) => i.id === id);

await t("unit (ED05 review, pinned): a closed documents store builds the onboarding checklist with editor links; every step's href is an editor or working console destination, never /admin/theme, /admin/catalog, /admin/home, /admin/upsells or a bare /admin/storefront", async () => {
  const list = await checklist();
  eq(list.supported, true);
  // P6-ONBOARD: 'start' comes first on a documents store
  same(list.items.map((i) => i.id), ["start", "connect", "catalog", "brand", "policies", "billing", "domain", "preview", "test_order", "launch"], "steps:");
  for (const i of list.items) {
    ok(!FORBIDDEN_HREF(i.href), `${i.id} links to ${i.href}`);
    ok(await hrefWorks(i.href), `${i.id}: ${i.href} is not an editor or working console destination`);
    for (const a of i.actions || []) if (a.href) ok(await hrefWorks(a.href), `${i.id} action ${a.label}: ${a.href}`);
  }
  same(
    Object.fromEntries(list.items.map((i) => [i.id, i.href])),
    {
      start: "/admin/start",
      connect: "/admin/integrations",
      catalog: "/admin/settings#catalog-sync",
      brand: "/admin/start",
      policies: E.PAGES_LIST_HREF,
      billing: "/admin/billing",
      domain: "/admin/settings",
      preview: E.EDITOR_PATH,
      test_order: E.EDITOR_PATH,
      launch: E.EDITOR_PUBLISH_HREF,
    },
    "hrefs:",
  );
  eq(stepOf(list, "brand").done, false, "no published design yet:");
  eq(stepOf(list, "policies").done, false, "no published pages:");
  eq(stepOf(list, "billing").done, true, "the free plan:");
  eq(stepOf(list, "catalog").done, true, "the catalog step reads products as on any store:");
  eq(stepOf(list, "test_order").hint, ON.TEST_ORDER_CLOSED_HINT, "the test order goes through the preview:");
  const launch = stepOf(list, "launch");
  same([launch.done, launch.gated, launch.kind], [false, false, "auto"], "launch before the first publish:");
  ok(/private until your first publish/.test(launch.hint) && /Publishing from the editor opens it/.test(launch.hint), launch.hint);
  same([list.launched, list.launchedAt], [false, null], "not launched:");
  // a check-off can't claim a launch on the new editor: the publish is the launch
  let refused = null;
  try {
    await inF(() => markManualStep("launch"));
  } catch (e) {
    refused = e.message;
  }
  ok(/opens when you publish from the editor/.test(refused || ""), `refused: ${refused}`);
  const mp = await inF(() => markManualStep("preview"));
  eq(mp.done, true, "the other check-offs still work:");
  eq(stepOf(await checklist(), "preview").done, true, "preview checked off:");
});

await t("unit: legacy brand and old-editor writes on the new tenant answer 409 with the documents message; the theme screen's apply saves only the doc_design draft; saving doc_design through the documents API works", async () => {
  const cfg0 = await cfgOf("fresh");
  const save = await adminRoute("admin/brand", "PUT", { brand: { accent: "#0f766e" } });
  eq(save.status, 409, `brand save: ${JSON.stringify(save.body)}`);
  ok(save.body.error.startsWith(DOCUMENTS_MESSAGE), save.body.error);
  same([save.body.code, save.body.editor], ["STORE_USES_DOCUMENTS", E.editorHref("doc_design")], "brand save answer:");
  const reset = await adminRoute("admin/brand", "PUT", { reset: true });
  same([reset.status, reset.body.code], [409, "STORE_USES_DOCUMENTS"], "brand reset:");
  ok(reset.body.error.startsWith(DOCUMENTS_MESSAGE), reset.body.error);
  const block = await adminRoute("admin/storefront", "PUT", { block: "announcement", value: { enabled: true, text: "Old editor words", href: "/" } });
  same([block.status, block.body.code], [409, "STORE_USES_DOCUMENTS"], `old storefront save: ${JSON.stringify(block.body)}`);
  ok(/new editor/.test(block.body.error), block.body.error);
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

await t("unit: the founder publishes a first home page (open doc_home, save a section, publish): the store opens, resolvedHomePage shows the section from a live content.v 4 release, and the checklist reads Launch done from the live state", async () => {
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
  const list = await checklist();
  const launch = stepOf(list, "launch");
  same([launch.done, launch.hint, list.launched], [true, ON.LAUNCH_HINTS.open, true], "launch done from the live state:");
  ok(list.launchedAt, "launchedAt (the first release):");
  same([stepOf(list, "test_order").href, stepOf(list, "test_order").hint], ["/checkout", "One COD test order end-to-end (cancel it after)."], "an open store's checkout:");
  eq(stepOf(list, "brand").done, true, "the design opened with the store:");
});

await t("unit: a later doc_design publish writes theme_pin (setThemePinWriter spy) and completes the design step", async () => {
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
  // P6-ONBOARD: an open store's design step links /admin/start too (the logo is changed there)
  const step = stepOf(await checklist(), "brand");
  same([step.done, step.href, step.hint], [true, ON.START_HREF, ON.BRAND_HINTS.open], "design step:");
  ok(!/then publish it/.test(step.hint), step.hint);
});

await t("unit (ED05 review, pinned): the legal-pages step counts only published PAGE documents: published campaigns and a journal post named privacy and terms don't count; published privacy and terms pages do", async () => {
  await makeAndPublish("campaign", "privacy-week", "Privacy week sale");
  await makeAndPublish("campaign", "terms-and-returns-week", "Returns week");
  await makeAndPublish("journal", "terms-explained", "Terms explained");
  const listed = await asRequest(() => inF(() => Res.resolvedContentPageList()));
  same(listed.map((p) => [p.slug, p.family, p.enabled]), [["privacy-week", "campaign", true], ["terms-and-returns-week", "campaign", true]], "the published list holds both campaigns (only the family filter keeps them out; journal posts are not in the list):");
  eq(stepOf(await checklist(), "policies").done, false, "campaigns and a journal post are not legal pages:");
  // a draft is not enough
  const priv = await api({ createDocument: { type: "page", body: routeBody("page", "privacy", "Privacy", [sec("text", "sec_priv", { title: "Privacy", body: ["We keep little."] })]) } });
  eq(priv.status, 200);
  eq(stepOf(await checklist(), "policies").done, false, "a draft privacy page:");
  eq((await publishOne(priv.body.document.id)).status, 200, "publish privacy:");
  eq(stepOf(await checklist(), "policies").done, false, "privacy alone:");
  await makeAndPublish("page", "terms", "Terms");
  eq(stepOf(await checklist(), "policies").done, true, "privacy and terms published:");
});

await t("unit: a --force re-provision of the published documents store keeps it on the new editor with its live release", async () => {
  const before = await storeState(".test-prov-fresh.db");
  ok(before.live, "live release:");
  const r = await P.runProvision(params("fresh", { force: true }));
  eq(r.run.status, "done", `force (${r.error}):`);
  same([r.run.refs.contentMode, r.run.refs.contentModeReason], ["documents", P.CONTENT_MODE_REASONS.already], "kept:");
  same(await storeState(".test-prov-fresh.db"), before, "untouched:");
});

await t("unit: a legacy tenant's checklist output is unchanged (every step's label, kind, link, hint and gate)", async () => {
  const list = await withTenant(await C.getTenant("acme"), buildChecklist);
  same(
    list.items.map((i) => [i.id, i.label, i.kind, i.href, i.hint, Boolean(i.gated)]),
    [
      ["connect", "Connect Shopify", "auto", "/admin/integrations", "OAuth connect — the catalog syncs from your store.", false],
      ["catalog", "Bring in your products", "auto", "/admin/settings#catalog-sync", "1 products in", false],
      ["brand", "Pick a theme & brand", "auto", "/admin/theme", "Apply a kit, set your accent color.", false],
      ["policies", "Publish legal pages", "auto", "/admin/storefront", "Privacy + terms/refund — templates scaffold them; checkout links them.", false],
      ["billing", "Activate billing", "auto", "/admin/billing", "Pick a plan (Free counts) — explicit, never silent.", false],
      ["domain", "Point your domain", "auto", "/admin/settings", "A custom host (operator adds + verifies it).", false],
      ["preview", "Review your draft preview", "manual", "/admin/storefront", "Walk the storefront in the preview pane, then mark done.", false],
      ["test_order", "Place a test order", "manual", "/checkout", "One COD test order end-to-end (cancel it after).", false],
      ["launch", "Launch", "manual", "/admin/releases", "Publish your first release and go.", false],
    ],
    "legacy items:",
  );
  // P6-ONBOARD: byte-identical items: the same keys in the same order (no
  // 'start' step, no actions key) and the same done values
  same(
    list.items.map((i) => Object.keys(i).join(",")),
    [...Array(8).fill("id,label,kind,done,href,hint"), "id,label,kind,done,gated,href,hint"],
    "legacy item keys:",
  );
  same(list.items.map((i) => i.done), Array(9).fill(true), "legacy done values:");
  eq(list.launched, true, "launched by its check-off:");
  ok(list.launchedAt, "launchedAt:");
  same(Object.keys(list).sort(), ["doneCount", "items", "launched", "launchedAt", "provisionedAt", "supported", "total"], "answer keys:");
});

// ---- P6-ONBOARD: the first-run checklist on a documents store ------------------------------
// GEN-04, PUB-12, US-01, US-41. A closed documents store with an empty
// catalog ("onb"), its brand step, its policy starters, and the same rule as
// "Before you open your store" (policyStatus). Then SetupAdmin rendered with
// a fetch spy (no network): the buttons, the reload and the refusals.
console.log("— P6-ONBOARD: 'Start your store', the design step and the legal pages on a documents store");
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
const olist = () => inO(() => ON.buildChecklist());
// no step hint on a documents store may send the founder to add or publish a page "in the editor"
const EDITOR_PAGE_HINT = (h) => /in the editor/i.test(h) || /\b(add|publish)\b[^.]*\bpages?\b[^.]*\beditor\b/i.test(h);
async function checkHintsAndLinks(list, label) {
  for (const i of list.items) {
    ok(!EDITOR_PAGE_HINT(i.hint), `${label}: ${i.id} hint sends the founder to the editor for a page: ${i.hint}`);
    ok(await hrefWorks(i.href), `${label}: ${i.id}: ${i.href} is not a console page`);
    for (const a of i.actions || []) if (a.type === "link") ok(await hrefWorks(a.href), `${label}: ${i.id} action ${a.label}: ${a.href} is not a console page`);
  }
}
// PUB-12 and onboarding agree: each kind counts in onboarding exactly when
// the opening report does not block on it, and the step is done exactly when
// neither blocks
async function agreesWithOpening(step) {
  const rep = await inO(() => OP6.openingReport());
  eq(rep.opening, true, "the store is closed:");
  const st = await inO(async () => PP6.policyStatus(await PP6.readPolicyRows()));
  const level = (k) => rep.items.find((i) => i.id === k).level;
  for (const k of PP6.POLICY_KINDS) eq(PP6.policyCounts(st[k].state), level(k) !== "block", `${k}: policyStatus ${st[k].state} vs opening ${level(k)}:`);
  eq(step.done, level("privacy") !== "block" && level("returns") !== "block", "onboarding done vs opening:");
}

await t("unit (P6-ONBOARD): a closed documents store's checklist starts with 'Start your store' (/admin/start, a real console page); on an empty catalog it is done once the brand step is recorded; with products it is done once doc_home exists", async () => {
  same([onbRun.run.status, onbRun.run.refs.contentMode], ["done", "documents"], `onb (${onbRun.error}):`);
  let list = await olist();
  const first = list.items[0];
  same([first.id, first.label, first.kind, first.href, first.done, first.hint], ["start", "Start your store", "auto", "/admin/start", false, ON.START_HINTS.emptyCatalog], "the first step:");
  ok(await hrefWorks(first.href), "/admin/start is a console page");
  eq(stepOf(list, "brand").done, false, "brand before the step:");
  await inO(() => BS6.saveBrandStep({ skip: true }, OACT));
  list = await olist();
  same([stepOf(list, "start").done, stepOf(list, "brand").done], [true, true], "the brand step skipped on an empty catalog:");
  // with products and no home page, the step waits for the home page
  await inO(() => db.insertInto("products").values({ id: "gid://t/ONB1", handle: "onb-tee", title: "Onb Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute());
  list = await olist();
  same([stepOf(list, "start").done, stepOf(list, "start").hint], [false, ON.START_HINTS.todo], "products, no home page:");
  await inO(() => Docs.createDocument({ type: "home", actor: OACT }));
  list = await olist();
  same([stepOf(list, "start").done, stepOf(list, "start").hint], [true, ON.START_HINTS.done], "doc_home exists:");
  await checkHintsAndLinks(list, "onb");
});

await t("unit (P6-ONBOARD): the design step is done after a brand-step skip or save with nothing live, links /admin/start, and its closed-store hint says the colours go live when the store opens (never 'then publish it')", async () => {
  // a second store: a brand-step SAVE (no skip before it)
  const r = await P.runProvision(params("onbui"));
  eq(r.run.status, "done", `onbui (${r.error}):`);
  const inU = async (fn) => withTenant(await C.getTenant("onbui"), fn);
  const before = stepOf(await inU(() => ON.buildChecklist()), "brand");
  same([before.done, before.href, before.hint], [false, "/admin/start", ON.BRAND_HINTS.closed], "before:");
  const saved = await inU(() => BS6.saveBrandStep({ paletteId: PAL6.DEFAULT_PALETTE_ID }, OACT));
  same([saved.ok, saved.skipped], [true, false], `saved: ${JSON.stringify(saved).slice(0, 200)}`);
  eq(await asRequest(() => inU(() => Res.isStoreClosed())), true, "nothing live:");
  const after = stepOf(await inU(() => ON.buildChecklist()), "brand");
  same([after.done, after.href, after.hint], [true, "/admin/start", "Pick your colours and logo. They go live when you open your store."], "after a save:");
  ok(!/then publish it/.test(after.hint), after.hint);
  // the skipped store (test above) too
  const skipped = stepOf(await olist(), "brand");
  same([skipped.done, skipped.href, skipped.hint], [true, "/admin/start", ON.BRAND_HINTS.closed], "after a skip:");
});

let starterPrivacy = null;
await t("unit (P6-ONBOARD, PUB-12 review rule): on a closed documents store the legal-pages step is 'Add your legal pages' with two start buttons; a starter draft does not count and offers 'Read your privacy page' and 'I've read it'; I've read it (body unchanged) counts it; a founder-saved terms draft finishes the step; opening and onboarding agree at every stage", async () => {
  let step = stepOf(await olist(), "policies");
  same([step.label, step.done, step.href, step.hint], ["Add your legal pages", false, E.PAGES_LIST_HREF, ON.POLICY_HINTS.missing], "no pages:");
  eq(step.hint, "Your store can't open without a privacy page and a returns page. Start each from a template, then read it and save it.", "the words:");
  same(step.actions, [
    { type: "startPolicy", kind: "privacy", label: "Start a privacy page" },
    { type: "startPolicy", kind: "returns", label: "Start a returns page" },
  ], "two start buttons:");
  await agreesWithOpening(step);
  // a starter privacy draft, written by the policy starter
  const made = await inO(() => Docs.createDocument({ type: "page", body: PS6.starterBody("privacy"), actor: PP6.POLICY_STARTER_ACTOR }));
  starterPrivacy = made.document;
  step = stepOf(await olist(), "policies");
  eq(step.done, false, "a starter draft does not count:");
  same(step.actions, [
    { type: "link", href: `/admin/editor?doc=${starterPrivacy.id}`, label: "Read your privacy page" },
    { type: "markPolicyRead", id: starterPrivacy.id, revision: starterPrivacy.revision, label: "I've read it" },
    { type: "startPolicy", kind: "returns", label: "Start a returns page" },
  ], "the privacy start button is replaced; the returns one stays:");
  eq(step.hint, ON.POLICY_HINTS.missing, "a kind is still missing:");
  await agreesWithOpening(step);
  // the returns starter through the real op: both are starters now
  const ret = await inO(() => PS6.startPolicyPage({ kind: "returns", actor: OACT }));
  eq(ret.status, 200, `returns starter: ${JSON.stringify(ret.body).slice(0, 200)}`);
  step = stepOf(await olist(), "policies");
  eq(step.hint, "We started your privacy page and your returns page from a template. It's a starting point, not legal advice: read each, change what you need and save it, or press I've read it if it is right as it is.", "two starters:");
  eq(ON.policyStarterHint(["privacy"]), "We started your privacy page from a template. It's a starting point, not legal advice: read it, change what you need and save it, or press I've read it if it is right as it is.", "one starter (the brief's words):");
  eq(ON.policyStarterHint(["returns"]).startsWith("We started your returns page from a template."), true, "returns words:");
  await agreesWithOpening(step);
  // I've read it on the privacy starter: body unchanged, it now counts as saved
  const hashBefore = (await inO(() => Docs.getDocument(starterPrivacy.id))).draftHash;
  const mark = step.actions.find((a) => a.type === "markPolicyRead" && a.id === starterPrivacy.id);
  const read = await inO(() => PS6.markPolicyRead({ id: mark.id, revision: mark.revision, actor: OACT }));
  eq(read.status, 200, `marked: ${JSON.stringify(read.body).slice(0, 200)}`);
  eq((await inO(() => Docs.getDocument(starterPrivacy.id))).draftHash, hashBefore, "the body is unchanged:");
  eq((await inO(async () => PP6.policyStatus(await PP6.readPolicyRows()))).privacy.state, "saved", "privacy counts as saved:");
  step = stepOf(await olist(), "policies");
  same([step.done, step.hint], [false, ON.policyStarterHint(["returns"])], "returns is still a starter:");
  same(step.actions.map((a) => [a.type, a.label]), [["link", "Read your returns page"], ["markPolicyRead", "I've read it"]], "only the returns buttons are left:");
  await agreesWithOpening(step);
  // a merchant saveDraft of the privacy page, and the founder saves the terms page (an edit)
  const p = await inO(() => Docs.getDocument(starterPrivacy.id));
  await inO(() => Docs.saveDraft({ id: p.id, revision: p.revision, body: { ...p.body, meta: { ...p.body.meta, title: "Our privacy" } }, actor: OACT }));
  const terms = await inO(() => Docs.getDocument(ret.body.document.id));
  eq(terms.slug, "terms", "the returns starter is the terms page:");
  await inO(() => Docs.saveDraft({ id: terms.id, revision: terms.revision, body: { ...terms.body, meta: { ...terms.body.meta, title: "Our terms" } }, actor: OACT }));
  const list = await olist();
  step = stepOf(list, "policies");
  same([step.label, step.done, step.hint, step.actions], ["Add your legal pages", true, "Your privacy and returns pages are ready.", []], "both founder-saved:");
  await agreesWithOpening(step);
  eq(await asRequest(() => inO(() => Res.isStoreClosed())), true, "nothing was published:");
  await checkHintsAndLinks(list, "onb, pages ready");
});

await t("unit (P6-ONBOARD): the Launch hint on a closed documents store says publishing opens the store, first shows what is still missing ('Before you open your store'), and needs a way to pay, a privacy page and a returns page", async () => {
  const launch = stepOf(await olist(), "launch");
  eq(launch.hint, ON.LAUNCH_HINTS.closedOpenSteps, "steps are still open:");
  ok(/Publishing from the editor opens it/.test(launch.hint), launch.hint);
  ok(/first shows what is still missing/.test(launch.hint) && /Before you open your store/.test(launch.hint), launch.hint);
  ok(/can't open without a way to pay, a privacy page and a returns page/.test(launch.hint), launch.hint);
  ok(/private until your first publish/.test(launch.hint), "the pinned words stay:");
});

// ---- SetupAdmin, rendered (Next's SWC, a small hook driver, a fetch spy) ----
const React6 = require("react");
const { renderToStaticMarkup: rsm6 } = require("react-dom/server");
const swc6 = require("next/dist/build/swc/index.js");
await swc6.loadBindings();
const { createHash } = await import("node:crypto");
const compile6 = async (src, filename) =>
  (await swc6.transform(src, { filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
// load a component file (or its source) with the console components compiled too
async function loadComponent(file, stubs, source = null) {
  const cache = new Map();
  async function load(f, src) {
    if (cache.has(f)) return cache.get(f);
    const mod = { exports: {} };
    cache.set(f, mod.exports);
    const code = await compile6(src ?? (await readFile(f, "utf8")), f);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || local.has(id)) continue;
      const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? join(dirname(f), id) : null;
      if (!base) continue;
      const target = base.endsWith(".js") ? base : `${base}.js`;
      local.set(id, /\/components\//.test(target) ? await load(target) : await import(pathToFileURL(target).href));
    }
    new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
    cache.set(f, mod.exports);
    return mod.exports;
  }
  return (await load(file, source)).default;
}
const toasts6 = [];
const toastStub6 = { useToast: () => ({ success: (m) => toasts6.push(["success", m]), error: (m) => toasts6.push(["error", m]), info: (m) => toasts6.push(["info", m]) }) };
const linkStub6 = { __esModule: true, default: function Link({ href, children, ...rest }) { return React6.createElement("a", { href, ...rest }, children); } };
// the hook driver: function components called with their own hook slots
function driver6() {
  const slots = new Map();
  let cur = null;
  let cursor = 0;
  let dirty = false;
  const hooks = {
    useState(init) {
      const box = cur;
      const k = cursor++;
      if (!(k in box)) box[k] = typeof init === "function" ? init() : init;
      return [box[k], (v) => { const nv = typeof v === "function" ? v(box[k]) : v; if (!Object.is(nv, box[k])) { box[k] = nv; dirty = true; } }];
    },
    useEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef(init) { const k = cursor++; if (!(k in cur)) cur[k] = { current: init }; return cur[k]; },
    useContext: () => null,
  };
  const react = { ...React6, ...hooks, default: { ...React6, ...hooks } };
  function render(el) {
    const nodes = [];
    const visit = (n, path) => {
      if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
      if (Array.isArray(n)) return n.forEach((c, i) => visit(c, `${path}.${c?.key ?? i}`));
      if (!React6.isValidElement(n)) return;
      if (n.type === React6.Fragment) return visit(n.props.children, `${path}F`);
      if (typeof n.type === "function") {
        const key = `${path}/${n.type.name}`;
        if (!slots.has(key)) slots.set(key, {});
        cur = slots.get(key);
        cursor = 0;
        return visit(n.type(n.props), key);
      }
      nodes.push(n);
      visit(n.props.children, `${path}/${typeof n.type === "string" ? n.type : "x"}`);
    };
    visit(el, "r");
    return nodes;
  }
  return { react, render, takeDirty: () => { const d = dirty; dirty = false; return d; } };
}
const textOf6 = (n) => (n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(textOf6).join("") : typeof n === "string" || typeof n === "number" ? String(n) : React6.isValidElement(n) ? textOf6(n.props.children) : "");
async function mountSetup(initial) {
  const d = driver6();
  const Setup = await loadComponent(join(ROOT, "components/admin/SetupAdmin.js"), { react: d.react, "@/components/console/Toast": toastStub6, "next/link": linkStub6 });
  let nodes = [];
  const draw = () => (nodes = d.render(React6.createElement(Setup, { initial })));
  const flush = async () => {
    for (let round = 0; round < 40; round++) {
      d.takeDirty();
      draw();
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      if (!d.takeDirty()) return draw();
    }
    throw new Error("SetupAdmin never settled");
  };
  await flush();
  const buttons = () => nodes.filter((n) => n.type === "button");
  return {
    all: () => nodes.map((n) => (typeof n.props.children === "string" ? n.props.children : "")).join(" | "),
    text: () => nodes.map((n) => textOf6(n)).join(" "),
    buttons: () => buttons().map((b) => textOf6(b.props.children).trim()),
    links: () => nodes.filter((n) => n.type === "a").map((a) => [textOf6(a.props.children).trim(), a.props.href]),
    async click(name) {
      const b = buttons().find((x) => textOf6(x.props.children).trim() === name);
      ok(b, `no button "${name}"; buttons: ${buttons().map((x) => textOf6(x.props.children).trim()).join(" | ")}`);
      ok(!b.props.disabled, `"${name}" is disabled`);
      await b.props.onClick();
      await flush();
    },
  };
}
// the fetch spy: records every call and answers from `answer(url, init)`
function fetchSpy(answer) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status, body } = await answer(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

await t("rendered (P6-ONBOARD, SetupAdmin): the legal-pages step shows 'Start a privacy page' and 'Start a returns page' and the 'not legal advice' line; pressing one POSTs /api/admin/policy-start { kind } then reloads the checklist; a POLICY_PAGE_EXISTS or 403 answer shows its words; 'I've read it' POSTs { markRead: { id, revision } } and reloads", async () => {
  // a fresh closed documents store with no policy pages: the real checklist
  const r = await P.runProvision(params("onbx"));
  eq(r.run.status, "done", `onbx (${r.error}):`);
  const inX = async (fn) => withTenant(await C.getTenant("onbx"), fn);
  const real = async () => ({ ok: true, ...(await inX(() => ON.buildChecklist())) });
  const initial = await real();
  // the spy answers with the real op and the real checklist
  const spy = fetchSpy(async (c) => {
    if (c.url === "/api/admin/setup" && c.method === "GET") return { status: 200, body: await real() };
    if (c.url === "/api/admin/policy-start" && c.method === "POST") {
      const out = c.body.kind ? await inX(() => PS6.startPolicyPage({ kind: c.body.kind, actor: OACT })) : await inX(() => PS6.markPolicyRead({ ...c.body.markRead, actor: OACT }));
      return out;
    }
    return { status: 404, body: {} };
  });
  try {
    toasts6.length = 0;
    const view = await mountSetup(initial);
    ok(view.buttons().includes("Start a privacy page") && view.buttons().includes("Start a returns page"), `buttons: ${view.buttons().join(" | ")}`);
    ok(view.text().includes("These are starting points, not legal advice."), "the not-legal-advice line");
    await view.click("Start a privacy page");
    same(spy.calls.slice(0, 2).map((c) => [c.method, c.url, c.body]), [["POST", "/api/admin/policy-start", { kind: "privacy" }], ["GET", "/api/admin/setup", null]], "POST then the checklist reload:");
    same(toasts6, [["success", PS6.startedMessage("privacy")]], "the answer's message in a toast:");
    ok(!view.buttons().includes("Start a privacy page") && view.buttons().includes("I've read it"), `after: ${view.buttons().join(" | ")}`);
    const priv = (await inX(async () => PP6.policyStatus(await PP6.readPolicyRows()))).privacy.doc;
    same(view.links().find((l) => l[0] === "Read your privacy page"), ["Read your privacy page", `/admin/editor?doc=${priv.id}`], "the read link:");
    // a stale screen (the first checklist) presses Start again: POLICY_PAGE_EXISTS, its own words
    const stale = await mountSetup(initial);
    spy.calls.length = 0;
    await stale.click("Start a privacy page");
    eq(spy.calls[0].body.kind, "privacy", "posted:");
    ok(stale.text().includes(PS6.existsMessage("privacy", priv.label)), `the POLICY_PAGE_EXISTS words: ${stale.text().slice(0, 400)}`);
    // I've read it: { markRead: { id, revision } }, then a reload
    spy.calls.length = 0;
    toasts6.length = 0;
    await view.click("I've read it");
    same(spy.calls.map((c) => [c.method, c.url, c.body]), [["POST", "/api/admin/policy-start", { markRead: { id: priv.id, revision: priv.revision } }], ["GET", "/api/admin/setup", null]], "markRead then the reload:");
    same(toasts6, [["success", PS6.READ_MESSAGE]], "marked:");
    ok(!view.buttons().includes("I've read it"), `after I've read it: ${view.buttons().join(" | ")}`);
    // the stale screen's I've read it: a 409 with its words
    const stale2 = await mountSetup(await (async () => { const s = structuredClone(initial); s.items.find((i) => i.id === "policies").actions = [{ type: "markPolicyRead", id: priv.id, revision: priv.revision, label: "I've read it" }]; return s; })());
    spy.calls.length = 0;
    await stale2.click("I've read it");
    ok(stale2.text().includes(PS6.POLICY_START_WORDS.alreadySaved), `the 409 words: ${stale2.text().slice(0, 400)}`);
    // P6-FIX3 (M2): a 409 also reads the checklist again, so the stale button goes
    same(spy.calls.map((c) => [c.method, c.url]), [["POST", "/api/admin/policy-start"], ["GET", "/api/admin/setup"]], "the 409 then the checklist reload:");
    ok(!stale2.buttons().includes("I've read it"), `the stale button after the reload: ${stale2.buttons().join(" | ")}`);
    ok(stale2.buttons().includes("Start a returns page"), `the fresh checklist: ${stale2.buttons().join(" | ")}`);
  } finally {
    spy.restore();
  }
  // a 403: the server's plain words
  const spy403 = fetchSpy(async () => ({ status: 403, body: { error: PS6.POLICY_START_WORDS.readOnly, code: "READ_ONLY" } }));
  try {
    const v = await mountSetup(initial);
    await v.click("Start a returns page");
    eq(spy403.calls.length, 1, "no reload after a 403:");
    ok(v.text().includes(PS6.POLICY_START_WORDS.readOnly), "the 403 words");
  } finally {
    spy403.restore();
  }
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

await t("unit (P6-FIX3, M12 M1 M7 M11): an OPEN documents store keeps 'Publish legal pages'; a missing kind gets its start button and the open-missing hint; a starter draft gets no read link and no I've read it; with no kind missing the hint is the publish hint", async () => {
  const r = await P.runProvision(params("onbopen"));
  eq(r.run.status, "done", `onbopen (${r.error}):`);
  const inOp = async (fn) => withTenant(await C.getTenant("onbopen"), fn);
  const opened = await inOp(async () => {
    const home = await Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [sec("text", "sec_onbopen", { title: "Open words", body: ["Hello."] })] }, actor: OACT });
    return Pub6.publish({ ids: [{ id: home.document.id, revision: home.document.revision, draftHash: home.document.draftHash }], actor: OACT });
  });
  ok(opened?.release?.id, `published: ${JSON.stringify(opened).slice(0, 200)}`);
  const ol = () => inOp(() => ON.buildChecklist());
  let list = await ol();
  eq(list.launched, true, "the store is open:");
  let step = stepOf(list, "policies");
  same([step.label, step.done, step.href, step.hint], ["Publish legal pages", false, E.PAGES_LIST_HREF, ON.POLICY_HINTS.openMissing], "no pages (M7, M11):");
  eq(step.hint, "Shoppers need a privacy page and a returns page, and checkout links them. Start each from a template, read it, then publish it.", "the open-missing words:");
  same(step.actions, [
    { type: "startPolicy", kind: "privacy", label: "Start a privacy page" },
    { type: "startPolicy", kind: "returns", label: "Start a returns page" },
  ], "two start buttons on an open store (M12):");
  // a starter privacy draft: no read link, no I've read it (M1); returns still missing
  await inOp(() => Docs.createDocument({ type: "page", body: PS6.starterBody("privacy"), actor: PP6.POLICY_STARTER_ACTOR }));
  step = stepOf(await ol(), "policies");
  same([step.label, step.done, step.hint], ["Publish legal pages", false, ON.POLICY_HINTS.openMissing], "a starter and a missing kind:");
  same(step.actions, [{ type: "startPolicy", kind: "returns", label: "Start a returns page" }], "only the returns start button, no read actions (M1):");
  // a founder-saved terms draft (not published): nothing missing, the publish hint (M11)
  await inOp(() => Docs.createDocument({ type: "page", body: routeBody("page", "terms", "Terms", [sec("text", "sec_onbopen_terms", { title: "Terms", body: ["Our terms."] })]), actor: OACT }));
  step = stepOf(await ol(), "policies");
  same([step.label, step.done, step.hint, step.actions], ["Publish legal pages", false, ON.POLICY_HINTS.openPublish, []], "nothing missing, nothing published (M11):");
  eq(step.hint, "Publish your privacy page and your returns page so shoppers can read them. Checkout links them.", "the publish words:");
});

await t("unit (P6-FIX3, M4): the brand step counts as recorded only with its `at`: a brand_step object without `at` leaves 'Start your store' (empty catalog) and the design step open", async () => {
  const r = await P.runProvision(params("onbm4"));
  eq(r.run.status, "done", `onbm4 (${r.error}):`);
  const t4 = async () => C.getTenant("onbm4");
  const steps = async () => {
    const list = await withTenant(await t4(), () => ON.buildChecklist());
    return [stepOf(list, "start").done, stepOf(list, "brand").done];
  };
  same(await steps(), [false, false], "nothing recorded:");
  const ob = (await t4()).config?.onboarding || {};
  await C.patchTenant("onbm4", { config: { onboarding: { ...ob, brand_step: { skipped: true, paletteId: "slate" } } } });
  same(await steps(), [false, false], "a brand_step with no `at` (M4):");
  await C.patchTenant("onbm4", { config: { onboarding: { ...ob, brand_step: ["at"] } } });
  same(await steps(), [false, false], "a list is not a record:");
  await C.patchTenant("onbm4", { config: { onboarding: { ...ob, brand_step: { skipped: true, paletteId: "slate", at: new Date().toISOString() } } } });
  same(await steps(), [true, true], "with `at`:");
});

await t("unit (P6-FIX3, M8 and the policy read): a failed doc_home read leaves 'Start your store' open; a failed policy read says the pages couldn't be checked (try again), with no buttons and never 'Start each from a template'", async () => {
  const r = await P.runProvision(params("onbfail"));
  eq(r.run.status, "done", `onbfail (${r.error}):`);
  const inFl = async (fn) => withTenant(await C.getTenant("onbfail"), fn);
  await inFl(() => db.insertInto("products").values({ id: "gid://t/FL1", handle: "fl-tee", title: "Fl Tee", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute());
  await inFl(() => Docs.createDocument({ type: "home", actor: OACT }));
  const ok1 = await inFl(() => ON.buildChecklist());
  same([stepOf(ok1, "start").done, stepOf(ok1, "start").hint], [true, ON.START_HINTS.done], "the home exists:");
  // M8: the doc_home read fails: the step stays open
  const failedHome = await withFailingSql("onbfail", /FROM documents WHERE id = 'doc_home'/, () => inFl(() => ON.buildChecklist()));
  same([stepOf(failedHome, "start").done, stepOf(failedHome, "start").hint], [false, ON.START_HINTS.todo], "a failed home read (M8):");
  // readPolicyRows fails: the legal-pages step says so, offers nothing, stays open
  const failedPol = await withFailingSql("onbfail", /WHERE type = 'page' AND archived_at IS NULL AND slug IS NOT NULL/, () => inFl(() => ON.buildChecklist()));
  const pol = stepOf(failedPol, "policies");
  same([pol.label, pol.done, pol.hint, pol.actions], ["Add your legal pages", false, ON.POLICY_HINTS.unreadable, []], "a failed policy read:");
  eq(pol.hint, "We couldn't check your privacy and returns pages just now. Reload this page to try again.", "the words:");
  ok(!/Start each from a template/.test(pol.hint), pol.hint);
  eq(scanText(pol.hint, { claims: false }).length, 0, "no banned words");
  // and the read works again afterwards: the start buttons are back
  const back = stepOf(await inFl(() => ON.buildChecklist()), "policies");
  same([back.hint, back.actions.map((a) => a.type)], [ON.POLICY_HINTS.missing, ["startPolicy", "startPolicy"]], "after:");
  // an OPEN store's failed policy read says the same (never 'Start each from a template')
  const inOp = async (fn) => withTenant(await C.getTenant("onbopen"), fn);
  const openFail = stepOf(await withFailingSql("onbopen", /WHERE type = 'page' AND archived_at IS NULL AND slug IS NOT NULL/, () => inOp(() => ON.buildChecklist())), "policies");
  same([openFail.label, openFail.done, openFail.hint, openFail.actions], ["Publish legal pages", false, ON.POLICY_HINTS.unreadable, []], "an open store's failed policy read:");
});

// The legacy screen: the component at eee9f2d (before this item) and today's
// render the same markup for a checklist with no actions.
const LEGACY_LIST6 = Object.freeze({
  ok: true,
  supported: true,
  items: [
    { id: "connect", label: "Connect Shopify", kind: "auto", done: true, href: "/admin/integrations", hint: "OAuth connect — the catalog syncs from your store." },
    { id: "policies", label: "Publish legal pages", kind: "auto", done: false, href: "/admin/storefront", hint: "Privacy + terms/refund — templates scaffold them; checkout links them." },
    { id: "preview", label: "Review your draft preview", kind: "manual", done: false, href: "/admin/storefront", hint: "Walk the storefront in the preview pane, then mark done." },
    { id: "launch", label: "Launch", kind: "manual", done: false, gated: true, href: "/admin/releases", hint: "Unlocks when everything above is done." },
  ],
  doneCount: 1,
  total: 4,
  launched: false,
  launchedAt: null,
  provisionedAt: null,
});
// renderToStaticMarkup of components/admin/SetupAdmin.js at eee9f2d for LEGACY_LIST6
// (regenerate: render that commit's file through staticSetup(source))
const SETUP_BEFORE_SHA256 = "549e86bd70d930b5a934accf7ae404152a958bb70b3012193021e14e913616cc";
async function staticSetup(source = null) {
  const Setup = await loadComponent(join(ROOT, "components/admin/SetupAdmin.js"), { react: React6, "@/components/console/Toast": toastStub6, "next/link": linkStub6 }, source);
  return rsm6(React6.createElement(Setup, { initial: LEGACY_LIST6 }));
}

await t("rendered (P6-ONBOARD, SetupAdmin): a checklist whose steps have no actions renders exactly as before this item (the markup's sha256 is the eee9f2d component's), with no 'not legal advice' line", async () => {
  const html = await staticSetup();
  eq(createHash("sha256").update(html).digest("hex"), SETUP_BEFORE_SHA256, "markup:");
  ok(!html.includes("not legal advice"), "no starter line");
  // an empty actions list is no actions
  const Setup = await loadComponent(join(ROOT, "components/admin/SetupAdmin.js"), { react: React6, "@/components/console/Toast": toastStub6, "next/link": linkStub6 });
  const withEmpty = { ...LEGACY_LIST6, items: LEGACY_LIST6.items.map((i) => ({ ...i, actions: [] })) };
  eq(rsm6(React6.createElement(Setup, { initial: withEmpty })), html, "actions: [] renders the same:");
});

// ---- P4-FIX5: the P4-PROVISION review findings -------------------------------------
console.log("— P4-FIX5 / P4-FIX6: a database another store uses, and the turso CLI's database list");

await t("unit (P4-FIX5, P4-FIX6): provisioning on a database another registered store already uses stops with plain words before anything touches it (same address, another spelling, a relative or absolute file path, another ?authToken): no second store is registered, and the other store's editor and cms_state stay as they were", async () => {
  // store A on its own database, kept on the old editor by the operator; its database holds nothing yet
  const a = await P.runProvision(params("sharea", { contentMode: "legacy" }));
  eq(a.run.status, "done", `A (${a.error}):`);
  const row = (await rawSql(".test-prov-sharea.db", "SELECT mode, updated_at FROM cms_state WHERE id = 1"))[0];
  eq(row.mode, "legacy", "A is legacy:");
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
  eq(row.mode, "legacy", "not moved yet:");
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

console.log(`\n${pass} passed, ${fail} failed`);
await removeDbs();
process.exit(fail ? 1 : 0);
