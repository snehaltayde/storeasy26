import { sql } from "kysely";
import { db, libsql } from "./db.js";
import { numericId } from "./ids.js";
import { evaluateOffers, findCoupon } from "./offers/engine.js";
import { getActiveOffers } from "./offers/store.js";
import { offerProgress } from "./offers/progress.js";
import { computeShipping } from "./shipping.js";
import { currentTenant, tenantShippingConfig } from "./tenant-context.js";
import { shippingRatesChosen } from "./brand-tenants.js";
import { cartRows, giftRows, readEffective, effectiveExpr } from "./catalog/effective.js";
import { convertPrice, convertOffer, marketShipping, baseCurrency } from "./markets.js";
import { toMinor, fromMinor, roundMoney } from "./money.js";
import { hasColumns } from "./schema-compat.js";
import { subscriptionSettings, resolveSubscriptions, subscriptionOffer, eligibleFor, SUBSCRIPTION_OFFER_ID } from "./subscriptions/pricing.js";

export const CART_COOKIE = "cart_session";
const now = () => new Date().toISOString();

export function emptyCart() {
  return {
    id: null,
    items: [],
    subtotal: 0,
    count: 0,
    coupon: null,
    currency: "INR",
    appliedOffers: [],
    gifts: [],
    discountTotal: 0,
    total: 0,
    shipping: computeShipping({ subtotal: 0, discountTotal: 0 }),
    grandTotal: 0,
    couponStatus: null,
    progress: { nudges: [], unlocked: [] },
  };
}

export async function createCart(id) {
  const ts = now();
  await db
    .insertInto("carts")
    .values({ id, coupon_code: null, created_at: ts, updated_at: ts })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  return id;
}

async function touch(cartId) {
  await db.updateTable("carts").set({ updated_at: now() }).where("id", "=", cartId).execute();
}

// Read the cart and join line items onto the live catalog (current price/title/
// image/availability). Items normalise to full GIDs; lineTotal/subtotal/count
// are computed server-side so every surface agrees.
//
// Phase 8 line 4 (decision 15): `market` (lib/markets.js, null = the base
// market) prices the cart twice. The presentment run is what this returns at
// the top level: unit prices by convertPrice, offers by convertOffer, the
// market's shipping, every figure snapped to the currency's minor unit — the
// amounts the drawer shows and Razorpay charges. The base run, under `base`,
// is the same lines at catalog prices through the same offers the presentment
// run applied (so Shopify and the reports see the deal the shopper got, in base
// money). With no market nothing changes: no `base`, no `market` key.
// Phase 9 line 2 (0044): the subscription columns, read only where this
// database has them (MIG-05). One probe per database.
const SUB_LINE_COLUMNS = ["subscription_interval"];
const SUB_CART_COLUMNS = ["subscription_id", "subscription_cycle"];
export const subscriptionColumns = async () => (await hasColumns("cart_items", SUB_LINE_COLUMNS)) && (await hasColumns("carts", SUB_CART_COLUMNS));

// A cart's stored intervals (read with its lines) and, for a renewal cart, its
// subscription (one more statement, only for a renewal cart). The renewal holds
// only while the subscription is still on that cycle and not cancelled: once
// the cycle's order moves it on, the cart is an ordinary one.
//
// A renewal cart whose delivery no longer stands (skipped, paid for, moved on
// by the sweep, paused, cancelled or swapped away from) is stale: no line in
// it subscribes (it is priced one-time, so it can never start a second
// subscription) and, while it still holds a line it was built with, the
// checkout refuses it with RENEWAL_CHANGED.
async function cartSubscriptionState(cart, rows) {
  let intervals = new Map(rows.filter((r) => r.subscription_interval != null).map((r) => [r.variant_id, Number(r.subscription_interval)]));
  let renewal = null;
  let stale = false;
  if (cart.subscription_id) {
    const sub = await db.selectFrom("subscriptions").selectAll().where("id", "=", cart.subscription_id).executeTakeFirst();
    if (sub && sub.status === "active" && Number(sub.cycle) === Number(cart.subscription_cycle) && intervals.has(sub.variant_id)) renewal = { subscriptionId: sub.id, cycle: Number(sub.cycle), subscription: sub };
    else {
      stale = intervals.size > 0;
      intervals = new Map();
    }
  }
  return { intervals, renewal, stale };
}

export async function getCart(cartId, { market = null } = {}) {
  if (!cartId) return market ? { ...emptyCart(), currency: market.currency, market: market.id } : emptyCart();
  const subCols = await subscriptionColumns();
  const cart = await db
    .selectFrom("carts")
    .select(["id", "coupon_code", ...(subCols ? SUB_CART_COLUMNS : [])])
    .where("id", "=", cartId)
    .executeTakeFirst();
  if (!cart) return emptyCart();

  // P4-EFFECTIVE (OVL-03): the lines on the effective catalog — `title` is what
  // the shopper sees, `catalog_title` Shopify's raw title (lib/catalog/effective.js).
  const rows = await cartRows(cartId, { withInterval: subCols });
  return priceRows(cart, rows, { market, subs: await cartSubscriptionState(cart, rows) });
}

// Phase 9 line 2: what a subscription's next delivery costs today, priced by
// the same code as its renewal cart (no cart is written): the subscription's
// variant and quantity at today's catalog price, its locked percent, today's
// offers and the store's shipping, no coupon, base market.
export async function previewRenewal(sub) {
  return (await previewRenewals([sub]))[0];
}

// Many at once (the console's list): one catalog read for every variant, one
// offers read and one settings read, then each priced in memory.
export async function previewRenewals(subs) {
  if (!subs.length) return [];
  const all = await variantRows([...new Set(subs.map((s) => s.variant_id))].map((variantId) => ({ variantId, quantity: 1 })));
  const byVariant = new Map(all.map((r) => [r.variant_id, r]));
  const ctx = { storedOffers: await getActiveOffers(), settings: await subscriptionSettings() };
  const out = [];
  for (const sub of subs) {
    const row = byVariant.get(sub.variant_id);
    const rows = row ? [{ ...row, quantity: Number(sub.quantity) }] : [];
    const renewal = { subscriptionId: sub.id, cycle: Number(sub.cycle), subscription: sub };
    out.push(await priceRows({ id: null, coupon_code: null }, rows, { market: null, subs: { intervals: new Map([[sub.variant_id, Number(sub.interval_days)]]), renewal }, ctx }));
  }
  return out;
}

// cartRows' shape for lines that are in no cart (previewRenewal).
async function variantRows(lines) {
  const ids = lines.map((l) => l.variantId);
  if (!ids.length) return [];
  const qty = new Map(lines.map((l) => [l.variantId, l.quantity]));
  const rows = await readEffective(async (live) => {
    let q = db.selectFrom("variants as v").innerJoin("products as p", "p.id", "v.product_id");
    if (live) q = q.leftJoin("product_content_live as c", "c.product_id", "p.id");
    return q
      .where("v.id", "in", ids)
      .select(["v.id as variant_id", "v.product_id", "v.title as variant_title", "v.sku", "v.price", "v.currency as v_currency", "v.image_url", "v.available", "p.handle", "p.currency as p_currency"])
      .select(["title", "catalog_title", "featured_image", "logic_tags", "logic_type"].map((n) => effectiveExpr(n, live).as(n)))
      .select(sql`(SELECT json_group_array(k.handle) FROM collection_products cp JOIN collections k ON k.id = cp.collection_id WHERE cp.product_id = p.id)`.as("collections"))
      .execute();
  });
  const tags = (v) => {
    try {
      const t = JSON.parse(v ?? "[]");
      return Array.isArray(t) ? t.map(String) : [];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({ ...r, quantity: qty.get(r.variant_id), price_at_add: null, logic_tags: tags(r.logic_tags), collections: tags(r.collections) }));
}

async function priceRows(cart, rows, { market, subs, ctx = null }) {
  const items = rows.map((r) => {
    const price = market ? convertPrice(Number(r.price) || 0, market) : Number(r.price) || 0;
    const priceAtAdd = r.price_at_add == null ? null : market ? convertPrice(Number(r.price_at_add), market) : Number(r.price_at_add);
    const currency = market ? market.currency : r.v_currency || r.p_currency || "INR";
    return {
      variantId: r.variant_id,
      productId: r.product_id,
      variantNumericId: numericId(r.variant_id),
      handle: r.handle,
      title: r.title,
      // OVL-06: Shopify's own title and the SKU, frozen onto the order so the
      // founder can find the line in Shopify. Always the RAW catalog title
      // (p.title in lib/catalog/effective.js cartRows), never the line's title.
      catalog_title: r.catalog_title,
      sku: r.sku || null,
      variantTitle: r.variant_title,
      priceAtAdd,
      image: r.image_url || r.featured_image || null,
      price,
      currency,
      quantity: r.quantity,
      // a market line in integer minor units: unit price × quantity, exactly
      lineTotal: market ? fromMinor(toMinor(price, currency) * r.quantity, currency) : price * r.quantity,
      basePrice: Number(r.price) || 0,
      available: !!r.available,
      // engine-only fields (stripped from the response below): Shopify's RAW
      // type and tags, so a display type never changes which offers apply
      productType: r.logic_type || null,
      tags: r.logic_tags,
      collections: r.collections || [],
    };
  });

  // Re-run the pure offer engine on every cart read → live recompute, with
  // the CURRENT DB-configured offers (Session 19: admin edits apply on the
  // very next read — no deploy, no cache).
  // Phase 9 line 2: a stored row can never be a SUBSCRIPTION offer (the
  // validator has no such type; this drops one anyway). The subscription offer
  // is built here, from the plugin's settings and the lines' stored intervals.
  const storedOffers = (ctx ? ctx.storedOffers : await getActiveOffers()).filter((o) => o.type !== "SUBSCRIPTION" && o.id !== SUBSCRIPTION_OFFER_ID);
  const settings = subs.intervals.size ? (ctx ? ctx.settings : await subscriptionSettings()) : null;
  const subscribed = resolveSubscriptions({ items, intervals: subs.intervals, renewal: subs.renewal, settings, market });
  const subOffer = subscriptionOffer(subscribed.lines);
  const round = market ? (n) => roundMoney(n, market.currency) : null;
  const activeOffers = [...(subOffer ? [subOffer] : []), ...(market ? storedOffers.map((o) => convertOffer(o, market)) : storedOffers)];
  const offers = evaluateOffers(items, { offers: activeOffers, coupon: cart.coupon_code, ...(round ? { round } : {}) });
  // an exclusive code switches line offers off, the subscriber discount with them
  // (decision: like a bundle); the line still subscribes, at its locked percent
  const exclusive = Boolean(offers.couponStatus?.valid && findCoupon(cart.coupon_code, activeOffers)?.combinable === false);
  const gifts = await giftLines(offers.gifts);

  // Drawer-facing shipping ESTIMATE (prepaid, no pincode). The checkout API
  // recomputes with the chosen payment method + pincode — same pure engine,
  // so the number the user watched is the number they're charged.
  const shippingConfig = market ? marketShipping(market, tenantShippingConfig()) : tenantShippingConfig();
  const shipping = computeShipping({
    subtotal: offers.subtotal,
    discountTotal: offers.discountTotal,
    paymentMethod: "prepaid",
    config: shippingConfig,
  });
  const ratesSet = shippingRatesChosen(currentTenant());

  return {
    id: cart.id,
    coupon: cart.coupon_code || null,
    items: items.map((i) => ({
      variantId: i.variantId,
      productId: i.productId,
      variantNumericId: i.variantNumericId,
      handle: i.handle,
      title: i.title,
      catalog_title: i.catalog_title,
      sku: i.sku,
      variantTitle: i.variantTitle,
      image: i.image,
      price: i.price,
      currency: i.currency,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
      available: i.available,
      discount: offers.lineDiscounts[i.variantId] || 0,
      // Phase 9 line 2: { interval, percent, active } for a line the shopper
      // chose to subscribe; active false = priced one-time (subscriptions off,
      // the product no longer eligible, or outside the base market)
      // (only on such a line: every other line keeps its exact shape)
      ...(subscribed.perItem.has(i.variantId) ? { subscription: { ...subscribed.perItem.get(i.variantId), applied: subscribed.perItem.get(i.variantId).active && !exclusive } } : {}),
    })),
    // Phase 9 line 2: checkout needs a signed-in shopper and the base market
    // when any line would be subscribed; a renewal cart names its cycle. Only
    // on such a cart: a cart without subscriptions answers exactly as before.
    ...(subscribed.wanted > 0 ? { hasSubscription: true } : {}),
    ...(subs.renewal ? { renewal: { subscriptionId: subs.renewal.subscriptionId, cycle: subs.renewal.cycle } } : {}),
    ...(subs.stale ? { renewalStale: true } : {}),
    // S32 (SF06): acknowledge, don't hide — lines whose live catalog state
    // moved since the shopper added them. Totals already use CURRENT prices;
    // this tells the shopper what changed under them.
    changes: items.flatMap((i) => {
      const out = [];
      if (!i.available) out.push({ variantId: i.variantId, title: i.title, kind: "unavailable" });
      if (i.priceAtAdd != null && Number(i.priceAtAdd) !== Number(i.price)) {
        out.push({ variantId: i.variantId, title: i.title, kind: "price_changed", from: Number(i.priceAtAdd), to: Number(i.price) });
      }
      return out;
    }),
    subtotal: offers.subtotal,
    count: items.reduce((s, i) => s + i.quantity, 0),
    currency: market ? market.currency : items[0]?.currency || "INR",
    appliedOffers: offers.appliedOffers,
    gifts,
    discountTotal: offers.discountTotal,
    total: offers.total, // goods total (post-discount, pre-shipping)
    shipping, // prepaid estimate { label, total, free, remainingForFree, … }
    // GEN-03: did this store choose these rates? Display only: the amounts above
    // are computed the same either way.
    shippingRatesSet: ratesSet,
    grandTotal: market ? roundMoney(offers.total + shipping.total, market.currency) : offers.total + shipping.total,
    couponStatus: offers.couponStatus,
    // Phase 7 line 3: the drawer's nudges, computed here from the same lines,
    // offers and coupon the engine just priced; each one is proved against the
    // engine before it is listed (lib/offers/progress.js). No request carries
    // it. Free shipping is promised only when the store chose its rates
    // (GEN-03). An applied gift is named by its line's title (the founder's
    // published one); a gift not yet reached by the offer's stored title, so
    // the read costs no extra statement.
    progress: offerProgress(items, {
      offers: activeOffers,
      coupon: cart.coupon_code,
      result: offers,
      shippingConfig: ratesSet ? shippingConfig : null,
      giftTitles: new Map(gifts.map((g) => [g.variantId, g.title])),
      ...(round ? { round } : {}),
    }),
    ...(market ? { market: market.id, base: baseRun(items, storedOffers, offers, cart.coupon_code) } : {}),
  };
}

// The base run (decision 15): catalog prices through the offers the presentment
// run applied, and only those. A threshold that converted across a line (a gift
// or a code's minimum reached in USD but not in rupees, or the other way) can't
// make Shopify's order differ from the one the shopper was shown: an applied
// coupon's minimum is lifted here, an applied gift is given, and an offer the
// shopper didn't get is left out.
function baseRun(items, storedOffers, presented, coupon) {
  const applied = new Set(presented.appliedOffers.map((a) => a.id));
  const offers = storedOffers
    .filter((o) => applied.has(o.id))
    .map((o) => ({ ...o, ...(o.minSubtotal != null ? { minSubtotal: 0 } : {}), ...(o.type === "FREE_GIFT" ? { threshold: -1 } : {}) }));
  const lines = items.map((i) => ({ ...i, price: i.basePrice, lineTotal: i.basePrice * i.quantity, currency: undefined }));
  const r = evaluateOffers(lines, { offers, coupon: presented.couponStatus?.valid ? coupon : null });
  const currency = baseCurrency(currentTenant()?.config) || "INR";
  return {
    currency,
    items: lines.map((i) => ({ variantId: i.variantId, price: i.price, quantity: i.quantity, lineTotal: i.lineTotal, discount: r.lineDiscounts[i.variantId] || 0 })),
    appliedOffers: r.appliedOffers,
    subtotal: r.subtotal,
    discountTotal: r.discountTotal,
    total: r.total,
  };
}

// P4-EFFECTIVE (OVL-03, OVL-06): a gift line is resolved by its variant through
// lib/catalog/effective.js. When the founder has published a title for that
// product, the gift line shows it, as every other line and page does, instead
// of the title the offer stored when it was set up (lib/offers/engine.js keeps
// that snapshot). Without one, the stored title stays, so a store with no
// published titles shows exactly what it showed before. The line also carries
// Shopify's title and the SKU for the order (OVL-06). A gift whose variant is
// not in the catalog keeps its stored title, with no Shopify title or SKU.
// One statement, only when a gift applies.
async function giftLines(gifts) {
  if (!gifts?.length) return [];
  const byVariant = new Map((await giftRows(gifts.map((g) => g.variantId))).map((r) => [r.variant_id, r]));
  return gifts.map((g) => {
    const r = byVariant.get(g.variantId);
    if (!r) return { ...g, catalog_title: null, sku: null };
    return { ...g, title: r.live_title ?? g.title, catalog_title: r.catalog_title ?? null, sku: r.sku || null };
  });
}

// P4-EFFECTIVE (OVL-06, plan decision 13, OQ-7): the cart a browser may see.
// catalog_title and sku are for matching an order in Shopify; they stay on the
// server (createOrder reads the full getCart) and are stripped from every cart
// that reaches a browser: the /api/cart responses, the storefront layout's
// initial cart, the checkout page's prop and the checkout API's answers.
const SERVER_ONLY_LINE_KEYS = ["catalog_title", "sku"];
const stripLine = (line) => {
  if (!line || typeof line !== "object") return line;
  const out = { ...line };
  for (const k of SERVER_ONLY_LINE_KEYS) delete out[k];
  return out;
};
// Phase 8 line 4: the base run stays on the server too (the browser shows the
// market's money only).
export function shopperCart(cart) {
  if (!cart || typeof cart !== "object") return cart;
  const { base: _base, ...rest } = cart;
  return {
    ...rest,
    ...(Array.isArray(rest.items) ? { items: rest.items.map(stripLine) } : {}),
    ...(Array.isArray(cart.gifts) ? { gifts: cart.gifts.map(stripLine) } : {}),
  };
}

// Phase 9 line 2: the interval a line is stored with. Only an interval the
// store offers, on an eligible product, in the base market, with subscriptions
// on; anything else is stored as one-time (null), never refused. A variant is
// one or the other in a cart: adding it again stores the latest choice.
async function storedInterval(productId, interval, market) {
  const days = Number(interval);
  if (interval == null || market || !Number.isInteger(days)) return null;
  const settings = await subscriptionSettings();
  if (!settings || !settings.intervals.includes(days)) return null;
  const p = await db.selectFrom("products").select(["tags"]).where("id", "=", productId).executeTakeFirst();
  let tags = [];
  try {
    tags = JSON.parse(p?.tags ?? "[]");
  } catch {
    tags = [];
  }
  return eligibleFor(settings, tags) ? days : null;
}

export async function addItem(cartId, variantId, quantity = 1, { subscriptionInterval = null, market = null } = {}) {
  const qty = Math.max(1, Number(quantity) || 1);
  // Resolve product_id from the catalog — enforces a valid variant and the
  // canonical GID pairing (variant_id ↔ product_id).
  const variant = await db
    .selectFrom("variants")
    .select(["id", "product_id", "price"])
    .where("id", "=", variantId)
    .executeTakeFirst();
  if (!variant) throw new Error(`variant not in catalog: ${variantId}`);
  const subCols = await subscriptionColumns();
  const interval = subCols ? await storedInterval(variant.product_id, subscriptionInterval, market) : null;

  await db
    .insertInto("cart_items")
    .values({
      cart_id: cartId,
      variant_id: variant.id,
      product_id: variant.product_id,
      quantity: qty,
      // S32 (SF06): the price the shopper saw — reference for the change notice
      price_at_add: Number(variant.price) || null,
      added_at: now(),
      ...(subCols ? { subscription_interval: interval } : {}),
    })
    .onConflict((oc) =>
      oc.columns(["cart_id", "variant_id"]).doUpdateSet({ quantity: sql`quantity + ${qty}`, ...(subCols ? { subscription_interval: interval } : {}) }),
    )
    .execute();
  await touch(cartId);
}

// Atomic batch cart add (Phase 1.2 / OQ-G): validates EVERY requested variant
// before writing, then upserts all cart_items + touches the cart in ONE write
// batch so a bundle never lands half-added if one variant is missing or invalid.
const MAX_BATCH_ITEMS = 25;
export async function addItems(cartId, rawItems, { requireAvailable = false } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("addItems requires a non-empty items array");
  }
  if (rawItems.length > MAX_BATCH_ITEMS) {
    throw new Error(`addItems accepts at most ${MAX_BATCH_ITEMS} items`);
  }
  const merged = new Map();
  for (const item of rawItems) {
    const vid = typeof item?.variantId === "string" ? item.variantId.trim() : "";
    if (!vid) throw new Error("each item requires a variantId");
    const qty = Math.floor(Number(item?.quantity ?? 1));
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      throw new Error(`invalid quantity for ${vid}`);
    }
    merged.set(vid, (merged.get(vid) || 0) + qty);
  }
  const variantIds = [...merged.keys()];
  const rows = await db
    .selectFrom("variants")
    .select(["id", "product_id", "price", "available"])
    .where("id", "in", variantIds)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const vid of variantIds) {
    const v = byId.get(vid);
    if (!v) throw new Error(`variant not in catalog: ${vid}`);
    if (requireAvailable && !v.available) throw new Error(`variant unavailable: ${vid}`);
  }

  const ts = now();
  const stmts = variantIds.map((vid) => {
    const v = byId.get(vid);
    const qty = merged.get(vid);
    return {
      sql: `INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, price_at_add, added_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      args: [cartId, v.id, v.product_id, qty, Number(v.price) || null, ts],
    };
  });
  stmts.push({
    sql: "UPDATE carts SET updated_at = ? WHERE id = ?",
    args: [ts, cartId],
  });
  await libsql.batch(stmts, "write");
}

export async function setItemQty(cartId, variantId, quantity) {
  const qty = Number(quantity) || 0;
  if (qty <= 0) return removeItem(cartId, variantId);
  await db
    .updateTable("cart_items")
    .set({ quantity: qty })
    .where("cart_id", "=", cartId)
    .where("variant_id", "=", variantId)
    .execute();
  await touch(cartId);
}

export async function removeItem(cartId, variantId) {
  await db
    .deleteFrom("cart_items")
    .where("cart_id", "=", cartId)
    .where("variant_id", "=", variantId)
    .execute();
  await touch(cartId);
}

export async function setCoupon(cartId, code) {
  const coupon = code ? String(code).trim().toUpperCase().slice(0, 40) || null : null;
  await db
    .updateTable("carts")
    .set({ coupon_code: coupon, updated_at: now() })
    .where("id", "=", cartId)
    .execute();
}

export async function clearCart(cartId) {
  await db.deleteFrom("cart_items").where("cart_id", "=", cartId).execute();
  await db
    .updateTable("carts")
    .set({ coupon_code: null, updated_at: now() })
    .where("id", "=", cartId)
    .execute();
}
