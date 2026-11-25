// TEAM: `pnpm drill:team`, the team screen in a real browser (Phase 2 line 8,
// docs/plans/phase-2.md "Line 8" Drill). Run by scripts/drills/run-isolated.mjs
// in a throwaway worktree on its own roles store (seeded and started there);
// never in the owner's checkout. Mail is blank there, so no email is sent: the
// invite says so and the drill copies the link from the page.
//   owner: invites a new staff member; the link is shown once with the
//     "email isn't set up" words
//   a second browser context accepts the link (a new account), lands signed
//     in, and the team page is the no-access page for that new staff member
//   admin: the invite dialog's role select has no Owner; no Transfer button;
//     an owner's row has no Change role or Remove
//   staff (the seeded one): the no-access page, no member email in the page
//   owner transfers ownership to the admin (typing the store name), the page
//     reloads and the former owner is now admin: no Transfer, the API says admin
// Evidence: docs/cms-reviews/drills/TEAM/ (results-main.json, screenshots).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "TEAM";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const TEAM_PAGE = "/admin/settings/team";
const STORE_NAME = "Roles Demo Co";
const NEW_STAFF = { email: "new-staff@roles.test", name: "Nina New", password: "drill-new-staff-pass-1" };
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
const member = (role) => seed().members.find((x) => x.role === role);

const consoleErrors = [];
function watch(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/eval\(\) is not supported/.test(msg.text())) consoleErrors.push(`${label}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${label}: ${String(e?.message || e).slice(0, 300)}`));
}
async function signIn(drill, role) {
  const m = member(role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  watch(page, role);
  return page;
}
const openTeam = async (page) => {
  const r = await page.goto(ORIGIN + TEAM_PAGE, { waitUntil: "load" });
  await settle(page);
  return r?.status();
};
const teamApi = (page) => page.evaluate(async () => {
  const r = await fetch("/api/admin/team");
  return { status: r.status, json: await r.json().catch(() => null) };
});
const row = (page, text) => page.locator('[data-team="members"] tr', { hasText: text });

async function ownerInvites(drill) {
  const page = await signIn(drill, "owner");
  drill.check((await openTeam(page)) === 200, "owner: the team page opens (200)");
  const members = await page.locator('[data-team="members"] tbody tr').count();
  drill.check(members >= 4 && (await row(page, member("owner").email).locator('[data-team="you"]').count()) === 1, "owner: four members or more, the You marker on the owner's row", { members });
  await drill.shoot(page, "owner-team");
  await page.locator('[data-team="invite"]').click();
  const dialog = page.locator('[data-team="invite-dialog"]');
  await dialog.waitFor();
  const options = await dialog.locator('[data-team="role-select"] option').evaluateAll((els) => els.map((e) => e.value));
  drill.check(options.includes("owner"), "owner: the role select offers Owner", options);
  await dialog.getByLabel("Email").fill(NEW_STAFF.email);
  await dialog.locator('[data-team="role-select"]').selectOption("staff");
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await dialog.locator('[data-team="invite-link"]').waitFor({ timeout: 15_000 });
  const url = await dialog.locator('[data-team="invite-url"]').inputValue();
  const mail = await dialog.locator('[data-team="invite-mail"]').getAttribute("data-mail");
  drill.check(/\/admin\/accept-invite\?token=[0-9a-f]{64}$/.test(url) && mail === "not-configured", "owner: the link is shown once, and the page says no email was sent", { mail });
  await drill.shoot(page, "owner-invite-link");
  await dialog.getByRole("button", { name: "Done" }).click();
  const pending = await page.locator('[data-team="invites"] tr', { hasText: NEW_STAFF.email }).count();
  drill.check(pending === 1, "owner: the invite is listed as pending");
  await page.context().close();
  return url;
}

async function newMemberAccepts(drill, url) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  watch(page, "new staff");
  await page.goto(url, { waitUntil: "load" });
  await settle(page);
  await page.locator("#inv-name").fill(NEW_STAFF.name);
  await page.locator("#inv-pw").fill(NEW_STAFF.password);
  await page.locator("#inv-pw2").fill(NEW_STAFF.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/admin/accept-invite"), { timeout: 30_000 });
  await settle(page);
  const who = await page.evaluate(async () => (await fetch("/api/admin/team")).status);
  drill.check(who === 403, "the new member is signed in as staff: GET /api/admin/team is 403", { who });
  await openTeam(page);
  drill.check((await page.locator('[data-team="no-access"]').count()) === 1 && (await page.locator('[data-team="members"]').count()) === 0, "the new staff member gets the no-access page");
  await drill.shoot(page, "new-staff-no-access");
  await ctx.close();
}

async function adminView(drill) {
  const page = await signIn(drill, "admin");
  await openTeam(page);
  drill.check((await page.locator('[data-team="transfer"]').count()) === 0, "admin: no Transfer ownership button");
  const ownerRow = row(page, member("owner").email);
  drill.check((await ownerRow.count()) === 1 && (await ownerRow.locator('[data-team="change-role"], [data-team="remove"]').count()) === 0, "admin: an owner's row has no Change role or Remove");
  await page.locator('[data-team="invite"]').click();
  const dialog = page.locator('[data-team="invite-dialog"]');
  await dialog.waitFor();
  const options = await dialog.locator('[data-team="role-select"] option').evaluateAll((els) => els.map((e) => e.value));
  drill.check(!options.includes("owner") && options.includes("staff"), "admin: the role select has no Owner option", options);
  await drill.shoot(page, "admin-invite-dialog");
  await page.keyboard.press("Escape");
  await page.context().close();
}

async function staffView(drill) {
  const page = await signIn(drill, "staff");
  await openTeam(page);
  const text = await page.locator("main").innerText();
  drill.check((await page.locator('[data-team="no-access"]').count()) === 1 && !text.includes(member("owner").email), "staff: the no-access page, no member email in it");
  await drill.shoot(page, "staff-no-access");
  await page.context().close();
}

async function ownerTransfers(drill) {
  const page = await signIn(drill, "owner");
  await openTeam(page);
  await page.locator('[data-team="transfer"]').click();
  const dialog = page.locator('[data-team="transfer-dialog"]');
  await dialog.waitFor();
  const adminId = await dialog.locator('[data-team="transfer-to"] option', { hasText: member("admin").name }).getAttribute("value");
  await dialog.locator('[data-team="transfer-to"]').selectOption(adminId);
  const submit = dialog.getByRole("button", { name: "Transfer ownership" });
  drill.check(await submit.isDisabled(), "transfer: the button waits for the store name");
  await dialog.getByLabel(`Type ${STORE_NAME} to confirm`).fill(STORE_NAME);
  await drill.shoot(page, "owner-transfer-dialog");
  await Promise.all([page.waitForEvent("load", { timeout: 30_000 }), submit.click()]);
  await settle(page);
  const api = await teamApi(page);
  const roles = Object.fromEntries((api.json?.members ?? []).map((m) => [m.email, m.role]));
  drill.check(api.status === 200 && api.json?.you?.role === "admin" && roles[member("owner").email] === "admin" && roles[member("admin").email] === "owner", "after the transfer the former owner is admin and the admin is owner", { you: api.json?.you, roles });
  drill.check((await page.locator('[data-team="transfer"]').count()) === 0 && (await page.locator('[data-team="members"]').count()) === 1, "the reloaded page is the admin's: no Transfer button, the team still shows");
  await drill.shoot(page, "former-owner-as-admin");
  await page.context().close();
}

async function team(drill) {
  if (!port) throw new Error("drill:team needs ROLES_PORT (run it as pnpm drill:team).");
  const url = await ownerInvites(drill);
  await newMemberAccepts(drill, url);
  await adminView(drill);
  await staffView(drill);
  await ownerTransfers(drill);
  drill.check(consoleErrors.length === 0, "no error in the browser console", consoleErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "TEAM — invite, accept, roles, transfer" }, team).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
