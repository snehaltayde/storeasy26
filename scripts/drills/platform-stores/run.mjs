// PLATFORM-STORES: `pnpm drill:platform-stores`, the operator's Stores list and
// store page (Phase 3 line 1, docs/plans/phase-3.md "Line 1"). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree after it seeds the
// --p3 design store; this starts the harness. Never in the owner's checkout.
// Steps:
//   1. an operator (a session put straight into the control plane; the sign-in
//      itself is drill:platform-shell's) opens /platform: the Stores list in
//      the shell, the fleet strip, and every visible row's health resolves
//      (never left on "Checking…")
//   2. search by name and by id narrows the list and lands in the URL; a
//      partial owner email and nonsense show the empty state with Clear filters
//   3. the Status filter and "Needs attention" land in the URL; sorting by
//      name lands in the URL
//   4. a row opens /platform/stores/<id>: health with Try again, secrets by
//      name, Open storefront; the page and the APIs hold no database url
//   5. an unknown id is the not-found page
//   6. 375, 768 and 1280 screenshots of the list and the store page; no
//      sideways page scroll at 375 (the table scrolls inside its frame)
//   7. anonymous, then a merchant's token in _platform: /platform is the
//      sign-in with no store in it, a store's page goes to /platform, and the
//      list, health and detail APIs answer 401
// Results: docs/cms-reviews/drills/PLATFORM-STORES/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";

const DRILL_ID = "PLATFORM-STORES";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const CONSOLE = `http://localhost:${ports.next}`;
const at = (path) => new URL(path, CONSOLE).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SHELL = '[data-shell="platform"]';
const LIST = '[data-screen="platform-stores"]';
const STORE = '[data-screen="platform-store"]';

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

async function until(fn, ms = 30_000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, step));
  }
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

// a session row for a user, as the sign-in would make one
async function session(userId, kind) {
  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await platformSql([{ sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), userId, kind, now, new Date(Date.now() + 3600_000).toISOString()] }]);
  return token;
}

const searchParam = (page, k) => new URL(page.url()).searchParams.get(k);
const rowCount = (page) => page.locator(`${LIST} [data-kit="data-table"] tbody tr`).count();
const healthResolved = (page) => until(async () => (await page.locator('[data-health="pending"]').count()) === 0 && (await page.locator("[data-health]").count()) > 0, 30_000);

async function sidewaysAt375(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

async function platformStores(drill) {
  await startOwned();
  const now = new Date().toISOString();
  const opId = `u_${randomBytes(8).toString("hex")}`;
  const merchantId = `u_${randomBytes(8).toString("hex")}`;
  await platformSql([
    { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Stores Drill Operator', NULL, 1, 1, 'active', ?, ?)", args: [opId, `operator-${opId}@platform-stores.test`, now, now] },
    { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Merchant', NULL, 0, 0, 'active', ?, ?)", args: [merchantId, `merchant-${merchantId}@platform-stores.test`, now, now] },
  ]);
  const opToken = await session(opId, "operator");
  const merchantToken = await session(merchantId, "merchant");
  const tenants = await all("SELECT id, name, db_url FROM tenants ORDER BY created_at ASC");
  drill.check(tenants.length > 0, "the design store has at least one store", tenants.length);
  const first = tenants[0];
  const dbUrls = tenants.map((t) => String(t.db_url)).filter((u) => u.length > 8);

  // 1. the list
  const { ctx, page } = await newPage(drill, { cookie: opToken });
  const res = await page.goto(at("/platform"), { waitUntil: "load" });
  await page.locator(LIST).waitFor();
  await settle(page);
  drill.check(res?.status() === 200 && (await page.locator(`${SHELL} ${LIST}`).count()) === 1 && !ERROR_TEXT.test(await text(page)), "operator: /platform is the Stores list inside the shell", res?.status());
  drill.check((await page.locator("[data-fleet-strip] [data-fleet-stat]").count()) === 4, "the fleet strip shows four numbers", null);
  const rows = await until(async () => (await rowCount(page)) || null);
  drill.check(rows >= 1, "the list shows the stores", rows);
  drill.check(Boolean(await healthResolved(page)), "every visible row's health resolves (none left on Checking…)", null);
  const healthWords = await page.locator("[data-health]").allInnerTexts();
  drill.check(healthWords.every((w) => /^(Healthy|Needs attention: .+|Can't reach the store's database|No such store)$/.test(w.trim())), "each health cell says Healthy, Needs attention: <reason> or Can't reach the store's database", healthWords.slice(0, 5));
  await drill.screenshot(page, "01-list-1280");

  // the list and health APIs hold no database url
  const apis = await page.evaluate(async (id) => Promise.all([`/api/platform/tenants`, `/api/platform/tenants?health=${id}`, `/api/platform/tenants/${id}`, `/api/platform/tenants?legacy=1`].map((u) => fetch(u).then((r) => r.text()))), first.id);
  drill.check(apis.every((body) => !/"db_url"|"dbUrl"|"db_token|"password_hash"/.test(body) && !dbUrls.some((u) => body.includes(u))), "the list, health, detail and legacy answers hold no database url, token or password hash", null);

  // 2. search
  await page.locator("#stores-q").fill(String(first.name));
  await page.locator("#stores-q").press("Enter");
  await until(async () => searchParam(page, "q") === String(first.name));
  await settle(page);
  drill.check(searchParam(page, "q") === String(first.name) && (await page.locator(`${LIST} tbody a[href="/platform/stores/${encodeURIComponent(first.id)}"]`).count()) === 1, "searching by name lands in the URL and finds the store", page.url());
  await page.locator("#stores-q").fill(String(first.id));
  await page.locator("#stores-q").press("Enter");
  await until(async () => searchParam(page, "q") === String(first.id));
  await settle(page);
  drill.check((await page.locator(`${LIST} tbody a[href="/platform/stores/${encodeURIComponent(first.id)}"]`).count()) === 1, "searching by id finds the store", null);
  await page.locator("#stores-q").fill("@platform-stores.tes");
  await page.locator("#stores-q").press("Enter");
  await until(async () => (await page.locator('[data-kit="empty-state"]').count()) === 1);
  drill.check(/Owner emails match exactly/.test(await text(page)), "a partial owner email matches nothing and says emails match exactly", null);
  await page.locator("#stores-q").fill("no-such-store-anywhere-zz");
  await page.locator("#stores-q").press("Enter");
  await until(async () => /No store matches/.test(await text(page)));
  await drill.screenshot(page, "02-search-empty");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await until(async () => !new URL(page.url()).search);
  drill.check(!new URL(page.url()).search, "Clear filters empties the URL", page.url());

  // 3. filters and sort in the URL
  await page.locator("#stores-status").selectOption("suspended");
  await until(async () => searchParam(page, "status") === "suspended");
  drill.check(searchParam(page, "status") === "suspended", "the Status filter lands in the URL", page.url());
  await page.locator("#stores-status").selectOption("");
  await page.locator("#stores-attention").check();
  await until(async () => searchParam(page, "attention") === "1");
  drill.check(searchParam(page, "attention") === "1" && !searchParam(page, "status"), "Needs attention lands in the URL", page.url());
  await page.locator("#stores-attention").uncheck();
  await until(async () => !searchParam(page, "attention"));
  await page.locator(`${LIST} thead button`, { hasText: "Store" }).click();
  await until(async () => searchParam(page, "sort") === "name");
  drill.check(searchParam(page, "sort") === "name", "sorting by name lands in the URL", page.url());
  await settle(page);

  // 4. open a store
  await page.locator(`${LIST} tbody a[href="/platform/stores/${encodeURIComponent(first.id)}"]`).click();
  await page.waitForURL((u) => u.pathname === `/platform/stores/${first.id}`);
  await page.locator(STORE).waitFor();
  await settle(page);
  const storeBody = await text(page);
  drill.check(!ERROR_TEXT.test(storeBody) && storeBody.includes(String(first.name)), "a row opens the store's page", null);
  drill.check(Boolean(await until(async () => (await page.locator('[data-card="health"] [data-health]').count()) === 1)), "the health card resolves", null);
  await page.locator('[data-card="health"]').getByRole("button", { name: "Try again" }).click();
  drill.check(Boolean(await until(async () => (await page.locator('[data-card="health"] [data-health]').count()) === 1)), "Try again re-runs the health check", null);
  const html = await page.content();
  drill.check(!dbUrls.some((u) => html.includes(u)) && !/db_url|dbUrl/.test(html), "the store page holds no database url", null);
  drill.check((await page.locator('[data-card="secrets"]').count()) === 1, "the secrets card is there (names only)", null);
  drill.check((await page.getByRole("link", { name: "Open storefront" }).count()) <= 1, "Open storefront is a single link", null);
  for (const w of [1280, 768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await settle(page);
    if (w === 375) drill.check(!(await sidewaysAt375(page)), "the store page has no sideways scroll at 375", null);
    await drill.screenshot(page, `03-store-${w}`);
  }

  // 5. unknown id
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(at("/platform/stores/no-such-store-zz"), { waitUntil: "load" });
  await settle(page);
  drill.check(/No store with that id/.test(await text(page)), "an unknown id is the not-found page", null);
  await drill.screenshot(page, "04-not-found");

  // 6. the list at three widths
  for (const w of [768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(at("/platform"), { waitUntil: "load" });
    await page.locator(LIST).waitFor();
    await healthResolved(page);
    await settle(page);
    if (w === 375) {
      drill.check(!(await sidewaysAt375(page)), "the list has no sideways page scroll at 375", null);
      const link = page.locator(`${LIST} tbody a`).first();
      drill.check(await link.isVisible().catch(() => false), "at 375 the store links are still there to tap", null);
    }
    await drill.screenshot(page, `05-list-${w}`);
  }
  await ctx.close();

  // 7. anonymous, then a merchant's token in _platform
  for (const [who, cookie] of [["anonymous", null], ["merchant token in _platform", merchantToken]]) {
    const { ctx: c2, page: p2 } = await newPage(drill, { cookie });
    await p2.goto(at("/platform"), { waitUntil: "load" });
    await p2.locator("#pl-password").waitFor();
    const body = await text(p2);
    drill.check((await p2.locator(LIST).count()) === 0 && (await p2.locator(SHELL).count()) === 0 && !tenants.some((t) => body.includes(String(t.name)) || body.includes(String(t.id))), `${who}: /platform is the sign-in with no store in it`, body.slice(0, 160));
    await p2.goto(at(`/platform/stores/${first.id}`), { waitUntil: "load" });
    const moved = await until(async () => new URL(p2.url()).pathname === "/platform");
    drill.check(Boolean(moved) && (await p2.locator(STORE).count()) === 0, `${who}: a store's page goes to /platform`, p2.url());
    const statuses = await p2.evaluate(async (id) => Promise.all([`/api/platform/tenants`, `/api/platform/tenants?health=${id}`, `/api/platform/tenants/${id}`].map((u) => fetch(u).then((r) => r.status))), first.id);
    drill.check(statuses.every((s) => s === 401), `${who}: the list, health and detail APIs answer 401`, statuses);
    await drill.screenshot(p2, `06-${cookie ? "merchant" : "anonymous"}`);
    await c2.close();
  }
}

runDrill({ id: DRILL_ID, part: "main", title: "PLATFORM-STORES — the operator's Stores list, health and store page" }, platformStores).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
