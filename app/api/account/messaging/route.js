import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { rateLimitAsync } from "@/lib/rate-limit";
import { sameOrigin } from "@/lib/origin-check";
import { CUSTOMER_COOKIE, customerFromToken } from "@/lib/customers";
import { maskPhone } from "@/lib/checkout/cod-otp";
import { ConsentError, customerConsents, grantConsent, revokeConsent } from "@/lib/messaging/consent";

// Phase 9 line 3: the account page's WhatsApp toggles (components/account/MessagingPrefs.js).
// The signed-in shopper's own consents only (the _customer cookie); signed out → 401.
//   GET  → { ok, updates, marketing, phone }: each purpose on or off; phone is
//          the covered number, masked
//   POST { purpose, granted, phone? } → the same. Turning one on uses the phone
//        given, else the account's phone. 20 per 10 minutes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGN_IN = { error: "sign in first" };
const me = (request) => customerFromToken(request.cookies.get(CUSTOMER_COOKIE)?.value);

async function state(customer) {
  const c = await customerConsents(customer.id);
  const phone = c.updates || c.marketing || customer.phone || null;
  return { ok: true, updates: Boolean(c.updates), marketing: Boolean(c.marketing), phone: phone ? maskPhone(phone) : null };
}

export const GET = tenantHandler(async (request) => {
  const customer = await me(request);
  if (!customer) return NextResponse.json(SIGN_IN, { status: 401 });
  return NextResponse.json(await state(customer));
});

export const POST = tenantHandler(async (request) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: "This request isn't allowed." }, { status: 403 });
  const customer = await me(request);
  if (!customer) return NextResponse.json(SIGN_IN, { status: 401 });
  const limited = await rateLimitAsync(request, { name: "wa-account", limit: 20, windowMs: 10 * 60_000 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const purpose = String(body?.purpose ?? "");
  try {
    if (body?.granted === true) await grantConsent({ purpose, phone: body.phone || customer.phone, cartId: null, customerId: customer.id, source: "account" });
    else if (body?.granted === false) await revokeConsent({ purpose, customerId: customer.id, via: "account" });
    else return NextResponse.json({ error: "Choose on or off." }, { status: 400 });
    return NextResponse.json(await state(customer));
  } catch (e) {
    if (e instanceof ConsentError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
