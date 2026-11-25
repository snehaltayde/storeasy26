// CATALOG: `pnpm drill:catalog`, the Catalog page on the new UI in a real
// browser (Phase 2 line 3, docs/plans/phase-2.md "Line 3" §5.8). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store (4 fixture products in 2 collections, synced; the store is closed).
// Never in the owner's checkout (runDrill refuses).
//
// Sign-ins through POST /api/admin/login, one context per role.
// Owner: search, the content and stock filters (a filter with no match shows
// Clear), the product sheet (variants with SKU, collections, the price note,
// View on store and View in Shopify), "Edit content" lands on
// /admin/editor?product=<gid>; the Collections tab and one collection's
// products in Shopify's order with "Edit collection content"; the Bundles
// card links to /admin/bundles (not followed: line 4 builds that page); the
// quiz tray; Sync from Shopify enabled (not pressed: the roles store has no
// Shopify behind it).
// Staff: Sync from Shopify disabled with the reason; the quiz tray kept.
// Support (read-only): no [data-legacy] region in main, the one-line quiz
// summary, Sync disabled by RoleGate; search, filters, the sheet and the
// collection drill-down all work; the sheet says "View content" (its link is
// checked, not followed: the editor is line 6's to drill). No non-GET request
// at all.
// Results and screenshots: docs/cms-reviews/drills/CATALOG/.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "CATALOG";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const PAGE = "/admin/catalog";
const DEV_EVAL = /eval\(\) is not supported in this environment/;
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

async function signIn(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  // the shell drill's rule (scripts/drills/shell/run.mjs): every non-GET request
  // counts, except Next's dev error overlay (POST /__nextjs_*) only when the
  // server is a dev server (the page opened the HMR socket); React's dev-only
  // eval() message is dropped on a dev server only, once the pass is over
  const run = { page, writes: [], raw: [], devServer: false, devOverlay: 0 };
  page.on("websocket", (ws) => {
    if (/\/_next\/webpack-hmr/.test(ws.url())) run.devServer = true;
  });
  page.on("request", (req) => {
    if (["GET", "HEAD"].includes(req.method())) return;
    const path = new URL(req.url()).pathname;
    if (run.devServer && path.startsWith("/__nextjs")) return void run.devOverlay++;
    run.writes.push(`${req.method()} ${path}`);
  });
  page.on("console", (m) => m.type() === "error" && run.raw.push(m.text().slice(0, 300)));
  page.on("pageerror", (e) => run.raw.push(String(e.message || e).slice(0, 300)));
  Object.defineProperty(run, "errors", { get: () => run.raw.filter((e) => !(run.devServer && DEV_EVAL.test(e))) });
  return run;
}

async function open(page, path = PAGE) {
  const res = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  await page.locator('[data-catalog="products"] tbody tr').first().waitFor({ timeout: 20_000 }).catch(() => {});
  return res;
}

const rowNames = (page) => page.locator('[data-catalog="products"] tbody tr button[data-read-control]').evaluateAll((els) => els.map((e) => e.querySelector("span")?.innerText.trim()));
async function waitRows(page, want, ms = 10_000) {
  const until = Date.now() + ms;
  let got = [];
  while (Date.now() < until) {
    got = await rowNames(page);
    if (want(got)) return got;
    await page.waitForTimeout(200);
  }
  return got;
}

// interactive elements on the page (main and open sheets) that are not a
// marked read, natively disabled or RoleGate's; the shell's own controls and
// nav links are left out
function strays() {
  const q = 'a[href], button, input, select, textarea, [role="menuitem"], [role="link"], [tabindex]:not([tabindex="-1"])';
  const scopes = [document.querySelector("main"), ...document.querySelectorAll('[data-slot="sheet-content"]')].filter(Boolean);
  const ok = (el) => el.hasAttribute("data-read-control") || el.disabled === true || (el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled") || el.closest("[data-nav-item],[data-shell-control]");
  return scopes.flatMap((s) => [...s.querySelectorAll(q)]).filter((el) => !ok(el) && el.getClientRects().length).map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
}

async function common(drill, page, role) {
  const res = await open(page);
  const body = await page.locator("main").innerText();
  drill.check((res?.status() ?? 500) === 200 && !ERROR_TEXT.test(body), `${role}: /admin/catalog opens`, { status: res?.status(), body: body.slice(0, 160) });
  const facts = await page.evaluate(() => ({
    synced: document.querySelector('[data-catalog="last-synced"]')?.innerText || null,
    count: document.querySelector('[data-catalog="product-count"]')?.innerText || null,
    bundles: document.querySelector('[data-catalog="bundles-moved"] a')?.getAttribute("href") || null,
    legacy: [...document.querySelectorAll("main [data-legacy]")].map((el) => el.getAttribute("data-legacy-tray") || "region"),
    sync: (() => {
      const b = [...document.querySelectorAll('[data-catalog="sync-header"] button')].find((x) => /Sync from Shopify/.test(x.innerText));
      return b ? { gated: b.getAttribute("data-role-gate") === "disabled", disabled: b.disabled } : null;
    })(),
    quizSummary: document.querySelector("[data-quiz-summary]")?.innerText || null,
  }));
  drill.check(/^Last synced /.test(facts.synced || "") && facts.count === "4 products", `${role}: the header says when the catalog last synced and how many products`, facts);
  drill.check(facts.bundles === "/admin/bundles", `${role}: "Bundles are with your offers" links to /admin/bundles`, facts.bundles);
  const names = await rowNames(page);
  drill.check(names.length === 4, `${role}: the Products tab lists the 4 products`, names);
  return facts;
}

async function search(drill, page, role) {
  await page.locator("#catalog-search").fill("product 2");
  const got = await waitRows(page, (n) => n.length === 1);
  drill.check(got.length === 1 && /Fixture product 2/.test(got[0]), `${role}: search narrows to the match`, got);
  await page.locator("#catalog-search").fill("");
  drill.check((await waitRows(page, (n) => n.length === 4)).length === 4, `${role}: clearing the box lists them all again`);
  await page.getByRole("button", { name: /^Sold out/ }).click();
  await page.getByText("No products match", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {});
  drill.check((await page.getByText("No products match", { exact: true }).count()) === 1, `${role}: Sold out (none are) shows No products match`);
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  drill.check((await waitRows(page, (n) => n.length === 4)).length === 4, `${role}: Clear brings the products back`);
  await page.getByRole("button", { name: /^Edited/ }).click();
  await page.getByText("No products match", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {});
  drill.check((await page.getByText("No products match", { exact: true }).count()) === 1, `${role}: Edited (nothing is edited on the closed store) shows No products match`);
  await page.getByRole("button", { name: /^All/ }).click();
  await waitRows(page, (n) => n.length === 4);
}

async function sheet(drill, page, role, shot) {
  await page.locator('[data-catalog="products"] tbody tr button[data-read-control]').first().click();
  const sh = page.locator('[data-catalog="product-sheet"]');
  await sh.locator("text=/SKU FX-/").first().waitFor({ timeout: 15_000 }).catch(() => {});
  const facts = await sh.evaluate((el) => ({
    text: el.innerText,
    editor: el.querySelector("[data-editor-link]")?.getAttribute("href") || null,
    editorText: el.querySelector("[data-editor-link]")?.innerText.trim() || null,
    store: [...el.querySelectorAll("a")].find((a) => /View on store/.test(a.innerText))?.getAttribute("href") || null,
  }));
  drill.check(/SKU FX-\d/.test(facts.text) && /Fixture collection/.test(facts.text) && /Fixture Labs/.test(facts.text), `${role}: the sheet shows variants with SKU, collections and vendor`, facts.text.slice(0, 300));
  drill.check(/Price and stock change in Shopify/.test(facts.text), `${role}: the sheet carries the price and stock note`);
  drill.check(/^\/products\/fixture-product-\d$/.test(facts.store || ""), `${role}: View on store links to the product page`, facts.store);
  drill.check(/^\/admin\/editor\?product=gid%3A%2F%2Fshopify%2FProduct%2F\d+$/.test(facts.editor || ""), `${role}: the editor link is entityEditorHref({ product })`, facts.editor);
  await drill.shoot(page, shot);
  return facts;
}

async function collections(drill, page, role, shot) {
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Collections" }).click();
  await page.locator('[data-catalog="collections"] tbody tr button[data-read-control]').first().waitFor({ timeout: 15_000 }).catch(() => {});
  const rows = await page.locator('[data-catalog="collections"] tbody tr').evaluateAll((els) => els.map((r) => [...r.querySelectorAll("td")].map((td) => td.innerText.trim())));
  drill.check(rows.length === 2 && rows.every((r) => r[2] === "2"), `${role}: the Collections tab lists 2 collections with 2 products each`, rows);
  await page.locator('[data-catalog="collections"] tbody tr button[data-read-control]').first().click();
  const sh = page.locator('[data-catalog="collection-sheet"]');
  await sh.locator("[data-editor-link]").waitFor({ timeout: 15_000 }).catch(() => {});
  await sh.locator('tbody tr:not([data-kit="skeleton-row"])').first().waitFor({ timeout: 15_000 }).catch(() => {});
  const facts = await sh.evaluate((el) => ({
    order: [...el.querySelectorAll("tbody tr")].map((r) => r.querySelectorAll("td")[0]?.innerText.trim()),
    editor: el.querySelector("[data-editor-link]")?.getAttribute("href") || null,
    editorText: el.querySelector("[data-editor-link]")?.innerText.trim() || null,
  }));
  drill.check(facts.order.join(",") === "1,2", `${role}: a collection lists its products in position order`, facts.order);
  drill.check(/^\/admin\/editor\?collection=gid%3A%2F%2Fshopify%2FCollection%2F\d+$/.test(facts.editor || ""), `${role}: the collection's editor link is entityEditorHref({ collection })`, facts.editor);
  await drill.shoot(page, shot);
  await page.keyboard.press("Escape");
  return facts;
}

async function catalog(drill) {
  if (!port) throw new Error("drill:catalog needs ROLES_PORT (run it as pnpm drill:catalog).");
  const out = {};

  // --- support first: read-only, never the editor ---
  const sup = await signIn(drill, "support");
  const sf = await common(drill, sup.page, "support");
  drill.check(sf.legacy.length === 0, "support: no [data-legacy] region in main (no old quiz tray)", sf.legacy);
  drill.check(/Product-finder quizzes: \d+ quizz?e?s?\./.test(sf.quizSummary || ""), "support: the one-line quiz summary", sf.quizSummary);
  drill.check(sf.sync?.gated === true, "support: Sync from Shopify is RoleGate's (disabled, with the reason)", sf.sync);
  drill.check((await sup.page.evaluate(strays)).length === 0, "support: every control on the page is a read, disabled or gated", await sup.page.evaluate(strays));
  await drill.shoot(sup.page, "support-products");
  await search(drill, sup.page, "support");
  const ss = await sheet(drill, sup.page, "support", "support-sheet");
  drill.check(ss.editorText === "View content", "support: the sheet says View content (checked, not followed)", ss.editorText);
  drill.check((await sup.page.evaluate(strays)).length === 0, "support: no stray control in the open sheet", await sup.page.evaluate(strays));
  const sc = await collections(drill, sup.page, "support", "support-collection");
  drill.check(sc.editorText === "View collection content", "support: the collection says View collection content", sc.editorText);
  // a gated sync: click, Enter and Space do nothing
  const gate = sup.page.locator('[data-catalog="sync-header"] [data-role-gate="disabled"]');
  await gate.click({ force: true }).catch(() => {});
  await gate.focus().catch(() => {});
  await sup.page.keyboard.press("Enter");
  await sup.page.keyboard.press("Space");
  await sup.page.waitForTimeout(500);
  drill.check(new URL(sup.page.url()).pathname === PAGE, "support: never left the catalog for the editor", sup.page.url());
  drill.check(sup.writes.length === 0, "support: no non-GET request in the whole pass", sup.writes);
  drill.check(sup.errors.length === 0, "support: no error in the browser console", sup.errors);
  drill.note(`dev server: ${sup.devServer}; Next's dev overlay sent ${sup.devOverlay} request(s) to /__nextjs_* in support's pass (skipped only on a dev server)`);
  out.support = { facts: sf, writes: sup.writes };

  // --- staff: writes the storefront, can't sync ---
  const st = await signIn(drill, "staff");
  const tf = await common(drill, st.page, "staff");
  drill.check(tf.sync?.gated === true, "staff: Sync from Shopify is disabled with the reason", tf.sync);
  drill.check(tf.legacy.join(",") === "quizzes", "staff: keeps the quiz tray (the one [data-legacy-tray])", tf.legacy);
  out.staff = { facts: tf };

  // --- owner: everything, then into the editor ---
  const ow = await signIn(drill, "owner");
  const of = await common(drill, ow.page, "owner");
  const unlinked = await ow.page.getByText("isn't linked to your Shopify store yet", { exact: false }).count();
  drill.check(of.sync && !of.sync.gated && (!of.sync.disabled || unlinked > 0), "owner: Sync from Shopify is the owner's (not pressed); on the roles store, with no Shopify link, natively disabled with the words why", { ...of.sync, unlinked });
  drill.check(of.legacy.join(",") === "quizzes", "owner: the quiz tray is the only old region", of.legacy);
  await drill.shoot(ow.page, "owner-products");
  await search(drill, ow.page, "owner");
  await collections(drill, ow.page, "owner", "owner-collection").then((c) => drill.check(c.editorText === "Edit collection content", "owner: Edit collection content", c.editorText));
  await ow.page.getByRole("tab", { name: "Products" }).click();
  const os = await sheet(drill, ow.page, "owner", "owner-sheet");
  drill.check(os.editorText === "Edit content", "owner: the sheet says Edit content", os.editorText);
  await ow.page.locator('[data-catalog="product-sheet"] [data-editor-link]').click();
  await ow.page.waitForURL(/\/admin\/editor\?product=/, { timeout: 60_000 }).catch(() => {});
  drill.check(new URL(ow.page.url()).pathname === "/admin/editor" && new URL(ow.page.url()).searchParams.get("product") === new URL(ORIGIN + os.editor).searchParams.get("product"), "owner: Edit content lands on /admin/editor?product=<gid>", ow.page.url());
  // the old links still open the editor
  const old = await ow.page.goto(`${ORIGIN}${PAGE}?product=${encodeURIComponent(new URL(ORIGIN + os.editor).searchParams.get("product"))}`, { waitUntil: "load" });
  // catalog/loading.js streams the page, so the redirect may land on the client
  await ow.page.waitForURL(/\/admin\/editor\?product=/, { timeout: 30_000 }).catch(() => {});
  drill.check(old && new URL(ow.page.url()).pathname === "/admin/editor", "owner: /admin/catalog?product=<gid> still redirects to the editor", ow.page.url());

  drill.check(ow.errors.length === 0 && st.errors.length === 0, "owner and staff: no error in the browser console", { owner: ow.errors, staff: st.errors });
  // phone width: the table and filters fit
  await sup.page.setViewportSize({ width: 375, height: 812 });
  await open(sup.page);
  const overflow = await sup.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  drill.check(overflow <= 1, "support at 375px: no sideways page scroll", overflow);
  await drill.shoot(sup.page, "support-375");

  writeFileSync(join(drill.dir, "result.json"), `${JSON.stringify({ id: DRILL_ID, ranAt: new Date().toISOString(), passed: drill.checks.filter((c) => c.ok).length, failed: drill.checks.filter((c) => !c.ok).length, out, notes: drill.notes, failures: drill.checks.filter((c) => !c.ok) }, null, 2)}\n`);
}

runDrill({ id: DRILL_ID, part: "main", title: "CATALOG — browse products and collections, every role" }, catalog).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
