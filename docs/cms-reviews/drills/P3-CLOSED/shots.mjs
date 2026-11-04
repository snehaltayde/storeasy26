import { createRequire } from "node:module";
const [, , WT, OUTDIR] = process.argv;
const require = createRequire(WT + "/package.json");
const { chromium } = require("playwright-core");
const { chromePath } = await import(WT + "/scripts/drill.js");
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const out = [];
for (const [w, h] of [[1440, 900], [375, 812]]) {
  for (const cookies of [[], [{ name: "_admin", value: "x" }, { name: "_platform", value: "x" }, { name: "_mx", value: "x" }]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    if (cookies.length) await ctx.addCookies(cookies.map((c) => ({ ...c, url: "http://localhost:3640" })));
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const res = await page.goto("http://localhost:3640/", { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const title = await page.title();
    const tag = cookies.length ? "forged-cookies" : "anonymous";
    if (!cookies.length) await page.screenshot({ path: `${OUTDIR}/closed-${w}.png`, fullPage: true });
    out.push({ width: w, cookies: tag, status: res.status(), title, text: text.replace(/\s+/g, " ").trim(), sideways, errors });
    await ctx.close();
  }
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
