// P1-DRILLS · SHOP: components/cart/CartContext.js changed in the first SHOP
// build. A storefront page: add to cart, change quantity, remove; the drawer
// and checkout still work (docs/cms-reviews/P1-SHOP.md).
import { text, settle } from "./util.mjs";
import { noThanks, clearCart } from "./sf.mjs";
import { drawerOpen } from "../../drill.js";

export const id = "SHOP";
export const title = "P1-DRILLS SHOP: the cart after the CartContext change";

const drawer = (page) => page.locator('[role="dialog"][aria-label="Shopping cart"]');
const cart = (page) => page.evaluate(async () => (await (await fetch("/api/cart", { cache: "no-store" })).json()));

export const parts = {
  async cart(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 200)));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
    await drill.open(page, "/products/glow-serum");
    await noThanks(page);
    await clearCart(page);
    await page.reload();
    await settle(page);
    const post = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
    drill.check((await post).status() === 200, "add: POST /api/cart 200");
    await page.waitForTimeout(700);
    drill.check(await drawerOpen(page), "add: the drawer opens");
    let c = await cart(page);
    drill.check(c.items?.length === 1 && c.items[0].quantity === 1 && c.subtotal === 1299, "add: the cart holds 1 × Radiance Glow Serum 30ml (₹1,299)", { items: c.items?.map((i) => [i.title, i.quantity]), subtotal: c.subtotal });
    await drill.shoot(page, "1-added");
    // change quantity in the drawer
    await drawer(page).getByRole("button", { name: "Increase quantity" }).first().click();
    await page.waitForTimeout(1200);
    c = await cart(page);
    let dt = await drawer(page).innerText();
    drill.check(c.items[0].quantity === 2 && c.subtotal === 2598 && dt.includes("₹2,598"), "quantity: + makes it 2 (₹2,598), in the drawer and the cart", { q: c.items[0].quantity, subtotal: c.subtotal });
    await drill.shoot(page, "2-quantity-2");
    await drawer(page).getByRole("button", { name: "Decrease quantity" }).first().click();
    await page.waitForTimeout(1200);
    c = await cart(page);
    drill.check(c.items[0].quantity === 1 && c.subtotal === 1299, "quantity: − takes it back to 1", { q: c.items[0].quantity, subtotal: c.subtotal });
    // checkout works
    await drawer(page).getByRole("link", { name: /Checkout/ }).first().click().catch(async () => drill.open(page, "/checkout"));
    await page.waitForURL(/\/checkout/, { timeout: 30_000 });
    await settle(page);
    const co = await text(page);
    drill.check(co.includes("Contact & shipping address") && co.includes("Radiance Glow Serum 30ml"), "checkout: the drawer's Checkout opens checkout with the item", co.slice(0, 160));
    await drill.shoot(page, "3-checkout");
    // remove
    await drill.open(page, "/products/glow-serum");
    await page.getByRole("button", { name: /Open cart/ }).first().click();
    await page.waitForTimeout(600);
    await drawer(page).getByRole("button", { name: "Remove item" }).first().click();
    await page.waitForTimeout(1200);
    c = await cart(page);
    dt = await drawer(page).innerText();
    const btn = await page.getByRole("button", { name: /Open cart/ }).first().getAttribute("aria-label");
    drill.check(c.items.length === 0 && !dt.includes("Radiance Glow Serum 30ml"), "remove: the item goes, from the drawer and the cart", dt.slice(0, 160));
    drill.note(`remove: the header button now reads "${btn}"`);
    await drill.shoot(page, "4-removed");
    await drill.open(page, "/checkout");
    const empty = await text(page);
    drill.note(`checkout with an empty cart reads: ${JSON.stringify(empty.slice(0, 200))}`);
    drill.check(!/Something went wrong/.test(empty), "checkout with an empty cart: no error page");
    await drill.shoot(page, "5-checkout-empty");
    drill.check(errs.length === 0, "no console or page errors", errs.slice(0, 5));
    await ctx.close();
  },
};
