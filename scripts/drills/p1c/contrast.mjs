// P1-CONTRAST drills (docs/cms-reviews/P1-CONTRAST.md).
//   DESIGN_PORT=3271 node scripts/drills/p1c/run.mjs contrast [part]
// Evidence lands in docs/cms-reviews/drills/CONTRAST/, so batch C's own
// TOK-01-02 evidence is not overwritten.
// Parts
//   c-pulse-brand   batch C's TOK drill, re-run as it is (tokc.mjs)
//   c-rest-themes   batch C's TOK drill, re-run as it is (tokc.mjs)
//   x-fixed-pairs   the three things this item changed, measured in Chrome on
//                   every look a shopper can get (no brand on Pulse and Glow,
//                   the Pulse kit's own brand, an accent-only blue brand, both
//                   test themes), at 375 and 1440:
//                   - the wishlist's missing-photo "?"
//                   - the content page's "Home" and "Contact us" links
//                   - the applied coupon's words in the cart drawer (a CONTRAST10
//                     coupon inserted into the local DB for the drill)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settle } from "../../drill.js";
import { audit } from "../p1/contrast.mjs";
import { sql } from "../p1/db.mjs";
import { liveRelease, publishCopy, pointLiveAt, TEST_THEMES, smallCopy } from "../p1/tok.mjs";
import { parts as tokc } from "./tokc.mjs";

export const id = "CONTRAST";
export const title = "P1-CONTRAST: the wishlist mark, content page links and the pairs TOK missed";

const HEIGHTS = { 375: 812, 1440: 900 };
const CONSENT = encodeURIComponent(JSON.stringify({ v: 2, a: 0, m: 0, at: "2026-11-01T00:00:00.000Z" }));

const LOOKS = {
  "no-brand-pulse": { brand: null, theme: { kit: "pulse", version: 1 } },
  "no-brand-glow": { brand: null, theme: { kit: "glow", version: 1 } },
  "pulse-brand": { brand: { accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "md", type_scale: "regular" }, theme: { kit: "pulse", version: 1 } },
  "blue-accent": { brand: { accent: "#2563eb" }, theme: { kit: "pulse", version: 1 } },
  light: TEST_THEMES.light,
  dark: TEST_THEMES.dark,
};

async function shopper(drill, width) {
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width, height: HEIGHTS[width] }, deviceScaleFactor: 1 });
  const host = new URL(drill.baseUrl).hostname;
  await ctx.addCookies([{ name: "_consent", value: CONSENT, domain: host, path: "/" }]);
  return ctx;
}
async function go(page, path) {
  const r = await page.goto(path, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  return r?.status() ?? 0;
}
async function snap(drill, page, name) {
  await page.mouse.move(1, 1).catch(() => {});
  const raw = await page.screenshot({ fullPage: false, animations: "disabled", caret: "hide" });
  mkdirSync(join(drill.dir, "x-fixed-pairs"), { recursive: true });
  const small = await smallCopy(raw, { maxBytes: 35 * 1024 });
  writeFileSync(join(drill.dir, "x-fixed-pairs", `${name}.png`), small);
  drill.shots.push({ name: `x-fixed-pairs/${name}`, bytes: small.length });
}
const pick = (r) => ({ text: r.text, fg: r.fg, bg: r.bg, ratio: r.ratio, need: r.need });
// Measure each element `find` returns (the audit takes one root at a time).
async function measure(page, find) {
  const n = await page.evaluate((src) => {
    document.querySelectorAll("[data-drill-target]").forEach((e) => e.removeAttribute("data-drill-target"));
    const els = new Function(`return (${src})`)()();
    els.forEach((e, i) => e.setAttribute("data-drill-target", String(i)));
    return els.length;
  }, find.toString());
  const out = [];
  for (let i = 0; i < n; i++) out.push(...(await audit(page, `[data-drill-target="${i}"]`)).filter((r) => r.text));
  return out;
}

export const parts = {
  "c-pulse-brand": tokc["c-pulse-brand"],
  "c-rest-themes": tokc["c-rest-themes"],

  async "x-fixed-pairs"(drill) {
    const orig = await liveRelease();
    const report = {};
    // a coupon that works today (the seed's FESTIVE10 starts in 5 days)
    const now = new Date().toISOString();
    await sql("tenant", "INSERT OR REPLACE INTO offers (id, type, label, enabled, starts_at, ends_at, config, created_at, updated_at) VALUES ('contrast-drill', 'COUPON', 'CONTRAST10 drill', 1, NULL, NULL, ?, ?, ?)", [JSON.stringify({ id: "contrast-drill", type: "COUPON", scope: "order", title: "CONTRAST10 — 10% off", code: "CONTRAST10", discount: { kind: "percent", value: 10 } }), now, now]);
    drill.note("setup: coupon CONTRAST10 inserted into the local DB (removed afterwards)");
    try {
      for (const [look, set] of Object.entries(LOOKS)) {
        await publishCopy(orig.content, set);
        report[look] = {};
        for (const width of [375, 1440]) {
          const ctx = await shopper(drill, width);
          const page = await ctx.newPage();
          const row = (report[look][width] = {});

          // the wishlist "?" (a product saved in this browser; the seed's products have no photo)
          await go(page, "/products/glow-serum");
          const save = page.getByRole("button", { name: "Save for later" }).filter({ visible: true }).first();
          if (await save.count()) await save.click();
          await page.waitForTimeout(500);
          await go(page, "/wishlist");
          row.wishlist = await measure(page, () => [...document.querySelectorAll("main li span")].filter((s) => s.textContent.trim() === "?"));
          drill.check(row.wishlist.length === 1, `${look} at ${width}: the wishlist shows one missing-photo "?"`, row.wishlist.map(pick));
          drill.check(row.wishlist.every((r) => r.ratio >= 4.5), `${look} at ${width}: the "?" is 4.5:1 or better`, row.wishlist.map(pick));
          await snap(drill, page, `${look}-wishlist-${width}`);

          // the content page's links
          await go(page, "/policies/shipping");
          row.links = await measure(page, () => [...document.querySelectorAll("main a")].filter((a) => ["Home", "Contact us"].includes(a.textContent.trim())));
          drill.check(row.links.length === 2, `${look} at ${width}: the policy page has its Home and Contact us links`, row.links.map(pick));
          drill.check(row.links.every((r) => r.ratio >= 4.5), `${look} at ${width}: Home and Contact us are 4.5:1 or better`, row.links.map(pick));
          await snap(drill, page, `${look}-policy-${width}`);

          // the applied coupon in the cart drawer
          await go(page, "/products/glow-serum");
          const posted = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
          await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
          await posted;
          await page.waitForTimeout(1200);
          // offers are read through a short cache: try for up to a minute
          const removeBtn = page.getByRole("button", { name: "Remove", exact: true });
          for (let i = 0; i < 12 && !(await removeBtn.count()); i++) {
            const clear = page.getByRole("button", { name: "clear", exact: true });
            if (await clear.count()) await clear.click();
            const input = page.getByLabel("Coupon code");
            await input.waitFor({ timeout: 15_000 });
            await input.fill("CONTRAST10");
            await page.getByRole("button", { name: "Apply", exact: true }).click();
            await page.waitForTimeout(5000);
          }
          await removeBtn.waitFor({ timeout: 10_000 });
          await page.waitForTimeout(400);
          row.coupon = await measure(page, () => [...document.querySelectorAll("[role=dialog] span, [role=dialog] button, aside span, aside button")].filter((e) => ["Coupon", "Remove", "CONTRAST10"].includes(e.textContent.trim()) || /^· −/.test(e.textContent.trim())));
          drill.check(row.coupon.length >= 3, `${look} at ${width}: the applied coupon shows its words`, row.coupon.map(pick));
          drill.check(row.coupon.every((r) => r.ratio >= 4.5), `${look} at ${width}: the applied coupon's words are 4.5:1 or better`, row.coupon.map(pick));
          await snap(drill, page, `${look}-coupon-${width}`);
          await ctx.close();
        }
      }
    } finally {
      await pointLiveAt(orig.id);
      await sql("tenant", "DELETE FROM offers WHERE id = 'contrast-drill'");
      drill.note(`live release back to ${orig.id}; coupon CONTRAST10 removed`);
    }
    mkdirSync(join(drill.dir, "x-fixed-pairs"), { recursive: true });
    writeFileSync(join(drill.dir, "x-fixed-pairs", "contrast.json"), JSON.stringify(report, null, 2) + "\n");
  },
};
