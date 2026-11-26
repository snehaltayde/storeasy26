import { NextResponse } from "next/server";
import { storefrontHandler } from "@/lib/storefront-request";
import { rateLimitAsync } from "@/lib/rate-limit";
import { sameOrigin } from "@/lib/origin-check";
import { CART_COOKIE } from "@/lib/cart";
import { CUSTOMER_COOKIE, customerFromToken } from "@/lib/customers";
import { ConsentError, grantConsent, revokeConsent } from "@/lib/messaging/consent";

// Phase 9 line 3: the checkout's WhatsApp boxes (components/checkout/WhatsAppConsent.js).
//   POST { purpose: "updates" | "marketing", granted: boolean, phone?, country? }
// The consent is bound to the cart cookie (and the signed-in shopper, if any),
// never to an id in the body; no cart cookie → 400. 10 per 10 minutes.
// The words recorded are the server's own (lib/messaging/wording.js).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = storefrontHandler(async (request) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: "This request isn't allowed." }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "wa-consent", limit: 10, windowMs: 10 * 60_000 });
  if (limited) return limited;
  const cart = request.cookies.get(CART_COOKIE)?.value || null;
  if (!cart) return NextResponse.json({ error: "Add something to your cart first." }, { status: 400 });
  const customer = await customerFromToken(request.cookies.get(CUSTOMER_COOKIE)?.value).catch(() => null);
  const body = await request.json().catch(() => ({}));
  const purpose = String(body?.purpose ?? "");
  try {
    if (body?.granted === true) {
      await grantConsent({ purpose, phone: body.phone, country: String(body.country || "IN"), cartId: cart, customerId: customer?.id ?? null, source: "checkout" });
      return NextResponse.json({ ok: true, granted: true });
    }
    if (body?.granted === false) {
      await revokeConsent({ purpose, cartId: cart, via: "checkout" });
      return NextResponse.json({ ok: true, granted: false });
    }
    return NextResponse.json({ error: "Choose yes or no." }, { status: 400 });
  } catch (e) {
    if (e instanceof ConsentError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
