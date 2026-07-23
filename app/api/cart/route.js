import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import {
  CART_COOKIE,
  emptyCart,
  getCart,
  createCart,
  addItem,
  setItemQty,
  removeItem,
  setCoupon,
  clearCart,
} from "@/lib/cart";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30 days
  secure: process.env.NODE_ENV === "production",
};

export async function GET(request) {
  const id = request.cookies.get(CART_COOKIE)?.value;
  const cart = id ? await getCart(id) : emptyCart();
  return NextResponse.json(cart);
}

export async function POST(request) {
  const limited = rateLimit(request, { name: "cart", limit: 60 });
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
  } catch (e) {
    return respond({ ...(await getCart(id)), error: String(e?.message || e) }, 400);
  }

  return respond(await getCart(id));
}
