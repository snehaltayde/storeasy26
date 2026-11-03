// P1-DRILLS-C · TOK-01/02 drills still needed (docs/cms-reviews/P1-TOK-01-02.md).
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs tokc [part]
// Parts
//   c-glow-twoword     logo in two words, no brand, Glow kit, live: the header
//                      wordmark's second word is 3:1 or better on #fffbf7, at 375 and 1440
//   c-reset-screens    Brand → Reset, then Publishing at once: within 30 s no
//                      "Fix before publishing" for colours, Publish now works, no 422
//   c-pulse-brand      the Pulse kit with its own brand, live: links 4.5:1, the
//                      footer and checkout wordmarks 3:1; every other pixel equal
//                      to the same pages with no brand on Pulse
//   c-rest-themes      the two test themes: account sign-in and orders, an order
//                      page, the confirmation, wishlist, a quiz, a bundle, a CMS
//                      page, checkout review and payment, at 375 and 1440
//   c-hover-focus      the two test themes: a hovered dark button, accent button,
//                      link and filter chip, and a field reached by Tab
//   c-dark-glow        a dark brand on the Glow kit: home and product, every pair
//   c-never-published  a store with no live release saves an unreadable brand:
//                      shoppers see the default look, the founder's preview the
//                      saved colours, Brand shows the warning
//   c-checkout-steps   checkout's address, review and payment steps at 320 to 414:
//                      no sideways scroll
// The live look is switched by publishing a copy of the live release with
// another brand/theme straight into this checkout's local harness database
// (scripts/drills/p1/tok.mjs helpers); each part puts the live release back.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settle } from "../../drill.js";
import { rows, sql } from "../p1/db.mjs";
import { audit } from "../p1/contrast.mjs";
import { liveRelease, publishCopy, pointLiveAt, TEST_THEMES, smallCopy } from "../p1/tok.mjs";
import { seen, sleep, text } from "../p1/util.mjs";
import { SHOPPER } from "../p1/sf.mjs";

export const id = "TOK-01-02";
export const title = "P1-DRILLS-C: TOK-01/02 drills still needed";

const HEIGHTS = { 320: 640, 360: 740, 375: 812, 390: 844, 414: 896, 1440: 900 };
const UNIT = "tok-drill-fixed-unit";
const CONSENT = encodeURIComponent(JSON.stringify({ v: 2, a: 0, m: 0, at: "2026-11-01T00:00:00.000Z" }));
const PULSE_BRAND_ACCENT = "#84cc16";

async function shopper(drill, width) {
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width, height: HEIGHTS[width] || 900 }, deviceScaleFactor: 1 });
  const host = new URL(drill.baseUrl).hostname;
  await ctx.addCookies([
    { name: "_unit", value: UNIT, domain: host, path: "/" },
    { name: "_consent", value: CONSENT, domain: host, path: "/" },
  ]);
  return ctx;
}
async function go(page, path) {
  const r = await page.goto(path, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  return r?.status() ?? 0;
}
async function addToCart(page, handle = "glow-serum") {
  await go(page, `/products/${handle}`);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const res = await posted;
  await page.waitForTimeout(1500);
  return res.status();
}
async function snap(drill, page, folder, name, maxBytes = 45 * 1024) {
  await page.mouse.move(1, 1).catch(() => {});
  const raw = await page.screenshot({ fullPage: false, animations: "disabled", caret: "hide" });
  const dir = join(drill.dir, folder);
  mkdirSync(dir, { recursive: true });
  const small = await smallCopy(raw, { maxBytes });
  writeFileSync(join(dir, `${name}.png`), small);
  drill.shots.push({ name: `${folder}/${name}`, bytes: small.length });
  return raw;
}
const pick = (r) => ({ text: r.text, fg: r.fg, bg: r.bg, ratio: r.ratio, need: r.need });
const signedInApi = (page) => (path, method, body) =>
  page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }, [path, method, body]);
const tenantCfg = async () => JSON.parse((await rows("platform", "SELECT config FROM tenants WHERE id='design'"))[0].config);
const liveContent = async () => JSON.parse((await rows("tenant", "SELECT content FROM releases WHERE id = (SELECT live_release_id FROM release_state WHERE id = 1)"))[0].content);

// Measure one element (marked with data-drill-target) with the contrast audit.
async function measureTarget(page) {
  return (await audit(page, "[data-drill-target]")).filter((r) => !r.icon || r.text);
}

export const parts = {
  async "c-glow-twoword"(drill) {
    const orig = await liveRelease();
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/settings", { width: 1280 });
    const was = { t1: await page.locator("#sa-logo-text1").inputValue(), t2: await page.locator("#sa-logo-text2").inputValue() };
    await page.locator("#sa-logo-text1").fill("Design");
    await page.locator("#sa-logo-text2").fill("Demo");
    const put = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    drill.check((await put).status() === 200, "Settings: the logo saved as two words (Design / Demo)");
    try {
      await publishCopy(orig.content, { brand: null, theme: { kit: "glow", version: 1 } });
      drill.note("live: a copy of the live release with no brand and the Glow kit");
      // the logo is live-on-save and shoppers read settings through a 30 s cache
      for (const w of [375, 1440]) {
        const sctx = await shopper(drill, w);
        const sp = await sctx.newPage();
        let m = null;
        for (let i = 0; i < 12; i++) {
          await go(sp, "/");
          m = await sp.evaluate(() => {
            const span = document.querySelector("header .text-sf-header-accent");
            if (!span) return null;
            span.setAttribute("data-drill-target", "1");
            let bgEl = span;
            while (bgEl && getComputedStyle(bgEl).backgroundColor.match(/rgba\(0, 0, 0, 0\)|transparent/)) bgEl = bgEl.parentElement;
            return { text: span.innerText, color: getComputedStyle(span).color, kit: document.documentElement.dataset.kit, headerBg: bgEl ? getComputedStyle(bgEl).backgroundColor : null };
          });
          if (m?.text === "Demo") break;
          await sleep(3000);
        }
        const a = m ? await measureTarget(sp) : [];
        drill.note(`at ${w}: ${JSON.stringify(m)}; measured ${JSON.stringify(a.map(pick))}`);
        drill.check(m?.text === "Demo" && /^glow/.test(m.kit || ""), `at ${w}: the header shows the two-word logo on the Glow kit`, m);
        drill.check(a.length > 0 && a.every((r) => r.ratio >= 3), `at ${w}: the wordmark's second word measures 3:1 or better`, a.map(pick));
        drill.check(a.some((r) => r.fg === "#4d7c0f" && r.bg === "#fffbf7"), `at ${w}: it is #4d7c0f on #fffbf7 (4.85:1 expected)`, a.map(pick));
        await snap(drill, sp, "c-glow-twoword", `header-${w}`, 60 * 1024);
        await sctx.close();
      }
    } finally {
      await pointLiveAt(orig.id);
      await drill.open(page, "/admin/settings", { width: 1280 });
      await page.locator("#sa-logo-text1").fill(was.t1);
      await page.locator("#sa-logo-text2").fill(was.t2);
      const back = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
      await page.getByRole("button", { name: "Save settings" }).click();
      drill.note(`logo put back to ${JSON.stringify(was)}: ${(await back).status()}; live release back to ${orig.id}`);
      await ctx.close();
    }
  },

  async "c-reset-screens"(drill) {
    const orig = await liveRelease();
    const cfg = await tenantCfg();
    const savedBrand = cfg.brand || null;
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    const api = signedInApi(page);
    const seen422 = [];
    page.on("response", (r) => {
      if (r.status() === 422) seen422.push({ path: new URL(r.url()).pathname, method: r.request().method() });
    });
    try {
      // the store's own colours are live first
      drill.check(savedBrand && savedBrand.accent, "setup: the store has its own colours saved", savedBrand);
      const p0 = await api("/api/admin/releases", "POST", { action: "publish", note: "P1-DRILLS-C reset setup" });
      drill.note(`setup publish (own colours live): ${p0.status} ${JSON.stringify(p0.json.errors || p0.json.error || "")}`);
      const lc = await liveContent();
      drill.check(lc.brand && lc.brand.accent === savedBrand.accent, "setup: the store's own colours are live", lc.brand);

      await drill.open(page, "/admin/brand", { width: 1280 });
      await page.getByRole("button", { name: "Reset to platform default" }).click();
      const dlg = page.locator("dialog[open]");
      await dlg.waitFor({ timeout: 10_000 });
      const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/brand" && r.request().method() === "PUT", { timeout: 30_000 });
      await dlg.getByRole("button", { name: "Reset", exact: true }).click();
      const pr = await put;
      const t0 = Date.now();
      drill.check(pr.status() === 200, "Brand: Reset answers 200", pr.status());
      // straight to Publishing
      await drill.open(page, "/admin/releases", { width: 1280 });
      await seen(page, "What will publish", 30_000);
      const observations = [];
      let fixColours = false;
      let enabled = false;
      do {
        const t = await text(page);
        const fixAt = t.indexOf("Fix before publishing");
        const fixText = fixAt >= 0 ? t.slice(fixAt, fixAt + 400) : "";
        const colourFix = /contrast|colou?r|text on|wordmark|Hard to read/i.test(fixText);
        enabled = await page.getByRole("button", { name: "Publish now", exact: true }).first().isEnabled();
        observations.push({ at: Date.now() - t0, fix: fixText.slice(0, 160), colourFix, enabled });
        if (colourFix) fixColours = true;
        if (enabled) break;
        await sleep(3000);
        await page.reload();
        await settle(page);
      } while (Date.now() - t0 < 30_000);
      drill.note(`Publishing after Reset: ${JSON.stringify(observations)}`);
      drill.check(!fixColours, 'Publishing never shows a "Fix before publishing" about colours after Reset', observations);
      drill.check(enabled, "Publish now is enabled within 30 s of Reset", observations.at(-1));
      await drill.shoot(page, "c-reset-publishing");
      const btn = page.getByRole("button", { name: "Publish now", exact: true }).first();
      let pubStatus = null;
      if (enabled) {
        await btn.click();
        await page.waitForTimeout(400);
        const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/releases" && r.request().method() === "POST", { timeout: 30_000 });
        await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
        pubStatus = (await posted).status();
      }
      drill.check(pubStatus === 200, "Publish now answers 200", pubStatus);
      const after = await liveContent();
      drill.check(after.brand == null, "the live release has no brand (the platform default look)", after.brand);
      drill.check(seen422.length === 0, "no 422 at any point", seen422);
      await page.waitForTimeout(800);
      await drill.shoot(page, "c-reset-published");
    } finally {
      await api("/api/admin/brand", "PUT", savedBrand ? { brand: savedBrand } : { reset: true }).catch(() => {});
      await pointLiveAt(orig.id);
      drill.note(`brand put back to ${JSON.stringify(savedBrand)}, live release back to ${orig.id}`);
      await ctx.close();
    }
  },

  async "c-pulse-brand"(drill) {
    const orig = await liveRelease();
    const cfg = await tenantCfg();
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    const api = signedInApi(page);
    const sharp = (await import("sharp")).default;
    const PAGES = [
      ["home", "/"],
      ["product", "/products/glow-serum"],
      ["collection", "/collections/serums"],
      ["search", "/search?q=serum"],
      ["cms-page", "/policies/shipping"],
      ["checkout", "/checkout"],
    ];
    const capture = async () => {
      const out = {};
      for (const w of [375, 1440]) {
        const sctx = await shopper(drill, w);
        const sp = await sctx.newPage();
        await addToCart(sp);
        for (const [key, path] of PAGES) {
          await go(sp, path);
          await sp.mouse.move(1, 1);
          await sp.waitForTimeout(400);
          out[`${key}-${w}`] = await sp.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
        }
        await sctx.close();
      }
      return out;
    };
    try {
      // the Pulse kit's own brand, applied the founder's way, then published
      const applied = await api("/api/admin/theme", "POST", { action: "apply", kit: "pulse", withBrand: true, withPresets: false });
      drill.check(applied.status === 200, "Theme: the Pulse kit applied with its brand", applied.status);
      let pub = null;
      for (let i = 0; i < 10; i++) {
        pub = await api("/api/admin/releases", "POST", { action: "publish", note: "P1-DRILLS-C pulse brand" });
        const lc = await liveContent();
        if (pub.status === 200 && lc.brand?.accent === PULSE_BRAND_ACCENT && lc.theme?.kit === "pulse") break;
        if (pub.status === 422) break;
        await sleep(3000);
      }
      const lc = await liveContent();
      drill.check(pub?.status === 200 && lc.brand?.accent === PULSE_BRAND_ACCENT, "the Pulse kit's own brand publishes", { status: pub?.status, errors: pub?.json?.errors, brand: lc.brand });
      const pulseRelease = (await rows("tenant", "SELECT live_release_id id FROM release_state WHERE id = 1"))[0].id;
      drill.note(`the Pulse brand: ${JSON.stringify(lc.brand)}`);

      // links, the footer wordmark and the checkout wordmark
      const sctx = await shopper(drill, 1440);
      const sp = await sctx.newPage();
      await addToCart(sp);
      await go(sp, "/policies/shipping");
      const links = (await audit(sp, "main")).filter((r) => r.tag === "a" && !r.disabled);
      const footer = (await audit(sp, "footer")).filter((r) => /accent/.test(r.cls) || r.tag === "a");
      await go(sp, "/checkout");
      const checkoutMark = (await audit(sp, "main")).filter((r) => /sf-accent-mark/.test(r.cls));
      await go(sp, "/");
      const homeLinks = (await audit(sp, "main")).filter((r) => r.tag === "a" && /accent-text|underline/.test(r.cls));
      drill.note(`links on the CMS page: ${JSON.stringify(links.map(pick))}; home links: ${JSON.stringify(homeLinks.map(pick))}; footer: ${JSON.stringify(footer.map(pick))}; checkout wordmark: ${JSON.stringify(checkoutMark.map(pick))}`);
      const allLinks = links.concat(homeLinks);
      drill.check(allLinks.length > 0 && allLinks.every((r) => r.ratio >= (r.large ? 3 : 4.5)), "links measure 4.5:1 or better", allLinks.filter((r) => r.ratio < 4.5).map(pick));
      const footerMarks = footer.filter((r) => /accent/.test(r.cls));
      drill.check(footerMarks.every((r) => r.ratio >= 3), "the footer wordmark measures 3:1 or better", footerMarks.length ? footerMarks.map(pick) : "the harness logo has no second word, so no accent part is drawn");
      drill.check(checkoutMark.every((r) => r.ratio >= 3), "the checkout wordmark measures 3:1 or better", checkoutMark.length ? checkoutMark.map(pick) : "no accent part drawn (one-word logo)");
      if (!footerMarks.length || !checkoutMark.length) drill.note("the harness logo is one word, so the footer and checkout wordmarks have no accent part to measure; their colours are the page's own text");
      await snap(drill, sp, "c-pulse-brand", "home-1440", 60 * 1024);
      await sctx.close();

      // every other pixel equal to the same pages with no brand on Pulse
      const branded = await capture();
      await publishCopy(orig.content, { brand: null, theme: { kit: "pulse", version: 1 } });
      const plain = await capture();
      await pointLiveAt(pulseRelease);
      const diffs = {};
      for (const k of Object.keys(branded)) {
        const a = await sharp(branded[k]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const b = await sharp(plain[k]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
          diffs[k] = { sizeDiffers: [a.info.width, a.info.height, b.info.width, b.info.height] };
          continue;
        }
        let n = 0;
        let box = null;
        const W = a.info.width;
        const pairs = new Map();
        const hx = (d, i) => "#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
        for (let i = 0; i < a.data.length; i += 4) {
          if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
            n++;
            const pk = `${hx(b.data, i)}→${hx(a.data, i)}`;
            pairs.set(pk, (pairs.get(pk) || 0) + 1);
            const p = i / 4;
            const x = p % W;
            const y = Math.floor(p / W);
            box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
          }
        }
        diffs[k] = { pixels: n, box, topColourChanges: [...pairs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([c, m]) => `${c} ×${m}`) };
        if (n) {
          const [x0, y0, x1, y1] = box;
          const crop = await sharp(branded[k]).extract({ left: x0, top: y0, width: Math.min(x1 - x0 + 1, W - x0), height: Math.min(y1 - y0 + 1, 400) }).png().toBuffer();
          mkdirSync(join(drill.dir, "c-pulse-brand"), { recursive: true });
          writeFileSync(join(drill.dir, "c-pulse-brand", `diff-${k}.png`), await smallCopy(crop, { maxBytes: 30 * 1024 }));
        }
      }
      writeFileSync(join(drill.dir, "c-pulse-brand", "pixel-diff.json"), JSON.stringify(diffs, null, 2) + "\n");
      drill.note(`pixel differences, Pulse brand against no brand on Pulse: ${JSON.stringify(diffs)}`);
      const changed = Object.entries(diffs).filter(([, d]) => d.pixels || d.sizeDiffers);
      drill.check(changed.length === 0, "every screenshot equals the no-brand baseline on Pulse", changed.map(([k, d]) => `${k}: ${d.pixels ?? "size"} px in ${JSON.stringify(d.box || d.sizeDiffers)}`));
    } finally {
      await api("/api/admin/brand", "PUT", cfg.brand ? { brand: cfg.brand } : { reset: true }).catch(() => {});
      await sql("platform", "UPDATE tenants SET config = json_set(config, '$.theme', json(?)) WHERE id = 'design'", [JSON.stringify(cfg.theme ?? null)]);
      await pointLiveAt(orig.id);
      drill.note(`brand and theme put back, live release back to ${orig.id}`);
      await ctx.close();
    }
  },

  async "c-rest-themes"(drill) {
    const orig = await liveRelease();
    const EMAIL = `p1c-themes-${Date.now().toString(36)}@design.test`;
    // a quiz and a bundle in the local DB (the seed has neither)
    const now = new Date().toISOString();
    await sql("tenant", [
      { sql: "INSERT OR REPLACE INTO quizzes (slug, title, intro, questions, enabled, updated_at) VALUES ('p1c-skin', 'Find your routine', 'Two questions.', ?, 1, ?)", args: [JSON.stringify([{ id: "q1", prompt: "What bothers you most?", options: [{ id: "q1o1", label: "Dull skin", tags: ["glow"] }, { id: "q1o2", label: "Dry nights", tags: ["repair"] }] }, { id: "q2", prompt: "When do you shop?", options: [{ id: "q2o1", label: "Morning", tags: ["spf"] }, { id: "q2o2", label: "Night", tags: ["night"] }] }]), now] },
      { sql: "INSERT OR REPLACE INTO bundles (id, slug, title, description, items, bundle_price, enabled, created_at, updated_at) VALUES ('bnd_p1c', 'p1c-duo', 'Glow duo', 'Serum and sunscreen together.', ?, 1999, 1, ?, ?)", args: [JSON.stringify([{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/3", quantity: 1 }]), now, now] },
    ]);
    drill.note("setup: quiz p1c-skin and bundle p1c-duo inserted into the local DB");
    // one COD order for a test shopper, and a signed-in shopper session
    const setup = await shopper(drill, 1440);
    const sp = await setup.newPage();
    await addToCart(sp);
    await go(sp, "/checkout");
    for (const [k, v] of Object.entries({ ...SHOPPER, email: EMAIL })) if (v) await sp.locator(`input[name="${k}"]`).fill(v);
    await sp.getByRole("button", { name: "Continue to review" }).click();
    await sp.getByRole("heading", { name: "Review your order" }).waitFor({ timeout: 15_000 });
    await sp.getByRole("button", { name: "Continue to payment" }).click();
    await sp.getByRole("heading", { name: "Payment" }).waitFor({ timeout: 15_000 });
    await sp.locator('input[name="method"]').first().check();
    await sp.getByRole("button", { name: /^Place order/ }).click();
    await sp.waitForURL(/\/checkout\/confirmation\//, { timeout: 60_000 });
    const orderId = decodeURIComponent(new URL(sp.url()).pathname.split("/").pop());
    const confirmationPath = new URL(sp.url()).pathname + new URL(sp.url()).search; // carries the order's ?t= token
    await go(sp, "/account");
    await sp.locator('input[type="email"]').first().fill(EMAIL);
    await sp.getByRole("button", { name: /code/i }).first().click();
    const codeInput = sp.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name="code"]').first();
    await codeInput.waitFor({ timeout: 20_000 });
    const n = await rows("tenant", "SELECT subject FROM notifications WHERE recipient=? AND type='customer_otp' ORDER BY created_at DESC LIMIT 1", [EMAIL]);
    const code = /(\d{6})/.exec(n[0]?.subject || "")?.[1];
    drill.check(Boolean(code), "setup: the shopper's sign-in code was recorded locally (never printed)");
    await codeInput.fill(code || "");
    await sp.getByRole("button", { name: /Sign in|Verify|Continue/i }).first().click();
    await sp.waitForTimeout(2500);
    const shopperCookies = await setup.cookies();
    drill.note(`setup: order ${orderId} for the test shopper; signed in`);
    await setup.close();

    const report = {};
    try {
      for (const [name, th] of Object.entries(TEST_THEMES)) {
        await publishCopy(orig.content, th);
        report[name] = {};
        for (const width of [375, 1440]) {
          // signed out: the account sign-in page
          const out = await shopper(drill, width);
          const op = await out.newPage();
          // signed in: everything else (cart, wishlist, orders)
          const ctx = await shopper(drill, width);
          await ctx.addCookies(shopperCookies.filter((c) => !["_unit", "_consent"].includes(c.name)));
          const page = await ctx.newPage();
          const visit = async (p, key, path, { root = null, prep = null } = {}) => {
            let status = null;
            if (path) status = await go(p, path);
            if (prep) await prep(p);
            await p.mouse.move(1, 1);
            await p.waitForTimeout(300);
            // A disabled option's own words (its <label> around a disabled
            // radio, e.g. "Pay online" with no Razorpay keys) are part of an
            // inactive control: mark the label so the audit exempts it, and
            // record what it measured.
            const inactive = await p.evaluate(() =>
              [...document.querySelectorAll("label")]
                .filter((l) => l.querySelector("input:disabled"))
                .map((l) => (l.setAttribute("aria-disabled", "true"), l.innerText.replace(/\s+/g, " ").trim().slice(0, 80))),
            );
            if (inactive.length) drill.note(`${name}, ${key} at ${width}: exempt as a disabled control: ${JSON.stringify(inactive)}`);
            const all = await audit(p, root);
            const checked = all.filter((r) => !r.overMedia && !r.disabled);
            const failing = checked.filter((r) => !r.pass);
            const errorPage = /Something went wrong|This page hit an error|404/.test((await text(p)).slice(0, 400));
            report[name][`${key}-${width}`] = { status, checked: checked.length, exempt: all.filter((r) => r.overMedia || r.disabled).map(pick), failing: failing.map(pick) };
            drill.check(!errorPage && checked.length > 0, `${name}, ${key} at ${width}: the page renders (${status ?? "same page"})`, (await text(p)).slice(0, 160));
            drill.check(!failing.length, `${name}, ${key} at ${width}: every one of ${checked.length} text and icon pairs passes`, failing.slice(0, 6).map(pick));
            await snap(drill, p, "c-rest-themes", `${name}-${key}-${width}`, 35 * 1024);
          };
          await visit(op, "account-sign-in", "/account");
          await visit(page, "account-orders", "/account");
          await visit(page, "order-page", `/account/orders/${encodeURIComponent(orderId)}`);
          await visit(page, "confirmation", confirmationPath);
          await visit(page, "wishlist", null, {
            prep: async (p) => {
              await go(p, "/products/glow-serum");
              const save = p.getByRole("button", { name: "Save for later" }).filter({ visible: true }).first();
              if (await save.count()) await save.click();
              await p.waitForTimeout(500);
              await go(p, "/wishlist");
              drill.check((await text(p)).includes("Radiance Glow Serum"), `${name}, wishlist at ${width}: the saved product is listed`);
            },
          });
          await visit(page, "quiz", "/quiz/p1c-skin");
          await visit(page, "bundle", "/bundles/p1c-duo");
          await visit(page, "cms-page", "/policies/shipping");
          await addToCart(page);
          await go(page, "/checkout");
          for (const [k, v] of Object.entries({ ...SHOPPER, email: EMAIL })) if (v) await page.locator(`input[name="${k}"]`).fill(v).catch(() => {});
          await page.getByRole("button", { name: "Continue to review" }).click();
          await page.getByRole("heading", { name: "Review your order" }).waitFor({ timeout: 15_000 });
          await visit(page, "checkout-review", null);
          await page.getByRole("button", { name: "Continue to payment" }).click();
          await page.getByRole("heading", { name: "Payment" }).waitFor({ timeout: 15_000 });
          await page.locator('input[name="method"]').first().check();
          await visit(page, "checkout-payment", null);
          await ctx.close();
          await out.close();
        }
      }
    } finally {
      await pointLiveAt(orig.id);
      await sql("tenant", ["DELETE FROM quizzes WHERE slug='p1c-skin'", "DELETE FROM bundles WHERE id='bnd_p1c'"]);
    }
    mkdirSync(join(drill.dir, "c-rest-themes"), { recursive: true });
    writeFileSync(join(drill.dir, "c-rest-themes", "contrast.json"), JSON.stringify(report, null, 2) + "\n");
  },

  async "c-hover-focus"(drill) {
    const orig = await liveRelease();
    const report = {};
    try {
      for (const [name, th] of Object.entries(TEST_THEMES)) {
        await publishCopy(orig.content, th);
        const ctx = await shopper(drill, 1440);
        const page = await ctx.newPage();
        const hoverCheck = async (key, path, find, prep = null, afterGo = null) => {
          if (prep) await prep();
          await go(page, path);
          if (afterGo) await afterGo();
          const ok = await page.evaluate(find);
          if (!ok) {
            drill.check(false, `${name}, ${key}: found the element`, path);
            return;
          }
          const el = page.locator("[data-drill-target]").first();
          await el.scrollIntoViewIfNeeded();
          await el.hover();
          await page.waitForTimeout(500);
          const m = await measureTarget(page);
          report[`${name}-${key}`] = m.map(pick);
          drill.check(m.length > 0 && m.every((r) => r.ratio >= r.need), `${name}, hovered ${key}: text still ${m[0]?.need ?? 4.5}:1 or better`, m.map(pick));
          await snap(drill, page, "c-hover-focus", `${name}-${key}`, 35 * 1024);
        };
        const mark = (sel, pred) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (${pred})(e); }); if (!el) return false; el.setAttribute("data-drill-target", "1"); return true; })()`;
        // the dark (inverse) button: checkout's "Continue to review", with one item in the cart
        await hoverCheck("dark-button-continue-to-review", "/checkout", (mark("main button", "(e) => /Continue to review/.test(e.innerText) && /bg-sf-inverse/.test(e.className) && !e.disabled")), () => addToCart(page), async () => {
          // the button is disabled until the address is complete
          for (const [k, v] of Object.entries(SHOPPER)) if (v) await page.locator(`input[name="${k}"]`).fill(v);
          await page.waitForTimeout(300);
        });
        // on both test themes Add to cart is accent-filled, not dark
        await hoverCheck("accent-button-add-to-cart", "/products/glow-serum", (mark("main button", "(e) => /Add to cart/.test(e.innerText)")));
        await hoverCheck("accent-button-hero", "/", (mark('[data-sec="hero"] a', "(e) => /bg-sf-accent/.test(e.className)")));
        await hoverCheck("link-footer", "/", (mark("footer a", "(e) => e.innerText.trim().length > 2")));
        await hoverCheck("filter-chip", "/collections/serums", (mark("main a, main button", "(e) => /rounded-full/.test(e.className) && e.innerText.trim().length > 0 && e.innerText.trim().length < 30")));
        // a field reached by Tab
        await go(page, "/checkout");
        await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
        let focused = null;
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          focused = await page.evaluate(() => {
            const a = document.activeElement;
            if (a && a.tagName === "INPUT" && a.type !== "hidden" && a.type !== "radio" && a.type !== "checkbox") {
              a.setAttribute("data-drill-target", "1");
              return { name: a.name, placeholder: a.placeholder };
            }
            return null;
          });
          if (focused) break;
        }
        await page.keyboard.type("Pune");
        await page.waitForTimeout(300);
        const fm = await measureTarget(page);
        const ring = await page.evaluate(() => {
          const a = document.querySelector("[data-drill-target]");
          const cs = a ? getComputedStyle(a) : null;
          return cs ? { outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, border: cs.borderColor, boxShadow: cs.boxShadow.slice(0, 80) } : null;
        });
        report[`${name}-tab-field`] = { focused, ring, measured: fm.map(pick) };
        drill.check(Boolean(focused) && fm.length > 0 && fm.every((r) => r.ratio >= 4.5), `${name}, a field reached by Tab (${focused?.name}): typed text 4.5:1 or better`, { focused, ring, measured: fm.map(pick) });
        await snap(drill, page, "c-hover-focus", `${name}-tab-field`, 35 * 1024);
        await ctx.close();
      }
    } finally {
      await pointLiveAt(orig.id);
    }
    writeFileSync(join(drill.dir, "c-hover-focus", "contrast.json"), JSON.stringify(report, null, 2) + "\n");
  },

  async "c-dark-glow"(drill) {
    const orig = await liveRelease();
    const brand = { accent: "#f59e0b", background: "#0b0f17", foreground: "#f1f5f9", radius: "lg", type_scale: "regular" };
    const report = {};
    try {
      await publishCopy(orig.content, { brand, theme: { kit: "glow", version: 1 } });
      drill.note(`live: a dark brand ${JSON.stringify(brand)} on the Glow kit`);
      for (const width of [375, 1440]) {
        const ctx = await shopper(drill, width);
        const page = await ctx.newPage();
        for (const [key, path] of [["home", "/"], ["product", "/products/glow-serum"]]) {
          await go(page, path);
          await page.mouse.move(1, 1);
          const all = await audit(page);
          const checked = all.filter((r) => !r.overMedia && !r.disabled);
          const failing = checked.filter((r) => !r.pass);
          const header = checked.filter((r) => r.cls.includes("header") || false);
          report[`${key}-${width}`] = { kit: await page.evaluate(() => document.documentElement.dataset.kit), checked: checked.length, failing: failing.map(pick) };
          drill.check(!failing.length, `dark brand on Glow, ${key} at ${width}: every one of ${checked.length} pairs passes`, failing.slice(0, 8).map(pick));
          const hdr = (await audit(page, "header")).filter((r) => !r.disabled);
          const hero = key === "home" ? (await audit(page, '[data-sec="hero"]')).filter((r) => !r.disabled && !r.overMedia) : [];
          drill.check(hdr.length > 0 && hdr.every((r) => r.pass), `dark brand on Glow, ${key} at ${width}: the header passes`, hdr.filter((r) => !r.pass).map(pick));
          if (key === "home") drill.check(hero.length > 0 && hero.every((r) => r.pass), `dark brand on Glow, home at ${width}: the hero passes`, hero.filter((r) => !r.pass).map(pick));
          void header;
          await snap(drill, page, "c-dark-glow", `${key}-${width}`, 45 * 1024);
        }
        await ctx.close();
      }
    } finally {
      await pointLiveAt(orig.id);
    }
    writeFileSync(join(drill.dir, "c-dark-glow", "contrast.json"), JSON.stringify(report, null, 2) + "\n");
  },

  async "c-never-published"(drill) {
    const [st] = await rows("tenant", "SELECT live_release_id id FROM release_state WHERE id = 1");
    const cfg = await tenantCfg();
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    const api = signedInApi(page);
    const BAD = { ...(cfg.brand || {}), background: "#0a0a0b", foreground: "#18181b" };
    try {
      await sql("tenant", "UPDATE release_state SET live_release_id = NULL WHERE id = 1");
      drill.note(`setup: release_state.live_release_id set to NULL locally (was ${st.id}): the store has nothing live`);
      await drill.open(page, "/admin/brand", { width: 1440 });
      await page.locator("#brand-background").fill(BAD.background);
      await page.locator("#brand-foreground").fill(BAD.foreground);
      const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/brand" && r.request().method() === "PUT" && r.request().postData()?.includes('"brand"'), { timeout: 30_000 });
      await page.getByRole("button", { name: "Save brand", exact: true }).click();
      const res = await saved;
      const body = await res.json().catch(() => ({}));
      drill.check(res.status() === 200, "Save brand answers 200 for the unreadable brand", res.status());
      drill.note(`save warnings: ${JSON.stringify(body.warnings || [])}`);
      await drill.open(page, "/admin/brand", { width: 1440 });
      const warn = await seen(page, "Hard to read", 15_000);
      drill.check(warn, 'Brand shows the "Hard to read" warning after a reload');
      await drill.shoot(page, "c-never-published-brand-warning");
      // a signed-out shopper
      const sctx = await shopper(drill, 1440);
      const sp = await sctx.newPage();
      await go(sp, "/");
      const sv = await sp.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, draftBar: document.body.innerText.includes("Draft preview") }));
      drill.note(`signed-out shopper: ${JSON.stringify(sv)}`);
      drill.check(sv.body !== "rgb(10, 10, 11)" && sv.text !== "rgb(24, 24, 27)", "a signed-out shopper does not get the unreadable colours", sv);
      drill.check(sv.body === "rgb(255, 255, 255)", "a signed-out shopper sees the platform default look (white page)", sv);
      await snap(drill, sp, "c-never-published", "shopper-1440", 50 * 1024);
      await sctx.close();
      // the founder's preview
      await drill.open(page, "/admin/storefront/designer", { width: 1440 });
      await seen(page, "Preview shows your last save", 60_000);
      const fr = page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).pathname === "/");
      const pv = fr ? await fr.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, draftBar: document.body.innerText.includes("Draft preview") })).catch(() => null) : null;
      drill.note(`the founder's preview: ${JSON.stringify(pv)}`);
      drill.check(pv?.body === "rgb(10, 10, 11)", "the founder's preview shows the saved colours (#0a0a0b page)", pv);
      await drill.shoot(page, "c-never-published-designer");
    } finally {
      await api("/api/admin/brand", "PUT", cfg.brand ? { brand: cfg.brand } : { reset: true }).catch(() => {});
      await pointLiveAt(st.id);
      drill.note(`brand put back, live release back to ${st.id}`);
      await ctx.close();
    }
  },

  async "c-checkout-steps"(drill) {
    const out = {};
    for (const w of [320, 360, 375, 390, 414]) {
      const ctx = await shopper(drill, w);
      const page = await ctx.newPage();
      await addToCart(page);
      await go(page, "/checkout");
      const measure = () =>
        page.evaluate(() => {
          const wide = [...document.querySelectorAll("main *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ").slice(0, 3).join(".")}`).slice(0, 4);
          return { vw: window.innerWidth, sw: document.documentElement.scrollWidth, wide };
        });
      const address = await measure();
      await snap(drill, page, "c-checkout-steps", `address-${w}`, 30 * 1024);
      for (const [k, v] of Object.entries(SHOPPER)) if (v) await page.locator(`input[name="${k}"]`).fill(v);
      await page.getByRole("button", { name: "Continue to review" }).click();
      await page.getByRole("heading", { name: "Review your order" }).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
      const review = await measure();
      await snap(drill, page, "c-checkout-steps", `review-${w}`, 30 * 1024);
      await page.getByRole("button", { name: "Continue to payment" }).click();
      await page.getByRole("heading", { name: "Payment" }).waitFor({ timeout: 15_000 });
      await page.locator('input[name="method"]').first().check();
      await page.waitForTimeout(400);
      const payment = await measure();
      await snap(drill, page, "c-checkout-steps", `payment-${w}`, 30 * 1024);
      out[w] = { address, review, payment };
      for (const [step, m] of Object.entries(out[w])) drill.check(m.sw <= m.vw + 1, `checkout ${step} at ${w}: no sideways scroll`, m);
      await ctx.close();
    }
    writeFileSync(join(drill.dir, "c-checkout-steps", "widths.json"), JSON.stringify(out, null, 2) + "\n");
  },
};
