// P6-DRILLS: shared helpers for the phase 6 drills (GEN-01, GEN-04, PUB-12;
// US-01, US-04, US-41), in desktop Chrome on the design harness
// (docs/cms-reviews/P1-HARNESS.md). Everything the phase 3, 4 and 5 helpers
// give (scripts/drills/p5/lib.mjs, imported and re-exported, never edited),
// plus what phase 6 needs. Not a test:* suite: drills need a harness and Chrome.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p6/run.mjs [stage,…]
//   node scripts/drills/p6/lib.mjs --check     the helpers' own checks (no harness)
//
// Added here:
//   DRILL_ID, OUT                 "P6-DRILLS" and its results folder
//   stageEnv()                    this process's env with every Shopify,
//                                 payment and AI key blank (the seed and the
//                                 harness both get it)
//   reseedP6(drill, stage, opts)  stops the harness this run started, seeds one
//                                 stage (seed-design-documents.js --p6 --stage
//                                 <s> [--variant v]) and starts the harness
//                                 again. Returns the seed config.
//   readP6Seed(), p6Check()       .design-data/p6-seed.json; check --p6 (read)
//   p6Url(drill, path)            an address on p6.localhost (this run's port)
//   p6Context(drill, {width})     a fresh context whose base is p6.localhost
//   loginP6(drill, ctx)           the founder through the real sign-in form
//   p6Sql(stmts)                  the p6 store's local database (read and
//                                 check; never a hosted one)
//   docsOf(), docOf(id)           the p6 store's documents rows
//   watchHosts(ctx)               every host the browser asked for in a context
//   cssVarsOf(frameOrPage)        the storefront's computed brand variables
//   frameOf(page)                 the editor's preview frame
//   logoFacts(scope)              header and footer logo <img>s (src, alt)
//   isLime(hex)                   lib/themes/palettes.js isLimeish
//   rscProbe(opts)                P3-CLOSED's RSC probe, made reusable: the
//                                 store's content strings, then anonymous HTML
//                                 and RSC: 1 requests on the probe's routes with
//                                 four cookie sets; every answer must carry none
//   closedPageFacts(drill, host)  the storefront a shopper gets (closed page?)
//   placeTestOrder(drill, page)   a cash on delivery order (snehal@mediastic.in)
//                                 placed in the founder's preview, then cancelled
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT, dbUrl, harnessPorts } from "../../design-harness.js";
import { DrillError, TEST_ORDER_EMAIL, assertLocal, noThanks, runNode, selfCheck as p5SelfCheck, settle, sleep, sqlAt, startOwned, stopOwned, waitFor } from "../p5/lib.mjs";
import { P6_STORE, REAL_KEYS, realKeysSet, stagePlan } from "./seed-p6.mjs";

export * from "../p5/lib.mjs";
export { P6_STORE, P6_LOGIN, P6_RETURNS_DAYS, P6_LOGO_MEDIA, P6_PRODUCTS, logoPng } from "./seed-p6.mjs";

export const DRILL_ID = "P6-DRILLS";
export const OUT = join(ROOT, "docs", "cms-reviews", "drills", DRILL_ID);
export const P6_SEED_PATH = join(ROOT, DATA_DIR_NAME, "p6-seed.json");
export const LIME = "#84cc16";
export const AI_HOST = "api.anthropic.com";

// ---------- the environment ----------

// Every key that could reach Shopify, a payment provider or the AI service,
// blank. The harness's own env (scripts/design-harness.js harnessEnv) blanks
// Shopify and Razorpay already; ANTHROPIC_API_KEY it passes through, so the
// drill blanks it here (US-01: the store is made with no AI key).
export const AI_KEYS = Object.freeze(["ANTHROPIC_API_KEY"]);
export function stageEnv(env = process.env) {
  const out = { ...env };
  for (const k of [...REAL_KEYS, ...AI_KEYS]) out[k] = "";
  return out;
}
export function blankKeysHere() {
  for (const k of [...REAL_KEYS, ...AI_KEYS]) process.env[k] = "";
}

// ---------- the seed ----------

export function readP6Seed() {
  try {
    return JSON.parse(readFileSync(P6_SEED_PATH, "utf8"));
  } catch {
    throw new DrillError(`There is no phase 6 seed config (${DATA_DIR_NAME}/p6-seed.json). Run the drills with pnpm drill:p6, which seeds a throwaway worktree.`);
  }
}

export async function p6Check() {
  const r = await runNode([join(ROOT, "scripts", "seed-design-documents.js"), "check", "--p6"], { env: stageEnv() });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith('{"p6"')).pop();
  if (r.code !== 0 || !line) throw new DrillError(`check --p6 failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`);
  return JSON.parse(line).p6;
}

// Stop the harness this run started, seed one stage, start it again.
export async function reseedP6(drill, stage, { variant = null, start = true } = {}) {
  stagePlan(stage, variant);
  const real = realKeysSet();
  if (real.length) throw new DrillError(`Refusing stage ${stage}: this shell names a Shopify store or a payment secret (${real.join(", ")}).`);
  await stopOwned();
  const args = [join(ROOT, "scripts", "seed-design-documents.js"), "--p6", "--stage", stage, ...(variant ? ["--variant", variant] : [])];
  const r = await runNode(args, { env: stageEnv() });
  const line = r.out.split("\n").filter((l) => /^[✓✗]/.test(l)).pop() || r.out.trim().split("\n").pop();
  if (r.code !== 0) throw new DrillError(`seeding phase 6 stage ${stage}${variant ? ` (${variant})` : ""} failed: ${line}`);
  if (start) {
    // next dev now and then takes longer than the 3 minutes connectHarness
    // waits on a cold start (seen once in a full run): one more try, said so
    try {
      await startOwned();
    } catch (e) {
      drill?.note(`the harness didn't come up the first time (${String(e?.message || e).slice(0, 120)}); starting it once more`);
      await stopOwned();
      await startOwned();
    }
    // the p6 host's first request compiles the console and storefront routes
    await fetch(p6UrlAt(harnessPorts().next, "/")).catch(() => {});
  }
  drill?.note(`seeded (--p6 --stage ${stage}${variant ? ` --variant ${variant}` : ""}): ${String(line).replace(/^✓ /, "")}`);
  return readP6Seed();
}

// ---------- addresses, contexts, sign-in ----------

const p6UrlAt = (port, path = "/") => `http://${P6_STORE.host}:${port}${path}`;
export const p6Origin = (drill) => p6UrlAt(drill.harness.port);
export const p6Url = (drill, path = "/") => assertLocal(p6UrlAt(drill.harness.port, path));

export async function p6Context(drill, { width = 1440 } = {}) {
  const ctx = await drill.browser.newContext({ baseURL: p6Origin(drill), viewport: { width, height: width >= 1024 ? 900 : 812 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  return ctx;
}

// The founder, through the real sign-in form, by email (fresh password each seed).
export async function loginP6(drill, ctx) {
  const seed = readP6Seed();
  const page = await ctx.newPage();
  const res = await page.goto(p6Url(drill, "/admin/login"), { waitUntil: "load", timeout: 120_000 });
  if (!(await page.locator("#login-email").waitFor({ timeout: 60_000 }).then(() => true, () => false))) {
    const { loginDiag } = await import("../p3/lib.mjs");
    await loginDiag(drill, page, res, p6Url(drill, "/admin/login"), "p6owner").catch((e) => console.error("diag failed", e));
  }
  await page.locator("#login-email").fill(seed.logins.owner.email);
  await page.locator("#login-password").fill(seed.logins.owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await page.waitForURL((u) => /^\/admin\/(?!login)/.test(new URL(u).pathname), { timeout: 60_000 });
  } catch {
    throw new DrillError("Signing in as the p6 founder didn't reach the console. Reseed the stage (the login is made fresh by every seed).");
  }
  await settle(page);
  return page;
}

// ---------- the p6 store's database ----------

export const p6DbUrl = () => assertLocal(dbUrl(harnessPorts().sqld.default));
export const p6Sql = (stmts) => sqlAt(p6DbUrl(), stmts);
export const platformSql = (stmts) => sqlAt(assertLocal(dbUrl(harnessPorts().sqld.platform)), stmts);
const rowsOf = (r) => r.rows.map((x) => ({ ...x }));
export async function docsOf() {
  return rowsOf((await p6Sql(["SELECT id, type, slug, label, revision, updated_by, published_version_id, draft_hash, published_hash, archived_at FROM documents ORDER BY id"]))[0]);
}
export async function docOf(id) {
  const r = rowsOf((await p6Sql([{ sql: "SELECT id, type, slug, label, revision, updated_by, published_version_id, draft, draft_hash FROM documents WHERE id = ?", args: [id] }]))[0])[0];
  return r ? { ...r, body: JSON.parse(r.draft || "null") } : null;
}
export async function liveRelease() {
  return (await p6Sql(["SELECT live_release_id AS id FROM release_state WHERE id = 1"]))[0].rows[0]?.id ?? null;
}
export async function tenantConfig() {
  const r = (await platformSql([{ sql: "SELECT config FROM tenants WHERE id = ?", args: [P6_STORE.id] }]))[0].rows[0];
  return r ? JSON.parse(r.config) : null;
}

// fn() inside withTenant(p6) in THIS process, against the running harness's
// local databases only (withHarnessStore, write: false, as P5's inStore).
export async function inP6(fn) {
  const { withHarnessStore } = await import("../../seed-design-documents.js");
  return withHarnessStore(
    async ({ urls }) => {
      for (const u of Object.values(urls)) assertLocal(u);
      const C = await import("../../../lib/platform/control.js");
      const { withTenant } = await import("../../../lib/tenant-context.js");
      const t = await C.getTenant(P6_STORE.id, { fresh: true });
      assertLocal(t.dbUrl || t.db_url);
      return withTenant(t, fn);
    },
    { write: false },
  );
}

// ---------- what the browser does ----------

// Every request the browser makes in this context: [{ host, url, method }].
export function watchHosts(ctx) {
  const seen = [];
  ctx.on("request", (r) => {
    try {
      const u = new URL(r.url());
      seen.push({ host: u.host, hostname: u.hostname, url: r.url().slice(0, 200), method: r.method() });
    } catch {}
  });
  return seen;
}

// Page errors in a context (every page, now and later).
export function watchErrors(ctx) {
  const errors = [];
  const hook = (p) => p.on("pageerror", (e) => errors.push(String(e?.message || e).slice(0, 300)));
  for (const p of ctx.pages()) hook(p);
  ctx.on("page", hook);
  return errors;
}

export const frameOf = (page) => page.frameLocator("[data-preview-frame]");

// The brand variables a storefront page computes (page or the editor's frame).
const VARS = ["--accent-500", "--sf-accent", "--background", "--sf-text", "--sf-text-muted"];
export async function cssVarsOf(target) {
  return target.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  }, VARS);
}
// the same, inside the editor's preview frame
export async function frameCssVars(page) {
  const h = await page.locator("[data-preview-frame]").elementHandle();
  const f = h ? await h.contentFrame() : null;
  if (!f) return null;
  return cssVarsOf(f);
}
export async function frameEval(page, fn, arg) {
  const h = await page.locator("[data-preview-frame]").elementHandle();
  const f = h ? await h.contentFrame() : null;
  if (!f) return null;
  return f.evaluate(fn, arg);
}

// The logo <img>s in the header and footer: { header: [{src, alt}], footer: [...] }
export const LOGO_FACTS = () => {
  const imgs = (sel) => [...document.querySelectorAll(`${sel} img`)].filter((i) => /\/api\/media\//.test(i.getAttribute("src") || "")).map((i) => ({ src: i.getAttribute("src"), alt: i.getAttribute("alt"), ok: i.complete && i.naturalWidth > 0 }));
  const words = (sel) => (document.querySelector(sel)?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
  return { header: imgs("header"), footer: imgs("footer"), headerText: words("header"), footerText: words("footer"), headerLinks: [...document.querySelectorAll("header a")].map((a) => [a.innerText.trim(), a.getAttribute("href")]).filter(([t]) => t), footerLinks: [...document.querySelectorAll("footer a")].map((a) => [a.innerText.trim(), a.getAttribute("href")]).filter(([t]) => t) };
};

// lib/themes/palettes.js isLimeAccent, for "#rrggbb" or "rgb(r, g, b)".
export async function isLime(value) {
  const P = await import("../../../lib/themes/palettes.js");
  let hex = String(value || "").trim().toLowerCase();
  const m = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(hex);
  if (m) hex = `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  return hex === LIME || P.isLimeAccent(hex);
}

// ---------- the closed storefront and the RSC probe ----------

// A shopper's look at a host: the HTML of / and of a draft-only address.
export async function closedPageFacts(base) {
  assertLocal(base);
  const r = await fetch(new URL("/", base), { headers: { accept: "text/html" }, redirect: "manual" });
  const html = await r.text();
  return { status: r.status, openingSoon: html.includes("Opening soon"), bytes: html.length, html };
}

// P3-CLOSED's RSC probe (docs/cms-reviews/drills/P3-CLOSED/rsc-probe.mjs),
// made reusable: it reads every string of 10 characters or more the store's
// content holds (documents drafts and versions, the legacy blocks and pages,
// the release content), leaves out the catalog's own words (public Shopify
// data, the P3-CLOSED owner interpretation) and the store's name (which the
// closed page shows on purpose), then sends anonymous requests: the probe's 8
// routes x 4 cookie sets x (plain HTML, and RSC: 1 with a router-state header
// claiming the layout is loaded). Nothing is written. Every answer must carry
// none of the strings.
export async function rscProbe({ base, db, extraStrings = [], exclude = [] }) {
  assertLocal(base);
  assertLocal(db);
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: db });
  const rows = async (sql) => {
    try {
      return (await c.execute(sql)).rows;
    } catch {
      return [];
    }
  };
  const strings = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      // words, not identifiers: 10 characters or more with a space in them
      // (a section kind like "product_rail" or a source like "collections" is
      // the registry's vocabulary, which every page ships, not content)
      const t = v.trim();
      if (t.length >= 10 && /\s/.test(t) && !/^(https?:|\/|gid:|#|rel_|ver_|sec_|doc_|med_|system:|merchant:)/.test(t)) strings.add(t);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  const parse = (s) => {
    try {
      return JSON.parse(String(s));
    } catch {
      return null;
    }
  };
  let catalog = [];
  try {
    for (const r of await rows("SELECT draft FROM documents")) walk(parse(r.draft));
    for (const r of await rows("SELECT body FROM document_versions")) walk(parse(r.body));
    for (const r of await rows("SELECT value FROM cms_blocks")) walk(parse(r.value));
    for (const r of await rows("SELECT sections, title, description FROM cms_pages")) walk({ s: parse(r.sections), t: r.title, d: r.description });
    for (const r of await rows("SELECT content FROM releases")) walk(parse(r.content));
    catalog = (await rows("SELECT title FROM products UNION SELECT title FROM collections")).map((r) => String(r.title));
  } finally {
    c.close();
  }
  for (const s of extraStrings) strings.add(s);
  const dropped = [];
  for (const s of [...strings]) {
    if (catalog.some((t) => s.includes(t) || t.includes(s)) || exclude.some((x) => x && (s === x || x.includes(s)))) {
      strings.delete(s);
      dropped.push(s);
    }
  }
  const tree = (seg) => encodeURIComponent(JSON.stringify(["", { children: ["(storefront)", { children: [seg, { children: ["__PAGE__", {}] }] }] }]));
  const routes = ["/", "/contact", "/about", "/policies/shipping", "/campaigns/spring", "/journal", "/journal/first-post", "/collections"];
  const cookieSets = [{}, { _admin: "x" }, { _platform: "x" }, { _mx: "x" }];
  const results = [];
  for (const path of routes) {
    for (const cookies of cookieSets) {
      for (const kind of ["html", "rsc"]) {
        const headers = { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") };
        if (kind === "rsc") Object.assign(headers, { RSC: "1", "Next-Router-State-Tree": tree("collections"), "Next-Url": "/collections" });
        const res = await fetch(new URL(path, base), { headers, redirect: "manual" });
        const text = await res.text();
        const leaks = [...strings].filter((s) => text.includes(s));
        results.push({ path, kind, cookies: Object.keys(cookies).join(",") || "none", status: res.status, type: (res.headers.get("content-type") || "").split(";")[0], bytes: text.length, openingSoon: text.includes("Opening soon"), leaks });
      }
    }
  }
  return { base, contentStrings: strings.size, sample: [...strings].slice(0, 12), droppedAsCatalogOrName: dropped.length, requests: results.length, withLeaks: results.filter((r) => r.leaks.length).length, statuses: [...new Set(results.map((r) => r.status))], results };
}

// ---------- a cash on delivery test order in the founder's preview ----------

export async function noRealKeys(drill, extraEnv = {}) {
  const row = (await platformSql([{ sql: "SELECT config FROM tenants WHERE id = ?", args: [P6_STORE.id] }]))[0].rows[0] || {};
  const found = [...String(row.config || "").matchAll(/"((?:shopify|razorpay)_[a-z_]*(?:domain|token|secret|key|id)[a-z_]*)"\s*:\s*"([^"]+)"/gi)].map((m) => m[1]);
  const env = [...REAL_KEYS, ...AI_KEYS].filter((k) => String(process.env[k] ?? extraEnv[k] ?? "").trim() !== "");
  drill.check(found.length === 0 && env.length === 0, "before the test order: the p6 store's row and this run's env hold no Shopify store, no payment secret and no AI key", { found, env });
  if (found.length || env.length) throw new DrillError("refusing to place a test order: the p6 store or the env names a Shopify store or a payment secret");
}

// In the founder's own browser context (the console session and its preview
// cookie): a product into the cart, then checkout, cash on delivery, with
// snehal@mediastic.in. Card details are never entered. Returns { orderId, order }.
export async function placeTestOrder(drill, ctx, { handle, shotPrefix = "test-order" }) {
  const page = await ctx.newPage();
  await page.goto(p6Url(drill, `/products/${handle}`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await noThanks(page);
  const add = page.getByRole("button", { name: /^Add to cart/ }).first();
  await add.waitFor({ timeout: 60_000 });
  await add.click();
  await waitFor(async () => {
    const c = await page.evaluate(async () => (await fetch("/api/cart")).json()).catch(() => null);
    return c && (c.items || []).length > 0;
  }, 30_000);
  await page.goto(p6Url(drill, "/checkout"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await noThanks(page);
  await page.locator('input[name="email"]').waitFor({ timeout: 60_000 });
  const fill = { email: TEST_ORDER_EMAIL, phone: "9999999999", name: "P6 Drill Test Order", line1: "1 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" };
  for (const [k, v] of Object.entries(fill)) await page.locator(`input[name="${k}"]`).fill(v);
  await page.getByRole("button", { name: "Continue to review" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const cod = page.locator('input[type="radio"][name="method"][value="cod"], input[type="radio"][name="method"]').first();
  await cod.waitFor({ timeout: 30_000 });
  if (!(await cod.isChecked())) await cod.check();
  const codValue = await cod.getAttribute("value");
  if (codValue != null && codValue !== "cod") throw new DrillError(`the payment choice is "${codValue}", not cash on delivery: no order is placed`);
  const checkoutLinks = await page.evaluate(() => [...document.querySelectorAll("a")].map((a) => [a.innerText.trim(), a.getAttribute("href")]).filter(([, h]) => /privacy|terms/.test(h || "")));
  await drill.screenshot(page, `${shotPrefix}-payment-1440`);
  await page.getByRole("button", { name: /^Place order/ }).click();
  await page.waitForURL(/\/checkout\/confirmation/, { timeout: 60_000 }).catch(() => {});
  await settle(page);
  const orderId = decodeURIComponent((/\/checkout\/confirmation\/([^/?#]+)/.exec(page.url()) || [])[1] || "");
  if (orderId) await drill.screenshot(page, `${shotPrefix}-confirmation-1440`);
  return { page, orderId, codValue, checkoutLinks };
}

export async function orderRow(id) {
  return rowsOf((await p6Sql([{ sql: "SELECT id, status, email, payment_method, total, sync_error, sync_attempts, shopify_order_id FROM orders WHERE id = ?", args: [id] }]))[0])[0] || null;
}

// Cancel through the console's own orders route, from a signed-in page.
export async function cancelOrder(page, id, reason = "P6-DRILLS test order") {
  return page.evaluate(
    async ([oid, why]) => {
      const r = await fetch(`/api/admin/orders/${encodeURIComponent(oid)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reason: why }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [id, reason],
  );
}

// ---------- the editor's publish panel ----------

// The "Before you open your store" panel, read: phase, lead, items (id, level,
// text, buttons, link), the Open button (text, disabled), the goes-live list.
export async function readOpening(page) {
  // one read of the DOM (a locator per missing link would wait out its timeout)
  const r = await page.evaluate(() => {
    const panel = document.querySelector("[data-publish][data-phase]");
    if (!panel) return null;
    const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const items = [...panel.querySelectorAll("[data-opening-item]")].map((li) => {
      const a = li.querySelector("a[data-opening-link]");
      return { id: li.getAttribute("data-opening-item"), level: li.getAttribute("data-level"), text: clean(li.innerText), buttons: [...li.querySelectorAll("button")].map((b) => clean(b.innerText)), link: a ? a.getAttribute("href") : null, linkText: a ? clean(a.innerText) : null };
    });
    const open = panel.querySelector("button[data-open-store]");
    const status = panel.querySelector('p[role="status"]');
    const noticeLink = panel.querySelector("a[data-notice-link]");
    return {
      phase: panel.getAttribute("data-phase"),
      items,
      open: open ? { text: clean(open.innerText), disabled: open.disabled } : null,
      text: clean(panel.innerText),
      goesLive: [...panel.querySelectorAll("[data-change-list]")].map((d) => clean(d.innerText)),
      notice: status ? clean(status.innerText) : null,
      noticeLink: noticeLink ? noticeLink.getAttribute("href") : null,
    };
  });
  return r || { phase: null, items: [], open: null, text: "", goesLive: [], notice: null, noticeLink: null };
}
export const itemOf = (panel, id) => panel.items.find((i) => i.id === id) || null;

// Wait until the panel is not busy (no "Opening your store…" / "Publishing…").
export async function panelSettled(page, ms = 60_000) {
  await sleep(400);
  await waitFor(async () => {
    const busy = await page.locator("[data-publish] button[aria-busy='true'], [data-publish] button:has-text('Opening your store…'), [data-publish] button:has-text('Publishing…')").count();
    const ph = await page.locator("[data-publish][data-phase]").first().getAttribute("data-phase").catch(() => null);
    return !busy && ph && ph !== "checking";
  }, ms, 300);
  await sleep(600);
}

// Publish in the editor: the panel's first answer (opening, review, …).
export async function pressPublish(page) {
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  await waitFor(async () => (await page.locator("[data-publish][data-phase]").count()) > 0, 60_000, 200);
  await panelSettled(page);
  return readOpening(page);
}

export async function panelButton(page, name, { within = null } = {}) {
  const scope = within ? page.locator(`[data-publish] [data-opening-item="${within}"]`) : page.locator("[data-publish]");
  await scope.getByRole("button", { name, exact: true }).first().click();
  await panelSettled(page);
  return readOpening(page);
}

// ---------- the helpers' own checks ----------

export function selfCheck() {
  const out = p5SelfCheck();
  const env = stageEnv({ SHOPIFY_STORE_DOMAIN: "shop-x.example", RAZORPAY_KEY_SECRET: "x", ANTHROPIC_API_KEY: "x", OTHER: "kept" });
  out.push({ ok: [...REAL_KEYS, ...AI_KEYS].every((k) => env[k] === "") && env.OTHER === "kept", label: "stageEnv blanks every Shopify, payment and AI key and keeps the rest", detail: { blanked: [...REAL_KEYS, ...AI_KEYS].length } });
  out.push({ ok: realKeysSet({ SHOPIFY_ADMIN_TOKEN: "t" }).length === 1 && realKeysSet({}).length === 0, label: "a Shopify token in the env is noticed (the stage is refused)", detail: null });
  const refused = (() => {
    try {
      stagePlan("z");
      return false;
    } catch {
      return true;
    }
  })();
  out.push({ ok: refused && stagePlan("c").returnsWindowDays === 10 && stagePlan("d").checkoutMode === "disabled" && stagePlan("e", "refill").wipe === false, label: "the stage plans: c's returns window is 10 days, d's checkout is off, e's refill keeps the store; an unknown stage is refused", detail: null });
  return out;
}

export function ensureOut() {
  mkdirSync(OUT, { recursive: true });
  return OUT;
}
export function writeJson(name, value) {
  ensureOut();
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  return join(OUT, name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--check")) {
  const res = selfCheck();
  for (const c of res) console.log(`${c.ok ? "✓" : "✗"} ${c.label}`);
  process.exit(res.every((c) => c.ok) ? 0 : 1);
}
