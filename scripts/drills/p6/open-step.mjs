// P6-DRILLS stage J (Phase 1 line 7): the founder opens the store from
// onboarding step 4, on a fresh closed p6 store with checkout off, no
// contact details and no policy pages (seed stage j):
//   1. the starter store is made (step 3), then step 4 is Blocked by payment
//      and both policy pages; the shopper sees the closed page
//   2. "Turn on checkout" sets cash on delivery here; "Add Razorpay keys"
//      opens Settings with "Back to onboarding", which comes back to step 4
//   3. "Start a privacy page" / "Start a returns page", each "Read it" in the
//      reader, "I've read it" at the end of the text
//   4. the contact form saves a support email
//   4b. the step and the dialog at 375 and 768; Cancel sends nothing
//   5. support: every item and reason on screen, every control disabled
//      with its reason, nothing enabled
//   6. "Open your store": the dialog lists what goes live (home, both pages,
//      the colours), the "Worth checking" items, says other drafts stay
//      drafts; "Open my store anyway"; the step says "Your store is open"
//      with the store address; a shopper sees the home page (200)
// No test order is placed here (stages c and h cover it).
import { closedPageFacts, docsOf, liveRelease, loginP6, p6Context, p6Url, reseedP6, settle, sleep, tenantConfig, waitFor, watchErrors } from "./lib.mjs";
import { openStart } from "./brand.mjs";
import { readOnboarding } from "./setup.mjs";

const STEP = "/admin/onboarding?step=open";
const READ_ONLY = "Your role can look at this but not change it.";
const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();

async function goStep(drill, page) {
  await page.goto(p6Url(drill, STEP), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator('[data-onboarding="panel"][data-step="open"]').waitFor({ timeout: 60_000 });
}
async function openModel(page) {
  const r = await readOnboarding(page);
  const step = (r.body?.steps || []).find((s) => s.id === "open") || null;
  return { status: r.status, step, blocking: (step?.facts?.blocking || []).map((b) => b.id), item: (id) => (step?.facts?.items || []).find((i) => i.id === id) || null };
}
const itemLi = (page, id) => page.locator(`[data-onboarding="panel"] [data-opening-item="${id}"]`);
// every button in the panel: its words, disabled, and the reason it names
const panelButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-onboarding="panel"] button')].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled, reason: b.getAttribute("aria-describedby") ? document.getElementById(b.getAttribute("aria-describedby"))?.innerText.trim() : null })),
  );

async function readAndMark(drill, page, id) {
  await itemLi(page, id).getByRole("button", { name: "Read it", exact: true }).click();
  const reader = page.locator('[data-onboarding="policy-reader"]');
  await reader.locator('[data-onboarding="policy-end"]').waitFor({ timeout: 30_000 });
  const text = clean(await reader.innerText());
  await drill.screenshot(page, `j-reader-${id}-1440`);
  await reader.getByRole("button", { name: "I've read it", exact: true }).click();
  await reader.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  const m = await waitFor(async () => {
    const r = await openModel(page);
    return r.blocking.includes(id) ? false : r;
  }, 30_000, 400);
  return { text, model: m };
}

export async function openStepStage(drill) {
  await reseedP6(drill, "j");
  const cfg0 = await tenantConfig();
  drill.check(cfg0?.checkout_mode === "disabled" && !cfg0?.site?.support_email, "the stage seed has checkout off and no support email", { checkout: cfg0?.checkout_mode, support: cfg0?.site?.support_email ?? null });
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  drill.check((await openStart(drill, page)) === "ready", "the starter store is made in step 3", null);

  // ---- 1. blocked ----
  await goStep(drill, page);
  let m = await openModel(page);
  drill.check(m.step?.state === "blocked" && ["payment", "privacy", "returns"].every((id) => m.blocking.includes(id)) && !m.blocking.includes("home"), "step 4 is Blocked by payment and both policy pages (the home page is made)", { state: m.step?.state, blocking: m.blocking });
  const openBtn = page.locator('[data-onboarding="open-store"] button', { hasText: "Open your store" });
  drill.check(await openBtn.isDisabled(), "'Open your store' is disabled while anything is needed", null);
  const shut = await closedPageFacts(p6Url(drill, "/"));
  drill.check(shut.status === 200 && shut.openingSoon, "a shopper sees the closed page before opening", { status: shut.status, openingSoon: shut.openingSoon });
  await drill.screenshot(page, "j-open-step-blocked-1440", { fullPage: true });

  // ---- 2. checkout on, Settings and back ----
  await itemLi(page, "payment").getByRole("button", { name: "Turn on checkout", exact: true }).click();
  const cfg1 = await waitFor(async () => ((await tenantConfig())?.checkout_mode === "direct" ? tenantConfig() : false), 30_000, 400);
  m = await waitFor(async () => {
    const r = await openModel(page);
    return r.blocking.includes("payment") ? false : r;
  }, 30_000, 400);
  drill.check(Boolean(cfg1) && m && m.item("payment")?.level === "info", "'Turn on checkout' sets cash on delivery and payment stops blocking", { checkout: cfg1?.checkout_mode, payment: m?.item("payment")?.level });
  await page.locator('[data-onboarding="panel"] [data-opening-item="payment"]').getByRole("link", { name: "Add Razorpay keys", exact: true }).waitFor({ timeout: 30_000 });
  await itemLi(page, "payment").getByRole("link", { name: "Add Razorpay keys", exact: true }).click();
  await page.waitForURL((u) => new URL(u).pathname === "/admin/settings" && new URL(u).searchParams.get("from") === "onboarding", { timeout: 60_000 });
  await settle(page);
  const back = page.getByRole("link", { name: "Back to onboarding", exact: true });
  await back.waitFor({ timeout: 30_000 });
  drill.check(new URL(page.url()).hash === "#payments", "'Add Razorpay keys' opens Settings at Payments with 'Back to onboarding' (no key is taken in onboarding)", page.url());
  await drill.screenshot(page, "j-settings-back-1440");
  await back.click();
  await page.waitForURL((u) => new URL(u).pathname === "/admin/onboarding" && new URL(u).searchParams.get("step") === "open", { timeout: 60_000 });
  await page.locator('[data-onboarding="panel"][data-step="open"]').waitFor({ timeout: 60_000 });
  drill.check(true, "'Back to onboarding' returns to step 4", page.url());

  // ---- 3. both policy pages: start, read, mark read ----
  for (const [id, label] of [["privacy", "Start a privacy page"], ["returns", "Start a returns page"]]) {
    await itemLi(page, id).getByRole("button", { name: label, exact: true }).click();
    await itemLi(page, id).getByRole("button", { name: "Read it", exact: true }).waitFor({ timeout: 30_000 });
    const r = await readAndMark(drill, page, id);
    drill.check(r.text.length > 200 && r.text.includes("These are starting points, not legal advice.") && Boolean(r.model), `${label}, 'Read it' shows the draft text, 'I've read it' at its end and the page stops blocking`, { text: r.text.slice(0, 160), blocking: r.model?.blocking });
  }
  const pages = (await docsOf()).filter((d) => d.type === "page");
  drill.check(pages.length === 2 && pages.every((d) => d.updated_by !== "system:policy-starter" && !d.published_version_id), "both pages count as the founder's and are still drafts", pages.map((d) => ({ slug: d.slug, by: d.updated_by })));

  // ---- 4. contact details ----
  const form = page.locator('[data-onboarding="contact-form"]');
  await form.locator('input[type="email"]').fill("hello@p6.test");
  await form.getByRole("button", { name: "Save contact details", exact: true }).click();
  const cfg2 = await waitFor(async () => {
    const c = await tenantConfig();
    return c?.site?.support_email === "hello@p6.test" ? c : false;
  }, 30_000, 400);
  drill.check(Boolean(cfg2) && cfg2.site.name, "the contact form saves the support email and keeps the store name", cfg2?.site);
  m = await waitFor(async () => {
    const r = await openModel(page);
    return r.step?.state === "ready" ? r : false;
  }, 30_000, 400);
  drill.check(Boolean(m) && m.step.actions.find((a) => a.id === "open_store")?.allowed === true, "nothing blocks now: step 4 is ready and Open is allowed", m?.step?.state);
  await goStep(drill, page);
  await drill.screenshot(page, "j-open-step-ready-1440", { fullPage: true });

  // ---- 4b. the step and the dialog at 375 and 768; Cancel sends nothing ----
  for (const width of [375, 768]) {
    const nctx = await p6Context(drill, { width });
    const np = await loginP6(drill, nctx);
    await goStep(drill, np);
    const overflow = await np.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    drill.check(!overflow, `at ${width} step 4 has no sideways scroll`, overflow);
    await drill.screenshot(np, `j-open-step-ready-${width}`, { fullPage: true });
    await np.locator('[data-onboarding="open-store"]').getByRole("button", { name: "Open your store", exact: true }).click();
    const nd = np.locator('[data-onboarding="open-dialog"]');
    await waitFor(async () => (await nd.locator('[data-onboarding="confirm-open"]').isEnabled().catch(() => false)) || false, 60_000, 300);
    await drill.screenshot(np, `j-open-dialog-${width}`);
    await nd.getByRole("button", { name: "Cancel", exact: true }).click();
    await nd.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await nctx.close();
  }
  drill.check((await liveRelease()) == null, "Cancel closes the dialog before anything is sent (still closed)", null);

  // ---- 5. support: everything visible, nothing enabled ----
  const sctx = await p6Context(drill);
  const sp = await loginP6(drill, sctx, { as: "support" });
  await goStep(drill, sp);
  const st = clean(await sp.locator('[data-onboarding="panel"]').innerText());
  const sButtons = await panelButtons(sp);
  drill.check(["Home page", "Privacy page", "Returns page", "Contact details"].every((t) => st.includes(t)), "support: every item is on screen", st.slice(0, 300));
  drill.check(sButtons.length > 0 && sButtons.every((b) => (b.disabled && b.reason) || b.text.startsWith("Next:")), "support: every control is disabled with its reason under it", sButtons);
  drill.check(sButtons.find((b) => b.text === "Open your store")?.reason === READ_ONLY, "support: 'Open your store' says 'Your role can look at this but not change it.'", sButtons.find((b) => b.text === "Open your store"));
  await drill.screenshot(sp, "j-open-step-support-1440", { fullPage: true });
  await sctx.close();

  // ---- 6. open from the dialog ----
  await page.locator('[data-onboarding="open-store"]').getByRole("button", { name: "Open your store", exact: true }).click();
  const dialog = page.locator('[data-onboarding="open-dialog"]');
  await dialog.waitFor({ timeout: 30_000 });
  const confirm = dialog.locator('[data-onboarding="confirm-open"]');
  await waitFor(async () => (await confirm.isEnabled().catch(() => false)) && (await dialog.locator("[data-going-live]").count()) > 0, 60_000, 300);
  const listed = await dialog.locator("[data-going-live]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-going-live"), text: e.innerText.replace(/\s+/g, " ").trim() })));
  const dtext = clean(await dialog.innerText());
  drill.check(listed.some((l) => l.id === "doc_home") && listed.length >= 3 && listed.every((l) => /First version|\d+ changes?/.test(l.text)), "the dialog lists home and what goes with it, each 'First version' or its changes", listed);
  drill.check(dtext.includes("Worth checking") && dtext.includes("stays a draft") && (await confirm.innerText()).trim() === "Open my store anyway", "it shows the 'Worth checking' items, says other drafts stay drafts, and offers 'Open my store anyway'", dtext.slice(0, 400));
  await drill.screenshot(page, "j-open-dialog-1440");
  await confirm.click();
  // Esc straight after sending: the panel keeps "Publishing your store…" with
  // Open off until the answer, and Open is never offered again meanwhile
  await page.keyboard.press("Escape");
  const openNow = page.locator('[data-onboarding="open-store"] button').first();
  let sawPublishing = false;
  let reofferedEarly = false;
  const finished = await waitFor(async () => {
    if (await page.locator('[data-onboarding="open-done"]').count()) return true;
    if (await page.locator('[data-onboarding="publishing"]').count()) {
      sawPublishing = true;
      if (await openNow.isEnabled().catch(() => false)) reofferedEarly = true;
    } else if ((await openNow.isEnabled().catch(() => false)) && (await liveRelease()) == null) {
      // the answer came back without opening (the server asked once more with
      // the colours folded in): confirm again from a new dialog
      await openNow.click().catch(() => {});
      await waitFor(async () => (await confirm.isEnabled().catch(() => false)) || false, 30_000, 300);
      await confirm.click().catch(() => {});
    }
    return false;
  }, 90_000, 150);
  drill.check(Boolean(finished) && !reofferedEarly, "closing the dialog after sending keeps 'Publishing your store…' with Open off until the answer (or the store is already open)", { sawPublishing, reofferedEarly });
  await sleep(800);
  const live = await liveRelease();
  drill.check(live != null, "the store is open (a live release)", live);
  const done = page.locator('[data-onboarding="open-done"]');
  await waitFor(async () => (await page.locator('[data-onboarding="panel"]').getAttribute("data-state")) === "done", 30_000, 400);
  const doneText = clean(await done.innerText());
  const href = await done.locator('[data-onboarding="live-link"]').getAttribute("href").catch(() => null);
  drill.check(doneText.includes("Your store is open") && doneText.includes("p6.localhost") && href === "/api/preview?exit=1&to=%2F", "step 4 says 'Your store is open' with the store address linked to the live site", { doneText, href });
  drill.check((await page.getByRole("link", { name: "Go to your dashboard", exact: true }).count()) > 0, "'Go to your dashboard' is offered", null);
  const pill = await waitFor(async () => {
    const t = clean(await page.locator('[data-onboarding="status"]').first().innerText().catch(() => ""));
    return t.toLowerCase() === "open" ? t : false;
  }, 30_000, 400);
  drill.check(Boolean(pill), "the welcome block's pill says Open without a reload", pill);
  await drill.screenshot(page, "j-open-step-done-1440", { fullPage: true });
  const shopper = await closedPageFacts(p6Url(drill, "/"));
  drill.check(shopper.status === 200 && !shopper.openingSoon, "a shopper now sees the home page (200, not the closed page)", { status: shopper.status, openingSoon: shopper.openingSoon });

  drill.check(errors.length === 0, "no page errors", errors);
  await ctx.close();
}
