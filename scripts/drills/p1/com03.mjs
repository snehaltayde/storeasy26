// P1-DRILLS · COM-03 "Browser drills still needed" B1–B7 (docs/cms-reviews/P1-COM-03.md).
//   cart     B1 + B5: Buy 2 get 1 (name blank) → storefront cart label and free count,
//            edit to get 2, then go back, with no restart and no publish
//   tabs     B6: two real tabs on one live offer
//   later    B7: going back to settings that start later
//   keyboard B2: the New offer journey without a mouse
//   slow     B3: a slow, then a failed example
//   big      B4: 2,000 products with 50 tags (adds rows to the local DB: re-seed after)
import { sql, rows } from "./db.mjs";
import { text, seen, settle, sleep } from "./util.mjs";
import { noThanks, clearCart } from "./sf.mjs";
import { drawerOpen } from "../../drill.js";

export const id = "COM-03";
export const title = "P1-DRILLS COM-03: offers in plain words, a check before going live, a way back";

const PRODUCT = "Night Repair Cream 50g";
const HANDLE = "night-repair-cream";
const PRICE = 1799;
const VARIANT = "gid://v/2";

async function toastsOf(page) {
  return page.evaluate(() => [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim())).filter(Boolean));
}

async function waitToast(page, re, ms = 15_000) {
  const t0 = Date.now();
  let t = [];
  while (Date.now() - t0 < ms) {
    t = await toastsOf(page);
    if (t.some((x) => re.test(x))) return t;
    await sleep(150);
  }
  return t;
}

async function openOffers(drill, page) {
  await drill.open(page, "/admin/offers", { width: 1280 });
  await seen(page, "New offer", 30_000);
}

// The list row whose text holds `needle`, then its Edit button.
async function editRow(page, needle) {
  const row = page.locator("li, tr, article, section > div").filter({ hasText: needle }).filter({ has: page.getByRole("button", { name: "Edit", exact: true }) }).last();
  await row.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.waitForTimeout(800);
}

async function startBxgy(page, product, { buy = 2, free = 1 } = {}) {
  await page.getByRole("button", { name: "New offer" }).first().click();
  await page.getByRole("button", { name: /Buy some, get some free/ }).click();
  await page.getByRole("button", { name: /^One product/ }).click().catch(() => {});
  await page.getByRole("button", { name: "Choose a product", exact: true }).click();
  const dlg = page.locator("dialog[open]").last();
  await dlg.getByRole("searchbox").first().fill(product.split(" ")[0]).catch(() => {});
  await dlg.getByRole("button", { name: new RegExp(product) }).first().click({ timeout: 30_000 });
  await page.locator("#offer-buy").fill(String(buy));
  await page.locator("#offer-free").fill(String(free));
  await page.waitForTimeout(1500);
  const start = page.getByRole("button", { name: "Start offer", exact: true });
  await start.click();
  return waitToast(page, /./);
}

// The storefront cart as a shopper's browser gets it.
async function cartState(page) {
  return page.evaluate(async () => {
    const c = await (await fetch("/api/cart", { cache: "no-store" })).json();
    return { items: (c.items || []).map((i) => ({ title: i.title, qty: i.quantity })), offers: (c.appliedOffers || []).map((o) => ({ title: o.label ?? o.title ?? null, amount: o.amount })), discountTotal: c.discountTotal, subtotal: c.subtotal };
  });
}

async function setQty(page, variantId, quantity) {
  return page.evaluate(async ([v, q]) => (await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setQty", variantId: v, quantity: q }) })).status, [variantId, quantity]);
}

async function drawerOffers(drill, page) {
  await drill.open(page, `/products/${HANDLE}`);
  await noThanks(page);
  await page.getByRole("button", { name: /Open cart/ }).first().click();
  await page.waitForTimeout(800);
  return page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Shopping cart"]')?.innerText || "");
}

export const parts = {
  async cart(drill) {
    const offersBefore = await rows("tenant", "SELECT id, label AS title, config FROM offers");
    drill.check(!offersBefore.some((o) => String(o.config).includes("gid://p/2") || String(o.config).includes(HANDLE)), `setup: no other offer on ${PRODUCT}`, offersBefore.map((o) => o.title));
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await openOffers(drill, page);
    const t1 = await startBxgy(page, PRODUCT, { buy: 2, free: 1 });
    drill.note(`B1: start toast ${JSON.stringify(t1)}`);
    const made = await rows("tenant", "SELECT id, label AS title, config, enabled FROM offers ORDER BY created_at DESC LIMIT 1");
    drill.check(String(made[0]?.config).includes("gid://p/2") || made[0]?.title?.includes(PRODUCT), "B1 setup: Buy 2 get 1 started on the product, name left blank", made[0]);
    const offerId = made[0]?.id;
    await drill.shoot(page, "B1-started");

    // ---- B5: the storefront cart with 3 ----
    const shop = await drill.context({ width: 1280 });
    const sp = await shop.newPage();
    await drill.open(sp, "/");
    await noThanks(sp);
    await clearCart(sp);
    await setQty(sp, VARIANT, 0);
    await sp.evaluate(async (v) => fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", variantId: v, quantity: 3 }) }), VARIANT);
    let cs = await cartState(sp);
    let dt = await drawerOffers(drill, sp);
    const label1 = `Buy 2 of ${PRODUCT}, get 1 free`;
    drill.check(cs.offers.some((o) => o.title === label1 && o.amount === PRICE) && dt.includes(label1), `B5: with 3 in the cart the drawer's discount line reads "${label1}" (1 free, ₹${PRICE} off)`, { cs, drawer: dt.slice(0, 300) });
    await drill.shoot(sp, "B5-drawer-get-1");

    // ---- edit to get 2 ----
    await openOffers(drill, page);
    await editRow(page, PRODUCT);
    await page.locator("#offer-free").fill("2");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Update live offer", exact: true }).click();
    const t2 = await waitToast(page, /./);
    drill.note(`B1: update toast ${JSON.stringify(t2)}`);
    // ---- B1: 4 in the cart → 2 free ----
    await setQty(sp, VARIANT, 4);
    dt = await drawerOffers(drill, sp);
    cs = await cartState(sp);
    const label2 = `Buy 2 of ${PRODUCT}, get 2 free`;
    drill.check(cs.offers.some((o) => o.amount === 2 * PRICE), `B1: with 4 in the cart, 2 free (₹${2 * PRICE} off)`, cs);
    drill.check(cs.offers.some((o) => o.title === label2) && dt.includes(label2), `B5: after the edit the drawer reads "${label2}"`, { cs, drawer: dt.slice(0, 300) });
    await drill.shoot(sp, "B5-drawer-get-2");
    await drill.open(sp, "/checkout");
    await noThanks(sp);
    const co = await text(sp);
    drill.check(co.includes(label2), `B5: the checkout summary reads "${label2}"`, co.split("\n").filter((l) => /free|Buy 2/i.test(l)));
    await drill.shoot(sp, "B5-checkout-get-2");

    // ---- B1: go back in the console ----
    await openOffers(drill, page);
    await editRow(page, PRODUCT);
    await page.getByRole("button", { name: "Go back to previous offer settings" }).click();
    await page.waitForTimeout(500);
    const dlgText = await page.locator("dialog[open]").innerText();
    drill.note(`B1: go-back dialog: ${JSON.stringify(dlgText)}`);
    await page.locator("dialog[open]").getByRole("button", { name: "Go back", exact: true }).click();
    const t3 = await waitToast(page, /Back to the earlier settings/);
    drill.check(t3.some((x) => x.startsWith("Back to the earlier settings")), "B1: going back in the console says so", t3);
    await drill.shoot(page, "B1-went-back");
    // reload the cart: no restart, no publish
    await sp.reload();
    await settle(sp);
    cs = await cartState(sp);
    dt = await drawerOffers(drill, sp);
    drill.check(cs.offers.some((o) => o.amount === PRICE && o.title === label1), `B1: reloading the cart gives 1 free again ("${label1}"), with no restart and no publish`, cs);
    await drill.shoot(sp, "B1-drawer-after-go-back");
    const releases = await rows("tenant", "SELECT count(*) n FROM releases");
    drill.note(`B1: releases in the store: ${releases[0].n} (none made by this drill; offers are not published content)`);
    await clearCart(sp);
    await shop.close();
    // leave the offer off so it doesn't touch later drills
    await sql("tenant", "UPDATE offers SET enabled=0 WHERE id=?", [offerId]);
    await ctx.close();
  },

  async tabs(drill) {
    const ctx = await drill.context({ width: 1280 });
    const a = await drill.signIn(ctx);
    // A live offer: the seeded "Serum duo" tiered offer.
    await openOffers(drill, a);
    const b = await ctx.newPage();
    await openOffers(drill, b);
    // Make sure it has a previous version to go back to: a first edit in A.
    await editRow(a, "Serum duo");
    const firstTier = a.getByLabel("Step 1: percent off");
    const v0 = await firstTier.inputValue();
    await firstTier.fill(String(Number(v0) + 1));
    await a.waitForTimeout(1200);
    await a.getByRole("button", { name: "Update live offer", exact: true }).click();
    await waitToast(a, /./);
    // Both tabs open the edit view now.
    await openOffers(drill, a);
    await editRow(a, "Serum duo");
    await openOffers(drill, b);
    await editRow(b, "Serum duo");
    const hasBack = await b.getByRole("button", { name: "Go back to previous offer settings" }).count();
    drill.check(hasBack > 0, "B6 setup: both tabs show the live offer's edit view with a way back", hasBack);
    // A: change a number, Update live offer
    const v1 = await a.getByLabel("Step 1: percent off").inputValue();
    const v2 = String(Number(v1) + 2);
    await a.getByLabel("Step 1: percent off").fill(v2);
    await a.waitForTimeout(1200);
    await a.getByRole("button", { name: "Update live offer", exact: true }).click();
    const ta = await waitToast(a, /./);
    drill.note(`B6: tab A update toast ${JSON.stringify(ta)}`);
    // B: without reloading, Go back
    await b.bringToFront();
    await b.getByRole("button", { name: "Go back to previous offer settings" }).click();
    await b.waitForTimeout(400);
    await b.locator("dialog[open]").getByRole("button", { name: "Go back", exact: true }).click();
    await b.waitForTimeout(2000);
    const dlg = await b.evaluate(() => document.querySelector("dialog[open]")?.innerText || "");
    drill.check(dlg.includes("This offer changed while you were looking at it"), `B6: tab B's dialog shows "This offer changed while you were looking at it…"`, dlg);
    await drill.shoot(b, "B6-tab-b-refused");
    await openOffers(drill, b);
    const list = await text(b);
    const row = list.split("\n").filter((l) => /Radiance Glow Serum|Serum duo/.test(l));
    const cfg = await rows("tenant", "SELECT label AS title, config FROM offers WHERE id='serum-duo'");
    drill.check(String(cfg[0]?.config).includes(`"percent":${v2}`) || String(cfg[0]?.config).includes(`:${v2}`), `B6: the reloaded list still shows tab A's settings (step 1 at ${v2}%)`, { row, cfg: cfg[0] });
    await drill.shoot(b, "B6-list-after");
    await ctx.close();
  },

  async later(drill) {
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await openOffers(drill, page);
    await page.getByRole("button", { name: "New offer" }).first().click();
    await page.getByRole("button", { name: /Discount code/ }).click();
    await page.locator("#offer-code").fill("DRILLLATER");
    await page.locator("#offer-disc-value").fill("10");
    const startsAt = await page.evaluate(() => {
      const d = new Date(Date.now() + 7 * 86400000);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`;
    });
    await page.locator("#offer-starts").fill(startsAt);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Start offer", exact: true }).click();
    const t1 = await waitToast(page, /./);
    drill.note(`B7: start toast ${JSON.stringify(t1)}`);
    // change it to no dates
    await openOffers(drill, page);
    await editRow(page, "DRILLLATER");
    await page.locator("#offer-starts").fill("");
    await page.waitForTimeout(1200);
    const primary = page.locator('form button[type="submit"]').last();
    drill.note(`B7: the primary button reads "${(await primary.innerText()).trim()}"`);
    await primary.click();
    const t2 = await waitToast(page, /./);
    drill.note(`B7: no-dates save toast ${JSON.stringify(t2)}`);
    // go back
    await openOffers(drill, page);
    await editRow(page, "DRILLLATER");
    await page.getByRole("button", { name: "Go back to previous offer settings" }).click();
    await page.waitForTimeout(500);
    const dlg = await page.locator("dialog[open]").innerText();
    const first = dlg.split("\n").map((l) => l.trim()).filter(Boolean)[1] || "";
    drill.note(`B7: dialog text ${JSON.stringify(dlg)}`);
    drill.check(/^Shoppers get this from .+:$/.test(first), `B7: the dialog's first line reads "Shoppers get this from <date>:"`, first);
    await drill.shoot(page, "B7-go-back-dialog");
    await page.locator("dialog[open]").getByRole("button", { name: "Go back", exact: true }).click();
    const t3 = await waitToast(page, /Back to the earlier settings/);
    const toast = t3.find((x) => x.startsWith("Back to the earlier settings")) || "";
    drill.check(/^Back to the earlier settings\. Shoppers get them from .+\.$/.test(toast), `B7: the toast reads "Back to the earlier settings. Shoppers get them from <date>."`, t3);
    const d1 = /from (.+):$/.exec(first)?.[1];
    const d2 = /from (.+)\.$/.exec(toast)?.[1];
    drill.check(d1 && d1 === d2, "B7: the dialog and the toast name the same date", { dialog: d1, toast: d2 });
    await drill.shoot(page, "B7-toast");
    await ctx.close();
  },

  async keyboard(drill) {
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await openOffers(drill, page);
    const focusInfo = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        const s = getComputedStyle(el);
        const focused = { outline: s.outlineStyle + " " + s.outlineWidth, shadow: s.boxShadow, border: s.borderColor };
        // Tag the element; its unfocused look is read after the journey.
        window.__p1stops = (window.__p1stops || 0) + 1;
        if (!el.dataset.p1stop) el.dataset.p1stop = String(window.__p1stops);
        const ringOrOutline = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
        return { tag: el.tagName, stop: el.dataset.p1stop, type: el.type || null, text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 50), ringOrOutline, focused, inDialog: Boolean(el.closest("dialog")) };
      });
    const stops = [];
    const tabTo = async (re, max = 60, back = false) => {
      for (let i = 0; i < max; i++) {
        await page.keyboard.press(back ? "Shift+Tab" : "Tab");
        const f = await focusInfo();
        stops.push(f);
        if (re.test(f.text)) return f;
      }
      return null;
    };
    await page.evaluate(() => document.activeElement?.blur());
    const nb = await tabTo(/^New offer$/);
    drill.check(Boolean(nb), "B2: Tab reaches New offer", nb);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const kind = await tabTo(/^Buy some, get some free/);
    drill.check(Boolean(kind), "B2: Tab reaches the kind 'Buy some, get some free'", kind);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const one = await tabTo(/^One product/);
    if (one) await page.keyboard.press("Enter");
    const choose = await tabTo(/^Choose a product$/);
    drill.check(Boolean(choose), "B2: Tab reaches Choose a product", choose);
    // Escape closes the picker and focus returns to the button
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    let f = await focusInfo();
    drill.check(f.inDialog, "B2: the product picker opens with focus inside", f);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    f = await focusInfo();
    const open1 = await page.locator("dialog[open]").count();
    drill.check(open1 === 0 && /^Choose a product$/.test(f.text), "B2: Escape closes the picker and focus returns to Choose a product", { open1, f });
    // open again and pick by keyboard
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    await page.keyboard.type("Night");
    await page.waitForTimeout(1200);
    const row = await tabTo(/Night Repair Cream/, 20);
    drill.check(Boolean(row), "B2: Tab reaches the product in the picker", row);
    await page.keyboard.press("Enter"); // a one-product picker takes the pick at once
    await page.waitForTimeout(700);
    f = await focusInfo();
    const open2 = await page.locator("dialog[open]").count();
    drill.check(open2 === 0 && /^(Change|Choose a product)$/.test(f.text), "B2: Enter on the product picks it, closes the picker, and focus returns to the button that opened it", { open2, f });
    await drill.shoot(page, "B2-picked-by-keyboard");
    await page.locator("#offer-starts").focus();
    await page.keyboard.press("Tab");
    await page.locator("#offer-starts").screenshot({ path: `${drill.dir}/B2-date-part-focus-raw.png` }).catch(() => {});
    await page.locator("#offer-starts").scrollIntoViewIfNeeded();
    await drill.shoot(page, "B2-date-part-focus");
    await page.getByRole("button", { name: /^(Change|Choose a product)$/ }).first().focus();
    const start = await tabTo(/^Start offer$/, 60);
    drill.check(Boolean(start), "B2: Tab reaches Start offer", start);
    await page.evaluate(() => document.activeElement?.blur());
    const unfocused = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-p1stop]")].map((e) => { const u = getComputedStyle(e); return [e.dataset.p1stop, { shadow: u.boxShadow, border: u.borderColor, outline: u.outlineStyle + " " + u.outlineWidth }]; })));
    for (const st of stops) {
      const u = unfocused[st.stop];
      st.visible = st.ringOrOutline || (u ? u.border !== st.focused.border || u.shadow !== st.focused.shadow : false);
      st.how = st.ringOrOutline ? "outline or ring" : u && u.border !== st.focused.border ? `border ${u.border} → ${st.focused.border}` : null;
    }
    const kinds = [...new Set(stops.map((s) => `${s.tag}${s.type ? ":" + s.type : ""} → ${s.how || "none"}`))];
    drill.note(`B2: focus indicators seen: ${JSON.stringify(kinds)}`);
    const invisible = stops.filter((s) => !s.visible && s.tag !== "BODY");
    // Inside a date field Tab walks its day, month, year and time parts; Chrome
    // highlights the part in use, but the field's own ring isn't drawn then.
    const datePartStops = invisible.filter((s) => s.type === "datetime-local");
    const otherInvisible = invisible.filter((s) => s.type !== "datetime-local");
    drill.check(otherInvisible.length === 0, `B2: focus is visible at every stop outside the date fields (${stops.length} stops)`, otherInvisible.slice(0, 10));
    if (datePartStops.length) drill.note(`B2: ${datePartStops.length} stop(s) inside the Starts/Ends date fields have no ring on the field (Chrome's own part highlight only); see B2-date-part-focus.png`);
    // Back to Start offer (reading the unfocused styles moved focus), then Enter.
    await page.getByRole("button", { name: "Start offer", exact: true }).focus();
    await page.keyboard.press("Enter");
    const t = await waitToast(page, /./);
    drill.note(`B2: start toast ${JSON.stringify(t)}`);
    drill.check(t.length > 0 && !(await page.locator("#offer-buy").count()), "B2: Enter on Start offer starts it (back on the list with a toast)", t);
    await drill.shoot(page, "B2-started");
    // turn it off again so later drills aren't affected
    await sql("tenant", "UPDATE offers SET enabled=0 WHERE label LIKE 'Buy 2 of Night Repair Cream%'");
    await ctx.close();
  },

  async slow(drill) {
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await openOffers(drill, page);
    await page.getByRole("button", { name: "New offer" }).first().click();
    await page.getByRole("button", { name: /Buy some, get some free/ }).click();
    await page.getByRole("button", { name: /^One product/ }).click().catch(() => {});
    await page.getByRole("button", { name: "Choose a product", exact: true }).click();
    const dlg = page.locator("dialog[open]").last();
    await dlg.getByRole("button", { name: /Rose Hydration Mist/ }).first().click({ timeout: 30_000 });
      await page.waitForTimeout(2000);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    // Chrome DevTools' "Slow 3G": 2 s latency, ~50 KB/s down and up
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 });
    const sims = [];
    page.on("request", (r) => r.url().includes("/api/admin/offers") && sims.push({ at: Date.now(), m: r.method(), u: new URL(r.url()).pathname + new URL(r.url()).search.slice(0, 40) }));
    await page.locator("#offer-free").fill("2");
    const t0 = Date.now();
    const samples = [];
    for (let i = 0; i < 80; i++) {
      const ex = await page.evaluate(() => {
        const t = document.body.innerText;
        return { checking: t.includes("Checking on your store’s products") || t.includes("Checking on your store's products"), get2: /get 2 free/.test(t), failed: t.includes("The example couldn't load") };
      });
      samples.push({ t: Date.now() - t0, ...ex });
      if (!ex.checking && ex.get2 && i > 2) break;
      await sleep(100);
    }
    const firstChecking = samples.find((s) => s.checking);
    const lastChecking = [...samples].reverse().find((s) => s.checking);
    const arrived = samples.find((s) => !s.checking && s.get2 && s.t > (lastChecking?.t ?? 0));
    drill.check(Boolean(firstChecking) && firstChecking.t < 600, "B3 (Slow 3G): \"Checking on your store's products…\" shows right after the change", firstChecking);
    drill.check(Boolean(arrived) && arrived.t >= (lastChecking?.t ?? 0), "B3: it stays until the new example arrives", { lastChecking, arrived, samples: samples.length });
    drill.note(`B3: example requests under Slow 3G: ${JSON.stringify(sims.map((s) => ({ ...s, at: s.at - t0 })))}`);
    await drill.shoot(page, "B3-slow-example-arrived");
    // offline
    await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.locator("#offer-buy").fill("3");
    const failed = await seen(page, "The example couldn't load", 20_000);
    drill.check(failed, `B3 (offline): the example area says "The example couldn't load. Check your connection and try again."`);
    await drill.shoot(page, "B3-offline-example");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForTimeout(1500);
    const startBtn = page.getByRole("button", { name: "Start offer", exact: true });
    drill.note(`B3: back online, Start offer enabled: ${await startBtn.isEnabled()}`);
    await startBtn.click();
    const t = await waitToast(page, /./);
    drill.check(t.length > 0 && !(await page.locator("#offer-buy").count()), "B3: back online, Start offer works", t);
    await sql("tenant", "UPDATE offers SET enabled=0 WHERE label LIKE '%Rose Hydration Mist%'");
    await ctx.close();
  },

  async big(drill) {
    // 2,000 products with 50 tags in the local harness database (re-seed afterwards).
    const n = await rows("tenant", "SELECT count(*) n FROM products WHERE id LIKE 'gid://p/drill-%'");
    if (Number(n[0].n) < 2000) {
      const stmts = [];
      for (let i = 0; i < 2000; i += 100) {
        const vals = [];
        for (let j = i; j < i + 100; j++) {
          const tags = JSON.stringify([`drilltag-${String(j % 50).padStart(2, "0")}`, `drilltag-${String((j * 7) % 50).padStart(2, "0")}`]);
          vals.push(`('gid://p/drill-${j}','drill-product-${j}','Drill product ${j}',1,${100 + (j % 900)},'Drill type ${j % 10}','${tags}')`);
        }
        stmts.push(`INSERT OR IGNORE INTO products (id, handle, title, available, price_min, product_type, tags) VALUES ${vals.join(",")}`);
      }
      try {
        await sql("tenant", stmts);
      } catch (e) {
        drill.note(`B4 setup: insert failed: ${e.message}`);
        throw e;
      }
    }
    const after = await rows("tenant", "SELECT count(*) n FROM products");
    drill.check(Number(after[0].n) >= 2008, "B4 setup: the store has 2,000 more products with 50 tags", after[0].n);
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await openOffers(drill, page);
    await page.getByRole("button", { name: "New offer" }).first().click();
    await page.getByRole("button", { name: /Buy more, save more/ }).click();
    await page.getByRole("button", { name: /^Products with a tag/ }).click();
    const t0 = Date.now();
    await page.getByRole("button", { name: "Choose a tag", exact: true }).click();
    const dlg = page.locator("dialog[open]").last();
    await dlg.getByText(/drilltag-/).first().waitFor({ timeout: 30_000 });
    const opened = Date.now() - t0;
    drill.check(opened <= 1500, "B4: 'Choose a tag' lists the tags within about a second", `${opened} ms`);
    const count = await dlg.locator("li, button").filter({ hasText: /drilltag-/ }).count();
    drill.note(`B4: the tag list shows ${count} drill tags`);
    await drill.shoot(page, "B4-tag-list");
    const t1 = Date.now();
    await dlg.getByRole("searchbox").first().fill("drilltag-42").catch(async () => dlg.getByLabel("Search").fill("drilltag-42"));
    await page.waitForTimeout(400);
    const shown = await dlg.evaluate((d) => [...d.querySelectorAll("li, button")].map((x) => x.innerText.trim()).filter((t) => /drilltag-/.test(t)));
    drill.check(shown.length >= 1 && shown.every((t) => t.includes("drilltag-42")), "B4: searching narrows the list to the tag", { ms: Date.now() - t1, shown: shown.slice(0, 5) });
    await drill.shoot(page, "B4-tag-search");
    await ctx.close();
  },
};
