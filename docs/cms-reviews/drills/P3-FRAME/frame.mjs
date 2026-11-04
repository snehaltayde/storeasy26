// P3-FRAME drill: desktop Chrome (headless, playwright-core) on a running
// design harness, after setup.mjs publish. A same-origin stand-in for the
// editor (a blank page on the store's origin with an iframe) talks to the
// storefront's bridge exactly as the editor will.
// node frame.mjs <worktree> <scratch-dir> <port> <out-dir>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [, , WT, SCRATCH, PORT, OUT] = process.argv;
const require = createRequire(WT + "/package.json");
const { chromium } = require("playwright-core");
const { chromePath } = await import(WT + "/scripts/drill.js");
const BASE = `http://localhost:${PORT}`;
const token = readFileSync(join(SCRATCH, "token.txt"), "utf8").trim();
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });

async function editorPage(cookies, path = "/", { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  if (cookies.length) await ctx.addCookies(cookies.map((c) => ({ ...c, url: BASE })));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // the stand-in editor: same origin, a frame, every message kept
  await page.goto(`${BASE}/robots.txt`);
  await page.evaluate((src) => {
    document.open();
    document.write(`<!doctype html><body style="margin:0"><iframe id="f" src="${src}" style="width:100vw;height:100vh;border:0"></iframe></body>`);
    document.close();
    window.__msgs = [];
    window.addEventListener("message", (e) => {
      if (e.origin === location.origin) window.__msgs.push(e.data);
    });
  }, path);
  const frameEl = await page.waitForSelector("#f");
  const frame = await frameEl.contentFrame();
  await frame.waitForLoadState("load");
  const msgs = () => page.evaluate(() => window.__msgs);
  const waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = (await msgs()).find(pred);
      if (m) return m;
      await page.waitForTimeout(100);
    }
    return null;
  };
  const send = (data) => page.evaluate((d) => document.getElementById("f").contentWindow.postMessage(d, location.origin), data);
  return { ctx, page, frame: () => page.frames().find((f) => f !== page.mainFrame()), msgs, waitFor, send, errors, clear: () => page.evaluate(() => (window.__msgs = [])) };
}

// 1. a valid documents preview, driven as the editor will
{
  const e = await editorPage([{ name: "_preview", value: token }], "/");
  check("mount announces ready (v1 shape)", await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === undefined));
  await e.send({ type: "storeasy:editor:hello", v: 2 });
  const ready = await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === 2);
  check("v2 ready, ok, with the session's state", ready?.ok === true && ready.state?.kind === "documents" && typeof ready.state.docs?.doc_home === "string", JSON.stringify(ready).slice(0, 300));
  check("ready names no token", ready && !JSON.stringify(ready).includes(token));
  const f = e.frame();
  const before = f.url();
  await f.click('[data-field="primary.label"]');
  await e.page.waitForTimeout(800);
  const pick1 = (await e.msgs()).filter((m) => m?.type === "storeasy:pick").at(-1);
  check("clicking the hero's button picks it and does not navigate", e.frame().url() === before && pick1?.doc === "doc_home" && pick1.sectionId === "sec_hero" && pick1.field === "primary.label", JSON.stringify(pick1));
  await e.frame().click('header a[href="/about"]');
  await e.page.waitForTimeout(800);
  const pick2 = (await e.msgs()).filter((m) => m?.type === "storeasy:pick").at(-1);
  check("clicking a header link picks the header and does not navigate", e.frame().url() === before && pick2?.doc === "doc_header" && pick2.sectionId === null, JSON.stringify(pick2));
  await e.frame().click('[data-field="items.1.q"]');
  await e.page.waitForTimeout(800);
  const pick3 = (await e.msgs()).filter((m) => m?.type === "storeasy:pick").at(-1);
  check("clicking an FAQ question picks items.1.q", pick3?.sectionId === "sec_faq" && pick3.field === "items.1.q", JSON.stringify(pick3));
  await e.send({ type: "storeasy:select", sectionId: "sec_text" });
  await e.page.waitForTimeout(800);
  const outlined = await e.frame().evaluate(() => document.querySelector('[data-section-id="sec_text"]')?.classList.contains("storeasy-selected"));
  check("select outlines the section", outlined);
  await e.page.screenshot({ path: join(OUT, "preview-selected-1440.png") });
  await e.frame().evaluate(() => window.scrollTo(0, 700));
  const y0 = await e.frame().evaluate(() => window.scrollY);
  await e.clear();
  await e.send({ type: "storeasy:refresh" });
  await e.waitFor((m) => m?.type === "storeasy:ready", 15000);
  await e.page.waitForTimeout(1500);
  const after = await e.frame().evaluate(() => ({ y: window.scrollY, sel: document.querySelector('[data-section-id="sec_text"]')?.classList.contains("storeasy-selected") }));
  check("refresh reloads and restores the scroll and the selection", Math.abs(after.y - y0) < 5 && after.sel === true, `before ${y0}, after ${JSON.stringify(after)}`);
  const live = await e.frame().getAttribute("a:text('See the live store')", "href");
  check("the banner's live-store link is the exit to this address, no token", live === "/api/preview?exit=1&to=%2F", live);
  check("no page errors", e.errors.length === 0, e.errors.join(" | "));
  await e.ctx.close();
}

// 1b. "See the live store" inside the editor's frame (v2 on): the bar's link
// is followed, the cookie goes, and the bridge then says "live" (console cookie)
{
  const e = await editorPage([{ name: "_preview", value: token }, { name: "_admin", value: "x" }], "/about");
  await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === undefined);
  await e.send({ type: "storeasy:editor:hello", v: 2 });
  await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === 2);
  await e.clear();
  await e.frame().click("a:text('See the live store')");
  await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === undefined, 15000);
  const url = e.frame().url();
  check("See the live store navigates the frame to the same address, live", url === `${BASE}/about`, url);
  check("the preview cookie is gone", !(await e.ctx.cookies(BASE)).some((c) => c.name === "_preview" && c.value));
  await e.send({ type: "storeasy:editor:hello", v: 2 });
  const ready = await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === 2);
  check("the bridge now says live", ready?.ok === false && ready.reason === "live", JSON.stringify(ready));
  await e.ctx.close();
}

// 2. the same at 375
{
  const e = await editorPage([{ name: "_preview", value: token }], "/", { width: 375, height: 812 });
  await e.page.waitForTimeout(1000);
  await e.page.screenshot({ path: join(OUT, "preview-375.png") });
  const wide = await e.frame().evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("375: no sideways scroll in the preview", !wide);
  await e.ctx.close();
}

// 3. no preview, a console cookie: the bridge says live, Edit this page shows
{
  const e = await editorPage([{ name: "_admin", value: "x" }], "/about");
  check("console cookie: the bridge mounts and announces", await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === undefined));
  await e.send({ type: "storeasy:editor:hello", v: 2 });
  const ready = await e.waitFor((m) => m?.type === "storeasy:ready" && m.v === 2);
  check("console cookie, no preview: ready ok:false reason live", ready?.ok === false && ready.reason === "live", JSON.stringify(ready));
  const href = await e.frame().getAttribute("[data-edit-this-page]", "href");
  check("Edit this page links to the editor at this address", href === "/admin/editor?path=%2Fabout", href);
  check("no bar", !(await e.frame().content()).includes("preview has ended"));
  await e.page.screenshot({ path: join(OUT, "live-console-1440.png") });
  await e.ctx.close();
}

// 4. a shopper: nothing of this
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/about`);
  const html = await page.content();
  check("shopper: no Edit this page, no data-doc or data-field, no bar", !/Edit this page|data-doc=|data-field=|preview has ended|unpublished changes/.test(html));
  await ctx.close();
}

writeFileSync(join(OUT, "frame-results-part1.json"), JSON.stringify(results, null, 2));
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
