// FLAGS-INCIDENTS: `pnpm drill:flags-incidents`, the operator's feature flags
// and incidents in a real browser (Phase 3 line 4, docs/plans/phase-3.md
// "Line 4", Drill). Run by scripts/drills/run-isolated.mjs in a throwaway
// worktree on its own roles store (seeded and started there); never in the
// owner's checkout. Operator routes are host-blind, so the operator works on
// the roles store's host too, with a session minted in its control plane (as
// the suites and drill:operator-onboarding do; drill:platform-shell types a
// real authenticator code).
//   1. the operator opens an incident for the roles store (title, public
//      message, an internal-note canary) and the banner preview shows the title
//   2. the store's support member sees the banner in their console, never the note
//   3. the operator posts an update; the member sees the new message
//   4. the operator resolves it with a closing message; the timeline shows it,
//      and the member's banner is gone
//   5. flags: create a flag, turn it on for the roles store, the state reads
//      "On for 1 store", the history lists both changes, emergency disable
//      (AlertDialog) turns it "Off", delete (AlertDialog) removes it
//   6. signed out, /platform/flags and /platform/incidents go to /platform
// Evidence: docs/cms-reviews/drills/FLAGS-INCIDENTS/ (results-main.json, screenshots).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dbUrl, readPidfile } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "FLAGS-INCIDENTS";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const HOST = `roles.localhost`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
const NOTE = `drill internal note ${randomBytes(4).toString("hex")}`;
const STAMP = String(Date.now()).slice(-6);
const TITLE = `Payouts delayed ${STAMP}`;
const FLAG = `ff_drill-${STAMP}`;

const browserErrors = [];
async function context(drill, label) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/eval\(\) is not supported/.test(msg.text())) browserErrors.push(`${label}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => browserErrors.push(`${label}: ${String(e?.message || e).slice(0, 300)}`));
  return { ctx, page };
}
const open = async (page, path) => {
  await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
};
const bodyText = (page) => page.locator("body").innerText().catch(() => "");

// the roles store's control plane (its pid file), and the store's id in it
async function controlPlane() {
  const info = readPidfile(join(ROOT, ".design-data-roles"));
  if (!info?.ports?.sqld?.platform) throw new Error("drill:flags-incidents needs the roles harness's control plane (its pid file)");
  process.env.PLATFORM_DB_URL = dbUrl(info.ports.sqld.platform);
  process.env.PLATFORM_DB_TOKEN = "";
  const { platformDb } = await import("../../../lib/platform/control.js");
  const tenant = (await platformDb().execute("SELECT id, name, domains FROM tenants")).rows.find((r) => String(r.domains || "").includes(HOST));
  if (!tenant) throw new Error("no roles.localhost store in the control plane");
  return { db: platformDb(), tenant: { id: String(tenant.id), name: String(tenant.name) } };
}

// An operator: a user with is_operator and a live operator session (only its hash stored).
async function operatorPage(drill, db) {
  const id = `u_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await db.execute({ sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, 'Drill Operator Mira', NULL, 1, 1, 'active', ?, ?)", args: [id, `operator-${id}@flags-drill.test`, now.toISOString(), now.toISOString()] });
  await db.execute({ sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, 'operator', ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, createHash("sha256").update(token).digest("hex"), id, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString()] });
  const { ctx, page } = await context(drill, "operator");
  await ctx.addCookies([{ name: "_platform", value: token, domain: HOST, path: "/", httpOnly: true, sameSite: "Lax" }]);
  return page;
}

async function memberPage(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const { ctx, page } = await context(drill, role);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  return page;
}

const posted = (page, path) => page.waitForResponse((r) => r.url().includes(`/api/platform/${path}`) && r.request().method() === "POST", { timeout: 30_000 });

async function incidents(drill, op, member, tenant) {
  await open(op, "/platform/incidents");
  drill.check(await op.getByRole("heading", { name: "Incidents" }).isVisible(), "the incidents page opens in the operator shell");
  await op.getByRole("button", { name: "Open an incident" }).first().click();
  await op.locator("#incident-title").fill(TITLE);
  await op.locator("#incident-store").selectOption(tenant.id);
  await op.locator("#incident-public").fill("Payouts are delayed by about an hour.");
  await op.locator("#incident-note").fill(NOTE);
  const preview = await op.locator("[data-banner-preview]").innerText();
  drill.check(preview.includes(`Notice for your store: ${TITLE}`) && preview.includes("Payouts are delayed"), "the banner preview shows what merchants will see", preview.slice(0, 200));
  await drill.screenshot(op, "incident-open-dialog");
  const done = posted(op, "incidents");
  await op.getByRole("button", { name: "Open incident" }).click();
  drill.check((await done).status() === 200, "opening the incident answers 200");
  await op.locator("[data-incident-sheet]").waitFor();
  await settle(op);

  await open(member, "/admin");
  let text = await bodyText(member);
  drill.check(text.includes(`Notice for your store: ${TITLE}`) && text.includes("Payouts are delayed by about an hour."), "the support member sees the banner");
  drill.check(!text.includes(NOTE) && !(await member.content()).includes(NOTE), "the member's page never holds the internal note");
  await drill.screenshot(member, "member-banner-open");

  const upd = posted(op, "incidents");
  await op.locator("#incident-update").fill("Payouts resume at 6pm.");
  await op.getByRole("button", { name: "Post update" }).click();
  drill.check((await upd).status() === 200, "posting an update answers 200");
  await open(member, "/admin");
  drill.check((await bodyText(member)).includes("Payouts resume at 6pm."), "the member sees the update");

  await op.getByRole("button", { name: "Resolve incident" }).click();
  await op.locator("#incident-closing").fill("Payouts are back to normal.");
  await drill.screenshot(op, "incident-resolve-dialog");
  const res = posted(op, "incidents");
  await op.getByRole("button", { name: "Resolve", exact: true }).click();
  drill.check((await res).status() === 200, "resolving answers 200");
  await op.locator("[data-incident-timeline] li").nth(2).waitFor({ timeout: 15_000 }).catch(() => {});
  const timeline = await op.locator("[data-incident-timeline]").innerText().catch(() => "");
  drill.check(/Opened[\s\S]*Update posted[\s\S]*Resolved/.test(timeline) && timeline.includes("Payouts are back to normal.") && timeline.includes("Drill Operator Mira"), "the timeline shows opened, the update and resolved, by the operator", timeline.slice(0, 300));
  drill.check(!timeline.includes(NOTE), "the timeline never shows the note text");
  await drill.screenshot(op, "incident-timeline");

  await open(member, "/admin");
  text = await bodyText(member);
  drill.check(!text.includes(TITLE), "after resolving, the member's banner is gone");
}

async function flags(drill, op, tenant) {
  await open(op, "/platform/flags");
  drill.check(await op.getByRole("heading", { name: "Feature flags" }).isVisible(), "the flags page opens");
  await op.getByRole("button", { name: "New flag" }).first().click();
  await op.locator("#flag-key").fill("bad key");
  drill.check(await op.getByRole("button", { name: "Create flag" }).isDisabled(), "a key outside ff_[a-z0-9-] can't be sent");
  await op.locator("#flag-key").fill(FLAG);
  await op.locator("#flag-description").fill("Drill flag");
  let done = posted(op, "flags");
  await op.getByRole("button", { name: "Create flag" }).click();
  drill.check((await done).status() === 200, "creating the flag answers 200");
  await settle(op);
  const row = () => op.locator("tr", { has: op.locator(`text=${FLAG}`) });
  drill.check((await row().innerText()).includes("Off") && (await row().innerText()).includes("Drill Operator Mira"), "the new flag is Off, changed by the operator");

  await op.locator(`[data-flag-actions="${FLAG}"]`).click();
  await op.getByRole("menuitem", { name: "Store overrides" }).click();
  await op.locator("#override-store").selectOption(tenant.id);
  done = posted(op, "flags");
  await op.getByRole("button", { name: "Set override" }).click();
  drill.check((await done).status() === 200, "the store override answers 200");
  await op.locator("[data-flag-overrides]").waitFor();
  await op.keyboard.press("Escape");
  await settle(op);
  drill.check((await row().innerText()).includes("On for 1 store"), "the state reads On for 1 store");

  await op.locator(`[data-flag-actions="${FLAG}"]`).click();
  await op.getByRole("menuitem", { name: "History" }).click();
  await op.locator("[data-flag-history] li").nth(1).waitFor({ timeout: 15_000 }).catch(() => {});
  const history = await op.locator("[data-flag-history]").innerText().catch(() => "");
  drill.check(/Store override[\s\S]*Saved/.test(history), "the history lists the override, then the save", history.slice(0, 300));
  await drill.screenshot(op, "flag-history");
  await op.keyboard.press("Escape");

  await op.locator(`[data-flag-actions="${FLAG}"]`).click();
  await op.getByRole("menuitem", { name: "Emergency disable" }).click();
  const dialog = await op.getByRole("alertdialog").innerText();
  drill.check(/every store/.test(dialog), "the disable dialog says it is off for every store", dialog.slice(0, 200));
  done = posted(op, "flags");
  await op.getByRole("button", { name: "Switch off now" }).click();
  drill.check((await done).status() === 200, "emergency disable answers 200");
  await settle(op);
  drill.check((await row().innerText()).includes("Off"), "the flag is Off again");

  await op.locator(`[data-flag-actions="${FLAG}"]`).click();
  await op.getByRole("menuitem", { name: "Delete" }).click();
  const del = await op.getByRole("alertdialog").innerText();
  drill.check(/treat it as on for every store/.test(del), "the delete dialog says what the code falls back to", del.slice(0, 200));
  done = posted(op, "flags");
  await op.getByRole("button", { name: "Delete flag" }).click();
  drill.check((await done).status() === 200, "delete answers 200");
  await settle(op);
  drill.check((await op.locator(`text=${FLAG}`).count()) === 0, "the flag is gone from the list");
}

async function signedOut(drill) {
  const { page } = await context(drill, "signed-out");
  for (const path of ["/platform/flags", "/platform/incidents"]) {
    await open(page, path);
    drill.check(new URL(page.url()).pathname === "/platform", `signed out, ${path} goes to /platform`, page.url());
  }
}

async function run(drill) {
  if (!port) throw new Error("drill:flags-incidents needs ROLES_PORT (run it as pnpm drill:flags-incidents).");
  const { db, tenant } = await controlPlane();
  const op = await operatorPage(drill, db);
  const member = await memberPage(drill, "support");
  await incidents(drill, op, member, tenant);
  await flags(drill, op, tenant);
  await signedOut(drill);
  const notes = (await db.execute("SELECT diff FROM audit_log WHERE action LIKE 'incident.%'")).rows.map((r) => String(r.diff)).join("\n");
  drill.check(!notes.includes(NOTE), "no audit row holds the internal note");
  drill.check(browserErrors.length === 0, "no error in the browser console", browserErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "FLAGS-INCIDENTS — feature flags and incidents on the operator console" }, run).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
