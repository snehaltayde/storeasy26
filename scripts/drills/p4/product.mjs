// P4-DRILLS stages on a moved --p4 store (OVL-04, OVL-17, ED-12, MED-03):
// what the founder does to a product and a collection in the new editor, and
// what a shopper then sees, in desktop Chrome at 1440 px. Each stage starts
// from a fresh --p4 store moved to the new editor (movedP4Store: the
// rehearsal on a copy, the dry run, the move).
//
//   product        open a product from the editor's product list; rename it,
//                  give it a description of its own, a photo from the media
//                  library, a badge, a module, "goes well with" products and
//                  a template; publish. A shopper (a fresh browser) sees them
//                  on the product page, its card (search and its collection),
//                  the cart, the checkout, the confirmation and the order
//                  page; a cash on delivery test order (snehal@mediastic.in)
//                  is placed and cancelled at once. The console's order page
//                  shows the new name with "Shopify title: …" under it. Reset
//                  every field to Shopify's, publish: the shopper sees
//                  Shopify's again, and the order keeps the name it was
//                  bought under.
//   collection     a collection's pinned products and its template: the
//                  pinned product first and the chosen template, as a shopper
//   search-rename  a rename published in the browser: storefront search (the
//                  SQL path the harness uses) finds the new name and not the
//                  old one, and the product's search row is marked done. Then
//                  in THIS process only, against the harness store's database
//                  (inside withTenant, no server call): a second rename
//                  published and the search rows drained to a spy client (the
//                  Typesense values are dummies set in this process only: a
//                  localhost port nothing listens on and a fake key; the
//                  harness server keeps them blank). Last, Undo twice in the
//                  browser (Recently published): Shopify's name is back in search.
// No test order is left open; nothing is written to Shopify (the harness env
// blanks every Shopify value, and the stage refuses a store row that holds one).
import { join } from "node:path";
import { DrillError, movedP4Store, noThanks, pickInto, publishHere, rowsOf, searchFor, settle, shopperContext, sleep, sqlAt, waitFor, waitSaved, consoleUrl } from "./lib.mjs";

export const TEST_ORDER_EMAIL = "snehal@mediastic.in";
const NEW_NAME = "Aurora Drill Tonic";
const NEW_DESCRIPTION = "Our own words for this tonic: brewed in small batches.";
const NEW_BADGE = "Drill pick";
const MODULE_WORDS = "A module the founder wrote in the new editor.";

const one = async (url, sql, args = []) => rowsOf((await sqlAt(url, [{ sql, args }]))[0])[0] ?? null;

// A product a shopper can buy, in a collection, with no content of its own
// yet (no live row), not the seed's chosen product.
async function plainProduct(ctx, { not = [] } = {}) {
  const r = await sqlAt(ctx.urls.tenant, [
    {
      sql: `SELECT p.id, p.handle, p.title FROM products p
            WHERE p.available = 1
              AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.available = 1)
              AND EXISTS (SELECT 1 FROM collection_products cp WHERE cp.product_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM product_content_live l WHERE l.product_id = p.id)
              ${not.length ? `AND p.id NOT IN (${not.map(() => "?").join(",")})` : ""}
            ORDER BY p.title, p.id LIMIT 3`,
      args: not,
    },
  ]);
  return rowsOf(r[0]);
}

// Nothing in the store's row or the harness env could reach a real Shopify.
async function assertNoShopify(drill, ctx) {
  const row = (await sqlAt(ctx.urls.platform, [{ sql: "SELECT * FROM tenants WHERE id = ?", args: [ctx.store] }]))[0].rows[0] || {};
  const text = JSON.stringify(row);
  const found = [...text.matchAll(/"(shopify_[a-z_]*(?:domain|token|secret)[a-z_]*)\\?"\s*:\s*\\?"([^"\\]+)/gi)].map((m) => m[1]);
  const env = ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_STOREFRONT_TOKEN", "NEXT_PUBLIC_SHOPIFY_DOMAIN", "RAZORPAY_KEY_SECRET"].filter((k) => ctx.env[k]);
  drill.check(found.length === 0 && env.length === 0, "before the test order: the store's row and the harness env hold no Shopify domain, token or secret and no Razorpay secret (nothing can reach Shopify or a payment)", { found, env });
  if (found.length || env.length) throw new DrillError("refusing to place a test order: the harness store names a Shopify store or a payment secret");
}

async function openProduct(page, base, id) {
  await page.goto(consoleUrl(base, `/admin/editor?product=${encodeURIComponent(id)}`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  await page.locator("[data-product-heading]").waitFor({ timeout: 30_000 });
}

// Type into a rich text field's surface (a sandboxed same-origin frame).
async function typeRich(page, scope, text) {
  const frame = scope.locator("iframe").first();
  await frame.waitFor({ timeout: 30_000 });
  const body = frame.contentFrame().locator("body");
  await body.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(text);
}

// ------------------------------------------------------------------ product

export async function productStage(drill) {
  const { seed, ctx } = await movedP4Store(drill, "product");
  const base = ctx.base;
  const [product, other] = await plainProduct(ctx, { not: [seed.chosenProduct.id] });
  if (!product || !other) throw new DrillError("the moved store has no two plain products in a collection");
  const col = await one(ctx.urls.tenant, "SELECT c.handle, c.title FROM collections c JOIN collection_products cp ON cp.collection_id = c.id WHERE cp.product_id = ? ORDER BY cp.position LIMIT 1", [product.id]);
  const sku = (await one(ctx.urls.tenant, "SELECT sku FROM variants WHERE product_id = ? AND available = 1 ORDER BY position, id LIMIT 1", [product.id]))?.sku ?? null;
  drill.note(`the product: ${product.title} (${product.handle}); its "goes well with" pick: ${other.title}; its collection: ${col?.handle}`);

  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));

  // ---- open it from the editor's product list ----
  await page.goto(consoleUrl(base, `/admin/editor`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-switcher-toggle]").click();
  await page.locator("[data-switcher-search]").fill(product.title.slice(0, 14));
  const row = page.locator(`[data-switcher-product="${product.id}"]`);
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForURL((u) => u.searchParams.get("product") === product.id, { timeout: 60_000 });
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  drill.check((await page.locator("[data-shopify-title]").innerText()).trim() === `Shopify title: ${product.title}`, "product: it opens from the editor's product list, with 'Shopify title: …'", null);

  // ---- every field the founder owns ----
  await page.locator("#f-doc-title").fill(NEW_NAME);
  await waitSaved(page);
  await typeRich(page, page.locator('[data-overlay="description_html"]'), NEW_DESCRIPTION);
  await waitSaved(page);
  // a photo from the library
  await page.locator("[data-gallery-library]").click();
  const dlg = page.locator("dialog[open]").filter({ hasText: "Choose an image" });
  const firstPick = dlg.locator('ul[aria-label="Media library"] button').first();
  await firstPick.waitFor({ timeout: 30_000 });
  const filename = String((await firstPick.getAttribute("title")) || "").split(" — ")[0];
  const media = await one(ctx.urls.tenant, "SELECT id FROM media WHERE filename = ? AND parent_id IS NULL", [filename]);
  await firstPick.click();
  await dlg.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  await waitFor(async () => (await page.locator("[data-gallery-item]").count()) === 1, 20_000);
  await waitSaved(page);
  // badge and template
  const more = page.locator("[data-product-more]");
  const badgeInput = more.locator('input[type="text"], input:not([type])').first();
  await badgeInput.fill(NEW_BADGE);
  await waitSaved(page);
  const tplSelect = more.locator("select").first();
  const tplOptions = await tplSelect.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  const template = tplOptions.includes("editorial") ? "editorial" : tplOptions[0];
  await tplSelect.selectOption(template);
  await waitSaved(page);
  // goes well with
  await pickInto(page, "[data-pairs-control]", other.title);
  await waitSaved(page);
  // a module
  const kinds = await page.locator("[data-add-module]").evaluateAll((bs) => bs.map((b) => b.getAttribute("data-add-module")));
  const kind = kinds.includes("rich_text") ? "rich_text" : kinds[0];
  await page.locator(`[data-add-module="${kind}"]`).click();
  const mod = page.locator("[data-product-module]").last();
  await mod.waitFor({ timeout: 20_000 });
  const modText = mod.locator('input[type="text"], input:not([type]), textarea').first();
  if ((await mod.locator("iframe").count()) > 0) {
    if (await modText.count()) await modText.fill("From the founder");
    await typeRich(page, mod, MODULE_WORDS);
  } else await modText.fill(MODULE_WORDS);
  await waitSaved(page);
  await drill.screenshot(page, "product-editor-edited-1440", { fullPage: true });
  const doc = (await page.evaluate(async (id) => (await (await fetch("/api/admin/documents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ openEntityContent: { type: "product_content", entityId: id } }) })).json()), product.id))?.document;
  const st = doc?.body?.settings || {};
  drill.check(
    st.title?.value === NEW_NAME && String(st.description_html?.value || "").includes("small batches") && st.gallery?.value?.[0]?.media === `/api/media/${media?.id}` && st.badge === NEW_BADGE && st.template === template && (st.pairs?.products || st.pairs?.ids || JSON.stringify(st.pairs || "")).toString().includes(other.id) && (doc.body.sections || []).length === 1,
    "product: the name, description, library photo, badge, template, 'goes well with' and one module are saved in the draft",
    { title: st.title?.value, description: st.description_html?.value, gallery: st.gallery?.value, badge: st.badge, template: st.template, pairs: st.pairs, modules: (doc?.body?.sections || []).map((s) => s.kind) },
  );
  const phase = await publishHere(page);
  const live = await one(ctx.urls.tenant, "SELECT title, description_html, gallery, badge, modules, pairs, layout_template FROM product_content_live WHERE product_id = ?", [product.id]);
  drill.check(phase === "done" && live?.title === NEW_NAME && live?.badge === NEW_BADGE && live?.layout_template === template, "product: Publish goes live (its live row holds the new name, badge and template)", { phase, live: live && { title: live.title, badge: live.badge, template: live.layout_template } });
  await drill.screenshot(page, "product-editor-published-1440");

  // ---- the shopper ----
  const sctx = await shopperContext(drill, base, "p4-drills-product");
  const sp = await sctx.newPage();
  await sp.goto(`${base}/products/${product.handle}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  await sp.locator("[data-pdp-template]").first().waitFor({ state: "visible", timeout: 90_000 });
  const pdp = await sp.evaluate(() => ({
    h1: document.querySelector("h1")?.innerText?.trim(),
    template: document.querySelector("[data-pdp-template]")?.getAttribute("data-pdp-template"),
    text: document.querySelector("main")?.innerText || "",
    // a module is a closed <details>: its words are in the page, not in innerText
    modules: document.querySelector('[data-sec="pdp-modules"]')?.textContent || "",
    imgs: [...document.querySelectorAll("main img")].map((i) => i.getAttribute("src") || ""),
    pairs: [...document.querySelectorAll('[data-sec="pdp-pairs"] a[href^="/products/"]')].map((a) => a.getAttribute("href")),
    title: document.title,
  }));
  drill.check(pdp.h1 === NEW_NAME && pdp.title.includes(NEW_NAME), "shopper: the product page's heading and tab title show the new name", { h1: pdp.h1, title: pdp.title });
  drill.check(pdp.text.includes(NEW_DESCRIPTION), "shopper: the product page shows the founder's description", null);
  drill.check(pdp.imgs.some((s) => s.includes(`/api/media/${media?.id}`)), "shopper: the product page shows the photo chosen from the library", { media: media?.id, imgs: pdp.imgs.slice(0, 6) });
  drill.check(pdp.text.includes(NEW_BADGE), `shopper: the product page shows the badge "${NEW_BADGE}"`, null);
  drill.check(pdp.modules.includes("From the founder") && pdp.modules.includes(MODULE_WORDS), "shopper: the product page shows the founder's module (its title, and its words when opened)", { modules: pdp.modules.slice(0, 300) });
  drill.check(pdp.pairs.some((h) => h.split("?")[0] === `/products/${other.handle}`), `shopper: "goes well with" shows ${other.title}`, { pairs: pdp.pairs });
  drill.check(pdp.template === template, `shopper: the product page uses the ${template} template`, { template: pdp.template });
  await drill.screenshot(sp, "shopper-product-page-1440");
  // the card, in search and on its collection
  const word = NEW_NAME.split(" ")[1];
  const searchText = await searchFor(sp, base, word);
  const card = sp.locator(`main a[href="/products/${product.handle}"]`).first();
  drill.check(searchText.includes(NEW_NAME) && (await card.count()) === 1 && (await card.innerText()).includes(NEW_NAME), "shopper: storefront search finds it by the new name, and its card shows the new name", null);
  await drill.screenshot(sp, "shopper-search-card-1440");
  if (col) {
    await sp.goto(`${base}/collections/${col.handle}`, { waitUntil: "load", timeout: 120_000 });
    await settle(sp);
    const ccard = sp.locator(`main a[href^="/products/${product.handle}"]`).first();
    const ctext = (await ccard.count()) ? await ccard.innerText() : "";
    drill.check(ctext.includes(NEW_NAME), "shopper: its card on its collection page shows the new name", { collection: col.handle, card: ctext.slice(0, 120) });
  }
  // the cart
  await sp.goto(`${base}/products/${product.handle}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  const posted = sp.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await sp.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  await posted;
  const drawer = sp.locator('[role="dialog"][aria-label="Shopping cart"]');
  await waitFor(async () => (await drawer.innerText()).includes(NEW_NAME), 20_000);
  const cartJson = await sp.evaluate(async () => (await fetch("/api/cart")).json());
  const line = (cartJson.items || []).find((i) => i.title === NEW_NAME);
  drill.check(Boolean(line) && !("catalog_title" in line) && (await drawer.innerText()).includes(NEW_NAME), "shopper: the cart (the drawer and the cart the browser gets) shows the new name, never Shopify's", { line });
  await drill.screenshot(sp, "shopper-cart-1440");

  // ---- checkout, confirmation, the order page: a COD test order ----
  await assertNoShopify(drill, ctx);
  await sp.goto(`${base}/checkout`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  await sp.locator('input[name="email"]').waitFor({ timeout: 60_000 });
  const fill = { email: TEST_ORDER_EMAIL, phone: "9999999999", name: "P4 Drill Test Order", line1: "1 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" };
  for (const [k, v] of Object.entries(fill)) await sp.locator(`input[name="${k}"]`).fill(v);
  await sp.getByRole("button", { name: "Continue to review" }).click();
  await sp.getByRole("button", { name: "Continue to payment" }).waitFor({ timeout: 30_000 });
  const reviewText = await sp.locator("main").innerText();
  drill.check(reviewText.includes(NEW_NAME) && !reviewText.includes(product.title), "shopper: the checkout's review step lists the item under the new name", { has: reviewText.includes(NEW_NAME), sample: reviewText.slice(0, 300) });
  await drill.screenshot(sp, "shopper-checkout-review-1440");
  await sp.getByRole("button", { name: "Continue to payment" }).click();
  const cod = sp.locator('input[type="radio"][name="method"][value="cod"], input[type="radio"][name="method"]').first();
  await cod.waitFor({ timeout: 30_000 });
  if (!(await cod.isChecked())) await cod.check();
  const codValue = await cod.getAttribute("value");
  drill.check(codValue == null || codValue === "cod", "checkout: cash on delivery is chosen (no card details are ever entered)", { codValue });
  await drill.screenshot(sp, "shopper-checkout-payment-1440");
  await sp.getByRole("button", { name: /^Place order/ }).click();
  await sp.waitForURL(/\/checkout\/confirmation/, { timeout: 60_000 }).catch(() => {});
  await settle(sp);
  const confirmText = await sp.locator("main").innerText().catch(() => "");
  const orderId = decodeURIComponent((/\/checkout\/confirmation\/([^/?#]+)/.exec(sp.url()) || [])[1] || "");
  const orderRow = orderId ? await one(ctx.urls.tenant, "SELECT id, status, email, payment_method FROM orders WHERE id = ?", [orderId]) : null;
  drill.check(Boolean(orderRow) && orderRow.email === TEST_ORDER_EMAIL && orderRow.payment_method === "cod" && confirmText.includes(NEW_NAME), "shopper: a cash on delivery test order (snehal@mediastic.in) goes through, and the confirmation shows the new name", { orderRow, at: sp.url() });
  await drill.screenshot(sp, "shopper-confirmation-1440");
  let cancelled = null;
  try {
    const statusLink = sp.locator('main a[href*="/orders/"]').first();
    if (await statusLink.count()) {
      await statusLink.click();
      await sp.waitForURL(/\/orders\//, { timeout: 60_000 });
      await settle(sp);
      const orderText = await sp.locator("main").innerText();
      drill.check(orderText.includes(NEW_NAME) && !orderText.includes("Shopify title"), "shopper: the order page shows the new name (and no Shopify title)", { at: new URL(sp.url()).pathname });
      await drill.screenshot(sp, "shopper-order-page-1440");
    } else drill.check(false, "shopper: the confirmation links to the order page", null);
    // the console's order page: the name bought, and Shopify's under it
    await page.goto(consoleUrl(base, `/admin/orders/${encodeURIComponent(orderId)}`), { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    const shopLine = page.locator("p", { hasText: `Shopify title: ${product.title}` }).first();
    await shopLine.waitFor({ timeout: 30_000 });
    const lineText = await shopLine.innerText();
    const adminText = await page.locator("main").innerText();
    drill.check(adminText.includes(NEW_NAME) && lineText.startsWith(`Shopify title: ${product.title}`) && (!sku || lineText.includes(sku)), "console: the order page shows the new name with 'Shopify title: …' (and the SKU) under it", { lineText, sku });
    await drill.screenshot(page, "console-order-page-1440");
  } finally {
    // cancelled at once (the test-order rule)
    if (orderId) {
      cancelled = await page.evaluate(async (id) => {
        const r = await fetch(`/api/admin/orders/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reason: "P4-DRILLS test order" }) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, orderId);
    }
  }
  const after = orderId ? await one(ctx.urls.tenant, "SELECT status FROM orders WHERE id = ?", [orderId]) : null;
  drill.check(cancelled?.status === 200 && after?.status === "cancelled", "the test order is cancelled at once", { cancel: cancelled?.status, status: after?.status });
  drill.note(`test order ${orderId} (${TEST_ORDER_EMAIL}) placed and cancelled: ${JSON.stringify(after)}`);

  // ---- reset to Shopify's ----
  await openProduct(page, base, product.id);
  for (const key of ["title", "description_html", "gallery"]) {
    const btn = page.locator(`[data-overlay="${key}"] [data-reset="${key}"]`);
    if (await btn.count()) {
      await btn.first().click();
      await waitSaved(page);
    }
  }
  const following = await waitFor(async () => (await page.locator('[data-overlay="title"] [data-same]').count()) === 1 && (await page.locator("#f-doc-title").inputValue()) === product.title, 20_000);
  drill.check(Boolean(following), "reset: 'Reset to Shopify' puts Shopify's name, description and photos back ('Same as Shopify')", null);
  const phase2 = await publishHere(page);
  const live2 = await one(ctx.urls.tenant, "SELECT title, description_html, gallery FROM product_content_live WHERE product_id = ?", [product.id]);
  await sp.goto(`${base}/products/${product.handle}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  const h1b = (await sp.locator("h1").first().innerText()).trim();
  const textb = await sp.locator("main").innerText();
  const search2 = await searchFor(sp, base, word);
  drill.check(phase2 === "done" && live2?.title == null && live2?.description_html == null && h1b === product.title && !textb.includes(NEW_DESCRIPTION) && !search2.includes(NEW_NAME), "reset: published, the shopper sees Shopify's name and description again, and search no longer finds the new name", { phase2, live: live2, h1b });
  await drill.screenshot(sp, "shopper-after-reset-1440");
  const kept = orderId ? await one(ctx.urls.tenant, "SELECT title, catalog_title FROM order_items WHERE order_id = ? LIMIT 1", [orderId]) : null;
  drill.check(kept?.title === NEW_NAME && kept?.catalog_title === product.title, "the order keeps the name it was bought under, with Shopify's beside it", kept);
  await sctx.close();
  drill.check(errors.length === 0, "no page errors in the editor", { errors: errors.slice(0, 5) });
  await bctx.close();
}

// --------------------------------------------------------------- collection

export async function collectionStage(drill) {
  const { seed, ctx } = await movedP4Store(drill, "collection");
  const base = ctx.base;
  // a collection with no pins of its own and at least five products
  const col = await one(
    ctx.urls.tenant,
    `SELECT c.id, c.handle, c.title FROM collections c
     WHERE c.id <> ? AND (SELECT count(*) FROM collection_products cp WHERE cp.collection_id = c.id) >= 5
       AND NOT EXISTS (SELECT 1 FROM collection_content_live l WHERE l.collection_id = c.id AND l.pinned IS NOT NULL AND l.pinned <> '[]')
     ORDER BY c.title LIMIT 1`,
    [seed.pinnedCollection.id],
  );
  if (!col) throw new DrillError("the moved store has no collection without pins");
  // the pin: the collection's last product, so "first" proves the pin
  const last = await one(ctx.urls.tenant, "SELECT p.id, p.handle, p.title FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id = ? AND p.available = 1 ORDER BY cp.position DESC LIMIT 1", [col.id]);
  drill.note(`the collection: ${col.title} (${col.handle}); pinned first: ${last.title}`);
  const sctx = await shopperContext(drill, base, "p4-drills-collection");
  const sp = await sctx.newPage();
  const shopperView = async () => {
    await sp.goto(`${base}/collections/${col.handle}`, { waitUntil: "load", timeout: 120_000 });
    await settle(sp);
    await noThanks(sp);
    await sp.locator("[data-collection-template]").first().waitFor({ state: "visible", timeout: 90_000 });
    return sp.evaluate(() => ({
      template: document.querySelector("[data-collection-template]")?.getAttribute("data-collection-template"),
      hrefs: [...new Set([...document.querySelectorAll('[data-sec="collection-products"] a[href^="/products/"]')].map((a) => a.getAttribute("href").split("?")[0]))],
    }));
  };
  const before = await shopperView();
  drill.check(before.hrefs[0] !== `/products/${last.handle}`, "before: the product to pin is not first on the collection page", { first: before.hrefs[0], template: before.template });

  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  await page.goto(consoleUrl(base, `/admin/editor?collection=${encodeURIComponent(col.id)}`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-collection-form]").waitFor({ timeout: 90_000 });
  await pickInto(page, "[data-product-picks]", last.title);
  await waitSaved(page);
  const sel = page.locator("[data-collection-form] select").first();
  const options = await sel.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  const template = options.find((o) => o !== before.template) || options[0];
  await sel.selectOption(template);
  await waitSaved(page);
  await drill.screenshot(page, "collection-editor-1440");
  const phase = await publishHere(page);
  const live = await one(ctx.urls.tenant, "SELECT pinned, layout_template FROM collection_content_live WHERE collection_id = ?", [col.id]);
  drill.check(phase === "done" && String(live?.pinned || "").includes(last.id) && live?.layout_template === template, "collection: the pin and the template are published (its live row)", { phase, live });
  const after = await shopperView();
  drill.check(after.hrefs[0] === `/products/${last.handle}`, `shopper: the pinned product (${last.title}) is first on the collection page`, { first: after.hrefs.slice(0, 3) });
  drill.check(after.template === template, `shopper: the collection page uses the ${template} template`, { template: after.template, before: before.template });
  await drill.screenshot(sp, "shopper-collection-pinned-1440");
  await sctx.close();
  await bctx.close();
}

// ------------------------------------------------------------ search-rename

// A spy Typesense admin client: records every call, reaches nothing.
function spyClient() {
  const calls = [];
  const client = {
    collections(name) {
      return {
        documents(id) {
          return {
            async import(docs, opts) {
              calls.push({ op: "import", collection: name, docs: structuredClone(docs), opts });
              return docs.map(() => ({ success: true }));
            },
            async delete() {
              calls.push({ op: "delete", collection: name, id });
              return {};
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

const DUMMY_TS = { TYPESENSE_HOST: "localhost", TYPESENSE_PORT: "7109", TYPESENSE_PROTOCOL: "http", TYPESENSE_ADMIN_API_KEY: "p4-drill-not-a-real-key" };

// In THIS process only: a second rename published against the harness
// store's database, then the outbox drained to the spy. Never the server's env.
async function secondRenameToSpy(productId, name) {
  const { withHarnessStore } = await import("../../seed-design-documents.js");
  const saved = Object.fromEntries(Object.keys(DUMMY_TS).map((k) => [k, process.env[k]]));
  // nothing listens on the dummy port (checked by the caller); the spy is the
  // client, so no request is ever made
  Object.assign(process.env, DUMMY_TS);
  try {
    return await withHarnessStore(
      async () => {
        const { currentTenant, withTenant } = await import("../../../lib/tenant-context.js");
        const t = currentTenant();
        const tenant = { ...t, config: { ...(t.config || {}), typesense_collection: "p4_drill_products" } };
        return withTenant(tenant, async () => {
          const Docs = await import("../../../lib/documents/service.js");
          const { publish } = await import("../../../lib/documents/publish.js");
          const { drainSearchOutbox } = await import("../../../lib/catalog/search-reindex.js");
          const { libsql } = await import("../../../lib/db.js");
          const opened = await Docs.openEntityContent({ type: "product_content", entityId: productId });
          const doc = opened.document;
          const saved2 = await Docs.saveDraft({ id: doc.id, revision: doc.revision, body: { ...doc.body, settings: { ...doc.body.settings, title: { ...(doc.body.settings.title || {}), value: name } } } });
          const sd = saved2.document;
          const pub = await publish({ ids: [{ id: sd.id, revision: sd.revision, draftHash: sd.draftHash }], actor: { kind: "drill", id: "p4-drills" } });
          const pending = rowsOf(await libsql.execute({ sql: "SELECT rowid AS rid, product_id, done_at FROM search_outbox WHERE product_id = ? AND done_at IS NULL", args: [productId] }));
          const spy = spyClient();
          const drained = await drainSearchOutbox({ client: spy.client });
          const rows = rowsOf(await libsql.execute({ sql: "SELECT rowid AS rid, done_at FROM search_outbox WHERE product_id = ? ORDER BY rowid", args: [productId] }));
          return { pub: { ok: pub?.ok !== false }, pending, drained, calls: spy.calls, rows };
        });
      },
      { write: false },
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function undoLatest(page, base, label) {
  await page.goto(consoleUrl(base, `/admin/releases`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const list = page.locator("[data-recently-published]");
  await list.waitFor({ timeout: 60_000 });
  const rowL = list.locator("[data-row]").filter({ hasText: label }).filter({ has: page.locator("[data-undo] button:not([disabled])") }).first();
  await rowL.waitFor({ timeout: 30_000 });
  await rowL.locator("[data-undo] button", { hasText: /^Undo$/ }).first().click();
  const confirm = rowL.locator("[data-undo] button", { hasText: /^Undo$/ }).last();
  await waitFor(async () => (await rowL.locator("[data-undo] button").count()) >= 2, 20_000);
  await confirm.click();
  await waitFor(async () => !(await rowL.locator("[data-undo] button[aria-busy=true]").count()), 30_000);
  await sleep(1000);
}

export async function searchRenameStage(drill) {
  const { ctx } = await movedP4Store(drill, "search-rename");
  const base = ctx.base;
  const [product] = await plainProduct(ctx);
  const NAME1 = "Zephyr Drill Blend";
  const NAME2 = "Quasar Drill Blend";
  const oldWord = product.title;
  drill.note(`the product: ${product.title} (${product.handle}); search words: new "Zephyr", second "Quasar", old "${oldWord}" (the whole old name)`);
  const sctx = await shopperContext(drill, base, "p4-drills-search");
  const sp = await sctx.newPage();
  const found = async (q) => {
    await searchFor(sp, base, q);
    return (await sp.locator(`main a[href="/products/${product.handle}"]`).count()) > 0;
  };
  drill.check(await found(oldWord), `before: search for "${oldWord}" finds the product`, null);

  // ---- rename and publish in the browser ----
  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  await openProduct(page, base, product.id);
  await page.locator("#f-doc-title").fill(NAME1);
  await waitSaved(page);
  const phase = await publishHere(page);
  drill.check(phase === "done", "the rename is published in the editor", { phase });
  const byNew = await found("Zephyr");
  await drill.screenshot(sp, "search-new-name-1440");
  const byOld = await found(oldWord);
  drill.check(byNew && !byOld, "storefront search (the SQL path) finds it by the new name, and not by the old one", { byNew, byOld });
  const outbox = await waitFor(async () => {
    const r = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT rowid AS rid, handle, reason, done_at FROM search_outbox WHERE product_id = ? ORDER BY rowid", args: [product.id] }]))[0]);
    return r.length && r.every((x) => x.done_at) ? r : null;
  }, 30_000);
  drill.check(Boolean(outbox) && outbox.length >= 1, "its search row is marked done (the harness server has no Typesense: its fast path marks rows done without a client call)", { outbox });

  // ---- the spy step, in this process only ----
  const { createConnection } = await import("node:net");
  const listening = await new Promise((r) => {
    const s = createConnection({ host: "127.0.0.1", port: Number(DUMMY_TS.TYPESENSE_PORT) });
    s.once("connect", () => (s.destroy(), r(true)));
    s.once("error", () => r(false));
  });
  drill.check(!listening && !ctx.env.TYPESENSE_HOST && !ctx.env.TYPESENSE_ADMIN_API_KEY, "the spy step's Typesense values are dummies set in this process only: nothing listens on the dummy port, and the harness server's Typesense values are blank", { port: DUMMY_TS.TYPESENSE_PORT, listening, serverHost: ctx.env.TYPESENSE_HOST || "" });
  if (listening) throw new DrillError(`something listens on ${DUMMY_TS.TYPESENSE_PORT}: refusing the spy step`);
  const spy = await secondRenameToSpy(product.id, NAME2);
  const imported = spy.calls.filter((c) => c.op === "import").flatMap((c) => c.docs);
  const docFor = imported.find((d) => d.id === product.id || d.handle === product.handle);
  drill.check(spy.pending.length === 1, "in this process: the second rename, published against the harness database, wrote its own pending search row", { pending: spy.pending });
  drill.check(Boolean(docFor) && docFor.title === NAME2 && spy.calls.every((c) => c.collection === "p4_drill_products"), "drainSearchOutbox({ client: spy }) upserts the product with the second name, in the drill's collection only", { calls: spy.calls.map((c) => ({ op: c.op, collection: c.collection, titles: (c.docs || []).map((d) => d.title) })), drained: spy.drained });
  drill.check(spy.rows.every((r) => r.done_at), "after the spy drain every search row of the product is done", { rows: spy.rows });
  const byNew2 = await found("Quasar");
  drill.check(byNew2, "storefront search finds the second name too", null);

  // ---- Undo, twice, in the browser ----
  await undoLatest(page, base, product.title);
  await drill.screenshot(page, "recently-published-undo-1-1440");
  await undoLatest(page, base, product.title);
  await drill.screenshot(page, "recently-published-undo-2-1440");
  const liveTitle = (await one(ctx.urls.tenant, "SELECT title FROM product_content_live WHERE product_id = ?", [product.id]))?.title ?? null;
  const backOld = await found(oldWord);
  const gone1 = !(await found("Zephyr"));
  const gone2 = !(await found("Quasar"));
  await drill.screenshot(sp, "search-old-name-back-1440");
  drill.check(liveTitle == null && backOld && gone1 && gone2, "after Undo of both renames in the browser, search finds the old name again and neither new one", { liveTitle, backOld, gone1, gone2 });
  const pend = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT count(*) AS n FROM search_outbox WHERE product_id = ? AND done_at IS NULL", args: [product.id] }]))[0])[0];
  drill.check(Number(pend.n) === 0, "the Undo's search rows are marked done too", pend);
  await sctx.close();
  await bctx.close();
}
void join;
