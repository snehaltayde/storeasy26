// P3-FRAME drill, part 2: after setup.mjs revoke. The same session cookie now
// shows the live store with the "preview has ended" bar, and the bridge
// answers the editor's hello with ok:false, reason "revoked".
// node ended.mjs <worktree> <scratch-dir> <port> <out-dir>
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "_preview", value: token, url: BASE }]);
const page = await ctx.newPage();
await page.goto(`${BASE}/robots.txt`);
await page.evaluate(() => {
  document.open();
  document.write(`<!doctype html><body style="margin:0"><iframe id="f" src="/" style="width:100vw;height:100vh;border:0"></iframe></body>`);
  document.close();
  window.__msgs = [];
  window.addEventListener("message", (e) => e.origin === location.origin && window.__msgs.push(e.data));
});
const waitFor = async (pred, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = (await page.evaluate(() => window.__msgs)).find(pred);
    if (m) return m;
    await page.waitForTimeout(100);
  }
  return null;
};
check("the bridge mounts for an ended preview", await waitFor((m) => m?.type === "storeasy:ready" && m.v === undefined));
await page.evaluate(() => document.getElementById("f").contentWindow.postMessage({ type: "storeasy:editor:hello", v: 2 }, location.origin));
const ready = await waitFor((m) => m?.type === "storeasy:ready" && m.v === 2);
check("ready ok:false, reason revoked", ready?.ok === false && ready.reason === "revoked", JSON.stringify(ready));
const frame = page.frames().find((f) => f !== page.mainFrame());
const html = await frame.content();
check("the ended bar shows, with Exit", html.includes("Your preview has ended, so you’re seeing the live store.") || html.includes("Your preview has ended, so you're seeing the live store."));
check("the live store shows (no draft hero, no attributes)", !html.includes("Draft glow") && !/data-field=|data-doc=/.test(html));
await page.screenshot({ path: join(OUT, "ended-1440.png") });
// Exit clears the stale cookie
await frame.click("[data-preview-ended] a");
await page.waitForTimeout(1500);
const cookies = await ctx.cookies(BASE);
check("Exit clears the preview cookie", !cookies.some((c) => c.name === "_preview" && c.value));
writeFileSync(join(OUT, "frame-results-part2.json"), JSON.stringify(results, null, 2));
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
