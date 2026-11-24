// P6-DRILLS stage H (Phase 1 line 3): the four-step onboarding page,
// /admin/onboarding, on a fresh closed p6 store whose founder has already
// saved a privacy and a terms page (so nothing blocks opening):
//   1. states   the founder signs in and lands on onboarding, on the first step
//               not done (Brand); Connect and Import read Done (the seed's
//               complete sync), Open reads To do; the step list sits left of
//               the 640px column at 1440, above it at 375; Brand turns
//               In progress once the starter store is made
//   2. resume   ?step=import opens Import; choosing a step replaces ?step=;
//               an unknown ?step is ignored
//   3. marks    "I placed a test order" is stored and said; undo clears it
//   4. support  the support member reads every step; every control is
//               disabled with its reason; the POST is refused
//   5. open     "Open your store" and the dialog (line 7); then /admin goes to the
//               dashboard, onboarding reads every step Done and "Your store is
//               open", and the nav has no onboarding badge
import { liveRelease, loginP6, p6Context, p6Url, reseedP6, settle, sleep, tenantConfig, waitFor, watchErrors } from "./lib.mjs";
import { readOnboarding } from "./setup.mjs";

const ONBOARDING = "/admin/onboarding";
const READ_ONLY = "Your role can look at this but not change it.";
const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();

async function goStep(drill, page, step = null) {
  await page.goto(p6Url(drill, step ? `${ONBOARDING}?step=${step}` : ONBOARDING), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator('[data-onboarding="panel"]').waitFor({ timeout: 60_000 });
}
// the page as the founder sees it: the panel and the step list's states
async function readPage(page) {
  return page.evaluate(() => {
    const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const panel = document.querySelector('[data-onboarding="panel"]');
    const visible = (el) => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    const rail = document.querySelector('[data-onboarding="steplist"]');
    const compact = document.querySelector('[data-onboarding="steplist-compact"]');
    const list = visible(rail) ? rail : compact;
    return {
      step: panel?.getAttribute("data-step") || null,
      state: panel?.getAttribute("data-state") || null,
      text: clean(panel?.innerText),
      states: Object.fromEntries([...(list?.querySelectorAll("button[data-step]") || [])].map((b) => [b.getAttribute("data-step"), b.getAttribute("data-state")])),
      progress: clean(document.querySelector('[data-onboarding="progress"]')?.innerText),
      railVisible: visible(rail),
      compactVisible: visible(compact),
      search: location.search,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

export async function onboardingStage(drill) {
  await reseedP6(drill, "h");
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);

  // ---- 1. states ----
  const page = await loginP6(drill, ctx);
  drill.check(new URL(page.url()).pathname === ONBOARDING, "the founder signs in and lands on /admin/onboarding (the store is closed)", page.url());
  await page.locator('[data-onboarding="panel"]').waitFor({ timeout: 60_000 });
  let v = await readPage(page);
  drill.check(v.step === "brand" && v.search === "", "with no ?step the page opens on the first step not done (Brand)", { step: v.step, search: v.search });
  drill.check(v.states.connect === "done" && v.states.import === "done" && v.states.open === "ready" && ["ready", "in_progress"].includes(v.states.brand), "Connect and Import read Done (a complete sync), Open reads To do", v.states);
  drill.check(v.railVisible && !v.compactVisible, "at 1440 the step list sits beside the column (the compact list is hidden)", { rail: v.railVisible, compact: v.compactVisible });
  const col = await page.locator('[data-onboarding="column"]').boundingBox();
  const rail = await page.locator('[data-onboarding="steplist"]').boundingBox();
  drill.check(col && col.width <= 640 && col.width >= 600 && rail && rail.x + rail.width <= col.x, "the column is at most 640px wide with the step list to its left", { col, rail });
  const made = await waitFor(async () => {
    const s = await page.locator("[data-first-run]").getAttribute("data-first-run").catch(() => null);
    return s && !["loading", "making"].includes(s) ? s : false;
  }, 120_000, 300);
  const inProgress = await waitFor(async () => ((await readPage(page)).states.brand === "in_progress" ? true : false), 30_000, 500);
  v = await readPage(page);
  drill.check(made === "ready" && inProgress && v.text.includes("In progress") && v.progress.includes("2 of 4"), "the starter store is made in the Brand step and the step turns In progress without a reload; '2 of 4 steps done'", { made, brand: v.states.brand, progress: v.progress });
  await drill.screenshot(page, "h-onboarding-brand-1440", { fullPage: true });

  // ---- 2. resume ----
  await goStep(drill, page, "import");
  v = await readPage(page);
  drill.check(v.step === "import" && v.state === "done" && v.text.includes("24 products are in your store."), "?step=import opens Import: Done, '24 products are in your store.'", { step: v.step, text: v.text.slice(0, 200) });
  await page.locator('[data-onboarding="steplist"] button[data-step="open"]').click();
  await waitFor(async () => (await readPage(page)).search === "?step=open", 10_000, 200);
  v = await readPage(page);
  drill.check(v.step === "open" && v.search === "?step=open", "choosing 'Open your store' shows it and replaces ?step=open", { step: v.step, search: v.search });
  await goStep(drill, page, "nope");
  v = await readPage(page);
  drill.check(v.step === "brand", "an unknown ?step is ignored (the first step not done)", v.step);

  // ---- 3. the test order mark ----
  await goStep(drill, page, "open");
  await page.getByRole("button", { name: "I placed a test order", exact: true }).click();
  await page.getByText("You told us you placed a test order.").waitFor({ timeout: 30_000 });
  drill.check(Boolean((await tenantConfig())?.onboarding?.manual?.test_order), "'I placed a test order' is stored and the step says so", (await tenantConfig())?.onboarding?.manual ?? null);
  await page.getByRole("button", { name: "I haven't placed one yet", exact: true }).click();
  await page.getByRole("button", { name: "I placed a test order", exact: true }).waitFor({ timeout: 30_000 });
  drill.check(!(await tenantConfig())?.onboarding?.manual?.test_order, "'I haven't placed one yet' clears it", (await tenantConfig())?.onboarding?.manual ?? null);
  await drill.screenshot(page, "h-onboarding-open-1440", { fullPage: true });

  // the same page at 375: the compact list above the panel, no sideways scroll
  const narrow = await p6Context(drill, { width: 375 });
  const np = await loginP6(drill, narrow);
  await goStep(drill, np, "open");
  v = await readPage(np);
  drill.check(v.compactVisible && !v.railVisible && !v.overflow && Object.keys(v.states).length === 4, "at 375 the compact step list shows above the panel and nothing scrolls sideways", { compact: v.compactVisible, rail: v.railVisible, overflow: v.overflow });
  await drill.screenshot(np, "h-onboarding-open-375", { fullPage: true });
  // the same signed-in tab at other widths (screenshots only): 768 keeps the
  // compact list, 1280 has the rail
  for (const width of [375, 768, 1280]) {
    await np.setViewportSize({ width, height: width >= 1024 ? 900 : 812 });
    await goStep(drill, np, "brand");
    await drill.screenshot(np, `h-onboarding-brand-${width}`, { fullPage: true });
    if (width === 375) continue;
    await goStep(drill, np, "import");
    await drill.screenshot(np, `h-onboarding-import-${width}`, { fullPage: true });
  }
  await narrow.close();

  // ---- 4. support: reads everything, changes nothing ----
  const sctx = await p6Context(drill);
  const sp = await loginP6(drill, sctx, { as: "support" });
  drill.check(new URL(sp.url()).pathname === ONBOARDING, "support lands on onboarding too", sp.url());
  await goStep(drill, sp, "open");
  const gated = await sp.evaluate(() =>
    [...document.querySelectorAll('[data-onboarding="panel"] button')].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled, reason: b.getAttribute("aria-describedby") ? document.getElementById(b.getAttribute("aria-describedby"))?.innerText.trim() : null })),
  );
  const byText = (t) => gated.find((g) => g.text === t);
  drill.check(byText("I placed a test order")?.disabled && byText("I placed a test order")?.reason === READ_ONLY && byText("Open your store")?.disabled && byText("Open your store")?.reason === READ_ONLY, "support: 'I placed a test order' and 'Open your store' are disabled with 'Your role can look at this but not change it.'", gated);
  drill.check(gated.every((g) => g.disabled || g.text.startsWith("Next:")), "support: no enabled control in the Open step", gated);
  await drill.screenshot(sp, "h-onboarding-support-open-1440", { fullPage: true });
  await goStep(drill, sp, "brand");
  const brandText = clean(await sp.locator('[data-onboarding="panel"]').innerText());
  await drill.screenshot(sp, "h-onboarding-support-brand-1440", { fullPage: true });
  drill.check(brandText.includes(READ_ONLY), "support: the Brand step says why nothing can be changed", brandText.slice(0, 300));
  const brandButtons = await sp.locator('[data-onboarding="panel"] [data-brand-step] button:not([disabled])').count();
  drill.check(brandButtons === 0, "support: the brand step has no enabled button", brandButtons);
  await goStep(drill, sp, "connect");
  drill.check((await sp.locator('[data-onboarding="shop-domain"]').count()) === 0, "support: no Shopify store address on the page", null);
  const post = await sp.evaluate(async () => {
    const r = await fetch("/api/admin/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "test_order", done: true }) });
    return r.status;
  });
  drill.check(post === 403 && !(await tenantConfig())?.onboarding?.manual?.test_order, "support: marking the test order directly is refused (403) and nothing is stored", post);
  const sread = await readOnboarding(sp);
  drill.check(sread.status === 200 && (sread.body?.steps || []).flatMap((s) => s.actions).every((a) => a.allowed === (a.id === "policy_view")), "support: GET /api/admin/onboarding has every action disallowed but reading a policy draft", sread.status);
  await sctx.close();

  // ---- 5. open the store, then every step is Done ----
  await goStep(drill, page, "open");
  await page.locator('[data-onboarding="open-store"]').getByRole("button", { name: "Open your store", exact: true }).click();
  const dialog = page.locator('[data-onboarding="open-dialog"]');
  const confirm = dialog.locator('[data-onboarding="confirm-open"]');
  const enabled = await waitFor(async () => (await confirm.isEnabled().catch(() => false)) || false, 60_000, 300);
  drill.check(Boolean(enabled), "'Open your store' shows what goes live with the confirm enabled", await dialog.innerText().catch(() => ""));
  await confirm.click();
  await waitFor(async () => (await page.locator('[data-onboarding="open-done"]').count()) > 0 || ["refused", "error", "blocked", "conflict"].includes(await dialog.getAttribute("data-phase").catch(() => "")), 90_000, 400);
  await sleep(800);
  drill.check((await liveRelease()) != null, "the store is open (a live release)", null);
  // a fresh tab: the editor may still be finishing its own navigation after Open
  const after = await ctx.newPage();
  await after.goto(p6Url(drill, "/admin"), { waitUntil: "load", timeout: 120_000 });
  await settle(after);
  drill.check(new URL(after.url()).pathname === "/admin/dashboard", "an open store: /admin goes to the dashboard", after.url());
  const nav = await after.locator('[data-slot="sidebar-container"] a[data-nav-item]').count();
  const badge = await after.locator('[data-badge="onboarding"]').count();
  drill.check(nav > 0 && badge === 0, "the dashboard's nav has no onboarding badge once the store is open", { nav, badge });
  await goStep(drill, after);
  v = await readPage(after);
  const status = clean(await after.locator('[data-onboarding="status"]').innerText().catch(() => ""));
  drill.check(Object.values(v.states).length === 4 && Object.values(v.states).every((s) => s === "done") && v.progress.includes("4 of 4") && status.toLowerCase() === "open", "onboarding: every step Done, '4 of 4', the Open badge", { states: v.states, progress: v.progress, status });
  drill.check(v.step === "open" && v.text.includes("Your store is open."), "it opens on 'Open your store': 'Your store is open.'", v.text.slice(0, 200));
  await drill.screenshot(after, "h-onboarding-all-done-1440", { fullPage: true });

  drill.check(errors.length === 0, "no page errors", errors);
  await ctx.close();
}
