// P1-DRILLS · MIG-05/OVL-06 drills D1, D3–D6 (docs/cms-reviews/P1-MIG-05-OVL-06.md
// "Browser drills still needed"). D2 (this branch against main) is run by
// scripts/drills/p1/migovl-d2.mjs. Local harness database only.
//   part orders  D1, D6, D5 (needs a fresh seed: seeded orders have no lines)
//   part rename  D3, D4
import { readFileSync } from "node:fs";
import { sql, rows } from "./db.mjs";
import { text, seen, supportContext, revokeGrant, scrollWidth, settle } from "./util.mjs";
import { addToCart, checkoutCod, noThanks, clearCart } from "./sf.mjs";

export const id = "MIG-OVL";
export const title = "P1-DRILLS MIG-05/OVL-06: both titles on the order page";

const SKU = "DD-GLOW-30";
const SKU2 = "DD-SPF-50";
const RENAMED_LINE = "Glow Serum, festive edition";

// The order's line items as the console shows them: title text and the small line under it.
async function orderLines(page) {
  return page.evaluate(() => {
    const ps = [...document.querySelectorAll("p")].filter((p) => p.textContent.startsWith("Shopify title:"));
    return ps.map((p) => {
      const s = getComputedStyle(p);
      const li = p.closest("li") || p.parentElement?.parentElement;
      return { text: p.textContent, row: li?.innerText.slice(0, 200), color: s.color, size: s.fontSize };
    });
  });
}

function contrast(rgb, bg = [255, 255, 255]) {
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [l1, l2] = [lum(rgb), lum(bg)].sort((a, b) => b - a);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

const SHOPPER_HIDDEN = [/Shopify title/i, /\bSKU\b/i, new RegExp(SKU), new RegExp(SKU2)];

export const parts = {
  async orders(drill) {
    // Local data only: give two harness variants a SKU so the line has one to show.
    await sql("tenant", [`UPDATE variants SET sku='${SKU}' WHERE id='gid://v/1'`, `UPDATE variants SET sku='${SKU2}' WHERE id='gid://v/3'`]);
    const shopper = await drill.context({ width: 1440 });
    const sp = await shopper.newPage();
    await drill.open(sp, "/");
    await noThanks(sp);
    await clearCart(sp);
    const a1 = await addToCart(drill, sp, "glow-serum", 1);
    const a2 = await addToCart(drill, sp, "spf-50-sunscreen", 2);
    drill.check(a1.status === 200 && a2.status === 200, "setup: two products added to the storefront cart (POST /api/cart 200)", [a1, a2]);
    // ---- D6: the cart drawer ----
    const drawerText = await sp.evaluate(() => document.querySelector('[role="dialog"][aria-label="Shopping cart"]')?.innerText || "");
    drill.check(drawerText.includes("Radiance Glow Serum 30ml"), "D6 setup: the drawer shows the cart", drawerText.slice(0, 120));
    drill.check(!SHOPPER_HIDDEN.some((re) => re.test(drawerText)), "D6: no SKU or 'Shopify title' text in the cart drawer");
    await drill.shoot(sp, "D6-cart-drawer");
    const cartJson = await sp.evaluate(async () => (await fetch("/api/cart")).json());
    drill.note(`D6: the cart JSON a shopper's browser receives carries catalog_title and sku (known limit, not visible): ${JSON.stringify((cartJson.items || []).map((i) => ({ title: i.title, catalog_title: i.catalog_title, sku: i.sku })))}`);
    // ---- place the order (COD) ----
    const shots = {};
    const placed = await checkoutCod(drill, sp, {
      onStep: async (s) => {
        if (s === "review") shots.review = await drill.shoot(sp, "D6-checkout-review");
        if (s === "payment") shots.payment = await drill.shoot(sp, "D6-checkout-payment");
      },
    });
    drill.check(Boolean(placed.orderId), "setup: COD order placed on the harness storefront", placed.orderId);
    for (const [k, t] of Object.entries(placed.texts)) drill.check(!SHOPPER_HIDDEN.some((re) => re.test(t)), `D6: no SKU or 'Shopify title' text on checkout (${k})`);
    await drill.shoot(sp, "D6-confirmation");
    await shopper.close();

    const items = await rows("tenant", "SELECT position, variant_id, title, catalog_title, sku, quantity FROM order_items WHERE order_id=? ORDER BY position", [placed.orderId]);
    drill.note(`D1: order ${placed.orderId} lines as written: ${JSON.stringify(items)}`);
    drill.check(items.length === 2 && items.every((i) => i.catalog_title === i.title) && items.find((i) => i.variant_id === "gid://v/1")?.sku === SKU, "D1 setup: the order's lines carry catalog_title (= title) and sku (migration 0018)", items);
    // Stand in for an overlay title: rename the shopper-facing title of one line.
    await sql("tenant", "UPDATE order_items SET title=? WHERE order_id=? AND variant_id='gid://v/1'", [RENAMED_LINE, placed.orderId]);

    // ---- D1 ----
    const merchant = await drill.context({ width: 1280 });
    const mp = await drill.signIn(merchant);
    await drill.open(mp, `/admin/orders/${encodeURIComponent(placed.orderId)}`, { width: 1280 });
    let lines = await orderLines(mp);
    const want = `Shopify title: Radiance Glow Serum 30ml, SKU: ${SKU}`;
    drill.check(lines.length === 1 && lines[0].text === want, `D1: under the renamed line, "${want}"`, lines);
    drill.check(lines[0]?.row?.includes(RENAMED_LINE), "D1: it sits under the line the shopper saw as the new name", lines[0]?.row);
    drill.check(lines.every((l) => !l.row?.includes("Daily Defence SPF 50")), "D1: the other line shows nothing new", lines);
    if (lines[0]) {
      const rgb = lines[0].color.match(/\d+/g).slice(0, 3).map(Number);
      drill.note(`D1: the line is ${lines[0].size} in ${lines[0].color}, contrast ${contrast(rgb)}:1 on white (review finding: text-fg-subtle, about 2.6:1)`);
    }
    let sw = await scrollWidth(mp);
    drill.check(sw.sw <= sw.vw + 1, "D1 at 1280: nothing overflows sideways", sw);
    await mp.getByText(want).first().scrollIntoViewIfNeeded().catch(() => {});
    await drill.shoot(mp, "D1-order-1280");
    await mp.setViewportSize({ width: 375, height: 812 });
    await settle(mp);
    sw = await scrollWidth(mp);
    const clipped = await mp.evaluate((needle) => {
      const p = [...document.querySelectorAll("p")].find((x) => x.textContent === needle);
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { right: r.right, vw: window.innerWidth, scrollW: p.scrollWidth, clientW: p.clientWidth };
    }, want);
    drill.check(sw.sw <= sw.vw + 1 && clipped && clipped.right <= clipped.vw && clipped.scrollW <= clipped.clientW + 1, "D1 at 375: nothing overflows (page and the Shopify line fit)", { sw, clipped });
    await mp.getByText(want).first().scrollIntoViewIfNeeded().catch(() => {});
    await drill.shoot(mp, "D1-order-375");
    await merchant.close();

    // ---- D5: support role ----
    const { ctx, page: op, grant } = await supportContext(drill, { width: 1280 });
    drill.check(grant.status === 200, "D5 setup: support grant created in the operator console", grant.status);
    await drill.open(op, `/admin/orders/${encodeURIComponent(placed.orderId)}`, { width: 1280 });
    lines = await orderLines(op);
    const t = await text(op);
    drill.check(lines.length === 1 && lines[0].text === want, "D5: as support, the Shopify title and SKU line shows", lines);
    const pii = ["Drill Shopper", "drill@design.test", "9876500000", "12 Test Lane", "411001"].filter((x) => t.includes(x));
    drill.check(pii.length === 0, "D5: name, email, phone and address are hidden from support", pii);
    await op.getByText(want).first().scrollIntoViewIfNeeded().catch(() => {});
    await drill.shoot(op, "D5-support-order");
    await revokeGrant(op, grant.body.id);
    await ctx.close();
  },

  async rename(drill) {
    const HANDLE = "rose-mist";
    const OLD = "Rose Hydration Mist 100ml";
    const NEW = "Rose Hydration Mist 100ml Renamed";
    const before = await rows("tenant", "SELECT count(*) n FROM order_items WHERE variant_id='gid://v/7'");
    drill.note(`D3: lines for ${OLD} before the drill: ${before[0].n} (seeded orders don't carry this product)`);
    const shopper = await drill.context({ width: 1440 });
    const sp = await shopper.newPage();
    await drill.open(sp, "/");
    await noThanks(sp);
    await clearCart(sp);
    await addToCart(drill, sp, HANDLE, 1);
    const o1 = await checkoutCod(drill, sp);
    await sql("tenant", "UPDATE products SET title=? WHERE handle=?", [NEW, HANDLE]);
    await clearCart(sp);
    await addToCart(drill, sp, HANDLE, 2);
    const o2 = await checkoutCod(drill, sp);
    drill.check(o1.orderId && o2.orderId, "D3 setup: two COD orders for one product, renamed in the local DB between them", [o1.orderId, o2.orderId]);
    const lines = await rows("tenant", "SELECT order_id, title, catalog_title, quantity, line_total FROM order_items WHERE variant_id='gid://v/7' ORDER BY order_id");
    drill.note(`D3: the two orders' lines: ${JSON.stringify(lines)}`);
    await shopper.close();

    const merchant = await drill.context({ width: 1440 });
    const mp = await drill.signIn(merchant);
    await drill.open(mp, "/admin/analytics", { width: 1440 });
    const top = await mp.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim().startsWith("Top products"));
      const sec = h?.closest("section");
      return sec ? sec.innerText : null;
    });
    drill.note(`D3: Top products card: ${JSON.stringify(top)}`);
    const rowsWith = (top || "").split("\n").filter((l) => l.includes("Rose Hydration Mist"));
    drill.check(Boolean(top), "D3: Analytics shows Top products");
    const oneRow = (top || "").split(/\n/).filter((l) => /^Rose Hydration Mist/.test(l.trim()));
    drill.check(oneRow.length === 1 && oneRow[0].trim().startsWith(NEW), `D3: one Top products row for the product, under its current title "${NEW}"`, rowsWith);
    await mp.getByText("Top products").first().scrollIntoViewIfNeeded().catch(() => {});
    await drill.shoot(mp, "D3-analytics-top-products");
    // CSV export: the real button, the browser's download.
    const sec = mp.locator("section", { has: mp.getByRole("heading", { name: "Top products" }) });
    const [dl] = await Promise.all([mp.waitForEvent("download", { timeout: 15_000 }), sec.getByRole("button", { name: "Export CSV" }).click()]);
    const csv = readFileSync(await dl.path(), "utf8");
    const [header, ...body] = csv.split("\n");
    const mine = body.filter((l) => l.includes("Rose Hydration Mist"));
    drill.check(header === "title,qty,revenue", "D3: the CSV export still has the columns title, qty, revenue", header);
    drill.check(mine.length === 1 && mine[0] === `${NEW},3,${749 * 3}`, `D3: the CSV has one row for it with both orders' quantity (3) and revenue (${749 * 3})`, mine);
    drill.note(`D3: CSV rows: ${JSON.stringify(body.slice(0, 10))}`);
    await merchant.close();

    // ---- D4: the agency's client report ----
    const agency = await drill.context({ width: 1440 });
    const ap = await agency.newPage();
    await drill.open(ap, "/partners");
    await ap.locator("#partners-email").fill("partner@design.test");
    await ap.locator("#partners-password").fill(drill.harness.creds.DESIGN_ADMIN_PASSWORD || "");
    await ap.getByRole("button", { name: "Sign in", exact: true }).click();
    const inConsole = await seen(ap, "Design Demo Co", 30_000);
    drill.check(inConsole, "D4 setup: signed in to the Partners console as the harness agency");
    const reportBtn = ap.getByRole("button", { name: /report/i }).first();
    const has = (await reportBtn.count()) > 0;
    drill.check(has, "D4: the design tenant has a report button");
    if (has) {
      await reportBtn.click();
      await seen(ap, "Top products", 30_000);
      const rep = await ap.evaluate(() => [...document.querySelectorAll("dialog[open], [role=dialog]")].map((d) => d.innerText).join("\n"));
      drill.note(`D4: the report dialog: ${JSON.stringify(rep.slice(0, 900))}`);
      const mention = rep.split("\n").filter((l) => l.includes("Rose Hydration Mist"));
      drill.check(mention.length === 1 && mention[0].includes(NEW), `D4: one row for that product under its current title`, mention);
      await drill.shoot(ap, "D4-agency-report");
    }
    await agency.close();
  },
};
