import { NextResponse } from "next/server";
import { customerFromToken, CUSTOMER_COOKIE } from "@/lib/customers";
import { CART_COOKIE } from "@/lib/cart";
import { rateLimitAsync } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { db } from "@/lib/db";
import { readEffective, effectiveExpr, LIVE_TABLE } from "@/lib/catalog/effective";
import { subscriptionSettings, eligibleFor, subscribedUnitPrice, QUANTITY_MAX } from "@/lib/subscriptions/pricing";
import { subscriptionsOf, ownSubscription } from "@/lib/subscriptions/store";
import { renewalFigure, payableNow, startRenewalCart } from "@/lib/subscriptions/renewal";
import { shopperAction, SubscriptionError } from "@/lib/subscriptions/actions";

// Phase 9 line 2: the shopper's own subscriptions (the _customer cookie; never
// an id from anyone else). Signed out → 401 with no data; another shopper's id
// → 404, the same as a missing one, and that row is not changed.
//   GET                       → { subscriptions, intervals, quantityMax }
//   GET ?swap=<id>            → { options: [{ variantId, title, price }] }
//   POST {action: skip|pause|resume|swap|change|cancel, id, until?, variantId?, interval?, quantity?}
//   POST {action: "pay", id}  → a renewal cart for the due delivery, the cart
//                               cookie set to it, { ok, redirect: "/checkout" }
// Writes: 30 per 10 minutes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGN_IN = { error: "sign in first" };
const NOT_FOUND = { error: "subscription not found" };
const CART_COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === "production" };

const me = (request) => customerFromToken(request.cookies.get(CUSTOMER_COOKIE)?.value);

async function view(row, settings) {
  const figure = row.status === "cancelled" ? null : await renewalFigure(row);
  return {
    id: row.id,
    productTitle: row.product_title || "A product no longer in the store",
    variantTitle: row.variant_title && row.variant_title !== "Default Title" ? row.variant_title : null,
    handle: row.handle || null,
    image: row.image_url || row.featured_image || null,
    quantity: Number(row.quantity),
    interval: Number(row.interval_days),
    percent: Number(row.discount_percent),
    status: row.status,
    nextDueAt: row.status === "cancelled" ? null : row.next_due_at,
    pausedUntil: row.paused_until || null,
    cancelledAt: row.cancelled_at || null,
    next: figure ? { amount: figure.amount, currency: figure.currency, available: figure.available } : null,
    payable: Boolean(settings) && payableNow(row, settings) && Boolean(figure?.available),
  };
}

export const GET = tenantHandler(async (request) => {
  const customer = await me(request);
  if (!customer) return NextResponse.json(SIGN_IN, { status: 401 });
  const settings = await subscriptionSettings();
  const swapId = new URL(request.url).searchParams.get("swap");
  if (swapId != null) {
    const sub = await ownSubscription(customer.id, swapId);
    if (!sub) return NextResponse.json(NOT_FOUND, { status: 404 });
    if (!settings) return NextResponse.json({ ok: true, options: [] });
    // the products as shoppers see them (the founder's published titles)
    const rows = await readEffective((live) => {
      let q = db.selectFrom("variants as v").innerJoin("products as p", "p.id", "v.product_id");
      if (live) q = q.leftJoin(`${LIVE_TABLE} as c`, "c.product_id", "p.id");
      return q
        .select(["v.id", "v.title as variant_title", "v.price", "p.id as product_id", "p.tags"])
        .select(effectiveExpr("title", live).as("product_title"))
        .where("v.available", "=", 1)
        .orderBy("product_title", "asc")
        .limit(400)
        .execute();
    });
    const options = rows
      .filter((r) => {
        let tags = [];
        try {
          tags = JSON.parse(r.tags ?? "[]");
        } catch {
          tags = [];
        }
        return r.id !== sub.variant_id && (r.product_id === sub.product_id || eligibleFor(settings, tags));
      })
      .slice(0, 50)
      .map((r) => ({
        variantId: r.id,
        title: r.variant_title && r.variant_title !== "Default Title" ? `${r.product_title} · ${r.variant_title}` : r.product_title,
        price: subscribedUnitPrice(r.price, Number(sub.discount_percent)),
      }));
    return NextResponse.json({ ok: true, options });
  }
  const rows = await subscriptionsOf(customer.id);
  const subscriptions = [];
  for (const r of rows) subscriptions.push(await view(r, settings));
  return NextResponse.json({ ok: true, subscriptions, intervals: settings?.intervals ?? [], quantityMax: QUANTITY_MAX });
});

export const POST = tenantHandler(async (request) => {
  const customer = await me(request);
  if (!customer) return NextResponse.json(SIGN_IN, { status: 401 });
  const limited = await rateLimitAsync(request, { name: "account_subscriptions", limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  try {
    if (body.action === "pay") {
      const sub = await ownSubscription(customer.id, id);
      if (!sub) return NextResponse.json(NOT_FOUND, { status: 404 });
      const settings = await subscriptionSettings();
      if (!settings) return NextResponse.json({ error: "Subscriptions are turned off for this store right now." }, { status: 409 });
      if (!payableNow(sub, settings)) return NextResponse.json({ error: "This delivery isn't due yet." }, { status: 409 });
      const cartId = await startRenewalCart(sub);
      slog("subscription_pay_started", { subscription: sub.id, cycle: Number(sub.cycle) });
      const res = NextResponse.json({ ok: true, redirect: "/checkout" });
      res.cookies.set(CART_COOKIE, cartId, CART_COOKIE_OPTS);
      return res;
    }
    const sub = await shopperAction(customer.id, String(body.action || ""), id, {
      until: body.until,
      variantId: body.variantId,
      interval: body.interval,
      quantity: body.quantity,
    });
    slog("subscription_changed", { subscription: sub.id, action: String(body.action) });
    return NextResponse.json({ ok: true, status: sub.status });
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json(e.status === 404 ? NOT_FOUND : { error: e.message, code: e.code }, { status: e.status });
    if (e?.code === "VARIANT_GONE") return NextResponse.json({ error: "This product isn't in the store any more. Swap it or cancel." }, { status: 409 });
    throw e;
  }
});
