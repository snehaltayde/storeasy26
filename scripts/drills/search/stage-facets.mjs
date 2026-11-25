// drill:search stage "facets" (Phase 7 line 2, docs/plans/phase-7.md "Drill
// search"): the anonymous shopper filters search results.
//   desktop 1280x900: page 2, two product types (OR), a brand, size M, the
//     price form, sort, a chip removed, Back restores the filters
//   phone 390x844: "Filters (1)" opens the sheet, focus stays inside, Escape
//     closes it, a value picked inside keeps it open, "Show N products"
//   the empty state, then "Clear all filters"
// Seeding (this stage's own state): the roles store has too few products and
// no options, so 30 products with sizes are written straight into its own
// database (products and variants, as the sync writes them), and the owner
// publishes a home page (and the design) through the documents API so the
// store is open. Every expected count comes from the same seed model below.
// Selectors are data-* hooks and exact names; every wait is for an element,
// a URL or a text, never a fixed time.
import { ORIGIN, docsApi, open, rolesSql, shopper, signIn, stage, stubImages } from "./lib.mjs";

const N = 30;
const TYPES = ["Tee", "Hoodie", "Cap"];
const SIZES = [["S", "M"], ["M"], ["L"], ["M", "L"], ["S"]];
const MODEL = Array.from({ length: N }, (_, i) => {
  const n = i + 1;
  return { n, handle: `facet-drill-${n}`, type: TYPES[n % 3], vendor: n % 2 ? "Acme" : "Bolt", sizes: SIZES[n % 5], price: 100 + n * 10 };
});
const expect = ({ types = [], vendors = [], sizes = [], min = null, max = null } = {}) =>
  MODEL.filter((p) => (!types.length || types.includes(p.type)) && (!vendors.length || vendors.includes(p.vendor)) && (!sizes.length || p.sizes.some((s) => sizes.includes(s))) && (min == null || p.price >= min) && (max == null || p.price <= max));
const plural = (n) => `${n} ${n === 1 ? "product" : "products"}`;

async function seed(drill) {
  const stmts = [];
  for (const p of MODEL) {
    const id = `gid://shopify/Product/77${String(p.n).padStart(4, "0")}`;
    stmts.push({
      sql: "INSERT OR REPLACE INTO products (id, handle, title, description, product_type, vendor, tags, price_min, price_max, currency, available, total_inventory, featured_image, options, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', 1, 10, NULL, ?, ?, ?, ?)",
      args: [id, p.handle, `Facet drill ${p.n}`, "A drill product.", p.type, p.vendor, JSON.stringify(["drill-internal-tag"]), p.price, p.price, JSON.stringify([{ name: "Size", values: p.sizes }]), `2026-02-${String(p.n % 28 + 1).padStart(2, "0")}T00:00:00Z`, "2026-02-01T00:00:00Z", new Date().toISOString()],
    });
    p.sizes.forEach((s, k) =>
      stmts.push({
        sql: "INSERT OR REPLACE INTO variants (id, product_id, title, sku, price, currency, available, selected_options, position) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?, ?)",
        args: [`${id}-v${k}`, id, s, `FD-${p.n}-${s}`, p.price, JSON.stringify([{ name: "Size", value: s }]), k],
      }),
    );
  }
  await rolesSql(stmts);

  // the store opens with its first publish (a home page, and the design)
  const owner = await signIn(drill, "owner");
  await stubImages(owner.context());
  await open(owner, "/admin");
  let home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  if (!home) {
    const made = await docsApi(owner, { createDocument: { type: "home", body: { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_searchdrl1", kind: "new", v: 1, enabled: true, settings: { title: "New arrivals", limit: 8 }, blocks: [] }] } } });
    drill.check(made.status === 200, "seed: a home page is made", made.body?.error);
    home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  }
  let design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  if (!design) {
    await docsApi(owner, { createDocument: { type: "design", body: { schema: 1, type: "design", meta: {}, settings: { brand: null, theme: null, logo: null } } } });
    design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  }
  const set = [];
  if (home && home.draftHash !== home.publishedHash) set.push({ id: "doc_home", revision: home.revision, draftHash: home.draftHash });
  if (design && design.draftHash !== design.publishedHash) set.push({ id: "doc_design", revision: design.revision, draftHash: design.draftHash });
  if (set.length) {
    const pub = await docsApi(owner, { publishSet: set });
    drill.check(pub.status === 200, "seed: the home page (and the design) are live, so the store is open", pub.body?.error || pub.body?.code);
  }
  await owner.context().close();
}

const countText = (page) => page.locator("[data-search-count]").innerText();
async function countIs(page, n) {
  await page.waitForFunction((want) => document.querySelector("[data-search-count]")?.textContent?.trim() === want, plural(n));
}
const cards = (page) => page.locator('main a[href^="/products/facet-drill-"]').evaluateAll((els) => [...new Set(els.map((a) => a.getAttribute("href").split("/products/")[1]))]);
const rail = (page) => page.locator("aside[aria-label='Filters']");
async function pick(page, scope, group, value, urlRe) {
  await scope.locator(`[data-facet-group="${group}"] [data-facet-value="${value}"]`).click();
  await page.waitForURL(urlRe);
}

stage("facets", async (drill) => {
  await seed(drill);
  const BASE = "/search?q=facet+drill";

  // ---- desktop ----
  const page = await shopper(drill, { width: 1280, height: 900 });
  let r = await page.goto(ORIGIN + BASE, { waitUntil: "load" });
  drill.check(r?.status() === 200, "desktop: /search answers 200", r?.status());
  await countIs(page, N);
  drill.check((await cards(page)).length === 24, "desktop: 24 products on page 1", (await cards(page)).length);
  drill.check((await page.locator("[data-facet-group]").count()) >= 3, "desktop: type, brand and size groups show");
  drill.check((await page.locator("[data-facet-value='drill-internal-tag']").count()) === 0 && !(await page.content()).includes("drill-internal-tag"), "desktop: the products' tags are nowhere on the page");
  await page.locator("[data-search-pages]").getByRole("link", { name: "2", exact: true }).click();
  await page.waitForURL(/page=2/);
  await page.locator('[data-search-pages] [aria-current="page"]', { hasText: "2" }).waitFor();
  drill.check((await cards(page)).length === N - 24, "desktop: page 2 lists the last 6", (await cards(page)).length);
  await drill.shoot(page, "desktop-page-2");

  await page.goto(ORIGIN + BASE, { waitUntil: "load" });
  await countIs(page, N);
  await pick(page, rail(page), "type", "Tee", /type=Tee/);
  await countIs(page, expect({ types: ["Tee"] }).length);
  await pick(page, rail(page), "type", "Hoodie", /type=Tee&type=Hoodie/);
  const two = expect({ types: ["Tee", "Hoodie"] });
  await countIs(page, two.length);
  const teeCount = await rail(page).locator('[data-facet-group="type"] [data-facet-value="Tee"]').innerText();
  drill.check(teeCount.trim().endsWith(String(expect({ types: ["Tee"] }).length)), "desktop: OR within a group, and Tee's count ignores the type filter (disjunctive)", teeCount);

  await pick(page, rail(page), "vendor", "Acme", /vendor=Acme/);
  const acme = { types: ["Tee", "Hoodie"], vendors: ["Acme"] };
  await countIs(page, expect(acme).length);
  await pick(page, rail(page), "o:size", "M", /o=size%3AM/);
  const sized = { ...acme, sizes: ["M"] };
  await countIs(page, expect(sized).length);
  drill.check(JSON.stringify((await cards(page)).sort()) === JSON.stringify(expect(sized).map((p) => p.handle).sort()), "desktop: AND across groups: Tee or Hoodie, Acme, size M", { got: await cards(page), want: expect(sized).map((p) => p.handle) });

  const price = page.locator("aside [data-facet-price]");
  await price.locator('input[name="min"]').fill("150");
  await price.locator('input[name="max"]').fill("300");
  await price.getByRole("button", { name: "Apply price" }).click();
  await page.waitForURL(/min=150.*max=300|max=300.*min=150/);
  const priced = { ...sized, min: 150, max: 300 };
  await countIs(page, expect(priced).length);
  drill.check((await page.locator('[data-chip="Price: 150 – 300"]').count()) === 1, "desktop: the price form applies, with its chip");

  await page.locator("[data-search-sort] select").selectOption("price-desc");
  await page.waitForURL(/sort=price-desc/);
  await countIs(page, expect(priced).length);
  const dear = expect(priced).sort((a, b) => b.price - a.price)[0]?.handle;
  drill.check((await cards(page))[0] === dear, "desktop: Price high to low puts the dearest first", { first: (await cards(page))[0], want: dear });
  await drill.shoot(page, "desktop-filtered");

  const chips = await page.locator("[data-chip]").count();
  await page.locator('[data-chip="Acme"]').click();
  await page.waitForURL((u) => !u.search.includes("vendor="));
  const noAcme = { types: ["Tee", "Hoodie"], sizes: ["M"], min: 150, max: 300 };
  await countIs(page, expect(noAcme).length);
  drill.check((await page.locator("[data-chip]").count()) === chips - 1 && (await page.locator('[data-chip="Acme"]').count()) === 0, "desktop: removing the Acme chip removes only that filter");
  await page.goBack();
  await page.waitForURL(/vendor=Acme/);
  await countIs(page, expect(priced).length);
  drill.check((await page.locator('[data-chip="Acme"]').count()) === 1, "desktop: Back restores the filters", await countText(page));
  await page.context().close();

  // ---- phone ----
  const phone = await shopper(drill, { width: 390, height: 844 });
  await phone.goto(ORIGIN + `${BASE}&type=Tee`, { waitUntil: "load" });
  await countIs(phone, expect({ types: ["Tee"] }).length);
  const opener = phone.locator("[data-facet-sheet-open]");
  drill.check((await opener.innerText()).trim() === "Filters (1)", "phone: the button says Filters (1)", await opener.innerText());
  drill.check(!(await rail(phone).isVisible()), "phone: no left rail");
  await opener.click();
  const sheet = phone.locator("[data-facet-sheet]");
  await sheet.waitFor({ state: "visible" });
  let outside = 0;
  for (let i = 0; i < 40; i++) {
    await phone.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    if (!(await phone.evaluate(() => Boolean(document.activeElement?.closest("[data-facet-sheet]"))))) outside++;
  }
  drill.check(outside === 0, "phone: focus stays inside the sheet through 40 Tab presses", outside);
  await phone.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  drill.check(await phone.evaluate(() => document.activeElement?.hasAttribute("data-facet-sheet-open")), "phone: Escape closes the sheet and focus goes back to its button");

  await opener.click();
  await sheet.waitFor({ state: "visible" });
  await pick(phone, sheet, "vendor", "Acme", /vendor=Acme/);
  const phoneWant = expect({ types: ["Tee"], vendors: ["Acme"] }).length;
  await phone.locator("[data-sheet-show]", { hasText: `Show ${plural(phoneWant)}` }).waitFor();
  drill.check(await sheet.isVisible(), "phone: picking a value keeps the sheet open with the new total");
  await drill.shoot(phone, "phone-sheet");
  await phone.locator("[data-sheet-show]").click();
  await sheet.waitFor({ state: "detached" });
  await countIs(phone, phoneWant);
  drill.check((await opener.innerText()).trim() === "Filters (2)", "phone: Show N products closes the sheet; the button says Filters (2)", await opener.innerText());
  await drill.shoot(phone, "phone-results");
  await phone.context().close();

  // ---- empty, then clear ----
  const empty = await shopper(drill, { width: 1280, height: 900 });
  await empty.goto(ORIGIN + `${BASE}&type=Nothing+like+this`, { waitUntil: "load" });
  await empty.locator("[data-search-empty]", { hasText: "No products match these filters." }).waitFor();
  await countIs(empty, 0);
  await drill.shoot(empty, "empty");
  await empty.getByRole("link", { name: "Clear all filters" }).click();
  await empty.waitForURL((u) => !u.search.includes("type="));
  await countIs(empty, N);
  drill.check(true, "empty state: Clear all filters brings every result back");
  await empty.context().close();
});
