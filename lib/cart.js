import { sql } from "kysely";
import { db, libsql } from "./db.js";
import { numericId } from "./ids.js";
import { evaluateOffers } from "./offers/engine.js";
import { getActiveOffers } from "./offers/store.js";
import { computeShipping } from "./shipping.js";
import { currentTenant, tenantShippingConfig } from "./tenant-context.js";
import { shippingRatesChosen } from "./brand-tenants.js";
import { cartRows, giftRows } from "./catalog/effective.js";

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
export async function getCart(cartId) {
  if (!cartId) return emptyCart();
  const cart = await db
    .selectFrom("carts")
    .select(["id", "coupon_code"])
    .where("id", "=", cartId)
    .executeTakeFirst();
  if (!cart) return emptyCart();

  // P4-EFFECTIVE (OVL-03): the lines on the effective catalog — `title` is what
  // the shopper sees, `catalog_title` Shopify's raw title (lib/catalog/effective.js).
  const rows = await cartRows(cartId);

  const items = rows.map((r) => {
    const price = Number(r.price) || 0;
    const priceAtAdd = r.price_at_add == null ? null : Number(r.price_at_add);
    const currency = r.v_currency || r.p_currency || "INR";
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
      lineTotal: price * r.quantity,
      available: !!r.available,
      // engine-only fields (stripped from the response below): Shopify's RAW
      // type and tags, so a display type never changes which offers apply
      productType: r.logic_type || null,
      tags: r.logic_tags,
    };
  });

  // Re-run the pure offer engine on every cart read → live recompute, with
  // the CURRENT DB-configured offers (Session 19: admin edits apply on the
  // very next read — no deploy, no cache).
  const activeOffers = await getActiveOffers();
  const offers = evaluateOffers(items, { offers: activeOffers, coupon: cart.coupon_code });
  const gifts = await giftLines(offers.gifts);

  // Drawer-facing shipping ESTIMATE (prepaid, no pincode). The checkout API
  // recomputes with the chosen payment method + pincode — same pure engine,
  // so the number the user watched is the number they're charged.
  const shipping = computeShipping({
    subtotal: offers.subtotal,
    discountTotal: offers.discountTotal,
    paymentMethod: "prepaid",
    config: tenantShippingConfig(),
  });

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
    })),
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
    currency: items[0]?.currency || "INR",
    appliedOffers: offers.appliedOffers,
    gifts,
    discountTotal: offers.discountTotal,
    total: offers.total, // goods total (post-discount, pre-shipping)
    shipping, // prepaid estimate { label, total, free, remainingForFree, … }
    // GEN-03: did this store choose these rates? Display only: the amounts above
    // are computed the same either way.
    shippingRatesSet: shippingRatesChosen(currentTenant()),
    grandTotal: offers.total + shipping.total,
    couponStatus: offers.couponStatus,
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
export function shopperCart(cart) {
  if (!cart || typeof cart !== "object") return cart;
  return {
    ...cart,
    ...(Array.isArray(cart.items) ? { items: cart.items.map(stripLine) } : {}),
    ...(Array.isArray(cart.gifts) ? { gifts: cart.gifts.map(stripLine) } : {}),
  };
}

export async function addItem(cartId, variantId, quantity = 1) {
  const qty = Math.max(1, Number(quantity) || 1);
  // Resolve product_id from the catalog — enforces a valid variant and the
  // canonical GID pairing (variant_id ↔ product_id).
  const variant = await db
    .selectFrom("variants")
    .select(["id", "product_id", "price"])
    .where("id", "=", variantId)
    .executeTakeFirst();
  if (!variant) throw new Error(`variant not in catalog: ${variantId}`);

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
    })
    .onConflict((oc) =>
      oc.columns(["cart_id", "variant_id"]).doUpdateSet({ quantity: sql`quantity + ${qty}` }),
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
