// drill:plugins stage "shiprocket" (Phase 9 line 4). The owner installs
// Shiprocket with the local stub (never the real API) and Shiprocket's
// courier estimate, makes a webhook key and turns the Tracking block on. A
// shopper's "Check delivery" shows the couriers' dates, and an unserviceable
// PIN says couriers don't reach it. The seeded shopper's order gets an AWB
// (fixtures in scripts/fixtures/shiprocket/); a webhook with the key makes
// Storeasy ask the stub, and the shopper's order page shows "In transit"; the
// stub then says delivered and the next webhook ends the timeline on
// Delivered. A wrong key gets 401; another order's page shows no tracking.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, harnessPorts } from "../../design-harness.js";
import { ROLES_PROFILE, latestShopperCode } from "../../seed-roles-store.js";
import { stubDir } from "../../../lib/couriers/stub.js";
import { ORIGIN, api, open, openStore, rolesSql, shopper, signIn, stage, state } from "./lib.mjs";

const HANDLE = "fixture-product-4";
const fixture = (name, awb) => JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/shiprocket", `${name}.json`), "utf8").replaceAll("__AWB__", awb));
const rolesSeed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

stage("shiprocket", async (drill) => {
  await openStore(drill);
  const awb = `DRL${Date.now()}`;

  // --- the owner: install with the stub, choose Shiprocket's estimate, make a key, Tracking on
  const owner = await signIn(drill, "owner");
  await open(owner, "/admin/apps");
  const listed = await api(owner, "apps");
  let installId = listed.json?.installs?.find((i) => i.pluginId === "shiprocket" && i.status !== "uninstalled")?.id;
  if (!installId) {
    const made = await api(owner, "apps", { install: { pluginId: "shiprocket", scopes: ["orders.read"] } });
    drill.check(made.status === 200, "owner: Shiprocket installs", made.json?.error);
    installId = made.json?.install?.id;
  }
  state.shiprocketInstall = installId;
  const saved = await api(owner, `apps/${installId}`, { settings: { api_email: "api-user@example.test", api_password: "drill-stub-pass", pickup_pin: "411001", default_weight_g: 500, estimate_source: "shiprocket" } });
  drill.check(saved.status === 200, "owner: the API user, pickup PIN, weight and Shiprocket's estimate are saved", saved.json?.errors || saved.json?.error);
  const key = await api(owner, `apps/${installId}/parcel-key`, { rotate: true });
  drill.check(key.status === 200 && /^[0-9a-f]{64}$/.test(String(key.json?.key)), "owner: a webhook key is made (shown once)", key.status);
  const live = await api(owner, `apps/${installId}/blocks`, { block: "tracking", state: "live" });
  drill.check(live.status === 200, "owner: the Tracking block is turned on", live.json?.error);
  await open(owner, `/admin/apps/${installId}`);
  const card = owner.locator('[data-apps="shiprocket-webhook"]');
  await card.waitFor();
  drill.check((await card.innerText()).includes("/api/parcel-updates"), "owner: the app page shows the webhook address to paste");
  drill.check((await owner.content()).includes(key.json.key) === false, "owner: the key isn't on the page after a reload");
  await drill.shoot(owner, "shiprocket-app");

  // --- a shopper: Check delivery
  const page = await shopper(drill);
  await open(page, `/products/${HANDLE}`);
  const check = page.locator("[data-delivery-check]");
  await check.waitFor();
  await page.fill("#delivery-check-pin", "560001");
  await check.locator('button[type="submit"]').click();
  const line = check.locator('[data-delivery-estimate="delivery"]');
  await line.waitFor();
  const pin = await page.request.get(`${ORIGIN}/api/pincode?pin=560001`);
  const body = await pin.json().catch(() => null);
  drill.check(JSON.stringify(body?.estimate) === '{"minDays":3,"maxDays":6}', "the PIN answer carries the couriers' days (3–6)", body?.estimate);
  drill.check(/^Delivery by /.test(await line.innerText()), "PDP: Check delivery shows the courier dates", await line.innerText());
  await page.fill("#delivery-check-pin", "799999");
  await check.locator('button[type="submit"]').click();
  const none = check.locator('[data-delivery-estimate="unserviceable"]');
  await none.waitFor();
  drill.check((await none.innerText()) === "Couriers don't reach this PIN code yet", "PDP: an unserviceable PIN says couriers don't reach it");
  await drill.shoot(page, "shiprocket-pdp");

  // --- the seeded shopper's order gets an AWB; another order has none
  const seed = rolesSeed();
  const orderId = seed.shopper.orderId;
  const now = new Date().toISOString();
  const otherId = `BL-DRLSR${Date.now() % 1_000_000}`;
  await rolesSql([
    { sql: "INSERT OR REPLACE INTO order_fulfillments (id, order_id, status, tracking_company, tracking_number, tracking_url, updated_at) VALUES (?, ?, 'SUCCESS', 'Delhivery', ?, NULL, ?)", args: [`ful_${awb}`, orderId, awb, now] },
    { sql: "INSERT INTO orders (id, email, name, subtotal, discount_total, shipping_total, total, currency, payment_method, payment_status, status, created_at, updated_at) VALUES (?, 'other-drill@example.test', 'Other Drill', 100, 0, 0, 100, 'INR', 'cod', 'cod', 'synced', ?, ?)", args: [otherId, now, now] },
  ]);

  // --- the shopper signs in (email code from the store's own notifications row)
  await page.evaluate((email) => fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "request_otp", email }) }), seed.shopper.email);
  const code = await latestShopperCode({ tenantUrl: `http://127.0.0.1:${harnessPorts(process.env, ROLES_PROFILE).sqld.tenant}`, email: seed.shopper.email });
  drill.check(Boolean(code?.code), "shopper: a sign-in code was sent");
  const verified = await page.evaluate(([email, c]) => fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", email, code: c }) }).then((r) => r.status), [seed.shopper.email, code?.code]);
  drill.check(verified === 200, "shopper: signed in", verified);

  // --- webhooks: a wrong key, then the real one (the stub says in transit)
  const hook = (k) => page.request.post(`${ORIGIN}/api/parcel-updates`, { headers: { "content-type": "application/json", ...(k ? { "x-api-key": k } : {}) }, data: fixture("webhook-delivered", awb) });
  drill.check((await hook("0".repeat(64))).status() === 401, "a webhook with a wrong key gets 401");
  drill.check((await hook(null)).status() === 401, "a webhook with no key gets 401");
  drill.check((await hook(key.json.key)).status() === 200, "the webhook with the key gets 200");

  const statusOf = async () => {
    await open(page, `/account/orders/${encodeURIComponent(orderId)}`);
    const el = page.locator("[data-tracking-status]");
    return (await el.count()) ? (await el.innerText()).trim() : null;
  };
  let status = null;
  for (let i = 0; i < 10 && status !== "In transit"; i++) {
    status = await statusOf();
    if (status !== "In transit") await page.waitForTimeout(1000);
  }
  drill.check(status === "In transit", "the order page shows In transit (Shiprocket's answer, not the webhook's 'delivered')", status);
  await drill.shoot(page, "shiprocket-in-transit");

  // the stub now says delivered; a second webhook (a new update) refetches it
  const dir = stubDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${awb}.json`), JSON.stringify({ fixture: "track-delivered" }));
  try {
    const second = fixture("webhook-delivered", awb);
    second.current_timestamp = "2026-11-30 14:06:00";
    drill.check((await page.request.post(`${ORIGIN}/api/parcel-updates`, { headers: { "content-type": "application/json", "x-api-key": key.json.key }, data: second })).status() === 200, "the delivered webhook gets 200");
    for (let i = 0; i < 10 && status !== "Delivered"; i++) {
      status = await statusOf();
      if (status !== "Delivered") await page.waitForTimeout(1000);
    }
    drill.check(status === "Delivered", "the order page shows Delivered", status);
    const steps = page.locator("[data-tracking-step]");
    drill.check((await steps.count()) === 5, "the timeline has the five scans", await steps.count());
    drill.check(/^Delivered/.test((await steps.first().innerText()).trim()), "the timeline ends (newest first) on Delivered");
    const text = await page.locator("[data-tracking]").innerText();
    drill.check(!/Ramesh|9876/.test(text), "no recipient name or phone number in the timeline");
    drill.check((await page.locator("[data-tracking-link]").getAttribute("href")) === `https://shiprocket.co/tracking/${awb}`, "the courier link goes to Shiprocket's tracking page");
    await drill.shoot(page, "shiprocket-delivered");
  } finally {
    rmSync(join(dir, `${awb}.json`), { force: true });
  }

  // another order's page: not this shopper's, so no page and no tracking
  const other = await page.goto(`${ORIGIN}/account/orders/${encodeURIComponent(otherId)}`, { waitUntil: "load" });
  drill.check((await page.locator("[data-tracking]").count()) === 0, "another order's page shows no tracking", other?.status());
  const guest = await page.goto(`${ORIGIN}/orders/${encodeURIComponent(orderId)}?t=bad`, { waitUntil: "load" });
  drill.check(guest?.status() === 404 && (await page.locator("[data-tracking]").count()) === 0, "the guest order page with a bad link: 404, no tracking", guest?.status());

  // the admin order view's shipment card
  await open(owner, `/admin/orders/${encodeURIComponent(orderId)}`);
  const ship = owner.locator('[data-shipment-card="delivered"]');
  await ship.waitFor();
  drill.check((await ship.innerText()).includes(awb), "owner: the order view's shipment card shows the AWB, delivered");
  const support = await signIn(drill, "support");
  await open(support, `/admin/orders/${encodeURIComponent(orderId)}`);
  drill.check((await support.locator('[data-shipment-card="delivered"]').count()) === 1, "support: sees the shipment card too (orders.read, no customer details in it)");
  await support.context().close();

  // back to the store's own dates, so later stages see the Phase 8 estimate
  await api(owner, `apps/${installId}`, { settings: { api_email: "api-user@example.test", pickup_pin: "411001", default_weight_g: 500, estimate_source: "store" } });
  await owner.context().close();
  await page.context().close();
});
