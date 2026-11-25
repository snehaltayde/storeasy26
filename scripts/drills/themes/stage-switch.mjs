// drill:themes stage "switch" (Phase 5 line 3, docs/plans/phase-5.md "Line 3"
// drill stage). Starts where stage-render leaves the roles store: open, with
// Aurora (state.themePackage) live. Through the Themes page only:
//   1. the owner chooses Pulse (a draft: the shopper still sees Aurora) and
//      publishes it: the shopper sees Pulse
//   2. the owner chooses Aurora again; Preview opens the store in a new tab
//      with Aurora shown, while the anonymous shopper still sees Pulse; staff
//      see "Ask an admin to publish"; the owner publishes: the shopper sees
//      Aurora
//   3. the owner switches back to Pulse and publishes
// Selectors are data-* hooks and exact names; every wait is for an element or
// an answer, never a fixed time.
import { ORIGIN, open, signIn, stage, state } from "./lib.mjs";

stage("switch", async (drill) => {
  const PKG = state.themePackage;
  drill.check(typeof PKG === "string", "the render stage left Aurora live", state);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(30_000);
  const anon = await ctx.newPage();
  const shopperTheme = async () => {
    await anon.goto(ORIGIN + "/", { waitUntil: "load" });
    return { theme: await anon.locator("html").getAttribute("data-theme"), kit: await anon.locator("html").getAttribute("data-kit") };
  };
  drill.check((await shopperTheme()).theme === "aurora", "start: the shopper sees Aurora");

  const owner = await signIn(drill, "owner");
  await open(owner, "/admin/themes");
  const answer = (path) => owner.waitForResponse((r) => r.url().includes(path) && r.request().method() !== "GET");
  const choose = async (selector, hasHome = false) => {
    await owner.locator(selector).first().click();
    const dialog = owner.locator('[data-themes="apply-dialog"]');
    await dialog.waitFor();
    drill.check((await dialog.locator('[data-themes-option="brand"]').getAttribute("data-state")) === "checked", "apply: 'Also use its colours' is on by default");
    if (hasHome) drill.check((await dialog.locator('[data-themes-option="home"]').getAttribute("data-state")) !== "checked", "apply: 'Also use its home layout' is off by default");
    const done = answer("/api/admin/theme");
    await dialog.locator('[data-themes-action="use-confirm"]').click();
    drill.check((await done).status() === 200, "apply: the draft is saved");
    await owner.locator('[data-themes="draft-bar"]').waitFor();
  };
  const publish = async () => {
    const done = answer("/api/admin/documents");
    await owner.locator('[data-themes-action="publish"]').click();
    const r = await done;
    drill.check(r.status() === 200, "publish: the documents publish answers 200", await r.text().catch(() => ""));
    await owner.locator('[data-themes="draft-bar"]').waitFor({ state: "detached" });
  };

  // 1. Pulse: a draft first, then live
  await choose('[data-theme-builtin="pulse"] [data-themes-action="use"]');
  drill.check((await shopperTheme()).theme === "aurora", "Pulse in the draft: the shopper still sees Aurora");
  await drill.shoot(owner, "switch-draft-bar");
  await publish();
  const pulse = await shopperTheme();
  drill.check(pulse.theme === null && pulse.kit === "pulse-1", "Pulse published: the shopper sees Pulse", pulse);

  // 2. Aurora again, previewed in a new tab before it goes live
  await choose(`[data-themes-look="${PKG}"]`, true);
  drill.check((await owner.locator(`[data-theme-use="draft"]`).count()) > 0, "Aurora shows the 'In your draft' badge");
  const popup = owner.context().waitForEvent("page");
  await owner.locator('[data-themes-action="preview"]').click();
  const tab = await popup;
  await tab.waitForURL((u) => !String(u).startsWith("about:") && !String(u).includes("/api/preview"));
  await tab.waitForLoadState("load");
  drill.check((await tab.locator("html").getAttribute("data-theme")) === "aurora", "preview: the new tab shows Aurora");
  await drill.shoot(tab, "switch-preview");
  await tab.close();
  drill.check((await shopperTheme()).theme === null, "preview: the anonymous shopper still sees Pulse");

  const staff = await signIn(drill, "staff");
  await open(staff, "/admin/themes");
  await staff.locator('[data-themes="draft-bar"]').waitFor();
  drill.check((await staff.getByText("Ask an admin to publish.").count()) > 0, "staff: 'Ask an admin to publish' instead of publishing");
  await staff.context().close();

  await publish();
  drill.check((await shopperTheme()).theme === "aurora", "Aurora published: the shopper sees Aurora");
  drill.check((await owner.locator(`[data-theme-use="live"]`).count()) > 0, "Aurora shows the 'Live' badge");

  // 3. back to Pulse
  await choose('[data-theme-builtin="pulse"] [data-themes-action="use"]');
  await publish();
  drill.check((await shopperTheme()).theme === null, "back to Pulse: the shopper sees Pulse");
  await drill.shoot(anon, "switch-back-pulse");
  await owner.context().close();
  await ctx.close();
});
