// P1-FIX-C drills (docs/cms-reviews/P1-FIX-C.md): the batch B drill failures,
// run again on the design harness after the fix.
//   settings   GEN-03 drill 6: save shipping rates, reload at once
//   brand      P1-DRILLS finding 1 (Brand): save brand, Publishing at once, Publish now
//   missingcol P1-DRILLS finding 5: cms_pages reads fail "no such column"
//   oldshape   the expected old shape still works: cms_pages without the family columns
// Breaks are made in the harness's local tenant database only, and undone at the
// end of each part (and by a re-seed).
import { sql, rows } from "./db.mjs";
import { text, seen, watch, settle } from "./util.mjs";

export const id = "FIX-C";
export const title = "P1-FIX-C: the console shows a founder's save at once; a broken schema isn't an old store";

const W = 1280;

async function signedIn(drill) {
  const ctx = await drill.context({ width: W });
  const page = await drill.signIn(ctx);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return { ctx, page };
}
async function banners(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("div")]
      .filter((d) => /(danger|warning|success|info)-bg/.test(d.className || "") && /rounded-ctl border/.test(d.className || ""))
      .map((d) => d.innerText.replace(/\s+\n/g, "\n").trim()),
  );
}
async function toasts(page) {
  return page.evaluate(() => [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim())).filter(Boolean));
}
const rates = async (page) => ({
  flat: await page.locator("#sa-flat-rate").inputValue(),
  free: await page.locator("#sa-free-over").inputValue(),
  cod: await page.locator("#sa-cod-fee").inputValue(),
  notice: (await text(page)).includes("You haven't set your own shipping rates yet"),
});
const storedRates = async () => JSON.parse((await rows("platform", "SELECT json_extract(config,'$.shipping_config') s FROM tenants WHERE id='design'"))[0].s || "null");

async function publishNow(page) {
  const btn = page.getByRole("button", { name: "Publish now", exact: true }).first();
  if (!(await btn.isEnabled())) return { status: "nothing to publish" };
  await btn.click();
  await page.waitForTimeout(400);
  const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/releases" && r.request().method() === "POST", { timeout: 30_000 });
  await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
  const res = await posted;
  let t = [];
  for (let i = 0; i < 20 && !t.length; i++) {
    await page.waitForTimeout(250);
    t = await toasts(page);
  }
  return { status: res.status(), body: await res.json().catch(() => null), toasts: t };
}

export const parts = {
  async settings(drill) {
    await sql("platform", "UPDATE tenants SET config = json_remove(config, '$.shipping_config') WHERE id = 'design'");
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/settings", { width: W });
    await page.locator("#shipping").scrollIntoViewIfNeeded();
    const notice = await seen(page, "You haven't set your own shipping rates yet", 10_000);
    drill.check(notice, "settings: starter rates, with the notice");
    drill.note(`settings: starter values shown: ${JSON.stringify(await rates(page))}`);
    await page.locator("#sa-flat-rate").fill("79");
    await page.locator("#sa-free-over").fill("1999");
    await page.locator("#sa-cod-fee").fill("49");
    await page.locator("#sa-cod-waive").fill("");
    const put = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    const pr = await put;
    drill.check(pr.status() === 200, "settings: Save settings answers 200", pr.status());
    // at once: no wait before the reload
    await page.reload();
    await settle(page);
    await page.locator("#shipping").scrollIntoViewIfNeeded();
    const after = await rates(page);
    drill.note(`settings: the control plane right after Save: ${JSON.stringify(await storedRates())}`);
    drill.check(after.flat === "79" && after.free === "1999" && after.cod === "49" && !after.notice, "settings: a reload right after Save shows the saved rates and no notice", after);
    await drill.shoot(page, "settings-reload-at-once");
    // four more reloads in a row, and a new tab: each request may land anywhere
    const more = [];
    for (let i = 0; i < 4; i++) {
      await page.reload();
      await settle(page);
      more.push(await rates(page));
    }
    drill.check(more.every((r) => r.free === "1999" && !r.notice), "settings: four more reloads in a row all show the saved rates", more);
    const tab = await ctx.newPage();
    await drill.open(tab, "/admin/settings", { width: W });
    const inTab = await rates(tab);
    drill.check(inTab.free === "1999" && !inTab.notice, "settings: a new tab shows the saved rates", inTab);
    // put the starter rates back behind the console's back: the console sees that at once too
    await sql("platform", "UPDATE tenants SET config = json_remove(config, '$.shipping_config') WHERE id = 'design'");
    await tab.reload();
    await settle(tab);
    await tab.locator("#shipping").scrollIntoViewIfNeeded();
    const back = await rates(tab);
    drill.check(back.free === "999" && back.notice, "settings: rates removed in the control plane show as starter rates on the next reload", back);
    await drill.shoot(tab, "settings-after-control-plane-change");
    await ctx.close();
  },

  async brand(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const base = await publishNow(page);
    drill.note(`brand: baseline publish: ${JSON.stringify({ status: base.status, toasts: base.toasts })}`);
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    drill.check(!(await page.getByRole("button", { name: "Publish now", exact: true }).first().isEnabled()), "brand: before the save, Publishing has nothing to publish");

    await drill.open(page, "/admin/brand", { width: W });
    const was = await page.locator("#brand-accent").inputValue();
    const accent = was.toLowerCase() === "#2563eb" ? "#7c3aed" : "#2563eb";
    await page.locator("#brand-accent").fill(accent);
    const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/brand" && r.request().method() === "PUT" && !/preview/.test(r.request().postData() || ""), { timeout: 30_000 });
    await page.getByRole("button", { name: "Save brand" }).click();
    const pr = await put;
    drill.check(pr.status() === 200, "brand: Save brand answers 200", pr.status());

    // at once
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const enabled = await page.getByRole("button", { name: "Publish now", exact: true }).first().isEnabled();
    const t = await text(page);
    drill.check(enabled, "brand: right after Save brand, Publishing has something to publish (Publish now enabled)");
    drill.check(/brand/i.test(t.slice(t.indexOf("What will publish"), t.indexOf("What will publish") + 600)), "brand: the change list names the brand", t.slice(t.indexOf("What will publish"), t.indexOf("What will publish") + 300));
    await drill.shoot(page, "brand-publishing-at-once");
    const pub = await publishNow(page);
    drill.check(pub.status === 200, "brand: Publish now answers 200, not 409", pub.status);
    drill.check(pub.toasts.some((x) => /Published/.test(x)), "brand: the toast says it is live", pub.toasts);
    const live = await rows("tenant", "SELECT json_extract(r.content, '$.brand.accent') a FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
    drill.check(String(live[0]?.a || "").toLowerCase() === accent, "brand: the live release holds the saved accent", live);
    await drill.shoot(page, "brand-published");
    await ctx.close();
  },

  async missingcol(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    await seen(page, "Add section", 30_000);
    await page.getByRole("button", { name: "Hero", exact: true }).first().click();
    await page.locator("#ins-hero-title").waitFor({ timeout: 15_000 });
    const NEW_TITLE = `Saved while a column is missing ${new Date().toISOString().slice(11, 19)}`;
    await page.locator("#ins-hero-title").fill(NEW_TITLE);
    const cols = (await rows("tenant", "PRAGMA table_info(cms_pages)")).map((r) => r.name);
    await sql("tenant", [
      "ALTER TABLE cms_pages RENAME TO cms_pages_data",
      `CREATE VIEW cms_pages AS SELECT ${cols.map((n) => (n === "title" ? "nosuch_col AS title" : n)).join(", ")} FROM cms_pages_data`,
    ]);
    try {
      const calls = watch(page, "/api/admin/storefront");
      await page.getByRole("button", { name: "Save", exact: true }).first().click();
      await page.waitForTimeout(3500);
      const b = await banners(page);
      drill.note(`missingcol: requests ${JSON.stringify(calls)}; banners ${JSON.stringify(b)}`);
      const save = calls.find((c) => c.method === "PUT");
      drill.check(save?.status === 503, "missingcol: the Designer save answers 503 (saved, refresh failed), not 200", save);
      drill.check(b.join("\n").includes("Your changes were saved, but this page couldn't refresh. Reload it before you make more changes."), "missingcol: the banner says the save went through and to reload", b);
      const hero = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'");
      drill.check(String(hero[0]?.value || "").includes(NEW_TITLE), "missingcol: the hero really was saved");
      await page.evaluate(() => window.scrollTo(0, 0));
      await drill.shoot(page, "missingcol-designer-saved-refresh-failed");

      const pe = await ctx.newPage();
      const res = await drill.open(pe, "/admin/storefront/pages/shipping", { width: W });
      const t = await text(pe);
      drill.note(`missingcol: /admin/storefront/pages/shipping answered ${res.status}; ${JSON.stringify(t.slice(0, 200))}`);
      drill.check(t.includes("This page hit an error"), 'missingcol: the page editor shows "This page hit an error"', t.slice(0, 200));
      drill.check((await pe.getByRole("button", { name: /Retry|Try again/ }).count()) > 0, "missingcol: with Try again");
      drill.check(!/404|not found/i.test(t.slice(0, 400)), "missingcol: not a 404", t.slice(0, 200));
      await drill.shoot(pe, "missingcol-page-editor-error");
      await pe.close();
    } finally {
      await sql("tenant", ["DROP VIEW cms_pages", "ALTER TABLE cms_pages_data RENAME TO cms_pages"]);
    }
    const pe2 = await ctx.newPage();
    await drill.open(pe2, "/admin/storefront/pages/shipping", { width: W });
    const t2 = await text(pe2);
    drill.check(!t2.includes("This page hit an error") && t2.includes("Shipping policy"), "missingcol: with the table back, the page editor opens the page", t2.slice(0, 200));
    await ctx.close();
  },

  async oldshape(drill) {
    // a store from before page families (tenant migration 0009): no family or
    // window columns. That is the expected old shape, and must keep working.
    const cols = (await rows("tenant", "PRAGMA table_info(cms_pages)")).map((r) => r.name).filter((n) => !["family", "window_start", "window_end"].includes(n));
    await sql("tenant", ["ALTER TABLE cms_pages RENAME TO cms_pages_data", `CREATE VIEW cms_pages AS SELECT ${cols.join(", ")} FROM cms_pages_data`]);
    const { ctx, page } = await signedIn(drill);
    try {
      await drill.open(page, "/admin/storefront/pages", { width: W });
      const list = await text(page);
      drill.check(!list.includes("This page hit an error") && /Shipping/i.test(list), "oldshape: the Pages list opens and lists the pages", list.slice(0, 300));
      await drill.shoot(page, "oldshape-pages-list");
      await drill.open(page, "/admin/storefront/pages/shipping", { width: W });
      const ed = await text(page);
      drill.check(!ed.includes("This page hit an error") && ed.includes("Shipping policy"), "oldshape: the page editor opens the page", ed.slice(0, 200));
      await drill.shoot(page, "oldshape-page-editor");
    } finally {
      await sql("tenant", ["DROP VIEW cms_pages", "ALTER TABLE cms_pages_data RENAME TO cms_pages"]);
    }
    await ctx.close();
  },
};
