import { NextResponse } from "next/server";
import { storefrontHandler } from "@/lib/storefront-request";
import { rateLimitAsync } from "@/lib/rate-limit";
import { sameOrigin } from "@/lib/origin-check";
import { CART_COOKIE } from "@/lib/cart";
import { CUSTOMER_COOKIE, customerFromToken } from "@/lib/customers";
import { maskPhone } from "@/lib/checkout/cod-otp";
import { ConsentError, cartState, grantConsent, marketingPhoneCapped, revokeConsent, syncCart } from "@/lib/messaging/consent";

// Phase 9 line 3: the checkout's WhatsApp boxes (components/checkout/WhatsAppConsent.js).
//   GET  → { ok, updates, marketing, phone }: what is live on this cart (phone masked)
//   POST { purpose: "updates" | "marketing", granted: boolean, phone?, country? }
//   POST { sync: true, phone, country? }: the phone typed now; any live consent
//        on this cart for another number is withdrawn
//   Every POST answers the GET's shape.
// The consent is bound to the cart cookie (and the signed-in shopper, if any),
// never to an id in the body; no cart cookie → 400. Ticks 10 per 10 minutes;
// syncs (withdraw only) 60 per 10 minutes, counted apart.
// P9-B: a marketing tick is also capped at 3 per IP per day (across carts) and
// a phone at 2 carts' marketing consents per 7 days; past either cap the tick
// answers as usual and writes nothing.
// The words recorded are the server's own (lib/messaging/wording.js).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const answer = (st) => NextResponse.json({ ok: true, updates: st.updates, marketing: st.marketing, phone: st.phone ? maskPhone(st.phone) : null });

export const GET = storefrontHandler(async (request) => {
  const cart = request.cookies.get(CART_COOKIE)?.value || null;
  return answer(cart ? await cartState(cart) : { updates: false, marketing: false, phone: null });
});

export const POST = storefrontHandler(async (request) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: "This request isn't allowed." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  // a sync only ever withdraws, and runs as the phone is typed: its own allowance
  const sync = body?.sync === true;
  const limited = await rateLimitAsync(request, sync ? { name: "wa-consent-sync", limit: 60, windowMs: 10 * 60_000 } : { name: "wa-consent", limit: 10, windowMs: 10 * 60_000 });
  if (limited) return limited;
  const cart = request.cookies.get(CART_COOKIE)?.value || null;
  if (!cart) return NextResponse.json({ error: "Add something to your cart first." }, { status: 400 });
  const customer = await customerFromToken(request.cookies.get(CUSTOMER_COOKIE)?.value).catch(() => null);
  const purpose = String(body?.purpose ?? "");
  try {
    if (sync) return answer(await syncCart(cart, body.phone, String(body.country || "IN")));
    if (body?.granted === true) {
      if (purpose === "marketing") {
        const country = String(body.country || "IN");
        const capped = (await rateLimitAsync(request, { name: "wa-consent-marketing-day", limit: 3, windowMs: 86_400_000 })) || (await marketingPhoneCapped({ phone: body.phone, country, cartId: cart }));
        if (capped) return answer(await cartState(cart));
      }
      await grantConsent({ purpose, phone: body.phone, country: String(body.country || "IN"), cartId: cart, customerId: customer?.id ?? null, source: "checkout" });
      return answer(await cartState(cart));
    }
    if (body?.granted === false) {
      await revokeConsent({ purpose, cartId: cart, via: "checkout" });
      return answer(await cartState(cart));
    }
    return NextResponse.json({ error: "Choose yes or no." }, { status: 400 });
  } catch (e) {
    if (e instanceof ConsentError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
