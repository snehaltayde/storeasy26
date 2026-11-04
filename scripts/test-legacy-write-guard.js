// P4-GUARD (MIG-03, MIG-02): the content-system mode check of every old write
// rides INSIDE the write's own batch. Run for real: file-database tenants
// (scripts/support/tenant-fixture.js), the real lib writers, storage re-read
// after every refusal.
//
//   1. Every guarded write site (lib/cms/store.js, placements, catalog
//      overrides, templates, approvals, history, lib/content-writes.js and the
//      release helpers): the store passes the pre-check on legacy, then a test
//      hook moves it to 'migrating' (and, separately, 'documents') right
//      before the batch. The write is refused with the plain 409 words and
//      every legacy table is unchanged. publishReleaseById answers
//      { skipped: 'mode' } after one attempt.
//   2. A cms_state table with no row is legacy for every writer (EXISTS form);
//      a tenant at 0020 (no cms_state) saves through every writer.
//   3. The three guard statements and classifyAbort, on real batches.
//   4. The sync pause: requestCatalogSync is skipped while migrating; a run
//      started on legacy writes nothing once the store is migrating and
//      carries on after; legacy and documents stores sync as before; webhook
//      writes carry on.
//   5. The refusal words: plain, no codes or table names (snapshot).
//   pnpm test:legacy-write-guard
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-lwg-default.db";
process.env.PLATFORM_CACHE_MS = "50";

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
const NAMES = ["lwg-legacy", "lwg-norow", "lwg-old", "lwg-docs", "lwg-g23", "lwg-sync", "lwg-syncd", "lwg-old2"];
for (const n of [...NAMES, "lwg"]) await F.removeFixtureFiles(n);
await rm(join(ROOT, ".test-lwg-default.db"), { force: true });

const P = await F.makePlatform({ name: "lwg" });
const { libsql } = await import("../lib/db.js");
const M = await import("../lib/cms-mode.js");
const Store = await import("../lib/cms/store.js");
const Pl = await import("../lib/cms/placements.js");
const Ov = await import("../lib/catalog-overrides.js");
const Tpl = await import("../lib/cms/templates-store.js");
const Ap = await import("../lib/cms/approvals.js");
const H = await import("../lib/cms/history.js");
const W = await import("../lib/content-writes.js");
const R = await import("../lib/releases.js");
const Sync = await import("../lib/sync.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 3).join("\n   ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (v, m) => {
  if (!v) throw new Error(m);
};

const COLLECTION = "gid://shopify/Collection/9001";
const productId = (i) => `gid://shopify/Product/${9100 + i}`;
async function seedTenant(name, stage) {
  const T = await F.makeTenant({ name, stage, products: 3 });
  await T.run(() => Sync.writeCollection({ id: COLLECTION, handle: "guard-collection", title: "Guard collection", products: { nodes: [{ id: productId(1) }, { id: productId(2) }] } }));
  await T.run(async () => {
    await Store.setBlock("hero", { title: "Seed hero" });
    await Store.upsertContentPage({ slug: "about-us", title: "About us", sections: [] });
    await Pl.upsertPlacement({ id: "pl_seed", kind: "pdp_pairs", sourceProductId: productId(1), targetProductIds: [productId(2)] });
    await Ov.setProductOverride(productId(1), { modules: [{ title: "Seed", html: "<p>Seed</p>" }], badge: "Seed" });
    await Ov.setCollectionPins(COLLECTION, [productId(2)]);
  });
  const tpl = await T.run(() => Tpl.saveTemplate({ name: "Seed template", family: "page", sections: [{ kind: "text", heading: "Seed", body: ["Seed"] }] }).catch(() => null));
  const base = await T.run(() => R.createRelease({ note: "seed base" }));
  return { ...T, tplId: tpl?.id ?? null, baseRelease: base.id };
}

const TABLES = ["cms_blocks", "cms_pages", "page_redirects", "placements", "product_overrides", "collection_overrides", "cms_templates", "cms_approvals", "cms_history", "releases", "release_state"];
const dump = (T) =>
  T.run(async () => {
    const out = {};
    for (const table of TABLES) {
      try {
        out[table] = (await libsql.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows.map((r) => ({ ...r }));
      } catch (e) {
        out[table] = `missing: ${/no such table/i.test(String(e.message))}`;
      }
    }
    return out;
  });
const setMode = (T, mode) => T.run(() => libsql.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] }));
const modeOf = async (T) => T.run(() => M.getCmsMode());

// Arms a hook that moves the store to `mode` on the n-th call, then disarms.
async function armed(hooks, key, mode, T, fn, { at = 1 } = {}) {
  let calls = 0;
  hooks[key] = async () => {
    calls++;
    if (calls === at) await setMode(T, mode);
  };
  try {
    return { value: await fn(), calls: () => calls };
  } catch (e) {
    return { error: e, calls: () => calls };
  } finally {
    hooks[key] = null;
    await setMode(T, "legacy");
  }
}

// ---- the write sites -------------------------------------------------------------------
// prep runs on legacy before the hook is armed; run is the write itself,
// after the pre-check its route makes (assertLegacyContentWrites). hook names
// which seam fires right before that write's batch.
const LEGACY = { hooks: M.__legacyWriteTestHooks, key: "beforeBatch" };
const FLIP = { hooks: R.__releaseTestHooks, key: "beforeFlip" };
const blockRev = async (key) => (await Store.getBlockRow(key, { strict: true }))?.revision ?? null;
const pageRev = async (slug) => (await Store.pageRevisions({ strict: true }))[slug] ?? null;
const SITES = [
  { name: "setBlock, a first save (insert)", seam: LEGACY, prep: () => Store.deleteBlock("announcement"), run: () => Store.setBlock("announcement", { enabled: true, text: "Guarded bar", href: "/" }, { expectedRevision: null }) },
  { name: "setBlock, an edit (compare-and-set update)", seam: LEGACY, run: async () => Store.setBlock("hero", { title: "Guarded hero" }, { expectedRevision: await blockRev("hero") }) },
  { name: "deleteBlock without a revision", seam: LEGACY, run: () => Store.deleteBlock("hero") },
  { name: "deleteBlock with the loaded revision", seam: LEGACY, run: async () => Store.deleteBlock("hero", { expectedRevision: await blockRev("hero") }) },
  { name: "upsertContentPage, a new page (insert)", seam: LEGACY, prep: () => Store.deleteContentPage("guard-new"), run: () => Store.upsertContentPage({ slug: "guard-new", title: "Guard new", sections: [] }, { expectedRevision: null }) },
  { name: "upsertContentPage, an edit (compare-and-set update)", seam: LEGACY, run: async () => Store.upsertContentPage({ slug: "about-us", title: "About us, guarded", sections: [] }, { expectedRevision: await pageRev("about-us") }) },
  { name: "deleteContentPage without a revision", seam: LEGACY, run: () => Store.deleteContentPage("about-us") },
  { name: "deleteContentPage with the loaded revision", seam: LEGACY, run: async () => Store.deleteContentPage("about-us", { expectedRevision: await pageRev("about-us") }) },
  { name: "upsertPlacement", seam: LEGACY, run: () => Pl.upsertPlacement({ id: "pl_seed", kind: "pdp_pairs", sourceProductId: productId(1), targetProductIds: [productId(3)], title: "Guarded" }) },
  { name: "deletePlacement", seam: LEGACY, run: () => Pl.deletePlacement("pl_seed") },
  { name: "setProductOverride (upsert)", seam: LEGACY, run: () => Ov.setProductOverride(productId(1), { modules: [{ title: "Guarded", html: "<p>Guarded</p>" }], badge: "New" }) },
  { name: "setProductOverride (clearing deletes the row)", seam: LEGACY, run: () => Ov.setProductOverride(productId(1), { modules: [], badge: "" }) },
  { name: "setCollectionPins (upsert)", seam: LEGACY, run: () => Ov.setCollectionPins(COLLECTION, [productId(1), productId(2)]) },
  { name: "setCollectionPins (clearing deletes the row)", seam: LEGACY, run: () => Ov.setCollectionPins(COLLECTION, []) },
  { name: "saveTemplate, a new template (insert)", seam: LEGACY, run: () => Tpl.saveTemplate({ name: "Guarded template", family: "page", sections: [{ kind: "text", heading: "G", body: ["G"] }] }) },
  { name: "saveTemplate, an edit (update)", seam: LEGACY, needs: "tplId", run: (T) => Tpl.saveTemplate({ id: T.tplId, name: "Seed template, guarded", family: "page", sections: [{ kind: "text", heading: "G", body: ["G"] }] }) },
  { name: "deleteTemplate", seam: LEGACY, needs: "tplId", run: (T) => Tpl.deleteTemplate(T.tplId) },
  { name: "approveCandidate", seam: LEGACY, run: async () => Ap.approveCandidate({ expectedHash: (await R.snapshotContent()).hash, actor: "merchant:u1", note: "ok" }), doing: "publish" },
  { name: "writeContentDrafts (lib/content-writes.js, legacy)", seam: LEGACY, run: () => W.writeContentDrafts({ announcement: { enabled: true, text: "From the door", href: "/" } }, { source: "test" }) },
  { name: "createRelease, publish now (guardedFlip)", seam: FLIP, prep: () => Store.setBlock("hero", { title: "Next release" }), run: () => R.createRelease({ note: "guarded publish" }), doing: "publish" },
  {
    name: "createRelease, scheduled (its release row)",
    seam: LEGACY,
    prep: () => Store.setBlock("hero", { title: "Scheduled release" }),
    run: () => R.createRelease({ note: "guarded schedule", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
    doing: "publish",
  },
  { name: "rollbackRelease (guardedFlip)", seam: FLIP, prep: async () => (await Store.setBlock("hero", { title: "Newer" }), R.createRelease({ note: "newer" })), run: (T) => R.rollbackRelease(T.baseRelease), doing: "publish" },
];
// history is best-effort: a refused append never fails the save it trails
const HISTORY = { name: "appendHistory", seam: LEGACY, run: () => H.appendHistory({ kind: "block", key: "hero", value: { title: "History" }, actor: "merchant:u1" }) };

const words = (mode, doing = "save") =>
  mode === "migrating"
    ? "Your store is being updated. Try again in a few minutes."
    : doing === "publish"
      ? "This store publishes with the new editor, so nothing was published here. Publish from the editor instead."
      : "This store now uses the new editor, so nothing was saved. Make this change in the editor instead.";

const L = await seedTenant("lwg-legacy", "latest");
ok(L.tplId, "the seed template was not saved");

console.log("— 1. every guarded write site refuses when the store leaves legacy after the pre-check");
for (const mode of ["migrating", "documents"]) {
  for (const site of SITES) {
    await t(`'${mode}' after the pre-check: ${site.name} is refused (409, plain words) and nothing changes`, async () => {
      if (site.prep) await L.run(() => site.prep(L));
      eq(await modeOf(L), "legacy", "start:");
      const before = await dump(L);
      const out = await armed(site.seam.hooks, site.seam.key, mode, L, () =>
        L.run(async () => {
          await M.assertLegacyContentWrites({ doing: site.doing || "save" }); // the route's pre-check: passes
          return site.run(L);
        }),
      );
      eq(out.calls(), 1, "the hook fired once:");
      ok(out.error, `the write went through: ${JSON.stringify(out.value)?.slice(0, 120)}`);
      eq([out.error.status, out.error.code, out.error.expose], [409, "STORE_USES_DOCUMENTS", true], "refusal:");
      eq(out.error.message, words(mode, site.doing), "words:");
      ok(!/Another publish/.test(out.error.message) && out.error.code !== "PUBLISH_RACE", "reported as a lost race");
      eq(await dump(L), before, "tables:");
    });
  }
  await t(`'${mode}' after the pre-check: publishReleaseById returns {skipped:'mode'} after ONE attempt and flips nothing`, async () => {
    const sched = await L.run(async () => {
      await Store.setBlock("hero", { title: `Job ${mode}` });
      return R.createRelease({ note: "job", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    });
    const before = await dump(L);
    const out = await armed(FLIP.hooks, FLIP.key, mode, L, () => L.run(() => R.publishReleaseById(sched.id)));
    ok(!out.error, `threw: ${out.error?.message}`);
    eq(out.calls(), 1, "flip attempts:");
    eq([out.value.skipped, out.value.mode], ["mode", mode], "result:");
    eq(await dump(L), before, "tables:");
  });
  await t(`'${mode}' after the pre-check: appendHistory writes no entry and never throws (history is best-effort)`, async () => {
    const before = await dump(L);
    const out = await armed(HISTORY.seam.hooks, HISTORY.seam.key, mode, L, () => L.run(() => HISTORY.run()));
    ok(!out.error, `threw: ${out.error?.message}`);
    eq(out.calls(), 1, "the hook fired once:");
    eq(await dump(L), before, "tables:");
  });
}

await t("on legacy every site still writes, with the guard in its batch (one extra statement, nothing else)", async () => {
  const seen = [];
  M.__legacyWriteTestHooks.beforeBatch = async ({ statements }) => seen.push(statements.length);
  try {
    for (const site of [...SITES, HISTORY]) {
      if (site.prep) await L.run(() => site.prep(L));
      const before = await dump(L);
      await L.run(() => site.run(L));
      ok(JSON.stringify(await dump(L)) !== JSON.stringify(before), `${site.name} changed nothing`);
      if (site.needs === "tplId" && site.name.startsWith("deleteTemplate")) L.tplId = (await L.run(() => Tpl.saveTemplate({ name: "Again", family: "page", sections: [{ kind: "text", heading: "A", body: ["A"] }] }))).id;
      if (site.name.startsWith("deletePlacement")) await L.run(() => Pl.upsertPlacement({ id: "pl_seed", kind: "pdp_pairs", sourceProductId: productId(1), targetProductIds: [productId(2)] }));
      if (site.name.startsWith("deleteContentPage")) await L.run(() => Store.upsertContentPage({ slug: "about-us", title: "About us", sections: [] }));
      if (site.name.startsWith("deleteBlock")) await L.run(() => Store.setBlock("hero", { title: "Seed hero" }));
    }
  } finally {
    M.__legacyWriteTestHooks.beforeBatch = null;
  }
  ok(seen.length > 0 && seen.every((n) => n >= 1), `statements per batch: ${seen}`);
  // the guard is the batch's first statement
  const batches = [];
  const inst = await L.run(async () => (await import("../lib/db.js")).currentDatabase().libsql);
  const orig = inst.batch;
  inst.batch = async (stmts, mode) => {
    batches.push(stmts.map((s) => (typeof s === "string" ? s : s.sql)));
    return orig.call(inst, stmts, mode);
  };
  try {
    await L.run(() => Store.setBlock("hero", { title: "Watched" }));
  } finally {
    inst.batch = orig;
  }
  eq(batches.length, 1, "one batch:");
  ok(/^INSERT INTO cms_state .* WHERE EXISTS \(SELECT 1 FROM cms_state WHERE id = 1 AND mode IS NOT 'legacy'\)$/.test(batches[0][0]), `guard first: ${batches[0][0]}`);
  ok(/update "cms_blocks"/i.test(batches[0][1]), `then the write: ${batches[0][1]}`);
});

console.log("— 2. a cms_state with no row is legacy; a tenant at 0020 saves through every writer");
const runEvery = async (T) => {
  for (const site of [...SITES, HISTORY]) {
    if (site.prep) await T.run(() => site.prep(T));
    const before = await dump(T);
    try {
      await T.run(() => site.run(T));
    } catch (e) {
      throw new Error(`${site.name}: ${e.message}`);
    }
    ok(JSON.stringify(await dump(T)) !== JSON.stringify(before), `${site.name} changed nothing`);
    if (site.name.startsWith("deleteTemplate")) T.tplId = (await T.run(() => Tpl.saveTemplate({ name: "Again", family: "page", sections: [{ kind: "text", heading: "A", body: ["A"] }] }))).id;
    if (site.name.startsWith("deletePlacement")) await T.run(() => Pl.upsertPlacement({ id: "pl_seed", kind: "pdp_pairs", sourceProductId: productId(1), targetProductIds: [productId(2)] }));
    if (site.name.startsWith("deleteContentPage")) await T.run(() => Store.upsertContentPage({ slug: "about-us", title: "About us", sections: [] }));
    if (site.name.startsWith("deleteBlock")) await T.run(() => Store.setBlock("hero", { title: "Seed hero" }));
  }
  const sched = await T.run(async () => {
    await Store.setBlock("hero", { title: "Scheduled once more" });
    return R.createRelease({ note: "sched", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
  });
  const res = await T.run(() => R.publishReleaseById(sched.id));
  eq(res.id, sched.id, "the scheduled flip:");
  eq(await T.run(async () => (await libsql.execute("SELECT live_release_id AS id FROM release_state WHERE id = 1")).rows[0].id), sched.id, "pointer:");
};

await t("a cms_state table with NO row reads as legacy for every guarded writer (the EXISTS form): each one writes", async () => {
  const N = await seedTenant("lwg-norow", "latest");
  await N.run(() => libsql.execute("DELETE FROM cms_state"));
  eq(await N.run(async () => Number((await libsql.execute("SELECT count(*) AS n FROM cms_state")).rows[0].n)), 0, "no row:");
  eq(await modeOf(N), "legacy", "mode:");
  await runEvery(N);
});

await t("a tenant at 0020 (no cms_state at all) saves through every writer, the release helpers included", async () => {
  const O = await seedTenant("lwg-old", "0020");
  eq(await O.run(async () => (await libsql.execute("SELECT name FROM sqlite_master WHERE name = 'cms_state'")).rows.length), 0, "no cms_state:");
  eq(await O.run(() => M.hasCmsStateTable()), false, "probe:");
  eq(await O.run(() => M.legacyGuard()), [], "no guard before 0021:");
  await runEvery(O);
  // migrated while warm: the very next write carries the guard (only a yes is cached)
  await O.migrateTo("latest");
  eq(await O.run(() => M.legacyGuard()), [M.legacyGuardStatement()], "guarded after 0021:");
  await setMode(O, "migrating");
  const e = await O.run(() => Store.setBlock("hero", { title: "After 0021" }).then(() => null, (x) => x));
  eq(e?.code, "STORE_USES_DOCUMENTS", "refused once migrated:");
});

console.log("— 3. the guard statements and classifyAbort on real batches");
const G = await F.makeTenant({ name: "lwg-g23", stage: "0023" });
const D = await seedTenant("lwg-docs", "latest");
const guardRun = (T, stmt) =>
  T.run(() =>
    libsql.batch([stmt, { sql: "UPDATE release_state SET updated_at = 'guard-probe' WHERE id = 1", args: [] }], "write").then(
      () => "passed",
      (e) => (M.isGuardAbort(e) ? "aborted" : `error: ${String(e.message).slice(0, 200)}`),
    ),
  );
const probeWritten = (T) => T.run(async () => (await libsql.execute("SELECT updated_at FROM release_state WHERE id = 1")).rows[0].updated_at === "guard-probe");
const resetProbe = (T) => T.run(() => libsql.execute("UPDATE release_state SET updated_at = NULL WHERE id = 1"));

await t("documentsGuardStatement aborts on legacy and migrating, passes on documents; the rest of the batch follows it", async () => {
  for (const [mode, want] of [
    ["legacy", "aborted"],
    ["migrating", "aborted"],
    ["documents", "passed"],
  ]) {
    await resetProbe(D);
    await setMode(D, mode);
    eq(await guardRun(D, M.documentsGuardStatement()), want, `${mode}:`);
    eq(await probeWritten(D), want === "passed", `${mode} write:`);
  }
  await D.run(() => libsql.execute("DELETE FROM cms_state"));
  eq(await guardRun(D, M.documentsGuardStatement()), "aborted", "no row (reads as legacy):");
  await D.run(() => libsql.execute("INSERT INTO cms_state (id, mode, updated_at) VALUES (1, 'legacy', 'x')"));
  const O = await F.makeTenant({ name: "lwg-old2", stage: "0020" });
  { const r = await guardRun(O, M.documentsGuardStatement()); ok(/^error: .*no such table: cms_state/.test(r), `before 0021 it refuses: ${r}`); }
  eq(await probeWritten(O), false, "before 0021, nothing written:");
});

await t("migratingGuardStatement aborts unless the store is migrating AND that run is open", async () => {
  const at = new Date().toISOString();
  await D.run(() =>
    libsql.batch(
      [
        { sql: "INSERT INTO cms_migration_runs (id, kind, step, started_at) VALUES ('run_open', 'cutover', 'lock', ?)", args: [at] },
        { sql: "INSERT INTO cms_migration_runs (id, kind, step, started_at, finished_at, outcome) VALUES ('run_done', 'cutover', 'done', ?, ?, 'done')", args: [at, at] },
      ],
      "write",
    ),
  );
  const cases = [
    ["legacy", "run_open", "aborted"],
    ["documents", "run_open", "aborted"],
    ["migrating", "run_missing", "aborted"],
    ["migrating", "run_done", "aborted"],
    ["migrating", "run_open", "passed"],
  ];
  for (const [mode, run, want] of cases) {
    await resetProbe(D);
    await setMode(D, mode);
    eq(await guardRun(D, M.migratingGuardStatement(run)), want, `${mode} ${run}:`);
    eq(await probeWritten(D), want === "passed", `${mode} ${run} write:`);
  }
  await setMode(D, "legacy");
  // before 0024 there is no run table: refused
  await G.run(() => libsql.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1"));
  { const r = await guardRun(G, M.migratingGuardStatement("run_open")); ok(/^error: .*no such table: cms_migration_runs/.test(r), `before 0024 it refuses: ${r}`); }
  let threw = false;
  try {
    M.migratingGuardStatement("");
  } catch {
    threw = true;
  }
  ok(threw, "a run id is required");
});

await t("legacyGuardStatement passes on legacy and on a table with no row, aborts on migrating and documents", async () => {
  for (const [mode, want] of [
    ["legacy", "passed"],
    ["migrating", "aborted"],
    ["documents", "aborted"],
    ["something-else", "aborted"],
  ]) {
    await resetProbe(D);
    await setMode(D, mode);
    eq(await guardRun(D, M.legacyGuardStatement()), want, `${mode}:`);
  }
  await D.run(() => libsql.execute("DELETE FROM cms_state"));
  eq(await guardRun(D, M.legacyGuardStatement()), "passed", "no row:");
  await D.run(() => libsql.execute("INSERT INTO cms_state (id, mode, updated_at) VALUES (1, 'legacy', 'x')"));
});

await t("classifyAbort tells a mode abort from a lost pointer race (same CHECK text), and leaves other errors alone", async () => {
  const pointerAbort = () =>
    D.run(() =>
      libsql
        .batch(
          [
            M.legacyGuardStatement(),
            { sql: "UPDATE release_state SET live_release_id = 'x' WHERE id = 1 AND live_release_id IS 'not-the-pointer'", args: [] },
            { sql: "INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0", args: [] },
          ],
          "write",
        )
        .then(() => null, (e) => e),
    );
  await setMode(D, "legacy");
  const race = await pointerAbort();
  ok(M.isGuardAbort(race), `not a guard abort: ${race?.message}`);
  eq(await D.run(() => M.classifyAbort(libsql, race, "legacy")), { kind: "lost" }, "pointer race:");
  await setMode(D, "migrating");
  const mig = await pointerAbort();
  ok(/CHECK constraint failed/.test(String(mig?.message) + String(mig?.cause?.message)), "same CHECK text");
  eq(await D.run(() => M.classifyAbort(libsql, mig, "legacy")), { kind: "mode", mode: "migrating", message: M.MIGRATING_MESSAGE }, "mode abort:");
  // the mode is re-read: the same error once the store is back on legacy is a race
  await setMode(D, "legacy");
  eq(await D.run(() => M.classifyAbort(libsql, mig, "legacy")), { kind: "lost" }, "re-read:");
  await setMode(D, "documents");
  eq((await D.run(() => M.classifyAbort(libsql, race, "legacy"))).kind, "mode", "documents:");
  eq(await D.run(() => M.classifyAbort(libsql, race, "documents")), { kind: "lost" }, "expected documents:");
  await setMode(D, "legacy");
  const other = await D.run(() => libsql.execute("INSERT INTO cms_blocks (key) VALUES (NULL)").then(() => null, (e) => e));
  eq(await D.run(() => M.classifyAbort(libsql, other, "legacy")), null, "not a guard abort:");
});

console.log("— 4. the sync pause (MIG-02)");
const page = (nodes, more, cursor) => ({ nodes, endCursor: cursor, hasNextPage: more });
const catalogProduct = (i) => F.fixtureProduct(i, { title: `Synced ${i}` });
const fetchersFor = (n = 4, { onProductsPage } = {}) => ({
  productsPage: async (cursor) => {
    const at = cursor ? Number(cursor) : 0;
    if (onProductsPage) await onProductsPage(at);
    const nodes = [catalogProduct(at + 1), catalogProduct(at + 2)].filter((p, k) => at + k < n);
    return page(nodes, at + 2 < n, String(at + 2));
  },
  collectionsPage: async () => page([{ id: COLLECTION, handle: "guard-collection", title: "Guard collection", products: { nodes: [{ id: productId(1) }], pageInfo: { hasNextPage: false } } }], false, "c1"),
});
const indexer = async () => ({ indexed: 0, skipped: "test" });
const catalog = (T) =>
  T.run(async () => ({
    products: (await libsql.execute("SELECT id, title, synced_at FROM products ORDER BY id")).rows.map((r) => ({ ...r })),
    collections: (await libsql.execute("SELECT id, title, synced_at FROM collections ORDER BY id")).rows.map((r) => ({ ...r })),
    members: (await libsql.execute("SELECT collection_id, product_id FROM collection_products ORDER BY 1, 2")).rows.map((r) => ({ ...r })),
  }));
const runRow = (T, id) => T.run(() => Sync.getSyncRun(id));
const S1 = await F.makeTenant({ name: "lwg-sync", stage: "latest", products: [{ title: "Before the sync" }] });

await t("on a migrating tenant requestCatalogSync reports skipped and changes no catalog rows; runCatalogSync says so in plain words", async () => {
  await setMode(S1, "migrating");
  try {
    const before = await catalog(S1);
    const res = await S1.run(() => Sync.requestCatalogSync({ startedBy: "test", fetchers: fetchersFor() }));
    eq([res.action, res.skipped, res.run], ["skipped", "store is being updated", null], "request:");
    eq(await S1.run(async () => Number((await libsql.execute("SELECT count(*) AS n FROM sync_runs")).rows[0].n)), 0, "no run started:");
    const e = await S1.run(() => Sync.runCatalogSync({ fetchers: fetchersFor(), indexer }).then(() => null, (x) => x));
    eq(e?.message, Sync.SYNC_PAUSED_MESSAGE, "inline:");
    eq(await catalog(S1), before, "catalog:");
  } finally {
    await setMode(S1, "legacy");
  }
});

await t("a run started on legacy and flipped to migrating mid-run writes nothing in its next slice, and resumes after the store is back on legacy", async () => {
  const before = await catalog(S1);
  const { run, action } = await S1.run(() => Sync.requestCatalogSync({ startedBy: "test", fetchers: fetchersFor() }));
  eq(action, "started", "start:");
  // slice 1: one page, then the time runs out
  let clock = 0;
  const fx = fetchersFor(4, {
    onProductsPage: async () => {
      clock += 1;
    },
  });
  const deadline = Sync.SYNC_TIMING.MIN_PAGE_MS * 1.5;
  const first = await S1.run(() => Sync.runSyncSlice(run.id, { deadline, now: () => (clock ? deadline : 0), fetchers: fx, indexer }));
  ok(!first.done && first.yielded && first.committed === 1, `first slice: ${JSON.stringify({ ...first, run: undefined })}`);
  const mid = await catalog(S1);
  ok(mid.products.length > before.products.length, "the first page went in");
  const runMid = await runRow(S1, run.id);
  // the store starts migrating between slices
  await setMode(S1, "migrating");
  const fetchedBefore = clock;
  const second = await S1.run(() => Sync.runSyncSlice(run.id, { fetchers: fx, indexer }));
  eq([second.done, second.paused], [false, true], "parked:");
  eq(clock, fetchedBefore, "parked at the start of the slice: no Shopify page was read:");
  eq(await catalog(S1), mid, "catalog while migrating:");
  eq(await runRow(S1, run.id), runMid, "the run row is untouched (no lease, no position):");
  // a run joined while migrating is handed back untouched too
  const join = await S1.run(() => Sync.requestCatalogSync({ startedBy: "test", fetchers: fx }));
  eq([join.action, join.run?.id], ["skipped", run.id], "join while migrating:");
  // back on legacy: the next slice carries on from the stored position
  await setMode(S1, "legacy");
  const third = await S1.run(() => Sync.runSyncSlice(run.id, { fetchers: fx, indexer }));
  eq([third.done, third.status], [true, "complete"], "resumed:");
  const after = await catalog(S1);
  eq(after.products.map((p) => p.title).sort(), ["Synced 1", "Synced 2", "Synced 3", "Synced 4"], "products:");
  eq(after.members, [{ collection_id: COLLECTION, product_id: productId(1) }], "members:");
});

await t("a slice already under way when the store starts migrating writes no further page (the in-batch pause belt)", async () => {
  const { run } = await S1.run(() => Sync.requestCatalogSync({ startedBy: "test", fetchers: fetchersFor() }));
  let calls = 0;
  const fx = fetchersFor(6, {
    onProductsPage: async () => {
      calls++;
      if (calls === 2) await setMode(S1, "migrating"); // after page 1 is in, while page 2 is being read
    },
  });
  let res;
  try {
    const before = await catalog(S1);
    res = await S1.run(() => Sync.runSyncSlice(run.id, { fetchers: fx, indexer }));
    eq([res.done, res.paused, res.committed], [false, true, 1], "paused after one page:");
    const mid = await catalog(S1);
    eq(mid.products.length, before.products.length, "page 1 rewrote existing rows only:");
    const r = await runRow(S1, run.id);
    eq([Number(r.pages_done), r.lease_owner, r.status], [1, null, "running"], "run row: one page, lease freed:");
  } finally {
    await setMode(S1, "legacy");
  }
  const done = await S1.run(() => Sync.runSyncSlice(run.id, { fetchers: fx, indexer }));
  eq(done.status, "complete", "resumed:");
  eq((await catalog(S1)).products.length, 6, "all six:");
});

await t("legacy and documents tenants sync as before; webhook writes carry on while migrating", async () => {
  const SD = await F.makeTenant({ name: "lwg-syncd", stage: "latest" });
  await setMode(SD, "documents");
  for (const T of [S1, SD]) {
    const res = await T.run(() => Sync.runCatalogSync({ fetchers: fetchersFor(4), indexer, startedBy: "test" }));
    eq([res.products, res.collections], [4, 1], `${T.name}:`);
  }
  // webhooks: a product write and a delete go through on a migrating store
  await setMode(S1, "migrating");
  try {
    await S1.run(() => Sync.writeProduct(F.fixtureProduct(9, { title: "From a webhook" })));
    await S1.run(() => Sync.deleteProductByGid(productId(4)));
    const titles = (await catalog(S1)).products.map((p) => p.title);
    ok(titles.includes("From a webhook") && !titles.includes("Synced 4"), `webhooks: ${titles}`);
  } finally {
    await setMode(S1, "legacy");
  }
});

console.log("— 5. the words");
await t("refusal messages are plain words with no codes or table names (snapshot)", async () => {
  const msgs = {
    migrating: M.modeAbortError("migrating").message,
    migrating_publish: M.modeAbortError("migrating", { doing: "publish" }).message,
    documents: M.modeAbortError("documents").message,
    documents_publish: M.modeAbortError("documents", { doing: "publish" }).message,
    sync_paused: Sync.SYNC_PAUSED_MESSAGE,
    sync_skipped: Sync.SYNC_SKIPPED,
  };
  eq(msgs, {
    migrating: "Your store is being updated. Try again in a few minutes.",
    migrating_publish: "Your store is being updated. Try again in a few minutes.",
    documents: "This store now uses the new editor, so nothing was saved. Make this change in the editor instead.",
    documents_publish: "This store publishes with the new editor, so nothing was published here. Publish from the editor instead.",
    sync_paused: "Your store is being updated, so the catalog copy is paused. It carries on by itself once the update is done.",
    sync_skipped: "store is being updated",
  });
  for (const [k, m] of Object.entries(msgs)) ok(!/[a-z]+_[a-z_]+|[A-Z]{3,}|SQLITE|CHECK|constraint|cms_|release_state|\bid\b|\d/.test(m), `${k} is not plain: ${m}`);
  // the error carries no driver cause, so routes never read it as a 5xx
  const { infraKind } = await import("../lib/cms/issues.js");
  eq(infraKind(M.modeAbortError("migrating")), null, "infraKind:");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
for (const n of NAMES) await F.removeFixtureFiles(n);
await P.cleanup();
await rm(join(ROOT, ".test-lwg-default.db"), { force: true });
process.exit(fail ? 1 : 0);
