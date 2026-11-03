// pnpm drill:smoke — one shopper journey on the design harness, to prove the
// browser runner works end to end: a product page at 375, 768 and 1440 wide,
// add to cart, the drawer opens with the item, then close it and open it
// again from the header. Screenshots go to docs/cms-reviews/drills/smoke/.
import { WIDTHS, drawerOpen } from "../drill.js";

export const id = "smoke";
export const title = "Smoke: product page at three widths, add to cart, open the drawer";

const PRODUCT = { path: "/products/glow-serum", title: "Radiance Glow Serum 30ml", price: "1,299" };

export default async function smoke(drill) {
  const context = await drill.context();
  const page = await context.newPage();

  for (const width of WIDTHS) {
    const res = await drill.open(page, PRODUCT.path, { width });
    const f = await drill.facts(page);
    drill.check(res.status === 200, `${width}px: product page answers 200`, res.status);
    drill.check(res.headers["x-edge-runtime"] === "1", `${width}px: rendered on the edge runtime (x-edge-runtime: 1)`, res.headers["x-edge-runtime"] ?? "header absent");
    drill.check(f.h1.some((h) => h.includes(PRODUCT.title)), `${width}px: the heading is "${PRODUCT.title}"`, f.h1);
    drill.check(f.text.includes(PRODUCT.price), `${width}px: the price ₹${PRODUCT.price} shows`);
    drill.check(!f.errorPage, `${width}px: not an error page`);
    drill.check(!f.overflowX, `${width}px: no sideways scroll`, `page is ${f.scrollWidth}px wide in a ${f.viewport}px window`);
    await drill.shoot(page, `product-${width}`);
  }

  // Still at the last width (1440).
  drill.check(!(await drawerOpen(page)), "the cart drawer starts closed");
  const emptyCart = page.getByRole("button", { name: "Open cart, 0 items" }).filter({ visible: true });
  drill.check((await emptyCart.count()) > 0, 'the header says "Open cart, 0 items"');

  const added = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const cartRes = await added;
  drill.check(cartRes.status() === 200, "adding to cart: POST /api/cart answers 200", cartRes.status());

  await page.waitForFunction(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Shopping cart"]');
    return d && d.getBoundingClientRect().left < window.innerWidth - 10;
  }, null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600); // the slide-in transition
  const drawer = page.getByRole("dialog", { name: "Shopping cart" });
  drill.check(await drawerOpen(page), "adding to cart opens the drawer");
  drill.check((await drawer.innerText()).includes(PRODUCT.title), `the drawer lists "${PRODUCT.title}"`);
  await drill.shoot(page, "drawer-after-add");
  // Reported, not checked: what a first-time shopper's tap on "Checkout →" lands on
  // while the cookie banner is still up.
  const onCheckout = await page.evaluate(() => {
    const link = [...document.querySelectorAll('[aria-label="Shopping cart"] a[href="/checkout"]')][0];
    if (!link) return "no Checkout link in the drawer";
    const r = link.getBoundingClientRect();
    if (r.bottom > window.innerHeight) return `the Checkout link is below the window (bottom ${Math.round(r.bottom)}px, window ${window.innerHeight}px)`;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return link.contains(hit) ? "the Checkout link itself" : `something else on top of it: <${hit?.tagName.toLowerCase()}> "${(hit?.innerText || "").trim().slice(0, 60)}"`;
  });
  drill.note(`1440px, cookie banner not yet answered: a tap on the drawer's "Checkout →" hits ${onCheckout}`);

  await drawer.getByRole("button", { name: "Close cart" }).click();
  await page.waitForTimeout(600);
  drill.check(!(await drawerOpen(page)), "Close cart closes the drawer");

  const oneItem = page.getByRole("button", { name: "Open cart, 1 item" }).filter({ visible: true }).first();
  drill.check((await oneItem.count()) > 0, 'the header now says "Open cart, 1 item"');
  await oneItem.click();
  await page.waitForTimeout(600);
  drill.check(await drawerOpen(page), "the header cart button opens the drawer");
  drill.check((await drawer.innerText()).includes(PRODUCT.title), "the reopened drawer still lists the item");
  await drill.shoot(page, "drawer-from-header");

  await context.close();
}
