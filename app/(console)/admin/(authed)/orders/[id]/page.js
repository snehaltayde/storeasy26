import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getOrder, canTransition, ORDER_STATUS } from "@/lib/orders";
import { canPush } from "@/lib/shopify-push";
import { roleAllows } from "@/lib/platform/authz";
import { getOrderProjection } from "@/lib/order-projection";
import { redactOrderForRole, shopifyMatchLine, orderTime } from "@/lib/admin/order-view";
import { shopifyAdminUrl } from "@/lib/admin/shopify-admin-url";
import { merchantTz } from "@/lib/reporting";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OrderHeader } from "@/components/admin/orders/OrderHeader";
import { OrderActions } from "@/components/admin/orders/OrderActions";
import { OrderLines } from "@/components/admin/orders/OrderLines";
import { OrderTimeline } from "@/components/admin/orders/OrderTimeline";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order · Admin", robots: { index: false } };

// One order on the new UI (docs/plans/phase-2.md "Line 2" §1.3-1.7). S31:
// the support role sees the order's state and money, never the customer.
// The writes offered are the role's permission AND what the order's state
// allows (canPush, canTransition), and OrderActions gates them again.
function Fields({ items }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
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
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { id } = await params;
  const role = actor.role;
  const [rawOrder, projection, timeZone, shopifyUrl] = await tfetch(async () => {
    const o = await getOrder(id);
    return [o, o ? await getOrderProjection(id) : null, merchantTz(), o?.shopify_order_id ? shopifyAdminUrl({ order: o.shopify_order_id }) : null];
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

      {order.sync_error && order.status === ORDER_STATUS.SYNC_FAILED && (
        <div role="status" className="mb-4 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">This order didn&apos;t reach Shopify</p>
          <p className="mt-1 break-words text-foreground">{order.sync_error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {order.sync_attempts} attempt{order.sync_attempts === 1 ? "" : "s"} so far.{can.push ? " Fix the cause in Shopify, then use Push to Shopify." : " An owner or admin can push it again once the cause is fixed."}
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[1.125rem]">Customer</CardTitle>
          </CardHeader>
          <CardContent>
            {order.pii_redacted ? (
              <p className="text-sm text-muted-foreground">
                <Badge variant="muted" className="mr-2">
                  Hidden for support
                </Badge>
                Customer details are not shown with support access.
              </p>
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
                ["Razorpay", order.razorpay_payment_id || order.razorpay_order_id || "—", true],
                ["Shopify order", order.shopify_order_id ? String(order.shopify_order_id).split("/").pop() : "Not sent yet", true],
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
      </div>

      <div className="mt-4">
        <OrderLines
          items={order.items}
          shopifyLines={shopifyLines}
          totals={{ subtotal: order.subtotal, discount_total: order.discount_total, coupon_code: order.coupon_code, shipping_total: order.shipping_total, total: order.total, refunded_total: order.refunded_total }}
          currency={order.currency}
        />
      </div>

      <div className="mt-4">
        <OrderTimeline fulfillments={projection.fulfillments} refunds={projection.refunds} events={order.events} currency={order.currency} timeZone={timeZone} />
      </div>
    </>
  );
}
