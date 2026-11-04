// P4-REVERSE drill (MIG-04): cut over, rename a product, reverse, see Shopify's
// name, cut over again, see the renamed name, in desktop Chrome on the design
// harness. Builder-only: every database is a local sqld, the control plane
// too; Typesense is blank (BLANKED_ENV); no --hosted, no Shopify.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 COPY_SQLD_PORT=7103 PLATFORM_CACHE_MS=1000 \
//     node docs/cms-reviews/drills/P4-REVERSE/drill.mjs [--headed]
//
// What it does (results-reverse.json and screenshots next to this file):
//   1. seeds the phase 4 store (--p4: a legacy store live on a v3 release) and
//      starts the harness; removes the demo agency access (the move refuses it)
//   2. the move as the owner runs it: a copy in a second local sqld, the
//      rehearsal on it (--rehearsal-run), the dry run, then the move with the
//      digest and the rehearsal report
//   3. the founder renames the chosen product in the new editor (signed in as
//      the owner, through the editor's own documents API: open, save, publish);
//      a shopper in Chrome sees the new name
//   4. the reversal's dry run names the product and its new name; the reversal
//      with its digest; a shopper in Chrome sees Shopify's name again; --status
//   5. the move again (a fresh copy and rehearsal of the reversed store, the dry
//      run listing the edit that comes back, the move); a shopper in Chrome
//      sees the renamed name
import { mkdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, harnessEnv, harnessPorts, harnessUrls, readCredentials, findSqld, startSqld, waitForHealth, stopChild } from "../../../../scripts/design-harness.js";
import { readP4Seed, reseedP4, runDrill, runNode, settle, noThanks, docsApi } from "../../../../scripts/drills/p4/lib.mjs";

const SCRATCH = process.env.P4_REVERSE_SCRATCH || mkdtempSync(join(tmpdir(), "p4-reverse-drill-"));
const COPY_PORT = Number(process.env.COPY_SQLD_PORT || 0);
const NEW_NAME = "Drill Renamed Bestseller";

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
    // a fresh copy each time: drop what an earlier copy left
    const old = await dst.execute("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%' AND type IN ('table', 'view', 'trigger')");
    for (const r of old.rows) await dst.execute(`DROP ${String(r.type).toUpperCase()} IF EXISTS "${r.name}"`);
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
  await runDrill({ id: "P4-REVERSE", part: "reverse", title: "P4-REVERSE — move, rename, move back, move again, in desktop Chrome" }, async (drill) => {
    if (!COPY_PORT) throw new Error("Set COPY_SQLD_PORT to this run's own spare sqld port.");
    const ports = harnessPorts();
    const urls = harnessUrls(ports);
    await reseedP4(drill, { start: true });
    const seed = readP4Seed();
    const env = { ...harnessEnv(process.env, readCredentials(ROOT), ports), PLATFORM_CACHE_MS: process.env.PLATFORM_CACHE_MS || "1000" };
    const base = `http://localhost:${ports.next}`;
    const migrate = (args) => runNode([join(ROOT, "scripts/migrate-documents.js"), ...args], { env });
    const reverse = (args) => runNode([join(ROOT, "scripts/reverse-documents.js"), ...args], { env });
    const render = (args) => runNode([join(ROOT, "scripts/migrate-render.mjs"), ...args], { env });
    const store = "design";
    const productPath = seed.chosenProduct.path;
    const handle = productPath.split("/").pop();
    const prod = (await sql(urls.tenant, [{ sql: "SELECT id, title FROM products WHERE handle = ?", args: [handle] }]))[0].rows[0];
    const shopifyName = String(prod.title);
    drill.note(`store ${store}; the product ${productPath} (${prod.id}), Shopify's name "${shopifyName}"; scratch ${SCRATCH}`);

    const revoked = await sql(urls.platform, [{ sql: "UPDATE agency_grants SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND status = 'accepted'", args: [new Date().toISOString(), store] }]);
    drill.note(`the agency's access to the store removed first (${revoked[0].rowsAffected} grant), as the dry run asks`);
    const routesFile = join(SCRATCH, "routes.json");
    const mk = await render(["--make-routes", routesFile, "--tenant", store]);
    drill.check(mk.code === 0, "the route list for the comparison (migrate-render --make-routes)", mk.out.trim().split("\n").pop());

    // what a shopper sees on the product page, in Chrome
    const look = async (label) => {
      const ctx = await drill.context({ width: 1440 });
      await ctx.addCookies([{ name: "_unit", value: "p4-reverse-drill", url: base }]);
      const page = await ctx.newPage();
      await page.goto(`${base}${productPath}`, { waitUntil: "load" });
      await settle(page);
      await noThanks(page);
      await page.locator("h1").first().waitFor({ state: "visible", timeout: 90_000 });
      const seen = await page.evaluate(() => ({ h1: document.querySelector("h1")?.innerText?.trim() ?? null, title: document.title }));
      await drill.screenshot(page, `product-${label}-1440`);
      await ctx.close();
      return seen;
    };

    const dataDir = join(SCRATCH, "copy-sqld");
    mkdirSync(dataDir, { recursive: true });
    const sq = startSqld({ bin: findSqld().bin, key: "p4-reverse-copy", port: COPY_PORT, dataDir });
    // the move as the owner runs it: copy, rehearsal, dry run, move
    const moveStore = async (label) => {
      const copied = await copyDatabase(urls.tenant, sq.url);
      drill.note(`${label}: copied the store into ${sq.url}: ${copied.tables} tables, ${copied.rows} rows`);
      await sql(urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [sq.url, store] }]);
      await wait(2500);
      const out = join(SCRATCH, `rehearsal-${label}`);
      let reh;
      try {
        reh = await migrate(["--tenant", store, "--rehearsal-run", "--db", sq.url, "--base", base, "--routes", routesFile, "--out", out]);
      } finally {
        await sql(urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [urls.tenant, store] }]);
        await wait(2500);
      }
      const rep = JSON.parse(readFileSync(join(out, "rehearsal.json"), "utf8"));
      drill.check(reh.code === 0 && rep.passed === true, `${label}: the rehearsal on a copy passes`, { exit: reh.code, render: { same: rep.render?.same, compared: rep.render?.compared, list: rep.render?.list?.slice(0, 5) }, dataCheck: rep.dataCheck, tail: reh.out.trim().split("\n").slice(-3) });
      const dry = await migrate(["--tenant", store, "--dry-run"]);
      const digest = /Dry-run digest: ([0-9a-f]{64})/.exec(dry.out)?.[1];
      drill.check(dry.code === 0 && /^Ready to move/m.test(dry.out) && digest, `${label}: the dry run says Ready to move`, dry.out.split("\n")[0]);
      const mv = await migrate(["--tenant", store, "--dry-run-digest", digest, "--rehearsal", join(out, "rehearsal.json")]);
      drill.check(mv.code === 0 && /Your store now uses the new editor\./.test(mv.out), `${label}: the move finishes`, mv.out.split("\nDetails")[0].slice(-1200));
      await wait(1500);
      return { dry, mv };
    };

    try {
      await waitForHealth(sq.url, sq.child, { logFile: sq.logFile, label: "the copy" });
      const before = await look("legacy-before");
      drill.check(before.h1 === shopifyName, "before anything: the product page shows Shopify's name", before);

      // 2. the first move
      await moveStore("first-move");
      const moved = (await sql(urls.tenant, ["SELECT mode, cutover_release_id FROM cms_state WHERE id = 1"]))[0].rows[0];
      drill.check(moved.mode === "documents" && moved.cutover_release_id === seed.liveRelease, "the store is on the new editor, the old live release recorded", moved);

      // 3. the founder renames the product in the new editor
      const ctx = await drill.context({ width: 1440 });
      const admin = await drill.login("owner", { context: ctx });
      const opened = await docsApi(admin, { openEntityContent: { type: "product_content", entityId: prod.id } });
      drill.check(opened.status === 200, "the founder opens the product in the new editor", { status: opened.status });
      const doc = opened.body.document;
      const saved = await docsApi(admin, { saveDraft: { id: doc.id, body: { ...doc.body, settings: { ...doc.body.settings, title: { value: NEW_NAME } } } }, revision: doc.revision });
      drill.check(saved.status === 200, "the new name is saved", { status: saved.status, error: saved.body?.error });
      const sd = saved.body.document;
      const pub = await docsApi(admin, { publish: { id: sd.id, draftHash: sd.draftHash }, revision: sd.revision });
      drill.check(pub.status === 200, "and published", { status: pub.status, error: pub.body?.error });
      await ctx.close();
      await wait(1500);
      const renamed = await look("renamed-in-new-editor");
      drill.check(renamed.h1 === NEW_NAME, "in Chrome, the product page shows the new name", renamed);

      // 4. the reversal
      const rdry = await reverse(["--tenant", store, "--dry-run"]);
      const rdigest = /Reversal dry-run digest: ([0-9a-f]{64})/.exec(rdry.out)?.[1];
      drill.check(rdry.code === 0 && /^Ready to move back to the old editor/.test(rdry.out) && rdigest, "the reversal's dry run is ready", rdry.out.split("\n")[0]);
      drill.check(rdry.out.includes(`“${shopifyName}”: new name (“${NEW_NAME}”)`), "the reversal's dry run names the product and its new name", rdry.out.split("\nDetails")[0]);
      const rv = await reverse(["--tenant", store, "--dry-run-digest", rdigest]);
      drill.check(rv.code === 0 && rv.out.startsWith("Your store is back on the old editor.") && rv.out.includes("A message you can pass on"), "the reversal finishes, with the message for the founder", rv.out.split("\nDetails")[0]);
      const back = (await sql(urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT count(*) AS n FROM product_content_live", "SELECT count(*) AS n FROM content_live_reversed"])).map((r) => r.rows[0]);
      drill.check(back[0].mode === "legacy" && back[1].id === seed.liveRelease && Number(back[2].n) === 0 && Number(back[3].n) > 0, "the store is on the old editor, on the release from before the move, its live rows copied aside", back);
      await wait(1500);
      const reversed = await look("after-reversal");
      drill.check(reversed.h1 === shopifyName, "in Chrome, the product page shows Shopify's name again", reversed);
      const st = await reverse(["--tenant", store, "--status"]);
      drill.check(st.code === 0 && /Your store uses the old editor\. No reversal is under way\./.test(st.out) && /moved the store back to the old editor/.test(st.out), "--status says the store is back on the old editor", st.out.trim());

      // 5. the move again
      const again = await moveStore("second-move");
      drill.check(again.dry.out.includes("Edits that come back at the move") && again.dry.out.includes(`“${shopifyName}”: new name (“${NEW_NAME}”).`), "the second move's dry run lists, by name, the edit that comes back", again.dry.out.split("\nDetails")[0].slice(-1500));
      const final = await look("after-second-move");
      drill.check(final.h1 === NEW_NAME, "in Chrome, after the second move the product page shows the renamed name", final);
    } finally {
      await sql(urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ? AND db_url <> ?", args: [urls.tenant, store, urls.tenant] }]).catch(() => {});
      await stopChild(sq.child);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }),
);
