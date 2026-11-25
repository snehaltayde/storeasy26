// OFFERS: `pnpm drill:offers`, offers and bundles on the new console UI in a
// real browser (docs/plans/phase-2.md "Line 4" §5 item 7). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store (seeded, closed, the four-product fixture catalog). Never in the
// owner's checkout (runDrill refuses).
//
// Staff (signed in through POST /api/admin/login):
//   - creates a "Buy more, save more" offer: the kind, the product picked with
//     the keyboard only (Enter opens the picker, typing searches, ArrowDown /
//     ArrowUp move, Esc closes with focus back on the trigger, Enter picks),
//     "Try it", Start offer; the list shows its sentence;
//   - changes it (Update live offer), goes back to the previous settings,
//     turns it off from the list (asks first), deletes it (asks first);
//   - creates a bundle whose price saves nothing (the check's words), saves it
//     off, and turning it on is refused in words.
// Support: /admin/offers, an offer, /admin/bundles and a bundle: no enabled
// switch, Save or Delete; every control is a marked read, natively disabled or
// RoleGate's; "Try it" answers; no non-GET request but the listed reads
// (scripts/support/read-controls.js READ_POSTS). An unknown id is a 404.
// Evidence: docs/cms-reviews/drills/OFFERS/ (results-main.json, screenshots).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";
import { READ_POSTS } from "../../support/read-controls.js";

const DRILL_ID = "OFFERS";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

async function signIn(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  return ctx.newPage();
}
const open = async (page, path) => {
  const r = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  return r;
};
const waitFor = (page, fn, arg, ms = 15_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

// In the page: controls support could press that are not a marked read, natively
// disabled or RoleGate's (the shell drill's rule on a new-UI route), in main
// and in any open popover or dialog.
function stray() {
  const q = 'a[href], button, input, select, textarea, [role="menuitem"], [role="link"], [tabindex]:not([tabindex="-1"])';
  const passes = (el) => el.hasAttribute("data-read-control") || el.disabled === true || (el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled");
  return [...document.querySelectorAll(q)]
    .filter((el) => el.closest("main, [role=dialog], [data-ref-combobox=popover]") && !el.closest("[data-nav-item]") && !el.closest("[data-shell-control]") && !passes(el))
    .map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
}

async function staffFlows(drill, page) {
  const check = (v, label, detail) => drill.check(v, `staff: ${label}`, detail);
  // --- a tiered offer, the product picked by keyboard ---
  await open(page, "/admin/offers/new");
  await page.getByText("Buy more, save more", { exact: true }).click();
  const trigger = page.locator('[data-ref-combobox="trigger"]').first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const pop = page.locator('[data-ref-combobox="popover"]');
  check(await pop.isVisible().catch(() => false), "Enter on the picker opens its popover", null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = !(await pop.isVisible().catch(() => false));
  const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("data-ref-combobox") === "trigger");
  check(closed && focusBack, "Esc closes the picker and focus returns to its trigger", { closed, focusBack });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Fixture product");
  await waitFor(page, () => document.querySelectorAll('[data-ref-combobox="list"] [role=option]').length >= 2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  const activeText = await page.evaluate(() => {
    const input = document.querySelector('[data-ref-combobox="popover"] [role=combobox]');
    return document.getElementById(input?.getAttribute("aria-activedescendant") || "")?.innerText?.trim() || null;
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const picked = await page.locator('[data-picked="target"]').innerText().catch(() => "");
  check(activeText && picked && activeText.startsWith(picked), "arrows move the active option and Enter picks it", { activeText, picked });
  await page.getByRole("button", { name: /^Try it/ }).click();
  check(await waitFor(page, () => document.querySelector("[data-simulator=result] [data-example]")), "Try it shows an example cart from the store", null);
  await drill.screenshot(page, "staff-new-offer");
  await page.locator("[data-offer-save]").click();
  await page.waitForURL(/\/admin\/offers$/, { timeout: 60_000 }).catch(() => {});
  await settle(page);
  const rowLink = page.locator('main table a[href^="/admin/offers/tiered-"]').first();
  const href = await rowLink.getAttribute("href").catch(() => null);
  check(Boolean(href), "Start offer lands on the list with the new offer", page.url());
  if (!href) return null;
  // --- change it, then go back ---
  await open(page, href);
  await page.getByLabel("Step 1: percent off").fill("15");
  await page.getByRole("button", { name: "Update live offer" }).click();
  await page.waitForURL(/\/admin\/offers$/, { timeout: 60_000 }).catch(() => {});
  await open(page, href);
  const before = await page.locator('[data-sentence="previous"]').innerText().catch(() => "");
  check(/10%/.test(before), "the earlier settings are shown after a change", before);
  await page.getByRole("button", { name: "Go back to previous settings" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Go back" }).click();
  await page.waitForURL(/\/admin\/offers$/, { timeout: 60_000 }).catch(() => {});
  await open(page, href);
  check(/10%/.test(await page.locator('[data-sentence="old"]').innerText().catch(() => "")), "going back restores the earlier settings", null);
  // --- off from the list, asked first ---
  await open(page, "/admin/offers");
  const id = decodeURIComponent(href.split("/").pop());
  await page.locator(`[data-offer-switch="${id}"]`).click();
  const asked = await page.getByRole("alertdialog").isVisible().catch(() => false);
  await page.getByRole("alertdialog").getByRole("button", { name: "Turn off" }).click();
  await waitFor(page, (i) => document.querySelector(`[data-offer-switch="${i}"]`)?.getAttribute("aria-checked") === "false", id);
  check(asked && (await page.locator(`[data-offer-switch="${id}"]`).getAttribute("aria-checked")) === "false", "turning off a live offer asks first, then it is off", null);
  // --- delete, asked first ---
  await open(page, href);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete offer" }).click();
  await page.waitForURL(/\/admin\/offers$/, { timeout: 60_000 }).catch(() => {});
  await settle(page);
  check((await page.locator(`main a[href="${href}"]`).count()) === 0, "Delete asks first and the offer is gone", null);
  // --- a discount code that stays, for support's pass ---
  await open(page, "/admin/offers/new");
  await page.getByText("Discount code", { exact: true }).click();
  await page.locator("[data-offer-save]").click();
  await page.waitForURL(/\/admin\/offers$/, { timeout: 60_000 }).catch(() => {});
  await settle(page);
  const keep = await page.locator('main table a[href^="/admin/offers/coupon-"]').first().getAttribute("href").catch(() => null);
  check(Boolean(keep), "a discount code is started (kept for support's pass)", null);
  // --- a bundle whose price saves nothing ---
  await open(page, "/admin/bundles/new");
  await page.locator("#bundle-name").fill("Drill pair");
  for (const name of ["Fixture product 1", "Fixture product 2"]) {
    await page.getByRole("button", { name: /Add a product/ }).click();
    await page.keyboard.type(name);
    await waitFor(page, (n) => [...document.querySelectorAll('[data-ref-combobox="list"] [role=option]')].some((o) => o.innerText.includes(n)), name);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
  }
  await page.locator("#bundle-price").fill("5000");
  const words = await waitFor(page, () => /Price must be lower than/.test(document.querySelector("[data-bundle-reasons]")?.innerText || ""));
  check(words && (await page.locator("[data-bundle-row]").count()) === 2, "the live check says the price must be lower, in words", null);
  await drill.screenshot(page, "staff-bundle-no-saving");
  await page.locator("[data-bundle-save]").click();
  await page.waitForURL(/\/admin\/bundles$/, { timeout: 60_000 }).catch(() => {});
  await settle(page);
  const bundleHref = await page.locator('main table a[href^="/admin/bundles/bun-"]').first().getAttribute("href").catch(() => null);
  check(Boolean(bundleHref), "the bundle is saved off and listed", null);
  await page.locator("[data-bundle-switch]").first().click();
  const refused = await waitFor(page, () => /can't be turned on/.test(document.querySelector("[data-bundle-error]")?.innerText || ""));
  const said = await page.locator("[data-bundle-error]").innerText().catch(() => "");
  check(refused && /Price must be lower than/.test(said) && !/[A-Z_]{6,}/.test(said), "turning it on is refused with the reasons in words", said);
  await drill.screenshot(page, "staff-bundle-refused");
  return { offer: keep, bundle: bundleHref };
}

async function supportPass(drill, page, made) {
  const writes = [];
  let devOverlay = 0;
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    // /__nextjs_* is the dev server's own error overlay (next dev only), not the app
    if (path.startsWith("/__nextjs_")) return void devOverlay++;
    if (!["GET", "HEAD"].includes(req.method()) && !READ_POSTS.some((r) => r.method === req.method() && r.path === path)) writes.push(`${req.method()} ${path}`);
  });
  const errors = [];
  // React's development build says it needs eval() under the app's CSP (no
  // 'unsafe-eval', next.config.mjs) on every page of a next dev server: noted, not this slice's
  const DEV_EVAL = /eval\(\) is not supported in this environment/;
  page.on("console", (m) => m.type() === "error" && !DEV_EVAL.test(m.text()) && errors.push(`${new URL(page.url()).pathname}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => errors.push(`${new URL(page.url()).pathname}: ${String(e?.message || e).slice(0, 300)}`));
  const reads = [];
  page.on("request", (req) => READ_POSTS.some((r) => r.path === new URL(req.url()).pathname) && reads.push(req.method()));
  for (const path of ["/admin/offers", made.offer, "/admin/bundles", made.bundle].filter(Boolean)) {
    const r = await open(page, path);
    const s = await page.evaluate(stray);
    const switches = await page.locator('main [role="switch"]:not([disabled])').count();
    const saves = await page.locator("main [data-offer-save], main [data-bundle-save]").count();
    const deletes = await page.locator('main button:has-text("Delete")').count();
    drill.check(r?.status() === 200 && !s.length && !switches && !saves && !deletes, `support ${path}: 200, no enabled switch, Save or Delete, and only reads to press`, { status: r?.status(), stray: s, switches, saves, deletes });
    await drill.screenshot(page, `support${path.replaceAll("/", "-")}`);
  }
  if (made.offer) {
    await open(page, made.offer);
    await page.getByRole("button", { name: /^Try it/ }).click();
    drill.check(await waitFor(page, () => document.querySelector("[data-simulator=result] [data-example], [data-simulator=result] p")?.innerText), "support: Try it answers on a read-only offer", null);
    drill.check(reads.includes("POST"), "support: Try it is POST /api/admin/offers/simulate (a listed read)", reads);
  }
  drill.check(writes.length === 0, "support: no non-GET request but the listed reads", writes);
  drill.check(errors.length === 0, "support: no console error or page error on the four pages", errors);
  drill.note(`next dev: React's dev build asked for eval() under the CSP on these pages; its overlay sent ${devOverlay} request(s) to /__nextjs_* (dev tooling, not counted as writes)`);
  // the route's loading.js streams the page, so the status is already sent: the not-found page says it
  const missing = [];
  for (const path of ["/admin/offers/off_missing", "/admin/bundles/bun-missing"]) {
    await open(page, path);
    if (!/404 — not found/.test(await page.locator("body").innerText().catch(() => ""))) missing.push(path);
  }
  drill.check(missing.length === 0, "an unknown offer or bundle id shows the not-found page", missing);
}

async function offers(drill) {
  if (!port) throw new Error("drill:offers needs ROLES_PORT (run it as pnpm drill:offers).");
  const staff = await signIn(drill, "staff");
  const made = (await staffFlows(drill, staff)) || {};
  const support = await signIn(drill, "support");
  await supportPass(drill, support, made);
}

runDrill({ id: DRILL_ID, part: "main", title: "OFFERS — offers and bundles on the new console UI" }, offers).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
