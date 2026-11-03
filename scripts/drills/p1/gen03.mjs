// P1-DRILLS · GEN-03 batch A drills (docs/cms-reviews/P1-GEN-03.md "Still needs a browser drill").
//   rates      3, 5, 6, 9, 2 (COD only) and 4 (the failed network call only)
//   boundary   7, with a temporary throw in the storefront search page (gen03-temp.mjs)
//   footer     8, both footer variants, switched in the console and published
//   home       12, the Home editor's banner and rich text placeholders
//   account    13 and 14 (sign-in code read from the local notifications table)
//   empty      1 and 10, on a store with 0 products (run after the products are deleted)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, rows } from "./db.mjs";
import { text, seen, settle, sleep } from "./util.mjs";
import { noThanks, clearCart, addToCart, checkoutCod, SHOPPER } from "./sf.mjs";
import { drawerOpen } from "../../drill.js";

export const id = "GEN-03";
export const title = "P1-DRILLS GEN-03: a good store before the founder edits anything";

const drawerText = (page) => page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Shopping cart"]')?.innerText || "");

async function publishNow(drill, page) {
  await drill.open(page, "/admin/releases", { width: 1280 });
  await seen(page, "What will publish", 30_000);
  const btn = page.getByRole("button", { name: "Publish now", exact: true }).first();
  if (!(await btn.isEnabled())) return "nothing to publish";
  await btn.click();
  await page.waitForTimeout(400);
  const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/releases" && r.request().method() === "POST", { timeout: 30_000 });
  await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
  return (await posted).status();
}

export const parts = {
  async rates(drill) {
    const cfg = JSON.parse((await rows("platform", "SELECT json_extract(config,'$.shipping_config') s FROM tenants WHERE id='design'"))[0].s || "null");
    drill.note(`setup: the store's shipping config before: ${JSON.stringify(cfg)}`);
    // ---- 5: starter rates, no nudge ----
    const shop = await drill.context({ width: 1440 });
    const sp = await shop.newPage();
    await drill.open(sp, "/");
    await noThanks(sp);
    await clearCart(sp);
    const a = await addToCart(drill, sp, "glow-serum", 1);
    let dt = await drawerText(sp);
    drill.check(a.drawer && !/more for\s+free shipping/i.test(dt), "5: on starter rates the drawer shows no free-shipping nudge", dt.split("\n").filter((l) => /ship/i.test(l)));
    await drill.shoot(sp, "5-drawer-starter-no-nudge");

    // ---- 6: the notice in Settings, then own rates saved and reloaded ----
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/settings", { width: 1280 });
    await page.locator("#shipping").scrollIntoViewIfNeeded();
    const notice = await seen(page, "You haven't set your own shipping rates yet", 10_000);
    drill.check(notice, `6: the shipping card shows "You haven't set your own shipping rates yet" with Keep these rates`);
    await page.locator("#shipping").screenshot({ path: join(drill.dir, "6-settings-notice-raw.png") }).catch(() => {});
    await drill.shoot(page, "6-settings-notice");
    const before = { flat: await page.locator("#sa-flat-rate").inputValue(), free: await page.locator("#sa-free-over").inputValue(), cod: await page.locator("#sa-cod-fee").inputValue() };
    drill.note(`6: starter values shown: ${JSON.stringify(before)}`);
    await page.locator("#sa-flat-rate").fill("79");
    await page.locator("#sa-free-over").fill("1999");
    await page.locator("#sa-cod-fee").fill("49");
    await page.locator("#sa-cod-waive").fill("");
    const put = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    const pr = await put;
    drill.check(pr.status() === 200, "6: Save settings answers 200", pr.status());
    await page.waitForTimeout(1500);
    await page.reload();
    await settle(page);
    await page.locator("#shipping").scrollIntoViewIfNeeded();
    const after = { flat: await page.locator("#sa-flat-rate").inputValue(), free: await page.locator("#sa-free-over").inputValue(), cod: await page.locator("#sa-cod-fee").inputValue(), notice: (await text(page)).includes("You haven't set your own shipping rates yet") };
    const saved = JSON.parse((await rows("platform", "SELECT json_extract(config,'$.shipping_config') s FROM tenants WHERE id='design'"))[0].s || "null");
    drill.note(`6: what the control plane holds right after Save: ${JSON.stringify(saved)}`);
    drill.check(after.flat === "79" && after.free === "1999" && after.cod === "49" && !after.notice, "6: a reload right after Save shows the saved rates and no notice", after);
    await drill.shoot(page, "6-settings-after-save-reload");
    if (after.notice || after.free !== "1999") {
      await page.waitForTimeout(31_000); // the console's tenant settings cache (PLATFORM_CACHE_MS, 30 s)
      await page.reload();
      await settle(page);
      await page.locator("#shipping").scrollIntoViewIfNeeded();
      const later = { flat: await page.locator("#sa-flat-rate").inputValue(), free: await page.locator("#sa-free-over").inputValue(), cod: await page.locator("#sa-cod-fee").inputValue(), notice: (await text(page)).includes("You haven't set your own shipping rates yet") };
      drill.check(later.free === "1999" && !later.notice, "6: a reload 31 s later shows the saved rates and no notice", later);
      await drill.shoot(page, "6-settings-reload-31s-later");
    }

    // ---- 5 and 9: the nudge appears (the storefront caches settings up to 30 s) ----
    let nudge = null;
    for (let i = 0; i < 45 && !nudge; i++) {
      await drill.open(sp, "/products/glow-serum");
      await sp.getByRole("button", { name: /Open cart/ }).first().click();
      await sp.waitForTimeout(500);
      dt = await drawerText(sp);
      nudge = dt.split("\n").find((l) => /more for/i.test(l)) || null;
      if (!nudge) await sp.waitForTimeout(1000);
    }
    drill.check(nudge && /Add ₹700 more for/.test(nudge), "5: after saving rates the drawer shows the nudge (Add ₹700 more for free shipping, at ₹1,299 of ₹1,999)", nudge);
    await drill.shoot(sp, "5-drawer-own-rates-nudge");
    // 9: a fresh page load seeds the cart from the real cart, and adding shows the right nudge
    await clearCart(sp);
    await drill.open(sp, "/products/vitamin-c-booster");
    const a9 = await addToCart(drill, sp, "vitamin-c-booster", 1);
    dt = await drawerText(sp);
    const n9 = dt.split("\n").find((l) => /more for/i.test(l));
    drill.check(a9.drawer && n9 && /Add ₹500 more for/.test(n9), "9: on a real page, adding to the cart opens the drawer with the right nudge (₹1,499 → Add ₹500 more)", n9);
    await sp.reload();
    await settle(sp);
    const header = await sp.getByRole("button", { name: /Open cart/ }).first().getAttribute("aria-label");
    drill.check(/1 item/.test(header || ""), "9: after a reload the header's cart button comes from the real cart (layout seeds CartProvider)", header);
    await drill.shoot(sp, "9-drawer-real-page");

    // ---- 3 and 2: checkout with own rates, COD ----
    await clearCart(sp);
    await addToCart(drill, sp, "glow-serum", 1);
    await drill.open(sp, "/checkout");
    for (const [k, v] of Object.entries(SHOPPER)) if (v) await sp.locator(`input[name="${k}"]`).fill(v);
    await sp.getByRole("button", { name: "Continue to review" }).click();
    await sp.getByRole("button", { name: "Continue to payment" }).click();
    await sp.getByRole("heading", { name: "Payment" }).waitFor();
    const online = await sp.evaluate(() => {
      const r = [...document.querySelectorAll('input[name="method"]')][1];
      return { disabled: r?.disabled, label: r?.closest("label")?.innerText };
    });
    drill.check(online.disabled && online.label.includes("Online payment isn't available for this store right now."), `3: with no Razorpay keys, Pay online is disabled with "Online payment isn't available for this store right now."`, online);
    await drill.shoot(sp, "3-payment-no-keys");
    const btn = (await sp.getByRole("button", { name: /^Place order/ }).innerText()).trim();
    const summary = await sp.evaluate(() => {
      const aside = [...document.querySelectorAll("aside, div")].find((d) => /Order summary|Summary/.test(d.querySelector("h2,h3")?.innerText || "") && d.innerText.includes("Total"));
      return aside?.innerText || document.body.innerText.slice(-600);
    });
    const btnAmt = /₹([\d,]+)/.exec(btn)?.[1];
    const totals = summary.split("\n").filter((l) => /Total|Shipping|COD|Subtotal|₹/.test(l));
    drill.note(`2: payment step: button "${btn}"; summary ${JSON.stringify(totals.slice(0, 12))}`);
    // ---- 4: a failed network call ----
    await sp.route("**/api/checkout**", (route) => route.abort("internetdisconnected"));
    await sp.getByRole("button", { name: /^Place order/ }).click();
    await sp.waitForTimeout(1500);
    const err = await sp.evaluate(() => [...document.querySelectorAll("p")].map((p) => p.innerText).find((t) => /Could not reach the store|couldn't|went wrong/i.test(t)) || null);
    drill.check(err === "Could not reach the store — your cart is untouched. Check your connection and try again.", `4: a failed network call shows "Could not reach the store — your cart is untouched. Check your connection and try again."`, err);
    await drill.shoot(sp, "4-network-failed");
    await sp.unroute("**/api/checkout**");
    // ---- 2: place it ----
    await sp.getByRole("button", { name: /^Place order/ }).click();
    await sp.waitForURL(/\/checkout\/confirmation\//, { timeout: 60_000 });
    const orderId = decodeURIComponent(new URL(sp.url()).pathname.split("/").pop());
    const o = (await rows("tenant", "SELECT total, subtotal, shipping_total, payment_method FROM orders WHERE id=?", [orderId]))[0];
    drill.check(o && Number(btnAmt?.replace(/,/g, "")) === Number(o.total), `2 (COD): the Place order button (₹${btnAmt}) matches the amount charged (order total ₹${o?.total})`, o);
    drill.check(totals.some((l) => l.includes(`₹${btnAmt}`)), "2 (COD): the summary's total matches the button", totals);
    await drill.shoot(sp, "2-cod-confirmation");
    await shop.close();
    await ctx.close();
  },

  async boundary(drill) {
    const src = readFileSync(join(drill.root, "app/(storefront)/search/page.js"), "utf8");
    drill.check(src.includes("P1-DRILLS GEN-03"), "7 setup: a temporary throw is in app/(storefront)/search/page.js");
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    const r = await drill.open(page, "/search?q=serum");
    const t = await text(page);
    drill.check(r.headers["x-edge-runtime"] === "1" || r.status >= 500, "7: the page ran on the edge runtime", { status: r.status, edge: r.headers["x-edge-runtime"] });
    drill.check(t.includes("Something went wrong") && t.includes("A temporary error stopped this page from loading. It's usually gone on retry."), "7: the storefront's error boundary shows its plain words", t.slice(0, 300));
    drill.check((await page.getByRole("button", { name: "Try again" }).count()) > 0 && (await page.getByRole("link", { name: "Back to home" }).count()) > 0, "7: with Try again and Back to home");
    drill.check(!/P1-DRILLS|Error:|at\s+\w+\s+\(/.test(t), "7: no error text or stack shown to the shopper", t.slice(0, 300));
    await noThanks(page);
    await drill.shoot(page, "7-error-boundary-edge");
    await ctx.close();
  },

  async footer(drill) {
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    const anon = await drill.context({ width: 1440 });
    const ap = await anon.newPage();
    const footerOf = async () => {
      await drill.open(ap, "/");
      await noThanks(ap);
      return ap.evaluate(() => {
        const f = document.querySelector("footer");
        f?.scrollIntoView();
        return f ? { text: f.innerText, cols: f.querySelectorAll("h3, h4").length } : null;
      });
    };
    const setFooter = async (v) => {
      await drill.open(page, "/admin/theme", { width: 1280 });
      await page.locator("#tpl-footer").selectOption(v);
      const card = page.locator("#page-templates");
      const put = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/admin"), { timeout: 30_000 });
      await card.getByRole("button", { name: /^Save/ }).first().click();
      const st = (await put).status();
      const pub = await publishNow(drill, page);
      return { st, pub };
    };
    const check = async (v) => {
      let f = null;
      for (let i = 0; i < 40; i++) {
        f = await footerOf();
        const isMinimal = f && f.cols === 0;
        if ((v === "minimal") === isMinimal) break;
        await ap.waitForTimeout(1000);
      }
      const ok = f && f.text.includes("Design Demo Co") && !/catalog|Shopify|Vercel|Turso/i.test(f.text);
      drill.check(ok, `8: the ${v} footer carries the store's name and no catalog or vendor note`, f?.text.slice(0, 300));
      await drill.shoot(ap, `8-footer-${v}`, { fullPage: false });
      return f;
    };
    const cur = await (async () => {
      await drill.open(page, "/admin/theme", { width: 1280 });
      return page.locator("#tpl-footer").inputValue();
    })();
    drill.note(`8: the footer layout before: ${cur}`);
    if (cur !== "columns") drill.note(`8: switched to columns: ${JSON.stringify(await setFooter("columns"))}`);
    await check("columns");
    drill.note(`8: switched to minimal: ${JSON.stringify(await setFooter("minimal"))}`);
    await check("minimal");
    drill.note(`8: switched back to columns: ${JSON.stringify(await setFooter("columns"))}`);
    await anon.close();
    await ctx.close();
  },

  async home(drill) {
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/storefront/home", { width: 1280 });
    const card = page.locator("section", { has: page.getByRole("heading", { name: /^Homepage sections/ }) }).first();
    await card.getByRole("button", { name: "Banner / CTA", exact: true }).click();
    await card.getByRole("button", { name: "Rich text", exact: true }).click();
    await page.waitForTimeout(400);
    const ph = await card.evaluate((sec) => [...sec.querySelectorAll("input, textarea")].slice(-8).map((e) => ({ id: e.id, ph: e.getAttribute("placeholder"), value: e.value })));
    drill.note(`12: the new sections' fields and placeholders: ${JSON.stringify(ph)}`);
    drill.check(ph.some((p) => p.ph === "A short headline") && ph.some((p) => /Tell your story/.test(p.ph || "")), "12: the placeholders read as examples (\"A short headline\", \"<p>Tell your story…</p>\")", ph);
    await drill.shoot(page, "12-placeholders");
    const put1 = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    const s1 = (await put1).status();
    await page.waitForTimeout(1200);
    const err = await page.evaluate(() => [...document.querySelectorAll("div")].filter((d) => /danger-bg/.test(d.className || "")).map((d) => d.innerText).join("\n"));
    drill.check(s1 === 422 && /Section 3 \(Banner \/ CTA\)/.test(err) && /Section 4 \(Rich text\)/.test(err), "12: saving them unedited shows the error for each", { s1, err });
    await drill.shoot(page, "12-unedited-error");
    const bannerId = ph.find((p) => p.ph === "A short headline")?.id;
    await page.locator(`#${bannerId}`).fill("Winter gift guide");
    const richId = ph.find((p) => /Tell your story/.test(p.ph || ""))?.id;
    await page.locator(`#${richId}`).fill("<p>Made in small batches.</p>");
    const put2 = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    const s2 = (await put2).status();
    drill.check(s2 === 200, "12: typing a title (and the rich text) lets it save", s2);
    await drill.shoot(page, "12-saved");
    await ctx.close();
  },

  async account(drill) {
    const EMAIL = "drill-account@design.test";
    // two COD orders for this shopper
    const shop = await drill.context({ width: 1440 });
    const sp = await shop.newPage();
    await drill.open(sp, "/");
    await noThanks(sp);
    const ids = [];
    for (const h of ["gentle-cleanser", "rose-mist"]) {
      await clearCart(sp);
      await addToCart(drill, sp, h, 1);
      ids.push((await checkoutCod(drill, sp, { shopper: { ...SHOPPER, email: EMAIL } })).orderId);
    }
    await sql("tenant", [
      { sql: "UPDATE orders SET fulfillment_status='fulfilled' WHERE id=?", args: [ids[0]] },
      { sql: "UPDATE orders SET fulfillment_status='partially_fulfilled' WHERE id=?", args: [ids[1]] },
    ]);
    drill.note(`14 setup: orders ${ids.join(", ")} for ${EMAIL}, set shipped and partly shipped in the local DB`);
    // ---- 13: a wrong code ----
    await drill.open(sp, "/account");
    await sp.locator('input[type="email"]').first().fill(EMAIL);
    await sp.getByRole("button", { name: /code/i }).first().click();
    const codeInput = sp.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name="code"]').first();
    await codeInput.waitFor({ timeout: 20_000 });
    await codeInput.fill("000000");
    await sp.getByRole("button", { name: /Sign in|Verify|Continue/i }).first().click();
    const wrong = await seen(sp, "That code isn't right — check the email and try again.", 15_000);
    const pageT = await text(sp);
    drill.check(wrong && !pageT.includes("Something went wrong"), `13: a wrong sign-in code shows "That code isn't right — check the email and try again.", not "Something went wrong"`, pageT.split("\n").filter((l) => /code|wrong/i.test(l)).slice(0, 4));
    await drill.shoot(sp, "13-wrong-code");
    // ---- 14: the real code from the local notifications table (never printed) ----
    const n = await rows("tenant", "SELECT subject FROM notifications WHERE recipient=? AND type='customer_otp' ORDER BY created_at DESC LIMIT 1", [EMAIL]);
    const code = /(\d{6})/.exec(n[0]?.subject || "")?.[1];
    drill.check(Boolean(code), "14 setup: the sign-in code was recorded locally (notifications table; email is blanked on the harness)");
    if (code) {
      await codeInput.fill(code);
      await sp.getByRole("button", { name: /Sign in|Verify|Continue/i }).first().click();
      await sp.waitForTimeout(2500);
      for (const w of [1440, 375]) {
        await drill.open(sp, "/account", { width: w });
        const badges = await sp.evaluate(() => [...document.querySelectorAll("span")].filter((s) => /shipped/i.test(s.innerText) && s.innerText.length < 30).map((s) => ({ t: s.innerText, w: s.scrollWidth, cw: s.clientWidth, right: Math.round(s.getBoundingClientRect().right), vw: window.innerWidth })));
        drill.check(badges.some((b) => /^shipped$/i.test(b.t)) && badges.some((b) => /^partly shipped$/i.test(b.t)), `14 at ${w}: the order list shows plain words on the badges (shipped, partly shipped)`, badges);
        drill.check(badges.every((b) => b.w <= b.cw + 1 && b.right <= b.vw), `14 at ${w}: "PARTLY SHIPPED" fits`, badges);
        await drill.shoot(sp, `14-orders-${w}`);
      }
    }
    await shop.close();
  },

  async empty(drill) {
    const n = await rows("tenant", "SELECT count(*) n FROM products");
    drill.check(Number(n[0].n) === 0, "1/10 setup: the store has 0 products", n[0].n);
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    for (const w of [1440, 375]) {
      let t = "";
      for (let i = 0; i < 40; i++) {
        const r = await drill.open(page, "/", { width: w });
        t = await text(page);
        if (!/\d+ products · /.test(t) || /0 products/.test(t)) break;
        await page.waitForTimeout(1000);
      }
      await noThanks(page);
      const f = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth, heroButtons: [...document.querySelectorAll('[data-sec="hero"] a, [data-sec="hero"] button')].map((a) => a.innerText.trim()).filter(Boolean), heroH: Math.round(document.querySelector('[data-sec="hero"]')?.getBoundingClientRect().height || 0), err: /Something went wrong/.test(document.body.innerText) }));
      drill.check(!f.err && f.sw <= f.vw + 1, `1 at ${w}: the empty store's home renders with no error and no sideways scroll`, f);
      drill.check(f.heroButtons.length === 1, `10 at ${w}: the shorter hero has one button`, f.heroButtons);
      drill.note(`10 at ${w}: hero ${f.heroH}px tall; text ${JSON.stringify(t.slice(0, 240))}`);
      await drill.shoot(page, `1-empty-home-${w}`);
      await drill.open(page, "/collections", { width: w });
      const c = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth, err: /Something went wrong/.test(document.body.innerText), text: document.body.innerText.slice(0, 400) }));
      drill.check(!c.err && c.sw <= c.vw + 1, `1 at ${w}: /collections on the empty store renders with no error and no sideways scroll`, c);
      drill.note(`1 at ${w}: /collections reads ${JSON.stringify(c.text.slice(0, 240))}`);
      await drill.shoot(page, `1-empty-collections-${w}`);
    }
    await ctx.close();
  },
};
