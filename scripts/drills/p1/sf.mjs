// Storefront helpers for the P1 drills: a shopper on the harness storefront.
import { settle, drawerOpen } from "../../drill.js";

// Answer the cookie banner the privacy-preserving way ("No thanks"), if it shows.
export async function noThanks(page) {
  const b = page.getByRole("button", { name: "No thanks", exact: true });
  if (await b.count().catch(() => 0)) await b.first().click({ timeout: 3000 }).catch(() => {});
}

// Product page → set quantity → Add to cart, through the real buttons.
export async function addToCart(drill, page, handle, qty = 1) {
  await drill.open(page, `/products/${handle}`);
  await noThanks(page);
  const main = page.locator("main");
  for (let i = 1; i < qty; i++) await main.getByRole("button", { name: "Increase quantity" }).first().click();
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const res = await posted;
  await page.waitForTimeout(600);
  return { status: res.status(), drawer: await drawerOpen(page) };
}

export async function clearCart(page) {
  return page.evaluate(async () => {
    const c = await (await fetch("/api/cart")).json();
    for (const it of c.items || []) await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", variantId: it.variantId }) });
    return (c.items || []).length;
  });
}

export const SHOPPER = {
  email: "drill@design.test",
  phone: "9876500000",
  name: "Drill Shopper",
  line1: "12 Test Lane",
  line2: "",
  city: "Pune",
  state: "Maharashtra",
  pincode: "411001",
};

// /checkout → address → review → payment → Cash on Delivery → Place order.
// Returns { orderId, confirmationPath, texts: { address, review, payment } }.
export async function checkoutCod(drill, page, { shopper = SHOPPER, onStep } = {}) {
  await drill.open(page, "/checkout");
  await noThanks(page);
  const texts = {};
  for (const [k, v] of Object.entries(shopper)) if (v) await page.locator(`input[name="${k}"]`).fill(v);
  texts.address = await page.evaluate(() => document.body.innerText);
  if (onStep) await onStep("address");
  await page.getByRole("button", { name: "Continue to review" }).click();
  await page.getByRole("heading", { name: "Review your order" }).waitFor({ timeout: 15_000 });
  texts.review = await page.evaluate(() => document.body.innerText);
  if (onStep) await onStep("review");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await page.getByRole("heading", { name: "Payment" }).waitFor({ timeout: 15_000 });
  await page.locator('input[name="method"]').first().check();
  texts.payment = await page.evaluate(() => document.body.innerText);
  if (onStep) await onStep("payment");
  await page.getByRole("button", { name: /^Place order/ }).click();
  await page.waitForURL(/\/checkout\/confirmation\//, { timeout: 60_000 });
  await settle(page);
  texts.confirmation = await page.evaluate(() => document.body.innerText);
  const path = new URL(page.url()).pathname;
  const orderId = decodeURIComponent(path.split("/").pop());
  return { orderId, confirmationPath: path, texts };
}
