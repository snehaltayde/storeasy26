// drill:plugins stage "subscriptions" (Phase 9 line 2): a shopper signs in
// (an email code, read from the store's own notifications row), subscribes on
// a product page and places a cash on delivery order; /account lists the
// subscription; Skip moves the due date, Swap changes the variant, Pause and
// Resume; with the due date moved into the reminder window a jobs tick runs
// the sweep, which marks the delivery due and emails one reminder; "Pay for
// this delivery" reaches the checkout, whose quote is the account's figure;
// Cancel keeps it as cancelled; signed out, the API reads nothing. No card
// details are ever entered. The stage sets up its own starting state.
import { ORIGIN, rolesSql, shopper, stage } from "./lib.mjs";

const EMAIL = "snehal@mediastic.in";
const CONTACT = { email: EMAIL, phone: "9876500001", name: "Subscriptions Drill" };
const ADDRESS = { line1: "1 Drill Road", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", country_code: "IN" };
const SETTINGS = { discount_percent: 10, every_14: false, every_30: true, every_45: false, every_60: true, every_90: false, eligible: "all", eligible_tag: "", reminder_days: 3, grace_days: 7 };
const money = (s) => Number(String(s || "").replace(/[^\d.]/g, ""));
const json = (page, path, method = "GET", body) =>
  page.evaluate(
    async ([p, m, b]) => {
      const res = await fetch(p, { method: m, headers: { "Content-Type": "application/json" }, body: b === null ? undefined : JSON.stringify(b) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    [path, method, body ?? null],
  );
const tick = (page) => page.evaluate(async () => (await fetch("/api/jobs/tick", { method: "POST" })).status);
async function until(page, fn, label, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await page.waitForTimeout(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const subRow = async () => (await rolesSql([{ sql: "SELECT s.* FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE c.email = ? ORDER BY s.created_at DESC LIMIT 1", args: [EMAIL] }]))[0][0];

stage("subscriptions", async (drill) => {
  const ts = new Date().toISOString();
  // own starting state: the plugin on (10%, every 30 or 60 days), no earlier subscriptions for this shopper
  await rolesSql([
    {
      sql: `INSERT INTO plugin_installs (id, plugin_id, kind, name, version, status, granted_scopes, settings, installed_by, installed_at, updated_at)
            VALUES ('pin_drillsubs', 'subscriptions', 'first_party', 'Subscriptions', '1.0.0', 'enabled', '[]', ?, 'merchant:drill', ?, ?)
            ON CONFLICT (id) DO UPDATE SET status = 'enabled', settings = excluded.settings, updated_at = excluded.updated_at`,
      args: [JSON.stringify(SETTINGS), ts, ts],
    },
    { sql: "UPDATE subscriptions SET customer_id = NULL, status = 'cancelled' WHERE customer_id IN (SELECT id FROM customers WHERE email = ?)", args: [EMAIL] },
  ]);
  const [products] = await rolesSql([
    "SELECT p.id AS product_id, p.handle, v.id AS variant_id, v.price FROM products p JOIN variants v ON v.product_id = p.id WHERE v.available = 1 AND p.available = 1 AND p.handle NOT IN ('fixture-product-1', 'fixture-product-4') ORDER BY p.handle, v.position LIMIT 8",
  ]);
  const product = products[0];
  const other = products.find((p) => p.product_id !== product?.product_id);
  drill.check(Boolean(product && other), "the roles store has two in-stock products", products.length);
  if (!product || !other) return;

  const page = await shopper(drill);
  await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
  // sign in with an email code, read from the store's own notification row
  const asked = await json(page, "/api/account", "POST", { action: "request_otp", email: EMAIL });
  drill.check(asked.status === 200, "sign-in: a code is requested", asked);
  let code = null;
  await until(page, async () => {
    const [rows] = await rolesSql([{ sql: "SELECT body FROM notifications WHERE type = 'customer_otp' AND lower(recipient) = ? ORDER BY created_at DESC LIMIT 1", args: [EMAIL] }]);
    code = rows[0]?.body?.match(/code is (\d{6})/)?.[1] || null;
    return Boolean(code);
  }, "the sign-in code");
  const verified = await json(page, "/api/account", "POST", { action: "verify", email: EMAIL, code });
  drill.check(verified.status === 200 && verified.json?.customer?.email === EMAIL, "sign-in: the code signs the shopper in", verified.status);

  // the product page: One-time or Subscribe, the price from the server, the honest line
  await page.goto(`${ORIGIN}/products/${product.handle}`, { waitUntil: "load" });
  const choice = page.locator("[data-subscribe-choice]");
  await choice.waitFor({ timeout: 20_000 });
  drill.check((await choice.innerText()).includes("Nothing is charged automatically"), "PDP: says nothing is charged automatically");
  const offer = (await json(page, `/api/cart?subscribe=${encodeURIComponent(product.product_id)}`)).json?.offer;
  const shown = money(await page.locator("[data-subscribe-price]").innerText());
  drill.check(offer && shown === offer.prices[product.variant_id], "PDP: the subscribe price is the server's", { shown, offer });
  await page.locator("[data-subscribe-radio]").check();
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  const line = page.locator('[data-line-subscription="on"]').first();
  await line.waitFor({ timeout: 15_000 });
  drill.check((await line.innerText()).includes("Every 30 days"), "drawer: the line subscribes every 30 days", await line.innerText());
  await drill.shoot(page, "subscribe-drawer");

  // cash on delivery at the quoted total
  const quote = (await json(page, "/api/checkout", "POST", { action: "quote", contact: CONTACT, address: ADDRESS })).json?.quote;
  drill.check(quote?.cod?.available && !quote.cod.otpRequired, "checkout: cash on delivery is offered without a code", quote?.cod);
  const placed = await json(page, "/api/checkout", "POST", { action: "cod", idempotencyKey: `drill-subs-${Date.now()}`, contact: CONTACT, address: ADDRESS, expectedTotal: quote?.cod?.total, expectedShipping: quote?.cod?.shipping });
  drill.check(placed.status === 200 && placed.json?.ok, "checkout: the COD order is placed", placed);
  let sub = null;
  await until(page, async () => Boolean((sub = await subRow())), "the subscription row (runOrderEffects)");
  drill.check(sub.status === "active" && sub.interval_days === 30 && sub.discount_percent === 10, "the order's effects made the subscription", sub);

  // /account lists it
  await page.goto(`${ORIGIN}/account`, { waitUntil: "load" });
  const card = page.locator(`[data-subscription="${sub.id}"]`);
  await card.waitFor({ timeout: 20_000 });
  drill.check((await card.getAttribute("data-subscription-status")) === "active", "/account: the subscription is active");
  const due0 = await card.locator("[data-subscription-due]").innerText();
  await drill.shoot(page, "account-subscription");

  // Skip moves the due date one interval
  await card.locator("[data-subscription-skip]").click();
  await until(page, async () => (await card.locator("[data-subscription-due]").innerText().catch(() => due0)) !== due0, "the due date to move");
  const skipped = await subRow();
  drill.check(Date.parse(skipped.next_due_at) - Date.parse(sub.next_due_at) === 30 * 86400000, "Skip: due moved 30 days", [sub.next_due_at, skipped.next_due_at]);

  // Swap changes the variant (from the next delivery)
  await card.locator("[data-subscription-swap]").click();
  const to = card.locator("[data-subscription-swap-to]");
  await to.waitFor();
  await to.selectOption(other.variant_id);
  await card.locator("[data-subscription-swap-confirm]").click();
  await until(page, async () => (await subRow()).variant_id === other.variant_id, "the swap");
  drill.check(true, "Swap: the variant changed");

  // Pause, then Resume
  await card.locator("[data-subscription-pause]").click();
  await card.locator("[data-subscription-pause-confirm]").click();
  await until(page, async () => (await card.getAttribute("data-subscription-status")) === "paused", "paused");
  await card.locator("[data-subscription-resume]").click();
  await until(page, async () => (await card.getAttribute("data-subscription-status")) === "active", "resumed");
  drill.check((await subRow()).status === "active", "Pause and Resume");

  // the due date inside the reminder window; a tick runs the sweep: due + one reminder
  await rolesSql([{ sql: "UPDATE subscriptions SET next_due_at = ? WHERE id = ?", args: [new Date(Date.now() + 2 * 86400000).toISOString(), sub.id] }]);
  await until(
    page,
    async () => {
      await tick(page);
      const [[c]] = await rolesSql([{ sql: "SELECT status, reminded_at FROM subscription_cycles WHERE subscription_id = ? ORDER BY cycle DESC LIMIT 1", args: [sub.id] }]);
      return c?.status === "due" && Boolean(c.reminded_at);
    },
    "the sweep to mark the delivery due",
    30,
  );
  const [[reminder]] = await rolesSql([{ sql: "SELECT body FROM notifications WHERE type = 'subscription_reminder' AND recipient = ? ORDER BY created_at DESC LIMIT 1", args: [EMAIL] }]);
  drill.check(Boolean(reminder?.body?.includes("Nothing is charged automatically")), "sweep: one reminder email", reminder?.body?.slice(0, 160));

  // Pay for this delivery → the checkout, priced at the account's figure
  await page.goto(`${ORIGIN}/account`, { waitUntil: "load" });
  await card.locator("[data-subscription-pay]").waitFor({ timeout: 20_000 });
  const figureText = (await card.locator("[data-subscription-amount]").innerText()).trim();
  const figure = money(figureText);
  drill.check(Boolean(reminder?.body?.includes(figureText)), "the reminder's amount is the account's figure", { figureText });
  await card.locator("[data-subscription-pay]").click();
  await page.waitForURL(/\/checkout/, { timeout: 20_000 });
  const renewalQuote = (await json(page, "/api/checkout", "POST", { action: "quote", contact: CONTACT, address: ADDRESS })).json?.quote;
  const due = renewalQuote?.prepaid?.available ? renewalQuote.prepaid.total : renewalQuote?.cod?.total;
  drill.check(due === figure, "Pay for this delivery: the checkout's total is the account's figure", { due, figure });
  const cart = (await json(page, "/api/cart")).json;
  drill.check(cart?.renewal?.subscriptionId === sub.id && cart.items?.length === 1, "the renewal cart holds only this delivery", cart?.renewal);
  await drill.shoot(page, "renewal-checkout");

  // Cancel behind its confirm: kept as cancelled
  await page.goto(`${ORIGIN}/account`, { waitUntil: "load" });
  await card.locator("[data-subscription-cancel]").click();
  await card.locator("[data-subscription-cancel-confirm]").click();
  await until(page, async () => (await card.getAttribute("data-subscription-status")) === "cancelled", "cancelled");
  drill.check((await subRow()).status === "cancelled", "Cancel: the row is kept as cancelled");
  await page.context().close();

  // signed out, the subscriptions API reads nothing
  const anon = await shopper(drill);
  await anon.goto(`${ORIGIN}/`, { waitUntil: "load" });
  // (the context's own request, not the page's fetch: a 401 there is the expected answer, not a console error)
  const res = await anon.context().request.get(`${ORIGIN}/api/account/subscriptions`);
  const out = { status: res.status(), json: await res.json().catch(() => null) };
  drill.check(out.status === 401 && JSON.stringify(Object.keys(out.json || {})) === '["error"]', "signed out: 401 with no data", out);
  await anon.context().close();
});
