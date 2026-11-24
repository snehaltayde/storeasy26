// OPS-CREATE-STORE: `pnpm drill:operator-create-store`, an operator creates a
// store for a founder in one form and the founder accepts the invite into the
// same onboarding (Phase 1 line 9, docs/plans/phase-1.md "Line 9" §5 item 21).
// Run by scripts/drills/run-isolated.mjs in a throwaway worktree after it seeds
// the --p3 design store; this starts the harness (new stores get
// <slug>.localhost, the operator console is on localhost, store databases come
// from the local Turso stand-in). Never in the owner's checkout.
// Steps:
//   1. an operator (a session row in the harness's control plane, as the
//      suites make one; the TOTP sign-in is covered by test-identity) opens
//      /platform → New store, fills the form with the Shopify app's id and
//      secret; the address check says Available; Create store
//   2. the progress lands on the done screen: invite sent, address, app set
//      up, redirect URL; a reload of ?signup= shows the same screen
//   3. the founder opens the mock invite on <slug>.localhost, sees the store
//      and their email, sets a password, lands on /admin/onboarding: step 1
//      shows their shop and Connect is enabled
//   4. a second store without app credentials: done says it isn't set up;
//      Resend invite works (only the newest link then works); its founder's
//      step 1 says Storeasy's team is preparing the connection
//   5. the first shop typed again is refused by the live check
//   6. signed out, /platform/stores/new goes to /platform; the API answers 401
// Results: docs/cms-reviews/drills/OPS-CREATE-STORE/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";
import { latestPlatformMail } from "../../support/signup-mail.js";

const DRILL_ID = "OPS-CREATE-STORE";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const CONSOLE = `http://localhost:${ports.next}`;
const ONE = { storeName: "Drill Created Store", slug: "drill-created-store", email: "created-founder@ops-create.test", founder: "Meera Iyer", shop: "https://admin.shopify.com/store/drill-created-shop", shopDomain: "drill-created-shop.myshopify.com", password: "created-founder-pass-1" };
const TWO = { storeName: "Drill Prep Store", slug: "drill-prep-store", email: "prep-founder@ops-create.test", shop: "drill-prep-shop", shopDomain: "drill-prep-shop.myshopify.com", password: "prep-founder-pass-1" };
const storeOrigin = (slug) => `http://${slug}.localhost:${ports.next}`;

const at = (origin, path) => new URL(path, origin).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const tokenOf = (mail) => mail?.body?.match(/accept-invite\?token=([0-9a-f]{64})/)?.[1] || null;

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
const one = async (sql, args = []) => (await platformSql([{ sql, args }]))[0].rows[0] ?? null;

async function until(fn, ms = 60_000, step = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

async function newPage(drill, width = 1280) {
  const ctx = await drill.browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  const page = await ctx.newPage();
  const seen = new Set();
  const say = (t) => !seen.has(t) && seen.add(t) && drill.note(`browser: ${t.slice(0, 400)}`);
  page.on("pageerror", (e) => say(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && say(`console error: ${m.text()}`));
  return { ctx, page };
}

async function makeOperator() {
  const id = `u_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await platformSql([
    { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Drill Operator', NULL, 1, 1, 'active', ?, ?)", args: [id, `operator-${id}@ops-create.test`, now.toISOString(), now.toISOString()] },
    { sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, 'operator', ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), id, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString()] },
  ]);
  return { id, token };
}

// Fill the New store form and press Create store -> the signup id from the URL
async function createStore(drill, page, s, { app = null, label }) {
  await page.goto(at(CONSOLE, "/platform/stores/new"), { waitUntil: "load" });
  await page.locator("#cs-storeName").waitFor();
  await page.locator("#cs-storeName").fill(s.storeName);
  await page.locator("#cs-email").fill(s.email);
  if (s.founder) await page.locator("#cs-founderName").fill(s.founder);
  await page.locator("#cs-shop").fill(s.shop);
  if (app) {
    await page.locator("#cs-clientId").fill(app.clientId);
    await page.locator("#cs-clientSecret").fill(app.clientSecret);
  }
  const avail = await page.locator("#cs-slug-msg", { hasText: `Available: ${s.slug}.localhost` }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  drill.check(avail, `${label}: the address check says it's available as <slug>.localhost`, await page.locator("#cs-slug-msg").innerText().catch(() => ""));
  const shopOk = await page.locator("#cs-shop-msg", { hasText: `Available: ${s.shopDomain}` }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  drill.check(shopOk, `${label}: the Shopify store check normalises the input and says it's free`, await page.locator("#cs-shop-msg").innerText().catch(() => ""));
  await page.getByRole("button", { name: "Create store" }).click();
  const id = await until(async () => new URL(page.url()).searchParams.get("signup"), 30_000, 200);
  drill.check(/^sgn_[0-9a-f]{16}$/.test(id || ""), `${label}: the URL carries the setup (?signup=)`, page.url());
  const done = await page.locator('ol[data-status="done"]').waitFor({ timeout: 120_000 }).then(() => true, () => false);
  drill.check(done, `${label}: the progress reaches the done screen`, (await text(page)).slice(0, 300));
  return id;
}

async function acceptAs(drill, s, token, { label }) {
  const { ctx, page } = await newPage(drill);
  await page.goto(at(storeOrigin(s.slug), `/admin/accept-invite?token=${token}`), { waitUntil: "load" });
  await page.getByRole("button", { name: "Accept invitation" }).waitFor({ timeout: 60_000 });
  const body = await text(page);
  drill.check(body.includes(`Join ${s.storeName}`) && body.includes(s.email), `${label}: the accept page shows the store and the invited email`, body.slice(0, 200));
  await page.locator("#inv-name").fill(s.founder || "Prep Founder");
  await page.locator("#inv-pw").fill(s.password);
  await page.locator("#inv-pw2").fill(s.password);
  await drill.screenshot(page, `${label}-accept`);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  const landed = await until(async () => new URL(page.url()).pathname === "/admin/onboarding", 60_000, 250);
  drill.check(Boolean(landed), `${label}: accepting lands on /admin/onboarding`, page.url());
  await settle(page);
  return { ctx, page };
}

async function opsCreateStore(drill) {
  await startOwned();
  const operator = await makeOperator();
  const { ctx, page } = await newPage(drill);
  await ctx.addCookies([{ name: "_platform", value: operator.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);

  // 1. /platform → New store
  await page.goto(at(CONSOLE, "/platform"), { waitUntil: "load" });
  await settle(page);
  const link = page.getByRole("link", { name: "New store" }).first();
  drill.check((await link.count()) > 0 && !/New tenant/.test(await text(page)), "/platform links to New store; the old New tenant form is gone", null);
  await link.click();
  await page.waitForURL((u) => u.pathname === "/platform/stores/new");
  drill.check(!ERROR_TEXT.test(await text(page)), "the New store page renders without an error", null);
  await drill.screenshot(page, "01-new-store-form");

  // 2. the first store, with the app's credentials
  const first = await createStore(drill, page, ONE, { app: { clientId: "drill-client-id", clientSecret: "drill-client-secret-value" }, label: "store 1" });
  const doneText = await text(page);
  drill.check(doneText.includes(`Invite sent to ${ONE.email}`), "done: the invite went to the owner", null);
  drill.check(doneText.includes(`${ONE.slug}.localhost`) && doneText.includes(`${storeOrigin(ONE.slug)}/api/admin/shopify/callback`), "done: the address and the redirect URL for the store's Shopify app", null);
  drill.check(/Set up for drill-created-shop\.myshopify\.com/.test(doneText), "done: the Shopify app is set up", null);
  drill.check(!/token=|[0-9a-f]{64}/.test(doneText) && !doneText.includes("drill-client-secret-value"), "the operator sees no token, link or secret", null);
  await drill.screenshot(page, "02-done");
  await page.reload({ waitUntil: "load" });
  const again = await page.locator('ol[data-status="done"]').waitFor({ timeout: 30_000 }).then(() => true, () => false);
  drill.check(again, "a reload of ?signup= shows the same done screen", null);
  const row = await one("SELECT source, shopify_secret_enc, invite_status FROM signups WHERE id = ?", [first]);
  drill.check(row?.source === "operator" && row.shopify_secret_enc === null && row.invite_status === "mock", "the row: source operator, secret cleared, invite recorded", row);

  // 3. the founder accepts and lands on step 1 with their shop and Connect
  const invite1 = await latestPlatformMail({ platformUrl, kind: "operator_store_invite", recipient: ONE.email });
  drill.check(Boolean(tokenOf(invite1)), "the founder's invite is in the (mock) mail", null);
  {
    const f = await acceptAs(drill, ONE, tokenOf(invite1), { label: "03-founder-1" });
    const step = await text(f.page);
    const shopShown = step.includes(ONE.shopDomain) || (await f.page.locator(`input[value="${ONE.shopDomain}"]`).count()) > 0;
    drill.check(shopShown, "step 1 shows the founder's shop", step.slice(0, 300));
    const connect = f.page.locator('[data-onboarding="connect-button"]');
    drill.check((await connect.count()) === 1 && (await connect.isEnabled()), "Connect is enabled (the app was set up)", null);
    await drill.screenshot(f.page, "04-founder-1-step-1");
    await f.ctx.close();
  }

  // 4. a second store without app credentials; Resend invite
  const second = await createStore(drill, page, TWO, { label: "store 2" });
  drill.check(/Not set up yet/.test(await text(page)), "done: the app isn't set up yet", null);
  const auto = tokenOf(await latestPlatformMail({ platformUrl, kind: "operator_store_invite", recipient: TWO.email }));
  await page.getByRole("button", { name: "Resend invite" }).click();
  const resent = await page.locator('[role="status"]', { hasText: `Invite sent to ${TWO.email}` }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  drill.check(resent, "Resend invite sends a new one", null);
  await drill.screenshot(page, "05-resent");
  const newest = tokenOf(await until(async () => {
    const m = await latestPlatformMail({ platformUrl, kind: "operator_store_invite", recipient: TWO.email });
    return tokenOf(m) && tokenOf(m) !== auto ? m : null;
  }, 30_000));
  const oldPeek = await fetch(at(storeOrigin(TWO.slug), `/api/admin/accept-invite?token=${auto}`)).then((r) => r.status);
  drill.check(oldPeek === 400 && Boolean(newest), "the earlier invite no longer works; the newest does", { oldPeek });
  {
    const f = await acceptAs(drill, TWO, newest, { label: "06-founder-2" });
    const step = await text(f.page);
    // the shop shows in the step's address field (an input's value is not in innerText)
    const shopShown = step.includes(TWO.shopDomain) || (await f.page.locator(`input[value="${TWO.shopDomain}"]`).count()) > 0;
    drill.check(/preparing your Shopify connection/.test(step) && shopShown, "step 1 says Storeasy's team is preparing the connection, with their shop", step.slice(0, 600));
    await drill.screenshot(f.page, "07-founder-2-preparing");
    await f.ctx.close();
  }
  drill.check(Boolean(second), "store 2 made", second);

  // 5. the first shop again is refused
  await page.goto(at(CONSOLE, "/platform/stores/new"), { waitUntil: "load" });
  await page.locator("#cs-shop").fill("DRILL-CREATED-SHOP");
  const dup = await page.locator("#cs-shop-msg", { hasText: `${ONE.storeName} already uses this Shopify store.` }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  drill.check(dup, "a Shopify store another store uses is refused, in words naming it", await page.locator("#cs-shop-msg").innerText().catch(() => ""));
  await drill.screenshot(page, "08-duplicate-shop");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(at(CONSOLE, "/platform/stores/new"), { waitUntil: "load" });
  await page.locator("#cs-storeName").waitFor();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  drill.check(!sideways, "phone width: no sideways scroll", null);
  await drill.screenshot(page, "09-phone");
  await ctx.close();

  // 6. signed out
  {
    const anon = await newPage(drill);
    await anon.page.goto(at(CONSOLE, "/platform/stores/new"), { waitUntil: "load" });
    const moved = await until(async () => new URL(anon.page.url()).pathname === "/platform", 30_000, 250);
    drill.check(Boolean(moved) && !(await text(anon.page)).includes("Owner's email"), "signed out: /platform/stores/new goes to /platform", anon.page.url());
    const api = await fetch(at(CONSOLE, "/api/platform/stores?check=1&slug=x")).then((r) => r.status);
    drill.check(api === 401, "signed out: the API answers 401", api);
    await anon.ctx.close();
  }
}

runDrill({ id: DRILL_ID, part: "main", title: "OPS-CREATE-STORE — an operator creates a store; the founder accepts into onboarding" }, opsCreateStore).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
