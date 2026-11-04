// P4-HARNESS: local file-database tenants for the phase 4 CLI drills (the
// dry run, the cutover and the reversal run against these, never against a
// hosted or real store). Built with the P4-FIXTURES builders
// (scripts/support/legacy-tenants.js), then copied out as plain files.
//
//   node scripts/drills/p4/local-tenants.mjs [--out <dir>]   build, copy, verify
//   node scripts/drills/p4/local-tenants.mjs --check [--out <dir>]
//                                                       verify an earlier build
//
// The five states (spec 8.11), one database each, in <dir> (default
// .design-data/p4-local; a fresh harness seed wipes .design-data, so build
// after seeding):
//   v1.db        live on a version 1 release (entities in the live tables)
//   v2.db        live on a version 2 release (entities frozen in the release)
//   v3.db        live on a version 3 release
//   open.db      no release, store open to shoppers   (operator flag --store-open)
//   closed.db    no release, store not launched yet   (operator flag --not-launched)
// plus platform.db, a control plane whose tenant rows point at those files,
// and manifest.json (each tenant's id, file: URL, state, flag and live
// release). Every store holds the "vgate" content set, its drafts, and the
// entity fixtures a cutover can move (overrides, pairs, the cart upsell, pins,
// template exceptions, redirects, saved templates; not approvals or agency
// grants, which make a cutover refuse, and not the BeastLife-only redirect).
// The control plane's secret is the fixtures' test value (manifest.env).
//
// Verified by SQL after the build (and by --check): each copy is legacy, has
// the right live release and version (or none), the right release count, and
// its rows; the control plane names each copy. Results:
// docs/cms-reviews/drills/P4-HARNESS/results-local-tenants.json, written only
// when the build is in the default folder (a scratch --out leaves the
// committed file alone).
// File databases only: anything else is refused before it is opened.
//
// The output folder is never wiped. A rebuild deletes only the files this tool
// writes (OWN_FILES), and only in a folder that is new, empty, or an earlier
// build of this tool (its manifest.json says so) holding nothing else. Any
// other folder (one with a file this tool did not write, or a manifest.json of
// some other kind) is refused before anything is deleted or built. A
// .DS_Store (Finder's) is tolerated and left where it is (P4-DRILLS).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const PREFIX = ".test-p4-local";
export const DEFAULT_OUT = join(ROOT, ".design-data", "p4-local");
const RESULTS = join(ROOT, "docs", "cms-reviews", "drills", "P4-HARNESS", "results-local-tenants.json");

// name -> the legacy-tenants state row, and what SQL must show
export const LOCAL_STATES = Object.freeze([
  { name: "v1", id: "p4-local-v1", state: "live_v1", v: 1 },
  { name: "v2", id: "p4-local-v2", state: "live_v2", v: 2 },
  { name: "v3", id: "p4-local-v3", state: "live_v3", v: 3 },
  { name: "open", id: "p4-local-open", state: "no_release_open", v: null, flag: "--store-open" },
  { name: "closed", id: "p4-local-closed", state: "no_release_not_launched", v: null, flag: "--not-launched" },
]);
// entities a cutover can move (no approvals or agency grant: those refuse a cutover)
const ENTITIES = [
  "product_override_modules_badge",
  "product_override_six_modules",
  "product_override_long_module",
  "product_override_unsanitized_html",
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
  "redirect_to_nothing",
  "cms_templates_two_families",
];

// what this tool writes, and the only files it ever deletes
export const MANIFEST_TOOL = "p4-local-tenants";
const DB_NAMES = [...LOCAL_STATES.map((s) => s.name), "platform"];
export const OWN_FILES = Object.freeze([...DB_NAMES.flatMap((n) => [`${n}.db`, `${n}.db-wal`, `${n}.db-shm`]), "manifest.json"]);
// files the operating system leaves in a folder: neither foreign nor deleted
export const IGNORED_FILES = Object.freeze([".DS_Store"]);

// Make outDir ready for a build: create it, or clear an earlier build of this
// tool file by file. Refuses (throws, deleting nothing) when the folder holds
// anything this tool did not write, or is not this tool's earlier build.
export function prepareOutDir(outDir) {
  const refuse = (why) => {
    throw new Error(`Refused to build in ${outDir}: ${why} Nothing was deleted. Pick a new or empty folder with --out.`);
  };
  let st = null;
  try {
    st = lstatSync(outDir);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (!st) {
    mkdirSync(outDir, { recursive: true });
    return { created: true, removed: [] };
  }
  if (!st.isDirectory() || st.isSymbolicLink()) refuse("it is not a folder.");
  // Finder drops a .DS_Store into any folder it opens: it is tolerated (and
  // left in place), never counted as a foreign file
  const entries = readdirSync(outDir).filter((n) => !IGNORED_FILES.includes(n));
  if (!entries.length) return { created: false, removed: [] };
  const foreign = entries.filter((n) => !OWN_FILES.includes(n));
  if (foreign.length) refuse(`it holds files this tool did not write (${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", …" : ""}).`);
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  } catch {
    manifest = null;
  }
  if (manifest?.tool !== MANIFEST_TOOL) refuse("it is not an earlier build of this tool (no manifest.json written by it).");
  for (const n of entries) {
    if (!lstatSync(join(outDir, n)).isFile()) refuse(`${n} is not a plain file.`);
  }
  for (const n of entries) rmSync(join(outDir, n));
  return { created: false, removed: entries };
}

// a file: URL for an absolute path on this machine (spaces and all)
const fileUrl = (path) => pathToFileURL(path).href.replace(/^file:\/\//, "file:");
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

function parseArgs(argv) {
  const out = { check: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--out" && argv[i + 1]) out.out = resolve(argv[++i]);
    else throw new Error(`Unknown option "${a}". Use: node scripts/drills/p4/local-tenants.mjs [--check] [--out <dir>]`);
  }
  if (!isAbsolute(out.out)) out.out = resolve(out.out);
  return out;
}

// Build the five stores, copy them (VACUUM INTO, a clean single file each)
// and the control plane to outDir, point the copied control plane at them.
export async function buildLocalTenants(outDir = DEFAULT_OUT) {
  const L = await import("../../support/legacy-tenants.js");
  const { assertLocalDbUrl } = await import("../../support/tenant-fixture.js");
  prepareOutDir(outDir);
  L.installHooks({ headers: "real" });
  const world = await L.openWorld({ prefix: PREFIX });
  const tenants = [];
  try {
    const { libsql } = await import("../../../lib/db.js");
    for (const s of LOCAL_STATES) {
      const { db, manifest } = await L.makeLegacyTenant(world, { id: s.id, name: `Local ${s.name}`, file: s.name, set: "vgate", state: s.state, entities: ENTITIES });
      const file = join(outDir, `${s.name}.db`);
      await db.run(() => libsql.execute(`VACUUM INTO ${sqlString(file)}`));
      const url = assertLocalDbUrl(fileUrl(file));
      tenants.push({ name: s.name, id: s.id, state: s.state, describe: L.STATE_ROWS[s.state].describe, flag: manifest.flag, liveRelease: manifest.releases.live, v: s.v, file, url });
    }
    const platformFile = join(outDir, "platform.db");
    await world.control.platformDb().execute(`VACUUM INTO ${sqlString(platformFile)}`);
    const { createClient } = await import("@libsql/client");
    const pc = createClient({ url: assertLocalDbUrl(fileUrl(platformFile)) });
    try {
      for (const t of tenants) await pc.execute({ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [t.url, t.id] });
    } finally {
      pc.close();
    }
    const manifest = {
      tool: MANIFEST_TOOL,
      builtAt: new Date().toISOString(),
      outDir,
      platform: { file: platformFile, url: fileUrl(platformFile) },
      env: { PLATFORM_DB_URL: fileUrl(platformFile), PLATFORM_SECRET: "test-platform-secret", TURSO_DB_URL: "" },
      entities: ENTITIES,
      tenants,
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await world.cleanup();
  }
}

// Read every copy back with a plain client and check it by SQL.
export async function verifyLocalTenants(outDir = DEFAULT_OUT) {
  const { assertLocalDbUrl } = await import("../../support/tenant-fixture.js");
  const { createClient } = await import("@libsql/client");
  const manifestFile = join(outDir, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`There is no build in ${outDir}. Build it first: node scripts/drills/p4/local-tenants.mjs`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const checks = [];
  const check = (ok, label, detail) => {
    checks.push({ ok: !!ok, label, detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  };
  const one = async (c, sql, args = []) => (await c.execute({ sql, args })).rows[0] || {};
  const pc = createClient({ url: assertLocalDbUrl(manifest.platform.url) });
  try {
    for (const s of LOCAL_STATES) {
      const t = manifest.tenants.find((x) => x.name === s.name);
      if (!t) {
        check(false, `${s.name}: in the manifest`, null);
        continue;
      }
      const c = createClient({ url: assertLocalDbUrl(t.url) });
      try {
        const mode = (await one(c, "SELECT mode FROM cms_state WHERE id = 1")).mode;
        const live = await one(c, "SELECT s.live_release_id AS id, json_extract(r.content, '$.v') AS v FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
        const n = async (table) => Number((await one(c, `SELECT count(*) AS n FROM ${table}`)).n || 0);
        const got = {
          mode,
          liveRelease: live.id ?? null,
          v: live.v ?? null,
          releases: await n("releases"),
          products: await n("products"),
          cms_pages: await n("cms_pages"),
          cms_blocks: await n("cms_blocks"),
          product_overrides: await n("product_overrides"),
          placements: await n("placements"),
          collection_overrides: await n("collection_overrides"),
          page_redirects: await n("page_redirects"),
          cms_templates: await n("cms_templates"),
          documents: await n("documents"),
        };
        const want = { mode: "legacy", liveRelease: t.liveRelease, v: s.v, releases: s.v ? 1 : 0, documents: 0 };
        check(Object.entries(want).every(([k, v]) => got[k] === v), `${s.name}: ${s.v ? `legacy, live on a version ${s.v} release` : `legacy, no release (${s.flag})`}, no documents`, { want, got: { mode: got.mode, liveRelease: got.liveRelease, v: got.v, releases: got.releases, documents: got.documents } });
        check(got.products >= 20 && got.cms_pages > 0 && got.cms_blocks > 0 && got.product_overrides >= 4 && got.placements >= 6 && got.collection_overrides >= 1 && got.page_redirects >= 3 && got.cms_templates === 2, `${s.name}: holds the catalog, drafts and entity rows`, got);
        if (s.v >= 2) {
          const content = JSON.parse((await one(c, "SELECT content FROM releases WHERE id = ?", [t.liveRelease])).content || "{}");
          const frozen = { overrides: (content.product_overrides || []).length, placements: (content.placements || []).length, pins: (content.collection_pins || []).length, redirects: (content.redirects || []).length };
          check(frozen.overrides >= 4 && frozen.placements >= 6 && frozen.pins >= 1 && frozen.redirects >= 3, `${s.name}: the version ${s.v} release froze the entity rows`, frozen);
        }
        check(t.flag === (s.flag ?? null), `${s.name}: the operator flag is ${s.flag ?? "none"}`, t.flag);
        const row = await one(pc, "SELECT db_url FROM tenants WHERE id = ?", [t.id]);
        check(row.db_url === t.url, `${s.name}: the copied control plane points tenant ${t.id} at this file`, row.db_url);
      } finally {
        c.close();
      }
    }
  } finally {
    pc.close();
  }
  return { manifest, checks, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const started = Date.now();
  if (!opts.check) {
    const m = await buildLocalTenants(opts.out);
    console.log(`✓ built ${m.tenants.length} local stores in ${opts.out} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  const r = await verifyLocalTenants(opts.out);
  // the committed results file describes the default build only: a run into
  // a scratch folder (--out elsewhere) leaves it alone
  if (resolve(opts.out) !== resolve(DEFAULT_OUT)) {
    console.log(`-- local-tenants: ${r.passed} passed, ${r.failed} failed (built in ${opts.out}; the committed results file is written only for the default folder)`);
    return r.failed ? 1 : 0;
  }
  mkdirSync(join(RESULTS, ".."), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify({ id: "P4-HARNESS", part: "local-tenants", ranAt: new Date().toISOString(), outDir: opts.out, passed: r.passed, failed: r.failed, checks: r.checks, tenants: r.manifest.tenants.map(({ name, id, state, flag, liveRelease, v }) => ({ name, id, state, flag, liveRelease, v })) }, null, 2)}\n`);
  console.log(`-- local-tenants: ${r.passed} passed, ${r.failed} failed. Results in docs/cms-reviews/drills/P4-HARNESS/results-local-tenants.json`);
  return r.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✗ ${e.message || e}`);
      process.exit(1);
    },
  );
}
