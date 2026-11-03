import { NextResponse, after } from "next/server";
import { requestOtp, verifyOtp, customerFromToken, revokeCustomerSession, updateCustomerProfile, customerOrders, buildReorder, validEmail, CUSTOMER_COOKIE } from "@/lib/customers";
import { requestReturn } from "@/lib/returns";
import { mergeWishlist, accountWishlist, removeWishlistItem } from "@/lib/wishlist";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { shopperErrorMessage } from "@/lib/shopper-errors";
import { tenantHandler } from "@/lib/tenant-request";

// Shopper account API (S45 / BE30 + SF10–12). Passwordless email OTP;
// session = httpOnly tenant-host cookie (hashed at rest). Enumeration-safe:
// requesting a code answers the same whether or not an account exists —
// accounts materialize only on first successful verification.
//   POST {action:"request_otp", email}
//   POST {action:"verify", email, code}  → sets _customer cookie
//   POST {action:"logout"}
//   POST {action:"profile", name?, phone?, address?}   (authed)
//   GET  ?view=me | orders | reorder&order=<id>        (authed)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = CUSTOMER_COOKIE;
const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60 };

const me = (request) => customerFromToken(request.cookies.get(COOKIE)?.value);

export const GET = tenantHandler(async (request) => {
  const customer = await me(request);
  if (!customer) return NextResponse.json({ ok: true, authenticated: false });
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "me";
  if (view === "orders") return NextResponse.json({ ok: true, authenticated: true, customer, orders: await customerOrders(customer.id) });
  if (view === "wishlist") return NextResponse.json({ ok: true, authenticated: true, items: await accountWishlist(customer.id) });
  if (view === "reorder") {
    const r = await buildReorder(customer.id, String(url.searchParams.get("order") || ""));
    if (!r) return NextResponse.json({ error: "order not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...r });
  }
  return NextResponse.json({ ok: true, authenticated: true, customer });
});

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "request_otp") {
      const limited = rateLimit(request, { name: "account_otp", limit: 5, windowMs: 15 * 60 * 1000 });
      if (limited) return limited;
      if (String(body.website || "").trim()) return NextResponse.json({ ok: true, sent: true }); // honeypot
      if (!validEmail(body.email)) return NextResponse.json({ error: "That email doesn't look right." }, { status: 422 });
      const r = await requestOtp(body.email);
      // deliver through the jobs fast path (same as the contact form)
      after(async () => {
        const { runDueJobs } = await import("@/lib/platform/worker.js");
        await runDueJobs({ limit: 5 }).catch(() => {});
      });
      slog("account_otp_sent", { otp: r.id });
      return NextResponse.json({ ok: true, sent: true });
    }
    if (body.action === "verify") {
      const limited = rateLimit(request, { name: "account_verify", limit: 10, windowMs: 15 * 60 * 1000 });
      if (limited) return limited;
      const r = await verifyOtp(body.email, body.code);
      const res = NextResponse.json({ ok: true, customer: r.customer, claimedOrders: r.claimedOrders });
      res.cookies.set(COOKIE, r.token, COOKIE_OPTS);
      return res;
    }
    if (body.action === "logout") {
      await revokeCustomerSession(request.cookies.get(COOKIE)?.value);
      const res = NextResponse.json({ ok: true });
      res.cookies.set(COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
      return res;
    }
    if (body.action === "request_return") {
      const customer = await me(request);
      if (!customer) return NextResponse.json({ error: "sign in first" }, { status: 401 });
      const limited = rateLimit(request, { name: "account_return", limit: 5, windowMs: 60 * 60 * 1000 });
      if (limited) return limited;
      const r = await requestReturn({ customerId: customer.id, orderId: String(body.orderId || ""), reason: body.reason });
      // merchant notification rides the jobs fast path, like the contact form
      after(async () => {
        const { runDueJobs } = await import("@/lib/platform/worker.js");
        await runDueJobs({ limit: 5 }).catch(() => {});
      });
      return NextResponse.json({ ok: true, request: r });
    }
    if (body.action === "wishlist_merge") {
      // SF22: the EXPLICIT merge — the only way local items reach the account
      const customer = await me(request);
      if (!customer) return NextResponse.json({ error: "sign in first" }, { status: 401 });
      const r = await mergeWishlist(customer.id, body.items);
      slog("wishlist_merged", { added: r.added, deduped: r.deduped });
      return NextResponse.json({ ok: true, ...r, items: await accountWishlist(customer.id) });
    }
    if (body.action === "wishlist_remove") {
      const customer = await me(request);
      if (!customer) return NextResponse.json({ error: "sign in first" }, { status: 401 });
      await removeWishlistItem(customer.id, body.handle);
      return NextResponse.json({ ok: true, items: await accountWishlist(customer.id) });
    }
    if (body.action === "profile") {
      const customer = await me(request);
      if (!customer) return NextResponse.json({ error: "sign in first" }, { status: 401 });
      const updated = await updateCustomerProfile(customer.id, { name: body.name, phone: body.phone, address: body.address });
      return NextResponse.json({ ok: true, customer: updated });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: shopperErrorMessage(e, "Something went wrong — please try again.").slice(0, 200) }, { status: 422 });
  }
});
