import { NextResponse } from "next/server";
import { rateLimitAsync } from "@/lib/rate-limit";
import { storefrontHandler } from "@/lib/storefront-request";
import {
  CART_COOKIE,
  emptyCart,
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

export const runtime = "edge";

// P4-EFFECTIVE (OVL-06, plan decision 13): every cart this route answers with
// is the shopper's projection: Shopify's title and the SKU stay on the server.
const getCart = async (id) => shopperCart(await fullCart(id));
export const dynamic = "force-dynamic";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30 days
  secure: process.env.NODE_ENV === "production",
};

export const GET = storefrontHandler(async (request) => {
  const id = request.cookies.get(CART_COOKIE)?.value;
  const cart = id ? await getCart(id) : emptyCart();
  return NextResponse.json(cart);
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

  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "add":
        await addItem(id, body.variantId, body.quantity ?? 1);
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

  return respond(await getCart(id));
});
