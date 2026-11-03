// P1-DRILLS · AU-05 batch A drills D1–D11 (docs/cms-reviews/P1-AU-05.md
// "Browser drills still needed"). Pages are made through the console's own API
// from the signed-in page, then edited in the real page editor.
//   editor   D1–D9 in the page editor
//   publish  publish, then the live checks for D1, D7, D8
//   d10      a product description with stray markup (local product data only)
//   d11      a template holding an old empty-markup section (local DB row)
import { sql, rows } from "./db.mjs";
import { text, seen, settle, sleep } from "./util.mjs";
import { noThanks } from "./sf.mjs";

export const id = "AU-05";
export const title = "P1-DRILLS AU-05: the page editor keeps the founder's words";

const W = 1280;

async function api(page, method, url, body) {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, url, body],
  );
}

async function makePage(page, slug, title, sections) {
  const r = await api(page, "PUT", "/api/admin/storefront", { page: { slug, title, sections }, revision: null });
  if (r.status !== 200) {
    // already there from an earlier run: overwrite on purpose
    const r2 = await api(page, "PUT", "/api/admin/storefront", { page: { slug, title, sections }, force: true });
    return r2.status;
  }
  return r.status;
}

async function editor(drill, page, slug) {
  await drill.open(page, `/admin/storefront/pages/${slug}`, { width: W });
  await page.locator("#pe-title").waitFor({ timeout: 30_000 });
}

async function banner(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("div")].find((d) => /danger-bg/.test(d.className || "") && d.innerText.includes("Couldn't save"));
    return b ? b.innerText.trim() : null;
  });
}

async function badges(page) {
  return page.evaluate(() => [...document.querySelectorAll("span")].map((s) => s.innerText.trim()).filter((t) => /^\d+\. (Text|Rich HTML|Image|FAQ)$/.test(t)));
}

const unsaved = (page) => page.evaluate(() => [...document.querySelectorAll("span")].some((s) => s.innerText.trim() === "Unsaved"));

async function save(page) {
  const btn = page.getByRole("button", { name: "Save", exact: true }).first();
  if (!(await btn.isEnabled())) return "disabled";
  const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  const r = await put;
  await page.waitForTimeout(1200);
  return r.status();
}

const lastCard = (page) => page.locator('[class*="p-3"]').filter({ has: page.locator("span", { hasText: /^\d+\. / }) }).last();

export const parts = {
  async editor(drill) {
    const ctx = await drill.context({ width: W });
    const page = await drill.signIn(ctx);
    page.on("dialog", (d) => d.accept().catch(() => {}));

    // ---- D1 ----
    await makePage(page, "drill-au05-d1", "AU-05 D1", [{ kind: "text", heading: "About us", body: ["We make things by hand."] }]);
    await editor(drill, page, "drill-au05-d1");
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.getByLabel("Section paragraphs").last().fill("First paragraph.\n\nSecond paragraph.");
    let st = await save(page);
    drill.check(st === 200, "D1: a text section with two paragraphs and no heading saves (PUT 200)", st);
    await page.reload();
    await page.locator("#pe-title").waitFor();
    const heads = await page.getByLabel("Section heading").evaluateAll((els) => els.map((e) => e.value));
    const paras = await page.getByLabel("Section paragraphs").evaluateAll((els) => els.map((e) => e.value));
    drill.check(paras.some((p) => p.includes("First paragraph.") && p.includes("Second paragraph.")) && heads[heads.length - 1] === "", "D1: after reload both paragraphs are there and the heading is empty", { heads, paras });
    await drill.shoot(page, "D1-editor-after-reload");
    const [prev] = await Promise.all([ctx.waitForEvent("page", { timeout: 30_000 }), page.getByRole("button", { name: "Preview", exact: true }).click()]);
    await prev.waitForLoadState("load");
    await settle(prev);
    const pv = await prev.evaluate(() => ({ url: location.pathname + location.search.slice(0, 30), text: document.body.innerText, emptyH2: [...document.querySelectorAll("h2")].filter((h) => !h.textContent.trim()).length }));
    drill.check(pv.text.includes("First paragraph.") && pv.text.includes("Second paragraph.") && pv.emptyH2 === 0, "D1: the preview shows both paragraphs, with no empty h2 in the DOM", { url: pv.url, emptyH2: pv.emptyH2 });
    await noThanks(prev);
    await drill.shoot(prev, "D1-preview");
    await prev.close();

    // ---- D2 ----
    await editor(drill, page, "drill-au05-d1");
    await page.getByRole("button", { name: "Text", exact: true }).click();
    const b0 = await badges(page);
    st = await save(page);
    let msg = await banner(page);
    const n = b0.length;
    drill.check(st === 422 && msg && new RegExp(`section ${n}\\b`, "i").test(msg), `D2: a blank text section is refused with a plain message naming section ${n} (its badge reads "${b0[n - 1]}")`, { st, msg });
    drill.check(await unsaved(page), "D2: the Unsaved badge stays");
    await drill.shoot(page, "D2-blank-refused");
    // remove the blank section: Save succeeds (or there is nothing left to save)
    await page.getByRole("button", { name: "Remove section" }).last().click();
    await page.waitForTimeout(400);
    {
      const c = page.locator("dialog[open]").getByRole("button", { name: "Remove section" });
      if (await c.count()) await c.click();
    }
    const stRemoved = await save(page);
    const bannerRemoved = await banner(page);
    drill.note(`D2: right after removing the blank section the form matches the saved page, so Save is ${stRemoved === "disabled" ? "disabled" : stRemoved}; the earlier banner ${bannerRemoved ? `still reads ${JSON.stringify(bannerRemoved)}` : "is gone"}`);
    await drill.shoot(page, "D2-after-remove");
    // a real change too, so there is something to save
    await page.locator("#pe-title").fill("AU-05 D1 (saved again)");
    st = await save(page);
    const msgAfter = await banner(page);
    drill.check(st === 200 && !msgAfter && !(await unsaved(page)), "D2: with the blank section removed, Save succeeds (the banner and the Unsaved badge go)", { st, msgAfter });
    await page.reload();
    await page.locator("#pe-title").waitFor();
    const paras2 = await page.getByLabel("Section paragraphs").evaluateAll((els) => els.map((e) => e.value));
    drill.check(paras2.length === 2 && paras2[1].includes("Second paragraph."), "D2: after reload the earlier content is unchanged", paras2);

    // ---- D3 ----
    await makePage(page, "drill-au05-d3", "AU-05 D3", [{ kind: "text", heading: "Keep me", body: ["Kept."] }]);
    await editor(drill, page, "drill-au05-d3");
    await page.getByRole("button", { name: "Rich HTML", exact: true }).click();
    await page.getByLabel("Section heading").last().fill("Only a heading");
    await page.getByRole("button", { name: "Image", exact: true }).click();
    await page.getByLabel("Alt text (required)").last().fill("Only alt text");
    await page.getByRole("button", { name: "FAQ", exact: true }).click();
    await page.getByLabel("Answer HTML").last().fill("<p>An answer with no question.</p>");
    st = await save(page);
    msg = await banner(page);
    drill.note(`D3: banner ${JSON.stringify(msg)}`);
    drill.check(st === 422 && /section 2/i.test(msg || "") && /section 3/i.test(msg || "") && /section 4/i.test(msg || ""), "D3: the rich (heading only), image (alt only) and FAQ (answer, no question) sections are each refused", msg);
    const kept = {
      heading: await page.getByLabel("Section heading").nth(1).inputValue(), // text, rich, (image has none), faq
      alt: await page.getByLabel("Alt text (required)").last().inputValue(),
      answer: await page.getByLabel("Answer HTML").last().inputValue(),
    };
    drill.check(kept.heading === "Only a heading" && kept.alt === "Only alt text" && kept.answer.includes("An answer with no question."), "D3: nothing is lost from the form", kept);
    await drill.shoot(page, "D3-three-refused");

    // ---- D4 ----
    await makePage(page, "drill-au05-d4", "AU-05 D4", [{ kind: "text", heading: "", body: ["Template paragraph one.", "Template paragraph two."] }]);
    await editor(drill, page, "drill-au05-d4");
    const tplBtn = page.getByRole("button", { name: "Save as template" });
    drill.check(await tplBtn.isEnabled(), "D4: with only a headingless text section, Save as template is enabled");
    await tplBtn.click();
    const tplName = `Drill headingless ${Date.now() % 100000}`;
    await page.locator("#pe-tpl-name").fill(tplName);
    const tput = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
    await page.locator("dialog[open]").getByRole("button", { name: "Save template" }).click();
    drill.check((await tput).status() === 200, "D4: Save as template works (PUT 200)");
    await page.waitForTimeout(800);
    // a new page from it
    await drill.open(page, "/admin/storefront/pages/new", { width: W });
    await page.locator("#pe-template").waitFor({ timeout: 30_000 });
    const optVal = await page.locator("#pe-template option").evaluateAll((os, name) => os.find((o) => o.textContent.includes(name))?.value, tplName);
    await page.locator("#pe-template").selectOption(optVal);
    await page.waitForTimeout(800);
    const apply = page.locator("dialog[open]").getByRole("button", { name: "Apply template" });
    if (await apply.count()) await apply.click();
    await page.waitForTimeout(1200);
    const fromTpl = await page.getByLabel("Section paragraphs").evaluateAll((els) => els.map((e) => e.value));
    drill.check(fromTpl.some((p) => p.includes("Template paragraph one.") && p.includes("Template paragraph two.")), "D4: a new page from that template holds the paragraphs", fromTpl);
    await drill.shoot(page, "D4-new-page-from-template");
    // a blank section's error shows inside the dialog
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.getByRole("button", { name: "Save as template" }).click();
    await page.locator("#pe-tpl-name").fill(`${tplName} blank`);
    await page.locator("dialog[open]").getByRole("button", { name: "Save template" }).click();
    await page.waitForTimeout(1500);
    const dlg = await page.evaluate(() => document.querySelector("dialog[open]")?.innerText || "");
    drill.check(/section 2/i.test(dlg), "D4: a blank section shows its error inside the dialog", dlg.slice(0, 300));
    await drill.shoot(page, "D4-template-dialog-error");
    await page.keyboard.press("Escape");

    // ---- D5 ----
    await makePage(page, "drill-au05-d5", "AU-05 D5", [{ kind: "text", heading: "One", body: ["First."] }]);
    await editor(drill, page, "drill-au05-d5");
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.getByLabel("Section heading").last().fill("Two");
    await page.getByLabel("Section paragraphs").last().fill("Second.");
    st = await save(page);
    await page.getByLabel("Section paragraphs").last().fill("Second, edited.");
    const st2 = await save(page);
    await page.reload();
    await page.locator("#pe-title").waitFor();
    const h5 = await page.getByLabel("Section heading").evaluateAll((els) => els.map((e) => e.value));
    const p5 = await page.getByLabel("Section paragraphs").evaluateAll((els) => els.map((e) => e.value));
    drill.check(st === 200 && st2 === 200 && JSON.stringify(h5) === JSON.stringify(["One", "Two"]) && p5[0] === "First." && p5[1] === "Second, edited.", "D5: add, save, edit, save, reload: no duplicated or swapped section", { st, st2, h5, p5 });
    const ids = await rows("tenant", "SELECT sections FROM cms_pages WHERE slug='drill-au05-d5'");
    drill.note(`D5: stored sections ${String(ids[0]?.sections).slice(0, 300)}`);
    await drill.shoot(page, "D5-identity");

    // ---- D6 ----
    await editor(drill, page, "drill-au05-d5");
    const long = `${"Long words for a size check. ".repeat(150)}End.`;
    await page.getByLabel("Section paragraphs").last().fill(long);
    st = await save(page);
    msg = await banner(page);
    const stays = await page.getByLabel("Section paragraphs").last().inputValue();
    drill.check(st === 422 && /\d[\d,]* characters/.test(msg || "") && /4,?000/.test(msg || ""), "D6: a paragraph over 4,000 characters is refused with its length and the limit", { len: long.length, msg });
    drill.check(stays === long, "D6: the text stays in the form");
    await drill.shoot(page, "D6-too-long");

    // ---- D7 ----
    await makePage(page, "drill-au05-d7", "AU-05 D7", [{ kind: "faq", heading: "Questions", items: [{ q: "Is shipping free?", a: "<p>Yes.</p>" }] }]);
    await editor(drill, page, "drill-au05-d7");
    const typed = "Free on orders <500 and >100 rupees.";
    await page.getByLabel("Answer HTML").last().fill(typed);
    st = await save(page);
    msg = await banner(page);
    const b7 = await badges(page);
    drill.check(st === 422 && (msg || "").includes("<500 and >"), 'D7: the banner quotes "<500 and >"', msg);
    drill.check(/section 1/i.test(msg || "") && b7[0]?.startsWith("1."), "D7: the number matches the section badge", { msg, b7 });
    drill.check((await page.getByLabel("Answer HTML").last().inputValue()) === typed, "D7: the text stays");
    await drill.shoot(page, "D7-quoted");
    await page.getByLabel("Answer HTML").last().fill("Free on orders under 500 rupees.");
    st = await save(page);
    drill.check(st === 200, "D7: reworded, Save succeeds", st);

    // ---- D8 ----
    await makePage(page, "drill-au05-d8", "AU-05 D8", [{ kind: "text", heading: "Contact", body: ["Reach us."] }]);
    await editor(drill, page, "drill-au05-d8");
    await page.getByRole("button", { name: "Rich HTML", exact: true }).click();
    await page.getByLabel("Section HTML").last().fill('<p><a href="tel:+919876543210">Call us</a></p>');
    st = await save(page);
    msg = await banner(page);
    drill.check(st === 422 && (msg || "").includes("tel:+919876543210"), "D8: a tel: link is refused and the banner quotes the address", msg);
    drill.check(await unsaved(page), "D8: the form stays Unsaved");
    await drill.shoot(page, "D8-tel-refused");
    await page.getByLabel("Section HTML").last().fill('<p><a href="https://wa.me/919876543210">Message us</a> or read <a href="https://example.com/guide" rel="nofollow" target="_blank">our guide</a>.</p>');
    st = await save(page);
    drill.check(st === 200, "D8: with https addresses (one rel=nofollow target=_blank) Save succeeds", st);

    // ---- D9 ----
    await makePage(page, "drill-au05-d9", "AU-05 D9", [{ kind: "text", heading: "Video", body: ["Watch below."] }]);
    await editor(drill, page, "drill-au05-d9");
    await page.getByRole("button", { name: "Rich HTML", exact: true }).click();
    const embed = '<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="YouTube video player" frameborder="0" allowfullscreen></iframe>';
    await page.getByLabel("Section HTML").last().fill(embed);
    st = await save(page);
    msg = await banner(page);
    drill.check(st === 422 && (msg || "").includes("youtube.com/embed/dQw4w9WgXcQ"), "D9: the banner quotes the address", msg);
    drill.check(/embed|video/i.test(msg || "") && !/empty/i.test(msg || ""), "D9: it says the page can't show embedded videos, and doesn't say the section is empty", msg);
    drill.check(await unsaved(page), "D9: the form stays Unsaved");
    await drill.shoot(page, "D9-embed-refused");
    await page.getByLabel("Section HTML").last().fill('<p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Watch the video</a></p>');
    st = await save(page);
    drill.check(st === 200, "D9: replaced with a plain link, Save succeeds", st);
    await ctx.close();
  },

  async publish(drill) {
    const ctx = await drill.context({ width: W });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const pub = page.getByRole("button", { name: "Publish now", exact: true }).first();
    if (await pub.isEnabled()) {
      await pub.click();
      await page.waitForTimeout(400);
      const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/releases" && r.request().method() === "POST", { timeout: 30_000 });
      await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
      const pr = await posted;
      drill.check(pr.status() === 200, "publish: Publish now answers 200", pr.status());
    } else drill.note("publish: nothing new to publish (an earlier run of this part already published the drill pages)");
    const anon = await drill.context({ width: 1440 });
    const ap = await anon.newPage();
    const live = async (slug, test) => {
      for (let i = 0; i < 45; i++) {
        const r = await drill.open(ap, `/policies/${slug}`);
        const html = await ap.content();
        const t = await text(ap);
        if (test(t, html)) return { r, t, html };
        await ap.waitForTimeout(1000);
      }
      return null;
    };
    const d1 = await live("drill-au05-d1", (t) => t.includes("Second paragraph."));
    const emptyH2 = d1 ? await ap.evaluate(() => [...document.querySelectorAll("h2")].filter((h) => !h.textContent.trim()).length) : null;
    drill.check(d1 && emptyH2 === 0, "D1 live: the published page shows both paragraphs with no empty h2", { status: d1?.r.status, emptyH2 });
    await noThanks(ap);
    await drill.shoot(ap, "D1-live");
    const d7 = await live("drill-au05-d7", (t) => t.includes("Is shipping free?"));
    if (d7) await ap.getByText("Is shipping free?").first().click().catch(() => {});
    const d7t = await text(ap);
    drill.check(d7t.includes("Free on orders under 500 rupees."), "D7 live: the answer reads as typed", d7t.split("\n").filter((l) => /Free on orders/.test(l)));
    await drill.shoot(ap, "D7-live");
    const d8 = await live("drill-au05-d8", (t) => t.includes("our guide"));
    const link = d8 ? /<a[^>]*href="https:\/\/example\.com\/guide"[^>]*>/.exec(d8.html)?.[0] : null;
    drill.check(link && /rel="[^"]*nofollow[^"]*"/.test(link) && /noopener/.test(link), "D8 live: the target=_blank link keeps nofollow (beside noopener noreferrer) in the page's HTML", link);
    await anon.close();
    await ctx.close();
  },

  async d10(drill) {
    const before = await rows("tenant", "SELECT description_html FROM products WHERE handle='glow-serum'");
    const orig = before[0]?.description_html ?? null;
    drill.note(`D10: the harness product's description before: ${JSON.stringify(String(orig).slice(0, 120))}`);
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      d.dismiss().catch(() => {});
    });
    try {
      await sql("tenant", "UPDATE products SET description_html=? WHERE handle='glow-serum'", ["<p>Brightens in two weeks.</p>< <img src=x onerror=alert(1) "]);
      let t = "";
      for (let i = 0; i < 40; i++) {
        await drill.open(page, "/products/glow-serum");
        t = await text(page);
        if (t.includes("Brightens in two weeks.")) break;
        await page.waitForTimeout(1000);
      }
      const facts = await page.evaluate(() => {
        const d = [...document.querySelectorAll(".rte")].find((x) => x.innerText.includes("Brightens"));
        return { text: d?.innerText, imgs: d ? d.querySelectorAll("img").length : null, xImgs: [...document.querySelectorAll('img[src="x"]')].length };
      });
      drill.check(facts.text?.includes("<") && facts.text?.includes("img src=x"), "D10: the product page shows the stray markup as text", facts.text);
      drill.check(dialogs === 0 && facts.imgs === 0 && facts.xImgs === 0, "D10: no dialog appears and the DOM has no img from it", { dialogs, facts });
      await noThanks(page);
      await page.getByText("Brightens in two weeks.").first().scrollIntoViewIfNeeded();
      await drill.shoot(page, "D10-stray-markup-as-text");
      await sql("tenant", "UPDATE products SET description_html=? WHERE handle='glow-serum'", ["<p>a <!-- private > note --> b</p>"]);
      let f2 = null;
      for (let i = 0; i < 40; i++) {
        await drill.open(page, "/products/glow-serum");
        f2 = await page.evaluate(() => [...document.querySelectorAll(".rte")].map((x) => x.innerText.trim()).find((x) => /^a\s/.test(x) || x === "a b" || x.includes("note")));
        if (f2 !== undefined) break;
        await page.waitForTimeout(1000);
      }
      drill.check(f2 != null && /^a\s+b$/.test(f2) && !/private|note/.test(f2), "D10: 'a <!-- private > note --> b' shows only a and b", f2);
      await drill.shoot(page, "D10-comment-hidden");
    } finally {
      await sql("tenant", "UPDATE products SET description_html=? WHERE handle='glow-serum'", [orig]);
    }
    await ctx.close();
  },

  async d11(drill) {
    const tid = "tpl_drill_old_empty";
    const sections = JSON.stringify([
      { kind: "text", heading: "Our promise", body: ["We ship within a day."] },
      { kind: "rich", heading: "Old details", html: "<p>&nbsp;</p>" },
    ]);
    const now = new Date().toISOString();
    await sql("tenant", [
      { sql: "DELETE FROM cms_templates WHERE id=?", args: [tid] },
      { sql: "INSERT INTO cms_templates (id, name, family, sections, version, revision, created_at, updated_at) VALUES (?,?,?,?,1,1,?,?)", args: [tid, "Drill old template", "page", sections, now, now] },
    ]);
    const ctx = await drill.context({ width: W });
    const page = await drill.signIn(ctx);
    page.on("dialog", (d) => d.accept().catch(() => {}));
    await drill.open(page, "/admin/storefront/pages/new", { width: W });
    await page.locator("#pe-template").waitFor({ timeout: 30_000 });
    await page.locator("#pe-title").fill("AU-05 D11");
    await page.locator("#pe-slug").fill("drill-au05-d11").catch(() => {});
    await page.locator("#pe-template").selectOption(`tpl:${tid}`);
    await page.waitForTimeout(800);
    const apply = page.locator("dialog[open]").getByRole("button", { name: "Apply template" });
    if (await apply.count()) await apply.click();
    await page.waitForTimeout(1200);
    const b = await badges(page);
    const heads = await page.getByLabel("Section heading").evaluateAll((els) => els.map((e) => e.value));
    drill.check(b.length === 2 && heads.includes("Old details") && heads.includes("Our promise"), "D11: the template opens with every section and the heading kept", { b, heads });
    await drill.shoot(page, "D11-opened");
    const st = await save(page);
    const msg = await banner(page);
    drill.check(st === 422 && /section 2/i.test(msg || ""), "D11: Save names the empty section (section 2)", { st, msg });
    await drill.shoot(page, "D11-save-names-section");
    await page.getByLabel("Section HTML").last().fill("<p>Every order ships with tracking.</p>");
    const st2 = await save(page);
    drill.check(st2 === 200, "D11: fixing it, Save succeeds", st2);
    await sql("tenant", "DELETE FROM cms_templates WHERE id=?", [tid]).catch(() => {});
    await ctx.close();
  },
};
