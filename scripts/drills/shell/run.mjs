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
// Each role at 1280, 900 and 375 wide: /admin lands on /admin/onboarding (the
// roles store is closed; Phase 1 line 3) in the onboarding shell (no sidebar,
// the 56px top bar, the step panel); then /admin/dashboard with the sidebar
// and a 56px top bar; the onboarding nav item opens the onboarding shell; the nav's hrefs are navFor(role); every item
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
const ONBOARDING = "/admin/onboarding";

// The onboarding shell (Phase 1 line 3): its main, the step panel, no sidebar,
// the top bar's height, and the step panel's controls a role could press
// (outside the old screens' [data-legacy] regions; the step list and "Next"
// only move between steps) and the reasons shown for disabled ones.
async function onboardingShell(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-onboarding="panel"]');
    const bar = document.querySelector('[data-shell="topbar"]');
    const enabledWrites = [...(panel?.querySelectorAll("button:not([disabled])") || [])].filter((b) => !b.closest("[data-legacy]") && !b.hasAttribute("data-onboarding")).map((b) => b.innerText.trim());
    return {
      main: Boolean(document.querySelector('main[data-shell="onboarding"]')),
      panel: Boolean(panel),
      step: panel?.getAttribute("data-step") || null,
      sidebar: Boolean(document.querySelector('[data-slot="sidebar-container"]')),
      bar: bar ? Math.round(bar.getBoundingClientRect().height) : null,
      enabledWrites,
      reasons: [...(panel?.querySelectorAll('[data-onboarding="reason"]') || [])].map((r) => r.innerText.trim()),
    };
  });
}

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
  check(new URL(page.url()).pathname === ONBOARDING && res?.status() === 200, "/admin lands on /admin/onboarding (the store is closed)", `${res?.status()} ${page.url()}`);
  const ob = await onboardingShell(page);
  check(ob.main && ob.panel && !ob.sidebar && ob.bar === 56, "onboarding: no sidebar, the 56px top bar, a step panel", ob);
  await page.goto(`${ORIGIN}/admin/dashboard`, { waitUntil: "load" });
  await settle(page);
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
    if (href === ONBOARDING) {
      // new UI in its own shell: no sidebar to mark, no [data-legacy] region
      const o = await onboardingShell(page);
      check(r?.status() === 200 && !ERROR_TEXT.test(body) && o.main && o.panel && !o.sidebar, `${href} opens in the onboarding shell (200, no error, the step panel, no sidebar)`, { status: r?.status(), error: ERROR_TEXT.test(body), ...o });
      if (role === "support" && width === 1280) check(o.enabledWrites.length === 0, `${href}: support sees no enabled control in the step panel`, o.enabledWrites);
      continue;
    }
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
  const menu = page.locator('[data-slot="dropdown-menu-content"][data-state="open"]');
  await menu.waitFor({ timeout: 5000 });
  const text = await menu.innerText();
  drill.check([s.name, s.email, "Support"].every((x) => text.includes(x)) && (await menu.locator('[data-account="read-only"]').count()) === 1, "support: the account menu shows name, email, Support and the read-only note", text);
  const items = await menu.locator('[role="menuitem"]').allInnerTexts();
  drill.check(items.length === 1 && /Sign out/.test(items[0]), "support: Sign out is the account menu's only action", items);
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('[data-slot="dropdown-menu-content"]'));
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
  const menu = page.locator('[data-slot="dropdown-menu-content"][data-state="open"]');
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

// Phase 0 least-trusted audit (docs/cms-reviews/PHASE-0-AUDIT.md), browser pass.
// Support: deep links to the screens it must not have show the permission note
// and none of their data; setup opens; the write and owner-only APIs refuse it
// from its own signed-in context; /platform is the operator sign-in, never the
// console; on the Roles Annex (support is a member, nothing published, no
// orders) every nav item renders its empty state.
const DENIED_PAGES = ["/admin/settings", "/admin/integrations", "/admin/billing", "/admin/automations"];
const ONBOARDING_OPEN = "/admin/onboarding?step=open";
const NOTE = /Your role \(support\) can.t .+ ask an owner or admin/;
const PLATFORM_CONSOLE = /New tenant|Tenant registry|Provision/;

async function supportDeepLinks(drill, page) {
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  for (const path of DENIED_PAGES) {
    const r = await page.goto(ORIGIN + path, { waitUntil: "load" });
    await settle(page);
    const body = await page.locator("main").innerText().catch(() => "");
    drill.check(r?.status() === 200 && !ERROR_TEXT.test(body) && NOTE.test(body) && new URL(page.url()).pathname === path, `support deep link ${path}: the permission note, no error`, { status: r?.status(), url: page.url(), body: body.slice(0, 200) });
  }
  const setup = await page.goto(ORIGIN + ONBOARDING_OPEN, { waitUntil: "load" });
  await settle(page);
  const setupBody = await page.locator("body").innerText().catch(() => "");
  const ob = await onboardingShell(page);
  drill.check(setup?.status() === 200 && !ERROR_TEXT.test(setupBody) && ob.step === "open" && ob.enabledWrites.length === 0 && ob.reasons.length > 0, "support deep link /admin/onboarding?step=open: opens on that step read-only (controls disabled with their reason), no error", { status: setup?.status(), url: page.url(), ...ob });
  const api = (method, path, data) => page.request.fetch(`${ORIGIN}/api/admin/${path}`, { method, data, headers: { origin: ORIGIN }, maxRedirects: 0 }).then((r) => r.status());
  const refusals = {
    "PUT documents publish": await api("PUT", "documents", { publish: { id: "doc_missing", draftHash: "x" }, revision: 1 }),
    "PUT documents publishSet": await api("PUT", "documents", { publishSet: [] }),
    "POST releases publish": await api("POST", "releases", { action: "publish" }),
    "POST onboarding": await api("POST", "onboarding", { step: "test_order", done: true }),
    "PUT settings": await api("PUT", "settings", { bogus_setting: true }),
    "GET settings": await api("GET", "settings"),
    "GET team": await api("GET", "team"),
    "GET audit": await api("GET", "audit"),
    "GET help": await api("GET", "help"),
    "GET integrations": await api("GET", "integrations"),
  };
  drill.check(Object.values(refusals).every((s) => s === 403), "support: publish, the onboarding test-order mark, settings, team, audit, help and integrations APIs answer 403", refusals);
  const plat = await page.goto(`${ORIGIN}/platform`, { waitUntil: "load" });
  await settle(page);
  const platBody = await page.locator("body").innerText().catch(() => "");
  drill.check(plat?.status() === 200 && !PLATFORM_CONSOLE.test(platBody) && ((await page.locator("#pl-password").count()) === 1 || /Not configured/.test(platBody)), "support at /platform: the operator sign-in (or not configured), never the console", { status: plat?.status(), body: platBody.slice(0, 160) });
}

async function supportEmptyStates(drill, ctx, creds) {
  const res = await ctx.request.post(`${ANNEX}/api/admin/login`, { data: creds, headers: { origin: ANNEX }, maxRedirects: 0 });
  if (!drill.check(res.status() === 200, "support signs in on the Roles Annex", res.status())) return;
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  for (const href of navItems(navFor("support")).map((i) => i.href)) {
    const r = await page.goto(ANNEX + href, { waitUntil: "load" });
    await settle(page);
    const body = await page.locator("body").innerText().catch(() => "");
    const legacy = await page.evaluate(() => {
      const el = document.querySelector("main > [data-legacy]");
      return el ? (el.textContent || "").trim().length > 0 : false;
    });
    drill.check(r?.status() === 200 && !ERROR_TEXT.test(body) && legacy, `support on the empty Roles Annex: ${href} renders (200, no error, content)`, { status: r?.status(), error: ERROR_TEXT.test(body), legacy, url: page.url() });
  }
  await page.close();
}

// Anonymous: every console page (scripts/support/admin-pages.js) and /admin
// itself go to /admin/login; /platform is the operator sign-in; the Roles
// Annex (never published) shows only "Opening soon" on its storefront pages and
// its sitemap lists only the front door.
async function anonymousPass(drill, ctx) {
  const { ADMIN_PAGES } = await import("../../support/admin-pages.js");
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  const stray = [];
  for (const row of ADMIN_PAGES) {
    const path = `/admin${row.page ? `/${row.page.replace("[id]", "SHO-MISSING").replace("[slug]", "about")}` : ""}`;
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    if (new URL(page.url()).pathname !== "/admin/login") stray.push(`${path} → ${page.url()}`);
  }
  drill.check(stray.length === 0, `anonymous: all ${ADMIN_PAGES.length} console pages redirect to /admin/login`, stray);
  await page.goto(`${ORIGIN}/platform`, { waitUntil: "load" });
  await settle(page);
  const platBody = await page.locator("body").innerText().catch(() => "");
  drill.check(!PLATFORM_CONSOLE.test(platBody) && ((await page.locator("#pl-password").count()) === 1 || /Not configured/.test(platBody)), "anonymous at /platform: the operator sign-in (or not configured), never the console", platBody.slice(0, 160));
  for (const path of ["/", "/collections", "/products/fixture-product-1", "/journal", "/search?q=a", "/policies/privacy-policy", "/bundles/any"]) {
    const r = await page.goto(ANNEX + path, { waitUntil: "load" });
    await settle(page);
    const body = await page.locator("body").innerText().catch(() => "");
    drill.check((r?.status() ?? 500) < 500 && !ERROR_TEXT.test(body) && /Opening soon/.test(body), `anonymous on the closed Roles Annex: ${path} shows only "Opening soon"`, { status: r?.status(), body: body.slice(0, 160) });
  }
  const sm = await ctx.request.get(`${ANNEX}/sitemap.xml`);
  const locs = ((await sm.text()).match(/<loc>/g) || []).length;
  drill.check(sm.status() === 200 && locs === 1, "anonymous: the closed Roles Annex sitemap lists only its front door", { status: sm.status(), locs });
  await page.close();
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
  await supportDeepLinks(drill, pages.support);
  const annexCtx = await drill.browser.newContext({ viewport: { width: 1280, height: HEIGHT }, deviceScaleFactor: 1 });
  annexCtx.setDefaultTimeout(60_000);
  await supportEmptyStates(drill, annexCtx, s.members.find((x) => x.role === "support"));
  const anonCtx = await drill.browser.newContext({ viewport: { width: 1280, height: HEIGHT }, deviceScaleFactor: 1 });
  anonCtx.setDefaultTimeout(60_000);
  await anonymousPass(drill, anonCtx);
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
