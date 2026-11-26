import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { getOrder, canTransition, ORDER_STATUS } from "@/lib/orders";
import { canPush } from "@/lib/shopify-push";
import { roleAllows } from "@/lib/platform/authz";
import { getOrderProjection } from "@/lib/order-projection";
import { codCheckChannel, codCheckWords } from "@/lib/checkout/cod-otp";
import { redactOrderForRole, shopifyMatchLine, orderTime } from "@/lib/admin/order-view";
import { shopifyAdminUrl } from "@/lib/admin/shopify-admin-url";
import { merchantTz } from "@/lib/reporting";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EyeOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { OrderHeader } from "@/components/admin/orders/OrderHeader";
import { OrderActions } from "@/components/admin/orders/OrderActions";
import { OrderLines } from "@/components/admin/orders/OrderLines";
import { OrderTimeline } from "@/components/admin/orders/OrderTimeline";
import { LatePaymentBanner } from "@/components/admin/orders/LatePaymentBanner";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order · Admin", robots: { index: false } };

// One order on the new UI (docs/plans/phase-2.md "Line 2" §1.3-1.7). S31:
// the support role sees the order's state and money, never the customer.
// The writes offered are the role's permission AND what the order's state
// allows (canPush, canTransition), and OrderActions gates them again.
function Fields({ items }) {
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v, mono]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className={mono ? "font-mono break-all" : "break-words"}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AdminOrderDetail({ params }) {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "orders.read")) return <NoAccess role={actor.role} page />;

  const { id } = await params;
  const role = actor.role;
  const [rawOrder, projection, timeZone, shopifyUrl, codChannel] = await tfetch(async () => {
    const o = await getOrder(id);
    // Phase 8 line 2: how the COD code was sent (SMS proves the phone, email only the email)
    const channel = o?.cod_verified_at ? await codCheckChannel(id).catch(() => null) : null;
    return [o, o ? await getOrderProjection(id) : null, merchantTz(), o?.shopify_order_id ? shopifyAdminUrl({ order: o.shopify_order_id }) : null, channel];
  });
  if (!rawOrder) notFound();
  const order = redactOrderForRole(rawOrder, role);
  // OVL-06: "Shopify title: X, SKU: Y" under a line the shopper saw under another
  // title. The snapshot's items hold titles and SKUs only, no customer details,
  // so the support role gets this line too.
  const shopifyLines = order.items.map((it) => shopifyMatchLine(it, rawOrder.snapshot?.items));
  const can = {
    push: roleAllows(role, "orders.push") && canPush(order),
    reconcile: roleAllows(role, "orders.push") && Boolean(order.shopify_order_id),
    cancel: roleAllows(role, "orders.cancel") && canTransition(order.status, ORDER_STATUS.CANCELLED),
  };
  const address = [order.address_line1, order.address_line2, order.city, order.state, order.pincode].filter(Boolean).join(", ");

  return (
    <>
      <OrderHeader
        order={{ id: order.id, status: order.status, financial_status: order.financial_status ?? null, fulfillment_status: order.fulfillment_status ?? null, refunded_total: order.refunded_total ?? 0, payment_method: order.payment_method, created_at: order.created_at }}
        timeZone={timeZone}
        actions={<OrderActions orderId={order.id} role={role} can={can} paymentCaptured={rawOrder.payment_status === "paid"} />}
      />

      {/* Phase 9 line 2: money captured for a replaced (cancelled) order */}
      <LatePaymentBanner events={rawOrder.events} />

      {order.sync_error && order.status === ORDER_STATUS.SYNC_FAILED && (
        <div role="status" className="mb-4 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">This order didn&apos;t reach Shopify</p>
          <p className="mt-1 break-words text-foreground">{order.sync_error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {order.sync_attempts} attempt{order.sync_attempts === 1 ? "" : "s"} so far.{can.push ? " Fix the cause in Shopify, then use Push to Shopify." : " An owner or admin can push it again once the cause is fixed."}
          </p>
        </div>
      )}

      {/* The order's what (lines, totals, then what happened) leads; who and
          where it stands in payment and Shopify sit in the side column from
          1024px, and under the lines on narrower screens. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <OrderLines
            items={order.items}
            shopifyLines={shopifyLines}
            totals={{ subtotal: order.subtotal, discount_total: order.discount_total, payment_discount: order.payment_discount ?? 0, coupon_code: order.coupon_code, shipping_total: order.shipping_total, total: order.total, refunded_total: order.refunded_total }}
            currency={order.currency}
            refundCurrency={order.base_currency || order.currency}
          />
          <OrderTimeline fulfillments={projection.fulfillments} refunds={projection.refunds} events={order.events} codVerifiedAt={order.cod_verified_at ?? null} codCheck={codCheckWords(codChannel)} currency={order.currency} refundCurrency={order.base_currency || order.currency} timeZone={timeZone} />
        </div>
        <aside aria-label="Customer and payment" className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-[1.125rem]">Customer</CardTitle>
            </CardHeader>
            <CardContent>
              {order.pii_redacted ? (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <Badge variant="muted">
                    <EyeOff aria-hidden />
                    Hidden for support
                  </Badge>
                  <p>Name, email, phone and address are not shown with support access.</p>
                </div>
              ) : (
                <Fields items={[["Name", order.name || "—"], ["Email", order.email || "—"], ["Phone", order.phone || "—"], ["Address", address || "No address"]]} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-[1.125rem]">Payment and sync</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Fields
                items={[
                  ["Placed", orderTime(order.created_at, timeZone)],
                  ["Paid", orderTime(order.paid_at, timeZone)],
                  ["Razorpay", order.razorpay_payment_id || order.razorpay_order_id || "—", Boolean(order.razorpay_payment_id || order.razorpay_order_id)],
                  ["Shopify order", order.shopify_order_id ? String(order.shopify_order_id).split("/").pop() : "Not sent yet", Boolean(order.shopify_order_id)],
                  ["Push attempts", String(order.sync_attempts ?? 0)],
                ]}
              />
              {shopifyUrl && (
                <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" data-read-control className="inline-flex rounded-md text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  View in Shopify
                </a>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
