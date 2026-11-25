// drill:apps stage "slots" (Phase 4 line 2): the owner turns Trust badges'
// Badges block Live on the app's "Where it shows" card and opens "Preview on
// store": the product page shows the badges; turned Off, the preview shows
// them with the founder's "Turned off" note. The roles store is closed
// (nothing published), so the anonymous shopper gets "Opening soon" and no
// plugin markup at all, Live or not (a block never opens a closed store; the
// open-store shopper cases are in test:plugin-slots). Support sees the
// card with every write control gated. Runs after "install" (which ends with
// the app uninstalled), so it installs Trust badges again through the API and
// uninstalls it at the end.
// Selectors are ids, data-* hooks and exact names; every wait is for a row or
// an answer, never a fixed time.
import { ORIGIN, api, open, signIn, stage } from "./lib.mjs";

const POSTED = (id) => (r) => r.url().endsWith(`/api/admin/apps/${id}/blocks`) && r.request().method() === "POST";

stage("slots", async (drill) => {
  const page = await signIn(drill, "owner");
  await open(page, "/admin/apps");
  const made = await api(page, "apps", { install: { pluginId: "trust-badges", scopes: [] } });
  drill.check(made.status === 200, "owner: Trust badges installs for the slots stage", made.json?.error);
  const id = made.json?.install?.id;
  const listed = await api(page, `apps/${id}/blocks`);
  const productPath = listed.json?.previewPaths?.["storefront.pdp.under_atc"];
  drill.check(typeof productPath === "string" && productPath.startsWith("/products/"), "a product page to look at", productPath);
  drill.check(listed.json?.blocks?.map((p) => p.state).join(",") === "off,off", "both blocks start Off", listed.json?.blocks);

  // the anonymous shopper: a fresh context with no cookies, on the closed store
  const anonCtx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  anonCtx.setDefaultTimeout(30_000);
  const anon = await anonCtx.newPage();
  const shopperSees = async () => {
    await anon.goto(ORIGIN + productPath, { waitUntil: "load" });
    await anon.getByText("Opening soon").first().waitFor();
    return anon.locator("[data-plugin-slot], [data-plugin-slot-outlet], [data-founder-note]").count();
  };
  drill.check((await shopperSees()) === 0, "before: the anonymous shopper gets Opening soon and no plugin markup");

  // the owner turns Badges Live on the card
  await open(page, `/admin/apps/${id}`);
  const card = page.locator("#app-blocks");
  await card.locator('[data-placement="badges"]').waitFor();
  const toggle = card.locator("#pl-badges-live");
  let saved = page.waitForResponse(POSTED(id));
  await toggle.click();
  drill.check((await saved).status() === 200, "owner: Live is saved");
  await card.locator('#pl-badges-live[data-placement-state="live"]').waitFor();
  await drill.shoot(page, "slots-card-live");

  // Preview on store: the founder preview opens the product page in a new tab
  const previewOf = async () => {
    const popup = page.context().waitForEvent("page"); // opened with noopener
    await card.locator('[data-placement-preview="badges"]').click();
    const tab = await popup;
    await tab.waitForLoadState("load");
    await tab.locator("[data-pdp-template]").waitFor();
    return tab;
  };
  let tab = await previewOf();
  const badge = tab.locator('[data-plugin-slot="storefront.pdp.under_atc"][data-plugin="trust-badges"][data-block="badges"]');
  await badge.waitFor();
  drill.check((await badge.locator("[data-plugin-off]").count()) === 0, "preview, Live: the badges show with no Turned off note");
  const slotHtml = await badge.evaluate((el) => el.outerHTML);
  drill.check(!/<script|<iframe|\son[a-z]+=/i.test(slotHtml), "the slot markup holds no script, iframe or handler");
  await drill.shoot(tab, "slots-preview-live");
  await tab.close();
  drill.check((await shopperSees()) === 0, "Live: the anonymous shopper on the closed store still gets no plugin markup");

  // support: the card with every write control gated, and the API refuses
  const support = await signIn(drill, "support");
  await open(support, `/admin/apps/${id}`);
  const sCard = support.locator("#app-blocks");
  await sCard.locator('[data-placement="badges"]').waitFor();
  const ungated = await sCard.evaluate((el) =>
    [...el.querySelectorAll("button, input, [role=combobox]")]
      .filter((b) => !b.hasAttribute("data-read-control") && !b.disabled && !(b.getAttribute("aria-disabled") === "true" && b.getAttribute("data-role-gate") === "disabled"))
      .map((b) => b.outerHTML.slice(0, 120)),
  );
  drill.check(ungated.length === 0, "support: every write control on the card is gated", ungated);
  drill.check((await api(support, `apps/${id}/blocks`, { block: "badges", state: "off" })).status === 403, "support: the API refuses a change (403)");
  await support.context().close();

  // Off: the preview shows it with the founder's note; the shopper still sees nothing
  saved = page.waitForResponse(POSTED(id));
  await toggle.click();
  drill.check((await saved).status() === 200, "owner: Off is saved");
  await card.locator('#pl-badges-live[data-placement-state="off"]').waitFor();
  tab = await previewOf();
  await tab.locator('[data-block="badges"] [data-plugin-off]').waitFor();
  drill.check(true, "preview, Off: the badges show with the Turned off note");
  await drill.shoot(tab, "slots-preview-off");
  await tab.close();
  drill.check((await shopperSees()) === 0, "Off: the anonymous shopper gets no plugin markup");

  await anonCtx.close();
  drill.check((await api(page, `apps/${id}`, { uninstall: true })).status === 200, "owner: uninstalled again");
  await page.context().close();
});
