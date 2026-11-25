// drill:apps stage "slots" (Phase 4 line 2): the owner turns Trust badges'
// Badges block Live on the app's "Where it shows" card; an anonymous browser
// sees it on a product page; turning it Off hides it again. Support sees the
// card with every write control gated. Runs after "install" (which ends with
// the app uninstalled), so it installs Trust badges again through the API and
// uninstalls it at the end.
// Selectors are ids, data-* hooks and exact names; every wait is for a row or
// an answer, never a fixed time.
import { ORIGIN, api, open, signIn, stage } from "./lib.mjs";

const POSTED = (id) => (r) => r.url().endsWith(`/api/admin/apps/${id}/placements`) && r.request().method() === "POST";

stage("slots", async (drill) => {
  const page = await signIn(drill, "owner");
  await open(page, "/admin/apps");
  const made = await api(page, "apps", { install: { pluginId: "trust-badges", scopes: [] } });
  drill.check(made.status === 200, "owner: Trust badges installs for the slots stage", made.json?.error);
  const id = made.json?.install?.id;
  const listed = await api(page, `apps/${id}/placements`);
  const productPath = listed.json?.previewPaths?.["storefront.pdp.under_atc"];
  drill.check(typeof productPath === "string" && productPath.startsWith("/products/"), "a product page to look at", productPath);
  drill.check(listed.json?.placements?.map((p) => p.state).join(",") === "off,off", "both blocks start Off", listed.json?.placements);

  // the anonymous shopper: a fresh context with no cookies
  const anonCtx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  anonCtx.setDefaultTimeout(30_000);
  const anon = await anonCtx.newPage();
  const shopperSees = async () => {
    await anon.goto(ORIGIN + productPath, { waitUntil: "domcontentloaded" });
    await anon.locator("[data-pdp-template]").waitFor();
    return anon.locator('[data-plugin-slot][data-plugin="trust-badges"][data-block="badges"]').count();
  };
  drill.check((await shopperSees()) === 0, "before: the shopper sees no badges");

  // the owner turns Badges Live on the card
  await open(page, `/admin/apps/${id}`);
  const card = page.locator("#app-placements");
  await card.locator('[data-placement="badges"]').waitFor();
  const toggle = card.locator("#pl-badges-live");
  let saved = page.waitForResponse(POSTED(id));
  await toggle.click();
  drill.check((await saved).status() === 200, "owner: Live is saved");
  await card.locator('#pl-badges-live[data-placement-state="live"]').waitFor();
  await drill.shoot(page, "slots-card-live");

  drill.check((await shopperSees()) === 1, "after Live: the shopper sees the badges on the product page");
  const slotHtml = await anon.locator('[data-plugin-slot][data-block="badges"]').evaluate((el) => el.outerHTML);
  drill.check(!/<script|<iframe|\son[a-z]+=/i.test(slotHtml), "the slot markup holds no script, iframe or handler");
  drill.check((await anon.locator("[data-founder-note]").count()) === 0, "the shopper never sees a founder note");
  await drill.shoot(anon, "slots-pdp-live");

  // support: the card with every write control gated, and the API refuses
  const support = await signIn(drill, "support");
  await open(support, `/admin/apps/${id}`);
  const sCard = support.locator("#app-placements");
  await sCard.locator('[data-placement="badges"]').waitFor();
  const ungated = await sCard.evaluate((el) =>
    [...el.querySelectorAll("button, input, [role=combobox]")]
      .filter((b) => !b.hasAttribute("data-read-control") && !b.disabled && !(b.getAttribute("aria-disabled") === "true" && b.getAttribute("data-role-gate") === "disabled"))
      .map((b) => b.outerHTML.slice(0, 120)),
  );
  drill.check(ungated.length === 0, "support: every write control on the card is gated", ungated);
  drill.check((await api(support, `apps/${id}/placements`, { block: "badges", state: "off" })).status === 403, "support: the API refuses a change (403)");
  await support.context().close();

  // Off hides it again
  saved = page.waitForResponse(POSTED(id));
  await toggle.click();
  drill.check((await saved).status() === 200, "owner: Off is saved");
  await card.locator('#pl-badges-live[data-placement-state="off"]').waitFor();
  drill.check((await shopperSees()) === 0, "after Off: the shopper sees no badges");

  await anonCtx.close();
  drill.check((await api(page, `apps/${id}`, { uninstall: true })).status === 200, "owner: uninstalled again");
  await page.context().close();
});
