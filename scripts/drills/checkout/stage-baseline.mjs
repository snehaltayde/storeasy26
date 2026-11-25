// drill:checkout stage "baseline" (Phase 8 step 0): the checkout as it is
// before lines 1–3 change it. The stage sets its own starting state (no offer,
// one product in the cart), fills the address, reviews it, keeps cash on
// delivery and places the order; the confirmation page opens and the order's
// row holds the address and the total the button showed. Never pays online.
import { ADDRESS, CONTACT, ORIGIN, flow, money, openStore, orderRow, seedStore, shopper, stage } from "./lib.mjs";

stage("baseline", async (drill) => {
  const item = await seedStore();
  await openStore(drill);

  const page = await shopper(drill);
  const r = await page.goto(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" });
  drill.check(r?.status() === 200, "the shopper's product page answers 200", r?.status());
  const added = await page.evaluate(async (variantId) => {
    const res = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 1 }) });
    return { status: res.status, cart: await res.json().catch(() => null) };
  }, item.variant_id);
  drill.check(added.status === 200, "one item goes into the cart (POST /api/cart answers 200)", added.status);
  const cart = await page.evaluate(() => fetch("/api/cart", { cache: "no-store" }).then((x) => x.json()));

  const c = await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  drill.check(c?.status() === 200, "the checkout page answers 200", c?.status());
  const f = flow(page);
  await f.getByRole("heading", { name: "Contact & shipping address" }).waitFor();
  const cont = f.getByRole("button", { name: "Continue to review" });
  drill.check(await cont.isDisabled(), "with an empty form, Continue to review is disabled");
  for (const [name, value] of Object.entries({ ...CONTACT, ...ADDRESS })) await f.locator(`input[name="${name}"]`).fill(value);
  drill.check(await cont.isEnabled(), "a filled address enables Continue to review");
  await drill.shoot(page, "address");
  await cont.click();

  await f.getByRole("heading", { name: "Review your order" }).waitFor();
  const review = await f.locator("section").innerText();
  drill.check(review.includes(CONTACT.name) && review.includes(`${ADDRESS.line1}, ${ADDRESS.line2}, ${ADDRESS.city}, ${ADDRESS.state} ${ADDRESS.pincode}`), "the review shows the address as typed", review.slice(0, 200));
  drill.check(review.includes(item.title), "the review lists the item", item.title);
  await f.getByRole("button", { name: "Continue to payment" }).click();

  await f.getByRole("heading", { name: "Payment" }).waitFor();
  drill.check(await f.getByRole("radio").first().isChecked(), "cash on delivery is chosen by default");
  const summary = f.locator("aside");
  const summaryTotal = money(await summary.locator("div:has(> span:text-is('Total')) > span").last().innerText());
  const codFee = (await summary.innerText()).includes("incl. COD fee");
  drill.check(summaryTotal >= cart.grandTotal && (codFee || summaryTotal === cart.grandTotal), "the summary's total is the cart's (plus the cash on delivery fee it says it adds)", { summaryTotal, cart: cart.grandTotal, codFee });
  const place = f.getByRole("button", { name: /^Place order · / });
  const shown = money((await place.innerText()).split("·")[1]);
  drill.check(shown === summaryTotal, "the button shows the summary's total", { shown, summaryTotal });
  await drill.shoot(page, "payment");

  const answered = page.waitForResponse((x) => x.url().endsWith("/api/checkout") && x.request().method() === "POST");
  await place.click();
  const res = await answered;
  drill.check(res.status() === 200 && res.request().postDataJSON()?.action === "cod", "POST /api/checkout (cod) answers 200", res.status());
  // the page navigates at once, so the order id is read from the confirmation path
  await page.waitForURL(/\/checkout\/confirmation\/[^/?]+/);
  const orderId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  drill.check(Boolean(orderId), "the confirmation page opens for the new order", orderId);
  await drill.shoot(page, "confirmation");

  const order = await orderRow(orderId);
  drill.check(order?.payment_method === "cod", "the order is cash on delivery", order?.payment_method);
  drill.check(Number(order?.total) === shown, "the order's total is the one the button showed", { order: order?.total, shown });
  drill.check(Math.abs(Number(order?.subtotal) - Number(order?.discount_total) + Number(order?.shipping_total) - Number(order?.total)) < 0.005, "total = subtotal − discounts + shipping", order && { subtotal: order.subtotal, discount: order.discount_total, shipping: order.shipping_total, total: order.total });
  const stored = order && { email: order.email, phone: order.phone, name: order.name, line1: order.address_line1, line2: order.address_line2, city: order.city, state: order.state, pincode: order.pincode, country: order.country };
  drill.check(JSON.stringify(stored) === JSON.stringify({ ...CONTACT, ...ADDRESS, country: "India" }), "the order holds the address as typed (country India)", stored);
  await page.context().close();
});
