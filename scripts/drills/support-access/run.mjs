// SUPPORT-ACCESS: `pnpm drill:support-access`, time-boxed support access across
// hosts in a real browser (Phase 3 line 5, docs/plans/phase-3.md "Line 5",
// Drill). Run by scripts/drills/run-isolated.mjs in a throwaway worktree on
// its own roles store (seeded and started there); never in the owner's
// checkout. The operator console is on http://localhost:<port> and the store
// on http://roles.localhost:<port>: two hosts, so the store's cookies are
// never the operator console's. The operator's session is minted in the
// control plane (as drill:flags-incidents does; drill:platform-shell types a
// real authenticator code).
//   1. on localhost the operator opens support access to the roles store from
//      its store page (reason, 1 hour); the card shows it open by name
//   2. "Enter store console (read-only)" lands on roles.localhost/admin with a
//      host-only __Host-support cookie (HttpOnly, Secure, Lax, no Domain), and the
//      entry token never shows in a URL
//   3. the stray-control pass (scripts/drills/support/stray.mjs) on every
//      ADMIN_PAGES row as the operator under support access
//   4. the owner sees the banner naming the operator and the Support access
//      card on Settings, Team, and ends access (AlertDialog)
//   5. the operator's next request on the store goes to the sign-in
//   6. signed out, /platform/support-access goes to /platform
// Evidence: docs/cms-reviews/drills/SUPPORT-ACCESS/ (results-main.json, screenshots).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dbUrl, readPidfile } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";
import { strayPass } from "../support/stray.mjs";
import { ADMIN_PAGES } from "../../support/admin-pages.js";

const DRILL_ID = "SUPPORT-ACCESS";
const port = String(process.env.ROLES_PORT || "").trim();
const STORE = `http://roles.localhost:${port}`;
const CONSOLE = `http://localhost:${port}`;
const HOST = "roles.localhost";
const OP_NAME = "Drill Operator Ravi";
const REASON = `Checking the catalog sync ${String(Date.now()).slice(-6)}`;
const CONTROLS = ["skip", "toggle", "switcher", "account"];
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
const NEXT_LOG = process.env.DRILL_LOG_DIR ? join(process.env.DRILL_LOG_DIR, "design-data-roles-next.log") : null;
const { supportNewUiControls, checkNewUi, strayControls } = strayPass({ origin: STORE, controls: CONTROLS, nextLog: NEXT_LOG });

const browserErrors = [];
async function context(drill, label) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    // the editor's document reads answer 404 for a document the roles store
    // doesn't have yet (the same for every member): an answer, not an error
    // and the fixture catalog's product images live on a Shopify CDN path the
    // drill's blocked network never serves (next/image answers 404)
    const at = msg.location()?.url || "";
    const documentsMiss = /status of 404/.test(msg.text()) && (/\/api\/admin\/documents$/.test(at) || /\/_next\/image\?url=https%3A%2F%2Fcdn\.shopify\.com%2Ffixture%2F/.test(at));
    if (msg.type() === "error" && !documentsMiss && !/eval\(\) is not supported/.test(msg.text())) browserErrors.push(`${label}: ${msg.text().slice(0, 300)} (${msg.location()?.url || ""})`);
  });
  page.on("pageerror", (e) => browserErrors.push(`${label}: ${String(e?.message || e).slice(0, 300)}`));
  return { ctx, page };
}
const bodyText = (page) => page.locator("body").innerText().catch(() => "");

async function controlPlane() {
  const info = readPidfile(join(ROOT, ".design-data-roles"));
  if (!info?.ports?.sqld?.platform) throw new Error("drill:support-access needs the roles harness's control plane (its pid file)");
  process.env.PLATFORM_DB_URL = dbUrl(info.ports.sqld.platform);
  process.env.PLATFORM_DB_TOKEN = "";
  const { platformDb } = await import("../../../lib/platform/control.js");
  const tenant = (await platformDb().execute("SELECT id, name, domains FROM tenants")).rows.find((r) => String(r.domains || "").includes(HOST));
  if (!tenant) throw new Error("no roles.localhost store in the control plane");
  return { db: platformDb(), tenant: { id: String(tenant.id), name: String(tenant.name) } };
}

// An operator with TOTP confirmed and a live operator session, on the console host only.
async function operatorContext(drill, db) {
  const id = `u_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await db.execute({ sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, 1, 'active', ?, ?)", args: [id, `operator-${id}@support-drill.test`, OP_NAME, now.toISOString(), now.toISOString()] });
  await db.execute({ sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, 'operator', ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, createHash("sha256").update(token).digest("hex"), id, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString()] });
  const { ctx, page } = await context(drill, "operator");
  await ctx.addCookies([{ name: "_platform", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  return { ctx, page, id };
}

async function ownerPage(drill) {
  const m = seed().members.find((x) => x.role === "owner");
  const { ctx, page } = await context(drill, "owner");
  const res = await ctx.request.post(`${STORE}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: STORE }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as owner answered ${res.status()}`);
  return page;
}

async function openAndEnter(drill, op, tenant) {
  const { page, ctx } = op;
  await page.goto(`${CONSOLE}/platform/stores/${encodeURIComponent(tenant.id)}`, { waitUntil: "load" });
  await settle(page);
  const card = page.locator('[data-card="support"]');
  drill.check(await card.isVisible(), "the store page has the Support access card");
  await card.getByLabel("Reason").fill(REASON);
  await card.getByLabel("For").selectOption("1");
  const granted = page.waitForResponse((r) => r.url().includes("/api/platform/support") && r.request().method() === "POST");
  await card.getByRole("button", { name: "Open access" }).click();
  drill.check((await granted).status() === 200, "Open access answers 200");
  await card.locator('[data-support="open"]').waitFor();
  const txt = await card.innerText();
  drill.check(txt.includes(OP_NAME) && txt.includes(REASON) && /Open until/.test(txt), "the card shows it open, by the operator's name, with the reason", txt.slice(0, 400));
  drill.check(/Email is off|emailed/.test(txt), "the card says whether the owners were emailed", txt.slice(0, 400));
  await drill.screenshot(page, "store-card-open");

  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  await card.getByRole("button", { name: "Enter store console (read-only)" }).click();
  await page.waitForURL((u) => u.host === `${HOST}:${port}` && u.pathname.startsWith("/admin"), { timeout: 30_000 });
  await settle(page);
  drill.check(new URL(page.url()).host === `${HOST}:${port}`, "the operator lands on the store's own host", page.url());
  drill.check(!/\/admin\/login/.test(page.url()), "in the console, not at the sign-in", page.url());
  drill.check(urls.every((u) => !/token=/.test(u)), "no request URL carries the entry token", urls.filter((u) => /token=/.test(u)));
  const cookies = await ctx.cookies(STORE);
  const sup = cookies.find((c) => c.name === "__Host-support");
  drill.check(Boolean(sup) && sup.httpOnly && sup.secure && sup.sameSite === "Lax" && sup.domain === HOST, "a host-only HttpOnly Secure Lax __Host-support cookie on roles.localhost", sup && { ...sup, value: "…" });
  drill.check(!(await ctx.cookies(CONSOLE)).some((c) => c.name === "__Host-support"), "no __Host-support cookie on the operator console's host");
  const body = await bodyText(page);
  drill.check(/Platform support access is active/.test(body) && body.includes(OP_NAME), "the console's banner names the operator", body.slice(0, 300));
  await drill.screenshot(page, "operator-in-store");
}

async function strayPassAll(drill, page) {
  const check = (cond, label, detail) => drill.check(cond, label, detail);
  for (const r of ADMIN_PAGES) {
    if (/\[/.test(r.page)) continue; // a made-up id is a not-found page: nothing to press
    const href = `/admin${r.page ? `/${r.page}` : ""}`;
    const res = await page.goto(STORE + href, { waitUntil: "load" });
    await settle(page);
    const landed = new URL(page.url()).pathname;
    drill.check(!landed.startsWith("/admin/login"), `${href}: opens under support access (not the sign-in)`, page.url());
    if (res?.status() !== 200 || landed !== href) continue; // a redirect (the index) gets its pass on its destination
    // the onboarding page has its own shell (step list, Next, Preview), checked
    // for the support role by drill:shell's onboarding rules, not this pass
    if (r.page === "onboarding") continue;
    const stray = await page.evaluate(strayControls, [CONTROLS]);
    check(stray.length === 0, `${href}: as operator support, only nav links, shell controls, marked reads and gated writes`, stray);
    checkNewUi(check, href, await supportNewUiControls(page, href));
  }
}

async function ownerEnds(drill, owner) {
  await owner.goto(new URL("/admin/settings/team", STORE).href, { waitUntil: "load" });
  await settle(owner);
  const body = await bodyText(owner);
  drill.check(/Platform support access is active/.test(body) && body.includes(OP_NAME) && body.includes(REASON), "the owner's banner names the operator and the reason", body.slice(0, 400));
  const card = owner.locator('[data-team="support-access"]');
  drill.check(await card.isVisible(), "Settings, Team shows the Support access card");
  drill.check((await card.innerText()).includes(OP_NAME), "the card names the operator");
  await drill.screenshot(owner, "owner-team-card");
  await card.getByRole("button", { name: "End support access now" }).click();
  const dialog = owner.getByRole("alertdialog");
  drill.check((await dialog.innerText()).includes(OP_NAME), "the confirm names the operator");
  const ended = owner.waitForResponse((r) => r.url().includes("/api/admin/support-access") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "End support access now" }).click();
  drill.check((await ended).status() === 200, "ending answers 200");
  await settle(owner);
  drill.check(/Support access has ended/.test(await card.innerText()), "the card says it has ended");
  const history = await card.locator('[data-support="history"]').innerText().catch(() => "");
  drill.check(/Closed/.test(history) && history.includes(REASON), "the history lists it closed", history.slice(0, 300));
}

async function operatorOut(drill, op) {
  await op.page.goto(`${STORE}/admin/dashboard`, { waitUntil: "load" });
  await settle(op.page);
  drill.check(new URL(op.page.url()).pathname === "/admin/login", "the operator's next request on the store goes to the sign-in", op.page.url());
}

async function signedOut(drill) {
  const { page } = await context(drill, "signed-out");
  await page.goto(`${CONSOLE}/platform/support-access`, { waitUntil: "load" });
  await settle(page);
  drill.check(new URL(page.url()).pathname === "/platform", "signed out, /platform/support-access goes to /platform", page.url());
}

async function run(drill) {
  if (!port) throw new Error("drill:support-access needs ROLES_PORT (run it as pnpm drill:support-access).");
  if (!NEXT_LOG) throw new Error("drill:support-access needs DRILL_LOG_DIR (the roles store's Next log is the stray pass's second witness).");
  const { db, tenant } = await controlPlane();
  const op = await operatorContext(drill, db);
  await openAndEnter(drill, op, tenant);
  await strayPassAll(drill, op.page);
  const owner = await ownerPage(drill);
  await ownerEnds(drill, owner);
  await operatorOut(drill, op);
  await signedOut(drill);
  const audit = JSON.stringify((await db.execute("SELECT * FROM audit_log WHERE action LIKE 'support.%'")).rows);
  const tokens = (await db.execute("SELECT token_hash FROM sessions WHERE kind IN ('support_entry', 'support')")).rows.map((r) => String(r.token_hash));
  drill.check(tokens.length >= 2 && tokens.every((h) => !audit.includes(h)), "no audit row holds a support token or its hash");
  drill.check(browserErrors.length === 0, "no error in the browser console", browserErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "SUPPORT-ACCESS — time-boxed support access across hosts" }, run).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
