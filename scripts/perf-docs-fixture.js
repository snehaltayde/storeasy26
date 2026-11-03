// P2-PERF (PERF-01): the perf fixture as documents-mode content, for
// measuring the version 4 read path. Local only: the fixture is written to a
// test store (unit tests) or to the design harness's own sqld, never to a
// real store, and nothing here talks to Shopify.
//
// Two halves, like scripts/perf-fixture.js:
//   buildDocumentsFixture({ posts })   pure and deterministic. The perf
//       fixture's content (scripts/perf-fixture.js, buildPerfFixture) turned
//       into registry document bodies: every singleton but the cart, 21 pages
//       (the fixture's 20 plus the demo's shipping page), its 4 campaigns and
//       `posts` journal posts. Every section id is fixed and the order is
//       fixed, so two runs give the same documents and the same `hash`. Every
//       body passes validateDocument in publish mode, or the builder throws.
//       Singletons carry their doc_<type> id; route documents get theirs from
//       the write service when they are created (random, plan decision 10).
//   publishDocumentsFixture(fx)        creates those documents as drafts
//       through the write service (lib/documents/service.js createDocument,
//       so no table is written directly) in the active tenant database (call
//       inside withTenant), then publishes them through
//       lib/documents/publish.js, in sets of up to 200. The journal index is
//       made by publish itself. The store must already be in documents mode
//       with no v1 to v3 release live (see takeOverHarnessStore below, for
//       the harness only).
//
// CLI (the design harness on DESIGN_PORT / DESIGN_SQLD_PORT, stopped):
//   node scripts/perf-docs-fixture.js hash [--posts N]
//       print the fixture's hash (the determinism check runs this twice)
//   node scripts/perf-docs-fixture.js publish --posts N
//       the harness store, seeded with `node scripts/dev-design.js seed
//       --fixture perf`, moved to documents mode and published (the harness
//       store only; the seeded v3 pointer is cleared first)
//   node scripts/perf-docs-fixture.js unpublish-legacy
//       the harness store's live pointer cleared, mode left legacy: a legacy
//       store before its first publish, for the extra cms_state read
//   node scripts/perf-docs-fixture.js report <label=run.json> …
//       docs/perf/2026-11-phase2-local.json and .md from perf-report runs
//
// The measurement itself is scripts/perf-report.js http (perf-http.js and
// the unchanged perf-dbcount.js), with --extra-routes. See
// docs/cms-reviews/P2-PERF.md for the exact commands.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPerfFixture, PERF_FIXTURE } from "./perf-fixture.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// The demo store's content that the perf seed keeps (scripts/seed-design-
// preview.js): its live announcement, its live hero and its shipping page.
const DEMO_ANNOUNCEMENT = { enabled: true, text: "Festive sale — free shipping over ₹1,499", href: "/collections" };
const DEMO_HERO = {
  title: "Skin first. Makeup second.",
  highlight: "Skin first",
  subtitle: "Clinically-tested routines for Indian skin — serums, SPF and repair that actually show up in the mirror.",
  primary: { label: "Shop bestsellers", href: "/collections" },
};
const DEMO_SHIPPING = { slug: "shipping", title: "Shipping policy", description: "", family: "page", sections: [{ id: "sec_demoship", kind: "text", heading: "Dispatch", body: ["Orders dispatch within 24 hours on business days."] }] };
// The tenant's configured brand (seed-design-preview.js), as doc_design.
const DEMO_BRAND = { accent: "#0d9488" };

export const SINGLETON_ORDER = ["announcement", "header", "footer", "design", "home", "collections_index", "product_layout", "collection_layout"];

const urlLink = (href) => ({ type: "url", href });
const navItem = (it) => ({ label: it.label, link: urlLink(it.href), ...(Array.isArray(it.children) ? { children: it.children.map((c) => ({ label: c.label, link: urlLink(c.href) })) } : {}) });

// Registry modules are loaded lazily, so `hash` from the CLI and the unit
// test share one code path without loading the app at import time.
async function registry() {
  const Reg = await import("../lib/registry/index.js");
  const ids = await import("../lib/documents/ids.js");
  return { Reg, ids };
}

// One route document's body from a legacy page record of the perf fixture.
function routeBody(Reg, type, page) {
  const b = Reg.emptyBody(type);
  b.meta = {
    ...b.meta,
    slug: page.slug,
    title: page.title,
    description: page.description ?? "",
    enabled: page.enabled !== false,
    window_start: page.window_start ?? null,
    window_end: page.window_end ?? null,
  };
  b.sections = Reg.legacyPageSectionsToSections(page.sections);
  return b;
}

export async function buildDocumentsFixture({ posts = 0 } = {}) {
  if (!Number.isInteger(posts) || posts < 0 || posts > 5000) throw new Error(`buildDocumentsFixture: posts must be a whole number from 0 to 5000, not ${posts}`);
  const { Reg, ids } = await registry();
  const fx = buildPerfFixture({ ...PERF_FIXTURE, journalPosts: posts });
  const docs = [];
  const singleton = (type, body) => docs.push({ id: ids.singletonId(type), type, slug: null, label: Reg.documentType(type).label, body });

  // singletons
  {
    const b = Reg.emptyBody("announcement");
    b.settings = { ...b.settings, ...Reg.legacyAnnouncementToSettings(DEMO_ANNOUNCEMENT) };
    singleton("announcement", b);
  }
  {
    const b = Reg.emptyBody("header");
    b.settings = { ...b.settings, mode: "custom", items: fx.navHeader.map(navItem) };
    singleton("header", b);
  }
  {
    const b = Reg.emptyBody("footer");
    b.settings = { ...b.settings, mode: "custom", items: fx.navFooter.map(navItem) };
    singleton("footer", b);
  }
  {
    const b = Reg.emptyBody("design");
    b.settings = { ...b.settings, brand: DEMO_BRAND };
    singleton("design", b);
  }
  {
    const b = Reg.emptyBody("home");
    b.sections = [Reg.legacyHeroToSection(DEMO_HERO), ...Reg.legacyHomeSectionsToSections(fx.homeSections)];
    singleton("home", b);
  }
  singleton("collections_index", Reg.emptyBody("collections_index"));
  for (const type of ["product_layout", "collection_layout"]) {
    const b = Reg.emptyBody(type);
    // the protected module gets a fixed id (emptyBody mints a random one)
    b.sections = b.sections.map((s, i) => ({ ...s, id: `sec_${type === "product_layout" ? "pl" : "cl"}main${i}` }));
    singleton(type, b);
  }

  // route documents: 21 pages, the campaigns, then the posts (ids come from
  // the write service at create)
  const route = (type, page) => docs.push({ id: null, type, slug: page.slug, label: page.title, body: routeBody(Reg, type, page) });
  for (const p of [...fx.pages, DEMO_SHIPPING]) route("page", p);
  for (const p of fx.campaigns) route("campaign", p);
  for (const p of fx.posts) route("journal", p);

  // every body must publish: a fixture the publish service refuses measures nothing
  for (const d of docs) {
    const r = Reg.validateDocument(d.body, { mode: "publish", documentId: d.id ?? d.slug });
    const errors = r.issues.filter((i) => i.severity === "error");
    if (errors.length) throw new Error(`buildDocumentsFixture: ${d.id ?? d.slug} (${d.type}) would not publish: ${JSON.stringify(errors).slice(0, 600)}`);
    d.body = r.body;
  }
  const counts = { singletons: docs.filter((d) => !Reg.documentType(d.type).route).length, pages: docs.filter((d) => d.type === "page").length, campaigns: docs.filter((d) => d.type === "campaign").length, posts: docs.filter((d) => d.type === "journal").length };
  const hash = sha256(Reg.stableStringify(docs));
  return { posts, documents: docs, counts, hash, measured: fx.measured };
}

// ---------------------------------------------------------------------------
// writing and publishing (inside withTenant)
// ---------------------------------------------------------------------------

const PUBLISHED_BY = "seed:perf-docs";

export async function publishDocumentsFixture(fixture, { log = () => {} } = {}) {
  const { getCmsMode } = await import("../lib/cms-mode.js");
  const { createDocument } = await import("../lib/documents/service.js");
  const { publish, PUBLISH_SET_CAP } = await import("../lib/documents/publish.js");
  if ((await getCmsMode()) !== "documents") throw new Error("publishDocumentsFixture: the store is not in documents mode");
  const rows = [];
  for (const d of fixture.documents) {
    const { document } = await createDocument({ type: d.type, body: d.body, actor: PUBLISHED_BY });
    if (d.id && document.id !== d.id) throw new Error(`publishDocumentsFixture: ${d.type} was created as ${document.id}, not ${d.id}`);
    rows.push({ ...d, id: document.id, revision: document.revision, draftHash: document.draftHash });
  }
  log(`  drafts: ${rows.length} documents created through the write service`);
  let releases = 0;
  let last = null;
  for (let i = 0; i < rows.length; i += PUBLISH_SET_CAP) {
    const set = rows.slice(i, i + PUBLISH_SET_CAP);
    const r = await publish({ ids: set.map((d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash })), actor: PUBLISHED_BY });
    if (r.published.length !== set.length) throw new Error(`publishDocumentsFixture: published ${r.published.length} of ${set.length} (skipped ${r.skipped.length})`);
    releases++;
    last = r.release?.id ?? last;
  }
  log(`  published: ${rows.length} documents in ${releases} publish sets, live release ${last}`);
  return { documents: rows.length, releases, release: last, ids: rows.map((d) => d.id) };
}

// The harness store only: the perf seed publishes a v3 release, and the
// publish service (rightly) refuses a store whose live release is v1 to v3.
// This clears that pointer and moves the store to documents mode, as a
// cutover would. Never called on anything but the harness's own sqld.
export async function takeOverHarnessStore({ libsql }) {
  await libsql.batch(["UPDATE release_state SET live_release_id = NULL, updated_at = datetime('now') WHERE id = 1", "UPDATE cms_state SET mode = 'documents' WHERE id = 1"], "write");
}

// ---------------------------------------------------------------------------
// the combined report (docs/perf/2026-11-phase2-local.*)
// ---------------------------------------------------------------------------

const kb = (b) => (b == null ? "–" : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

export function phase2Report(runs, { baseline = null, takenOn } = {}) {
  const keys = [];
  for (const r of runs) for (const route of r.run.routes) if (!keys.includes(route.key)) keys.push(route.key);
  const cell = (run, key) => run.routes.find((x) => x.key === key) || null;
  const summary = runs.map((r) => ({
    label: r.label,
    store: r.store,
    posts: r.posts ?? null,
    build: r.run.environment.build.id,
    commit: r.run.environment.git.commit,
    fixture: r.run.fixture,
    routes: r.run.routes.map((x) => ({
      key: x.key,
      path: x.path,
      status: x.status,
      ttfb: x.ttfb,
      total: x.total,
      cold: x.cold,
      sentBytes: x.bytes.wire,
      db: { reads: x.db.warm.reads, readsFirst: x.db.first.reads, roundTrips: x.db.warm.roundTrips, rowsRead: x.db.warm.rowsRead, bytesDown: x.db.warm.bytesDown, bytesDownDecoded: x.db.warm.bytesDownDecoded, repeated: x.db.warm.duplicateReads, stable: x.db.stableAcrossRuns, sqldAgrees: x.db.sqldAgrees, statements: x.db.statements },
    })),
  }));
  const base = baseline
    ? {
        file: baseline.file,
        commit: baseline.run.environment.git.commit,
        routes: baseline.run.routes.map((x) => ({ key: x.key, path: x.path, reads: x.db.warm.reads, roundTrips: x.db.warm.roundTrips, bytesDown: x.db.warm.bytesDown, bytesDownDecoded: x.db.warm.bytesDownDecoded, totalP50: x.total.p50 })),
      }
    : null;
  const json = {
    kind: "storeasy-perf-phase2",
    version: 1,
    takenOn,
    environment: { kind: "local", machine: runs[0]?.run.environment.machine, node: runs[0]?.run.environment.node, next: runs[0]?.run.environment.next, sqld: runs[0]?.run.environment.sqld, runtime: runs[0]?.run.environment.runtime },
    budgets: "None. These are local numbers (kind: local), not budgets. Budgets wait for hosted numbers (PERF-04, OQ-19).",
    method: runs[0]?.run.method,
    baseline: base,
    runs: summary,
  };
  // markdown: per route, round trips and parsed bytes across the runs
  const head = `| Route | ${base ? "Baseline 2026-11-03 | " : ""}${runs.map((r) => r.label).join(" | ")} |`;
  const sep = `|---|${base ? "---|" : ""}${runs.map(() => "---").join("|")}|`;
  const dbRow = (key) => {
    const b = base?.routes.find((x) => x.key === key);
    const cells = runs.map((r) => {
      const c = cell(r.run, key);
      return c ? `${c.db.warm.roundTrips} / ${kb(c.db.warm.bytesDownDecoded)}` : "–";
    });
    return `| ${key} | ${base ? `${b ? `${b.roundTrips} / ${kb(b.bytesDownDecoded)}` : "–"} | ` : ""}${cells.join(" | ")} |`;
  };
  const timeRow = (key) => {
    const b = base?.routes.find((x) => x.key === key);
    const cells = runs.map((r) => {
      const c = cell(r.run, key);
      return c ? `${c.total.p50} / ${c.total.p95}` : "–";
    });
    return `| ${key} | ${base ? `${b ? `${b.totalP50}` : "–"} | ` : ""}${cells.join(" | ")} |`;
  };
  const md = `# Phase 2 local numbers (P2-PERF, PERF-01)

**Kind: local. Not budgets.** One Mac, a production build of the design harness (\`next build\`, then \`next start\`), storefront on Next's local edge runtime, databases on local sqld. Hosted numbers are an owner check (OQ-19).

- Taken: ${takenOn}. Machine: ${json.environment.machine?.cpu}, ${json.environment.machine?.cores} cores, ${json.environment.machine?.os}, Node ${json.environment.node}, Next ${json.environment.next}, ${json.environment.sqld}.
- Runs (each its own \`node scripts/perf-report.js http --extra-routes\` on the same build): ${runs.map((r) => `**${r.label}** (${r.store}, build \`${r.run.environment.build.id}\`, commit \`${r.run.environment.git.commit}\`, load ${r.run.environment.machine.loadAverageAtStart.join("/")} at start)`).join("; ")}.
- Database counts come from scripts/perf-dbcount.js (unchanged) in front of each sqld, checked against sqld's own query counter. Every count below was the same on all ${runs[0]?.run.method.countedRuns} counted runs of its route unless marked.

## Round trips and parsed bytes per request (warm)

Each cell: round trips to the databases / what the page parsed from them (all three databases).

${head}
${sep}
${keys.map(dbRow).join("\n")}

## Total time, p50 / p95 ms (warm)

${head}
${sep}
${keys.map(timeRow).join("\n")}
`;
  return { json, md };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function withHarnessStore(fn) {
  const H = await import("./design-harness.js");
  const { join } = await import("node:path");
  const env = process.env;
  const ports = H.harnessPorts(env);
  const dataDir = join(H.ROOT, H.DATA_DIR_NAME);
  const other = H.runningHarness(dataDir);
  if (other) throw new H.HarnessError(`The design harness is running in this checkout (pid ${other.launcher.pid}). Stop it first.`);
  await H.stopLeftovers(dataDir, console.log);
  const seeded = H.readSeeded(dataDir);
  if (seeded?.fixture !== "perf") throw new H.HarnessError("The harness data isn't the perf fixture. Seed it first: node scripts/dev-design.js seed --fixture perf");
  for (const key of ["platform", "tenant"]) if (await H.isPortBusy(ports.sqld[key])) throw new H.HarnessError(`Port ${ports.sqld[key]} is already in use.`);
  const sqld = H.findSqld({ env });
  const servers = ["platform", "tenant"].map((key) => H.startSqld({ bin: sqld.bin, key, port: ports.sqld[key], dataDir }));
  try {
    for (const s of servers) await H.waitForHealth(s.url, s.child, { logFile: s.logFile, label: s.key });
    const urls = H.harnessUrls(ports);
    await H.pointTenantAtThisRun({ platform: urls.platform, tenant: urls.tenant });
    const hEnv = H.harnessEnv(env, H.ensureCredentials(H.ROOT), ports);
    // the app's modules read these at import: set them first
    for (const k of ["DATABASE_URL", "PLATFORM_DB_URL", "PLATFORM_DB_TOKEN", "PLATFORM_SECRET"]) process.env[k] = hEnv[k];
    process.env.TURSO_DB_URL = "";
    H.assertLocalDbUrl("PLATFORM_DB_URL", process.env.PLATFORM_DB_URL);
    const C = await import("../lib/platform/control.js");
    const { withTenant } = await import("../lib/tenant-context.js");
    const { libsql } = await import("../lib/db.js");
    const tenant = await C.getTenant(H.TENANT_ID);
    if (!tenant) throw new H.HarnessError("The harness has no design store. Seed it again.");
    H.assertLocalDbUrl("the design store's database", tenant.dbUrl || tenant.db_url || urls.tenant);
    return await withTenant(tenant, () => fn({ libsql }));
  } finally {
    await Promise.all(servers.map((s) => H.stopChild(s.child)));
  }
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v == null || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const posts = Number(argValue(rest, "--posts") ?? 0);
  if (cmd === "hash") {
    const fx = await buildDocumentsFixture({ posts });
    console.log(JSON.stringify({ posts, hash: fx.hash, counts: fx.counts }));
    return 0;
  }
  if (cmd === "publish") {
    const fx = await buildDocumentsFixture({ posts });
    console.log(`• documents fixture: ${JSON.stringify(fx.counts)}, hash ${fx.hash.slice(0, 16)}`);
    await withHarnessStore(async ({ libsql }) => {
      await takeOverHarnessStore({ libsql });
      await publishDocumentsFixture(fx, { log: console.log });
    });
    console.log("✓ the harness store is in documents mode with the fixture published");
    return 0;
  }
  if (cmd === "unpublish-legacy") {
    await withHarnessStore(async ({ libsql }) => {
      const mode = (await libsql.execute("SELECT mode FROM cms_state WHERE id = 1")).rows[0]?.mode;
      if (mode !== "legacy") throw new Error(`the harness store is in ${mode} mode, not legacy: seed it again first`);
      await libsql.execute("UPDATE release_state SET live_release_id = NULL, updated_at = datetime('now') WHERE id = 1");
    });
    console.log("✓ the harness store has no live release (legacy mode): drafts serve, as before a first publish");
    return 0;
  }
  if (cmd === "report") {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { ROOT } = await import("./design-harness.js");
    const runs = [];
    let baseline = null;
    for (const a of rest.filter((x) => x.includes("="))) {
      const [label, file] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
      const meta = /^(.*)\|(.*)\|(.*)$/.exec(label);
      const run = JSON.parse(readFileSync(file, "utf8"));
      if (label === "baseline") baseline = { file: file.replace(`${ROOT}/`, ""), run };
      else runs.push({ label: meta ? meta[1] : label, store: meta ? meta[2] : "", posts: meta && meta[3] !== "" ? Number(meta[3]) : null, run });
    }
    const takenOn = runs[0]?.run.takenAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const { json, md } = phase2Report(runs, { baseline, takenOn });
    const out = argValue(rest, "--out") || "docs/perf";
    writeFileSync(join(ROOT, out, "2026-11-phase2-local.json"), `${JSON.stringify(json, null, 2)}\n`);
    writeFileSync(join(ROOT, out, "2026-11-phase2-local.md"), md);
    console.log(`✓ wrote ${out}/2026-11-phase2-local.json and .md`);
    return 0;
  }
  console.error("Use: node scripts/perf-docs-fixture.js hash|publish [--posts N] | unpublish-legacy | report label|store|posts=run.json … [baseline=run.json]");
  return 2;
}

// fileURLToPath, not a "file://" string: the URL percent-encodes a space
// (the owner's checkout is ".../Projects 2026/..."), so a string compare would
// skip the CLI there and exit 0 with no output (scripts/drill.js does the same).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
