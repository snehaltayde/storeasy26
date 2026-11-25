// ORDERS: `pnpm drill:orders`, the orders console on the new UI in a real
// browser (docs/plans/phase-2.md "Line 2" §5 item 11). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree: it seeds and
// starts the roles store (one cash-on-delivery order from the seeded shopper),
// then runs this. Never in the owner's checkout (runDrill refuses).
//
// Every role signs in through POST /api/admin/login in its own context.
//   staff and support: the order page offers no push, refresh or cancel
//     control; support's customer card says hidden and no shopper detail is
//     on the page; support's search by the shopper's email lists nothing;
//     staff sees the return decisions' tab
//   admin: Push to Shopify on the order (the roles store has no Shopify
//     connection, so the push is refused) answers in plain words, never a
//     5xx, and the page then shows the push failure
//   owner: searches by the shopper's email, opens the order from the list,
//     cancels it (reason typed), and the page then says Cancelled; an unknown
//     id is the not-found page; the list at 375 wide has no sideways scroll
// Assertions are never retried. Results and screenshots:
// docs/cms-reviews/drills/ORDERS/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "ORDERS";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const WRITES = /^(Push to Shopify|Refresh from Shopify|Cancel order)$/;
const CODES = /[a-z]+_[a-z]+|[A-Z]{3,}_[A-Z]+|HTTP \d{3}/;
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

async function signIn(drill, role, creds) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: creds, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  return ctx.newPage();
}

async function open(page, path) {
  const r = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  return { status: r?.status() ?? 0, body: await page.locator("main").innerText().catch(() => "") };
}

const writeButtons = (page) => page.locator("main button").evaluateAll((els, re) => els.map((e) => e.innerText.trim()).filter((t) => new RegExp(re).test(t)), WRITES.source);

async function readOnlyRole(drill, page, role, s) {
  const orderId = s.shopper.orderId;
  const d = await open(page, `/admin/orders/${orderId}`);
  drill.check(d.status === 200 && !ERROR_TEXT.test(d.body) && d.body.includes(orderId), `${role}: the order page opens`, { status: d.status, body: d.body.slice(0, 200) });
  drill.check((await writeButtons(page)).length === 0, `${role}: no push, refresh or cancel control on the order page`, await writeButtons(page));
  await drill.screenshot(page, `${role}-order`);
  if (role === "support") {
    drill.check(d.body.includes("Hidden for support") && !d.body.includes(s.shopper.email) && !d.body.includes(s.shopper.name), "support: the customer card says hidden; no shopper email or name on the page", d.body.slice(0, 400));
    const q = await open(page, `/admin/orders?q=${encodeURIComponent(s.shopper.email)}`);
    drill.check(q.status === 200 && /No orders match/.test(q.body) && !q.body.includes(orderId), "support: searching by the shopper's email lists nothing", q.body.slice(0, 300));
    const byId = await open(page, `/admin/orders?q=${encodeURIComponent(orderId)}`);
    drill.check(byId.body.includes(orderId) && byId.body.includes("Hidden for support"), "support: searching by the order id finds it, customer masked", byId.body.slice(0, 300));
  }
  const ret = await open(page, "/admin/orders?view=returns");
  drill.check(ret.status === 200 && !ERROR_TEXT.test(ret.body) && /return requests|Returns/.test(ret.body), `${role}: the Returns tab opens`, ret.body.slice(0, 200));
}

async function adminPush(drill, page, s) {
  const orderId = s.shopper.orderId;
  await open(page, `/admin/orders/${orderId}`);
  const push = page.getByRole("button", { name: "Push to Shopify", exact: true });
  if (!drill.check((await push.count()) === 1, "admin: Push to Shopify is offered on a cash-on-delivery order", await writeButtons(page))) return;
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/admin/orders/${orderId}`) && r.request().method() === "POST");
  await push.click();
  const res = await answered;
  const toast = await page
    .getByText(/didn't go through|can't be sent|already running|failed to reach Shopify|Sent to Shopify|already in Shopify|Your role can't/)
    .first()
    .innerText({ timeout: 10_000 })
    .catch(() => "");
  drill.check(res.status() < 500, "admin: the push answers without a 5xx", res.status());
  drill.check(Boolean(toast) && !CODES.test(toast), "admin: the push answer is in plain words, no codes", toast);
  await page.waitForTimeout(1000);
  await settle(page);
  const body = await page.locator("main").innerText().catch(() => "");
  drill.check(/didn't reach Shopify|Shopify push failed|In Shopify/.test(body), "admin: after the push the page shows where the order is", body.slice(0, 300));
  await drill.screenshot(page, "admin-push");
}

async function ownerFlows(drill, page, s) {
  const orderId = s.shopper.orderId;
  const list = await open(page, "/admin/orders");
  drill.check(list.status === 200 && !ERROR_TEXT.test(list.body) && list.body.includes(orderId), "owner: the orders list shows the seeded order", list.body.slice(0, 300));
  const search = page.getByRole("searchbox");
  await search.fill(s.shopper.email);
  await search.press("Enter");
  await page.waitForURL(/[?&]q=/, { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const found = await page.locator("main").innerText();
  drill.check(new URL(page.url()).searchParams.get("q") === s.shopper.email && found.includes(orderId), "owner: search by the shopper's email keeps ?q= in the address and finds the order", { url: page.url() });
  await drill.screenshot(page, "owner-search");
  await page.getByRole("link", { name: orderId, exact: true }).first().click();
  await page.waitForURL(new RegExp(`/admin/orders/${orderId}$`), { timeout: 30_000 }).catch(() => {});
  await settle(page);
  const detail = await page.locator("main").innerText();
  drill.check(detail.includes(s.shopper.email), "owner: the order opens from the list with the customer's details", { url: page.url() });

  const cancel = page.getByRole("button", { name: "Cancel order", exact: true });
  if (drill.check((await cancel.count()) === 1, "owner: Cancel order is offered", await writeButtons(page))) {
    await cancel.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 10_000 });
    await dialog.getByLabel("Reason").fill("Drill: the customer asked to cancel");
    await drill.screenshot(page, "owner-cancel-dialog");
    await dialog.getByRole("button", { name: "Cancel order", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await settle(page);
    const after = await page.locator("main").innerText();
    drill.check(/Cancelled/.test(after) && (await writeButtons(page)).length === 0, "owner: after cancelling the order reads Cancelled and offers no more writes", { writes: await writeButtons(page), body: after.slice(0, 300) });
    await drill.screenshot(page, "owner-cancelled");
  }

  const missing = await open(page, "/admin/orders/ORD-0000000000000000");
  drill.check(/We couldn't find that order/.test(missing.body), "owner: an unknown order id is the not-found page", missing.body.slice(0, 200));

  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "/admin/orders");
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  drill.check(sideways <= 0, "owner: the orders list at 375 wide has no sideways page scroll", sideways);
  await drill.screenshot(page, "owner-list-375");
}

async function orders(drill) {
  if (!port) throw new Error("drill:orders needs ROLES_PORT (run it as pnpm drill:orders).");
  const s = seed();
  const pages = {};
  for (const role of ["owner", "admin", "staff", "support"]) pages[role] = await signIn(drill, role, s.members.find((m) => m.role === role));
  await readOnlyRole(drill, pages.support, "support", s);
  await readOnlyRole(drill, pages.staff, "staff", s);
  await adminPush(drill, pages.admin, s);
  await ownerFlows(drill, pages.owner, s);
}

runDrill({ id: DRILL_ID, part: "main", title: "ORDERS — list, search, open, push and cancel, every role" }, orders).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
