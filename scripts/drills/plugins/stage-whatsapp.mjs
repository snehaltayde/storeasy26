// drill:plugins stage "whatsapp" (Phase 9 line 3), in a real browser on the
// roles store (the local stub provider: messages are notifications rows,
// provider whatsapp-stub; nothing leaves the machine).
//   1. The owner installs WhatsApp, opens its page and approves the four
//      templates on the WhatsApp card.
//   2. Shopper 1 ticks both WhatsApp boxes at checkout and places a COD
//      order → one order_confirmed row for that phone, after the job tick.
//   3. Shopper 2 (a first-time number) ticks only the marketing box and
//      leaves; shopper 3 ticks nothing and leaves. Their carts are backdated 3 hours, the store's time
//      zone is pinned to one where it is midday now (so quiet hours can't
//      hold the run), and one plugin_sweep job is queued. The sweep sends one
//      cart_reminder to shopper 2 and nothing to shopper 3 (and no reminder
//      for shopper 1's cart, which became an order).
//   4. The reminder's cart link, opened in a fresh browser, restores that cart
//      at checkout; its stop link opens the stop page and Stop messages
//      revokes that number's consents.
// The time zone is put back at the end.
import { createClient } from "@libsql/client";
import { harnessPorts } from "../../design-harness.js";
import { ROLES_PROFILE } from "../../seed-roles-store.js";
import { ORIGIN, api, open, openStore, rolesSql, shopper, signIn, stage } from "./lib.mjs";

const PHONES = { buyer: "9876543210", browser: "9876543211", silent: "9876543212" };
const e164 = (p) => `+91${p}`;
const KINDS = ["order_confirmed", "order_shipped", "order_delivered", "cart_reminder"];
const flow = (page) => page.locator('[data-protected="checkout"]');
const CONTACT = (phone) => ({ email: "snehal@mediastic.in", phone, name: "WhatsApp Drill", line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001" });

async function platformSql(statements) {
  const c = createClient({ url: `http://127.0.0.1:${harnessPorts(process.env, ROLES_PROFILE).sqld.platform}` });
  try {
    const out = [];
    for (const s of statements) out.push((await c.execute(s)).rows);
    return out;
  } finally {
    c.close();
  }
}
const tick = (page) => page.evaluate(async () => (await fetch("/api/jobs/tick", { method: "POST" })).status);
async function until(page, fn, label, tries = 20) {
  for (let i = 0; i < tries; i++) {
    await tick(page);
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(1500);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const rowsTo = async (phone) => (await rolesSql([{ sql: "SELECT type, body, consent_class, provider_id FROM notifications WHERE recipient = ? AND type LIKE 'whatsapp_%' ORDER BY created_at", args: [e164(phone)] }]))[0];

// a shopper with one item in the cart, at checkout with the address filled in
async function atCheckout(drill, item, phone, ticks) {
  const page = await shopper(drill);
  await page.goto(`${ORIGIN}/products/${item.handle}`, { waitUntil: "load" });
  const added = await page.evaluate((variantId) => fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 1 }) }).then((r) => r.status), item.variant_id);
  drill.check(added === 200, `shopper ${phone}: one item in the cart`, added);
  await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  const f = flow(page);
  for (const [name, value] of Object.entries(CONTACT(phone))) await f.locator(`input[name="${name}"]`).fill(value);
  const boxes = f.locator('[data-wa="consent"]');
  await boxes.waitFor();
  drill.check((await boxes.locator('input[type="checkbox"]:checked').count()) === 0, `shopper ${phone}: both WhatsApp boxes start unticked`);
  for (const purpose of ticks) {
    const saved = page.waitForResponse((x) => x.url().endsWith("/api/messaging/consent"));
    await boxes.locator(`[data-wa-consent="${purpose}"]`).check();
    drill.check((await saved).status() === 200, `shopper ${phone}: the ${purpose} tick is saved (200)`);
  }
  const cart = (await page.context().cookies(ORIGIN)).find((c) => c.name === "cart_session")?.value ?? null;
  return { page, f, cart };
}

stage("whatsapp", async (drill) => {
  await openStore(drill);
  await rolesSql(["UPDATE offers SET enabled = 0"]);
  const [[item]] = await rolesSql(["SELECT p.handle, v.id AS variant_id FROM products p JOIN variants v ON v.product_id = p.id WHERE v.available = 1 AND v.price > 0 ORDER BY p.handle, v.position LIMIT 1"]);
  if (!item) throw new Error("the roles store has no in-stock product to buy");

  // 1. install and approve
  const owner = await signIn(drill, "owner");
  await open(owner, "/admin/apps");
  const made = await api(owner, "apps", { install: { pluginId: "whatsapp", scopes: ["orders.read"] } });
  const installId = made.json?.install?.id ?? (await api(owner, "apps")).json?.installs?.find((i) => i.pluginId === "whatsapp")?.id;
  drill.check(/^pin_/.test(String(installId)), "owner: WhatsApp is installed", made.json?.error);
  drill.check((await open(owner, `/admin/apps/${installId}`)) === 200, "owner: the WhatsApp app page opens (200)");
  const card = owner.locator('[data-apps="whatsapp"]');
  await card.waitFor();
  drill.check((await card.locator('[data-wa-status="draft"]').count()) === 4, "the card: four templates, all drafts");
  drill.check((await card.locator('[data-wa-connection="stub"]').count()) === 1, "the card: test mode (the local stub)");
  for (const kind of KINDS) {
    const row = card.locator(`[data-wa-template="${kind}"]`);
    await row.locator(`[data-wa-approve="${kind}"]`).click();
    await card.locator(`[data-wa-template="${kind}"][data-wa-status="approved"]`).waitFor();
  }
  drill.check((await card.locator('[data-wa-status="approved"]').count()) === 4, "owner: all four templates approved");
  await drill.shoot(owner, "whatsapp-card");

  // pin the store's clock to midday: an Etc zone where the hour is now 12
  const [[tenant]] = await platformSql(["SELECT id, config FROM tenants WHERE domains LIKE '%roles.localhost%' LIMIT 1"]);
  const before = JSON.parse(tenant?.config || "{}").merchant_timezone ?? null;
  let off = 12 - new Date().getUTCHours();
  if (off > 12) off -= 24;
  if (off < -12) off += 24;
  const zone = off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
  await platformSql([{ sql: "UPDATE tenants SET config = json_set(config, '$.merchant_timezone', ?) WHERE id = ?", args: [zone, tenant.id] }]);

  try {
    // 2. shopper 1: both boxes, a COD order → order_confirmed
    const one = await atCheckout(drill, item, PHONES.buyer, ["updates", "marketing"]);
    await one.f.getByRole("button", { name: "Continue to review" }).click();
    await one.f.getByRole("button", { name: "Continue to payment" }).click();
    await one.f.getByRole("heading", { name: "Payment" }).waitFor();
    await one.f.getByRole("radio").first().check();
    const answered = one.page.waitForResponse((x) => x.url().endsWith("/api/checkout") && x.request().postDataJSON()?.action === "cod");
    await one.f.getByRole("button", { name: /^Place order · / }).click();
    drill.check((await answered).status() === 200, "shopper 1: the COD order is placed (200)");
    await one.page.waitForURL(/\/checkout\/confirmation\/[^/?]+/);
    const confirmed = await until(owner, async () => (await rowsTo(PHONES.buyer)).find((r) => r.type === "whatsapp_order_confirmed"), "the order_confirmed message");
    drill.check(confirmed.provider_id === "whatsapp-stub" && confirmed.consent_class === "transactional" && /\/m\/stop\?t=/.test(confirmed.body), "shopper 1: one order_confirmed row (stub, transactional, a stop link)", confirmed.body);
    await one.page.context().close();

    // 3. shopper 2 (marketing only, first time) and shopper 3 (no ticks) leave their carts
    const two = await atCheckout(drill, item, PHONES.browser, ["marketing"]);
    await drill.shoot(two.page, "whatsapp-consent");
    await two.page.context().close();
    const three = await atCheckout(drill, item, PHONES.silent, []);
    await three.page.context().close();
    drill.check(Boolean(two.cart && three.cart), "both shoppers have a cart", [two.cart, three.cart]);
    const ago = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await rolesSql([
      { sql: "UPDATE carts SET updated_at = ? WHERE id IN (?, ?)", args: [ago, two.cart, three.cart] },
      { sql: "UPDATE messaging_consents SET granted_at = ? WHERE cart_id = ?", args: [ago, two.cart] },
    ]);
    const now = new Date().toISOString();
    await platformSql([{ sql: "INSERT INTO jobs (id, type, tenant_id, payload, idempotency_key, status, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?, 'plugin_sweep', NULL, '{}', ?, 'pending', 0, 1, ?, ?, ?)", args: [`job_wadrill${Date.now().toString(16).slice(-8)}`, `plugin_sweep:drill-wa-${Date.now()}`, now, now, now] }]);
    const reminder = await until(owner, async () => (await rowsTo(PHONES.browser)).find((r) => r.type === "whatsapp_cart_reminder"), "the cart reminder");
    drill.check(reminder.consent_class === "marketing", "shopper 2 (first time): one cart reminder (marketing)", reminder.consent_class);
    drill.check((await rowsTo(PHONES.browser)).length === 1, "shopper 2: nothing else (no order updates without that tick)");
    drill.check((await rowsTo(PHONES.buyer)).every((r) => r.type === "whatsapp_order_confirmed"), "shopper 1: no reminder (the cart became an order)");
    drill.check((await rowsTo(PHONES.silent)).length === 0, "shopper 3 (no ticks): nothing at all");

    // 4. the cart link restores the cart; the stop link revokes
    const cartPath = /\/cart\/r\/\S+/.exec(reminder.body)?.[0];
    const stopPath = /\/m\/stop\?t=\S+/.exec(reminder.body)?.[0];
    drill.check(Boolean(cartPath && stopPath) && !/98765|cart_|@/.test(cartPath + stopPath), "the reminder has a cart link and a stop link, with no phone or cart id in them", reminder.body);
    const fresh = await shopper(drill);
    await fresh.goto(ORIGIN + cartPath, { waitUntil: "load" });
    drill.check(new URL(fresh.url()).pathname === "/checkout", "the cart link opens checkout", fresh.url());
    const restored = await fresh.evaluate(() => fetch("/api/cart").then((r) => r.json()));
    drill.check((restored?.items ?? []).length === 1, "…with the left cart's item in it", restored?.items?.length);
    await fresh.goto(ORIGIN + stopPath, { waitUntil: "load" });
    await fresh.locator('[data-wa-stop="confirm"]').click();
    await fresh.locator('[data-wa-stop="done"]').waitFor();
    await drill.shoot(fresh, "whatsapp-stopped");
    const [live] = await rolesSql([{ sql: "SELECT count(*) AS n FROM messaging_consents WHERE phone_e164 = ? AND revoked_at IS NULL", args: [e164(PHONES.browser)] }]);
    drill.check(Number(live[0].n) === 0, "Stop messages revokes shopper 2's consent", live[0]);
    await fresh.context().close();
  } finally {
    await platformSql([before == null ? { sql: "UPDATE tenants SET config = json_remove(config, '$.merchant_timezone') WHERE id = ?", args: [tenant.id] } : { sql: "UPDATE tenants SET config = json_set(config, '$.merchant_timezone', ?) WHERE id = ?", args: [before, tenant.id] }]);
    await owner.context().close();
  }
});
