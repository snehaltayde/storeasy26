// drill:checkout stage "addresses" (Phase 8 line 3, docs/plans/phase-8.md
// "Drill checkout/stage-addresses"). A signed-out shopper sees no saved
// addresses at checkout, only a sign-in link that comes back to checkout; signs
// in with the email code (read from the store's notifications row); saves two
// addresses in /account and makes the second the default; at checkout the
// default is picked, the other can be picked, and a new address with "Save"
// ticked is saved on Continue; the order stamps its last_used_at; in /account
// it is deleted after a confirm while the order keeps its copy; signed out
// again, the picker is gone. Cash on delivery only; the email is a test address
// on a domain that takes no mail.
import { ORIGIN, flow, orderRow, rolesSql, seedStore, shopper, stage } from "./lib.mjs";

const EMAIL = `address-drill-${Date.now()}@example.test`;
const HOME = { label: "Home", name: "Address Drill", phone: "9999999999", line1: "11 Home Street", line2: "Flat 1", city: "Pune", state: "Maharashtra", pincode: "411001" };
const WORK = { label: "Work", name: "Address Drill", phone: "9999999999", line1: "22 Work Road", line2: "", city: "Mumbai", state: "Maharashtra", pincode: "400001" };
const TYPO = { line1: "33 New Lnae", city: "Nagpur", state: "Maharashtra", pincode: "440001" };
const NEW = { ...TYPO, line1: "33 New Lane" };

async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const addressRows = async () => (await rolesSql([{ sql: "SELECT a.* FROM customer_addresses a JOIN customers c ON c.id = a.customer_id WHERE c.email = ? ORDER BY a.created_at", args: [EMAIL] }]))[0];

async function addToCart(drill, page, item) {
  await page.goto(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" });
  const added = await page.evaluate(async (variantId) => {
    const res = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 1 }) });
    return res.status;
  }, item.variant_id);
  drill.check(added === 200, "one item goes into the cart", added);
}

async function saveInAccount(page, a, { makeDefault = false } = {}) {
  const book = page.locator('section[aria-labelledby="addresses-heading"]');
  await book.getByRole("button", { name: "Add an address" }).click();
  const form = book.locator('form[aria-label="New address"]');
  for (const [k, v] of Object.entries(a)) await form.locator(`input[name="${k}"]`).fill(v);
  if (makeDefault) await form.getByLabel("Make this my default address").check();
  await form.getByRole("button", { name: "Save address" }).click();
  await book.getByRole("status").filter({ hasText: "Address saved." }).waitFor();
}

stage("addresses", async (drill) => {
  const item = await seedStore();
  const page = await shopper(drill);
  const f = flow(page);
  await addToCart(drill, page, item);

  // signed out: no picker, a sign-in link back to checkout
  await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  const link = f.getByRole("link", { name: "Sign in to use saved addresses" });
  await link.waitFor();
  drill.check((await f.getByRole("radio", { name: "Use a new address" }).count()) === 0 && (await f.getByLabel("Save this address to my account").count()) === 0, "signed out: no saved addresses and no save box at checkout");
  drill.check((await link.getAttribute("href")) === "/account?return=/checkout", "the sign-in link returns to checkout", await link.getAttribute("href"));
  await drill.shoot(page, "addresses-signed-out");
  await link.click();
  await page.waitForURL(/\/account\?return=/);

  // sign in with the emailed code (the notifications row holds it)
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByText("6-digit code").waitFor();
  const code = await until(async () => {
    const [[row]] = await rolesSql([{ sql: "SELECT subject FROM notifications WHERE type = 'customer_otp' AND recipient = ? ORDER BY created_at DESC LIMIT 1", args: [EMAIL] }]);
    return row ? String(row.subject).match(/(\d{6})/)?.[1] : null;
  }, "the sign-in code's notification");
  await page.locator('input[inputmode="numeric"]').fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${ORIGIN}/checkout`);
  drill.check(true, "after sign-in the shopper is back at checkout");
  const saveBox = f.getByLabel("Save this address to my account");
  await saveBox.waitFor();
  drill.check(await saveBox.isChecked(), "signed in with nothing saved: 'Save this address to my account' is ticked by default");

  // /account: save two, make the second the default
  await page.goto(`${ORIGIN}/account`, { waitUntil: "load" });
  await saveInAccount(page, HOME);
  await saveInAccount(page, WORK);
  const workCard = page.locator("li[data-address]").filter({ hasText: WORK.line1 });
  await workCard.getByRole("button", { name: "Make default" }).click();
  await page.getByRole("status").filter({ hasText: "Default address changed." }).waitFor();
  const cards = await page.locator("li[data-address]").allInnerTexts();
  drill.check(cards.length === 2 && cards[0].includes(WORK.line1) && !cards[0].includes("Make default") && cards[1].includes("Make default"), "two saved, the second is now the default and listed first", cards);
  const rows = await addressRows();
  drill.check(rows.length === 2 && rows.filter((r) => r.is_default).length === 1 && rows.find((r) => r.is_default).line1 === WORK.line1, "the store holds two addresses, one default", rows.map((r) => [r.line1, r.is_default]));
  await drill.shoot(page, "addresses-account");

  // checkout: the default is picked, the other can be picked
  await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  const line1 = f.locator('input[name="line1"]');
  await until(async () => (await line1.inputValue()) === WORK.line1, "the default fills the form");
  const radios = f.getByRole("radio");
  drill.check((await radios.count()) === 3, "one card per saved address and 'Use a new address'", await radios.count());
  drill.check(await f.locator("label").filter({ hasText: WORK.line1 }).getByRole("radio").isChecked(), "the default address is picked");
  drill.check((await f.locator('input[name="email"]').inputValue()) === EMAIL, "the shopper's email is filled in");
  await drill.shoot(page, "addresses-picker");
  await f.locator("label").filter({ hasText: HOME.line1 }).getByRole("radio").check();
  await until(async () => (await line1.inputValue()) === HOME.line1, "picking the other fills it");
  drill.check((await f.locator('input[name="city"]').inputValue()) === HOME.city && (await saveBox.count()) === 0, "picking the other address fills it, with no save box");

  // a new address, "Save" ticked, saved on Continue
  await f.getByRole("radio", { name: "Use a new address" }).check();
  await until(async () => (await line1.inputValue()) === "", "a new address clears the address fields");
  drill.check(await saveBox.isChecked(), "a new address has 'Save this address to my account' ticked");
  for (const [k, v] of Object.entries(TYPO)) await f.locator(`input[name="${k}"]`).fill(v);
  const isSave = (x) => x.url().endsWith("/api/account") && x.request().method() === "POST" && x.request().postDataJSON()?.action === "address_save";
  const saved = page.waitForResponse(isSave);
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("heading", { name: "Review your order" }).waitFor();
  const res = await saved;
  drill.check(res.status() === 200, "Continue saves the new address (POST address_save answers 200)", res.status());
  drill.check((await addressRows()).some((r) => r.line1 === TYPO.line1), "the new address is in the store");

  // Edit → fix the typo → Continue: the row saved in this checkout is edited, not added again
  await f.getByRole("button", { name: "Edit" }).click();
  await until(async () => (await line1.inputValue()) === TYPO.line1, "the address step is back");
  await line1.fill(NEW.line1);
  const edited = page.waitForResponse(isSave);
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("heading", { name: "Review your order" }).waitFor();
  const er = await edited;
  drill.check(er.status() === 200 && Boolean(er.request().postDataJSON()?.address?.id), "fixing it edits the saved row (address_save carries its id)", er.status());
  const afterEdit = await addressRows();
  drill.check(afterEdit.length === 3 && afterEdit.some((r) => r.line1 === NEW.line1) && !afterEdit.some((r) => r.line1 === TYPO.line1), "still three addresses, the typo is gone", afterEdit.map((r) => r.line1));

  // Edit → untick → change → Continue: nothing saved, and the box stays unticked when the step comes back
  await f.getByRole("button", { name: "Edit" }).click();
  await until(async () => (await line1.inputValue()) === NEW.line1, "the address step is back");
  await f.locator('input[name="line2"]').fill("Back gate");
  await saveBox.uncheck();
  let posted = false;
  const spy = (x) => {
    if (isSave(x)) posted = true;
  };
  page.on("request", spy);
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("heading", { name: "Review your order" }).waitFor();
  await page.waitForTimeout(1000);
  page.off("request", spy);
  drill.check(!posted && (await addressRows()).length === 3, "unticked: Continue saves nothing");
  await f.getByRole("button", { name: "Edit" }).click();
  await saveBox.waitFor();
  drill.check(!(await saveBox.isChecked()), "back on the address step, the box is still unticked");
  await f.locator('input[name="line2"]').fill("");
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("heading", { name: "Review your order" }).waitFor();

  // place the order (cash on delivery): its address gets last_used_at
  await f.getByRole("button", { name: "Continue to payment" }).click();
  await f.getByRole("heading", { name: "Payment" }).waitFor();
  await f.getByRole("button", { name: /^Place order · / }).click();
  await page.waitForURL(/\/checkout\/confirmation\/[^/?]+/);
  const orderId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  const used = await until(async () => (await addressRows()).find((r) => r.line1 === NEW.line1 && r.last_used_at), "last_used_at on the order's address");
  drill.check(Boolean(used), "placing the order stamps the address's last_used_at", used?.last_used_at);
  drill.check((await addressRows()).filter((r) => r.last_used_at).length === 1, "only that address is stamped");

  // /account: the new one is there; delete it after the confirm
  await page.goto(`${ORIGIN}/account`, { waitUntil: "load" });
  const newCard = page.locator("li[data-address]").filter({ hasText: NEW.line1 });
  await newCard.waitFor();
  drill.check((await page.locator("li[data-address]").count()) === 3, "the address saved at checkout appears in /account", await page.locator("li[data-address]").count());
  await newCard.getByRole("button", { name: "Delete" }).click();
  await newCard.getByText("Delete this address? Past orders keep their copy.").waitFor();
  await drill.shoot(page, "addresses-delete-confirm");
  await newCard.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Address deleted." }).waitFor();
  drill.check(!(await addressRows()).some((r) => r.line1 === NEW.line1), "delete removes the row");
  const order = await orderRow(orderId);
  drill.check(order?.address_line1 === NEW.line1 && JSON.parse(order.snapshot).address?.line1 === NEW.line1, "the order keeps its own copy of the address", order?.address_line1);

  // signed out again: the picker is gone
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${ORIGIN}/`);
  await addToCart(drill, page, item); // the order emptied the cart
  await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  await f.getByRole("link", { name: "Sign in to use saved addresses" }).waitFor();
  drill.check((await f.getByRole("radio", { name: "Use a new address" }).count()) === 0, "signed out: the saved addresses are gone from checkout");
  await page.context().close();
});
