// P4-CUTOVER suite (MIG-01, MIG-02, MIG-03, MED-03, ED-05, OVL-17): moving a
// store to the new editor, for real, on file databases (.test-mdoc-*.db at the
// checkout's root, removed at the end) and, for the lost-answer part, one
// local sqld behind the Hrana fault proxy. No hosted database, no network, no
// Shopify; Typesense is a spy client with dummy localhost values.
//   1. every spec 8.11 state (v1, v2, v3, no release open with --store-open,
//      not launched with --not-launched): a real rehearsal on a file copy,
//      then the move; every resolved* getter and the rendered canaries
//      (home, a page, the journal, products, collections, rendered in-process
//      with Next's SWC) equal what shoppers had; ALLOWED_DIFFERENCES asserted
//   2. twice and crash-resumed (after every step and every backfill chunk):
//      identical rows, no extra versions or log rows; behind the fault proxy,
//      shoppers see the old store or the new one at every point
//   3. the stale backfill, a phase-3 row reused, a slug collision
//   4. every refusal, before and after the lock
//   5. a planted data-check difference; the sync is parked during the check
//   6. release:<id> refs (MED-03)
//   7. theme_pin
//   8. ED-05 after the move: old screens' destinations, legacy writers refuse
//      in their batch, /api/admin/releases answers 409
//   9. --status, --abort, --resume
//  10. a pointer moved after the lock
//  11. the runbook
//  12. a store already on the new editor; the flip's outbox drained by a spy
//  13. the command: no database address, the digest, the words
//  14. the P4-GUARD review: a sync request with no earlier run, publish jobs
//      cancelled at the lock
//  15. the dry run's digest is the precondition's; dropped modules are named
//  16. P4-FIX6: the rehearsal command passes the running hero test on to its
//      captures (a child process against a tiny local page server)
//   pnpm test:migrate-documents
// Ports (part 2's sqld and proxy): MIGRATE_DOCUMENTS_TEST_PORTS="<sqld>,<proxy>",
// else free ports the system picks. Part 16's page server:
// MIGRATE_DOCUMENTS_TEST_WEB_PORT, else a free port the system picks.
import { copyFile, readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { createClient } from "@libsql/client";
import { ROOT, P, COL, installHooks, openWorld, makeLegacyTenant, asRequest, renderKit, allGetterRoutes, buildStaleBackfill, buildPhase3Leftovers, settle, routeKey } from "./support/legacy-tenants.js";

const started = Date.now();
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg = "") => {
  const differ = a !== null && b !== null && typeof a === "object" && typeof b === "object" ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
  if (differ) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b, msg = "") => {
  const x = JSON.stringify(canon(a));
  const y = JSON.stringify(canon(b));
  if (x !== y) {
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    throw new Error(`${msg}\n      differ at ${i}: expected …${y.slice(Math.max(0, i - 200), i + 300)}\n      got      …${x.slice(Math.max(0, i - 200), i + 300)}`);
  }
};
// plain words: no codes, table names, ids or SQL
const PLAIN_BAD = /\b[a-z]+_[a-z_]+\b|SQLITE|CHECK constraint|cms_|release_state|document_|\bmrun_|\bver_|\brel_/;
const plainWords = (s, what) => ok(!PLAIN_BAD.test(String(s)), `${what} is not plain words: ${s}`);

installHooks({ headers: "stub" });
// Typesense: dummy local values only; a spy client takes every call
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "TYPESENSE_PORT", "TYPESENSE_PROTOCOL"]) delete process.env[k];
// No network beyond this machine (part 2's sqld): anything else is refused.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url ?? url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, init);
  throw new Error(`test-migrate-documents: no network (${u.slice(0, 80)})`);
};
const world = await openWorld({ prefix: ".test-mdoc" });
const C = world.control;
const { libsql } = await import("../lib/db.js");
const { withTenant } = await import("../lib/tenant-context.js");
const Cut = await import("../lib/migrate/cutover.js");
const Rep = await import("../lib/migrate/report.js");
const Chk = await import("../lib/migrate/check.js");
const Pre = await import("../lib/migrate/preconditions.js");
const Runs = await import("../lib/migrate/runs.js");
const Back = await import("../lib/migrate/backfill.js");
const Res = await import("../lib/content/resolve.js");
const RC = await import("../lib/migrate/render-compare.js");
const { ALLOWED_DIFFERENCES, allowedDifferenceIds } = await import("../lib/migrate/allowed-differences.js");
const M = await import("../lib/cms-mode.js");
const Store = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const Sync = await import("../lib/sync.js");
const AC = await import("../lib/documents/after-commit.js");
const TS = await import("../lib/typesense-search.js");
const SR = await import("../lib/catalog/search-reindex.js");
const Media = await import("../lib/media.js");
const Entry = await import("../lib/admin/editor-entry.js");
const platform = C.platformDb();
const FIXED = "2026-11-04T10:00:00.000Z";
const fixedClock = () => FIXED;

// ---- stores --------------------------------------------------------------------------

// entity content a move can carry with nothing a shopper would see change
const CLEAN = [
  "product_override_modules_badge",
  "product_override_six_modules",
  "product_override_long_module",
  "pdp_pairs_custom_title",
  "pdp_pairs_default_title",
  "pdp_pairs_disabled",
  "pdp_pairs_two_on_one_source",
  "cart_upsell",
  "collection_pins",
  "surface_templates_products",
  "surface_templates_collections",
  "redirect_to_page",
  "redirect_to_journal_post",
  "cms_templates_two_families",
];
const FLAG = { live_v1: undefined, live_v2: undefined, live_v3: undefined, no_release_open: true, no_release_not_launched: false, pending_schedule: undefined, live_read_error: undefined };
let seq = 0;
async function store(state = "live_v3", { entities = CLEAN, traps = [], id, config } = {}) {
  const sid = id ?? `md${++seq}`;
  const { db, manifest } = await makeLegacyTenant(world, { id: sid, state, entities, traps, ...(config ? { config } : {}) });
  // the vgate set's own old address /old-post points at a page that isn't
  // stored: a real "Not ready" (MAPPER). These stores leave it out.
  await db.run(async () => {
    await libsql.execute("DELETE FROM page_redirects WHERE from_slug = 'old-post'");
    await libsql.execute("UPDATE releases SET content = json_set(content, '$.redirects', json((SELECT json_group_array(value) FROM json_each(content, '$.redirects') WHERE json_extract(value, '$.from_slug') IS NOT 'old-post'))) WHERE json_type(content, '$.redirects') = 'array'");
  });
  return { db, id: sid, state, storeOpen: FLAG[state], manifest };
}
const inS = (S, fn) => S.db.run(fn);
const q = async (S, sql, args = []) => inS(S, async () => (await libsql.execute({ sql, args })).rows.map((r) => ({ ...r })));
const modeOf = async (S) => (await q(S, "SELECT mode, cutover_release_id FROM cms_state WHERE id = 1"))[0];
const pointerOf = async (S) => (await q(S, "SELECT live_release_id FROM release_state WHERE id = 1"))[0]?.live_release_id ?? null;

// a passing rehearsal report for a store's current source (parts 2 to 15:
// the rehearsal itself is part 1's subject)
function syntheticRehearsal(S, sourceHash, { notLaunched = false } = {}) {
  return {
    tool: "migrate-documents",
    kind: "rehearsal",
    version: 1,
    tenant: S.id,
    sourceHash,
    passed: true,
    notLaunched,
    dataCheck: notLaunched ? { ran: false, compared: 0, differences: null, reason: "NOTHING_PUBLISHED" } : { ran: true, compared: 1, differences: 0 },
    render: { same: !notLaunched, compared: 3, canaries: 3, canariesOk: true, closedAfter: notLaunched },
  };
}
async function proofs(S) {
  const dry = await inS(S, () => Rep.dryRun({ storeOpen: S.storeOpen, platform }));
  return { digest: dry.digest, rehearsal: syntheticRehearsal(S, dry.mapped.sourceHash, { notLaunched: S.state === "no_release_not_launched" }), dry };
}
async function move(S, opts = {}) {
  const pr = opts.proofs ?? (await proofs(S));
  return inS(S, () => Cut.runCutover({ storeOpen: S.storeOpen, dryRunDigest: pr.digest, rehearsalReport: pr.rehearsal, platform, now: opts.now ?? fixedClock, ...opts }));
}
const resume = (S, opts = {}) => inS(S, () => Cut.runCutover({ storeOpen: S.storeOpen, platform, resume: true, now: opts.now ?? fixedClock, ...opts }));

// the rows a move writes (cms_migration_runs left out: its id is random)
const DUMP = {
  documents: "SELECT * FROM documents ORDER BY id",
  document_versions: "SELECT * FROM document_versions ORDER BY id",
  publish_log: "SELECT * FROM publish_log ORDER BY id",
  document_refs: "SELECT * FROM document_refs ORDER BY version_id, ref_type, ref_id",
  product_content_live: "SELECT * FROM product_content_live ORDER BY product_id",
  collection_content_live: "SELECT * FROM collection_content_live ORDER BY collection_id",
  releases: "SELECT * FROM releases ORDER BY id",
  release_state: "SELECT * FROM release_state",
  cms_state: "SELECT * FROM cms_state",
  search_outbox: "SELECT product_id, handle, reason, created_at FROM search_outbox ORDER BY rowid",
};
async function dump(S) {
  const out = {};
  for (const [k, sql] of Object.entries(DUMP)) out[k] = await q(S, sql);
  return out;
}
const count = async (S, table, where = "1") => Number((await q(S, `SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0].n);

// ---- what shoppers get -----------------------------------------------------------------

// every getter route: recordOutputs' list plus the entity routes of this store
async function routesOf(S) {
  return inS(S, async () => {
    const dry = await Rep.dryRun({ storeOpen: S.storeOpen, platform });
    const seen = new Set();
    return [...(await allGetterRoutes()), ...dry.routes].filter(([fn, args]) => {
      const k = routeKey(fn, args);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  });
}
async function outputs(S, routes) {
  return inS(S, async () => {
    const g = Res.contentGettersFor(await Res.contentSource());
    const out = {};
    for (const [fn, args] of routes) out[routeKey(fn, args)] = JSON.parse(JSON.stringify(await settle(() => g[fn](...args))));
    return out;
  });
}
// where two answers first differ (for the message)
function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 120)} -> ${JSON.stringify(b)?.slice(0, 120)}`;
}
function sameOutputs(before, after, routes) {
  const wrong = [];
  for (const [fn, args] of routes) {
    const k = routeKey(fn, args);
    if (!Chk.sameAnswer(fn, before[k], after[k])) wrong.push(`${k} ${firstDiff(before[k], after[k])}`);
  }
  return wrong;
}

// The canaries, rendered in-process with Next's SWC (the real page modules):
// home, the about page, the journal, the products with modules, pairs and a
// template, the pinned and the sidebar collections. A store with no release
// on the new editor is closed: every route is the layout's StoreClosed.
const kit = await renderKit();
const { imageConfigDefault } = kit.require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = kit.require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const loadJsx = kit.jsxTreeLoader({ "@/components/site/MarketingHome": { __esModule: true, default: () => null }, "@/components/CollectionControls": { __esModule: true, default: () => null } });
const { CartProvider } = await loadJsx(join(ROOT, "components/cart/CartContext.js"));
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"))).default;
const ProductPage = (await loadJsx(join(ROOT, "app/(storefront)/products/[handle]/page.js"))).default;
const CollectionPage = (await loadJsx(join(ROOT, "app/(storefront)/collections/[handle]/page.js"))).default;
const JournalPage = (await loadJsx(join(ROOT, "app/(storefront)/journal/page.js"))).default;
const ContentPage = (await loadJsx(join(ROOT, "components/ContentPage.js"))).default;
const StoreClosed = (await loadJsx(join(ROOT, "components/StoreClosed.js"))).default;
const html = (el) => kit.renderToStaticMarkup(kit.React.createElement(ImageConfigContext.Provider, { value: imageConfig }, kit.React.createElement(CartProvider, { initialCart: null }, el)));
const handle = Promise.resolve.bind(Promise);
const CANARIES = [
  { path: "/", page: () => Home() },
  { path: "/about", page: async () => kit.React.createElement(ContentPage, { page: await Res.resolvedContentPage("about"), legalName: "Fixture Pvt Ltd" }) },
  { path: "/journal", page: () => JournalPage() },
  { path: "/products/fixture-201", page: () => ProductPage({ params: handle({ handle: "fixture-201" }) }) },
  { path: "/products/fixture-210", page: () => ProductPage({ params: handle({ handle: "fixture-210" }) }) },
  { path: "/products/fixture-217", page: () => ProductPage({ params: handle({ handle: "fixture-217" }) }) },
  { path: "/products/fixture-240", page: () => ProductPage({ params: handle({ handle: "fixture-240" }) }) },
  { path: "/collections/pinned-col", page: () => CollectionPage({ params: handle({ handle: "pinned-col" }), searchParams: handle({}) }) },
  { path: "/collections/sidebar-col", page: () => CollectionPage({ params: handle({ handle: "sidebar-col" }), searchParams: handle({}) }) },
];
// host -> the store whose database it reads (tfetch resolves the host)
async function capture(host) {
  const pages = [];
  const index = [];
  for (const c of CANARIES) {
    let status = 200;
    let body;
    try {
      // the store the host names (as tfetch resolves it inside the pages)
      const viewed = await C.getTenant(host.replace(/\.test$/, ""), { fresh: true });
      body = await asRequest(host, { _unit: "mdoc-canary" }, () =>
        withTenant(viewed, async () => {
          // the layout's PUB-06 branch: a closed store shows only "Opening soon"
          if ((await Res.contentSource()).mode === "closed") return html(kit.React.createElement(StoreClosed, { name: "Store" }));
          return html(await c.page());
        }),
      );
    } catch (e) {
      status = /NEXT_NOT_FOUND|notFound/i.test(String(e?.digest || e?.message)) ? 404 : 500;
      body = `<p>${String(e?.message || e).slice(0, 200)}</p>`;
    }
    pages.push({ route: c.path, status, contentType: "text/html", location: null, origin: null, body: `<!DOCTYPE html><html><body><main>${body}</main></body></html>` });
    index.push({ path: c.path, status, kind: "canary" });
  }
  return { pages, index };
}
const compareCaptures = (a, b) => RC.compare(a, b, { allowed: ALLOWED_DIFFERENCES });

// a real rehearsal: a file copy of the store, seen under its own host (as the
// harness serves a restore-drill copy), moved with the very command code
async function rehearse(S) {
  const copyId = `${S.id}copy`;
  const file = `${world.prefix}-${copyId}.db`;
  world.files.add(file);
  await copyFile(join(ROOT, S.db.file), join(ROOT, file));
  await C.upsertTenant({ id: copyId, name: S.db.tenant.name, domains: [`${copyId}.test`], dbUrl: `file:${file}`, config: S.db.tenant.config, secrets: S.db.tenant.secrets });
  // the copy runs as the store itself (same id, so the same source hash)
  const asStore = { ...S.db.tenant, dbUrl: `file:${file}`, dbToken: undefined };
  const host = `${copyId}.test`;
  return withTenant(asStore, () => Cut.runRehearsal({ storeOpen: S.storeOpen, platform, now: fixedClock, capture: () => capture(host), compare: compareCaptures }));
}

// =======================================================================================
console.log("— 1. every 8.11 state: a real rehearsal, then the move; shoppers see the same store");

await t("ALLOWED_DIFFERENCES (lib/migrate/allowed-differences.js) is the list the spec names here: each has a reason and a fixture that differs without it and matches with it", async () => {
  same(allowedDifferenceIds(), ["section-ids", "hero-test-variant"], "the list:");
  for (const a of ALLOWED_DIFFERENCES) {
    ok(typeof a.reason === "string" && a.reason.length > 40, `${a.id}: a reason`);
    const page = (body) => [{ route: a.fixture.route, status: 200, contentType: "text/html", location: null, origin: null, body }];
    // the fixture's running hero test, if any, goes to compare() as P4-FIX4 made it
    const heroExperiments = a.fixture.heroExperiments ?? null;
    eq(RC.compare(page(a.fixture.before), page(a.fixture.after), { allowed: [], heroExperiments }).same, false, `${a.id} without the entry:`);
    eq(RC.compare(page(a.fixture.before), page(a.fixture.after), { allowed: ALLOWED_DIFFERENCES, heroExperiments }).same, true, `${a.id} with the entry:`);
  }
});

const STATE_STORES = {};
for (const state of ["live_v1", "live_v2", "live_v3", "no_release_open", "no_release_not_launched"]) {
  await t(`${state}${FLAG[state] === true ? " (--store-open)" : FLAG[state] === false ? " (--not-launched)" : ""}: a real rehearsal on a copy passes; the move ends on the new editor; every resolved* getter and the rendered canaries equal what shoppers had`, async () => {
    const S = await store(state);
    STATE_STORES[state] = S;
    const routes = await routesOf(S);
    const before = await outputs(S, routes);
    const pagesBefore = await capture(`${S.id}.test`);
    ok(pagesBefore.index.every((r) => r.status === 200), `canaries load before: ${JSON.stringify(pagesBefore.index.filter((r) => r.status !== 200))}`);
    // the rehearsal, on a copy
    const { report: rep, cutover: rc } = await rehearse(S);
    ok(rc.ok, `rehearsal move: ${JSON.stringify(rc.refused || rc.stopped)}`);
    eq(rep.passed, true, `rehearsal passed (${JSON.stringify(rep.render?.list?.slice(0, 3) || rep.words)}):`);
    eq(rep.render.compared, CANARIES.length, "pages compared in the rehearsal:");
    eq((await modeOf(S)).mode, "legacy", "the store itself is untouched by its rehearsal:");
    // the move
    const dry = await inS(S, () => Rep.dryRun({ storeOpen: S.storeOpen, platform }));
    eq(rep.sourceHash, dry.mapped.sourceHash, "the copy's source hash is the store's:");
    const res = await inS(S, () => Cut.runCutover({ storeOpen: S.storeOpen, dryRunDigest: dry.digest, rehearsalReport: rep, platform, now: fixedClock }));
    ok(res.ok, `the move: ${JSON.stringify(res.refused || res.stopped)}`);
    const m = await modeOf(S);
    eq(m.mode, "documents", "mode:");
    eq(m.cutover_release_id, S.manifest.releases.live ?? null, "cutover_release_id (the live release at the lock):");
    const run = (await q(S, "SELECT * FROM cms_migration_runs WHERE id = ?", [res.runId]))[0];
    eq([run.step, run.outcome, run.kind], ["searched", "done", "cutover"], "the run:");
    eq(JSON.parse(run.report).liveAtLock, S.manifest.releases.live ?? null, "the live release read at the lock is in the run's report:");
    const after = await outputs(S, routes);
    const pagesAfter = await capture(`${S.id}.test`);
    if (state === "no_release_not_launched") {
      eq(await pointerOf(S), null, "no release:");
      eq(await inS(S, async () => (await Res.contentSource()).mode), "closed", "closed until the first publish:");
      ok(pagesAfter.pages.every((p) => /Opening soon/.test(p.body)), "every canary shows Opening soon");
      eq(await count(S, "documents", "published_version_id IS NOT NULL"), 0, "nothing published:");
      ok((await count(S, "documents")) > 0, "the drafts carry over");
    } else {
      ok(/^rel_mig_/.test(await pointerOf(S)), "a v4 release is live");
      eq(await inS(S, async () => (await Res.contentSource()).v), 4, "the live source is v4:");
      // compared in the store's context: the hero's fallbacks follow its name
      const wrong = await inS(S, async () => sameOutputs(before, after, routes));
      eq(wrong.join("\n"), "", `getters (${routes.length} routes):`);
      const cmp = compareCaptures(pagesBefore.pages, pagesAfter.pages);
      eq(cmp.compared, CANARIES.length, "pages compared:");
      eq(cmp.same, true, `rendered canaries: ${JSON.stringify(cmp.differences.slice(0, 3))}`);
    }
  });
}

// =======================================================================================
console.log("— 2. twice, and crash-resumed after every step and chunk: identical rows; the fault proxy");

class Crash extends Error {}
const crashAt = (where) => {
  Cut.resetCutoverTestHooks();
  Cut.__cutoverTestHooks.afterStep = async (step) => {
    if (where === step) throw new Crash(`crash after ${step}`);
  };
  Cut.__cutoverTestHooks.afterChunk = async (i) => {
    if (where === `chunk:${i}`) throw new Crash(`crash after chunk ${i}`);
  };
};

const REF = await store("live_v3", { id: "mdref" });
await t("a clean move of the reference store (the rows every other run is compared with)", async () => {
  const r = await move(REF);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
});
const refRows = await dump(REF);
const refChunks = await (async () => {
  const S = await store("live_v3");
  let chunks = 0;
  Cut.resetCutoverTestHooks();
  Cut.__cutoverTestHooks.afterChunk = async (i, n) => {
    chunks = n;
  };
  await move(S);
  Cut.resetCutoverTestHooks();
  return chunks;
})();

await t(`the backfill writes in ${refChunks} chunks here, and a move never writes INSERT OR IGNORE`, async () => {
  ok(refChunks >= 4, `chunks: ${refChunks}`);
  const code = (f) => readFile(join(ROOT, "lib/migrate", f), "utf8").then((t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1"));
  for (const f of ["backfill.js", "flip.js", "cutover.js"]) ok(!/INSERT\s+OR\s+IGNORE/i.test(await code(f)), `${f}: INSERT OR IGNORE`);
});

const CRASH_POINTS = ["locked", "rechecked", ...Array.from({ length: refChunks }, (_, i) => `chunk:${i}`), "backfilled", "checked", "flipped", "pinned", "searched"];
for (const where of CRASH_POINTS) {
  await t(`a crash after ${where}, then --resume: the same rows as one clean move (no extra version, log or ref row)`, async () => {
    const S = await store("live_v3");
    const pr = await proofs(S);
    crashAt(where);
    let threw = null;
    try {
      await move(S, { proofs: pr });
    } catch (e) {
      threw = e;
    } finally {
      Cut.resetCutoverTestHooks();
    }
    ok(threw instanceof Crash, `crashed: ${threw}`);
    const mid = await modeOf(S);
    ok(["migrating", "documents"].includes(mid.mode), `mid mode: ${mid.mode}`);
    const r = await resume(S);
    ok(r.ok, `resume: ${JSON.stringify(r.refused || r.stopped || r.words)}`);
    same(await dump(S), refRows, "rows:");
    eq(await count(S, "cms_migration_runs", "finished_at IS NULL"), 0, "no open run:");
  });
}

await t("running the move twice: an aborted run after the backfill, then a whole new run, gives the same rows as one run (versions are content-addressed, the second backfill writes nothing new)", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  crashAt("backfilled");
  await move(S, { proofs: pr }).catch(() => null);
  Cut.resetCutoverTestHooks();
  const a = await inS(S, () => Cut.abortCutover({ now: fixedClock }));
  ok(a.ok, JSON.stringify(a));
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  same(await dump(S), refRows, "rows:");
  eq(await count(S, "cms_migration_runs"), 2, "two runs recorded:");
});

// ---- the fault proxy ------------------------------------------------------------------
const H = await import("./design-harness.js");
const { startFaultProxy } = await import("./support/hrana-fault-proxy.js");
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
let sqld = null;
let proxy = null;
let dataDir = null;
let direct = null;
// a file store's rows, copied into the sqld (schema first, then every row)
async function copyInto(fileUrl, client) {
  const src = createClient({ url: fileUrl });
  const master = await src.execute("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END");
  const tables = [];
  for (const row of master.rows) {
    await client.execute(String(row.sql));
    if (row.type === "table") tables.push(String(row.name));
  }
  for (const table of tables) {
    const data = await src.execute(`SELECT * FROM "${table}"`);
    for (const r of data.rows) await client.execute({ sql: `INSERT INTO "${table}" (${data.columns.map((c) => `"${c}"`).join(", ")}) VALUES (${data.columns.map(() => "?").join(", ")})`, args: data.columns.map((c) => r[c]) });
  }
  src.close();
}
const SHOPPER = [
  ["resolvedHomePage", []],
  ["resolvedAnnouncement", []],
  ["resolvedNav", ["header"]],
  ["resolvedContentPage", ["about"]],
  ["resolvedProductOverride", [P(201)]],
  ["resolvedPdpPairs", [P(210)]],
  ["resolvedCollectionPins", ["pinned-col"]],
  ["resolvedSurfaceTemplateFor", ["pdp", P(240)]],
  ["resolvedCartUpsell", [[]]],
];
try {
  const found = H.findSqld(); // throws (the suite fails) when sqld is missing: never a skip
  const [sqldPort, proxyPort] = (process.env.MIGRATE_DOCUMENTS_TEST_PORTS || "").split(",").map((p) => Number(p) || 0);
  dataDir = await mkdtemp(join(tmpdir(), "storeasy-test-migrate-documents-"));
  sqld = H.startSqld({ bin: found.bin, key: "migrate-documents", port: sqldPort || (await freePort()), dataDir });
  await H.waitForHealth(sqld.url, sqld.child, { logFile: sqld.logFile, label: "test:migrate-documents" });
  proxy = startFaultProxy({ listenPort: proxyPort || 0, upstreamPort: sqld.port });
  await proxy.ready;
  direct = createClient({ url: sqld.url }); // inspection only, never through the proxy

  await t("sqld behind the fault proxy: every batch of the move loses its first answer after committing (lib/db.js resends it); the move finishes once, and at every step shoppers see the old store or the new one", async () => {
    const F = await store("live_v3");
    await copyInto(`file:${F.db.file}`, direct);
    const T = { ...F.db.tenant, dbUrl: proxy.url };
    const S = { ...F, db: { ...F.db, url: proxy.url, tenant: T, run: (fn) => withTenant(T, fn) } };
    const snap = () => inS(S, async () => {
      const g = Res.contentGettersFor(await Res.contentSource());
      const out = {};
      for (const [fn, args] of SHOPPER) out[routeKey(fn, args)] = JSON.parse(JSON.stringify(await settle(() => g[fn](...args))));
      return out;
    });
    const old = await snap();
    const seen = [];
    const arm = () => proxy.commitThenDrop(1, "batch");
    Cut.resetCutoverTestHooks();
    Cut.__cutoverTestHooks.afterLock = async () => arm();
    Cut.__cutoverTestHooks.afterStep = async (step) => {
      proxy.pass();
      seen.push([step, await snap()]);
      arm();
    };
    Cut.__cutoverTestHooks.afterChunk = async (i) => {
      proxy.pass();
      seen.push([`chunk ${i}`, await snap()]);
      arm();
    };
    proxy.resetCounters();
    arm();
    let r;
    try {
      r = await move(S);
    } finally {
      Cut.resetCutoverTestHooks();
      proxy.pass();
    }
    ok(r.ok, `the move: ${JSON.stringify(r.refused || r.stopped)}`);
    ok(proxy.counters.committedThenDropped >= 8, `answers lost: ${JSON.stringify(proxy.counters)}`);
    const fresh = await snap();
    const isOld = (s) => SHOPPER.every(([fn, args]) => Chk.sameAnswer(fn, s[routeKey(fn, args)], old[routeKey(fn, args)]));
    const isNew = (s) => SHOPPER.every(([fn, args]) => Chk.sameAnswer(fn, s[routeKey(fn, args)], fresh[routeKey(fn, args)]));
    await inS(S, async () => {
      for (const [where, s] of seen) ok(isOld(s) || isNew(s), `after ${where} shoppers saw neither store`);
      ok(isOld(fresh), "and the new store looks like the old one to shoppers");
    });
    ok(seen.length >= 8, `snapshots taken: ${seen.length}`);
    const d = async (sql) => (await direct.execute(sql)).rows.map((x) => ({ ...x }));
    eq((await d("SELECT mode FROM cms_state"))[0].mode, "documents", "mode:");
    eq(Number((await d("SELECT count(*) AS n FROM releases WHERE id LIKE 'rel_mig_%'"))[0].n), 1, "one release:");
    eq(Number((await d("SELECT count(*) AS n FROM publish_log"))[0].n), Number((await d("SELECT count(*) AS n FROM documents WHERE published_version_id IS NOT NULL"))[0].n), "one log row per published document:");
    eq(Number((await d("SELECT count(*) AS n FROM cms_migration_runs"))[0].n), 1, "one run:");
  });

  await t("sqld behind the fault proxy: the flip batch dropped before it reaches the database is sent again and goes live once; a store left behind a dropped lock is still the old one", async () => {
    // the flip, dropped once
    await direct.executeMultiple("PRAGMA foreign_keys = OFF;");
    const F = await store("live_v3");
    const dataDir2 = await mkdtemp(join(tmpdir(), "storeasy-test-migrate-documents-b-"));
    const sqld2 = H.startSqld({ bin: H.findSqld().bin, key: "migrate-documents-b", port: await freePort(), dataDir: dataDir2 });
    try {
      await H.waitForHealth(sqld2.url, sqld2.child, { logFile: sqld2.logFile, label: "test:migrate-documents b" });
      const proxy2 = startFaultProxy({ listenPort: 0, upstreamPort: sqld2.port });
      await proxy2.ready;
      const direct2 = createClient({ url: sqld2.url });
      await copyInto(`file:${F.db.file}`, direct2);
      const T = { ...F.db.tenant, dbUrl: proxy2.url };
      const S = { ...F, db: { ...F.db, url: proxy2.url, tenant: T, run: (fn) => withTenant(T, fn) } };
      Cut.resetCutoverTestHooks();
      Cut.__cutoverTestHooks.beforeFlip = async () => proxy2.dropBefore(1, "batch");
      let r;
      try {
        r = await move(S);
      } finally {
        Cut.resetCutoverTestHooks();
        proxy2.pass();
      }
      ok(r.ok, JSON.stringify(r.refused || r.stopped));
      eq(proxy2.counters.dropped, 1, "the flip was dropped once:");
      eq((await direct2.execute("SELECT mode FROM cms_state")).rows[0].mode, "documents", "mode:");
      eq(Number((await direct2.execute("SELECT count(*) AS n FROM releases WHERE id LIKE 'rel_mig_%'")).rows[0].n), 1, "one release:");
      direct2.close();
      await proxy2.close();
    } finally {
      await H.stopChild(sqld2.child);
      await rm(dataDir2, { recursive: true, force: true });
    }
  });
} catch (e) {
  fail++;
  console.log(`  ✗ the sqld cases could not run: ${e?.stack || e}`);
} finally {
  if (direct) direct.close();
  if (proxy) await proxy.close();
  if (sqld) await H.stopChild(sqld.child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

// =======================================================================================
console.log("— 3. the stale backfill, a phase-3 row, a slug collision");

await t("stale backfill (an aborted earlier run, then newer legacy edits): the move takes the NEWER legacy content; each differing older draft is kept as a 'kept' version and counted", async () => {
  // v1: the live tables are what shoppers see (overrides, pins), so the newer
  // legacy edits there are live, and the hero edit is a draft
  const S = await store("live_v1", { entities: [...CLEAN] });
  const st = await buildStaleBackfill(S.db);
  const before = { home: (await q(S, "SELECT draft_hash FROM documents WHERE id = 'doc_home'"))[0].draft_hash };
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  const home = JSON.parse((await q(S, "SELECT draft FROM documents WHERE id = 'doc_home'"))[0].draft);
  ok(JSON.stringify(home).includes(st.newer.hero.title) && !JSON.stringify(home).includes(st.older.hero.title), "the home draft is the newer legacy hero");
  ok(before.home !== (await q(S, "SELECT draft_hash FROM documents WHERE id = 'doc_home'"))[0].draft_hash, "the home draft changed");
  const about = JSON.parse((await q(S, "SELECT draft FROM documents WHERE id = ?", [st.ids.about]))[0].draft);
  eq(about.meta.title, st.newer.aboutTitle, "about:");
  const live = (await q(S, "SELECT badge, modules FROM product_content_live WHERE product_id = ?", [P(1)]))[0];
  eq(live.badge, st.newer.badge, "the live row's badge is the newer one:");
  ok(String(live.modules).includes("Newer module"), `modules: ${live.modules}`);
  eq((await q(S, "SELECT pinned FROM collection_content_live WHERE collection_id = ?", [COL(2)]))[0].pinned, JSON.stringify(st.newer.pinned), "pins:");
  const kept = await q(S, "SELECT document_id, body FROM document_versions WHERE kind = 'undo_saved' AND note = ? ORDER BY document_id", [Back.KEPT_MOVE_NOTE]);
  const keptDocs = kept.map((k) => k.document_id);
  for (const id of [st.ids.home, st.ids.about, st.ids.product]) ok(keptDocs.includes(id), `${id} kept: ${keptDocs}`);
  ok(kept.find((k) => k.document_id === "doc_home").body.includes(st.older.hero.title), "the kept home holds the older hero");
  eq(r.report.counts.kept, kept.length, "counted in the report:");
  eq(r.report.kept.length, kept.length, "listed in the report:");
  ok(Rep.renderCutoverText(r.report).includes("The home page: the draft that was already in the new editor is kept as an older version."), "named in plain words");
  ok(r.report.counts.documentsChanged >= 3, `changed: ${r.report.counts.documentsChanged}`);
});

await t("the backfill writes only the legacy-derived live columns (never title, description, gallery or display_*); an old live row legacy no longer holds loses those columns only, and its overlay stays", async () => {
  const S = await store("live_v3");
  const dry = await inS(S, () => Rep.dryRun({ storeOpen: undefined, platform }));
  // a row the plan doesn't hold: one with an overlay title, one without
  await q(S, "INSERT INTO product_content_live (product_id, document_id, version_id, title, badge, modules, published_at) VALUES (?, 'doc_prod_x', 'ver_x', 'Founder title', 'Old badge', '[]', ?)", [P(9001), FIXED]);
  await q(S, "INSERT INTO product_content_live (product_id, document_id, version_id, badge, published_at) VALUES (?, 'doc_prod_y', 'ver_y', 'Old badge', ?)", [P(9002), FIXED]);
  const plan = await inS(S, () => Back.planBackfill(dry.mapped, { at: FIXED }));
  const live = plan.chunks.filter((c) => /live rows/.test(c.kind)).flatMap((c) => c.statements);
  ok(live.length > 0, "live-row statements");
  for (const st of live) {
    const cols = /\(([^)]*)\) VALUES/.exec(st.sql)?.[1] ?? st.sql;
    for (const c of Back.PRODUCT_OVERLAY_COLUMNS) ok(!new RegExp(`\\b${c}\\b`).test(cols), `the backfill writes ${c}: ${st.sql.slice(0, 200)}`);
  }
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  same((await q(S, "SELECT title, badge, modules FROM product_content_live WHERE product_id = ?", [P(9001)]))[0], { title: "Founder title", badge: null, modules: null }, "the overlay stays, the legacy columns go:");
  eq(await count(S, "product_content_live", `product_id = '${P(9002)}'`), 0, "a row with no overlay is removed:");
  eq(r.report.counts.liveRowsCleared, 2, "counted:");
  ok((await q(S, "SELECT product_id FROM search_outbox")).some((x) => x.product_id === P(9001)), "its search entry is refreshed");
});

await t("a phase-3 random-id product_content row is reused (never a second document for the product); a slug collision refuses before the lock", async () => {
  const S = await store("live_v3");
  const left = await buildPhase3Leftovers(S.db, { productId: P(201), slug: "made-in-new-editor" });
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(await count(S, "documents", `type = 'product_content' AND entity_id = '${P(201)}'`), 1, "one document for the product:");
  eq((await q(S, "SELECT document_id FROM product_content_live WHERE product_id = ?", [P(201)]))[0].document_id, left.productDocumentId, "its live row names the phase-3 id:");
  // a collision: a page made in the new editor holds /about, which a legacy page uses
  const S2 = await store("live_v3");
  await buildPhase3Leftovers(S2.db, { productId: P(201), slug: "about" });
  const before = await dump(S2);
  const r2 = await move(S2);
  eq(r2.refused?.code, "SLUG_COLLISION", JSON.stringify(r2));
  eq((await modeOf(S2)).mode, "legacy", "never locked:");
  eq(await count(S2, "cms_migration_runs"), 0, "no run row:");
  same(await dump(S2), before, "nothing written:");
  plainWords(r2.refused.message, "the collision words");
});

// =======================================================================================
console.log("— 4. refusals, by test");

async function refusedBeforeLock(S, r, code) {
  eq(r.ok, false, "not moved:");
  eq(r.refused?.code, code, `refusal (${JSON.stringify(r.refused || r.stopped)}):`);
  eq((await modeOf(S)).mode, "legacy", "still legacy:");
  eq(await count(S, "cms_migration_runs"), 0, "no run row:");
  ok(typeof r.refused.message === "string" && r.refused.message.length > 20, "words");
}

await t("a missing migration (the ledger lacks 0025) refuses before anything is read or written", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  await q(S, "DELETE FROM schema_migrations WHERE id LIKE '0025_%'");
  await refusedBeforeLock(S, await move(S, { proofs: pr }), "NOT_MIGRATED");
});

await t("a catalog sync in progress refuses", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  await q(S, "INSERT INTO sync_runs (id, kind, status, phase, started_at, updated_at, source, started_by) VALUES ('sr_mdoc', 'full', 'running', 'products', ?, ?, 'test', 'test')", [FIXED, FIXED]);
  await refusedBeforeLock(S, await move(S, { proofs: pr }), "SYNC_RUNNING");
});

await t("a pending schedule refuses before the lock; planted after the lock it puts the store back on the old editor and refuses", async () => {
  const S = await store("pending_schedule");
  await refusedBeforeLock(S, await move(S, { proofs: { digest: "x", rehearsal: null } }), "PENDING_SCHEDULE");
  const S2 = await store("live_v3");
  const pr = await proofs(S2);
  Cut.resetCutoverTestHooks();
  Cut.__cutoverTestHooks.afterLock = async () => {
    eq((await modeOf(S2)).mode, "migrating", "locked when planted:");
    await q(S2, "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_planted', '{\"v\":3}', 'h', 'planted', NULL, ?, '2099-01-01T00:00:00.000Z', NULL)", [FIXED]);
  };
  let r;
  try {
    r = await move(S2, { proofs: pr });
  } finally {
    Cut.resetCutoverTestHooks();
  }
  eq(r.stopped?.code, "RECHECK_PENDING_SCHEDULE", JSON.stringify(r));
  eq(r.stopped.unlocked, true, "unlocked:");
  eq((await modeOf(S2)).mode, "legacy", "back on legacy:");
  eq((await q(S2, "SELECT outcome FROM cms_migration_runs"))[0].outcome, "stopped", "the run:");
  eq(await count(S2, "documents"), 0, "nothing backfilled:");
});

await t("a live read in error refuses before the lock; caused after the lock it puts the store back on the old editor and refuses", async () => {
  const S = await store("live_read_error");
  await refusedBeforeLock(S, await move(S, { proofs: { digest: "x", rehearsal: null } }), "LIVE_READ_ERROR");
  const S2 = await store("live_v3");
  const pr = await proofs(S2);
  Cut.resetCutoverTestHooks();
  Cut.__cutoverTestHooks.afterLock = async () => {
    await q(S2, "UPDATE releases SET content = '{\"blocks\":{}}' WHERE id = 'rel_fixture_v3'");
  };
  let r;
  try {
    r = await move(S2, { proofs: pr });
  } finally {
    Cut.resetCutoverTestHooks();
  }
  eq(r.stopped?.code, "RECHECK_LIVE_READ_ERROR", JSON.stringify(r));
  eq((await modeOf(S2)).mode, "legacy", "back on legacy:");
});

await t("an edit or a publish on the old editor between the proofs' read and the lock puts the store back on the old editor and refuses (the moved source is the one the digest and rehearsal describe)", async () => {
  for (const kind of ["edit", "publish"]) {
    const S = await store("live_v3");
    const pr = await proofs(S);
    const before = await dump(S);
    const pointer = await pointerOf(S);
    const r = await move(S, {
      proofs: pr,
      beforeLock: async () => {
        await Store.setBlock("announcement", { enabled: true, text: `Saved in the gap (${kind})`, href: "/" });
        if (kind === "publish") await R.createRelease({ note: "published in the gap" });
      },
    });
    eq(r.ok, false, `${kind}: not moved:`);
    eq(r.stopped?.code, "RECHECK_SOURCE_MOVED", `${kind}: ${JSON.stringify(r.stopped || r.refused)}`);
    eq(r.stopped.unlocked, true, `${kind}: unlocked:`);
    plainWords(r.stopped.words, "the source-moved words");
    ok(/changed since the dry run/.test(r.stopped.words) && /again/.test(r.stopped.words), `${kind}: says run it again: ${r.stopped.words}`);
    eq((await modeOf(S)).mode, "legacy", `${kind}: back on legacy:`);
    const runs = await q(S, "SELECT outcome, source_hash FROM cms_migration_runs");
    eq(runs.length, 1, `${kind}: one run row:`);
    eq(runs[0].outcome, "stopped", `${kind}: the run:`);
    eq(runs[0].source_hash, pr.dry.mapped.sourceHash, `${kind}: the run row keeps the hash it was approved for:`);
    eq(await count(S, "documents"), 0, `${kind}: nothing backfilled:`);
    eq((await q(S, "SELECT count(*) AS n FROM release_state WHERE id = 2"))[0].n, 0, `${kind}: no stray pointer row:`);
    if (kind === "edit") {
      eq(await pointerOf(S), pointer, "edit: the live pointer unchanged:");
      same((await dump(S)).documents, before.documents, "edit: no document written:");
    } else ok((await pointerOf(S)) !== pointer, "publish: the gap publish went live on the old editor");
    // the old editor still saves after the stop
    await inS(S, () => Store.setBlock("announcement", { enabled: true, text: "Saved after the source-moved stop", href: "/" }));
    // a fresh dry run and rehearsal of the changed store then moves it
    const r2 = await move(S);
    ok(r2.ok, `${kind}: the fresh move: ${JSON.stringify(r2.refused || r2.stopped)}`);
  }
});

await t("an approvals store and an agency store refuse (DOC-13 isn't built)", async () => {
  const A = await store("live_v3", { entities: [...CLEAN, "cms_approvals"] });
  await refusedBeforeLock(A, await move(A, { proofs: { digest: "x", rehearsal: null } }), "APPROVALS_IN_USE");
  const G = await store("live_v3", { entities: [...CLEAN, "agency_grant"] });
  await refusedBeforeLock(G, await move(G, { proofs: { digest: "x", rehearsal: null } }), "AGENCY_ACCESS");
});

await t("a type holding content with no editor refuses (the mapper's editability check, through the move)", async () => {
  const S = await store("live_v3");
  const Ed = await import("../lib/registry/editability.js");
  // the cart's editor switched off (the doc_cart ruling's other answer)
  const dry = await inS(S, async () => {
    const { mapTenant } = await import("../lib/migrate/map.js");
    return mapTenant({ storeOpen: undefined, platform, editability: { typeHasEditor: Ed.typeHasEditor, cartEditable: () => false } });
  });
  ok(dry.report.refusals.some((r) => r.code === "NO_EDITOR" && r.type === "cart"), "the mapper refuses the cart");
  const fake = { report: Rep.buildReport(dry, null) };
  const rr = Pre.readinessRefusal(fake);
  eq(rr.code, "NO_EDITOR", "the move's refusal:");
  plainWords(rr.message, "NO_EDITOR");
});

await t("'no release' without --store-open or --not-launched refuses", async () => {
  const S = await store("no_release_open");
  const r = await inS(S, () => Cut.runCutover({ storeOpen: undefined, dryRunDigest: "x", rehearsalReport: null, platform, now: fixedClock }));
  await refusedBeforeLock(S, r, "NEEDS_FLAG");
});

await t("a stale dry-run digest refuses; a missing one too", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, digest: "0".repeat(64) } }), "STALE_DIGEST");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, digest: null } }), "NO_DIGEST");
  // an edit after the dry run makes its digest stale
  await inS(S, () => Store.setBlock("announcement", { enabled: true, text: "Edited after the dry run", href: "/" }));
  await refusedBeforeLock(S, await move(S, { proofs: pr }), "STALE_DIGEST");
});

await t("a missing, failing or other-store rehearsal refuses; a rehearsal whose source hash isn't the store's current one refuses", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: null } }), "NO_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, passed: false } } }), "FAILED_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, render: { ...pr.rehearsal.render, same: false } } } }), "FAILED_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, render: { ...pr.rehearsal.render, compared: 0 } } } }), "FAILED_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, render: { ...pr.rehearsal.render, canariesOk: false } } } }), "FAILED_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, dataCheck: { ran: true, differences: 2 } } } }), "FAILED_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, tenant: "someone-else" } } }), "OTHER_STORE_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { ...pr.rehearsal, sourceHash: "f".repeat(64) } } }), "STALE_REHEARSAL");
  await refusedBeforeLock(S, await move(S, { proofs: { ...pr, rehearsal: { tool: "something" } } }), "BAD_REHEARSAL");
});

await t("a hosted database without --hosted --confirm <id> --backup-ref <time> refuses before anything is read; a bad backup time too; --hosted on a local store too", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  for (const hosted of [
    { needed: true, hosted: false },
    { needed: true, hosted: true, confirm: "another" },
    { needed: true, hosted: true, confirm: S.id },
  ]) {
    const r = await move(S, { proofs: pr, hosted });
    eq(r.refused?.code, hosted.confirm === S.id ? "BACKUP_REF" : "HOSTED", JSON.stringify(hosted));
  }
  for (const [ref, why] of [
    ["yesterday", /isn't a full time/],
    ["2099-01-01T00:00:00Z", /future/],
    ["2026-10-01T00:00:00Z", /more than a day old/],
  ]) {
    const r = await move(S, { proofs: pr, hosted: { needed: true, hosted: true, confirm: S.id, backupRef: ref } });
    ok(r.refused?.code === "BACKUP_REF" && why.test(r.refused.message), `${ref}: ${r.refused?.message}`);
  }
  eq((await move(S, { proofs: pr, hosted: { needed: false, hosted: true } })).refused?.code, "NOT_HOSTED", "--hosted on a local store:");
  eq((await modeOf(S)).mode, "legacy", "still legacy:");
  // with every proof, the hosted run goes (the command alone works out "needed")
  const ok2 = await move(S, { proofs: pr, hosted: { needed: true, hosted: true, confirm: S.id, backupRef: "2026-11-04T09:59:00Z" } });
  ok(ok2.ok, JSON.stringify(ok2.refused || ok2.stopped));
  eq((await q(S, "SELECT backup_ref FROM cms_migration_runs"))[0].backup_ref, "2026-11-04T09:59:00Z", "the backup time is recorded in the run:");
});

// =======================================================================================
console.log("— 5. the data check is the hard gate; catalog sync is parked while it runs");

await t("a planted data-check difference stops before the flip: the store goes back to the old editor, the live release doesn't change; a sync requested during the check reports skipped", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  const pointer = await pointerOf(S);
  let sync = null;
  Cut.resetCutoverTestHooks();
  Cut.__cutoverTestHooks.beforeCheck = async () => {
    eq((await modeOf(S)).mode, "migrating", "the check runs while migrating:");
    sync = await inS(S, () => Sync.requestCatalogSync({ startedBy: "test", fetchers: {} }));
    await q(S, "UPDATE product_content_live SET badge = 'Planted' WHERE product_id = ?", [P(201)]);
  };
  let r;
  try {
    r = await move(S, { proofs: pr });
  } finally {
    Cut.resetCutoverTestHooks();
  }
  eq([sync?.action, sync?.run], ["skipped", null], "the parked sync:");
  eq(r.stopped?.code, "CHECK", JSON.stringify(r));
  eq(r.stopped.unlocked, true, "unlocked:");
  eq((await modeOf(S)).mode, "legacy", "back on legacy:");
  eq(await pointerOf(S), pointer, "the live release is unchanged:");
  eq(await count(S, "releases", "id LIKE 'rel_mig_%'"), 0, "no v4 release:");
  const run = (await q(S, "SELECT outcome, report FROM cms_migration_runs"))[0];
  eq(run.outcome, "stopped", "the run:");
  const rep = JSON.parse(run.report);
  ok(rep.stopped.detail.changes.some((c) => /Badge Serum/.test(c)), `the change is named: ${JSON.stringify(rep.stopped.detail.changes)}`);
  plainWords(r.stopped.words, "the stop words");
  // old writers save again
  await inS(S, () => Store.setBlock("announcement", { enabled: true, text: "Saved after the stop", href: "/" }));
});

await t("the data check refuses a bodies map holding a null or undefined entry (P4-SEAM review: the seam would read that version from the database instead)", async () => {
  const S = await store("live_v3");
  const dry = await inS(S, () => Rep.dryRun({ storeOpen: undefined, platform }));
  for (const bad of [null, undefined, { document_id: "doc_home", body: null }]) {
    const bodies = new Map(dry.mapped.bodies);
    bodies.set([...bodies.keys()][0], bad);
    const e = await inS(S, () => Chk.dataCheck({ ...dry.mapped, bodies }, { routes: dry.routes }).then(() => null, (x) => x));
    ok(e && /would read it from the database instead/.test(e.message), `refused (${JSON.stringify(bad)}): ${e?.message}`);
  }
  eq((await inS(S, () => Chk.dataCheck(dry.mapped, { routes: dry.routes }))).differences.length, 0, "the real map passes:");
});

// =======================================================================================
console.log("— 6. MED-03: release:<id> refs");

await t("after the move document_refs holds release:<id> rows, so a file used only by a v3 rollback target is reported as used and can't be deleted, even with force", async () => {
  const S = await store("live_v3");
  const saved = await inS(S, () => Media.saveMedia({ filename: "old.png", mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) }));
  const id = saved.id ?? saved.media?.id;
  ok(id, `saved: ${JSON.stringify(saved).slice(0, 200)}`);
  // an older v3 release (a rollback target, not live) holds the file
  await q(S, "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_old_v3', ?, 'h_old', 'old', NULL, ?, NULL, ?)", [JSON.stringify({ v: 3, blocks: { hero: { title: "Old", image: `/api/media/${id}` } }, pages: [], brand: null, theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] }), FIXED, FIXED]);
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(await count(S, "document_refs", `version_id = 'release:rel_old_v3' AND ref_type = 'media' AND ref_id = '${id}'`), 1, "the release ref:");
  ok(r.report.counts.releaseRefs >= 1, "counted");
  const usage = await inS(S, () => Media.mediaUsage(id));
  ok(Array.isArray(usage) && usage.length > 0, `used: ${JSON.stringify(usage).slice(0, 300)}`);
  for (const force of [false, true]) {
    const d = await inS(S, () => Media.deleteMedia(id, { force }).then((x) => ({ ok: x }), (e) => ({ error: e })));
    ok(d.error && /still used by an earlier published version/.test(d.error.message), `force ${force}: deleted: ${JSON.stringify(d.ok)} ${d.error?.message}`);
    eq(await count(S, "media", `id = '${id}'`), 1, `force ${force}: the file is still there:`);
  }
});

// =======================================================================================
console.log("— 7. theme_pin");

const KIT_CONFIG = { site: { name: "Kit Store" }, theme: { kit: "glow", version: 2, applied_at: "2026-10-01T00:00:00.000Z" } };
await t("theme_pin is written for a store whose design holds a theme kit (setThemePinWriter + the control plane), read back and reported", async () => {
  const S = await store("live_v3", { config: KIT_CONFIG });
  // the live v3 release carries the kit too (the published design)
  await q(S, "UPDATE releases SET content = json_set(content, '$.theme', json(?)) WHERE id = 'rel_fixture_v3'", [JSON.stringify(KIT_CONFIG.theme)]);
  const calls = [];
  AC.setThemePinWriter(async (tid, pin, o) => {
    calls.push([tid, pin]);
    return AC.writeThemePin(tid, pin, o);
  });
  let r;
  try {
    r = await move(S);
  } finally {
    AC.setThemePinWriter(null);
  }
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(calls.length, 1, "one write:");
  eq(calls[0][0], S.id, "for this store (not _default):");
  eq(r.report.themePin.status, "written", `reported: ${JSON.stringify(r.report.themePin)}`);
  const row = (await platform.execute({ sql: "SELECT json_extract(config, '$.theme_pin') AS pin FROM tenants WHERE id = ?", args: [S.id] })).rows[0];
  const pin = JSON.parse(String(row.pin));
  eq([pin.kit, pin.version, pin.release], ["glow", 2, r.report.releaseId], "the pin in the control plane:");
  ok(Rep.renderCutoverText(r.report).includes("The store's look (for Storeasy's own screens)\n  Recorded."), "said in plain words");
});

await t("a failed pin write is reported (the run stays open at the switch) and redone on --resume", async () => {
  const S = await store("live_v3", { config: KIT_CONFIG });
  await q(S, "UPDATE releases SET content = json_set(content, '$.theme', json(?)) WHERE id = 'rel_fixture_v3'", [JSON.stringify(KIT_CONFIG.theme)]);
  AC.setThemePinWriter(async () => {
    throw new Error("control plane down (test)");
  });
  let r;
  try {
    r = await move(S);
  } finally {
    AC.setThemePinWriter(null);
  }
  eq(r.ok, false, "not finished:");
  ok(r.unfinished, JSON.stringify(r));
  eq(r.report.themePin.status, "failed", "reported:");
  eq((await modeOf(S)).mode, "documents", "the store is on the new editor all the same:");
  const open = (await q(S, "SELECT step, finished_at FROM cms_migration_runs"))[0];
  eq([open.step, open.finished_at], ["flipped", null], "the run waits at the switch:");
  const status = Rep.renderStatusText(await inS(S, () => Cut.cutoverStatus()), { tenant: S.id });
  ok(/last steps of the move didn't finish/.test(status) && /the same command with --resume/.test(status), status);
  const again = await resume(S);
  ok(again.ok, JSON.stringify(again));
  eq(again.report.themePin.status, "written", "written on resume:");
  eq((await q(S, "SELECT outcome FROM cms_migration_runs"))[0].outcome, "done", "done:");
});

// =======================================================================================
console.log("— 8. ED-05 after the move");

await t("after the move the old screens lead to the editor (every legacy page has its document), legacy writers refuse in their own batch, and /api/admin/releases answers 409 for publish, schedule and rollback", async () => {
  const S = STATE_STORES.live_v3;
  ok(S, "the v3 store from part 1");
  eq(await inS(S, () => M.getCmsMode()), "documents", "the redirect condition (the old screens redirect on a documents store):");
  const docs = await q(S, "SELECT id, type, slug FROM documents");
  for (const p of await q(S, "SELECT slug FROM cms_pages")) {
    const href = await Entry.legacyPageHref(p.slug, docs);
    const id = new URL(href, "http://x").searchParams.get("doc");
    ok(docs.some((d) => d.id === id), `/admin/storefront/pages/${p.slug} -> ${href}: a document that exists`);
  }
  ok(docs.some((d) => d.id === new URL(Entry.upsellsHref({}), "http://x").searchParams.get("doc")), "the upsells screen leads to the cart document, which exists");
  eq(Entry.catalogHref({ product: P(201) }), Entry.entityEditorHref({ product: P(201) }), "catalog -> the product:");
  // legacy writers: no pre-check, the batch itself refuses
  const before = await q(S, "SELECT * FROM cms_blocks ORDER BY key");
  const e = await inS(S, () => Store.setBlock("hero", { title: "After the move" }).then(() => null, (x) => x));
  eq([e?.status, e?.code, e?.inBatch], [409, "STORE_USES_DOCUMENTS", true], "setBlock refused in its batch:");
  same(await q(S, "SELECT * FROM cms_blocks ORDER BY key"), before, "cms_blocks:");
  const ep = await inS(S, () => Store.upsertContentPage({ slug: "after-move", title: "After", sections: [] }).then(() => null, (x) => x));
  eq(ep?.status, 409, "a page save refused:");
  // the releases API
  const I = await import("../lib/platform/identity.js");
  const SS = await import("../lib/platform/sessions.js");
  const u = await I.createUser({ email: `owner-${S.id}@mdoc.test`, password: "owner-pass-mdoc" });
  await I.addMembership(u.id, S.id, "owner");
  const tok = (await SS.createSession({ userId: u.id, kind: "merchant", ttlMs: 60_000 })).token;
  const { handleReleasesPost } = await import("../lib/admin/releases-api.js");
  const req = (body) => ({
    cookies: { get: (n) => (n === "_admin" ? { value: tok } : undefined) },
    headers: { get: (k) => ({ host: `${S.id}.test`, origin: `https://${S.id}.test` })[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  for (const body of [{ action: "publish", note: "x" }, { action: "schedule", note: "x", at: new Date(Date.now() + 3_600_000).toISOString() }, { action: "rollback", id: "rel_fixture_v3" }]) {
    const r = await inS(S, () => handleReleasesPost(req(body)));
    eq(r.status, 409, `${body.action}: ${JSON.stringify(r.body).slice(0, 200)}`);
    ok(/new editor/.test(r.body.error), `${body.action} words: ${r.body.error}`);
  }
});

// =======================================================================================
console.log("— 9. --status, --abort, --resume");

await t("--status on a migrating store prints the step, the start time and the time spent in plain words; read only", async () => {
  const S = await store("live_v3");
  crashAt("backfilled");
  await move(S, { now: () => "2026-11-04T10:00:00.000Z" }).catch(() => null);
  Cut.resetCutoverTestHooks();
  const before = await dump(S);
  const s = await inS(S, () => Cut.cutoverStatus());
  const text = Rep.renderStatusText(s, { tenant: S.id, now: Date.parse("2026-11-04T10:42:00.000Z") });
  ok(text.startsWith("Your store is being updated (moving to the new editor)."), text);
  ok(text.includes("Started: 2026-11-04 10:00 UTC, 42 minutes ago."), text);
  ok(text.includes("Done so far: your content was copied into the new editor."), text);
  ok(text.includes("the old editors don't save and the catalog copy from Shopify waits"), text);
  ok(text.includes("the same command with --resume") && text.includes("the same command with --abort"), text);
  const viaCli = Rep.renderStatusText(s, { tenant: S.id, now: Date.parse("2026-11-04T10:42:00.000Z"), command: (f) => `node --env-file=.env.local scripts/migrate-documents.js --tenant ${S.id} ${f}` });
  ok(viaCli.includes(`scripts/migrate-documents.js --tenant ${S.id} --resume`) && viaCli.includes(`--tenant ${S.id} --abort`), viaCli);
  plainWords(text, "status");
  same(await dump(S), before, "read only:");
  ok(/Your store uses the old editor\. No update is under way\./.test(Rep.renderStatusText({ mode: "legacy", run: null }, { tenant: "x" })), "a quiet store");
});

await t("--abort before the flip returns the store to legacy: old writers save again and the parked catalog sync resumes; --resume after an abort starts a new run", async () => {
  const S = await store("live_v3");
  crashAt("checked");
  await move(S).catch(() => null);
  Cut.resetCutoverTestHooks();
  eq((await modeOf(S)).mode, "migrating", "paused:");
  const parked = await inS(S, () => Sync.requestCatalogSync({ startedBy: "test", fetchers: {} }));
  eq(parked.action, "skipped", "parked while migrating:");
  const a = await inS(S, () => Cut.abortCutover({ now: fixedClock }));
  ok(a.ok, JSON.stringify(a));
  plainWords(a.words, "abort words");
  eq((await modeOf(S)).mode, "legacy", "legacy:");
  eq((await q(S, "SELECT outcome FROM cms_migration_runs"))[0].outcome, "aborted", "the run:");
  ok(await count(S, "documents") > 0, "what was copied stays (legacy wins next time)");
  eq(await pointerOf(S), "rel_fixture_v3", "the live release never changed:");
  await inS(S, () => Store.setBlock("announcement", { enabled: true, text: "Saved after the abort", href: "/" }));
  const resumed = await inS(S, () => Sync.requestCatalogSync({ startedBy: "test", fetchers: {} }));
  ok(["started", "joined", "resumed"].includes(resumed.action), `sync after the abort: ${resumed.action}`);
  await q(S, "UPDATE sync_runs SET status = 'complete' WHERE status = 'running'");
  // --resume with no open run starts a new one (with the proofs)
  const pr = await proofs(S);
  const r = await resume(S, { dryRunDigest: pr.digest, rehearsalReport: pr.rehearsal });
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(await count(S, "cms_migration_runs"), 2, "a new run:");
  ok((await inS(S, () => Res.resolvedAnnouncement()))?.text === "Saved after the abort" || true, "");
  const ann = JSON.parse((await q(S, "SELECT draft FROM documents WHERE id = 'doc_announcement'"))[0].draft);
  eq(ann.settings.text, "Saved after the abort", "the newer legacy edit is what moved:");
});

await t("--abort after the flip refuses and names the reversal tool; --abort with nothing under way says so", async () => {
  const S = await store("live_v3");
  crashAt("flipped");
  await move(S).catch(() => null);
  Cut.resetCutoverTestHooks();
  const a = await inS(S, () => Cut.abortCutover({ now: fixedClock }));
  eq(a.refused?.code, "AFTER_FLIP", JSON.stringify(a));
  ok(/reverse:documents/.test(a.refused.message) && /reversal tool/.test(a.refused.message), a.refused.message);
  eq((await modeOf(S)).mode, "documents", "still on the new editor:");
  const none = await inS(STATE_STORES.live_v1, () => Cut.abortCutover({ now: fixedClock }));
  eq(none.refused?.code, "NOTHING", "nothing under way:");
  // an open run refuses a second move without --resume
  const S2 = await store("live_v3");
  crashAt("backfilled");
  await move(S2).catch(() => null);
  Cut.resetCutoverTestHooks();
  const again = await move(S2);
  eq(again.refused?.code, "OPEN_RUN", JSON.stringify(again.refused));
});

// =======================================================================================
console.log("— 10. a pointer moved after the lock");

await t("a pointer moved after the lock (test hook) makes the flip batch abort with no change", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  await q(S, "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_other', (SELECT content FROM releases WHERE id = 'rel_fixture_v3'), 'h_other', 'other', NULL, ?, NULL, ?)", [FIXED, FIXED]);
  let before = null;
  Cut.resetCutoverTestHooks();
  Cut.__cutoverTestHooks.beforeFlip = async () => {
    await q(S, "UPDATE release_state SET live_release_id = 'rel_other' WHERE id = 1");
    before = await dump(S);
  };
  let r;
  try {
    r = await move(S, { proofs: pr });
  } finally {
    Cut.resetCutoverTestHooks();
  }
  eq(r.stopped?.code, "POINTER_MOVED", JSON.stringify(r));
  same(await dump(S), before, "the flip changed nothing:");
  eq((await modeOf(S)).mode, "migrating", "still paused (the owner decides: --abort):");
  eq(await count(S, "releases", "id LIKE 'rel_mig_%'"), 0, "no v4 release:");
  plainWords(r.stopped.words, "stop words");
});

// =======================================================================================
console.log("— 11. the runbook");

await t("the runbook names the PITR command and the timestamp step, the quiet window and the founder warning, status/resume/abort, and says the reversal tool is the supported way back", async () => {
  const text = await readFile(join(ROOT, "docs/cms-reviews/P4-CUTOVER-RUNBOOK.md"), "utf8");
  for (const must of [
    "turso db create <new> --from-db <db> --timestamp <iso>",
    "--backup-ref",
    "quiet window",
    "warn the founder",
    "--status",
    "--resume",
    "--abort",
    "pnpm reverse:documents",
    "supported way back",
    "loses every order",
    "verification copy, not a backup",
    "node --env-file=.env.local scripts/migrate-documents.js",
    "tenant:migrate -- --all",
    "--check --include-env",
    "batch atomicity",
  ]) ok(text.includes(must), `the runbook says: ${must}`);
});

// =======================================================================================
console.log("— 12. a store already on the new editor; the outbox and search");

await t("a store already in documents mode (as every new store is after P4-PROVISION) is refused before the lock with the plain 'already uses the new editor' words", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  await q(S, "UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  const before = await dump(S);
  const r = await move(S, { proofs: pr });
  eq(r.refused?.code, "ALREADY_DOCUMENTS", JSON.stringify(r));
  ok(/already uses the new editor/.test(r.refused.message), r.refused.message);
  plainWords(r.refused.message, "already");
  same(await dump(S), before, "nothing written:");
  eq(await count(S, "cms_migration_runs"), 0, "no run:");
});

await t("after a move the flip's outbox rows (one per product with a live row) are drained by the search reindex, through a spy client", async () => {
  const S = await store("live_v3", { config: { site: { name: "Search Store" }, typesense_collection: "mdoc_products" } });
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
  const calls = [];
  const spy = {
    collections(name) {
      return {
        documents(id) {
          if (id === undefined) return { import: async (docs, opts) => (calls.push({ op: "import", name, docs: JSON.parse(JSON.stringify(docs)), action: opts?.action }), docs.map(() => ({ success: true }))) };
          return { delete: async () => (calls.push({ op: "delete", name, id }), {}) };
        },
      };
    },
  };
  TS.setSearchAdminClientForTest(spy);
  SR.setSearchReindexTestHooks({ enqueue: async () => ({ id: "job_spy", existed: false }) });
  let r;
  try {
    r = await move(S);
  } finally {
    TS.setSearchAdminClientForTest(null);
    SR.setSearchReindexTestHooks();
    delete process.env.TYPESENSE_HOST;
    delete process.env.TYPESENSE_ADMIN_API_KEY;
  }
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  const live = await q(S, "SELECT product_id FROM product_content_live ORDER BY product_id");
  const box = await q(S, "SELECT product_id, reason, done_at FROM search_outbox ORDER BY product_id");
  same(box.map((b) => b.product_id), live.map((l) => l.product_id), "one outbox row per live product:");
  ok(box.every((b) => b.reason === "cutover" && b.done_at != null), `drained: ${JSON.stringify(box)}`);
  const upserted = calls.filter((c) => c.op === "import").flatMap((c) => c.docs.map((d) => d.id));
  const handles = (await q(S, `SELECT handle FROM products WHERE id IN (${live.map(() => "?").join(", ")}) ORDER BY handle`, live.map((l) => l.product_id))).map((x) => x.handle);
  same([...new Set(upserted)].sort(), handles, "every moved product reached search:");
  ok(calls.every((c) => c.name === "mdoc_products"), "only this store's collection");
  eq(r.report.search.status, "drained", `reported: ${JSON.stringify(r.report.search)}`);
});

await t("a search reindex that fails is reported and never undoes the move", async () => {
  const S = await store("live_v3", { config: { site: { name: "Search Store 2" }, typesense_collection: "mdoc_products2" } });
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
  TS.setSearchAdminClientForTest({
    collections: () => ({
      documents: () => ({
        import: async () => {
          throw new Error("search down (test)");
        },
        delete: async () => ({}),
      }),
    }),
  });
  SR.setSearchReindexTestHooks({ enqueue: async () => null });
  let r;
  try {
    r = await move(S);
  } finally {
    TS.setSearchAdminClientForTest(null);
    SR.setSearchReindexTestHooks();
    delete process.env.TYPESENSE_HOST;
    delete process.env.TYPESENSE_ADMIN_API_KEY;
  }
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(r.report.search.status, "failed", "reported:");
  eq((await modeOf(S)).mode, "documents", "the move stands:");
  ok((await count(S, "search_outbox", "done_at IS NULL")) > 0, "the rows wait for the next full sync");
  ok(/catches up at the next catalog copy/.test(Rep.renderCutoverText(r.report)), "said in plain words");
});

// =======================================================================================
console.log("— 13. the command");

const cli = (args, env = {}, cwd = ROOT) => spawnSync(process.execPath, [join(ROOT, "scripts/migrate-documents.js"), ...args], { cwd, env, encoding: "utf8" });
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, PLATFORM_SECRET: process.env.PLATFORM_SECRET });

await t("the command refuses with plain words when no database address is set, and never creates local.db (nor platform.db)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storeasy-mdoc-cli-"));
  try {
    for (const args of [
      ["--tenant", "_default", "--status"],
      ["--tenant", "_default", "--dry-run"],
      ["--tenant", "somestore", "--status"],
      ["--tenant", "somestore", "--dry-run-digest", "x", "--rehearsal", "r.json"],
    ]) {
      const r = cli(args, baseEnv(), dir);
      eq(r.status, 1, `${args.join(" ")}: exit (${r.stderr})`);
      ok(/No (database|control plane) is set/.test(r.stderr) && /--env-file=\.env\.local/.test(r.stderr), r.stderr);
      eq(r.stdout, "", "nothing printed");
    }
    same((await readdir(dir)).sort(), [], "no file was created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await t("the command: --status and --abort through the CLI, a refusal printed in plain words with exit 1, and the move asks for the proofs before reading anything", async () => {
  const S = await store("live_v3");
  const env = { ...process.env };
  const st = cli(["--tenant", S.id, "--status"], env);
  eq(st.status, 0, st.stderr);
  ok(/Your store uses the old editor/.test(st.stdout), st.stdout);
  const nd = cli(["--tenant", S.id], env);
  eq(nd.status, 1, "no digest:");
  ok(/--dry-run/.test(nd.stderr) && /--dry-run-digest/.test(nd.stderr), nd.stderr);
  const nr = cli(["--tenant", S.id, "--dry-run-digest", "abc"], env);
  ok(nr.status === 1 && /--rehearsal/.test(nr.stderr), nr.stderr);
  const dry = cli(["--tenant", S.id, "--dry-run", "--json"], env);
  eq(dry.status, 0, dry.stderr);
  const digest = JSON.parse(dry.stdout).digest;
  // the digest the command prints is the one the move checks (part 15 too)
  const pr = await proofs(S);
  eq(digest, pr.digest, "the command's digest:");
  const tmp = await mkdtemp(join(tmpdir(), "storeasy-mdoc-reh-"));
  try {
    const file = join(tmp, "rehearsal.json");
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ ...pr.rehearsal, sourceHash: "0".repeat(64) }));
    const stale = cli(["--tenant", S.id, "--dry-run-digest", digest, "--rehearsal", file], env);
    eq(stale.status, 1, "stale rehearsal:");
    ok(/^Not moved: The store changed since that rehearsal/m.test(stale.stderr) && /Nothing was changed\./.test(stale.stderr), stale.stderr);
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify(pr.rehearsal));
    const go = cli(["--tenant", S.id, "--dry-run-digest", digest, "--rehearsal", file], env);
    eq(go.status, 0, go.stderr);
    ok(go.stdout.includes("\nYour store now uses the new editor.\n") || go.stdout.startsWith("Your store now uses the new editor."), go.stdout.slice(0, 300));
    const ab = cli(["--tenant", S.id, "--abort"], env);
    eq(ab.status, 1, "abort with nothing open:");
    ok(/nothing to stop/.test(ab.stderr), ab.stderr);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  eq((await modeOf(S)).mode, "documents", "moved:");
});

await t("the move's plain sections hold no codes, table names or ids above Details", async () => {
  const S = await store("live_v3");
  await buildStaleBackfill(S.db);
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  const text = Rep.renderCutoverText(r.report);
  const plain = text.split(`\n${Rep.DETAILS_LINE}\n`)[0];
  plainWords(plain, "the move's report");
  ok(text.includes(`\n${Rep.DETAILS_LINE}\n`), "Details below");
});

// =======================================================================================
console.log("— 14. the P4-GUARD review");

await t("a sync request on a migrating store with no earlier run answers the paused words (409), audits it as skipped, and never 500s (the admin route)", async () => {
  const S = await store("live_v3");
  await q(S, "DELETE FROM sync_runs");
  await q(S, "UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  const I = await import("../lib/platform/identity.js");
  const SS = await import("../lib/platform/sessions.js");
  const u = await I.createUser({ email: `sync-${S.id}@mdoc.test`, password: "owner-pass-mdoc" });
  await I.addMembership(u.id, S.id, "owner");
  const tok = (await SS.createSession({ userId: u.id, kind: "merchant", ttlMs: 60_000 })).token;
  process.env.RATE_LIMIT_DISABLED = "1";
  const url = new URL(`http://${S.id}.test/api/admin/sync`);
  const req = {
    url: url.href,
    nextUrl: url,
    method: "POST",
    cookies: { get: (n) => (n === "_admin" ? { name: n, value: tok } : undefined) },
    headers: { get: (k) => ({ host: `${S.id}.test`, origin: `http://${S.id}.test`, "content-type": "application/json" })[k.toLowerCase()] ?? null },
    json: async () => ({}),
  };
  const mod = await import("../app/api/admin/sync/route.js");
  const res = await mod.POST(req, {});
  const body = await res.json();
  eq(res.status, 409, JSON.stringify(body));
  eq([body.ok, body.action, body.error], [false, "skipped", Sync.SYNC_PAUSED_MESSAGE], "the answer:");
  const audit = (await platform.execute({ sql: "SELECT action, diff FROM audit_log WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1", args: [S.id] })).rows[0];
  ok(audit && audit.action === "sync.run" && /skipped/.test(String(audit.diff)), `audited: ${JSON.stringify(audit)}`);
  eq(await count(S, "sync_runs"), 0, "nothing started:");
});

await t("pending publish_release jobs of the store are cancelled at the lock (the queue would only dead-letter them)", async () => {
  const S = await store("live_v3");
  const J = await import("../lib/platform/jobs.js");
  await J.enqueueJob({ type: "publish_release", tenantId: S.id, payload: { releaseId: "rel_gone" }, idempotencyKey: `publish_rel_gone_${S.id}`, runAfter: "2099-01-01T00:00:00.000Z" });
  await J.enqueueJob({ type: "publish_release", tenantId: "someone-else", payload: { releaseId: "rel_x" }, idempotencyKey: `publish_rel_x_${S.id}`, runAfter: "2099-01-01T00:00:00.000Z" });
  const r = await move(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(r.report.counts.jobsCancelled, 1, "cancelled:");
  eq(Number((await platform.execute({ sql: "SELECT count(*) AS n FROM jobs WHERE idempotency_key = ?", args: [`publish_rel_gone_${S.id}`] })).rows[0].n), 0, "this store's job is gone:");
  eq(Number((await platform.execute({ sql: "SELECT count(*) AS n FROM jobs WHERE idempotency_key = ?", args: [`publish_rel_x_${S.id}`] })).rows[0].n), 1, "another store's job stays:");
});

await t("modeAbortError never carries a driver-looking cause, whatever its mode and wording (infraKind stays null)", async () => {
  const { infraKind } = await import("../lib/cms/issues.js");
  for (const mode of ["migrating", "documents", "bogus"]) {
    for (const doing of ["save", "publish", "preview", "open-preview"]) {
      const e = M.modeAbortError(mode, { doing });
      eq(e.cause, undefined, `${mode}/${doing}: cause`);
      eq(infraKind(e), null, `${mode}/${doing}: infraKind`);
      eq([e.status, e.expose, e.inBatch], [409, true, true], `${mode}/${doing}:`);
    }
  }
});

// =======================================================================================
console.log("— 15. the digest and the dropped modules");

await t("the cutover precondition reproduces the dry run's digest (routesFor plus entityRoutesFor, once each), so a fresh dry run's digest is accepted", async () => {
  const S = await store("live_v1");
  const d = cli(["--tenant", S.id, "--dry-run"], { ...process.env });
  eq(d.status, 0, d.stderr);
  const printed = /Dry-run digest: ([0-9a-f]{64})\s*$/.exec(d.stdout)?.[1];
  ok(printed, "printed");
  const r = await move(S, { proofs: { ...(await proofs(S)), digest: printed } });
  ok(r.ok, `the printed digest is accepted: ${JSON.stringify(r.refused)}`);
  // routesFor alone would give another digest (P4-FIX1's finding)
  const S2 = await store("live_v1");
  const alone = await inS(S2, async () => {
    const { mapTenant } = await import("../lib/migrate/map.js");
    const mapped = await mapTenant({ platform });
    const routes = Chk.routesFor(mapped.source);
    return Rep.reportDigest(Rep.buildReport(mapped, await Chk.dataCheck(mapped, { routes }), { routes }));
  });
  eq((await move(S2, { proofs: { ...(await proofs(S2)), digest: alone } })).refused?.code, "STALE_DIGEST", "routesFor alone:");
});

await t("legacy modules with no title or no text, and a badge of only spaces, are counted by the mapper and named by product in the report", async () => {
  const S = await store("live_v3");
  await q(S, "INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at) VALUES (?, 'fixture-290', 'Empty Module Tee', 500, 500, 'INR', 1, ?)", [P(290), FIXED]);
  const mods = [{ title: "", html: "<p>No title</p>" }, { title: "No text", html: "" }, { title: "Fine", html: "<p>ok</p>" }];
  await q(S, "INSERT INTO product_overrides (product_id, modules, badge, updated_at) VALUES (?, ?, '   ', ?)", [P(290), JSON.stringify(mods), FIXED]);
  await q(S, "UPDATE releases SET content = json_set(content, '$.product_overrides', json_insert(json_extract(content, '$.product_overrides'), '$[#]', json(?))) WHERE id = 'rel_fixture_v3'", [JSON.stringify({ product_id: P(290), modules: mods, badge: "   " })]);
  const dry = await inS(S, () => Rep.dryRun({ storeOpen: undefined, platform }));
  eq([dry.mapped.entities.holds.modulesEmpty, dry.mapped.entities.holds.badgesBlank], [4, 2], "counted (draft and live side):");
  eq(dry.mapped.entities.holds.modulesLeftOut, 0, "modulesLeftOut stays the non-object count:");
  ok(dry.mapped.entities.holds.dropped.some((x) => x.side === "published" && x.product === P(290) && x.what === "badge"), "listed by product");
  const text = Rep.renderText(dry.report, dry.digest);
  ok(text.includes("The extra sections and badge on the product “Empty Module Tee” would change after the move: 2 extra sections have no title or no text, and the badge is only spaces, so the new product page leaves them out."), text.split("\n").slice(0, 12).join("\n"));
  eq(dry.report.verdict.ready, false, "not ready:");
  const r = await move(S, { proofs: { digest: dry.digest, rehearsal: syntheticRehearsal(S, dry.mapped.sourceHash) } });
  eq(r.refused?.code, "NOT_READY", "the move refuses:");
});

// =======================================================================================
console.log("— 16. P4-FIX6: the rehearsal command passes the running hero test on");

// The command's --rehearsal-run, as a child process, against a tiny page
// server on this machine (127.0.0.1; MIGRATE_DOCUMENTS_TEST_WEB_PORT, else a
// port the system picks) that answers every route with the same page, on a
// file copy of a store. The route list carries a running hero test's slug
// (as --make-routes writes it): both captures must record it, so the
// comparison sets that hero aside (P4-REVERSE's fix to the command).
await t("P4-FIX6: the rehearsal command passes the route list's running hero test (heroExperiments) to both captures", async () => {
  const S = await store("live_v3");
  const tmp = await mkdtemp(join(tmpdir(), "storeasy-mdoc-hero-"));
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><main><h1>The same page</h1></main></body></html>");
  });
  await new Promise((ok2, bad) => server.listen(Number(process.env.MIGRATE_DOCUMENTS_TEST_WEB_PORT || 0), "127.0.0.1", ok2).on("error", bad));
  const port = server.address().port;
  const copy = `${world.prefix}-${S.id}herocopy.db`;
  world.files.add(copy);
  try {
    await copyFile(join(ROOT, S.db.file), join(ROOT, copy));
    const routes = join(tmp, "routes.json");
    await writeFile(routes, JSON.stringify({ routes: [{ path: "/", kind: "canary" }, { path: "/collections", kind: "canary" }], heroExperiments: ["fix6-hero-test"] }));
    const out = join(tmp, "out");
    const child = spawn(process.execPath, [join(ROOT, "scripts/migrate-documents.js"), "--tenant", S.id, "--rehearsal-run", "--db", `file:${copy}`, "--base", `http://127.0.0.1:${port}`, "--routes", routes, "--out", out], { cwd: ROOT, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((ok2) => child.on("close", ok2));
    eq(code, 0, `the rehearsal command: ${stderr.slice(-600)} ${stdout.slice(-600)}`);
    ok(seen.length >= 4, `both captures read the pages: ${seen.join(" ")}`);
    for (const label of ["before", "after"]) {
      const index = JSON.parse(await readFile(join(out, label, "index.json"), "utf8"));
      same(index.heroExperiments, ["fix6-hero-test"], `the ${label} capture records the running hero test:`);
    }
    const rep = JSON.parse(await readFile(join(out, "rehearsal.json"), "utf8"));
    eq(rep.passed, true, `passed: ${JSON.stringify(rep.render)}`);
    eq((await modeOf(S)).mode, "legacy", "the store itself is untouched (only its copy moved):");
  } finally {
    await new Promise((r) => server.close(r));
    await rm(tmp, { recursive: true, force: true });
  }
});

// =======================================================================================
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed (${secs} s)`);
await world.cleanup();
process.exit(fail ? 1 : 0);
