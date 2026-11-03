// PV-08 · Experiments do not hide what you are editing (desktop Chrome, design harness).
//   DESIGN_PORT=3202 node scripts/drills/p1/run.mjs pv08 [part]
//   PV08_PHASE=before … runs the same journey on code without PV-08: every PV-08
//   check is marked known, screenshots and results are named before-*.
// Parts:
//   designer    the founder's Designer with the seeded hero test running, as a
//               visitor bucketed into variant b: saved and typed titles show, the
//               note shows in the frame and beside the hero settings, its link
//               opens the test's row, and nothing pings /api/exp
//   preview-tab the same preview opened as a page of its own, at 1440 and 375
//   shopper     signed-out shoppers in each bucket: served and counted as before
//   conversion  a founder exposed as a shopper, then previewing, places a COD
//               order: no conversion; the same as a plain shopper: a conversion
import { text, seen, sleep } from "./util.mjs";
import { addToCart, checkoutCod, clearCart, noThanks } from "./sf.mjs";
import { rows } from "./db.mjs";

export const id = "PV-08";
export const title = "PV-08 experiments are inert in preview";

const PHASE = process.env.PV08_PHASE === "before" ? "before" : "after";
const K = PHASE === "before" ? { known: "PV-08 not built (8968db3)" } : {};
const shot = (name) => (PHASE === "before" ? `before-${name}` : name);
const NOTE = "A test is running on this section";
const SEES = "Some visitors see a different version; the preview shows yours.";

// The pure bucketing hash of lib/experiments.js (copied: importing the library
// would open the app's database client here).
function hashUnit(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000;
}
function assign(exp, unit) {
  const bucket = hashUnit(`${exp.salt || ""}|${exp.slug}|${unit}`);
  const total = exp.variants.reduce((s, v) => s + Number(v.weight), 0);
  let acc = 0;
  for (const v of exp.variants) {
    acc += (Number(v.weight) / total) * 10000;
    if (bucket < acc) return v.key;
  }
  return exp.variants[exp.variants.length - 1]?.key || "control";
}
async function heroTest() {
  const [r] = await rows("tenant", "SELECT id, slug, name, salt, status, variants FROM experiments WHERE slug='hero-promise'");
  return { ...r, variants: JSON.parse(r.variants) };
}
// A fresh unit id in the bucket asked for, unique to this run.
function unitIn(exp, key, tag) {
  const stamp = Date.now().toString(36);
  for (let i = 0; ; i++) {
    const u = `pv08-${tag}-${stamp}-${i}`;
    if (assign(exp, u) === key) return u;
  }
}
// The runner signs later contexts in by copying the first sign-in's cookies,
// which would carry that browser's _unit and _preview too. So the unit is set
// after every sign-in, and checked.
async function setUnit(ctx, url, unit) {
  await ctx.addCookies([{ name: "_unit", value: unit, url }]);
  const got = (await ctx.cookies()).find((c) => c.name === "_unit")?.value;
  if (got !== unit) throw new Error(`the browser's _unit is ${got}, not ${unit}`);
}
const exposures = async (unit) => rows("tenant", "SELECT variant FROM experiment_exposures WHERE unit_id = ?", [unit]);
const conversions = async (unit) => rows("tenant", "SELECT order_id FROM experiment_conversions WHERE unit_id = ?", [unit]);
const allExposures = async () => Number((await rows("tenant", "SELECT count(*) n FROM experiment_exposures"))[0].n);

// Every /api/exp request any page or frame in a context sends, with its answer.
function expPings(ctx) {
  const out = [];
  ctx.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/exp") out.push({ method: r.method(), frame: r.frame()?.url?.() ?? null });
  });
  ctx.on("response", async (r) => {
    if (new URL(r.url()).pathname !== "/api/exp") return;
    const body = await r.json().catch(() => null);
    const hit = out.find((x) => x.body === undefined);
    if (hit) Object.assign(hit, { status: r.status(), body });
  });
  return out;
}

const previewFrame = (page) => page.frames().find((fr) => fr !== page.mainFrame() && new URL(fr.url()).pathname === "/");
async function frameHero(page) {
  const fr = previewFrame(page);
  if (!fr) return null;
  return fr
    .evaluate(() => {
      const sec = document.querySelector('[data-sec="hero"]');
      const note = sec?.querySelector("[data-preview-note]");
      return {
        h1: sec?.querySelector("h1")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        text: sec?.innerText.replace(/\s+/g, " ").trim() ?? "",
        note: note ? note.innerText.replace(/\s+/g, " ").trim() : null,
        noteLink: note?.querySelector("a")?.getAttribute("href") ?? null,
      };
    })
    .catch(() => null);
}
async function waitHero(page, pred, ms = 20_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await frameHero(page);
    if (last && pred(last)) return { ms: Date.now() - t0, hero: last };
    await sleep(250);
  }
  return { ms: null, hero: last };
}

async function designer(drill) {
  const exp = await heroTest();
  drill.check(exp.status === "running", "setup: the seeded hero test is running", { slug: exp.slug, status: exp.status });
  const unit = unitIn(exp, "b", "founder");
  const ctx = await drill.context({ width: 1440 });
  const pings = expPings(ctx);
  const docs = [];
  ctx.on("response", (r) => {
    if (r.request().resourceType() === "document" && new URL(r.url()).pathname === "/") docs.push({ status: r.status(), edge: r.headers()["x-edge-runtime"] ?? null });
  });
  const before = await allExposures();
  const page = await drill.signIn(ctx);
  // The founder's browser is a visitor in variant b: the worst case, every time.
  await setUnit(ctx, drill.baseUrl, unit);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const [saved] = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'").catch(() => [null]);
  const draft = JSON.parse(saved?.value || "{}");
  drill.note(`setup: founder's browser unit ${unit} is in variant ${assign(exp, unit)}; saved hero title "${draft.title}"`);

  await drill.open(page, "/admin/storefront/designer", { width: 1440 });
  drill.check(await seen(page, "Preview shows your last save", 60_000), 'the preview connects ("Preview shows your last save")');
  const first = await waitHero(page, (h) => h.h1 === draft.title, 8_000);
  drill.check(first.hero?.h1 === draft.title, "the preview shows the founder's saved hero title, not variant b's", first.hero?.h1, K);
  drill.check(first.hero?.note?.includes(NOTE) && first.hero.note.includes(`“${exp.name}”`) && first.hero.note.includes(SEES), "the preview's hero carries the note, naming the test", first.hero?.note, K);
  drill.check(first.hero?.noteLink === "/admin/experiments#exp-row-hero-promise", "the preview note links to the test's row", first.hero?.noteLink, K);
  await drill.shoot(page, shot("designer-preview-note"));

  // Reload the frame five times: the same visitor, the same answer.
  const reloads = [];
  for (let i = 0; i < 5; i++) {
    await page.getByRole("button", { name: "Refresh preview" }).click();
    await sleep(600);
    await seen(page, "Preview shows your last save", 20_000);
    reloads.push((await waitHero(page, (h) => !!h.h1, 10_000)).hero?.h1);
  }
  drill.check(reloads.every((h) => h === draft.title), "five reloads of the preview: the saved title every time", reloads, K);

  // The hero's settings: the note beside them, and its link.
  await page.getByRole("button", { name: "Hero", exact: true }).first().click();
  await page.locator("#ins-hero-title").waitFor({ timeout: 10_000 });
  const inspector = await page.evaluate((needle) => {
    const t = document.querySelector("#ins-hero-title");
    let box = t;
    while (box && !box.innerText?.includes("The big home-page opener")) box = box.parentElement;
    const banner = box ? [...box.querySelectorAll("div")].find((d) => d.children.length && d.innerText.startsWith(needle)) : null;
    const a = banner?.querySelector("a");
    return { note: banner ? banner.innerText.replace(/\s+/g, " ").trim() : null, href: a?.getAttribute("href") ?? null, before: banner ? !!(banner.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) : null };
  }, NOTE);
  drill.check(inspector.note?.includes(`“${exp.name}”`) && inspector.note.includes(SEES), "beside the hero settings: the note names the test and says what the preview shows", inspector.note, K);
  drill.check(inspector.href === "/admin/experiments#exp-row-hero-promise" && inspector.before, "the settings note links to the test's row and sits above the fields", inspector, K);
  const treeMark = await page.evaluate(() => {
    const b = [...document.querySelectorAll("[data-tree-pick]")].find((x) => x.innerText.includes("Hero"));
    const d = b?.getAttribute("aria-describedby");
    return { text: b?.innerText.replace(/\s+/g, " ").trim(), describedBy: d ? document.getElementById(d)?.textContent.trim() : null };
  });
  drill.check(/Test running/.test(treeMark.text || "") && treeMark.describedBy === "Test running", "the tree's Hero row says a test is running (as its description)", treeMark, K);
  const heroNamed = await page.getByRole("button", { name: "Hero", exact: true }).count();
  drill.check(heroNamed >= 1, 'the tree\'s Hero button is still named "Hero" (the other drills select it by that name)', heroNamed);
  await drill.shoot(page, shot("designer-hero-settings"));

  // Type a new title and subtitle: the preview shows them while the test runs.
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, ".");
  const TITLE = `PV-08 hero ${stamp}`;
  const SUB = `Typed in the Designer while the test runs, ${stamp}.`;
  await page.locator("#ins-hero-title").fill(TITLE);
  await page.locator("#ins-hero-subtitle").fill(SUB);
  const typed = await waitHero(page, (h) => h.h1 === TITLE && h.text.includes(SUB), 20_000);
  drill.check(typed.ms != null, "typed title and subtitle show in the preview before saving", typed.ms != null ? `${typed.ms} ms` : typed.hero, K);
  await drill.shoot(page, shot("designer-typed"));
  const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  drill.check((await put).status() === 200, "Save answers 200", (await put).status());
  await sleep(1500);
  await seen(page, "Preview shows your last save", 20_000);
  const after = await waitHero(page, (h) => h.h1 === TITLE && h.text.includes(SUB), 20_000);
  drill.check(after.ms != null, "after Save the preview shows the saved title and subtitle", after.hero, K);
  await drill.shoot(page, shot("designer-saved"));

  // Nothing the founder did counted as a visitor.
  await sleep(1000);
  drill.note(`/api/exp requests from the founder's browser: ${JSON.stringify(pings)}`);
  drill.check(pings.length === 0, "no POST /api/exp from the Designer, the preview or its reloads", pings, K);
  drill.check((await exposures(unit)).length === 0, "no exposure row for the founder's unit", await exposures(unit), K);
  drill.check((await allExposures()) === before, "exposures in all unchanged by the Designer session", { before, after: await allExposures() }, K);
  drill.check(docs.length > 0 && docs.every((d) => d.status === 200 && d.edge === "1"), "every preview document answered 200 on the edge runtime", docs);

  // The link opens the test's row in the console.
  await page.locator("a[href='/admin/experiments#exp-row-hero-promise']").first().click().catch(() => {});
  await page.waitForURL(/\/admin\/experiments/, { timeout: 15_000 }).catch(() => {});
  await sleep(800);
  const row = await page.evaluate(() => {
    const el = document.getElementById("exp-row-hero-promise");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText.replace(/\s+/g, " ").slice(0, 120), top: Math.round(r.top), inView: r.top >= 0 && r.top < window.innerHeight };
  });
  drill.check(new URL(page.url()).pathname === "/admin/experiments" && row?.text?.includes(exp.name) && row.inView, "the note's link opens Experiments at the test's row", { url: page.url(), row }, K);
  await drill.shoot(page, shot("experiments-row"));

  // Put the hero back as seeded, so later parts and drills see the seed.
  await drill.open(page, "/admin/storefront/designer", { width: 1440 });
  await page.getByRole("button", { name: "Hero", exact: true }).first().click();
  await page.locator("#ins-hero-title").fill(draft.title || "");
  await page.locator("#ins-hero-subtitle").fill(draft.subtitle || "");
  const back = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  drill.note(`hero put back to the seeded draft: ${(await back).status()}`);
  await ctx.close();
}

async function previewTab(drill) {
  const exp = await heroTest();
  const unit = unitIn(exp, "b", "tab");
  const ctx = await drill.context({ width: 1440 });
  const pings = expPings(ctx);
  const page = await drill.signIn(ctx);
  await setUnit(ctx, drill.baseUrl, unit);
  // The Designer mints this browser's preview session; then "Open preview in a new tab".
  await drill.open(page, "/admin/storefront/designer", { width: 1440 });
  await seen(page, "Preview shows your last save", 60_000);
  const [saved] = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'");
  const draft = JSON.parse(saved.value);
  const tab = await ctx.newPage();
  for (const width of [1440, 375]) {
    await drill.open(tab, "/", { width });
    await noThanks(tab);
    const h = await tab.evaluate(() => {
      const sec = document.querySelector('[data-sec="hero"]');
      const note = sec?.querySelector("[data-preview-note]");
      const r = note?.getBoundingClientRect();
      return { h1: sec?.querySelector("h1")?.innerText.replace(/\s+/g, " ").trim(), note: note?.innerText.replace(/\s+/g, " ").trim() ?? null, fits: r ? r.right <= window.innerWidth + 1 && r.left >= -1 : null, sw: document.documentElement.scrollWidth, vw: window.innerWidth };
    });
    drill.check(h.h1 === draft.title, `preview tab at ${width}: the founder's saved title`, h.h1, K);
    drill.check(h.note?.includes(NOTE) && h.note.includes(`“${exp.name}”`), `preview tab at ${width}: the note in the hero`, h.note, K);
    drill.check(h.sw <= h.vw + 1 && h.fits !== false, `preview tab at ${width}: no sideways scroll, the note fits`, h);
    await drill.shoot(tab, shot(`preview-tab-${width}`));
  }
  await sleep(800);
  drill.check(pings.length === 0, "no POST /api/exp from the preview tab", pings, K);
  drill.check((await exposures(unit)).length === 0, "no exposure row for this unit", await exposures(unit), K);
  await ctx.close();
}

async function shopper(drill) {
  const exp = await heroTest();
  const [live] = await rows("tenant", "SELECT json_extract(content, '$.blocks.hero.title') title FROM releases WHERE id = (SELECT live_release_id FROM release_state WHERE id = 1)").catch(() => [null]);
  const out = [];
  for (const key of ["b", "control", null]) {
    const ctx = await drill.context({ width: 1440 });
    const unit = key ? unitIn(exp, key, `shopper-${key}`) : null;
    if (unit) await setUnit(ctx, drill.baseUrl, unit);
    const pings = expPings(ctx);
    const page = await ctx.newPage();
    await drill.open(page, "/", { width: 1440 });
    await sleep(1200);
    const h = await page.evaluate(() => {
      const sec = document.querySelector('[data-sec="hero"]');
      return { h1: sec?.querySelector("h1")?.innerText.replace(/\s+/g, " ").trim(), note: !!document.querySelector("[data-preview-note]"), body: document.body.innerText.includes("A test is running") };
    });
    const cookieUnit = (await ctx.cookies()).find((c) => c.name === "_unit")?.value ?? null;
    const u = unit || cookieUnit;
    const want = u ? assign(exp, u) : null;
    const rowsFor = u ? await exposures(u) : [];
    out.push({ key: key ?? "first visit", unit: u, h1: h.h1, pings: pings.map((p) => p.body), exposure: rowsFor.map((r) => r.variant) });
    const variantTitle = exp.variants.find((v) => v.key === "b").payload.title;
    if (want === "b") drill.check(h.h1 === variantTitle, `shopper (${key ?? "first visit"}): variant b's title`, h.h1);
    else drill.check(h.h1 && h.h1 !== variantTitle, `shopper (${key ?? "first visit"}): the live title`, h.h1);
    drill.check(pings.length === 1 && pings[0].body?.recorded === true, `shopper (${key ?? "first visit"}): one POST /api/exp, recorded`, pings);
    drill.check(rowsFor.length === 1 && rowsFor[0].variant === want, `shopper (${key ?? "first visit"}): one exposure row, variant ${want}`, rowsFor);
    drill.check(!h.note && !h.body, `shopper (${key ?? "first visit"}): no preview note`, h);
    if (key === "b") await drill.shoot(page, shot("shopper-variant-b"));
    if (key === "control") await drill.shoot(page, shot("shopper-control"));
    await ctx.close();
  }
  drill.note(`shoppers: ${JSON.stringify(out)}; the live release's hero title: ${JSON.stringify(live?.title ?? null)}`);
}

async function conversion(drill) {
  const exp = await heroTest();
  const results = {};
  for (const mode of ["shopper", "previewing"]) {
    const unit = unitIn(exp, "b", `conv-${mode}`);
    const ctx = await drill.context({ width: 1440 });
    await setUnit(ctx, drill.baseUrl, unit);
    // First as a shopper: exposed, counted.
    const shopperPage = await ctx.newPage();
    await drill.open(shopperPage, "/", { width: 1440 });
    await noThanks(shopperPage);
    await sleep(1200);
    const exposed = await exposures(unit);
    drill.check(exposed.length === 1, `${mode}: exposed once as a shopper first`, exposed);
    let page = shopperPage;
    if (mode === "previewing") {
      // Then the same browser signs in and opens the Designer: a preview session.
      page = await drill.signIn(ctx);
      await setUnit(ctx, drill.baseUrl, unit);
      await drill.open(page, "/admin/storefront/designer", { width: 1440 });
      await seen(page, "Preview shows your last save", 60_000);
      const hasPreview = (await ctx.cookies()).some((c) => c.name === "_preview");
      drill.check(hasPreview, "previewing: the browser holds the preview cookie", hasPreview);
    }
    await clearCart(page);
    await addToCart(drill, page, "glow-serum", 1);
    const order = await checkoutCod(drill, page);
    let conv = [];
    for (let i = 0; i < 20; i++) {
      conv = await conversions(unit);
      if (conv.length || (mode === "previewing" && i >= 8)) break;
      await sleep(500);
    }
    results[mode] = { unit, order: order.orderId, conversions: conv };
    if (mode === "shopper") drill.check(conv.length === 1 && conv[0].order_id === order.orderId, "shopper: the COD order counts as a conversion for the test", results[mode]);
    else drill.check(conv.length === 0, "previewing: the COD order placed in a preview session counts as no conversion", results[mode], K);
    if (mode === "previewing") await drill.shoot(page, shot("conversion-preview-order"));
    await ctx.close();
  }
  drill.note(`conversions: ${JSON.stringify(results)} (harness orders; re-seed afterwards)`);
}

const PARTS = { designer, "preview-tab": previewTab, shopper, conversion };
export const parts = Object.fromEntries(Object.entries(PARTS).map(([k, fn]) => [PHASE === "before" ? `before-${k}` : k, fn]));
