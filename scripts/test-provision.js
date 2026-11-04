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

const P4_DBS = ["fresh", "keep", "live", "liveorders", "liveprod", "adoptrel", "adoptblk", "adoptdoc", "earlier", "badmode", ...Array.from({ length: 8 }, (_, i) => `fa${i}`)].map((n) => `.test-prov-${n}.db`);
const dbs = [".test-prov-default.db", ".test-prov-platform.db", ".test-prov-t1.db", ...P4_DBS];
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
  const p2 = { id: "beta", name: "Beta", shopDomain: "beta.myshopify.com", dbUrl: "file:.test-prov-t1.db", contentMode: "legacy" };
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
const CONSOLE_PAGES = { "/admin/integrations": "integrations", "/admin/settings": "settings", "/admin/billing": "billing" };
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
  same(list.items.map((i) => i.id), ["connect", "catalog", "brand", "policies", "billing", "domain", "preview", "test_order", "launch"], "steps:");
  for (const i of list.items) {
    ok(!FORBIDDEN_HREF(i.href), `${i.id} links to ${i.href}`);
    ok(await hrefWorks(i.href), `${i.id}: ${i.href} is not an editor or working console destination`);
  }
  same(
    Object.fromEntries(list.items.map((i) => [i.id, i.href])),
    {
      connect: "/admin/integrations",
      catalog: "/admin/settings#catalog-sync",
      brand: E.editorHref("doc_design"),
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
  const p = await publishOne("doc_home");
  eq(p.status, 200, `publish: ${JSON.stringify(p.body).slice(0, 300)}`);
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
  eq(stepOf(list, "brand").done, false, "the design is not published yet:");
});

await t("unit: a later doc_design publish writes theme_pin (setThemePinWriter spy) and completes the design step", async () => {
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
  const step = stepOf(await checklist(), "brand");
  same([step.done, step.href], [true, E.editorHref("doc_design")], "design step:");
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
  eq(list.launched, true, "launched by its check-off:");
  ok(list.launchedAt, "launchedAt:");
  same(Object.keys(list).sort(), ["doneCount", "items", "launched", "launchedAt", "provisionedAt", "supported", "total"], "answer keys:");
});


console.log(`\n${pass} passed, ${fail} failed`);
await removeDbs();
process.exit(fail ? 1 : 0);
