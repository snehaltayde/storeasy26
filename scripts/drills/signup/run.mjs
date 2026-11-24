// SIGNUP: `pnpm drill:signup`, self-serve signup in a real browser (Phase 1
// line 1, docs/plans/phase-1.md "Line 1" §5 item 16). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree, after it seeds the
// --p3 design store; this starts the harness (storeasy.localhost is its
// marketing host, new stores get <slug>.localhost). Never in the owner's
// checkout (runDrill refuses).
//
// Line 2 (Phase 1): the store's database is made through the harness's
// stand-in for Turso's Platform API (scripts/support/fake-turso-api.js), each
// store on its own sqld, so the new storefront renders too.
// Steps:
//   1. flag off: /signup says signups are closed and links to /contact
//   2. flag ff_self-signup on (the control plane, then waits until the API answers)
//   3. pricing's "Get started" goes to /signup
//   4. an empty submit: an error under each field
//   5. the form: the address follows the store name; submit → the code screen
//      with the email and a resend countdown that counts down
//   6. the stand-in answers 503 to the first two "create database" calls; the
//      code (read from the mock mail row) → "Setting up your store…" with the
//      four steps (aria-live) and the retry note → done, one database made →
//      <slug>.localhost/admin/onboarding: the shell's
//      top bar, no sidebar, a 640px column with the step list to its left,
//      "Welcome to …", the address, the Closed badge, the verified email, and
//      the four steps opened on Connect Shopify (To do, the address field; Import waits for it);
//      the handoff fragment is gone from the address and the history
//   7. Sign out → /admin/login; sign in again with the same email and password
//   8. the same email again (a new browser): the same code screen, no new code
//      mailed; a wrong code gets the generic words
//   9. a used or made-up handoff token: "This sign-in link didn't work"
//  10. anonymous /admin/onboarding → /admin/login; /signup on the store host → 404
//  11. the new store's storefront (<slug>.localhost/) says "Opening soon"
//  12. a second founder while the stand-in answers 402: the needs-operator
//      words and Try again; the fault cleared, Try again → done, the same run
//      and one database
// Results: docs/cms-reviews/drills/SIGNUP/results-main.json and screenshots.
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";
import { latestSignupCode } from "../../support/signup-mail.js";
import { CODE_FAILED } from "../../../lib/platform/signup.js";
import { NEEDS_US_WORDS } from "../../../lib/platform/signup-provision.js";
import { WORDS as STEP_WORDS } from "../../../lib/onboarding/steps.js";

const DRILL_ID = "SIGNUP";
const STORE_NAME = "Drill Signup Shop";
const SLUG = "drill-signup-shop";
const EMAIL = "founder@signup-drill.test";
const PASSWORD = "drill-signup-pass-1";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;

const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const SITE = `http://storeasy.localhost:${ports.next}`;
const STORE = `http://${SLUG}.localhost:${ports.next}`;
const SLUG2 = "drill-second-founder";
const EMAIL2 = "second@signup-drill.test";
const STORE2 = `http://${SLUG2}.localhost:${ports.next}`;
// the harness's stand-in for Turso's Platform API (loopback only)
const FAKE = `http://127.0.0.1:${ports.turso}`;
const dbName = (slug) => `storeasy-t-${slug}`;

async function fake(method, path, body) {
  const r = await fetch(`${FAKE}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
}
// the "create database" calls the stand-in answered, in order: [status]
const createStatuses = async () => ((await fake("GET", "/_fake/log")).log || []).filter((e) => e.route === "create").map((e) => e.status);
const fakeDatabases = async () => (await fake("GET", "/_fake/log")).databases || [];
const at = (origin, path) => new URL(path, origin).href;
const text = (page) => page.locator("body").innerText().catch(() => "");

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

// a real signal: poll until fn() is truthy or the time is up
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
  return { ctx, page: await ctx.newPage() };
}

async function fillForm(page, { name, email, password, storeName }) {
  await page.locator("#signup-name").fill(name);
  await page.locator("#signup-email").fill(email);
  await page.locator("#signup-password").fill(password);
  await page.locator("#signup-store").fill(storeName);
}

async function signInForm(drill, page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await page.goto(at(STORE, "/admin/login"), { waitUntil: "load" });
    const shown = await page.locator("#login-email").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const flaky = !shown || res?.status() === 404 || /1 Issue/.test(await text(page));
    if (!flaky) break;
    if (attempt === 2) throw new Error(`the sign-in form did not show twice in a row (status ${res?.status()}): a real fault`);
    drill.note(`known flake: the sign-in form did not show (status ${res?.status()}); reloading once`);
  }
  await page.locator("#login-email").fill(EMAIL);
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return page.waitForURL((u) => u.pathname.startsWith("/admin") && u.pathname !== "/admin/login", { timeout: 60_000 }).then(() => true, () => false);
}

async function signup(drill) {
  await startOwned();

  // 1. closed while the flag is off
  {
    const { ctx, page } = await newPage(drill);
    const r = await page.goto(at(SITE, "/signup"), { waitUntil: "load" });
    await settle(page);
    const body = await text(page);
    drill.check(r?.status() === 200 && /Signups are closed right now/.test(body) && (await page.locator('[data-signup="closed"] a[href="/contact"]').count()) === 1, "flag off: /signup says signups are closed and links to /contact", { status: r?.status(), body: body.slice(0, 200) });
    await drill.screenshot(page, "01-closed");
    await ctx.close();
  }

  // 2. the kill switch on
  await platformSql([
    {
      sql: `INSERT INTO feature_flags (key, description, default_on, tenants, critical, expires_at, updated_at, updated_by)
            VALUES (?, ?, 1, '{}', 0, NULL, ?, 'drill:signup')
            ON CONFLICT(key) DO UPDATE SET default_on = 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: ["ff_self-signup", "self-serve signup (drill)", new Date().toISOString()],
    },
  ]);
  const t0 = Date.now();
  // the API route, the /signup page and pricing each read the flag through
  // their own cached copy (up to 30 s): wait for all three
  const open = await until(async () => {
    const api = (await fetch(at(SITE, "/api/signup?storeName=probe")).then((r) => r.status)) === 200;
    const form = (await fetch(at(SITE, "/signup")).then((r) => r.text())).includes('data-signup="form"');
    const pricing = (await fetch(at(SITE, "/pricing")).then((r) => r.text())).includes('href="/signup"');
    return api && form && pricing;
  }, 90_000, 1000);
  drill.check(Boolean(open), "flag on: the signup API, the /signup page and pricing open (the flag cache expires)", { seconds: Math.round((Date.now() - t0) / 1000) });

  // 3. pricing → /signup
  {
    const { ctx, page } = await newPage(drill);
    await page.goto(at(SITE, "/pricing"), { waitUntil: "load" });
    await settle(page);
    const hrefs = await page.getByRole("link", { name: "Get started" }).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    drill.check(hrefs.length > 0 && hrefs.every((h) => h === "/signup"), "pricing: every \"Get started\" goes to /signup", hrefs);
    await ctx.close();
  }

  // 4–6. the founder signs up
  const { ctx, page } = await newPage(drill);
  await page.goto(at(SITE, "/signup"), { waitUntil: "load" });
  await page.locator('[data-signup="form"]').waitFor();
  await page.getByRole("button", { name: "Email me a code" }).click();
  await until(async () => (await page.locator("[data-field-error]").count()) >= 4, 30_000);
  const fieldErrors = await page.locator("[data-field-error]").evaluateAll((els) => els.map((e) => e.getAttribute("data-field-error")));
  drill.check(["signup-name", "signup-email", "signup-password", "signup-store"].every((f) => fieldErrors.includes(f)), "an empty submit: an error under each field", fieldErrors);
  const focused = await page.evaluate(() => document.activeElement?.id);
  drill.check(focused === "signup-name", "focus moves to the first field to fix", focused);
  const pwDescribed = (await page.locator("#signup-password").getAttribute("aria-describedby")) || "";
  drill.check(pwDescribed.includes("signup-password-error") && pwDescribed.includes("signup-password-hint"), "the password's error and its rules are both tied to it (aria-describedby)", pwDescribed);
  await drill.screenshot(page, "02-field-errors");

  await fillForm(page, { name: "Drill Founder", email: EMAIL, password: PASSWORD, storeName: STORE_NAME });
  const shownSlug = await until(async () => ((await page.locator("#signup-slug").inputValue()) === SLUG ? SLUG : null), 30_000);
  const hint = await page.locator("#signup-slug-hint").innerText().catch(() => "");
  drill.check(shownSlug === SLUG && hint.includes(`${SLUG}.localhost`), "the address follows the store name and shows the full address", { shownSlug, hint });
  drill.check((await page.locator("#signup-name").inputValue()) === "Drill Founder", "nothing typed was lost after the errors", null);
  await drill.screenshot(page, "03-form");
  // show / hide the password, by keyboard
  await page.locator("#signup-password").focus();
  await page.keyboard.press("Tab");
  const toggle = await page.evaluate(() => document.activeElement?.getAttribute("aria-controls"));
  await page.keyboard.press("Enter");
  const shown = await page.locator("#signup-password").getAttribute("type");
  await page.keyboard.press("Enter");
  const hidden = await page.locator("#signup-password").getAttribute("type");
  drill.check(toggle === "signup-password" && shown === "text" && hidden === "password", "Tab reaches Show password; Enter shows and hides it", { toggle, shown, hidden });
  for (const [width, name] of [[375, "03b-form-375"], [1680, "03c-form-wide"]]) {
    const v = await newPage(drill, width);
    await v.page.goto(at(SITE, "/signup"), { waitUntil: "load" });
    await v.page.locator('[data-signup="form"]').waitFor();
    await fillForm(v.page, { name: "Drill Founder", email: "view@signup-drill.test", password: "short", storeName: "A Rather Long Store Name For Wrapping" });
    await until(async () => (await v.page.locator("#signup-slug").inputValue()) === "a-rather-long-store-name-for-wrapping", 30_000);
    await until(async () => !/Checking/.test(await v.page.locator("#signup-slug-hint").innerText()), 10_000);
    const fits = await v.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    drill.check(fits, `${width}px: the form has no sideways scroll`, null);
    await drill.screenshot(v.page, name);
    await v.ctx.close();
  }
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.locator('[data-signup="code"]').waitFor();
  const codeBody = await text(page);
  drill.check(codeBody.includes("Check your email") && codeBody.includes(EMAIL), "the code screen names the email", codeBody.slice(0, 200));
  const n1 = Number((await page.locator("[data-signup-countdown]").innerText().catch(() => "")).match(/(\d+)/)?.[1]);
  await new Promise((r) => setTimeout(r, 2500));
  const n2 = Number((await page.locator("[data-signup-countdown]").innerText().catch(() => "")).match(/(\d+)/)?.[1]);
  drill.check(n1 > 0 && n2 < n1 && (await page.locator("[data-signup-resend]").isDisabled()), "the resend countdown counts down and the button waits", { n1, n2 });
  const codeFocus = await page.evaluate(() => ({ id: document.activeElement?.id, mode: document.activeElement?.inputMode, ac: document.activeElement?.autocomplete }));
  drill.check(codeFocus.id === "signup-code" && codeFocus.mode === "numeric" && codeFocus.ac === "one-time-code", "the code field takes focus, numeric keypad, one-time-code autofill", codeFocus);
  await drill.screenshot(page, "04-code");

  const mail = await until(() => latestSignupCode({ platformUrl, email: EMAIL }), 30_000);
  drill.check(Boolean(mail?.code), "a code was mailed (the mock mail row)", mail ? { id: mail.id } : null);
  await page.locator("#signup-code").fill(mail?.code || "");
  // the hosting provider is slow: the first two "create database" calls answer 503
  const before = (await createStatuses()).length;
  await fake("DELETE", "/_fake/faults");
  await fake("POST", "/_fake/faults", { route: "create", status: 503, times: 2 });
  const t6 = Date.now();
  await page.getByRole("button", { name: "Verify and create my store" }).click();
  const working = await page.locator('[data-signup="working"]').waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const labels = await page.locator("[data-signup-steps] li").allInnerTexts().catch(() => []);
  drill.check(working && labels.length === 4 && labels[0].includes("Creating your store's database") && labels[3].includes("Creating your account"), "verify answers at once: \"Setting up your store…\" with the four steps", labels);
  const live = await page.locator('[data-signup="working"] [aria-live="polite"]').count();
  drill.check(live === 1, "the steps' progress is announced (one aria-live area)", live);
  const noteText = await until(async () => {
    const t = await page.locator("[data-signup-note]").innerText();
    return /slow to answer/.test(t) ? t : null;
  }, 40_000, 300);
  drill.check(Boolean(noteText) && /Trying again in \d+ (second|minute)s? \(try \d of 5\)/.test(noteText), "the retry note: the provider is slow, when the next try is, which try", noteText);
  if (noteText) await drill.screenshot(page, "05a-working-retry");
  const landed = await page.waitForURL((u) => u.host === new URL(STORE).host && u.pathname === "/admin/onboarding", { timeout: 180_000 }).then(() => true, () => false);
  drill.check(landed, `after the retries: done, and on to ${SLUG}.localhost /admin/onboarding`, { url: page.url(), seconds: Math.round((Date.now() - t6) / 1000) });
  const tries = (await createStatuses()).slice(before);
  drill.check(tries.length === 3 && tries[0] === 503 && tries[1] === 503 && tries[2] === 200, "the stand-in saw two 503s, then one database made", tries);
  drill.check((await fakeDatabases()).filter((d) => d === dbName(SLUG)).length === 1, `one database: ${dbName(SLUG)}`, await fakeDatabases());
  await settle(page);
  const welcome = await text(page);
  drill.check(!ERROR_TEXT.test(welcome) && welcome.includes(`Welcome to ${STORE_NAME}`), "the Welcome page names the store", welcome.slice(0, 300));
  drill.check((await page.locator('[data-onboarding="address"]').innerText().catch(() => "")) === `${SLUG}.localhost`, "the store's address", null);
  drill.check((await page.locator('[data-onboarding="status"]').innerText().catch(() => "")).trim().toLowerCase() === "closed" && welcome.includes("Opening soon"), "the Closed badge and \"Opening soon\"", null);
  drill.check((await page.locator('[data-onboarding="email"]').innerText().catch(() => "")).includes(EMAIL) && welcome.includes("email verified"), "the verified email", null);
  const steps = await page.evaluate(() => ({
    panel: document.querySelector('[data-onboarding="panel"]')?.getAttribute("data-step") || null,
    states: Object.fromEntries([...document.querySelectorAll('[data-onboarding="steplist"] button[data-step]')].map((b) => [b.getAttribute("data-step"), b.getAttribute("data-state")])),
    words: (document.querySelector('[data-onboarding="words"]')?.innerText || "").trim(),
    shopField: Boolean(document.querySelector('[data-onboarding="panel"] [data-onboarding="shop-input"]')),
  }));
  // Phase 1 line 4: the founder enters the shop's address and connects from step 1
  drill.check(steps.panel === "connect" && steps.states.connect === "ready" && steps.states.import === "blocked" && Object.keys(steps.states).join(",") === "connect,import,brand,open" && steps.words === STEP_WORDS.connect.ready && steps.shopField, "the four steps, opened on Connect Shopify (To do: enter the shop's address); Import waits for it", steps);
  const bar = await page.locator('[data-shell="topbar"]').boundingBox();
  const col = await page.locator('[data-onboarding="column"]').boundingBox();
  const list = await page.locator('[data-onboarding="steplist"]').boundingBox();
  const sidebar = await page.locator('[data-slot="sidebar-container"]').count();
  drill.check(bar && Math.round(bar.height) === 56 && sidebar === 0 && col && col.width <= 640 && col.width >= 600 && list && list.x + list.width <= col.x, "the shell's 56px top bar, no sidebar, one column of at most 640px with the step list to its left", { bar: bar?.height, sidebar, col: col?.width, list });
  const where = await page.evaluate(() => ({ hash: location.hash, back: history.length }));
  drill.check(where.hash === "", "the handoff token is gone from the address", where);
  await drill.screenshot(page, "05-welcome");
  const narrow = await newPage(drill, 375);
  await narrow.ctx.addCookies(await ctx.cookies(STORE));
  await narrow.page.goto(at(STORE, "/admin/onboarding"), { waitUntil: "load" });
  await settle(narrow.page);
  const wide = await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const compact = await narrow.page.locator('[data-onboarding="steplist-compact"]').isVisible().catch(() => false);
  drill.check(wide && compact, "375px: the compact step list above the step, no sideways scroll", { wide, compact });
  await drill.screenshot(narrow.page, "06-welcome-375");
  await narrow.ctx.close();

  // 7. sign out, sign in again
  await page.locator('[data-shell-control="account"]').click();
  await page.locator('[data-account="sign-out"]').click();
  const out = await page.waitForURL((u) => u.pathname === "/admin/login", { timeout: 60_000 }).then(() => true, () => false);
  drill.check(out, "Sign out lands on /admin/login", page.url());
  const back = await signInForm(drill, page);
  drill.check(back, "the same email and password sign in again on the store's own /admin/login", page.url());
  const r7 = await page.goto(at(STORE, "/admin/onboarding"), { waitUntil: "load" });
  await settle(page);
  drill.check(r7?.status() === 200 && (await text(page)).includes(`Welcome to ${STORE_NAME}`), "signed in again: /admin/onboarding reads", r7?.status());
  const dash = await page.goto(at(STORE, "/admin/dashboard"), { waitUntil: "load" });
  await settle(page);
  drill.check(dash?.status() === 200 && !ERROR_TEXT.test(await text(page)), "the dashboard of a store with no Shopify connection renders", dash?.status());
  await ctx.close();

  // 8. the same email again, in a new browser: the same screen, no code; a wrong code
  {
    const { ctx: c2, page: p2 } = await newPage(drill, 375);
    await p2.goto(at(SITE, "/signup"), { waitUntil: "load" });
    await p2.locator('[data-signup="form"]').waitFor();
    await fillForm(p2, { name: "Someone Else", email: EMAIL, password: "another-pass-22", storeName: "Drill Second Shop" });
    await until(async () => (await p2.locator("#signup-slug").inputValue()) === "drill-second-shop", 30_000);
    await p2.getByRole("button", { name: "Email me a code" }).click();
    await p2.locator('[data-signup="code"]').waitFor();
    const again = await text(p2);
    drill.check(again.includes("Check your email") && again.includes(EMAIL), "an existing email gets the same code screen", again.slice(0, 200));
    await new Promise((r) => setTimeout(r, 1500));
    const latest = await latestSignupCode({ platformUrl, email: EMAIL });
    drill.check(latest?.id === mail?.id, "and no new code is mailed for it", { before: mail?.id, after: latest?.id });
    // a pasted code with words and spaces around it keeps only its 6 digits; Enter submits
    await p2.locator("#signup-code").focus();
    await p2.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "Your code: 000 000");
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    drill.check((await p2.locator("#signup-code").inputValue()) === "000000", "pasting \"Your code: 000 000\" fills 000000", null);
    await p2.keyboard.press("Enter");
    const err = await until(async () => p2.locator("#signup-code-error").innerText(), 30_000);
    drill.check(err === CODE_FAILED, "a wrong code gets the generic words", err);
    drill.check((await p2.locator("#signup-code").inputValue()) === "000000", "the typed code stays", null);
    await drill.screenshot(p2, "07-wrong-code");
    await c2.close();
  }

  // 9. a made-up handoff token
  {
    const { ctx: c3, page: p3 } = await newPage(drill);
    await p3.goto(`${at(STORE, "/admin/handoff")}#t=${"0".repeat(64)}`, { waitUntil: "load" });
    const refused = await p3.locator('[data-handoff="refused"]').waitFor({ timeout: 60_000 }).then(() => true, () => false);
    const body = await text(p3);
    drill.check(refused && body.includes("This sign-in link didn't work") && (await p3.locator('a[href="/admin/login"]').count()) >= 1, "a made-up handoff token: refused, with the way to sign in", body.slice(0, 200));
    drill.check((await p3.evaluate(() => location.hash)) === "", "the refused token is cleared from the address too", null);
    await drill.screenshot(p3, "08-handoff-refused");

    // 10. anonymous on the new store, and /signup on a store host
    await p3.goto(at(STORE, "/admin/onboarding"), { waitUntil: "load" });
    drill.check(new URL(p3.url()).pathname === "/admin/login", "anonymous /admin/onboarding goes to /admin/login", p3.url());
    const r404 = await p3.goto(at(STORE, "/signup"), { waitUntil: "load" });
    drill.check(r404?.status() === 404, "/signup on a store host is 404", r404?.status());
    const api404 = await fetch(at(STORE, "/api/signup?storeName=x")).then((r) => r.status);
    drill.check(api404 === 404, "/api/signup on a store host is 404", api404);
    await c3.close();
  }

  // 11. the new store's storefront renders from its own database: closed, "Opening soon"
  {
    const { ctx: c4, page: p4 } = await newPage(drill);
    const r = await p4.goto(at(STORE, "/"), { waitUntil: "load" });
    await settle(p4);
    const body = await text(p4);
    drill.check(!ERROR_TEXT.test(body) && body.includes("Opening soon"), `the storefront at ${SLUG}.localhost says "Opening soon"`, { status: r?.status(), body: body.slice(0, 200) });
    await drill.screenshot(p4, "09-storefront-opening-soon");
    await c4.close();
  }

  // 12. a second founder while the provider refuses (402, a plan limit): it needs us
  {
    const { ctx: c5, page: p5 } = await newPage(drill);
    await p5.goto(at(SITE, "/signup"), { waitUntil: "load" });
    await p5.locator('[data-signup="form"]').waitFor();
    await fillForm(p5, { name: "Second Founder", email: EMAIL2, password: "second-founder-pass", storeName: "Drill Second Founder" });
    await until(async () => (await p5.locator("#signup-slug").inputValue()) === SLUG2, 30_000);
    await p5.getByRole("button", { name: "Email me a code" }).click();
    await p5.locator('[data-signup="code"]').waitFor();
    const mail2 = await until(() => latestSignupCode({ platformUrl, email: EMAIL2 }), 30_000);
    await p5.locator("#signup-code").fill(mail2?.code || "");
    const before2 = (await createStatuses()).length;
    await fake("DELETE", "/_fake/faults");
    await fake("POST", "/_fake/faults", { route: "create", status: 402, times: 5 });
    await p5.getByRole("button", { name: "Verify and create my store" }).click();
    const failed = await p5.locator('[data-signup="failed"][data-failure-kind="needs_operator"]').waitFor({ timeout: 90_000 }).then(() => true, () => false);
    const words = await p5.locator('[data-signup="failed"] [role="alert"]').innerText().catch(() => "");
    drill.check(failed && words === NEEDS_US_WORDS, "402 from the provider: the needs-operator words", words);
    drill.check((await p5.getByRole("button", { name: "Try again" }).count()) === 1, "and Try again is offered", null);
    const stopped = await p5.locator('[data-signup-steps] li[data-step-state="failed"]').allInnerTexts().catch(() => []);
    drill.check(stopped.length === 1 && stopped[0].includes("Creating your store's database"), "the step it stopped at is marked", stopped);
    const asked = (await createStatuses()).slice(before2);
    drill.check(asked.length === 1 && asked[0] === 402, "a 402 is not retried on its own (one call)", asked);
    await drill.screenshot(p5, "10-needs-operator");
    // fixed on our side: the founder presses Try again
    await fake("DELETE", "/_fake/faults");
    await p5.getByRole("button", { name: "Try again" }).click();
    const landed2 = await p5.waitForURL((u) => u.host === new URL(STORE2).host && u.pathname === "/admin/onboarding", { timeout: 180_000 }).then(() => true, () => false);
    drill.check(landed2, `fault cleared, Try again → done, on to ${SLUG2}.localhost /admin/onboarding`, p5.url());
    await settle(p5);
    drill.check((await text(p5)).includes("Welcome to Drill Second Founder"), "the second store's Welcome page", null);
    const all2 = (await createStatuses()).slice(before2);
    drill.check(all2.length === 2 && all2[1] === 200 && (await fakeDatabases()).filter((d) => d === dbName(SLUG2)).length === 1, `the same run made one database: ${dbName(SLUG2)}`, { all2, databases: await fakeDatabases() });
    await c5.close();
  }
}

runDrill({ id: DRILL_ID, part: "main", title: "SIGNUP — a founder signs up on their own" }, signup).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
