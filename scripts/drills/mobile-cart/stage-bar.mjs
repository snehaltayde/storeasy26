// drill:mobile-cart stage "bar" (Phase 7 line 3, docs/plans/phase-7.md "Line 3"):
// on a phone the buy bar appears once the main Add button has scrolled away,
// "Choose size" moves focus to the Size options, the bar shows the chosen
// variant, and Add says "Adding…" then opens the drawer with one add only.
// The stage seeds and opens the store itself; it leaves the phone page in
// `state` for the drawer stage. Every wait is for an element or an answer.
import { ORIGIN, HANDLE, bar, drawer, openStore, phone, seedStore, stage, state, toBottom } from "./lib.mjs";

stage("bar", async (drill) => {
  await seedStore();
  await openStore(drill);

  const page = await phone(drill);
  let adds = 0;
  let releaseAdd = null;
  // hold the first add's answer until the stage has read "Adding…"
  await page.route("**/api/cart", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && JSON.parse(req.postData() || "{}").action === "add") {
      adds++;
      if (adds === 1) await new Promise((r) => (releaseAdd = r));
    }
    await route.continue();
  });
  const r = await page.goto(`${ORIGIN}/products/${HANDLE}`, { waitUntil: "load" });
  drill.check(r?.status() === 200, "the shopper's product page answers 200", r?.status());
  const b = bar(page);
  const buyBox = page.locator('[data-protected="buy-box"]');
  drill.check((await b.count()) === 1 && (await b.locator("[data-part], [data-plugin-slot]").count()) === 0, 'one data-protected="buy-bar", no theme hook or plugin slot inside');
  drill.check((await b.getAttribute("inert")) !== null, "at the top of the page the bar is hidden (the main Add button is on screen)");

  // Blue on the default S: that pair doesn't exist, so Size is left to choose
  await buyBox.getByRole("button", { name: "Blue", exact: true }).tap();
  await toBottom(page);
  await page.locator('[data-protected="buy-bar"]:not([inert])').waitFor();
  const button = b.locator("[data-buy-bar-button]");
  drill.check((await button.innerText()).trim() === "Choose size", 'the bar says "Choose size"', await button.innerText());
  drill.check((await b.evaluate((el) => getComputedStyle(el).transitionProperty)) === "none", "reduced motion: the bar doesn't slide in");
  const cover = await page.evaluate(() => {
    const f = document.querySelector('footer[data-part="footer"]').getBoundingClientRect();
    const bb = document.querySelector('[data-protected="buy-bar"]').getBoundingClientRect();
    return { footerBottom: Math.round(f.bottom), barTop: Math.round(bb.top) };
  });
  drill.check(cover.footerBottom <= cover.barTop + 1, "at the very bottom the bar doesn't cover the footer (the page's spacer)", cover);
  await drill.shoot(page, "bar-choose");

  await button.tap();
  await page.waitForFunction(() => document.activeElement?.closest("[data-option-group]")?.getAttribute("data-option-group") === "Size");
  drill.check(true, '"Choose size" moved focus to the Size options');
  await buyBox.getByRole("button", { name: "M", exact: true }).tap();

  await toBottom(page);
  await page.locator('[data-protected="buy-bar"]:not([inert])').waitFor();
  drill.check((await button.innerText()).trim() === "Add to cart", 'with M · Blue chosen the bar says "Add to cart"');
  const barText = await b.innerText();
  drill.check(barText.includes("M · Blue") && barText.includes("₹400") && barText.includes("₹499"), "the bar shows the chosen variant, the price and compare-at", barText);
  await drill.shoot(page, "bar-add");

  await button.tap();
  await page.waitForFunction(() => document.querySelector("[data-buy-bar-button]")?.textContent.trim() === "Adding…");
  drill.check(true, 'while the add is in flight the bar says "Adding…"');
  await drawer(page).locator("[data-cart-close]").waitFor({ state: "visible" });
  drill.check((await b.getAttribute("inert")) !== null, "the bar hides while the drawer is open");
  releaseAdd?.();
  await drawer(page).locator('[data-nudge="tier"]').waitFor();
  drill.check(adds === 1, "one tap, one add", adds);
  state.page = page;
});
