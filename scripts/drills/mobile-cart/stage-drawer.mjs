// drill:mobile-cart stage "drawer" (Phase 7 line 3): the phone drawer the bar
// stage opened. The tier nudge and the spend bar show (offer and gift titles,
// no target value); "Add 1 more" makes the offer line appear and the bar move;
// focus is trapped, the page doesn't scroll, Escape returns focus to the bar;
// checkout's total is the drawer's (plus the cash on delivery fee it says it
// adds), and a tampered checkout body still gets the confirm-the-total 409.
// Nothing is paid: the stage stops at the total.
import { ADDRESS, CONTACT, GIFT_TITLE, HANDLE, ORIGIN, TIER_TITLE, bar, drawer, money, stage, state } from "./lib.mjs";

stage("drawer", async (drill) => {
  const page = state.page;
  if (!page) throw new Error("the bar stage left no page (it runs first)");
  const d = drawer(page);
  drill.check((await d.getAttribute("aria-modal")) === "true", "the drawer is a modal dialog (aria-modal)");
  const size = await d.evaluate((el) => ({ h: Math.round(el.getBoundingClientRect().height), vh: window.innerHeight, w: Math.round(el.getBoundingClientRect().width) }));
  drill.check(size.h === size.vh && size.w === 390, "on a phone the drawer is full height and full width", size);
  drill.check(await page.evaluate(() => document.querySelector('[data-protected="cart"]').contains(document.activeElement)), "focus moved into the drawer");
  drill.check((await page.evaluate(() => document.body.style.overflow)) === "hidden", "the page behind doesn't scroll");

  const progress = d.locator("[data-offer-progress]");
  drill.check((await progress.getAttribute("aria-live")) === "polite", "the progress block is a polite live region");
  const tier = (await d.locator('[data-nudge="tier"]').innerText()).trim();
  drill.check(tier === `Add 1 more for 10% off · ${TIER_TITLE}`, "the tier nudge names the offer's title", tier);
  const spend = (await d.locator('[data-nudge="spend"] p').first().innerText()).trim();
  drill.check(spend === `Add ₹600 more for a free ${GIFT_TITLE}`, "the spend nudge: the smallest amount over ₹999, the gift's title", spend);
  drill.check(!(await progress.innerText()).includes(HANDLE), "no target value in the nudges");
  const bar0 = Number(await d.getByRole("progressbar").getAttribute("aria-valuenow"));
  await drill.shoot(page, "drawer-nudges");

  const answered = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST");
  await d.getByRole("button", { name: "Add 1 more", exact: true }).tap();
  drill.check((await answered).status() === 200, '"Add 1 more": POST /api/cart answers 200');
  await d.getByText(`${TIER_TITLE} · 10% off`).waitFor();
  drill.check(true, "the offer line appears in the drawer");
  await page.waitForFunction((v) => Number(document.querySelector('[data-protected="cart"] [role="progressbar"]')?.getAttribute("aria-valuenow")) > v, bar0);
  const bar1 = Number(await d.getByRole("progressbar").getAttribute("aria-valuenow"));
  drill.check(bar1 > bar0, "the spend bar moved", { before: bar0, after: bar1 });
  drill.check((await d.locator('[data-nudge="tier"]').count()) === 0, "the reached tier's nudge is gone");
  await drill.shoot(page, "drawer-tier-applied");

  // Tab and Shift+Tab stay inside
  await d.locator("[data-cart-close]").focus();
  let escaped = 0;
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press(i < 16 ? "Tab" : "Shift+Tab");
    if (!(await page.evaluate(() => document.querySelector('[data-protected="cart"]').contains(document.activeElement)))) escaped++;
  }
  drill.check(escaped === 0, "Tab and Shift+Tab keep focus in the drawer", escaped);

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-buy-bar-button"));
  drill.check((await d.getAttribute("inert")) !== null, "Escape closes the drawer");
  drill.check((await bar(page).getAttribute("inert")) === null, "the bar shows again");
  drill.check(true, "focus is back on the bar's button");
  drill.check((await page.evaluate(() => document.body.style.overflow)) === "", "the page scrolls again");

  // the bar opens the drawer again ("View cart"); its total against checkout's
  const button = bar(page).locator("[data-buy-bar-button]");
  drill.check((await button.innerText()).trim() === "View cart", 'after the add the bar says "View cart"');
  await button.tap();
  await d.locator("[data-cart-close]").waitFor({ state: "visible" });
  const drawerTotal = money(await d.locator("[data-cart-total]").innerText());
  const cart = await page.evaluate(() => fetch("/api/cart", { cache: "no-store" }).then((r) => r.json()));
  drill.check(drawerTotal === cart.grandTotal && drawerTotal === 799, "the drawer's total is the server's (2 × ₹400 − 10% + ₹79 shipping)", { drawerTotal, server: cart.grandTotal });
  await d.getByRole("link", { name: /Checkout/ }).tap();
  await page.waitForURL(/\/checkout/);
  const summary = page.locator('[data-protected="checkout"] aside');
  await summary.getByText("Total", { exact: true }).waitFor();
  const checkoutTotal = money(await summary.locator("div:has(> span:text-is('Total')) > span").last().innerText());
  const codFee = (await summary.innerText()).includes("incl. COD fee") ? 49 : 0;
  drill.check(checkoutTotal === drawerTotal + codFee, "checkout's total is the drawer's (plus the cash on delivery fee the drawer says is added)", { checkoutTotal, drawerTotal, codFee });
  await drill.shoot(page, "checkout-total");

  // a tampered body: the drawer's lower total, a discount and a progress field. Refused, not placed.
  const tampered = await page.evaluate(
    async ([contact, address, expected]) => {
      const r = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cod", idempotencyKey: `mc-${Date.now()}`, contact, address, expectedTotal: expected, expectedShipping: 79, discount: 9999, discountTotal: 9999, progress: { nudges: [] } }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [CONTACT, ADDRESS, drawerTotal - 100],
  );
  drill.check(tampered.status === 409 && tampered.body?.code === "PRICE_CHANGED" && tampered.body?.total === checkoutTotal, "a tampered checkout body gets the confirm-the-total 409 with checkout's own total", { status: tampered.status, code: tampered.body?.code, total: tampered.body?.total });
  await page.context().close();
});
