// P1-CONNECT: `pnpm drill:connect`, a founder connects Shopify from onboarding
// step 1 in a real browser (Phase 1 line 4, docs/plans/phase-1.md "Line 4" §5
// item 14). Run by scripts/drills/run-isolated.mjs in a throwaway worktree:
// it seeds and starts the roles store, adds the Roles Annex (a fresh closed
// store with no products, where owner@roles.test is admin and
// support@roles.test is support), and gives the harness SHOPIFY_API_ORIGIN
// pointing at SHOPIFY_FAKE_PORT on loopback. This script starts the Shopify
// stand-in (scripts/support/fake-shopify.js) there; nothing reaches Shopify.
// Steps:
//   1. ?step=connect&shop=… fills the address field and saves nothing
//   2. a custom domain gets the Settings, Domains words; a handle is saved:
//      In progress, "preparing", Connect disabled with the reason
//   3. the operator sets the store's app up (control plane): the address is
//      locked with "Wrong store?"; Connect is enabled
//   4. Cancel on Shopify's approval page: the denied words and the hint, and
//      connect_error is gone from the address bar
//   5. the stand-in names another shop on return: the wrong-shop words
//   6. support on the annex and staff on the roles store: read-only, no
//      address, Connect disabled (or absent once the step is done)
//   7. Install: back on step 2 with connected=1, step 1 Done, the products
//      come in from the stand-in and step 2 is Done
// Results and screenshots: docs/cms-reviews/drills/P1-CONNECT/.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, harnessEnv, readPidfile } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";
import { ROLES_PROFILE } from "../../seed-roles-store.js";
import { startFakeShopify } from "../../support/fake-shopify.js";
import { CONNECT_ERROR_WORDS, CONNECT_WORDS, DENIED_HINT } from "../../../lib/onboarding/connect-words.js";
import { SHOP_WORDS } from "../../../lib/shopify-origin.js";
import { READ_ONLY_REASON, WORDS } from "../../../lib/onboarding/steps.js";

const DRILL_ID = "P1-CONNECT";
const ONBOARDING = "/admin/onboarding";
const port = String(process.env.ROLES_PORT || "").trim();
const fakePort = Number(process.env.SHOPIFY_FAKE_PORT || 0);
const ROLES = `http://roles.localhost:${port}`;
const ANNEX = `http://annex.localhost:${port}`;
const SHOP = "drill-connect.myshopify.com";
const APP = { shop: SHOP, clientId: "drill-connect-client", clientSecret: `drill-secret-${Date.now()}`, redirectUris: [`${ANNEX}/api/admin/shopify/callback`] };
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const seed = () => JSON.parse(readFileSync(join(ROOT, ROLES_PROFILE.dataDirName, "roles-seed.json"), "utf8"));
const text = (page) => page.locator("body").innerText().catch(() => "");

// the control plane the roles harness runs on (the same env its servers got)
async function control() {
  const info = readPidfile(join(ROOT, ROLES_PROFILE.dataDirName));
  if (!info?.ports) throw new Error("the roles harness isn't running");
  const env = harnessEnv(process.env, {}, info.ports, { siteHost: ROLES_PROFILE.siteHost });
  for (const k of ["PLATFORM_DB_URL", "PLATFORM_DB_TOKEN", "PLATFORM_SECRET"]) process.env[k] = env[k];
  return import("../../../lib/platform/control.js");
}

async function signIn(drill, origin, creds) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  // console errors are recorded in the notes (the dev overlay's "1 Issue" is otherwise unexplained)
  ctx.on("page", (p) => p.on("console", (m) => m.type() === "error" && drill.note(`console error on ${new URL(p.url()).pathname}: ${m.text().slice(0, 300)}`)));
  // the first request on a cold dev server can 404 while the route compiles (the known login flake)
  let res;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await ctx.request.get(`${origin}/admin/login`).catch(() => {});
    res = await ctx.request.post(`${origin}/api/admin/login`, { data: { email: creds.email, password: creds.password }, headers: { origin }, maxRedirects: 0 });
    if (res.status() !== 404) break;
    drill.note(`known flake: sign-in answered 404 on ${origin} (attempt ${attempt}); trying again`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (res.status() !== 200) throw new Error(`sign-in as ${creds.email} on ${origin} answered ${res.status()}`);
  return ctx.newPage();
}

const model = async (page, origin) => (await page.request.get(`${origin}/api/admin/onboarding`)).json();
const step1 = async (page, origin) => (await model(page, origin)).steps?.[0];
async function openConnect(page, origin, query = "") {
  await page.goto(`${origin}${ONBOARDING}?step=connect${query}`, { waitUntil: "load" });
  await settle(page);
  await page.locator('[data-onboarding="panel"][data-step="connect"]').waitFor({ timeout: 60_000 });
}
// the step at a laptop width (the context's 1280), then 768 and 375
async function shootSizes(drill, page, name) {
  await drill.shoot(page, name);
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await drill.shoot(page, `${name}-${width}`, { fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
const fault = (body) => fetch(`http://127.0.0.1:${fakePort}/_fake/faults`, { method: body ? "POST" : "DELETE", body: body ? JSON.stringify(body) : undefined });

// → where the callback sent the browser (before the page clears its parameters)
async function connectVia(page, choice) {
  await page.locator('[data-onboarding="connect-button"]').click();
  await page.waitForURL(/\/admin\/oauth\/authorize/, { timeout: 30_000 });
  const back = page.waitForResponse((r) => r.url().includes("/api/admin/shopify/callback"), { timeout: 60_000 });
  await page.locator(`#${choice}`).click();
  const res = await back;
  await page.waitForURL(/\/admin\/onboarding/, { timeout: 60_000 });
  await settle(page);
  return new URL(res.headers().location || "/", res.url());
}

async function connectDrill(drill) {
  if (!port || !fakePort) throw new Error("drill:connect needs ROLES_PORT and SHOPIFY_FAKE_PORT (run it as pnpm drill:connect).");
  const fake = await startFakeShopify({ port: fakePort, apps: [APP] });
  drill.note(`Shopify stand-in on ${fake.url}`);
  try {
    const s = seed();
    const login = (role) => s.members.find((m) => m.role === role);
    const C = await control();
    const owner = await signIn(drill, ANNEX, login("owner")); // admin on the annex

    // 1. ?shop fills, never submits
    await openConnect(owner, ANNEX, `&shop=${SHOP}`);
    const filled = await owner.locator('[data-onboarding="shop-input"]').inputValue();
    drill.check(filled === SHOP, "?shop= fills the address field", filled);
    drill.check(!(await C.getTenant("annex", { fresh: true })).config.shopify_store_domain, "…and saves nothing");
    drill.check((await text(owner)).includes(CONNECT_WORDS.preparingSave), "before saving: 'preparing… save your address and there's nothing else'");
    await shootSizes(drill, owner, "1-prefilled");

    // 2. custom domain words; a handle saved; in progress, Connect disabled
    await owner.locator('[data-onboarding="shop-input"]').fill("brand.com");
    await owner.locator('[data-onboarding="shop-save"]').click();
    drill.check((await text(owner)).includes(SHOP_WORDS.custom_domain), "a custom domain says to use the myshopify.com address");
    await owner.locator('[data-onboarding="shop-input"]').fill("drill-connect");
    await owner.locator('[data-onboarding="shop-save"]').click();
    await owner.locator('[data-onboarding="panel"][data-state="in_progress"]').waitFor({ timeout: 30_000 }).catch(() => {});
    const saved = (await C.getTenant("annex", { fresh: true })).config.shopify_store_domain;
    drill.check(saved === SHOP, "the handle is saved as its myshopify.com address", saved);
    const ip = await step1(owner, ANNEX);
    drill.check(ip.state === "in_progress" && ip.words === CONNECT_WORDS.appNotReady, "step 1 In progress: Storeasy's team is preparing", ip);
    const reasons = await owner.locator('[data-onboarding="reason"]').allInnerTexts();
    drill.check(reasons.includes(CONNECT_WORDS.preparingWait), "Connect disabled with the reason (nothing for the founder to do)", reasons);
    drill.check((await owner.locator('[data-onboarding="shop-save"]').count()) === 0, "the saved, unchanged address has no Save button: one control");
    await shootSizes(drill, owner, "2-preparing");

    // 3. the operator sets the app up
    await C.patchTenant("annex", { config: { shopify_client_id: APP.clientId }, secrets: { shopify_client_secret: APP.clientSecret } });
    await openConnect(owner, ANNEX);
    const lockedText = await text(owner);
    drill.check(lockedText.includes(CONNECT_WORDS.locked) && lockedText.includes(SHOP), "the address is locked with 'Wrong store?'");
    drill.check(await owner.locator('[data-onboarding="connect-button"]').isEnabled(), "Connect is enabled");
    drill.check((await owner.locator('[data-onboarding="shop-input"]').count()) === 0, "no address field once locked");
    await shootSizes(drill, owner, "3-ready");

    // 4. Cancel in Shopify
    await connectVia(owner, "cancel");
    const denied = await text(owner);
    drill.check(denied.includes(CONNECT_ERROR_WORDS.denied) && denied.includes(DENIED_HINT), "Cancel: the denied words and 'Press Connect again'");
    await owner.waitForFunction(() => !location.search.includes("connect_error"), null, { timeout: 10_000 }).catch(() => {});
    drill.check(!owner.url().includes("connect_error"), "connect_error is cleared from the address bar", owner.url());
    await shootSizes(drill, owner, "4-cancelled");

    // 5. another shop on return
    await fault({ wrongShop: true });
    await openConnect(owner, ANNEX);
    await connectVia(owner, "install");
    await fault(null);
    drill.check((await text(owner)).includes(CONNECT_ERROR_WORDS.wrong_shop), "a different shop: the wrong-shop words");
    drill.check(!(await C.getTenant("annex", { fresh: true })).secrets.shopify_admin_token, "nothing stored after the refusals");
    await drill.shoot(owner, "5-wrong-shop");

    // 6. support and staff are read-only
    const support = await signIn(drill, ANNEX, login("support"));
    await openConnect(support, ANNEX);
    const sup = await text(support);
    drill.check(!sup.includes(SHOP), "support: no shop address");
    drill.check((await support.locator('[data-onboarding="shop-input"]').count()) === 0, "support: no address field");
    const supReasons = await support.locator('[data-onboarding="panel"] [data-onboarding="reason"]').allInnerTexts();
    drill.check(supReasons.includes(READ_ONLY_REASON), "support: Connect disabled, read-only reason", supReasons);
    drill.check((await support.locator('[data-onboarding="panel"] [data-onboarding="connect"] button:not([disabled])').count()) === 0, "support: no enabled control in step 1");
    await shootSizes(drill, support, "6-support");
    const staff = await signIn(drill, ROLES, login("staff"));
    await openConnect(staff, ROLES);
    drill.check((await staff.locator('[data-onboarding="connect"] button:not([disabled]), [data-onboarding="shop-input"]').count()) === 0, "staff: step 1 read-only");
    await drill.shoot(staff, "6-staff");

    // 7. Install
    await openConnect(owner, ANNEX);
    const u = await connectVia(owner, "install");
    drill.check(u.searchParams.get("step") === "import" && u.searchParams.get("connected") === "1", "the callback sends the browser to step 2 with connected=1", u.href);
    const note = await owner.locator('[data-onboarding="connected-note"]').waitFor({ timeout: 15_000 }).then(() => true, () => false);
    drill.check(note && (await text(owner)).includes(CONNECT_WORDS.connectedNote), "step 2 says Shopify connected");
    await owner.waitForFunction(() => !location.search.includes("connected="), null, { timeout: 10_000 }).catch(() => {});
    drill.check(!owner.url().includes("connected="), "connected=1 is cleared from the address bar", owner.url());
    const done = await step1(owner, ANNEX);
    drill.check(done.state === "done" && done.words === WORDS.connect.done, "step 1 Done", done?.state);
    const row = await C.getTenant("annex", { fresh: true });
    drill.check(Boolean(row.secrets.shopify_admin_token && row.secrets.shopify_refresh_token && row.config.shopify_token_expires_at), "an expiring token pair is stored");
    let imp = null;
    for (let i = 0; i < 30; i++) {
      imp = (await model(owner, ANNEX)).steps?.[1];
      if (imp?.state === "done") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    drill.check(imp?.state === "done", "the first sync brings the products in: step 2 Done", imp?.state);
    await owner.reload({ waitUntil: "load" });
    await settle(owner);
    drill.check(!ERROR_TEXT.test(await text(owner)), "no error screen");
    await drill.shoot(owner, "7-connected");
    writeFileSync(join(drill.dir, "fake-shopify-log.json"), `${JSON.stringify(fake.state.log, null, 2)}\n`);
  } finally {
    await fake.close();
  }
}

runDrill({ id: DRILL_ID, part: "main", title: "P1-CONNECT — a founder connects Shopify from onboarding step 1" }, connectDrill).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
