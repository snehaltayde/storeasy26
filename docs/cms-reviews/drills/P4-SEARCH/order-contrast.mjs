// P4-SEARCH drill (scratch, not committed): the order page's Shopify-title
// line, measured in desktop Chrome on the design harness.
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7107 node <this file> <worktree>
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const WT = process.argv[2];
const L = await import(pathToFileURL(join(WT, "scripts/drills/p3/lib.mjs")).href);

const code = await L.runDrill({ id: "P4-SEARCH", part: "order-contrast", title: "P4-SEARCH — order page Shopify-title line contrast" }, async (drill) => {
  await L.reseed(drill);
  const ts = new Date().toISOString();
  const id = "DRILL-OVL06";
  await L.storeSql("live", [
    { sql: "DELETE FROM order_items WHERE order_id = ?", args: [id] },
    { sql: "DELETE FROM orders WHERE id = ?", args: [id] },
    {
      sql: "INSERT INTO orders (id, idempotency_key, status, payment_method, payment_status, total, subtotal, discount_total, currency, snapshot, sync_attempts, created_at, updated_at) VALUES (?, 'drill-ovl06', 'cod_pending', 'cod', 'cod', 1000, 1000, 0, 'INR', ?, 0, ?, ?)",
      args: [id, JSON.stringify({ v: 1, items: [{ variantId: "gid://drill/v1", productId: "gid://drill/p1", title: "Morning Whey", catalog_title: "Whey Gold Isolate", sku: "WGI-1KG", quantity: 1, lineTotal: 1000 }] }), ts, ts],
    },
    {
      sql: "INSERT INTO order_items (order_id, variant_id, product_id, title, catalog_title, sku, unit_price, quantity, line_total, line_discount, is_gift, position) VALUES (?, 'gid://drill/v1', 'gid://drill/p1', 'Morning Whey', 'Whey Gold Isolate', 'WGI-1KG', 1000, 1, 1000, 0, 0, 0)",
      args: [id],
    },
  ]);
  const page = await drill.login("owner");
  await page.goto(L.storeUrl(drill, "live", `/admin/orders/${id}`));
  const line = page.locator("p", { hasText: "Shopify title: Whey Gold Isolate, SKU: WGI-1KG" }).first();
  await line.waitFor({ timeout: 30_000 });
  const m = await line.evaluate((el) => {
    const parse = (c) => {
      const x = c.match(/rgba?\(([^)]+)\)/);
      if (!x) return null;
      const [r, g, b, a = 1] = x[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parse(getComputedStyle(el).color);
    let bgEl = el;
    let bg = null;
    while (bgEl) {
      const c = parse(getComputedStyle(bgEl).backgroundColor);
      if (c && c.a > 0) {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    bg = bg || { r: 255, g: 255, b: 255, a: 1 };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { color: getComputedStyle(el).color, background: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, from: bgEl?.tagName || "default", className: el.className, fontSize: getComputedStyle(el).fontSize, ratio: (hi + 0.05) / (lo + 0.05), text: el.innerText };
  });
  drill.note(`measured: ${JSON.stringify(m)}`);
  drill.check(m.text === "Shopify title: Whey Gold Isolate, SKU: WGI-1KG", "the line shows Shopify's title and the SKU", m.text);
  drill.check(/\btext-fg-muted\b/.test(m.className) && !/\btext-fg-subtle\b/.test(m.className), "the line uses the muted text token", m.className);
  drill.check(m.ratio >= 4.5, `computed contrast is at least 4.5:1 (${m.ratio.toFixed(2)}:1, ${m.color} on ${m.background})`, m);
  await drill.screenshot(page, "order-shopify-line");
  await L.storeSql("live", [{ sql: "DELETE FROM order_items WHERE order_id = ?", args: [id] }, { sql: "DELETE FROM orders WHERE id = ?", args: [id] }]);
});
process.exit(code);
