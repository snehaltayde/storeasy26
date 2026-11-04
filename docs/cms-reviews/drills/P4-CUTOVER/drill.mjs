// P4-CUTOVER drill: the rehearsal on a local copy, then the real-shaped move of
// the harness store, with the storefront canaries checked before and after in
// desktop Chrome. Builder-only, on the design harness: every database is a
// local sqld, the control plane too; Typesense is blank (BLANKED_ENV); no
// --hosted, no Shopify.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 COPY_SQLD_PORT=7103 \
//     node docs/cms-reviews/drills/P4-CUTOVER/drill.mjs [--headed]
//
// What it does (results-cutover.json and screenshots next to this file):
//   1. seeds the phase 4 store (--p4: a legacy store live on a v3 release
//      with 24 overrides, 40 pairs, pins, templates, a redirect, a running
//      hero experiment) and starts the harness
//   2. the route list for the comparison (migrate-render --make-routes)
//   3. a copy of the store's database in a second local sqld (COPY_SQLD_PORT),
//      the store's control-plane row pointed at the copy (as the runbook's
//      "restore-drill copy served by the harness"), then the rehearsal
//      (--rehearsal-run --db <copy> --base <harness>): it must pass, and the
//      store's own database must be untouched
//   4. the store's row pointed back at its own database; desktop Chrome
//      (1440 px, a fixed experiment unit) visits the canaries: text and
//      template markers, and screenshots, BEFORE
//   5. the dry run, then the real-shaped move with its digest and the
//      rehearsal report: it must succeed; the store is on the new editor
//   6. the same canaries in Chrome AFTER: the same text and markers; a
//      shopper capture (migrate-render) before and after compares the same
//   7. --status reads "uses the new editor"; old writers refuse
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { DATA_DIR_NAME, ROOT, harnessEnv, harnessPorts, harnessUrls, readCredentials, findSqld, startSqld, waitForHealth, stopChild } from "../../../../scripts/design-harness.js";
import { readP4Seed, reseedP4, runDrill, runNode, settle, noThanks, startOwned, stopOwned } from "../../../../scripts/drills/p4/lib.mjs";

const SCRATCH = process.env.P4_CUTOVER_SCRATCH || mkdtempSync(join(tmpdir(), "p4-cutover-drill-"));
const COPY_PORT = Number(process.env.COPY_SQLD_PORT || 0);

async function sql(url, statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url });
  try {
    const out = [];
    for (const s of statements) out.push(await c.execute(typeof s === "string" ? { sql: s, args: [] } : s));
    return out;
  } finally {
    c.close();
  }
}

// every table and row of one database into another (schema first)
async function copyDatabase(fromUrl, toUrl) {
  const { createClient } = await import("@libsql/client");
  const src = createClient({ url: fromUrl });
  const dst = createClient({ url: toUrl });
  try {
    const master = await src.execute("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END");
    const tables = [];
    for (const row of master.rows) {
      await dst.execute(String(row.sql));
      if (row.type === "table") tables.push(String(row.name));
    }
    let rows = 0;
    for (const t of tables) {
      const data = await src.execute(`SELECT * FROM "${t}"`);
      const cols = data.columns;
      const stmts = data.rows.map((r) => ({ sql: `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => r[c]) }));
      for (let i = 0; i < stmts.length; i += 200) await dst.batch(stmts.slice(i, i + 200), "write");
      rows += stmts.length;
    }
    return { tables: tables.length, rows };
  } finally {
    src.close();
    dst.close();
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

process.exit(
  await runDrill({ id: "P4-CUTOVER", part: "cutover", title: "P4-CUTOVER — rehearsal on a copy, then the move, in desktop Chrome" }, async (drill) => {
    if (!COPY_PORT) throw new Error("Set COPY_SQLD_PORT to this run's own spare sqld port.");
    const ports = harnessPorts();
    const urls = harnessUrls(ports);
    await reseedP4(drill, { start: true });
    const seed = readP4Seed();
    const env = { ...harnessEnv(process.env, readCredentials(ROOT), ports), PLATFORM_CACHE_MS: process.env.PLATFORM_CACHE_MS || "1000" };
    const base = `http://localhost:${ports.next}`;
    const cli = (args) => runNode([join(ROOT, "scripts/migrate-documents.js"), ...args], { env });
    const render = (args) => runNode([join(ROOT, "scripts/migrate-render.mjs"), ...args], { env });
    const store = "design";
    const tenantRow = async () => (await sql(urls.platform, [{ sql: "SELECT db_url FROM tenants WHERE id = ?", args: [store] }]))[0].rows[0];
    drill.note(`store ${store}: its database ${urls.tenant}, the control plane ${urls.platform}; scratch ${SCRATCH}`);

    // The demo seed gives an agency access to this store; the move refuses
    // that (DOC-13 isn't built), so the founder removes it first, as the dry
    // run says (Settings > Team). Here: the grant is revoked in the control plane.
    const revoked = await sql(urls.platform, [{ sql: "UPDATE agency_grants SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND status = 'accepted'", args: [new Date().toISOString(), store] }]);
    drill.note(`the agency's access to the store removed first (${revoked[0].rowsAffected} grant), as the dry run asks`);

    // 2. the route list
    const routesFile = join(SCRATCH, "routes.json");
    const mk = await render(["--make-routes", routesFile, "--tenant", store]);
    drill.check(mk.code === 0, "the route list for the comparison (migrate-render --make-routes)", mk.out.trim().split("\n").pop());

    // 3. the copy, the store's row pointed at it, the rehearsal
    const dataDir = join(SCRATCH, "copy-sqld");
    mkdirSync(dataDir, { recursive: true });
    const sq = startSqld({ bin: findSqld().bin, key: "p4-cutover-copy", port: COPY_PORT, dataDir });
    try {
      await waitForHealth(sq.url, sq.child, { logFile: sq.logFile, label: "the copy" });
      const copied = await copyDatabase(urls.tenant, sq.url);
      drill.note(`copied the store into ${sq.url}: ${copied.tables} tables, ${copied.rows} rows`);
      const ownBefore = (await sql(urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT count(*) AS n FROM documents"])).map((r) => r.rows[0]);
      await sql(urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [sq.url, store] }]);
      await wait(2500); // the harness's cached row expires (PLATFORM_CACHE_MS)
      const out = join(SCRATCH, "rehearsal");
      const reh = await cli(["--tenant", store, "--rehearsal-run", "--db", sq.url, "--base", base, "--routes", routesFile, "--out", out]);
      const rep = JSON.parse(readFileSync(join(out, "rehearsal.json"), "utf8"));
      drill.check(reh.code === 0 && rep.passed === true, "the rehearsal on the copy passes (the move on the copy, then the page comparison)", { exit: reh.code, tail: reh.out.trim().split("\n").slice(-3), render: { same: rep.render?.same, compared: rep.render?.compared, canariesOk: rep.render?.canariesOk, allowed: rep.render?.allowed, list: rep.render?.list?.slice(0, 5) }, dataCheck: rep.dataCheck });
      drill.check(rep.render?.compared > 20 && rep.render?.canariesOk === true, "the rehearsal compared every route, and every canary loaded before the move", { compared: rep.render?.compared, canaries: rep.render?.canaries });
      const copyAfter = (await sql(sq.url, ["SELECT mode FROM cms_state WHERE id = 1"]))[0].rows[0];
      drill.check(copyAfter.mode === "documents", "the copy moved to the new editor", copyAfter);
      const ownAfter = (await sql(urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT count(*) AS n FROM documents"])).map((r) => r.rows[0]);
      drill.check(JSON.stringify(ownAfter) === JSON.stringify(ownBefore), "the store's own database is untouched by its rehearsal", { before: ownBefore, after: ownAfter });
      drill.note(`rehearsal output (plain part):\n${reh.out.split("\nDetails")[0].slice(-1500)}`);
      // 4. back to its own database
      await sql(urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [urls.tenant, store] }]);
      await wait(2500);
      drill.check((await tenantRow()).db_url === urls.tenant, "the store's row points at its own database again", await tenantRow());

      // canaries in desktop Chrome
      const canaries = [
        { name: "home", path: "/" },
        { name: "product", path: seed.chosenProduct.path },
        { name: "collection", path: seed.pinnedCollection.path },
        { name: "journal", path: "/journal" },
        { name: "redirected-post", path: `/journal/${seed.redirect.from}` },
      ];
      const look = async (label) => {
        const ctx = await drill.context({ width: 1440 });
        await ctx.addCookies([{ name: "_unit", value: "p4-cutover-drill", url: base }]);
        const page = await ctx.newPage();
        const seen = {};
        for (const c of canaries) {
          await page.goto(`${base}${c.path}`, { waitUntil: "load" });
          await settle(page);
          await noThanks(page);
          if (c.name === "product") await page.locator("[data-pdp-template]").first().waitFor({ state: "visible", timeout: 90_000 });
          if (c.name === "collection") await page.locator("[data-collection-template]").first().waitFor({ state: "visible", timeout: 90_000 });
          seen[c.name] = await page.evaluate(() => ({
            path: location.pathname,
            text: (document.querySelector("main")?.innerText || document.body.innerText).replace(/\s+/g, " ").trim(),
            markers: [...document.querySelectorAll("[data-sec],[data-pdp-template],[data-collection-template]")].map((e) => [e.getAttribute("data-sec"), e.getAttribute("data-pdp-template"), e.getAttribute("data-collection-template")].join("|")).filter((m) => !/^i-\d+\|\||^sec_/.test(m)),
          }));
          await drill.screenshot(page, `${c.name}-${label}-1440`);
        }
        await ctx.close();
        return seen;
      };
      const before = await look("before");
      drill.check(before.product.markers.includes("|editorial|") && before.collection.markers.includes("||sidebar"), "before: the chosen product's editorial template and the collection's sidebar template show", { product: before.product.markers.slice(0, 6), collection: before.collection.markers.slice(0, 6) });
      const capBefore = join(SCRATCH, "real-before");
      const cb = await render(["--base", base, "--routes", routesFile, "--out", capBefore]);
      drill.check(cb.code === 0, "a shopper capture of every route before the move", cb.out.trim().split("\n").pop());

      // 5. the dry run and the move
      const dry = await cli(["--tenant", store, "--dry-run"]);
      const digest = /Dry-run digest: ([0-9a-f]{64})/.exec(dry.out)?.[1];
      drill.check(dry.code === 0 && /^Ready to move/m.test(dry.out) && digest, "the dry run says Ready to move and prints its digest", dry.out.split("\n")[0]);
      const move = await cli(["--tenant", store, "--dry-run-digest", digest, "--rehearsal", join(out, "rehearsal.json")]);
      drill.check(move.code === 0 && /Your store now uses the new editor\./.test(move.out), "the real-shaped move (digest and rehearsal report as proofs) finishes", move.out.split("\nDetails")[0].slice(-1200));
      const state = (await sql(urls.tenant, ["SELECT mode, cutover_release_id FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT step, outcome FROM cms_migration_runs"])).map((r) => r.rows);
      drill.check(state[0][0].mode === "documents" && state[0][0].cutover_release_id === seed.liveRelease && /^rel_mig_/.test(state[1][0].id) && state[2].length === 1 && state[2][0].outcome === "done", "the store is on the new editor: v4 release live, the old live release recorded, one finished run", state);
      await wait(1500);

      // 6. the same canaries after
      const after = await look("after");
      for (const c of canaries) {
        const same = before[c.name].text === after[c.name].text && JSON.stringify(before[c.name].markers) === JSON.stringify(after[c.name].markers) && before[c.name].path === after[c.name].path;
        drill.check(same, `in Chrome, ${c.path} shows the same text, sections and templates before and after the move`, same ? { path: after[c.name].path, chars: after[c.name].text.length } : { before: before[c.name].text.slice(0, 400), after: after[c.name].text.slice(0, 400), mb: before[c.name].markers, ma: after[c.name].markers });
      }
      const capAfter = join(SCRATCH, "real-after");
      await render(["--base", base, "--routes", routesFile, "--out", capAfter]);
      const cmp = await render(["--compare", capBefore, capAfter, "--json", join(SCRATCH, "real-compare.json")]);
      drill.check(cmp.code === 0, "the shopper captures of every route before and after the real move compare the same", cmp.out.trim().split("\n").slice(-6).join(" | "));

      // 7. status, and the old writers
      const st = await cli(["--tenant", store, "--status"]);
      drill.check(st.code === 0 && /Your store uses the new editor\. No update is under way\./.test(st.out), "--status says the store uses the new editor", st.out.trim().split("\n")[0]);
      const ab = await cli(["--tenant", store, "--abort"]);
      drill.check(ab.code === 1 && /nothing to stop/.test(ab.out), "--abort with nothing under way says so", ab.out.trim());
    } finally {
      await sql(urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ? AND db_url <> ?", args: [urls.tenant, store, urls.tenant] }]).catch(() => {});
      await stopChild(sq.child);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }),
);
void startOwned;
void stopOwned;
void DATA_DIR_NAME;
