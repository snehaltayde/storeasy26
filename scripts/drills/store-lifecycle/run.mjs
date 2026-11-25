// STORE-LIFECYCLE: `pnpm drill:store-lifecycle`, an operator suspends and
// resumes a store and turns maintenance on and off from the store page
// (Phase 3 line 2, docs/plans/phase-3.md "Line 2"). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree after it seeds the
// --p3 design store; this starts the harness. Never in the owner's checkout.
// Steps:
//   1. an operator (a session put straight into the control plane) opens the
//      store's page: the Store controls card says Active, maintenance Off
//   2. Suspend: the dialog lists what happens (30 seconds), the button stays
//      off until the reason has 5 characters; confirm -> the card says
//      Suspended at once, Recent activity shows tenant.status
//   3. the storefront closes cleanly within 45 s (the edge runtime's host
//      cache is 30 s): not a 200, no error page, no product content
//   4. Resume (same dialog) -> Active; the storefront answers 200 again
//   5. Maintenance: the switch shows the message box and its preview; save ->
//      the card says On with the message; the storefront shows the maintenance
//      page with it; Maintenance off -> the storefront is back
//   6. Rotate secrets opens with nothing ticked and lists the merchant keys by
//      name (cancelled: the drill rotates nothing)
//   7. 375 and 1280 screenshots of the card and each dialog; no sideways
//      scroll at 375
//   8. the audit rows hold the drill operator's id
// Results: docs/cms-reviews/drills/STORE-LIFECYCLE/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";

const DRILL_ID = "STORE-LIFECYCLE";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const CONSOLE = `http://localhost:${ports.next}`;
const at = (path) => new URL(path, CONSOLE).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const CARD = '[data-card="lifecycle"]';
const MESSAGE = "Stocktake until 6pm, back soon";

async function platformSql(statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: platformUrl });
  try {
    const out = [];
    for (const s of statements) out.push(await c.execute(s));
    return out;
  } finally {
    c.close();
  }
}
const all = async (sql, args = []) => (await platformSql([{ sql, args }]))[0].rows;

async function until(fn, ms = 30_000, step = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

async function session(userId, kind) {
  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await platformSql([{ sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), userId, kind, now, new Date(Date.now() + 3600_000).toISOString()] }]);
  return token;
}

async function newPage(drill, { width = 1280, cookie = null } = {}) {
  const ctx = await drill.browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  if (cookie) await ctx.addCookies([{ name: "_platform", value: cookie, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  const seen = new Set();
  const say = (t) => !seen.has(t) && seen.add(t) && drill.note(`browser: ${t.slice(0, 400)}`);
  page.on("pageerror", (e) => say(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && say(`console error: ${m.text()}`));
  return { ctx, page };
}

// the storefront home as a shopper sees it (no cookies)
async function storefront(url) {
  const res = await fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache" } }).catch((e) => ({ status: 0, text: async () => String(e) }));
  return { status: res.status, body: await res.text() };
}

const cardSays = (page, attr, value) => until(async () => (await page.locator(`${CARD} [${attr}="${value}"]`).count()) === 1, 20_000);

async function storeLifecycle(drill) {
  await startOwned();
  const now = new Date().toISOString();
  const opId = `u_${randomBytes(8).toString("hex")}`;
  await platformSql([{ sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Lifecycle Drill Operator', NULL, 1, 1, 'active', ?, ?)", args: [opId, `operator-${opId}@store-lifecycle.test`, now, now] }]);
  const opToken = await session(opId, "operator");
  const tenants = await all("SELECT id, name, domains, status FROM tenants WHERE status = 'active' ORDER BY created_at ASC");
  drill.check(tenants.length > 0, "the design store has an active store", tenants.length);
  const store = tenants[0];
  const host = JSON.parse(String(store.domains || "[]")).find((d) => /localhost/.test(d)) || "localhost";
  const shopUrl = `http://${host.includes(":") ? host : `${host}:${ports.next}`}/`;
  const open = await storefront(shopUrl);
  drill.check(open.status === 200, "the storefront is open before the drill", { url: shopUrl, status: open.status });

  // 1. the card
  const { ctx, page } = await newPage(drill, { cookie: opToken });
  await page.goto(at(`/platform/stores/${store.id}`), { waitUntil: "load" });
  await page.locator(CARD).waitFor();
  await settle(page);
  drill.check(!ERROR_TEXT.test(await text(page)), "the store page loads with the Store controls card", null);
  drill.check(Boolean(await cardSays(page, "data-lifecycle-status", "active")) && Boolean(await cardSays(page, "data-lifecycle-maintenance", "off")), "the card says Active and maintenance Off", null);
  await drill.screenshot(page, "01-card-1280");

  // 2. suspend
  await page.locator(`${CARD} [data-action="suspend"]`).click();
  const dialog = page.locator('[data-dialog="store-status"]');
  await dialog.waitFor();
  const dialogText = await dialog.innerText();
  drill.check(/30 seconds/.test(dialogText) && /unavailable/.test(dialogText), "the suspend dialog says what happens, with the 30-second note", dialogText.slice(0, 300));
  const confirm = dialog.locator('[data-action="confirm-suspend"]');
  await dialog.locator("#status-reason").fill("abcd");
  drill.check(await confirm.isDisabled(), "Suspend store stays off with a 4-character reason", null);
  await dialog.locator("#status-reason").fill("Drill: suspend and resume");
  await drill.screenshot(page, "02-suspend-dialog");
  await confirm.click();
  drill.check(Boolean(await cardSays(page, "data-lifecycle-status", "suspended")), "after Suspend the card says Suspended at once", null);
  drill.check(Boolean(await until(async () => /tenant\.status/.test(await page.locator('[data-card="audit"]').innerText()), 10_000)), "Recent activity shows the tenant.status row", null);
  await drill.screenshot(page, "03-suspended");

  // 3. the storefront closes cleanly
  const closed = await until(async () => {
    const r = await storefront(shopUrl);
    return r.status !== 200 && r.status !== 0 ? r : null;
  }, 45_000);
  drill.check(Boolean(closed) && !ERROR_TEXT.test(closed.body), "the storefront closes within 45 s, cleanly (no error page)", closed?.status ?? null);
  const shop = await newPage(drill);
  await shop.page.goto(shopUrl, { waitUntil: "load" }).catch(() => {});
  await drill.screenshot(shop.page, "04-storefront-suspended");

  // 4. resume
  await page.locator(`${CARD} [data-action="resume"]`).click();
  await dialog.waitFor();
  await dialog.locator("#status-reason").fill("Drill: resume");
  await dialog.locator('[data-action="confirm-resume"]').click();
  drill.check(Boolean(await cardSays(page, "data-lifecycle-status", "active")), "after Resume the card says Active", null);
  const reopened = await until(async () => ((await storefront(shopUrl)).status === 200 ? true : null), 45_000);
  drill.check(Boolean(reopened), "the storefront answers 200 again within 45 s", null);

  // 5. maintenance
  await page.locator(`${CARD} [data-action="maintenance"]`).click();
  const mdialog = page.locator('[data-dialog="store-maintenance"]');
  await mdialog.waitFor();
  await mdialog.locator("#maintenance-on").click();
  await mdialog.locator("#maintenance-message").fill(MESSAGE);
  drill.check((await mdialog.locator("[data-maintenance-preview]").innerText()).includes(MESSAGE), "the preview shows the shoppers' message", null);
  await drill.screenshot(page, "05-maintenance-dialog");
  await mdialog.locator('[data-action="save-maintenance"]').click();
  drill.check(Boolean(await cardSays(page, "data-lifecycle-maintenance", "on")) && (await page.locator(CARD).innerText()).includes(MESSAGE), "the card says maintenance On with the message", null);
  const curtain = await until(async () => {
    const r = await storefront(shopUrl);
    return r.body.includes(MESSAGE) ? r : null;
  }, 45_000);
  drill.check(Boolean(curtain), "shoppers see the maintenance page with the message", curtain?.status ?? null);
  await shop.page.goto(shopUrl, { waitUntil: "load" }).catch(() => {});
  await drill.screenshot(shop.page, "06-storefront-maintenance");
  await page.locator(`${CARD} [data-action="maintenance"]`).click();
  await mdialog.waitFor();
  await mdialog.locator("#maintenance-on").click();
  await mdialog.locator('[data-action="save-maintenance"]').click();
  drill.check(Boolean(await cardSays(page, "data-lifecycle-maintenance", "off")), "maintenance off: the card says Off", null);
  const back = await until(async () => {
    const r = await storefront(shopUrl);
    return r.status === 200 && !r.body.includes(MESSAGE) ? true : null;
  }, 45_000);
  drill.check(Boolean(back), "the storefront is back without the maintenance page", null);
  await shop.ctx.close();

  // 6. rotate secrets: nothing ticked, merchant keys by name; cancelled
  await page.locator(`${CARD} [data-action="rotate"]`).click();
  const rdialog = page.locator('[data-dialog="rotate-secrets"]');
  await rdialog.waitFor();
  drill.check((await rdialog.locator('[role="checkbox"][data-state="checked"]').count()) === 0 && (await rdialog.locator('[data-action="confirm-rotate"]').isDisabled()), "Rotate secrets opens with nothing ticked", null);
  const keys = await rdialog.locator("[data-merchant-keys]").innerText();
  drill.check(/Razorpay/.test(keys) && /Meta/.test(keys) && /Google Analytics/.test(keys), "the merchant's keys are listed by name", keys);
  await drill.screenshot(page, "07-rotate-dialog");
  await page.keyboard.press("Escape");

  // 7. 375
  await page.setViewportSize({ width: 375, height: 900 });
  await settle(page);
  drill.check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "the store page has no sideways scroll at 375", null);
  await page.locator(CARD).scrollIntoViewIfNeeded();
  await drill.screenshot(page, "08-card-375");
  await page.locator(`${CARD} [data-action="suspend"]`).click();
  await dialog.waitFor();
  await drill.screenshot(page, "09-suspend-dialog-375");
  await page.keyboard.press("Escape");
  await ctx.close();

  // 8. audit rows
  const rows = await all("SELECT action, actor FROM audit_log WHERE tenant_id = ? AND action IN ('tenant.status', 'tenant.maintenance') AND at >= ?", [store.id, now]);
  drill.check(rows.length >= 4 && rows.every((r) => r.actor === opId), "each action left an audit row with the drill operator's id", rows.length);
  const st = await all("SELECT status FROM tenants WHERE id = ?", [store.id]);
  drill.check(st[0]?.status === "active", "the store ends active", st[0]?.status);
}

runDrill({ id: DRILL_ID, part: "main", title: "STORE-LIFECYCLE — suspend, resume and maintenance from the store page" }, storeLifecycle).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
