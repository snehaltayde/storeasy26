// DASHBOARD: `pnpm drill:dashboard`, the merchant dashboard on the new UI in a
// real browser (Phase 2 line 1, docs/plans/phase-2.md "Line 1" §5 item 6).
// Run by scripts/drills/run-isolated.mjs in a throwaway worktree: it seeds and
// starts the roles store (withRolesStore), then runs this. Never in the
// owner's checkout (runDrill refuses).
//
// Owner (the real sign-in form): the seed's COD order shows in Today so far;
// the range switch moves between 7, 30 and 90 days (?days=) with the current
// one marked; the chart has its hidden table; the store card says Closed with
// the onboarding count. Support (POST /api/admin/login): the page renders,
// with no customer name, email or phone and no Shopify domain; no "Run again"
// it could press; no link to a settings page; every control in main is a
// marked read. Screenshots at 375, 768 and 1280 into
// docs/cms-reviews/drills/DASHBOARD/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";
import { ROLES_LOGINS } from "../../seed-roles-store.js";

const DRILL_ID = "DASHBOARD";
const WIDTHS = [375, 768, 1280];
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error|couldn't load/;
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

async function signInForm(drill, ctx, creds) {
  const page = await ctx.newPage();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await page.goto(`${ORIGIN}/admin/login`, { waitUntil: "load" });
    const shown = await page.locator("#login-email").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    if (shown && res?.status() !== 404) break;
    if (attempt === 2) throw new Error(`the sign-in form did not show twice in a row (status ${res?.status()})`);
    drill.note(`known flake: the sign-in form did not show (status ${res?.status()}); reloading once`);
  }
  await page.locator("#login-email").fill(creds.email);
  await page.locator("#login-password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/admin\/onboarding$/, { timeout: 60_000 });
  return page;
}

async function signInApi(ctx, creds) {
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: creds, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${creds.email} answered ${res.status()}`);
  return ctx.newPage();
}

async function open(page, path) {
  const res = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  return { status: res?.status() ?? 0, body: await page.locator("main").innerText().catch(() => "") };
}

// In the page: controls in main that are not the shell's own (its top bar and
// nav, which drill:shell checks), a marked read, natively disabled or RoleGate's.
function unmarked() {
  const q = 'a[href], button, input, select, textarea, [role="link"], [tabindex]:not([tabindex="-1"])';
  return [...document.querySelectorAll(`main ${q}`)]
    .filter((el) => !el.closest("[data-shell-control], [data-nav-item]"))
    .filter((el) => !el.hasAttribute("data-read-control") && el.disabled !== true && !(el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled"))
    .map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || "").trim().slice(0, 40)}"`);
}

async function owner(drill, page) {
  const today = await open(page, "/admin/dashboard");
  drill.check(today.status === 200 && !ERROR_TEXT.test(today.body), "owner: /admin/dashboard renders", { status: today.status, body: today.body.slice(0, 200) });
  const stat = await page.locator('[data-dashboard="stat"]').first().innerText().catch(() => "");
  drill.check(/Today so far/.test(stat) && /\b1 order\b/.test(stat), "owner: the seed's COD order shows in Today so far", stat);
  drill.check((await page.locator('[data-dashboard="chart"] table.sr-only tbody tr').count()) === 30, "owner: the chart's hidden table has a row for each of the 30 days", null);
  const status = await page.locator('[data-dashboard="status"]').innerText().catch(() => "");
  drill.check(/Closed/.test(status) && /Onboarding \d\/4/.test(status) && /Open storefront/.test(status), "owner: the store card says Closed, Onboarding n/4 and Open storefront", status);
  drill.check((await page.locator('[data-dashboard="queue"]').count()) === 1, "owner: the action queue shows", null);
  for (const days of [7, 90, 30]) {
    await page.locator('nav[aria-label="Date range"] a', { hasText: `${days} days` }).click();
    await page.waitForURL(days === 30 ? /\/admin\/dashboard$/ : new RegExp(`days=${days}$`), { timeout: 30_000 });
    await settle(page);
    const current = await page.locator('nav[aria-label="Date range"] a[aria-current="page"]').innerText().catch(() => "");
    const rows = await page.locator('[data-dashboard="chart"] table.sr-only tbody tr').count();
    drill.check(current.trim() === `${days} days` && rows === days, `owner: the range switch moves to ${days} days (marked, ${days} chart days)`, { current, rows, url: page.url() });
  }
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await open(page, "/admin/dashboard");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    drill.check(over <= 0, `owner ${w}px: no sideways scroll`, over);
    await drill.shoot(page, `owner-${w}`, { fullPage: true });
  }
}

async function support(drill, page, s) {
  const r = await open(page, "/admin/dashboard");
  drill.check(r.status === 200 && !ERROR_TEXT.test(r.body), "support: /admin/dashboard renders", { status: r.status, body: r.body.slice(0, 200) });
  const html = await page.content();
  const leaks = [s.shopper.email, s.shopper.name, ROLES_LOGINS.shopper?.phone].filter((x) => typeof x === "string" && x && html.includes(x));
  drill.check(leaks.length === 0, "support: no customer name, email or phone in the page (the Shopify domain: test:dashboard)", leaks);
  const runAgain = await page.locator('main button:has-text("Run again"), main button:has-text("Try again"), main button:has-text("Bring in products")').evaluateAll((els) => els.filter((e) => !e.disabled && e.getAttribute("aria-disabled") !== "true").length);
  drill.check(runAgain === 0, "support: no sync button it could press", runAgain);
  const settings = await page.locator("main a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter((h) => /^\/admin\/(settings|integrations|automations|billing)/.test(h)));
  drill.check(settings.length === 0, "support: no link to a settings page", settings);
  const stray = await page.evaluate(unmarked);
  drill.check(stray.length === 0, "support: every control in main is a marked read (or disabled)", stray);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await open(page, "/admin/dashboard");
    await drill.shoot(page, `support-${w}`, { fullPage: true });
  }
}

async function dashboard(drill) {
  if (!port) throw new Error("drill:dashboard needs ROLES_PORT (run it as pnpm drill:dashboard).");
  const s = seed();
  const ctxFor = async () => {
    const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    ctx.setDefaultTimeout(60_000);
    return ctx;
  };
  const ownerPage = await signInForm(drill, await ctxFor(), s.members.find((m) => m.role === "owner"));
  await owner(drill, ownerPage);
  const supportPage = await signInApi(await ctxFor(), s.members.find((m) => m.role === "support"));
  await support(drill, supportPage, s);
}

runDrill({ id: DRILL_ID, part: "main", title: "DASHBOARD — the merchant dashboard on the new UI" }, dashboard).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
