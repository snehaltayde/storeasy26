// drill:checkout stage "pincode" (Phase 8 line 1), on the hand-written pincode
// fixture (PINCODE_DATA_FILE, set by scripts/drills/run-isolated.mjs). The
// owner sets delivery days in Settings → Shipping; the shopper checks 560001 on
// the product page ("Check delivery"), and that PIN prefills the checkout,
// where city and state fill and the estimate shows; a city the shopper typed
// survives a PIN change; a PIN the dataset doesn't know still places a cash on
// delivery order, whose confirmation says "Expected by …". Never pays online.
import { CONTACT, ORIGIN, flow, openStore, orderRow, seedStore, shopper, stage } from "./lib.mjs";
import { open, signIn } from "../apps/lib.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

stage("pincode", async (drill) => {
  const item = await seedStore();
  await openStore(drill);

  // the owner: 1 day to dispatch, 2–4 days to deliver
  const owner = await signIn(drill, "owner");
  drill.check((await open(owner, "/admin/settings/shipping")) === 200, "owner: Settings → Shipping opens");
  await owner.locator("#st-dispatchDays").fill("1");
  await owner.locator("#st-delivery-min").fill("2");
  await owner.locator("#st-delivery-max").fill("4");
  const example = owner.locator('[data-settings="shipping-example"]');
  await example.getByText(/arrives in 3–5 days/).waitFor();
  drill.check((await example.innerText()).includes("Delivery by"), "owner: the worked example says the delivery date shoppers see");
  await drill.shoot(owner, "settings-delivery");
  const saved = owner.waitForResponse((x) => x.url().endsWith("/api/admin/settings") && x.request().method() === "PUT");
  await owner.getByRole("button", { name: "Save shipping" }).click();
  drill.check((await saved).status() === 200, "owner: Save shipping answers 200");
  await owner.context().close();
  await wait(1500); // the store's config cache (PLATFORM_CACHE_MS=1000)

  const page = await shopper(drill);

  // the product page: Check delivery
  const r = await page.goto(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" });
  drill.check(r?.status() === 200, "the product page answers 200", r?.status());
  const check = page.locator("[data-delivery-check]");
  await check.locator("input[name=pin]").fill("560001");
  await check.getByRole("button", { name: "Check" }).click();
  await check.getByText("Bengaluru, Karnataka").waitFor();
  const pdp = await check.innerText();
  drill.check(/Delivery by \w{3} \d{1,2} \w{3}/.test(pdp), "Check delivery shows the estimate", pdp);
  drill.check(pdp.includes("Cash on delivery available"), "Check delivery says cash on delivery is available", pdp);
  drill.check((await page.evaluate(() => localStorage.getItem("sf_pin"))) === "560001", "the PIN is kept in localStorage (sf_pin)");
  await drill.shoot(page, "pdp-check-delivery");

  const added = await page.evaluate(async (variantId) => {
    const res = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 1 }) });
    return res.status;
  }, item.variant_id);
  drill.check(added === 200, "one item goes into the cart", added);

  // the checkout: the PIN comes first and is prefilled; city and state fill
  const c = await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  drill.check(c?.status() === 200, "the checkout page answers 200", c?.status());
  const f = flow(page);
  await f.getByRole("heading", { name: "Contact & shipping address" }).waitFor();
  const pinFirst = await page.evaluate(() => {
    const [pin, email] = ["pincode", "email"].map((n) => document.querySelector(`[data-protected="checkout"] input[name="${n}"]`));
    return Boolean(pin && email && pin.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  drill.check(pinFirst, "the PIN code is asked first (before the contact fields)");
  const pin = f.locator('input[name="pincode"]');
  await f.locator("[data-pincode-place]").getByText("Bengaluru, Karnataka").waitFor();
  drill.check((await pin.inputValue()) === "560001", "the PIN checked on the product page prefills the checkout");
  drill.check(/Delivery by/.test(await f.locator("[data-delivery-estimate]").innerText()), "the estimate shows under the PIN");
  await drill.shoot(page, "checkout-pin-filled");

  // Change opens city and state; a typed city survives a PIN change
  await f.locator("[data-pincode-place]").getByRole("button", { name: "Change" }).click();
  const city = f.locator('input[name="city"]');
  const state = f.locator('input[name="state"]');
  drill.check((await city.inputValue()) === "Bengaluru" && (await state.inputValue()) === "Karnataka", "Change shows the filled city and state to edit");
  await city.fill("Bangalore Urban");
  await pin.fill("411001");
  await page.waitForFunction(() => document.querySelector('input[name="state"]')?.value === "Maharashtra");
  drill.check((await city.inputValue()) === "Bangalore Urban", "a typed city survives a PIN change (the auto-filled state follows the PIN)", await city.inputValue());

  // a PIN the dataset doesn't know: the message, and the order still goes through
  await pin.fill("999999");
  const note = f.locator("[data-pincode-message]");
  await note.waitFor();
  drill.check((await note.innerText()).startsWith("We couldn't find that PIN code."), "an unknown PIN says so", await note.innerText());
  await pin.fill("99999");
  await pin.blur();
  drill.check((await note.innerText()) === "Enter a 6-digit PIN code.", "a short PIN is a format error", await note.innerText());
  await pin.fill("999999");
  await note.getByText(/couldn't find/).waitFor();
  for (const [name, value] of Object.entries({ ...CONTACT, line1: "2 Test Road", line2: "", city: "Testpur", state: "Maharashtra" })) await f.locator(`input[name="${name}"]`).fill(value);
  const cont = f.getByRole("button", { name: "Continue to review" });
  drill.check(await cont.isEnabled(), "an unknown PIN with a typed city and state can continue");
  await cont.click();
  await f.getByRole("heading", { name: "Review your order" }).waitFor();
  await f.getByRole("button", { name: "Continue to payment" }).click();
  await f.getByRole("heading", { name: "Payment" }).waitFor();
  const answered = page.waitForResponse((x) => x.url().endsWith("/api/checkout") && x.request().method() === "POST");
  await f.getByRole("button", { name: /^Place order · / }).click();
  const res = await answered;
  drill.check(res.status() === 200, "the cash on delivery order is placed with an unknown PIN", res.status());
  await page.waitForURL(/\/checkout\/confirmation\/[^/?]+/);
  const orderId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  const expected = page.locator('[data-delivery-estimate="expected"]');
  await expected.waitFor();
  drill.check(/^Expected by \w{3} \d{1,2} \w{3}$/.test((await expected.innerText()).trim()), "the confirmation says Expected by …", await expected.innerText());
  await drill.shoot(page, "confirmation-expected");

  const order = await orderRow(orderId);
  const snap = JSON.parse(order?.snapshot || "{}");
  drill.check(JSON.stringify(snap.shipping?.estimate) === JSON.stringify({ minDays: 3, maxDays: 5 }) && snap.shipping?.zoneCod !== false, "the order's snapshot keeps the estimate (and no zone turned COD off)", snap.shipping);
  drill.check(order?.pincode === "999999" && order?.city === "Testpur", "the order holds the PIN and the typed city", order && { pincode: order.pincode, city: order.city });
  await page.context().close();
});
