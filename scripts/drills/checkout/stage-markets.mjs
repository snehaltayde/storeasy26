// drill:checkout stage "markets" (Phase 8 line 4): selling in another currency
// in a real browser. The admin saves a US market through Settings' own API
// (USD at a fixed rate, x.99 rounding, its own shipping, the Razorpay tick and
// test keys); support and staff get no access to Settings → Markets. The
// shopper picks "United States ($)" in the footer; the product page and the
// cart drawer show dollars, the converted price of the same function the
// server uses; checkout says "You'll be charged in USD" with no cash on
// delivery; switching the country to India gives the rupee total and cash on
// delivery. Nothing is paid (no card is ever entered). The store is put back.
import { ADDRESS, CONTACT, ORIGIN, flow, seedStore, shopper, stage } from "./lib.mjs";
import { drawer } from "../mobile-cart/lib.mjs";
import { open, signIn } from "../apps/lib.mjs";
import { convertPrice } from "../../../lib/markets.js";
import { formatMoney } from "../../../lib/format.js";

const putSettings = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, body);

const US = { id: "US", countries: ["US"], currency: "USD", rate: 84.2, rounding: "x.99", flatRate: 10, freeThreshold: "", enabled: true, international: true };
const US_ADDRESS = { line1: "1 Main St", line2: "", city: "Austin", state: "TX", pincode: "78701" };

stage("markets", async (drill) => {
  const item = await seedStore();
  const admin = await signIn(drill, "admin");
  await open(admin, "/admin/settings/markets");
  drill.check(await admin.getByRole("heading", { name: "Markets" }).isVisible(), "admin: Settings → Markets opens");
  const saved = await putSettings(admin, { payments: { razorpay_key_id: "rzp_test_drillmk", razorpay_key_secret: "drill-only-secret" }, markets: [US] });
  drill.check(saved.status === 200, "admin: the US market is saved", saved.json);
  const refused = await putSettings(admin, { markets: [{ ...US, international: false }] });
  drill.check(refused.status === 422, "admin: a market without the Razorpay tick is refused", refused.json);
  await admin.reload({ waitUntil: "load" });
  drill.check(await admin.locator('[data-market="US"]').isVisible(), "admin: the saved market is listed with its price example");
  await drill.shoot(admin, "markets-settings");
  for (const role of ["support", "staff"]) {
    const p = await signIn(drill, role);
    await open(p, "/admin/settings/markets");
    drill.check((await p.getByText(/can't open/).count()) > 0 && (await p.locator('[data-settings-tab="markets"]').count()) === 0, `${role}: Settings → Markets is no access`);
    await p.context().close();
  }

  const usd = formatMoney(convertPrice(Number(item.price), US), "USD");
  const page = await shopper(drill);
  await page.goto(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" });
  const picker = page.locator('[data-part="market-picker"] select');
  drill.check((await picker.count()) === 1, "the footer has the Ship to picker");
  await Promise.all([page.waitForURL(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" }), picker.selectOption("US")]);
  drill.check((await picker.inputValue()) === "US", "the shopper chose United States ($)");
  drill.check((await page.getByText(usd, { exact: true }).count()) > 0, `the product page shows ${usd}`);
  await drill.shoot(page, "markets-pdp");

  const added = await page.evaluate(
    (variantId) => fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 2 }) }).then((r) => r.json()),
    item.variant_id,
  );
  drill.check(added.currency === "USD" && added.items?.[0]?.lineTotal === Number((convertPrice(Number(item.price), US) * 2).toFixed(2)), "the cart line is the product page's price × 2, in USD", added.items?.[0]);
  await page.reload({ waitUntil: "load" });
  await page.getByRole("button", { name: /^Open cart/ }).first().click();
  const total = drawer(page).locator("[data-cart-total]");
  await total.waitFor();
  drill.check((await total.innerText()) === formatMoney(added.grandTotal, "USD"), "the drawer total is in dollars", await total.innerText());
  await drill.shoot(page, "markets-drawer");

  await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  const f = flow(page);
  drill.check((await f.locator('select[name="country_code"]').inputValue()) === "US", "checkout starts in the United States");
  for (const [name, value] of Object.entries({ ...CONTACT, ...US_ADDRESS })) await f.locator(`input[name="${name}"]`).fill(value);
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("button", { name: "Continue to payment" }).click();
  await f.getByRole("heading", { name: "Payment" }).waitFor();
  const charged = f.locator('[data-checkout="charged-in"]');
  await charged.waitFor();
  drill.check((await charged.innerText()) === "You'll be charged in USD.", "the Pay button says the charge is in USD");
  drill.check((await f.getByRole("button", { name: /^Pay \$/ }).count()) === 1, "the button is a dollar amount");
  drill.check((await f.getByRole("radio").count()) <= 1 && (await f.getByText("Cash on Delivery").count()) === 0, "no cash on delivery outside India");
  await drill.shoot(page, "markets-checkout-usd");

  // back to the address; India brings rupees and cash on delivery back
  await f.getByRole("button", { name: "Back" }).click();
  await f.getByRole("button", { name: "Back" }).click();
  const moved = page.waitForResponse((x) => x.url().endsWith("/api/checkout") && x.request().postDataJSON()?.address?.country_code === "IN");
  await f.locator('select[name="country_code"]').selectOption("IN");
  await moved;
  for (const [name, value] of Object.entries(ADDRESS)) await f.locator(`input[name="${name}"]`).fill(value);
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("button", { name: "Continue to payment" }).click();
  await f.getByRole("button", { name: /^Place order · ₹/ }).waitFor();
  drill.check((await f.locator('[data-checkout="charged-in"]').count()) === 0, "India: no charged-in note, the total is in rupees with cash on delivery");
  await drill.shoot(page, "markets-checkout-inr");
  await page.context().close();

  const reset = await putSettings(admin, { payments: { razorpay_key_id: "" }, markets: [] });
  drill.check(reset.status === 200, "admin: the markets and keys are put back", reset.json);
  await admin.context().close();
});
