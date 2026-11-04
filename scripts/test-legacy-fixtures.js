// P4-FIXTURES (MIG-01, MIG-02, MIG-04): the legacy tenant builders of
// scripts/support/legacy-tenants.js.
//   1. builders refuse anything but a local file database (libsql://, https://,
//      a sqld on 127.0.0.1), before they touch it;
//   2. every 8.11 state row, mapping trap, entity fixture and re-run fixture
//      the phase 4 plan names has a builder, and each builder is checked here;
//   3. the builders plus recordOutputs reproduce the a6d028e baselines
//      (legacy-release-outputs, home-render-outputs, legacy-journal-outputs),
//      in this process and through the three recorders, which are now thin
//      wrappers over the builders;
//   4. what each named builder writes, and what the store then answers.
// P4-HARNESS adds: redirect_to_code_default_page needs BeastLife or the env
// store (and its target renders there), a second build on one database is
// refused, and the stale backfill's versions hold what its live rows say.
// File databases only (.test-lfx-*.db at the checkout's root, removed at the
// end). Nothing reaches the network or Shopify.
//   pnpm test:legacy-fixtures
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AGENCY_KIT_PAYLOAD,
  AI_PROPOSALS,
  CONTENT_SETS,
  COL,
  ENTITY_FIXTURES,
  HERO_EXPERIMENT,
  LEGACY_RELEASE_ROUTES,
  MAPPING_TRAPS,
  P,
  RERUN_FIXTURES,
  STATE_ROWS,
  allGetterRoutes,
  buildLegacyTenant,
  buildPhase3Leftovers,
  buildStaleBackfill,
  installHooks,
  makeLegacyTenant,
  openWorld,
  putLiveRelease,
  recordOutputs,
  resolvedGetterNames,
  routeKey,
  startHeroExperiment,
} from "./support/legacy-tenants.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg = "") => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
// key order aside (a release row is stored with sorted keys); list order counts
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b, msg = "") => {
  const x = JSON.stringify(canon(a));
  const y = JSON.stringify(canon(b));
  if (x !== y) throw new Error(`${msg}\n      expected ${y?.slice(0, 400)}\n      got      ${x?.slice(0, 400)}`);
};
async function rejects(fn, re, msg) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  ok(threw, `${msg}: did not throw`);
  if (re) ok(re.test(String(threw?.message)), `${msg}: threw "${threw?.message}"`);
}

// ---- the required list (P4-BATCHES.json, P4-FIXTURES brief (2) to (5)) ----------------
const REQUIRED = {
  "8.11 state rows": {
    map: STATE_ROWS,
    names: ["live_v1", "live_v2", "live_v3", "no_release_open", "no_release_not_launched", "pending_schedule", "live_read_error"],
  },
  "mapping traps": {
    map: MAPPING_TRAPS,
    names: [
      "nav_header_null",
      "nav_header_empty",
      "nav_header_absent",
      "nav_footer_null",
      "nav_footer_empty",
      "nav_footer_absent",
      "announcement_set",
      "announcement_empty",
      "home_sections_empty",
      "home_sections_no_ids",
      "page_sections_no_ids",
      "page_sections_no_kind",
      "code_default_pages_default",
      "code_default_pages_beastlife",
      "policies_as_cms_pages",
      "journal_family",
      "agency_home_sections_v2",
      "highlight_unmatched",
      "hero_experiment_running",
      "ai_proposal_payload",
      "agency_kit_payload",
      "home_hero_only",
      "home_sections_only",
      "home_both_custom",
      "home_both_default",
    ],
  },
  "entity fixtures": {
    map: ENTITY_FIXTURES,
    names: [
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
      "redirect_to_code_default_page",
      "redirect_to_nothing",
      "cms_templates_two_families",
      "cms_approvals",
      "agency_grant",
    ],
  },
  "re-run fixtures": { map: RERUN_FIXTURES, names: ["phase3_leftovers", "stale_backfill"] },
};
// Every required name is checked by a case below; this set records which ran.
const checked = new Set();
const mark = (...names) => names.forEach((n) => checked.add(n));

installHooks({ headers: "real" });
const world = await openWorld({ prefix: ".test-lfx" });
const { libsql } = await import("../lib/db.js");
const { withTenant } = await import("../lib/tenant-context.js");
const Res = await import("../lib/content/resolve.js");
const R = await import("../lib/releases.js");
const { sanitizeHtml } = await import("../lib/sanitize.js");
const Ids = await import("../lib/documents/ids.js");
const Reg = await import("../lib/registry/index.js");
const { PAGES: CODE_PAGES } = await import("../lib/content/pages.js");
const { DEFAULT_HOME_SECTIONS } = await import("../lib/cms/defaults.js");

const rows = (db, sql, args = []) => db.run(async () => (await libsql.execute({ sql, args })).rows.map((r) => ({ ...r })));
const block = async (db, key) => {
  const r = await rows(db, "SELECT value FROM cms_blocks WHERE key = ?", [key]);
  return r.length ? { value: JSON.parse(r[0].value) } : null;
};
const liveContent = async (db) => {
  const s = await db.run(() => R.getLiveReleaseState());
  return s.state === "live" ? s.release.content : null;
};
let seq = 0;
const tenant = (opts = {}) => makeLegacyTenant(world, { id: opts.id ?? `lfx-${++seq}`, set: "vgate", ...opts, file: opts.file ?? `t${++seq}` });
// Every entity fixture an ordinary tenant can hold (redirect_to_code_default_page
// needs BeastLife or the env store; it has its own case in part 7).
const ORDINARY_ENTITIES = Object.keys(ENTITY_FIXTURES).filter((e) => !ENTITY_FIXTURES[e].requires);

try {
  // ====================================================================================
  console.log("— 1. builders refuse anything but a local file database");
  // ====================================================================================
  await t("buildLegacyTenant, recordOutputs, putLiveRelease, the re-run builders and startHeroExperiment refuse libsql://, https:// and a sqld URL before running anything", async () => {
    let ran = 0;
    const run = async (fn) => {
      ran++;
      return fn();
    };
    for (const url of ["libsql://shop-x.turso.io", "https://shop-x.turso.io", "http://127.0.0.1:7140", "ws://127.0.0.1:7141", "file://remote-host/x.db", ".test-bare.db"]) {
      const handles = [
        { id: "x", url, run },
        { id: "x", tenant: { id: "x", dbUrl: url }, run },
        { id: "x", url: "file:.test-lfx-fine.db", tenant: { id: "x", dbUrl: url }, run },
      ];
      for (const db of handles) {
        await rejects(() => buildLegacyTenant(db, { state: "live_v1" }), /only local file: databases/, `buildLegacyTenant ${url}`);
        await rejects(() => recordOutputs(db), /only local file: databases/, `recordOutputs ${url}`);
        await rejects(() => putLiveRelease(db, "rel_x", { v: 3 }), /only local file: databases/, `putLiveRelease ${url}`);
        await rejects(() => buildPhase3Leftovers(db), /only local file: databases/, `buildPhase3Leftovers ${url}`);
        await rejects(() => buildStaleBackfill(db), /only local file: databases/, `buildStaleBackfill ${url}`);
        await rejects(() => startHeroExperiment(db), /only local file: databases/, `startHeroExperiment ${url}`);
      }
    }
    eq(ran, 0, "a refused handle's run(fn) was called:");
    await rejects(() => openWorld({ prefix: "libsql://x" }), /prefix/, "openWorld with a URL prefix");
    await rejects(() => buildLegacyTenant({ id: "x", url: "file:.test-lfx-x.db" }), /run\(fn\)/, "a handle with no run");
  });

  // ====================================================================================
  console.log("— 2. every required builder exists");
  // ====================================================================================
  await t("every 8.11 state row, mapping trap, entity fixture and re-run fixture of the brief has a named builder with a plain description", () => {
    const missing = [];
    for (const [group, { map, names }] of Object.entries(REQUIRED)) {
      for (const n of names) {
        const b = map[n];
        const callable = b && (typeof b.apply === "function" || typeof b.build === "function" || group === "8.11 state rows");
        if (!b || !callable || typeof b.describe !== "string" || b.describe.length < 12) missing.push(`${group}: ${n}`);
      }
    }
    eq(missing.join("; "), "", "builders missing:");
    // nothing unnamed: every builder exported is one the brief asks for
    for (const [group, { map, names }] of Object.entries(REQUIRED)) same(Object.keys(map).sort(), [...names].sort(), `${group}:`);
  });

  // ====================================================================================
  console.log("— 3. the a6d028e baselines");
  // ====================================================================================
  const baselineRel = JSON.parse(await readFile(join(here, "fixtures/legacy-release-outputs.a6d028e.json"), "utf8"));
  const inProcess = {};
  await t("live_v1, live_v2 and live_v3 (with their drafts) plus recordOutputs reproduce legacy-release-outputs.a6d028e.json, release.v aside", async () => {
    for (const v of [1, 2, 3]) {
      const { db } = await makeLegacyTenant(world, { set: "vgate", file: `vgl-v${v}`, state: `live_v${v}` });
      const rec = await recordOutputs(db, { routes: LEGACY_RELEASE_ROUTES });
      inProcess[`v${v}`] = JSON.parse(JSON.stringify(rec));
      const rel = rec.getLiveReleaseState?.ok?.release;
      ok(rel, `v${v}: not live: ${JSON.stringify(rec.getLiveReleaseState)}`);
      eq(rel.v, v, `v${v} release.v (the one P2-VGATE addition):`);
      delete rel.v;
      const want = baselineRel.fixtures[`v${v}`];
      same(Object.keys(rec), Object.keys(want), `v${v} keys:`);
      for (const k of Object.keys(want)) same(rec[k], want[k], `v${v} ${k}:`);
    }
    mark("live_v1", "live_v2", "live_v3");
  });

  const run = (file, env = {}) => {
    const out = join(ROOT, `.test-lfx-out-${file}.json`);
    const r = spawnSync(process.execPath, [join(here, "support", `${file}.js`), out], { cwd: ROOT, encoding: "utf8", timeout: 90_000, env: { ...process.env, ...env } });
    return { r, out };
  };
  await t("legacy-release-outputs.js (now a wrapper) matches the baseline and, byte for byte, the in-process builders", async () => {
    const { r, out } = run("legacy-release-outputs");
    try {
      eq(r.status, 0, `recorder failed: ${r.stderr?.slice(-600)}`);
      const now = JSON.parse(await readFile(out, "utf8"));
      same(Object.keys(now.fixtures), ["v1", "v2", "v3"], "fixtures:");
      for (const [name, rec] of Object.entries(now.fixtures)) {
        same(rec, inProcess[name], `${name}: the recorder and the in-process builders differ`);
        const copy = JSON.parse(JSON.stringify(rec));
        delete copy.getLiveReleaseState.ok.release.v;
        same(copy, baselineRel.fixtures[name], `${name} against a6d028e:`);
      }
    } finally {
      await rm(out, { force: true });
    }
  });

  await t("home-render-outputs.js (now a wrapper) equals home-render-outputs.a6d028e.json in every state (data-section-* taken out, as test:sections-render does)", async () => {
    const { r, out } = run("home-render-outputs", { HOME_RENDER_DB_PREFIX: ".test-lfx-home" });
    try {
      eq(r.status, 0, `recorder failed: ${r.stderr?.slice(-600)}`);
      const now = JSON.parse(await readFile(out, "utf8"));
      const then = JSON.parse(await readFile(join(here, "fixtures/home-render-outputs.a6d028e.json"), "utf8"));
      const normalize = (h) => h.replace(/ data-section-(?:id|kind)="[^"]*"/g, "");
      same(Object.keys(now.states), Object.keys(then.states), "states:");
      for (const s of Object.keys(then.states)) {
        eq(normalize(now.states[s].home), then.states[s].home, `${s} home:`);
        same(Object.keys(now.states[s].pages), Object.keys(then.states[s].pages), `${s} pages:`);
        for (const p of Object.keys(then.states[s].pages)) eq(normalize(now.states[s].pages[p]), then.states[s].pages[p], `${s} page ${p}:`);
      }
    } finally {
      await rm(out, { force: true });
    }
  });

  await t("legacy-journal-outputs.js (now a wrapper) equals legacy-journal-outputs.a6d028e.json exactly", async () => {
    const { r, out } = run("legacy-journal-outputs");
    try {
      eq(r.status, 0, `recorder failed: ${r.stderr?.slice(-600)}`);
      const now = await readFile(out, "utf8");
      const then = await readFile(join(here, "fixtures/legacy-journal-outputs.a6d028e.json"), "utf8");
      eq(now, then, "the journal output is not byte-identical to the baseline:");
    } finally {
      await rm(out, { force: true });
    }
  });

  await t("the recorders leave no database files behind", async () => {
    const left = (await readdir(ROOT)).filter((f) => /^\.test-(vgate-legacy|journal-legacy|lfx-home)-/.test(f));
    same(left, [], "left behind:");
  });

  // ====================================================================================
  console.log("— 4. recordOutputs");
  // ====================================================================================
  await t("allGetterRoutes calls every exported resolved* getter of lib/content/resolve.js; recordOutputs records each and refuses an unknown one", async () => {
    const names = await resolvedGetterNames();
    for (const n of ["resolvedHomePage", "resolvedJournalEntries", ...LEGACY_RELEASE_ROUTES.map(([fn]) => fn)]) ok(names.includes(n), `${n} not enumerated`);
    const routes = await allGetterRoutes();
    for (const n of names) ok(routes.some(([fn]) => fn === n), `${n} is not recorded`);
    for (const [fn, args] of LEGACY_RELEASE_ROUTES) ok(routes.some(([f, a]) => f === fn && JSON.stringify(a) === JSON.stringify(args)), `${routeKey(fn, args)} dropped`);
    const { db } = await tenant({ state: "live_v3", entities: ORDINARY_ENTITIES });
    const rec = await recordOutputs(db);
    for (const [fn, args] of routes) ok(Object.hasOwn(rec, routeKey(fn, args)), `${routeKey(fn, args)} missing`);
    ok(rec.getLiveReleaseState.ok.release.v === 3 && rec.contentSource.ok.mode === "live", "state not recorded");
    // another source's getters (P4-SEAM's contentGettersFor) can be recorded the same way
    const fake = await recordOutputs(db, { routes: [["resolvedHero", []]], getters: { resolvedHero: async () => ({ title: "other source" }) }, state: false });
    same(fake, { "resolvedHero()": { ok: { title: "other source" } } }, "injected getters:");
    await rejects(() => recordOutputs(db, { routes: [["resolvedNothing", []]] }), /no getter "resolvedNothing"/, "unknown getter");
  });

  // ====================================================================================
  console.log("— 5. the 8.11 state rows");
  // ====================================================================================
  await t("live_v1 keeps its overrides, pins, placements and redirects in the live tables, which the v1 read uses", async () => {
    const { db, manifest } = await tenant({ state: "live_v1" });
    eq(manifest.releases.live, "rel_fixture_v1", "live release:");
    eq((await liveContent(db)).v, 1, "v:");
    eq((await rows(db, "SELECT badge FROM product_overrides WHERE product_id = ?", [P(1)]))[0]?.badge, "TABLE", "override:");
    eq((await rows(db, "SELECT pinned FROM collection_overrides WHERE collection_id = ?", [COL(2)]))[0]?.pinned, JSON.stringify([P(2)]), "pins:");
    eq((await rows(db, "SELECT COUNT(*) AS n FROM placements"))[0].n, 2, "placements:");
    eq((await rows(db, "SELECT to_slug FROM page_redirects WHERE from_slug = 'old-post'"))[0]?.to_slug, "table-post", "redirect:");
    eq((await db.run(() => Res.resolvedProductOverride(P(1))))?.badge, "TABLE", "the v1 read of the live table:");
    eq((await db.run(() => Res.resolvedSlugRedirect("old-post"))), "table-post", "the v1 redirect read:");
  });

  await t("live_v2 and live_v3 put their envelopes live with drafts that differ (an unpublished change)", async () => {
    for (const v of [2, 3]) {
      const { db } = await tenant({ state: `live_v${v}` });
      eq((await liveContent(db)).v, v, `v${v}:`);
      eq((await block(db, "hero")).value.title, "Draft hero", `v${v} draft hero:`);
      eq((await db.run(() => Res.resolvedHero())).title, `Live hero v${v}`, `v${v} live hero:`);
    }
  });

  await t("no_release_open and no_release_not_launched: no release, drafts in place, and the operator flag the cutover needs", async () => {
    for (const [state, flag] of [
      ["no_release_open", "--store-open"],
      ["no_release_not_launched", "--not-launched"],
    ]) {
      const { db, manifest } = await tenant({ state });
      eq(manifest.flag, flag, `${state} flag:`);
      eq((await db.run(() => R.getLiveReleaseState())).state, "none", `${state} live state:`);
      eq((await db.run(() => Res.resolvedHero())).title, "Draft hero", `${state}: shoppers see the drafts:`);
      eq((await rows(db, "SELECT COUNT(*) AS n FROM releases"))[0].n, 0, `${state} releases:`);
      mark(state);
    }
  });

  await t("pending_schedule: live on v3 with one scheduled release still waiting", async () => {
    const { db, manifest } = await tenant({ state: "pending_schedule" });
    eq((await liveContent(db)).v, 3, "live:");
    const s = await rows(db, "SELECT id FROM releases WHERE scheduled_for IS NOT NULL AND published_at IS NULL");
    same(s.map((r) => r.id), [manifest.releases.scheduled], "scheduled:");
    mark("pending_schedule");
  });

  await t("live_read_error: the live read is in error, and contentSource fails closed", async () => {
    const { db } = await tenant({ state: "live_read_error" });
    const s = await db.run(() => R.getLiveReleaseState());
    eq(s.state, "error", "state:");
    ok(/no envelope version/.test(s.error), s.error);
    await rejects(() => db.run(() => Res.contentSource()), null, "contentSource");
    mark("live_read_error");
  });

  // ====================================================================================
  console.log("— 6. the mapping traps");
  // ====================================================================================
  await t("nav null, [] and absent, header and footer, kept apart in the drafts and the live release", async () => {
    const cases = [
      [["nav_header_null", "nav_footer_empty"], { nav_header: null, nav_footer: [] }],
      [["nav_header_empty", "nav_footer_absent"], { nav_header: [], nav_footer: undefined }],
      [["nav_header_absent", "nav_footer_null"], { nav_header: undefined, nav_footer: null }],
    ];
    for (const [traps, want] of cases) {
      const { db } = await tenant({ state: "live_v3", traps });
      const live = await liveContent(db);
      for (const [key, value] of Object.entries(want)) {
        const draft = await block(db, key);
        if (value === undefined) {
          eq(draft, null, `${traps} draft ${key} row:`);
          ok(!Object.hasOwn(live.blocks, key), `${traps}: live ${key} should be absent`);
        } else {
          same(draft?.value, value, `${traps} draft ${key}:`);
          same(live.blocks[key], value, `${traps} live ${key}:`);
        }
      }
      mark(...traps);
    }
  });

  await t("announcement set and empty", async () => {
    const a = await tenant({ state: "live_v3", traps: ["announcement_set"] });
    same((await block(a.db, "announcement")).value, { enabled: true, text: "Free shipping over ₹999", href: "/collections" }, "set:");
    eq((await a.db.run(() => Res.resolvedAnnouncement())).enabled, true, "live set:");
    const b = await tenant({ state: "live_v3", traps: ["announcement_empty"] });
    same((await block(b.db, "announcement")).value, { enabled: false, text: "", href: "" }, "empty row:");
    same((await liveContent(b.db)).blocks.announcement, { enabled: false, text: "", href: "" }, "empty live:");
    mark("announcement_set", "announcement_empty");
  });

  await t("home_sections stored as [] reads as the default sections today", async () => {
    const { db } = await tenant({ state: "no_release_open", traps: ["home_sections_empty"] });
    same((await block(db, "home_sections")).value, [], "row:");
    const shown = await db.run(() => Res.resolvedHomeSections());
    same(shown.map((s) => s.id), DEFAULT_HOME_SECTIONS.map((s) => s.id), "shown:");
    mark("home_sections_empty");
  });

  await t("home and page sections with no ids, and page sections with no kind", async () => {
    const { db } = await tenant({ state: "live_v3", traps: ["home_sections_no_ids", "page_sections_no_ids", "page_sections_no_kind"] });
    const home = (await block(db, "home_sections")).value;
    ok(home.length === 3 && home.every((s) => !("id" in s)), `draft home sections: ${JSON.stringify(home)}`);
    ok((await liveContent(db)).blocks.home_sections.every((s) => !("id" in s)), "live home sections have ids");
    const page = await db.run(() => Res.resolvedHomePage());
    same(page.slice(1).map((s) => s.legacyKey), ["i-0", "i-1", "i-2"], "home read keys:");
    const [noIds] = await rows(db, "SELECT sections FROM cms_pages WHERE slug = 'no-ids'");
    ok(JSON.parse(noIds.sections).every((s) => s.kind && !("id" in s)), noIds.sections);
    const [noKind] = await rows(db, "SELECT sections FROM cms_pages WHERE slug = 'no-kind'");
    ok(JSON.parse(noKind.sections).every((s) => !("kind" in s) && !("id" in s)), noKind.sections);
    const live = await db.run(() => Res.resolvedContentPage("no-kind"));
    same(live.sections.map((s) => s.kind), ["text", "text"], "no-kind reads as text:");
    mark("home_sections_no_ids", "page_sections_no_ids", "page_sections_no_kind");
  });

  await t("code-default pages keep rendering on the env store (_default) and on a BeastLife tenant, and need that store", async () => {
    const def = await world.defaultStore();
    await buildLegacyTenant(def, { state: "no_release_open", traps: ["code_default_pages_default"] });
    const bl = await tenant({ id: "beastlife", state: "no_release_open", traps: ["code_default_pages_beastlife"] });
    for (const db of [def, bl.db]) {
      eq((await rows(db, "SELECT COUNT(*) AS n FROM cms_pages WHERE slug IN ('contact','shipping','returns','terms','privacy')"))[0].n, 0, `${db.id} rows:`);
      eq((await db.run(() => Res.resolvedContentPage("terms")))?.title, CODE_PAGES.terms.title, `${db.id} terms:`);
      eq((await db.run(() => Res.resolvedContentPage("about")))?.title, "About (our own words)", `${db.id} about override:`);
    }
    await rejects(() => tenant({ state: "no_release_open", traps: ["code_default_pages_beastlife"] }), /tenant id "beastlife"/, "a non-BeastLife tenant");
    await rejects(() => tenant({ state: "no_release_open", traps: ["code_default_pages_default"] }), /env store/, "a tenant for _default");
    mark("code_default_pages_default", "code_default_pages_beastlife");
  });

  await t("policies as cms_pages, and journal family posts with the /journal index they make", async () => {
    const { db } = await tenant({ state: "live_v3", traps: ["policies_as_cms_pages", "journal_family"] });
    eq((await rows(db, "SELECT COUNT(*) AS n FROM cms_pages WHERE slug IN ('shipping','returns','terms','privacy')"))[0].n, 4, "policy rows:");
    eq((await db.run(() => Res.resolvedContentPage("returns")))?.title, "Returns policy", "live returns:");
    eq((await rows(db, "SELECT COUNT(*) AS n FROM cms_pages WHERE family = 'journal'"))[0].n, 5, "journal rows:");
    const entries = await db.run(() => Res.resolvedJournalEntries());
    same(entries.map((e) => e.slug).sort(), ["journal-first", "journal-undated"], "the index shows:");
    mark("policies_as_cms_pages", "journal_family");
  });

  await t("agency home sections without ids, stamped into a v2 release (and refused with another version)", async () => {
    const { db } = await tenant({ state: "live_v2", traps: ["agency_home_sections_v2"] });
    const live = await liveContent(db);
    eq(live.v, 2, "v:");
    same(live.blocks.home_sections, AGENCY_KIT_PAYLOAD.home_sections, "live:");
    same((await block(db, "home_sections")).value, AGENCY_KIT_PAYLOAD.home_sections, "draft:");
    await rejects(() => tenant({ state: "live_v3", traps: ["agency_home_sections_v2"] }), /live_v2/, "with v3");
    mark("agency_home_sections_v2");
  });

  await t("an unmatched highlight, a running hero experiment, AI proposals and an agency kit in their old shapes", async () => {
    const { db } = await tenant({ state: "live_v3", traps: ["highlight_unmatched", "hero_experiment_running", "ai_proposal_payload", "agency_kit_payload"] });
    const hero = await db.run(() => Res.resolvedHero());
    ok(!hero.title.includes(hero.highlight), `highlight "${hero.highlight}" is in "${hero.title}"`);
    const [exp] = await rows(db, "SELECT status, variants FROM experiments WHERE slug = ?", [HERO_EXPERIMENT.slug]);
    eq(exp?.status, "running", "experiment:");
    const payload = JSON.parse(exp.variants).find((v) => v.key === "b").payload;
    const want = HERO_EXPERIMENT.variants[1].payload;
    same([payload.title, payload.highlight, payload.primary], [want.title, want.highlight, want.primary], "variant payload (the old hero shape):");
    const [ins] = await rows(db, "SELECT proposals FROM ai_insights");
    same(JSON.parse(ins.proposals), AI_PROPOSALS, "proposals:");
    const kit = (await world.control.platformDb().execute("SELECT payload FROM agency_kits WHERE id = 'akit_fixture01'")).rows[0];
    same(JSON.parse(kit.payload), AGENCY_KIT_PAYLOAD, "kit:");
    mark("highlight_unmatched", "hero_experiment_running", "ai_proposal_payload", "agency_kit_payload");
  });

  await t("each doc_home combination: hero only, sections only (default title follows the store name), both, neither", async () => {
    const a = await tenant({ state: "live_v3", traps: ["home_hero_only"] });
    eq(await block(a.db, "home_sections"), null, "hero only: sections row");
    ok(!Object.hasOwn((await liveContent(a.db)).blocks, "home_sections"), "hero only: live sections present");
    same((await a.db.run(() => Res.resolvedHomeSections())).map((s) => s.id), DEFAULT_HOME_SECTIONS.map((s) => s.id), "hero only: default sections shown:");
    eq((await a.db.run(() => Res.resolvedHero())).title, "Made for the morning", "hero only: hero:");

    const b = await tenant({ state: "live_v3", traps: ["home_sections_only"] });
    eq(await block(b.db, "hero"), null, "sections only: hero row");
    ok(!Object.hasOwn((await liveContent(b.db)).blocks, "hero"), "sections only: live hero present");
    eq((await b.db.run(() => Res.resolvedHero())).title, "Shop Legacy Outputs.", "sections only: default title:");
    // {store_name}: the default title follows Settings
    const renamed = { ...b.db.tenant, config: { ...b.db.tenant.config, site: { name: "Renamed Shop" } } };
    eq((await withTenant(renamed, () => Res.resolvedHero())).title, "Shop Renamed Shop.", "sections only: after a rename:");
    same((await b.db.run(() => Res.resolvedHomeSections())).map((s) => s.id), ["sec_cust01", "sec_cust02"], "sections only: sections:");

    const c = await tenant({ state: "live_v3", traps: ["home_both_custom"] });
    ok((await block(c.db, "hero")) && (await block(c.db, "home_sections")), "both: rows");
    const d = await tenant({ state: "live_v3", traps: ["home_both_default"] });
    ok(!(await block(d.db, "hero")) && !(await block(d.db, "home_sections")), "neither: rows");
    eq((await d.db.run(() => Res.resolvedHero())).title, "Shop Legacy Outputs.", "neither: title:");
    mark("home_hero_only", "home_sections_only", "home_both_custom", "home_both_default");
  });

  // ====================================================================================
  console.log("— 7. the entity fixtures");
  // ====================================================================================
  const ALL_ENTITIES = ORDINARY_ENTITIES;
  await t("on live_v3 every entity lands in the live tables AND in the release's frozen arrays", async () => {
    const { db } = await tenant({ id: "lfx-ent3", state: "live_v3", entities: ALL_ENTITIES });
    const ov = Object.fromEntries((await rows(db, "SELECT product_id, modules, badge FROM product_overrides")).map((r) => [r.product_id, { modules: JSON.parse(r.modules), badge: r.badge }]));
    eq(ov[P(201)].modules.length, 2, "modules+badge:");
    eq(ov[P(201)].badge, "Lab tested", "badge:");
    eq(ov[P(202)].modules.length, 6, "six modules:");
    eq(ov[P(203)].modules[0].html.length, 10000, "long module length:");
    const dirty = ov[P(204)].modules[0].html;
    ok(sanitizeHtml(dirty) !== dirty, "today's sanitizer leaves the old module HTML as it is");
    const pl = Object.fromEntries((await rows(db, "SELECT * FROM placements")).map((r) => [r.id, r]));
    eq(pl.pl_fx_pairs_title.title, "Pairs well with", "custom pairs title:");
    eq(pl.pl_fx_pairs_default.title, null, "default pairs title:");
    eq(pl.pl_fx_pairs_off.enabled, 0, "disabled pairs:");
    same([pl.pl_fx_pairs_a, pl.pl_fx_pairs_b].map((r) => [r.source_product_id, r.position]), [[P(217), 0], [P(217), 1]], "two on one source:");
    same([pl.pl_fx_cart.kind, pl.pl_fx_cart.source_product_id, pl.pl_fx_cart.title, pl.pl_fx_cart.position], ["cart_upsell", null, "Add to your order", 2], "cart upsell:");
    eq((await rows(db, "SELECT pinned FROM collection_overrides WHERE collection_id = ?", [COL(230)]))[0]?.pinned, JSON.stringify([P(232), P(230)]), "pins:");
    const st = (await block(db, "surface_templates")).value;
    same([st.products?.[P(240)], st.collections?.[COL(241)]], ["editorial", "sidebar"], "template maps:");
    const rd = Object.fromEntries((await rows(db, "SELECT from_slug, to_slug FROM page_redirects")).map((r) => [r.from_slug, r.to_slug]));
    same([rd["old-about"], rd["old-post-address"], rd["old-terms"], rd["old-gone"]], ["redirect-page", "redirect-post", undefined, "gone-forever"], "redirects:");
    const fam = Object.fromEntries((await rows(db, "SELECT slug, family FROM cms_pages WHERE slug IN ('redirect-page','redirect-post','terms','gone-forever')")).map((r) => [r.slug, r.family]));
    same(fam, { "redirect-page": "page", "redirect-post": "journal" }, "redirect targets:");
    same((await rows(db, "SELECT family FROM cms_templates ORDER BY family")).map((r) => r.family), ["journal", "page"], "templates:");
    eq((await rows(db, "SELECT COUNT(*) AS n FROM cms_approvals"))[0].n, 2, "approvals:");
    const grant = (await world.control.platformDb().execute({ sql: "SELECT status, role FROM agency_grants WHERE tenant_id = ?", args: ["lfx-ent3"] })).rows[0];
    same([grant?.status, grant?.role], ["accepted", "staff"], "agency grant:");

    const live = await liveContent(db);
    for (const pid of [201, 202, 203, 204]) ok(live.product_overrides.some((o) => o.product_id === P(pid)), `frozen override ${pid}`);
    for (const id of ["pl_fx_pairs_title", "pl_fx_pairs_default", "pl_fx_pairs_off", "pl_fx_pairs_a", "pl_fx_pairs_b", "pl_fx_cart"]) ok(live.placements.some((p) => p.id === id), `frozen ${id}`);
    ok(live.collection_pins.some((c) => c.collection_id === COL(230)), "frozen pins");
    same(live.redirects.map((r) => r.from_slug).sort(), ["old-about", "old-gone", "old-post-address"], "frozen redirects:");
    same([live.blocks.surface_templates.products[P(240)], live.blocks.surface_templates.collections[COL(241)]], ["editorial", "sidebar"], "frozen template maps:");
    // shoppers on the live release see the frozen rows
    eq((await db.run(() => Res.resolvedProductOverride(P(201))))?.badge, "Lab tested", "live override:");
    eq((await db.run(() => Res.resolvedSurfaceTemplateFor("pdp", P(240))))?.template, "editorial", "live template:");
    eq(await db.run(() => Res.resolvedSlugRedirect("old-gone")), "gone-forever", "live redirect:");
    mark(...ALL_ENTITIES);
  });

  await t("redirect_to_code_default_page on BeastLife: the old address redirects to the terms page, which renders with no row of its own; an ordinary tenant is refused", async () => {
    for (const state of ["live_v3", "live_v1"]) {
      const { db } = await tenant({ id: "beastlife", state, entities: ["redirect_to_code_default_page"] });
      eq((await rows(db, "SELECT to_slug FROM page_redirects WHERE from_slug = 'old-terms'"))[0]?.to_slug, "terms", `${state} redirect row:`);
      eq((await rows(db, "SELECT COUNT(*) AS n FROM cms_pages WHERE slug = 'terms'"))[0].n, 0, `${state}: a terms row:`);
      const to = await db.run(() => Res.resolvedSlugRedirect("old-terms"));
      eq(to, "terms", `${state} the live redirect:`);
      const page = await db.run(() => Res.resolvedContentPage(to));
      eq(page?.title, CODE_PAGES.terms.title, `${state}: the redirect target renders:`);
      ok(Array.isArray(page?.sections) && page.sections.length > 0, `${state}: the terms page has no sections`);
      if (state === "live_v3") ok((await liveContent(db)).redirects.some((r) => r.from_slug === "old-terms" && r.to_slug === "terms"), "frozen in v3");
    }
    // an ordinary tenant: the target would not render, so the fixture refuses
    await rejects(() => tenant({ state: "live_v3", entities: ["redirect_to_code_default_page"] }), /needs the env store .*"beastlife"/, "an ordinary tenant");
    // why: on an ordinary tenant the terms slug resolves to nothing
    const plain = await tenant({ state: "live_v3", entities: ["redirect_to_nothing"] });
    eq(await plain.db.run(() => Res.resolvedContentPage("terms")), null, "terms on an ordinary tenant:");
    mark("redirect_to_code_default_page");
  });

  await t("buildLegacyTenant refuses a second build on the same database, in plain words, before writing anything", async () => {
    const { db } = await tenant({ state: "live_v3", entities: ["cart_upsell"] });
    const count = async () => (await rows(db, "SELECT (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM releases) + (SELECT COUNT(*) FROM placements) AS n"))[0].n;
    const before = await count();
    await rejects(() => buildLegacyTenant(db, { state: "live_v3" }), /already holds a store's catalog or content, so it was built before\. Each database can be built only once/, "a second build");
    await rejects(() => buildLegacyTenant(db, { state: "no_release_open", set: "empty" }), /built before/, "a second build of another set");
    eq(await count(), before, "the refused build wrote:");
  });

  await t("on live_v1 the entities stay in the live tables only (v1 never froze them), and the v1 read uses them", async () => {
    const { db } = await tenant({ state: "live_v1", entities: ORDINARY_ENTITIES });
    const live = await liveContent(db);
    // v1 froze no entity arrays: they stay out of the envelope (blocks and pages,
    // which v1 does freeze, carry the template maps and redirect targets)
    for (const k of ["product_overrides", "collection_pins", "placements", "redirects"]) ok(!Object.hasOwn(live, k), `the v1 envelope gained ${k}`);
    same(Object.keys(live).sort(), Object.keys(CONTENT_SETS.vgate.releases.v1).sort(), "v1 envelope keys:");
    eq((await db.run(() => Res.resolvedProductOverride(P(202))))?.modules?.length, 6, "v1 override read:");
    eq(await db.run(() => Res.resolvedSlugRedirect("old-gone")), "gone-forever", "v1 redirect read:");
    const pairs = await db.run(() => Res.resolvedPdpPairs(P(210)));
    ok(JSON.stringify(pairs).includes("Pairs well with"), `v1 pairs: ${JSON.stringify(pairs).slice(0, 200)}`);
  });

  await t("the agency fixtures need a world tenant (they write the control plane)", async () => {
    const { db } = await tenant({ state: "no_release_open" });
    const bare = { id: db.id, url: db.url, run: db.run };
    const before = (await rows(db, "SELECT COUNT(*) AS n FROM products"))[0].n;
    await rejects(() => buildLegacyTenant(bare, { entities: ["agency_grant"] }), /registered by openWorld/, "a bare handle (grant)");
    await rejects(() => buildLegacyTenant(bare, { traps: ["agency_kit_payload"] }), /registered by openWorld/, "a bare handle (kit)");
    eq((await rows(db, "SELECT COUNT(*) AS n FROM products"))[0].n, before, "refused, yet it wrote:");
  });

  // ====================================================================================
  console.log("— 8. the re-run fixtures");
  // ====================================================================================
  await t("buildPhase3Leftovers: a random-id product content row for a product, and a page document holding a legacy page's slug", async () => {
    const { db } = await tenant({ state: "live_v3" });
    const out = await buildPhase3Leftovers(db);
    const [pc] = await rows(db, "SELECT id, type, entity_id, draft FROM documents WHERE type = 'product_content'");
    eq(pc.id, out.productDocumentId, "id:");
    ok(/^doc_[a-z2-7]{16}$/.test(pc.id), `not a phase-3 random id: ${pc.id}`);
    ok(pc.id !== (await Ids.productDocumentId(P(1))), "a deterministic id");
    eq(pc.entity_id, P(1), "product:");
    ok(Reg.validateDocument(JSON.parse(pc.draft), { mode: "draft" }).ok, "the product body does not validate");
    const [pg] = await rows(db, "SELECT id, slug FROM documents WHERE type = 'page'");
    eq(pg.slug, "about", "slug:");
    ok(pg.id !== (await Ids.backfillRouteId("page", "about")), "the colliding page has the backfill id");
    eq((await rows(db, "SELECT COUNT(*) AS n FROM cms_pages WHERE slug = 'about'"))[0].n, 1, "the legacy page:");
    eq((await rows(db, "SELECT COUNT(*) AS n FROM document_versions"))[0].n, 2, "versions:");
    eq((await rows(db, "SELECT mode FROM cms_state"))[0].mode, "legacy", "mode:");
    mark("phase3_leftovers");
  });

  await t("buildStaleBackfill: documents and live rows of an aborted run, then newer legacy edits", async () => {
    const { db } = await tenant({ state: "live_v3" });
    const out = await buildStaleBackfill(db);
    const docs = Object.fromEntries((await rows(db, "SELECT id, type, draft, updated_at, published_version_id FROM documents")).map((r) => [r.id, r]));
    same(Object.keys(docs).sort(), [out.ids.about, out.ids.home, out.ids.product, out.ids.collection].sort(), "documents:");
    ok(/^doc_coll_[0-9a-f]{16}$/.test(out.ids.collection), `collection document id: ${out.ids.collection}`);
    for (const d of Object.values(docs)) {
      // the collection body comes from the registry once collection_content is registered (P4-LIVEROW)
      if (d.type !== "collection_content" || out.collectionBody === "registry") ok(Reg.validateDocument(JSON.parse(d.draft), { mode: "draft" }).ok, `${d.id} does not validate`);
      eq(d.published_version_id, null, `${d.id} published:`);
    }
    eq(docs[out.ids.collection].type, "collection_content", "collection document type:");
    // every live row names a real version, in the service's ver_<16 hex> shape
    for (const k of ["home", "about", "product", "collection"]) ok(/^ver_[0-9a-f]{16}$/.test(out.versions[k]), `${k} version id: ${out.versions[k]}`);
    const vrows = Object.fromEntries((await rows(db, "SELECT id, document_id, kind, body FROM document_versions")).map((r) => [r.id, r]));
    eq(vrows[out.versions.collection]?.document_id, out.ids.collection, "the collection row's version:");
    // the product version holds the older modules the live row holds
    const pv = JSON.parse(vrows[out.versions.product].body);
    same(pv.sections.map((x) => [x.kind, x.settings.title, x.settings.html]), out.older.modules.map((m) => ["rich_text", m.title, m.html]), "the product version's modules:");
    same(out.liveRowOnly, out.collectionBody === "registry" ? ["product badge", "product pairs"] : ["product badge", "product pairs", "collection pins"], "live-row-only fields:");
    ok(JSON.stringify(JSON.parse(docs.doc_home.draft)).includes("Older hero"), "the old home draft");
    eq(JSON.parse(docs[out.ids.about].draft).meta.title, "About (older)", "the old about draft:");
    eq((await block(db, "hero")).value.title, "Newer hero", "the newer legacy hero:");
    eq((await rows(db, "SELECT title FROM cms_pages WHERE slug = 'about'"))[0].title, "About (newer)", "the newer legacy about:");
    const [live] = await rows(db, "SELECT document_id, version_id, badge FROM product_content_live WHERE product_id = ?", [P(1)]);
    same([live.document_id, live.version_id, live.badge], [out.ids.product, out.versions.product, "OLDER"], "stale live row:");
    const [clive] = await rows(db, "SELECT document_id, version_id FROM collection_content_live WHERE collection_id = ?", [COL(2)]);
    same([clive.document_id, clive.version_id], [out.ids.collection, out.versions.collection], "stale collection live row:");
    eq((await rows(db, "SELECT badge FROM product_overrides WHERE product_id = ?", [P(1)]))[0].badge, "NEWER", "newer override:");
    eq((await rows(db, "SELECT pinned FROM collection_content_live WHERE collection_id = ?", [COL(2)]))[0].pinned, JSON.stringify([P(1)]), "stale pins:");
    eq((await rows(db, "SELECT pinned FROM collection_overrides WHERE collection_id = ?", [COL(2)]))[0].pinned, JSON.stringify([P(2), P(1)]), "newer pins:");
    const [runRow] = await rows(db, "SELECT kind, step, outcome FROM cms_migration_runs");
    same([runRow.kind, runRow.step, runRow.outcome], ["cutover", "backfill", "aborted"], "run:");
    eq((await rows(db, "SELECT mode FROM cms_state"))[0].mode, "legacy", "mode:");
    ok(out.editedAt > out.abortedAt, "edits are not newer");
    eq((await rows(db, "SELECT kind FROM document_versions GROUP BY kind"))[0].kind, "migrated", "version kind:");
    // shoppers still read the legacy store
    eq((await db.run(() => Res.resolvedHero())).title, "Live hero v3", "shoppers:");
    mark("stale_backfill");
  });

  // ====================================================================================
  console.log("— 9. every required builder was checked");
  // ====================================================================================
  await t("every required builder ran in a case above", () => {
    const unchecked = Object.values(REQUIRED).flatMap(({ names }) => names.filter((n) => !checked.has(n)));
    same(unchecked, [], "never checked:");
  });
} finally {
  await world.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
