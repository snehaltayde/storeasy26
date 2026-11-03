// P1-DRILLS-C · PERF-04 drills still needed (docs/cms-reviews/P1-PERF-04.md, 1 and 3),
// on a harness seeded with the perf fixture:
//   DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js seed --fixture perf
//   DESIGN_PORT=3231 DESIGN_SQLD_PORT=18320 node scripts/dev-design.js          (next dev)
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs perf04c
// Parts
//   c-console     sign in and open Catalog (products and collections), Pages
//                 (pages and journal posts), Media, Offers and Publishing: each
//                 loads the fixture's data with no error page; load times recorded
//   c-images-dev  finding 1 under next dev: a fixture product with photos and a
//                 content page with an image section; do the photos show?
import { rows } from "../p1/db.mjs";
import { text, sleep } from "../p1/util.mjs";

export const id = "PERF-04";
export const title = "P1-DRILLS-C: PERF-04 drills still needed (perf fixture)";

async function timedOpen(drill, page, path) {
  const t0 = Date.now();
  const res = await page.goto(path, { waitUntil: "load", timeout: 180_000 });
  const tLoad = Date.now() - t0;
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  const tIdle = Date.now() - t0;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n ? { ttfb: Math.round(n.responseStart), domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transfer: n.transferSize } : null;
  });
  const t = await text(page);
  return { status: res?.status() ?? 0, tLoad, tIdle, nav, text: t, errorPage: /This page hit an error|Something went wrong|404 — not found/.test(t) };
}

export const parts = {
  async "c-console"(drill) {
    const counts = {
      products: Number((await rows("tenant", "SELECT count(*) n FROM products"))[0].n),
      collections: Number((await rows("tenant", "SELECT count(*) n FROM collections"))[0].n),
      pages: Number((await rows("tenant", "SELECT count(*) n FROM cms_pages"))[0].n),
      journal: Number((await rows("tenant", "SELECT count(*) n FROM cms_pages WHERE family = 'journal'").catch(() => [{ n: -1 }]))[0].n),
      media: Number((await rows("tenant", "SELECT count(*) n FROM media WHERE parent_id IS NULL").catch(() => [{ n: -1 }]))[0].n),
      offers: Number((await rows("tenant", "SELECT count(*) n FROM offers").catch(() => [{ n: -1 }]))[0].n),
    };
    drill.note(`the fixture in the local DB: ${JSON.stringify(counts)}`);
    drill.check(counts.products === 400 && counts.collections === 30 && counts.pages === 85 && counts.media === 32, "setup: the harness holds the perf fixture (400 products, 30 collections, 85 pages, 32 media)", counts);
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    const timings = {};
    const titles = async (sql) => (await rows("tenant", sql)).map((r) => r.title);

    // Catalog: products (first page) and collections
    for (const run of ["first", "second"]) {
      const r = await timedOpen(drill, page, "/admin/catalog");
      timings[`catalog (${run} load)`] = { tLoad: r.tLoad, tIdle: r.tIdle, nav: r.nav };
      if (run === "second") continue;
      const firstProducts = await titles("SELECT title FROM products ORDER BY title LIMIT 30");
      const shownProducts = firstProducts.filter((t) => r.text.includes(t)).length;
      // the console has no collections list: Catalog's "Collection merchandising"
      // offers them in its handle field's suggestions and in its picker
      const colTitles = await titles("SELECT title FROM collections");
      const inSuggestions = await page.evaluate(() => document.querySelectorAll("#catalog-collections option").length);
      const t0 = Date.now();
      await page.getByRole("button", { name: "Choose…", exact: true }).first().click();
      const dlg = page.locator("dialog[open], [role='dialog']").last();
      await dlg.waitFor({ timeout: 15_000 }).catch(() => {});
      await sleep(1200);
      const page1 = await dlg.innerText().catch(() => "");
      const onFirstPage = colTitles.filter((t) => page1.includes(t)).length;
      let loads = 0;
      while ((await dlg.getByRole("button", { name: "Load more" }).count()) && loads < 5) {
        await dlg.getByRole("button", { name: "Load more" }).click();
        loads++;
        await sleep(1000);
      }
      const pickerText = await dlg.innerText().catch(() => "");
      drill.note(`the collection picker: ${onFirstPage} on its first page, "Load more" pressed ${loads} time(s)`);
      const inPicker = colTitles.filter((t) => pickerText.includes(t)).length;
      drill.note(`Catalog collections: ${inSuggestions} in the handle field's suggestions; the picker listed ${inPicker} of ${colTitles.length} titles ${Date.now() - t0} ms after the click`);
      await drill.shoot(page, "c-console-catalog-collection-picker");
      await page.keyboard.press("Escape");
      const shownCols = Math.max(inSuggestions, inPicker);
      drill.check(r.status === 200 && !r.errorPage, "Catalog opens with no error page", { status: r.status });
      drill.check(shownProducts >= 25, `Catalog lists the fixture's products (first page: ${shownProducts} of the 30 first titles)`, shownProducts);
      drill.check(inSuggestions === counts.collections && inPicker === counts.collections, `Catalog offers all ${counts.collections} collections (suggestions and picker)`, { inSuggestions, inPicker });
      await drill.open(page, "/admin/catalog");
      await drill.shoot(page, "c-console-catalog");
    }
    // Pages (content pages, campaigns and journal posts in one list)
    for (const run of ["first", "second"]) {
      const r = await timedOpen(drill, page, "/admin/storefront/pages");
      timings[`pages (${run} load)`] = { tLoad: r.tLoad, tIdle: r.tIdle, nav: r.nav };
      if (run === "second") continue;
      const all = await titles("SELECT title FROM cms_pages");
      const journal = await titles("SELECT title FROM cms_pages WHERE family = 'journal'").catch(() => []);
      const shown = all.filter((t) => r.text.includes(t)).length;
      const shownJournal = journal.filter((t) => r.text.includes(t)).length;
      drill.check(r.status === 200 && !r.errorPage, "Pages opens with no error page", { status: r.status });
      drill.check(shown === all.length, `Pages lists all ${all.length} pages`, shown);
      drill.check(journal.length > 0 && shownJournal === journal.length, `the journal's ${journal.length} posts are in the list`, shownJournal);
      await drill.shoot(page, "c-console-pages");
    }
    // Media
    for (const run of ["first", "second"]) {
      const r = await timedOpen(drill, page, "/admin/media");
      timings[`media (${run} load)`] = { tLoad: r.tLoad, tIdle: r.tIdle, nav: r.nav };
      if (run === "second") continue;
      const tiles = await page.evaluate(() => document.querySelectorAll('main img[src*="/api/media/"]').length);
      const broken = await page.evaluate(() => [...document.querySelectorAll("main img")].filter((i) => i.complete && i.naturalWidth === 0).length);
      drill.check(r.status === 200 && !r.errorPage, "Media opens with no error page", { status: r.status });
      drill.check(tiles >= counts.media, `Media shows the library (${tiles} thumbnails for ${counts.media} files)`, tiles);
      drill.note(`Media: ${tiles} thumbnails, ${broken} broken`);
      await drill.shoot(page, "c-console-media");
    }
    // Offers
    for (const run of ["first", "second"]) {
      const r = await timedOpen(drill, page, "/admin/offers");
      timings[`offers (${run} load)`] = { tLoad: r.tLoad, tIdle: r.tIdle, nav: r.nav };
      if (run === "second") continue;
      const names = (await rows("tenant", "SELECT label AS name FROM offers").catch(() => [])).map((x) => x.name).filter(Boolean);
      const shown = names.filter((t) => r.text.includes(t)).length;
      drill.check(r.status === 200 && !r.errorPage, "Offers opens with no error page", { status: r.status });
      drill.check(shown === names.length, `Offers lists all ${names.length} named offers`, shown);
      await drill.shoot(page, "c-console-offers");
    }
    // Publishing
    for (const run of ["first", "second"]) {
      const r = await timedOpen(drill, page, "/admin/releases");
      timings[`publishing (${run} load)`] = { tLoad: r.tLoad, tIdle: r.tIdle, nav: r.nav };
      if (run === "second") continue;
      drill.check(r.status === 200 && !r.errorPage && r.text.includes("What will publish"), "Publishing opens with no error page", { status: r.status });
      await drill.shoot(page, "c-console-publishing");
    }
    drill.note(`load times, ms (tLoad: to the load event; tIdle: to network quiet; nav: the browser's own timing): ${JSON.stringify(timings)}`);
    await ctx.close();
  },

  async "c-images-dev"(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    const imgs = [];
    page.on("response", (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith("/_next/image") || p.startsWith("/api/media/")) imgs.push({ path: p + new URL(r.url()).search.slice(0, 60), status: r.status(), type: r.headers()["content-type"] || "" });
    });
    // a content page with an image section, from the fixture
    const pages = await rows("tenant", "SELECT slug, family, sections FROM cms_pages").catch(() => []);
    const withImage = pages.find((p) => /"(kind|type)":"image/.test(p.sections || "") && /\/api\/media\//.test(p.sections || ""));
    const targets = [["product", "/products/micronised-creatine-12"]];
    if (withImage) targets.push(["content-page", withImage.family === "journal" ? `/journal/${withImage.slug}` : `/policies/${withImage.slug}`]);
    else drill.note("no content page with a library image section found in the fixture");
    for (const [key, path] of targets) {
      imgs.length = 0;
      const res = await drill.open(page, path, { width: 1440 });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(1500);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const f = await drill.facts(page);
      const photos = await page.evaluate(() => [...document.querySelectorAll("main img")].map((i) => ({ src: i.currentSrc.slice(0, 90), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })));
      drill.note(`${key} ${path}: ${res.status}; ${photos.filter((p) => p.ok).length} of ${photos.length} images drawn; image requests ${JSON.stringify(imgs.slice(0, 8))}`);
      drill.check(res.status === 200 && !f.errorPage, `${key}: ${path} answers 200 with no error page`, res.status);
      drill.check(photos.length > 0 && photos.every((p) => p.ok), `${key}: every photo shows under next dev`, photos.filter((p) => !p.ok).slice(0, 4));
      await drill.shoot(page, `c-images-dev-${key}`);
    }
    await ctx.close();
  },
};
