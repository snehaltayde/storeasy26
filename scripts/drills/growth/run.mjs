// GROWTH: `pnpm drill:growth`, analytics, experiments, insights and
// automations on the new UI in a real browser (Phase 2 line 9,
// docs/plans/phase-2.md "Line 9" Drill). Run by scripts/drills/run-isolated.mjs
// in a throwaway worktree on its own roles store; never in the owner's checkout.
//   admin: creates an experiment in the sheet (weights add up to 100) and
//     starts it from its page (asks first); it shows Running
//   staff: on a draft, Start is disabled with the reason (D6: starting needs
//     storefront.publish); clicking it sends nothing
//   support: a read pass on analytics (each range), experiments, one
//     experiment and insights: no write control, every control a marked read,
//     and clicking every read sends no non-GET request
//   staff: automations is the no-access page
// Insights never call an AI provider: the roles store has none set up, and the
// drill only checks the "not set up" state.
// Evidence: docs/cms-reviews/drills/GROWTH/ (results-main.json, screenshots).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "GROWTH";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
const STAMP = Date.now().toString(36);
const ADMIN_EXP = `drill-hero-${STAMP}`;
const STAFF_EXP = `drill-staff-${STAMP}`;

const consoleErrors = [];
async function signIn(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/eval\(\) is not supported/.test(msg.text())) consoleErrors.push(`${role}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${role}: ${String(e?.message || e).slice(0, 300)}`));
  return page;
}
const open = async (page, path) => {
  const r = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  return r;
};
const waitFor = (page, fn, arg, ms = 30_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const writes = (page) => {
  const out = [];
  page.on("request", (r) => {
    const m = r.method();
    if (m !== "GET" && m !== "HEAD" && !new URL(r.url()).pathname.startsWith("/__nextjs")) out.push(`${m} ${new URL(r.url()).pathname}`);
  });
  return out;
};

async function adminStarts(drill) {
  const page = await signIn(drill, "admin");
  await open(page, "/admin/experiments");
  await page.getByRole("button", { name: "New experiment" }).click();
  const form = page.locator('[data-experiment="form"]');
  await form.waitFor({ timeout: 10_000 });
  await form.locator("#exp-name").fill(`Drill hero ${STAMP}`);
  await form.locator("#exp-slug").fill(ADMIN_EXP);
  await form.locator("#exp-hypothesis").fill("A shorter hero title gets more orders");
  await form.locator("#exp-v1-title").fill("Shorter title");
  await form.locator("#exp-v1-weight").fill("40");
  const off = await form.locator('[data-experiment="weight-total"]').innerText();
  const blocked = await form.getByRole("button", { name: "Save draft" }).isDisabled();
  drill.check(/90%/.test(off) && blocked, "the form says the weights add up to 90% and Save waits for 100%", { off, blocked });
  await form.locator("#exp-v0-weight").fill("60");
  await form.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(new RegExp(`/admin/experiments/${ADMIN_EXP}$`), { timeout: 30_000 }).catch(() => {});
  await settle(page);
  drill.check(new URL(page.url()).pathname === `/admin/experiments/${ADMIN_EXP}`, "saving opens the experiment's page", page.url());
  await drill.shoot(page, "admin-draft");
  await page.locator('[data-experiment-action="start"]').click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Start experiment" }).click();
  const running = await waitFor(page, () => document.querySelector('[data-experiment-status="running"]'));
  drill.check(running, "admin starts it (after the confirm) and it shows Running");
  await drill.shoot(page, "admin-running");
  await page.context().close();
}

async function staffSeesReason(drill) {
  const page = await signIn(drill, "staff");
  const saved = await page.evaluate(async (slug) => {
    const r = await fetch("/api/admin/experiments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment: { slug, name: "Staff draft", hypothesis: "Staff idea", target_kind: "hero", min_sample: 50, variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "Staff title" } }] } }),
    });
    return r.status;
  }, STAFF_EXP);
  drill.check(saved === 200, "staff saves a draft", saved);
  await open(page, `/admin/experiments/${STAFF_EXP}`);
  const sent = writes(page);
  const start = page.locator('[data-experiment-action="start"]');
  const gate = { count: await start.count(), disabled: await start.getAttribute("aria-disabled"), role: await start.getAttribute("data-role-gate") };
  await start.focus();
  const tip = await page.getByRole("tooltip").first().innerText({ timeout: 5_000 }).catch(() => "");
  await start.click({ force: true });
  await page.waitForTimeout(500);
  drill.check(gate.count === 1 && gate.disabled === "true" && gate.role === "disabled" && /owner or admin/.test(tip), "staff sees Start disabled with the reason", { ...gate, tip });
  drill.check(sent.length === 0, "clicking staff's Start sends nothing", sent);
  await drill.shoot(page, "staff-start-reason");
  await open(page, "/admin/automations");
  const note = await page.locator("main").innerText();
  drill.check(/Your role \(staff\) can.t view automations/.test(note) && (await page.locator("main table").count()) === 0, "staff gets the no-access page on automations", note.slice(0, 200));
  await page.context().close();
}

// In the page: controls in main that are neither a marked read nor disabled.
function strays() {
  const q = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
  return [...document.querySelectorAll(`main ${q.split(", ").join(", main ")}`)]
    .filter((el) => !el.hasAttribute("data-read-control") && el.disabled !== true && !(el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled"))
    .map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
}

async function supportReadPass(drill) {
  const page = await signIn(drill, "support");
  const sent = writes(page);
  const paths = ["/admin/analytics", "/admin/analytics?days=7", "/admin/analytics?days=90", "/admin/experiments", `/admin/experiments/${ADMIN_EXP}`, "/admin/insights"];
  for (const path of paths) {
    const r = await open(page, path);
    const s = await page.evaluate(strays);
    const words = await page.locator("main").innerText();
    drill.check(r?.status() === 200 && s.length === 0 && !/New experiment|Generate ideas|Apply as draft|Dismiss|Keep it as a draft/.test(words), `support ${path}: no write control, every control a marked read`, s);
    const reads = await page.locator("main [data-read-control]").count();
    for (let i = 0; i < reads; i++) {
      const el = page.locator("main [data-read-control]").nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(150);
      if (page.url() !== ORIGIN + path) await open(page, path);
    }
    if (path === "/admin/insights") drill.check(/aren.t set up/.test(words), "insights: the not-set-up state (no AI provider is called)", words.slice(0, 300));
    await drill.shoot(page, `support-${path.replace(/[^a-z0-9]+/gi, "-")}`);
  }
  drill.check(sent.length === 0, "support's read pass sends no non-GET request", sent);
  await page.context().close();
}

async function growth(drill) {
  if (!port) throw new Error("drill:growth needs ROLES_PORT (run it as pnpm drill:growth).");
  await adminStarts(drill);
  await staffSeesReason(drill);
  await supportReadPass(drill);
  drill.check(consoleErrors.length === 0, "no error in the browser console (admin, staff and support)", consoleErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "GROWTH — analytics, experiments, insights and automations, every role" }, growth).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
