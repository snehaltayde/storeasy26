// OPS-ONBOARDING: `pnpm drill:operator-onboarding`, the operator's "Signups &
// onboarding" screen in a real browser (Phase 1 line 8, docs/plans/phase-1.md
// "Line 8" §5 item 16). Run by scripts/drills/run-isolated.mjs in a throwaway
// worktree after it seeds the --p3 design store; this starts the harness
// (storeasy.localhost is its marketing host, new stores get <slug>.localhost,
// the operator console is on localhost). Never in the owner's checkout.
// Steps:
//   1. a founder signs up while the Turso stand-in answers 402: the signup fails
//      "needs us"
//   2. an operator (a session row made in the harness's control plane, as the
//      suites do) opens /platform → "Signups & onboarding": the failed signup is
//      under Needs attention, with its status in words
//   3. the fault cleared, Resume provisioning in the sheet → the signup is done
//      and the store shows on step 1 (Connect Shopify) with a stuck time
//   4. Send sign-in help: a mock mail with the login address and a reset link;
//      the link sets a new password on the store host and it signs in
//   5. support access opens; the store console shows the support banner
//   6. a lapsed signup's address is freed (AlertDialog) and the signup API
//      then says the address is available
//   7. a note shows in the sheet and on the row
//   8. signed out, /platform/onboarding goes to /platform; the API answers 401
// Results: docs/cms-reviews/drills/OPS-ONBOARDING/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";
import { latestSignupCode, latestPlatformMail } from "../../support/signup-mail.js";

const DRILL_ID = "OPS-ONBOARDING";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const SITE = `http://storeasy.localhost:${ports.next}`;
const CONSOLE = `http://localhost:${ports.next}`;
const SLUG = "drill-ops-founder";
const EMAIL = "ops-founder@ops-drill.test";
const PASSWORD = "ops-founder-pass-1";
const STORE = `http://${SLUG}.localhost:${ports.next}`;
const LAPSED_SLUG = "drill-ops-lapsed";
const FAKE = `http://127.0.0.1:${ports.turso}`;

const at = (origin, path) => new URL(path, origin).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function fake(method, path, body) {
  const r = await fetch(`${FAKE}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
}

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
  return { ctx, page: await ctx.newPage() };
}

// An operator: a user with is_operator and a live operator session row (only
// its hash is stored), as the suites make one. The TOTP sign-in itself is
// covered by test-identity.
async function makeOperator() {
  const id = `u_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await platformSql([
    { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Drill Operator', NULL, 1, 1, 'active', ?, ?)", args: [id, `operator-${id}@ops-drill.test`, now.toISOString(), now.toISOString()] },
    { sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, 'operator', ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), id, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString()] },
  ]);
  return { id, token };
}

// Esc closes the sheet; the URL loses its ?s= once the router has replaced it
async function closeSheet(page) {
  if (await page.locator("[data-subject-sheet]").count()) await page.keyboard.press("Escape");
  await page.locator("[data-subject-sheet]").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await page.waitForURL((u) => !u.searchParams.has("s"), { timeout: 30_000 });
}

async function openRow(page, subject) {
  if (await page.locator(`[data-subject-sheet="${subject}"]`).count()) return;
  await closeSheet(page);
  await page.locator(`[data-subject="${subject}"] button`).first().click();
  await page.locator(`[data-subject-sheet="${subject}"]`).waitFor();
  await page.locator(`[data-subject-sheet="${subject}"] h3`, { hasText: "Help" }).waitFor({ timeout: 60_000 });
}
const sheet = (page) => page.locator("[data-subject-sheet]");
const notice = (page) => sheet(page).locator('[role="status"], [role="alert"]').first();

async function opsOnboarding(drill) {
  await startOwned();
  await platformSql([
    {
      sql: `INSERT INTO feature_flags (key, description, default_on, tenants, critical, expires_at, updated_at, updated_by)
            VALUES ('ff_self-signup', 'self-serve signup (drill)', 1, '{}', 0, NULL, ?, 'drill:operator-onboarding')
            ON CONFLICT(key) DO UPDATE SET default_on = 1, updated_at = excluded.updated_at`,
      args: [new Date().toISOString()],
    },
  ]);
  const open = await until(async () => (await fetch(at(SITE, "/signup")).then((r) => r.text())).includes('data-signup="form"'), 90_000, 1000);
  drill.check(Boolean(open), "signup is open on the marketing host", null);

  // 1. a founder signs up while the provider refuses (402)
  {
    const { ctx, page } = await newPage(drill);
    await page.goto(at(SITE, "/signup"), { waitUntil: "load" });
    await page.locator('[data-signup="form"]').waitFor();
    await page.locator("#signup-name").fill("Ops Founder");
    await page.locator("#signup-email").fill(EMAIL);
    await page.locator("#signup-password").fill(PASSWORD);
    await page.locator("#signup-store").fill("Drill Ops Founder");
    await until(async () => (await page.locator("#signup-slug").inputValue()) === SLUG, 30_000);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.locator('[data-signup="code"]').waitFor();
    const mail = await until(() => latestSignupCode({ platformUrl, email: EMAIL }), 30_000);
    await page.locator("#signup-code").fill(mail?.code || "");
    await fake("DELETE", "/_fake/faults");
    await fake("POST", "/_fake/faults", { route: "create", status: 402, times: 5 });
    await page.getByRole("button", { name: "Verify and create my store" }).click();
    const failed = await page.locator('[data-signup="failed"][data-failure-kind="needs_operator"]').waitFor({ timeout: 90_000 }).then(() => true, () => false);
    drill.check(failed, "402 from the provider: the founder's signup fails, needing us", null);
    await ctx.close();
  }
  const signup = await one("SELECT id, status, failure_kind FROM signups WHERE email = ? ORDER BY created_at DESC LIMIT 1", [EMAIL]);
  drill.check(signup?.status === "failed" && signup?.failure_kind === "needs_operator", "the signup row is failed / needs_operator", signup);

  // 2. the operator's screen
  const operator = await makeOperator();
  const { ctx, page } = await newPage(drill);
  const storeHost = new URL(STORE).hostname;
  await ctx.addCookies([
    { name: "_platform", value: operator.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
    { name: "_platform", value: operator.token, domain: storeHost, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  await page.goto(at(CONSOLE, "/platform"), { waitUntil: "load" });
  await settle(page);
  const navLink = page.getByRole("link", { name: "Signups & onboarding" });
  drill.check((await navLink.count()) === 1, "the /platform nav links to Signups & onboarding", null);
  await navLink.click();
  await page.waitForURL((u) => u.pathname === "/platform/onboarding");
  const subject = `signup:${signup.id}`;
  const row = page.locator(`[data-subject="${subject}"]`);
  const shown = await row.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  const rowText = shown ? await row.innerText() : "";
  const selected = await page.locator('[role="tab"][aria-selected="true"]').innerText().catch(() => "");
  drill.check(shown && /Needs attention/.test(selected) && /Failed: needs us/.test(rowText) && rowText.includes(EMAIL), "the failed signup is under Needs attention (the default view), with its status in words", { selected, rowText });
  drill.check(!ERROR_TEXT.test(await text(page)), "the page renders without an error", null);
  await drill.screenshot(page, "01-needs-attention");

  // 3. resume: the store is made and shows on step 1 with a stuck time
  await fake("DELETE", "/_fake/faults");
  await openRow(page, subject);
  await drill.screenshot(page, "02-signup-sheet");
  await sheet(page).getByRole("button", { name: "Resume provisioning" }).click();
  const resumedWords = await until(async () => notice(page).innerText(), 30_000);
  drill.check(/Provisioning resumed/.test(resumedWords || ""), "Resume provisioning: the sheet says it is running", resumedWords);
  const done = await until(async () => (await one("SELECT status FROM signups WHERE id = ?", [signup.id]))?.status === "done", 180_000, 1000);
  drill.check(Boolean(done), "the signup is done: its store is made", null);
  await closeSheet(page);
  await page.goto(at(CONSOLE, `/platform/onboarding?view=all&q=${SLUG}`), { waitUntil: "load" });
  const storeRow = page.locator(`[data-subject="tenant:${SLUG}"]`);
  await storeRow.waitFor({ timeout: 60_000 });
  // the first snapshot is taken by the sheet's live read (or the sweep)
  await openRow(page, `tenant:${SLUG}`);
  const steps = await sheet(page).innerText();
  drill.check(/1\. Connect Shopify/.test(steps), "the store's sheet reads its steps live: step 1, Connect Shopify", steps.slice(0, 300));
  await closeSheet(page);
  await page.reload({ waitUntil: "load" });
  await storeRow.waitFor();
  const storeText = await storeRow.innerText();
  drill.check(/Step 1 of 4/.test(storeText) && /Connect Shopify/.test(storeText) && /stuck/.test(storeText), "the store row: step 1 of 4 with a stuck time", storeText);
  drill.check((await page.locator(`[data-subject="${subject}"]`).count()) === 0, "the signup no longer has its own row once its store exists", null);
  await drill.screenshot(page, "03-store-step-1");

  // 4. sign-in help: the mail's reset link works on the store host
  await openRow(page, `tenant:${SLUG}`);
  await sheet(page).getByRole("button", { name: "Send sign-in help" }).click();
  const helpWords = await until(async () => notice(page).innerText(), 30_000);
  drill.check(new RegExp(`Sign-in help sent to ${EMAIL}`).test(helpWords || ""), "Send sign-in help: sent to the owner on file", helpWords);
  drill.check(!/token=|\/admin\/reset/.test(await sheet(page).innerText()), "the sheet never shows a token or the link", null);
  const help = await until(() => latestPlatformMail({ platformUrl, kind: "operator_signin_help", recipient: EMAIL }), 30_000);
  const reset = help?.body.match(/(http:\/\/\S+\/admin\/reset\?token=[0-9a-f]{64})/)?.[1];
  drill.check(Boolean(reset) && help.body.includes(`${STORE}/admin/login`), "the mock mail has the store's login address and a reset link", help?.body?.slice(0, 200));
  {
    const f = await newPage(drill);
    await f.page.goto(reset, { waitUntil: "load" });
    await settle(f.page);
    const pw = f.page.locator('input[type="password"]');
    await pw.first().waitFor();
    for (const el of await pw.all()) await el.fill("ops-founder-new-pass-2");
    await f.page.locator('button[type="submit"]').first().click();
    await f.page.waitForURL((u) => u.pathname === "/admin/login", { timeout: 30_000 }).catch(() => {});
    await f.page.goto(at(STORE, "/admin/login"), { waitUntil: "load" });
    await f.page.locator("#login-email").fill(EMAIL);
    await f.page.locator("#login-password").fill("ops-founder-new-pass-2");
    await f.page.getByRole("button", { name: "Sign in", exact: true }).click();
    const inside = await f.page.waitForURL((u) => u.pathname.startsWith("/admin") && u.pathname !== "/admin/login", { timeout: 60_000 }).then(() => true, () => false);
    drill.check(inside, "the reset link set a new password on the store host, and it signs in", f.page.url());
    await f.ctx.close();
  }

  // 5. support access, and the banner in the store console
  await sheet(page).locator("#sg-reason").fill("Helping the founder connect Shopify");
  await sheet(page).locator("#sg-hours").fill("2");
  await sheet(page).getByRole("button", { name: "Open support access" }).click();
  const consoleLink = sheet(page).getByRole("link", { name: /Open store console \(read-only\)/ });
  const linked = await consoleLink.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const href = linked ? await consoleLink.getAttribute("href") : null;
  drill.check(linked && href === `${STORE}/admin`, "support access opens; the sheet links to the store console", href);
  await drill.screenshot(page, "04-support-access");
  {
    const s = await ctx.newPage();
    await s.goto(at(STORE, "/admin"), { waitUntil: "load" });
    await settle(s);
    const body = await text(s);
    drill.check(/Platform support access is active/.test(body) && body.includes("Helping the founder connect Shopify"), "the store console shows the support-access banner", body.slice(0, 300));
    await drill.screenshot(s, "05-support-banner");
    await s.close();
  }

  // 7. a note
  await sheet(page).locator("#op-note").fill("Founder will connect Shopify tonight.");
  await sheet(page).getByRole("button", { name: "Add note" }).click();
  const noted = await until(async () => (await sheet(page).innerText()).includes("Founder will connect Shopify tonight."), 30_000);
  drill.check(Boolean(noted), "the note shows in the sheet", null);
  await closeSheet(page);
  await page.reload({ waitUntil: "load" });
  await storeRow.waitFor();
  drill.check((await storeRow.innerText()).includes("Founder will connect Shopify tonight."), "and on the row as the latest note", null);

  // 6. a lapsed signup's address is freed
  const lapsedId = `sgn_${randomBytes(8).toString("hex")}`;
  const old = new Date(Date.now() - 3 * 86400_000).toISOString();
  await platformSql([
    {
      sql: `INSERT INTO signups (id, email, name, store_name, slug, password_hash, browser_hash, sends, status, failure_kind, created_at, updated_at, expires_at)
            VALUES (?, 'lapsed@ops-drill.test', 'Lapsed Founder', 'Drill Ops Lapsed', ?, NULL, ?, 1, 'failed', 'lapsed', ?, ?, ?)`,
      args: [lapsedId, LAPSED_SLUG, sha(lapsedId), old, old, old],
    },
  ]);
  const held = await fetch(at(SITE, `/api/signup?slug=${LAPSED_SLUG}`)).then((r) => r.json());
  drill.check(held.available === false, "before: the lapsed signup still holds its address", held);
  await page.goto(at(CONSOLE, "/platform/onboarding?view=lapsed"), { waitUntil: "load" });
  await page.locator(`[data-subject="signup:${lapsedId}"]`).waitFor();
  await openRow(page, `signup:${lapsedId}`);
  await sheet(page).getByRole("button", { name: "Free this address" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await drill.screenshot(page, "06-free-address-dialog");
  await dialog.getByRole("button", { name: "Free the address" }).click();
  const freedWords = await until(async () => notice(page).innerText(), 30_000);
  drill.check(/Address freed/.test(freedWords || ""), "the address is freed (and the founder emailed)", freedWords);
  const free = await fetch(at(SITE, `/api/signup?slug=${LAPSED_SLUG}`)).then((r) => r.json());
  drill.check(free.available === true, "after: a new signup can take the address", free);
  const startAgain = await latestPlatformMail({ platformUrl, kind: "operator_start_again", recipient: "lapsed@ops-drill.test" });
  drill.check(Boolean(startAgain), "the founder got the start-again note", null);
  await closeSheet(page);

  // 8. signed out
  {
    const anon = await newPage(drill);
    await anon.page.goto(at(CONSOLE, "/platform/onboarding"), { waitUntil: "load" });
    drill.check(new URL(anon.page.url()).pathname === "/platform", "signed out: /platform/onboarding goes to /platform", anon.page.url());
    const api = await fetch(at(CONSOLE, "/api/platform/onboarding")).then((r) => r.status);
    drill.check(api === 401, "signed out: the API answers 401", api);
    await anon.ctx.close();
  }
  // the phone width: no sideways scroll on the list
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(at(CONSOLE, "/platform/onboarding?view=all"), { waitUntil: "load" });
  await page.locator("[data-subject]").first().waitFor();
  await drill.screenshot(page, "07-phone");
  await ctx.close();
}

runDrill({ id: DRILL_ID, part: "main", title: "OPS-ONBOARDING — the operator sees every signup and helps a stuck store" }, opsOnboarding).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
