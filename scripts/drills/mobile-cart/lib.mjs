// drill:mobile-cart shared parts (Phase 7 line 3): the roles store's origin,
// members and sign-in are drill:apps' own (through drill:themes' lib); this
// file adds the store's own SQL, the seeding (a sized product and the two
// offers the plan names), opening the store, and the phone shopper's context.
import { harnessPorts } from "../../design-harness.js";
import { ROLES_PROFILE } from "../../seed-roles-store.js";
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";
import { ORIGIN, open, signIn } from "../themes/lib.mjs";

export * from "../themes/lib.mjs";

export const HANDLE = "fixture-product-4";
export const TIER_TITLE = "Tee Tiers";
export const GIFT_TITLE = "Fixture product 1";
// the shopper's own test address (never a real card: the drill stops at the total)
export const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Mobile Cart Drill" };
export const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };

export async function rolesSql(statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: `http://127.0.0.1:${harnessPorts(process.env, ROLES_PROFILE).sqld.tenant}` });
  try {
    const out = [];
    for (const s of statements) out.push((await c.execute(s)).rows);
    return out;
  } finally {
    c.close();
  }
}

// The fixture product 4 (₹400, one variant) becomes a sized tee: Size S/M ×
// Colour Red/Blue, with S·Blue missing, so picking Blue on the default S
// leaves Size to choose. The offers the plan names: TIERED_QTY 2+ for 10% on
// it, FREE_GIFT over ₹999 (product 1 as the gift).
export async function seedStore() {
  const now = new Date().toISOString();
  const so = (size, colour) => JSON.stringify([{ name: "Size", value: size }, { name: "Colour", value: colour }]);
  const [[product]] = await rolesSql([{ sql: "SELECT id FROM products WHERE handle = ?", args: [HANDLE] }]);
  if (!product) throw new Error(`the roles store has no ${HANDLE}`);
  const [variant] = (await rolesSql([{ sql: "SELECT id FROM variants WHERE product_id = ? ORDER BY position LIMIT 1", args: [product.id] }]))[0];
  const [gift] = (await rolesSql(["SELECT p.id AS product_id, v.id AS variant_id FROM products p JOIN variants v ON v.product_id = p.id WHERE p.handle = 'fixture-product-1' LIMIT 1"]))[0];
  const variantRow = (id, size, colour, position) => ({
    sql: "INSERT OR REPLACE INTO variants (id, product_id, title, sku, price, compare_at_price, currency, available, selected_options, image_url, position) VALUES (?, ?, ?, ?, 400, 499, 'INR', 1, ?, NULL, ?)",
    args: [id, product.id, `${size} / ${colour}`, `MC-${size}${colour}`, so(size, colour), position],
  });
  const offer = (id, type, label, config) => ({
    sql: "INSERT OR REPLACE INTO offers (id, type, label, enabled, starts_at, ends_at, config, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, NULL, ?, ?, ?)",
    args: [id, type, label, JSON.stringify(config), now, now],
  });
  await rolesSql([
    { sql: "UPDATE products SET options = ?, price_min = 400, price_max = 400, compare_at_min = 499 WHERE id = ?", args: [JSON.stringify([{ name: "Size", values: ["S", "M"] }, { name: "Colour", values: ["Red", "Blue"] }]), product.id] },
    variantRow(variant.id, "S", "Red", 0),
    variantRow(`${variant.id}2`, "M", "Red", 1),
    variantRow(`${variant.id}3`, "M", "Blue", 2),
    offer("mc-tier", "TIERED_QTY", TIER_TITLE, { scope: "line", priority: 30, title: TIER_TITLE, target: { kind: "handle", value: HANDLE }, tiers: [{ minQty: 2, percent: 10 }] }),
    offer("mc-gift", "FREE_GIFT", "Free gift over ₹999", { scope: "gift", priority: 40, title: "Free gift over ₹999", threshold: 999, gift: { variantId: gift.variant_id, productId: gift.product_id, handle: "fixture-product-1", title: GIFT_TITLE, value: 100 } }),
  ]);
}

const docsApi = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);

// The roles store is closed until its first publish: the owner publishes a
// home page (and the design first-run made) through the documents API (drill:themes' render stage does the same).
export async function openStore(drill) {
  const owner = await signIn(drill, "owner");
  await stubImages(owner.context());
  await open(owner, "/admin");
  let home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  if (!home) {
    const made = await docsApi(owner, { createDocument: { type: "home", body: { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_mcdrill01", kind: "new", v: 1, enabled: true, settings: { title: "New arrivals", limit: 8 }, blocks: [] }] } } });
    drill.check(made.status === 200, "owner: a home page is made for the first publish", made.body?.error);
    home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  }
  // a first publish takes the design too when the store has one (first-run makes it)
  const design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  const set = [["doc_home", home], ["doc_design", design]].filter(([, d]) => d && !d.live).map(([id, d]) => ({ id, revision: d.revision, draftHash: d.draftHash }));
  if (set.length) {
    const published = await docsApi(owner, { publishSet: set });
    drill.check(published.status === 200, "owner: the home page (and design) are published (the store opens)", published.body?.error || published.body?.code);
  }
  await owner.context().close();
}

// The roles store's fixture pictures don't exist; Next's image route would 404.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));

export const shopperErrors = [];
// A phone: 390×844, touch, reduced motion (the bar must not slide), the cookie
// banner already answered (declined) so it covers nothing.
export async function phone(drill) {
  const ctx = await drill.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" });
  ctx.setDefaultTimeout(30_000);
  await stubImages(ctx);
  await ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => shopperErrors.push(String(e?.message || e).slice(0, 300)));
  page.on("console", (m) => {
    // the drill's own tampered checkout answers 409 on purpose
    // (and React's dev-mode eval note, which drill:apps also expects)
    if (m.type() === "error" && !/status of 409|eval\(\) is not supported/.test(m.text())) shopperErrors.push(m.text().slice(0, 300));
  });
  return page;
}

export const money = (s) => Number(String(s || "").replace(/[^\d.]/g, ""));
export const bar = (page) => page.locator('[data-protected="buy-bar"]');
export const drawer = (page) => page.locator('[data-protected="cart"]');
export const toBottom = (page) => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
