// P1-DRILLS · P1-HARNESS "Browser drills still needed" 1, 3 and 4
// (2, 5 and 6 are runs of pnpm drill:edge; see docs/cms-reviews/P1-DRILLS.md).
//   designer   S57/S59 Designer flows on the edge runtime: edit, save, preview, publish, live
//   dark       the maintenance message on a dark brand (finding 3)
//   checkout   checkout at 360, 375, 390 and 414 (finding 6)
import { text, seen, settle, sleep } from "./util.mjs";
import { addToCart, noThanks, clearCart } from "./sf.mjs";
import { rows } from "./db.mjs";

export const id = "harness";
export const title = "P1-DRILLS P1-HARNESS follow-ups";

const CLOSED_MESSAGE = "Closed for a dark-brand check. Back in a minute.";

function textContrast(page, needle) {
  return page.evaluate((n) => {
    const el = [...document.querySelectorAll("body *")].find((e) => e.children.length === 0 && e.textContent.trim() === n);
    if (!el) return null;
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    const rgb = (s) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    let bgEl = el;
    let bg = null;
    while (bgEl) {
      const c = rgb(getComputedStyle(bgEl).backgroundColor);
      if (c[3] > 0.95) {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    bg ||= [255, 255, 255];
    const fg = rgb(getComputedStyle(el).color);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const a = fg[3];
    const blended = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    const [l1, l2] = [lum(blended), lum(bg)].sort((x, y) => y - x);
    return { color: getComputedStyle(el).color, background: `rgb(${bg.slice(0, 3).join(", ")})`, bgFrom: bgEl?.tagName, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100 };
  }, needle);
}

const previewFrame = (page, pathRe = /^\/$/) => page.frames().find((fr) => fr !== page.mainFrame() && pathRe.test(new URL(fr.url()).pathname));

async function frameText(page) {
  const fr = previewFrame(page);
  return fr ? fr.evaluate(() => document.body?.innerText || "").catch(() => "") : "";
}

async function waitFrame(page, needle, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await frameText(page)).includes(needle)) return Date.now() - t0;
    await sleep(200);
  }
  return null;
}

async function designerFlow(drill, prefix, { known } = {}) {
  const k = known ? { known } : {};
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, ".");
  const TITLE = `Drill hero ${stamp}`;
  const SUB = `Edited in the Designer on the edge runtime at ${stamp}.`;
  const BTN = `Shop drill ${stamp.slice(3)}`;
  const ctx = await drill.context({ width: 1440 });
  const page = await drill.signIn(ctx);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const docs = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "document" && r.frame() !== page.mainFrame()) docs.push({ url: new URL(r.url()).pathname, status: r.status(), edge: r.headers()["x-edge-runtime"] ?? null });
  });
  await drill.open(page, "/admin/storefront/designer", { width: 1440 });
  drill.check(await seen(page, "Preview shows your last save", 60_000), prefix + ': the preview connects ("Preview shows your last save")');
  await page.getByRole("button", { name: "Hero", exact: true }).first().click();
  await page.locator("#ins-hero-title").fill(TITLE);
  await page.locator("#ins-hero-subtitle").fill(SUB);
  await page.locator("#ins-hero-p-label").fill(BTN);
  const tb = await waitFrame(page, BTN, 15_000);
  drill.check(tb != null, prefix + ": the typed button label shows in the preview before saving", tb != null ? tb + " ms" : "not within 15 s");
  const tt = await waitFrame(page, TITLE, 4_000);
  const ts = await waitFrame(page, SUB, 1_000);
  drill.check(tt != null && ts != null, prefix + ": the typed title and subtitle show in the preview before saving", { title: tt, subtitle: ts, hero: (await frameText(page)).split("\n").filter((l) => /Visibly|Drill hero|Edited in/.test(l)) }, k);
  await drill.shoot(page, prefix + "-designer-typed");
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  const sres = await saved;
  drill.check(sres.status() === 200, prefix + ": Save answers 200", sres.status());
  await page.waitForTimeout(2500);
  await seen(page, "Preview shows your last save", 20_000);
  const after = await frameText(page);
  drill.check(after.includes(BTN), prefix + ": after Save the preview shows the saved button label", after.slice(0, 160));
  drill.check(after.includes(TITLE) && after.includes(SUB), prefix + ": after Save the preview shows the saved title and subtitle", after.split("\n").filter((l) => /Visibly|Drill hero|Edited in|money back/.test(l)), k);
  await drill.shoot(page, prefix + "-designer-saved");

  await drill.open(page, "/admin/releases", { width: 1440 });
  await seen(page, "What will publish", 30_000);
  await page.getByRole("button", { name: "Publish now", exact: true }).first().click();
  await page.waitForTimeout(500);
  const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/releases" && r.request().method() === "POST", { timeout: 30_000 });
  await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
  const pres = await posted;
  const pbody = await pres.json().catch(() => ({}));
  drill.check(pres.status() === 200 && pbody.ok, prefix + ": Publish now answers 200 ok", { status: pres.status(), code: pbody.code });
  await drill.shoot(page, prefix + "-published");

  // Signed out, in fresh contexts (each one a new visitor): the live store.
  const t0 = Date.now();
  let res;
  let t = "";
  const visitors = [];
  for (let i = 0; i < 45; i++) {
    const anon = await drill.context({ width: 1440 });
    const ap = await anon.newPage();
    res = await drill.open(ap, "/", { width: 1440 });
    t = await text(ap);
    if (t.includes(BTN)) {
      const h1 = await ap.evaluate(() => (document.querySelector('[data-sec="hero"] h1') || document.querySelector("h1"))?.innerText.replace(/\s+/g, " ").trim());
      visitors.push({ h1, sub: t.includes(SUB) });
      await noThanks(ap);
      if (visitors.length === 1) await drill.shoot(ap, prefix + "-live-signed-out");
      await anon.close();
      if (visitors.length >= 4) break;
      continue;
    }
    await anon.close();
    await sleep(1000);
  }
  drill.check(visitors.length > 0, prefix + ": a signed-out visitor sees the new button label on /", "after " + Math.round((Date.now() - t0) / 1000) + " s");
  drill.check(res.status === 200 && res.headers["x-edge-runtime"] === "1", prefix + ": the live page is 200 on the edge runtime", { status: res.status, edge: res.headers["x-edge-runtime"] });
  drill.note(prefix + ": signed-out visitors' hero titles (each a new visitor): " + JSON.stringify(visitors));
  drill.check(visitors.length > 0 && visitors.every((v) => v.h1 === TITLE && v.sub), prefix + ": every signed-out visitor sees the new title and subtitle", visitors, k);
  drill.note(prefix + ": preview documents seen: " + JSON.stringify(docs));
  drill.check(docs.length > 0 && docs.every((d) => d.status === 200 && d.edge === "1"), prefix + ": every preview document answered 200 with x-edge-runtime: 1", docs.length + " documents");
  await ctx.close();
}

export const parts = {
  // S57/S59 with the seeded hero-promise experiment still running: its variant b
  // replaces the hero's title, highlight and subtitle for some visitors, the
  // Designer preview included (finding 1). The button label is never replaced,
  // so it tells the founder's words apart; title and subtitle are recorded as
  // known (finding 1).
  async designer(drill) {
    await designerFlow(drill, "S57", { known: "finding 1" });
  },

  // The same flow after completing the hero experiment in the console.
  async "designer-noexp"(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/experiments", { width: 1440 });
    const done = await rows("tenant", "SELECT status FROM experiments WHERE slug='hero-promise' OR id IN (SELECT id FROM experiments WHERE status='running')").catch(() => []);
    if (done.some((r) => r.status === "running")) {
      await page.getByRole("button", { name: "Complete", exact: true }).first().click();
      await page.waitForTimeout(400);
      await page.locator("dialog[open]").getByRole("button", { name: "Complete", exact: true }).click();
      await page.waitForTimeout(1500);
    }
    const st = await rows("tenant", "SELECT id, status FROM experiments");
    drill.check(!st.some((r) => r.status === "running"), "setup: no hero experiment running (completed in the console)", st);
    await ctx.close();
    await designerFlow(drill, "S57-noexp", {});
  },

  async dark(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    // The console's tenant settings are cached for up to 30 s, so the Brand
    // screen can show a stale value right after a save. Read the saved brand
    // from the local control-plane database, and save through the same API the
    // Brand screen's "Save brand" button calls.
    const saved = JSON.parse((await rows("platform", "SELECT json_extract(config,'$.brand') b FROM tenants WHERE id='design'"))[0].b || "{}");
    const orig = { bg: saved.background, fg: saved.foreground };
    drill.note("dark: the brand before: " + JSON.stringify(saved));
    // A brand save is a draft ("publish from Publishing to take it live"), so
    // each change is published through Publishing → Publish now.
    const publish = async () => {
      await drill.open(page, "/admin/releases", { width: 1440 });
      await seen(page, "What will publish", 30_000);
      const btn = page.getByRole("button", { name: "Publish now", exact: true }).first();
      if (!(await btn.isEnabled())) return "nothing to publish";
      await btn.click();
      await page.waitForTimeout(400);
      const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/releases" && r.request().method() === "POST", { timeout: 30_000 });
      await page.locator("dialog[open]").getByRole("button", { name: "Publish now" }).click();
      const r = await posted;
      const body = await r.json().catch(() => ({}));
      await page.waitForTimeout(800);
      const dlg = await page.evaluate(() => document.querySelector("dialog[open]")?.innerText.replace(/\s+/g, " ").trim() || null);
      if (r.status() !== 200) {
        drill.note(`dark: Publish now right after the brand save answered ${r.status()} ${JSON.stringify(body).slice(0, 300)}; the dialog then read: ${JSON.stringify(dlg)}`);
        await drill.shoot(page, "publish-right-after-brand-save");
      }
      return r.status();
    };
    const publishRetry = async () => {
      let st = await publish();
      if (st === "nothing to publish") {
        drill.note("dark: right after the brand save, Publishing showed nothing to publish (Publish now disabled)");
        await drill.shoot(page, "publishing-right-after-brand-save");
      }
      for (let i = 0; i < 3 && st !== 200; i++) {
        await page.waitForTimeout(31_000); // the console's tenant settings cache (PLATFORM_CACHE_MS)
        st = await publish();
        drill.note(`dark: publish again after waiting 31 s: ${st}`);
      }
      return st;
    };
    const setBrand = async (bg, fg) => {
      const st = await page.evaluate(async (brand) => (await fetch("/api/admin/brand", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand }) })).status, { ...saved, background: bg, foreground: fg });
      const pub = await publishRetry();
      drill.note(`dark: brand ${bg}/${fg} saved (${st}), published (${pub})`);
      return st;
    };
    const op = await drill.context({ width: 1440 });
    const opPage = await drill.signInOperator(op);
    const setMaintenance = (on) =>
      opPage.evaluate(
        async ([enabled, message]) => (await fetch("/api/platform/tenants/design", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maintenance: enabled ? { enabled: true, message } : { enabled: false } }) })).status,
        [on, CLOSED_MESSAGE],
      );
    const visitor = await drill.context({ width: 1440 });
    const vp = await visitor.newPage();
    try {
      const s = await setBrand("#111827", "#f9fafb");
      drill.check(s === 200, "dark: the console saves a dark brand (background #111827, text #f9fafb)", s);
      // The open store takes the dark brand (the storefront caches settings up to 30 s).
      let openBg = null;
      for (let i = 0; i < 45; i++) {
        await drill.open(vp, "/", { width: 1440 });
        openBg = await vp.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color }));
        if (!/255, 25[0-5], 2[45]\d/.test(openBg.body)) break;
        await vp.waitForTimeout(1000);
      }
      drill.check(!/255, 25[0-5], 2[45]\d/.test(openBg.body), "dark: the open store shows the dark brand", openBg);
      await noThanks(vp);
      await drill.shoot(vp, "open-store-dark-1440");
      const on = await setMaintenance(true);
      drill.check(on === 200, "dark: maintenance switched on in the operator console", on);
      let closed = null;
      for (let i = 0; i < 45 && !closed; i++) {
        await drill.open(vp, "/", { width: 1440 });
        const t = await text(vp);
        const bg = await vp.evaluate(() => getComputedStyle(document.body).backgroundColor);
        if (t.includes(CLOSED_MESSAGE)) closed = { bg };
        else await vp.waitForTimeout(1000);
      }
      drill.check(Boolean(closed), "dark: a signed-out visitor gets the maintenance page", closed);
      drill.check(closed && !/255, 25[0-5], 2[45]\d/.test(closed.bg), "dark: the maintenance page takes the dark brand's background", closed);
      const c = await textContrast(vp, CLOSED_MESSAGE);
      drill.note(`dark: the founder's message is ${c?.color} on ${c?.background} (from <${c?.bgFrom}>), contrast ${c?.ratio}:1`);
      drill.check(c && c.ratio >= 4.5, "dark: the message contrast is 4.5:1 or better", c);
      const link = await vp.evaluate(() => {
        const a = [...document.querySelectorAll("a")].find((x) => /sign.?in/i.test(x.innerText));
        return a ? { text: a.innerText.trim(), color: getComputedStyle(a).color } : null;
      });
      if (link) drill.note(`dark: the "${link.text}" link is ${link.color}`);
      const lc = link ? await textContrast(vp, link.text) : null;
      if (lc) drill.note(`dark: the sign-in link contrast is ${lc.ratio}:1`);
      await drill.shoot(vp, "maintenance-dark-1440");
    } finally {
      const off = await setMaintenance(false).catch(() => 0);
      drill.check(off === 200, "dark: maintenance switched off again", off);
      const back = await setBrand(orig.bg, orig.fg).catch(() => 0);
      drill.check(back === 200, `dark: the brand put back (${orig.bg} / ${orig.fg})`, back);
      await visitor.close();
      await op.close();
      await ctx.close();
    }
  },

  async checkout(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    await drill.open(page, "/");
    await noThanks(page);
    await clearCart(page);
    await addToCart(drill, page, "glow-serum", 1);
    const widths = [360, 375, 390, 414];
    const out = {};
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 812 });
      await drill.open(page, "/checkout");
      const m = await page.evaluate(() => {
        const ol = document.querySelector("ol");
        const r = ol?.getBoundingClientRect();
        const pay = [...document.querySelectorAll("ol li span")].find((s) => s.textContent.trim() === "Payment")?.getBoundingClientRect();
        return { vw: window.innerWidth, sw: document.documentElement.scrollWidth, stepsRight: r && Math.round(r.right), paymentRight: pay && Math.round(pay.right) };
      });
      out[w] = m;
      drill.note(`checkout at ${w}: page ${m.sw}px wide in a ${m.vw}px window; the step row ends at ${m.stepsRight}px, "Payment" ends at ${m.paymentRight}px`);
      drill.check(m.sw <= m.vw + 1, `checkout at ${w}: no sideways scroll`, `page is ${m.sw}px wide`, w < 414 ? { known: "finding 6" } : {});
      await drill.shoot(page, `checkout-${w}`);
    }
    await ctx.close();
  },
};
