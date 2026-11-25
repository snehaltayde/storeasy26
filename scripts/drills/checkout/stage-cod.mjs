// drill:checkout stage "cod" (Phase 8 line 2): the prepaid nudge and the COD
// code in a real browser. The owner saves a 5% prepaid discount, a code on
// every COD order (SMS through the local stub, or email where SMS is refused)
// and test Razorpay keys through Settings' own API. The shopper sees the nudge
// with the quote's numbers; "Pay online instead" moves the button to the
// quoted prepaid total (never pressed: no card is ever entered); back on cash
// on delivery, Place order opens the code dialog; a wrong code shows its
// sentence; the code read from the notifications row places the order; the
// owner's order page says "Phone confirmed by code". The rules are put back.
import { ADDRESS, CONTACT, ORIGIN, flow, money, orderRow, rolesSql, seedStore, shopper, shopperErrors, stage } from "./lib.mjs";
import { open, signIn } from "../apps/lib.mjs";

const putSettings = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, body);

stage("cod", async (drill) => {
  const item = await seedStore();
  const owner = await signIn(drill, "owner");
  await open(owner, "/admin/settings/checkout");
  const keys = { razorpay_key_id: "rzp_test_drillcod", razorpay_key_secret: "drill-only-secret" };
  let channel = "sms";
  let saved = await putSettings(owner, { payments: keys, payment_config: { prepaid: { kind: "percent", value: 5 }, cod: { otp: "always", otpChannel: "sms" } } });
  if (saved.status === 422 && (saved.json?.errors || []).some((e) => /SMS/.test(e))) {
    channel = "email"; // a server with no SMS provider refuses SMS: the code goes by email
    saved = await putSettings(owner, { payments: keys, payment_config: { prepaid: { kind: "percent", value: 5 }, cod: { otp: "always", otpChannel: "email" } } });
  }
  drill.check(saved.status === 200, `owner: the prepaid discount and the COD code (${channel}) are saved`, saved.json);

  const page = await shopper(drill);
  await page.goto(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" });
  const added = await page.evaluate(
    (variantId) => fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 1 }) }).then((r) => r.status),
    item.variant_id,
  );
  drill.check(added === 200, "one item goes into the cart", added);
  await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  const f = flow(page);
  for (const [name, value] of Object.entries({ ...CONTACT, ...ADDRESS })) await f.locator(`input[name="${name}"]`).fill(value);
  await f.getByRole("button", { name: "Continue to review" }).click();
  await f.getByRole("button", { name: "Continue to payment" }).click();
  await f.getByRole("heading", { name: "Payment" }).waitFor();

  // the server's quote, asked for the way the page asks
  const quote = await page.evaluate((address) => fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "quote", address }) }).then((r) => r.json()), ADDRESS);
  const q = quote.quote;
  drill.check(q && q.nudge.save > 0 && q.cod.otpRequired, "the quote has a nudge and asks for a code", q);
  const nudge = f.locator('[data-checkout="prepaid-nudge"]');
  await nudge.waitFor();
  const words = await nudge.innerText();
  drill.check(money(words.match(/save ₹([\d,.]+)/)?.[1]) === q.nudge.save && words.includes("Pay online instead"), "the nudge says the quote's saving", { words, save: q.nudge.save });
  const save = await f.locator('[data-checkout="prepaid-save"]').innerText();
  drill.check(money(save) === q.nudge.save, "the online option shows Save with the same amount", save);
  const placeButton = f.getByRole("button", { name: /^Place order · / });
  drill.check(money((await placeButton.innerText()).split("·")[1]) === q.cod.total, "Place order shows the quote's COD total", { button: await placeButton.innerText(), cod: q.cod.total });
  await drill.shoot(page, "cod-nudge");

  await f.getByRole("button", { name: "Pay online instead" }).click();
  const payButton = f.getByRole("button", { name: /^Pay ₹/ });
  await payButton.waitFor();
  drill.check(money(await payButton.innerText()) === q.prepaid.total, "Pay online instead moves the button to the quoted prepaid total", { button: await payButton.innerText(), prepaid: q.prepaid.total });
  drill.check(money(await f.locator("aside div:has(> span:text-is('Total')) > span").last().innerText()) === q.prepaid.total, "the summary's total follows");
  await drill.shoot(page, "cod-pay-online");

  // back to cash on delivery; Place order sends the code
  await f.getByRole("radio").first().check();
  const sent = page.waitForResponse((x) => x.url().endsWith("/api/checkout") && x.request().postDataJSON()?.action === "cod_otp_send");
  await f.getByRole("button", { name: /^Place order · / }).click();
  const sendRes = await sent;
  drill.check(sendRes.status() === 200, "POST /api/checkout (cod_otp_send) answers 200", sendRes.status());
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const told = await dialog.innerText();
  drill.check(channel === "sms" ? told.includes("We sent a code to +91 ••••••9999") : told.includes("We sent a code to s•••@mediastic.in"), "the dialog says where the code went, masked", told.slice(0, 120));
  drill.check((await dialog.locator('input[autocomplete="one-time-code"]').count()) === 1, "the code field is one-time-code");
  // the message is written just after the answer (after()), so wait for it briefly
  let row = null;
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    [[row]] = await rolesSql(["SELECT body FROM notifications WHERE type = 'cod_otp' ORDER BY created_at DESC LIMIT 1"]);
    code = String(row?.body || "").match(/^(\d{6}) /)?.[1] || null;
    if (!code) await new Promise((r) => setTimeout(r, 250));
  }
  drill.check(Boolean(code), "the code is in the notifications row", row?.body?.slice(0, 40));
  await drill.shoot(page, "cod-otp");

  const codeField = dialog.locator('input[autocomplete="one-time-code"]');
  await codeField.fill(code === "000000" ? "111111" : "000000");
  await dialog.getByRole("button", { name: "Confirm and place order" }).click();
  await dialog.getByRole("alert").waitFor();
  drill.check((await dialog.getByRole("alert").innerText()) === "That code isn't right. Check it and try again.", "a wrong code shows its sentence");
  // the wrong code's 409 is the answer this check asked for: the browser logs it, drop that one line
  const expected = shopperErrors.findIndex((e) => /status of 409 \(Conflict\)/.test(e));
  drill.check(expected >= 0, "the browser saw the wrong code's 409");
  if (expected >= 0) shopperErrors.splice(expected, 1);

  await codeField.fill(code);
  const placed = page.waitForResponse((x) => x.url().endsWith("/api/checkout") && x.request().postDataJSON()?.action === "cod");
  await dialog.getByRole("button", { name: "Confirm and place order" }).click();
  const placedRes = await placed;
  drill.check(placedRes.status() === 200, "the right code places the order (cod answers 200)", placedRes.status());
  await page.waitForURL(/\/checkout\/confirmation\/[^/?]+/);
  const orderId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  const order = await orderRow(orderId);
  drill.check(Number(order?.total) === q.cod.total && Boolean(order?.cod_verified_at), "the order is the quote's COD total and records the check", order && { total: order.total, cod_verified_at: order.cod_verified_at });
  await page.context().close();

  const status = await open(owner, `/admin/orders/${encodeURIComponent(orderId)}`);
  drill.check(status === 200, "owner: the order page opens", status);
  // SMS proves the phone; email proves only the email, and the order says so
  const proved = channel === "sms" ? "Phone confirmed by code" : "Email confirmed by code";
  drill.check(await owner.getByText(proved).isVisible(), `owner: the order says ${proved}`);
  await drill.shoot(owner, "cod-order");

  // put the store back for the stages after this one
  await open(owner, "/admin/settings/checkout");
  const reset = await putSettings(owner, { payments: { razorpay_key_id: "" }, payment_config: {} });
  drill.check(reset.status === 200, "owner: the payment rules are put back", reset.json);
  await owner.context().close();
});
