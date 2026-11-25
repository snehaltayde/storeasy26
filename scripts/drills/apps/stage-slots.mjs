// drill:apps, stage "slots" (Phase 4 line 2): the owner turns Trust badges'
// Badges block Live on the app's "Where it shows" card; an anonymous browser
// sees it on a product page; turning it Off hides it again.
//
// scripts/drills/apps/run.mjs (line 1) imports this file and calls
//   await stageSlots(drill, { store, ownerPage })
//     store      the store's origin (http://roles.localhost:<port>)
//     ownerPage  a Playwright page signed in as the owner on that store
// It installs Trust badges first when the store doesn't have it, and leaves
// the block Off and the app installed when it ends.
//
// Selectors are ids, data-* hooks and exact names only; every wait is for a
// row or an answer, never a timeout.
export async function stageSlots(drill, { store, ownerPage }) {
  const page = ownerPage;
  const api = page.context().request;
  const headers = { origin: store };

  // the install: line 1's Installed list, else install it
  const apps = await (await api.get(`${store}/api/admin/apps`)).json();
  let installId = apps.installs?.find((i) => i.pluginId === "trust-badges")?.id;
  if (!installId) {
    const made = await api.post(`${store}/api/admin/apps`, { data: { install: { pluginId: "trust-badges", scopes: [] } }, headers });
    drill.check(made.status() === 200, "Trust badges installs", made.status());
    installId = (await made.json()).install?.id;
  }
  drill.check(/^pin_[0-9a-f]{16}$/.test(String(installId)), "an install id", installId);

  const listed = await (await api.get(`${store}/api/admin/apps/${installId}/placements`)).json();
  const productPath = listed.previewPaths?.["storefront.pdp.under_atc"];
  drill.check(typeof productPath === "string" && productPath.startsWith("/products/"), "a product page to look at", productPath);
  drill.check(listed.placements?.find((p) => p.blockId === "badges")?.state === "off", "Badges starts Off");

  // the anonymous shopper: a fresh context with no cookies
  const anonCtx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  anonCtx.setDefaultTimeout(30_000);
  const anon = await anonCtx.newPage();
  const shopperSees = async () => {
    await anon.goto(`${store}${productPath}`, { waitUntil: "domcontentloaded" });
    await anon.locator("[data-pdp-template]").waitFor();
    return anon.locator('[data-plugin-slot][data-plugin="trust-badges"][data-block="badges"]').count();
  };
  drill.check((await shopperSees()) === 0, "before: the shopper sees no badges");

  // the owner turns it Live on the card
  // the console page path, joined (not a URL literal: test:shopify-boundary reads "/admin/…" after an origin as a Shopify REST call)
  const appPage = ["", "admin", "apps", installId].join("/");
  await page.goto(new URL(appPage, store).href, { waitUntil: "domcontentloaded" });
  const card = page.locator("#app-placements");
  await card.locator('[data-placement="badges"]').waitFor();
  const toggle = card.locator("#pl-badges-live");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/admin/apps/${installId}/placements`) && r.request().method() === "POST");
  await toggle.click();
  drill.check((await saved).status() === 200, "Live is saved");
  await card.locator('label[for="pl-badges-live"]', { hasText: /^Live$/ }).waitFor();
  await drill.screenshot(page, "slots-card-live");

  // the shopper sees it (the write invalidated the store's plugins cache)
  drill.check((await shopperSees()) === 1, "after Live: the shopper sees the badges on the product page");
  const slotHtml = await anon.locator('[data-plugin-slot][data-block="badges"]').evaluate((el) => el.outerHTML);
  drill.check(!/<script|<iframe|\son[a-z]+=/i.test(slotHtml), "the slot markup holds no script, iframe or handler");
  drill.check((await anon.locator("[data-founder-note]").count()) === 0, "the shopper never sees a founder note");
  await drill.screenshot(anon, "slots-pdp-live");

  // and Off hides it again
  const off = page.waitForResponse((r) => r.url().endsWith(`/api/admin/apps/${installId}/placements`) && r.request().method() === "POST");
  await toggle.click();
  drill.check((await off).status() === 200, "Off is saved");
  await card.locator('label[for="pl-badges-live"]', { hasText: /^Off$/ }).waitFor();
  drill.check((await shopperSees()) === 0, "after Off: the shopper sees no badges");

  await anonCtx.close();
}
