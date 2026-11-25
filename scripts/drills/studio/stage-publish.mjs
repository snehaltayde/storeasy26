// drill:studio stage "publish" (Phase 6 line 1): the owner's Publish lists
// every draft. The home page (moved in stage drag) is ticked; the older About
// draft is under "Other drafts", unticked. After publishing, the anonymous
// shopper sees the new order and the About page is still a draft.
import { ORIGIN, stage, state } from "./lib.mjs";
import { HOME_IDS, consent, docsApi, openStudio, stubImages, upToDate } from "./stage-open.mjs";

stage("publish", async (drill) => {
  const page = await openStudio(drill, "owner");
  await upToDate(page);
  // this session touches the home page: a move down and back up again
  // would leave nothing to publish, so move "Drill four" up one and keep it
  const handle = page.locator('[data-tree-handle="sec_drillfour4"]');
  await handle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  const order = ["sec_drillthree3", "sec_drilltwo2", "sec_drillfour4", "sec_drillone1"];
  await page.locator("[data-studio-publish]").click();
  const dialog = page.locator("[data-studio-publish-dialog]");
  await dialog.waitFor();
  drill.check((await dialog.locator('[data-publish-row="doc_home"][data-publish-ticked]').count()) === 1, "the home page is ticked (touched, differs from live)");
  const aboutId = state.aboutId;
  const about = dialog.locator(`[data-publish-group="other"] [data-publish-row="${aboutId}"]`);
  drill.check((await about.count()) === 1, "the About draft is under Other drafts", aboutId);
  drill.check((await about.locator("[data-publish-ticked]").count()) === 0 && (await dialog.locator(`[data-publish-row="${aboutId}"][data-publish-ticked]`).count()) === 0, "the About draft is not ticked");
  drill.check((await about.getByText("Has other edits", { exact: true }).count()) === 1, "it reads \"Has other edits\"");
  await drill.shoot(page, "publish-dialog");
  await dialog.locator("[data-studio-publish-go]").click();
  await page.locator("[data-studio-published]").waitFor();
  drill.check((await page.locator("[data-studio-published]").innerText()).includes("Published."), "the top bar says Published.");

  const aboutDoc = (await docsApi(page, { getDocument: aboutId })).body?.document;
  drill.check(aboutDoc && aboutDoc.live !== true && !aboutDoc.publishedVersionId, "the About page is still a draft", aboutDoc && { live: aboutDoc.live, v: aboutDoc.publishedVersionId });
  await page.context().close();

  // the anonymous shopper: a fresh context with no cookies
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stubImages(ctx);
  await consent(ctx);
  ctx.setDefaultTimeout(30_000);
  const anon = await ctx.newPage();
  anon.on("pageerror", (e) => drill.check(false, "no page error for the shopper", String(e?.message || e).slice(0, 300)));
  const r = await anon.goto(`${ORIGIN}/`, { waitUntil: "load" });
  drill.check(r?.status() === 200, "the shopper's home page answers 200", r?.status());
  // the live page has no data-doc (that mark is the preview's); each section's root keeps data-section-id
  const seen = await anon.locator("[data-section-id]").evaluateAll((els, mine) => els.map((el) => el.getAttribute("data-section-id")).filter((id) => mine.includes(id)), HOME_IDS);
  drill.check(JSON.stringify(seen) === JSON.stringify(order), "the shopper sees the new order", seen);
  drill.check((await anon.locator("[data-studio-hidden], .storeasy-ordering").count()) === 0, "the live page has no studio marks");
  await drill.shoot(anon, "publish-live");
  await ctx.close();
});
