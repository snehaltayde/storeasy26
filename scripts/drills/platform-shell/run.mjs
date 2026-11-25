// PLATFORM-SHELL: `pnpm drill:platform-shell`, the operator sign-in and shell
// (Phase 3 line 0, docs/plans/phase-3.md "Line 0"). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree after it seeds the
// --p3 design store; this starts the harness. Never in the owner's checkout.
// Steps:
//   1. signed out: /platform is the sign-in on the new UI (no shell, no nav);
//      /platform/onboarding and /platform/stores/new go to /platform; a wrong
//      password gets plain words
//   2. a merchant's session token put in _platform: the same sign-in, no shell
//   3. a new operator signs in for the first time: email and password show the
//      authenticator key once, with Copy; the drill computes the real code from
//      that key and types it; the shell opens (nav, name and email in the
//      account menu), the old /platform console inside it
//   4. the nav goes to Signups & onboarding and New store, marking each active
//   5. at 375 the nav is a sheet the top bar's toggle opens
//   6. Sign out revokes the session and leaves the sign-in, no shell
// Results: docs/cms-reviews/drills/PLATFORM-SHELL/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";

const DRILL_ID = "PLATFORM-SHELL";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const CONSOLE = `http://localhost:${ports.next}`;
const at = (path) => new URL(path, CONSOLE).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SHELL = '[data-shell="platform"]';

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

async function until(fn, ms = 30_000, step = 250) {
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

// the sign-in, on the new UI, and nothing of the console
async function checkSignIn(drill, page, who) {
  await page.locator("#pl-password").waitFor();
  const body = await text(page);
  drill.check((await page.locator("#pl-email").count()) === 1 && (await page.locator("#pl-totp").count()) === 1, `${who}: the sign-in has the email, password and code fields`, null);
  drill.check((await page.locator(SHELL).count()) === 0 && (await page.locator('[data-nav-item]').count()) === 0, `${who}: no shell and no nav`, null);
  drill.check(!/Signups & onboarding|Tenant registry|Sign out/.test(body), `${who}: no console words`, body.slice(0, 200));
  drill.check((await page.locator('[data-platform="sign-in"] [data-legacy]').count()) === 0 && (await page.locator("[data-legacy] #pl-email").count()) === 0, `${who}: the sign-in is new UI, outside any [data-legacy] region`, null);
}

async function platformShell(drill) {
  await startOwned();
  const { totpCode, hashPassword } = await import("../../../lib/platform/identity.js");

  // a new operator, not yet enrolled in TOTP (as `pnpm operator:create` makes one)
  const id = `u_${randomBytes(8).toString("hex")}`;
  const email = `operator-${id}@platform-shell.test`;
  const password = `shell-pass-${randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  await platformSql([{ sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Asha Rao', ?, 1, 0, 'active', ?, ?)", args: [id, email, await hashPassword(password), now, now] }]);

  // 1. signed out
  {
    const { ctx, page } = await newPage(drill);
    const res = await page.goto(at("/platform"), { waitUntil: "load" });
    drill.check(res?.status() === 200, "signed out: /platform answers 200", res?.status());
    await checkSignIn(drill, page, "signed out");
    await drill.screenshot(page, "01-sign-in");
    for (const path of ["/platform/onboarding", "/platform/stores/new"]) {
      await page.goto(at(path), { waitUntil: "load" });
      const moved = await until(async () => new URL(page.url()).pathname === "/platform");
      drill.check(Boolean(moved), `signed out: ${path} goes to /platform`, page.url());
      await checkSignIn(drill, page, `signed out at ${path}`);
    }
    await page.locator("#pl-email").fill(email);
    await page.locator("#pl-password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    const err = await page.locator('[data-platform="sign-in-error"]').waitFor({ timeout: 30_000 }).then(() => page.locator('[data-platform="sign-in-error"]').innerText(), () => "");
    drill.check(/don't match an operator account/.test(err) && !/Wrong email or password/.test(err), "a wrong password: plain words, not the raw server message", err);
    await drill.screenshot(page, "02-sign-in-error");
    await page.setViewportSize({ width: 375, height: 812 });
    await settle(page);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    drill.check(!sideways, "the sign-in has no sideways scroll at 375", null);
    await drill.screenshot(page, "03-sign-in-375");
    await ctx.close();
  }

  // 2. a merchant's session token in _platform
  {
    const mid = `u_${randomBytes(8).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    await platformSql([
      { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Merchant', NULL, 0, 0, 'active', ?, ?)", args: [mid, `merchant-${mid}@platform-shell.test`, now, now] },
      { sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, 'merchant', ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), mid, now, new Date(Date.now() + 3600_000).toISOString()] },
    ]);
    const { ctx, page } = await newPage(drill);
    await ctx.addCookies([{ name: "_platform", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    await page.goto(at("/platform"), { waitUntil: "load" });
    await checkSignIn(drill, page, "a merchant token in _platform");
    const api = await page.evaluate(async () => (await fetch("/api/platform/tenants")).status);
    drill.check(api === 401, "a merchant token in _platform: the operator API answers 401", api);
    await ctx.close();
  }

  // 3. first sign-in: the key once, then a real code
  const { ctx, page } = await newPage(drill);
  await page.goto(at("/platform"), { waitUntil: "load" });
  await page.locator("#pl-email").fill(email);
  await page.locator("#pl-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const keyBox = page.locator("#pl-totp-secret");
  await keyBox.waitFor({ timeout: 30_000 });
  const secret = (await keyBox.innerText()).trim();
  drill.check(/^[A-Z2-7]{16,}$/.test(secret), "first sign-in: the authenticator key is shown", secret.length);
  drill.check((await page.locator('[data-platform="enroll"]').getByRole("button", { name: "Copy the authenticator key" }).count()) === 1, "the key has a Copy button", null);
  drill.check(/shown again|show this key once/i.test(await text(page)), "the key is shown once, and says so", null);
  await drill.screenshot(page, "04-enroll-key");
  // a code from the start of a 30-second step, so it is still good when the server checks it
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 5_000) await new Promise((r) => setTimeout(r, left + 200));
  const code = totpCode(secret);
  await page.locator("#pl-totp").pressSequentially(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  const shell = await page.locator(SHELL).waitFor({ timeout: 60_000 }).then(() => true, () => false);
  drill.check(shell, "a real authenticator code signs in: the shell opens", (await text(page)).slice(0, 200));
  const confirmed = await one("SELECT totp_confirmed FROM users WHERE id = ?", [id]);
  drill.check(Number(confirmed?.totp_confirmed) === 1, "the first good code confirms the authenticator", confirmed);
  const session = await one("SELECT id FROM sessions WHERE user_id = ? AND kind = 'operator' AND revoked_at IS NULL", [id]);
  drill.check(Boolean(session), "an operator session row exists", null);
  await settle(page);
  const navIds = await page.locator("[data-nav-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav-item")));
  drill.check(navIds.join(",") === "stores,onboarding,new-store", "the nav: Stores, Signups & onboarding, New store", navIds);
  drill.check((await page.locator('[data-nav-item="stores"][aria-current="page"]').count()) === 1, "on /platform, Stores is the current item", null);
  drill.check((await page.locator(`${SHELL} [data-legacy]`).count()) >= 1 && !ERROR_TEXT.test(await text(page)), "the old /platform console renders in its [data-legacy] region inside the shell", null);
  await page.locator('[data-shell-control="account"]').click();
  const menu = await page.locator('[data-account="name"]').innerText().catch(() => "");
  const mail = await page.locator('[data-account="email"]').innerText().catch(() => "");
  drill.check(menu === "Asha Rao" && mail === email, "the account menu names the operator and their email", { menu, mail });
  await drill.screenshot(page, "05-shell-account");
  await page.keyboard.press("Escape");

  // 4. the nav
  for (const [item, path, marker] of [["onboarding", "/platform/onboarding", null], ["new-store", "/platform/stores/new", "#cs-email"]]) {
    await page.locator(`[data-nav-item="${item}"]`).click();
    await page.waitForURL((u) => u.pathname === path);
    if (marker) await page.locator(marker).waitFor();
    await settle(page);
    drill.check((await page.locator(`[data-nav-item="${item}"][aria-current="page"]`).count()) === 1 && (await page.locator(SHELL).count()) === 1, `the nav opens ${path} inside the shell, marked current`, null);
    drill.check(!ERROR_TEXT.test(await text(page)), `${path} renders without an error`, null);
    await drill.screenshot(page, `06-${item}`);
  }

  // 5. phones: the nav is a sheet
  await page.setViewportSize({ width: 375, height: 812 });
  await settle(page);
  drill.check(!(await page.locator("[data-nav-item]").first().isVisible().catch(() => false)), "at 375 the nav is hidden until asked for", null);
  await page.locator('[data-shell-control="toggle"]').click();
  const sheet = await page.locator('[data-nav-item="stores"]').waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
  drill.check(sheet, "at 375 the top bar's toggle opens the nav as a sheet", null);
  await drill.screenshot(page, "07-sheet-375");
  await page.locator('[data-nav-item="stores"]').click();
  await page.waitForURL((u) => u.pathname === "/platform");
  await settle(page);
  drill.check(!(await page.locator('[data-nav-item="stores"]').isVisible().catch(() => false)), "a link tapped in the sheet closes it", null);
  await page.setViewportSize({ width: 1280, height: 900 });

  // 6. sign out
  await page.locator('[data-shell-control="account"]').click();
  await page.locator('[data-account="sign-out"]').click();
  await page.waitForURL((u) => u.pathname === "/platform");
  await checkSignIn(drill, page, "after Sign out");
  const gone = await until(async () => (await one("SELECT revoked_at FROM sessions WHERE id = ?", [session?.id]))?.revoked_at);
  drill.check(Boolean(gone), "Sign out revokes the operator session", null);
  await drill.screenshot(page, "08-signed-out");
  await ctx.close();
}

runDrill({ id: DRILL_ID, part: "main", title: "PLATFORM-SHELL — the operator sign-in (with a real authenticator code) and shell" }, platformShell).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
