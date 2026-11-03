// P1-DRILLS-C · FIX-C drills still needed (docs/cms-reviews/P1-FIX-C.md, 1 to 5).
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs fixc-c [part]
// Parts
//   c-brand-preview  Save brand with a new accent, open the Designer at once:
//                    the preview frame's buttons use the new accent on its first load
//   c-theme          Theme → apply another kit, open Publishing at once: Publish now
//                    enabled, "Theme" in the change list, Publish now answers 200
//   c-identity       Settings → Store name → Save settings, reload Settings and open
//                    the Designer: the new name in the field and the console sidebar
//   c-rates          save new shipping rates, then within 30 s add to cart and go
//                    through COD checkout to the review step: the drawer's shipping
//                    and the review's shipping and total agree (numbers recorded).
//                    P1-RATES: then Place order. The order is stored at the amount
//                    on the button pressed; a press the server prices differently
//                    is refused with the new total, the page redraws, and the
//                    second press goes through at the redrawn amount
//   c-oldversions    cms_pages as a view without `revision` (a store from before
//                    page versions, tenant migration 0006): the Pages list and the
//                    page editor open with no error screen
// Every database change is made in this checkout's local harness only (db.mjs)
// and undone at the end of the part.
import { rows, sql } from "../p1/db.mjs";
import { text, seen, settle, sleep } from "../p1/util.mjs";
import { noThanks, clearCart, SHOPPER } from "../p1/sf.mjs";

export const id = "FIX-C";
export const title = "P1-DRILLS-C: FIX-C drills still needed";

const W = 1280;

async function signedIn(drill) {
  const ctx = await drill.context({ width: W });
  const page = await drill.signIn(ctx);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return { ctx, page };
}
async function toasts(page) {
  return page.evaluate(() => [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim())).filter(Boolean));
}
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
const changeList = (t) => {
  const i = t.indexOf("What will publish");
  return i < 0 ? "" : t.slice(i, i + 700);
};

export const parts = {
  async "c-brand-preview"(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/brand", { width: 1440 });
    const was = (await page.locator("#brand-accent").inputValue()).toLowerCase();
    const accent = was === "#7c3aed" ? "#be123c" : "#7c3aed";
    await page.locator("#brand-accent").fill(accent);
    const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/brand" && r.request().method() === "PUT" && r.request().postData()?.includes('"brand"'), { timeout: 30_000 });
    await page.getByRole("button", { name: "Save brand", exact: true }).click();
    const pr = await put;
    const savedAt = Date.now();
    drill.check(pr.status() === 200, "Save brand answers 200", pr.status());
    drill.note(`accent ${was} → ${accent}`);
    // at once
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    const connected = await seen(page, "Preview shows your last save", 60_000);
    drill.check(connected, "the Designer's preview connects");
    const fr = page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).pathname === "/");
    const facts = fr
      ? await fr.evaluate(() => {
          const s = getComputedStyle(document.documentElement);
          const btns = [...document.querySelectorAll("a, button")].filter((b) => /bg-accent|bg-sf-accent|btn-accent/.test(b.className || "")).slice(0, 4);
          const ladder = {};
          for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) ladder[n] = s.getPropertyValue(`--accent-${n}`).trim();
          return {
            ladder,
            accent500: s.getPropertyValue("--accent-500").trim(),
            accent600: s.getPropertyValue("--accent-600").trim(),
            buttons: btns.map((b) => ({ text: b.innerText.trim().slice(0, 30), bg: getComputedStyle(b).backgroundColor, cls: String(b.className).slice(0, 80) })),
            draftBar: document.body.innerText.includes("Draft preview"),
          };
        })
      : null;
    drill.note(`frame ${Date.now() - savedAt} ms after Save: ${JSON.stringify(facts)}`);
    const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    drill.check(facts?.accent500?.toLowerCase() === accent, "the preview frame's --accent-500 is the new accent on its first load", facts?.accent500);
    // the button paints the accent role, which is a step of the new accent's
    // ladder (the hero's button uses a lighter step on a dark hero), never the old one
    const ladderRgb = Object.entries(facts?.ladder || {}).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v)).map(([k, v]) => [k, hexToRgb(v.toLowerCase())]);
    const btn = (facts?.buttons || [])[0];
    const step = btn ? ladderRgb.find(([, rgb]) => rgb === btn.bg)?.[0] : null;
    drill.note(`the frame's accent button "${btn?.text}" is ${btn?.bg}, the new accent's ${step ?? "(no)"} step`);
    drill.check(Boolean(step), "the frame's accent button is painted from the new accent's ladder (not the old accent)", { button: btn, ladder: facts?.ladder });
    await drill.shoot(page, "c-brand-preview-designer");
    // a shopper still sees the published accent
    const sctx = await drill.context({ width: 1440 });
    const sp = await sctx.newPage();
    await drill.open(sp, "/", { width: 1440 });
    const live = await sp.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent-500").trim());
    drill.note(`a signed-out shopper's --accent-500: ${live}`);
    drill.check(live.toLowerCase() !== accent, "a signed-out shopper still sees the published accent (not the draft)", live);
    await sctx.close();
    // put the accent back
    await drill.open(page, "/admin/brand", { width: 1440 });
    await page.locator("#brand-accent").fill(was);
    const back = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/brand" && r.request().method() === "PUT" && r.request().postData()?.includes('"brand"'), { timeout: 30_000 });
    await page.getByRole("button", { name: "Save brand", exact: true }).click();
    drill.note(`accent put back to ${was}: ${(await back).status()}`);
    await ctx.close();
  },

  async "c-theme"(drill) {
    const { ctx, page } = await signedIn(drill);
    // start from nothing to publish
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const base = await publishNow(page);
    drill.note(`baseline publish: ${JSON.stringify({ status: base.status, toasts: base.toasts })}`);
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    drill.check(!(await page.getByRole("button", { name: "Publish now", exact: true }).first().isEnabled()), "before the kit change, Publishing has nothing to publish");

    await drill.open(page, "/admin/theme", { width: W });
    const applyBtns = await page.getByRole("button", { name: /^Apply / }).filter({ hasNotText: "Applied" }).all();
    const enabled = [];
    for (const b of applyBtns) if (await b.isEnabled()) enabled.push(b);
    drill.check(enabled.length > 0, "Theme lists another kit to apply", applyBtns.length);
    const label = (await enabled[0].innerText()).trim();
    await enabled[0].click();
    const dlg = page.locator("dialog[open]");
    await dlg.waitFor({ timeout: 10_000 });
    const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/theme" && r.request().method() === "POST", { timeout: 30_000 });
    await dlg.getByRole("button", { name: label }).click();
    const ar = await posted;
    drill.check(ar.status() === 200, `${label}: the apply answers 200`, ar.status());
    drill.note(`applied: ${label}`);
    // at once
    await drill.open(page, "/admin/releases", { width: W });
    await seen(page, "What will publish", 30_000);
    const on = await page.getByRole("button", { name: "Publish now", exact: true }).first().isEnabled();
    const list = changeList(await text(page));
    drill.check(on, "right after the kit change, Publish now is enabled");
    drill.check(/Theme/.test(list), '"Theme" is in the change list', list.slice(0, 300));
    await drill.shoot(page, "c-theme-publishing-at-once");
    const pub = await publishNow(page);
    drill.check(pub.status === 200, "Publish now answers 200 (not 409)", pub.status);
    drill.check((pub.toasts || []).some((x) => /Published/.test(x)), "the toast says it is live", pub.toasts);
    const [live] = await rows("tenant", "SELECT json_extract(r.content, '$.theme.kit') k FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
    drill.note(`the live release's kit: ${live?.k}`);
    await drill.shoot(page, "c-theme-published");
    await ctx.close();
  },

  async "c-identity"(drill) {
    const { ctx, page } = await signedIn(drill);
    await drill.open(page, "/admin/settings", { width: W });
    const was = await page.locator("#sa-name").inputValue();
    const NAME = `Design Demo Drill ${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
    await page.locator("#sa-name").fill(NAME);
    const put = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    const pr = await put;
    drill.check(pr.status() === 200, "Save settings answers 200", pr.status());
    await page.reload();
    await settle(page);
    const field = await page.locator("#sa-name").inputValue();
    const sidebar = await page.evaluate(() => [...document.querySelectorAll("aside p, nav p")].map((p) => p.innerText.trim()).filter(Boolean).slice(0, 6));
    drill.check(field === NAME, "the first reload shows the new name in the Store name field", field);
    drill.check(sidebar.includes(NAME) || (await text(page)).split("\n").slice(0, 15).some((l) => l.trim() === NAME), "the first reload shows the new name in the console sidebar", sidebar);
    await drill.shoot(page, "c-identity-settings-reload");
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    await seen(page, "Preview shows your last save", 60_000);
    const dt = await text(page);
    const inChrome = dt.split("\n").slice(0, 25).some((l) => l.trim() === NAME);
    drill.check(inChrome, "the Designer's console chrome shows the new name", dt.split("\n").slice(0, 10));
    await drill.shoot(page, "c-identity-designer");
    // put it back
    await drill.open(page, "/admin/settings", { width: W });
    await page.locator("#sa-name").fill(was);
    const back = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    drill.note(`name put back to "${was}": ${(await back).status()}`);
    await ctx.close();
  },

  async "c-rates"(drill) {
    const money = (s) => (s == null ? null : Number(String(s).replace(/[^\d.]/g, "")));
    const { ctx, page } = await signedIn(drill);
    // the shopper first warms every cache with the current rates
    const sctx = await drill.context({ width: 1440 });
    const sp = await sctx.newPage();
    const drawerNums = async () =>
      sp.evaluate(() => {
        const d = document.querySelector('[role="dialog"][aria-label="Shopping cart"]');
        const rowVal = (label) => {
          const r = [...(d?.querySelectorAll("div") || [])].find((x) => x.children.length === 2 && x.children[0].innerText.trim() === label);
          return r ? r.children[1].innerText.trim() : null;
        };
        return { subtotal: rowVal("Subtotal"), shipping: rowVal("Shipping"), total: rowVal("Total"), nudge: d?.innerText.match(/Add ₹[\d,]+ more for free shipping/)?.[0] ?? null };
      });
    const openDrawer = async () => {
      await drill.open(sp, "/products/glow-serum", { width: 1440 });
      await noThanks(sp);
      await sp.getByRole("button", { name: /Open cart/ }).first().click();
      await sp.waitForTimeout(900);
      return drawerNums();
    };
    const review = async () => {
      await drill.open(sp, "/checkout", { width: 1440 });
      await noThanks(sp);
      for (const [k, v] of Object.entries(SHOPPER)) if (v) await sp.locator(`input[name="${k}"]`).fill(v);
      await sp.getByRole("button", { name: "Continue to review" }).click();
      await sp.getByRole("heading", { name: "Review your order" }).waitFor({ timeout: 15_000 });
      await sp.waitForTimeout(600);
      return sp.evaluate(() => {
        const t = document.querySelector("main")?.innerText || "";
        const grab = (re) => t.match(re)?.[1] ?? null;
        return { shipping: grab(/Shipping[^\n₹]*\n?\s*(FREE|₹[\d,]+)/), total: grab(/\bTotal\s*\n?\s*(₹[\d,]+)/), text: t.slice(0, 900) };
      });
    };
    const clearAndAdd = async () => {
      await drill.open(sp, "/products/glow-serum", { width: 1440 });
      await noThanks(sp);
      await clearCart(sp);
      await drill.open(sp, "/products/glow-serum", { width: 1440 });
      const posted = sp.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
      await sp.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
      await posted;
      await sp.waitForTimeout(900);
    };
    await clearAndAdd();
    const warmDrawer = await drawerNums();
    const warmReview = await review();
    drill.note(`before the change: drawer ${JSON.stringify(warmDrawer)}; review ${JSON.stringify({ shipping: warmReview.shipping, total: warmReview.total })}`);

    // the founder saves new rates
    await drill.open(page, "/admin/settings", { width: W });
    const before = { flat: await page.locator("#sa-flat-rate").inputValue(), free: await page.locator("#sa-free-over").inputValue(), cod: await page.locator("#sa-cod-fee").inputValue() };
    const NEW = { flat: before.flat === "149" ? "129" : "149", free: "4999", cod: "59" };
    // P1-RATES: the shopper's caches must hold the rates being changed from, or
    // the drill tests nothing. A run started within 30 s of an earlier run's
    // put-back still has that run's rates cached: wait it out and warm again.
    {
      const SUB0 = 1299;
      const cod0 = (SUB0 >= Number(before.free) ? 0 : Number(before.flat)) + Number(before.cod);
      const shipOf = (s) => (s === "FREE" ? 0 : Number(String(s ?? "").replace(/[^\d.]/g, "")));
      let warm = warmReview;
      if (shipOf(warm.shipping) !== cod0) {
        drill.note(`the warm review shows ${warm.shipping}, not the current rates' ₹${cod0}: waiting 32 s for the caches to expire`);
        await sleep(32_000);
        await clearAndAdd();
        await drawerNums();
        warm = await review();
        drill.note(`warmed again: review ${JSON.stringify({ shipping: warm.shipping, total: warm.total })}`);
      }
      drill.check(shipOf(warm.shipping) === cod0, "setup: the shopper's checkout holds the rates being changed from", { review: warm.shipping, expected: cod0 });
      await drill.open(page, "/admin/settings", { width: W });
    }
    await page.locator("#sa-flat-rate").fill(NEW.flat);
    await page.locator("#sa-free-over").fill(NEW.free);
    await page.locator("#sa-cod-fee").fill(NEW.cod);
    const put = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    const pr = await put;
    const savedAt = Date.now();
    drill.check(pr.status() === 200, "Save settings answers 200", pr.status());
    drill.note(`rates ${JSON.stringify(before)} → ${JSON.stringify(NEW)}`);

    // Which rates a number came from, on this ₹1,299 cart (prepaid in the
    // drawer; the checkout's review starts on COD, so its shipping line
    // includes the COD fee).
    const SUB = 1299;
    const rate = (cfg, cod) => (SUB >= Number(cfg.free) ? 0 : Number(cfg.flat)) + (cod ? Number(cfg.cod) : 0);
    const which = (n, cod) => (n === rate(NEW, cod) ? "new" : n === rate(before, cod) ? "old" : `neither (${n})`);
    const num = (s) => (s === "FREE" ? 0 : money(s));
    const payStep = async () => {
      await sp.getByRole("button", { name: "Continue to payment" }).click();
      await sp.getByRole("heading", { name: "Payment" }).waitFor({ timeout: 15_000 });
      await sp.locator('input[name="method"]').first().check(); // the first is Cash on Delivery
      await sp.waitForTimeout(500);
      return sp.evaluate(() => (document.querySelector("main")?.innerText || "").match(/Place order · (₹[\d,]+)/)?.[1] ?? null);
    };
    const sample = async (label) => {
      const dr = await openDrawer();
      const tDrawer = Date.now() - savedAt;
      const rv = await review();
      const tReview = Date.now() - savedAt;
      const pay = await payStep();
      const tPay = Date.now() - savedAt;
      const s = {
        drawer: { at: tDrawer, shipping: dr.shipping, total: dr.total, rates: which(num(dr.shipping), false) },
        review: { at: tReview, shipping: rv.shipping, total: rv.total, rates: which(num(rv.shipping), true) },
        payment: { at: tPay, placeOrder: pay, rates: which(money(pay) - SUB, true) },
      };
      drill.note(`${label}: ${JSON.stringify(s)}`);
      return s;
    };

    // within 30 s: the drawer, the review step, the payment step, and the order
    const s1 = await sample("within 30 s");
    await drill.shoot(sp, "c-rates-payment-within-30s");
    drill.check(s1.payment.at < 30_000, "the drawer, review and payment steps were read within 30 s of the save", { drawer: s1.drawer.at, review: s1.review.at, payment: s1.payment.at });
    drill.check(s1.drawer.rates === s1.review.rates, "the drawer's shipping and the review step's shipping come from the same rates", { drawer: s1.drawer, review: s1.review });
    drill.check(s1.review.rates === s1.payment.rates, "the review step's shipping and total and the payment step's total come from the same rates", { review: s1.review, payment: s1.payment });
    // P1-RATES: whatever the page shows, the server charges that amount or
    // refuses, says the new total and redraws the page; then the shopper presses
    // the redrawn button. Every stored order must equal the button pressed.
    const orderCount = async () => Number((await rows("tenant", "SELECT COUNT(*) AS n FROM orders"))[0]?.n ?? 0);
    const press = async () => {
      const shown = await sp.evaluate(() => (document.querySelector("main")?.innerText || "").match(/Place order · (₹[\d,]+)/)?.[1] ?? null);
      const before = await orderCount();
      const placed = sp.waitForResponse((r) => new URL(r.url()).pathname === "/api/checkout" && r.request().method() === "POST", { timeout: 60_000 });
      await sp.getByRole("button", { name: /^Place order/ }).click();
      const res = await placed;
      const body = await res.json().catch(() => ({}));
      return { shown, status: res.status(), body, at: Date.now() - savedAt, newOrders: (await orderCount()) - before };
    };
    const p1 = await press();
    drill.note(`first press at ${p1.at} ms on "Place order · ${p1.shown}": ${p1.status} ${JSON.stringify({ code: p1.body.code, error: p1.body.error, total: p1.body.total, orderId: p1.body.orderId })}`);
    let final = p1;
    if (p1.status === 409 && p1.body.code === "PRICE_CHANGED") {
      drill.check(p1.newOrders === 0, "a refused press stores no order", { newOrders: p1.newOrders });
      await sp.locator("main").getByRole("alert").filter({ hasText: "your new total is" }).waitFor({ timeout: 10_000 });
      await sp.waitForTimeout(400);
      const after = await sp.evaluate(() => {
        const t = document.querySelector("main")?.innerText || "";
        // the order summary only: the alert also says "Shipping changed … ₹1,507"
        const summary = document.querySelector("main aside")?.innerText || "";
        return {
          alert: document.querySelector('main [role="alert"]')?.innerText.trim() ?? null,
          button: t.match(/Place order · (₹[\d,]+)/)?.[1] ?? null,
          shipping: summary.match(/Shipping[^\n₹]*\n?\s*(FREE|₹[\d,]+)/)?.[1] ?? null,
          total: summary.match(/\bTotal\s*\n?\s*(₹[\d,]+)/)?.[1] ?? null,
        };
      });
      drill.note(`after the refusal: ${JSON.stringify(after)}`);
      await drill.shoot(sp, "c-rates-refused-within-30s");
      const newAmount = `₹${Number(p1.body.total).toLocaleString("en-IN")}`;
      drill.check(after.alert === `Shipping changed — your new total is ${newAmount}. Review and place order.`, "the shopper is told shipping changed and the new total", after.alert);
      drill.check(after.button === newAmount && money(after.total) === Number(p1.body.total) && which(num(after.shipping), true) === which(Number(p1.body.shippingTotal), true), "the button, the summary's shipping and its total are redrawn to the new amount", { after, server: { total: p1.body.total, shipping: p1.body.shippingTotal } });
      final = await press();
      drill.note(`second press at ${final.at} ms on "Place order · ${final.shown}": ${final.status} ${JSON.stringify({ orderId: final.body.orderId, code: final.body.code })}`);
    }
    // The page navigates away on success, which can take the response body
    // with it, so the confirmation page is the proof the order went through.
    const confirmed = await sp.waitForURL(/\/checkout\/confirmation\//, { timeout: 60_000 }).then(() => true, () => false);
    await settle(sp);
    drill.check(final.status === 200 && confirmed, "the order goes through on the press after any refusal", { status: final.status, confirmed, error: final.body.error ?? null });
    const orderId = final.body.orderId || decodeURIComponent(new URL(sp.url()).pathname.split("/").pop());
    const [ord] = await rows("tenant", "SELECT id, subtotal, shipping_total, total, payment_method FROM orders WHERE id = ?", [orderId]);
    drill.note(`order stored: ${JSON.stringify(ord || final.body)}; the button pressed said "Place order · ${final.shown}"`);
    drill.check(ord && Number(ord.total) === money(final.shown), "the order's stored total is the amount on the button that was pressed", { stored: ord?.total, pressed: final.shown, storedRates: ord ? which(Number(ord.shipping_total), true) : null });
    await drill.shoot(sp, "c-rates-confirmation-within-30s");
    // after the 30 s window, everything shows the new rates
    await clearAndAdd();
    while (Date.now() - savedAt < 35_000) await sleep(1000);
    const s2 = await sample("after 35 s");
    drill.check(s2.drawer.rates === "new" && s2.review.rates === "new" && s2.payment.rates === "new", "after 35 s the drawer, review and payment all use the new rates", s2);
    await drill.shoot(sp, "c-rates-payment-after-35s");
    await sctx.close();
    // put the rates back
    await drill.open(page, "/admin/settings", { width: W });
    await page.locator("#sa-flat-rate").fill(before.flat);
    await page.locator("#sa-free-over").fill(before.free);
    await page.locator("#sa-cod-fee").fill(before.cod);
    const back = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/admin/settings") && r.request().method() !== "GET", { timeout: 30_000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    drill.note(`rates put back: ${(await back).status()}`);
    await ctx.close();
  },

  async "c-oldversions"(drill) {
    const cols = (await rows("tenant", "PRAGMA table_info(cms_pages)")).map((r) => r.name);
    drill.check(cols.includes("revision"), "setup: cms_pages has a revision column to take away", cols);
    const keep = cols.filter((n) => n !== "revision");
    await sql("tenant", ["ALTER TABLE cms_pages RENAME TO cms_pages_data", `CREATE VIEW cms_pages AS SELECT ${keep.join(", ")} FROM cms_pages_data`]);
    const { ctx, page } = await signedIn(drill);
    try {
      const after = (await rows("tenant", "PRAGMA table_info(cms_pages)")).map((r) => r.name);
      drill.check(!after.includes("revision"), "setup: cms_pages is now a view without revision", after);
      const r1 = await drill.open(page, "/admin/storefront/pages", { width: W });
      const list = await text(page);
      drill.check(r1.status === 200 && !list.includes("This page hit an error") && /Shipping/i.test(list), "the Pages list opens and lists the pages", { status: r1.status, text: list.slice(0, 200) });
      await drill.shoot(page, "c-oldversions-pages-list");
      const r2 = await drill.open(page, "/admin/storefront/pages/shipping", { width: W });
      const ed = await text(page);
      drill.check(r2.status === 200 && !ed.includes("This page hit an error") && ed.includes("Shipping policy"), "the page editor opens the page", { status: r2.status, text: ed.slice(0, 200) });
      drill.check(!/404|not found/i.test(ed.slice(0, 300)), "not a 404", ed.slice(0, 120));
      await drill.shoot(page, "c-oldversions-page-editor");
    } finally {
      await sql("tenant", ["DROP VIEW cms_pages", "ALTER TABLE cms_pages_data RENAME TO cms_pages"]);
    }
    await ctx.close();
  },
};
