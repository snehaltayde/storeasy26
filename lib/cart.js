import { sql } from "kysely";
import { db } from "./db.js";
import { numericId } from "./ids.js";
import { evaluateOffers } from "./offers/engine.js";

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
    discountTotal: 0,
    total: 0,
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

  const rows = await db
    .selectFrom("cart_items as ci")
    .innerJoin("variants as v", "v.id", "ci.variant_id")
    .innerJoin("products as p", "p.id", "ci.product_id")
    .where("ci.cart_id", "=", cartId)
    .select([
      "ci.variant_id",
      "ci.product_id",
      "ci.quantity",
      "v.title as variant_title",
      "v.price",
      "v.currency as v_currency",
      "v.image_url",
      "v.available",
      "p.title as product_title",
      "p.handle",
      "p.featured_image",
      "p.currency as p_currency",
      "p.tags",
      "p.product_type",
    ])
    .orderBy("ci.added_at", "asc")
    .execute();

  const items = rows.map((r) => {
    const price = Number(r.price) || 0;
    const currency = r.v_currency || r.p_currency || "INR";
    let tags = [];
    try {
      tags = JSON.parse(r.tags || "[]");
    } catch {
      tags = [];
    }
    return {
      variantId: r.variant_id,
      productId: r.product_id,
      variantNumericId: numericId(r.variant_id),
      handle: r.handle,
      title: r.product_title,
      variantTitle: r.variant_title,
      image: r.image_url || r.featured_image || null,
      price,
      currency,
      quantity: r.quantity,
      lineTotal: price * r.quantity,
      available: !!r.available,
      // engine-only fields (stripped from the response below)
      productType: r.product_type || null,
      tags,
    };
  });

  // Re-run the pure offer engine on every cart read → live recompute.
  const offers = evaluateOffers(items);

  return {
    id: cart.id,
    coupon: cart.coupon_code || null,
    items: items.map((i) => ({
      variantId: i.variantId,
      productId: i.productId,
      variantNumericId: i.variantNumericId,
      handle: i.handle,
      title: i.title,
      variantTitle: i.variantTitle,
      image: i.image,
      price: i.price,
      currency: i.currency,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
      available: i.available,
      discount: offers.lineDiscounts[i.variantId] || 0,
    })),
    subtotal: offers.subtotal,
    count: items.reduce((s, i) => s + i.quantity, 0),
    currency: items[0]?.currency || "INR",
    appliedOffers: offers.appliedOffers,
    discountTotal: offers.discountTotal,
    total: offers.total,
  };
}

export async function addItem(cartId, variantId, quantity = 1) {
  const qty = Math.max(1, Number(quantity) || 1);
  // Resolve product_id from the catalog — enforces a valid variant and the
  // canonical GID pairing (variant_id ↔ product_id).
  const variant = await db
    .selectFrom("variants")
    .select(["id", "product_id"])
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
      added_at: now(),
    })
    .onConflict((oc) =>
      oc.columns(["cart_id", "variant_id"]).doUpdateSet({ quantity: sql`quantity + ${qty}` }),
    )
    .execute();
  await touch(cartId);
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
