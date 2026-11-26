import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { requestOrigin } from "@/lib/origin-check";
import { CART_COOKIE } from "@/lib/cart";
import { db } from "@/lib/db";
import { consentById, verifyCartToken } from "@/lib/messaging/consent";

// Phase 9 line 3: the link in a WhatsApp cart reminder. The signed token
// carries a consent id only (no phone, no cart id); a valid one puts that
// consent's cart back in this browser's cart cookie and opens checkout. A bad
// or expired token, a consent revoked or erased since, or a cart that has
// already become an order just opens the store.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === "production" };

export const GET = tenantHandler(async (request, { params }) => {
  const { token } = await params;
  const origin = requestOrigin(request);
  const id = await verifyCartToken(String(token || ""));
  const consent = id ? await consentById(id) : null;
  const ordered = consent?.cart_id ? await db.selectFrom("orders").select("id").where("cart_id", "=", String(consent.cart_id)).executeTakeFirst() : null;
  if (!consent?.cart_id || consent.revoked_at || ordered) return NextResponse.redirect(new URL("/", origin), 303);
  const res = NextResponse.redirect(new URL("/checkout", origin), 303);
  res.cookies.set(CART_COOKIE, String(consent.cart_id), COOKIE_OPTS);
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
});
