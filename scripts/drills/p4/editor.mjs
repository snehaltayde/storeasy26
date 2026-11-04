// P4-EDITOR drill (OVL-04, OVL-01, OVL-06, ED-12): the product editor in
// desktop Chrome on the design harness, on the phase 3 seed (a documents
// store made by the harness's local takeOver), signed in as the owner, 1440 px.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p4/editor.mjs [--headed]
//
//   rename    open a product from the editor's product list, type a new name,
//             see "Differs from Shopify" and "Shopify title: …", publish
//   shopper   a fresh browser (no console cookie): the product page, the card
//             in search results and on a collection page, storefront search
//             by the new name, and the cart all show the new name
//   pickers   another product's "Goes well with" and a collection's pinned
//             products: the renamed product shows its new name with
//             "Shopify title: …" under it (the refs read's shopify_title)
//   reset     "Reset to Shopify" on the name, publish: the shopper sees
//             Shopify's name again and search no longer finds the new one
// Results: docs/cms-reviews/drills/P4-EDITOR/results-editor.json, with screenshots.
// No test order is placed (the cart is only filled, then emptied).
import { DrillError, reseed, runDrill, settle, storeSql, storeUrl, noThanks } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30_000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(step);
  }
  return false;
}
const rowsOf = (r) => r.rows.map((x) => ({ ...x }));
const saveStatus = (page) => page.locator("[data-save-status]").first().getAttribute("data-save-status").catch(() => null);
const NEW_NAME = "Aurora Drill Tonic";
// the search page streams: wait for its results line ("N products")
async function searchFor(sp, drill, q) {
  await sp.goto(storeUrl(drill, "live", `/search?q=${encodeURIComponent(q)}`), { waitUntil: "load", timeout: 120_000 });
  await sp.locator("main h1", { hasText: "Results for" }).waitFor({ timeout: 60_000 });
  await sp.locator("main p", { hasText: /^\d+ products?$/ }).first().waitFor({ timeout: 60_000 });
  return sp.locator("main").innerText();
}

async function publishHere(page) {
  await page.locator("[data-publish] button", { hasText: "Publish" }).first().click();
  await page.waitForSelector('[data-publish][data-phase="review"]', { timeout: 30_000 });
  await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 30_000);
  await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  await waitFor(async () => (await page.locator('[data-publish][data-phase="done"], [data-publish][data-phase="blocked"], [data-publish][data-phase="refused"], [data-publish][data-phase="error"]').count()) > 0, 45_000);
  return page.locator("[data-publish][data-phase]").getAttribute("data-phase").catch(() => null);
}
async function waitSaved(page) {
  return waitFor(async () => (await saveStatus(page)) === "saved", 30_000);
}

async function pickInto(page, groupSelector, query) {
  const group = page.locator(groupSelector).first();
  await group.getByRole("button", { name: /Choose products|Change the products/ }).click();
  const dlg = page.locator("dialog[open]").last();
  await dlg.getByRole("searchbox").fill(query);
  const row = dlg.locator('ul[aria-label="Synced products"] li').filter({ hasText: query }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.locator("button, input[type=checkbox], label").first().click();
  await dlg.getByRole("button", { name: /^Confirm/ }).click();
  await group.locator("[data-pick-title]").filter({ hasText: query }).first().waitFor({ timeout: 30_000 });
  return group;
}

async function editor(drill) {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));

  const [prodRows] = await storeSql("live", ["SELECT p.id, p.handle, p.title FROM products p WHERE p.available = 1 AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.available = 1) AND EXISTS (SELECT 1 FROM collection_products cp WHERE cp.product_id = p.id) ORDER BY p.title, p.id LIMIT 2"]);
  const [product, other] = rowsOf(prodRows);
  if (!product || !other) throw new DrillError("the seeded store has no two available products in a collection");
  const [colRows] = await storeSql("live", [{ sql: "SELECT c.id, c.handle, c.title FROM collections c JOIN collection_products cp ON cp.collection_id = c.id WHERE cp.product_id = ? ORDER BY cp.position LIMIT 1", args: [product.id] }]);
  const collection = rowsOf(colRows)[0];

  // ---- rename, from the editor's product list ----
  await page.goto("/admin/editor", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-switcher-toggle]").click();
  await page.locator("[data-switcher-search]").fill(product.title.slice(0, 12));
  const row = page.locator(`[data-switcher-product="${product.id}"]`);
  await row.waitFor({ timeout: 30_000 });
  const counts = await page.locator("[data-product-counts]").innerText().catch(() => "");
  drill.check(/^Products \d+ · Changed in Shopify \d+ · No longer in Shopify \d+$/.test(counts.trim()), "rename: the shell shows the Products count and the two filter counts", { counts });
  await row.click();
  await page.waitForURL((u) => u.searchParams.get("product") === product.id, { timeout: 60_000 });
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  const shopLine = await page.locator("[data-shopify-title]").innerText();
  drill.check(shopLine.trim() === `Shopify title: ${product.title}`, "rename: the product opens from the product list, with 'Shopify title: …' shown", { shopLine });
  await page.locator("#f-doc-title").fill(NEW_NAME);
  await waitSaved(page);
  const differs = await page.locator('[data-overlay="title"] [data-differs]').count();
  const heading = await page.locator("[data-product-heading]").innerText();
  drill.check(differs === 1 && heading.trim() === NEW_NAME && (await page.locator("[data-shopify-title]").innerText()).trim() === `Shopify title: ${product.title}`, "rename: the new name saves; 'Differs from Shopify' and Shopify's name show beside it", { heading, differs });
  await drill.screenshot(page, "editor-renamed-1440");
  const phase = await publishHere(page);
  const [liveRows] = await storeSql("live", [{ sql: "SELECT title FROM product_content_live WHERE product_id = ?", args: [product.id] }]);
  drill.check(phase === "done" && rowsOf(liveRows)[0]?.title === NEW_NAME, "rename: Publish goes live (the product's live row holds the new name)", { phase, live: rowsOf(liveRows)[0] });
  await drill.screenshot(page, "editor-renamed-published-1440");

  // ---- the shopper ----
  const shopCtx = await drill.context({ width: 1440 });
  const sp = await shopCtx.newPage();
  await sp.goto(storeUrl(drill, "live", `/products/${product.handle}`), { waitUntil: "load", timeout: 120_000 });
  await noThanks(sp);
  const h1 = (await sp.locator("h1").first().innerText()).trim();
  drill.check(h1 === NEW_NAME, "shopper: the product page shows the new name", { h1 });
  await drill.screenshot(sp, "shopper-product-page-1440");
  const word = NEW_NAME.split(" ")[1];
  const searchText = await searchFor(sp, drill, word);
  const searchCard = sp.locator(`main a[href="/products/${product.handle}"]`).first();
  drill.check(searchText.includes(NEW_NAME) && (await searchCard.count()) === 1, "shopper: storefront search finds it by its new name, and its card shows the new name", { found: searchText.includes(NEW_NAME) });
  await drill.screenshot(sp, "shopper-search-1440");
  if (collection) {
    await sp.goto(storeUrl(drill, "live", `/collections/${collection.handle}`), { waitUntil: "load", timeout: 120_000 });
    const card = sp.locator(`a[href="/products/${product.handle}"]`).first();
    const cardText = (await card.count()) ? await card.innerText() : "";
    const colText = await sp.locator("main").innerText();
    drill.check(cardText.includes(NEW_NAME) || (colText.includes(NEW_NAME) && !colText.includes(product.title)), "shopper: the product's card on its collection page shows the new name", { collection: collection.handle, cardText: cardText.slice(0, 120) });
  }
  await sp.goto(storeUrl(drill, "live", `/products/${product.handle}`), { waitUntil: "load", timeout: 120_000 });
  await noThanks(sp);
  const posted = sp.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await sp.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const added = await posted;
  const drawer = sp.locator('[role="dialog"][aria-label="Shopping cart"]');
  await waitFor(async () => (await drawer.innerText()).includes(NEW_NAME), 20_000);
  await sp.waitForTimeout(800);
  const cartText = await drawer.innerText().catch(() => "");
  const cartJson = await sp.evaluate(async () => (await fetch("/api/cart")).json());
  const line = (cartJson.items || []).find((i) => i.title === NEW_NAME);
  drill.check(added.status() === 200 && cartText.includes(NEW_NAME) && !cartText.includes("Shopify title") && Boolean(line) && !("catalog_title" in line), "shopper: the cart (drawer and the cart the browser gets) shows the new name, never Shopify's", { status: added.status(), drawer: cartText.slice(0, 200), line });
  await drill.screenshot(sp, "shopper-cart-1440");
  await sp.evaluate(async () => {
    const c = await (await fetch("/api/cart")).json();
    for (const it of c.items || []) await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", variantId: it.variantId }) });
  });
  const shopperHtml = await sp.content();
  drill.check(!/Differs from Shopify|Same as Shopify|Reset to Shopify/.test(shopperHtml), "shopper: no editor-only words on the shopper's pages", null);

  // ---- the pickers show the new name, with Shopify's under it ----
  await page.goto(`/admin/editor?product=${encodeURIComponent(other.id)}`, { waitUntil: "load", timeout: 120_000 });
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  const pairs = await pickInto(page, "[data-pairs-control]", NEW_NAME);
  const pairTitle = (await pairs.locator("[data-pick-title]").first().innerText()).trim();
  const pairShop = (await pairs.locator("[data-pick-shopify]").first().innerText().catch(() => "")).trim();
  drill.check(pairTitle.endsWith(NEW_NAME) && pairShop === `Shopify title: ${product.title}`, "pickers: in another product's Goes well with, the renamed product shows its new name with 'Shopify title: …' under it", { pairTitle, pairShop });
  await drill.screenshot(page, "editor-pairs-renamed-1440");
  await waitSaved(page);
  if (collection) {
    await page.goto(`/admin/editor?collection=${encodeURIComponent(collection.id)}`, { waitUntil: "load", timeout: 120_000 });
    await page.locator("[data-collection-form]").waitFor({ timeout: 90_000 });
    const pins = await pickInto(page, "[data-product-picks]", NEW_NAME);
    const pinTitle = (await pins.locator("[data-pick-title]").filter({ hasText: NEW_NAME }).first().innerText()).trim();
    const pinShop = (await pins.locator("li", { hasText: NEW_NAME }).locator("[data-pick-shopify]").first().innerText().catch(() => "")).trim();
    drill.check(pinTitle.endsWith(NEW_NAME) && pinShop === `Shopify title: ${product.title}`, "pickers: in a collection's pinned products, the renamed product shows its new name with 'Shopify title: …' under it", { pinTitle, pinShop });
    await drill.screenshot(page, "editor-pins-renamed-1440");
    await waitSaved(page);
  }

  // ---- reset ----
  await page.goto(`/admin/editor?product=${encodeURIComponent(product.id)}`, { waitUntil: "load", timeout: 120_000 });
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  await page.locator('[data-reset="title"]').click();
  await waitSaved(page);
  const following = await waitFor(async () => (await page.locator('[data-overlay="title"] [data-same]').count()) === 1 && (await page.locator("#f-doc-title").inputValue()) === product.title, 20_000);
  drill.check(Boolean(following), "reset: 'Reset to Shopify' puts Shopify's name back, 'Same as Shopify'", null);
  const phase2 = await publishHere(page);
  const [after] = await storeSql("live", [{ sql: "SELECT title FROM product_content_live WHERE product_id = ?", args: [product.id] }]);
  const liveTitle = rowsOf(after)[0]?.title ?? null;
  await sp.goto(storeUrl(drill, "live", `/products/${product.handle}`), { waitUntil: "load", timeout: 120_000 });
  const h1b = (await sp.locator("h1").first().innerText()).trim();
  const search2 = await searchFor(sp, drill, word);
  drill.check(phase2 === "done" && liveTitle == null && h1b === product.title && !search2.includes(NEW_NAME), "reset: published, the shopper sees Shopify's name again and search no longer finds the new one", { phase2, liveTitle, h1b });
  await drill.screenshot(sp, "shopper-after-reset-1440");
  drill.check(errors.length === 0, "no page errors in the console", { errors: errors.slice(0, 5) });
}

process.exitCode = await runDrill({ id: "P4-EDITOR", part: "editor", title: "P4-EDITOR — rename, publish, shopper, pickers, reset" }, editor);
