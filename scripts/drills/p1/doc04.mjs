// P1-DRILLS · DOC-04 batch B drills (docs/cms-reviews/P1-DOC-04.md "Known limits"
// and "From review": the builder drills the reviewer did not repeat).
// Breaks are made in the harness's local tenant database only, and undone by a re-seed.
//   nav, pdp, home, overview, schedule   wording and numbering
//   publishfail                          cms_approvals reads broken around Publish now
//   savefail                             cms_pages reads broken: Designer save, page editor load
//   after                                after a re-seed: the console works again
import { sql, rows } from "./db.mjs";
import { text, seen, watch, settle, sleep } from "./util.mjs";

export const id = "DOC-04";
export const title = "P1-DRILLS DOC-04: plain, located messages, and failures after a write";

const W = 1280;

// Every banner's text (role=alert for danger; warning banners have no role).
async function banners(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("div")]
      .filter((d) => /(danger|warning|success|info)-bg/.test(d.className || "") && /rounded-ctl border/.test(d.className || ""))
      .map((d) => ({ tone: /(danger|warning|success|info)-bg/.exec(d.className)[1], inCard: Boolean(d.closest("section")), text: d.innerText.replace(/\s+\n/g, "\n").trim() })),
  );
}

async function toasts(page) {
  return page.evaluate(() => [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim())).filter(Boolean));
}

async function signedIn(drill) {
  const ctx = await drill.context({ width: W });
  const page = await drill.signIn(ctx);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return { ctx, page };
}

const sectionCard = (page, heading) => page.locator("section", { has: page.getByRole("heading", { name: heading }) }).first();

export const parts = {
  async nav(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/storefront/navigation", { width: W });
    const card = sectionCard(page, /^Header menu/);
    await card.getByRole("button", { name: "Custom menu" }).click();
    await page.waitForTimeout(300);
    let count = await card.locator('input[aria-label$=" label"][aria-label^="Item "]').count();
    drill.note(`nav: the custom header menu starts with ${count} item(s)`);
    // three rows: filled, empty label, filled
    const want = [
      { label: "Shop", href: "/collections" },
      { label: "", href: "/collections/serums" },
      { label: "Night routine", href: "/collections/night-routine" },
    ];
    while (count < want.length) {
      await card.getByRole("button", { name: /^Add item/ }).click();
      count++;
    }
    for (let i = 0; i < want.length; i++) {
      await card.getByLabel(`Item ${i + 1} label`, { exact: true }).fill(want[i].label);
      await card.getByLabel(`Item ${i + 1} link`, { exact: true }).fill(want[i].href);
    }
    const emptyRow = await card.evaluate((sec) => [...sec.querySelectorAll('input[aria-label^="Item "][aria-label$=" label"]')].findIndex((i) => !i.value.trim()) + 1);
    const calls = watch(page, "/api/admin/storefront");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2500);
    const b = await banners(page);
    const lines = b.flatMap((x) => x.text.split("\n")).filter((l) => /Header menu/.test(l));
    const put = calls.find((c) => c.method === "PUT");
    drill.note(`nav: PUT /api/admin/storefront answered ${put?.status}; banners: ${JSON.stringify(b)}`);
    drill.check(lines.some((l) => l.includes(`Header menu, item ${emptyRow}: needs a label and a path/URL`)), `nav: the banner reads "Header menu, item ${emptyRow}: needs a label and a path/URL"`, lines);
    drill.check(emptyRow === 2, "nav: N matches the empty row's position on screen (row 2 of 3)", emptyRow);
    await card.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await drill.shoot(page, "B-nav-empty-label");
    await ctx.close();
  },

  async pdp(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/storefront/product-pages", { width: W });
    const card = sectionCard(page, /^Accordions on every product page/);
    await card.getByRole("button", { name: /^Add accordion/ }).click();
    await card.getByRole("button", { name: /^Add accordion/ }).click();
    await page.getByLabel("Accordion 1 title", { exact: true }).fill("Shipping & delivery");
    await page.getByLabel("Accordion 1 HTML", { exact: true }).fill("<p>Ships in 2 days.</p>");
    await page.getByLabel("Accordion 2 title", { exact: true }).fill("");
    await page.getByLabel("Accordion 2 HTML", { exact: true }).fill("<p>How to use it.</p>");
    const calls = watch(page, "/api/admin/storefront");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2500);
    const b = await banners(page);
    const lines = b.flatMap((x) => x.text.split("\n"));
    drill.note(`pdp: PUT answered ${calls.find((c) => c.method === "PUT")?.status}; banners: ${JSON.stringify(b)}`);
    drill.check(lines.some((l) => l.includes("Product page accordions, accordion 2: needs a title")), 'pdp: "Product page accordions, accordion 2: needs a title"', lines);
    await page.evaluate(() => window.scrollTo(0, 0));
    await drill.shoot(page, "B-pdp-accordion-2");
    await ctx.close();
  },

  async home(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/storefront/home", { width: W });
    const card = sectionCard(page, /^Homepage sections/);
    const before = await card.locator('button[aria-label^="Hide section"]').count();
    await card.getByRole("button", { name: "Banner / CTA", exact: true }).click();
    await page.waitForTimeout(300);
    const rowsNow = await card.evaluate((sec) => [...sec.querySelectorAll('button[aria-label^="Hide section"]')].map((b) => b.getAttribute("aria-label")));
    drill.check(rowsNow.length === before + 1 && /Banner/.test(rowsNow[2] || ""), "home setup: a blank Banner / CTA added as row 3", rowsNow);
    const calls = watch(page, "/api/admin/storefront");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2500);
    let lines = (await banners(page)).flatMap((x) => x.text.split("\n"));
    drill.check(lines.some((l) => l.includes("Section 3 (Banner / CTA): needs a title or text")), 'home: Save shows "Section 3 (Banner / CTA): needs a title or text"', lines);
    await drill.shoot(page, "B-home-section-3");
    const n = calls.length;
    // Move up the third row
    await card.locator('button[aria-label="Move up"]').nth(2).click();
    await page.waitForTimeout(800);
    lines = (await banners(page)).flatMap((x) => x.text.split("\n"));
    const labels = await card.evaluate((sec) => [...sec.querySelectorAll('button[aria-label^="Hide section"]')].map((b) => b.getAttribute("aria-label")));
    drill.check(lines.some((l) => l.includes("Section 2 (Banner / CTA): needs a title or text")) && !lines.some((l) => l.includes("Section 3 (Banner / CTA)")), 'home: after Move up it reads "Section 2 (Banner / CTA): …"', lines);
    drill.check(labels[1]?.includes("Section 2 (Banner / CTA)") || labels[1]?.includes("section 2 (Banner / CTA)"), "home: and row 2 is the banner on screen", labels);
    drill.check(calls.length === n, "home: with no new request", calls.slice(n));
    await drill.shoot(page, "B-home-after-move-up");
    await ctx.close();
  },

  async overview(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/storefront/home", { width: W });
    const card = sectionCard(page, /^Homepage sections/);
    await card.getByRole("button", { name: "Banner / CTA", exact: true }).click();
    await page.waitForTimeout(300);
    const id = await card.evaluate((sec) => [...sec.querySelectorAll('input[id$="-title"]')].pop()?.id.replace(/-title$/, ""));
    await page.locator(`#${id}-title`).fill("Monsoon sale");
    await page.locator(`#${id}-label`).fill("Shop now");
    await page.locator(`#${id}-href`).fill("/collections/not-a-collection");
    const calls = watch(page, "/api/admin/storefront");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2500);
    const put = calls.find((c) => c.method === "PUT");
    drill.check(put?.status === 200, "overview setup: a banner linking to /collections/not-a-collection saved (PUT 200)", put);
    await drill.open(page, "/admin/storefront", { width: W });
    const b = await banners(page);
    const fix = b.find((x) => x.text.startsWith("Fix before publishing"));
    drill.note(`overview: banners: ${JSON.stringify(b)}`);
    const m = /Section (\d+) \(Banner \/ CTA\): ([^\n]*)/.exec(fix?.text || "");
    drill.check(Boolean(m), '"Fix before publishing" lists "Section N (Banner / CTA): …"', fix?.text);
    await drill.shoot(page, "B-overview-fix-before-publishing");
    // Where is it in the Designer?
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    await seen(page, "Add section", 30_000);
    const tree = await page.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim() === "Sections");
      const root = h?.closest("aside, section, div")?.parentElement || document;
      return [...root.querySelectorAll("li button, ul button")].map((b) => b.innerText.trim()).filter((t) => t && !/^(Add section|Undo|Redo)$/.test(t));
    });
    const bannerAt = tree.filter((t) => !["Hero", "Announcement bar"].includes(t)).findIndex((t) => /Monsoon sale|Banner/.test(t)) + 1;
    drill.note(`overview: the Designer's tree reads ${JSON.stringify(tree)}`);
    drill.check(m && Number(m[1]) === bannerAt, `overview: N (${m?.[1]}) matches the banner's position among the Designer's homepage sections (${bannerAt})`, { tree });
    await drill.shoot(page, "B-overview-designer-tree");
    await ctx.close();
  },

  async schedule(drill) {
    const { ctx, page } = await signedIn(drill);
    // D9's warnings: banner link /odd-route, hero primary /x-odd, announcement /another-odd
    await drill.open(page, "/admin/storefront/home", { width: W });
    const card = sectionCard(page, /^Homepage sections/);
    const hrefs = card.locator('input[id$="-href"]');
    const nHref = await hrefs.count();
    let fixed = false;
    for (let i = 0; i < nHref; i++) {
      if (["/collections/not-a-collection", "/odd-route"].includes(await hrefs.nth(i).inputValue())) {
        await hrefs.nth(i).fill("/odd-route");
        fixed = true;
      }
    }
    drill.check(fixed, "schedule setup: the banner's link changed to /odd-route (a warning, not an error)");
    let calls = watch(page, "/api/admin/storefront");
    const saveIfDirty = async (btn) => {
      if (await btn.isEnabled()) {
        await btn.click();
        await page.waitForTimeout(2000);
      }
    };
    await saveIfDirty(card.getByRole("button", { name: "Save", exact: true }));
    await page.locator("#hero-p-href").fill("/x-odd");
    await saveIfDirty(sectionCard(page, /^Hero/).getByRole("button", { name: "Save", exact: true }));
    await drill.open(page, "/admin/storefront/navigation", { width: W });
    await page.locator("#ann-href").fill("/another-odd");
    await saveIfDirty(sectionCard(page, /^Announcement bar/).getByRole("button", { name: "Save", exact: true }));
    const saved = await rows("tenant", "SELECT key, value FROM cms_blocks");
    const pages = JSON.stringify(saved);
    drill.check(calls.filter((c) => c.method === "PUT").every((c) => c.status === 200) && pages.includes("/x-odd") && pages.includes("/another-odd"), "schedule setup: banner, hero and announcement saved (every PUT 200; hero and announcement hold the odd links)", calls);

    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const cardWarnings = (await banners(page)).filter((x) => x.tone === "warning").flatMap((x) => x.text.split("\n")).filter((l) => /isn.t a storefront route/.test(l));
    drill.note(`schedule: the card's warnings before scheduling: ${JSON.stringify(cardWarnings)}`);
    drill.check(["Hero:", "Announcement bar:", "(Banner / CTA):"].every((k) => cardWarnings.some((l) => l.includes(k))), "schedule: the card lists located lines (Hero:, Announcement bar:, Section N (Banner / CTA):)", cardWarnings);
    const at = await page.evaluate(() => {
      const d = new Date(Date.now() + 2 * 86400000);
      d.setSeconds(0, 0);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`;
    });
    await page.locator("#release-at").fill(at);
    calls = watch(page, "/api/admin/releases");
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    let t = [];
    for (let i = 0; i < 40 && !t.some((x) => x.startsWith("Scheduled for")); i++) {
      await page.waitForTimeout(250);
      t = await toasts(page);
    }
    const toastOk = t.some((x) => x.startsWith("Scheduled for"));
    const top = (await banners(page)).find((x) => !x.inCard && x.tone !== "info");
    const topLines = top?.tone === "warning" ? top.text.split("\n") : [];
    drill.note(`schedule: POST ${JSON.stringify(calls.filter((c) => c.method === "POST"))}; toasts ${JSON.stringify(t)}; top banner ${JSON.stringify(top)}`);
    drill.check(toastOk && t.some((x) => x.startsWith("Scheduled for")), 'schedule: the toast "Scheduled for …"', t);
    const same = cardWarnings.every((l) => topLines.includes(l));
    drill.check(same && ["Hero:", "Announcement bar:", "(Banner / CTA):"].every((k) => topLines.some((l) => l.includes(k))), "schedule: the top banner lists the same located lines as the card", { topLines, cardWarnings });
    await page.evaluate(() => window.scrollTo(0, 0));
    await drill.shoot(page, "B-schedule-toast-and-banner");
    // Cancel the pending schedule so it can't fire later.
    const cancel = page.getByRole("button", { name: "Cancel schedule" }).first();
    if (await cancel.count()) {
      await cancel.click();
      await page.waitForTimeout(400);
      const dlg = page.locator("dialog[open]");
      await dlg.getByRole("button").filter({ hasText: /Cancel schedule|Yes|Confirm/ }).last().click().catch(() => {});
      const gone = await seen(page, "Schedule cancelled", 15_000);
      drill.note(`schedule: pending schedule cancelled afterwards: ${gone}`);
    }
    await ctx.close();
  },

  async publishfail(drill) {
    const { ctx, page } = await signedIn(drill);
    // Something to publish: a small hero edit through the Home editor.
    await drill.open(page, "/admin/storefront/home", { width: W });
    await page.locator("#hero-subtitle").fill(`The night-cream routine your skin asked for (drill ${new Date().toISOString().slice(11, 19)}).`);
    await sectionCard(page, /^Hero/).getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2000);
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const releasesBefore = await rows("tenant", "SELECT id FROM releases ORDER BY created_at DESC LIMIT 1");
    const liveBefore = await rows("tenant", "SELECT * FROM release_state");
    // Break reads of cms_approvals (local harness database only).
    await sql("tenant", [
      "ALTER TABLE cms_approvals RENAME TO cms_approvals_data",
      "CREATE VIEW cms_approvals AS SELECT id, draft_hash, actor, json_extract('not json','$') AS note, created_at FROM cms_approvals_data UNION ALL SELECT NULL, json_extract('not json','$'), NULL, json_extract('not json','$'), NULL",
    ]);
    try {
      const probe = await sql("tenant", "SELECT draft_hash, actor, note, created_at FROM cms_approvals WHERE draft_hash = 'x' ORDER BY created_at DESC").then(() => "reads").catch((e) => e.message);
      drill.note(`publishfail: a read of cms_approvals now fails: ${probe}`);
      const calls = watch(page, "/api/admin/releases");
      await page.getByRole("button", { name: "Publish now", exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
      let t = [];
      for (let i = 0; i < 80 && !t.includes("Published — live now."); i++) {
        await page.waitForTimeout(250);
        t = await toasts(page);
      }
      const toastOk = t.includes("Published — live now.");
      await page.waitForTimeout(500);
      const b = await banners(page);
      drill.note(`publishfail: POST ${JSON.stringify(calls.filter((c) => c.method === "POST"))}; toasts ${JSON.stringify(t)}; banners ${JSON.stringify(b)}`);
      drill.check(toastOk, 'publishfail: the toast "Published — live now."', t);
      const warn = b.find((x) => x.tone === "warning" && x.text.startsWith("Published. Your live store has the new version, but this page couldn't refresh"));
      drill.check(Boolean(warn), `publishfail: a warning banner starting "Published. Your live store has the new version, but this page couldn't refresh…"`, b);
      drill.check(!b.some((x) => x.tone === "danger"), "publishfail: no red error banner", b.filter((x) => x.tone === "danger"));
      await page.evaluate(() => window.scrollTo(0, 0));
      await drill.shoot(page, "B-publish-then-refresh-failed");
      // A page load while the reads are broken, for the record
      const p2 = await ctx.newPage();
      await drill.open(p2, "/admin/releases", { width: W });
      drill.note(`publishfail: loading Publishing while cms_approvals reads fail shows: ${JSON.stringify((await text(p2)).slice(0, 200))}`);
      await p2.close();
    } finally {
      await sql("tenant", ["DROP VIEW cms_approvals", "ALTER TABLE cms_approvals_data RENAME TO cms_approvals"]);
    }
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "History", 30_000);
    const releasesAfter = await rows("tenant", "SELECT id FROM releases ORDER BY created_at DESC LIMIT 1");
    const liveAfter = await rows("tenant", "SELECT * FROM release_state");
    drill.note(`publishfail: release_state before ${JSON.stringify(liveBefore)}, after ${JSON.stringify(liveAfter)}; newest release before ${releasesBefore[0]?.id}, after ${releasesAfter[0]?.id}`);
    const firstRow = await page.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim() === "History");
      const tr = h?.closest("section")?.querySelector("tbody tr");
      return tr?.innerText.replace(/\s+/g, " ").trim();
    });
    drill.check(releasesAfter[0]?.id !== releasesBefore[0]?.id && /\bLive\b/.test(firstRow || ""), "publishfail: after restoring cms_approvals and reloading, History shows the new release as Live", firstRow);
    await drill.shoot(page, "B-publish-history-live");
    await ctx.close();
  },

  async savefail(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    await seen(page, "Add section", 30_000);
    await page.getByRole("button", { name: "Hero", exact: true }).first().click();
    await page.locator("#ins-hero-title").waitFor({ timeout: 15_000 });
    const NEW_TITLE = `Winter repair, saved while reads fail ${new Date().toISOString().slice(11, 19)}`;
    await page.locator("#ins-hero-title").fill(NEW_TITLE);
    await sql("tenant", [
      "ALTER TABLE cms_pages RENAME TO cms_pages_data",
      "CREATE VIEW cms_pages AS SELECT slug, json_extract('not json','$') AS title, description, sections, enabled, updated_at, revision, schema_version, effective_at, family, window_start, window_end FROM cms_pages_data",
    ]);
    const calls = watch(page, "/api/admin/storefront");
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await page.waitForTimeout(3500);
    const b = await banners(page);
    drill.note(`savefail: requests ${JSON.stringify(calls)}; banners ${JSON.stringify(b)}`);
    const all = b.map((x) => x.text).join("\n");
    drill.check(all.includes("Your changes were saved, but this page couldn't refresh. Reload it before you make more changes."), `savefail: the banner reads "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes."`, all);
    drill.check(!/someone else|changed since you opened|conflict/i.test(all), "savefail: no conflict banner", all);
    drill.check(!/needs a|required|choose an/i.test(all), "savefail: no validation list", all);
    const titled = b.find((x) => x.text.includes("Your changes were saved"));
    drill.note(`savefail: the banner's title line is "${titled?.text.split("\n")[0]}" (known limit: under the Designer's "Couldn't save…" title)`);
    const hero = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'").catch((e) => [{ value: `read failed: ${e.message}` }]);
    drill.check(String(hero[0]?.value || "").includes(NEW_TITLE), "savefail: the hero really was saved (cms_blocks holds the new title)", String(hero[0]?.value || "").slice(0, 120));
    await page.evaluate(() => window.scrollTo(0, 0));
    await drill.shoot(page, "B-designer-saved-refresh-failed");

    // Page editor load with page reads failing
    const pe = await ctx.newPage();
    const res = await drill.open(pe, "/admin/storefront/pages/shipping", { width: W });
    const t = await text(pe);
    drill.note(`savefail: /admin/storefront/pages/shipping answered ${res.status}; text ${JSON.stringify(t.slice(0, 300))}`);
    drill.check(t.includes("This page hit an error"), 'page editor load: the console\'s "This page hit an error" screen', t.slice(0, 200));
    drill.check((await pe.getByRole("button", { name: /Retry|Try again/ }).count()) > 0, "page editor load: with Retry");
    drill.check(res.status !== 404 && !/not found|404/i.test(t.slice(0, 400)), "page editor load: not a 404", res.status);
    drill.check(!t.includes("Shipping policy") || t.includes("This page hit an error"), "page editor load: not a built-in default page", t.slice(0, 200));
    await drill.shoot(pe, "B-page-editor-reads-failing");
    await ctx.close();
    // Leave the break in place: the "after" part runs after a re-seed.
  },

  async after(drill) {
    const { ctx, page } = await signedIn(drill);
    const ok = await rows("tenant", "SELECT type FROM sqlite_master WHERE name='cms_pages'");
    drill.check(ok[0]?.type === "table", "after re-seed: cms_pages is a table again", ok);
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    const d = await seen(page, "Add section", 30_000);
    drill.check(d && !(await text(page)).includes("This page hit an error"), "after re-seed and reload: the Designer works");
    await drill.open(page, "/admin/storefront/pages/shipping", { width: W });
    const t = await text(page);
    drill.check(!t.includes("This page hit an error") && t.includes("Shipping policy"), "after re-seed and reload: the page editor opens the shipping page", t.slice(0, 200));
    await drill.shoot(page, "B-after-reseed-page-editor");
    await ctx.close();
  },
};
