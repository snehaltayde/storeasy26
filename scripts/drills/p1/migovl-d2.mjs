// MIG-OVL D2: a seeded order's page, captured the same way on this branch and
// on main, so the two can be compared. Main runs from a `git archive main`
// copy with its own (file database) harness; this script only drives Chrome.
//   node scripts/drills/p1/migovl-d2.mjs <label> <baseUrl> <order id>
// Writes docs/cms-reviews/drills/MIG-OVL/D2-<label>-<width>.png and D2-<label>.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, compressShot, settle } from "../../drill.js";
import { readCredentials } from "../../design-harness.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const [label, base, orderId] = process.argv.slice(2);
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base || "")) throw new Error("local base URL only");
const dir = join(ROOT, "docs", "cms-reviews", "drills", "MIG-OVL");
mkdirSync(dir, { recursive: true });
const creds = readCredentials(ROOT);
const browser = await launchChrome();
const out = { label, base, orderId, ranAt: new Date().toISOString(), widths: {} };
try {
  for (const width of [1280, 375]) {
    const ctx = await browser.newContext({ baseURL: base, viewport: { width, height: width === 375 ? 812 : 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto("/admin/login");
    await page.locator("#login-password").fill(creds.DESIGN_ADMIN_PASSWORD || "");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/admin\/dashboard/, { timeout: 60_000 });
    await page.goto(`/admin/orders/${encodeURIComponent(orderId)}`, { timeout: 120_000 });
    await settle(page);
    await page.waitForTimeout(800);
    const facts = await page.evaluate(() => {
      const main = document.querySelector("main") || document.body;
      return {
        text: main.innerText,
        shopifyLine: /Shopify title/.test(document.body.innerText),
        sw: document.documentElement.scrollWidth,
        vw: window.innerWidth,
      };
    });
    // the line items card, for a like-for-like picture
    const items = page.locator("section").filter({ hasText: /×|Qty|Items/ }).first();
    const raw = (await items.count()) ? await items.screenshot({ animations: "disabled" }) : await page.screenshot({ animations: "disabled" });
    const png = await compressShot(raw);
    writeFileSync(join(dir, `D2-${label}-${width}-items.png`), png);
    writeFileSync(join(dir, `D2-${label}-${width}.png`), await compressShot(await page.screenshot({ fullPage: true, animations: "disabled" })));
    out.widths[width] = { ...facts, itemsShotBytes: raw.length };
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(dir, `D2-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ label, shopifyLine: Object.values(out.widths).map((w) => w.shopifyLine), overflow: Object.values(out.widths).map((w) => w.sw > w.vw + 1) }));
