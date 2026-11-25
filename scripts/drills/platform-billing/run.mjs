// PLATFORM-BILLING: `pnpm drill:platform-billing`, the operator's Billing
// screen in a real browser (Phase 3 line 3, docs/plans/phase-3.md "Line 3").
// Run by scripts/drills/run-isolated.mjs in a throwaway worktree after it seeds
// the --p3 design store; this starts the harness (the operator console is on
// localhost). Razorpay is not configured in the harness, so no provider call
// can be made: the paid paths are proven by scripts/test-platform-billing.js
// against a stand-in, and here the screen says why they are off.
// Steps:
//   1. an operator (a session row made in the harness's control plane, as the
//      suites do) opens Billing from the nav: Overview with MRR, "Razorpay is
//      not set up", the exception queue (an orphan event seeded here) linking
//      to the ledger
//   2. Plans: a new version with a feature row (rupees in, the paise shown back
//      in rupees), then Retire it through its AlertDialog
//   3. Subscriptions: Start a plan (free) for the store; ?store= opens its rows;
//      Extend grace is refused on an active plan and offered on a cancelled one;
//      Cancel (local) through its AlertDialog ends it with the grace date
//   4. Billing events: the orphan filter shows the seeded event, marked
//   5. Overrides: set one with a reason and an expiry, then clear it
//   6. Costs: enter the month's bills, set a store budget; the unallocated share shows
//   7. every write left a billing.* / costs.* audit row naming the operator
//   8. signed out, /platform/billing goes to /platform; the API answers 401
//   9. 375, 768 and 1280 widths: no sideways scroll
// Results: docs/cms-reviews/drills/PLATFORM-BILLING/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";

const DRILL_ID = "PLATFORM-BILLING";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const CONSOLE = `http://localhost:${ports.next}`;
const PLAN = "drill-scale";

const at = (path) => new URL(path, CONSOLE).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");

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
const all = async (sql, args = []) => (await platformSql([{ sql, args }]))[0].rows;

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

// An operator: a user with is_operator and a live operator session row (only
// its hash is stored), as the suites make one. The TOTP sign-in is drill:platform-shell's.
async function makeOperator() {
  const id = `u_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await platformSql([
    { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Billing Drill Operator', NULL, 1, 1, 'active', ?, ?)", args: [id, `operator-${id}@billing-drill.test`, now.toISOString(), now.toISOString()] },
    { sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, 'operator', ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), id, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString()] },
  ]);
  return { id, token };
}

async function noErrors(drill, page, where) {
  const body = await text(page);
  drill.check(!ERROR_TEXT.test(body), `${where}: no error page`, body.slice(0, 160));
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const statusLine = (page) => page.locator('[role="status"]').first();

async function billing(drill) {
  await startOwned();
  const store = await one("SELECT id, name FROM tenants ORDER BY created_at LIMIT 1");
  if (!store) throw new Error("the --p3 design store has no tenant row");
  const now = new Date().toISOString();
  await platformSql([
    { sql: "DELETE FROM subscriptions WHERE tenant_id = ?", args: [store.id] },
    {
      sql: "INSERT OR IGNORE INTO billing_events (id, provider_event_id, subscription_id, tenant_id, type, amount, payment_id, occurred_at, applied_at, note) VALUES ('bev_drill_orphan', 'evt_drill_orphan', NULL, NULL, 'subscription.charged', 99900, 'pay_drill', ?, ?, 'no matching subscription')",
      args: [now, now],
    },
  ]);
  const operator = await makeOperator();
  const started = new Date().toISOString();
  const { ctx, page } = await newPage(drill);
  await ctx.addCookies([{ name: "_platform", value: operator.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);

  // 1. overview, from the nav
  await page.goto(at("/platform/onboarding"), { waitUntil: "load" });
  await page.getByRole("link", { name: "Billing" }).first().click();
  await until(async () => new URL(page.url()).pathname === "/platform/billing", 30_000, 200);
  await page.getByRole("heading", { name: "Billing", level: 1 }).waitFor();
  await page.getByText("Monthly recurring revenue").waitFor();
  const overview = await until(async () => {
    const b = await text(page);
    return /Razorpay is not set up/.test(b) && /Event with no store/.test(b) ? b : null;
  }, 30_000);
  drill.check(Boolean(overview), "overview: MRR, the provider not set up, the orphan event in the exception queue", (await text(page)).slice(0, 300));
  await noErrors(drill, page, "overview");
  await drill.screenshot(page, "01-overview-1280");
  const ledgerLink = page.getByRole("link", { name: "Open in the ledger" }).first();
  drill.check((await ledgerLink.getAttribute("href")) === "/platform/billing?tab=events&store=orphan", "the orphan row links to the ledger's no-store filter", await ledgerLink.getAttribute("href"));

  // 2. plans: a new version, then retire it
  await tab(page, "Plans").click();
  await until(async () => new URL(page.url()).searchParams.get("tab") === "plans", 15_000, 200);
  await page.getByRole("button", { name: "New version" }).first().click();
  const pv = page.getByRole("dialog");
  await pv.waitFor();
  await pv.getByRole("button", { name: "A new plan" }).click();
  await pv.getByLabel("Plan", { exact: true }).fill(PLAN);
  await pv.getByLabel("Name", { exact: true }).fill("Drill Scale");
  await pv.getByLabel(/Price in rupees/).fill("4,999.50");
  drill.check(/₹4,999\.50 a month/.test(await pv.innerText()), "the price typed in rupees is read back in rupees", null);
  await pv.getByLabel("Feature 1 name").fill("orders_per_month");
  await pv.getByLabel("Feature 1 value").fill("20000");
  await drill.screenshot(page, "02-new-version-dialog");
  await pv.getByRole("button", { name: "Put on sale" }).click();
  await pv.waitFor({ state: "detached" });
  const plan = await until(() => one("SELECT price, status, features FROM plans WHERE id = ? AND version = 1", [PLAN]));
  drill.check(Number(plan?.price) === 499950 && plan?.status === "active" && /20000/.test(plan?.features || ""), "the version is saved in paise, on sale, with its feature", plan);
  const row = page.getByRole("row").filter({ hasText: "Drill Scale" });
  await row.getByRole("button", { name: "Retire" }).click();
  const retire = page.getByRole("alertdialog");
  await retire.waitFor();
  drill.check(/keep it/.test(await retire.innerText()), "the retire dialog says subscribers keep it", null);
  await retire.getByRole("button", { name: "Retire version" }).click();
  await retire.waitFor({ state: "detached" });
  drill.check(Boolean(await until(async () => (await one("SELECT status FROM plans WHERE id = ? AND version = 1", [PLAN]))?.status === "retired")), "the version is retired", null);

  // 3. subscriptions: start free for the store via ?store=, then cancel it
  await page.goto(at(`/platform/billing?tab=subscriptions&store=${encodeURIComponent(store.id)}`), { waitUntil: "load" });
  const start = page.getByRole("dialog");
  await start.waitFor();
  drill.check((await start.getByLabel("Store").inputValue()) === store.id, "?store= for a store with no plan opens Start a plan for it", null);
  await start.getByLabel("Plan").selectOption("free");
  await start.getByRole("button", { name: "Start plan" }).click();
  await start.waitFor({ state: "detached" });
  const started1 = await until(async () => /is active/.test(await statusLine(page).innerText()), 30_000);
  drill.check(Boolean(started1), "the free plan is active", null);
  const subRow = page.getByRole("row").filter({ hasText: "free v" });
  await subRow.first().waitFor();
  drill.check((await subRow.getByRole("button", { name: "Extend grace" }).count()) === 0, "an active plan offers no grace extension", null);
  await drill.screenshot(page, "03-subscriptions");
  await subRow.getByRole("button", { name: "Cancel" }).click();
  const cancel = page.getByRole("alertdialog");
  await cancel.waitFor();
  drill.check(/can't be undone/.test(await cancel.innerText()), "the cancel dialog says it can't be undone", null);
  await cancel.getByLabel(/Reason/).fill("drill cancel");
  await drill.screenshot(page, "04-cancel-dialog");
  await cancel.getByRole("button", { name: "Cancel subscription" }).click();
  await cancel.waitFor({ state: "detached" });
  const cancelled = await until(() => one("SELECT status, grace_until FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1", [store.id]).then((r) => (r?.status === "cancelled" ? r : null)));
  drill.check(Boolean(cancelled?.grace_until), "the local subscription ended with a grace date", cancelled);
  await page.getByRole("row").filter({ hasText: "Cancelled" }).getByRole("button", { name: "Extend grace" }).click();
  const grace = page.getByRole("dialog");
  await grace.getByLabel("Days to add").fill("5");
  await grace.getByLabel("Reason").fill("drill grace");
  await grace.getByRole("button", { name: "Extend grace" }).click();
  await grace.waitFor({ state: "detached" });
  const extended = await until(() => one("SELECT grace_until FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1", [store.id]).then((r) => (r?.grace_until > cancelled.grace_until ? r : null)));
  drill.check(Boolean(extended), "grace is extended", extended);

  // 4. events: the orphan filter
  await page.goto(at("/platform/billing?tab=events&store=orphan"), { waitUntil: "load" });
  await page.getByRole("table", { name: "Billing events" }).waitFor();
  const events = await text(page);
  drill.check(/No store/.test(events) && /\+\s*₹999/.test(events), "the orphan event is marked, with its signed amount", events.slice(0, 300));
  await drill.screenshot(page, "05-events-orphans");

  // 5. overrides
  await tab(page, "Overrides").click();
  await page.getByRole("button", { name: "Set an override" }).click();
  const ov = page.getByRole("dialog");
  await ov.getByLabel("Store").selectOption(store.id);
  await ov.getByLabel("Feature 1 value").fill("777");
  await ov.getByLabel("Reason").fill("drill override");
  await ov.getByRole("button", { name: "Save override" }).click();
  await ov.waitFor({ state: "detached" });
  drill.check(Boolean(await until(() => one("SELECT reason, expires_at FROM entitlement_overrides WHERE tenant_id = ?", [store.id]).then((r) => (r?.expires_at ? r : null)))), "the override is saved with an expiry", null);
  await page.getByRole("row").filter({ hasText: "777" }).getByRole("button", { name: "Clear" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear override" }).click();
  drill.check(Boolean(await until(async () => !(await one("SELECT 1 x FROM entitlement_overrides WHERE tenant_id = ?", [store.id])))), "the override is cleared", null);

  // 6. costs
  await tab(page, "Costs").click();
  await page.getByRole("button", { name: /Enter the month's bills|Edit the month's bills/ }).first().click();
  const bills = page.getByRole("dialog");
  await bills.getByLabel("Compute (₹)").fill("1200");
  await bills.getByLabel("Other (₹)").fill("300");
  await bills.getByRole("button", { name: "Save bills" }).click();
  await bills.waitFor({ state: "detached" });
  await page.getByText("Unallocated", { exact: true }).waitFor();
  await page.getByRole("row").filter({ hasText: store.name }).getByRole("button", { name: /budget/ }).click();
  const budget = page.getByRole("dialog");
  await budget.getByLabel(/Budget/).fill("500");
  await budget.getByRole("button", { name: "Save budget" }).click();
  await budget.waitFor({ state: "detached" });
  const cfg = await until(() => one("SELECT config FROM tenants WHERE id = ?", [store.id]).then((r) => (/"cost_budget":500/.test(r?.config || "") ? r : null)));
  drill.check(Boolean(cfg), "the store's budget is saved", null);
  await drill.screenshot(page, "06-costs");

  // 7. the audit trail names the operator
  const rows = await all("SELECT action, actor, actor_kind FROM audit_log WHERE at >= ? AND (action LIKE 'billing.%' OR action LIKE 'costs.%')", [started]);
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ["billing.plan_version", "billing.plan_retired", "billing.start", "billing.cancel", "billing.grace", "billing.override", "billing.override_cleared", "costs.inputs", "costs.budget"]) drill.check(actions.has(a), `audited: ${a}`, null);
  drill.check(rows.every((r) => r.actor === operator.id && r.actor_kind === "operator"), "every row names the operator", rows.filter((r) => r.actor !== operator.id).slice(0, 3));

  // 8. signed out
  {
    const anon = await newPage(drill);
    await anon.page.goto(at("/platform/billing?tab=subscriptions"), { waitUntil: "load" });
    const moved = await until(async () => new URL(anon.page.url()).pathname === "/platform", 30_000, 250);
    const body = await text(anon.page);
    drill.check(Boolean(moved) && !body.includes(store.id), "signed out: /platform/billing goes to /platform and shows no store", { url: anon.page.url() });
    const api = await fetch(at("/api/platform/billing?view=subscriptions")).then((r) => r.status);
    drill.check(api === 401, "signed out: the API answers 401", api);
    await anon.ctx.close();
  }

  // 9. widths
  for (const [w, name] of [[375, "07-phone-375"], [768, "08-tablet-768"], [1280, "09-laptop-1280"]]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(at("/platform/billing?tab=subscriptions"), { waitUntil: "load" });
    await page.getByRole("table", { name: "Subscriptions" }).waitFor();
    drill.check(await noSideScroll(page), `${w}px: no sideways scroll`, null);
    await drill.screenshot(page, name);
  }
  await ctx.close();
}

runDrill({ id: DRILL_ID, part: "main", title: "PLATFORM-BILLING — plans, subscriptions, events, overrides and costs" }, billing).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
