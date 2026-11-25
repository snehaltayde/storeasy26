// drill:apps stage "webhooks" (Phase 4 line 3): the owner creates a custom
// app pointed at a receiver this drill runs on 127.0.0.1 (the harness runs
// with STOREASY_PLUGIN_EGRESS_LOCAL=1, scripts/drills/run-isolated.mjs
// drillEnv), copies the signing secret shown once, sends a test event and
// places a cash-on-delivery order; the job tick sends both; the receiver
// checks each Standard Webhooks signature; the Deliveries table shows them
// Delivered. Support sees the card and the table with no live write control
// and no payload. Selectors: ids, data-* hooks and exact names; rows are waited for.
import http from "node:http";
import { createHmac } from "node:crypto";
import { ORIGIN, api, open, signIn, stage, state } from "./lib.mjs";

const received = [];
function receiver() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const signed = (secret, r) => {
  const mac = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`).digest("base64");
  return String(r.headers["webhook-signature"] || "").split(" ").includes(`v1,${mac}`);
};
const tick = (page) => page.evaluate(async () => (await fetch("/api/jobs/tick", { method: "POST" })).status);
async function until(page, fn, label, tries = 20) {
  for (let i = 0; i < tries; i++) {
    await tick(page);
    if (await fn()) return true;
    await page.waitForTimeout(1500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A real cash-on-delivery order through the shopper routes. The roles store
// is closed (nothing published), so it is the founder's preview test order
// (PUB-06): the owner mints a preview session, opens the store with it, adds
// an in-stock variant from the synced catalog to the cart and checks out COD.
async function placeCodOrder(page) {
  const list = await api(page, "catalog?view=products&stock=in_stock");
  const productId = (list.json?.items ?? []).find((i) => i.inShopify && i.available !== false)?.productId;
  if (!productId) return { error: "no in-stock product in the catalog", status: list.status };
  const sheet = await api(page, `catalog?view=product&id=${encodeURIComponent(productId)}`);
  const variantId = (sheet.json?.variants ?? []).find((v) => v.available)?.id;
  if (!variantId) return { error: "no available variant", status: sheet.status };
  const mint = await page.context().request.post(`${ORIGIN}/api/admin/preview-session`, { data: { create: true }, headers: { origin: ORIGIN } });
  const previewUrl = (await mint.json().catch(() => ({}))).previewUrl;
  if (mint.status() !== 200 || !previewUrl) return { error: `preview session ${mint.status()}` };
  const shop = await page.context().newPage();
  await shop.goto(ORIGIN + previewUrl, { waitUntil: "load" });
  const r = await shop.evaluate(
    async ([v]) => {
      const add = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId: v, quantity: 1 }) });
      if (!add.ok) return { error: `cart ${add.status}`, body: await add.text() };
      // as the checkout page does: the first answer names the total (shipping
      // included), the shopper reviews it and places the order at that total
      const key = `drill-hooks-${Date.now()}`;
      const place = (expected) =>
        fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cod",
            idempotencyKey: key,
            contact: { email: "drillbuyer@example.test", phone: "9876500000", name: "Drill Buyer" },
            address: { line1: "1 Drill Road", city: "Bengaluru", state: "KA", pincode: "560001", country: "IN" },
            ...expected,
          }),
        }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
      let r = await place({});
      if (r.status === 409 && r.json?.code === "PRICE_CHANGED") r = await place({ expectedTotal: r.json.total, expectedShipping: r.json.shippingTotal });
      return r;
    },
    [variantId],
  );
  await shop.close();
  return r;
}

stage("webhooks", async (drill) => {
  const server = await receiver();
  const hook = `http://127.0.0.1:${server.address().port}/hooks`;
  try {
    const page = await signIn(drill, "owner");
    drill.check((await open(page, "/admin/apps")) === 200, "owner: /admin/apps opens (200)");
    await page.locator('[data-apps="create-custom"]').click();
    const dialog = page.locator('[data-apps="custom-dialog"]');
    await dialog.waitFor();
    await dialog.locator("#custom-app-name").fill("Drill hooks");
    await dialog.locator("#custom-app-url").fill(hook);
    drill.check((await dialog.locator('[data-scope="orders.read"]').isDisabled()) && (await dialog.locator('[data-topic="order.created"]').getAttribute("data-state")) === "checked", "dialog: orders permission fixed, order events checked");
    await drill.shoot(page, "owner-custom-dialog");
    await dialog.getByRole("button", { name: "Approve and create" }).click();
    await dialog.locator('[data-apps="secret-once"]').waitFor({ timeout: 15_000 });
    const secret = await dialog.locator("#webhook-secret").innerText();
    drill.check(/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret.trim()), "the signing secret is shown once, whsec_ + 32 bytes");
    await drill.shoot(page, "owner-secret-once");
    await dialog.locator('[data-apps="open-custom"]').click();
    await page.waitForURL(/\/admin\/apps\/pin_[0-9a-f]{16}$/, { timeout: 30_000 });
    state.customId = new URL(page.url()).pathname.split("/").pop();
    const card = page.locator('[data-apps="webhooks"]');
    await card.locator("[data-webhook-url]").waitFor();
    drill.check((await card.locator('[data-webhook-status="active"]').count()) === 1 && (await card.locator("[data-webhook-url]").innerText()) === hook, "the Webhooks card: Active, the address");

    await card.locator('[data-webhooks-action="test"]').click();
    await until(page, () => received.some((r) => JSON.parse(r.body).type === "ping"), "the test event");
    const ping = received.find((r) => JSON.parse(r.body).type === "ping");
    drill.check(signed(secret.trim(), ping), "receiver: the test event's signature verifies with the secret", ping.headers["webhook-signature"]);

    const order = await placeCodOrder(page);
    drill.check(order.status === 200, "a cash-on-delivery order is placed", order);
    await until(page, () => received.some((r) => JSON.parse(r.body).type === "order.created"), "order.created");
    const created = received.find((r) => JSON.parse(r.body).type === "order.created");
    const body = JSON.parse(created.body);
    drill.check(signed(secret.trim(), created), "receiver: order.created's signature verifies");
    drill.check(!/drillbuyer|9876500000|Drill Buyer|Drill Road/.test(created.body) && !("customer" in body.data.order), "receiver: no customer details in the body", Object.keys(body.data.order));

    await open(page, `/admin/apps/${state.customId}`);
    const rows = page.locator('[data-apps="deliveries"] tbody tr');
    await rows.first().waitFor();
    const delivered = await page.locator('[data-apps="deliveries"] [data-delivery-status="delivered"]').count();
    drill.check(delivered >= 2, "the Deliveries table shows the test event and the order Delivered", { delivered });
    await drill.shoot(page, "owner-deliveries");
    await page.context().close();

    const support = await signIn(drill, "support");
    await open(support, `/admin/apps/${state.customId}`);
    await support.locator('[data-apps="deliveries"] tbody tr').first().waitFor();
    const live = await support.evaluate(() => [...document.querySelectorAll("[data-webhooks-action], [data-delivery-action=resend], [data-apps=create-custom]")].filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true").map((el) => el.outerHTML.slice(0, 100)));
    drill.check(live.length === 0, "support: no live webhook write control", live);
    drill.check((await support.locator('[data-delivery-action="view"]').count()) === 0, "support: no payload view");
    const refused = await api(support, `apps/${state.customId}/webhooks`, { pause: true });
    drill.check(refused.status === 403, "support: the API refuses pause (403)", refused.status);
    await drill.shoot(support, "support-webhooks");
    await support.context().close();
  } finally {
    server.close();
  }
  drill.check(ORIGIN.startsWith("http://roles.localhost:"), "ran against the roles store");
});
