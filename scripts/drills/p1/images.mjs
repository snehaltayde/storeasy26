// P1-IMAGES drill: library photos (/api/media/<id>) show on every storefront
// page that draws them, in desktop Chrome, on the harness with the perf fixture.
// Run it once under next dev (part "dev") and once on a production build
// (part "prod"); the checks are the same.
//   node scripts/dev-design.js seed --fixture perf
//   DESIGN_PORT=3261 DESIGN_SQLD_PORT=18310 node scripts/dev-design.js                         (next dev)
//   DESIGN_PORT=3261 node scripts/drills/p1/run.mjs images dev
//   DESIGN_PORT=3261 DESIGN_SQLD_PORT=18310 node scripts/drills/p1/prod-harness.mjs build
//   DESIGN_PORT=3261 DESIGN_SQLD_PORT=18310 node scripts/drills/p1/prod-harness.mjs start      (next start)
//   DESIGN_PORT=3261 node scripts/drills/p1/run.mjs images prod
// Each page: 200 with no error page, every image drawn (scrolled through, so
// lazy ones load), no 4xx/5xx from /_next/image or /api/media, and no library
// photo fetched through /_next/image.
import { buildPerfFixture } from "../../perf-fixture.js";
import { routesFor } from "../../perf-http.js";
import { rows } from "./db.mjs";
import { sleep } from "./util.mjs";

export const id = "IMAGES";
export const title = "P1-IMAGES: library photos on the storefront (perf fixture)";

const fx = buildPerfFixture();
const pages = routesFor(fx.measured).filter((r) => !r.json && r.key !== "checkout");

function watch(page) {
  const seen = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/_next/image") || u.pathname.startsWith("/api/media/")) {
      seen.push({ path: u.pathname + (u.search ? decodeURIComponent(u.search).slice(0, 70) : ""), status: r.status(), type: r.headers()["content-type"] || "" });
    }
  });
  return seen;
}

async function scrollThrough(page) {
  const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  for (let y = 0; y <= h; y += 600) {
    await page.evaluate((v) => window.scrollTo(0, v), y).catch(() => {});
    await sleep(120);
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 10_000); }))))).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

async function judge(drill, page, seen, key, label) {
  await scrollThrough(page);
  const imgs = await page.evaluate(() =>
    [...document.images].filter((i) => i.getAttribute("src")).map((i) => ({ src: i.currentSrc || i.src, ok: i.complete && i.naturalWidth > 0 })),
  );
  const local = imgs.map((i) => ({ ...i, path: new URL(i.src, page.url()).pathname }));
  const library = local.filter((i) => i.path.startsWith("/api/media/"));
  const viaOptimizer = local.filter((i) => i.path.startsWith("/_next/image") && /url=%2Fapi%2Fmedia|url=\/api\/media/.test(i.src));
  const bad = seen.filter((r) => r.status >= 400);
  drill.note(`${key}: ${imgs.filter((i) => i.ok).length} of ${imgs.length} images drawn (${library.length} library photos as /api/media); ${seen.length} image responses, ${bad.length} failed`);
  drill.check(imgs.length > 0 && imgs.every((i) => i.ok), `${label}: every image is drawn`, imgs.filter((i) => !i.ok).slice(0, 4));
  drill.check(library.length > 0, `${label}: library photos are on the page, as their own /api/media url`, library.length);
  drill.check(viaOptimizer.length === 0, `${label}: no library photo goes through /_next/image`, viaOptimizer.slice(0, 3));
  drill.check(bad.length === 0, `${label}: no 4xx or 5xx from /_next/image or /api/media`, bad.slice(0, 4));
}

function partFor(mode) {
  return async (drill) => {
    const m = Number((await rows("tenant", "SELECT count(*) n FROM media WHERE parent_id IS NULL"))[0].n);
    drill.check(m === 32, "setup: the harness holds the perf fixture's 32 library images", m);
    // The measured policy has no image section, so use a content page that has
    // one (it draws a plain <img>, not next/image: a control for the fix).
    const all = await rows("tenant", "SELECT slug, family, sections FROM cms_pages").catch(() => []);
    const withImage = all.find((p) => /"(kind|type)":"image/.test(p.sections || "") && /\/api\/media\//.test(p.sections || "") && p.family !== "journal");
    drill.check(Boolean(withImage), "setup: a content page with a library image section", withImage?.slug);
    const routes = pages.map((r) => (r.key === "cms-page" && withImage ? { ...r, path: `/policies/${withImage.slug}` } : r));
    for (const width of [1440, 375]) {
      const ctx = await drill.context({ width });
      const page = await ctx.newPage();
      const seen = watch(page);
      const list = width === 1440 ? routes : routes.filter((r) => ["home", "product", "collection"].includes(r.key));
      for (const route of list) {
        seen.length = 0;
        const res = await drill.open(page, route.path, { width });
        const f = await drill.facts(page);
        drill.check(res.status === 200 && !f.errorPage, `${route.key} at ${width}: ${route.path} answers 200 with no error page`, res.status);
        if (route.key === "journal") {
          // the journal index lists posts without photos; it is here for the 404s
          const bad = seen.filter((r) => r.status >= 400);
          drill.check(bad.length === 0, `journal at ${width}: no 4xx or 5xx from /_next/image or /api/media`, bad);
          continue;
        }
        await judge(drill, page, seen, `${route.key}-${width}`, `${route.key} at ${width}`);
        await drill.shoot(page, `${mode}-${route.key}-${width}`);
      }
      if (width === 1440) {
        // the cart drawer and checkout show the product's photo too
        const product = routes.find((r) => r.key === "product");
        await drill.open(page, product.path, { width });
        seen.length = 0;
        await page.getByRole("button", { name: /add to cart/i }).first().click();
        await sleep(2500);
        await judge(drill, page, seen, "cart-drawer", "cart drawer after Add to cart");
        await drill.shoot(page, `${mode}-cart-drawer-${width}`);
        seen.length = 0;
        const res = await drill.open(page, "/checkout", { width });
        drill.check(res.status === 200, "checkout answers 200", res.status);
        await judge(drill, page, seen, "checkout", "checkout with the cart");
        await drill.shoot(page, `${mode}-checkout-${width}`);
      }
      await ctx.close();
    }
  };
}

export const parts = { dev: partFor("dev"), prod: partFor("prod") };
