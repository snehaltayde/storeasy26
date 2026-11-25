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
// opens with 200, no error boundary, a non-empty [data-legacy] (on a new-UI
// route, lib/admin/new-ui-routes.js: content in main and no [data-legacy] but
// the notices') and aria-current on that item; at 900 the sidebar is icon width and a tooltip
// shows on focus; at 375 the trigger opens the sheet, Esc closes it with
// focus back on the trigger, and a link tap closes it.
// Support: outside [data-legacy] (on a new-UI route: anywhere) only
// allowlisted controls on every page; the
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
import { isNewUiRoute } from "../../../lib/admin/new-ui-routes.js";
import { RANGES, rangeHref } from "../../../lib/admin/dashboard-ranges.js";
import * as RC from "../../support/read-controls.js";

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

// In the page: interactive elements that are not nav links or allowlisted
// shell controls, outside [data-legacy] (an old route) or anywhere (a new-UI
// route, lib/admin/new-ui-routes.js: the rule covers the whole of main). On a
// new-UI route a control also passes when it carries data-read-control itself
// (never through an ancestor), is natively disabled, or is RoleGate's
// (aria-disabled="true" with data-role-gate="disabled"). Radix's focus
// guards (an empty span[data-radix-focus-guard] with tabindex="0" around a
// sheet, select or dialog) are not controls; anything else in a portal is.
function strayControls([allowed, newUi]) {
  const q = 'a[href], button, input, select, textarea, summary, label[for], [role="button"], [role="menuitem"], [role="link"], [onclick], [tabindex]:not([tabindex="-1"])';
  const passes = (el) => newUi && (el.hasAttribute("data-read-control") || el.disabled === true || (el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled"));
  const focusGuard = (el) => el.matches("span[data-radix-focus-guard]") && el.getAttribute("tabindex") === "0" && el.textContent === "" && el.children.length === 0;
  return [...document.querySelectorAll(q)]
    .filter((el) => (newUi || !el.closest("[data-legacy]")) && !el.closest("[data-nav-item]") && !allowed.some((c) => el.closest(`[data-shell-control="${c}"]`)) && !passes(el) && !focusGuard(el))
    .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""} "${(el.innerText || "").trim().slice(0, 40)}"`);
}
// In the page (a new-UI route): marked reads that could still write: a
// submit or image button, a form= or formaction override, or one inside a
// form without an explicit method="get".
function unsafeReads() {
  const formOk = (f) => !f || (f.getAttribute("method") || "").toLowerCase() === "get";
  return [...document.querySelectorAll("[data-read-control]")]
    .filter((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return type === "submit" || type === "image" || el.hasAttribute("form") || el.hasAttribute("formaction") || (el.tagName === "BUTTON" && el.closest("form") && !el.hasAttribute("type")) || !formOk(el.closest("form"));
    })
    .map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().slice(0, 40)}"`);
}
// In the page: forms a support user could submit with Enter. A form with a
// text field submits implicitly unless its default (first) submit button is
// natively disabled or RoleGate's; an explicit method="get" form only
// navigates (a search), so it passes.
function implicitSubmits() {
  const TEXT = new Set(["", "text", "search", "email", "number", "password", "tel", "url", "date", "datetime-local", "month", "time", "week"]);
  const gated = (b) => b.disabled || (b.getAttribute("aria-disabled") === "true" && b.getAttribute("data-role-gate") === "disabled");
  return [...document.querySelectorAll("form")]
    .filter((f) => (f.getAttribute("method") || "").toLowerCase() !== "get")
    .filter((f) => [...f.elements].some((e) => e.tagName === "INPUT" && TEXT.has((e.getAttribute("type") || "").toLowerCase()) && !e.disabled && !e.readOnly))
    .filter((f) => {
      const submit = [...f.elements].find((e) => (e.tagName === "BUTTON" && (e.getAttribute("type") || "submit").toLowerCase() === "submit") || (e.tagName === "INPUT" && ["submit", "image"].includes((e.getAttribute("type") || "").toLowerCase())));
      return !submit || !gated(submit);
    })
    .map((f) => `form${f.id ? `#${f.id}` : ""} (${f.elements.length} fields)`);
}

// Support on a new-UI route (and the drill's self-test pages):
//   - the page under test is page.url() after loading href, and must be href
//   - each marked read: click it; when the path is unchanged (a new query
//     string included) the whole document (portals, menus, popovers) may
//     hold no stray control
//   - each RoleGate-disabled control: mouse-click it and press Enter and Space
//     on it: no non-GET request, no navigation
//   - each enabled text field: press Enter in it: no non-GET request
//   - every non-GET request any page of the context sends during the pass
//     counts (workers, popups and new tabs included; no Referer is trusted),
//     until the tab navigates to a different path: a read link's destination
//     gets its own pass. Skipped only: an exact READ_POSTS row
//     (scripts/support/read-controls.js, a read sent as POST: { page, method,
//     path, reason }; none yet), and Next's dev error overlay (POST
//     /__nextjs_*) when the server is a dev server (its page opened the HMR
//     socket), never against a production build.
// Returns what it found; the caller checks.
const READ_POSTS = RC.READ_POSTS ?? [];
const readPost = (page, method, path) => READ_POSTS.some((r) => r.page === page && r.method === method && r.path === path);
async function supportNewUiControls(page, href) {
  const writes = [];
  const target = new URL(ORIGIN + href).pathname;
  const ctx = page.context();
  let counting = false;
  let devServer = false;
  const popups = [];
  const onNavigated = (frame) => {
    if (frame === page.mainFrame()) counting = new URL(frame.url()).pathname === target;
  };
  const onSocket = (ws) => {
    if (/\/_next\/webpack-hmr/.test(ws.url())) devServer = true;
  };
  const onRequest = (req) => {
    if (!counting || req.method() === "GET" || req.method() === "HEAD") return;
    const path = new URL(req.url()).pathname;
    if (devServer && path.startsWith("/__nextjs")) return;
    if (readPost(target, req.method(), path)) return;
    writes.push(`${req.method()} ${path}`);
  };
  const onPage = (p) => {
    if (p !== page) popups.push(p);
  };
  const found = { at: [], unsafe: [], implicit: [], revealed: [], moved: [], writes, reads: 0, gated: 0, fields: 0 };
  const fresh = async () => {
    await page.goto(ORIGIN + href, { waitUntil: "load" });
    await settle(page);
    if (page.url() !== ORIGIN + href) found.at.push(page.url());
  };
  page.on("framenavigated", onNavigated);
  page.on("websocket", onSocket);
  ctx.on("request", onRequest);
  ctx.on("page", onPage);
  try {
    await fresh();
    found.unsafe = await page.evaluate(unsafeReads);
    found.implicit = await page.evaluate(implicitSubmits);
    found.reads = await page.locator("main [data-read-control]").count();
    for (let i = 0; i < found.reads; i++) {
      await fresh();
      const el = page.locator("main [data-read-control]").nth(i);
      if (!(await el.isVisible().catch(() => false)) || (await el.isDisabled().catch(() => true))) continue;
      await el.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      await settle(page);
      // a link to another path: that page gets its own pass; the same path
      // (a menu, a popover, or a new ?query) is checked again here
      if (new URL(page.url()).pathname === target) for (const x of await page.evaluate(strayControls, [CONTROLS, true])) found.revealed.push(`after read #${i} (${page.url().slice(ORIGIN.length)}): ${x}`);
    }
    await fresh();
    found.gated = await page.locator('main [data-role-gate="disabled"]').count();
    for (let i = 0; i < found.gated; i++) {
      for (const how of ["click", "Enter", "Space"]) {
        const el = page.locator('main [data-role-gate="disabled"]').nth(i);
        const before = page.url();
        if (how === "click") await el.click({ timeout: 5000, force: true }).catch(() => {});
        else {
          await el.focus().catch(() => {});
          await page.keyboard.press(how);
        }
        await page.waitForTimeout(300);
        if (page.url() !== before) {
          found.moved.push(`${how} on gated #${i} → ${page.url()}`);
          await fresh();
        }
      }
    }
    await fresh();
    const fieldSel = 'main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])';
    found.fields = await page.locator(fieldSel).count();
    for (let i = 0; i < found.fields; i++) {
      await fresh();
      const el = page.locator(fieldSel).nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.focus().catch(() => {});
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(300); // a write sent on the way out still lands in the count
  } finally {
    page.off("framenavigated", onNavigated);
    page.off("websocket", onSocket);
    ctx.off("request", onRequest);
    ctx.off("page", onPage);
    for (const p of popups) await p.close().catch(() => {});
  }
  return found;
}
const checkNewUi = (check, href, f) => {
  check(f.at.length === 0, `${href}: the page under test is ${href} after loading it`, f.at);
  check(f.unsafe.length === 0, `${href}: no marked read control submits a form (submit, image, form=, formaction, a non-GET form)`, f.unsafe);
  check(f.implicit.length === 0, `${href}: no form support can submit with Enter (a text field needs a gated or disabled default submit, or method="get")`, f.implicit);
  check(f.revealed.length === 0, `${href}: clicking support's ${f.reads} marked read(s) reveals no write control anywhere (menus and popovers included)`, f.revealed);
  check(f.writes.length === 0, `${href}: support's reads, ${f.gated} gated control(s) (click, Enter, Space) and ${f.fields} field(s) (Enter) send no non-GET request`, f.writes);
  check(f.moved.length === 0, `${href}: support's gated controls do not navigate`, f.moved);
};

// New-UI routes whose query changes what the page shows: support's pass runs
// on each. Phase 2 lines append their own row.
const NEW_UI_VARIANTS = {
  "/admin/dashboard": RANGES.map(rangeHref), // Phase 2 line 1: ?days=7, 30 (the plain page), 90
};

// The support check's own self-test: one page per escape, served by the drill
// (ctx.route, so popups and workers get them too), each of which must be caught.
const SELFTEST = "/__shell-drill-selftest";
const SELFTEST_PAGES = {
  menu: `<main><button type="button" data-read-control onclick="document.body.insertAdjacentHTML('beforeend','<div role=menu><button>Delete store</button></div>')">More</button></main>`,
  "fake-gate": `<main><button aria-disabled="true" data-role-gate="disabled" onclick="fetch('${SELFTEST}/w',{method:'POST'})">Push</button></main>`,
  "submit-escapes": `<main><form id="f" method="post"></form><button type="button" form="f" data-read-control>A</button><button type="button" formaction="/x" data-read-control>B</button><input type="image" alt="C" data-read-control><form><button type="button" data-read-control>D</button></form></main>`,
  implicit: `<main><form id="q" onsubmit="event.preventDefault();fetch('${SELFTEST}/w',{method:'POST'})"><input name="q"></form></main>`,
  clean: `<main><form method="get"><input name="q" data-read-control><button type="button" data-read-control>Search</button></form><button aria-disabled="true" data-role-gate="disabled" onclick="event.preventDefault()">Save</button></main>`,
  // a write form whose default submit is gated: Enter can't submit it (its
  // editable field is still a stray control for support, checked elsewhere)
  "gated-form": `<main><form onsubmit="fetch('${SELFTEST}/w',{method:'POST'})"><input name="n"><button aria-disabled="true" data-role-gate="disabled" onclick="event.preventDefault()">Save</button></form></main>`,
  // a read link to another page that POSTs on load: that page's request is its own pass's
  "nav-read": `<main><a href="${SELFTEST}/posts-on-load" data-read-control>Open</a></main>`,
  "posts-on-load": `<main><p>Landed</p><script>fetch('${SELFTEST}/w',{method:'POST'})</script></main>`,
  // a "read" that POSTs and then navigates away: still this page's write
  "post-then-leave": `<main><button type="button" data-read-control onclick="fetch('${SELFTEST}/w',{method:'POST',keepalive:true});location.href='${SELFTEST}/posts-on-load'">Open</button></main>`,
  // the same write, each hiding where it came from: none may pass
  "referrer-origin": `<main><button type="button" data-read-control onclick="fetch('${SELFTEST}/w',{method:'POST',keepalive:true,referrerPolicy:'origin'});location.href='${SELFTEST}/posts-on-load'">Open</button></main>`,
  "custom-referrer": `<main><button type="button" data-read-control onclick="fetch('${SELFTEST}/w',{method:'POST',keepalive:true,referrer:location.origin+'${SELFTEST}/posts-on-load'});location.href='${SELFTEST}/posts-on-load'">Open</button></main>`,
  worker: `<main><button type="button" data-read-control onclick="new Worker(URL.createObjectURL(new Blob(['fetch(&quot;'+location.origin+'${SELFTEST}/w&quot;,{method:&quot;POST&quot;})'],{type:'text/javascript'})))">Open</button></main>`,
  "blank-form": `<main><form id="bf" method="post" action="${SELFTEST}/w" target="_blank"></form><button type="button" data-read-control onclick="document.getElementById('bf').submit()">Open</button></main>`,
  "window-open": `<main><button type="button" data-read-control onclick="const w=window.open('about:blank','_blank');w.fetch(location.origin+'${SELFTEST}/w',{method:'POST'})">Open</button></main>`,
  // a Radix portal: its empty focus guards are not controls; a button in it is,
  // and so is a "guard" with text
  "radix-portal": `<main><button type="button" data-read-control onclick="document.body.insertAdjacentHTML('beforeend','<div data-radix-portal><span data-radix-focus-guard tabindex=0></span><div role=dialog><button>Delete store</button><span data-radix-focus-guard tabindex=0>x</span></div><span data-radix-focus-guard tabindex=0></span></div>')">More</button></main>`,
};
async function supportSelfTest(drill, ctx) {
  const page = await ctx.newPage();
  await ctx.route(`${ORIGIN}${SELFTEST}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill(SELFTEST_PAGES[name] ? { status: 200, contentType: "text/html", body: `<!doctype html><html><body>${SELFTEST_PAGES[name]}</body></html>` } : { status: 204, body: "" });
  });
  const run = (name) => supportNewUiControls(page, `${SELFTEST}/${name}`);
  const menu = await run("menu");
  drill.check(menu.revealed.some((x) => x.includes("Delete store")), "self-test: a write item a marked read reveals in a menu is caught", menu);
  const fake = await run("fake-gate");
  drill.check(fake.writes.some((x) => x.startsWith("POST")), "self-test: a fake gate's mouse click that POSTs is caught", fake);
  const esc = await run("submit-escapes");
  drill.check(["A", "B", "C", "D"].every((n) => esc.unsafe.some((x) => x.includes(`"${n}"`))), "self-test: form=, formaction, type=image and a form without method=get are caught", esc.unsafe);
  const imp = await run("implicit");
  drill.check(imp.implicit.length === 1 && imp.writes.some((x) => x.startsWith("POST")), "self-test: a form that submits on Enter is caught (statically and by pressing Enter)", imp);
  const clean = await run("clean");
  drill.check(!clean.unsafe.length && !clean.implicit.length && !clean.revealed.length && !clean.writes.length && !clean.moved.length, "self-test: a GET search and a gated save pass", clean);
  const gatedForm = await run("gated-form");
  drill.check(!gatedForm.implicit.length && !gatedForm.writes.length, "self-test: a form whose default submit is gated does not submit on Enter", gatedForm);
  const navRead = await run("nav-read");
  drill.check(navRead.reads === 1 && navRead.writes.length === 0, "self-test: a read link to a page that POSTs on load passes (that page's request is not this page's)", navRead);
  const leave = await run("post-then-leave");
  drill.check(leave.writes.some((x) => x.startsWith("POST")), "self-test: a control that POSTs before navigating away is caught", leave);
  for (const [name, how] of [["referrer-origin", "with referrerPolicy origin"], ["custom-referrer", "with a custom referrer"], ["worker", "from a Web Worker"], ["blank-form", "through a target=_blank form"], ["window-open", "from a window.open tab"]]) {
    const f = await run(name);
    drill.check(f.writes.some((x) => x.startsWith("POST")), `self-test: a POST ${how} is caught`, f);
  }
  const portal = await run("radix-portal");
  drill.check(portal.revealed.length === 2 && portal.revealed.some((x) => x.includes("Delete store")) && portal.revealed.some((x) => x.includes('span "x"')), "self-test: in a Radix portal a real button (and a focus guard with text) is caught; the empty focus guards are not", portal.revealed);
  drill.check(gatedForm.revealed.length === 0 && (await (async () => { await page.goto(`${ORIGIN}${SELFTEST}/gated-form`); return (await page.evaluate(strayControls, [CONTROLS, true])).length; })()) === 1, "self-test: its editable field is still a stray control for support", gatedForm);
  await page.close();
}

// In the page: an old route's content sits in main > [data-legacy]; a new-UI
// route's sits in main directly, and the only [data-legacy] regions left are
// the notices' own.
function regionOk(newUi) {
  const main = document.querySelector("main");
  if (!newUi) {
    const el = document.querySelector("main > [data-legacy]");
    return el ? el.children.length > 0 && (el.textContent || "").trim().length > 0 : false;
  }
  const strays = [...main.querySelectorAll("[data-legacy]")].filter((el) => !el.querySelector("[data-console-notices]"));
  return strays.length === 0 && (main.textContent || "").trim().length > 0;
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
  // sign-in goes to /admin, which sends a closed store to its onboarding (Phase 1 line 3)
  await page.waitForURL(/\/admin\/onboarding$/, { timeout: 60_000 });
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
    const newUi = isNewUiRoute(href);
    const legacy = await page.evaluate(regionOk, newUi);
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
    check(r?.status() === 200 && !ERROR_TEXT.test(body) && legacy && JSON.stringify(current) === JSON.stringify([href]), `${href} opens (200, no error, ${newUi ? "new UI: content in main, no [data-legacy] but the notices'" : "content in [data-legacy]"}, aria-current)`, { status: r?.status(), error: ERROR_TEXT.test(body), legacy, current });
    if (role === "support" && width === 1280) {
      const stray = await page.evaluate(strayControls, [CONTROLS, newUi]);
      check(stray.length === 0, `${href}: ${newUi ? "anywhere" : "outside [data-legacy]"} only nav links and shell controls`, stray);
      if (newUi) {
        // each variant of the page (a query that changes what it shows) gets its own pass
        for (const v of NEW_UI_VARIANTS[href] ?? [href]) checkNewUi(check, v, await supportNewUiControls(page, v));
        await page.goto(ORIGIN + href, { waitUntil: "load" });
        await settle(page);
      }
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
const PLATFORM_CONSOLE = /New store|Tenant registry|Provision/;

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
    const legacy = await page.evaluate(regionOk, isNewUiRoute(href));
    // onboarding is new UI in its own shell (no [data-legacy]): its step panel is the content
    const content = href === ONBOARDING ? (await onboardingShell(page)).panel : legacy;
    drill.check(r?.status() === 200 && !ERROR_TEXT.test(body) && content, `support on the empty Roles Annex: ${href} renders (200, no error, content)`, { status: r?.status(), error: ERROR_TEXT.test(body), legacy, content, url: page.url() });
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

// Phase 1 least-trusted audit (docs/cms-reviews/PHASE-1-AUDIT.md), browser pass.
// Support: every onboarding step opens read-only (no enabled write, no Shopify
// address on the page); the Phase 1 write APIs and the founder's Shopify
// callback refuse it; the operator's onboarding and New store screens are the
// operator sign-in. Anonymous: the handoff and accept-invite routes refuse a
// made-up token with their generic words, the Shopify callback is 401, the
// operator onboarding APIs are 401, and signup on a store host is 404.
const STEPS = ["connect", "import", "brand", "open"];
const OPERATOR_PAGES = ["/platform/onboarding", "/platform/stores/new"];

async function operatorPagesClosed(drill, page, who) {
  for (const path of OPERATOR_PAGES) {
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    await settle(page);
    const body = await page.locator("body").innerText().catch(() => "");
    drill.check(new URL(page.url()).pathname === "/platform" && !/Signups & onboarding|Create store/.test(body) && ((await page.locator("#pl-password").count()) === 1 || /Not configured/.test(body)), `${who} at ${path}: sent to the operator sign-in, never the screen`, { url: page.url(), body: body.slice(0, 160) });
  }
}

async function phase1Support(drill, page) {
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  for (const step of STEPS) {
    const r = await page.goto(`${ORIGIN}${ONBOARDING}?step=${step}`, { waitUntil: "load" });
    await settle(page);
    const body = await page.locator("body").innerText().catch(() => "");
    const ob = await onboardingShell(page);
    drill.check(r?.status() === 200 && !ERROR_TEXT.test(body) && ob.step === step && ob.enabledWrites.length === 0 && !/[a-z0-9-]+\.myshopify\.com/i.test(body), `support at onboarding step ${step}: read-only, no enabled write, no Shopify address`, { status: r?.status(), ...ob });
  }
  const api = (method, path, data) => page.request.fetch(`${ORIGIN}/api/admin/${path}`, { method, data, headers: { origin: ORIGIN }, maxRedirects: 0 }).then((x) => x.status());
  const refusals = {
    "POST shopify/connect": await api("POST", "shopify/connect", { shop: "audit-probe.myshopify.com" }),
    "GET shopify/callback": await api("GET", "shopify/callback?state=x&code=y&shop=audit-probe.myshopify.com"),
    "POST brand-step": await api("POST", "brand-step", { paletteId: "x" }),
    "POST policy-start": await api("POST", "policy-start", { kind: "privacy" }),
    "POST first-run": await api("POST", "first-run", {}),
    "POST sync": await api("POST", "sync", {}),
    "PUT settings identity": await api("PUT", "settings", { identity: { support_email: "audit@probe.test" } }),
    "DELETE media": await api("DELETE", "media", { id: "med_missing" }),
  };
  drill.check(Object.values(refusals).every((x) => x === 403), "support: Connect, the Shopify callback, brand, policy start, starter store, import, the contact form and media delete answer 403", refusals);
  await operatorPagesClosed(drill, page, "support");
}

async function phase1Anonymous(drill, ctx) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  const req = (method, url, data) => ctx.request.fetch(url, { method, data, headers: { origin: new URL(url).origin }, maxRedirects: 0 });
  const handoff = await req("POST", `${ORIGIN}/api/admin/handoff`, { token: "ab".repeat(16) });
  const handoffBody = await handoff.json().catch(() => ({}));
  drill.check(handoff.status() === 400 && /expired or was already used/.test(handoffBody.error || "") && !handoff.headers()["set-cookie"], "anonymous: a made-up handoff token is 400 with the generic words and no session", { status: handoff.status(), body: handoffBody });
  const peek = await req("GET", `${ORIGIN}/api/admin/accept-invite?token=${"cd".repeat(16)}`);
  drill.check(peek.status() === 400, "anonymous: a made-up invite token's peek is 400", peek.status());
  await page.goto(`${ORIGIN}/admin/accept-invite?token=${"cd".repeat(16)}`, { waitUntil: "load" });
  await settle(page);
  const inviteBody = await page.locator("body").innerText().catch(() => "");
  drill.check(/invalid, expired, or already used/.test(inviteBody) && !ERROR_TEXT.test(inviteBody), "anonymous: the accept page with a made-up token says the invitation is invalid, no error", inviteBody.slice(0, 200));
  const cb = await req("GET", `${ORIGIN}/api/admin/shopify/callback?state=x&code=y&shop=audit-probe.myshopify.com`);
  drill.check(cb.status() === 401, "anonymous: the founder's Shopify callback is 401", cb.status());
  const ops = { onboarding: (await req("GET", `${ORIGIN}/api/platform/onboarding`)).status(), stores: (await req("GET", `${ORIGIN}/api/platform/stores?check=1`)).status(), "onboarding POST": (await req("POST", `${ORIGIN}/api/platform/onboarding`, { action: "note", subject: "tenant:x", text: "hi" })).status() };
  drill.check(Object.values(ops).every((x) => x === 401), "anonymous: the operator onboarding and New store APIs are 401", ops);
  const signup = { page: (await page.goto(`${ORIGIN}/signup`, { waitUntil: "load" }))?.status(), api: (await req("POST", `${ORIGIN}/api/signup`, { name: "A", email: "a@probe.test", password: "x", storeName: "A" })).status(), status: (await req("POST", `${ORIGIN}/api/signup/status`, {})).status() };
  drill.check(signup.page === 404 && signup.api === 404 && signup.status === 404, "anonymous: signup's page and APIs on a store host are 404", signup);
  await operatorPagesClosed(drill, page, "anonymous");
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
  await supportSelfTest(drill, pages.support.context());
  await supportMenus(drill, pages.support);
  await supportDeepLinks(drill, pages.support);
  const annexCtx = await drill.browser.newContext({ viewport: { width: 1280, height: HEIGHT }, deviceScaleFactor: 1 });
  annexCtx.setDefaultTimeout(60_000);
  await supportEmptyStates(drill, annexCtx, s.members.find((x) => x.role === "support"));
  const anonCtx = await drill.browser.newContext({ viewport: { width: 1280, height: HEIGHT }, deviceScaleFactor: 1 });
  anonCtx.setDefaultTimeout(60_000);
  await anonymousPass(drill, anonCtx);
  await phase1Support(drill, pages.support);
  await phase1Anonymous(drill, anonCtx);
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
