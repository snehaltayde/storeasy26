// PERF-04 drill: the pages the local baseline measures, seen in desktop Chrome
// on a production build of the harness with the perf fixture, so the numbers
// in docs/perf/ belong to real, whole pages (not error pages or empty shells).
//   node scripts/dev-design.js seed --fixture perf
//   DESIGN_PORT=3203 DESIGN_SQLD_PORT=18220 node scripts/drills/p1/prod-harness.mjs start   (after next build)
//   DESIGN_PORT=3203 node scripts/drills/p1/run.mjs perf04
import { buildPerfFixture } from "../../perf-fixture.js";
import { routesFor } from "../../perf-http.js";

export const id = "PERF-04";
export const title = "PERF-04: the measured pages, perf fixture, production build";

const fx = buildPerfFixture();
const routes = routesFor(fx.measured).filter((r) => !r.json);
// checkout needs the measured cart's cookie, so it has its own part
const pages = routes.filter((r) => r.key !== "checkout");

async function look(drill, page, route, width) {
  const res = await drill.open(page, route.path, { width });
  const f = await drill.facts(page);
  drill.check(res.status === 200, `${route.key} at ${width}: answers 200`, res.status);
  drill.check(res.headers["x-edge-runtime"] === "1", `${route.key} at ${width}: rendered on the edge runtime`, res.headers["x-edge-runtime"] ?? "header absent");
  drill.check(!f.errorPage, `${route.key} at ${width}: not an error page`);
  // Known (packet finding 1): under `next start`, Next's image optimizer
  // fetches a local image (/api/media/…) through a request with no Host
  // header, so the tenant can't be resolved and the photo comes back broken.
  // The baseline doesn't fetch images, so its numbers don't depend on this.
  drill.check(f.brokenImages.length === 0, `${route.key} at ${width}: no broken images`, f.brokenImages, { known: f.images ? "finding 1" : undefined });
  for (const e of route.expect || []) drill.check(f.text.includes(e) || f.text.toLowerCase().includes(e.toLowerCase()), `${route.key} at ${width}: shows "${e}"`);
  return f;
}

export const parts = {
  async pages(drill) {
    const context = await drill.context();
    const page = await context.newPage();
    for (const route of pages) {
      const f = await look(drill, page, route, 1440);
      if (route.key === "home") {
        const sections = await page.locator("[data-sec]").count();
        drill.check(sections >= fx.homeSections.length + 1, `home: the hero and all ${fx.homeSections.length} fixture sections render`, `${sections} [data-sec] elements`);
      }
      if (route.key === "collection-all") {
        const cards = await page.locator('a[href^="/products/"]').count();
        drill.check(cards >= 48, "shop all: a full first page of products", `${cards} product links`);
        drill.note(`shop all at 1440: ${cards} product links on the first page`);
      }
      if (route.key === "product") {
        const pairs = await page.getByText("Pairs well with").count();
        drill.check(pairs > 0, "product: the pairs list shows");
      }
      drill.note(`${route.key} at 1440: ${f.images} images, ${f.scrollWidth}px wide in a ${f.viewport}px window`);
      await drill.shoot(page, `${route.key}-1440`);
    }
    for (const key of ["home", "product", "collection-all"]) {
      const route = routes.find((r) => r.key === key);
      await look(drill, page, route, 375);
      await drill.shoot(page, `${key}-375`);
    }
    await context.close();
  },

  async checkout(drill) {
    const context = await drill.context();
    await context.addCookies([{ name: "cart_session", value: fx.measured.cart.id, url: drill.baseUrl }]);
    const page = await context.newPage();
    const route = routes.find((r) => r.key === "checkout");
    await look(drill, page, route, 1440);
    const body = await page.locator("body").innerText();
    for (const line of fx.measured.cart.lines) {
      const p = fx.products.find((x) => x.id === line.productId);
      drill.check(body.includes(p.title), `checkout lists "${p.title}" from the measured cart`);
    }
    await drill.shoot(page, "checkout-1440");
    await context.close();
  },
};
