// P1-DRILLS · ED-01 "Browser drills still needed" (docs/cms-reviews/P1-ED-01.md),
// now on the edge runtime with no runtime flip.
//   b1    click the hero, then a section, in the frame at 1440 and 1024
//   b2    pick the last home section from the Sections drawer at 1024 (close-on-pick)
//   b3    typed announcement text and hero title at 1280 (hero-promise ended)
//   b4    the store inside reports innerWidth 1280 with desktop navigation, at 1024 and 1440
//   b5    product designer at 1280: pairs region, and a pdp-modules region
//   b7    designer loading skeleton (RSC answers delayed by the drill, no code edit)
//   b8    the error page by keyboard (temporary throw, reverted; run by ed01-b8.mjs)
import { text, seen, settle, sleep } from "./util.mjs";
import { rows } from "./db.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const id = "ED-01";
export const title = "P1-DRILLS ED-01: the full-width editor on the edge runtime";

const H = { 1440: 900, 1280: 900, 1024: 768 };

async function designer(drill, width, path = "/admin/storefront/designer") {
  const ctx = await drill.context({ width });
  const page = await drill.signIn(ctx);
  await page.setViewportSize({ width, height: H[width] || 900 });
  await drill.open(page, path);
  await seen(page, "Preview shows your last save", 60_000);
  await page.waitForTimeout(800);
  return { ctx, page };
}

const frameOf = (page, re = /^\/$/) => page.frames().find((f) => f !== page.mainFrame() && re.test(new URL(f.url()).pathname));

async function frameFacts(page, re) {
  const fr = frameOf(page, re);
  const caption = await page.locator("[data-frame-caption]").first().innerText().catch(() => null);
  const box = await page.evaluate(() => {
    const f = document.querySelector("[data-preview-canvas] iframe");
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { shownWidth: Math.round(r.width), cssWidth: f.offsetWidth, transform: getComputedStyle(f).transform };
  });
  const inner = fr ? await fr.evaluate(() => ({ innerWidth: window.innerWidth, desktop: matchMedia("(min-width: 1024px)").matches })).catch(() => null) : null;
  return { caption, box, inner };
}

// What the console has selected: the tree's current item, else the inspector's first heading.
async function selected(page) {
  return page.evaluate(() => {
    const cur = document.querySelector('[data-editor-pane="tree"] [aria-current="true"], [aria-current="true"]');
    const insp = document.querySelector('[data-editor-pane="inspector"], [aria-label="Settings"]');
    const h = insp?.querySelector("h2, h3");
    return { tree: cur?.innerText.trim() || null, inspector: h?.innerText.trim() || null, heroField: Boolean(document.querySelector("#ins-hero-title")) };
  });
}

async function outlined(page, id) {
  const fr = frameOf(page);
  return fr.evaluate((sid) => {
    const el = document.querySelector(`[data-sec="${sid}"]`);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, selected: el.classList.contains("storeasy-selected"), outline: getComputedStyle(el).outlineStyle, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, inView: r.top < window.innerHeight && r.bottom > 0 };
  }, id);
}

async function homeSections(page) {
  const fr = frameOf(page);
  return fr.evaluate(() => [...document.querySelectorAll("[data-sec]")].map((e) => ({ id: e.getAttribute("data-sec"), text: (e.innerText || "").split("\n")[0].slice(0, 40) })));
}

export const parts = {
  async b1(drill) {
    for (const width of [1440, 1024]) {
      const { ctx, page } = await designer(drill, width);
      const ff = await frameFacts(page);
      drill.note(`B1 at ${width}: caption "${ff.caption}", frame ${JSON.stringify(ff.box)}, store inside ${JSON.stringify(ff.inner)}`);
      const secs = await homeSections(page);
      const fr = frameOf(page);
      await fr.locator('[data-sec="hero"]').first().click({ position: { x: 40, y: 40 } });
      await page.waitForTimeout(900);
      await page.mouse.move(5, 5); // off the frame, so the hover outline doesn't mask the selected one
      let sel = await selected(page);
      let o = await outlined(page, "hero");
      drill.check(sel.heroField && o.selected && o.outline === "solid", `B1 at ${width}: clicking the hero in the frame selects it and outlines it`, { sel, o });
      await drill.shoot(page, `B1-${width}-hero`);
      const sec = secs.find((s) => !["hero", "announcement"].includes(s.id) && /arrivals|collection/i.test(s.text)) || secs.find((s) => !["hero", "announcement"].includes(s.id));
      await fr.locator(`[data-sec="${sec.id}"]`).first().scrollIntoViewIfNeeded();
      await fr.locator(`[data-sec="${sec.id}"]`).first().click({ position: { x: 30, y: 10 } });
      await page.waitForTimeout(900);
      await page.mouse.move(5, 5);
      sel = await selected(page);
      o = await outlined(page, sec.id);
      const heroStill = await outlined(page, "hero");
      drill.check(!sel.heroField && o.selected && !heroStill.selected, `B1 at ${width}: then clicking a section ("${sec.text}") selects it and outlines it`, { sel, o });
      await drill.shoot(page, `B1-${width}-section`);
      await ctx.close();
    }
  },

  async b2(drill) {
    const { ctx, page } = await designer(drill, 1024);
    const toggle = page.locator("[data-tree-toggle]");
    await toggle.click();
    await page.waitForTimeout(500);
    const drawer = page.locator("dialog[open]").first();
    const items = await drawer.locator("ul button").allInnerTexts();
    const names = items.map((t) => t.trim()).filter((t) => t && !/^(Add section|Undo|Redo)$/.test(t));
    const last = names[names.length - 1];
    drill.note(`B2: the drawer lists ${JSON.stringify(names)}`);
    await drawer.getByRole("button", { name: last, exact: true }).first().click();
    await page.waitForTimeout(1500);
    const open = await page.locator("dialog[open]").count();
    const focus = await page.evaluate(() => ({ dataTree: document.activeElement?.hasAttribute("data-tree-toggle"), text: document.activeElement?.innerText?.trim() }));
    const secs = await homeSections(page);
    const target = secs.filter((s) => !["hero", "announcement"].includes(s.id)).pop();
    const o = await outlined(page, target.id);
    drill.check(open === 0, "B2 at 1024: picking the last section closes the drawer", open);
    drill.check(focus.dataTree, "B2: focus returns to the Sections button", focus);
    drill.check(o.selected && o.inView, `B2: the preview outlines "${last}" and scrolls it into view`, o);
    await drill.shoot(page, "B2-1024-last-section-picked");
    await ctx.close();
  },

  async b3(drill) {
    const exp = await rows("tenant", "SELECT slug, status FROM experiments");
    drill.check(!exp.some((e) => e.status === "running"), "B3 setup: no hero experiment running (hero-promise completed in the console earlier)", exp);
    const { ctx, page } = await designer(drill, 1280);
    const before = await frameFacts(page);
    // announcement text
    await page.getByRole("button", { name: "Announcement bar", exact: true }).first().click();
    const ANN = `Drill announcement ${Date.now() % 100000}`;
    await page.locator("#ins-ann-text").fill(ANN);
    const t0 = Date.now();
    let shownAnn = null;
    while (Date.now() - t0 < 5000) {
      const t = await frameOf(page).evaluate(() => document.body.innerText).catch(() => "");
      if (t.includes(ANN)) {
        shownAnn = Date.now() - t0;
        break;
      }
      await sleep(50);
    }
    const mid = await frameFacts(page);
    drill.check(shownAnn != null && shownAnn <= 1500, "B3: typed announcement text shows in the preview within about 1 s", shownAnn != null ? `${shownAnn} ms` : "not within 5 s");
    drill.check(mid.caption === before.caption && mid.box?.shownWidth === before.box?.shownWidth && mid.inner?.innerWidth === before.inner?.innerWidth, "B3: caption, frame size and inner width unchanged", { before, after: mid });
    await drill.shoot(page, "B3-1280-announcement");
    // hero title
    await page.getByRole("button", { name: "Hero", exact: true }).first().click();
    const TITLE = `Drill title ${Date.now() % 100000}`;
    await page.locator("#ins-hero-title").fill(TITLE);
    const t1 = Date.now();
    let shownTitle = null;
    while (Date.now() - t1 < 5000) {
      const t = await frameOf(page).evaluate(() => document.querySelector('[data-sec="hero"] h1')?.innerText || "").catch(() => "");
      if (t.includes(TITLE)) {
        shownTitle = Date.now() - t1;
        break;
      }
      await sleep(50);
    }
    const end = await frameFacts(page);
    const device = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Preview width"] button')].map((b) => `${b.innerText.trim()}:${b.getAttribute("aria-pressed")}`));
    drill.check(shownTitle != null && shownTitle <= 1500, "B3: typed hero title shows in the preview within about 1 s", shownTitle != null ? `${shownTitle} ms` : "not within 5 s");
    drill.check(end.caption === before.caption && end.box?.shownWidth === before.box?.shownWidth, "B3: device, shrink and caption unchanged", { before, end, device });
    await drill.shoot(page, "B3-1280-hero-title");
    await ctx.close();
  },

  async b4(drill) {
    for (const width of [1024, 1440]) {
      const { ctx, page } = await designer(drill, width);
      const ff = await frameFacts(page);
      const nav = await frameOf(page).evaluate(() => {
        const links = [...document.querySelectorAll("header a, header nav a")].filter((a) => a.getClientRects().length && getComputedStyle(a).visibility !== "hidden" && a.offsetParent);
        const burger = [...document.querySelectorAll("header button")].find((b) => /menu/i.test(b.getAttribute("aria-label") || "") && b.offsetParent);
        return { visibleLinks: links.map((a) => a.innerText.trim()).filter(Boolean).slice(0, 8), burger: Boolean(burger) };
      });
      drill.check(ff.inner?.innerWidth === 1280 && ff.inner?.desktop, `B4 at ${width}: the store inside reports innerWidth 1280 (desktop media query true)`, ff);
      drill.check(nav.visibleLinks.some((l) => /Bestsellers|Serums|Night routine|Shop all/.test(l)) && !nav.burger, `B4 at ${width}: the store shows its desktop navigation (no menu button)`, nav);
      drill.note(`B4 at ${width}: caption "${ff.caption}", shown ${ff.box?.shownWidth}px`);
      await drill.shoot(page, `B4-${width}`);
      await ctx.close();
    }
  },

  async b5(drill) {
    // Setup for the pdp-modules region: one accordion on every product page (a draft).
    {
      const c0 = await drill.context({ width: 1280 });
      const p0 = await drill.signIn(c0);
      await drill.open(p0, "/admin/storefront/product-pages");
      const card = p0.locator("section", { has: p0.getByRole("heading", { name: /^Accordions on every product page/ }) }).first();
      if ((await p0.getByLabel("Accordion 1 title", { exact: true }).count()) === 0) {
        await card.getByRole("button", { name: /^Add accordion/ }).click();
        await p0.getByLabel("Accordion 1 title", { exact: true }).fill("How to use");
        await p0.getByLabel("Accordion 1 HTML", { exact: true }).fill("<p>Two drops, morning and night.</p>");
        const put = p0.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
        await card.getByRole("button", { name: "Save", exact: true }).click();
        drill.check((await put).status() === 200, "B5 setup: an accordion on every product page saved (Product pages, PUT 200)");
      }
      await c0.close();
    }
    const { ctx, page } = await designer(drill, 1280, "/admin/storefront/designer/product");
    const choose = page.getByRole("button", { name: "Choose a product…" });
    if (await choose.count()) {
      await choose.click();
      await page.getByRole("dialog").getByRole("button", { name: /Radiance Glow Serum 30ml/ }).first().click({ timeout: 30_000 });
    }
    await seen(page, "Preview shows your last save", 60_000);
    let fr = null;
    for (let i = 0; i < 60 && !fr; i++) {
      fr = frameOf(page, /^\/products\//);
      if (!fr) await sleep(500);
    }
    await fr.waitForFunction(() => document.querySelector('[data-sec="pdp-pairs"]') || document.querySelector("h1"), null, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    fr = frameOf(page, /^\/products\//);
    const regions = await fr.evaluate(() => [...document.querySelectorAll("[data-sec]")].map((e) => e.getAttribute("data-sec")));
    drill.note(`B5: regions in the product preview: ${JSON.stringify(regions)}`);
    const flashOf = async (title) =>
      page.evaluate((t) => {
        const h = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim().startsWith(t));
        const card = h?.closest("section");
        if (!card) return null;
        const r = card.getBoundingClientRect();
        const insp = card.closest('[data-editor-pane="inspector"], [aria-label="Settings"]');
        return { cls: (card.parentElement?.className || "") + " > " + card.className, ring: /ring-2/.test(card.parentElement?.className || ""), inView: r.top >= 0 && r.bottom <= window.innerHeight + 1, top: Math.round(r.top), inspectorWidth: insp ? Math.round(insp.getBoundingClientRect().width) : null };
      }, title);
    const clickRegion = async (rid, cardTitle, label) => {
      const before = await flashOf(cardTitle);
      await fr.locator(`[data-sec="${rid}"]`).first().scrollIntoViewIfNeeded();
      await fr.locator(`[data-sec="${rid}"]`).first().click({ position: { x: 20, y: 10 } });
      const seenCls = [];
      for (let i = 0; i < 12; i++) {
        await sleep(100);
        const f = await flashOf(cardTitle);
        if (f) seenCls.push(f.cls);
      }
      await page.waitForTimeout(600);
      const after = await flashOf(cardTitle);
      const flashed = seenCls.some((c) => c !== before?.cls);
      drill.check(after?.inView && flashed, `${label}: clicking the region brings "${cardTitle}" into view and flashes it`, { before: before?.cls, during: [...new Set(seenCls)], after });
      return after;
    };
    if (regions.includes("pdp-pairs")) {
      await clickRegion("pdp-pairs", "Also on this page", "B5 at 1280 (pairs)");
      await drill.shoot(page, "B5-1280-pairs");
    } else drill.check(false, "B5: the product preview has a pairs region", regions);

    if (regions.includes("pdp-modules")) {
      const a = await clickRegion("pdp-modules", "Modules", "B5 at 1280 (pdp-modules)");
      drill.note(`B5: the Modules card sits in an inspector ${a?.inspectorWidth}px wide`);
      await drill.shoot(page, "B5-1280-modules");
    } else drill.check(false, "B5 (modules): the product preview has a pdp-modules region (save an accordion under Product pages first)", regions);
    await ctx.close();
  },

  async b7(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/storefront");
    // The designer pages carry a temporary 4 s delay for this part
    // (scripts/drills/p1/ed01-temp.mjs delay; reverted right after).
    const delayed = /P1-DRILLS ED-01 B7/.test(readFileSync(join(drill.root, "app/(console)/admin/(authed)/storefront/designer/page.js"), "utf8"));
    drill.check(delayed, "B7 setup: the temporary 4 s delay is in the designer pages");
    const watchSkeleton = async (label, expectTree) => {
      let sk = null;
      for (let i = 0; i < 60 && !sk; i++) {
        sk = await page.evaluate(() => {
          const s = document.querySelector('[aria-busy="true"][aria-label="Loading"]');
          if (!s) return null;
          const menu = s.querySelector("[data-console-menu]");
          const header = s.querySelector("header")?.getBoundingClientRect();
          return { menu: Boolean(menu), tree: Boolean(s.querySelector('[data-editor-pane="tree"]')), header: header && { top: Math.round(header.top), height: Math.round(header.height) } };
        });
        if (!sk) await sleep(50);
      }
      drill.check(Boolean(sk) && sk.menu, `B7 ${label}: an editor-shaped skeleton with the Open menu button shows`, sk);
      if (sk) drill.check(sk.tree === expectTree, `B7 ${label}: ${expectTree ? "with" : "no"} tree in the skeleton`, sk);
      if (sk) await drill.shoot(page, `B7-${label}-skeleton`);
      return sk;
    };
    const realHeader = async () =>
      page.evaluate(() => {
        if (document.querySelector('[aria-busy="true"][aria-label="Loading"]')) return null;
        const h = document.querySelector("[data-editor-shell] header")?.getBoundingClientRect();
        return h && { top: Math.round(h.top), height: Math.round(h.height) };
      });
    // Storefront → Designer (the sidebar link)
    await page.getByRole("link", { name: "Designer", exact: true }).first().click();
    const sk1 = await watchSkeleton("home", true);
    if (sk1) {
      await page.locator('[aria-busy="true"] [data-console-menu]').click();
      await page.waitForTimeout(500);
      const navOpen = await page.evaluate(() => {
        const d = document.querySelector("dialog[open]");
        return d ? { links: [...d.querySelectorAll("a")].map((a) => a.innerText.trim()).filter(Boolean).slice(0, 6) } : null;
      });
      drill.check(navOpen && navOpen.links.length > 3, "B7: the skeleton's menu opens the navigation", navOpen);
      await drill.shoot(page, "B7-home-skeleton-menu-open");
      await page.keyboard.press("Escape");
    }
    let real = null;
    for (let i = 0; i < 100 && !real; i++) {
      real = await realHeader();
      if (!real) await sleep(100);
    }
    await seen(page, "Add section", 30_000);
    real = await realHeader();
    drill.check(sk1 && real && sk1.header.top === real.top && Math.abs(sk1.header.height - real.height) <= 1, "B7 home: the real editor replaces the skeleton without the top bar jumping", { skeleton: sk1?.header, real });
    // Then the Product page tab
    await page.getByRole("link", { name: "Product page", exact: true }).first().click();
    const sk2 = await watchSkeleton("product", false);
    real = null;
    for (let i = 0; i < 100 && !real; i++) {
      real = await realHeader();
      if (!real) await sleep(100);
    }
    await page.waitForTimeout(1500);
    real = await realHeader();
    drill.check(sk2 && real && sk2.header.top === real.top && Math.abs(sk2.header.height - real.height) <= 1, "B7 product: the real editor replaces the skeleton without the top bar jumping", { skeleton: sk2?.header, real });
    await drill.shoot(page, "B7-product-real");
    await ctx.close();
  },

  async b8(drill) {
    const thrown = /P1-DRILLS ED-01 B8/.test(readFileSync(join(drill.root, "app/(console)/admin/(authed)/storefront/designer/page.js"), "utf8"));
    drill.check(thrown, "B8 setup: the temporary throw is in the designer page");
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    await page.setViewportSize({ width: 1440, height: 900 });
    await drill.open(page, "/admin/storefront/designer");
    const shown = await seen(page, "This page hit an error", 30_000);
    drill.check(shown, 'B8: the error page shows ("This page hit an error")');
    await drill.shoot(page, "B8-error-page");
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.innerText?.trim(), menu: document.activeElement?.hasAttribute("data-console-menu") }));
    drill.check(first.menu || first.label === "Open menu", "B8: Tab from the top: Open menu is the first stop", first);
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + " " + getComputedStyle(document.activeElement).boxShadow.slice(0, 60));
    drill.note(`B8: focus style on Open menu: ${ring}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const inside = await page.evaluate(() => {
      const d = document.querySelector("dialog[open]");
      return { open: Boolean(d), focusInside: Boolean(d && d.contains(document.activeElement)), focus: document.activeElement?.innerText?.trim().slice(0, 40) || document.activeElement?.getAttribute("aria-label") };
    });
    drill.check(inside.open && inside.focusInside, "B8: Enter opens the navigation with focus inside", inside);
    await drill.shoot(page, "B8-menu-open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => ({ open: Boolean(document.querySelector("dialog[open]")), menu: document.activeElement?.hasAttribute("data-console-menu"), label: document.activeElement?.getAttribute("aria-label") }));
    drill.check(!back.open && back.menu, "B8: Escape closes it with focus back on the button", back);
    let reached = null;
    for (let i = 1; i <= 40; i++) {
      await page.keyboard.press("Tab");
      const t = await page.evaluate(() => document.activeElement?.innerText?.trim());
      if (/^Try again$/.test(t || "")) {
        reached = i;
        break;
      }
    }
    drill.check(reached != null, "B8: Try again is reachable by Tab", reached != null ? `${reached} more Tab presses` : "not in 40");
    await ctx.close();
  },
};
