// P6-DRILLS stage E (US-04, GEN-01): a store whose Shopify catalog is empty.
// /admin/start says what to do in Shopify, the home page is the hero only; a
// second confirmed sync with products (seeded, the store kept) refills the
// untouched home when the founder opens the editor; and a store with products
// but no collections says so and gets a valid home of its newest products.
import { openStart } from "./brand.mjs";
import { LOGO_FACTS, P6_STORE, docOf, inP6, sleep, frameEval, frameText, liveRelease, loginP6, openEditor, p6Context, reseedP6, waitFor, watchErrors } from "./lib.mjs";

const kindsOf = (d) => (d?.body?.sections || []).map((s) => s.kind);

async function previewText(page) {
  return waitFor(async () => {
    const t = await frameText(page);
    return t.includes(P6_STORE.name) && t.length > 100 ? t : false;
  }, 90_000, 500);
}

export async function emptyStage(drill) {
  // ---- an empty catalog ----
  let seed = await reseedP6(drill, "e", { variant: "empty" });
  drill.check(seed.state.products === 0 && seed.state.latestSync.status === "complete", "the stage seed: a complete sync of an empty catalog (0 products)", seed.state);
  let ctx = await p6Context(drill);
  let errors = watchErrors(ctx);
  let page = await loginP6(drill, ctx);
  const state = await openStart(drill, page);
  const card = (await page.locator("[data-first-run]").innerText()).replace(/\s+/g, " ");
  const note = (await page.locator('[data-first-run-note="empty"]').innerText().catch(() => "")).replace(/\s+/g, " ");
  drill.check(state === "ready" && note.includes("Your Shopify store has no products yet. Add products in Shopify, then sync again.") && note.includes("product rows appear after your next sync"), "/admin/start explains 'Add products in Shopify, then sync again' and that rows come after the next sync", { state, note });
  drill.check(!/opening soon/i.test(card), "the made store never says 'opening soon'", card.slice(0, 200));
  await drill.screenshot(page, "e-empty-start-1440");
  const home1 = await docOf("doc_home");
  drill.check(home1?.updated_by === "system:first-run" && JSON.stringify(kindsOf(home1)) === JSON.stringify(["hero"]), "the home draft is the hero only (made by the generator)", kindsOf(home1));
  await openEditor(page, "?doc=doc_home");
  const t1 = await previewText(page);
  drill.check(Boolean(t1) && !/opening soon/i.test(String(t1)), "the preview shows the hero-only home", String(t1).slice(0, 200));
  await drill.screenshot(page, "e-empty-preview-1440");
  drill.check(errors.length === 0, "no page errors (empty catalog)", errors);
  await ctx.close();

  // ---- a second confirmed sync, with products: the untouched home refills ----
  seed = await reseedP6(drill, "e", { variant: "refill" });
  drill.check(seed.state.products === 24 && seed.state.latestSync.status === "complete" && seed.state.documents >= 2, "a second seeded sync (the store kept): 24 products, complete", seed.state);
  const before = await docOf("doc_home");
  drill.check(JSON.stringify(kindsOf(before)) === JSON.stringify(["hero"]), "before the founder comes back, the home is still the hero only (syncs don't make pages by themselves here)", kindsOf(before));
  ctx = await p6Context(drill);
  errors = watchErrors(ctx);
  page = await loginP6(drill, ctx);
  // the founder's own pages first: neither refills a home that already exists
  await openStart(drill, page);
  await openEditor(page, "?doc=doc_home");
  await sleep(1500);
  const untouched = await docOf("doc_home");
  drill.check(JSON.stringify(kindsOf(untouched)) === JSON.stringify(["hero"]) && untouched.revision === before.revision, "as built (finding P6D-2, an owner check): after a sync that is not the worker's (the seeded one, like the console's inline, the CLI's or the connect callback's), opening /admin/start or the editor leaves the hero-only home as it is: both only make a store that has no home yet, so only the worker's post-sync step refills it", { kinds: kindsOf(untouched), revision: untouched.revision });
  // the worker's own step after a completed sync (lib/platform/worker.js
  // catalog_sync -> firstRunAfterSync -> workerFirstRun.generate({ trigger: 'sync' })).
  // The harness has no Shopify, so the queued slice itself can't run; the
  // seeded sync above stands in for it and this is the step that follows.
  const W = await import("../../../lib/platform/worker.js");
  const ran = await inP6(() => W.workerFirstRun.generate({ trigger: "sync" }));
  drill.note(`the worker's post-sync step: ${JSON.stringify({ ran: ran?.ran, written: ran?.written, refilled: ran?.refilled, reason: ran?.reason })}`);
  const after = await waitFor(async () => {
    const d = await docOf("doc_home");
    return kindsOf(d).includes("product_rail") ? d : false;
  }, 30_000, 500);
  drill.check(Boolean(after) && after.updated_by === "system:first-run" && after.revision > before.revision && !after.published_version_id && (ran?.refilled || []).includes("doc_home"), "the worker's post-sync step refills the untouched home from the new catalog (rows added, still the generator's, still a draft)", { before: { kinds: kindsOf(before), revision: before.revision }, after: after ? { kinds: kindsOf(after), revision: after.revision } : null, refilled: ran?.refilled });
  await page.reload({ waitUntil: "load" });
  const t2 = await previewText(page);
  const rails = (after?.body?.sections || []).filter((s) => s.kind === "product_rail").map((s) => s.settings?.title).filter(Boolean);
  drill.check(Boolean(t2) && rails.length > 0 && rails.every((r) => String(t2).includes(r)), `the preview shows the refilled rows (${rails.join(", ")})`, String(t2).slice(0, 300));
  await drill.screenshot(page, "e-refilled-preview-1440");
  await openStart(drill, page);
  const card2 = (await page.locator("[data-first-run]").innerText()).replace(/\s+/g, " ");
  drill.check(card2.includes("rows for") && !card2.includes("no products yet"), "/admin/start now names the rows and no longer says the catalog is empty", card2.slice(0, 300));
  await drill.screenshot(page, "e-refilled-start-1440");
  drill.check((await liveRelease()) == null, "still closed: nothing published", null);
  drill.check(errors.length === 0, "no page errors (refill)", errors);
  await ctx.close();

  // ---- products, no collections ----
  seed = await reseedP6(drill, "e", { variant: "no-collections" });
  drill.check(seed.state.products === 24 && seed.state.collections === 0, "the stage seed: 24 products and no collections", seed.state);
  ctx = await p6Context(drill);
  errors = watchErrors(ctx);
  page = await loginP6(drill, ctx);
  const st3 = await openStart(drill, page);
  const note3 = (await page.locator('[data-first-run-note="no-collections"]').innerText().catch(() => "")).replace(/\s+/g, " ");
  drill.check(st3 === "ready" && note3.includes("Your products have no collections in Shopify yet") && note3.includes("newest products"), "/admin/start: 'Your products have no collections in Shopify yet, so your home page shows your newest products…'", note3);
  await drill.screenshot(page, "e-nocollections-start-1440");
  const home3 = await docOf("doc_home");
  const k3 = kindsOf(home3);
  drill.check(k3[0] === "hero" && k3.includes("new") && !k3.includes("collection_grid") && !k3.includes("product_rail"), "the home: a hero and the newest products (a \"new\" section), no collection rows or grid", k3);
  await openEditor(page, "?doc=doc_home");
  const t3 = await previewText(page);
  const f3 = await frameEval(page, LOGO_FACTS);
  const productCards = await frameEval(page, () => document.querySelectorAll('a[href^="/products/"]').length);
  drill.check(Boolean(t3) && productCards >= 4 && !/opening soon/i.test(String(t3)), `the preview is a valid home with products (${productCards} product links)`, String(t3).slice(0, 200));
  drill.check(f3 && f3.headerText.includes(P6_STORE.name), "the header still shows the store (no collection menu needed)", f3?.headerLinks);
  await drill.screenshot(page, "e-nocollections-preview-1440");
  drill.check(errors.length === 0, "no page errors (no collections)", errors);
  await ctx.close();
}
