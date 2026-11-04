// P4-DRILLS 'cutover' stage (MIG-02, MIG-03): the rehearsal on a local copy,
// then the move of the --p4 harness store, with the storefront canaries
// checked in desktop Chrome before and after. Builder-only: every database is
// a local sqld, the control plane too; Typesense and Shopify are blank in the
// harness env; no --hosted.
//
//   1. a fresh --p4 store (legacy, live on a v3 release), the harness running;
//      the demo agency access removed (the move refuses it)
//   2. the route list, a copy of the store in a second local sqld, the
//      store's row pointed at the copy, the rehearsal, the row pointed back:
//      the rehearsal passes and the store's own database is untouched
//   3. Chrome (1440 px, a fixed experiment unit) on the canaries BEFORE: the
//      home page, the chosen product (editorial template, badge, pairs
//      title, six modules), the pinned collection (sidebar template), the
//      journal, the renamed post's old address; a shopper capture of every route
//   4. the dry run, then the move with its digest and the rehearsal report
//   5. the same canaries AFTER, compared text for text and marker for
//      marker; the shopper captures before and after compare the same
//   6. --status says the new editor; --abort has nothing to stop; an old
//      editor's save is refused in plain words; the console opens the editor
import { join } from "node:path";
import { copyServer, digestOf, drillScratch, harnessContext, makeRoutes, noThanks, readP4Seed, rehearse, reseedP4, revokeAgency, settle, shopperContext, sleep, sqlAt, consoleUrl } from "./lib.mjs";

const CANARIES = (seed) => [
  { name: "home", path: "/" },
  { name: "product", path: seed.chosenProduct.path },
  { name: "collection", path: seed.pinnedCollection.path },
  { name: "journal", path: "/journal" },
  { name: "redirected-post", path: `/journal/${seed.redirect.from}` },
];

// What a shopper sees on each canary, in Chrome. Screenshots <name>-<label>-1440.
export async function lookAtCanaries(drill, base, seed, label, unit = "p4-drills-cutover") {
  const ctx = await shopperContext(drill, base, unit);
  const page = await ctx.newPage();
  const seen = {};
  for (const c of CANARIES(seed)) {
    await page.goto(`${base}${c.path}`, { waitUntil: "load" });
    await settle(page);
    await noThanks(page);
    if (c.name === "product") await page.locator("[data-pdp-template]").first().waitFor({ state: "visible", timeout: 90_000 });
    if (c.name === "collection") await page.locator("[data-collection-template]").first().waitFor({ state: "visible", timeout: 90_000 });
    seen[c.name] = await page.evaluate(() => ({
      path: location.pathname,
      text: (document.querySelector("main")?.innerText || document.body.innerText).replace(/\s+/g, " ").trim(),
      markers: [...document.querySelectorAll("[data-sec],[data-pdp-template],[data-collection-template]")].map((e) => [e.getAttribute("data-sec"), e.getAttribute("data-pdp-template"), e.getAttribute("data-collection-template")].join("|")).filter((m) => !/^i-\d+\|\||^sec_/.test(m)),
      modules: document.querySelectorAll('[data-sec="pdp-modules"] details').length,
      pairsTitle: document.querySelector('[data-sec="pdp-pairs"] h2')?.innerText?.trim() ?? null,
    }));
    await drill.screenshot(page, `${c.name}-${label}-1440`);
  }
  await ctx.close();
  return seen;
}

export async function cutoverStage(drill) {
  const { seed } = await reseedP4(drill, { start: true });
  const ctx = await harnessContext();
  const scratch = drillScratch("cutover");
  drill.note(`store ${ctx.store}: its database ${ctx.urls.tenant}, the control plane ${ctx.urls.platform}; scratch ${scratch}`);
  await revokeAgency(drill, ctx);
  const routesFile = await makeRoutes(drill, ctx, scratch);

  // ---- the rehearsal, on a copy ----
  const copy = await copyServer(scratch);
  let r;
  try {
    r = await rehearse(drill, ctx, { copy, routesFile, out: join(scratch, "rehearsal"), label: "rehearsal" });
    const copyMode = (await sqlAt(copy.url, ["SELECT mode FROM cms_state WHERE id = 1"]))[0].rows[0]?.mode;
    drill.check(copyMode === "documents", "the rehearsal moved the copy to the new editor", { copyMode });
  } finally {
    await copy.stop();
  }
  drill.check(r.reh.code === 0 && r.rep?.passed === true && /Result: passed/.test(r.reh.out), "the rehearsal on the copy passes (the move on the copy, then the page comparison): 'Result: passed'", { exit: r.reh.code, render: { same: r.rep?.render?.same, compared: r.rep?.render?.compared, canariesOk: r.rep?.render?.canariesOk, allowed: r.rep?.render?.allowed }, dataCheck: r.rep?.dataCheck, tail: r.reh.out.trim().split("\n").slice(-3) });
  drill.check(r.rep?.render?.compared > 20 && r.rep?.render?.canariesOk === true, "the rehearsal compared every route, and every canary loaded before the move", { compared: r.rep?.render?.compared, canaries: r.rep?.render?.canaries });
  drill.check(r.untouched, "the store's own database is untouched by its rehearsal", { before: r.before, after: r.after });
  const row = (await sqlAt(ctx.urls.platform, [{ sql: "SELECT db_url FROM tenants WHERE id = ?", args: [ctx.store] }]))[0].rows[0];
  drill.check(row?.db_url === ctx.urls.tenant, "the store's row points at its own database again", row);

  // ---- before ----
  const before = await lookAtCanaries(drill, ctx.base, seed, "before");
  drill.check(before.product.markers.includes("|editorial|") && before.collection.markers.includes("||sidebar") && before.product.modules === 6 && before.product.pairsTitle === seed.chosenProduct.pairsTitle && before["redirected-post"].path === `/journal/${seed.redirect.to}`, "before: the chosen product (editorial, six modules, its own pairs title), the sidebar collection and the redirected post show", { product: before.product.markers.slice(0, 6), modules: before.product.modules, pairs: before.product.pairsTitle, redirect: before["redirected-post"].path });
  const capBefore = join(scratch, "real-before");
  const cb = await ctx.render(["--base", ctx.base, "--routes", routesFile, "--out", capBefore]);
  drill.check(cb.code === 0, "a shopper capture of every route before the move", cb.out.trim().split("\n").pop());

  // ---- the dry run and the move ----
  const dry = await ctx.migrate(["--tenant", ctx.store, "--dry-run"]);
  const digest = digestOf(dry.out);
  drill.check(dry.code === 0 && /^Ready to move/m.test(dry.out) && Boolean(digest), "the dry run says Ready to move and prints its digest", dry.out.split("\n")[0]);
  const plain = dry.out.split("\nDetails")[0];
  drill.check(!/\b(cms_|document_refs|product_content_live|rel_|doc_|ver_)\w*/.test(plain), "the dry run's plain part (above Details) names no table, id or code", plain.slice(0, 600));
  drill.note(`dry run (plain part):\n${plain.slice(0, 1500)}`);
  const mv = await ctx.migrate(["--tenant", ctx.store, "--dry-run-digest", String(digest), "--rehearsal", r.report]);
  drill.check(mv.code === 0 && /Your store now uses the new editor\./.test(mv.out), "the move (digest and rehearsal report as proofs) finishes: 'Your store now uses the new editor.'", mv.out.split("\nDetails")[0].slice(-1200));
  const state = (await sqlAt(ctx.urls.tenant, ["SELECT mode, cutover_release_id FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT step, outcome FROM cms_migration_runs"])).map((x) => x.rows);
  drill.check(state[0][0].mode === "documents" && state[0][0].cutover_release_id === seed.liveRelease && /^rel_mig_/.test(state[1][0].id) && state[2].length === 1 && state[2][0].outcome === "done", "the store is on the new editor: a v4 release live, the old live release recorded, one finished run", state);
  await sleep(1500);

  // ---- after ----
  const after = await lookAtCanaries(drill, ctx.base, seed, "after");
  for (const c of CANARIES(seed)) {
    const a = after[c.name];
    const b = before[c.name];
    const same = a.text === b.text && JSON.stringify(a.markers) === JSON.stringify(b.markers) && a.path === b.path;
    drill.check(same, `in Chrome, ${c.path} shows the same text, sections and templates before and after the move`, same ? { path: a.path, chars: a.text.length } : { before: b.text.slice(0, 400), after: a.text.slice(0, 400), mb: b.markers, ma: a.markers });
  }
  const capAfter = join(scratch, "real-after");
  await ctx.render(["--base", ctx.base, "--routes", routesFile, "--out", capAfter]);
  const cmp = await ctx.render(["--compare", capBefore, capAfter, "--json", join(scratch, "real-compare.json")]);
  drill.check(cmp.code === 0, "the shopper captures of every route before and after the real move compare the same", cmp.out.trim().split("\n").slice(-6).join(" | "));

  // ---- status, abort, the old editors, the console ----
  const st = await ctx.migrate(["--tenant", ctx.store, "--status"]);
  drill.check(st.code === 0 && /Your store uses the new editor\. No update is under way\./.test(st.out), "--status says the store uses the new editor", st.out.trim().split("\n")[0]);
  const ab = await ctx.migrate(["--tenant", ctx.store, "--abort"]);
  drill.check(ab.code === 1 && /nothing to stop/.test(ab.out), "--abort with nothing under way says so", ab.out.trim());
  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  const annBefore = (await sqlAt(ctx.urls.tenant, ["SELECT value FROM cms_blocks WHERE key = 'announcement'"]))[0].rows[0]?.value ?? null;
  const old = await page.evaluate(async () => {
    const r = await fetch("/api/admin/storefront", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ block: "announcement", value: { enabled: true, text: "Old editor save after the move" } }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const annAfter = (await sqlAt(ctx.urls.tenant, ["SELECT value FROM cms_blocks WHERE key = 'announcement'"]))[0].rows[0]?.value ?? null;
  drill.check(old.status === 409 && /new editor/i.test(String(old.body?.error || "")) && !/cms_|mode =|legacy/.test(String(old.body?.error || "")) && annAfter === annBefore, "an old editor's save after the move is refused in plain words (409), and nothing is written", { ...old, unchanged: annAfter === annBefore });
  await page.goto(consoleUrl(ctx.base, `/admin/storefront`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const landed = new URL(page.url());
  drill.check(landed.pathname === "/admin/editor", "the old Storefront screen opens the new editor", landed.pathname + landed.search);
  await page.locator("[data-document-editor]").first().waitFor({ timeout: 90_000 });
  await drill.screenshot(page, "editor-after-move-1440");
  await bctx.close();
}
