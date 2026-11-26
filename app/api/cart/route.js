import { NextResponse } from "next/server";
import { rateLimitAsync } from "@/lib/rate-limit";
import { storefrontHandler } from "@/lib/storefront-request";
import { requestMarket } from "@/lib/market-request";
import {
  CART_COOKIE,
  getCart as fullCart,
  shopperCart,
  createCart,
  addItem,
  addItems,
  setItemQty,
  removeItem,
  setCoupon,
  clearCart,
} from "@/lib/cart";
import { productSubscribeOffer } from "@/lib/subscriptions/pricing";
import { HELD_CART_COOKIE, CART_COOKIE_OPTS } from "@/lib/subscriptions/held-cart";

export const runtime = "edge";

// P4-EFFECTIVE (OVL-06, plan decision 13): every cart this route answers with
// is the shopper's projection: Shopify's title and the SKU stay on the server.
// Phase 8 line 4: priced in this request's market (the presentment run).
const cartFor = (request) => async (id) => shopperCart(await fullCart(id || null, { market: requestMarket(request).market }));

// Phase 9 line 2 review: while a renewal cart holds the drawer, the shopper's
// own cart waits in HELD_CART_COOKIE ("heldCart" tells the drawer). Once the
// renewal no longer stands (placed, skipped, cancelled, moved on) or the
// shopper empties it, the held cart comes back: answered and cookied here.
async function withHeld(request, id, cart) {
  const held = request.cookies.get(HELD_CART_COOKIE)?.value;
  if (!held || held === id) return { id, cart, restored: false };
  if (cart.renewal && cart.items.length) return { id, cart: { ...cart, heldCart: true }, restored: false };
  return { id: held, cart: await cartFor(request)(held), restored: true };
}
const heldCookies = (res, restored, id) => {
  if (!restored) return res;
  res.cookies.set(CART_COOKIE, id, CART_COOKIE_OPTS);
  res.cookies.set(HELD_CART_COOKIE, "", { ...CART_COOKIE_OPTS, maxAge: 0 });
  return res;
};
export const dynamic = "force-dynamic";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30 days
  secure: process.env.NODE_ENV === "production",
};

// Phase 9 line 2: GET ?subscribe=<product id> answers the product page's
// subscribe choice (prices from the server; null when it can't be offered).
export const GET = storefrontHandler(async (request) => {
  const product = new URL(request.url).searchParams.get("subscribe");
  if (product != null) return NextResponse.json({ offer: await productSubscribeOffer(product.slice(0, 200), { market: requestMarket(request).market }) });
  const id = request.cookies.get(CART_COOKIE)?.value;
  const h = await withHeld(request, id, await cartFor(request)(id));
  return heldCookies(NextResponse.json(h.cart), h.restored, h.id);
});

export const POST = storefrontHandler(async (request) => {
  const limited = await rateLimitAsync(request, { name: "cart", limit: 60 });
  if (limited) return limited;
  let id = request.cookies.get(CART_COOKIE)?.value;
  const isNew = !id;
  if (isNew) {
    id = crypto.randomUUID();
    await createCart(id);
  }

  const respond = (payload, status = 200) => {
    const res = NextResponse.json(payload, { status });
    if (isNew) res.cookies.set(CART_COOKIE, id, COOKIE_OPTS);
    return res;
  };

  const getCart = cartFor(request);
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "add":
        // Phase 9 line 2: only the interval is read; the server decides whether it applies
        await addItem(id, body.variantId, body.quantity ?? 1, { subscriptionInterval: body.subscriptionInterval ?? null, market: requestMarket(request).market });
        break;
      case "add_many":
        await addItems(id, body.items, { requireAvailable: Boolean(body.requireAvailable) });
        break;
      case "setQty":
        await setItemQty(id, body.variantId, body.quantity);
        break;
      case "remove":
        await removeItem(id, body.variantId);
        break;
      case "setCoupon":
        await setCoupon(id, body.coupon ?? null);
        break;
      case "clear":
        await clearCart(id);
        break;
      default:
        return respond({ ...(await getCart(id)), error: "unknown action" }, 400);
    }
  } catch {
    // GEN-03: no raw error text in a public response; the 400 is the signal.
    return respond(await getCart(id), 400);
  }

  const h = await withHeld(request, id, await getCart(id));
  return heldCookies(respond(h.cart), h.restored, h.id);
});
