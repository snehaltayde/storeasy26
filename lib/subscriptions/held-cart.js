// Phase 9 line 2 review: "Pay for this delivery" moves the cart cookie to a
// renewal cart; the shopper's own cart id waits in a second cookie and comes
// back once the renewal order is placed (COD, or a verified online payment)
// or the renewal no longer stands (the cart route). Edge-safe.
import { CART_COOKIE } from "../cart.js";

export const HELD_CART_COOKIE = "cart_held";
export const CART_COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === "production" };

// On `res`: the cart cookie back to the held cart and the held cookie gone,
// when `cart` was a renewal and a cart is held. → res
export function restoreHeldCart(request, res, cart) {
  const held = request.cookies.get(HELD_CART_COOKIE)?.value;
  if (!held || !cart?.renewal || !res?.cookies) return res;
  if (res.status >= 400) return res;
  res.cookies.set(CART_COOKIE, held, CART_COOKIE_OPTS);
  res.cookies.set(HELD_CART_COOKIE, "", { ...CART_COOKIE_OPTS, maxAge: 0 });
  return res;
}
