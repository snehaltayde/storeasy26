// PLATFORM-OPS: `pnpm drill:platform-ops`, the operator's Operations page
// (Phase 3 line 6, docs/plans/phase-3.md "Line 6"). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree after it seeds the
// --p3 design store; this starts the harness. Never in the owner's checkout:
// the erasure step scrubs a seeded shopper in the throwaway store only.
// Steps:
//   1. signed out, and a merchant's token in _platform: /platform/operations
//      goes to the sign-in, with no shell and no operations data
//   2. an operator (a seeded, enrolled operator session) opens Operations from
//      the nav: the Queues tab, marked current, without an error
//   3. Queues: a seeded dead job is retried (it leaves the dead list) and a
//      second is discarded through the confirmation
//   4. Provisioning runs: a seeded failed run is abandoned after typing its id;
//      the page holds no founder email or database address
//   5. Privacy requests: a seeded request shows its store's name and no
//      shopper email or phone; the erase button stays off until the store's
//      name is typed; erasure marks it done
//   6. Themes: the kits and the store pins render
//   7. Case studies: a new draft is saved, Publish is refused with the gate's
//      reasons, and the study is deleted through the confirmation
//   8. at 375 the tabs and tables have no sideways page scroll
//   9. every write left an audit row naming the operator
// Results: docs/cms-reviews/drills/PLATFORM-OPS/results-main.json and screenshots.
import { createHash, randomBytes } from "node:crypto";
import { runDrill, settle, startOwned } from "../p3/lib.mjs";
import { harnessPorts, harnessUrls } from "../../design-harness.js";

const DRILL_ID = "PLATFORM-OPS";
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const ports = harnessPorts();
const platformUrl = harnessUrls(ports).platform;
const CONSOLE = `http://localhost:${ports.next}`;
const at = (path) => new URL(path, CONSOLE).href;
const text = (page) => page.locator("body").innerText().catch(() => "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SHELL = '[data-shell="platform"]';
const CANARY_EMAIL = "ops-drill-shopper@canary.test";
const CANARY_PHONE = "9123400567";
const CANARY_FOUNDER = "ops-drill-founder@canary.test";
const CANARY_DB = "libsql://ops-drill-canary.turso.io";

async function dbSql(url, statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url });
  try {
    const out = [];
    for (const s of statements) out.push(await c.execute(s));
    return out;
  } finally {
    c.close();
  }
}
const platformSql = (statements) => dbSql(platformUrl, statements);
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

async function newPage(drill, cookies = [], width = 1280) {
  const ctx = await drill.browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  if (cookies.length) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const seen = new Set();
  const say = (t) => !seen.has(t) && seen.add(t) && drill.note(`browser: ${t.slice(0, 400)}`);
  page.on("pageerror", (e) => say(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && say(`console error: ${m.text()}`));
  return { ctx, page };
}
const platformCookie = (token) => [{ name: "_platform", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }];

async function userWithSession({ operator, name }) {
  const id = `u_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await platformSql([
    { sql: "INSERT INTO users (id, email, name, password_hash, is_operator, totp_confirmed, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'active', ?, ?)", args: [id, `${id}@platform-ops.test`, name, operator ? 1 : 0, operator ? 1 : 0, now, now] },
    { sql: "INSERT INTO sessions (id, token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", args: [`s_${randomBytes(8).toString("hex")}`, sha(token), id, operator ? "operator" : "merchant", now, new Date(Date.now() + 3600_000).toISOString()] },
  ]);
  return { id, token };
}

async function seed() {
  const now = new Date().toISOString();
  const store = await one("SELECT id, name, db_url FROM tenants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1");
  if (!store) throw new Error("the --p3 seed has no active store");
  await platformSql([
    ...["job_drill_retry", "job_drill_discard"].map((id) => ({
      sql: `INSERT INTO jobs (id, type, tenant_id, payload, idempotency_key, status, attempts, max_attempts, last_error, created_at, updated_at) VALUES (?, 'noop_drill', ?, '{}', ?, 'dead', 5, 5, 'drill: boom', ?, ?)`,
      args: [id, store.id, `drill:${id}`, now, now],
    })),
    {
      sql: `INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, error, created_at, updated_at) VALUES ('run_drill_failed', 'drill-ghost', 'failed', ?, ?, ?, 'create_db: quota', ?, ?)`,
      args: [JSON.stringify([{ name: "create_db", status: "failed", detail: "quota" }]), JSON.stringify({ dbUrl: CANARY_DB }), JSON.stringify({ id: "drill-ghost", supportEmail: CANARY_FOUNDER, dbUrl: CANARY_DB, source: "operator" }), now, now],
    },
  ]);
  await dbSql(String(store.db_url), [
    { sql: "INSERT INTO privacy_requests (id, kind, email, phone, status, created_at) VALUES ('pr_drill_one', 'customer_redact', ?, ?, 'manual', ?)", args: [CANARY_EMAIL, CANARY_PHONE, now] },
  ]);
  return { id: String(store.id), name: String(store.name || store.id), dbUrl: String(store.db_url) };
}

const noCanary = (body) => ![CANARY_EMAIL, CANARY_PHONE, CANARY_FOUNDER, CANARY_DB].some((c) => body.includes(c));

async function openTab(page, label) {
  await page.getByRole("tab", { name: label }).click();
  await settle(page);
}

async function platformOps(drill) {
  await startOwned();
  const store = await seed();

  // 1. signed out, and a merchant's token
  for (const [who, cookies] of [["signed out", []], ["a merchant token in _platform", platformCookie((await userWithSession({ operator: false, name: "Merchant" })).token)]]) {
    const { ctx, page } = await newPage(drill, cookies);
    await page.goto(at("/platform/operations"), { waitUntil: "load" });
    const moved = await until(async () => new URL(page.url()).pathname === "/platform");
    drill.check(Boolean(moved), `${who}: /platform/operations goes to the sign-in`, page.url());
    await page.locator("#pl-password").waitFor();
    const body = await text(page);
    drill.check((await page.locator(SHELL).count()) === 0 && !/Operations|Dead letter|Provisioning runs/.test(body), `${who}: no shell and no operations data`, body.slice(0, 200));
    const api = await page.evaluate(async () => (await fetch("/api/platform/privacy")).status);
    drill.check(api === 401, `${who}: the privacy API answers 401`, api);
    await ctx.close();
  }

  // 2. an operator opens Operations from the nav
  const op = await userWithSession({ operator: true, name: "Ops Drill" });
  const { ctx, page } = await newPage(drill, platformCookie(op.token));
  await page.goto(at("/platform"), { waitUntil: "load" });
  await page.locator(SHELL).waitFor();
  await page.locator('[data-nav-item="operations"]').click();
  await page.waitForURL((u) => u.pathname === "/platform/operations");
  await page.locator('[data-ops-tab="queues"]').waitFor();
  await settle(page);
  drill.check((await page.locator('[data-nav-item="operations"][aria-current="page"]').count()) === 1, "the nav opens Operations, marked current", null);
  drill.check(!ERROR_TEXT.test(await text(page)), "Operations renders on the new UI without an error", null);
  await drill.screenshot(page, "01-queues");

  // 3. Queues: retry one dead job, discard another
  await page.getByRole("button", { name: "Dead letters only" }).click();
  await page.getByRole("button", { name: "Retry job_drill_retry" }).click();
  const retried = await until(async () => (await one("SELECT status FROM jobs WHERE id = 'job_drill_retry'"))?.status !== "dead");
  drill.check(Boolean(retried), "Retry takes a dead job off the dead list", null);
  await page.getByRole("button", { name: "Discard job_drill_discard" }).click();
  await page.locator("[data-ops-confirm]").click();
  const discarded = await until(async () => (await one("SELECT status FROM jobs WHERE id = 'job_drill_discard'"))?.status === "discarded");
  drill.check(Boolean(discarded), "Discard, confirmed, marks the dead job discarded", null);
  await drill.screenshot(page, "02-queues-after");

  // 4. Provisioning runs: abandon after typing the run id
  await openTab(page, "Provisioning runs");
  await page.locator('[data-ops-run="run_drill_failed"]').waitFor();
  drill.check(noCanary(await page.content()), "provisioning runs: no founder email or database address on the page", null);
  await page.locator('[data-ops-run="run_drill_failed"]').getByRole("button", { name: "Abandon" }).click();
  drill.check(await page.locator("[data-ops-confirm]").isDisabled(), "Abandon stays off until the run id is typed", null);
  await page.locator("#ops-confirm-text").fill("run_drill_failed");
  await page.locator("[data-ops-confirm]").click();
  const abandoned = await until(async () => (await one("SELECT status FROM provision_runs WHERE id = 'run_drill_failed'"))?.status === "compensated");
  drill.check(Boolean(abandoned), "the failed run is abandoned", null);
  await drill.screenshot(page, "03-provisioning");

  // 5. Privacy: no shopper details; typed store name before erasure
  await openTab(page, "Privacy requests");
  const row = page.getByRole("button", { name: `Carry out request pr_drill_one for ${store.name}` });
  await row.waitFor();
  drill.check(noCanary(await page.content()), "privacy: no shopper email or phone on the page", null);
  await drill.screenshot(page, "04-privacy");
  await row.click();
  drill.check(await page.locator("[data-ops-confirm]").isDisabled(), "erasure stays off until the store's name is typed", null);
  await page.locator("#ops-confirm-text").fill("not the name");
  drill.check(await page.locator("[data-ops-confirm]").isDisabled(), "a wrong name keeps it off", null);
  await page.locator("#ops-confirm-text").fill(store.name);
  await drill.screenshot(page, "05-privacy-confirm");
  await page.locator("[data-ops-confirm]").click();
  const done = await until(async () => (await dbSql(store.dbUrl, [{ sql: "SELECT status FROM privacy_requests WHERE id = 'pr_drill_one'", args: [] }]))[0].rows[0]?.status === "done");
  drill.check(Boolean(done), "erasure marks the request done", null);

  // 6. Themes
  await openTab(page, "Themes");
  await page.locator('[data-ops-tab="themes"] table').first().waitFor();
  drill.check((await text(page)).includes(store.id) && !ERROR_TEXT.test(await text(page)), "themes: the kits and the store pins render", null);
  await drill.screenshot(page, "06-themes");

  // 7. Case studies: a draft, a refused publish, a delete
  await openTab(page, "Case studies");
  await page.getByRole("button", { name: "New case study" }).click();
  await page.locator("#cs-slug").fill("drill-study");
  await page.locator("#cs-title").fill("Drill study");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Publish Drill study" }).waitFor();
  drill.check(Boolean(await one("SELECT 1 AS x FROM case_studies WHERE slug = 'drill-study' AND published = 0")), "a new case study saves as a draft", null);
  await page.getByRole("button", { name: "Publish Drill study" }).click();
  const refused = await page.locator('[data-ops-notice="error"]').waitFor({ timeout: 15_000 }).then(() => page.locator('[data-ops-notice="error"]').innerText(), () => "");
  drill.check(/can't be published yet/.test(refused) && /consent/.test(refused), "Publish without consent and measurements is refused, with the reasons", refused);
  await drill.screenshot(page, "07-case-study-refused");
  await page.getByRole("button", { name: "Delete Drill study" }).click();
  await page.locator("[data-ops-confirm]").click();
  const deleted = await until(async () => !(await one("SELECT 1 AS x FROM case_studies WHERE slug = 'drill-study'")));
  drill.check(Boolean(deleted), "Delete, confirmed, removes the study", null);

  // 8. phones
  await page.setViewportSize({ width: 375, height: 812 });
  for (const label of ["Queues", "Privacy requests"]) {
    await openTab(page, label);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    drill.check(!sideways, `at 375 the ${label} tab has no sideways page scroll`, null);
  }
  await drill.screenshot(page, "08-375");
  await ctx.close();

  // 9. the audit trail names the operator
  for (const [action, resource] of [["queue.replay", "job:job_drill_retry"], ["queue.discard", "job:job_drill_discard"], ["tenant.provision", "run:run_drill_failed"], ["privacy.redact", "privacy:pr_drill_one"], ["case_study.save", "case:drill-study"], ["case_study.delete", "case:drill-study"]]) {
    const row = await one("SELECT actor, actor_kind FROM audit_log WHERE action = ? AND resource = ? ORDER BY at DESC LIMIT 1", [action, resource]);
    drill.check(row?.actor === op.id && row?.actor_kind === "operator", `${action} is audited with the operator's id`, row);
  }
}

runDrill({ id: DRILL_ID, part: "main", title: "PLATFORM-OPS — queues, provisioning runs, privacy requests, themes and case studies on the new UI" }, platformOps).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
