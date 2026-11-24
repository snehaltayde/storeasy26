// SHELL: `pnpm drill:shell`, the new console shell in a real browser (Phase 0
// line 8, docs/plans/phase-0.md "Line 8" §5). Run by scripts/drills/run-isolated.mjs
// in a throwaway worktree: it seeds and starts the roles store, adds the
// Roles Annex (node scripts/dev-roles.js annex), then runs this. Never in the
// owner's checkout (runDrill refuses).
//
// Sign-ins: the owner once through the real form (the known flake: a 404 or
// "1 Issue" page, or no #login-email after 15 s, is reloaded once and logged;
// a second failure is a real fault); admin, staff and support through
// POST /api/admin/login in their own context. Assertions are never retried.
//
// Each role at 1280, 900 and 375 wide: lands on /admin/dashboard with the
// sidebar and a 56px top bar; the nav's hrefs are navFor(role); every item
// opens with 200, no error boundary, a non-empty [data-legacy] and
// aria-current on that item; at 900 the sidebar is icon width and a tooltip
// shows on focus; at 375 the trigger opens the sheet, Esc closes it with
// focus back on the trigger, and a link tap closes it.
// Support: outside [data-legacy] only allowlisted controls on every page; the
// account menu (name, email, "Support", the read-only note, Sign out the only
// action); no create item in the switcher; the write buttons support still
// sees inside the old screens go to support-write-controls.json (Phase 2's
// list, not a failure).
// Owner: the switcher (Roles Demo Co and Roles Annex with roles, current
// checked; choosing Annex requests the annex host's /admin); ⌘B collapses
// and survives a reload; Esc on the account menu returns focus; Tab from the
// top reaches the skip link first; Sign out lands on /admin/login and the
// dashboard then redirects to sign-in.
// Results: docs/cms-reviews/drills/SHELL/result.json (and results-main.json).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";
import { navFor, navItems } from "../../../lib/admin/nav.js";

const DRILL_ID = "SHELL";
const WIDTHS = [1280, 900, 375];
const HEIGHT = 900;
const ROLES = ["owner", "admin", "staff", "support"];
const CONTROLS = ["skip", "toggle", "switcher", "account"];
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;

const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const ANNEX = `http://annex.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

// In the page: interactive elements outside [data-legacy] that are not nav
// links or allowlisted shell controls.
function strayControls(allowed) {
  const q = 'a[href], button, input, select, textarea, [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  return [...document.querySelectorAll(q)]
    .filter((el) => !el.closest("[data-legacy]") && !el.closest("[data-nav-item]") && !allowed.some((c) => el.closest(`[data-shell-control="${c}"]`)))
    .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""} "${(el.innerText || "").trim().slice(0, 40)}"`);
}
// In the page: the enabled buttons and action links inside the old screens.
function legacyControls() {
  return [...document.querySelectorAll("main [data-legacy] button, main [data-legacy] [role=button], main [data-legacy] a[href]")]
    .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.getClientRects().length)
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60), href: el.getAttribute("href") || null }))
    .filter((c) => c.text && (c.tag !== "a" || /\b(new|create|add|edit|delete|archive|publish|save|cancel|refund|sync|upload|duplicate|invite|remove)\b/i.test(c.text)));
}

async function signInForm(drill, ctx, creds) {
  const page = await ctx.newPage();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await page.goto(`${ORIGIN}/admin/login`, { waitUntil: "load" });
    const shown = await page.locator("#login-email").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const flaky = !shown || res?.status() === 404 || /1 Issue/.test(await page.locator("body").innerText().catch(() => ""));
    if (!flaky) break;
    if (attempt === 2) throw new Error(`the sign-in form did not show twice in a row (status ${res?.status()}): a real fault`);
    drill.note(`known flake: the sign-in form did not show (status ${res?.status()}); reloading once`);
  }
  await page.locator("#login-email").fill(creds.email);
  await page.locator("#login-password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/admin\/dashboard$/, { timeout: 60_000 });
  return page;
}

async function signInApi(ctx, creds) {
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: creds, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${creds.email} answered ${res.status()}`);
  const page = await ctx.newPage();
  return page;
}

const hrefsIn = (page, scope) => page.locator(`${scope} a[data-nav-item]`).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
const activeId = () => document.activeElement?.closest("[data-shell-control]")?.getAttribute("data-shell-control") || document.activeElement?.tagName || null;
const sheet = (page) => page.locator('[data-mobile="true"][data-slot="sidebar"]');

async function waitFor(page, fn, arg, ms = 5000) {
  return page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
}

async function roleAtWidth(drill, page, role, width, out) {
  const want = navItems(navFor(role)).map((i) => i.href);
  await page.setViewportSize({ width, height: HEIGHT });
  const res = await page.goto(`${ORIGIN}/admin`, { waitUntil: "load" });
  await settle(page);
  const tag = `${role} ${width}px`;
  const row = { role, width, checks: 0, failed: 0 };
  const check = (okv, label, detail) => {
    row.checks++;
    if (!drill.check(okv, `${tag}: ${label}`, detail)) row.failed++;
  };
  check(new URL(page.url()).pathname === "/admin/dashboard" && res?.status() === 200, "/admin lands on /admin/dashboard", `${res?.status()} ${page.url()}`);
  const bar = await page.locator('[data-shell="topbar"]').boundingBox();
  check(bar && Math.round(bar.height) === 56, "the top bar is 56px", bar);
  const container = page.locator('[data-slot="sidebar-container"]');
  if (width === 1280) {
    const w = await container.evaluate((e) => Math.round(e.getBoundingClientRect().width)).catch(() => 0);
    check(w === 240, "the sidebar is 240px", w);
  } else if (width === 900) {
    const icon = await waitFor(page, () => Math.round(document.querySelector('[data-slot="sidebar-container"]')?.getBoundingClientRect().width || 0) === 48);
    check(icon, "the sidebar is icon width (48px)", await container.evaluate((e) => e.getBoundingClientRect().width).catch(() => null));
  } else {
    check(!(await container.isVisible().catch(() => false)), "no sidebar column on a phone", null);
  }
  // the nav's links
  let links;
  if (width === 375) {
    await page.locator('[data-shell-control="toggle"]').click();
    await sheet(page).waitFor({ timeout: 5000 }).catch(() => {});
    links = await hrefsIn(page, '[data-mobile="true"]');
    await page.keyboard.press("Escape");
    const closed = await waitFor(page, () => !document.querySelector('[data-mobile="true"][data-slot="sidebar"]'));
    check(closed, "Esc closes the sheet", null);
    check((await page.evaluate(activeId)) === "toggle", "focus returns to the trigger", await page.evaluate(activeId));
  } else {
    links = await hrefsIn(page, '[data-slot="sidebar-container"]');
  }
  check(JSON.stringify(links) === JSON.stringify(want), "the nav's hrefs are navFor(role)", { links, want });
  if (width === 900) {
    const first = page.locator('[data-slot="sidebar-container"] a[data-nav-item]').first();
    await first.focus();
    const tip = page.locator('[data-slot="tooltip-content"]');
    const shown = await tip.first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    check(shown && (await tip.first().innerText()).includes("Dashboard"), "a tooltip shows on focus", shown);
    await page.keyboard.press("Escape");
  }
  if (width === 375) {
    await page.locator('[data-shell-control="toggle"]').click();
    await sheet(page).waitFor({ timeout: 5000 }).catch(() => {});
    await sheet(page).locator('a[data-nav-item="orders"]').click();
    await page.waitForURL(/\/admin\/orders$/, { timeout: 60_000 }).catch(() => {});
    const closed = await waitFor(page, () => !document.querySelector('[data-mobile="true"][data-slot="sidebar"]'));
    check(closed && new URL(page.url()).pathname === "/admin/orders", "a link tap opens the page and closes the sheet", page.url());
  }
  // every item
  for (const href of want) {
    const r = await page.goto(ORIGIN + href, { waitUntil: "load" });
    await settle(page);
    const body = await page.locator("body").innerText().catch(() => "");
    const legacy = await page.evaluate(() => {
      const el = document.querySelector("main > [data-legacy]");
      return el ? el.children.length > 0 && (el.textContent || "").trim().length > 0 : false;
    });
    let current;
    if (width === 375) {
      await page.locator('[data-shell-control="toggle"]').click();
      await sheet(page).waitFor({ timeout: 5000 }).catch(() => {});
      current = await page.locator('[data-mobile="true"] a[aria-current="page"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
      await page.keyboard.press("Escape");
      await waitFor(page, () => !document.querySelector('[data-mobile="true"][data-slot="sidebar"]'));
    } else {
      current = await page.locator('[data-slot="sidebar-container"] a[aria-current="page"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    }
    check(r?.status() === 200 && !ERROR_TEXT.test(body) && legacy && JSON.stringify(current) === JSON.stringify([href]), `${href} opens (200, no error, content in [data-legacy], aria-current)`, { status: r?.status(), error: ERROR_TEXT.test(body), legacy, current });
    if (role === "support" && width === 1280) {
      const stray = await page.evaluate(strayControls, CONTROLS);
      check(stray.length === 0, `${href}: outside [data-legacy] only nav links and shell controls`, stray);
      out.supportWrites.push({ page: href, controls: await page.evaluate(legacyControls) });
    }
  }
  out.rows.push(row);
}

async function supportMenus(drill, page) {
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  await page.goto(`${ORIGIN}/admin/dashboard`, { waitUntil: "load" });
  await settle(page);
  const s = seed().members.find((m) => m.role === "support");
  const label = await page.locator('[data-shell="read-only"]').innerText().catch(() => "");
  drill.check(label === "Read-only access", "support: the top bar says Read-only access", label);
  await page.locator('[data-shell-control="account"]').click();
  const menu = page.locator('[data-slot="dropdown-menu-content"]');
  await menu.waitFor({ timeout: 5000 });
  const text = await menu.innerText();
  drill.check([s.name, s.email, "Support"].every((x) => text.includes(x)) && (await menu.locator('[data-account="read-only"]').count()) === 1, "support: the account menu shows name, email, Support and the read-only note", text);
  const items = await menu.locator('[role="menuitem"]').allInnerTexts();
  drill.check(items.length === 1 && /Sign out/.test(items[0]), "support: Sign out is the account menu's only action", items);
  await page.keyboard.press("Escape");
  await page.locator('[data-shell-control="switcher"]').click();
  await menu.waitFor({ timeout: 5000 });
  const sw = await menu.innerText();
  const radios = await menu.locator('[role="menuitemradio"]').allInnerTexts();
  drill.check(!/\b(create|new|add)\b/i.test(sw) && radios.length >= 1, "support: no create item in the switcher", { radios, sw });
  await page.keyboard.press("Escape");
}

async function ownerFlows(drill, page) {
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  await page.goto(`${ORIGIN}/admin/dashboard`, { waitUntil: "load" });
  await settle(page);
  // the switcher
  await page.locator('[data-shell-control="switcher"]').click();
  const menu = page.locator('[data-slot="dropdown-menu-content"]');
  await menu.waitFor({ timeout: 5000 });
  const radios = await menu.locator('[role="menuitemradio"]').evaluateAll((els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, " ").trim(), checked: e.getAttribute("aria-checked") })));
  drill.check(radios.length === 2 && /Roles Annex Admin/.test(radios.map((r) => r.text).join("|")) && radios.some((r) => /Roles Demo Co Owner/.test(r.text) && r.checked === "true"), "owner: the switcher lists Roles Demo Co (Owner, checked) and Roles Annex (Admin)", radios);
  const asked = page.waitForRequest((r) => r.url().startsWith(`${ANNEX}/admin`), { timeout: 30_000 }).then((r) => r.url(), () => null);
  await menu.locator('[role="menuitemradio"]', { hasText: "Roles Annex" }).click();
  const url = await asked;
  drill.check(Boolean(url), `owner: choosing Roles Annex requests ${ANNEX}/admin`, url);
  await page.goto(`${ORIGIN}/admin/dashboard`, { waitUntil: "load" });
  await settle(page);
  // ⌘B, then a reload
  await page.locator("body").click({ position: { x: 900, y: 600 } }).catch(() => {});
  await page.keyboard.press("Meta+b");
  const collapsed = await waitFor(page, () => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") === "collapsed");
  await page.reload({ waitUntil: "load" });
  await settle(page);
  const after = await page.locator('[data-slot="sidebar"]').first().getAttribute("data-state");
  drill.check(collapsed && after === "collapsed", "owner: ⌘B collapses the sidebar and it stays collapsed after a reload", { collapsed, after });
  await page.keyboard.press("Meta+b");
  await waitFor(page, () => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") === "expanded");
  // Esc on the account menu
  await page.locator('[data-shell-control="account"]').click();
  await menu.waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('[data-slot="dropdown-menu-content"]'));
  drill.check((await page.evaluate(activeId)) === "account", "owner: Esc closes the account menu and focus returns to its trigger", await page.evaluate(activeId));
  // Tab from the top
  await page.reload({ waitUntil: "load" });
  await settle(page);
  await page.keyboard.press("Tab");
  drill.check((await page.evaluate(activeId)) === "skip", "owner: Tab from the top reaches the skip link first", await page.evaluate(activeId));
  // sign out
  await page.locator('[data-shell-control="account"]').click();
  await menu.waitFor({ timeout: 5000 });
  await menu.locator('[data-account="sign-out"]').click();
  await page.waitForURL(/\/admin\/login$/, { timeout: 30_000 }).catch(() => {});
  const landed = new URL(page.url()).pathname;
  await page.goto(`${ORIGIN}/admin/dashboard`, { waitUntil: "load" });
  drill.check(landed === "/admin/login" && new URL(page.url()).pathname === "/admin/login", "owner: Sign out lands on /admin/login and the dashboard then redirects to sign-in", { landed, after: page.url() });
}

async function shell(drill) {
  if (!port) throw new Error("drill:shell needs ROLES_PORT (run it as pnpm drill:shell).");
  const s = seed();
  const out = { rows: [], supportWrites: [] };
  const pages = {};
  for (const role of ROLES) {
    const m = s.members.find((x) => x.role === role);
    const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: HEIGHT }, deviceScaleFactor: 1 });
    ctx.setDefaultTimeout(60_000);
    pages[role] = role === "owner" ? await signInForm(drill, ctx, m) : await signInApi(ctx, m);
  }
  for (const role of ROLES) for (const w of WIDTHS) await roleAtWidth(drill, pages[role], role, w, out);
  await supportMenus(drill, pages.support);
  await ownerFlows(drill, pages.owner);
  const dir = drill.dir;
  writeFileSync(join(dir, "support-write-controls.json"), `${JSON.stringify({ id: DRILL_ID, note: "Write controls support still sees inside the old screens: Phase 2's list, not a failure.", total: out.supportWrites.reduce((n, p) => n + p.controls.length, 0), pages: out.supportWrites }, null, 2)}\n`);
  writeFileSync(
    join(dir, "result.json"),
    `${JSON.stringify({ id: DRILL_ID, ranAt: new Date().toISOString(), passed: drill.checks.filter((c) => c.ok).length, failed: drill.checks.filter((c) => !c.ok).length, byRoleAndWidth: out.rows, notes: drill.notes, failures: drill.checks.filter((c) => !c.ok) }, null, 2)}\n`,
  );
  drill.note(`support still sees ${out.supportWrites.reduce((n, p) => n + p.controls.length, 0)} write control(s) inside the old screens (support-write-controls.json)`);
}

runDrill({ id: DRILL_ID, part: "main", title: "SHELL — the new console shell, every role and width" }, shell).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
