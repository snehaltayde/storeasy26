// drill:themes stage "flagship" (Phase 7 line 1, docs/plans/phase-7.md "Line 1"
// drill stage). Sets up its own start: the roles store open with Pulse live
// (the design back on Pulse and published, with a home page). Then, through
// the Themes page:
//   1. the owner uses Bloom from "Storeasy themes" (a draft: installed on
//      first use); Preview opens a new tab with Bloom and its serif heading,
//      while the anonymous shopper still sees Pulse
//   2. staff see "Ask an admin to publish" and no Publish; support sees the
//      five cards with no Use, Update or Publish control
//   3. the owner publishes: the anonymous shopper sees Bloom with Fraunces
//      headings and the "Live" badge shows
// The shopper context sets the consent cookie and stubs /_next/image (the
// roles store's fixture pictures 404). Selectors are data-* hooks and exact
// names; every wait is for an element or an answer, never a fixed time.
import { ORIGIN, open, signIn, stage } from "./lib.mjs";
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
const docsApi = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);
// the heading face the page draws with
const headingFont = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--display-font"));

stage("flagship", async (drill) => {
  // --- own start: Pulse live on an open store ---
  const owner = await signIn(drill, "owner");
  await stubImages(owner.context());
  await open(owner, "/admin");
  let home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  if (!home) {
    const made = await docsApi(owner, { createDocument: { type: "home", body: { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_flagdrill1", kind: "new", v: 1, enabled: true, settings: { title: "New arrivals", limit: 8 }, blocks: [] }] } } });
    drill.check(made.status === 200, "start: a home page for the first publish", made.body?.error);
    home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  }
  let design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  const pulse = { kit: "pulse", version: 1 };
  if (!design) {
    const made = await docsApi(owner, { createDocument: { type: "design", body: { schema: 1, type: "design", meta: {}, settings: { brand: null, theme: pulse, logo: null } } } });
    drill.check(made.status === 200, "start: a Pulse design", made.body?.error);
  } else {
    const saved = await docsApi(owner, { saveDraft: { id: "doc_design", body: { ...design.body, settings: { ...design.body.settings, theme: pulse } } }, revision: design.revision });
    drill.check(saved.status === 200, "start: the design back on Pulse", saved.body?.error);
  }
  design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document;
  const set = [{ id: "doc_design", revision: design.revision, draftHash: design.draftHash }];
  if (home && !home.live) set.push({ id: "doc_home", revision: home.revision, draftHash: home.draftHash });
  if (design.draftHash !== design.publishedHash || set.length > 1) {
    const published = await docsApi(owner, { publishSet: set });
    drill.check(published.status === 200, "start: Pulse is published and the store is open", published.body?.error || published.body?.code);
  }

  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(30_000);
  await stubImages(ctx);
  await ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);
  const anon = await ctx.newPage();
  anon.on("pageerror", (e) => drill.check(false, "no page error for the shopper", String(e?.message || e).slice(0, 300)));
  const shopper = async () => {
    await anon.goto(ORIGIN + "/", { waitUntil: "load" });
    return { theme: await anon.locator("html").getAttribute("data-theme"), font: await headingFont(anon) };
  };
  drill.check((await shopper()).theme === null, "start: the shopper sees Pulse");

  // --- 1. the owner uses Bloom: a draft, previewed in a new tab ---
  await open(owner, "/admin/themes");
  const cards = owner.locator('[data-themes="flagships"] [data-theme-flagship]');
  await cards.first().waitFor();
  drill.check((await cards.count()) === 5, "Themes opens with five Storeasy themes", await cards.count());
  await drill.shoot(owner, "flagship-cards");
  await owner.locator('[data-theme-flagship="bloom"] [data-themes-action="use"]').click();
  const dialog = owner.locator('[data-themes="apply-dialog"]');
  await dialog.waitFor();
  drill.check((await dialog.locator('[data-themes-option="brand"]').getAttribute("data-state")) === "checked", "use: 'Also use its colours' is on");
  drill.check((await dialog.locator('[data-themes-option="home"]').getAttribute("data-state")) !== "checked", "use: the home layout is off");
  const applied = owner.waitForResponse((r) => r.url().includes("/api/admin/themes/bloom") && r.request().method() === "POST");
  await dialog.locator('[data-themes-action="use-confirm"]').click();
  drill.check((await applied).status() === 200, "use: Bloom is in the draft");
  await owner.locator('[data-theme-flagship="bloom"] [data-theme-use="draft"]').waitFor();
  drill.check((await shopper()).theme === null, "Bloom in the draft: the shopper still sees Pulse");

  const popup = owner.context().waitForEvent("page");
  await owner.locator('[data-theme-flagship="bloom"] [data-themes-action="flagship-preview"]').click();
  const tab = await popup;
  await tab.waitForURL((u) => !String(u).startsWith("about:") && !String(u).includes("/api/preview"));
  await tab.waitForLoadState("load");
  drill.check((await tab.locator("html").getAttribute("data-theme")) === "bloom", "preview: the new tab shows Bloom");
  drill.check(/fraunces/i.test(await headingFont(tab)), "preview: headings are serif (Fraunces)", await headingFont(tab));
  await drill.shoot(tab, "flagship-preview");
  await tab.close();
  const still = await shopper();
  drill.check(still.theme === null && !/fraunces/i.test(still.font), "preview: the anonymous shopper still sees Pulse with sans headings", still);

  // --- 2. staff can't publish; support has no controls ---
  const staff = await signIn(drill, "staff");
  await open(staff, "/admin/themes");
  await staff.locator('[data-themes="draft-bar"]').waitFor();
  drill.check((await staff.getByText("Ask an admin to publish.").count()) > 0, "staff: 'Ask an admin to publish'");
  drill.check((await staff.locator('[data-themes-action="publish"]').count()) === 0, "staff: no Publish");
  await staff.context().close();

  const support = await signIn(drill, "support");
  await open(support, "/admin/themes");
  await support.locator('[data-themes="flagships"] [data-theme-flagship]').first().waitFor();
  drill.check((await support.locator('[data-themes="flagships"] [data-theme-flagship]').count()) === 5, "support: sees the five Storeasy themes");
  drill.check((await support.locator('[data-themes="flagships"] [data-themes-action="use"], [data-themes="flagships"] [data-themes-action="update"], [data-themes-action="publish"]').count()) === 0, "support: no Use, Update or Publish");
  await drill.shoot(support, "flagship-support");
  await support.context().close();

  // --- 3. the owner publishes: the shopper sees Bloom ---
  await owner.locator('[data-themes-action="publish"]').click();
  await owner.locator('[data-themes="publish-dialog"]').waitFor();
  const done = owner.waitForResponse((r) => r.url().includes("/api/admin/documents") && r.request().method() !== "GET");
  await owner.locator('[data-themes-action="publish-confirm"]').click();
  const r = await done;
  drill.check(r.status() === 200, "publish: the documents publish answers 200", await r.text().catch(() => ""));
  await owner.locator('[data-themes="draft-bar"]').waitFor({ state: "detached" });
  const live = await shopper();
  drill.check(live.theme === "bloom" && /fraunces/i.test(live.font), "published: the shopper sees Bloom with serif headings", live);
  await drill.shoot(anon, "flagship-live");
  await owner.locator('[data-theme-flagship="bloom"] [data-theme-use="live"]').waitFor();
  drill.check(true, "Bloom shows the 'Live' badge");
  await owner.context().close();
  await ctx.close();
});
