// drill:checkout shared parts (Phase 8 step 0): the roles store's origin,
// stages and SQL come from drill:mobile-cart (and through it drill:themes and
// drill:apps); this file adds the drill's own starting state, the shopper's
// context and the order read-back. Lines 1, 2, 3 and 5 append to it.
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";
import { ORIGIN, rolesSql } from "../mobile-cart/lib.mjs";

export { ORIGIN, STAGES, consoleErrors, money, openStore, port, rolesSql, stage, state } from "../mobile-cart/lib.mjs";

// the shopper's own test address (cash on delivery only; never a card)
export const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Checkout Drill" };
export const ADDRESS = { line1: "1 Test Street", line2: "Flat 2", city: "Pune", state: "Maharashtra", pincode: "411001" };

// The drill's own starting state: no offer is on (so the totals are the
// product's price and the store's shipping), and one in-stock product to buy.
export async function seedStore() {
  await rolesSql(["UPDATE offers SET enabled = 0"]);
  const [[item]] = await rolesSql([
    "SELECT p.handle, p.title, v.id AS variant_id, v.price FROM products p JOIN variants v ON v.product_id = p.id WHERE v.available = 1 AND v.price > 0 ORDER BY p.handle, v.position LIMIT 1",
  ]);
  if (!item) throw new Error("the roles store has no in-stock product to buy");
  return item;
}

export const orderRow = async (id) => (await rolesSql([{ sql: "SELECT * FROM orders WHERE id = ?", args: [id] }]))[0][0] ?? null;

// The roles store's fixture pictures don't exist; Next's image route would 404.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));

export const shopperErrors = [];
// A desktop shopper with the cookie banner already answered (declined), so it covers nothing.
export async function shopper(drill) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  ctx.setDefaultTimeout(30_000);
  await stubImages(ctx);
  await ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => shopperErrors.push(String(e?.message || e).slice(0, 300)));
  page.on("console", (m) => {
    // React's dev-mode eval note, which drill:apps also expects
    if (m.type() === "error" && !/eval\(\) is not supported/.test(m.text())) shopperErrors.push(m.text().slice(0, 300));
  });
  return page;
}

export const flow = (page) => page.locator('[data-protected="checkout"]');
