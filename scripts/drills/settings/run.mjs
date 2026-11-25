// SETTINGS: `pnpm drill:settings`, settings, integrations and billing in a real
// browser (Phase 2 line 7, docs/plans/phase-2.md "Line 7", Drill). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store (seeded and started there); never in the owner's checkout.
//   admin: edits Details, Checkout and payments, Shipping and Tracking, reloads,
//     and the values are kept; a typed secret never comes back in the page;
//     Domains and SEO loads; an old /admin/settings#payments link lands on Checkout
//   staff and support: every settings, integrations and billing URL shows
//     "Your role can't open settings" and no settings tab
//   signed out while an operator's support grant is open: /admin/login shows
//     no support-access banner (the signed-in admin does see it)
// Evidence: docs/cms-reviews/drills/SETTINGS/ (results-main.json, screenshots).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dbUrl, readPidfile } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "SETTINGS";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
const NO_ACCESS = "Your role can't open settings";
const GATED = ["/admin/settings", "/admin/settings/checkout", "/admin/settings/shipping", "/admin/settings/domains", "/admin/settings/tracking", "/admin/settings/sync", "/admin/settings/privacy", "/admin/settings/audit", "/admin/settings/help", "/admin/integrations", "/admin/billing"];

const consoleErrors = [];
async function context(drill, label) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/eval\(\) is not supported/.test(msg.text())) consoleErrors.push(`${label}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${label}: ${String(e?.message || e).slice(0, 300)}`));
  return { ctx, page };
}
async function signIn(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const { ctx, page } = await context(drill, role);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  return page;
}
const open = async (page, path) => {
  await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
};
const saveTab = async (page, label) => {
  const done = page.waitForResponse((r) => r.url().endsWith("/api/admin/settings") && r.request().method() === "PUT", { timeout: 30_000 });
  await page.getByRole("button", { name: label, exact: true }).click();
  const res = await done;
  await page.locator('[data-settings="save-bar"]').waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  return res.status();
};
const value = (page, id) => page.locator(`#${id}`).inputValue();

async function adminFlows(drill) {
  const page = await signIn(drill, "admin");
  const stamp = String(Date.now()).slice(-6);

  // Details
  await open(page, "/admin/settings");
  drill.check((await page.locator('[data-settings-tab="details"]').count()) === 1 && (await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link").count()) >= 9, "admin: Details with the section nav");
  await page.locator("#st-tagline").fill(`Drill tagline ${stamp}`);
  await page.locator("#st-support_phone").fill(`98765${stamp.slice(0, 5)}`);
  drill.check((await page.locator('[data-settings="save-bar"]').count()) === 1, "an edit shows the sticky save bar");
  const s1 = await saveTab(page, "Save details");
  await open(page, "/admin/settings");
  drill.check(s1 === 200 && (await value(page, "st-tagline")) === `Drill tagline ${stamp}` && (await value(page, "st-support_phone")) === `98765${stamp.slice(0, 5)}`, "Details: saved, reloaded, kept", { s1 });
  await drill.shoot(page, "admin-details");

  // Checkout and payments: the key id is kept; a typed secret never comes back
  await open(page, "/admin/settings/checkout");
  await page.locator("#st-rzp-key-id").fill(`rzp_test_drill${stamp}`);
  await page.locator("#st-timezone").fill("Asia/Dubai");
  const secretBox = page.locator('[data-secret-field="st-rzp-key-secret"]');
  await secretBox.getByRole("button", { name: /Replace|Add/ }).click();
  const secret = `drillsecret${stamp}`;
  await page.locator("#st-rzp-key-secret").fill(secret);
  const s2 = await saveTab(page, "Save checkout and payments");
  await open(page, "/admin/settings/checkout");
  const html = await page.content();
  drill.check(
    s2 === 200 && (await value(page, "st-rzp-key-id")) === `rzp_test_drill${stamp}` && (await value(page, "st-timezone")) === "Asia/Dubai" && /Saved/.test(await secretBox.innerText()) && !html.includes(secret),
    "Checkout: key id and timezone kept; the key secret shows only as Saved, its value nowhere in the page",
    { s2 },
  );
  drill.check((await page.locator('[data-settings="pay-with"]').count()) === 1, "Checkout: the 'Shoppers can pay with' line");
  await drill.shoot(page, "admin-checkout");

  // Shipping: an inline error keeps what was typed; then a real save
  await open(page, "/admin/settings/shipping");
  await page.locator("#st-flatRate").fill("-5");
  const inline = await page.locator("#st-flatRate-error").innerText().catch(() => "");
  drill.check(/Flat rate/.test(inline) && (await value(page, "st-flatRate")) === "-5", "Shipping: an invalid rate is said under the field and kept as typed", inline);
  await page.locator("#st-flatRate").fill("61");
  await page.locator("#st-freeThreshold").fill("1500");
  const example = await page.locator('[data-settings="shipping-example"]').innerText();
  const s3 = await saveTab(page, "Save shipping");
  await open(page, "/admin/settings/shipping");
  drill.check(s3 === 200 && (await value(page, "st-flatRate")) === "61" && (await value(page, "st-freeThreshold")) === "1500" && /₹61/.test(example) && /₹1,500 or more ships free/.test(example), "Shipping: saved, reloaded, kept; the worked example in words", { s3, example });
  await drill.shoot(page, "admin-shipping");

  // Tracking
  await open(page, "/admin/settings/tracking");
  await page.locator("#st-meta-test").fill(`TEST${stamp}`);
  const s4 = await saveTab(page, "Save tracking");
  await open(page, "/admin/settings/tracking");
  drill.check(s4 === 200 && (await value(page, "st-meta-test")) === `TEST${stamp}`, "Tracking: saved, reloaded, kept", { s4 });

  // Domains and SEO loads (a list, an empty state or the no-platform words, never an error)
  await open(page, "/admin/settings/domains");
  const domains = page.locator('[data-settings-tab="domains"]');
  await page.waitForFunction(() => !document.querySelector('[data-settings-tab="domains"] [aria-busy="true"]'), null, { timeout: 30_000 }).catch(() => {});
  drill.check((await domains.count()) === 1 && (await domains.getByRole("alert").count()) === 0, "Domains and SEO loads without an error");

  // an old anchor lands on its tab
  await page.goto(`${ORIGIN}/admin/settings#payments`, { waitUntil: "load" });
  const moved = await page.waitForURL((u) => new URL(u).pathname === "/admin/settings/checkout", { timeout: 30_000 }).then(() => true, () => false);
  drill.check(moved, "an old /admin/settings#payments link lands on Checkout and payments", page.url());

  // the banner is for signed-in members: the admin sees it
  await open(page, "/admin/settings");
  drill.check(/Platform support access is active/.test(await page.locator("body").innerText()), "signed in, the admin sees the support-access banner");
  await page.context().close();
}

async function deniedRoles(drill) {
  for (const role of ["staff", "support"]) {
    const page = await signIn(drill, role);
    const bad = [];
    for (const path of GATED) {
      await open(page, path);
      const body = await page.locator("main").innerText();
      if (!body.includes(NO_ACCESS) || (await page.locator("[data-settings-tab]").count()) > 0 || (await page.getByRole("navigation", { name: "Settings sections" }).count()) > 0) bad.push(path);
    }
    drill.check(bad.length === 0, `${role}: every settings, integrations and billing URL shows the no-access page and nothing else`, bad);
    await drill.shoot(page, `${role}-no-access`);
    await page.context().close();
  }
}

async function signedOutBanner(drill, grantReason) {
  const { ctx, page } = await context(drill, "signed-out");
  await open(page, "/admin/login");
  const text = await page.locator("body").innerText();
  drill.check(!/Platform support access/.test(text) && !text.includes(grantReason), "signed out with a grant open: /admin/login shows no support-access banner, no operator and no reason");
  await drill.shoot(page, "signed-out-login");
  await ctx.close();
}

// an operator's support grant on the roles store, straight in its control plane
async function openGrant() {
  const info = readPidfile(join(ROOT, ".design-data-roles"));
  if (!info?.ports?.sqld?.platform) throw new Error("drill:settings needs the roles harness's control plane (its pid file)");
  process.env.PLATFORM_DB_URL = dbUrl(info.ports.sqld.platform);
  process.env.PLATFORM_DB_TOKEN = "";
  const { platformDb } = await import("../../../lib/platform/control.js");
  const rows = (await platformDb().execute("SELECT id, domains FROM tenants")).rows;
  const tenant = rows.find((r) => String(r.domains || "").includes("roles.localhost"));
  if (!tenant) throw new Error("no roles.localhost store in the control plane");
  const { createSupportGrant, revokeSupportGrant } = await import("../../../lib/platform/support.js");
  const reason = `settings drill grant ${Date.now()}`;
  const grant = await createSupportGrant({ tenantId: tenant.id, reason, hours: 1, operator: "op_settings_drill" });
  return { reason, close: () => revokeSupportGrant(grant.id, { operator: "op_settings_drill" }).catch(() => {}) };
}

async function settings(drill) {
  if (!port) throw new Error("drill:settings needs ROLES_PORT (run it as pnpm drill:settings).");
  const grant = await openGrant();
  try {
    await adminFlows(drill);
    await deniedRoles(drill);
    await signedOutBanner(drill, grant.reason);
  } finally {
    await grant.close();
  }
  drill.check(consoleErrors.length === 0, "no error in the browser console", consoleErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "SETTINGS — settings tabs, integrations and billing, every role" }, settings).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
